// AIR-369 / ADR 0099 (C3a), ADR 0086/0087: D1-owned canonical Film admission for verified rated-archive Films and the watchlist retention fact.
// Migration 0015 (a file only), the pure receipt check, the fenced writers, the compare-only report and the merge handling, on the sqlite3-CLI
// D1 stand-in. No Worker, R2, TMDB, ZIP or production access. To repeat in AIR-371 (producers), AIR-372 (read model), AIR-373 (baseline/parity), AIR-374.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {mutateFilm,mergeFilms} from '../src/canonical-mutations.js';
import {RATED_RECEIPT_KEY,verifiedAdmission,resolveAdmissionFilm,admitRatedFilm,retainFilm,loadAdmissionRows,readAdmissions,compareAdmissions} from '../src/film-admission.js';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-admission-'));
const NEW='0015_film_admission';
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>name.replace(/\.sql$/,''));
assert.ok(names.includes(NEW),'0015 exists');
const chain=names.filter(name=>name<NEW);
let n=0;
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const sql=name=>fs.readFileSync('migrations/'+name+'.sql','utf8');
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern);};
function database({upTo=chain.length,apply=true,open=false}={}){
 const file=path.join(root,'fa-'+(n++)+'.sqlite');
 const r=sqlite(file,chain.slice(0,upTo).map(sql).join('\n'));assert.equal(r.status,0,r.stderr);
 if(apply){const r2=sqlite(file,sql(NEW));assert.equal(r2.status,0,r2.stderr);}
 if(open)assert.equal(sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 return file;
}
const AT='2026-11-07T10:00:00.000Z';
const SHA='a'.repeat(64),SHA2='b'.repeat(64);
const receipt=(tmdb,over={})=>({tmdb:String(tmdb),sourceCode:'sc'+tmdb,archiveSha256:SHA,title:'Film '+tmdb,year:2001,filmPath:'/film/x/',verifiedAt:'2026-11-01T09:00:00.000Z',...over});
const state=file=>({DB:d1Standin(file)});
const code=expected=>error=>error.code===expected;
const admit=(env,tmdb,over={})=>admitRatedFilm(env,{receiptKey:'tmdb_'+tmdb,receipt:receipt(tmdb),expectedRevision:0,at:AT,requestId:'req-'+tmdb,...over});
async function seedFilm(env,id,externalIds=[]){return mutateFilm(env,{id,expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'Original',externalIds}});}

// 1. The migration: it refuses anything but a complete v14, creates nothing then, and creates two empty tables with real constraints.
{
 for(const upTo of [13,12,9]){
  const file=database({upTo,apply:false});
  const before=one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type='table'");
  refused(file,sql(NEW));
  assert.equal(one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type='table'"),before,'a refused file creates nothing (v'+(upTo<chain.length?'<14':'14')+')');
 }
 const file=database();
 assert.equal(one(file,'SELECT version FROM schema_contract'),15);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_rated_admission')+one(file,'SELECT COUNT(*) FROM film_retention'),0,'no row is written');
 assert.deepEqual(rows(file,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'r2',cutover:'open',generation:0}],'the marker is not moved');
 refused(database(),sql(NEW));
 refused(file,'UPDATE schema_contract SET version=14',/schema_contract_downgrade/);
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:x',1,'t'),('film:y',1,'t')");
 const adm=(film,tmdb,code,sha,key,verified)=>`INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('${film}','${tmdb}','${code}','${sha}',NULL,NULL,'${RATED_RECEIPT_KEY}','${key}','${verified}','r','t')`;
 const good='2026-11-01T09:00:00.000Z';
 assert.equal(sqlite(file,adm('film:x','5','sc5',SHA,'tmdb_5',good)).status,0);
 refused(file,adm('film:y','5','other',SHA,'tmdb_5',good),/UNIQUE/);
 refused(file,adm('film:y','6','sc5',SHA,'tmdb_6',good),/UNIQUE/);
 refused(file,adm('film:x','7','sc7',SHA,'tmdb_7',good),/UNIQUE|PRIMARY/);
 for(const bad of [adm('film:y','0','s',SHA,'tmdb_0',good),adm('film:y','5x','s',SHA,'tmdb_5x',good),adm('film:y','8','s','xyz','tmdb_8',good),adm('film:y','8','s',SHA,'tmdb_9',good),adm('film:y','8','s',SHA,'tmdb_8','2026-11-01T11:00:00+02:00'),adm('film:y','8','',SHA,'tmdb_8',good),adm('film:none','8','s',SHA,'tmdb_8',good)])refused(file,bad);
 const ret=(film,flag,basis,evidence,at)=>`INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('${film}','${basis}',${flag},'${evidence}','r','${at}','t')`;
 assert.equal(sqlite(file,ret('film:y',0,'watchlist_fact','{}',good)).status,0);
 for(const bad of [ret('film:x',2,'watchlist_fact','{}',good),ret('film:x',1,'other','{}',good),ret('film:x',1,'watchlist_fact','{bad',good),ret('film:x',1,'watchlist_fact','{}','2026-11-01T11:00:00+02:00'),ret('film:none',1,'watchlist_fact','{}',good)])refused(file,bad);
}

