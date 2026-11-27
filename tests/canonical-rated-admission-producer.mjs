// AIR-499 rated_admission_retention: film_admission and film_retention, sqlite3-CLI D1 stand-in. No production writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {installViewIndexFixture} from './view-index-fixture.mjs';
import {pathToFileURL} from 'node:url';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const M=await load('canonical-rated-admission-producer.js');
const FA=await load('film-admission.js');
const {PRODUCER_OPERATIONS,PRODUCER_WIRING,handoffReadiness}=await load('canonical-producers.js');
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
// A real schema 24 database (the chain up to 0024, without 0025 and later), for the pre-migration behaviour.
const template24=path.join(root,'template24.sqlite');
assert.equal(sqlite(template24,chain.filter(name=>Number(name.slice(0,4))<=24).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
let n=0;
function database(stage='open',source=template){
 const file=path.join(root,'e-'+(n++)+'.sqlite');
 fs.copyFileSync(source,file);
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
const KEYS=['film_admission','film_credits','film_facts','film_localization_projection','film_metadata','film_mutation','film_retention','film_sync_state','localization_conflict','localization_source','person_mutation','person_state'];

{
 const file=database('prepared');
 const before=one(file,'SELECT COUNT(*) FROM film_rated_admission');
 await assert.rejects(()=>applyRatedAdmissionRetention(envOf(file),{event:'rated:p',admissions:[{receiptKey:'tmdb_603',receipt:receipt(603)}],now:()=>T}),error=>error.code==='film_person_unavailable');
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

// AIR-532 (ADR 0173): observed_at is the start of the current watchlist state. A scan that repeats the stored boolean writes nothing; an exit and a re-add do.
{
 const file=database('open');
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:51',1,'"+T+"'),('film:tmdb:52',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:51','tmdb','51',1,0,NULL),('film:tmdb:51','letterboxd','s51',1,0,NULL),('film:tmdb:52','tmdb','52',1,0,NULL),('film:tmdb:52','letterboxd','s52',1,0,NULL);");
 const env=envOf(file);
 const item=(lid,tmdbId,watchlist,observedAt,scanId)=>({lid,tmdbId,watchlist,observedAt,evidence:{scanId}});
 const state=id=>rows(file,"SELECT r.observed_at AS at,r.watchlist AS w,r.request_id AS rid,c.revision AS rev FROM film_retention r JOIN canonical_revision c ON c.kind='film' AND c.id=r.film_id WHERE r.film_id='"+id+"'")[0];
 const first=await applyRatedAdmissionRetention(env,{event:'d:1',retentions:[item('s51','51',true,T,'d1'),item('s52','52',true,T,'d1')],now:()=>T});
 assert.equal(first.applied,2);
 const before=state('film:tmdb:51'),receipts=one(file,'SELECT COUNT(*) FROM canonical_write_receipt');
 const quiet=await applyRatedAdmissionRetention(env,{event:'d:2',retentions:[item('s51','51',true,T2,'d2'),item('s52','52',true,T2,'d2')],now:()=>T2});
 assert.equal(quiet.state,'complete');assert.equal(quiet.applied,0);assert.equal(quiet.noop,2);
 assert.deepEqual(state('film:tmdb:51'),before,'an unchanged daily scan keeps observed_at, request id and revision');
 assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),receipts,'an unchanged scan creates no receipt');
 const T3='2026-11-16T14:00:00.000Z',T4='2026-11-16T15:00:00.000Z';
 const exit=await applyRatedAdmissionRetention(env,{event:'d:3',retentions:[item('s51','51',false,T3,'d3'),item('s52','52',true,T3,'d3')],now:()=>T3});
 assert.equal(exit.applied,1);assert.equal(exit.noop,1);
 assert.equal(state('film:tmdb:51').at,T3);assert.equal(state('film:tmdb:51').w,0);assert.equal(state('film:tmdb:52').at,T,'the Film that stayed keeps its oldest observed_at');
 const stay=await applyRatedAdmissionRetention(env,{event:'d:4',retentions:[item('s51','51',false,T4,'d4')],now:()=>T4});
 assert.equal(stay.noop,1);assert.equal(state('film:tmdb:51').at,T3,'a Film that stays gone keeps the time it left');
 const back=await applyRatedAdmissionRetention(env,{event:'d:5',retentions:[item('s51','51',true,T4,'d5')],now:()=>T4});
 assert.equal(back.applied,1);assert.equal(state('film:tmdb:51').at,T4);assert.equal(state('film:tmdb:51').w,1);
}

// AIR-532: revision race, interrupted slice and a mass add/remove. No Film is written twice and no change is lost.
{
 const file=database('open');
 const films=[];for(let i=61;i<=72;i++)films.push("('film:tmdb:"+i+"',1,'"+T+"')");
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES "+films.join(',')+";INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES "+Array.from({length:12},(_,k)=>"('film:tmdb:"+(61+k)+"','tmdb','"+(61+k)+"',1,0,NULL),('film:tmdb:"+(61+k)+"','letterboxd','m"+(61+k)+"',1,0,NULL)").join(',')+";");
 const item=(n,watchlist,observedAt,scanId)=>({lid:'m'+n,tmdbId:String(n),watchlist,observedAt,evidence:{scanId}});
 const all=(watchlist,at,scanId,from=61,to=72)=>Array.from({length:to-from+1},(_,k)=>item(from+k,watchlist,at,scanId));
 const state=id=>rows(file,"SELECT r.watchlist AS w,r.observed_at AS at,c.revision AS rev FROM film_retention r JOIN canonical_revision c ON c.kind='film' AND c.id=r.film_id WHERE r.film_id='"+id+"'")[0];
 const T3='2026-11-16T14:00:00.000Z',T4='2026-11-16T15:00:00.000Z',T5='2026-11-16T16:00:00.000Z';
 // mass add: one batch per Film, one receipt per Film
 const add=await applyRatedAdmissionRetention({DB:d1Standin(file)},{event:'m:1',retentions:all(true,T,'m1'),now:()=>T});
 assert.equal(add.applied,12);assert.equal(one(file,'SELECT COUNT(*) FROM film_retention'),12);
 const rev=state('film:tmdb:61').rev;
 // a concurrent writer moves the revision of one Film between the plan and the write: that unit is not written, the rest are, and the carried intent finishes it
 let hit=0;
 const racing={DB:d1Standin(file,{onBatch:async()=>{hit++;if(hit===1)assert.equal(sqlite(file,"UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id='film:tmdb:61'").status,0);}})};
 const race=await applyRatedAdmissionRetention(racing,{event:'m:2',retentions:all(false,T3,'m2'),now:()=>T3});
 assert.equal(race.applied+race.failed+race.unknown+race.noop,12);
 const finished=race.state==='complete'?race:await applyRatedAdmissionRetention({DB:d1Standin(file)},{event:'m:2',intent:race.intent,retentions:[],now:()=>'2026-11-16T14:10:00.000Z'});
 assert.equal(finished.state,'complete');
 for(let n=61;n<=72;n++)assert.equal(state('film:tmdb:'+n).w,0,'every exit landed: film:tmdb:'+n);
 assert.ok(state('film:tmdb:61').rev>=rev+2,'the foreign bump and our write both count');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_retention'),12,'no second row for any Film');
 // an interrupted slice (a transient batch error) repeats the SAME request ids: no Film is written twice
 const before=one(file,'SELECT COUNT(*) FROM canonical_write_receipt');
 let seen=0;
 const flaky={DB:d1Standin(file,{onBatch:async()=>{seen++;if(seen===2)throw new Error('transient');}})};
 await assert.rejects(()=>applyRatedAdmissionRetention(flaky,{event:'m:3',retentions:all(true,T4,'m3',61,64),now:()=>T4}),error=>error.code==='film_person_unavailable','a transient write failure aborts the slice, fail closed');
 const done=await applyRatedAdmissionRetention({DB:d1Standin(file)},{event:'m:3',retentions:all(true,T4,'m3',61,64),now:()=>'2026-11-16T15:10:00.000Z'});
 assert.equal(done.state,'complete');
 for(let n=61;n<=64;n++){assert.equal(state('film:tmdb:'+n).w,1);assert.equal(state('film:tmdb:'+n).at,T4);}
 assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt')-before,4,'one receipt per changed Film, none repeated');
 // replaying the whole event after it finished writes nothing
 const replayed=await applyRatedAdmissionRetention({DB:d1Standin(file)},{event:'m:3',retentions:all(true,T4,'m3',61,64),now:()=>T4});
 assert.equal(replayed.applied,0);assert.equal(replayed.noop,4);
 // a stale scan (older observedAt) never moves a Film back
 const stale=await applyRatedAdmissionRetention({DB:d1Standin(file)},{event:'m:old',retentions:all(false,T0,'old',61,64),now:()=>T0});
 assert.equal(stale.applied,0);for(let n=61;n<=64;n++)assert.equal(state('film:tmdb:'+n).w,1);
 void T5;
}

// AIR-532 review P1 (ADR 0173): the scan watermark orders a late observation against a later unchanged confirmation, which `observed_at` (the start of the state) cannot.
{
 const mk=()=>{
  const file=database('open');
  sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:81',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:81','tmdb','81',1,0,NULL),('film:tmdb:81','letterboxd','w81',1,0,NULL);");
  return file;
 };
 const d=n=>'2026-11-'+n+'T12:00:00.000Z';
 const unit=(watchlist,observedAt,scanId)=>({lid:'w81',tmdbId:'81',watchlist,observedAt,evidence:{scanId}});
 const st=file=>rows(file,"SELECT r.watchlist AS w,r.observed_at AS at,r.request_id AS rid,c.revision AS rev FROM film_retention r JOIN canonical_revision c ON c.kind='film' AND c.id=r.film_id WHERE r.film_id='film:tmdb:81'")[0];
 const wmark=file=>one(file,'SELECT observed_at FROM film_retention_scan WHERE id=1');
 const rcpt=file=>Number(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'));

 // 1. true at t1, true at t3 (no-op), then a delayed false at t2 with t1 < t2 < t3: it is stale, the Film stays true, nothing is written.
 {
  const file=mk();
  await applyRatedAdmissionRetention(envOf(file),{event:'p:1',retentions:[unit(true,d('10'),'s1')],now:()=>d('10')});
  assert.equal(wmark(file),d('10'));
  const quiet=await applyRatedAdmissionRetention(envOf(file),{event:'p:3',retentions:[unit(true,d('18'),'s3')],now:()=>d('18')});
  assert.equal(quiet.noop,1);assert.equal(wmark(file),d('18'),'the watermark moved to the newest scan');
  const before=st(file),receipts=rcpt(file);
  const late=await applyRatedAdmissionRetention(envOf(file),{event:'p:2',retentions:[unit(false,d('15'),'s2')],now:()=>d('19')});
  assert.equal(late.state,'complete');assert.equal(late.applied,0);assert.equal(late.noop,1);
  assert.deepEqual(st(file),before,'a late contradictory observation leaves state, observed_at, request id and revision alone');
  assert.equal(rcpt(file),receipts,'and creates no receipt');
  assert.equal(wmark(file),d('18'),'a stale scan never moves the watermark back');
 }

 // 2. an older false receipt left pending (its write was cut) is not replayed after a newer unchanged scan confirmed true.
 {
  const file=mk();
  await applyRatedAdmissionRetention(envOf(file),{event:'q:1',retentions:[unit(true,d('10'),'s1')],now:()=>d('10')});
  const receiptsBefore=rcpt(file),appliedBefore=Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE state='applied'"));
  const planned=await M.planRatedAdmissionIntent(envOf(file),{event:'q:2',retentions:[unit(false,d('15'),'s2')],now:()=>d('15')});
  assert.equal(planned.units.length,1);
  let seen=0;
  const cut={DB:d1Standin(file,{onBatch:async()=>{seen++;if(seen===2)throw new Error('transient');}})};
  await assert.rejects(()=>applyRatedAdmissionRetention(cut,{event:'q:2',intent:planned.units,retentions:[],now:()=>d('15')}),error=>error.code==='film_person_unavailable');
  assert.equal(rcpt(file)-receiptsBefore,1,'the cut write left one pending receipt');
  assert.equal(st(file).w,1);
  await applyRatedAdmissionRetention(envOf(file),{event:'q:3',retentions:[unit(true,d('18'),'s3')],now:()=>d('18')});
  assert.equal(wmark(file),d('18'));
  // the old unit is still carried (an intent that outlived its scan) and its receipt is due: neither replays it
  const settled=await applyRatedAdmissionRetention(envOf(file),{event:'q:4',intent:planned.units,retentions:[],now:()=>d('19')});
  assert.equal(settled.applied,0);
  assert.equal(st(file).w,1,'the older false is never applied after the newer confirmation');
  assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE state='applied'")),appliedBefore,'the old receipt is not settled as applied');
 }

 // 3. the watermark moves between the plan and the write (batch 1 advances it, 2 records the receipt, 3 is the Film write): the batch refuses, nothing lands, the retry ends stale.
 {
  const file=mk();
  await applyRatedAdmissionRetention(envOf(file),{event:'r:1',retentions:[unit(true,d('10'),'s1')],now:()=>d('10')});
  const before=st(file);
  let hit=0;
  const racing={DB:d1Standin(file,{onBatch:async()=>{hit++;if(hit===3)assert.equal(sqlite(file,"UPDATE film_retention_scan SET observed_at='"+d('18')+"' WHERE id=1").status,0);}})};
  const out=await applyRatedAdmissionRetention(racing,{event:'r:2',retentions:[unit(false,d('15'),'s2')],now:()=>d('15')});
  assert.equal(out.applied,0);assert.deepEqual(st(file),before,'the guarded batch wrote nothing');
  const retry=await applyRatedAdmissionRetention(envOf(file),{event:'r:2',intent:out.intent,retentions:[unit(false,d('15'),'s2')],now:()=>'2026-11-19T12:10:00.000Z'});
  assert.equal(retry.state,'complete');assert.equal(st(file).w,1,'the retry is stale against the newer watermark');
 }

 // 4. normal exit and re-add under the watermark still go through the revision and receipt fences.
 {
  const file=mk();
  await applyRatedAdmissionRetention(envOf(file),{event:'e:1',retentions:[unit(true,d('10'),'s1')],now:()=>d('10')});
  const exit=await applyRatedAdmissionRetention(envOf(file),{event:'e:2',retentions:[unit(false,d('12'),'s2')],now:()=>d('12')});
  assert.equal(exit.applied,1);assert.equal(st(file).w,0);assert.equal(st(file).at,d('12'));
  const back=await applyRatedAdmissionRetention(envOf(file),{event:'e:3',retentions:[unit(true,d('14'),'s3')],now:()=>d('14')});
  assert.equal(back.applied,1);assert.equal(st(file).w,1);assert.equal(st(file).at,d('14'));
  assert.equal(rcpt(file),3,'one receipt per real change');
  assert.equal(wmark(file),d('14'));
 }

 // 5. the watermark row only moves forward and is never deleted (triggers), and the fenced advance never lowers it.
 {
  const file=mk();
  await applyRatedAdmissionRetention(envOf(file),{event:'t:1',retentions:[unit(true,d('18'),'s1')],now:()=>d('18')});
  assert.notEqual(sqlite(file,"UPDATE film_retention_scan SET observed_at='"+d('10')+"' WHERE id=1").status,0,'lowering is refused');
  assert.notEqual(sqlite(file,'DELETE FROM film_retention_scan').status,0,'deleting is refused');
  assert.equal(wmark(file),d('18'));
 }

 // 6. a real schema 24 database (no table yet): the previous behaviour stays, so deploying the code before the migration is safe.
 {
  const file=database('open',template24);
  assert.equal(Number(one(file,'SELECT version FROM schema_contract WHERE id=1')),24);
  sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:81',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:81','tmdb','81',1,0,NULL),('film:tmdb:81','letterboxd','w81',1,0,NULL);");
  await applyRatedAdmissionRetention(envOf(file),{event:'l:1',retentions:[unit(true,d('10'),'s1')],now:()=>d('10')});
  const again=await applyRatedAdmissionRetention(envOf(file),{event:'l:2',retentions:[unit(true,d('18'),'s2')],now:()=>d('18')});
  assert.equal(again.applied,1);assert.equal(st(file).at,d('18'),'schema 24: every newer scan rewrites observed_at');
  const stale=await applyRatedAdmissionRetention(envOf(file),{event:'l:3',retentions:[unit(false,d('15'),'s3')],now:()=>d('19')});
  assert.equal(stale.applied,0);assert.equal(st(file).w,1,'the row-level monotonic rule still refuses an older observation');
 }

 // 6b. schema 25 WITHOUT the watermark table is a damaged schema, not a pre-migration one: fail closed, write nothing, never fall back to row-only ordering.
 {
  const file=mk();
  await applyRatedAdmissionRetention(envOf(file),{event:'m:1',retentions:[unit(true,d('10'),'s1')],now:()=>d('10')});
  const before=st(file);
  assert.equal(sqlite(file,'DROP TABLE film_retention_scan').status,0);
  assert.equal(Number(one(file,'SELECT version FROM schema_contract WHERE id=1')),50);
  await assert.rejects(()=>applyRatedAdmissionRetention(envOf(file),{event:'m:2',retentions:[unit(false,d('15'),'s2')],now:()=>d('19')}),error=>error.code==='film_person_unavailable'&&/film_retention_scan_missing_at_schema_50/.test(String(error.cause?.message)));
  assert.deepEqual(st(file),before,'nothing was written');
  await assert.rejects(()=>FA.readRetentionWatermark(envOf(file)),error=>error.code==='film_person_unavailable');
 }

 // 7. rollback contract: Worker code that never reads the watermark (here: retainFilm called without `watermark`) cannot overwrite a newer confirmation, because the guard is in the database.
 {
  const file=mk();
  await applyRatedAdmissionRetention(envOf(file),{event:'b:1',retentions:[unit(true,d('10'),'s1')],now:()=>d('10')});
  await applyRatedAdmissionRetention(envOf(file),{event:'b:3',retentions:[unit(true,d('18'),'s3')],now:()=>d('18')});
  assert.equal(wmark(file),d('18'));
  const before=st(file);
  const oldCode=(watchlist,observedAt,requestId)=>FA.retainFilm(envOf(file),{id:'film:tmdb:81',expectedRevision:st(file).rev,at:d('20'),requestId,watchlist,observedAt,evidence:{scanId:requestId}});
  await assert.rejects(()=>oldCode(false,d('15'),'old-late'),error=>error.code==='film_person_unavailable'&&/film_retention_scan_stale/.test(String(error.cause?.message)),'a rolled-back producer is refused by the database for a late contradictory observation');
  assert.deepEqual(st(file),before,'and nothing was written');
  const same=await oldCode(true,d('16'),'old-late-same');
  assert.equal(same.written,true,'a late observation that agrees with the stored boolean is harmless and allowed');
  assert.equal((await oldCode(false,d('21'),'old-new')).written,true,'an observation at or after the watermark is allowed: the reverted producer works as before');
  assert.equal(st(file).w,0);assert.equal(wmark(file),d('18'),'the reverted producer does not advance the watermark; it only lags');
  // re-deploying the new code resumes from the stored watermark
  const resumed=await applyRatedAdmissionRetention(envOf(file),{event:'b:5',retentions:[unit(true,d('22'),'s5')],now:()=>d('22')});
  assert.equal(resumed.applied,1);assert.equal(st(file).w,1);assert.equal(wmark(file),d('22'));
  // the first row of a Film is not covered by the guard (documented limit); a direct contradicting UPDATE is
  assert.equal(sqlite(file,"UPDATE film_retention_scan SET observed_at='"+d('30')+"' WHERE id=1").status,0);
  assert.notEqual(sqlite(file,"UPDATE film_retention SET watchlist=0,observed_at='"+d('25')+"' WHERE film_id='film:tmdb:81'").status,0,'a direct contradicting UPDATE newer than the row but older than the watermark is refused too');
  assert.equal(st(file).w,1);
 }

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
 const file=database('open');
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:daU4',1,'tmdb_tv:64099','TV','"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:daU4','letterboxd','daU4',1,0,NULL),('film:daU4','tmdb','378779',0,0,NULL);INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:daU4','watchlist_fact',1,'{}','prior','2026-11-13T00:00:00.000Z','2026-11-13T00:00:00.000Z');");
 const env=envOf(file);
 assert.equal(await resolveExistingRetentionFilm(env,{lid:'daU4',tmdbId:'378779'}),'film:daU4');
 const first=await applyRatedAdmissionRetention(env,{event:'wl:tv',retentions:[{lid:'daU4',tmdbId:'378779',watchlist:true,observedAt:T,evidence:{scanId:'s'}}],now:()=>T});
 assert.equal(first.state,'complete');
 assert.equal(one(file,"SELECT canonical_identity FROM film WHERE id='film:daU4'"),'tmdb_tv:64099');
 assert.equal(one(file,"SELECT trusted FROM film_external_id WHERE film_id='film:daU4' AND scheme='tmdb'"),0);
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:daU4'"),1);
 const replay=await applyRatedAdmissionRetention(env,{event:'wl:tv2',retentions:[{lid:'daU4',tmdbId:'378779',watchlist:true,observedAt:T,evidence:{scanId:'s'}}],now:()=>T});
 assert.ok(replay.noop>=1);
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id LIKE 'film:tmdb:%'"),0);
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:otherTmdb',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:otherTmdb','tmdb','1',1,0,NULL),('film:daU4','letterboxd','xLid',1,0,NULL);");
 await assert.rejects(resolveExistingRetentionFilm(env,{lid:'xLid',tmdbId:'1'}),e=>e.code==='identity_collision');
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:conf',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:conf','letterboxd','cLid',1,0,NULL),('film:conf','tmdb','2',0,1,NULL);");
 await assert.rejects(resolveExistingRetentionFilm(env,{lid:'cLid',tmdbId:'2'}),e=>e.code==='identity_collision');
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:nolid',1,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:nolid','tmdb','3',0,0,NULL);");
 await assert.rejects(resolveExistingRetentionFilm(env,{lid:'missingLid',tmdbId:'3'}),e=>e.code==='identity_collision');
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:from',1,'"+T+"'),('film:to',1,'"+T+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:from','film:to','"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:from','letterboxd','redir',1,0,NULL),('film:from','tmdb','4',0,0,NULL);");
 await assert.rejects(resolveExistingRetentionFilm(env,{lid:'redir',tmdbId:'4'}),e=>e.code==='film_person_redirect');
}

