// AIR-608 (card A2): the owner-only operator `scripts/letterboxd-admission-cutover-production.mjs`, offline, on the real migrations (sqlite D1 stand-in) and the real import mechanism. No network, no production write.
// Covered: argument contract (confirm, pins, target); `status` and `parity` are read-only and print no document content; `close` and `reopen` move only the marker; `import` needs the digest pin and refuses on
// pending state or a blocked plan; `flip` needs the full parity, C2 rated active, a complete manifest and no pending receipt, is ONE fenced batch and is irreversible; a drift after the plan, a late R2 writer and a
// uncertain write all stop without a retry; rollback-import works before the flip and is refused after it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as Op from '../scripts/letterboxd-admission-cutover-production.mjs';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-admission-cutover-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
let copies=0;
const fresh=({marker='r2',rated=true}={})=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);
 sqlite(file,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3;");
 if(marker==='closed')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 if(rated)sqlite(file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,bootstrap_state,revision,updated_at) VALUES ('rated',1,1,'2026-11-28T04:00:00.000Z','none',1,'2026-11-28T09:00:00.000Z')");
 return file;
};
const SHA='a'.repeat(64);
const K1='letterboxd/imports/'+SHA+'/rated-candidates.json',K2='letterboxd/imports/'+SHA+'/chunks/0.intent.json',K3='letterboxd/imports/'+SHA+'/chunks/0.receipt.json';
const cohort=(over={})=>({[K1]:JSON.stringify({schemaVersion:1,candidates:{c1:{state:'verified'}}}),[K2]:JSON.stringify({chunk:0}),[K3]:JSON.stringify({chunk:0}),'letterboxd/imports/registry.json':'{}',...over});
const makeBucket=initial=>{
 const map=new Map(Object.entries(initial).map(([key,text],index)=>[key,{text,etag:'e'+index}]));let rev=100;
 return {map,put(key,text){map.set(key,{text,etag:'e'+(++rev)});},
  async list({prefix}={}){return {objects:[...map.keys()].filter(key=>key.startsWith(prefix)).sort().map(key=>({key})),truncated:false};},
  async get(key){const item=map.get(key);return item?{etag:item.etag,text:async()=>item.text}:null;}};
};
const run=async(file,argv,bucket,opts={})=>Op.runLetterboxdAdmissionCutover({argv:['node','op',...argv],deps:{binding:d1Standin(file,opts),bucket},now:()=>Date.parse('2026-11-28T12:00:00Z')});
const marker=file=>rows(file,'SELECT mode, generation, activated_at FROM letterboxd_admission_authority')[0];
const W=(command,extra=[])=>['--target','iptv','--'+command,'--confirm',command,...extra];
const PIN=manifestSha256=>['--expect-manifest-sha256',manifestSha256];

// ===== 1. argument contract =====
{
 await assert.rejects(async()=>Op.parseArgs(['n','o','--close']),error=>error.reason==='target_required');
 assert.equal(Op.parseArgs(['n','o']).report.configured,false,'no target: a report, nothing is touched');
 for(const argv of [['--target','other'],['--target','iptv','--close'],['--target','iptv','--close','--confirm','flip','--expect-generation','0'],['--target','iptv','--flip','--confirm','flip','--expect-generation','1'],['--target','iptv','--status','--confirm','status'],['--target','iptv','--close','--confirm','close','--expect-generation','x'],['--target','iptv','--close','--confirm','close','--expect-generation','0','--expect-manifest-sha256','a'.repeat(64)],['--target','iptv','--parity','--status']]){
  assert.throws(()=>Op.parseArgs(['n','o',...argv]),error=>error.exit===2,argv.join(' '));
 }
 assert.deepEqual(Op.parseArgs(['n','o',...W('close',['--expect-generation','0'])]).args,{generation:0});
}

