// AIR-499 rated_admission_retention: film_admission and film_retention, sqlite3-CLI D1 stand-in. No production writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const M=await load('canonical-rated-admission-producer.js');
const {PRODUCER_OPERATIONS,PRODUCER_WIRING,handoffReadiness}=await load('canonical-producers.js');
const {activationAudit}=await load('film-person-open-handoff.js');
const {
 applyRatedAdmissionRetention,applyFilmAdmission,FILM_ADMISSION_OPERATION,FILM_RETENTION_OPERATION,
 RATED_ADMISSION_KINDS,RATED_ADMISSION_ORIGIN,ratedAdmissionRegistry,ratedAdmissionSettled,ratedAdmissionSliceSettled,
 ratedAdmissionRecord,carryRatedAdmissionIntent,resolveExistingRetentionFilm,UNIT_CAP,
 departedWatchlistLids,watchlistRetentionWork,assertRatedAdmissionAccepted,
}=M;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-rated-admission-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
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
const envOf=file=>({DB:d1Standin(file)});
const T='2026-11-16T12:00:00.000Z';
const T2='2026-11-16T13:00:00.000Z';
const T0='2026-11-16T11:00:00.000Z';
const SHA='a'.repeat(64);
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const receipt=(tmdb,over={})=>({tmdb:String(tmdb),sourceCode:'sc'+tmdb,archiveSha256:SHA,title:'Film '+tmdb,year:2001,verifiedAt:T,...over});
const KEYS=['film_admission','film_credits','film_facts','film_metadata','film_mutation','film_retention','film_sync_state','localization_conflict','localization_source','person_mutation','person_state'];

{
 const file=database('prepared');
 const before=one(file,'SELECT COUNT(*) FROM film_rated_admission');
 const out=await applyRatedAdmissionRetention(envOf(file),{event:'rated:p',admissions:[{receiptKey:'tmdb_603',receipt:receipt(603)}],now:()=>T});
 assert.equal(out.state,'skipped');assert.equal(out.reason,'projector_is_writer');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_rated_admission'),before);
}

{
 const file=database('open');
 const env=envOf(file);
 const out=await applyRatedAdmissionRetention(env,{event:'rated:open',admissions:[{receiptKey:'tmdb_603',receipt:receipt(603)}],now:()=>T});
 assert.equal(out.state,'complete');
 assert.equal(out.intent.length,0);
 assert.equal(one(file,"SELECT tmdb FROM film_rated_admission WHERE film_id='film:tmdb:603'"),'603');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:tmdb:603'"),1);
 const again=await applyRatedAdmissionRetention(env,{event:'rated:open',admissions:[{receiptKey:'tmdb_603',receipt:receipt(603)}],now:()=>T});
 assert.ok(again.noop>=1);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_rated_admission'),1);
}

{
 const file=database('open');
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:h95',1,'tmdb:603','Heat','"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:h95','tmdb','603',1,0,NULL);");
 const out=await applyRatedAdmissionRetention(envOf(file),{event:'rated:reuse',admissions:[{receiptKey:'tmdb_603',receipt:receipt(603)}],now:()=>T});
 assert.equal(out.state,'complete');
 assert.equal(one(file,"SELECT film_id FROM film_rated_admission"),'film:h95');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:tmdb:603'"),0);
}

{
 const file=database('open');
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:other',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:other','tmdb','603',0,0,NULL);");
 const out=await applyRatedAdmissionRetention(envOf(file),{event:'rated:held',admissions:[{receiptKey:'tmdb_603',receipt:receipt(603)}],now:()=>T});
 assert.equal(out.state,'incomplete');
 assert.ok(out.refusedDetail.some(item=>item.errorClass==='admission_identity_held'));
 assert.equal(one(file,'SELECT COUNT(*) FROM film_rated_admission'),0);
}

