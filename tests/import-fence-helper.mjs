// AIR-661 / ADR 0218 decision 7: an offline import target must carry the stage-2 fence, or importBatch refuses it (import_target_unfenced).
// Test databases built from the early migrations add it the way scripts/offline-import.mjs does for a file it creates.
import {FILM_DIMENSION_IMPORT_FENCE_SQL} from '../src/film-dimension-import-fence.js';
export const withImportFence=sql=>sql.replace(/;\s*$/,'')+';\n'+FILM_DIMENSION_IMPORT_FENCE_SQL;
