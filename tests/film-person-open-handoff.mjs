import assert from 'node:assert/strict';
import fs from 'node:fs';
import {applyFilmFacts} from '../src/canonical-producer-adapters.js';
import {handoffReadiness} from '../src/canonical-producers.js';
import {grantProjectorWindow,requestProjectorWindow} from '../src/discovery-authority.js';
import {projectorExpectation} from '../src/film-person-authority.js';
import {writerRoute} from '../src/canonical-writer-route.js';
import {
 ACTIVATION_CONSUMERS,
 OPEN_HANDOFF_MIN_VERSION,
 activateOpen,
 activationReadiness,
 flipOpen,
 parseOpenHandoffArgs,
 takeProjectorLease,
} from '../src/film-person-open-handoff.js';
import {d1Standin} from './d1-standin.mjs';
import {copyOf,envOf,fresh,rows,sqlite} from './canonical-differential-helper.mjs';

const T='2026-11-16T08:00:00.000Z';
const Tms=Date.parse(T);
const REF='t';
const CLASSES=[{name:'ratedAdmission',table:'film_rated_admission',expected:0},{name:'retention',table:'film_retention',expected:0},{name:'retirement',table:'tmdb_retirement_decision',expected:0}];
const DISCOVERY="UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1;";
const openDb=()=>{const file=fresh();sqlite(file,DISCOVERY);return file;};
const q=(file,sql)=>rows(file,sql)[0];

assert.equal(OPEN_HANDOFF_MIN_VERSION,23);
assert.equal(ACTIVATION_CONSUMERS.length,4);
assert.throws(()=>parseOpenHandoffArgs(['--nope']),/film_person_invalid/);
assert.deepEqual(parseOpenHandoffArgs(['--apply','--confirm-go','--expected-generation=1','--expected-reference=t']),{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:'t'});

const bundled=fs.readFileSync('build.mjs','utf8')+' '+fs.readFileSync('src/worker.js','utf8');
assert.doesNotMatch(bundled,/film-person-open-handoff/);

{
 const file=openDb();
 const env=envOf(file);
 const ready=await activationReadiness(env,{now:T,expectedGeneration:1,expectedReference:REF,classes:CLASSES});
 assert.equal(ready.ready,true,ready.blockers.join(','));
 const handoff=await handoffReadiness(env,{now:T});
 assert.equal(handoff.ready,false);
 assert.ok(handoff.blockers.some(item=>item.startsWith('producer_not_wired:')));
 assert.ok(handoff.blockers.some(item=>item.startsWith('reader_not_moved:')));
 const dry=await activateOpen(env,{apply:false,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES});
 assert.equal(dry.outcome,'dry_run');
 assert.equal(q(file,'SELECT mode FROM film_person_authority WHERE id=1').mode,'prepared');
 const refused=await activateOpen(env,{apply:true,confirmGo:false,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES});
 assert.equal(refused.reason,'confirm_go_required');
}