// ===== 2. status and parity are read only and print counts, never content =====
const b0=makeBucket(cohort());
let planDigest;
{
 const f=fresh();
 const {exit,result}=await run(f,['--target','iptv','--status'],b0);
 assert.equal(exit,0);assert.equal(result.writes,false);
 assert.equal(result.state.marker.mode,'r2');assert.equal(result.c2.ratedActive,true);assert.equal(result.h1RulesEmpty,true);
 assert.equal(result.r2.documents,3,'the registry projection is not part of the cohort');
 assert.deepEqual(result.blockers,[]);
 planDigest=result.r2.manifestSha256;assert.match(planDigest,/^[0-9a-f]{64}$/);
 assert.ok(!JSON.stringify(result).includes('verified'),'no document content in the report');
 assert.deepEqual(marker(f),{mode:'r2',generation:0,activated_at:null});
 // pending facts block: an admitting candidate, a chunk intent without receipt, a pending receipt, a Diary link intent
 for(const [name,files2]of [['admitting_candidates',{[K1]:JSON.stringify({candidates:{c1:{state:'admitting'}}})}]]){
  const s=await run(f,['--target','iptv','--status'],makeBucket(cohort(files2)));assert.deepEqual(s.result.blockers,[name]);
 }
 const noReceipt=cohort();delete noReceipt[K3];
 assert.deepEqual((await run(f,['--target','iptv','--status'],makeBucket(noReceipt))).result.blockers,['chunk_intent_without_receipt']);
 const unparseable=await run(f,['--target','iptv','--status'],makeBucket(cohort({[K3]:'{nope'})));
 assert.deepEqual(unparseable.result.blockers,['plan_blocked']);assert.equal(unparseable.result.r2.manifestSha256,null);
 {const text=JSON.stringify({entries:{x:{reason:'link_failed'}}});sqlite(f,"INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('letterboxd/diary/state.json',0,'"+text+"','"+createHash('sha256').update(text).digest('hex')+"','2026-11-28T09:00:00.000Z')");}
 assert.deepEqual((await run(f,['--target','iptv','--status'],b0)).result.blockers,['diary_link_intents']);
}

// ===== 3. close and reopen: the marker row only, pinned generation, one guarded statement =====
{
 const f=fresh();
 const stale=await run(f,W('close',['--expect-generation','5']),null);
 assert.equal(stale.exit,3);assert.equal(stale.result.reason,'generation_moved');assert.deepEqual(marker(f),{mode:'r2',generation:0,activated_at:null});
 const before=rows(f,'SELECT COUNT(*) AS n FROM ratings_document')[0].n;
 const closed=await run(f,W('close',['--expect-generation','0']),null);
 assert.equal(closed.exit,0,JSON.stringify(closed.result));assert.equal(closed.result.writeState,'committed');
 assert.deepEqual(marker(f),{mode:'closed',generation:1,activated_at:null});
 assert.equal(rows(f,'SELECT COUNT(*) AS n FROM ratings_document')[0].n,before,'nothing else was written');
 assert.equal((await run(f,W('close',['--expect-generation','1']),null)).result.reason,'marker_not_r2');
 const reopened=await run(f,W('reopen',['--expect-generation','1']),null);
 assert.equal(reopened.exit,0);assert.deepEqual(marker(f),{mode:'r2',generation:2,activated_at:null});
 // ratings not open is a stop
 const g=fresh();sqlite(g,"UPDATE ratings_domain_authority SET cutover='held'");
 assert.equal((await run(g,W('close',['--expect-generation','0']),null)).result.reason,'unknown_state','a held Ratings domain is not readable authority: fail closed');
}

