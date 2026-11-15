# Concert telecasts verified as Film — AIR-496 RCA

**Captured:** 2026-11-15, Europe/Madrid (code of `main` at branch start `97fc32b7`, offline fixtures; no production read of the EPG XML, D1 decisions or TMDB in this session)  
**Used by:** [AIR-496](https://trello.com/c/4NxERbZW), [ADR 0149](../../adr/0149-concert-recording-identity-gate.md)  
**Verdict:** root cause is the scored detail gate, not the title screen and not the prediction fingerprint contract

## Production observation (from the card; not re-read here)

On 15 November 2026 the hourly Predictions Task received two catalog Films:

| Film id | Title as reported | Queue after 22:00 Madrid |
| --- | --- | --- |
| `tmdb_1326142` | Robbie Williams: Live at the Apple Music Festival | no fingerprint/prediction; `parse_error` attempts=2 |
| `tmdb_238858` | Rieu Royale - André Rieu Coronation Concert Live in Amsterdam | same |

Owner identification: the EPG objects were concert telecasts, not Films. Prediction `parse_error` is a consequence of false admission, not a predictor bug.

## Reconstructed chain (code)

1. `scanEPG` keeps a programme when duration is 55–300 minutes and `nonFilmEPGReason` is null. `Live` / `Concert` / `концерт` never screen (AIR-94). XMLTV `episode-num` was not available. `<category>` was not stored before this delivery.
2. Discovery searches TMDB Movies by the EPG title. Both titles exist as movies (public TMDB pages list 2016 / ~82 min for 1326142; 238858 is the André Rieu coronation concert recording).
3. `scoreFilmResolution` accepts an exact title with compatible year and runtime.
4. `acceptScoredIdentity` required only id, title, year, runtime, competitors and generation. A Music-only TMDB card therefore became `detail_verified`.
5. The catalog upsert created `tmdb_<id>` and `refreshPredictionQueue` put a hot member on the prediction queue.

**Unavailable primary EPG evidence:** this session did not read the live XMLTV, the D1 observation row or TMDB `genres` / `video` for those ids. Category and episode-num of the real slots are unknown. The TMDB movie ids may be correct catalog entries for those recordings; that still does not make the EPG slot a Film.

## Fix (offline)

The gate withholds `detail_verified` only when XMLTV category is concert/music (not film) and TMDB has Music id `10402` without Documentary or another feature genre (`concert_recording` → `no_confident_match`). TV Movie alone still verifies. Music-only without that category still verifies. Title screening is unchanged. Tests: `tests/concert-broadcast-admission.mjs` (R2 resolver and a D1 paged chunk), `tests/resolution-acceptance.mjs`.

A category-less Music match may still admit: that false-negative-for-telecasts / false-positive-for-films trade-off is explicit in ADR 0149. Live XMLTV and TMDB genre arrays of the two production titles were not inspected.

## Already stored rows

A verified decision is not selected again. Deploying this gate does **not** un-verify the two Films, delete catalog rows, drop prediction-queue members or move the EPG generation (ADR 0142). The existing owner action `discovery_identity_correct` reject (ADR 0080) is the staff path for those two observation keys: it writes the decision under the resolver lease, does not start a chunk, and does not rewrite R2 Film blobs by itself. The next ordinary chunk then searches, hits the same TMDB card, records `concert_recording`, and does not re-admit. Shows follow that chunk only when it can touch a catalog Film that is already there; residual catalog/queue membership may remain until a separate owner-approved retirement. This evidence does not authorize that write.

## Limits

No production TMDB, Discovery or EPG call. Natural EPG/Discovery after deploy is the check that new telecasts of this shape stay unresolved; absence of new cases does not prove classification quality.
