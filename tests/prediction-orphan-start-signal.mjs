// ADR 0193 / AIR-573: repeated orphan starts are one more reason of the shared AIR-556 progress verdict (Footer and Monitor), not a second monitor. Pure functions of enrichment.js, no storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,encodeURIComponent,decodeURIComponent});
for(const f of ['src/domain/prediction-versions.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-confidence.js','src/enrichment.js'])vm.runInContext(fs.readFileSync(f,'utf8').replace('export default','globalThis.worker='),ctx);
const now=Date.parse('2026-11-21T14:00:00Z'),min=60000,at=m=>new Date(now-m*min).toISOString();
const progress=m=>({runId:'p'+m,status:'complete',stopReason:'manifest_spent',added:5,updated:0,failed:0,startedAt:at(m+2),endedAt:at(m)});
const turnedAway=(m,id)=>({runId:'a'+id,status:'completed',state:'completed',startResult:'already_running',startedAt:at(m),endedAt:at(m)});
const abandoned=(m,id)=>({runId:'o'+id,status:'interrupted',stopReason:'lease_expired',added:0,updated:0,failed:0,startedAt:at(m+15),endedAt:at(m)});
const evidence=(rows,run=null)=>ctx.predictionRunEvidence({run,recentRuns:rows,now});
const verdict=(rows,extra={})=>{const e=evidence(rows);return ctx.predictionStallAssessment({now,sinceMs:e.lastProgressAt?Date.parse(e.lastProgressAt):null,eligibleNow:9,orphanStarts:e.orphanStarts,...extra});};

// The incident of 21 Nov 2026: one abandoned owned run and three turned-away starts after 40 minutes without progress.
{
 const rows=[progress(40),abandoned(25,1),turnedAway(24,1),turnedAway(23,2),turnedAway(10,3)];
 assert.equal(evidence(rows).orphanStarts,4);
 const v=verdict(rows);assert.equal(v.state,'no_progress');assert.equal(v.reason,'repeated_orphan_starts');assert.equal(v.orphanStarts,4);assert.ok(v.idleMs<60*min,'earlier than the 60 minute limit of AIR-556: '+v.idleMs);
 assert.equal(ctx.predictionStallAssessment({now,sinceMs:now-40*min,eligibleNow:9}).state,'ok','without the orphan count the same silence is still healthy at 40 minutes (the 60 minute verdict is unchanged)');
}
// Fewer than three, a recent progress, or a run that is still working are not repeated orphan starts.
{
 assert.equal(verdict([progress(40),turnedAway(24,1),turnedAway(10,2)]).state,'ok','two attempts are an overlap, not a chain');
 assert.equal(verdict([progress(5),turnedAway(4,1),turnedAway(3,2),turnedAway(2,3)]).state,'ok','progress five minutes ago resets the chain');
 assert.equal(evidence([progress(40),turnedAway(24,1),turnedAway(23,2),turnedAway(22,3)],{runId:'live',status:'running',createdAt:at(1),added:0}).orphanStarts,3,'a running run is not counted as abandoned');
 // AIR-596 (ADR 0210): a live young lease no longer hides a proven chain; it is running only while nothing is proven.
 const running=ctx.predictionStallAssessment({now,sinceMs:now-40*min,eligibleNow:9,orphanStarts:5,activeRun:true,activeStartedAtMs:now-2*min});assert.equal(running.state,'no_progress','a young live run does not hide five ownerless starts after 40 minutes');assert.equal(running.reason,'repeated_orphan_starts');assert.equal(running.activeRun,true);
 assert.equal(ctx.predictionStallAssessment({now,sinceMs:now-40*min,eligibleNow:9,orphanStarts:2,activeRun:true,activeStartedAtMs:now-2*min}).state,'running','an overlap with a young live run is still running');
 assert.equal(ctx.predictionStallAssessment({now,sinceMs:now-10*min,eligibleNow:9,orphanStarts:5}).state,'ok','under 20 minutes of silence nothing is raised');
 assert.equal(ctx.predictionStallAssessment({now,sinceMs:now-40*min,eligibleNow:0,orphanStarts:5}).state,'idle','no eligible work, no alert');
}
// An old chain outside the window and attempts before the last progress do not count.
{
 assert.equal(evidence([turnedAway(200,1),turnedAway(190,2),turnedAway(180,3)]).orphanStarts,0,'outside the two hour window');
 assert.equal(evidence([turnedAway(50,1),turnedAway(49,2),turnedAway(48,3),progress(40)]).orphanStarts,0,'before the last confirmed progress');
}
// The Monitor's issue names the reason and keeps the one key `predictions_no_progress`.
{
 const policy=await import('../src/domain/monitor-policy.js');
 const out=policy.evaluatePredictions({present:true,pendingCount:9,eligibleNow:9,stall:{state:'no_progress',reason:'repeated_orphan_starts',idleMs:40*min,orphanStarts:4},lastProgressAt:at(40)},null,now);
 const text=JSON.stringify(out);
 assert.equal(out.state,'degraded',text.slice(0,300));assert.match(text,/predictions_no_progress/);assert.match(text,/with 4 ownerless starts since/);assert.equal(out.facts.stallReason,'repeated_orphan_starts');
 const plain=policy.evaluatePredictions({present:true,pendingCount:9,eligibleNow:9,stall:{state:'no_progress',reason:'no_productive_batch',idleMs:70*min},lastProgressAt:at(70)},null,now);
 assert.doesNotMatch(JSON.stringify(plain),/ownerless/,'the 60 minute verdict keeps its own message');
}
console.log('prediction-orphan-start-signal: ok');
