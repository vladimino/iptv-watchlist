// Synthetic Letterboxd export archives for the archive reader and preview tests. Every name, code and rating here is
// invented. `zipArchive` writes a ZIP the way an ordinary archiver does and lets a test bend any one field of it.
import {deflateRawSync} from 'node:zlib';
import {crc32} from '../../src/letterboxd-zip.js';

// entries: [{name, data, method = 8, flags = 0, crc, size, compressed, extra, localName, localMethod, body}]
// options: {comment, count, cdOffset, cdSize, trailing}
export function zipArchive(entries, options = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    const method = entry.method ?? 8;
    const body = entry.body ?? (method === 8 ? deflateRawSync(data) : data);
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    const localName = entry.localName === undefined ? name : Buffer.from(entry.localName);
    const extra = entry.extra ?? Buffer.alloc(0);
    const crc = entry.crc ?? crc32(data), size = entry.size ?? data.length, compressed = entry.compressed ?? body.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.localFlags ?? entry.flags ?? 0, 6); local.writeUInt16LE(entry.localMethod ?? method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(entry.local ?? offset, 42);
    locals.push(local, localName, body);
    centrals.push(central, name, extra);
    offset += 30 + localName.length + body.length;
  }
  const directory = Buffer.concat(centrals), comment = Buffer.from(options.comment ?? ''), end = Buffer.alloc(22);
  const count = options.count ?? entries.length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(options.cdSize ?? directory.length, 12); end.writeUInt32LE(options.cdOffset ?? offset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment, Buffer.from(options.trailing ?? '')]);
}

const quote = value => /[",\n\r]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value);
const csv = (header, rows) => [header, ...rows].map(row => row.map(quote).join(',')).join('\n') + '\n';
const uri = code => 'https://boxd.it/' + code;

// films: [{code, name, year, watched, watchedDate, rating, watchlist, diary: [{date, rating}]}]
export function exportFiles(films) {
  const watched = [], ratings = [], watchlist = [], diary = [];
  for (const film of films) {
    if (film.watched) watched.push([film.watchedDate ?? '2026-01-01', film.name, film.year ?? '', uri(film.code)]);
    if (film.rating !== undefined) ratings.push([film.ratedOn ?? '2026-01-02', film.name, film.year ?? '', uri(film.code), film.rating]);
    if (film.watchlist) watchlist.push(['2026-01-03', film.name, film.year ?? '', uri(film.code)]);
    for (const entry of film.diary ?? []) diary.push([entry.date, film.name, film.year ?? '', uri(film.code), entry.rating ?? '', entry.date]);
  }
  return {
    'watched.csv': csv(['Date', 'Name', 'Year', 'Letterboxd URI'], watched),
    'ratings.csv': csv(['Date', 'Name', 'Year', 'Letterboxd URI', 'Rating'], ratings),
    'watchlist.csv': csv(['Date', 'Name', 'Year', 'Letterboxd URI'], watchlist),
    'diary.csv': csv(['Date', 'Name', 'Year', 'Letterboxd URI', 'Rating', 'Watched Date'], diary),
  };
}

// A whole export as Letterboxd ships it: the four CSV files, the profile and some folders the reader never inflates.
export function exportArchive(films, {omit = [], extra = {}, method = 8} = {}) {
  const files = exportFiles(films);
  const entries = [{name: 'profile.csv', data: 'Date Joined,Username\n2015-01-01,demo-user\n', method}];
  for (const [name, text] of Object.entries(files)) if (!omit.includes(name)) entries.push({name, data: text, method});
  entries.push({name: 'reviews.csv', data: 'Date,Name\n', method}, {name: 'likes/', data: '', method: 0}, {name: 'likes/films.csv', data: 'Date,Name\n', method});
  for (const [name, data] of Object.entries(extra)) entries.push({name, data, method});
  return zipArchive(entries);
}

export function syntheticFilms(count, start = 0) {
  return Array.from({length: count}, (_, i) => {
    const n = start + i;
    return {code: 'f' + n.toString(36), name: 'Synthetic Film ' + n, year: 1950 + (n % 70), watched: true, watchedDate: '2025-0' + (1 + (n % 9)) + '-1' + (n % 9), rating: n % 3 ? ((n % 10) + 1) / 2 : undefined, watchlist: n % 7 === 0, diary: n % 5 === 0 ? [{date: '2025-03-0' + (1 + (n % 9)), rating: '4'}] : []};
  });
}
