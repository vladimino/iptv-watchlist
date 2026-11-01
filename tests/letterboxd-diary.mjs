// AIR-51 / ADR 0049: the Letterboxd Diary viewing history. Synthetic pages in the structure the production Worker parsed
// on 29 Oct 2026 (diary-entry-row, poster lid, film and date links, rated-N); no real HTML or private history.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const USER='fixture';
const records=new Map(),etags=new Map(),writes=[],requests=[];let revision=0,failState=false;
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(failState&&key==='letterboxd/diary/state.json')throw new Error('isolate killed');
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  writes.push(key);records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(key=>key.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
// Diary pages served by URL; a function value decides per request.
const site=new Map();
const respond=(status,html,headers={})=>({ok:status===200,status,headers:new Headers(headers),text:async()=>html});
const ctx=vm.createContext({Response,Request,Headers,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console:{...console,log:()=>{}},setTimeout:fn=>fn(),
 fetch:async(url,init={})=>{
  url=String(url);requests.push({url,redirect:init.redirect});
  const page=site.get(url);if(typeof page==='function')return page();if(page!=null)return respond(200,page);
  if(url.includes('/films/'))return respond(403,'<title>Just a moment...</title>');
  return respond(404,'');
 }});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const D=vm.runInContext('LetterboxdDiary',ctx);
const off={LETTERBOXD_USERNAME:USER,EPG_XML_URL:'https://epg.test/guide.xml',BUCKET:bucket};
const env={...off,LETTERBOXD_DIARY_HISTORY:'on'};
const plain=value=>JSON.parse(JSON.stringify(value));

const row=({lid,slug=lid?.toLowerCase(),date='2026-10-29',stars=7,viewing=null,rewatch,foreign=false})=>{
 const [y,m,d]=(date||'').split('-');
 return `<tr class="diary-entry-row viewing-poster-container"${viewing?` data-viewing-id="${viewing}"`:''}>`+
  (date?`<td class="td-calendar"><a href="/${USER}/diary/films/for/${y}/${m}/${d}/">${d}</a></td>`:'<td class="td-calendar"></td>')+
  `<td class="td-film-details">${lid?`<div class="react-component" data-component-class="LazyPoster" data-postered-identifier="{&quot;lid&quot;:&quot;${lid}&quot;,&quot;uid&quot;:&quot;film:1&quot;}"></div>`:''}`+
  (slug?`<h3><a href="/${USER}/film/${slug}/">Title</a></h3>`:'')+(foreign?`<a href="https://example.com/${USER}/diary/films/for/1999/01/01/">x</a><a href="https://example.com/film/evil/">x</a>`:'')+`</td>`+
  `<td class="td-rating">${stars?`<span class="rating rated-${stars}"></span>`:''}</td>`+
  (rewatch===undefined?'':`<td class="td-rewatch center ${rewatch?'icon-rewatch':'icon-status-off'}"></td>`)+'</tr>';
};
const page=(rows,next)=>'<html><head><title>Diary</title></head><body><table>'+rows.map(row).join('')+'</table>'+(next?`<a class="next" href="/${USER}/diary/page/2/">Older</a>`:'')+'</body></html>';
const url=n=>`https://letterboxd.com/${USER}/diary/`+(n>1?`page/${n}/`:'');
const day=n=>new Date(Date.UTC(2026,9,29)-n*86400000).toISOString().slice(0,10);
// A diary of `count` entries, newest first, 50 per page.
function publish(entries){site.clear();const pages=Math.ceil(entries.length/50)||1;for(let p=1;p<=pages;p++)site.set(url(p),page(entries.slice((p-1)*50,p*50),p<pages));}
const diaryRequests=()=>requests.filter(r=>r.url.includes('/diary/'));
const history=()=>records.get(D.KEYS.history);
const state=()=>records.get(D.KEYS.state);

// 1. Parser on a 50-row first page: lid, date, rating and slug in page order; nothing invented.
const fifty=Array.from({length:50},(_,i)=>({lid:'F'+i,slug:'film-'+i,date:day(i),stars:(i%10)+1}));
const parsed=D.parsePage(page(fifty,true));
assert.equal(parsed.rows.length,50);assert.equal(parsed.next,true);assert.equal(parsed.challenge,false);
assert.deepEqual(plain(parsed.rows.map(r=>[r.lid,r.slug,r.watchedDate,r.ratingAtEntry])),fifty.map(f=>[f.lid,f.slug,f.date,f.stars/2]));
assert.equal(parsed.rows.every(r=>r.rewatch==='unknown'&&r.viewingId===null),true,'no marker, no id: unknown and null');
const odd=D.parsePage(page([{lid:null,slug:'no-lid'},{lid:'NoDate',date:null},{lid:'Unrated',stars:null},{lid:'Re',rewatch:true},{lid:'First',rewatch:false},{lid:'Vid',viewing:'987654'},{lid:'Far',foreign:true}],false));
assert.deepEqual(plain(odd.rows.map(r=>[r.lid,r.slug,r.watchedDate,r.ratingAtEntry,r.rewatch,r.viewingId])),[
 [null,'no-lid','2026-10-29',3.5,'unknown',null],['NoDate','nodate',null,3.5,'unknown',null],['Unrated','unrated','2026-10-29',null,'unknown',null],
 ['Re','re','2026-10-29',3.5,true,null],['First','first','2026-10-29',3.5,false,null],['Vid','vid','2026-10-29',3.5,'unknown','987654'],['Far','far','2026-10-29',3.5,'unknown',null]]);
assert.equal(D.parsePage('<html><head><title>Just a moment...</title></head></html>').challenge,true);
assert.equal(D.parsePage('<html><title>Changed layout</title><div class="entry">x</div></html>').rows.length,0);
// Keys: a viewing id when present; otherwise one day entry per film and date, which counts its viewings.
const keyed=D.keyRows(D.parsePage(page([{lid:'Twice'},{lid:'Twice'},{lid:'Vid',viewing:'5'},{lid:'NoDate',date:null},{lid:null,slug:'only-slug'}],false)).rows);
assert.deepEqual(plain(keyed.map(r=>r.key)),['day:lid:Twice|2026-10-29','day:lid:Twice|2026-10-29','viewing:5',null,'day:slug:only-slug|2026-10-29']);

// 2. Gate off: the stage is inert and the commit requests nothing from Letterboxd (AIR-287: no films list, no repair).
publish(fifty);
const film=id=>({id,url:`https://letterboxd.com/film/${id.toLowerCase()}/`,title:id,year:2020,shows:[]});
const report=runId=>({runId,updatedAt:new Date().toISOString(),watchlistCount:1,films:[film('F0')],stats:{}});
const run=runId=>({runId,stage:'epg',events:[],ratingPending:['letterboxd-diary'],watchlist:[film('F0')],pending:[]});
records.set('programme.json',report('r-off'));
await ctx.completeWithRatings(off,run('r-off'),report('r-off'));
assert.equal(requests.length,0,'no Letterboxd request');
assert.equal(records.has(D.KEYS.history),false);assert.equal(records.has(D.KEYS.state),false);
assert.equal(records.get('sync.json').diaryHistory,undefined);
assert.equal(records.get('sync.json').ratingAttempt,undefined,'the commit opens no ratings attempt');
assert.equal(records.get('sync.json').ratingsPipeline,'blocked');

// 3. First run: page 1 only, however many pages the diary has and however new they are. No facts are written here.
records.clear();etags.clear();requests.length=0;writes.length=0;
const diary=Array.from({length:230},(_,i)=>({lid:'E'+i,slug:'e-'+i,date:day(i),stars:(i%10)+1}));
publish(diary);
let result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().map(r=>r.url),[url(1)]);
assert.equal(diaryRequests().every(r=>r.redirect==='manual'),true);
assert.deepEqual([result.counts.pages,result.counts.added,result.lastOutcome,result.stopReason,result.resumePage],[1,50,'recent_window','recent_window_only',null]);
assert.equal(result.historicalCoverage,'incomplete');assert.equal(result.coverage.window,'recent');assert.equal(result.coverage.reachedEnd,false);
assert.equal(result.counts.overflowSuspected,true,'every row was new and the page links onward');
assert.equal(Object.keys(history().entries).length,50);
assert.equal(result.coverage.newestWatchedDate,day(0));assert.equal(result.coverage.oldestWatchedDate,day(49));
assert.equal(writes.every(key=>key.startsWith('letterboxd/diary/')),true,'only the diary objects');
assert.equal(writes.some(key=>key.includes('facts/')||key.includes('view-index')||key.includes('actual.json')),false);
// 4. A stored resume page is not a fetch plan: page 2 and the rest stay unrequested, and the page is not moved backward.
state().resumePage=4;records.set(D.KEYS.state,state());
requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().map(r=>r.url),[url(1)]);
assert.equal(result.resumePage,4);assert.equal(result.counts.added,0);assert.equal(Object.keys(history().entries).length,50);
// 5. Steady state: one new viewing at the top and a rating edit on the page, still one request.
requests.length=0;
const newer=[{lid:'E5',slug:'e-5',date:'2026-10-30',stars:9,rewatch:true},...diary.map((e,i)=>i===1?{...e,stars:9}:e)];
publish(newer);result=await D.syncHistory(env);
assert.deepEqual([diaryRequests().length,result.counts.added,result.counts.updated,result.lastOutcome],[1,1,1,'recent_window']);
const e5=Object.values(history().entries).filter(e=>e.identity?.value==='E5');
assert.equal(e5.length,2,'two viewings of one film');
assert.deepEqual(plain(e5.map(e=>[e.watchedDate,e.rewatch])).sort(),[['2026-10-24','unknown'],['2026-10-30',true]]);
const edited=history().entries['day:lid:E1|'+day(1)];
assert.equal(edited.ratingAtEntry,4.5);assert.deepEqual(plain(edited.changes.map(c=>[c.field,c.from,c.to])),[['ratingAtEntry',1,4.5],['ratingsAtEntry',[1],[4.5]]]);
// 6. Re-import of the same page adds nothing.
requests.length=0;result=await D.syncHistory(env);
assert.deepEqual([result.counts.added,result.counts.updated,Object.keys(history().entries).length],[0,0,51]);

