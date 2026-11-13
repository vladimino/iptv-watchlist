// AIR-374 P3a (ADR 0125): the dormant EPG producer layer for canonical Film facts, on the sqlite3-CLI D1 stand-in. No Worker, R2, D1 or Cloudflare access. Covered: the pure unit plan (order, duplicates, release units, run id as event), the route gate
// (one marker read at r2 and prepared, nothing else; held throws), a bounded resumable pass (cursor, per-call cap, one atomic receipted batch per changed Film, no-op without a receipt, a release never creates a Film, one refusal never blocks
// the others, a held marker stops the pass on its unit), the A to B change under a new run, a stale revision settled by the own-origin inline reconcile (replayed, or backed off without a re-plan) and the static dormancy and truthful readiness.
// EPG_SRC points the file at a mutant copy of src/ (tests/canonical-epg-producer-mutation.mjs); EPG_TEMPLATE a prebuilt template database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

// AIR-374: EPGPRODUCER_ONLY="4,9" runs only those numbered sections (the mutation runner's first, cheap run of a mutant; a mutant that survives it is run against the whole file). Absent: every section.
// A failing run names the section it died in on stderr (LEAN_SECTION), which is how the runner's hints are learned.
const ONLY=process.env.EPGPRODUCER_ONLY?new Set(process.env.EPGPRODUCER_ONLY.split(',')):null;
let currentSection='-';
const section=id=>{if(ONLY&&!ONLY.has(id))return false;currentSection=id;return true;};
process.on('exit',code=>{if(code!==0)console.error('LEAN_SECTION '+currentSection);});