// 2. The pure receipt check: only an entry with every verification fact is a Film; a candidate is never admitted.
{
 const ok=verifiedAdmission('tmdb_603',receipt(603,{verifiedAt:'2026-11-01T11:00:00+02:00'}));
 assert.deepEqual([ok.ok,ok.admission.tmdb,ok.admission.verifiedAt,ok.admission.receiptFilmKey],[true,'603','2026-11-01T09:00:00.000Z','tmdb_603'],'the verification time is normalized UTC');
 const bad=(key,item)=>verifiedAdmission(key,item).reason;
 assert.equal(bad('abc123',receipt(1)),'invalid_key','a short code is not a key');
 assert.equal(bad('tmdb_tv_5',receipt(5)),'invalid_key','tmdb_tv is another scheme');
 assert.equal(bad('tmdb_0',receipt(0)),'invalid_key');
 assert.equal(bad('tmdb_5',null),'not_verified');
 assert.equal(bad('tmdb_5',{status:'pending',tmdb:'5',code:'x'}),'not_verified','a queue candidate');
 assert.equal(bad('tmdb_5',{...receipt(5),status:'admitting',verifiedAt:undefined}),'not_verified','no verification time');
 assert.equal(bad('tmdb_5',receipt(5,{sourceCode:''})),'not_verified');
 assert.equal(bad('tmdb_5',receipt(5,{archiveSha256:'short'})),'not_verified');
 assert.equal(bad('tmdb_5',receipt(5,{verifiedAt:'yesterday'})),'not_verified');
 assert.equal(bad('tmdb_5',{...receipt(5),watchlist:true}),'watchlist_field');
 assert.equal(bad('tmdb_5',receipt(6)),'tmdb_mismatch');
}

// 3. Compare-only: R2 inputs against D1 rows; nothing is written and an unverified entry is never expected in D1.
{
 const body={schemaVersion:1,films:{tmdb_1:receipt(1),tmdb_2:receipt(2),tmdb_3:receipt(3,{verifiedAt:undefined}),abc:receipt(4)}};
 const rowsIn={admissions:[{filmId:'film:tmdb:1',tmdb:'1',sourceCode:'sc1',archiveSha256:SHA},{filmId:'film:tmdb:2',tmdb:'2',sourceCode:'changed',archiveSha256:SHA},{filmId:'film:tmdb:9',tmdb:'9',sourceCode:'sc9',archiveSha256:SHA}],retained:[{filmId:'film:a',letterboxdIds:['lidA']},{filmId:'film:z',letterboxdIds:['lidZ']}]};
 const report=compareAdmissions({receipts:body,viewIndex:{lidA:{watchlist:false},lidB:{watchlist:true},tmdb_7:{watchlist:true},lidC:{prediction:'x'}},rows:rowsIn});
 assert.deepEqual([report.admissions.expected,report.admissions.stored,report.admissions.mismatch,report.admissions.extra,report.admissions.missing],[2,3,['2'],['9'],[]]);
 assert.deepEqual(report.admissions.unverified.map(item=>[item.key,item.reason]),[['tmdb_3','not_verified'],['abc','invalid_key']]);
 assert.deepEqual([report.retention.expected,report.retention.missing,report.retention.extra],[2,['lidB'],['lidZ']],'a tmdb_<n> alias or a non-boolean entry is not a retention fact');
 assert.equal(report.agree,false);
 const agree=compareAdmissions({receipts:{schemaVersion:1,films:{tmdb_1:receipt(1)}},viewIndex:{lidA:{watchlist:true}},rows:{admissions:[{filmId:'film:tmdb:1',tmdb:'1',sourceCode:'sc1',archiveSha256:SHA}],retained:[{filmId:'film:a',letterboxdIds:['lidA']}]}});
 assert.equal(agree.agree,true);
 assert.equal(compareAdmissions({}).agree,true,'a missing document and index expect nothing');
 const many=compareAdmissions({receipts:{schemaVersion:1,films:Object.fromEntries(Array.from({length:300},(_,i)=>['tmdb_'+(i+1),receipt(i+1)]))}});
 assert.deepEqual([many.admissions.expected,many.admissions.missing.length],[300,200],'the report lists are bounded');
}

