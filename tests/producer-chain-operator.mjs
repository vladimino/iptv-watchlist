// AIR-572: the owner-only terminalization of a stale canonical Producer chain (MCP tool producer_chain_operator). Offline only: the sqlite D1 stand-in with the REAL migration chain and the
// REAL `supersedeChain`; no production database, Workflow or Cloudflare is opened. Covers: no write without a call, status (read-only, bounded, eligibility, expect pins),
// every refusal with zero writes (confirm, pins, hold, marker, published authority, current run, live lease, terminal or missing chain, revision moved), the happy path (exactly one row moves to
// `superseded`, nothing else in the database changes, no Workflow instance), idempotent repeat, races inside the write (publication, target published, marker, revision: each rolls the batch back),
// the published guards on the owner batch only (the reconcile's batch unchanged), ambiguous outcomes (commit then lost response, failed readback, lost request) never reported as zero writes and
// never retried, the open-chain predicate agreeing with the membership switch gate, and why the hourly reconcile cannot do this while the hold is on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Chain from '../src/canonical-producer-chain.js';
import {reconcileProducerChain,HELD_BY_DELIVERY} from '../src/canonical-producer-workflow.js';
import {operatorReads,PRODUCER_OPEN_CHAINS_SQL} from '../src/watchlist-membership.js';

