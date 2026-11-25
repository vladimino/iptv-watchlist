#!/usr/bin/env node
// AIR-599 / ADR 0207 decision 4b: the read-only legacy report of the shared Letterboxd check (Diary entries and Watchlist ledger rows exhausted or aged out by the old rules), from two local exports.
// It reads two files and writes to stdout; it calls nothing, writes no store and needs no credential. Producing the exports is an L0 production read by an authorized role:
//   --diary  <file>  the Diary check document as stored (`letterboxd/facts/scans/diary-identity.json`, JSON {schemaVersion, films}), read through an authorized read-only path
//   --ledger <file>  a JSON array of the ledger rows, the result of this SELECT-only statement on D1 `iptv`:
//       SELECT a.lid AS lid, a.state AS state, a.attempts AS attempts, a.last_reason AS lastReason,
//              EXISTS (SELECT 1 FROM watchlist_member m JOIN watchlist_current c ON c.id = 1 AND m.snapshot_id = c.snapshot_id WHERE m.lid = a.lid) AS onWatchlist
//       FROM watchlist_admission_pending a WHERE a.state = 'terminal'
//   --ids    include the ids (private: for the owner's L2 recovery contract only, never for public evidence)
// The printed JSON is aggregate by default: counts by last reason and the size of the bounded recovery. Dated evidence records it with the read time and source identity.
import fs from 'node:fs';
import {legacyReport} from '../src/domain/letterboxd-check-report.js';

const args = process.argv.slice(2);
const value = name => {const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null;};
const diaryFile = value('--diary'), ledgerFile = value('--ledger');
if (!diaryFile || !ledgerFile) {console.error('usage: letterboxd-check-legacy-report.mjs --diary <file> --ledger <file> [--ids]'); process.exit(2);}
const diary = JSON.parse(fs.readFileSync(diaryFile, 'utf8'));
const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).map(row => ({...row, onWatchlist: row.onWatchlist === 1 || row.onWatchlist === true ? true : row.onWatchlist === 0 || row.onWatchlist === false ? false : null}));
process.stdout.write(JSON.stringify(legacyReport({diary, ledger, withIds: args.includes('--ids')}), null, 2) + '\n');