{
 const file=database('open');
 const env=envOf(file);
 const tv=await applyRatedAdmissionRetention(env,{event:'rated:tv',admissions:[{receiptKey:'tmdb_tv_5',receipt:{tmdb:'5',sourceCode:'x',archiveSha256:SHA,verifiedAt:T}}],now:()=>T});
 assert.equal(tv.state,'incomplete');
 const unverified=await applyRatedAdmissionRetention(env,{event:'rated:pending',admissions:[{receiptKey:'tmdb_7',receipt:{tmdb:'7',sourceCode:'x',archiveSha256:SHA}}],now:()=>T});
 assert.ok(unverified.refusedDetail.some(item=>item.errorClass==='not_verified'));
 const watch=await applyRatedAdmissionRetention(env,{event:'rated:wl',admissions:[{receiptKey:'tmdb_8',receipt:{...receipt(8),watchlist:true}}],now:()=>T});
 assert.ok(watch.refusedDetail.some(item=>item.errorClass==='watchlist_field'));
}

{
 const file=database('open');
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:11',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:11','tmdb','11',1,0,NULL),('film:tmdb:11','letterboxd','28nq',1,0,NULL);");
 const env=envOf(file);
 const a=await applyRatedAdmissionRetention(env,{event:'wl:1',retentions:[{lid:'28nq',tmdbId:'11',watchlist:true,observedAt:T,evidence:{scanId:'s1'}}],now:()=>T});
 assert.equal(a.state,'complete');
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:tmdb:11'"),1);
 const b=await applyRatedAdmissionRetention(env,{event:'wl:2',retentions:[{lid:'28nq',tmdbId:'11',watchlist:false,observedAt:T2,evidence:{scanId:'s2'}}],now:()=>T2});
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:tmdb:11'"),0);
 const stale=await applyRatedAdmissionRetention(env,{event:'wl:stale',retentions:[{lid:'28nq',tmdbId:'11',watchlist:true,observedAt:T0,evidence:{scanId:'old'}}],now:()=>T0});
 assert.ok(stale.noop>=1);
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:tmdb:11'"),0);
 const c=await applyRatedAdmissionRetention(env,{event:'wl:3',retentions:[{lid:'28nq',tmdbId:'11',watchlist:true,observedAt:'2026-11-16T14:00:00.000Z',evidence:{scanId:'s3'}}],now:()=>'2026-11-16T14:00:00.000Z'});
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:tmdb:11'"),1);
}

{
 const file=database('open');
 const missing=await applyRatedAdmissionRetention(envOf(file),{event:'wl:miss',retentions:[{lid:'nope',watchlist:true,observedAt:T,evidence:{scanId:'s'}}],now:()=>T});
 assert.ok(missing.absent>=1);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_retention'),0);
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:a',1,'"+T+"'),('film:b',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:a','letterboxd','lid1',1,0,NULL),('film:b','tmdb','99',1,0,NULL);");
 const collide=await applyRatedAdmissionRetention(envOf(file),{event:'wl:col',retentions:[{lid:'lid1',tmdbId:'99',watchlist:true,observedAt:T}],now:()=>T});
 assert.ok(collide.refusedDetail.some(item=>item.errorClass==='identity_collision'));
}

{
 const file=database('held');
 await assert.rejects(()=>applyRatedAdmissionRetention(envOf(file),{event:'x',admissions:[{receiptKey:'tmdb_1',receipt:receipt(1)}],now:()=>T}),e=>e.code==='film_person_held');
}

{
 const file=database('open');
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:21',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:21','tmdb','21',1,0,NULL);");
 const env=envOf(file);
 const planned=await M.planRatedAdmissionIntent(env,{event:'fail',retentions:[{id:'film:tmdb:21',tmdbId:'21',watchlist:true,observedAt:T,evidence:{scanId:'s'}}],now:()=>T});
 assert.ok(planned.units.some(unit=>unit.operation===FILM_RETENTION_OPERATION));
 const replay=await applyRatedAdmissionRetention(env,{event:'fail',admissions:[],retentions:[],intent:planned.units,now:()=>T});
 assert.equal(replay.state,'complete');
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:tmdb:21'"),1);
}

