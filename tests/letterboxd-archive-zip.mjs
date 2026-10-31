// The Worker's reader of the Letterboxd export ZIP (src/domain/letterboxd-archive-zip.js): the same files, hashes and export
// time as the offline Node reader, and a refusal, before any allocation it cannot bound, of every archive outside the limits.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {readZip, archiveGeneratedAt as nodeGeneratedAt, crc32 as nodeCrc} from '../src/letterboxd-zip.js';
import {ARCHIVE_LIMITS, ARCHIVE_FILES, ArchiveError, crc32, archiveGeneratedAt, readLetterboxdArchive} from '../src/domain/letterboxd-archive-zip.js';
import {zipArchive, exportArchive, syntheticFilms} from './fixtures/letterboxd-archive.mjs';

const read = (bytes, options) => readLetterboxdArchive(new Uint8Array(bytes), options);
async function refuses(bytes, code, file, options) {
  await assert.rejects(read(bytes, options), error => {
    assert.ok(error instanceof ArchiveError, 'an ArchiveError, not ' + error);
    assert.equal(error.code, code);
    if (file !== undefined) assert.equal(error.file, file);
    return true;
  }, code);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// The same answer as the Node reader on an ordinary export, deflated and stored.
for (const method of [8, 0]) {
  const archive = exportArchive(syntheticFilms(40), {method});
  const node = readZip(archive, ARCHIVE_FILES);
  const worker = await read(archive);
  assert.equal(worker.sha256, node.archiveSha256);
  assert.equal(worker.sha256, sha(archive));
  assert.equal(worker.bytes, archive.length);
  assert.equal(worker.entries, 8);
  assert.equal(worker.ignoredEntries, 4, 'profile, reviews, the likes folder and its file are not inflated');
  assert.deepEqual(Object.keys(worker.files), ARCHIVE_FILES);
  for (const name of ARCHIVE_FILES) {
    assert.equal(worker.files[name].text, node.files[name].text, name);
    assert.equal(worker.files[name].sha256, node.files[name].sha256, name);
    assert.equal(worker.files[name].bytes, Buffer.byteLength(node.files[name].text), name);
  }
}
// A missing export file is absent from `files`, not an error.
{
  const worker = await read(exportArchive(syntheticFilms(3), {omit: ['diary.csv', 'watchlist.csv']}));
  assert.deepEqual(Object.keys(worker.files), ['watched.csv', 'ratings.csv']);
}
// CRC and export time agree with the offline tools.
{
  const sample = Buffer.from('Date,Name,Year,Letterboxd URI\n');
  assert.equal(crc32(new Uint8Array(sample)), nodeCrc(sample));
  for (const name of ['letterboxd-demo-user-2026-10-26-13-48-utc.zip', '/x/letterboxd-demo_user-2026-10-26-13-48-utc.zip', 'letterboxd-demo-user-2026-02-30-13-48-utc.zip', 'export.zip', 'letterboxd-demo-user-2026-10-26-24-00-utc.zip', '', 'letterboxd-a b-2026-10-26-13-48-utc.zip']) assert.equal(archiveGeneratedAt(name), nodeGeneratedAt(name), name);
  assert.equal(archiveGeneratedAt('C:\\Users\\me\\letterboxd-demo-user-2026-10-26-13-48-utc.zip'), '2026-10-26T13:48:00.000Z', 'a Windows path from an old browser keeps the base name');
}

const watched = 'Date,Name,Year,Letterboxd URI\n2026-01-01,A,2000,https://boxd.it/a1\n';
const ok = (overrides = {}) => ({name: 'watched.csv', data: watched, ...overrides});

// Not a ZIP, or a ZIP whose end record does not close it.
await refuses(Buffer.from('not a zip at all, definitely not!'), 'not_zip');
await refuses(Buffer.alloc(10), 'not_zip');
await refuses(zipArchive([ok()], {trailing: 'junk after the end'}), 'not_zip');
await assert.rejects(readLetterboxdArchive('text'), error => error.code === 'not_zip');
// Size, entry count and the central directory.
await refuses(Buffer.alloc(ARCHIVE_LIMITS.maxArchiveBytes + 1), 'archive_too_large');
await refuses(zipArchive(Array.from({length: 6}, (_, i) => ({name: 'x' + i + '.txt', data: 'x'}))), 'too_many_entries', undefined, {limits: {...ARCHIVE_LIMITS, maxEntries: 5}});
await refuses(zipArchive([ok()], {cdOffset: 3}), 'central_directory_invalid');
await refuses(zipArchive([ok()], {count: 2}), 'central_directory_invalid');
// ZIP64 and multi-disk.
await refuses(zipArchive([ok()], {count: 0xffff}), 'zip64_unsupported');
await refuses(zipArchive([ok({size: 0xffffffff})]), 'zip64_unsupported');
{
  const extra = Buffer.alloc(20); extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2);
  await refuses(zipArchive([ok({extra})]), 'zip64_unsupported');
  const archive = zipArchive([ok()]);
  const disk = Buffer.from(archive); disk.writeUInt16LE(1, disk.length - 22 + 4);
  await refuses(disk, 'multi_disk_unsupported');
  const locator = zipArchive([ok(), {name: 'pad.bin', data: Buffer.alloc(40), method: 0}]);
  const withLocator = Buffer.from(locator); withLocator.writeUInt32LE(0x07064b50, withLocator.length - 22 - 20);
  await refuses(withLocator, 'zip64_unsupported');
}
// Unsafe names: traversal, absolute, drive letter, backslash, control characters, empty segments.
for (const name of ['../watched.csv', '/watched.csv', 'C:/watched.csv', 'a\\b.csv', 'a/./b.csv', 'a//b.csv', 'ok\u0001.csv', 'x/../../etc', Buffer.alloc(0)]) await refuses(zipArchive([ok(), {name, data: 'x'}]), 'entry_name_invalid');
await refuses(zipArchive([ok({name: 'a'.repeat(256)})]), 'entry_name_invalid');
// Encryption, methods, duplicates and case variants of an export file.
for (const flags of [0x1, 0x40, 0x2000]) await refuses(zipArchive([ok({flags})]), 'encrypted_entry');
await refuses(zipArchive([ok(), {name: 'other.bin', data: 'x', method: 12}]), 'unsupported_method');
await refuses(zipArchive([ok(), ok()]), 'duplicate_entry');
await refuses(zipArchive([ok(), ok({name: 'Watched.csv'})]), 'duplicate_entry', 'watched.csv');
await refuses(zipArchive([ok({name: 'WATCHED.CSV'})]), 'entry_name_invalid', 'watched.csv');
// Local headers that contradict the directory, overlap or run past it.
await refuses(zipArchive([ok({localMethod: 0})]), 'local_header_invalid', 'watched.csv');
await refuses(zipArchive([ok({localName: 'ratings.csv'})]), 'local_header_invalid', 'watched.csv');
await refuses(zipArchive([ok({localFlags: 1})]), 'local_header_invalid', 'watched.csv');
await refuses(zipArchive([ok({compressed: 100000})]), 'entry_truncated', 'watched.csv');
await refuses(zipArchive([ok({compressed: deflateRawSync(watched).length + 10}), {name: 'ratings.csv', data: 'Date,Name,Year,Letterboxd URI,Rating\n'}]), 'entry_overlap', 'watched.csv');
await refuses(zipArchive([ok(), {name: 'other.txt', data: 'x', local: 0}]), 'entry_overlap');
// Size limits before inflating, and declared sizes that lie.
{
  const big = 'x'.repeat(ARCHIVE_LIMITS.maxEntryBytes + 1);
  await refuses(zipArchive([ok({data: big})]), 'entry_too_large', 'watched.csv');
  const three = 'y'.repeat(3 * 1024 * 1024);
  await refuses(zipArchive([ok({data: three, method: 0}), {name: 'ratings.csv', data: three, method: 0}, {name: 'watchlist.csv', data: three, method: 0}]), 'total_too_large', 'watchlist.csv');
  // A bomb: a megabyte of zeros deflates to about a kilobyte, a ratio far above the limit.
  await refuses(zipArchive([ok({data: Buffer.alloc(1024 * 1024)})]), 'ratio_exceeded', 'watched.csv');
  // A declared size smaller than the real one stops the inflate at the declared size; a larger one fails at the end.
  const text = Buffer.from(watched.repeat(50));
  await refuses(zipArchive([ok({data: text, size: 100})]), 'entry_size_mismatch', 'watched.csv');
  await refuses(zipArchive([ok({data: text, size: text.length + 10})]), 'entry_size_mismatch', 'watched.csv');
  await refuses(zipArchive([ok({method: 0, size: 3})]), 'entry_size_mismatch', 'watched.csv');
  // A real bomb under a declared size that passes the ratio check: inflation stops at the declared size.
  const zeros = Buffer.alloc(2 * 1024 * 1024), body = deflateRawSync(zeros);
  await refuses(zipArchive([ok({data: zeros, body, size: body.length * 50})]), 'entry_size_mismatch', 'watched.csv');
}
// Corrupt data, checksum, encoding, rows.
await refuses(zipArchive([ok({body: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), size: watched.length})]), 'inflate_failed', 'watched.csv');
await refuses(zipArchive([ok({crc: 1})]), 'checksum_failed', 'watched.csv');
await refuses(zipArchive([ok({data: Buffer.from([0x44, 0xff, 0xfe, 0x0a])})]), 'invalid_utf8', 'watched.csv');
await refuses(zipArchive([ok({data: 'a\n'.repeat(11)})]), 'too_many_rows', 'watched.csv', {limits: {...ARCHIVE_LIMITS, maxRows: 10}});
// A non-ASCII name of an ignored entry is fine; it is never inflated.
{
  const result = await read(zipArchive([ok(), {name: 'заметки.txt', data: 'x'}]));
  assert.equal(result.ignoredEntries, 1);
  assert.equal(result.files['watched.csv'].text, watched);
}
// The caller's abort signal and the wall budget.
{
  const controller = new AbortController(); controller.abort();
  await refuses(exportArchive(syntheticFilms(3)), 'aborted', null, {signal: controller.signal});
  await refuses(exportArchive(syntheticFilms(3)), 'time_budget', null, {now: Date.now() - ARCHIVE_LIMITS.maxMillis - 1});
}
// The source is web-platform only: no Node built-in or Buffer, so it runs in the Worker unchanged.
{
  const fs = await import('node:fs');
  const source = fs.readFileSync('src/domain/letterboxd-archive-zip.js', 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /^\s*import\s|require\(|\bBuffer\b|node:|\bfetch\(|console\./m);
}
console.log('letterboxd-archive-zip: ok');