const SRC=process.env.EPG_SRC?path.resolve(process.env.EPG_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const E=await load('canonical-epg-producer.js');
const {writeFilmFacts}=await load('canonical-film-writers.js');
const {readAuthority}=await load('film-person-authority.js');
const {PRODUCER_WIRING,PRODUCER_OPERATIONS}=await load('canonical-producers.js');
const {producerRequestId,filmFactsDigest,filmFactsContent}=await load('canonical-producer-adapters.js');
const {planEpgUnits,applyEpgUnits,reconcileEpg,epgReplan,epgUnitCap,EPG_UNIT_HARD_CAP,EPG_UNIT_LIMIT_DEFAULT}=E;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-producer-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
if(process.env.EPG_TEMPLATE)fs.copyFileSync(process.env.EPG_TEMPLATE,template);
else{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
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
const T='2026-11-11T10:00:00.000Z';
const iso=ms=>new Date(Date.parse(T)+ms).toISOString();
const ID=k=>'film:tmdb:'+k;
const META=(over={})=>({schemaVersion:1,year:1999,runtime:136,synopsis:'S',poster:'/p.jpg',url:'https://example.test/m',genres:['g'],peopleVersion:2,payload:{k:'v'},r2Key:null,contentSha256:null,updatedAt:T,...over});
const facts=(title='Title A')=>({film:{contractVersion:1,originalTitle:title,source:'tmdb'},metadata:META(),sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true});
const receipts=file=>rows(file,'SELECT request_id,operation,origin,target_id,state,attempts,applied_revision,error_class FROM canonical_write_receipt ORDER BY target_id,created_at');
const revision=(file,id)=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+id+"'")??0);
const dump=file=>JSON.stringify(['film','film_metadata','film_sync_state','watchlist_film','film_dimension','canonical_revision','canonical_write_receipt'].map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2')]));
const member=(file,id)=>one(file,"SELECT COUNT(*) FROM watchlist_film WHERE film_id='"+id+"'");
const filmCount=(file,id)=>one(file,"SELECT COUNT(*) FROM film WHERE id='"+id+"'");
const films3=[{id:ID(3),facts:facts('C')},{id:ID(1),facts:facts('A')},{id:ID(2),facts:facts('B')}];
const plan=(over={})=>planEpgUnits({runId:'run-1',at:T,films:films3,departed:[],...over});

// 1. The pure plan: deterministic order by id, the run id is the event, the write clock is the run's, release units, duplicates and malformed input refused.
if(section('1')){
 const p=plan({departed:[ID(9),ID(1)]});
 assert.equal(p.event,'epg:run-1');
 assert.deepEqual(p.units.map(unit=>unit.id),[ID(1),ID(2),ID(3),ID(9)],'sorted by id; an observed member is not also released');
 assert.deepEqual(p.units.map(unit=>unit.release),[false,false,false,true]);
 assert.deepEqual(p.units[3].input,{id:ID(9),at:T,release:true,watchlist:false},'a release carries no Film facts: the contract version comes from the stored row');
 assert.deepEqual(filmFactsContent(p.units[3].input),{release:true,watchlist:false});
 assert.equal(p.units[0].input.at,T);assert.equal(p.units[0].input.id,ID(1));
 const dirty=planEpgUnits({runId:'r',at:T,films:[{id:ID(1),facts:{...facts(),id:'film:other',at:'x',requestId:'q',expectedRevision:7,receiptMark:{}}}]});
 assert.deepEqual(Object.keys(dirty.units[0].input).sort(),['at','film','id','metadata','sync','watchlist'],'caller-supplied id, clock, request id, revision and receipt mark are dropped');
 assert.equal(dirty.units[0].input.id,ID(1));assert.equal(dirty.units[0].input.at,T);
 assert.equal(JSON.stringify(plan()),JSON.stringify(plan({films:[...films3].reverse()})),'input order does not matter');
 for(const bad of [{runId:''},{runId:'  '},{runId:7},{runId:'x'.repeat(281)},{at:''},{at:5},{films:'x'},{departed:'x'},{films:[...films3,films3[0]]},{films:[{id:'person:x',facts:facts()}]},{films:[{id:ID(1)}]},{films:[null]},{departed:['person:x']},{departed:[7]}])
  assert.throws(()=>plan(bad),code('film_person_invalid'),JSON.stringify(Object.keys(bad)));
 assert.deepEqual(plan({films:[],departed:[]}).units,[]);
 const replan=epgReplan(p);
 const own=async id=>{const target={kind:'film',id},unit=p.units.find(item=>item.id===id),contentDigest=await filmFactsDigest(unit.input);return {target,contentDigest,requestId:await producerRequestId({origin:'epg',event:p.event,target,digest:contentDigest})};};
 assert.equal((await replan(await own(ID(2)))).film.originalTitle,'B');
 assert.equal(await replan({target:{id:ID(77)}}),null);assert.equal(await replan({}),null);assert.equal(await epgReplan(null)({target:{id:ID(1)}}),null);
 assert.equal(await replan({...(await own(ID(2))),requestId:(await own(ID(1))).requestId}),null,'a receipt whose request id is not this run\'s is not re-planned');
 assert.equal(await replan({...(await own(ID(2))),contentDigest:(await own(ID(1))).contentDigest}),null);
 assert.equal(await replan(await own(ID(9))),null,'a release has no re-plan without the store to resolve it against');
 assert.equal(epgUnitCap(1000),EPG_UNIT_HARD_CAP);assert.equal(epgUnitCap(0),1);assert.equal(epgUnitCap(undefined),1);assert.equal(epgUnitCap(-5),1);assert.equal(epgUnitCap(7),7);
 assert.ok(EPG_UNIT_LIMIT_DEFAULT<=EPG_UNIT_HARD_CAP&&EPG_UNIT_HARD_CAP<=80,'the ceiling stays under the 800-query run budget at ~10 round trips per changed Film');
}

// 2. Dormancy: at r2 and prepared a pass and an inline reconcile each cost exactly one marker read (SELECTs only), no batch, nothing written; held throws.
for(const stage of section('2')?['r2','prepared']:[]){
 const file=database(stage),before=dump(file);
 const probe=envOf(file);await readAuthority(probe);
 const markerQueries=probe.DB.calls.queries;
 const seen=[];
 const env=envOf(file,{onQuery:async text=>{seen.push(text);}});
 const done=await applyEpgUnits(env,{plan:plan(),now:()=>T});
 assert.equal(done.skipped,true,stage);assert.equal(done.reason,'projector_is_writer');assert.equal(done.cursor,0);assert.equal(done.done,false);
 assert.equal(env.DB.calls.queries,markerQueries,stage+': exactly one marker read');
 assert.ok(seen.every(text=>/^\s*SELECT/i.test(text)),stage+': only SELECTs');
 assert.equal(env.DB.calls.batches,0,stage+': no batch');
 const rec=await reconcileEpg(env,{plan:plan()});
 assert.equal(rec.skipped,true,stage+': reconcile skipped');
 assert.equal(env.DB.calls.queries,2*markerQueries,stage+': the reconcile reads only the marker');
 assert.equal(dump(file),before,stage+': nothing written');
}
if(section('2')){
 const file=database('held'),env=envOf(file);
 await assert.rejects(()=>applyEpgUnits(env,{plan:plan()}),code('film_person_held'));
 await assert.rejects(()=>reconcileEpg(env,{plan:plan()}),code('film_person_held'));
 assert.equal(env.DB.calls.batches,0);
}
if(section('2')){
 const env=envOf(database('open'));
 for(const bad of [{plan:null},{plan:{units:[]}},{plan:{units:'x',event:'e'}},{plan:plan(),cursor:-1},{plan:plan(),cursor:1.5}])
  await assert.rejects(()=>applyEpgUnits(env,bad),code('film_person_invalid'),JSON.stringify(Object.keys(bad)));
 assert.equal(env.DB.calls.queries,0,'a malformed call reads nothing');
}

// 3. open: a bounded, resumable pass. Two changed Films per call, then the rest; each changed Film is ONE receipt of origin epg, applied after two batches; a release of a Film the store does not hold creates nothing; a held member is released.
if(section('3')){
 const file=database('open');
 assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('"+ID(8)+"',1,'"+T+"'),('"+ID(9)+"',1,'"+T+"');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('"+ID(8)+"','"+T+"')").status,0);
 const p=plan({departed:[ID(8),ID(99)]});
 assert.deepEqual(p.units.map(unit=>unit.id),[ID(1),ID(2),ID(3),ID(8),ID(99)]);
 const env=envOf(file);
 const first=await applyEpgUnits(env,{plan:p,limit:2,now:()=>T});
 assert.deepEqual([first.skipped,first.cursor,first.done,first.counts.applied,first.counts.noop,first.failures.length,first.stoppedBy],[false,2,false,2,0,0,null]);
 assert.equal(env.DB.calls.batches,4,'two batches per changed Film: the pending insert and the writer own');
 assert.equal(filmCount(file,ID(3)),0,'the third Film is not visited yet');
 const second=await applyEpgUnits(env,{plan:p,cursor:first.cursor,limit:10,now:()=>T});
 assert.deepEqual([second.cursor,second.done,second.counts.applied,second.counts.noop,second.counts.absent,second.failures.length],[5,true,2,0,1,0],'rest of the plan: one Film, one release applied, one absent release skipped');
 const list=receipts(file);
 assert.equal(list.length,4);
 assert.ok(list.every(item=>item.origin==='epg'&&item.operation==='film_facts'&&item.state==='applied'&&item.applied_revision===1&&/^epg:film_facts:[0-9a-f]{64}$/.test(item.request_id)));
 assert.equal(new Set(list.map(item=>item.request_id)).size,4);
 assert.equal(filmCount(file,ID(99)),0,'a release never creates a Film');
 assert.equal(member(file,ID(8)),0,'the departed member is released');assert.equal(revision(file,ID(8)),1);
 assert.equal(member(file,ID(1)),1);assert.equal(revision(file,ID(1)),1);
 // The same run again: every unit is a no-op (the absent release stays absent), no receipt, no batch, no revision move.
 const before=dump(file);
 const again=envOf(file);
 const third=await applyEpgUnits(again,{plan:p,limit:50,now:()=>T});
 assert.deepEqual([third.done,third.counts.noop,third.counts.applied,third.counts.absent,third.failures.length],[true,4,0,1,0]);
 assert.equal(again.DB.calls.batches,0);assert.equal(dump(file),before);
 // A new run with the same facts and a new run id is still a no-op: the pre-plan sees stored content.
 const next=envOf(file);
 const fourth=await applyEpgUnits(next,{plan:planEpgUnits({runId:'run-2',at:iso(60000),films:films3,departed:[ID(8)]}),now:()=>iso(60000)});
 assert.equal(fourth.counts.noop,4);assert.equal(next.DB.calls.batches,0);assert.equal(dump(file),before);
 // An A to B change under a new run is a NEW request (never read as already applied) and bumps the revision; the old receipt stays.
 const changed=planEpgUnits({runId:'run-3',at:iso(120000),films:[{id:ID(1),facts:facts('A2')}]});
 const fifth=await applyEpgUnits(envOf(file),{plan:changed,now:()=>iso(120000)});
 assert.deepEqual([fifth.counts.applied,fifth.counts.already,revision(file,ID(1))],[1,0,2]);
 assert.equal(one(file,"SELECT original_title FROM film WHERE id='"+ID(1)+"'"),'A2');
 assert.equal(receipts(file).filter(item=>item.target_id===ID(1)).length,2);
  assert.equal(one(file,"SELECT COUNT(*) FROM film_metadata WHERE film_id='"+ID(1)+"'"),1);
 assert.equal(sqlite(file,"UPDATE film SET original_title='A2' WHERE id='"+ID(1)+"'").status,0);
 const sixth=await applyEpgUnits(envOf(file),{plan:planEpgUnits({runId:'run-4',at:iso(180000),films:[{id:ID(1),facts:{...facts('A'),metadata:META({runtime:100})}}]}),now:()=>iso(180000)});
 assert.deepEqual([sixth.counts.applied,sixth.counts.already,revision(file,ID(1))],[1,0,3]);
 assert.equal(new Set(receipts(file).filter(item=>item.target_id===ID(1)).map(item=>item.request_id)).size,3,'three runs, three distinct request ids');
 // The same run again after another actor moved the Film: the same request id, read as already applied, counted so and not rewritten.
 await writeFilmFacts(envOf(file),{id:ID(1),at:iso(190000),requestId:'interloper',expectedRevision:3,film:{contractVersion:1,originalTitle:'A2',source:'tmdb'},metadata:META({runtime:101})});
 const batchesBefore=envOf(file);
 const seventh=await applyEpgUnits(batchesBefore,{plan:planEpgUnits({runId:'run-4',at:iso(180000),films:[{id:ID(1),facts:{...facts('A'),metadata:META({runtime:100})}}]}),now:()=>iso(200000)});
 assert.deepEqual([seventh.counts.already,seventh.counts.applied,revision(file,ID(1))],[1,0,4]);
}

// 3b. A to B to A on one Film: the third run carries the FIRST content again and is a THIRD request (revision 3), not the first one read as already applied.
if(section('3b')){
 const file=database('open');
 const run=(runId,runtime)=>applyEpgUnits(envOf(file),{plan:planEpgUnits({runId,at:T,films:[{id:ID(5),facts:{...facts('A'),metadata:META({runtime})}}]}),now:()=>T});
 const a=await run('flip-1',136),b=await run('flip-2',100),c=await run('flip-3',136);
 assert.deepEqual([a.counts.applied,b.counts.applied,c.counts.applied,c.counts.already,revision(file,ID(5))],[1,1,1,0,3]);
 assert.equal(one(file,"SELECT runtime FROM film_metadata WHERE film_id='"+ID(5)+"'"),136);
 assert.equal(new Set(receipts(file).map(item=>item.request_id)).size,3);
}

// 4. One refusal never blocks the others, and it is counted with its code (no receipt exists for a refusal the planner raises).
if(section('4')){
 const file=database('open');
 const p=plan();
 p.units[1]={...p.units[1],input:{...p.units[1].input,film:{originalTitle:'B'}}};
 const out=await applyEpgUnits(envOf(file),{plan:p,now:()=>T});
 assert.deepEqual([out.done,out.counts.applied,out.counts.failed,out.failures],[true,2,1,[{id:ID(2),code:'film_person_invalid'}]]);
 assert.equal(receipts(file).filter(item=>item.target_id===ID(2)).length,0,'no receipt for a refusal before a receipt');
}

// 5. A marker that goes held mid-pass stops the pass ON the unit it refused, the cursor stays there, and the unit is not counted.
if(section('5')){
 const file=database('open');
 let flipped=false,env=null;
 env=envOf(file,{onQuery:async text=>{
  if(!flipped&&env.DB.calls.batches>=2&&/film_person_authority/.test(text)){flipped=true;assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);}
 }});
 const out=await applyEpgUnits(env,{plan:plan(),now:()=>T});
 assert.deepEqual([out.skipped,out.cursor,out.done,out.stoppedBy,out.counts.applied,out.counts.failed],[false,1,false,'film_person_held',1,0]);
 assert.equal(filmCount(file,ID(2)),0);assert.equal(filmCount(file,ID(1)),1);
}