{
 const file=database('open');
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:31',1,'"+T+"'),('film:tmdb:32',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:31','tmdb','31',1,0,NULL),('film:tmdb:32','tmdb','32',1,0,NULL);");
 const env=envOf(file);
 const batch1=await applyRatedAdmissionRetention(env,{event:'b1',retentions:[{tmdbId:'31',id:'film:tmdb:31',watchlist:true,observedAt:T,evidence:{scanId:'a'}}],now:()=>T});
 assert.equal(batch1.state,'complete');
 assert.equal(batch1.intent.length,0);
 const batch2=await applyRatedAdmissionRetention(env,{event:'b2',retentions:[{tmdbId:'32',id:'film:tmdb:32',watchlist:true,observedAt:T,evidence:{scanId:'b'}}],intent:batch1.intent,now:()=>T});
 assert.equal(batch2.state,'complete');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_retention'),2);
}

{
 assert.deepEqual([...PRODUCER_OPERATIONS.keys()].sort(),KEYS);
 for(const kind of RATED_ADMISSION_KINDS)assert.equal(PRODUCER_OPERATIONS.get(kind).atomic,true);
 const flipped=PRODUCER_WIRING.filter(item=>item.requires.every(kind=>[...PRODUCER_OPERATIONS.values()].some(op=>op.operation===kind&&op.atomic===true))).map(item=>item.name);
 assert.deepEqual(flipped,['epg_commit','metadata_sync','discovery_admission','rated_admission_retention']);
 const audit=activationAudit();
 assert.equal(audit.producers.find(item=>item.name==='rated_admission_retention').wired,true);
 assert.ok(!audit.residuals.includes('producer_not_wired:rated_admission_retention'));
 const ready=await handoffReadiness(envOf(database('prepared')),{now:T});
 assert.equal(ready.ready,false);
 assert.ok(!ready.blockers.includes('producer_not_wired:rated_admission_retention'));
}

{
 const source=fs.readFileSync(path.join(SRC,'canonical-rated-admission-producer.js'),'utf8');
 assert.ok(!/canonical-producers\.js/.test(source));
 const workerText=fs.readFileSync('src/worker.js','utf8');
 assert.ok(workerText.includes('CanonicalRatedAdmission.applyRatedAdmissionRetention'));
 assert.ok(/typeof CanonicalRatedAdmission!=='undefined'/.test(workerText));
 assert.ok(fs.readFileSync('src/letterboxd-rated-candidates.js','utf8').includes('CanonicalRatedAdmission.applyRatedAdmissionRetention'));
 assert.ok(fs.readFileSync('src/letterboxd-facts.js','utf8').includes('CanonicalRatedAdmission.applyRatedAdmissionRetention'));
 const build=fs.readFileSync('build.mjs','utf8');
 assert.ok(/scopedImports\('src\/canonical-rated-admission-producer\.js','CanonicalRatedAdmission'/.test(build));
 assert.ok(/scopedImports\('src\/film-admission\.js','CanonicalFilmAdmission'/.test(build));
}

function factsBucket(){
 const records=new Map(),etags=new Map();let revision=0;
 return {
  records,etags,
  async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key))}:null;},
  async put(key,value,options={}){
   const condition=options.onlyIf||{};
   if(condition.etagDoesNotMatch==='*'&&records.has(key)||condition.etagMatches&&condition.etagMatches!==etags.get(key))return null;
   records.set(key,typeof value==='string'?JSON.parse(value):value);etags.set(key,String(++revision));return {etag:etags.get(key)};
  },
  async delete(key){records.delete(key);},
 };
}
function seedFilm(file,id,tmdb,lid){
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ("+q(id)+",1,"+q(T)+");INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(id)+",'tmdb',"+q(tmdb)+",1,0,NULL)"+(lid?",("+q(id)+",'letterboxd',"+q(lid)+",1,0,NULL)":"")+";");
}

