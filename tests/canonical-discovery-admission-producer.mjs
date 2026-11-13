// AIR-374 P3c `discovery_admission` (ADR 0126 decision 2): the `film_mutation` unit of the Discovery admission and its call site (src/canonical-discovery-admission-producer.js), on the sqlite3-CLI D1 stand-in. No Worker, R2, D1 or
// Cloudflare access. Covered: eligibility of an entry, content and digest, the route gate (one marker read below `open`, nothing written), create / land-on-existing / fill-a-blank-title, the identity refusals before any receipt, the atomic
// receipt, the origin's own reconcile from the current admission row, the sweep of a current admission without a canonical Film, never throwing, the bounded call, the registry, and the static wiring (bundle scope, call site, no cycle).
// DISCOVERY_ADM_SRC points the file at a mutant copy of src/; DISCOVERY_ADM_TEMPLATE at a prebuilt template database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.DISCOVERY_ADM_SRC?path.resolve(process.env.DISCOVERY_ADM_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const M=await load('canonical-discovery-admission-producer.js');
const {PRODUCER_OPERATIONS,PRODUCER_WIRING}=await load('canonical-producers.js');
const {OPERATION_KINDS,reconcileReceipts}=await load('canonical-receipts.js');
const {writerRoute}=await load('canonical-writer-route.js');
const {admissionInput,admitDiscoveryFilms,applyDiscoveryAdmission,discoveryAdmissionDigest,discoveryAdmissionContent,discoveryAdmissionOperation,discoveryAdmissionRegistry,planAdmissionFilm,ADMIT_PER_CALL,SWEEP_PER_CALL,DISCOVERY_ORIGIN}=M;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-discovery-adm-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
if(process.env.DISCOVERY_ADM_TEMPLATE)fs.copyFileSync(process.env.DISCOVERY_ADM_TEMPLATE,template);
else{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
let n=0;
function database(stage='open'){
 const file=path.join(root,'e-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['r2','prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='open')assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const T='2026-11-13T10:00:00.000Z';
const LATER='2026-11-13T11:00:00.000Z';
const U='2026-11-01T00:00:00.000Z';
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const FID=k=>'film:tmdb:'+k;
// A Film of the canonical store with stored ids [scheme,value,trusted,conflicting].
const seedFilm=(file,id,{title='Kept',identity=null,ids=[],version=2}={})=>{
 assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ("+q(id)+","+version+","+q(identity)+","+q(title)+",'"+U+"');"+ids.map(([scheme,value,trusted=1,conflicting=0])=>"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(id)+","+q(scheme)+","+q(value)+","+trusted+","+conflicting+",NULL);").join('')).status,0);
};
const admit=(file,tmdb,{title='Admitted Title',state='current',kind='movie',id=null}={})=>assert.equal(sqlite(file,"INSERT INTO discovery_admission (film_id,tmdb_id,media_kind,canonical_identity,observation_key,programme_run_id,generation,state,payload_json) VALUES ("+q(id||'tmdb_'+tmdb)+","+q(String(tmdb))+","+q(kind)+","+q((kind==='tv'?'tmdb_tv:':'tmdb:')+tmdb)+",NULL,'run-1',1,"+q(state)+","+q(JSON.stringify({id:id||'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:(kind==='tv'?'tmdb_tv:':'tmdb:')+tmdb,title}))+");").status,0);
const entry=(tmdb,over={})=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Admitted Title',...over});
const film=(file,id)=>rows(file,"SELECT contract_version,canonical_identity,original_title,updated_at FROM film WHERE id="+q(id))[0];
const ext=(file,id)=>rows(file,"SELECT scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE film_id="+q(id)+" ORDER BY scheme,value");
const receipts=file=>rows(file,'SELECT request_id,operation,origin,target_kind,target_id,state,attempts,applied_revision,error_class FROM canonical_write_receipt ORDER BY target_id,created_at');
const TABLES=['film','film_external_id','film_alias','film_person_credit','film_redirect','canonical_revision','canonical_write_receipt'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3')]));
const input=(tmdb=603,over={})=>({tmdbId:String(tmdb),title:'Admitted Title',at:T,...over});
const EV='discovery:admission';

// 1. Eligibility of an entry and content: a verified movie only.
{
 assert.deepEqual(admissionInput('tmdb_603',entry(603),T),{tmdbId:'603',title:'Admitted Title',at:T});
 const refused=[
  ['tmdb_tv_5',entry(5,{mediaType:'tv'})],['tmdb_603',entry(603,{mediaType:'tv'})],['tmdb_603',entry(603,{kind:'tv'})],['tmdb_603',entry(603,{canonicalIdentity:'tmdb_tv:603'})],
  ['tmdb_603',entry(603,{canonicalIdentity:undefined})],['tmdb_603',entry(603,{tmdbId:'604'})],['tmdb_603',entry(603,{tmdbId:undefined})],['603',entry(603)],['tmdb_0',entry(0)],['tmdb_603',null],['tmdb_603','x'],[undefined,entry(603)],
  ['tmdb_1234567890123',entry('1234567890123')],
 ];
 for(const [key,value] of refused)assert.equal(admissionInput(key,value,T),null,JSON.stringify([key,value]));
 assert.equal(admissionInput('tmdb_603',entry(603,{title:undefined}),T).title,null);
 assert.equal(discoveryAdmissionContent(input(603,{title:'  Spaced  '})).title,'Spaced');
 assert.equal(discoveryAdmissionContent(input(603,{title:'   '})).title,null);
 for(const bad of [null,{},{tmdbId:''},{tmdbId:'0'},{tmdbId:'12a'},{tmdbId:'1234567890123'},{tmdbId:603.5}])assert.throws(()=>discoveryAdmissionContent(bad),code('film_person_invalid'),JSON.stringify(bad));
 const a=await discoveryAdmissionDigest(input(603));
 assert.equal(a,await discoveryAdmissionDigest(input(603,{at:'2031-01-01T00:00:00.000Z',tmdbId:603})),'the write clock and the number form do not move the digest');
 assert.notEqual(a,await discoveryAdmissionDigest(input(604)));
 assert.notEqual(a,await discoveryAdmissionDigest(input(603,{title:'Other'})));
 assert.ok(OPERATION_KINDS.includes('film_mutation'));
}

// 2. Dormant below open: ONE marker read and nothing else; held throws (apply) or is reported (the call site); never a fallback to a writer.
for(const stage of ['legacy','r2','prepared']){
 const file=database(stage),before=dump(file),env=envOf(file);
 assert.deepEqual(await applyDiscoveryAdmission(env,{event:EV,input:input()}),{state:'skipped',reason:'projector_is_writer',receipt:false},stage);
 const probe=envOf(file);await writerRoute(probe);
 assert.equal(env.DB.calls.queries,probe.DB.calls.queries,'exactly the marker read ('+stage+')');
 const env2=envOf(file);
 assert.deepEqual(await admitDiscoveryFilms(env2,{films:{tmdb_603:entry(603)},written:['tmdb_603'],routeSkipMs:0}),{state:'skipped',reason:'projector_is_writer'},stage);
 assert.equal(env2.DB.calls.queries,probe.DB.calls.queries,'the call site is exactly the marker read ('+stage+')');
 assert.equal(env2.DB.calls.batches,0,'no batch');
 assert.equal(dump(file),before,'nothing written at '+stage);
}
{
 const file=database('held'),before=dump(file);
 await assert.rejects(applyDiscoveryAdmission(envOf(file),{event:EV,input:input()}),code('film_person_held'));
 const out=await admitDiscoveryFilms(envOf(file),{films:{tmdb_603:entry(603)},written:['tmdb_603'],routeSkipMs:0});
 assert.equal(out.state,'unavailable');assert.equal(out.code,'film_person_held');
 assert.equal(dump(file),before);
}

// 2b. The skip is cached per binding for ROUTE_SKIP_MS (the long `prepared` wait costs no marker read per batch); a cached skip never survives the marker move, never applies to another binding, and `routeSkipMs: 0` reads every time.
{
 const file=database('prepared'),env=envOf(file);
 const first=await admitDiscoveryFilms(env,{films:{},written:[]});
 assert.deepEqual(first,{state:'skipped',reason:'projector_is_writer'});
 const reads=env.DB.calls.queries;assert.ok(reads>0);
 const second=await admitDiscoveryFilms(env,{films:{tmdb_603:entry(603)},written:['tmdb_603']});
 assert.deepEqual(second,{state:'skipped',reason:'projector_is_writer',cached:true});
 assert.equal(env.DB.calls.queries,reads,'a cached skip reads nothing');
 const other=envOf(file);
 assert.equal((await admitDiscoveryFilms(other,{films:{},written:[]})).cached,undefined,'another binding is not cached');
 assert.ok(other.DB.calls.queries>0);
 // the marker moves to open: with the cache off the next call admits; with the cache on, it waits at most ROUTE_SKIP_MS and the sweep then admits
 sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1");sqlite(file,BASELINE);
 admit(file,603);
 assert.equal((await admitDiscoveryFilms(env,{films:{},written:[],now:()=>T})).cached,true,'inside the window the skip stands');
 const open=await admitDiscoveryFilms(env,{films:{},written:[],now:()=>T,routeSkipMs:0});
 assert.equal(open.state,'done');assert.equal(open.swept,1);
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film')),1,'the sweep admitted the film once the marker was open');
 assert.ok(M.ROUTE_SKIP_MS>=1000);
}

// 3. CREATE: an absent Film is created as film:tmdb:<n> with the trusted tmdb id and the title, in ONE batch with the applied receipt.
{
 const file=database(),env=envOf(file);
 const out=await applyDiscoveryAdmission(env,{event:EV,input:input(603),now:()=>T});
 assert.equal(out.state,'applied');
 assert.deepEqual(film(file,FID(603)),{contract_version:1,canonical_identity:null,original_title:'Admitted Title',updated_at:T});
 assert.deepEqual(ext(file,FID(603)).map(row=>[row.scheme,row.value,row.trusted,row.conflicting]),[['tmdb','603',1,0]]);
 assert.deepEqual(JSON.parse(ext(file,FID(603))[0].provenance_json),{source:'discovery',verified:true});
 const list=receipts(file);
 assert.equal(list.length,1);
 assert.deepEqual([list[0].operation,list[0].origin,list[0].target_kind,list[0].target_id,list[0].state],['film_mutation',DISCOVERY_ORIGIN,'film',FID(603),'applied']);
 assert.equal(env.DB.calls.batches>=1,true);
 // the same event and content again: nothing to write, no second receipt
 const again=await applyDiscoveryAdmission(env,{event:EV,input:input(603),now:()=>T});
 assert.equal(again.state,'noop');assert.equal(receipts(file).length,1);
}

// 4. LAND ON EXISTING: a Film that already holds the trusted tmdb id (any id) is the target; a stored title and contract version are never overwritten; a blank title is filled; the id is added only when missing.
{
 const file=database();
 seedFilm(file,'film:lb:abc',{title:'Stored Title',ids:[['tmdb','603']],version:3});
 const out=await applyDiscoveryAdmission(envOf(file),{event:EV,input:input(603,{title:'New Title'}),now:()=>T});
 assert.equal(out.state,'noop','the Film holds the id and a title');
 assert.deepEqual(film(file,'film:lb:abc'),{contract_version:3,canonical_identity:null,original_title:'Stored Title',updated_at:U});
 assert.equal(film(file,FID(603)),undefined,'no second Film is created for the same tmdb id');
 assert.equal(receipts(file).length,0);
}
{
 const file=database();
 seedFilm(file,'film:lb:abc',{title:'  ',ids:[['tmdb','603']],version:3});
 const out=await applyDiscoveryAdmission(envOf(file),{event:EV,input:input(603,{title:'Filled'}),now:()=>T});
 assert.equal(out.state,'applied');
 assert.deepEqual(film(file,'film:lb:abc'),{contract_version:3,canonical_identity:null,original_title:'Filled',updated_at:T},'a blank title is filled, the contract version stays');
 assert.equal(ext(file,'film:lb:abc').length,1,'the id is not duplicated');
}
{
 // a Film film:tmdb:<n> without the tmdb id (identity not yet stored): the id is ADDED, the title kept
 const file=database();
 seedFilm(file,FID(603),{title:'Kept',ids:[]});
 const out=await applyDiscoveryAdmission(envOf(file),{event:EV,input:input(603,{title:'Other'}),now:()=>T});
 assert.equal(out.state,'applied');
 assert.equal(film(file,FID(603)).original_title,'Kept');
 assert.deepEqual(ext(file,FID(603)).map(row=>row.scheme+':'+row.value),['tmdb:603']);
}
{
 // no title in the admission: the Film is created without one
 const file=database();
 const out=await applyDiscoveryAdmission(envOf(file),{event:EV,input:input(603,{title:null}),now:()=>T});
 assert.equal(out.state,'applied');
 assert.equal(film(file,FID(603)).original_title,null);
}

// 5. Identity refusals BEFORE any receipt, nothing written: the id held UNTRUSTED or CONFLICTING by another Film, trusted by two Films cannot happen (unique index) but an untrusted row plus a trusted one is a collision, a Film with a DIFFERENT
// trusted tmdb value, and a redirect source.
{
 const cases=[
  ['untrusted holder',f=>seedFilm(f,'film:lb:x',{ids:[['tmdb','603',0,0]]}),'identity_collision'],
  ['conflicting holder',f=>seedFilm(f,'film:lb:x',{ids:[['tmdb','603',1,1]]}),'identity_collision'],
  ['trusted holder plus an untrusted holder',f=>{seedFilm(f,'film:lb:x',{ids:[['tmdb','603',1,0]]});seedFilm(f,'film:lb:y',{ids:[['tmdb','603',0,0]]});},'identity_collision'],
  ['redirect source',f=>{seedFilm(f,'film:lb:gone',{});seedFilm(f,'film:lb:gone2',{ids:[['tmdb','603']]});assert.equal(sqlite(f,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb:gone2','film:lb:gone','"+U+"')").status,0);},'film_person_redirect'],
  ['redirected film:tmdb',f=>{seedFilm(f,'film:lb:z',{});assert.equal(sqlite(f,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+FID(603)+"','film:lb:z','"+U+"')").status,0);},'film_person_redirect'],
 ];
 for(const [name,setup,expected] of cases){
  const file=database();
  setup(file);
  const before=dump(file),env=envOf(file);
  await assert.rejects(applyDiscoveryAdmission(env,{event:EV,input:input(603),now:()=>T}),code(expected),name);
  assert.equal(dump(file),before,name+': nothing written, no receipt');
  assert.equal(env.DB.calls.batches,0,name);
  // the call site counts it and never throws
  const out=await admitDiscoveryFilms(envOf(file),{films:{tmdb_603:entry(603)},written:['tmdb_603'],now:()=>T,sweepLimit:0});
  assert.equal(out.refused,1,name);assert.equal(out.failed,0,name);assert.equal(dump(file),before);
 }
 // a Film holding a DIFFERENT trusted value of the scheme under the id film:tmdb:<n>
 const file=database();
 seedFilm(file,FID(603),{ids:[['tmdb','999']]});
 const before=dump(file);
 await assert.rejects(planAdmissionFilm(envOf(file),input(603)),code('identity_collision'));
 assert.equal(dump(file),before);
}

// 6. The atomic receipt: the mutation and the applied receipt are ONE fenced batch; a receipt that no longer matches rolls the whole batch back; a Film that appears between the plan and the batch (revision moved) fails the batch.
{
 const file=database(),sizes=[],env=envOf(file,{onBatch:async statements=>{sizes.push(statements.length);}});
 const out=await applyDiscoveryAdmission(env,{event:EV,input:input(603),now:()=>T});
 assert.equal(out.state,'applied');
 assert.equal(env.DB.calls.batches,2,'one pending-receipt batch and ONE atomic batch');
 assert.ok(sizes[1]>=6,'the atomic batch carries fence, revision, assertions, the Film write and the applied receipt: '+sizes);
 assert.equal(rows(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id="+q(FID(603)))[0].revision,1);
}
{
 // the same Film created by another writer between the pre-plan and the batch: the batch fails whole (the revision moved), nothing partial, the receipt stays retryable
 const file=database();
 let hit=false;
 const env=envOf(file,{onBatch:async statements=>{
  if(!hit&&statements.some(item=>/INSERT INTO film \(/.test(item.text))){hit=true;seedFilm(file,FID(603),{title:'Racer',ids:[]});sqlite(file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','"+FID(603)+"',1,'"+U+"')");}
 }});
 let error=null;
 try{await applyDiscoveryAdmission(env,{event:EV,input:input(603),now:()=>T});}catch(e){error=e;}
 assert.equal(ext(file,FID(603)).length,0,'the failed batch wrote no id');
 const list=receipts(file);
 assert.equal(list.length,1);assert.notEqual(list[0].state,'applied','the receipt is not applied');
}
{
 // an EXISTING Film at revision 3 with a blank title: the pre-plan revision is the stored one, the batch applies once and bumps it to 4
 const file=database();
 seedFilm(file,FID(603),{title:'',ids:[['tmdb','603']]});
 sqlite(file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','"+FID(603)+"',3,'"+U+"')");
 const env=envOf(file);
 const out=await applyDiscoveryAdmission(env,{event:EV,input:input(603),now:()=>T});
 assert.equal(out.state,'applied');
 assert.equal(rows(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id="+q(FID(603)))[0].revision,4);
 assert.equal(env.DB.calls.batches,2,'no revalidation round: the pre-plan revision is the stored one');
 assert.equal(receipts(file)[0].attempts,1);
}

// 7. Origin reconcile: a due receipt is replayed from the CURRENT admission row (the receipt stores no payload); a changed source abandons; a missing admission is not replayed.
{
 const file=database();
 admit(file,603,{title:'Admitted Title'});
 // a pending receipt created by a failed attempt
 let fail=true;
 const env=envOf(file,{onBatch:async statements=>{if(fail&&statements.some(item=>/INSERT INTO film \(/.test(item.text)))throw new Error('D1 transport');}});
 await assert.rejects(applyDiscoveryAdmission(env,{event:EV,input:input(603),now:()=>T}));
 assert.equal(ext(file,FID(603)).length,0);
 const pending=receipts(file);
 assert.equal(pending.length,1);assert.notEqual(pending[0].state,'applied');
 fail=false;
 const settled=await reconcileReceipts(env,{operations:discoveryAdmissionRegistry(env,()=>LATER),origin:DISCOVERY_ORIGIN,limit:5,now:()=>LATER});
 assert.ok(settled);
 assert.deepEqual(ext(file,FID(603)).map(row=>row.scheme+':'+row.value),['tmdb:603'],'the replay wrote the Film from the admission row');
 assert.equal(receipts(file)[0].state,'applied');
}
{
 // the admission moved on (another title): the digest differs, the receipt is abandoned, nothing is written
 const file=database();
 admit(file,603,{title:'Changed Title'});
 let fail=true;
 const env=envOf(file,{onBatch:async statements=>{if(fail&&statements.some(item=>/INSERT INTO film \(/.test(item.text)))throw new Error('D1 transport');}});
 await assert.rejects(applyDiscoveryAdmission(env,{event:EV,input:input(603,{title:'Original Title'}),now:()=>T}));
 fail=false;
 await reconcileReceipts(env,{operations:discoveryAdmissionRegistry(env,()=>LATER),origin:DISCOVERY_ORIGIN,limit:5,now:()=>LATER});
 assert.equal(ext(file,FID(603)).length,0,'a source that moved on is never replayed');
 assert.equal(receipts(file)[0].state,'abandoned');
}
{
 // no admission row at all: the registry re-plan is null, nothing is replayed blind
 const file=database();
 let fail=true;
 const env=envOf(file,{onBatch:async statements=>{if(fail&&statements.some(item=>/INSERT INTO film \(/.test(item.text)))throw new Error('D1 transport');}});
 await assert.rejects(applyDiscoveryAdmission(env,{event:EV,input:input(603),now:()=>T}));
 fail=false;
 await reconcileReceipts(env,{operations:discoveryAdmissionRegistry(env,()=>LATER),origin:DISCOVERY_ORIGIN,limit:5,now:()=>LATER});
 assert.equal(ext(file,FID(603)).length,0);
 assert.notEqual(receipts(file)[0].state,'applied');
}

// 7b. The registry spec called directly (the hooks `reconcileReceipts` uses): readback abandons a moved source, replay refuses it, revalidate supersedes a no-op and proceeds while work remains, a refusal or a missing re-plan is `stale`, and a
// D1 read failure PROPAGATES (the receipt stays due instead of being abandoned as stale).
{
 const file=database();
 const env=envOf(file);
 const digest=await discoveryAdmissionDigest(input(603));
 const receipt={requestId:'discovery:film_mutation:'+digest,operation:'film_mutation',origin:DISCOVERY_ORIGIN,target:{kind:'film',id:FID(603)},contentDigest:digest};
 const specOf=replan=>discoveryAdmissionOperation({replan,now:()=>T});
 const same=specOf(async()=>input(603));
 const moved=specOf(async()=>input(603,{title:'Moved On'}));
 const none=specOf(async()=>null);
 const broken=specOf(async()=>{throw new Error('boom');});
 // readback: the digest of a no-op plan is the receipt's, otherwise null; a moved source abandons; no plan is "not applied"
 assert.deepEqual(await moved.readback(env,receipt.target,receipt),{disposition:'abandon',errorClass:'producer_source_changed'});
 assert.deepEqual(await same.readback(env,receipt.target,receipt),{digest:null,revision:0});
 assert.deepEqual(await none.readback(env,receipt.target,receipt),{digest:null,revision:0});
 assert.deepEqual(await broken.readback(env,receipt.target,receipt),{digest:null,revision:0});
 // replay: a moved source is refused (nothing written), no plan is a typed error
 await assert.rejects(moved.replay(env,receipt,{requestId:receipt.requestId,attempt:1,currentRevision:0,target:receipt.target}),code('film_person_invalid'));
 await assert.rejects(none.replay(env,receipt,{requestId:receipt.requestId,attempt:1,currentRevision:0,target:receipt.target}),code('producer_replan_unavailable'));
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film')),0);
 // revalidate
 assert.equal(await same.revalidate(env,receipt),'proceed','work remains');
 assert.equal(await moved.revalidate(env,receipt),'stale','a moved source');
 assert.equal(await none.revalidate(env,receipt),'stale','no re-plan');
 seedFilm(file,FID(603),{title:'Kept',ids:[['tmdb','603']]});
 assert.equal(await same.revalidate(env,receipt),'superseded','the Film already holds everything');
 assert.deepEqual(await same.readback(env,receipt.target,receipt),{digest,revision:0},'readback finds the applied content (a no-op plan)');
 // a refusal is "no plan" (stale), a read failure propagates
 const file2=database();seedFilm(file2,'film:lb:x',{ids:[['tmdb','603',0,0]]});
 assert.equal(await specOf(async()=>input(603)).revalidate(envOf(file2),receipt),'stale','an identity refusal is a missing plan');
 const failing=envOf(database(),{onQuery:async text=>{if(/FROM film_external_id/.test(text))throw new Error('D1_ERROR: boom');}});
 await assert.rejects(same.revalidate(failing,receipt),/boom/);
 await assert.rejects(same.readback(failing,receipt.target,receipt),/boom/);
 // the registry re-plan reads the CURRENT admission row only
 const file3=database();
 admit(file3,603,{state:'superseded'});
 const registry=discoveryAdmissionRegistry(envOf(file3),()=>T);
 assert.equal(await registry.get('film_mutation').replay(envOf(file3),receipt,{requestId:receipt.requestId,attempt:1,currentRevision:0,target:receipt.target}).then(()=>'wrote',error=>error.code),'producer_replan_unavailable','a superseded admission is not a source');
}

// 8. The call site: written films are admitted (bounded), a non-eligible entry is skipped, the sweep admits a current admission without a canonical Film, a tv admission and a superseded one are not swept, and it never throws.
{
 const file=database();
 admit(file,603);admit(file,604);admit(file,700,{state:'superseded'});admit(file,5,{kind:'tv',id:'tmdb_tv_5'});admit(file,800);
 const env=envOf(file);
 const out=await admitDiscoveryFilms(env,{films:{tmdb_603:entry(603),tmdb_tv_5:entry(5,{mediaType:'tv'})},written:['tmdb_603','tmdb_tv_5','tmdb_603'],now:()=>T});
 assert.equal(out.state,'done');
 assert.equal(out.applied>=1,true);
 const films=rows(file,"SELECT id FROM film ORDER BY id").map(row=>row.id);
 assert.deepEqual(films,[FID(603),FID(604),FID(800)],'written 603 plus the swept 604 and 800; neither the tv admission nor the superseded one');
 assert.equal(out.refused,0);assert.equal(out.failed,0);
 // idempotent: a second call finds nothing to do
 const second=await admitDiscoveryFilms(envOf(file),{films:{tmdb_603:entry(603)},written:['tmdb_603'],now:()=>T});
 assert.equal(second.applied,0);assert.equal(second.swept,0);
}
{
 // bounded: at most ADMIT_PER_CALL written films per call, the rest is deferred (and found by the sweep later)
 const file=database();
 const films={},written=[];
 for(let k=1;k<=ADMIT_PER_CALL+3;k++){admit(file,1000+k);films['tmdb_'+(1000+k)]=entry(1000+k);written.push('tmdb_'+(1000+k));}
 const out=await admitDiscoveryFilms(envOf(file),{films,written,now:()=>T,sweepLimit:0});
 assert.equal(out.applied,ADMIT_PER_CALL);assert.equal(out.deferred,3);
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film')),ADMIT_PER_CALL);
 // the sweep (bounded) picks the rest up on a later call, with no written films at all
 let guard=0;
 while(Number(one(file,'SELECT COUNT(*) FROM film'))<ADMIT_PER_CALL+3&&guard++<10)await admitDiscoveryFilms(envOf(file),{films:{},written:[],now:()=>T});
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film')),ADMIT_PER_CALL+3,'every current admission reaches a canonical Film');
 assert.ok(SWEEP_PER_CALL>=1);
}
{
 // a deadline already past: nothing is admitted, the work is deferred, no throw
 const file=database();
 admit(file,603);
 const out=await admitDiscoveryFilms(envOf(file),{films:{tmdb_603:entry(603)},written:['tmdb_603'],deadline:Date.now()-1,now:()=>T});
 assert.equal(out.state,'done');assert.equal(out.applied,0);assert.equal(out.deferred,1);
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film')),0);
}
{
 // a failing D1 never throws out of the call site, and writes nothing partial
 const file=database();
 admit(file,603);
 const env=envOf(file,{onBatch:async()=>{throw new Error('D1 transport');}});
 const out=await admitDiscoveryFilms(env,{films:{tmdb_603:entry(603)},written:['tmdb_603'],now:()=>T});
 assert.equal(out.state,'done');assert.ok(out.failed>=1);
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film')),0);
}

// 9. Registry and readiness: the atomic `film_mutation` spec is registered, exactly its dependent producer flips, the other kinds are unchanged, and nothing else registers.
{
 assert.deepEqual([...PRODUCER_OPERATIONS.keys()],['film_mutation']);
 const spec=PRODUCER_OPERATIONS.get('film_mutation');
 assert.equal(spec.atomic,true);assert.equal(spec.operation,'film_mutation');
 for(const hook of ['readback','replay','revalidate'])assert.equal(typeof spec[hook],'function');
 const flipped=PRODUCER_WIRING.filter(item=>item.requires.every(kind=>[...PRODUCER_OPERATIONS.values()].some(op=>op.operation===kind&&op.atomic===true))).map(item=>item.name);
 assert.deepEqual(flipped,['discovery_admission']);
 assert.throws(()=>discoveryAdmissionOperation({}),code('film_person_invalid'));
}

// 10. Static wiring: the Worker bundle carries the scope, the call site is the one in upsertAdmissions behind a typeof guard, the module has no import cycle with the registry, and nothing here uses a timer, cron or network.
{
 const source=fs.readFileSync(path.join(SRC,'canonical-discovery-admission-producer.js'),'utf8');
 assert.ok(!/canonical-producers\.js/.test(source),'no import of the registry (no cycle)');
 assert.ok(!/\b(fetch|setTimeout|setInterval|crypto\.subtle\.digest)\b|R2|BUCKET|Cron|cron/.test(source.replace(/\/\/.*$/gm,'')),'no network, timer, cron or R2 call');
 const authority=fs.readFileSync(path.join(SRC,'discovery-authority.js'),'utf8');
 assert.equal(authority.split('CanonicalDiscoveryAdmission.admitDiscoveryFilms').length-1,1,'one call site');
 assert.ok(/typeof CanonicalDiscoveryAdmission!=='undefined'/.test(authority),'the call site is guarded');
 const build=fs.readFileSync('build.mjs','utf8');
 assert.ok(/scopedImports\('src\/canonical-discovery-admission-producer\.js','CanonicalDiscoveryAdmission'/.test(build));
 assert.ok(build.indexOf("'CanonicalMutations'")<build.indexOf("'CanonicalReceipts'")&&build.indexOf("'CanonicalReceipts'")<build.indexOf("'CanonicalProducerAdapters'")&&build.indexOf("'CanonicalProducerAdapters'")<build.indexOf("'CanonicalDiscoveryAdmission'"),'scopes are in dependency order');
}
console.log('canonical-discovery-admission-producer: ok');