// 5b. An unreadable marker mid-pass stops the pass the same way (the marker table cannot be read after the first Film).
if(section('5b')){
 const file=database('open');
 let env=null;
 env=envOf(file,{rewrite:sql=>env&&env.DB.calls.batches>=2&&/film_person_authority/.test(sql)?sql.replace(/film_person_authority/g,'film_person_missing'):sql});
 const out=await applyEpgUnits(env,{plan:plan(),now:()=>T});
 assert.deepEqual([out.cursor,out.done,out.stoppedBy,out.counts.applied],[1,false,'film_person_unavailable',1]);
}
// 5c. E5: identical content landing between the pre-plan and the writer ends the receipt `unknown` (counted so, no second batch, visible to the reconcile).
if(section('5c')){
 const file=database('open');
 const p=planEpgUnits({runId:'run-5',at:T,films:[{id:ID(1),facts:facts('A')}]});
 let seen=0;
 const env=envOf(file,{onBatch:async()=>{seen++;if(seen===1)await writeFilmFacts(envOf(file),{...p.units[0].input,requestId:'interloper',expectedRevision:0});}});
 const out=await applyEpgUnits(env,{plan:p,now:()=>T});
 assert.deepEqual([out.counts.unknown,out.counts.applied,out.failures.length],[1,0,0]);
 assert.equal(env.DB.calls.batches,2,'the pending insert and the transition to unknown; no marking batch');
 assert.deepEqual([receipts(file)[0].state,receipts(file)[0].error_class],['unknown','atomic_mark_missing']);
}
// 5d. The inline reconcile honours its limit: two due receipts, one considered.
if(section('5d')){
 const file=database('open');
 const p=planEpgUnits({runId:'run-6',at:T,films:[{id:ID(1),facts:facts('A')},{id:ID(2),facts:facts('B')}]});
 let seen=0;
 const env=envOf(file,{onBatch:async()=>{seen++;if(seen===2||seen===4){const id=seen===2?ID(1):ID(2);await writeFilmFacts(envOf(file),{id,at:T,requestId:'interloper-'+id,expectedRevision:0,film:{contractVersion:1,originalTitle:'Z',source:'tmdb'}});}}});
 const out=await applyEpgUnits(env,{plan:p,now:()=>T});
 assert.deepEqual([out.counts.failed,receipts(file).length,receipts(file).every(item=>item.state==='failed')],[2,2,true]);
 const one_=await reconcileEpg(envOf(file),{plan:p,limit:1,now:()=>iso(61000)});
 assert.equal(one_.considered,1,'the limit bounds the pass');
 const rest=await reconcileEpg(envOf(file),{plan:p,limit:10,now:()=>iso(61000)});
 assert.equal(rest.considered,1,'the other receipt is settled by the next pass');
}
// 6. Stale revision: an interloper moves a Film between the pre-plan and the writer batch. The pass counts it failed (retryable), the own-origin inline reconcile re-validates and replays the SAME request id and the
// receipt ends applied at attempt 2. A reconcile that cannot re-plan the Film never replays and backs off; a plan of another run whose content differs abandons it.
if(section('6')){
 const file=database('open');
 const p=planEpgUnits({runId:'run-7',at:T,films:[{id:ID(1),facts:facts('A')}]});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)await writeFilmFacts(envOf(file),{id:ID(1),at:T,requestId:'interloper',expectedRevision:0,film:{contractVersion:1,originalTitle:'Z',source:'tmdb'},watchlist:false});}});
 const out=await applyEpgUnits(racing,{plan:p,now:()=>T});
 assert.deepEqual([out.counts.failed,out.failures.map(item=>item.code)],[1,['film_person_revision_conflict']]);
 const [pending]=receipts(file);assert.equal(pending.state,'failed');assert.equal(pending.attempts,1);
 const early=await reconcileEpg(envOf(file),{plan:p,now:()=>iso(1000)});
 assert.equal(early.considered,0,'before the backoff nothing is due');
 const blind=await reconcileEpg(envOf(file),{plan:{units:[]},now:()=>iso(61000)});
 assert.equal(blind.considered,1);
 assert.deepEqual([receipts(file)[0].state,receipts(file)[0].error_class],['abandoned','stale_revision_needs_repair'],'no re-plan after a moved revision: repair, never a blind replay');
 assert.equal(title(file),'Z','nothing replayed without a re-plan');
}
if(section('6')){
 const file=database('open');
 const p=planEpgUnits({runId:'run-7',at:T,films:[{id:ID(1),facts:facts('A')}]});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)await writeFilmFacts(envOf(file),{id:ID(1),at:T,requestId:'interloper',expectedRevision:0,film:{contractVersion:1,originalTitle:'Z',source:'tmdb'},watchlist:false});}});
 await applyEpgUnits(racing,{plan:p,now:()=>T});
 const moved=planEpgUnits({runId:'run-7',at:T,films:[{id:ID(1),facts:facts('Other')}]});
 const gone=await reconcileEpg(envOf(file),{plan:moved,now:()=>iso(61000)});
 assert.equal(gone.abandoned.length,1);assert.equal(receipts(file)[0].error_class,'producer_source_changed');assert.equal(title(file),'Z','a source that moved on is never replayed');
}
function title(file,id=ID(1)){return one(file,"SELECT original_title FROM film WHERE id='"+id+"'");}
if(section('6')){
 const file=database('open');
 const p=planEpgUnits({runId:'run-8',at:T,films:[{id:ID(1),facts:facts('A')}]});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)await writeFilmFacts(envOf(file),{id:ID(1),at:T,requestId:'interloper',expectedRevision:0,film:{contractVersion:1,originalTitle:'Z',source:'tmdb'},watchlist:false});}});
 await applyEpgUnits(racing,{plan:p,now:()=>T});
 const ok=await reconcileEpg(envOf(file),{plan:p,now:()=>iso(61000)});
 assert.equal(ok.considered,1);
 const [done]=receipts(file);
 assert.deepEqual([done.state,done.attempts,done.applied_revision,done.origin],['applied',2,2,'epg']);
 assert.equal(member(file,ID(1)),1);assert.equal(revision(file,ID(1)),2);
}