// 7. A backdated entry that lands on page 1 is found; a row missing from the page is kept.
publish([{lid:'Back',slug:'back',date:day(3),stars:6},...newer.slice(0,45)]);requests.length=0;result=await D.syncHistory(env);
assert.equal(result.counts.added,1);assert.equal(Object.keys(history().entries).length,52,'rows missing from the page are kept');

// 8b. Day entries. A day cut at the bottom of page 1 is a lower bound from that page, one entry; a later page 1 that
// holds the whole day proves it. Page 2 is never requested.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);
const twinKey='day:lid:Twin|'+day(60),twin=()=>history().entries[twinKey];
const filler=(prefix,n,from)=>Array.from({length:n},(_,i)=>({lid:prefix+i,date:day(from+i)}));
const split=[...filler('S',49,0),{lid:'Twin',date:day(60),stars:8},{lid:'Twin',date:day(60),stars:6,rewatch:true},...filler('T',60,61)];
publish(split);requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().map(r=>r.url),[url(1)]);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain,twin().ratingsAtEntry]),[1,false,[4]],'cut at the bottom of page 1: one viewing at least, not exact');
assert.equal(twin().rewatchRows,0);
assert.equal(Object.values(history().entries).filter(e=>e.identity?.value==='Twin').length,1);
// A later page 1 that holds the whole day completes it: two viewings, certain, both ratings, one re-watch row.
const closed=[{lid:'New1',date:'2026-10-31'},{lid:'Twin',date:day(60),stars:8},{lid:'Twin',date:day(60),stars:6,rewatch:true},{lid:'New2',date:'2026-10-30'}];
records.delete(D.KEYS.state);publish(closed);requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().map(r=>r.url),[url(1)]);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain,twin().ratingsAtEntry,twin().rewatch,twin().rewatchRows]),[2,true,[4,3],true,1]);
assert.deepEqual(plain(twin().changes.map(c=>c.field)),['viewings','viewingsCertain','rewatchRows','ratingAtEntry','ratingsAtEntry','rewatch']);
let twinFilm=(await D.readHistory(env,{filmId:'Twin'})).film;
assert.deepEqual([twinFilm.viewingCount,twinFilm.viewingCountExact,twinFilm.rewatches,twinFilm.rewatchesExact],[2,true,1,false],'first viewing unmarked, so re-watches are a lower bound');
// A page that does not show the day, and an uncertain cut of one row, never lower, inflate or duplicate the proved count.
publish([...filler('N',50,0),...split]);requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().map(r=>r.url),[url(1)]);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain]),[2,true],'a page that omits the day leaves the proved count');
const cut=[...filler('C',49,0),{lid:'Twin',date:day(60),stars:8},...filler('Z',10,80)];
publish(cut);requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().map(r=>r.url),[url(1)]);
assert.equal(result.counts.conflicts,0);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain]),[2,true],'an uncertain smaller read does not lower a proved count');
assert.equal(Object.values(history().entries).filter(e=>e.identity?.value==='Twin').length,1);