// 4. The writers refuse before the database unless the marker is open: the projector stays the only writer in r2 and prepared (and legacy, held).
{
 const input=[{receiptKey:'tmdb_1',receipt:receipt(1),expectedRevision:0,at:AT,requestId:'q'}];
 const retain={id:'film:tmdb:1',expectedRevision:1,at:AT,requestId:'q',watchlist:false,observedAt:AT};
 const legacy=database({apply:false,upTo:12});
 await assert.rejects(()=>admitRatedFilm(state(legacy),...input),code('film_person_not_open'));
 const r2=database();
 await assert.rejects(()=>admitRatedFilm(state(r2),...input),code('film_person_not_open'),'r2');
 await assert.rejects(()=>retainFilm(state(r2),retain),code('film_person_not_open'),'r2 retention');
 sqlite(r2,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1");
 await assert.rejects(()=>admitRatedFilm(state(r2),...input),code('film_person_not_open'),'prepared');
 assert.equal(one(r2,'SELECT COUNT(*) FROM film')+one(r2,'SELECT COUNT(*) FROM film_rated_admission'),0);
 const held=database({open:true});
 sqlite(held,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 await assert.rejects(()=>admitRatedFilm(state(held),...input),code('film_person_held'),'held');
 await assert.rejects(()=>retainFilm(state(held),retain),code('film_person_held'),'held retention');
 await assert.rejects(()=>readAdmissions(state(held),['film:tmdb:1']),code('film_person_held'),'held readers fail closed');
 await assert.rejects(()=>readAdmissions(state(r2),['film:tmdb:1']),code('admission_not_authoritative'),'prepared is not a D1 read authority');
 const v14=database({apply:false,open:true});
 await assert.rejects(()=>admitRatedFilm(state(v14),...input),code('admission_unavailable'),'schema 14 has no admission table');
 await assert.rejects(()=>retainFilm(state(v14),retain),code('retention_unavailable'));
}

// 5. admitRatedFilm when open: a verified entry becomes one Film; nothing unverified does; typed ids, collisions, replay, CAS, races.
{
 const file=database({open:true});
 const env=state(file);
 const before=env.DB.calls.batches;
 for(const [key,item] of [['abc123',receipt(1)],['tmdb_1',{status:'pending'}],['tmdb_1',{...receipt(1),verifiedAt:undefined}],['tmdb_1',{...receipt(1),watchlist:false}]])
  await assert.rejects(()=>admitRatedFilm(env,{receiptKey:key,receipt:item,expectedRevision:0,at:AT,requestId:'x'}),error=>error.code==='admission_not_verified'&&typeof error.reason==='string');
 assert.equal(env.DB.calls.batches,before,'a candidate opens no batch');
 assert.equal(one(file,'SELECT COUNT(*) FROM film'),0,'no unverified candidate becomes a Film');
 // A verified rated-only entry becomes film:tmdb:<n> with its typed id, the short code as a historical alias, the receipt facts and no more.
 assert.deepEqual(await resolveAdmissionFilm(env,'603'),{id:'film:tmdb:603',exists:false,revision:0,redirected:false,owner:null,held:null,claims:0});
 const first=await admit(env,603);
 assert.deepEqual([first.id,first.revision,first.admitted],['film:tmdb:603',1,true]);
 assert.deepEqual(rows(file,"SELECT canonical_identity,original_title FROM film WHERE id='film:tmdb:603'"),[{canonical_identity:'tmdb:603',original_title:'Film 603'}]);
 assert.deepEqual(rows(file,"SELECT scheme,value,trusted,conflicting FROM film_external_id WHERE film_id='film:tmdb:603'"),[{scheme:'tmdb',value:'603',trusted:1,conflicting:0}]);
 assert.deepEqual(rows(file,"SELECT kind,value FROM film_alias WHERE film_id='film:tmdb:603'"),[{kind:'letterboxd_short_code',value:'sc603'}],'the short code is an alias, never a lid');
 assert.deepEqual(rows(file,"SELECT tmdb,source_code,archive_sha256,receipt_key,receipt_film_key,verified_at FROM film_rated_admission WHERE film_id='film:tmdb:603'"),[{tmdb:'603',source_code:'sc603',archive_sha256:SHA,receipt_key:RATED_RECEIPT_KEY,receipt_film_key:'tmdb_603',verified_at:'2026-11-01T09:00:00.000Z'}]);
 assert.equal(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:tmdb:603'"),1);
 for(const table of ['film_metadata','film_person_credit','film_dimension','watchlist_film','film_localization_source'])assert.equal(one(file,'SELECT COUNT(*) FROM '+table),0,table+' is untouched (no metadata, credit, localization, membership or rating)');
 // A replay (same entry) opens no batch, even with a stale expected revision.
 const batches=env.DB.calls.batches;
 const replay=await admit(env,603,{expectedRevision:0,requestId:'again'});
 assert.deepEqual([replay.replay,replay.admitted,replay.revision],[true,false,1]);
 assert.equal(env.DB.calls.batches,batches,'a replay writes nothing');
 // The same verified Film with a later archive digest refreshes the receipt facts and moves the revision; the verification time stays the first one.
 const again=await admit(env,603,{expectedRevision:1,requestId:'r2',receipt:receipt(603,{archiveSha256:SHA2,verifiedAt:'2026-11-05T09:00:00.000Z'})});
 assert.deepEqual([again.revision,again.admitted],[2,true]);
 assert.deepEqual(rows(file,"SELECT archive_sha256,verified_at,request_id FROM film_rated_admission WHERE film_id='film:tmdb:603'"),[{archive_sha256:SHA2,verified_at:'2026-11-01T09:00:00.000Z',request_id:'r2'}]);
 // A different movie id for the same short code, or the same short code for another Film, is a historical alias conflict.
 await assert.rejects(()=>admit(env,604,{receipt:receipt(604,{sourceCode:'sc603'}),requestId:'c1'}),code('admission_conflict'),'one short code verified for two movie ids');
 await assert.rejects(()=>admit(env,603,{expectedRevision:2,receipt:receipt(603,{sourceCode:'other'}),requestId:'c2'}),code('admission_conflict'),'one movie id with two short codes');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_rated_admission'),1);
 // tmdb_tv with the same number is another scheme: it neither collides nor receives the admission.
 await seedFilm(env,'film:tv:55',[{scheme:'tmdb_tv',value:'55',trusted:true}]);
 const tv=await admit(env,55);
 assert.equal(tv.id,'film:tmdb:55','a tmdb_tv holder is not the owner of the movie id');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_rated_admission WHERE film_id='film:tv:55'"),0);
 // A Letterboxd Film that already holds the trusted movie id stays ONE Film: the admission goes onto it, no duplicate identity.
 await seedFilm(env,'film:lb-7',[{scheme:'letterboxd',value:'lid7',trusted:true},{scheme:'tmdb',value:'77',trusted:true}]);
 const target=await resolveAdmissionFilm(env,'77');
 assert.deepEqual([target.id,target.exists,target.revision,target.held],['film:lb-7',true,1,null]);
 const joined=await admit(env,77,{expectedRevision:1,filmId:'film:lb-7'});
 assert.deepEqual([joined.id,joined.revision],['film:lb-7',2]);
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE canonical_identity='tmdb:77' OR id='film:tmdb:77'"),1,'one Film');
 assert.equal(one(file,"SELECT original_title FROM film WHERE id='film:lb-7'"),'Original','an existing title is not overwritten');
 await assert.rejects(()=>admit(env,77,{expectedRevision:2,filmId:'film:tmdb:77',requestId:'x'}),code('admission_target_changed'));
 // An owner value of the Film survives the admission (it writes no localization or dimension).
 sqlite(file,"INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('film:lb-7','localization','reviewed','owner','{}','Владелец','owner',0,'2026-11-07T00:00:00.000Z')");
 await admit(env,77,{expectedRevision:2,requestId:'r3',receipt:receipt(77,{archiveSha256:SHA2})});
 assert.equal(one(file,"SELECT value FROM film_dimension WHERE film_id='film:lb-7'"),'Владелец');
 // A lost revision is a retryable conflict and writes nothing; a redirected id is refused.
 await assert.rejects(()=>admit(env,603,{expectedRevision:1,requestId:'late',receipt:receipt(603,{archiveSha256:'c'.repeat(64)})}),code('film_person_revision_conflict'));
 assert.equal(one(file,"SELECT archive_sha256 FROM film_rated_admission WHERE film_id='film:tmdb:603'"),SHA2);
 await seedFilm(env,'film:tmdb:900',[{scheme:'tmdb',value:'900',trusted:true}]);
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:901',1,'t');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:901','film:tmdb:900','t')");
 await assert.rejects(()=>admit(env,901,{requestId:'red'}),error=>true,'a redirect target is never admitted');
 // The marker moving to held between the read and the batch fails the fence and writes nothing.
 const racing={DB:d1Standin(file,{onBatch:async()=>{sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}})};
 await assert.rejects(()=>admit(racing,800),code('film_person_fence'));
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:tmdb:800'"),0);
 sqlite(file,"UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1");
 // Another Film claims the movie id after the read: the in-batch assertion refuses (no duplicate or phantom identity).
 const claim={DB:d1Standin(file,{onBatch:async()=>{sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:other',1,'t');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:other','tmdb','810',1,0)");}})};
 await assert.rejects(()=>admit(claim,810),code('film_person_precondition'));
 assert.equal(one(file,"SELECT COUNT(*) FROM film_rated_admission WHERE tmdb='810'"),0);
 // Another Film verifies the same short code after the read: the unique index refuses.
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:holder',1,'t')");
 const dup={DB:d1Standin(file,{onBatch:async()=>{sqlite(file,`INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:holder','820','sc830','${SHA}','${RATED_RECEIPT_KEY}','tmdb_820','2026-11-01T09:00:00.000Z','r','t')`);}})};
 await assert.rejects(()=>admit(dup,830),code('admission_conflict'));
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:tmdb:830'"),0,'nothing partial');
}

// 5b. Existing identity evidence is never promoted or bypassed: an untrusted or conflicting claim on the typed movie id holds the admission, in the
// preflight and again inside the batch. A refusal changes no Film, admission, external id, trust flag, provenance or revision.
{
 const file=database({open:true});
 const env=state(file);
 const snapshot=()=>JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),rows(file,'SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id ORDER BY film_id,scheme,value'),rows(file,'SELECT * FROM film_rated_admission'),rows(file,'SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id'),rows(file,'SELECT film_id,kind,value FROM film_alias ORDER BY film_id,kind,value')]);
 const held=async(tmdb,over={},label='')=>{
  const before=snapshot();
  await assert.rejects(()=>admit(env,tmdb,over),error=>error.code==='admission_identity_held'&&error.reason==='untrusted_or_conflicting_claim',label+' is held');
  assert.equal(snapshot(),before,label+': a refusal changes nothing');
 };
 // (1) Another Film holds the typed id untrusted, or conflicting: the new film:tmdb:<n> is not admitted beside it.
 await seedFilm(env,'film:claim-untrusted',[{scheme:'tmdb',value:'100',trusted:false}]);
 await held(100,{},'untrusted claim on another Film');
 await seedFilm(env,'film:claim-conflicting',[{scheme:'tmdb',value:'101',trusted:false,conflicting:true}]);
 await held(101,{},'conflicting claim on another Film');
 assert.deepEqual(await resolveAdmissionFilm(env,'101'),{id:'film:tmdb:101',exists:false,revision:0,redirected:false,owner:null,held:'untrusted_or_conflicting_claim',claims:1});
 // (2) The target Film itself holds the id untrusted/conflicting: the row is not upgraded and its provenance is kept.
 await seedFilm(env,'film:tmdb:300',[{scheme:'tmdb',value:'300',trusted:false,conflicting:true,provenance:{note:'disputed'}}]);
 await held(300,{},'a conflicting row on the same Film');
 assert.deepEqual(rows(file,"SELECT trusted,conflicting FROM film_external_id WHERE film_id='film:tmdb:300'"),[{trusted:0,conflicting:1}],'never promoted');
 await seedFilm(env,'film:tmdb:301',[{scheme:'tmdb',value:'301',trusted:false}]);
 await held(301,{expectedRevision:1},'an untrusted row on the same Film');
 // (3) A trusted owner with another Film's untrusted claim on the same id is ambiguous too.
 await seedFilm(env,'film:owner-400',[{scheme:'tmdb',value:'400',trusted:true}]);
 await seedFilm(env,'film:rival-400',[{scheme:'tmdb',value:'400',trusted:false,conflicting:true}]);
 await held(400,{expectedRevision:1},'a trusted owner with a rival claim');
 // (4) tmdb_tv stays distinct: a claim of the other scheme never holds the id, and an untrusted tmdb_tv row is untouched.
 await seedFilm(env,'film:tv-500',[{scheme:'tmdb_tv',value:'500',trusted:false,conflicting:true}]);
 const tvBefore=rows(file,"SELECT trusted,conflicting FROM film_external_id WHERE scheme='tmdb_tv'");
 assert.equal((await admit(env,500)).id,'film:tmdb:500');
 assert.deepEqual(rows(file,"SELECT trusted,conflicting FROM film_external_id WHERE scheme='tmdb_tv'"),tvBefore);
 // (5) A trusted own row keeps its provenance when the admission is refreshed (the row is not rewritten).
 await seedFilm(env,'film:own-600',[{scheme:'tmdb',value:'600',trusted:true,provenance:{keep:'me'}}]);
 await admit(env,600,{expectedRevision:1});
 await admit(env,600,{expectedRevision:2,requestId:'r600b',receipt:receipt(600,{archiveSha256:SHA2})});
 assert.deepEqual(rows(file,"SELECT trusted,provenance_json FROM film_external_id WHERE film_id='film:own-600'"),[{trusted:1,provenance_json:'{"keep":"me"}'}]);
 // (6) Races between the read and the batch: a claim appearing, the owner row changing or vanishing. The in-batch assertions refuse and nothing is written.
 const race=async(tmdb,mutate,over={},label='')=>{
  const before=snapshot();
  const racing={DB:d1Standin(file,{onBatch:async()=>{sqlite(file,mutate);}})};
  await assert.rejects(()=>admit(racing,tmdb,over),code('film_person_precondition'),label);
  const after=JSON.parse(snapshot()),was=JSON.parse(before);
  assert.deepEqual(after[2],was[2],label+': no admission written');
  assert.deepEqual(after[3],was[3],label+': no revision moved');
 };
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:racer',1,'t')");
 await race(700,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:racer','tmdb','700',0,1)",{},'an untrusted claim appears for a new Film');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:tmdb:700'"),0,'no Film was created');
 await seedFilm(env,'film:own-710',[{scheme:'tmdb',value:'710',trusted:true}]);
 await race(710,"UPDATE film_external_id SET conflicting=1 WHERE film_id='film:own-710' AND scheme='tmdb'",{expectedRevision:1},'the owner row turns conflicting');
 assert.deepEqual(rows(file,"SELECT trusted,conflicting FROM film_external_id WHERE film_id='film:own-710'"),[{trusted:1,conflicting:1}],'the race left the disputed row as it found it');
 await seedFilm(env,'film:own-720',[{scheme:'tmdb',value:'720',trusted:true}]);
 await race(720,"DELETE FROM film_external_id WHERE film_id='film:own-720' AND scheme='tmdb'",{expectedRevision:1},'the owner row vanishes');
 await seedFilm(env,'film:own-730',[{scheme:'tmdb',value:'730',trusted:true}]);
 await race(730,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:rival-730',1,'t');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:rival-730','tmdb','730',0,0)",{expectedRevision:1},'a rival untrusted claim appears beside the owner');
}

// 6. retainFilm: a Film that left the watchlist persists; membership is not touched; the fact is monotonic and replay-safe; no R2.
{
 const file=database({open:true});
 const env={DB:d1Standin(file),R2:new Proxy({},{get(){throw new Error('R2 must not be touched');}}),BUCKET:new Proxy({},{get(){throw new Error('R2 must not be touched');}})};
 await seedFilm(env,'film:lid-1',[{scheme:'letterboxd',value:'lid1',trusted:true}]);
 sqlite(file,"INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:lid-1','t')");
 const retain=(over={})=>retainFilm(env,{id:'film:lid-1',expectedRevision:1,at:AT,requestId:'k1',watchlist:true,observedAt:'2026-11-07T09:00:00Z',evidence:{lid:'lid1'},...over});
 await assert.rejects(()=>retainFilm(env,{id:'film:nope',expectedRevision:0,at:AT,requestId:'k',watchlist:true,observedAt:AT}),code('retention_unknown_film'),'retention never creates a Film');
 for(const bad of [{watchlist:'yes'},{observedAt:'yesterday'},{evidence:[1]},{id:'tmdb:1'},{requestId:''},{expectedRevision:-1}])await assert.rejects(()=>retain(bad),error=>/^(retention_invalid|film_person_invalid)$/.test(error.code));
 const first=await retain();
 assert.deepEqual([first.written,first.revision],[true,2]);
 assert.deepEqual(rows(file,"SELECT basis,watchlist,observed_at FROM film_retention WHERE film_id='film:lid-1'"),[{basis:'watchlist_fact',watchlist:1,observed_at:'2026-11-07T09:00:00.000Z'}]);
 // The Film leaves the watchlist: membership goes, the retention fact and the Film stay, and a later observation records the departure.
 sqlite(file,"DELETE FROM watchlist_film WHERE film_id='film:lid-1'");
 const left=await retain({expectedRevision:2,requestId:'k2',watchlist:false,observedAt:'2026-11-08T09:00:00Z'});
 assert.deepEqual([left.written,left.revision],[true,3]);
 assert.deepEqual(rows(file,"SELECT watchlist FROM film_retention WHERE film_id='film:lid-1'"),[{watchlist:0}]);
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:lid-1'"),1,'the departed Film persists');
 assert.equal(one(file,"SELECT COUNT(*) FROM watchlist_film"),0,'membership is not written here');
 // Replay, mismatch, stale and equal observations.
 const batches=env.DB.calls.batches;
 assert.deepEqual([(await retain({expectedRevision:2,requestId:'k2',watchlist:false,observedAt:'2026-11-08T09:00:00Z'})).reason],['replay']);
 assert.equal(env.DB.calls.batches,batches,'a replay opens no batch');
 await assert.rejects(()=>retain({expectedRevision:3,requestId:'k2',watchlist:true,observedAt:'2026-11-08T09:00:00Z'}),code('retention_replay_mismatch'));
 assert.equal((await retain({expectedRevision:3,requestId:'k3',watchlist:true,observedAt:'2026-11-08T11:00:00+02:00'})).reason,'stale','09:00 UTC equals the stored instant, not newer');
 assert.equal((await retain({expectedRevision:3,requestId:'k4',watchlist:true,observedAt:'2026-11-07T00:00:00Z'})).reason,'stale');
 assert.deepEqual(rows(file,"SELECT watchlist FROM film_retention"),[{watchlist:0}]);
 // A lost revision is a retryable conflict; a concurrent newer observation between the read and the batch is not overwritten.
 await assert.rejects(()=>retain({expectedRevision:1,requestId:'k5',observedAt:'2026-11-09T00:00:00Z'}),code('film_person_revision_conflict'));
 const racing={DB:d1Standin(file,{onBatch:async()=>{sqlite(file,"UPDATE film_retention SET watchlist=1,observed_at='2026-12-01T00:00:00.000Z' WHERE film_id='film:lid-1'");}})};
 await retainFilm(racing,{id:'film:lid-1',expectedRevision:3,at:AT,requestId:'k6',watchlist:false,observedAt:'2026-11-20T00:00:00Z'});
 assert.deepEqual(rows(file,"SELECT watchlist,observed_at FROM film_retention"),[{watchlist:1,observed_at:'2026-12-01T00:00:00.000Z'}],'the SQL guard holds on its own');
 // A redirected Film takes no retention.
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:old',1,'t');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:old','film:lid-1','t')");
 await assert.rejects(()=>retainFilm(env,{id:'film:old',expectedRevision:0,at:AT,requestId:'z',watchlist:true,observedAt:AT}),code('film_person_redirect'));
}

// 7. A merge keeps the data: a retired admission moves, an identical one is dropped, a different one refuses; the later retention fact wins.
{

 const adm=(film)=>`INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('${film}','51','sc51','${SHA}','${RATED_RECEIPT_KEY}','tmdb_51','2026-11-01T09:00:00.000Z','r','t')`;
 const setup=async()=>{const file=database({open:true});const env=state(file);await seedFilm(env,'film:a',[{scheme:'letterboxd',value:'a',trusted:true}]);await seedFilm(env,'film:b',[{scheme:'letterboxd',value:'a',trusted:true}].slice(0,0));return {file,env};};
 // moves
 let {file,env}=await setup();
 sqlite(file,`INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:a','50','sc50','${SHA}','${RATED_RECEIPT_KEY}','tmdb_50','2026-11-01T09:00:00.000Z','r','t');INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:a','watchlist_fact',0,'{}','r','2026-11-05T00:00:00.000Z','t')`);
 await mergeFilms(env,{from:'film:a',to:'film:b',expected:{from:1,to:1},at:AT});
 assert.deepEqual(rows(file,"SELECT film_id,tmdb FROM film_rated_admission"),[{film_id:'film:b',tmdb:'50'}],'the admission moved to the survivor');
 assert.deepEqual(rows(file,"SELECT film_id,watchlist FROM film_retention"),[{film_id:'film:b',watchlist:0}],'the retention fact moved');
 // the later retention fact wins (two Films can never hold the same movie id or short code, so two admissions always differ)
 ({file,env}=await setup());
 sqlite(file,"INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:a','watchlist_fact',0,'{}','r','2026-11-09T00:00:00.000Z','t'),('film:b','watchlist_fact',1,'{}','r','2026-11-05T00:00:00.000Z','t')");
 await mergeFilms(env,{from:'film:a',to:'film:b',expected:{from:1,to:1},at:AT});
 assert.deepEqual(rows(file,'SELECT film_id,watchlist,observed_at FROM film_retention'),[{film_id:'film:b',watchlist:0,observed_at:'2026-11-09T00:00:00.000Z'}],'the later observation wins');
 ({file,env}=await setup());
 sqlite(file,"INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:a','watchlist_fact',0,'{}','r','2026-11-01T00:00:00.000Z','t'),('film:b','watchlist_fact',1,'{}','r','2026-11-05T00:00:00.000Z','t')");
 await mergeFilms(env,{from:'film:a',to:'film:b',expected:{from:1,to:1},at:AT});
 assert.deepEqual(rows(file,'SELECT watchlist,observed_at FROM film_retention'),[{watchlist:1,observed_at:'2026-11-05T00:00:00.000Z'}],'an older retired observation does not replace a newer survivor');
 // different admissions refuse the merge and write nothing
 ({file,env}=await setup());
 sqlite(file,adm('film:a'));
 sqlite(file,adm('film:b').replace("'51','sc51'","'52','sc52'").replace("'tmdb_51'","'tmdb_52'"));
 await assert.rejects(()=>mergeFilms(env,{from:'film:a',to:'film:b',expected:{from:1,to:1},at:AT}),code('film_person_data_conflict'));
 assert.equal(one(file,'SELECT COUNT(*) FROM film_redirect'),0);
 assert.equal(one(file,'SELECT COUNT(*) FROM film'),2);
 // before schema 15 a merge is the AIR-367 one
 const old=database({apply:false,open:true});const e=state(old);
 await seedFilm(e,'film:a');await seedFilm(e,'film:b');
 assert.equal((await mergeFilms(e,{from:'film:a',to:'film:b',expected:{from:1,to:1},at:AT})).merged,true);
}

// 8. Reads: D1 only while open, chunked by 80 ids with two queries per chunk, a typed key per row, no R2.
{
 const file=database({open:true});
 const env=state(file);
 await admit(env,603);
 await seedFilm(env,'film:lid-1',[{scheme:'letterboxd',value:'lid1',trusted:true}]);
 await retainFilm(env,{id:'film:lid-1',expectedRevision:1,at:AT,requestId:'k',watchlist:false,observedAt:AT});
 const read=await readAdmissions(env,['film:tmdb:603','film:lid-1','film:none']);
 assert.deepEqual(read.get('film:tmdb:603').ratedAdmission,{tmdb:'603',sourceCode:'sc603',archiveSha256:SHA,title:'Film 603',year:2001,receiptKey:RATED_RECEIPT_KEY,receiptFilmKey:'tmdb_603',verifiedAt:'2026-11-01T09:00:00.000Z'});
 assert.deepEqual(read.get('film:lid-1').retention,{watchlist:false,observedAt:AT});
 assert.deepEqual(read.get('film:none'),{ratedAdmission:null,retention:null});
 const ids=Array.from({length:170},(_,i)=>'film:bulk:'+i);
 const spy=state(file);const before=spy.DB.calls.queries;
 assert.equal((await loadAdmissionRows(spy,ids)).size,170);
 assert.equal(spy.DB.calls.queries-before,6,'three chunks, two reads each');
}

// 9. Static: inactive. No source file imports the module, it is not bundled, the projector's writer is unchanged, the receipt key is the existing object.
{
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('film-admission'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers.filter(file=>!file.endsWith('film-admission.js')&&!file.endsWith('canonical-producers.js')),[],'no source file imports film-admission');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('film-admission'),file+' does not bundle or name it');
 assert.ok(fs.readFileSync('migrations/README.md','utf8').includes(NEW),'migrations/README.md lists 0015');
 for(const file of ['src/canonical-repository.js','src/d1-enrichment.js','src/letterboxd-rated-candidates.js','src/enrichment-projection.js'])assert.ok(!/film_rated_admission|film_retention/.test(fs.readFileSync(file,'utf8')),file+' does not touch the admission tables');
 assert.ok(fs.readFileSync('src/letterboxd-rated-candidates.js','utf8').includes(RATED_RECEIPT_KEY),'the receipt object is the existing verified-films.json');
}

console.log('film-admission: migration 0015 refuses below v14 and creates two empty constrained tables; only a fully verified receipt entry becomes a Film (no candidate, short code, tmdb_tv or watchlist field); the writers refuse unless the marker is open, are fenced, revision-checked, replay-safe and monotonic, keep typed ids and one Film per movie id; a departed watchlist Film persists without R2; merges move, drop or refuse admission rows; reads fail closed when held; the module is inactive');
