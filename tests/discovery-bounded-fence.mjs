// AIR-444: the segment writes of a bounded archive commit take the full fence every few writes or every few seconds instead of before each one.
// On 11 Nov 2026 each full fence cost about 4 s in production, so the 64 serial fences were 273 s of a 348 s `seal_stage`. A segment is a create-only
// object that nothing reads until the archive pointer moves; the pointer moves only after a full fence and a compare-and-swap, which stay. Every
// full fence is also a mutation boundary of the EPG step, so a long step renews its step lease and a step that lost it stops before the next write.
// Same harness as the other bounded tests (real planner, sqlite stand-in of D1, in-memory bucket); no Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import {context,call,DAY,BASE,scan,runId,POINTER,world,envOf,bootstrap} from './discovery-bounded-lib.mjs';

const logs=[];
context.console.log=line=>{try{logs.push(JSON.parse(line));}catch{}};
const phase=(name,edge='exit')=>logs.filter(item=>item.event==='epg_phase'&&item.phase===name&&item.edge===edge);

// Day 0 installs a full ledger; day 2 is a bounded commit whose scan keeps only a few rows, so nearly every row departs and touches most segments.
async function setup(){
 const state=world();
 await bootstrap(state,0);
 return state;
}
async function stage(state,{latest,env=envOf(state,'bounded'),day=2}={}){
 const id=runId(day),at=new Date(BASE+day*DAY).toISOString();
 await state.bkt.put('sync.json',JSON.stringify({runId:id,stage:'epg',startedAt:at,updatedAt:at}));
 const run={runId:id,stage:'epg',startedAt:at,watchlist:[],events:[]};
 context.DB_RESET?.();
 return context.stageSealedGeneration(env,run,{holder:{discovery:latest},meta:{programmeRunId:id,updatedAt:at},pending:{'programme.json':{runId:id,updatedAt:at},'discovered-films.json':{}},nextWatchlist:{updatedAt:at,films:[]},uncertain:[],publication:{programmeRunId:state.published.programmeRunId,phase:'published',fence:state.published.fence}});
}
const latestFew=()=>scan(2).slice(0,5);

// The recording of what happens, in order: every full fence (the Discovery lease renewal is its first remote call) and every archive write.
function record(state){
 const events=[];
 const realRenew=context.renewDiscoveryLease,realPut=state.bkt.onPut;
 context.renewDiscoveryLease=async(...args)=>{events.push('fence');return realRenew(...args);};
 state.bkt.onPut=async key=>{
  if(key.startsWith('epg/discovery-archive/v1/segments/'))events.push('segment');
  else if(key.startsWith('epg/discovery-archive/v1/manifests/'))events.push('manifest');
  else if(key===POINTER)events.push('pointer');
  if(realPut)await realPut(key);
 };
 return {events,restore(){context.renewDiscoveryLease=realRenew;state.bkt.onPut=realPut;}};
}

// 1. The fence count: before, one per segment write plus the manifest and the pointer; now one per 8 writes plus those two.
{
 const state=await setup();const rec=record(state);logs.length=0;
 await stage(state,{latest:latestFew()});rec.restore();
 const segments=rec.events.filter(item=>item==='segment').length,fences=rec.events.filter(item=>item==='fence').length;
 assert.ok(segments>=24,'the scan leaves most of the ledger behind: '+segments+' segments are rewritten');
 const [archive]=phase('seal_stage_archive');assert.ok(archive,'the archive phase is logged');
 assert.equal(archive.segments,segments);assert.equal(archive.fences,fences,'the log counts the full fences');assert.equal(archive.fencesSkipped,segments-Math.ceil(segments/8),'and the skipped ones');
 assert.ok(fences<=Math.ceil(segments/8)+2,'at most one fence per 8 segment writes plus the manifest and the pointer: '+fences+' for '+segments);
 assert.ok(fences<segments+2,'fewer than the '+(segments+2)+' of one fence per write');
 assert.equal(rec.events[0],'fence','the first write is fenced');
 const tail=rec.events.slice(-4);
 assert.deepEqual(tail.slice(-3),['manifest','fence','pointer'],'the manifest, a full fence and then the pointer swap: '+tail.join(','));
 assert.equal(rec.events[rec.events.lastIndexOf('manifest')-1],'fence','the manifest write is fenced too');
 for(const field of ['elapsedMs','fenceMs','putMs','bytes'])assert.ok(Number.isFinite(archive[field])&&archive[field]>=0,field+' is a number');
 assert.deepEqual(Object.keys(archive).sort(),['at','bytes','edge','elapsedMs','event','fenceMs','fences','fencesSkipped','phase','putMs','runId','segments'].sort(),'sanitized: counts and milliseconds only, no key, title or payload');
 const [plan]=phase('seal_stage_plan');assert.ok(plan&&plan.departures>0&&Number.isFinite(plan.elapsedMs));
 const [emit]=phase('seal_stage_emit');assert.ok(emit&&emit.items>0&&emit.bytes>0);
}