const {producerChainOperator,PRODUCER_CHAIN_OPERATOR_LIMIT,PRODUCER_OPEN_CHAIN_PREDICATE}=Chain;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-producer-chain-operator-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'t.sqlite');
sqlite(template,names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
sqlite(template,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");

// The production shape of 23 Nov 2026: one chain of the previous published run (generation 517) that was launched, never claimed, and taken over 21 times while the instances errored;
// then generation 518 was published under the hold, so nothing superseded it. Two earlier chains are already superseded.
const OLD='run-old',NEW='run-new',EARLIER='run-earlier';
const LAUNCH='2026-11-22T16:00:00.000Z';
const NOW=Date.parse('2026-11-23T21:15:00.000Z');
let copies=0;
function world({publishNew=true,takeovers=3}={}){
 const file=path.join(root,'w-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);
 const queries=[];
 const made={file,queries,publishNew,takeovers,beforeBatch:null,batchSizes:[]};
 // `beforeBatch` (one shot) runs right before the next batch is applied: a concurrent writer between the operator's read and its write.
 made.env={DB:d1Standin(file,{onQuery:text=>{queries.push(text);},onBatch:async statements=>{made.batchSizes.push(statements.length);const hook=made.beforeBatch;made.beforeBatch=null;if(hook)await hook(statements);}})};
 return made;
}
const publish=(file,p,g)=>sqlite(file,"UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='"+p+"',generation="+g+" WHERE id=1");
async function seed(made){
 publish(made.file,EARLIER,516);
 assert.equal((await Chain.launchChain(made.env,{programmeRunId:EARLIER,generation:516,at:LAUNCH,nowMs:Date.parse(LAUNCH)})).state,'launched');
 publish(made.file,OLD,517);
 assert.equal((await Chain.launchChain(made.env,{programmeRunId:OLD,generation:517,at:LAUNCH,nowMs:Date.parse(LAUNCH)})).state,'launched');
 // the reconcile of the next tick supersedes the earlier run's chain, as it did before the hold
 assert.equal((await Chain.supersedeChain(made.env,{chain:await Chain.readChain(made.env,EARLIER),at:LAUNCH})).state,'superseded');
 // the old chain's lease is taken over a few times (each takeover bumps epoch and revision) and then expires
 for(let i=0;i<made.takeovers;i++){
  const chain=await Chain.readChain(made.env,OLD);
  const at=new Date(Date.parse(chain.lease_expires_at)+60000).toISOString();
  const out=await Chain.takeoverChain(made.env,{chain,generation:517,at,nowMs:Date.parse(at)});
  assert.equal(out.state,'pending',JSON.stringify(out));
 }
 if(made.publishNew)publish(made.file,NEW,518);
 return made;
}
const chainRow=(file,p)=>rows(file,"SELECT * FROM canonical_producer_chain WHERE programme_run_id='"+p+"'")[0]||null;
// every row of every table except the sqlite internals: what "nothing else changed" means
const tables=file=>rows(file,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row=>row.name);
const dump=file=>Object.fromEntries(tables(file).map(name=>[name,JSON.stringify(rows(file,'SELECT * FROM "'+name+'" ORDER BY '+(rows(file,"SELECT wr FROM pragma_table_list WHERE name='"+name+"'")[0]?.wr?Array.from({length:rows(file,"SELECT COUNT(*) AS n FROM pragma_table_info('"+name+"')")[0].n},(_,i)=>i+1).join(','):'rowid')))]));
const sameExcept=(before,after,except=[])=>{for(const name of Object.keys(before))if(!except.includes(name))assert.equal(after[name],before[name],'table '+name+' unchanged');};
const operatorOf=({held=true,now=NOW,...rest}={})=>producerChainOperator({held:()=>held,now:()=>now,...rest});

// ===== 1. no call, no write; status is read-only and bounded =====
{
 const made=await seed(world());
 const before=dump(made.file),batches=made.env.DB.calls.batches;
 const operator=operatorOf();
 assert.equal(made.env.DB.calls.batches,batches,'building the operator writes nothing');
 made.queries.length=0;
 const status=await operator(made.env,{});
 assert.equal(status.status,200);assert.equal(status.body.mode,'status');assert.equal(status.body.sideEffects,'none');
 assert.equal(made.env.DB.calls.batches,batches,'status sends no batch');
 assert.ok(made.queries.every(text=>/^\s*SELECT/i.test(text)),'status runs SELECT statements only');
 sameExcept(before,dump(made.file));
 assert.deepEqual(status.body.filmPerson,{open:true,generation:2});
 assert.deepEqual(status.body.published,{programmeRunId:NEW,generation:518});
 assert.equal(status.body.held,true);assert.equal(status.body.blocked,null);
 assert.equal(status.body.chains.truncated,false);
 assert.equal(status.body.chains.items.length,1,'the superseded chain is not listed');
 const [item]=status.body.chains.items;
 const stored=chainRow(made.file,OLD);
 assert.deepEqual(item,{programmeRunId:OLD,inputGeneration:517,ownerState:'pending',ownerEpoch:Number(stored.owner_epoch),claimed:false,leaseExpiresAt:stored.lease_expires_at,recoveryClass:null,
  revision:Number(stored.revision),runLinked:false,eligible:true,expect:{expectedProgrammeRunId:OLD,expectedRevision:Number(stored.revision)}});
 assert.equal(item.revision,1+made.takeovers,'each takeover bumped the revision');
 assert.ok(made.queries.some(text=>/FROM canonical_producer_chain WHERE \(owner_state IN/.test(text)&&/LIMIT 11$/.test(text.trim())),'the list is bounded to the limit plus one');
 // the status call is also safe without the hold: it reports the blocker and still writes nothing
 const loose=await operatorOf({held:false})(made.env,{mode:'status'});
 assert.equal(loose.body.held,false);assert.equal(loose.body.blocked,'producer_not_held');
 sameExcept(before,dump(made.file));
}

// ===== 2. every refusal writes nothing =====
{
 const made=await seed(world());
 const before=dump(made.file),batches=()=>made.env.DB.calls.batches,start=batches();
 const pins={expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)};
 const refuse=async(args,reason,extra={},status=409)=>{
  const out=await operatorOf(extra)(made.env,args);
  assert.equal(out.status,status,reason+': '+JSON.stringify(out));assert.equal(out.body.ok,false);assert.equal(out.body.reason,reason);
  if(out.body.writes!==undefined)assert.equal(out.body.writes,0);
 };
 await refuse([],'invalid',{},400);
 await refuse({mode:'apply'},'invalid_mode',{},400);
 await refuse({mode:'supersede',confirmGo:'yes',...pins},'invalid_confirm',{},400);
 await refuse({mode:'supersede',...pins},'confirm_required',{},400);
 await refuse({mode:'supersede',confirmGo:false,...pins},'confirm_required',{},400);
 await refuse({mode:'supersede',confirmGo:true,expectedRevision:pins.expectedRevision},'invalid_expected_programme_run_id',{},400);
 await refuse({mode:'supersede',confirmGo:true,expectedProgrammeRunId:"x' OR 1=1 --",expectedRevision:1},'invalid_expected_programme_run_id',{},400);
 await refuse({mode:'supersede',confirmGo:true,expectedProgrammeRunId:OLD},'invalid_expected_revision',{},400);
 await refuse({mode:'supersede',confirmGo:true,expectedProgrammeRunId:OLD,expectedRevision:0},'invalid_expected_revision',{},400);
 await refuse({mode:'supersede',confirmGo:true,expectedProgrammeRunId:OLD,expectedRevision:'4'},'invalid_expected_revision',{},400);
 await refuse({mode:'supersede',confirmGo:true,...pins},'producer_not_held',{held:false});
 await refuse({mode:'supersede',confirmGo:true,...pins},'producer_not_held',{held:'true'});
 await refuse({mode:'supersede',confirmGo:true,...pins,expectedRevision:pins.expectedRevision-1},'revision_moved');
 await refuse({mode:'supersede',confirmGo:true,...pins,expectedRevision:pins.expectedRevision+1},'revision_moved');
 await refuse({mode:'supersede',confirmGo:true,expectedProgrammeRunId:'run-unknown',expectedRevision:1},'chain_not_found');
 await refuse({mode:'supersede',confirmGo:true,expectedProgrammeRunId:EARLIER,expectedRevision:2},'already_superseded');
 // the lease of the chain is still live at a time before it expired (plus the boundary margin)
 const lease=Date.parse(chainRow(made.file,OLD).lease_expires_at);
 await refuse({mode:'supersede',confirmGo:true,...pins},'lease_live',{now:lease});
 await refuse({mode:'supersede',confirmGo:true,...pins},'lease_live',{now:lease+Chain.CHAIN_BOUNDARY_MARGIN_MS});
 assert.equal(made.env.DB.calls.batches,start,'no refusal sends a batch');
 sameExcept(before,dump(made.file));
}
// the chain of the CURRENT published run is the reconcile's, never this tool's
{
 const made=await seed(world({publishNew:false}));
 const before=dump(made.file);
 const out=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)});
 assert.equal(out.body.reason,'current_published_run');assert.equal(out.body.writes,0);
 const status=await operatorOf()(made.env,{});
 assert.equal(status.body.chains.items[0].eligible,false);assert.equal(status.body.chains.items[0].reason,'current_published_run');assert.equal(status.body.chains.items[0].expect,undefined);
 sameExcept(before,dump(made.file));
}
// a held Film/Person marker, and a published authority that is not open
{
 const made=await seed(world());
 sqlite(made.file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 const before=dump(made.file);
 const out=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)});
 assert.equal(out.body.reason,'film_person_not_open');assert.equal(out.body.writes,0);
 assert.deepEqual((await operatorOf()(made.env,{})).body.filmPerson,{open:false});
 sameExcept(before,dump(made.file));
 const bare=world();
 const none=await operatorOf()(bare.env,{mode:'supersede',confirmGo:true,expectedProgrammeRunId:OLD,expectedRevision:1});
 assert.equal(none.body.reason,'published_not_open');assert.equal(none.body.writes,0);
 const status=await operatorOf()(bare.env,{});
 assert.equal(status.body.published,null);assert.equal(status.body.blocked,'published_not_open');assert.deepEqual(status.body.chains,{items:[],truncated:false});
 // an unreadable database is reported, never guessed
 const broken={DB:{prepare(){throw new Error('D1_ERROR: network');},batch(){throw new Error('must not write');}}};
 const unreadable=await operatorOf()(broken,{mode:'supersede',confirmGo:true,expectedProgrammeRunId:OLD,expectedRevision:1});
 assert.equal(unreadable.body.reason,'film_person_not_open','a marker that cannot be read is not open');assert.equal(unreadable.body.writes,0);
 assert.equal((await operatorOf()(broken,{})).status,200,'status of an unreadable database still answers');
}
// a terminal chain (complete, or stopped with a class the reconcile does not recover) does not block the switch and is not this tool's
{
 const made=await seed(world());
 const chain=chainRow(made.file,OLD);
 sqlite(made.file,"UPDATE canonical_producer_chain SET owner_state='stopped',stopped_by='fail_closed',recovery_class='fail_closed',revision=revision+1 WHERE programme_run_id='"+OLD+"'");
 const out=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,expectedProgrammeRunId:OLD,expectedRevision:Number(chain.revision)+1});
 assert.equal(out.body.reason,'chain_not_open');assert.equal(out.body.writes,0);
 assert.equal((await operatorOf()(made.env,{})).body.chains.items.length,0,'a terminal stopped chain is not listed');
}

