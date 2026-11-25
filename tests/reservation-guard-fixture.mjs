// The reservation fence contract (AIR-599, sixth review of PR #1009) as the canonical and Ratings writers consume it. `letterboxd-owner-race-d1.mjs` pins `LetterboxdFacts.reservationGuard` to this text.
export const RESERVATION_SQL = '(EXISTS (SELECT 1 FROM ratings_document WHERE key=? AND instr(body,?)>0) OR EXISTS (SELECT 1 FROM ratings_document a JOIN ratings_document b ON b.key=a.key AND b.part=a.part+1 WHERE a.key=? AND instr(substr(a.body,-?)||substr(b.body,1,?),?)>0))';
export const DIARY_KEY = 'letterboxd/facts/scans/diary-identity.json';
export const needleOf = checkId => '"reservation":{"checkId":"' + checkId + '"';
export const guardOf = checkId => {const needle = needleOf(checkId), length = needle.length; return {sql: RESERVATION_SQL, params: [DIARY_KEY, needle, DIARY_KEY, length - 1, length - 1, needle]};};
// Rows of the shared check document whose reservation needle is cut at `offset` characters of the needle: part 0 ends with needle[:offset], part 1 starts with needle[offset:], part 0 is exactly 60,000 bytes.
export function splitRows(checkId, offset, now) {
  const needle = needleOf(checkId), head = needle.slice(0, offset), tail = needle.slice(offset);
  const part0 = 'x'.repeat(60000 - head.length) + head, part1 = tail + '"}}';
  return [[DIARY_KEY, 0, part0, 'e', now], [DIARY_KEY, 1, part1, 'e', now]];
}