// 2. Slow rounds: with a clock that spends 6 s on each write, the time bound (20 s) keeps the Discovery lease (90 s) renewed.
{
 const state=await setup();const rec=record(state);
 const RealDate=context.Date;let skew=0;
 context.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[RealDate.now()+skew]));}static now(){return RealDate.now()+skew;}};
 const priorOnPut=state.bkt.onPut;state.bkt.onPut=async key=>{if(key.startsWith('epg/discovery-archive/v1/segments/'))skew+=6000;await priorOnPut(key);};
 try{await stage(state,{latest:latestFew()});}finally{context.Date=RealDate;rec.restore();}
 let sinceFence=0,worst=0;
 for(const item of rec.events){if(item==='fence')sinceFence=0;else if(item==='segment'){sinceFence++;worst=Math.max(worst,sinceFence);}}
 assert.ok(worst<=4,'at 6 s a write no more than 4 writes (24 s) pass between two fences: '+worst);
 assert.ok(rec.events.filter(item=>item==='fence').length>Math.ceil(rec.events.filter(item=>item==='segment').length/8)+2,'slow rounds fence more often than the call bound alone');
}

// 3. The fence still stops the archive: a lost Discovery lease part-way fails closed before the manifest and the pointer, nothing is published.
{
 const state=await setup();const rec=record(state);
 const real=context.renewDiscoveryLease;let calls=0;
 context.renewDiscoveryLease=async(...args)=>{calls++;if(calls===3)return false;return real(...args);};
 const before=state.bkt.objects.get(POINTER)?.etag??null;
 await assert.rejects(stage(state,{latest:latestFew()}),/Discovery archive fence lost: lease/);
 rec.restore();context.renewDiscoveryLease=real;
 assert.equal(state.bkt.objects.get(POINTER)?.etag??null,before,'the archive pointer did not move');
 assert.ok(![...state.bkt.objects.keys()].some(key=>key.includes('/manifests/')),'no manifest was written');
 assert.ok(!rec.events.includes('pointer'));
}

// 4. The EPG step guard is part of every full fence: a step that keeps working renews its step lease, one that lost it stops at the next fence
// with the typed fence error, and a path with no EPG step (the external one) calls nothing.
{
 const state=await setup();const rec=record(state);
 let asserts=0;
 context.EpgOrchestration={async assertStep(env){asserts++;}};
 const env=Object.assign(envOf(state,'bounded'),{epgStep:{holder:'h',modeRevision:1}});
 await stage(state,{latest:latestFew(),env});
 const [archive]=phase('seal_stage_archive').slice(-1);
 assert.equal(asserts,archive.fences+2,'the step guard runs once per full fence (not for the skipped ones) plus the two boundaries around the staging: its start and the final save of the run');
 rec.restore();

 const second=await setup();const rec2=record(second);
 let n=0;
 context.EpgOrchestration={async assertStep(){n++;if(n===3)throw Object.assign(new Error('epg_step_fenced'),{code:'epg_step_fenced',detail:'lease_expired'});}};
 const env2=Object.assign(envOf(second,'bounded'),{epgStep:{holder:'h',modeRevision:1}});
 await assert.rejects(stage(second,{latest:latestFew(),env:env2}),error=>error.code==='epg_step_fenced'&&error.detail==='lease_expired');
 rec2.restore();
 assert.equal(second.bkt.objects.get(POINTER)?.etag??null,null,'a step that lost its lease never moves the archive pointer');
 assert.ok(!rec2.events.includes('manifest'));

 const third=await setup();let none=0;
 context.EpgOrchestration={async assertStep(){none++;}};
 await stage(third,{latest:latestFew()});
 assert.equal(none,0,'without an EPG step nothing is asserted');
 delete context.EpgOrchestration;
}

console.log('Bounded archive fence: one full fence per 8 writes or 20 s plus the manifest and the pointer, lost leases still stop the archive before the pointer, the EPG step guard is part of every full fence, and the phase log is sanitized passed');