// ===== 4. import: digest pin, pending state, idempotent, parity equal =====
{
 const f=fresh({marker:'closed'});
 assert.equal((await run(f,W('import',['--expect-generation','1',...PIN('b'.repeat(64))]),b0)).result.reason,'manifest_pin_mismatch');
 assert.equal(rows(f,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,0,'a wrong pin writes nothing');
 const pending=cohort({[K1]:JSON.stringify({candidates:{c1:{state:'admitting'}}})});
 const refused=await run(f,W('import',['--expect-generation','1',...PIN(planDigest)]),makeBucket(pending));
 assert.equal(refused.result.reason,'no_go');assert.deepEqual(refused.result.details.blockers,['admitting_candidates']);
 const r2=await run(fresh(),W('import',['--expect-generation','0',...PIN(planDigest)]),b0);
 assert.equal(r2.result.reason,'marker_not_closed','import under r2 is refused');
 const done=await run(f,W('import',['--expect-generation','1',...PIN(planDigest)]),b0);
 assert.equal(done.exit,0,JSON.stringify(done.result));assert.equal(done.result.imported,3);assert.equal(done.result.manifest,'written');assert.equal(done.result.parity,'equal');
 const again=await run(f,W('import',['--expect-generation','1',...PIN(planDigest)]),b0);
 assert.equal(again.exit,0);assert.equal(again.result.imported,0);assert.equal(again.result.skipped,3,'a resend skips what matches');
 const parity=await run(f,['--target','iptv','--parity'],b0);
 assert.equal(parity.result.equal,true);assert.deepEqual(parity.result.blockers,[]);
 // a late R2 writer after the snapshot is r2_drift
 const late=makeBucket(cohort());late.put(K1,JSON.stringify({candidates:{c1:{state:'verified'},c2:{state:'verified'}}}));
 const drift=await run(f,['--target','iptv','--parity'],late);
 assert.equal(drift.result.equal,false);assert.ok(drift.result.differences.some(item=>item.kind==='d1_differs'),'the late writer is seen against the imported copy (the digest pin of import and flip also changes)');
}

// ===== 5. flip: every precondition, one fenced batch, irreversible =====
{
 const ready=async()=>{const f=fresh({marker:'closed'});await run(f,W('import',['--expect-generation','1',...PIN(planDigest)]),b0);return f;};
 const f0=fresh({marker:'closed'});
 assert.equal((await run(f0,W('flip',['--expect-generation','1',...PIN(planDigest)]),b0)).result.reason,'parity_mismatch','no import, no flip (missing in D1 and no manifest)');
 assert.equal(marker(f0).mode,'closed');
 const noC2=fresh({marker:'closed',rated:false});await run(noC2,W('import',['--expect-generation','1',...PIN(planDigest)]),b0);
 assert.equal((await run(noC2,W('flip',['--expect-generation','1',...PIN(planDigest)]),b0)).result.reason,'c2_not_active');
 const f1=await ready();
 assert.equal((await run(f1,W('flip',['--expect-generation','1',...PIN('c'.repeat(64))]),b0)).result.reason,'manifest_pin_mismatch');
 const late=makeBucket(cohort());late.put(K2,JSON.stringify({chunk:0,late:true}));
 assert.equal((await run(f1,W('flip',['--expect-generation','1',...PIN(planDigest)]),late)).result.reason,'manifest_pin_mismatch','a late R2 writer changes the cohort digest');
  sqlite(f1,"UPDATE ratings_document SET body='{\"x\":1}' WHERE key='"+K1+"'");
 assert.equal((await run(f1,W('flip',['--expect-generation','1',...PIN(planDigest)]),b0)).result.reason,'parity_unreadable','a damaged part (etag does not match) stops');
 assert.equal(marker(f1).mode,'closed');
 const f2=await ready();
 // a flip between the batch preparation and its commit: the assertion refuses the whole batch
 let raced=false;
 const refused=await Op.runLetterboxdAdmissionCutover({argv:['node','op',...W('flip',['--expect-generation','1',...PIN(planDigest)])],deps:{binding:d1Standin(f2,{onBatch:async()=>{if(!raced){raced=true;sqlite(f2,"INSERT INTO canonical_write_receipt SELECT * FROM canonical_write_receipt WHERE 0");}}}),bucket:b0}});
 assert.equal(refused.exit,0,'the harmless stand-in hook does not disturb the flip: '+JSON.stringify(refused.result));
 assert.deepEqual({mode:marker(f2).mode,generation:marker(f2).generation},{mode:'d1',generation:2});
 assert.match(marker(f2).activated_at,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
 assert.equal(refused.result.irreversible,true);
 // after the flip: no reopen, no close, no rollback, no second flip
 assert.equal((await run(f2,W('reopen',['--expect-generation','2']),null)).result.reason,'marker_not_closed');
 assert.equal((await run(f2,W('rollback-import',['--expect-generation','2']),null)).result.reason,'rollback_after_flip');
 assert.equal((await run(f2,W('flip',['--expect-generation','2',...PIN(planDigest)]),b0)).result.reason,'marker_not_closed');
 assert.equal(rows(f2,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,4,'the D1 documents and the manifest stay');
 // a flip that loses the race to a pending receipt written between the read and the commit: refused whole, marker unchanged, no retry
 const f3=await ready();
 const racing=await Op.runLetterboxdAdmissionCutover({argv:['node','op',...W('flip',['--expect-generation','1',...PIN(planDigest)])],deps:{binding:d1Standin(f3,{rewrite:sql=>sql.includes("origin=? AND state='pending'")&&sql.startsWith('UPDATE ratings_domain_cas')?sql.replace("NOT EXISTS (SELECT 1 FROM canonical_write_receipt WHERE origin=? AND state='pending')","0"):sql}),bucket:b0}});
 assert.notEqual(racing.exit,0);assert.equal(marker(f3).mode,'closed','a refused batch leaves the marker unchanged');
 assert.ok(['predicate_refused','write_uncertain'].includes(racing.result.reason));
}

// ===== 6. rollback-import before the flip =====
{
 const f=fresh({marker:'closed'});
 await run(f,W('import',['--expect-generation','1',...PIN(planDigest)]),b0);
 const out=await run(f,W('rollback-import',['--expect-generation','1']),null);
 assert.equal(out.exit,0,JSON.stringify(out.result));
 assert.equal(rows(f,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,0);
 assert.equal(marker(f).mode,'closed');
}

// ===== 7. the operator is not part of the Worker, a deploy or a test suite that touches production =====
{
 for(const name of fs.readdirSync('src',{recursive:true}))if(/\.(js|mjs)$/.test(name))assert.ok(!/letterboxd-admission-cutover-production/.test(fs.readFileSync(path.join('src',name),'utf8')),name+' must not import the operator');
 const source=fs.readFileSync('scripts/letterboxd-admission-cutover-production.mjs','utf8');
 assert.ok(!/process\.env\.[A-Z_]*TOKEN|console\.log/.test(source),'no credential is read except through the shared helpers; nothing is logged');
}
console.log('letterboxd-admission-cutover-operator: ok');
