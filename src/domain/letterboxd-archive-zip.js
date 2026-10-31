// Reader of a Letterboxd account export ZIP for the Worker (ADR 0061). Web platform only: DataView, DecompressionStream
// and crypto.subtle, no Buffer or node:zlib. It refuses before decompressing anything when the archive, its central
// directory or an entry header is outside the limits below, and it counts every byte while it inflates, so a declared size
// that lies, a ZIP bomb or a truncated entry stops the read instead of allocating. Only the four exact top-level CSV files
// are inflated; every other entry is checked for a safe name, method and flags and then left compressed. Bundled into the
// Worker by `scoped` as LetterboxdArchiveZip; tests import it directly. Contract: docs/reference/api/admin.md.
const MIB = 1024 * 1024;

export const ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 10 * MIB,   // compressed upload
  maxEntries: 2000,            // central directory records, directories included
  maxNameBytes: 255,
  maxEntryBytes: 4 * MIB,      // one inflated CSV
  maxTotalBytes: 8 * MIB,      // the inflated CSVs together
  maxRatio: 100,               // declared inflated size over compressed size of a read entry
  maxRows: 10000,              // line breaks in one CSV, a bound on its records and on the parse's memory
  maxMillis: 20000,            // wall budget, checked between inflated chunks
});
export const ARCHIVE_FILES = Object.freeze(['watched.csv', 'ratings.csv', 'watchlist.csv', 'diary.csv']);

export const ArchiveError = class ArchiveError extends Error {
  constructor(code, file) {
    super(code);
    this.name = 'ArchiveError';
    this.code = code;
    this.file = file ?? null;
  }
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

// The name Letterboxd gives an export: letterboxd-<user>-YYYY-MM-DD-HH-MM-utc.zip. Returns the generation time or null.
export function archiveGeneratedAt(fileName) {
  const base = String(fileName ?? '').split(/[\\/]/).pop();
  const match = /^letterboxd-[A-Za-z0-9_-]+-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-utc\.zip$/.exec(base);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d || date.getUTCHours() !== +h || date.getUTCMinutes() !== +mi) return null;
  return date.toISOString();
}

// A name is checked on its raw bytes: no control character, no backslash, no absolute path or drive letter, no empty, "."
// or ".." segment. A directory record ends with "/".
function safeName(bytes) {
  if (!bytes.length) return false;
  for (const byte of bytes) if (byte < 0x20 || byte === 0x7f || byte === 0x5c) return false;
  const text = new TextDecoder('utf-8', {fatal: false}).decode(bytes);
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) return false;
  const segments = (text.endsWith('/') ? text.slice(0, -1) : text).split('/');
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
const ascii = bytes => {for (const byte of bytes) if (byte > 0x7e) return null; return String.fromCharCode(...bytes);};

function checkGuard(guard, file) {
  if (guard.signal && guard.signal.aborted) throw new ArchiveError('aborted', file);
  if (Date.now() > guard.deadline) throw new ArchiveError('time_budget', file);
}

async function inflate(data, expected, guard, file) {
  const out = new Uint8Array(expected);
  const reader = new Response(data).body.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  let total = 0;
  try {
    for (;;) {
      let step;
      try {step = await reader.read();} catch {throw new ArchiveError('inflate_failed', file);}
      if (step.done) break;
      const chunk = step.value;
      if (total + chunk.length > expected) throw new ArchiveError('entry_size_mismatch', file);
      out.set(chunk, total);
      total += chunk.length;
      checkGuard(guard, file);
    }
  } catch (error) {
    try {await reader.cancel();} catch {}
    throw error;
  }
  if (total !== expected) throw new ArchiveError('entry_size_mismatch', file);
  return out;
}

