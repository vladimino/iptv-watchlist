// AIR-374 P6 (offline), ADR 0117. Data only, DORMANT: nothing in the Worker imports this module (it is not bundled). It holds what the differential natural-path
// harness (tests/canonical-differential.mjs) classifies, and the coverage that handoffReadiness (the producers module) may count as proven.
// - EXTRA_EXCEPTIONS: named differences between the projector path and the canonical writers that the writers' own list (P6_DIFFERENTIAL_EXCEPTIONS of the Film
//   writers module) does not carry. A difference that is in neither list fails the harness; a difference is never reported as parity.
// - DIFFERENTIAL_COVERAGE: for each former producer GAP, the harness scenarios that compare it. The harness asserts that every scenario named here really ran and
//   ended IDENTICAL or fully classified, and that every table it claims was compared, so this list cannot say more than the harness proved.
// Owner decision of 13 Nov 2026 (AIR-374, Trello comment 6af6e6bb4d9194f1238e6f98): ACCEPT credits_not_pruned_by_the_planner, updated_at_is_write_time, held_localization_not_recorded,
// noop_write_keeps_updated_at, canonical_identity_requires_trusted_tmdb and credit_ordinals_kept (and, in the Film writers list, blank_never_overwrites, reviewed_owner_rows_protected and
// redirected_film_refused). external_ids_not_pruned_by_the_planner stays `draft`: it is a mandatory FIX before the H2 marker flip (a stale external id can break identity resolution), and
// the producer delivery that owns the change removes or deactivates the dropped ids, with a test, instead of the owner accepting the difference. Acceptance changes no runtime behaviour.
export const EXTRA_EXCEPTIONS=Object.freeze([
 {id:'credits_not_pruned_by_the_planner',status:'accepted',area:'film_person_credit',rule:'The projector rewrites the whole credit list of a Film from its source; the canonical planner only upserts, so a credit the source dropped stays until an explicit removal.'},
 {id:'external_ids_not_pruned_by_the_planner',status:'draft',area:'film_external_id',rule:'The projector replaces the full external id set of a Film; the canonical planner only upserts, so an id the source dropped stays until an explicit removal.'},
 {id:'updated_at_is_write_time',status:'accepted',area:'film.updated_at, person.updated_at, watchlist_film.updated_at',rule:'The projector stamps an entity with the update time of its source state, and leaves a Film it does not rewrite (membership release) alone; the canonical writers stamp the time of the write, so an unchanged entity is restamped by a canonical refresh.'},
 {id:'held_localization_not_recorded',status:'accepted',area:'film_alias, person_alias, localization_conflict',rule:'When a reviewed or owner localization holds against an automatic value, the projector also records that value as an alias and a localization_conflict row; the canonical Film facts writer keeps the held value and records neither (the producer must call recordLocalizationConflicts and mutateFilm itself).'},
 {id:'noop_write_keeps_updated_at',status:'accepted',area:'film_metadata.updated_at, watchlist_film.updated_at',rule:'A canonical Film facts call whose every row is already stored writes nothing and so does not restamp updated_at; the projector rewrites the row with the newer source time.'},
 {id:'canonical_identity_requires_trusted_tmdb',status:'accepted',area:'film.canonical_identity',rule:'The canonical Film facts writer writes canonical_identity only when the same Film holds that TMDB id as a trusted, non-conflicting external id; the projector repository writes the identity it is given.'},
 {id:'credit_ordinals_kept',status:'accepted',area:'film_person_credit.ordinal',rule:'The projector renumbers ordinals from its source; the canonical writers keep an existing ordinal and append a new credit after the highest of its role.'},
]);
// `gap` is the exact text of the former gap (GAPS of the producers module); `writers` the fenced writers that close it (they must be registered in the producers CALLS and
// RECONCILE tables); `scenarios` and `tables` what the harness compared for it.
const cover=(gap,writers,scenarios,tables)=>Object.freeze({gap,covered:true,writers:Object.freeze(writers),scenarios:Object.freeze(scenarios),tables:Object.freeze(tables)});
export const DIFFERENTIAL_COVERAGE=Object.freeze([
 cover('film_metadata rows (synopsis, poster, genres, runtime, payload, people version)',['writeFilmFacts'],['first_write','normal_refresh'],['film_metadata']),
 cover('film_dimension rows (identity, metadata lifecycle, effective localization)',['writeFilmFacts'],['first_write','normal_refresh','owner_localization_survives_refresh'],['film_dimension']),
 cover('film_sync_state clocks',['writeFilmFacts'],['first_write','normal_refresh'],['film_sync_state']),
 cover('watchlist_film membership (set and clear)',['writeFilmFacts'],['first_write','departed_member_survives'],['watchlist_film']),
 cover('person_dimension rows and Person localization state',['recordPersonState'],['first_write','owner_person_name_survives_refresh'],['person_dimension']),
 cover('localization_conflict rows outside a merge',['recordLocalizationConflicts'],['localization_conflict_rows'],['localization_conflict']),
 cover('canonical_identity and original_title overwrite (the fenced write only fills)',['writeFilmFacts'],['first_write','normal_refresh'],['film']),
]);