function loadScanWorker(env,LetterboxdFacts){
 const workerCtx=vm.createContext({env,Response,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,console,CanonicalRatedAdmission:M,LetterboxdFacts,fetch:async()=>{throw new Error('unexpected fetch');}});
 vm.runInContext(scoped('src/metadata-cache.js','MetadataCache')+'\n'+fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8')+'\n'+fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),workerCtx);
 workerCtx.ratingsGate=async()=>({active:false,migration:'none'});
 workerCtx.persistWatchlist=async()=>{};
 workerCtx.persistEvents=async()=>{};
 return workerCtx;
}
async function putPayload(env,runId,report){
 await env.BUCKET.put('epg/seal/'+runId+'/payload.json',JSON.stringify({report,watchlist:{films:[]},uncertain:[],fence:'g'}));
}

{
 const file=database('open');
 const env=envOf(file);
 env.BUCKET=factsBucket();
 const factsCtx=vm.createContext({crypto,TextEncoder,console,Date,JSON,Map,Set,structuredClone});
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);
 const listed=[];
 for(let i=0;i<61;i++){
  const lid='f'+String(i).padStart(2,'0'),tmdb=String(2000+i);
  listed.push({id:lid,tmdbId:tmdb});
  seedFilm(file,'film:tmdb:'+tmdb,tmdb,lid);
  await Facts.linkFilm({BUCKET:env.BUCKET},{letterboxd:lid,tmdb});
 }
 seedFilm(file,'film:tmdb:1999','1999','gone');
 await Facts.linkFilm({BUCKET:env.BUCKET},{letterboxd:'gone',tmdb:'1999'});
 await Facts.applyWatchlistScan({BUCKET:env.BUCKET},{scanId:'prior',observedAt:T0,films:[...listed,{id:'gone',tmdbId:'1999'}]});
 let scans=0;
 const LetterboxdFacts={applyWatchlistScan:async(...args)=>{scans++;return Facts.applyWatchlistScan(...args);}};
 const workerCtx=loadScanWorker(env,LetterboxdFacts);
 const run={runId:'scan-61',stage:'seal',watchlistObservedAt:T,seal:{phase:'finalize',units:{},attempts:{}},events:[],error:undefined};
 const report={films:listed,watchlistCount:61,updatedAt:T,runId:'scan-61'};
 workerCtx.run=run;workerCtx.report=report;
 await env.BUCKET.put('sync.json',JSON.stringify(run));
 await putPayload(env,'scan-61',report);
 let continues=0,last=null;
 for(let i=0;i<20;i++){
  last=await vm.runInContext('sealFinalizeStep(env,run)',workerCtx);
  if(run.seal?.phase==='finalize'&&!run.seal.units?.scan)continues++;
  assert.equal(run.error,undefined);
  if(run.seal?.phase==='queue'||last.stage==='complete')break;
 }
 assert.equal(continues,5,'61 listed + 1 departed need six UNIT_CAP=12 scan slices; five are explicit continues');
 assert.equal(run.seal.phase,'queue');
 assert.equal(last.discovery.nextAction,'continue');
 assert.equal(scans,1);
 assert.equal(env.BUCKET.records.get('enrichment/view-index.json').gone.watchlist,false);
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:tmdb:1999'"),0);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_retention'),62);
 assert.equal(run.ratedAdmissionIntent,undefined);
 assert.equal(run.ratedAdmissionScan,undefined);
}