// ===== 3. the happy path: exactly one row moves, nothing else =====
{
 const made=await seed(world());
 let creates=0;made.env.PRODUCER_WORKFLOW={create:async()=>{creates++;return {};}};
 const before=dump(made.file),stored=chainRow(made.file,OLD);
 const status=await operatorOf()(made.env,{});
 const {expect}=status.body.chains.items[0];
 const batches=made.env.DB.calls.batches;
 const out=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,...expect});
 assert.equal(out.status,200,JSON.stringify(out));
 assert.deepEqual(out.body,{ok:true,mode:'supersede',superseded:true,writes:1,chain:{programmeRunId:OLD,ownerState:'superseded',revision:Number(stored.revision)+1},nonTerminalChains:0});
 assert.equal(made.env.DB.calls.batches,batches+1,'exactly one batch');
 assert.equal(creates,0,'no Workflow instance is created');
 const after=dump(made.file);
 sameExcept(before,after,['canonical_producer_chain','film_person_cas']);
 const moved=chainRow(made.file,OLD);
 assert.deepEqual({...moved,owner_state:stored.owner_state,revision:stored.revision,updated_at:stored.updated_at},stored,'only the state, the revision and updated_at change: no lease, epoch, nonce or counter');
 assert.equal(moved.owner_state,'superseded');assert.equal(moved.updated_at,new Date(NOW).toISOString());
 assert.deepEqual(chainRow(made.file,EARLIER),JSON.parse(before.canonical_producer_chain).find(row=>row.programme_run_id===EARLIER),'the earlier chain is untouched');
 // the membership switch gate now sees no open chain
 assert.equal(Number(rows(made.file,PRODUCER_OPEN_CHAINS_SQL)[0].n),0);
 assert.deepEqual(await operatorReads({held:()=>true}).producerState(made.env),{ok:true,held:true,nonTerminal:0});
 // a repeat is refused with zero writes, and status lists nothing
 const again=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,...expect});
 assert.equal(again.body.reason,'already_superseded');assert.equal(again.body.writes,0);
 assert.deepEqual((await operatorOf()(made.env,{})).body.chains,{items:[],truncated:false});
 assert.equal(made.env.DB.calls.batches,batches+1);
}

