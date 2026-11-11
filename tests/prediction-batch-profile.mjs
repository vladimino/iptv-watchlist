// AIR-438. The offline batch profile (scripts/prediction-batch-profile.mjs) is deterministic and shows what the evidence report states: a
// step's storage cost has a fixed part that does not shrink with the selection batch (the stored queue is moved whole several times), a part
// that grows by two reads per selected film in `next`, and a submit whose per-film cost falls as items share one step.
import assert from 'node:assert/strict';
import {measure,filmsPerActiveHour,CONFIGS,SCENARIOS} from '../scripts/prediction-batch-profile.mjs';

const a=await measure({S:1,r:1,s:1,catalogSize:130}),b=await measure({S:5,r:1,s:1,catalogSize:130}),c=await measure({S:20,r:1,s:1,catalogSize:130});
// `next` adds exactly two storage calls (fingerprint and predictions) per film of the selection; `submit` does not read the selection.
assert.equal(b.next.calls-a.next.calls,2*(5-1));assert.equal(c.next.calls-b.next.calls,2*(20-5));
assert.equal(a.submit.calls,b.submit.calls);assert.equal(b.submit.calls,c.submit.calls);
// The same measurement twice gives the same calls and, to a few bytes, the same sizes: the profile can be cited.
// Storage calls are exact; byte sizes vary by a few bytes with the length of the timestamps and ids written, so they are compared to 0.5 %.
const again=await measure({S:5,r:1,s:1,catalogSize:130});
assert.equal(again.next.calls,b.next.calls);assert.equal(again.submit.calls,b.submit.calls);assert.deepEqual(Object.keys(again.next.classes),Object.keys(b.next.classes));
for(const [x,y] of [[again.next.r2Bytes,b.next.r2Bytes],[again.submit.r2Bytes,b.submit.r2Bytes],[again.next.responseBytes,b.next.responseBytes]])assert.ok(Math.abs(x-y)/y<.005,'bytes differ by '+(x-y));
// What a request asks of the model does not change what the Worker reads: one item or twenty cost the same calls in `next`.
const r1=await measure({S:20,r:1,s:1,catalogSize:130}),r20=await measure({S:20,r:20,s:1,catalogSize:130});
assert.equal(r1.next.calls,r20.next.calls);assert.ok(r20.next.responseBytes>r1.next.responseBytes,'the answer carries every item');
// The stored queue is moved whole by every step: its bytes follow the number of films, not the batch.
const small=await measure({S:12,r:1,s:1,catalogSize:130}),large=await measure({S:12,r:1,s:1,catalogSize:1000});
const queue=m=>m.next.classes['r2:queue'].bytes,perFilm=(queue(large)-queue(small))/(1000-130);
assert.ok(perFilm>300&&perFilm<2500,'queue bytes per film '+perFilm);
assert.ok(queue(large)>5*queue(small),'a larger queue is a larger step');
assert.equal(small.next.calls,large.next.calls,'the number of calls does not depend on the queue size, the bytes do');
// Items that share a submit share its fixed cost.
const one=await measure({S:12,r:10,s:1,catalogSize:130}),ten=await measure({S:12,r:10,s:10,catalogSize:130});
const callsPerFilm=m=>(m.next.calls+m.submit.calls)/m.s,bytesPerFilm=m=>(m.next.r2Bytes+m.submit.r2Bytes)/m.s;
assert.ok(callsPerFilm(ten)<callsPerFilm(one)/2,'calls per film '+callsPerFilm(one)+' -> '+callsPerFilm(ten));
assert.ok(bytesPerFilm(ten)<bytesPerFilm(one)/2,'bytes per film '+bytesPerFilm(one)+' -> '+bytesPerFilm(ten));
// The throughput model reproduces the two regimes observed on 11 November 2026 for today's configuration (about 28 films/h in the slow regime
// of run 3bfcac84, about 49 in the fast one of run 6ad5062e) before it is used for any other configuration.
const today=CONFIGS[0];
assert.ok(Math.abs(filmsPerActiveHour(today,'likely').filmsPerHour-28.4)/28.4<.15,'slow regime '+filmsPerActiveHour(today,'likely').filmsPerHour);
assert.ok(Math.abs(filmsPerActiveHour(today,'best').filmsPerHour-48.6)/48.6<.15,'fast regime '+filmsPerActiveHour(today,'best').filmsPerHour);
for(const config of CONFIGS)for(const scenario of Object.keys(SCENARIOS)){const r=filmsPerActiveHour(config,scenario);assert.ok(r.filmsPerHour>0&&Number.isFinite(r.filmsPerHour),config.name+' '+scenario);}
// Ordering the report relies on: sharing steps helps, and a selection batch beyond what the API accepts does not by itself.
const hour=(c,k)=>filmsPerActiveHour(c,k).filmsPerHour;
assert.ok(hour(CONFIGS[3],'likely')>hour(CONFIGS[0],'likely')*1.5,'g=5, s=5 is at least 1.5x today in the likely case');
assert.ok(hour(CONFIGS[7],'likely')<hour(CONFIGS[4],'likely'),'S=500 is slower than S=20 at the same g and s: the selection reads grow');
console.log('prediction batch profile tests passed');