{
 const file=database('prepared');
 const env=envOf(file);
 env.BUCKET=factsBucket();
 const factsCtx=vm.createContext({crypto,TextEncoder,console,Date,JSON,Map,Set,structuredClone});
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);
 const listed=[];
 for(let i=0;i<26;i++){
  const lid='p'+String(i).padStart(2,'0');
  listed.push({id:lid,tmdbId:String(3000+i)});
  await Facts.linkFilm({BUCKET:env.BUCKET},{letterboxd:lid,tmdb:String(3000+i)});
 }
 let scans=0;
 const LetterboxdFacts={applyWatchlistScan:async(...args)=>{scans++;return Facts.applyWatchlistScan(...args);}};
 const workerCtx=loadScanWorker(env,LetterboxdFacts);
 const run={runId:'prep-26',stage:'seal',watchlistObservedAt:T,seal:{phase:'finalize',units:{},attempts:{}},events:[]};
 const report={films:listed,watchlistCount:26,updatedAt:T,runId:'prep-26'};
 workerCtx.run=run;
 await env.BUCKET.put('sync.json',JSON.stringify(run));
 await putPayload(env,'prep-26',report);
 const first=await vm.runInContext('sealFinalizeStep(env,run)',workerCtx);
 assert.equal(run.seal.phase,'queue');
 assert.equal(first.discovery.nextAction,'continue');
 assert.equal(run.ratedAdmissionScan,undefined);
 assert.equal(scans,1);
 assert.equal(env.BUCKET.records.get('sync.json').ratedAdmissionScan,undefined);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_retention'),0);
}

{
 const file=database('open');
 const env=envOf(file);
 env.BUCKET=factsBucket();
 const factsCtx=vm.createContext({crypto,TextEncoder,console,Date,JSON,Map,Set,structuredClone,CanonicalRatedAdmission:M});
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);
 const origin={archiveSha256:SHA,generatedAt:T,generatedAtSource:'archive_name'};
 const item={lid:'alien',tmdb:'348',identity:'inferred',admit:{title:'Alien',year:1979},facts:{watched:true,rating:4}};
 factsCtx.CanonicalRatedAdmission={
  ...M,
  applyRatedAdmissionRetention:async()=>{const error=new Error('injected before receipt');error.code='d1_error';throw error;},
 };
 await assert.rejects(Facts.commitBaselineChunk({BUCKET:env.BUCKET,DB:env.DB},{origin,chunk:0,items:[item]}),e=>e.code==='d1_error');
 assert.equal(env.BUCKET.records.get('letterboxd/admissions/verified-films.json')?.films?.tmdb_348?.tmdb,'348');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_rated_admission'),0);
 factsCtx.CanonicalRatedAdmission=M;
 const committed=await Facts.commitBaselineChunk({BUCKET:env.BUCKET,DB:env.DB},{origin,chunk:0,items:[item]});
 assert.equal(committed.replay,false);
 assert.equal(one(file,"SELECT tmdb FROM film_rated_admission WHERE film_id='film:tmdb:348'"),'348');
 const replay=await Facts.commitBaselineChunk({BUCKET:env.BUCKET,DB:env.DB},{origin,chunk:0,items:[item]});
 assert.equal(replay.replay,true);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_rated_admission'),1);
}

{
 const file=database('open');
 const env=envOf(file);
 env.BUCKET=factsBucket();
 let n=0;
 const factsCtx=vm.createContext({crypto,TextEncoder,console,Date,JSON,Map,Set,structuredClone,CanonicalRatedAdmission:{
  ...M,
  applyRatedAdmissionRetention:async(...args)=>{
   n++;
   if(n===1)return {state:'unknown',applied:0,failed:0,unknown:1,preflightFailed:0,refused:0,deferred:0,intent:[{requestId:'u1'}],units:[{state:'unknown'}]};
   return M.applyRatedAdmissionRetention(...args);
  },
 }});
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);
 const origin={archiveSha256:SHA,generatedAt:T,generatedAtSource:'archive_name'};
 const item={lid:'heat',tmdb:'949',identity:'inferred',admit:{title:'Heat',year:1995},facts:{watched:true,rating:4}};
 await assert.rejects(Facts.commitBaselineChunk({BUCKET:env.BUCKET,DB:env.DB},{origin,chunk:0,items:[item]}),e=>e.code==='rated_admission_incomplete');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_rated_admission'),0);
 const second=await Facts.commitBaselineChunk({BUCKET:env.BUCKET,DB:env.DB},{origin,chunk:0,items:[item]});
 assert.equal(second.replay,false);
 assert.equal(one(file,"SELECT tmdb FROM film_rated_admission WHERE film_id='film:tmdb:949'"),'949');
}

