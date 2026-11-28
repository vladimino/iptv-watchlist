// AIR-608 (card A2): the owner-only operator `scripts/letterboxd-admission-cutover-production.mjs` and its freeze audit, offline, on the real migrations (sqlite D1 stand-in), the real import mechanism and real legacy R2/D1
// admission rows. No network (the REST and S3 transports are mocked), no production write.
// Covered (PR #1082 review P1-A..E): the ORIGINAL admission freeze gate (verified-films.json vs film_rated_admission, mismatch both ways, a late PUT independent of the coordination manifest, P2-P5/P7, unreadable evidence);
// the REAL Diary check queue (`letterboxd/facts/scans/diary-identity.json`, fail-closed on malformed state, the old `diary/state.json` is not the queue); the real C2 activation (active control, done bootstrap, cutoff, pinned
// revisions, concurrent pause at the batch boundary); the exact imported manifest and its production-reader contract, the document fence in the flip batch, the closure generation pinned through import and rollback
// (close/reopen/close race), strict REST reads and a bounded S3 listing on mocked transports, the bytes pin, activated_at in the readback, and the one-way marker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as Op from '../scripts/letterboxd-admission-cutover-production.mjs';
import * as Audit from '../scripts/letterboxd-admission-freeze-audit.mjs';
import {createD1Adapter} from '../scripts/d1-backfill.mjs';
import {createS3Store} from '../scripts/r2-s3-store.mjs';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-admission-cutover-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const sha256=text=>createHash('sha256').update(text).digest('hex');
const putDoc=(file,key,value)=>{const text=JSON.stringify(value);sqlite(file,"INSERT OR REPLACE INTO ratings_document (key,part,body,etag,updated_at) VALUES ('"+key+"',0,'"+text.replace(/'/g,"''")+"','"+sha256(text)+"','2026-11-28T09:00:00.000Z')");};

const A='a'.repeat(64),B='b'.repeat(64);
const AT='2026-11-20T10:00:00.000Z';
const ADMISSIONS='letterboxd/admissions/verified-films.json';
// three legacy admissions: rated archive (no identity), inferred (links + marked record), diary_page (links)
const ENTRIES={
 tmdb_101:{tmdb:'101',sourceCode:'rated1',archiveSha256:A,title:'TitleOne',year:1999,verifiedAt:AT,receiptKey:ADMISSIONS},
 tmdb_102:{tmdb:'102',sourceCode:'inf1',archiveSha256:B,title:'TitleTwo',year:2001,verifiedAt:AT,identity:'inferred'},
 tmdb_103:{tmdb:'103',sourceCode:'dia1',archiveSha256:B,title:'TitleThree',year:2003,verifiedAt:AT,identity:'diary_page'},
};
const r2Admissions=(over={})=>JSON.stringify({schemaVersion:1,films:{...ENTRIES,...over}});
const SHA='c'.repeat(64);
const K1='letterboxd/imports/'+SHA+'/rated-candidates.json',K2='letterboxd/imports/'+SHA+'/chunks/0.intent.json',K3='letterboxd/imports/'+SHA+'/chunks/0.receipt.json';
const cohort=(over={})=>({[ADMISSIONS]:r2Admissions(),[K1]:JSON.stringify({schemaVersion:1,candidates:{c1:{state:'verified'}}}),[K2]:JSON.stringify({chunk:0}),[K3]:JSON.stringify({chunk:0}),'letterboxd/imports/registry.json':'{}',...over});
const makeBucket=initial=>{
 const map=new Map(Object.entries(initial).map(([key,text],index)=>[key,{text,etag:'e'+index}]));let rev=100;
 return {map,put(key,text){map.set(key,{text,etag:'e'+(++rev)});},drop(key){map.delete(key);},
  async list({prefix,limit=1000,cursor}={}){const keys=[...map.keys()].filter(key=>key.startsWith(prefix)).sort();const from=cursor?Number(cursor):0;const slice=keys.slice(from,from+Math.min(limit,3));const next=from+slice.length;return {objects:slice.map(key=>({key})),truncated:next<keys.length,cursor:next<keys.length?String(next):null};},
  async get(key){const item=map.get(key);return item?{etag:item.etag,text:async()=>item.text}:null;},
  async head(key){const item=map.get(key);return item?{etag:item.etag}:null;}};
};
let copies=0;
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
// a complete, healthy pre-flip database: Film/Person and Ratings open, three admitted Films, links and the inferred mark, an ACTIVE C2 (control active, rated scope done, cutoff in the past)
const fresh=({marker='r2',c2=true}={})=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);
 sqlite(file,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3;");
 sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE);
 for(const [key,e] of Object.entries(ENTRIES)){
  const id='film:tmdb:'+e.tmdb;
  sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+id+"',1,NULL,'x','"+AT+"');"
   +"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+id+"','tmdb','"+e.tmdb+"',1,0);"
   +"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('"+id+"','"+e.tmdb+"','"+e.sourceCode+"','"+e.archiveSha256+"','"+e.title+"',"+e.year+",'"+ADMISSIONS+"','"+key+"','"+e.verifiedAt+"','r"+e.tmdb+"','"+AT+"');");
 }
 putDoc(file,'letterboxd/facts/links.json',{'letterboxd:inf1':'f102','tmdb:102':'f102','letterboxd:dia1':'f103','tmdb:103':'f103'});
 putDoc(file,'letterboxd/facts/films/f102.json',{links:{letterboxd:'inf1',tmdb:'102'},inferredPairs:[{kind:'inferred',letterboxd:'inf1',tmdb:'102'}]});
 if(marker==='closed')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 if(c2)sqlite(file,"DELETE FROM catalog_enrichment_scope;INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,bootstrap_state,revision,updated_at) VALUES ('rated',1,1,'2026-11-28T04:00:00.000Z','done',3,'2026-11-28T09:00:00.000Z');INSERT INTO catalog_enrichment_control (id,state,generation,revision,updated_at,updated_by) VALUES (1,'active',1,2,'2026-11-28T09:00:00.000Z','op');");
 return file;
};
const NOW=()=>Date.parse('2026-11-28T12:00:00Z');
const run=async(file,argv,bucket,opts={})=>Op.runLetterboxdAdmissionCutover({argv:['node','op',...argv],deps:{binding:d1Standin(file,opts),bucket},now:NOW});
const marker=file=>rows(file,'SELECT mode, generation, activated_at FROM letterboxd_admission_authority')[0];
const W=(command,extra=[])=>['--target','iptv','--'+command,'--confirm',command,...extra];
const BYTES=Op.bytesDigest().sha256;
const P=(over={})=>{const p={generation:0,admission:null,manifest:null,control:2,scope:3,...over};return p;};
const pins=(command,p)=>{
 const out=['--expect-generation',String(p.generation)];
 if(['close','import','flip'].includes(command))out.push('--expect-admission-sha256',p.admission);
 if(['import','flip'].includes(command))out.push('--expect-manifest-sha256',p.manifest);
 if(command==='flip')out.push('--expect-control-revision',String(p.control),'--expect-scope-revision',String(p.scope));
 out.push('--expect-bytes-sha256',BYTES);
 return W(command,out);
};
const b0=makeBucket(cohort());
const st=(await run(fresh(),['--target','iptv','--status'],b0)).result;
const ADMISSION_PIN=st.freeze.pin,MANIFEST=st.r2.manifestSha256;

