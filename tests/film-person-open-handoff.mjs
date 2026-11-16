import assert from 'node:assert/strict';
import fs from 'node:fs';
import {applyFilmFacts} from '../src/canonical-producer-adapters.js';
import {handoffReadiness} from '../src/canonical-producers.js';
import {grantProjectorWindow,requestProjectorWindow} from '../src/discovery-authority.js';
import {projectorExpectation} from '../src/film-person-authority.js';
import {writerRoute} from '../src/canonical-writer-route.js';
import {CANONICAL_READER_REGISTRY} from '../src/canonical-catalog-reader.js';
import {
 ACTIVATION_CONSUMERS,
 OPEN_HANDOFF_MIN_VERSION,
 OPERATOR_D1_TARGET,
 WORKFLOW_FILM_FACTS,
 activationAudit,
 activateOpen,
 activationReadiness,
 exclusiveOwned,
 flipOpen,
 runExclusiveHandoff,
 parseOpenHandoffArgs,
 proveOperatorTarget,
 takeProjectorLease,
 transactionalStatements,
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
assert.equal(ACTIVATION_CONSUMERS.length,CANONICAL_READER_REGISTRY.length);
const audit=activationAudit();
assert.equal(audit.consumers.length,CANONICAL_READER_REGISTRY.length);
assert.equal(audit.consumers.filter(item=>item.class==='freeze'&&item.moved!==true).length,11);
assert.equal(audit.consumers.filter(item=>item.kind==='adr0117_exception').length,5);
assert.ok(audit.consumers.some(item=>item.name==='metadata cache mirror object of the D1 metadata cache'&&item.kind==='adr0117_exception'));
assert.deepEqual([...WORKFLOW_FILM_FACTS],['watchlist','canonicalIdentity','originalTitle']);
assert.ok(audit.residuals.some(item=>item==='workflow_facts_absent:film_metadata'));
assert.ok(audit.residuals.some(item=>item.startsWith('producer_not_wired:')));
assert.ok(audit.producers.find(item=>item.name==='discovery_admission').wired);
const workflowSrc=fs.readFileSync('src/canonical-producer-workflow.js','utf8');
assert.match(workflowSrc,/function filmFactsOf\(film,watchlisted\)\{\n return \{watchlist:watchlisted,film:\{contractVersion:1,canonicalIdentity:film\?\.canonicalIdentity\|\|null,originalTitle:film\?\.original\|\|film\?\.title\|\|null\}\};\n\}/);
assert.doesNotMatch(workflowSrc.slice(workflowSrc.indexOf('function filmFactsOf'),workflowSrc.indexOf('function idsOf')),/metadata|sync_state|dimension/);
assert.equal(proveOperatorTarget({target:{...OPERATOR_D1_TARGET,endpointOverride:false},described:{name:OPERATOR_D1_TARGET.databaseName,uuid:OPERATOR_D1_TARGET.databaseId}}).ok,true);
assert.ok(!proveOperatorTarget({target:{...OPERATOR_D1_TARGET,endpointOverride:true},described:{name:OPERATOR_D1_TARGET.databaseName,uuid:OPERATOR_D1_TARGET.databaseId}}).ok);
assert.ok(!proveOperatorTarget({target:{...OPERATOR_D1_TARGET,databaseId:'00000000-0000-0000-0000-000000000000',endpointOverride:false},described:{name:'iptv',uuid:OPERATOR_D1_TARGET.databaseId}}).ok);
assert.throws(()=>parseOpenHandoffArgs(['--nope']),/film_person_invalid/);
assert.deepEqual(parseOpenHandoffArgs(['--apply','--confirm-go','--expected-generation=1','--expected-reference=t']),{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:'t'});

const bundled=fs.readFileSync('build.mjs','utf8')+' '+fs.readFileSync('src/worker.js','utf8');
assert.doesNotMatch(bundled,/film-person-open-handoff/);

{
 const file=openDb();
 const env=envOf(file);
 const ready=await activationReadiness(env,{now:T,expectedGeneration:1,expectedReference:REF,classes:CLASSES});
 assert.equal(ready.ready,false,ready.blockers.join(','));
 assert.ok(ready.blockers.some(item=>item.startsWith('freeze_unmoved:')));
 assert.ok(ready.blockers.some(item=>item.startsWith('producer_not_wired:')));
 assert.ok(ready.blockers.some(item=>item==='workflow_facts_absent:film_metadata'));
 assert.match(ready.nextMinimalFix,/Move the 11 freeze consumers/);
 const handoff=await handoffReadiness(env,{now:T});
 assert.equal(handoff.ready,false);
 const dry=await activateOpen(env,{apply:false,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES});
 assert.equal(dry.outcome,'dry_run');
 assert.equal(dry.readiness.ready,false);
 assert.equal(q(file,'SELECT mode FROM film_person_authority WHERE id=1').mode,'prepared');
 const refused=await activateOpen(env,{apply:true,confirmGo:false,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES});
 assert.equal(refused.reason,'confirm_go_required');
 const operands=await activateOpen(env,{apply:true,confirmGo:true,now:T,classes:CLASSES});
 assert.equal(operands.reason,'go_operands_required');
}

{
 const file=openDb();
 const blocked=await activateOpen(envOf(file),{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-1'});
 assert.equal(blocked.outcome,'stop');
 assert.equal(blocked.reason,'preflight');
 const out=await runExclusiveHandoff(envOf(file),{expectedGeneration:1,expectedReference:REF,owner:'op-1'});
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
 const armed=await runExclusiveHandoff(env,{expectedGeneration:1,expectedReference:REF,owner:'op-9'});
 assert.equal(armed.outcome,'activated');
 const again=await activateOpen(env,{apply:true,confirmGo:true,expectedGeneration:1,expectedReference:REF,now:T,classes:CLASSES,owner:'op-9b'});
 assert.equal(again.outcome,'stop');
 assert.equal(again.reason,'preflight');
}

{
 const file=openDb();
 const env=envOf(file);
 const wall=Date.now();
 const taken=await takeProjectorLease(env,{owner:'op-10',now:wall});
 assert.equal(taken.taken,true);
 const requested=await requestProjectorWindow(env,{owner:'op-10',now:wall});
 assert.equal(requested.outcome,'requested');
 const granted=await grantProjectorWindow(env,{owner:'op-10',now:wall});
 assert.equal(granted.outcome,'granted',JSON.stringify(granted));
 const flipped=await flipOpen(env,{expectedGeneration:1,expectedReference:REF,owner:'op-10'});
 assert.equal(flipped.outcome,'flipped');
 assert.equal((await writerRoute(env)).writer,'canonical');
 assert.equal(projectorExpectation(q(file,'SELECT mode,cutover,generation FROM film_person_authority WHERE id=1')),null);
 const facts={id:'film:tmdb:603',at:T,film:{contractVersion:1,originalTitle:'Title A',source:'tmdb'},metadata:{schemaVersion:1,year:1999,runtime:136,synopsis:'A',poster:'/p.jpg',url:'https://example.test/m',genres:['sci-fi'],peopleVersion:2,payload:{k:'v'},r2Key:null,contentSha256:null,updatedAt:T},sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true};
 await assert.rejects(()=>applyFilmFacts(env,{origin:'epg',event:'tick',input:facts,now:()=>T}),error=>error.code==='receipt_baseline_missing');
 assert.equal(q(file,'SELECT COUNT(*) AS n FROM canonical_receipt_baseline_seal').n,0);
}

{
 const file=openDb();
 const wall=Date.now();
 const db=d1Standin(file,{onQuery:async text=>{
  if(/UPDATE film_person_authority SET mode='d1'/.test(text))throw new Error('transport');
 }});
 const env={DB:db};
 const taken=await takeProjectorLease(env,{owner:'op-11',now:wall});
 assert.equal(taken.taken,true);
 const requested=await requestProjectorWindow(env,{owner:'op-11',now:wall});
 assert.equal(requested.outcome,'requested');
 const granted=await grantProjectorWindow(env,{owner:'op-11',now:wall});
 assert.equal(granted.outcome,'granted');
 const flipped=await flipOpen(env,{expectedGeneration:1,expectedReference:REF,owner:'op-11'});
 assert.equal(flipped.outcome,'stop');
 assert.equal(flipped.reason,'flip_not_applied');
 assert.equal(flipped.retry,false);
 assert.equal(q(file,'SELECT generation FROM film_person_authority WHERE id=1').generation,1);
}

{
 const file=openDb();
 sqlite(file,"UPDATE film_person_authority SET mode='d1', generation=2 WHERE id=1");
 const flipped=await flipOpen(envOf(file),{expectedGeneration:1,expectedReference:REF,owner:'ghost'});
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
 const file=openDb();
 const env=envOf(file);
 const wall=Date.now();
 await takeProjectorLease(env,{owner:'op-13',now:wall});
 assert.equal((await requestProjectorWindow(env,{owner:'op-13',now:wall})).outcome,'requested');
 assert.equal((await grantProjectorWindow(env,{owner:'op-13',now:wall})).outcome,'granted');
 sqlite(file,'UPDATE projector_window SET expires_at=1 WHERE id=1');
 const flipped=await flipOpen(env,{expectedGeneration:1,expectedReference:REF,owner:'op-13'});
 assert.equal(flipped.outcome,'stop');
 assert.equal(flipped.reason,'flip_precondition');
 assert.equal(q(file,'SELECT generation FROM film_person_authority WHERE id=1').generation,1);
 assert.equal(await exclusiveOwned(env,{owner:'op-13'}),false);
}

{
 const file=openDb();
 let batches=0;
 const db=d1Standin(file,{onBatch:async()=>{batches++;}});
 const env={DB:db};
 const wall=Date.now();
 await takeProjectorLease(env,{owner:'op-14',now:wall});
 assert.equal((await requestProjectorWindow(env,{owner:'op-14',now:wall})).outcome,'requested');
 const before=batches;
 assert.equal((await grantProjectorWindow(env,{owner:'op-14',now:wall})).outcome,'granted');
 const afterGrant=batches;
 const flipped=await flipOpen(env,{expectedGeneration:1,expectedReference:REF,owner:'op-14'});
 assert.equal(flipped.outcome,'flipped',JSON.stringify(flipped));
 assert.equal(batches,afterGrant,'flip is one UPDATE via run(), not a REST batch');
 assert.ok(afterGrant>before);
}

{
 const file=openDb();
 const wall=Date.now();
 let wrote=false;
 const db=d1Standin(file,{onQuery:async text=>{
  if(/UPDATE film_person_authority SET mode='d1'/.test(text))wrote=true;
  else if(wrote&&/SELECT version FROM schema_contract/.test(text))throw new Error('read_lost');
 }});
 const env={DB:db};
 await takeProjectorLease(env,{owner:'op-15',now:wall});
 assert.equal((await requestProjectorWindow(env,{owner:'op-15',now:wall})).outcome,'requested');
 assert.equal((await grantProjectorWindow(env,{owner:'op-15',now:wall})).outcome,'granted');
 const flipped=await flipOpen(env,{expectedGeneration:1,expectedReference:REF,owner:'op-15'});
 assert.equal(flipped.outcome,'unknown');
 assert.equal(flipped.retry,false);
 assert.equal(flipped.wrote,true);
 assert.equal(q(file,'SELECT mode FROM film_person_authority WHERE id=1').mode,'d1');
 assert.equal(q(file,'SELECT owner FROM projector_window WHERE id=1').owner,'op-15');
}

{
 const wrapped=transactionalStatements(["UPDATE projector_window SET state='held' WHERE id=1","UPDATE discovery_cas SET ok=changes() WHERE id=1"]);
 assert.equal(wrapped[0],'BEGIN IMMEDIATE;');
 assert.equal(wrapped.at(-1),'COMMIT;');
 assert.equal(wrapped.length,4);
}

{
 const src=fs.readFileSync('src/film-person-open-handoff.js','utf8')+' '+fs.readFileSync('scripts/film-person-open-handoff.mjs','utf8');
 assert.match(src,/strftime\('%s','now'\)/);
 assert.match(src,/proveOperatorTarget/);
 assert.match(src,/PRODUCER_WIRING/);
 assert.match(src,/BEGIN IMMEDIATE/);
 assert.match(src,/go_operands_required/);
}