// 8. BLOCKER 1: a release-only unit is resolved against the STORED Film. Missing Film: skipped and never created. Existing Film at contract version 2 (and with identity and title): only the membership and the revision change, the Film row is
// untouched (contract version, title, identity, updated_at), in ONE receipted atomic batch. A departed non-member is a no-op. The release of a Film whose contract version differs from 1 does NOT overwrite it with 1.
if(section('8')){
 const file=database('open');
 const U='2026-11-01T00:00:00.000Z';
 assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('"+ID(20)+"',2,'Kept Title','"+U+"'),('"+ID(21)+"',1,'Plain','"+U+"'),('"+ID(22)+"',3,'Not Member','"+U+"');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('"+ID(20)+"','"+U+"'),('"+ID(21)+"','"+U+"')").status,0);
 const filmRow=id=>JSON.stringify(rows(file,"SELECT * FROM film WHERE id='"+id+"'"));
 const before={20:filmRow(ID(20)),21:filmRow(ID(21)),22:filmRow(ID(22))};
 const p=planEpgUnits({runId:'rel-1',at:T,films:[],departed:[ID(20),ID(21),ID(22),ID(23)]});
 const env=envOf(file);
 const out=await applyEpgUnits(env,{plan:p,now:()=>T});
 assert.deepEqual([out.done,out.counts.applied,out.counts.noop,out.counts.absent,out.counts.failed,out.counts.unknown],[true,2,1,1,0,0]);
 assert.equal(env.DB.calls.batches,4,'two changed Films, two batches each (pending receipt, atomic write with the applied receipt)');
 for(const id of [20,21,22])assert.equal(filmRow(ID(id)),before[id],'the Film row of '+id+' is byte for byte what it was: contract version, title, identity, updated_at');
 assert.equal(one(file,"SELECT contract_version FROM film WHERE id='"+ID(20)+"'"),2,'not overwritten with 1');
 assert.equal(filmCount(file,ID(23)),0,'a missing Film is never created');
 assert.deepEqual([member(file,ID(20)),member(file,ID(21)),member(file,ID(22)),member(file,ID(23))],[0,0,0,0]);
 assert.deepEqual([revision(file,ID(20)),revision(file,ID(21)),revision(file,ID(22)),revision(file,ID(23))],[1,1,0,0],'only the released members move their revision; the non-member and the missing Film do not');
 const list=receipts(file);
 assert.deepEqual(list.map(item=>[item.target_id,item.state,item.applied_revision]),[[ID(20),'applied',1],[ID(21),'applied',1]],'one applied receipt per released member, none for the no-op or the missing Film');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_metadata WHERE film_id IN ('"+ID(20)+"','"+ID(21)+"')"),0,'no other row is written');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_dimension WHERE film_id IN ('"+ID(20)+"','"+ID(21)+"')"),0);
 // Again: everything is a no-op, no batch, nothing moves.
 const stable=dump(file),again=envOf(file);
 const second=await applyEpgUnits(again,{plan:p,now:()=>T});
 assert.deepEqual([second.counts.noop,second.counts.absent,second.counts.applied],[3,1,0]);assert.equal(again.DB.calls.batches,0);assert.equal(dump(file),stable);
}

