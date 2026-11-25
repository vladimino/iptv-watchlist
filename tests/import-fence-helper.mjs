// AIR-661 / ADR 0218 decision 7: an offline import target carries the offline import contract (src/film-dimension-import-fence.js), or importBatch
// refuses it before any write. Test databases built from migration text add it the way scripts/offline-import.mjs does for a file it creates.
// Fixture rows written straight into a fenced target go through sessionSql, the same session row the importer opens inside each of its batches.
import {OFFLINE_IMPORT_SESSION_TABLE,withOfflineImportFence} from '../src/film-dimension-import-fence.js';
export const withImportFence=withOfflineImportFence;
export const sessionSql=sql=>`BEGIN;\nINSERT INTO ${OFFLINE_IMPORT_SESSION_TABLE} (id, opened_at) VALUES (1, 'fixture');\n${sql.replace(/;\s*$/,'')};\nDELETE FROM ${OFFLINE_IMPORT_SESSION_TABLE} WHERE id = 1;\nCOMMIT;\n`;
// A test adapter over a fenced target whose repositories the test also drives directly (outside importBatch): every write goes through the session.
import {openImportSession} from '../src/film-dimension-import-fence.js';
export const sessioned=db=>{openImportSession(db,{now:()=>'fixture'});return db;};
