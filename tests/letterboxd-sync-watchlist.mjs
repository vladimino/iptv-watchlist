// AIR-570 / ADR 0186. The Watchlist phase of a Letterboxd Sync slot, OFFLINE against a mock repository (the AIR-569 contract). No network, no D1, no Cloudflare.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as W from '../src/letterboxd-sync-watchlist.js';

const T=s=>Date.parse(s);
const ids=n=>Array.from({length:n},(_,i)=>({id:'f'+i,title:'F'+i}));
// A fake Letterboxd: pages of `size` films; `html` is just the page index.
function site({films,size=3,mutate=null,failAt=null}){
 const pages=[];for(let i=0;i<films.length;i+=size)pages.push(films.slice(i,i+size));
 const calls=[];
 const pageOf=url=>{const m=/page\/(\d+)\/$/.exec(url);return m?Number(m[1]):1;};
 return {calls,
  async fetchPage(url){calls.push(url);if(failAt&&failAt(url,calls.length))throw Object.assign(new Error('http'),{status:failAt(url,calls.length)});return {url,n:pageOf(url),call:calls.length};},
  parse(html){let list=pages[html.n-1]||[];let total=films.length;if(mutate)({list,total}=mutate(html,list,total));return {films:list,total,next:html.n<pages.length?'/me/watchlist/page/'+(html.n+1)+'/':null};}};
}
const run=(repository,s,extra={})=>W.watchlistPhase({repository,fetchPage:s.fetchPage,parse:s.parse,firstUrl:'https://letterboxd.com/me/watchlist/',username:'me'}).run({env:{},slotKey:'2026-11-21T1030',runId:'r1',now:()=>T('2026-11-21T10:40:00Z'),...extra});
function repo(over={}){
 const log=[];
 return {log,ready:async()=>({ready:true}),drainEffects:async()=>{log.push('drain');return {drained:true};},commitScan:async(env,arg)=>{log.push(['commit',arg.members.length,arg.scan.slotKey]);return {outcome:'committed',version:42,lastSuccessAt:'2026-11-21T10:41:00.000Z',total:arg.members.length,baseline:false,added:[{lid:'f0'}],removed:[]};},
  recordAttempt:async(env,arg)=>{log.push(['attempt',arg.outcome,arg.code]);},admitNew:async()=>{log.push('admit');return {resolved:1,pending:0};},...over};
}