// 9. BLOCKER 2: a receipt of run A is never replayed from run B, even when B observed the same content (the content digest does not encode the event); the same run replays it with the SAME request id. The write of run A fails
// transiently (the revision does not move), so the receipt is due and failed with a counted attempt.
if(section('9')){
 const file=database('open');
 const mk=runId=>planEpgUnits({runId,at:T,films:[{id:ID(1),facts:facts('A')}]});
 const A=mk('run-A'),B=mk('run-B');
 assert.equal(await filmFactsDigest(A.units[0].input),await filmFactsDigest(B.units[0].input),'same content, same digest');
 let seen=0;
 const flaky=envOf(file,{onBatch:async()=>{seen++;if(seen===2)throw new Error('transient');}});
 const first=await applyEpgUnits(flaky,{plan:A,now:()=>T});
 assert.equal(first.counts.applied,0);
 const [failedReceipt]=receipts(file);
 assert.equal(failedReceipt.applied_revision,null);assert.equal(filmCount(file,ID(1)),0);
 const fromB=await reconcileEpg(envOf(file),{plan:B,now:()=>iso(3600000)});
 assert.equal(fromB.considered,1);
 const [afterB]=receipts(file);
 assert.equal(afterB.request_id,failedReceipt.request_id,'the original request id is kept');
 assert.notEqual(afterB.state,'applied','run B does not settle run A\'s request');
 assert.equal(filmCount(file,ID(1)),0,'no canonical write from the other run');assert.equal(revision(file,ID(1)),0);
 assert.ok(afterB.attempts>=failedReceipt.attempts&&afterB.state!=='abandoned','a counted retry, not an abandonment on an arbitrary new run: '+JSON.stringify(afterB));
 const fromA=await reconcileEpg(envOf(file),{plan:A,now:()=>iso(2*3600000+1)});
 assert.equal(fromA.considered,1);
 const [afterA]=receipts(file);
 assert.deepEqual([afterA.state,afterA.request_id,afterA.applied_revision],['applied',failedReceipt.request_id,1],'the same run replays under the same request id: '+JSON.stringify(afterA));
 assert.equal(member(file,ID(1)),1);assert.equal(title(file),'A');
}

