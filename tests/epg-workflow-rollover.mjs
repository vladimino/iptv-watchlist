// The controlled EPG Workflow rollover (ADR 0175): dry_run writes nothing; apply swaps the control record to the deterministic successor
// by one compare-and-set only for an owner provably asleep outside a step; every unsafe, unknown, stale or lost case refuses with zero writes;
// the old instance stops without a write; budget, cooldown, checkpoint and run survive; a repeat never swaps twice. No network, no production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as Policy from '../src/domain/orchestration-policy.js';
import {d1Standin} from './d1-standin.mjs';

const MIN=60000;
const T=Date.parse('2026-11-19T20:00:00Z');
const RUN_KEY='2026-11-19';
const at=ms=>new Date(ms).toISOString();
const plain=value=>JSON.parse(JSON.stringify(value));
const source=fs.readFileSync('src/epg-orchestration.js','utf8');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-rollover-'));
const chain=fs.readdirSync('migrations').filter(name=>name.endsWith('.sql')&&name<'0018').sort();
let databases=0;
class FixedDate extends Date{constructor(...args){if(args.length)super(...args);else super(T);}static now(){return T;}}

function binding(){
 const instances=new Map(),creates=[];
 return {instances,creates,failNext:null,
  async create({id,params}){
   creates.push({id,params});
   if(this.failNext==='lost'){this.failNext=null;throw new Error('network');}
   if(instances.has(id))throw new Error('already exists');
   instances.set(id,'running');
  },
  async get(id){if(this.statusUnknown)throw new Error('platform down');if(!instances.has(id))throw new Error('instance not found');return {status:async()=>({status:instances.get(id)})};}};
}
function world({control={},sync,mode={},lease=null,version='v-new',authority={ready:true},db:dbOptions={}}={}){
 const file=path.join(root,'r-'+(databases++)+'.sqlite');
 const db=d1Standin(file,dbOptions);
 for(const name of chain)db.sql(fs.readFileSync('migrations/'+name,'utf8'));
 const put=(key,value)=>db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('"+key+"','"+JSON.stringify(value)+"',1,'x')");
 put('mode',{schemaVersion:1,mode:'cloudflare',from:'external',target:null,epoch:1,drain:'verified',...mode});
 const budget={...Policy.emptyBudget(),consecutive:4,total:5};
 put('control',{schemaVersion:1,runKey:RUN_KEY,series:2,instanceId:'epg_20261119_2',epoch:1,phase:'waiting',runId:'run-1',checkpoint:{key:'run-1|epg|3|0|',phase:'epg',runId:'run-1',count:2000003},budget,cooldownUntil:null,quarantine:null,failure:{class:'transient',code:'timeout'},lastDurableProgressAt:at(T-10*MIN),nextWakeAt:at(T+30*MIN),lastStep:null,publishedRunId:null,doneAt:null,updatedAt:at(T-MIN),versionId:'v-old',...control});
 if(lease)put('lease',lease);
 const state={sync:sync===undefined?{runId:'run-1',stage:'epg',cursor:3,remaining:5,updatedAt:at(T-MIN)}:sync,authority:{...authority},calls:[]};
 const context=vm.createContext({console:{log(){}},Date:FixedDate,Math,JSON,Promise,Intl,URL,crypto:webcrypto});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy'),context);
 context.loadJSON=async(env,key)=>{if(key==='sync.json'){if(state.syncThrows)throw new Error('r2');return state.sync?JSON.parse(JSON.stringify(state.sync)):null;}return null;};
 context.PublishedEpg={readAuthority:async()=>state.authority,repairMirrors:async()=>({mirrored:true,aligned:true,wrote:false})};
 context.postSync=async(env,execution,pathname)=>{state.calls.push(pathname);return {status:200,json:async()=>({})};};
 vm.runInContext(source,context);
 const wf=binding();wf.instances.set('epg_20261119_2','waiting');
 const env={DB:db,EPG_WORKFLOW:wf,...(version?{CF_VERSION_METADATA:{id:version}}:{})};
 return {context,state,env,db,wf,epg:vm.runInContext('EpgOrchestration',context)};
}
const rows=db=>db.sql('SELECT key, revision, body FROM epg_orchestration_document ORDER BY key');
const ctl=async w=>(await w.epg.readControl(w.env)).record;
const pins=async(w,extra={})=>{const p=(await w.epg.rolloverPreflight(w.env,T)).expect;return {mode:'apply',confirmGo:true,requestId:'req-00000001',expectedRunKey:p.runKey,expectedEpoch:p.epoch,expectedSeries:p.series,expectedInstanceId:p.instanceId,expectedRunId:p.runId,expectedControlRevision:p.controlRevision,...extra};};
const apply=(w,args)=>w.epg.handleRolloverTool(w.env,args);
const dry=async w=>(await w.epg.handleRolloverTool(w.env,{mode:'dry_run'})).body;
// A refusal changes nothing: the documents (bodies and revisions) and the Workflow creates are exactly as before.
async function refused(w,args,reason,message){
 const before=plain(rows(w.db)),creates=w.wf.creates.length;
 const reply=await apply(w,args);
 assert.equal(reply.body.ok,false,message);assert.equal(reply.body.writes,0,message+' (writes)');
 if(reason)assert.equal(reply.body.reason,reason,message);
 assert.deepEqual(plain(rows(w.db)),before,message+' (documents untouched)');assert.equal(w.wf.creates.length,creates,message+' (no create)');
 return reply;
}

