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
assert.deepEqual([records.get('sync.json').ratingAttempt.state,records.get('sync.json').ratingAttempt.cause],['finished','diary_off']);

// 3. First run with the gate on: bounded to three pages, partial, resumable; no rating or watched fact written.
records.clear();etags.clear();requests.length=0;writes.length=0;
const diary=Array.from({length:230},(_,i)=>({lid:'E'+i,slug:'e-'+i,date:day(i),stars:(i%10)+1}));
publish(diary);
let result=await D.syncHistory(env);
assert.deepEqual([diaryRequests().length,result.counts.pages,result.counts.added,result.lastOutcome,result.resumePage],[3,3,150,'partial',4]);
assert.equal(diaryRequests().every(r=>r.redirect==='manual'),true);
assert.equal(Object.keys(history().entries).length,150);
assert.equal(writes.every(key=>key.startsWith('letterboxd/diary/')),true,'only the diary objects');
assert.equal(writes.some(key=>key.includes('facts/')||key.includes('view-index')||key.includes('actual.json')),false);
assert.equal(result.coverage.reachedEnd,false);
// 4. Second run: page 1 known, the backfill resumes one page early (overlap) and goes on; nothing duplicated.
requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().map(r=>r.url),[url(1),url(3),url(4)]);
assert.deepEqual([result.counts.added,result.counts.unchanged,result.resumePage,result.lastOutcome],[50,100,5,'partial']);
assert.equal(Object.keys(history().entries).length,200);
// 5. Third run reaches the last page: complete, nothing left to resume.
requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().map(r=>r.url),[url(1),url(4),url(5)]);
assert.deepEqual([result.lastOutcome,result.resumePage,result.coverage.reachedEnd,Object.keys(history().entries).length],['complete',null,true,230]);
assert.equal(result.coverage.oldestWatchedDate,day(229));assert.equal(result.coverage.newestWatchedDate,day(0));
// 6. Steady state: one new viewing at the top, a re-watch of an old film, a rating edit: one request, all three seen.
requests.length=0;
const newer=[{lid:'E5',slug:'e-5',date:'2026-10-30',stars:9,rewatch:true},...diary.map((e,i)=>i===1?{...e,stars:9}:e)];
publish(newer);result=await D.syncHistory(env);
assert.deepEqual([diaryRequests().length,result.counts.added,result.counts.updated,result.lastOutcome],[1,1,1,'complete']);
const e5=Object.values(history().entries).filter(e=>e.identity?.value==='E5');
assert.equal(e5.length,2,'two viewings of one film');
assert.deepEqual(plain(e5.map(e=>[e.watchedDate,e.rewatch])).sort(),[['2026-10-24','unknown'],['2026-10-30',true]]);
const edited=history().entries['day:lid:E1|'+day(1)];
assert.equal(edited.ratingAtEntry,4.5);assert.deepEqual(plain(edited.changes.map(c=>[c.field,c.from,c.to])),[['ratingAtEntry',1,4.5],['ratingsAtEntry',[1],[4.5]]]);
// 7. Re-import of the same pages adds nothing.
requests.length=0;result=await D.syncHistory(env);
assert.deepEqual([result.counts.added,result.counts.updated,Object.keys(history().entries).length],[0,0,231]);

// 8. A backdated entry that lands on page 1 is found; the stored history is never shrunk by absence.
publish([{lid:'Back',slug:'back',date:day(3),stars:6},...newer.slice(0,45)]);requests.length=0;result=await D.syncHistory(env);
assert.equal(result.counts.added,1);assert.equal(Object.keys(history().entries).length,232,'rows missing from the page are kept');

// 8b. Day entries. Pages are separate requests, so a day count is never summed across pages: a day cut by a page
// boundary is a lower bound from one page, marked uncertain, and one entry; a page that holds the whole day proves it.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);
const twinKey='day:lid:Twin|'+day(60),twin=()=>history().entries[twinKey];
const filler=(prefix,n,from)=>Array.from({length:n},(_,i)=>({lid:prefix+i,date:day(from+i)}));
const split=[...filler('S',49,0),{lid:'Twin',date:day(60),stars:8},{lid:'Twin',date:day(60),stars:6,rewatch:true},...filler('T',60,61)];
publish(split);requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain,twin().ratingsAtEntry]),[1,false,[4]],'cut on page 1, cut again on page 2: one viewing at least, not exact');
assert.equal(twin().rewatchRows,1);
assert.equal(Object.values(history().entries).filter(e=>e.identity?.value==='Twin').length,1);
// A later read where one page holds the whole day completes it: two viewings, certain, both ratings, one re-watch row.
const closed=[{lid:'New1',date:'2026-10-31'},{lid:'New2',date:'2026-10-31'},...split];
records.delete(D.KEYS.state);publish(closed);requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(diaryRequests().slice(0,2).map(r=>r.url),[url(1),url(2)]);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain,twin().ratingsAtEntry,twin().rewatch,twin().rewatchRows]),[2,true,[4,3],true,1]);
assert.deepEqual(plain(twin().changes.map(c=>c.field)),['rewatchRows','viewings','viewingsCertain','ratingAtEntry','ratingsAtEntry','rewatch'],'page 2 of the first read raised the re-watch lower bound');
let twinFilm=(await D.readHistory(env,{filmId:'Twin'})).film;
assert.deepEqual([twinFilm.viewingCount,twinFilm.viewingCountExact,twinFilm.rewatches,twinFilm.rewatchesExact],[2,true,1,false],'first viewing unmarked, so re-watches are a lower bound');
// A shift that cuts the day again never lowers, inflates or duplicates it; an uncertain read leaves a proved count alone.
publish([...filler('N',50,-10).map(e=>({...e,date:'2026-11-0'+(1+Number(e.lid.slice(1))%5)})),...split]);requests.length=0;result=await D.syncHistory(env);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain]),[2,true],'a page shift never lowers or inflates the count');
assert.equal(Object.values(history().entries).filter(e=>e.identity?.value==='Twin').length,1);