{
 const file=database('open');
 const env=envOf(file);
 env.BUCKET=factsBucket();
 const factsCtx=vm.createContext({crypto,TextEncoder,console,Date,JSON,Map,Set,structuredClone});
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);viewIndexSeam(factsCtx);
 const listed=[];
 for(let i=0;i<10;i++){
  const lid='n'+String(i).padStart(2,'0'),tmdb=String(5000+i);
  listed.push({id:lid,tmdbId:tmdb});
  seedFilm(file,'film:tmdb:'+tmdb,tmdb,lid);
  await Facts.linkFilm({BUCKET:env.BUCKET},{letterboxd:lid,tmdb});
 }
 for(const [lid,tmdb] of [['g97G','11'],['3tCe','12'],['1IUo','13']]){
  listed.push({id:lid,tmdbId:tmdb});
  sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES ("+q('film:'+lid)+",1,'tmdb_tv:1',"+q(T)+");INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q('film:'+lid)+",'letterboxd',"+q(lid)+",1,0,NULL),("+q('film:'+lid)+",'tmdb',"+q(tmdb)+",0,0,NULL);");
  await Facts.linkFilm({BUCKET:env.BUCKET},{letterboxd:lid,tmdb});
 }
 const LetterboxdFacts={applyWatchlistScan:async(...args)=>Facts.applyWatchlistScan(...args)};
 const workerCtx=loadScanWorker(env,LetterboxdFacts);
 const run={runId:'scan-live',stage:'seal',watchlistObservedAt:T,seal:{phase:'finalize',units:{},attempts:{}},events:[]};
 const report={films:listed,watchlistCount:listed.length,updatedAt:T,runId:'scan-live'};
 workerCtx.run=run;
 await env.BUCKET.put('sync.json',JSON.stringify(run));
 await putPayload(env,'scan-live',report);
 const first=await vm.runInContext('sealFinalizeStep(env,run)',workerCtx);
 assert.equal(first.discovery.nextAction,'continue');
 assert.equal(run.error,undefined);
 assert.equal(run.ratedAdmissionScan.cursor,12);
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:g97G'"),1);
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:3tCe'"),1);
 const second=await vm.runInContext('sealFinalizeStep(env,run)',workerCtx);
 assert.equal(run.seal.phase,'queue');
 assert.equal(second.discovery.nextAction,'continue');
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:1IUo'"),1);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_retention'),13);
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