// ===== 4. races between the operator's read and its write =====
{
 // the chain moves (a takeover bumps its revision) after the read: the revision CAS refuses the whole batch
 const made=await seed(world());
 const pins={expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)};
 const racing=async(env,input)=>{sqlite(made.file,"UPDATE canonical_producer_chain SET takeover_count=takeover_count+1,revision=revision+1 WHERE programme_run_id='"+OLD+"'");return Chain.supersedeChain(env,input);};
 const before=chainRow(made.file,OLD);
 const out=await operatorOf({supersede:racing})(made.env,{mode:'supersede',confirmGo:true,...pins});
 assert.equal(out.status,409);assert.equal(out.body.reason,'producer_cas_lost');assert.equal(out.body.writes,0);
 const after=chainRow(made.file,OLD);
 assert.equal(after.owner_state,'pending','the chain is not superseded');assert.equal(Number(after.revision),Number(before.revision)+1,'only the concurrent change landed');
}
{
 // the Film/Person marker leaves `open` before supersedeChain reads the route: refused before any batch
 const made=await seed(world());
 const pins={expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)};
 const racing=async(env,input)=>{sqlite(made.file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");return Chain.supersedeChain(env,input);};
 const before=chainRow(made.file,OLD),batches=made.env.DB.calls.batches;
 const out=await operatorOf({supersede:racing})(made.env,{mode:'supersede',confirmGo:true,...pins});
 assert.equal(out.status,409);assert.equal(out.body.reason,'film_person_held');assert.equal(out.body.writes,0);
 assert.equal(made.env.DB.calls.batches,batches,'no batch was sent');
 assert.deepEqual(chainRow(made.file,OLD),before,'the chain is unchanged');
}
// Races INSIDE the write: the concurrent change lands after every read of the operator and of supersedeChain, right before the batch applies. Each must roll the whole batch back.
{
 const race=async(sql,reason)=>{
  const made=await seed(world());
  const pins={expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)};
  made.beforeBatch=()=>sqlite(made.file,sql);
  const before=chainRow(made.file,OLD);
  const out=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,...pins});
  assert.equal(out.status,409,JSON.stringify(out));assert.equal(out.body.reason,reason);assert.equal(out.body.writes,0);
  const after=chainRow(made.file,OLD);
  assert.equal(after.owner_state,before.owner_state,'the chain is not superseded ('+reason+')');
  return {made,before,after};
 };
 // a newer run is published: the published-authority pin fails
 const newer=await race("UPDATE published_epg_authority SET programme_run_id='run-newer',generation=519 WHERE id=1",'published_moved');
 assert.deepEqual(newer.after,newer.before);
 // the published generation moves on the same run
 await race("UPDATE published_epg_authority SET generation=519 WHERE id=1",'published_moved');
 // the target chain's own run becomes the published one: both published guards fail
 await race("UPDATE published_epg_authority SET programme_run_id='"+OLD+"',generation=519 WHERE id=1",'published_moved');
 // the Film/Person marker leaves `open`: the marker fence fails
 await race("UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1",'film_person_fence');
 // a takeover bumps the chain's revision: the revision CAS fails
 const moved=await race("UPDATE canonical_producer_chain SET takeover_count=takeover_count+1,revision=revision+1 WHERE programme_run_id='"+OLD+"'",'producer_cas_lost');
 assert.equal(Number(moved.after.revision),Number(moved.before.revision)+1,'only the concurrent change landed');
}
// The owner batch carries the published guards; the hourly reconcile's batch is unchanged (marker fence, update, changes() only).
{
 const made=await seed(world());
 const pins={expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)};
 let texts=null;made.beforeBatch=statements=>{texts=statements.map(item=>item.text);};
 assert.equal((await operatorOf()(made.env,{mode:'supersede',confirmGo:true,...pins})).status,200);
 assert.equal(texts.length,5,'fence, two published guards, update, changes()');
 assert.match(texts[1],/published_epg_authority WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id='run-new' AND generation=518/);
 assert.match(texts[2],/NOT EXISTS \(SELECT 1 FROM published_epg_authority WHERE id=1 AND programme_run_id='run-old'\)/);
 const plain=await seed(world());
 plain.env.PRODUCER_WORKFLOW={create:async()=>({})};
 plain.batchSizes.length=0;
 const out=await reconcileProducerChain(plain.env,{now:NOW,hold:false});
 assert.equal(out.supersede,1,JSON.stringify(out));assert.equal(chainRow(plain.file,OLD).owner_state,'superseded');
 assert.equal(plain.batchSizes[0],5,'the reconcile supersedes an in-flight chain with the marker fence, the update and changes(), then (ADR 0208) its asserted outcome row: no published guard');
}
// Ambiguous outcomes are never reported as zero writes and never retried.
{
 const wrap=(made,{after,before})=>{const real=made.env.DB;made.env.DB={calls:real.calls,prepare:(...a)=>real.prepare(...a),batch:async statements=>{if(before?.())throw new Error('D1_ERROR: Network connection lost.');const r=await real.batch(statements);if(after?.())throw new Error('D1_ERROR: Network connection lost.');return r;}};return real;};
 // the batch commits and then its response is lost: the read-only reconciliation proves the transition
 {
  const made=await seed(world());const pins={expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)};
  let once=true;const real=wrap(made,{after:()=>{const fire=once;once=false;return fire;}});
  const batches=real.calls.batches;
  const out=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,...pins});
  assert.equal(out.status,200,JSON.stringify(out));
  assert.deepEqual(out.body,{ok:true,mode:'supersede',superseded:true,writes:1,reconciled:true,chain:{programmeRunId:OLD,ownerState:'superseded',revision:pins.expectedRevision+1},nonTerminalChains:0});
  assert.equal(real.calls.batches,batches+1,'one batch only, no retry');
 }
 // the batch commits and every read after it fails: the outcome is not proven either way
 {
  const made=await seed(world());const pins={expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)};
  const real=made.env.DB;let broken=false;
  made.env.DB={calls:real.calls,prepare:(...a)=>{if(broken)throw new Error('D1_ERROR: Network connection lost.');return real.prepare(...a);},batch:async statements=>{const r=await real.batch(statements);broken=true;return r;}};
  const batches=real.calls.batches;
  const out=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,...pins});
  assert.equal(out.status,202,JSON.stringify(out));
  assert.deepEqual(out.body,{ok:false,mode:'supersede',reason:'readback_unproven',writes:null,expect:pins,observed:null});
  assert.equal(real.calls.batches,batches+1,'no retry');
  assert.equal(chainRow(made.file,OLD).owner_state,'superseded','the batch did commit: claiming zero writes would have been false');
  // once reads work again, status lists nothing and a repeat is refused without writing
  broken=false;
  assert.deepEqual((await operatorOf()(made.env,{})).body.chains,{items:[],truncated:false});
  assert.equal((await operatorOf()(made.env,{mode:'supersede',confirmGo:true,...pins})).body.reason,'already_superseded');
  assert.equal(real.calls.batches,batches+1);
 }
 // the transport fails and the batch did not apply: still not proven (it could land later), the observed row is reported, no retry; a repeat with the same pins is safe
 {
  const made=await seed(world());const pins={expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)};
  let once=true;const real=wrap(made,{before:()=>{const fire=once;once=false;return fire;}});
  const before=dump(made.file),batches=real.calls.batches;
  const out=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,...pins});
  assert.equal(out.status,202,JSON.stringify(out));
  assert.deepEqual(out.body,{ok:false,mode:'supersede',reason:'write_uncertain',writes:null,expect:pins,observed:{ownerState:'pending',revision:pins.expectedRevision}});
  assert.equal(real.calls.batches,batches,'the failed batch never reached the database and nothing retried it');
  sameExcept(before,dump(made.file));
  const again=await operatorOf()(made.env,{mode:'supersede',confirmGo:true,...pins});
  assert.equal(again.status,200);assert.equal(again.body.writes,1);assert.equal(again.body.reconciled,undefined);
 }
 // an injected failure with no code, and a route that is skipped, are handled the same ways
 {
  const made=await seed(world());const pins={expectedProgrammeRunId:OLD,expectedRevision:Number(chainRow(made.file,OLD).revision)};
  const out=await operatorOf({supersede:async()=>{throw new Error('boom');}})(made.env,{mode:'supersede',confirmGo:true,...pins});
  assert.equal(out.status,202);assert.equal(out.body.reason,'write_uncertain');assert.equal(out.body.writes,null);
  const skipped=await operatorOf({supersede:async()=>({state:'skipped',reason:'film_person_route_not_open'})})(made.env,{mode:'supersede',confirmGo:true,...pins});
  assert.equal(skipped.body.reason,'film_person_route_not_open');assert.equal(skipped.body.writes,0);
  assert.equal(chainRow(made.file,OLD).owner_state,'pending');
 }
}