// 8c. Non-atomic pagination: an entry added between the page 1 and page 2 requests repeats page 1's last row at the top
// of page 2. The repeated row is not a second viewing.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);
const once=[...filler('S',49,0),{lid:'Twin',date:day(60),stars:8},...filler('T',60,61)];
publish(once);const later=[{lid:'Late',date:'2026-10-31'},...once];
site.set(url(2),page(later.slice(50,100),true));site.set(url(3),page(later.slice(100),false));
result=await D.syncHistory(env);
assert.deepEqual(plain([twin().viewings,twin().viewingsCertain]),[1,false],'a repeated row never becomes an exact second viewing');

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
assert.equal(state().coverage.reachedEnd,true);
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
// A 403 on page 2 of a baseline keeps page 1 and resumes at page 2.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);publish(diary);site.set(url(2),()=>respond(403,'<title>Just a moment...</title>'));requests.length=0;
result=await D.syncHistory(env);
assert.deepEqual([diaryRequests().length,result.lastOutcome,result.resumePage,Object.keys(history().entries).length],[2,'blocked',2,50]);

// 10. Killed after a page commit, before the state write: the next run repeats reads only, nothing duplicates.
records.delete(D.KEYS.history);records.delete(D.KEYS.state);publish(diary);
failState=true;await assert.rejects(D.syncHistory(env),/isolate killed/);failState=false;
assert.equal(Object.keys(history().entries).length,150);assert.equal(records.has(D.KEYS.state),false);
result=await D.syncHistory(env);
assert.deepEqual([Object.keys(history().entries).length,result.counts.added,result.counts.unchanged,result.resumePage],[150,0,150,4],'the reads repeat, nothing duplicates');
result=await D.syncHistory(env);
assert.deepEqual([Object.keys(history().entries).length,result.counts.added],[200,50]);

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

// 13. In the EPG commit: the stage reads the diary once, writes no facts without LETTERBOXD_FACTS, never fails the commit.
records.clear();etags.clear();requests.length=0;publish(fifty);records.set('programme.json',report('r-on'));
const completed=await ctx.completeWithRatings(env,run('r-on'),report('r-on'));
assert.equal(completed.stage,'complete');
assert.deepEqual(requests.map(r=>r.url),[url(1)],'one diary page and nothing else');
const sync=records.get('sync.json');
assert.deepEqual([sync.diaryHistory.outcome,sync.diaryHistory.counts.added,sync.diaryHistory.facts.rated,sync.diaryHistory.facts.enabled],['complete',50,50,false]);
assert.deepEqual([sync.ratingAttempt.state,sync.ratingAttempt.phase,sync.ratingAttempt.source,sync.ratingPending,sync.ratingError],['finished','diary','letterboxd_diary',undefined,undefined]);
assert.equal(writes.some(key=>key.includes('facts/')||key.includes('view-index')),false,'no fact without LETTERBOXD_FACTS');
// A blocked diary: the commit completes, nothing else is requested, the attempt is an error with its cause.
records.clear();etags.clear();requests.length=0;site.clear();site.set(url(1),()=>respond(403,'<title>Just a moment...</title>'));records.set('programme.json',report('r-block'));
const blocked=await ctx.completeWithRatings(env,run('r-block'),report('r-block'));
assert.equal(blocked.stage,'complete');
assert.equal(requests.length,1,'one diary request in the whole commit');
assert.equal(records.get('sync.json').diaryHistory.outcome,'blocked');
assert.deepEqual([records.get('sync.json').ratingAttempt.state,records.get('sync.json').ratingAttempt.cause],['error','blocked']);
assert.match(records.get('sync.json').ratingError,/Letterboxd diary blocked/);

console.log('Letterboxd diary history (AIR-51): parser on a 50-row page, day entries proved by one page, lower bounds across page boundaries, shifts and non-atomic pages, no false exactness, re-watches per row, gate off untouched, bounded resumable backfill with overlap, steady-state increment, re-import and backdated rows, failures (HTTP, challenge, fetch, unreadable body, zero-row 200) without retry or loss, crash recovery, identity conflict, read API, one diary read per commit passed');