{
 const file=database('open');
 const env=envOf(file);
 env.BUCKET=factsBucket();
 const factsCtx=vm.createContext({crypto,TextEncoder,console,Date,JSON,Map,Set,structuredClone,CanonicalRatedAdmission:M});
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);
 await Facts.linkFilm({BUCKET:env.BUCKET},{letterboxd:'taken',tmdb:'1'});
 const origin={archiveSha256:SHA,generatedAt:T,generatedAtSource:'archive_name'};
 const item={lid:'taken',tmdb:'603',identity:'inferred',admit:{title:'Taken',year:2008},facts:{watched:true,rating:3}};
 const out=await Facts.commitBaselineChunk({BUCKET:env.BUCKET,DB:env.DB},{origin,chunk:0,items:[item]});
 assert.equal(out.conflicts,1);
 assert.equal(env.BUCKET.records.get('letterboxd/admissions/verified-films.json')?.films?.tmdb_603,undefined);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_rated_admission'),0);
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:tmdb:603'"),0);
}

{
 const file=database('open');
 const env=envOf(file);
 env.BUCKET=factsBucket();
 let applies=0;
 const wrap={
  ...M,
  applyRatedAdmissionRetention:async(...args)=>{
   applies++;
   if(applies===1){const error=new Error('injected');error.code='d1_error';throw error;}
   if(applies===2)return {state:'unknown',applied:0,failed:0,unknown:1,preflightFailed:0,refused:0,deferred:0,intent:[],units:[]};
   return M.applyRatedAdmissionRetention(...args);
  },
 };
 const ctx=vm.createContext({crypto,TextEncoder,console,Date,JSON,Map,Set,URL,URLSearchParams,structuredClone,fetch:async()=>{throw new Error('no fetch');},CanonicalRatedAdmission:wrap});
 vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8'),ctx);
 vm.runInContext(scoped('src/letterboxd-match.js','LetterboxdMatch'),ctx);
 vm.runInContext(scoped('src/domain/letterboxd-rated-admission.js','LetterboxdRatedAdmission'),ctx);
 vm.runInContext(scopedReplacing('src/letterboxd-identity.js','LetterboxdIdentity','const normTitle=LetterboxdMatch.normTitle;\n'),ctx);
 vm.runInContext(fs.readFileSync('src/letterboxd-rated-candidates.js','utf8'),ctx);
 const Candidates=vm.runInContext('LetterboxdRatedCandidates',ctx);
 const sha=SHA;
 const generatedAt=T;
 await env.BUCKET.put('letterboxd/imports/'+sha+'/rated-candidates.json',JSON.stringify({schemaVersion:1,archiveSha256:sha,generatedAt,candidates:{sc603:{code:'sc603',state:'admitting',intendedTmdb:'603',filmPath:'/film/heat/',name:'Heat',year:1995,rating:4}},checkpoint:{cursor:'sc603',stopped:null}}));
 await assert.rejects(Candidates.identityStep({BUCKET:env.BUCKET,DB:env.DB},{sha,code:'sc603'}),e=>e.code==='d1_error');
 await assert.rejects(Candidates.identityStep({BUCKET:env.BUCKET,DB:env.DB},{sha,code:'sc603'}),e=>e.code==='rated_admission_incomplete');
 const third=await Candidates.identityStep({BUCKET:env.BUCKET,DB:env.DB},{sha,code:'sc603'});
 assert.equal(third.verified,true);
 assert.equal(one(file,"SELECT tmdb FROM film_rated_admission WHERE film_id='film:tmdb:603'"),'603');
}

console.log('canonical-rated-admission-producer: ok');
void applyFilmAdmission;void ratedAdmissionRegistry;void UNIT_CAP;void resolveExistingRetentionFilm;void RATED_ADMISSION_ORIGIN;void FILM_ADMISSION_OPERATION;void FILM_RETENTION_OPERATION;void ratedAdmissionRecord;void departedWatchlistLids;void watchlistRetentionWork;void assertRatedAdmissionAccepted;void ratedAdmissionSliceSettled;
