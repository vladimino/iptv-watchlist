// AIR-537 slice 3: the retired enrichment projector's marker fence vocabulary (ADR 0116) is retained in src/film-person-authority.js
// because src/canonical-producers.js (`projectorFence`) builds on the same condition and the owner gate for authority semantics is not
// lifted. The runner and its batch tests are gone, so this pins the pure contract: which marker rows may carry a fenced batch, when a
// re-read marker still matches, and the exact SQL condition. d1 and held are never writable here (ADR 0162, fail closed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PROJECTOR_LEGACY_GUARD,PROJECTOR_MARKER_CONDITION,PROJECTOR_MARKER_GUARD,PROJECTOR_MARKER_READ,projectorExpectation,projectorGuard,projectorHolds} from '../src/film-person-authority.js';
import {projectorFence} from '../src/canonical-producers.js';

const row=(mode,cutover='open',generation=1)=>({mode,cutover,generation});
// Only `r2` and `prepared` at cutover `open` give an expectation; d1, held, malformed and missing rows do not.
assert.deepEqual(projectorExpectation(row('r2')),{mode:'r2',cutover:'open',generation:1});
assert.deepEqual(projectorExpectation(row('prepared','open',7)),{mode:'prepared',cutover:'open',generation:7});
for(const bad of [row('d1'),row('held'),row('r2','held'),row('r2','open',-1),row('r2','open',1.5),row('r2','open','x'),{mode:'r2'},null,undefined])assert.equal(projectorExpectation(bad),null,JSON.stringify(bad));
// A re-read marker holds only when the mode and the generation are unchanged; a legacy expectation is never satisfied by a successful read.
const expected=projectorExpectation(row('prepared','open',3));
assert.equal(projectorHolds(expected,row('prepared','open',3)),true);
for(const moved of [row('prepared','open',4),row('r2','open',3),row('d1','open',3),row('prepared','held',3),null])assert.equal(projectorHolds(expected,moved),false,JSON.stringify(moved));
assert.equal(projectorHolds({legacy:true},row('r2')),false);
assert.equal(projectorHolds(null,row('r2')),false);
// The fence statements: the marker guard binds mode and generation; the legacy guard binds nothing; any other state has no fence.
assert.deepEqual(projectorGuard(expected),{sql:PROJECTOR_MARKER_GUARD,params:['prepared',3]});
assert.deepEqual(projectorGuard({legacy:true}),{sql:PROJECTOR_LEGACY_GUARD,params:[]});
for(const none of [null,{mode:'d1',generation:1},{mode:'held',generation:1},{mode:'r2',generation:'1'}])assert.equal(projectorGuard(none),null,JSON.stringify(none));
// The SQL asserts mode, cutover `open` and generation against the marker row, and the producers' fence builds on the same condition.
assert.equal(PROJECTOR_MARKER_READ,'SELECT mode,cutover,generation FROM film_person_authority WHERE id=1');
assert.match(PROJECTOR_MARKER_CONDITION,/film_person_authority WHERE id=1 AND mode=\? AND cutover='open' AND generation=\?/);
assert.match(PROJECTOR_MARKER_GUARD,/^INSERT INTO projection_fence \(held\) SELECT CASE WHEN .* THEN 1 ELSE 0 END$/);
assert.equal(projectorFence(null),null);assert.equal(projectorFence({state:'legacy'}),null);
assert.throws(()=>projectorFence({state:'d1',generation:2,r2Allowed:false}),error=>error.code==='film_person_not_projector','a state the projector may not write in has no fence (fail closed)');
const fence=projectorFence({state:'prepared',generation:3,r2Allowed:true});
assert.deepEqual(fence[1],['prepared',3]);assert.ok(String(fence[0]).includes('cutover'),'the dormant producers fence carries the marker condition');
// The retired runner cannot come back unnoticed: no source file but the authority module and the producers names these guards.
for(const file of fs.readdirSync('src').filter(name=>name.endsWith('.js')&&!['film-person-authority.js','canonical-producers.js'].includes(name)))assert.doesNotMatch(fs.readFileSync('src/'+file,'utf8'),/PROJECTOR_MARKER_GUARD|projectorGuard\(/,file);
console.log('projector marker guard: only r2 and prepared at open give an expectation, d1/held/malformed rows never do, a moved mode or generation fails the re-read, the guard SQL binds mode and generation, and no other module uses it');