// 1. dry_run: eligible, pinned, and strictly zero writes.
{
 const w=world();
 const before=plain(rows(w.db));
 const body=await dry(w);
 assert.equal(body.decision,'eligible');assert.equal(body.writes,0);assert.deepEqual(plain(body.blockers),[]);assert.deepEqual(plain(body.unknowns),[]);
 assert.deepEqual(plain(body.expect),{runKey:RUN_KEY,epoch:1,series:2,instanceId:'epg_20261119_2',runId:'run-1',controlRevision:1});
 assert.equal(body.facts.deployedVersionId,'v-new');assert.equal(body.facts.control.versionId,'v-old');assert.equal(body.facts.sleepsUntil,at(T+30*MIN));
 assert.deepEqual(plain(rows(w.db)),before,'dry_run wrote nothing');assert.equal(w.wf.creates.length,0);
}

// 2. apply: one swap to series+1 of the same run, the successor created once, everything durable carried, readback.
{
 const w=world({lease:{schemaVersion:1,holder:'old',kind:'executor',modeRevision:1,acquiredAt:at(T-20*MIN),expiresAt:at(T-15*MIN),released:true}});
 const before=await ctl(w),leaseBefore=rows(w.db).find(r=>r.key==='lease'),modeBefore=rows(w.db).find(r=>r.key==='mode');
 const reply=await apply(w,await pins(w));
 assert.equal(reply.status,200,JSON.stringify(reply.body));assert.equal(reply.body.ok,true);assert.equal(reply.body.outcome,'handed_over_version_pending');assert.equal(reply.body.writes,2);
 assert.equal(reply.body.readback.accepted,true);assert.equal(reply.body.readback.versionConfirmed,false,'the version is confirmed only by the successor itself');
 const after=await ctl(w);
 assert.equal(after.series,3);assert.equal(after.instanceId,'epg_20261119_3');assert.equal(after.runKey,RUN_KEY);assert.equal(after.epoch,1);assert.equal(after.runId,'run-1');assert.equal(after.phase,'starting');
 assert.deepEqual(plain(after.budget),plain(before.budget),'budget carried, not reset');assert.deepEqual(plain(after.failure),plain(before.failure));assert.deepEqual(plain(after.checkpoint),plain(before.checkpoint));assert.equal(after.lastDurableProgressAt,before.lastDurableProgressAt);assert.equal(after.quarantine,null);
 assert.equal(after.rollover.fromInstanceId,'epg_20261119_2');assert.equal(after.rollover.toInstanceId,'epg_20261119_3');assert.equal(after.rollover.deployedVersionId,'v-new');assert.equal(after.createdVersionId,'v-new');assert.equal(after.versionId,null);assert.equal(after.handoff,undefined,'no claim is written: the old instance cannot recover an orphan claim');
 assert.deepEqual(w.wf.creates.map(c=>[c.id,plain(c.params)]),[['epg_20261119_3',{runKey:RUN_KEY,series:3,epoch:1}]],'exactly one successor, same params shape as ensure');
 assert.deepEqual(rows(w.db).find(r=>r.key==='lease'),leaseBefore,'the lease row is untouched');
 assert.equal(rows(w.db).find(r=>r.key==='mode').body,modeBefore.body);
 assert.deepEqual(w.state.calls,[],'nothing published, no step, no pipeline call');
 // The old instance wakes: not_owner, stop, no write, no create.
 const revision=(await w.epg.readControl(w.env)).revision,steps=[];
 const step={do:async(name,fn)=>{steps.push(name);return fn({attempt:1});},sleepUntil:async()=>{throw new Error('must not sleep');}};
 const ended=await w.epg.run(w.env,{runKey:RUN_KEY,series:2,epoch:1},step);
 assert.deepEqual(plain(ended),{stopped:true,reason:'not_owner',instanceId:'epg_20261119_2'});
 assert.equal((await w.epg.readControl(w.env)).revision,revision,'the old instance wrote nothing');assert.equal(w.wf.creates.length,1);assert.deepEqual(w.state.calls,[]);
 // The successor acts on the new version: it records its own and the next dry_run reads already_current.
 w.wf.instances.set('epg_20261119_3','waiting');
 const hold={nextWake:T+40*MIN};
 w.context.postSync=async(env,execution,pathname)=>({status:200,json:async()=>({state:'busy',nextCatchUpAt:at(hold.nextWake)})});
 const result=await w.epg.act(w.env,{runKey:RUN_KEY,series:3,epoch:1,id:'epg_20261119_3',now:()=>T,random:()=>0.5});
 assert.equal(result.kind,'sleep');
 const acted=await ctl(w);assert.equal(acted.versionId,'v-new');
 assert.equal((await dry(w)).decision,'already_current');
 // Rollover repeat with the same request id after the handover reads back, never swaps.
 const repeat=await apply(w,{mode:'apply',confirmGo:true,requestId:'req-00000001',expectedRunKey:RUN_KEY,expectedEpoch:1,expectedSeries:2,expectedInstanceId:'epg_20261119_2',expectedRunId:'run-1',expectedControlRevision:1});
 assert.equal(repeat.body.replay,true);assert.equal(repeat.body.writes,0);assert.equal(repeat.body.outcome,'handed_over');assert.equal(w.wf.creates.length,1);
}