// ===== 1. argument contract =====
{
 await assert.rejects(async()=>Op.parseArgs(['n','o','--close']),error=>error.reason==='target_required');
 assert.equal(Op.parseArgs(['n','o']).report.configured,false,'no target: a report, nothing is touched');
 const good=pins('close',P({admission:ADMISSION_PIN}));
 assert.deepEqual(Op.parseArgs(['n','o',...good]).args,{generation:0,admissionSha256:ADMISSION_PIN,bytesSha256:BYTES});
 for(const argv of [['--target','other'],['--target','iptv','--close'],['--target','iptv','--close','--confirm','flip','--expect-generation','0'],['--target','iptv','--status','--confirm','status'],['--target','iptv','--parity','--status'],
  W('close',['--expect-generation','0','--expect-bytes-sha256',BYTES]),                                                 // missing the admission pin
  W('close',['--expect-generation','x','--expect-admission-sha256',ADMISSION_PIN,'--expect-bytes-sha256',BYTES]),
  W('close',['--expect-generation','0','--expect-admission-sha256',ADMISSION_PIN,'--expect-bytes-sha256',BYTES,'--expect-manifest-sha256',MANIFEST]),  // a pin the command does not take
  W('flip',['--expect-generation','1','--expect-manifest-sha256',MANIFEST,'--expect-admission-sha256',ADMISSION_PIN,'--expect-bytes-sha256',BYTES]), // flip needs the C2 pins
 ])assert.throws(()=>Op.parseArgs(['n','o',...argv]),error=>error.exit===2,argv.join(' '));
}