// 9b. A release-only receipt of the same run is replayed through the stored Film (contract version kept); the release of another run is not.
if(section('9b')){
 const file=database('open');
 const U='2026-11-01T00:00:00.000Z';
 assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('"+ID(30)+"',2,'Kept','"+U+"');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('"+ID(30)+"','"+U+"')").status,0);
 const A=planEpgUnits({runId:'rel-A',at:T,departed:[ID(30)]}),B=planEpgUnits({runId:'rel-B',at:T,departed:[ID(30)]});
 let seen=0;
 await applyEpgUnits(envOf(file,{onBatch:async()=>{seen++;if(seen===2)throw new Error('transient');}}),{plan:A,now:()=>T});
 assert.equal(member(file,ID(30)),1);
 await reconcileEpg(envOf(file),{plan:B,now:()=>iso(3600000)});
 assert.equal(member(file,ID(30)),1,'another run does not replay the release');
 await reconcileEpg(envOf(file),{plan:A,now:()=>iso(2*3600000+1)});
 assert.equal(member(file,ID(30)),0);
 assert.deepEqual(rows(file,"SELECT contract_version,original_title,updated_at FROM film WHERE id='"+ID(30)+"'"),[{contract_version:2,original_title:'Kept',updated_at:U}]);
 assert.deepEqual([receipts(file)[0].state,revision(file,ID(30))],['applied',1]);
}