// 3. Refusals, each with zero writes.
{
 const w=world();
 await refused(w,{...(await pins(w)),confirmGo:undefined},'confirm_required','no confirmGo');
 for(const [field,value] of [['expectedSeries',1],['expectedInstanceId','epg_20261119_9'],['expectedRunKey','2026-11-18'],['expectedEpoch',2],['expectedRunId','other'],['expectedControlRevision',7]]){
  const reply=await refused(w,{...(await pins(w)),[field]:value},'stale_pin','stale '+field);assert.deepEqual(plain(reply.body.stale),[field]);
 }
}
const unsafe=[
 ['active owner (running, no cooldown)',{control:{phase:'running',nextWakeAt:null}},'owner_not_sleeping'],
 ['wake already past',{control:{nextWakeAt:at(T-MIN)}},'owner_not_sleeping'],
 ['wake too soon',{control:{nextWakeAt:at(T+MIN)}},'wake_too_soon'],
 ['live step lease',{lease:{schemaVersion:1,holder:'h',kind:'executor',modeRevision:1,acquiredAt:at(T-MIN),expiresAt:at(T+4*MIN),released:false}},'lease_live'],
 ['quarantined run',{control:{quarantine:{reason:'budget',at:at(T-MIN)}}},'quarantined'],
 ['complete run',{control:{doneAt:at(T-MIN),phase:'done'}},'complete'],
 ['successor not started',{control:{phase:'starting',nextWakeAt:null}},'successor_not_started'],
 ['unclaimed seal',{sync:{runId:'run-1',stage:'seal',seal:{phase:'ledger',cursor:1,itemTotal:9},updatedAt:at(T-MIN)}},'seal_unclaimed'],
 ['another run in sync.json',{sync:{runId:'run-2',stage:'epg',cursor:1,updatedAt:at(T-MIN)}},'run_mismatch'],
 ['switching mode',{mode:{mode:'switching',target:'external'}},'switch_in_progress'],
 ['external mode',{mode:{mode:'external'}},'not_cloudflare'],
 ['epoch moved',{mode:{epoch:2}},'epoch_mismatch'],
 ['authority held',{authority:{ready:false}},'authority_held'],
 ['day rolled with no claim',{control:{runKey:'2026-11-18',instanceId:'epg_20261118_2'}},'day_rolled']
];
for(const [label,options,blocker] of unsafe){
 const w=world(options);
 if(options.control?.runKey==='2026-11-18')w.wf.instances.set('epg_20261118_2','waiting');
 const body=await dry(w);
 assert.equal(body.decision,'unsafe',label);assert.ok(body.blockers.includes(blocker),label+': '+JSON.stringify(body.blockers));
 await refused(w,await pins(w),'unsafe',label);
}
// A claimed seal of the day before midnight is admitted like the executor's own day-roll rule (the claim keeps the run alive).
{
 const w=world({control:{runKey:'2026-11-18',instanceId:'epg_20261118_2',handoff:{sealRunId:'run-1',fromSeries:1,toSeries:2,at:at(T-60*MIN)}},sync:{runId:'run-1',stage:'seal',seal:{phase:'catalog',cursor:0,itemTotal:3},updatedAt:at(T-MIN)}});
 w.wf.instances.set('epg_20261118_2','waiting');
 const body=await dry(w);assert.equal(body.decision,'eligible',JSON.stringify(body));
 const reply=await apply(w,await pins(w));assert.equal(reply.body.ok,true,JSON.stringify(reply.body));
 const after=await ctl(w);assert.equal(after.handoff.sealRunId,'run-1','the claim is carried unchanged');assert.equal(after.handoff.fromSeries,1,'and still does not name the old instance');assert.equal(after.series,3);
}
// Unknown facts are not eligible and not unsafe.
for(const [label,options,tweak,unknown] of [
 ['no version metadata',{version:null},null,'deployed_version_unavailable'],
 ['platform status unreadable',{},w=>{w.wf.statusUnknown=true;},'instance_status_unknown'],
 ['sync.json unreadable',{},w=>{w.state.syncThrows=true;},'sync_unreadable']]){
 const w=world(options);if(tweak)tweak(w);
 const body=await dry(w);assert.equal(body.decision,'unknown',label);assert.ok(body.unknowns.includes(unknown),label);
 const args=await pins(w);await refused(w,args,'unknown',label);
}
{
 const w=world();w.wf.instances.delete('epg_20261119_2');
 const body=await dry(w);assert.equal(body.decision,'unsafe');assert.ok(body.blockers.includes('owner_not_alive'),'an absent owner is for the ensure, not for the rollover');
}
{ // The instance already runs the deployed version.
 const w=world({control:{versionId:'v-new'}});
 assert.equal((await dry(w)).decision,'already_current');
 await refused(w,await pins(w),'already_current','version equal');
}
// A cooldown is a durable sleep too, and the failure budget (4 of 5) crosses unchanged.
{
 const w=world({control:{phase:'running',nextWakeAt:null,cooldownUntil:at(T+20*MIN)}});
 assert.equal((await dry(w)).decision,'eligible');
 await apply(w,await pins(w));
 const after=await ctl(w);assert.equal(after.cooldownUntil,at(T+20*MIN),'the cooldown is carried');assert.equal(after.budget.consecutive,4);assert.equal(after.budget.total,5);assert.equal(after.quarantine,null,'no quarantine is created or cleared');
}