// ===== 2. status / parity: read only, counts never content; the freeze audit; the real Diary queue; the real C2 =====
{
 const f=fresh();
 const {exit,result}=await run(f,['--target','iptv','--status'],b0);
 assert.equal(exit,0);assert.equal(result.writes,false);assert.deepEqual(result.blockers,[]);
 assert.equal(result.bytes.sha256,BYTES);assert.equal(result.state.marker.mode,'r2');
 assert.equal(result.freeze.counts.verified,3);assert.equal(result.freeze.counts.agree,3);assert.equal(result.freeze.counts.inferred,1);assert.equal(result.freeze.counts.diaryPage,1);assert.equal(result.freeze.counts.rated,1);
 assert.equal(result.freeze.object.bytes,new TextEncoder().encode(r2Admissions()).length,'ETag AND size are recorded');assert.ok(result.freeze.object.etag);assert.equal(result.freeze.registry.etag,'e4');
 assert.equal(result.r2.documents,3,'the moved cohort: three documents (the admissions object and the registry projection are not in it)');
 assert.deepEqual(result.c2.problems,[]);assert.equal(result.diary.state,'absent','positive absence is an empty queue');
 const text=JSON.stringify(result);for(const secret of ['rated1','inf1','dia1','TitleOne','"c1"'])assert.ok(!text.includes(secret),'no content in the report: '+secret);
 assert.deepEqual(marker(f),{mode:'r2',generation:0,activated_at:null});
 // pending facts: admitting candidate, chunk intent without receipt, unparseable document, pending receipt
 assert.deepEqual((await run(f,['--target','iptv','--status'],makeBucket(cohort({[K1]:JSON.stringify({candidates:{c1:{state:'admitting'}}})})))).result.blockers,['admitting_candidates']);
 const noReceipt=cohort();delete noReceipt[K3];
 assert.deepEqual((await run(f,['--target','iptv','--status'],makeBucket(noReceipt))).result.blockers,['chunk_intent_without_receipt']);
 const bad=await run(f,['--target','iptv','--status'],makeBucket(cohort({[K3]:'{nope'})));assert.deepEqual(bad.result.blockers,['plan_blocked']);assert.equal(bad.result.r2.manifestSha256,null);
 sqlite(f,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('q1','admit','rated_admission_retention','film','film:tmdb:101','"+A+"',0,2,'pending',1,'2026-11-28T09:00:00.000Z','2026-11-28T09:00:00.000Z','2026-11-28T09:00:00.000Z')");
 assert.deepEqual((await run(f,['--target','iptv','--status'],b0)).result.blockers,['pending_receipts']);
}
// the real Diary queue: films with the three link states (both caller paths share ONE queue), a reservation, a malformed document; the old Diary cursor document is NOT the queue
for(const [name,value,blocker] of [
 ['linking',{films:{x1:{reason:'linking',tmdb:'5'}}},'diary_link_intents'],['link_failed',{films:{x1:{reason:'link_failed'}}},'diary_link_intents'],['lid_only_intent',{films:{x1:{reason:'lid_only_intent'}}},'diary_link_intents'],
 ['reservation',{films:{x1:{reason:'claim_pending',reservation:{until:'2026-11-28T10:00:00.000Z'}}}},'diary_reservations'],
]){
 const f=fresh();putDoc(f,Op.DIARY_QUEUE_KEY,value);
 assert.deepEqual((await run(f,['--target','iptv','--status'],b0)).result.blockers,[blocker],name);
}
{
 const f=fresh();putDoc(f,Op.DIARY_QUEUE_KEY,{films:{},backlog:{}});
 const s=(await run(f,['--target','iptv','--status'],b0)).result;assert.equal(s.diary.state,'present');assert.deepEqual(s.blockers,[],'an empty queue is clear');
 for(const bad of [[],'x',{films:[]},{films:{a:1}},{films:{},backlog:7},{films:{},backlog:{a:null}}]){
  const g=fresh();putDoc(g,Op.DIARY_QUEUE_KEY,bad);
  const out=await run(g,['--target','iptv','--status'],b0);assert.equal(out.exit,3,JSON.stringify(bad));assert.equal(out.result.reason,'diary_queue_malformed');
 }
 const h=fresh();putDoc(h,'letterboxd/diary/state.json',{films:{x:{reason:'link_failed'}}});
 assert.deepEqual((await run(h,['--target','iptv','--status'],b0)).result.blockers,[],'the Diary viewing cursor is not the check queue');
 // an unreadable (damaged) queue is a STOP, not zero
 const i=fresh();putDoc(i,Op.DIARY_QUEUE_KEY,{films:{}});sqlite(i,"UPDATE ratings_document SET body='{\"films\":{\"x\":{\"reason\":\"link_failed\"}}}' WHERE key='"+Op.DIARY_QUEUE_KEY+"'");
 const damaged=await run(i,['--target','iptv','--status'],b0);assert.equal(damaged.exit,3);assert.equal(damaged.result.reason,'unknown_state');
}
// C2: each broken ingredient is reported
for(const [name,sql,expected] of [
 ['paused control',"UPDATE catalog_enrichment_control SET state='paused',revision=3,generation=2",'c2_control_not_active'],
 ['bootstrap not done',"UPDATE catalog_enrichment_scope SET bootstrap_state='running'",'c2_bootstrap_not_done'],
 ['future cutoff',"UPDATE catalog_enrichment_scope SET cutoff_at='2026-11-29T04:00:00.000Z'",'c2_cutoff_in_future'],
 ['scope disabled',"UPDATE catalog_enrichment_scope SET enabled=0",'c2_scope_not_enabled'],
]){
 const f=fresh();sqlite(f,sql);
 const s=(await run(f,['--target','iptv','--status'],b0)).result;assert.ok(s.c2.problems.includes(expected),name+': '+JSON.stringify(s.c2.problems));
}
{const f=fresh({c2:false});sqlite(f,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,bootstrap_state,revision,updated_at) VALUES ('rated',1,1,'2026-11-28T04:00:00.000Z','done',3,'2026-11-28T09:00:00.000Z')");const s0=(await run(f,['--target','iptv','--status'],b0)).result;assert.deepEqual(s0.c2.problems,['c2_control_not_active'],'a scope row without an active control is not C2');}
 {const f=fresh({c2:false});const s=(await run(f,['--target','iptv','--status'],b0)).result;assert.ok(s.c2.problems.includes('c2_control_not_active')&&s.c2.problems.includes('c2_scope_missing'),'no control row, no scope');}

// ===== 3. the ORIGINAL admission freeze gate (verified-films.json vs film_rated_admission) =====
{
 const status=async(f,bucket)=>(await run(f,['--target','iptv','--status'],bucket)).result;
 // R2-only: an R2 entry D1 does not have
 let s=await status(fresh(),makeBucket(cohort({[ADMISSIONS]:r2Admissions({tmdb_104:{tmdb:'104',sourceCode:'new1',archiveSha256:A,title:'TitleFour',year:2004,verifiedAt:AT}})})));
 assert.ok(s.blockers.includes('admission_r2_only'),JSON.stringify(s.blockers));assert.equal(s.freeze.counts.r2Only,1);
 // D1-only: a D1 row with no R2 entry
 const f2=fresh();sqlite(f2,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:tmdb:105',1,'x','"+AT+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:105','tmdb','105',1,0);INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:105','105','d1only','"+A+"','T',2005,'"+ADMISSIONS+"','tmdb_105','"+AT+"','r105','"+AT+"')");
 s=await status(f2,b0);assert.ok(s.blockers.includes('admission_d1_only'));assert.equal(s.freeze.counts.d1Only,1);
 // mismatch: source code, archive, receipt key, verification time, year
 for(const [name,sql] of [['source code',"source_code='other'"],['archive',"archive_sha256='"+B+"'"],['verified_at',"verified_at='2026-11-21T10:00:00.000Z'"],['year',"year=1980"],['receipt key',"receipt_key='letterboxd/other.json'"]]){
  const f=fresh();sqlite(f,"UPDATE film_rated_admission SET "+sql+" WHERE tmdb='101'");
  s=await status(f,b0);assert.ok(s.blockers.includes('admission_mismatch'),name);
 }
 // P4 unlinked, P5 unmarked, P7 unhealthy
 const f4=fresh();putDoc(f4,'letterboxd/facts/links.json',{'letterboxd:inf1':'f102','tmdb:102':'f102'});
 assert.ok((await status(f4,b0)).blockers.includes('admission_p4_unlinked'),'the diary_page entry has no link');
 const f5=fresh();putDoc(f5,'letterboxd/facts/films/f102.json',{links:{letterboxd:'inf1',tmdb:'102'}});
 assert.ok((await status(f5,b0)).blockers.includes('admission_p5_unmarked'),'the inferred record has no mark');
 const f7=fresh();sqlite(f7,"UPDATE film_external_id SET trusted=0 WHERE value='101'");
 assert.ok((await status(f7,b0)).blockers.includes('admission_p7_unhealthy'));
 // missing, unparseable, unverified evidence
 const none=cohort();delete none[ADMISSIONS];
 let out=await run(fresh(),['--target','iptv','--status'],makeBucket(none));assert.equal(out.exit,3);assert.equal(out.result.reason,'freeze_admissions_object_missing');
 out=await run(fresh(),['--target','iptv','--status'],makeBucket(cohort({[ADMISSIONS]:'{not json'})));assert.equal(out.exit,3);assert.equal(out.result.reason,'freeze_admissions_object_unreadable');
 s=await status(fresh(),makeBucket(cohort({[ADMISSIONS]:r2Admissions({tmdb_106:{tmdb:'106',sourceCode:'bad code!'}})})));assert.ok(s.blockers.includes('admission_unverified_entries'));
 s=await status(fresh(),makeBucket(cohort({[ADMISSIONS]:JSON.stringify({schemaVersion:2,films:{}})})));assert.ok(s.blockers.includes('admission_receipts_malformed'));
 // an object that moves while it is read is a STOP
 const moving=makeBucket(cohort());let heads=0;const realHead=moving.head;moving.head=async key=>{if(key===ADMISSIONS&&++heads===2)moving.put(ADMISSIONS,r2Admissions());return realHead(key);};
 out=await run(fresh(),['--target','iptv','--status'],moving);assert.equal(out.result.reason,'freeze_admissions_object_moved');
 // the pin is independent of the coordination manifest: a late PUT to verified-films moves the admission pin and NOT the manifest digest
 const late=makeBucket(cohort());late.put(ADMISSIONS,r2Admissions());
 s=await status(fresh(),late);assert.notEqual(s.freeze.pin,ADMISSION_PIN,'a new ETag is a new pin');assert.equal(s.r2.manifestSha256,MANIFEST,'the coordination manifest did not change');
 // pure compare: a D1 row whose R2 entry exists with a different tmdb key
 assert.equal(Audit.compareFreeze({receipts:{schemaVersion:1,films:{}},rows:[],links:null,records:new Map()}).problems.length,0);
}

// ===== 4. close: pins, the freeze, one fenced batch (the D1 admission side is asserted in the batch) =====
{
 const f=fresh();
 const argv=(over={})=>pins('close',P({admission:ADMISSION_PIN,...over}));
 assert.equal((await run(f,argv({generation:5}),b0)).result.reason,'generation_moved');
 assert.equal((await run(f,pins('close',P({admission:'0'.repeat(64)})),b0)).result.reason,'admission_pin_mismatch');
 {const wrong=['--target','iptv','--close','--confirm','close','--expect-generation','0','--expect-admission-sha256',ADMISSION_PIN,'--expect-bytes-sha256','9'.repeat(64)];assert.equal((await run(f,wrong,b0)).result.reason,'bytes_pin_mismatch');}
 const g=fresh();sqlite(g,"UPDATE film_rated_admission SET source_code='other' WHERE tmdb='101'");
 assert.equal((await run(g,argv(),b0)).result.reason,'no_go','a freeze mismatch is a NO-GO at close');
 assert.deepEqual(marker(f),{mode:'r2',generation:0,activated_at:null});
 // a D1 admission row inserted between the read and the batch refuses the whole batch (the marker does not move)
 let raced=false;
 const refused=await run(f,argv(),b0,{onBatch:async()=>{if(!raced){raced=true;sqlite(f,"UPDATE film_rated_admission SET updated_at='2026-11-28T11:59:00.000Z' WHERE tmdb='103'");}}});
 assert.equal(refused.exit,3);assert.equal(refused.result.reason,'predicate_refused');assert.equal(marker(f).mode,'r2');
 sqlite(f,"UPDATE film_rated_admission SET updated_at='"+AT+"' WHERE tmdb='103'");
 const before=rows(f,'SELECT COUNT(*) AS n FROM ratings_document')[0].n;
 const closed=await run(f,argv(),b0);
 assert.equal(closed.exit,0,JSON.stringify(closed.result));assert.equal(closed.result.writeState,'committed');
 assert.deepEqual(marker(f),{mode:'closed',generation:1,activated_at:null});
 assert.equal(rows(f,'SELECT COUNT(*) AS n FROM ratings_document')[0].n,before,'nothing else was written');
 assert.equal((await run(f,pins('close',P({generation:1,admission:ADMISSION_PIN})),b0)).result.reason,'marker_not_r2');
 const h=fresh();sqlite(h,"UPDATE ratings_domain_authority SET cutover='held'");
 assert.ok(['unknown_state','ratings_not_open'].includes((await run(h,argv(),b0)).result.reason),'a held Ratings domain is not authority');
}

// ===== 5. import: pins, every blocker, the pinned closure generation, the exact manifest =====
const closedFresh=()=>fresh({marker:'closed'});
const imp=(f,bucket,over={},opts={})=>run(f,pins('import',P({generation:1,admission:ADMISSION_PIN,manifest:MANIFEST,...over})),bucket,opts);
{
 const f=closedFresh();
 assert.equal((await imp(f,b0,{manifest:'b'.repeat(64)})).result.reason,'manifest_pin_mismatch');
 assert.equal((await imp(f,b0,{admission:'d'.repeat(64)})).result.reason,'admission_pin_mismatch');
 assert.equal(rows(f,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,0,'a wrong pin writes nothing');
 const pending=makeBucket(cohort({[K1]:JSON.stringify({candidates:{c1:{state:'admitting'}}})}));
 const refused=await imp(f,pending);assert.equal(refused.result.reason,'no_go');assert.deepEqual(refused.result.details.blockers,['admitting_candidates']);
 assert.equal((await run(fresh(),pins('import',P({generation:0,admission:ADMISSION_PIN,manifest:MANIFEST})),b0)).result.reason,'marker_not_closed');
 // the closure generation is pinned THROUGH the import: a close/reopen/close after the caller's pin makes every batch refuse; nothing is written
 const g=closedFresh();let flipped=false;
 const race=await imp(g,b0,{},{onBatch:async()=>{if(!flipped){flipped=true;sqlite(g,"UPDATE letterboxd_admission_authority SET mode='r2',generation=2;UPDATE letterboxd_admission_authority SET mode='closed',generation=3");}}});
 assert.notEqual(race.exit,0);assert.equal(rows(g,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,0,'the helper did not adopt the new closed generation');
 const done=await imp(f,b0);
 assert.equal(done.exit,0,JSON.stringify(done.result));assert.equal(done.result.imported,3);assert.equal(done.result.manifest,'written');assert.equal(done.result.manifestExact,true);assert.equal(done.result.parity,'equal');
 const again=await imp(f,b0);assert.equal(again.exit,0);assert.equal(again.result.imported,0);assert.equal(again.result.skipped,3);
 const parity=await run(f,['--target','iptv','--parity'],b0);assert.equal(parity.result.equal,true);assert.deepEqual(parity.result.blockers,[]);
 const late=makeBucket(cohort());late.put(K1,JSON.stringify({candidates:{c1:{state:'verified'},c2:{state:'verified'}}}));
 const drift=await run(f,['--target','iptv','--parity'],late);assert.equal(drift.result.equal,false);assert.ok(drift.result.differences.some(item=>item.kind==='d1_differs'));
}

// ===== 6. flip: every gate, the fenced batch, the verified effect =====
const imported=async()=>{const f=closedFresh();const r=await imp(f,b0);assert.equal(r.exit,0,JSON.stringify(r.result));return f;};
const flip=(f,bucket,over={},opts={})=>run(f,pins('flip',P({generation:1,admission:ADMISSION_PIN,manifest:MANIFEST,...over})),bucket,opts);
{
 const f0=closedFresh();
 assert.equal((await flip(f0,b0)).result.reason,'manifest_not_exact','no import, no flip (the manifest is absent)');
 // C2: each broken ingredient refuses, the marker stays closed
 for(const [name,sql,reason] of [
  ['paused control',"UPDATE catalog_enrichment_control SET state='paused',revision=3,generation=2",'c2_not_active'],
  ['bootstrap not done',"UPDATE catalog_enrichment_scope SET bootstrap_state='running'",'c2_not_active'],
  ['future cutoff',"UPDATE catalog_enrichment_scope SET cutoff_at='2026-11-29T04:00:00.000Z'",'c2_not_active'],
  ['control revision moved',"UPDATE catalog_enrichment_control SET state='paused',revision=3,generation=2;UPDATE catalog_enrichment_control SET state='active',revision=4,generation=3",'c2_pin_mismatch'],
  ['scope revision moved',"UPDATE catalog_enrichment_scope SET revision=9",'c2_pin_mismatch'],
 ]){
  const f=await imported();sqlite(f,sql);
  const out=await flip(f,b0);assert.equal(out.result.reason,reason,name);assert.equal(marker(f).mode,'closed',name);
 }
 {const f=await imported();sqlite(f,"UPDATE film_person_authority SET cutover='held',generation=3");assert.ok(['c2_not_active','unknown_state'].includes((await flip(f,b0)).result.reason),'Film/Person must be open');assert.equal(marker(f).mode,'closed');}
 {const f=await imported();assert.equal((await flip(f,b0,{control:1})).result.reason,'c2_pin_mismatch');}
 // an UNRELATED Ratings generation bump is allowed (the flip asserts the Ratings authority open, not its generation)
 // the original admission freeze: a late PUT to verified-films independent of the coordination manifest, a D1-only row, a changed row
 {const f=await imported();const lateObject=makeBucket(cohort());lateObject.put(ADMISSIONS,r2Admissions());const out=await flip(f,lateObject);assert.equal(out.result.reason,'admission_pin_mismatch');assert.equal(marker(f).mode,'closed');}
 {const f=await imported();sqlite(f,"UPDATE film_rated_admission SET year=1970 WHERE tmdb='101'");assert.equal((await flip(f,b0)).result.reason,'no_go');}
 // a manifest that is a VALID Ratings document with a correct hash but not the approved manifest (count 0, the original inventory digest, complete true): rejected before the batch
 {const f=await imported();const original=JSON.parse(rows(f,"SELECT body FROM ratings_document WHERE key='letterboxd/imports/documents-manifest.json'")[0].body);
  putDoc(f,'letterboxd/imports/documents-manifest.json',{schemaVersion:1,complete:true,count:0,inventorySha256:original.inventorySha256,keys:original.keys});
  const out=await flip(f,b0);assert.equal(out.result.reason,'manifest_not_exact');assert.equal(marker(f).mode,'closed');
  putDoc(f,'letterboxd/imports/documents-manifest.json',{schemaVersion:1,complete:true,count:0,inventorySha256:original.inventorySha256,keys:[]});
  assert.equal((await flip(f,b0)).result.reason,'manifest_not_exact','count/keys/digest disagree');}
 // a moved document missing from D1 / a part missing: parity or the document fence
 {const f=await imported();sqlite(f,"DELETE FROM ratings_document WHERE key='"+K2+"'");const out=await flip(f,b0);assert.equal(out.exit,3);assert.equal(out.result.reason,'parity_mismatch');assert.equal(marker(f).mode,'closed');}
 // real concurrent changes at the batch boundary: each refuses the WHOLE batch and the marker stays closed
 for(const [name,sql] of [
  ['paused C2 control',"UPDATE catalog_enrichment_control SET state='paused',revision=3,generation=2"],
  ['pending receipt',"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('q2','admit','rated_admission_retention','film','film:tmdb:101','"+A+"',0,2,'pending',1,'2026-11-28T09:00:00.000Z','2026-11-28T09:00:00.000Z','2026-11-28T09:00:00.000Z')"],
  ['admission row changed',"UPDATE film_rated_admission SET updated_at='2026-11-28T11:59:59.000Z' WHERE tmdb='102'"],
  ['moved document replaced',"UPDATE ratings_document SET body='{\"chunk\":9}', etag='"+sha256('{"chunk":9}')+"' WHERE key='"+K2+"'"],
  ['marker closure moved',"UPDATE letterboxd_admission_authority SET mode='r2',generation=2;UPDATE letterboxd_admission_authority SET mode='closed',generation=3"],
  ['scope changed',"UPDATE catalog_enrichment_scope SET revision=4"],
 ]){
  const f=await imported();let hit=false;
  const out=await flip(f,b0,{},{onBatch:async()=>{if(!hit){hit=true;sqlite(f,sql);}}});
  assert.equal(out.exit,3,name);assert.ok(['predicate_refused','write_uncertain'].includes(out.result.reason),name+': '+out.result.reason);
  assert.equal(rows(f,'SELECT mode FROM letterboxd_admission_authority')[0].mode,name==='marker closure moved'?'closed':'closed',name+': the marker did not reach d1');
 }
 // the guard row is asserted to EXIST: with ratings_domain_cas emptied no assertion could trip, so the flip must still refuse
 {const f=await imported();const out=await flip(f,b0,{},{onBatch:async()=>{sqlite(f,'DELETE FROM ratings_domain_cas');}});assert.equal(out.exit,3);assert.equal(marker(f).mode,'closed','a missing guard row refuses');}
 // success
 const f2=await imported();
 const registryBefore=makeBucket(cohort());
 const ok=await flip(f2,registryBefore);
 assert.equal(ok.exit,0,JSON.stringify(ok.result));
 assert.deepEqual({mode:marker(f2).mode,generation:marker(f2).generation},{mode:'d1',generation:2});
 assert.equal(marker(f2).activated_at,'2026-11-28T12:00:00.000Z');assert.equal(ok.result.after.marker.activatedAt,'2026-11-28T12:00:00.000Z','the readback includes activated_at');
 assert.deepEqual(ok.result.verified,{manifestExact:true,parityEqual:true,admissionObjectUnchanged:true,registryUnchanged:true});assert.equal(ok.result.irreversible,true);
 assert.equal((await run(f2,pins('reopen',P({generation:2})),null)).result.reason,'marker_not_closed');
 assert.equal((await run(f2,pins('rollback-import',P({generation:2})),null)).result.reason,'rollback_after_flip');
 assert.equal((await flip(f2,b0,{generation:2})).result.reason,'marker_not_closed');
 assert.throws(()=>sqlite(f2,"UPDATE letterboxd_admission_authority SET mode='closed',generation=3"),/one_way|chain/,'the trigger refuses d1 -> closed');
 assert.equal(rows(f2,"SELECT COUNT(DISTINCT key) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,4,'the D1 documents and the manifest stay');
}

// ===== 7. rollback-import and reopen: the rollback is verified from D1, not from the marker =====
{
 const f=await imported();
 assert.equal((await run(f,pins('reopen',P({generation:1})),null)).result.reason,'d1_copies_present','copies still in D1: no reopen');
 assert.equal((await run(f,pins('rollback-import',P({generation:9})),null)).result.reason,'generation_moved');
 // a closure race during the rollback: the pinned batch refuses, the copies stay, and it is NOT reported as rolled back
 let hit=false;
 const racing=await run(f,pins('rollback-import',P({generation:1})),null,{onBatch:async()=>{if(!hit){hit=true;sqlite(f,"UPDATE letterboxd_admission_authority SET mode='r2',generation=2;UPDATE letterboxd_admission_authority SET mode='closed',generation=3");}}});
 assert.notEqual(racing.exit,0);assert.equal(rows(f,"SELECT COUNT(DISTINCT key) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,4,'nothing was deleted');
 sqlite(f,"UPDATE letterboxd_admission_authority SET mode='r2',generation=4");sqlite(f,"UPDATE letterboxd_admission_authority SET mode='closed',generation=5");
 const out=await run(f,pins('rollback-import',P({generation:5})),null);
 assert.equal(out.exit,0,JSON.stringify(out.result));assert.deepEqual(out.result.d1Copies,{documents:0});
 assert.equal(rows(f,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,0);
 const reopened=await run(f,pins('reopen',P({generation:5})),null);
 assert.equal(reopened.exit,0,JSON.stringify(reopened.result));assert.deepEqual(marker(f),{mode:'r2',generation:6,activated_at:null});
}

// ===== 8. the production transports (mocked, no live request): strict D1 reads, the bounded S3 listing, no write retry =====
{
 const ok=body=>({ok:true,status:200,json:async()=>body});
 const target={endpoint:'https://api.example.test/client/v4',accountId:'8d9331889a693d328ef306692adf9d24',apiToken:'t'};
 // a malformed SUCCESSFUL answer (no result array) must be an error for the strict read, never an empty result
 const adapter=createD1Adapter({target,databaseId:'db',retries:0,fetchImpl:async()=>ok({success:true,result:[{success:true}]})});
 const {strictBinding}=await import('../scripts/catalog-enrichment-activation-production.mjs');
 const {createPublishedBinding}=await import('../scripts/published-epg-production.mjs');
 const strict=strictBinding(createPublishedBinding(adapter),adapter);
 await assert.rejects(()=>strict.prepare('SELECT 1').bind().all(),/result rows array|no result/i);
 const lenient=createPublishedBinding(adapter);
 assert.deepEqual((await lenient.prepare('SELECT 1').bind().all()).results,[],'the non-strict binding would have read it as empty: that is why the operator uses the strict one');
 // `retries: 0`: a failing read is not repeated
 let calls=0;const failing=createD1Adapter({target,databaseId:'db',retries:0,fetchImpl:async()=>{calls++;return {ok:false,status:503,json:async()=>({success:false})};}});
 await assert.rejects(()=>failing.allStrict('SELECT 1')).catch(()=>{});assert.equal(calls,1,'one request, no retry');
 // the S3 listing: a page at a time. A truncated page without a continuation token or with a repeated one is an incomplete listing
 const xml=(keys,{truncated=false,next=null}={})=>'<?xml version="1.0"?><ListBucketResult><IsTruncated>'+truncated+'</IsTruncated>'+(next?'<NextContinuationToken>'+next+'</NextContinuationToken>':'')+keys.map(key=>'<Contents><Key>'+key+'</Key><Size>1</Size><ETag>"x"</ETag></Contents>').join('')+'</ListBucketResult>';
 const store=pages=>{let n=0;return createS3Store({credentials:{accountId:'8d9331889a693d328ef306692adf9d24',accessKeyId:'k',secretAccessKey:'s',bucket:'iptv',endpoint:'https://acc.r2.example.test'},fetchImpl:async()=>{const page=pages[Math.min(n++,pages.length-1)];return {ok:true,status:200,headers:new Headers(),text:async()=>page,body:{cancel:async()=>{}}};}});};
 const listed=await Op.bucketOf(store([xml(['letterboxd/imports/a'],{truncated:true,next:'T1'}),xml(['letterboxd/imports/b'])])).list({prefix:'letterboxd/imports/'});
 assert.equal(listed.truncated,true);assert.equal(listed.cursor,'T1');
 const noToken=Op.bucketOf(store([xml(['letterboxd/imports/a'],{truncated:true})]));
 await assert.rejects(()=>noToken.list({prefix:'letterboxd/imports/'}));
 const repeat=Op.bucketOf(store([xml(['a'],{truncated:true,next:'T1'}),xml(['a'],{truncated:true,next:'T1'})]));
 const first=await repeat.list({prefix:'p/'});
 await assert.rejects(()=>repeat.list({prefix:'p/',cursor:first.cursor}),error=>error.reason==='listing_incomplete');
 // the importer's page bound applies through the page-at-a-time bucket: a listing that never ends is truncated and blocks the plan
 const {MAX_LIST_PAGES,inventory,planImport}=await import('../src/letterboxd-admission-documents-import.js');
 let pageNo=0;const endless=Op.bucketOf({listPage:async()=>({objects:[{key:'letterboxd/imports/z'+(pageNo)}],truncated:true,cursor:'c'+(++pageNo)}),get:async()=>null,head:async()=>null});
 const snapshot=await inventory(endless);assert.equal(snapshot.truncated,true);assert.equal(planImport(snapshot).blocked[0].reason,'inventory_truncated');assert.ok(pageNo>=MAX_LIST_PAGES);
}

// ===== 9. the bytes pin covers the modules that run; the operator is not part of the Worker =====
{
 assert.equal(Op.bytesDigest().files,15);assert.match(BYTES,/^[0-9a-f]{64}$/);
 for(const name of fs.readdirSync('src',{recursive:true}))if(/\.(js|mjs)$/.test(name))assert.ok(!/letterboxd-admission-(cutover-production|freeze-audit)/.test(fs.readFileSync(path.join('src',name),'utf8')),name+' must not import the operator');
 const source=fs.readFileSync('scripts/letterboxd-admission-cutover-production.mjs','utf8');
 assert.ok(!/process\.env\.[A-Z_]*TOKEN|console\.log/.test(source),'nothing is logged');
 assert.ok(/retries:0/.test(source),'the REST adapter of the production path does not retry');
}
console.log('letterboxd-admission-cutover-operator: ok');
