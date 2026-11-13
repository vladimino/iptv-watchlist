// AIR-374 H2 readiness: the owner decision of 13 Nov 2026 on the ten named projector-versus-canonical differences, pinned (offline, no database). Nine are ACCEPTED, one is a mandatory FIX
// before the H2 marker flip; accepting or un-accepting any difference changes this list and so needs this file to change in the same reviewed PR. handoffReadiness must name exactly the
// one open exception, and must name it again if it is reopened or if an accepted one is turned back into a draft.
import assert from 'node:assert/strict';
import {P6_DIFFERENTIAL_EXCEPTIONS} from '../src/canonical-film-writers.js';
import {EXTRA_EXCEPTIONS} from '../src/canonical-differential-registry.js';
import {handoffReadiness} from '../src/canonical-producers.js';

const ALL=[...P6_DIFFERENTIAL_EXCEPTIONS,...EXTRA_EXCEPTIONS];
const ACCEPTED=['blank_never_overwrites','canonical_identity_requires_trusted_tmdb','credit_ordinals_kept','credits_not_pruned_by_the_planner','held_localization_not_recorded','identity_provenance_title_source','noop_write_keeps_updated_at','redirected_film_refused','reviewed_owner_rows_protected','sync_null_clock_keeps_stored','updated_at_is_write_time'];
const OPEN=['external_ids_not_pruned_by_the_planner'];

assert.equal(ALL.length,12,'twelve named differences in total');
assert.equal(new Set(ALL.map(item=>item.id)).size,12,'ids are unique');
assert.deepEqual(ALL.filter(item=>item.status==='accepted').map(item=>item.id).sort(),ACCEPTED,'exactly the owner-accepted differences are accepted');
assert.deepEqual(ALL.filter(item=>item.status!=='accepted').map(item=>item.id).sort(),OPEN,'exactly the mandatory fix is open');
assert.ok(ALL.every(item=>item.status==='accepted'||item.status==='draft'),'only accepted or draft');

// handoffReadiness derives its exception blockers from the same lists; evidence.exceptions lets this test reopen one without touching a registry. The state is the repository's own
// modelled database (the real migration chain over the sqlite3 stand-in), not a fake.
const {fresh,envOf}=await import('./canonical-differential-helper.mjs');
const blockersFor=async exceptions=>{
 const r=await handoffReadiness(envOf(fresh()),{now:'2026-11-13T10:00:00.000Z',evidence:{exceptions}});
 return r.blockers.filter(item=>String(item).startsWith('exception_not_accepted:')).sort();
};
assert.deepEqual(await blockersFor(ALL),['exception_not_accepted:external_ids_not_pruned_by_the_planner'],'handoffReadiness names exactly the open fix');
assert.deepEqual(await blockersFor(ALL.map(item=>item.id==='credit_ordinals_kept'?{...item,status:'draft'}:item)),['exception_not_accepted:credit_ordinals_kept','exception_not_accepted:external_ids_not_pruned_by_the_planner'],'reopening an accepted difference blocks again');
console.log('canonical-exception-decisions ok: '+ACCEPTED.length+' accepted, '+OPEN.length+' open fix');
process.exit(0);
