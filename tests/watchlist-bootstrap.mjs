// AIR-571 holdpoint (c): the Watchlist bootstrap import (src/watchlist-bootstrap.js) and its owner operator (scripts/watchlist-bootstrap-production.mjs).
// Offline only: the sqlite D1 stand-in over the whole migration chain. No production database is opened.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import {D1Error} from '../scripts/d1-backfill.mjs';
import * as Op from '../scripts/watchlist-bootstrap-production.mjs';
import {listDigest,normalizeFilms,readCurrent,pinForEpg} from '../src/watchlist-d1.js';
import {bootstrapStatements,BOOTSTRAP_MEMBERS_PER_STATEMENT} from '../src/watchlist-bootstrap.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-wl-boot-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const NOW=Date.parse('2026-11-21T18:00:00.000Z');
const RUN='run-20261121';
const FILMS=Array.from({length:40},(_,i)=>({id:'film-'+i,title:'Film '+i,year:1980+i,url:'https://letterboxd.com/film/film-'+i+'/'}));
const esc=text=>text.replace(/'/g,"''");
let copies=0;
function open({films=FILMS,run=RUN,certified=true,members=null}={}){
 const file=path.join(root,'db-'+(copies++)+'.sqlite');
 sqlite(file,names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 const text=JSON.stringify({films,updatedAt:'2026-11-21T16:11:45.255Z'});
 const half=Math.floor(text.length/2);
 sqlite(file,"INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('"+run+"','published','2026-11-21T16:11:45.255Z','"+'a'.repeat(64)+"','2026-11-21T16:00:00.000Z');"
  +"UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+run+"', generation=515"+(certified?", finalized_run_id='"+run+"', finalized_at='2026-11-21T16:11:45.255Z'":'')+' WHERE id=1;'
  +"INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('"+run+"','watchlist',0,'"+esc(text.slice(0,half))+"'),('"+run+"','watchlist',1,'"+esc(text.slice(half))+"');"
  +(members??films.map(f=>f.id)).map((id,i)=>"INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('"+run+"','watchlist',"+i+",'"+esc(id)+"');").join(''));
 return {file,db:d1Standin(file)};
}
// The production adapter reports a statement the database rejected (a tripped guard) as a D1Error of kind statement; the stand-in throws a plain error.
const asStatement=async run=>{try{return await run();}catch(error){throw new D1Error('statement',String(error?.message||error));}};
const stop=async(promise,reason)=>{try{await promise;}catch(error){assert.equal(error.reason,reason,String(error.reason));return error;}assert.fail('expected '+reason);};
const states=[];const trackedCtx=()=>({track:state=>states.push(state)});
const SHA=await listDigest(normalizeFilms(FILMS));
const ARGS={run:RUN,count:40,sha256:SHA};
const counts=file=>rows(file,"SELECT (SELECT COUNT(*) FROM watchlist_staging) AS staging,(SELECT COUNT(*) FROM watchlist_snapshot) AS snapshot,(SELECT COUNT(*) FROM watchlist_member) AS member,(SELECT COUNT(*) FROM watchlist_change) AS change,(SELECT COUNT(*) FROM watchlist_effect) AS effect,(SELECT COUNT(*) FROM watchlist_admission_pending) AS pending")[0];

// ===== 1. arguments =====
{
 const A=(...a)=>['node','x',...a];
 assert.deepEqual(Op.parseArgs(A()).report,{configured:false,writes:false,writeState:'none'});
 assert.throws(()=>Op.parseArgs(A('--bootstrap')),e=>e.reason==='target_required');
 assert.throws(()=>Op.parseArgs(A('--bootstrap','--target','other','--confirm','bootstrap')),e=>e.reason==='target_invalid');
 assert.throws(()=>Op.parseArgs(A('--bootstrap','--target','iptv','--expect-run','r','--expect-count','1','--expect-sha256',SHA)),e=>e.reason==='confirm');
 assert.throws(()=>Op.parseArgs(A('--bootstrap','--target','iptv','--confirm','bootstrap','--expect-run','r','--expect-count','1')),e=>e.reason==='usage','the digest pin is required');
 assert.throws(()=>Op.parseArgs(A('--bootstrap','--target','iptv','--confirm','bootstrap','--expect-run','r','--expect-count','1','--expect-sha256','zz')),e=>e.reason==='usage');
 assert.throws(()=>Op.parseArgs(A('--import','--target','iptv')),e=>e.reason==='usage','no other command exists');
 assert.equal(Op.parseArgs(A('--bootstrap','--target','iptv','--confirm','bootstrap','--expect-run',RUN,'--expect-count','40','--expect-sha256',SHA)).command,'bootstrap');
 const r=spawnSync(process.execPath,['scripts/watchlist-bootstrap-production.mjs'],{encoding:'utf8'});assert.equal(r.status,0);
 assert.deepEqual(JSON.parse(r.stdout),{configured:false,writes:false,writeState:'none'});
}

// ===== 2. the plan: statements, batch size, no side-effect rows =====
{
 const films=normalizeFilms(FILMS);
 const plan=bootstrapStatements({films,pin:{programmeRunId:RUN,epgGeneration:515,count:40,sha256:SHA,observedAt:'2026-11-21T16:11:45.255Z'},snapshotId:'snap-1',at:'2026-11-21T18:00:00.000Z',generation:0,revision:1});
 const sql=plan.statements.map(([text])=>text).join('\n');
 assert.equal(plan.statements.filter(([text])=>/INSERT INTO watchlist_member/.test(text)).length,Math.ceil(40/BOOTSTRAP_MEMBERS_PER_STATEMENT));
 assert.equal(plan.statements.every(([,params])=>params.length<=100),true,'no statement exceeds the 100 bound values of D1');
 for(const forbidden of ['watchlist_change','watchlist_effect','watchlist_admission_pending'])assert.equal(new RegExp('INSERT INTO '+forbidden).test(sql),false,'the import writes no '+forbidden+' row');
 const written=[...sql.matchAll(/(?:INSERT INTO|(?<!DO )UPDATE|DELETE FROM)\s+([a-z_]+)/gi)].map(match=>match[1]);
 assert.deepEqual([...new Set(written)].sort(),['watchlist_cas','watchlist_current','watchlist_member','watchlist_snapshot','watchlist_staging'],'only the import tables are written: no marker, Film, fact or retention row');
 assert.throws(()=>bootstrapStatements({films:[],pin:{},snapshotId:'x',at:'x',generation:0,revision:1}));
}

// ===== 3. status is read-only; bootstrap writes one atomic batch and reads back =====
{
 const env=open();
 const calls=[];const spy={prepare:sql=>env.db.prepare(sql),batch:async s=>{calls.push(s.length);return env.db.batch(s);}};
 const status=await Op.execute('status',{binding:spy,now:NOW});
 assert.equal(status.writes,false);assert.equal(status.decision,'ready');assert.deepEqual(status.source,{count:40,sha256:SHA});assert.equal(calls.length,0,'status never batches');
 assert.deepEqual(counts(env.file),{staging:0,snapshot:0,member:0,change:0,effect:0,pending:0});
 const before={members:rows(env.file,'SELECT COUNT(*) AS n FROM published_epg_member')[0].n,docs:rows(env.file,'SELECT COUNT(*) AS n FROM published_epg_document')[0].n,auth:rows(env.file,'SELECT mode, cutover, programme_run_id, generation FROM published_epg_authority')};
 states.length=0;
 const result=await Op.execute('bootstrap',{binding:spy,args:ARGS,now:NOW,ctx:{...trackedCtx(),snapshotId:'snap-boot-1'}});
 assert.equal(calls.length,1,'exactly ONE batch');assert.equal(result.writeState,'committed');assert.deepEqual(states,['unknown','committed']);
 assert.deepEqual(counts(env.file),{staging:1,snapshot:1,member:40,change:0,effect:0,pending:0},'snapshot, members and staging; no change, effect or admission row');
 assert.deepEqual(rows(env.file,'SELECT mode, writes, generation FROM watchlist_authority'),[{mode:'epg',writes:'open',generation:0}],'the marker stays epg');
 const pointer=rows(env.file,'SELECT version, snapshot_id, list_sha256, film_count, effects_drained_version, revision, last_success_run FROM watchlist_current')[0];
 assert.deepEqual(pointer,{version:1,snapshot_id:'snap-boot-1',list_sha256:SHA,film_count:40,effects_drained_version:1,revision:2,last_success_run:RUN});
 assert.equal(rows(env.file,'SELECT COUNT(*) AS n FROM published_epg_member')[0].n,before.members);assert.equal(rows(env.file,'SELECT COUNT(*) AS n FROM published_epg_document')[0].n,before.docs);
 assert.deepEqual(rows(env.file,'SELECT mode, cutover, programme_run_id, generation FROM published_epg_authority'),before.auth,'the published EPG generation is untouched');
 // the imported snapshot is a valid snapshot for the repository once the marker is d1: parity with the source, and the EPG pin has a list from the first instant
 sqlite(env.file,"UPDATE watchlist_authority SET mode='d1'");
 const current=await readCurrent(env.db,{now:NOW});
 assert.equal(current.ok,true);assert.equal(current.snapshot.version,1);assert.equal(current.snapshot.listSha256,SHA);assert.deepEqual(current.snapshot.films.map(f=>f.lid),FILMS.map(f=>f.id),'order parity');
 const pin=await pinForEpg(env.db,{now:NOW});assert.equal(pin.ok,true);assert.equal(pin.films.length,40);
 // idempotent: an equal import writes nothing
 sqlite(env.file,"UPDATE watchlist_authority SET mode='epg'");
 calls.length=0;
 const again=await Op.execute('bootstrap',{binding:spy,args:ARGS,now:NOW});
 assert.equal(again.outcome,'already_applied');assert.equal(again.writes,false);assert.equal(calls.length,0);
 await stop(Op.execute('bootstrap',{binding:env.db,args:{...ARGS,sha256:'b'.repeat(64)},now:NOW}),'already_bootstrapped');
}

// ===== 4. refusals change nothing =====
{
 const refuse=async(env,args,reason,label)=>{const e=await stop(Op.execute('bootstrap',{binding:env.db,args,now:NOW,ctx:trackedCtx()}),reason);assert.deepEqual(counts(env.file),{staging:0,snapshot:0,member:0,change:0,effect:0,pending:0},label+' wrote nothing');return e;};
 states.length=0;
 const e=await refuse(open(),{...ARGS,sha256:'c'.repeat(64)},'pin_mismatch','digest pin');assert.deepEqual(e.details.problems,['sha256']);assert.equal(states.length,0,'refused before any write');
 assert.deepEqual((await refuse(open(),{...ARGS,count:39},'pin_mismatch','count pin')).details.problems,['count']);
 assert.deepEqual((await refuse(open(),{...ARGS,run:'run-other'},'pin_mismatch','run pin')).details.problems,['run']);
 assert.deepEqual((await refuse(open(),{...ARGS,epgGeneration:1},'pin_mismatch','generation pin')).details.problems,['epg_generation']);
 await refuse(open({certified:false}),ARGS,'published_not_certified','uncertified generation');
 const held=open();sqlite(held.file,"UPDATE watchlist_authority SET writes='held'");await refuse(held,ARGS,'marker_not_epg_open','held marker');
 const d1=open();sqlite(d1.file,"UPDATE watchlist_authority SET mode='d1'");await refuse(d1,ARGS,'marker_not_epg_open','d1 marker');
 const dirty=open();sqlite(dirty.file,"INSERT INTO watchlist_staging (snapshot_id, attempt_id, expected_count, expected_sha256, started_at) VALUES ('x','x',0,'"+'d'.repeat(64)+"','2026-11-21T10:00:00.000Z')");
 await stop(Op.execute('bootstrap',{binding:dirty.db,args:ARGS,now:NOW}),'tables_not_empty');
 await refuse(open({members:FILMS.map(f=>f.id).reverse()}),ARGS,'source_mismatch','member rows disagree with the document order');
 const dup=FILMS.slice();dup[5]={...dup[5],id:'film-0'};
 await refuse(open({films:dup,members:FILMS.map(f=>f.id)}),{...ARGS},'source_shape','duplicate ids in the source');
 const noUrl=FILMS.map(f=>({...f}));delete noUrl[3].url;
 await refuse(open({films:noUrl}),ARGS,'source_shape','a film without a url');
 await refuse(open({films:[],members:[]}),ARGS,'source_shape','an empty source');
 const busy=open();sqlite(busy.file,"INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','{\"schemaVersion\":1,\"holder\":\"h\",\"expiresAt\":\"2026-11-21T19:00:00.000Z\",\"released\":false}',1,'2026-11-21T17:50:00.000Z')");
 assert.equal((await refuse(busy,ARGS,'writer_active','live EPG step')).details.busy,'step_lease_live');
}

// ===== 5. failures: rollback, unproven transport, lost reply, bad readback, live counters =====
{
 // the pinned generation moves inside the window: the in-batch guard aborts the whole batch
 const raced=open();
 const racing={prepare:sql=>raced.db.prepare(sql),batch:async s=>{sqlite(raced.file,"UPDATE published_epg_authority SET generation=516");return asStatement(()=>raced.db.batch(s));}};
 states.length=0;
 await stop(Op.execute('bootstrap',{binding:racing,args:ARGS,now:NOW,ctx:trackedCtx()}),'statement_failed');
 assert.deepEqual(counts(raced.file),{staging:0,snapshot:0,member:0,change:0,effect:0,pending:0},'rolled back: no row');assert.equal(states.at(-1),'none');
 // the marker flips to d1 inside the window
 const flipped=open();
 const flipping={prepare:sql=>flipped.db.prepare(sql),batch:async s=>{sqlite(flipped.file,"UPDATE watchlist_authority SET mode='d1'");return asStatement(()=>flipped.db.batch(s));}};
 await stop(Op.execute('bootstrap',{binding:flipping,args:ARGS,now:NOW}),'statement_failed');
 assert.equal(counts(flipped.file).member,0);
 // an unproven transport outcome stays write_uncertain even if the readback looks untouched; the CLI says retry:false
 const unproven=open();let attempts=0;
 const timing={prepare:sql=>unproven.db.prepare(sql),batch:async()=>{attempts++;throw new D1Error('write_uncertain','response lost');}};
 states.length=0;
 await stop(Op.execute('bootstrap',{binding:timing,args:ARGS,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(states.at(-1),'unknown');assert.equal(attempts,1,'no retry');
 const cli=await Op.runWatchlistBootstrapProduction({argv:['node','x','--bootstrap','--target','iptv','--confirm','bootstrap','--expect-run',RUN,'--expect-count','40','--expect-sha256',SHA],deps:{binding:timing},now:()=>NOW});
 assert.equal(cli.exit,3);assert.equal(cli.result.reason,'write_uncertain');assert.equal(cli.result.writeState,'unknown');assert.equal(cli.result.writes,null);assert.equal(cli.result.retry,false);
 // a proven statement rejection that rolled back is the only "not applied"
 const rejectedEnv=open();
 await stop(Op.execute('bootstrap',{binding:{prepare:sql=>rejectedEnv.db.prepare(sql),batch:async()=>{throw new D1Error('statement','rejected');}},args:ARGS,now:NOW,ctx:trackedCtx()}),'statement_failed');assert.equal(states.at(-1),'none');
 // a lost reply after a visible commit
 const lost=open();let batches=0;
 const error=await stop(Op.execute('bootstrap',{binding:{prepare:sql=>lost.db.prepare(sql),batch:async s=>{batches++;await lost.db.batch(s);throw new Error('lost reply');}},args:ARGS,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(batches,1);assert.equal(error.details.after.pointer.version,1);assert.equal(states.at(-1),'unknown');
 // a readback that disagrees: a change row appears inside the window
 const dirty=open();
 const bad=await stop(Op.execute('bootstrap',{binding:{prepare:sql=>dirty.db.prepare(sql),batch:async s=>{const r=await dirty.db.batch(s);sqlite(dirty.file,"INSERT INTO watchlist_change (snapshot_id, kind, lid, ordinal, prev_ordinal) SELECT snapshot_id,'added','film-0',0,NULL FROM watchlist_snapshot");return r;}},args:ARGS,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(bad.details.problems.includes('rows'),true);
 // a stable field of another domain changing inside the window is caught
 const moved=open();
 const m=await stop(Op.execute('bootstrap',{binding:{prepare:sql=>moved.db.prepare(sql),batch:async s=>{const r=await moved.db.batch(s);sqlite(moved.file,"UPDATE ratings_domain_authority SET cutover='held'");return r;}},args:ARGS,now:NOW,ctx:trackedCtx()}),'write_uncertain');
 assert.equal(m.details.problems.some(p=>p.startsWith('marker_changed:ratings_domain_authority')),true);
 // a live counter of a fast-moving domain is NOT drift (the lesson of the 0033 apply): the import succeeds
 const live=open();
 const counter=await Op.execute('bootstrap',{binding:{prepare:sql=>live.db.prepare(sql),batch:async s=>{const r=await live.db.batch(s);sqlite(live.file,"UPDATE discovery_authority SET generation=generation+500; UPDATE ratings_domain_authority SET generation=generation+30");return r;}},args:ARGS,now:NOW,ctx:trackedCtx()});
 assert.equal(counter.writeState,'committed','natural counters of other domains do not read as drift');
}
console.log('watchlist bootstrap: ok');