// bytes: the archive as a Uint8Array. Returns {sha256, bytes, entries, ignoredEntries, files: {<name>: {text, sha256,
// bytes}}} for the four export files that are present; an absent one is missing from `files`.
export async function readLetterboxdArchive(bytes, {limits = ARCHIVE_LIMITS, signal = null, now = Date.now()} = {}) {
  if (!(bytes instanceof Uint8Array)) throw new ArchiveError('not_zip');
  if (bytes.length > limits.maxArchiveBytes) throw new ArchiveError('archive_too_large');
  if (bytes.length < 22) throw new ArchiveError('not_zip');
  const guard = {signal, deadline: now + limits.maxMillis};
  checkGuard(guard, null);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = at => view.getUint16(at, true), u32 = at => view.getUint32(at, true);
  // The end record must close the archive exactly: its comment runs to the last byte.
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) {eocd = at; break;}
  }
  if (eocd < 0) throw new ArchiveError('not_zip');
  if (eocd >= 20 && u32(eocd - 20) === 0x07064b50) throw new ArchiveError('zip64_unsupported');
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 || u16(eocd + 8) !== u16(eocd + 10)) throw new ArchiveError('multi_disk_unsupported');
  const count = u16(eocd + 10), cdSize = u32(eocd + 12), cdOffset = u32(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError('zip64_unsupported');
  if (count > limits.maxEntries) throw new ArchiveError('too_many_entries');
  if (cdOffset + cdSize !== eocd) throw new ArchiveError('central_directory_invalid');
  const entries = [], names = new Set(), folded = new Set();
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || u32(at) !== 0x02014b50) throw new ArchiveError('central_directory_invalid');
    const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16), compressed = u32(at + 20), size = u32(at + 24);
    const nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32), local = u32(at + 42);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) throw new ArchiveError('central_directory_invalid');
    if (nameLength > limits.maxNameBytes) throw new ArchiveError('entry_name_invalid');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    if (!safeName(nameBytes)) throw new ArchiveError('entry_name_invalid');
    for (let x = at + 46 + nameLength; x + 4 <= at + 46 + nameLength + extraLength;) {
      const id = u16(x), length = u16(x + 2);
      if (id === 0x0001) throw new ArchiveError('zip64_unsupported');
      x += 4 + length;
    }
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new ArchiveError('zip64_unsupported');
    if (flags & 0x0001 || flags & 0x0040 || flags & 0x2000) throw new ArchiveError('encrypted_entry');
    if (method !== 0 && method !== 8) throw new ArchiveError('unsupported_method');
    const key = Array.from(nameBytes).join(',');
    if (names.has(key)) throw new ArchiveError('duplicate_entry');
    names.add(key);
    const name = ascii(nameBytes);
    // A case variant of an export file beside it would make the archive's content depend on which one a reader picks.
    if (name !== null) {
      const lower = name.toLowerCase();
      if (ARCHIVE_FILES.includes(lower)) {
        if (folded.has(lower)) throw new ArchiveError('duplicate_entry', lower);
        folded.add(lower);
        if (name !== lower) throw new ArchiveError('entry_name_invalid', lower);
      }
    }
    entries.push({name, method, flags, crc, compressed, size, local, read: name !== null && ARCHIVE_FILES.includes(name)});
    at = end;
  }
  if (at !== eocd) throw new ArchiveError('central_directory_invalid');
  // Local headers: each sits before the central directory, names the same file and does not overlap the next entry.
  const ordered = [...entries].sort((a, b) => a.local - b.local);
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    if (entry.local + 30 > cdOffset || u32(entry.local) !== 0x04034b50) throw new ArchiveError('local_header_invalid', entry.read ? entry.name : null);
    if (u16(entry.local + 8) !== entry.method || (u16(entry.local + 6) & 0x0001)) throw new ArchiveError('local_header_invalid', entry.read ? entry.name : null);
    const nameLength = u16(entry.local + 26), extraLength = u16(entry.local + 28);
    entry.start = entry.local + 30 + nameLength + extraLength;
    if (entry.read && ascii(bytes.subarray(entry.local + 30, entry.local + 30 + nameLength)) !== entry.name) throw new ArchiveError('local_header_invalid', entry.name);
    const limit = i + 1 < ordered.length ? ordered[i + 1].local : cdOffset;
    if (entry.start + entry.compressed > limit) throw new ArchiveError(entry.start + entry.compressed > cdOffset ? 'entry_truncated' : 'entry_overlap', entry.read ? entry.name : null);
  }
  const read = entries.filter(entry => entry.read).sort((a, b) => ARCHIVE_FILES.indexOf(a.name) - ARCHIVE_FILES.indexOf(b.name));
  let total = 0;
  for (const entry of read) {
    if (entry.size > limits.maxEntryBytes) throw new ArchiveError('entry_too_large', entry.name);
    total += entry.size;
    if (total > limits.maxTotalBytes) throw new ArchiveError('total_too_large', entry.name);
    if (entry.method === 0 ? entry.size !== entry.compressed : entry.size > Math.max(1, entry.compressed) * limits.maxRatio) throw new ArchiveError(entry.method === 0 ? 'entry_size_mismatch' : 'ratio_exceeded', entry.name);
  }
  const files = {};
  for (const entry of read) {
    checkGuard(guard, entry.name);
    const data = bytes.subarray(entry.start, entry.start + entry.compressed);
    const content = entry.method === 0 ? data.slice() : await inflate(data, entry.size, guard, entry.name);
    if (crc32(content) !== entry.crc) throw new ArchiveError('checksum_failed', entry.name);
    let text;
    try {text = new TextDecoder('utf-8', {fatal: true}).decode(content);} catch {throw new ArchiveError('invalid_utf8', entry.name);}
    let rows = 0;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) if (++rows > limits.maxRows) throw new ArchiveError('too_many_rows', entry.name);
    files[entry.name] = {text, sha256: await sha256Hex(content), bytes: content.length};
  }
  checkGuard(guard, null);
  return {sha256: await sha256Hex(bytes), bytes: bytes.length, entries: entries.length, ignoredEntries: entries.length - read.length, files};
}
