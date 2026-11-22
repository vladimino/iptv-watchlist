// AIR-571 Tier 0 QA worker: runs INSIDE a LOCAL workerd (Miniflare) with a local D1 binding and a local R2 binding. It imports the production modules and exposes bounded probe routes.
// It never reads a secret, a production binding or the network: the harness (scripts/tier0-workerd-qa.mjs) gives it only a private local D1 and R2.
import * as WatchlistD1 from '../../src/watchlist-d1.js';
import * as Mirror from '../../src/watchlist-mirror.js';
import * as PublishedEpg from '../../src/published-epg.js';
import * as Sync from '../../src/letterboxd-sync.js';
import * as Phase from '../../src/letterboxd-sync-watchlist.js';
import {watchlistRepository} from '../../src/letterboxd-sync-repository.js';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const film=i=>({id:'f'+i,title:'Film number '+i+' with a realistic title length',year:1950+(i%75),url:'https://letterboxd.com/film/f'+i+'/'});
const list=(a,b)=>Array.from({length:b-a},(_,i)=>film(a+i));
const T=s=>Date.parse(s);

// A counting wrapper of the real D1 binding: it forwards every call and counts what the production code sends.
function counted(db){
 const stats={byGroup:{},prepares:0,reads:0,runs:0,batches:0,statements:0,maxStatementsPerBatch:0,maxBinds:0,maxSqlChars:0,rowsWritten:0,rowsRead:0,hook:null};
 const groupOf=sql=>{const m=/^\s*(INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(\w+)/i.exec(sql);return m?m[1].toUpperCase().replace(/ OR \w+/,'').replace(' INTO','')+' '+m[2]:'other';};
 const wrapBound=(sql,bound)=>({_s:bound,_sql:sql,
  first:async(...a)=>{stats.reads++;const r=await bound.first(...a);return r;},
  all:async()=>{stats.reads++;const r=await bound.all();stats.rowsRead+=Number(r?.meta?.rows_read||0);return r;},
  run:async()=>{stats.runs++;const r=await bound.run();stats.rowsWritten+=Number(r?.meta?.rows_written||0);return r;},
  raw:async()=>{stats.reads++;return bound.raw();}});
 const wrap=sql=>{
  stats.prepares++;stats.maxSqlChars=Math.max(stats.maxSqlChars,sql.length);
  const stmt=db.prepare(sql);
  const w=wrapBound(sql,stmt);
  w.bind=(...p)=>{stats.maxBinds=Math.max(stats.maxBinds,p.length);return wrapBound(sql,stmt.bind(...p));};
  return w;
 };
 return {stats,db:{prepare:wrap,
  async batch(statements){
   stats.batches++;stats.statements+=statements.length;stats.maxStatementsPerBatch=Math.max(stats.maxStatementsPerBatch,statements.length);
   if(stats.hook){const hook=stats.hook;stats.hook=null;await hook(db);}
   const out=await db.batch(statements.map(x=>x._s||x));
   out.forEach((r,i)=>{const w=Number(r?.meta?.rows_written||0);stats.rowsWritten+=w;stats.rowsRead+=Number(r?.meta?.rows_read||0);const g=groupOf(statements[i]?._sql||'');const e=stats.byGroup[g]||(stats.byGroup[g]={statements:0,rowsWritten:0});e.statements++;e.rowsWritten+=w;});
   return out;
  },
  exec:s=>db.exec(s)}};
}
const TABLES=['watchlist_staging','watchlist_snapshot','watchlist_member','watchlist_change','watchlist_effect','watchlist_admission_pending'];
const count=async(db,t)=>Number((await db.prepare('SELECT COUNT(*) AS n FROM '+t).first()).n);
const counts=async db=>Object.fromEntries(await Promise.all(TABLES.map(async t=>[t,await count(db,t)])));
const settle=async(db,r,at)=>{
 for(const effect of WatchlistD1.EFFECTS){const done=await WatchlistD1.completeEffect({DB:db},{snapshotId:r.snapshotId,effect,receipt:'r'},{now:T(at)});if(!done.ok)throw new Error('effect '+effect+JSON.stringify(done));}
 await db.prepare("UPDATE watchlist_admission_pending SET state='resolved', resolved_by='tier0', updated_at=? WHERE state='pending'").bind(at).run();
};
const publish=(env,films,scanId,at,guards)=>WatchlistD1.publishSnapshot(env,films,{scanId,observedAt:at,completedAt:at},{now:T(at),...(guards?{guards}:{})});
const parity=async(env,expected)=>{
 const cur=await WatchlistD1.readCurrent(env,{now:Date.now()});
 if(!cur.ok)return {ok:false,reason:cur.reason};
 const ids=cur.snapshot.films.map(f=>f.lid);
 const digest=await WatchlistD1.listDigest(WatchlistD1.normalizeFilms(expected));
 return {ok:true,count:ids.length,orderEqual:JSON.stringify(ids)===JSON.stringify(expected.map(f=>f.id)),digestEqual:digest===cur.snapshot.listSha256};
};

const routes={
 // 1. the shape of the real D1 binding's batch([conditional UPDATE, SELECT changes()]) for 1 and 0 affected rows, and the strict decoder of recordMirror on real D1
 async '/shape'(body,env){
  const db=env.DB;
  await db.exec("CREATE TABLE IF NOT EXISTS qa_probe (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await db.prepare("INSERT OR REPLACE INTO qa_probe (id, v) VALUES (1, 0)").run();
  const redact=r=>({success:r.success,metaKeys:Object.keys(r.meta||{}).sort(),metaChanges:r.meta?.changes,metaRowsWritten:r.meta?.rows_written,resultsType:Array.isArray(r.results)?'array':typeof r.results,results:Array.isArray(r.results)?r.results:null});
  const one=await db.batch([db.prepare('UPDATE qa_probe SET v=v+1 WHERE id=?').bind(1),db.prepare('SELECT changes() AS changed')]);
  const zero=await db.batch([db.prepare('UPDATE qa_probe SET v=v+1 WHERE id=?').bind(999),db.prepare('SELECT changes() AS changed')]);
  const decode=batch=>{const changed=batch?.[batch.length-1]?.results?.[0]?.changed;return typeof changed==='number'&&(changed===0||changed===1)?changed:null;};
  // the production decoder, on a real pointer: delivered (applied true), the same again (a no-op), and a failed attempt whose attempts compare-and-swap is lost (changed = 0 inside the real batch)
  const marker=await WatchlistD1.readAuthority(env);
  const r1=await publish(env,list(0,5),'shape1','2026-11-22T09:00:00.000Z');
  let decoder=null;
  if(r1.ok&&marker.state==='d1'){
   await settle(db,r1,'2026-11-22T09:00:01.000Z');
   const cur=await WatchlistD1.readCurrent(env,{now:T('2026-11-22T09:00:02Z')});
   const p=cur.snapshot;
   const target={snapshotId:p.snapshotId,lastSuccessAt:p.lastSuccessAt,generation:marker.generation,now:T('2026-11-22T09:00:03Z')};
   const lost=await WatchlistD1.recordMirror(env,{...target,outcome:'failed',attempts:5,nextRetryAt:'2026-11-22T09:10:00.000Z'});
   const delivered=await WatchlistD1.recordMirror(env,{...target,outcome:'delivered'});
   const again=await WatchlistD1.recordMirror(env,{...target,outcome:'delivered'});
   decoder={lostCas:{ok:lost.ok,applied:lost.applied,reason:lost.reason},delivered:{ok:delivered.ok,applied:delivered.applied},again:{ok:again.ok,applied:again.applied,reason:again.reason}};
  }
  return {oneRow:{decoded:decode(one),results:one.map(redact)},zeroRows:{decoded:decode(zero),results:zero.map(redact)},decoder,publish1:{ok:r1.ok,reason:r1.reason}};
 },
 // 3. local D1 bind and batch limits
 async '/limits'(body,env){
  const db=env.DB;const out={binds:{},batch:{},sqlChars:{}};
  await db.exec("CREATE TABLE IF NOT EXISTS qa_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
  for(const n of [99,100,101,110,200]){
   const sql='SELECT COUNT(*) AS c FROM (SELECT 1 AS x) WHERE x IN ('+Array.from({length:n},()=>'?').join(',')+')';
   try{await db.prepare(sql).bind(...Array.from({length:n},(_,i)=>i)).all();out.binds[n]='accepted';}catch(e){out.binds[n]='rejected: '+String(e.message).slice(0,110);}
  }
  for(const n of [100,308,500,1000,2000,5000,10000,20000]){
   try{const t0=Date.now();const s=Array.from({length:n},(_,i)=>db.prepare('INSERT INTO qa_limits (v) VALUES (?)').bind('x'+i));const r=await db.batch(s);out.batch[n]='accepted ('+r.length+' results)';}catch(e){out.batch[n]='rejected: '+String(e.message).slice(0,110);}
  }
  for(const chars of [50000,100000,100500,102400,200000]){
   const lit="'"+'a'.repeat(chars-60)+"'";
   try{await db.prepare('INSERT INTO qa_limits (v) VALUES ('+lit+')').run();out.sqlChars[chars]='accepted';}catch(e){out.sqlChars[chars]='rejected: '+String(e.message).slice(0,110);}
  }
  return out;
 },
 // 4. promotions through the real D1 binding and the production code
 async '/promote'(body,env){
  const {step}=body;const c=counted(env.DB);const e2={DB:c.db};
  const before=await counts(env.DB);
  let result,expected;
  const t0=Date.now();
  let noSettle=false;
  if(step==='fill400'){expected=list(0,400);result=await publish(e2,expected,'p1','2026-11-22T10:00:00.000Z');noSettle=true;}
  else if(step==='overCapRefusedWhileLedgerFull'){expected=list(0,700);result=await publish(e2,expected,'pcap','2026-11-22T10:10:00.000Z');}
  else if(step==='grow700AfterSettle'){await settle(env.DB,{snapshotId:(await WatchlistD1.readCurrent({DB:env.DB},{now:T('2026-11-22T10:20:00Z')})).snapshot.snapshotId},'2026-11-22T10:20:00.000Z');expected=list(0,700);result=await publish(e2,expected,'p2','2026-11-22T10:30:00.000Z');}
  else if(step==='replace100'){expected=list(0,700).map((f,i)=>i<100?film(100000+i):f);result=await publish(e2,expected,'p3','2026-11-22T16:00:00.000Z');}
  else if(step==='noChange'){expected=list(0,700).map((f,i)=>i<100?film(100000+i):f);result=await publish(e2,expected,'p4','2026-11-22T22:00:00.000Z');}
  else if(step==='extra300New'){expected=list(0,700).map((f,i)=>i<100?film(100000+i):f).concat(list(200000,200300));result=await publish(e2,expected,'p5','2026-11-23T04:00:00.000Z');}
  else return {error:'unknown step'};
  const wallMs=Date.now()-t0;
  const after=await counts(env.DB);
  const settled=!noSettle&&result.ok&&result.outcome==='committed'?(await settle(env.DB,result,'2026-11-22T10:00:01.000Z'),true):false;
  const par=result.ok&&result.outcome!=='refused'?await parity({DB:env.DB},expected):null;
  const s=c.stats;
  return {step,ok:result.ok,outcome:result.outcome,reason:result.reason,version:result.version,added:result.added?.length,removed:result.removed?.length,
   byGroup:Object.fromEntries(Object.entries(s.byGroup).sort((a,b)=>b[1].rowsWritten-a[1].rowsWritten)),d1:{prepares:s.prepares,singleReads:s.reads,runs:s.runs,roundtrips:s.reads+s.runs+s.batches,batches:s.batches,statements:s.statements,maxStatementsPerBatch:s.maxStatementsPerBatch,maxBindParams:s.maxBinds,maxSqlChars:s.maxSqlChars,rowsWrittenMeta:s.rowsWritten,rowsReadMeta:s.rowsRead},
   rowsInserted:Object.fromEntries(TABLES.map(t=>[t,after[t]-before[t]])),settled,parity:par,workerWallMsCoarse:wallMs};
 },
 // CAS: a competing promotion (refusal) and bookkeeping-only contention (pinned replay) through the real adapter and the real binding
 async '/cas'(body,env){
  const out={};
  const ctxOf=db=>({env:{DB:db},epoch:1,now:()=>T('2026-11-23T10:00:00Z'),slotKey:'2026-11-23T1030',runId:'r'});
  const repo=watchlistRepository(WatchlistD1,{epochGuard:e=>[Sync.FENCE_GUARD_SQL,[e]]});
  const cur=await WatchlistD1.readCurrent(env,{now:T('2026-11-23T10:00:00Z')});
  const base=cur.snapshot.films.map(f=>({id:f.lid,title:f.title,year:f.year,url:f.url}));
  // (0) control: the same commitScan without contention, for the batch comparison
  {
   const c=counted(env.DB);
   const cc=await WatchlistD1.readCurrent(env,{now:T('2026-11-23T09:30:00Z')});
   const b0=cc.snapshot.films.map(f=>({id:f.lid,title:f.title,year:f.year,url:f.url}));
   const members=b0.slice(0,b0.length-1).concat([film(300000)]);
   const res=await repo.commitScan({...ctxOf(c.db),now:()=>T('2026-11-23T09:30:00Z')},{members,scan:{scanId:'cas-0',observedAt:'2026-11-23T09:30:00.000Z'}});
   out.control={outcome:res.outcome,batches:c.stats.batches};
   const after=await WatchlistD1.readCurrent(env,{now:T('2026-11-23T09:31:00Z')});await settle(env.DB,{snapshotId:after.snapshot.snapshotId},'2026-11-23T09:30:30.000Z');
  }
  // (a) bookkeeping contention: the mirror bookkeeping bumps the revision under the final batch: ONE pinned replay commits
  {
   const c=counted(env.DB);c.stats.hook=null;
   let armed=true;const db={...c.db,async batch(statements){if(armed&&statements.some(x=>true)&&statements.length>3&&!statements._seen){armed=false;await env.DB.prepare("UPDATE watchlist_current SET mirror_attempts=mirror_attempts+1, revision=revision+1").run();}return c.db.batch(statements);}};
   const members=base.slice(0,base.length-1).concat([film(300001)]);
   let res;try{res={outcome:(await repo.commitScan(ctxOf(db),{members,scan:{scanId:'cas-a',observedAt:'2026-11-23T10:00:00.000Z'}})).outcome};}catch(e){res={error:e.code||String(e.message)};}
   out.bookkeepingContention={result:res,batches:c.stats.batches};
   const after=await WatchlistD1.readCurrent(env,{now:T('2026-11-23T10:01:00Z')});out.bookkeepingContention.versionAfter=after.snapshot?.version;
   if(res.outcome==='committed'){await settle(env.DB,{snapshotId:after.snapshot.snapshotId},'2026-11-23T10:00:30.000Z');}
  }
  // (b) a competing PROMOTION between the scan's read and its final batch: refusal, no replay of the older list
  {
   const cur2=await WatchlistD1.readCurrent(env,{now:T('2026-11-23T11:00:00Z')});
   const base2=cur2.snapshot.films.map(f=>({id:f.lid,title:f.title,year:f.year,url:f.url}));
   const c=counted(env.DB);let armed=true;
   const db={...c.db,async batch(statements){if(armed&&statements.length>3){armed=false;const other=base2.slice(0,base2.length-1).concat([film(300002)]);const r=await publish({DB:env.DB},other,'cas-b-other','2026-11-23T11:00:10.000Z');if(r.ok&&r.outcome==='committed')await settle(env.DB,r,'2026-11-23T11:00:20.000Z');}return c.db.batch(statements);}};
   const mine=base2.slice(0,base2.length-1).concat([film(300003)]);
   let res;try{res={outcome:(await repo.commitScan(ctxOf(db),{members:mine,scan:{scanId:'cas-b',observedAt:'2026-11-23T11:00:00.000Z'}})).outcome};}catch(e){res={error:e.code||String(e.message)};}
   const after=await WatchlistD1.readCurrent(env,{now:T('2026-11-23T11:01:00Z')});
   out.competingPromotion={result:res,newerListKept:after.snapshot.films.some(f=>f.lid==='f300002'),olderListPromoted:after.snapshot.films.some(f=>f.lid==='f300003')};
  }
  // (c) two concurrent publishes: exactly one commits
  {
   const cur3=await WatchlistD1.readCurrent(env,{now:T('2026-11-23T12:00:00Z')});
   const base3=cur3.snapshot.films.map(f=>({id:f.lid,title:f.title,year:f.year,url:f.url}));
   const [x,y]=await Promise.all([publish({DB:env.DB},base3.slice(0,-1).concat([film(300010)]),'race-x','2026-11-23T12:00:00.000Z'),publish({DB:env.DB},base3.slice(0,-1).concat([film(300011)]),'race-y','2026-11-23T12:00:00.000Z')]);
   out.concurrentPublishes={outcomes:[x.ok?x.outcome:x.reason,y.ok?y.outcome:y.reason]};
  }
  return out;
 },
 // 5. a full LOCAL slot through the real Letterboxd modules, the real D1 binding and a real local R2 binding (ratings and reconcile phases are stubbed; the fake source is in-process)
 async '/slot'(body,env){
  const stages={};const c=counted(env.DB);const e2={DB:c.db,BUCKET:env.BUCKET};
  const films=list(0,Math.max(1,body.films||40));
  const pages=[];for(let i=0;i<films.length;i+=50)pages.push(films.slice(i,i+50));
  const fetchPage=async url=>({n:Number((/page\/(\d+)\/$/.exec(url)||[0,1])[1])});
  const parse=html=>({films:pages[html.n-1]||[],total:films.length,next:html.n<pages.length?'/me/watchlist/page/'+(html.n+1)+'/':null});
  const effectWriters={scan_facts:async(ctx,e)=>'r-'+e.effect+'-'+e.version,retention:async(ctx,e)=>'r-'+e.effect+'-'+e.version,removal_enqueue:async(ctx,e)=>'r-'+e.effect+'-'+e.version};
  const repository=watchlistRepository(WatchlistD1,{epochGuard:e=>[Sync.FENCE_GUARD_SQL,[e]],scanGuard:e=>[Sync.SCAN_GUARD_SQL,[e]],effectWriters});
  const phase=Phase.watchlistPhase({repository,scanOpen:e=>Sync.scanOpen(e),fetchPage,parse,firstUrl:'https://letterboxd.com/me/watchlist/',username:'me'});
  const wf={created:[],instances:new Map(),async create({id,params}){this.created.push(id);this.instances.set(id,{status:'running'});},async get(id){if(!this.instances.has(id))throw new Error('not found');return {status:async()=>({status:'running'})};}};
  const env3={...e2,LETTERBOXD_WORKFLOW:wf};
  const mirrorPort={mirror:{reconcile:(e,arg)=>Mirror.reconcileMirror(e,{...arg,deps:{WatchlistD1,PublishedEpg}})}};
  const now=T(body.at||'2026-11-24T09:35:00Z');
  const started=await Sync.ensure(env3,{now,ports:mirrorPort});
  stages.ensure={started:started.started,slot:started.slot};
  const step={async do(name,fn){return fn();},async sleepUntil(){}};
  const ports={ratings:{run:async()=>({done:true,outcome:'finished'})},watchlist:phase,reconcile:{run:async()=>({done:true,outcome:'done'})}};
  const result=await Sync.run(env3,{slotKey:started.slot,series:0,epoch:1},step,{now:()=>now+60000,ports});
  stages.run={stopped:result.stopped,reason:result.reason,status:result.status};
  // the next tick delivers the Events and reconciles the root mirror
  const ticks=[];for(let i=1;i<=6;i++){const tick=await Sync.ensure(env3,{now:now+i*60000,ports:mirrorPort});ticks.push({delivered:tick.delivery?.delivered,pending:tick.delivery?.pending,mirror:tick.delivery?.mirror?.outcome});}
  stages.ticks=ticks;
  const eventsList=await env.BUCKET.list({prefix:'events/items/'});
  const events=[];for(const o of eventsList.objects){const t=await (await env.BUCKET.get(o.key)).json();events.push({key:o.key.slice(-40),type:t.type,slot:t.slot,status:t.status,keys:Object.keys(t).sort().join(',')});}
  const root=await env.BUCKET.get('watchlist.json');
  const rootDoc=root?JSON.parse((await root.text()).split('\n')[0]):null;
  const slotRow=await env.DB.prepare('SELECT status, watchlist_outcome, ratings_outcome FROM letterboxd_slot WHERE slot_key=?').bind(started.slot).first();
  return {stages,slotRow,events,rootMirror:rootDoc?{source:rootDoc.source,snapshotVersion:rootDoc.snapshotVersion,films:rootDoc.films.length}:null,d1:{singleReads:c.stats.reads,batches:c.stats.batches,statements:c.stats.statements,maxBind:c.stats.maxBinds}};
 }
};
export default {async fetch(request,env){
 const url=new URL(request.url);const handler=routes[url.pathname];
 if(!handler)return json({error:'no route'},404);
 let body={};try{body=await request.json();}catch{/* no body */}
 try{return json(await handler(body,env));}catch(error){return json({error:String(error?.message||error).slice(0,300),stack:String(error?.stack||'').slice(0,400)},500);}
}};