// ===== 5. the open-chain predicate is the membership switch gate's =====
{
 const made=await seed(world({takeovers:0}));
 // one chain per state, inserted through the real launch and then moved by plain updates (the triggers allow it while the marker is open)
 const states=[['p-pending',"owner_state='pending'"],['p-active',"owner_state='active',claim_nonce='abcdef0123'"],['p-released',"owner_state='released'"],['p-complete',"owner_state='complete'"],
  ...['transient','authority','terminal','receipt','fail_closed','exhausted'].map(klass=>['p-stopped-'+klass,"owner_state='stopped',stopped_by='x',recovery_class='"+klass+"'"]),['p-superseded',"owner_state='superseded'"]];
 for(const [p,set] of states){
  publish(made.file,p,1);
  assert.equal((await Chain.launchChain(made.env,{programmeRunId:p,generation:1,at:LAUNCH,nowMs:Date.parse(LAUNCH)})).state,'launched');
  sqlite(made.file,'UPDATE canonical_producer_chain SET '+set+",revision=revision+1 WHERE programme_run_id='"+p+"'");
 }
 publish(made.file,NEW,518);
 const gate=Number(rows(made.file,PRODUCER_OPEN_CHAINS_SQL)[0].n);
 const ours=Number(rows(made.file,'SELECT COUNT(*) AS n FROM canonical_producer_chain WHERE '+PRODUCER_OPEN_CHAIN_PREDICATE)[0].n);
 assert.equal(ours,gate,'the operator and the switch gate count the same chains');
 const listed=(await operatorOf()(made.env,{})).body.chains.items.map(item=>item.programmeRunId).sort();
 assert.deepEqual(listed,[OLD,'p-active','p-pending','p-released','p-stopped-authority','p-stopped-receipt','p-stopped-transient'].sort());
 assert.equal(listed.length,gate);
}
// the list is bounded: more open chains than the limit are reported as truncated, never read whole
{
 const made=world();
 for(let i=0;i<PRODUCER_CHAIN_OPERATOR_LIMIT+3;i++){
  const p='p-'+String(i).padStart(2,'0');publish(made.file,p,i);
  await Chain.launchChain(made.env,{programmeRunId:p,generation:i,at:LAUNCH,nowMs:Date.parse(LAUNCH)});
 }
 publish(made.file,NEW,518);
 const status=await operatorOf()(made.env,{});
 assert.equal(status.body.chains.items.length,PRODUCER_CHAIN_OPERATOR_LIMIT);assert.equal(status.body.chains.truncated,true);
 assert.ok(status.body.chains.items.every(item=>item.eligible),'expired pending chains of older runs are eligible one at a time');
}