// 8c. A published page 2 that repeats page 1's last row is never fetched, so the repeat is not a second viewing.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);
const once=[...filler('S',49,0),{lid:'Twin',date:day(60),stars:8},...filler('T',60,61)];
publish(once);const later=[{lid:'Late',date:'2026-10-31'},...once];
site.set(url(2),page(later.slice(50,100),true));site.set(url(3),page(later.slice(100),false));
requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().map(r=>r.url),[url(1)]);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain]),[1,false],'an unread page never becomes a second viewing');

// 8d. False exactness: a stored lower bound above a later proved count is a conflict, never an exact count.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);
publish([{lid:'Twin',date:day(60),stars:8}]);await D.syncHistory(env);
const stored=history();Object.assign(stored.entries[twinKey],{viewings:2,viewingsCertain:false});records.set(D.KEYS.history,stored);
records.delete(D.KEYS.state);result=await D.syncHistory(env);
assert.equal(result.counts.conflicts,1);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain]),[2,false],'2 uncertain then 1 certain stays 2 uncertain');
assert.equal((await D.readHistory(env,{filmId:'Twin'})).film.viewingCountExact,false);
// A proved count grown by an uncertain read is a lower bound again.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);
publish([{lid:'Twin',date:day(60)},{lid:'Other',date:day(61)}]);await D.syncHistory(env);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain]),[1,true]);
const grown=[...filler('S',48,0),{lid:'Twin',date:day(60)},{lid:'Twin',date:day(60)},{lid:'Twin',date:day(60)}];
records.delete(D.KEYS.state);publish(grown);await D.syncHistory(env);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain]),[2,false]);