// 4. Lost compare-and-set: a step takes the lease between the read and the swap, or the control moved.
{
 let w;
 let armed=false;
 w=world({db:{onQuery:async text=>{if(armed&&/^UPDATE epg_orchestration_document SET body=.*WHERE key='control'/s.test(text)){armed=false;w.db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder:'late',kind:'executor',modeRevision:1,acquiredAt:at(T),expiresAt:at(T+5*MIN),released:false})+"',1,'x')");}}}});
 const args=await pins(w);armed=true;
 const before=plain(rows(w.db).filter(r=>r.key==='control'));
 const reply=await apply(w,args);
 assert.equal(reply.body.ok,false);assert.equal(reply.body.reason,'cas_lost');assert.equal(reply.body.writes,0);
 assert.deepEqual(plain(rows(w.db).filter(r=>r.key==='control')),before,'the control record is untouched');assert.equal(w.wf.creates.length,0,'no create after a lost swap');
}
{
 const w=world();
 const args=await pins(w);
 w.db.sql("UPDATE epg_orchestration_document SET revision=revision+1 WHERE key='control'");
 await refused(w,args,'stale_pin','control moved after the preflight');
}

// 5. Unknown create: the swap stands, the same id is recreated by a repeat or by the hourly ensure, never a new candidate id, no budget spent.
{
 const w=world();
 w.wf.failNext='lost';
 const reply=await apply(w,await pins(w));
 assert.equal(reply.body.outcome,'successor_uncertain');assert.equal(reply.body.ok,false);assert.equal(reply.status,202);
 const swapped=await ctl(w);assert.equal(swapped.instanceId,'epg_20261119_3');assert.equal(swapped.phase,'starting');
 const revision=(await w.epg.readControl(w.env)).revision;
 // A repeat with other pins is refused; with the same pins it resumes the create only.
 const reused=await apply(w,{mode:'apply',confirmGo:true,requestId:'req-00000001',expectedRunKey:RUN_KEY,expectedEpoch:1,expectedSeries:5,expectedInstanceId:'epg_20261119_2',expectedRunId:'run-1',expectedControlRevision:1});
 assert.equal(reused.body.reason,'request_id_reused');
 const again=await apply(w,{mode:'apply',confirmGo:true,requestId:'req-00000001',expectedRunKey:RUN_KEY,expectedEpoch:1,expectedSeries:2,expectedInstanceId:'epg_20261119_2',expectedRunId:'run-1',expectedControlRevision:1});
 assert.equal(again.body.replay,true);assert.equal(again.body.ok,true);assert.equal((await w.epg.readControl(w.env)).revision,revision,'no second swap');
 assert.deepEqual(w.wf.creates.map(c=>c.id),['epg_20261119_3','epg_20261119_3'],'the same id, never another');
 assert.equal(w.wf.instances.get('epg_20261119_3'),'running');
 // A different request id against the swapped record names a stale owner and refuses.
 await refused(w,{mode:'apply',confirmGo:true,requestId:'req-00000002',expectedRunKey:RUN_KEY,expectedEpoch:1,expectedSeries:2,expectedInstanceId:'epg_20261119_2',expectedRunId:'run-1',expectedControlRevision:1},'stale_pin','second request id');
}
{
 const w=world();
 w.wf.failNext='lost';
 await apply(w,await pins(w));
 const budget=plain((await ctl(w)).budget);
 const result=await w.epg.ensure(w.env,{now:T,random:()=>0.5});
 assert.equal(result.started,true);assert.equal(result.instanceId,'epg_20261119_3');assert.equal(result.recovered,'rollover');
 assert.deepEqual(plain((await ctl(w)).budget),budget,'a recreate of the same id spends no budget');
 assert.deepEqual(w.wf.creates.map(c=>c.id),['epg_20261119_3','epg_20261119_3']);
}

