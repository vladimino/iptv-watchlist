// AIR-480: every deterministic acceptance example of ADR 0142 names the tests that cover it.
// Local files only; this file does not call Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const examples=[
 {n:1,title:'Assign to a member',files:['tests/discovery-slot-assignment.mjs','tests/published-epg-completed.mjs']},
 {n:2,title:'Assign to a Film outside the watchlist',files:['tests/published-epg-completed.mjs','tests/programme-catalog-route.mjs']},
 {n:3,title:'One Film per identity, no membership side effect',files:['tests/discovery-slot-assignment.mjs','tests/programme-catalog-route.mjs']},
 {n:4,title:'Replay',files:['tests/discovery-slot-assignment.mjs']},
 {n:5,title:'Stale run',files:['tests/discovery-slot-assignment.mjs']},
 {n:6,title:'Re-application',files:['tests/discovery-slot-assignment.mjs']},
 {n:7,title:'Bounded drift, per slot',files:['tests/discovery-slot-assignment.mjs','tests/discovery-revalidation.mjs']},
 {n:8,title:'No chaining',files:['tests/discovery-slot-assignment.mjs']},
 {n:9,title:'No anchor',files:['tests/discovery-slot-assignment.mjs']},
 {n:10,title:'Drift is visible; the owner can always end it',files:['tests/discovery-revalidation.mjs']},
 {n:11,title:'Slot taken',files:['tests/discovery-slot-assignment.mjs']},
 {n:12,title:'Film without a record',files:['tests/discovery-slot-assignment.mjs']},
 {n:13,title:'Owner correction',files:['tests/discovery-slot-assignment.mjs']},
 {n:14,title:'Change signal',files:['tests/published-epg-completed.mjs']},
 {n:15,title:'EPG priority',files:['tests/discovery-slot-assignment.mjs']},
 {n:16,title:'One increment per sync',files:['tests/persist-watchlist-tail.mjs']},
 {n:17,title:'Failed decision compare-and-set',files:['tests/discovery-slot-assignment.mjs']},
 {n:18,title:'Crash between the writes',files:['tests/discovery-slot-assignment.mjs']},
 {n:19,title:'Racing owner correction',files:['tests/discovery-slot-assignment.mjs']},
 {n:20,title:'Inactive observation or changed slot',files:['tests/discovery-slot-assignment.mjs']},
 {n:21,title:'Duplicate slot',files:['tests/epg-slot-uniqueness.mjs']},
 {n:22,title:'Read during a correction',files:['tests/published-epg-completed.mjs']},
 {n:23,title:'Mirror reconciliation',files:['tests/published-epg-completed.mjs']},
 {n:24,title:'Revert after an assignment',files:['tests/published-epg-completed.mjs']},
 {n:25,title:'Catalog reader unavailable',files:['tests/programme-catalog-route.mjs']},
 {n:26,title:'One source of availability',files:['tests/prediction-queue-hotenteredat.mjs','tests/catalog-completed-d1.mjs','tests/film-person-reader.mjs']},
 {n:27,title:'Aliases stay with the identity',files:['tests/catalog-availability-writes.mjs']},
 {n:28,title:'Revalidation reconfirms',files:['tests/discovery-revalidation.mjs']},
 {n:29,title:'A verified duration is not chaining',files:['tests/discovery-revalidation.mjs','tests/discovery-slot-assignment.mjs']},
 {n:30,title:'Revalidation does not reconfirm',files:['tests/discovery-revalidation.mjs']},
 {n:31,title:'Bounds of revalidation',files:['tests/discovery-revalidation.mjs']},
 {n:32,title:'A catalog Film the scan confirms (R2)',files:['tests/catalog-availability-writes.mjs','tests/published-epg-completed.mjs']},
 {n:33,title:'No canonical alias write (R3)',files:['tests/catalog-availability-writes.mjs']},
 {n:34,title:'An earlier decision with one duration',files:['tests/discovery-slot-assignment.mjs']},
 {n:35,title:'An earlier decision with accumulated durations',files:['tests/discovery-slot-assignment.mjs','tests/discovery-revalidation.mjs']},
 {n:36,title:'The detail gate alone is not a verification',files:['tests/discovery-revalidation.mjs']},
 {n:37,title:'A reconfirmed duration beside a verified one',files:['tests/discovery-revalidation.mjs']},
 {n:38,title:'Twelve failures, not twelve checks (R4)',files:['tests/discovery-revalidation.mjs']},
];

assert.equal(examples.length,38);
assert.deepEqual(examples.map(item=>item.n),Array.from({length:38},(_,index)=>index+1));
for(const example of examples){
 assert.ok(example.files.length,'example '+example.n+' names at least one test');
 for(const file of example.files)assert.equal(fs.existsSync(file),true,file+' covers example '+example.n);
}
const adr=fs.readFileSync('docs/adr/0142-epg-owned-generation-addressed-discovery-slots.md','utf8');
for(const example of examples){
 const heading=example.n+'. **'+example.title;
 assert.ok(adr.includes(heading),'ADR still names example '+example.n+' as '+example.title);
}
console.log('adr 0142 examples: 38 mapped');