// 8e. Re-watch rows are counted per row, not per day entry: two marked rows are two re-watches; one first viewing and
// one re-watch are one.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);
publish([{lid:'Two',date:day(1),rewatch:true},{lid:'Two',date:day(1),rewatch:true},{lid:'One',date:day(2),rewatch:false},{lid:'One',date:day(2),rewatch:true}]);await D.syncHistory(env);
twinFilm=(await D.readHistory(env,{filmId:'Two'})).film;
assert.deepEqual([twinFilm.viewingCount,twinFilm.rewatches,twinFilm.rewatchesExact],[2,2,true]);
twinFilm=(await D.readHistory(env,{filmId:'One'})).film;
assert.deepEqual([twinFilm.viewingCount,twinFilm.rewatches,twinFilm.rewatchesExact],[2,1,true]);

// 9. Failures stop at once, keep the last good history and say why; no retry.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);publish(newer);await D.syncHistory(env);await D.syncHistory(env);await D.syncHistory(env);
const before=JSON.stringify(history()),lastGood=state().lastSuccessAt;
for(const [status,outcome] of [[403,'blocked'],[429,'rate_limited'],[500,'failed']]){
 site.set(url(1),()=>respond(status,'<title>Just a moment...</title>',{'cf-mitigated':'challenge'}));requests.length=0;
 result=await D.syncHistory(env);
 assert.deepEqual([diaryRequests().length,result.lastOutcome,result.stopReason],[1,outcome,'http_'+status+'_page_1']);
 assert.equal(JSON.stringify(history()),before);assert.equal(state().lastSuccessAt,lastGood);assert.ok(state().lastFailureAt);
}
assert.equal(state().coverage.reachedEnd,false,'a recent window never claims the last page');
site.set(url(1),()=>respond(200,'<html><head><title>Just a moment...</title></head></html>'));result=await D.syncHistory(env);
assert.deepEqual([result.lastOutcome,result.stopReason],['blocked','challenge_page_1']);
site.set(url(1),()=>{throw new Error('timed out');});result=await D.syncHistory(env);
assert.deepEqual([result.lastOutcome,result.stopReason],['failed','fetch:timed out']);
site.set(url(1),'<html><title>Changed layout</title></html>'+'<a class="next" href="/x/diary/page/2/">');result=await D.syncHistory(env);
assert.deepEqual([result.lastOutcome,result.stopReason],['failed','unrecognized_page_1']);
// A 200 page with no rows and no next link is not an empty diary: it fails and keeps coverage, cursor and last success.
const coverageBefore=JSON.stringify(state().coverage),resumeBefore=state().resumePage;
site.set(url(1),'<html><head><title>Something else</title></head><body>Sorry</body></html>');result=await D.syncHistory(env);
assert.deepEqual([result.lastOutcome,result.stopReason],['failed','unrecognized_page_1']);
assert.deepEqual([JSON.stringify(state().coverage),state().resumePage,state().lastSuccessAt],[coverageBefore,resumeBefore,lastGood]);
// A body that cannot be read is a failed run with a durable state, not an exception.
site.set(url(1),()=>({ok:true,status:200,headers:new Headers(),text:async()=>{throw new Error('stream reset');}}));
result=await D.syncHistory(env);
assert.deepEqual([result.lastOutcome,result.stopReason],['failed','read:stream reset_page_1']);
assert.equal(state().lastOutcome,'failed');assert.equal(state().lastSuccessAt,lastGood);
assert.equal(JSON.stringify(history()),before,'no failure rewrote the history');
// The same zero-row page with no history yet: failed, nothing created, no coverage claimed.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);site.clear();site.set(url(1),'<html><head><title>Something else</title></head></html>');
result=await D.syncHistory(env);
assert.deepEqual([result.lastOutcome,result.coverage.reachedEnd,result.lastSuccessAt,records.has(D.KEYS.history)],['failed',false,null,false]);
// A 403 published on page 2 is never requested: page 1 still finishes as a recent window and does not move the resume page.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);publish(diary);site.set(url(2),()=>respond(403,'<title>Just a moment...</title>'));requests.length=0;
result=await D.syncHistory(env);
assert.deepEqual([diaryRequests().length,result.lastOutcome,result.stopReason,result.resumePage,Object.keys(history().entries).length],[1,'recent_window','recent_window_only',null,50]);
assert.equal(state().coverage.reachedEnd,false);assert.ok(state().lastSuccessAt);