// AIR-558: no raw view index: the derived view is the fake-bucket fixture and a stub ratings domain owns the projection and mirrors it into that fixture (the D1 ratings_view overlay), as these contexts have no ratings D1.
function viewIndexSeam(ctx){installViewIndexFixture(ctx);ctx.RatingsD1=new Proxy({ratingsMutableKey:()=>false,projectView:async(env,written)=>{const key='enrichment/view-index.json',got=await env.BUCKET.get(key),view=got?await got.json():{};for(const r of written)for(const id of [...(r.links.letterboxd?[String(r.links.letterboxd)]:[]),...(r.links.tmdb?['tmdb_'+r.links.tmdb]:[])]){const item={...(view[id]||{})};if(r.rating)item.actualRating=r.rating.value;if(r.watched)item.watched=r.watched.value;if(r.watchlist)item.watchlist=r.watchlist.value;view[id]=item;}await env.BUCKET.put(key,JSON.stringify(view));return {owned:true,changed:written.length};}},{get:(t,n)=>n in t?t[n]:async()=>({owned:false,handled:false,changed:0})});}
function loadScanWorker(env,LetterboxdFacts){
 const workerCtx=vm.createContext({env,Response,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,console,CanonicalRatedAdmission:M,LetterboxdFacts,fetch:async()=>{throw new Error('unexpected fetch');}});
 vm.runInContext(scoped('src/metadata-cache.js','MetadataCache')+'\n'+fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8')+'\n'+fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),workerCtx);
installViewIndexFixture(workerCtx);
 workerCtx.ratingsGate=async()=>({active:false,storage:'unsupported'});
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
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);viewIndexSeam(factsCtx);
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
 // AIR-558: no raw view-index watchlist projection any more; the D1 film_retention row below is the authority.
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
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);viewIndexSeam(factsCtx);
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
 await assert.rejects(()=>vm.runInContext('sealFinalizeStep(env,run)',workerCtx),error=>error.code==='film_person_unavailable');
 assert.equal(run.seal.phase,'finalize');
 assert.equal(run.ratedAdmissionScan,undefined);
 assert.equal(env.BUCKET.records.get('sync.json').ratedAdmissionScan,undefined);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_retention'),0);
}