{
 const file=openDb();
 const out=await activateOpen(envOf(file),{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-1'});
 assert.equal(out.outcome,'activated',JSON.stringify(out));
 assert.equal(out.generation,2);
 assert.equal(q(file,'SELECT mode FROM film_person_authority WHERE id=1').mode,'d1');
 assert.equal(q(file,'SELECT generation FROM film_person_authority WHERE id=1').generation,2);
 assert.equal(q(file,'SELECT COUNT(*) AS n FROM canonical_receipt_baseline_seal').n,1);
 assert.equal(q(file,'SELECT state FROM projector_window WHERE id=1').state,'idle');
 assert.equal(q(file,"SELECT lease_id FROM projection_run WHERE projection='enrichment'").lease_id,null);
 const env=envOf(file);
 assert.equal((await writerRoute(env)).writer,'canonical');
 assert.equal(projectorExpectation(q(file,'SELECT mode,cutover,generation FROM film_person_authority WHERE id=1')),null);
 assert.equal((await handoffReadiness(env,{now:T})).ready,false);
}

{
 const file=openDb();
 sqlite(file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','other','2026-11-16T09:00:00.000Z','2026-11-16T07:00:00.000Z')");
 const out=await activateOpen(envOf(file),{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-2'});
 assert.equal(out.outcome,'stop');
 assert.equal(out.reason,'preflight');
 assert.ok(out.readiness.blockers.includes('projector_lease_live'));
 assert.equal(q(file,'SELECT generation FROM film_person_authority WHERE id=1').generation,1);
}

{
 const file=openDb();
 sqlite(file,"UPDATE projector_window SET state='held', owner='other', requested_at="+Tms+", expires_at="+(Tms+300000)+" WHERE id=1");
 const out=await activateOpen(envOf(file),{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-3'});
 assert.equal(out.outcome,'stop');
 assert.ok(out.readiness.blockers.includes('projector_window_not_idle:held'));
}

{
 const file=openDb();
 sqlite(file,"UPDATE discovery_lease SET lease_id='disc-other', expires_at="+(Tms+60000)+" WHERE id=1");
 const out=await activateOpen(envOf(file),{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-4'});
 assert.equal(out.outcome,'stop');
 assert.ok(out.readiness.blockers.includes('discovery_lease_live'));
}

{
 const file=openDb();
 const env=envOf(file);
 await takeProjectorLease(env,{owner:'op-5',now:T});
 const requested=await requestProjectorWindow(env,{owner:'op-5',now:Tms});
 assert.equal(requested.outcome,'requested');
 const out=await activateOpen(env,{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-5'});
 assert.equal(out.outcome,'stop');
 assert.ok(out.readiness.blockers.includes('projector_lease_live')||out.readiness.blockers.includes('projector_window_not_idle:requested'),out.readiness.blockers.join(','));
}

{
 const file=openDb();
 const out=await activateOpen(envOf(file),{apply:true,confirmGo:true,expectedGeneration:9,expectedReference:REF,now:T,classes:CLASSES,owner:'op-6'});
 assert.equal(out.outcome,'stop');
 assert.ok(out.readiness.blockers.some(item=>item.startsWith('generation_mismatch')));
}

{
 const file=openDb();
 const out=await activateOpen(envOf(file),{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:'wrong',now:T,classes:CLASSES,owner:'op-7'});
 assert.equal(out.outcome,'stop');
 assert.ok(out.readiness.blockers.includes('baseline_reference_mismatch'));
}

{
 const file=openDb();
 const env=envOf(file);
 const armed=await activateOpen(env,{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-9'});
 assert.equal(armed.outcome,'activated');
 const again=await activateOpen(env,{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-9b'});
 assert.equal(again.outcome,'stop');
 assert.ok(again.readiness.blockers.some(item=>item.startsWith('marker_not_prepared')));
}

{
 const file=openDb();
 const env=envOf(file);
 const taken=await takeProjectorLease(env,{owner:'op-10',now:T});
 assert.equal(taken.taken,true);
 const requested=await requestProjectorWindow(env,{owner:'op-10',now:Tms});
 assert.equal(requested.outcome,'requested');
 const granted=await grantProjectorWindow(env,{owner:'op-10',now:Tms});
 assert.equal(granted.outcome,'granted',JSON.stringify(granted));
 const flipped=await flipOpen(env,{expectedGeneration:1,expectedReference:REF,owner:'op-10',now:T});
 assert.equal(flipped.outcome,'flipped');
 assert.equal((await writerRoute(env)).writer,'canonical');
 assert.equal(projectorExpectation(q(file,'SELECT mode,cutover,generation FROM film_person_authority WHERE id=1')),null);
 const facts={id:'film:tmdb:603',at:T,film:{contractVersion:1,originalTitle:'Title A',source:'tmdb'},metadata:{schemaVersion:1,year:1999,runtime:136,synopsis:'A',poster:'/p.jpg',url:'https://example.test/m',genres:['sci-fi'],peopleVersion:2,payload:{k:'v'},r2Key:null,contentSha256:null,updatedAt:T},sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true};
 await assert.rejects(()=>applyFilmFacts(env,{origin:'epg',event:'tick',input:facts,now:()=>T}),error=>error.code==='receipt_baseline_missing');
 assert.equal(q(file,'SELECT COUNT(*) AS n FROM canonical_receipt_baseline_seal').n,0);
}

{
 const file=openDb();
 const db=d1Standin(file,{onBatch:async statements=>{
  if(statements.some(item=>/UPDATE film_person_authority SET mode='d1'/.test(item.text)))throw new Error('transport');
 }});
 const env={DB:db};
 const taken=await takeProjectorLease(env,{owner:'op-11',now:T});
 assert.equal(taken.taken,true);
 const requested=await requestProjectorWindow(env,{owner:'op-11',now:Tms});
 assert.equal(requested.outcome,'requested');
 const granted=await grantProjectorWindow(env,{owner:'op-11',now:Tms});
 assert.equal(granted.outcome,'granted');
 const flipped=await flipOpen(env,{expectedGeneration:1,expectedReference:REF,owner:'op-11',now:T});
 assert.equal(flipped.outcome,'stop');
 assert.equal(flipped.reason,'flip_not_applied');
 assert.equal(flipped.retry,false);
 assert.equal(q(file,'SELECT generation FROM film_person_authority WHERE id=1').generation,1);
}

{
 const file=openDb();
 sqlite(file,"UPDATE film_person_authority SET mode='d1', generation=2 WHERE id=1");
 const flipped=await flipOpen(envOf(file),{expectedGeneration:1,expectedReference:REF,owner:'ghost',now:T});
 assert.ok(['stop','unknown','unknown_committed'].includes(flipped.outcome));
 assert.notEqual(flipped.retry,true);
}

{
 const file=copyOf(fresh(),'no-disc');
 const out=await activateOpen(envOf(file),{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-12'});
 assert.equal(out.outcome,'stop');
 assert.ok(out.readiness.blockers.includes('discovery_not_open'));
}

{
 const src=fs.readFileSync('src/film-person-open-handoff.js','utf8');
 assert.match(src,/handoffReadiness/);
 assert.match(src,/frozen R2 mirrors/);
 assert.doesNotMatch(src,/PRODUCER_WIRING/);
}