// 10. Killed after a page commit, before the state write: the next run repeats the same page, nothing duplicates.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);publish(diary);
failState=true;await assert.rejects(D.syncHistory(env),/isolate killed/);failState=false;
assert.equal(Object.keys(history().entries).length,50);assert.equal(records.has(D.KEYS.state),false);
result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().slice(-1).map(r=>r.url),[url(1)]);
assert.deepEqual([Object.keys(history().entries).length,result.counts.added,result.counts.unchanged,result.resumePage],[50,0,50,null],'the same page repeats, nothing duplicates');

// 11. An entry whose viewing id comes back with another film is a conflict: the stored identity stays.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);
publish([{lid:'Mine',viewing:'77'}]);await D.syncHistory(env);
publish([{lid:'Other',viewing:'77'}]);result=await D.syncHistory(env);
assert.equal(result.counts.conflicts,1);assert.equal(history().entries['viewing:77'].identity.value,'Mine');

// 12. Read side: per-film aggregates from confirmed entries, unresolved rows kept apart, a GET that writes nothing.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);
publish([{lid:'A',date:'2026-10-20',rewatch:true},{lid:'A',date:'2026-01-02'},{lid:null,slug:'mystery',date:'2026-10-01'}]);await D.syncHistory(env);
writes.length=0;
const read=await ctx.worker.fetch(new Request('https://site.example/api/letterboxd/diary?filmId=A'),env);
const body=await read.json();
assert.deepEqual([read.status,body.enabled,body.entries,body.unresolvedEntries,body.films],[200,true,3,1,1]);
assert.deepEqual(plain([body.film.viewingCount,body.film.viewingCountExact,body.film.lastWatchedAt,body.film.rewatches,body.film.rewatchesExact,body.film.entries.map(e=>e.watchedDate)]),[2,true,'2026-10-20',1,false,['2026-10-20','2026-01-02']]);
assert.ok(body.film.entries.every(e=>e.aliases.every(alias=>typeof alias.firstObservedAt==='string')),'each slug alias carries the read that first saw it');
assert.equal((await ctx.worker.fetch(new Request('https://site.example/api/letterboxd/diary?filmId=../x'),env)).status,400);
assert.deepEqual(writes,[],'the read writes nothing');