// 1. Complete scan: every page, repeat of page 1, one commit, then admission; order is drain -> commit -> admit.
{
 const s=site({films:ids(7)}),r=repo();
 const out=await run(r,s);
 assert.equal(out.outcome,'committed');assert.equal(out.snapshotVersion,42);assert.equal(out.total,7);assert.equal(out.addedCount,1);
 assert.deepEqual(r.log.map(x=>Array.isArray(x)?x[0]:x),['drain','commit','admit']);
 assert.equal(s.calls.length,4,'three pages plus the repeat read of page 1');
 assert.equal(s.calls[0],s.calls[3]);
}
// 1b. AIR-571 D2: in drain mode the effects are applied but no scan starts: nothing is fetched, nothing is committed, no attempt is recorded, and the outcome is an honest `disabled` / `draining`.
{
 const s=site({films:ids(7)}),r=repo();
 const phase=W.watchlistPhase({repository:r,scanOpen:async()=>({open:false}),fetchPage:s.fetchPage,parse:s.parse,firstUrl:'https://letterboxd.com/me/watchlist/',username:'me'});
 const out=await phase.run({env:{},slotKey:'2026-11-21T1030',runId:'r1',now:()=>T('2026-11-21T10:40:00Z')});
 assert.deepEqual([out.outcome,out.reason],['disabled','draining']);assert.deepEqual(r.log,['drain']);assert.equal(s.calls.length,0);
 // an unreadable mode row is not scanning either (fail closed)
 const r2=repo();const out2=await W.watchlistPhase({repository:r2,scanOpen:async()=>{throw new Error('d1');},fetchPage:s.fetchPage,parse:s.parse,firstUrl:'https://letterboxd.com/me/watchlist/',username:'me'}).run({env:{},slotKey:'2026-11-21T1030',runId:'r1',now:()=>T('2026-11-21T10:40:00Z')});
 assert.equal(out2.reason,'draining');assert.equal(s.calls.length,0);
 // the effects drain still follows the snapshot just promoted (afterRecorded is not a scan)
 assert.deepEqual(await phase.afterRecorded({env:{},now:()=>T('2026-11-21T10:41:00Z')}),{drained:true});
 // open scanning behaves as before
 const r3=repo();const out3=await W.watchlistPhase({repository:r3,scanOpen:async()=>({open:true}),fetchPage:s.fetchPage,parse:s.parse,firstUrl:'https://letterboxd.com/me/watchlist/',username:'me'}).run({env:{},slotKey:'2026-11-21T1030',runId:'r1',now:()=>T('2026-11-21T10:40:00Z')});
 assert.equal(out3.outcome,'committed');
}
// 2. T8: every incompleteness is classified, nothing is committed, no removal, and the attempt is recorded.
{
 const cases={
  'page missing / count mismatch':[site({films:ids(7),mutate:(h,l,t)=>({list:h.n===2?l.slice(1):l,total:t})}),'count_mismatch'],
  'total changes between pages':[site({films:ids(7),mutate:(h,l,t)=>({list:l,total:h.n===2?t+1:t})}),'total_changed'],
  'empty page with a positive total':[site({films:ids(7),mutate:(h,l,t)=>({list:h.n===2?[]:l,total:t})}),'empty_page'],
  'duplicate id across pages':[site({films:ids(7),mutate:(h,l,t)=>({list:h.n===2?[{id:'f0'},...l.slice(1)]:l,total:t})}),'duplicate'],
  'page 1 changes on the repeat read':[site({films:ids(7),mutate:(h,l,t)=>({list:(h.n===1&&h.call>3)?[{id:'zz'},...l.slice(1)]:l,total:t})}),'page1_changed'],
  'total missing':[site({films:ids(7),mutate:(h,l)=>({list:l,total:NaN})}),'total_missing'],
 };
 for(const [name,[s,reason]] of Object.entries(cases)){
  const r=repo(),out=await run(r,s);
  assert.equal(out.outcome,'incomplete',name);assert.equal(out.reason,reason,name);
  assert.ok(!r.log.some(x=>Array.isArray(x)&&x[0]==='commit'),name+': nothing committed');
  assert.deepEqual(r.log.find(x=>Array.isArray(x)&&x[0]==='attempt'),['attempt','incomplete',reason],name);
 }
 // Review fix: a repeated page 1 that is a strict prefix (or empty) with the same total is a change, not a pass.
 for(const keep of [2,0]){
  const short=site({films:ids(7),mutate:(h,l,t)=>({list:(h.n===1&&h.call>3)?l.slice(0,keep):l,total:t})});
  const r=repo(),out=await run(r,short);
  assert.equal(out.outcome,'incomplete','repeat page 1 with '+keep+' of 3 ids');assert.equal(out.reason,'page1_changed');
  assert.ok(!r.log.some(x=>Array.isArray(x)&&x[0]==='commit'),'nothing committed');
 }
 // The pagination URL must match the account path.
 const bad={calls:[],fetchPage:async u=>({n:1}),parse:()=>({films:[{id:'a'}],total:2,next:'/evil/watchlist/page/2/'})};
 assert.equal((await run(repo(),bad)).reason,'pagination_url');
 // Page cap.
 const endless={fetchPage:async u=>({n:1}),parse:()=>({films:[{id:'x'+Math.random()}],total:1000,next:'/me/watchlist/page/2/'})};
 assert.equal((await run(repo(),endless)).reason,'page_limit');
}
// 3. HTTP outcomes: 429, 403, 5xx and a network error. No removal, attempt recorded, one attempt only (no loop).
{
 for(const [status,outcome,reason] of [[429,'rate_limited','http_429'],[403,'unavailable','http_403'],[503,'unavailable','http_5xx'],[0,'unavailable','network_error']]){
  const s=site({films:ids(5),failAt:()=>status||null});
  if(!status)s.fetchPage=async()=>{throw new Error('socket');};
  const r=repo(),out=await run(r,s);
  assert.equal(out.outcome,outcome);assert.equal(out.reason,reason);
  assert.ok(!r.log.some(x=>Array.isArray(x)&&x[0]==='commit'));
  if(status)assert.equal(s.calls.length,1,'a failure is not retried inside the run');
 }
}
// 4. Fail closed: no repository, repository not ready, a repository that throws on ready: nothing fetched, `disabled`.
{
 for(const repository of [null,{},{ready:async()=>({ready:false})},{ready:async()=>{throw new Error('x');}}]){
  const s=site({films:ids(3)}),out=await run(repository,s);
  assert.equal(out.outcome,'disabled');assert.equal(out.reason,'watchlist_repository_absent');assert.equal(s.calls.length,0,'Letterboxd is never called without a ready repository');
 }
}
// 5. Effects drain first: a pending causal effect that cannot be drained holds the scan (visible `error`), it is not skipped.
{
 const s=site({films:ids(3)}),r=repo({drainEffects:async()=>({drained:false,code:'effects_pending'})});
 const out=await run(r,s);assert.equal(out.outcome,'error');assert.equal(out.reason,'effects_pending');assert.equal(s.calls.length,0);
 const r2=repo({drainEffects:async()=>{throw new Error('d1');}});assert.equal((await run(r2,site({films:ids(3)}))).reason,'effects_failed');
}
// 6. Commit outcomes: no_change is its own outcome and a repository failure is an error that never claims a commit; an unknown commit is not replayed here.
{
 const r=repo({commitScan:async()=>({outcome:'no_change',version:42,lastSuccessAt:'2026-11-21T10:41:00.000Z',total:3,baseline:false,added:[],removed:[]})});
 const out=await run(r,site({films:ids(3)}));assert.equal(out.outcome,'no_change');assert.equal(out.addedCount,0);assert.equal(out.removedCount,0);
 let commits=0;const r2=repo({commitScan:async()=>{commits++;throw Object.assign(new Error('x'),{code:'commit_unknown'});}});
 const out2=await run(r2,site({films:ids(3)}));assert.equal(out2.outcome,'error');assert.equal(out2.reason,'commit_unknown');assert.equal(commits,1,'no blind replay inside the run');
 // Admission failure never undoes the committed snapshot.
 const r3=repo({admitNew:async()=>{throw new Error('tmdb');}});const out3=await run(r3,site({films:ids(3)}));assert.equal(out3.outcome,'committed');assert.equal(out3.admission.error,true);
 // 1-for-1 replacement and a large removal are reported as they are (no mass-change guard, O2).
 const r4=repo({commitScan:async()=>({outcome:'committed',version:43,lastSuccessAt:'x',total:5,baseline:false,added:[{lid:'new'}],removed:[{lid:'old'}]})});
 const o4=await run(r4,site({films:ids(5)}));assert.equal(o4.addedCount,1);assert.equal(o4.removedCount,1);
 const big=repo({commitScan:async()=>({outcome:'committed',version:44,lastSuccessAt:'x',total:1,baseline:false,added:[],removed:ids(300)})});
 assert.equal((await run(big,site({films:ids(1)}))).removedCount,300,'a complete scan with a large removal is published, never held');
}
// 7. The module reads no Discovery, EPG or resolver state and holds no storage of its own.
{
 const text=fs.readFileSync('src/letterboxd-sync-watchlist.js','utf8');
 assert.doesNotMatch(text,/discovery_lease|epg_checkpoint|epg_priority|resolver_lease|published_epg|watchlist_(current|snapshot|member|staging)|env\.DB|BUCKET/i);
}
console.log('letterboxd-sync-watchlist ok');