// 7. Static: dormant. No source file imports the module, build.mjs and the Worker do not name it, it imports exactly the adapter and the authority helpers, names no network, timer, cron or R2 API and holds no SQL;
// readiness stays truthful: the registry of receipt operations is still empty, so epg_commit (which also needs the person kinds) is not wired.
if(section('7')){
 const self='src/canonical-epg-producer.js';
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&full!==self&&fs.readFileSync(full,'utf8').includes('canonical-epg-producer'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,['src/canonical-epg-person-producer.js'],'only the dormant EPG Person layer (ADR 0126) imports it, for the event and the ceiling');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-epg-producer'),file+' does not bundle it');
 const text=fs.readFileSync(path.join(SRC,'canonical-epg-producer.js'),'utf8');
 const code_=text.replace(/\/\/.*$/gm,'');
 assert.deepEqual([...text.matchAll(/from '(\.\/[^']+)'/g)].map(match=>match[1]).sort(),['./canonical-producer-adapters.js','./film-person-authority.js']);
 assert.ok(!/\b(fetch|setTimeout|setInterval|scheduled|R2|BUCKET|waitUntil)\b/.test(code_),'no network, timer, cron or R2 reference');
 assert.ok(!/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?\s*\w/.test(code_),'the module holds no SQL of its own');
 assert.ok(!fs.readFileSync('src/worker.js','utf8').includes('canonical-epg-producer'),'the Worker does not name it');
 assert.deepEqual([...PRODUCER_OPERATIONS.keys()],['film_mutation'],'only the Discovery admission operation (AIR-374 P3c) is registered; this change registers nothing');
 const epg=PRODUCER_WIRING.find(item=>item.name==='epg_commit');
 assert.ok(epg.requires.some(kind=>!PRODUCER_OPERATIONS.has(kind)),'epg_commit stays unwired (blocker producer_not_wired:epg_commit is true)');
}
console.log('canonical-epg-producer: ok');