// 13. The EPG commit does not read Diary (ADR 0074), including when the page would be blocked. Facts of a diary page
// are written by the ratings run; the page-1 read above already covers that reader.
records.clear();etags.clear();requests.length=0;publish(fifty);records.set('programme.json',report('r-on'));
const completed=await ctx.completeWithRatings(env,run('r-on'),report('r-on'));
assert.equal(completed.stage,'complete');
assert.equal(completed.ratingsPipeline,'blocked');
assert.deepEqual(requests,[], 'the commit requests nothing');
assert.equal(records.get('sync.json').diaryHistory,undefined);
assert.equal(records.get('sync.json').ratingAttempt,undefined);
records.clear();etags.clear();requests.length=0;site.clear();site.set(url(1),()=>respond(403,'<title>Just a moment...</title>'));records.set('programme.json',report('r-block'));
const blocked=await ctx.completeWithRatings(env,run('r-block'),report('r-block'));
assert.equal(blocked.stage,'complete');
assert.equal(blocked.ratingsPipeline,'blocked');
assert.equal(requests.length,0,'a blocked diary page is not requested by the commit');
assert.equal(records.get('sync.json').ratingAttempt,undefined);

console.log('Letterboxd diary history (AIR-304, ADR 0074): parser on a 50-row page, one fetch of page 1, a stored resume page is not a fetch plan, day cut at the bottom stays a lower bound, a later page 1 can prove the day, no false exactness, re-watches per row, gate off untouched, steady-state increment, re-import and backdated rows, failures (HTTP, challenge, fetch, unreadable body, zero-row 200) without retry or loss, crash recovery repeats page 1, identity conflict, read API, and an EPG commit that does not read Diary passed');
