// AIR-661 / ADR 0218 (Accepted), decision 7 stage 2. The target-side fence of the offline importer (W2) and the protected-row predicates of
// W2 and of the offline retirement W3. Nothing in the Worker imports this module.
//
// Why a trigger: an importer that predates stage 2 (the old W2) checks nothing on the target. It deletes every non-localization dimension row of a
// Film and inserts `fingerprint` and `prediction` rows, always, in the same transaction that overwrites the title. The target refuses that insert,
// so the whole Film unit of an old importer rolls back: its title overwrite and its deletes of control rows never land. The new W2 never inserts a
// `fingerprint` or `prediction` row (decision 2, A1), and before any mutation it reads the target and refuses a target without this fence, so the
// two cannot be mixed on one database. Moving or deleting a legacy row (merge, retirement) is an UPDATE or a DELETE and stays allowed.

export const FILM_DIMENSION_IMPORT_FENCE='film_dimension_import_fence';
// The same DDL is in migrations/0040_film_dimension_import_fence.sql (a test pins the two together). The offline importer puts it into a local
// SQLite file it creates; for any other target the migration is the only way in, under its own owner gate.
export const FILM_DIMENSION_IMPORT_FENCE_SQL=`CREATE TRIGGER film_dimension_import_fence
BEFORE INSERT ON film_dimension
FOR EACH ROW
WHEN NEW.dimension IN ('fingerprint', 'prediction')
BEGIN
 SELECT RAISE(ABORT, 'film_dimension_import_fence');
END;`;

// Read before any mutation. A target without the fence is refused: an old importer could still write it.
export async function verifyImportFence(db){
 const row=await db.get("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?",[FILM_DIMENSION_IMPORT_FENCE]);
 return row?{ok:true}:{ok:false,reason:'import_target_unfenced'};
}

// The protected-row predicates live in the repository itself (it is bundled and may not import); re-exported here for the importer and tests.
export {DIMENSION_STATUSES,PROTECTED_ROW_SQL,REPLACEABLE_IDENTITY_SQL,protectedReasons,replaceableIdentity} from './canonical-repository.js';