// 6. Crash between swap and create (no create at all): the ensure creates the same id; a simultaneous natural handoff for the successor is an attach.
{
 const w=world();
 const reply=await apply(w,await pins(w));assert.equal(reply.body.ok,true);
 w.wf.instances.delete('epg_20261119_3');
 const result=await w.epg.ensure(w.env,{now:T,random:()=>0.5});assert.equal(result.started,true);
 const dup=await w.epg.ensure(w.env,{now:T+MIN,random:()=>0.5});assert.equal(dup.reason,'in_progress','a second ensure finds the successor alive');
 assert.equal(w.wf.creates.filter(c=>c.id==='epg_20261119_3').length,2);assert.ok(!w.wf.creates.some(c=>c.id==='epg_20261119_4'));
}

// 7. Input validation of the MCP entry.
{
 const w=world();
 for(const args of [null,[],{mode:'x'},{mode:'dry_run',confirmGo:'yes'},{mode:'apply',requestId:'short'},{mode:'apply',requestId:'req-00000001',expectedRunKey:'x'},{mode:'apply',requestId:'req-00000001',expectedRunKey:RUN_KEY,expectedEpoch:1,expectedSeries:-1}]){
  const reply=await w.epg.handleRolloverTool(w.env,args);assert.equal(reply.status,400,JSON.stringify(args));
 }
 assert.equal(rows(w.db).length,2,'mode and control only: validation wrote nothing');
}
console.log('EPG Workflow rollover: dry_run writes nothing, apply is one fenced swap for a sleeping owner, every unsafe/unknown/stale/lost case refuses with zero writes, the old instance stops, budget and run survive, replays and unknown creates reuse the same id passed');