// ===== 6. why the tool exists: while the hold is on, the hourly reconcile supersedes nothing =====
{
 const made=await seed(world());
 made.env.PRODUCER_WORKFLOW={create:async()=>{throw new Error('must not be called');}};
 const before=dump(made.file);
 assert.deepEqual(await reconcileProducerChain(made.env,{now:NOW,hold:true}),{ran:false,reason:HELD_BY_DELIVERY});
 sameExcept(before,dump(made.file));
 assert.equal(chainRow(made.file,OLD).owner_state,'pending','the stale chain stays open under the hold');
}

// ===== 7. wiring: the Worker binds the tool to the real hold and nothing else =====
{
 const worker=fs.readFileSync('src/worker.js','utf8');
 assert.match(worker,/async function handleProducerChainOperatorTool\(env,args\)\{\n return CanonicalProducerChain\.producerChainOperator\(\{held:\(\)=>CanonicalProducerWorkflow\.PRODUCER_DELIVERY_HOLD\}\)\(env,args\);\n\}/);
 assert.equal((worker.match(/producerChainOperator\(/g)||[]).length,1,'one call site');
 const mcp=fs.readFileSync('src/mcp.js','utf8');
 assert.match(mcp,/mcpRejectFields\(params\.name,args,\['mode','confirmGo','expectedProgrammeRunId','expectedRevision'\]\)/);
 const source=fs.readFileSync('src/canonical-producer-chain.js','utf8');
 const body=source.slice(source.indexOf('export function producerChainOperator'),source.indexOf('export function parseReleasePin'));
 assert.doesNotMatch(body,/\b(INSERT|UPDATE|DELETE)\b/,'the operator itself has no write SQL: the only write is supersedeChain');
 assert.doesNotMatch(body,/\.batch\(|\.run\(|PRODUCER_WORKFLOW|create\(/,'no batch, no run, no Workflow');
}

console.log('producer-chain-operator: ok');
