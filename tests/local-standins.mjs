// ADR 0162: the explicit local stand-ins in one place. A domain that is not installed (no D1 binding, no schema, no tables) is refused by the Worker unless the
// caller opts in with its own flag; production never sets them (wrangler.jsonc has none) and, since AIR-576, scripts/local-dev.mjs sets none: the local stack runs a real D1 (scripts/local-d1.mjs). Fixtures that run
// the Worker without a D1 binding wrap their env with `standins`; `strict` removes the flags again, for a test that must prove the refusal. A flag only ever covers a
// domain that is not installed at all: a partly installed domain, a contract that declares the domain installed, and a marker that is not d1 stay refused.
export const STANDIN_FLAGS=Object.freeze({
 PUBLISHED_EPG_DB_OPTIONAL:'standin',
 OWNER_REVIEW_DB_OPTIONAL:'standin',
 METADATA_CACHE_DB_OPTIONAL:'standin',
 DISCOVERY_DB_OPTIONAL:'standin',
 FILM_PERSON_DB_OPTIONAL:'standin',
 STARTED_DB_OPTIONAL:'standin',
 EPG_CHECKPOINT_DB_OPTIONAL:'standin',
});
export const standins=(env={})=>({...env,...STANDIN_FLAGS});
export const strict=(env={})=>{const out={...env};for(const name of Object.keys(STANDIN_FLAGS))delete out[name];return out;};