{
 const file=database('open');
 const env=envOf(file);
 env.BUCKET=factsBucket();
 const factsCtx=vm.createContext({crypto,TextEncoder,console,Date,JSON,Map,Set,structuredClone,CanonicalRatedAdmission:M});
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);viewIndexSeam(factsCtx);
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
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);viewIndexSeam(factsCtx);
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
 const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',factsCtx);viewIndexSeam(factsCtx);
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
 vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8'),ctx);viewIndexSeam(ctx);
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

// AIR-599 / ADR 0207 decision 4b: through the Letterboxd Sync's fenced env (producerFence kind `letterboxd`) the admission batch and its receipt transitions assert the Sync epoch.
// A stale epoch admits nothing (no Film, no admission row, no applied receipt); the running epoch admits as before; another fence kind is not bound by these writers.
{
 const file=database('open');
 assert.equal(sqlite(file,"INSERT INTO letterboxd_sync_mode (id,mode,target,from_mode,epoch,drain,quarantine_reason,quarantined_at,changed_at,revision,write_id) VALUES (1,'cloudflare',NULL,'switching',5,NULL,NULL,NULL,'"+T0+"',1,'w')").status,0);
 const stale={...envOf(file),producerFence:{kind:'letterboxd',epoch:4}};
 const out=await applyRatedAdmissionRetention(stale,{event:'diary:stale',admissions:[{receiptKey:'tmdb_604',receipt:receipt(604)}],now:()=>T}).catch(error=>({thrown:error.code}));
 assert.ok(out.thrown||out.state!=='complete'||Number(out.failed||0)+Number(out.unknown||0)+Number(out.refused||0)>0,'a stale epoch is not a complete admission: '+JSON.stringify(out));
 assert.equal(one(file,"SELECT COUNT(*) FROM film_rated_admission WHERE tmdb='604'"),0,'a stale Sync epoch admits nothing');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:tmdb:604'"),0);
 assert.equal(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE state='applied'"),0);
 await assert.rejects(()=>FA.admitRatedFilm(stale,{receiptKey:'tmdb_604',receipt:receipt(604),expectedRevision:0,at:T,requestId:'req-stale'}),error=>error.code==='letterboxd_epoch_fence','the writer names the moved epoch');
 const running={...envOf(file),producerFence:{kind:'letterboxd',epoch:5}};
 const ok=await applyRatedAdmissionRetention(running,{event:'diary:running',admissions:[{receiptKey:'tmdb_604',receipt:receipt(604)}],now:()=>T2});
 assert.equal(ok.state,'complete',JSON.stringify(ok));assert.equal(one(file,"SELECT tmdb FROM film_rated_admission WHERE film_id='film:tmdb:604'"),'604');
 // the switch away (mode no longer `cloudflare`) fences the same epoch too
 assert.equal(sqlite(file,"UPDATE letterboxd_sync_mode SET mode='switching',target='external',epoch=6,revision=2 WHERE id=1").status,0);
 await assert.rejects(()=>FA.admitRatedFilm(running,{receiptKey:'tmdb_605',receipt:receipt(605),expectedRevision:0,at:T,requestId:'req-moved'}),error=>error.code==='letterboxd_epoch_fence');
 // another producer fence kind is not bound by the admission writer (unchanged behaviour of other producers)
 const other=await FA.admitRatedFilm({...envOf(file),producerFence:{kind:'dictionary'}},{receiptKey:'tmdb_605',receipt:receipt(605),expectedRevision:0,at:T,requestId:'req-other'});
 assert.equal(other.admitted,true);
}

// AIR-599 (fifth and sixth review of PR #1009): an env carrying the check reservation of a Letterboxd identity effect (`effectGuard`) admits only while the shared check document still holds that reservation, also when the
// reservation text is CUT BY THE PART BOUNDARY of the stored document (parts of 60,000 bytes with no regard to JSON tokens). A released, taken-over or voided reservation is refused AT COMMIT (no Film, no admission row).
{
 const {guardOf,splitRows,DIARY_KEY}=await import('./reservation-guard-fixture.mjs');
 const file=database('open');
 const insert=rows=>rows.map(([key,part,body,etag,at])=>"INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('"+key+"',"+part+",'"+body+"','"+etag+"','"+at+"');").join('\n');
 // the live reservation `c-live-0001` is cut inside the needle at byte 60000
 assert.equal(sqlite(file,insert(splitRows('c-live-0001',20,T0))).status,0);
 const gone={...envOf(file),effectGuard:guardOf('c-gone-0002')};
 await assert.rejects(()=>FA.admitRatedFilm(gone,{receiptKey:'tmdb_610',receipt:receipt(610),expectedRevision:0,at:T,requestId:'req-gone'}));
 assert.equal(one(file,"SELECT COUNT(*) FROM film_rated_admission WHERE tmdb='610'"),0,'no admission without the reservation');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:tmdb:610'"),0);
 const live={...envOf(file),effectGuard:guardOf('c-live-0001')};
 const ok=await FA.admitRatedFilm(live,{receiptKey:'tmdb_610',receipt:receipt(610),expectedRevision:0,at:T,requestId:'req-live'});
 assert.equal(ok.admitted,true,'the live reservation, cut by the part boundary, admits');
 // the reservation replaced (another holder) or removed: refused
 assert.equal(sqlite(file,"DELETE FROM ratings_document WHERE key='"+DIARY_KEY+"';\n"+insert(splitRows('c-other-0003',7,T0))).status,0);
 await assert.rejects(()=>FA.admitRatedFilm(live,{receiptKey:'tmdb_611',receipt:receipt(611),expectedRevision:0,at:T,requestId:'req-replaced'}));
 assert.equal(one(file,"SELECT COUNT(*) FROM film_rated_admission WHERE tmdb='611'"),0,'a replaced reservation admits nothing');
 assert.equal(sqlite(file,"DELETE FROM ratings_document WHERE key='"+DIARY_KEY+"'").status,0);
 await assert.rejects(()=>FA.admitRatedFilm(live,{receiptKey:'tmdb_611',receipt:receipt(611),expectedRevision:0,at:T,requestId:'req-removed'}));
}

console.log('canonical-rated-admission-producer: ok');
void applyFilmAdmission;void ratedAdmissionRegistry;void UNIT_CAP;void resolveExistingRetentionFilm;void RATED_ADMISSION_ORIGIN;void FILM_ADMISSION_OPERATION;void FILM_RETENTION_OPERATION;void ratedAdmissionRecord;void departedWatchlistLids;void watchlistRetentionWork;void assertRatedAdmissionAccepted;void ratedAdmissionSliceSettled;
