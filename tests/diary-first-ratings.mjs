// AIR-287 / ADR 0054, recent window AIR-304 / ADR 0064: Diary-first EPG ratings. Synthetic diary pages only; no real Letterboxd request.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const USER='fixture';
const records=new Map(),etags=new Map(),writes=[],requests=[];let revision=0,failFactsFor=null;
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(failFactsFor&&key===`letterboxd/facts/films/lb-${failFactsFor}.json`)throw new Error('storage unavailable');
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  writes.push(key);records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(key=>key.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const site=new Map();
const respond=(status,html)=>({ok:status===200,status,headers:new Headers(),text:async()=>html});
const ctx=vm.createContext({Response,Request,Headers,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console:{...console,log:()=>{}},setTimeout:fn=>fn(),
 fetch:async url=>{url=String(url);requests.push(url);const page=site.get(url);if(typeof page==='function')return page();if(page!=null)return respond(200,page);return respond(404,'');}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const D=vm.runInContext('LetterboxdDiary',ctx);
const env={LETTERBOXD_USERNAME:USER,EPG_XML_URL:'https://epg.test/guide.xml',BUCKET:bucket,LETTERBOXD_DIARY_HISTORY:'on'};
const plain=value=>JSON.parse(JSON.stringify(value));
const row=({lid,date,stars=null,viewing=null})=>{const [y,m,d]=date.split('-');return `<tr class="diary-entry-row"${viewing?` data-viewing-id="${viewing}"`:''}><td><a href="/${USER}/diary/films/for/${y}/${m}/${d}/">${d}</a></td><td><div data-postered-identifier="{&quot;lid&quot;:&quot;${lid}&quot;}"></div><h3><a href="/${USER}/film/${lid.toLowerCase()}/">t</a></h3></td><td>${stars?`<span class="rating rated-${stars}"></span>`:''}</td></tr>`;};
const url=n=>`https://letterboxd.com/${USER}/diary/`+(n>1?`page/${n}/`:'');
const pageHtml=(rows,next)=>'<html><head><title>Diary</title></head><table>'+rows.map(row).join('')+'</table>'+(next?'<a class="next" href="#">Older</a>':'')+'</html>';
function publish(entries){site.clear();const pages=Math.ceil(entries.length/50)||1;for(let p=1;p<=pages;p++)site.set(url(p),pageHtml(entries.slice((p-1)*50,p*50),p<pages));}
const day=n=>new Date(Date.UTC(2026,9,29)-n*86400000).toISOString().slice(0,10);
const record=lid=>records.get(`letterboxd/facts/films/lb-${lid}.json`);
const view=()=>records.get('enrichment/view-index.json')||{};
const report=runId=>({runId,updatedAt:new Date().toISOString(),watchlistCount:0,films:[],stats:{}});
const run=runId=>({runId,stage:'epg',events:[],ratingPending:['letterboxd-diary'],watchlist:[],pending:[]});
const commit=async runId=>{records.set('programme.json',report(runId));return ctx.completeWithRatings(env,run(runId),report(runId));};

// The rule, on the page just read, in display order (ADR 0064). The stored history is not the evidence.
// Latest watched date on that page; the first row of that day that shows a rating. An open edge, a next link,
// an uncertain count and a later row of the same day do not hide it. An older day does not stand in. No page: nothing.
const H={entries:{}};
const pageRows=[
 {lid:'D',watchedDate:'2026-06-01',ratingAtEntry:null,key:'d-new'},
 {lid:'A',watchedDate:'2026-01-01',ratingAtEntry:3,key:'a-old'},
 {lid:'A',watchedDate:'2026-05-01',ratingAtEntry:4.5,key:'a-new'},
 {lid:'B',watchedDate:'2026-05-01',ratingAtEntry:4,key:'b1'},
 {lid:'B',watchedDate:'2026-05-01',ratingAtEntry:3,key:'b2'},
 {lid:'C',watchedDate:'2026-05-01',ratingAtEntry:4,key:'c'},
 {lid:'E',watchedDate:'2026-05-01',ratingAtEntry:5,key:'viewing:9'},
 {lid:'F',watchedDate:'2026-05-01',ratingAtEntry:4,key:'f1'},
 {lid:'F',watchedDate:'2026-05-01',ratingAtEntry:4,key:'f2'},
 {lid:'D',watchedDate:'2026-01-01',ratingAtEntry:2,key:'d-old'}
];
assert.deepEqual(plain(D.ratingEvidence(H)),[]);
assert.deepEqual(plain(D.ratingEvidence(H,null,{rows:pageRows}).map(e=>[e.lid,e.watchedDate,e.rating,e.ratingState])),[
 ['A','2026-05-01',4.5,'rated'],['B','2026-05-01',4,'rated'],['C','2026-05-01',4,'rated'],['D','2026-06-01',null,'unrated'],['E','2026-05-01',5,'rated'],['F','2026-05-01',4,'rated']]);
assert.deepEqual(plain(D.ratingEvidence(H,new Set(['A']),{rows:pageRows}).map(e=>e.lid)),['A']);

// 1. Sixty diary rows over two pages: page 1 only. Every film on it becomes a watched fact and its visible rating a
// rating fact, including the last row; the films list is never requested; ratingHistory says first_observed at the watched date.
const sixty=Array.from({length:60},(_,i)=>({lid:'R'+i,date:day(i),stars:(i%10)+1}));
publish(sixty);
let done=await commit('r1');
assert.equal(done.stage,'complete');
assert.deepEqual(requests,[url(1)],'one diary page, nothing else');
let sync=records.get('sync.json');
assert.deepEqual([sync.diaryHistory.outcome,sync.diaryHistory.counts.added,sync.diaryHistory.facts.written,sync.diaryHistory.facts.rated,sync.diaryHistory.facts.partial,sync.diaryHistory.facts.ambiguous],['recent_window',50,50,50,0,0]);
assert.deepEqual([sync.ratingAttempt.state,sync.ratingAttempt.source,sync.ratingPending],['finished','letterboxd_diary',undefined]);
for(let i=0;i<50;i++){const r=record('R'+i);assert.equal(r.watched.value,true);assert.equal(r.rating.value,((i%10)+1)/2);assert.equal(r.rating.observedAt,day(i)+'T00:00:00.000Z');assert.equal(r.rating.source,'letterboxd_diary');}
assert.equal(record('R55'),undefined,'page 2 is not imported');
assert.deepEqual(plain(record('R3').ratingHistory.map(h=>[h.kind,h.value,h.observedAt])),[['first_observed',2,day(3)+'T00:00:00.000Z']]);
assert.deepEqual([view().R0.actualRating,view().R0.watched,view().R49.actualRating,view().R59],[0.5,true,5,undefined]);

// 2. Replay: the same diary again writes no fact record and adds no history.
writes.length=0;requests.length=0;
done=await commit('r2');
sync=records.get('sync.json');
assert.equal(writes.filter(key=>key.startsWith('letterboxd/facts/films/')).length,0,'no fact record rewritten');
assert.equal(sync.diaryHistory.facts.written,0);
assert.equal(record('R3').ratingHistory.length,1);

// 3. A newer observation wins over an older diary entry; a newer diary entry wins over an older observation.
const rec=record('R5');rec.rating={...rec.rating,value:1,observedAt:'2026-10-29T12:00:00.000Z',source:'letterboxd_film_page',observationId:'page-obs'};records.set('letterboxd/facts/films/lb-R5.json',rec);
records.set('enrichment/view-index.json',{...view(),R5:{...view().R5,actualRating:1}});
const rec7=record('R7');rec7.rating={...rec7.rating,value:1,observedAt:'2026-01-01T00:00:00.000Z',source:'letterboxd_film_page',observationId:'old-obs'};records.set('letterboxd/facts/films/lb-R7.json',rec7);
records.set('enrichment/view-index.json',{...view(),R7:{...view().R7,actualRating:1}});
done=await commit('r3');
assert.equal(record('R5').rating.value,1,'a newer film-page rating is never rolled back by an older diary entry');
assert.equal(view().R5.actualRating,1);
assert.equal(record('R7').rating.value,4,'a diary entry newer than the stored observation replaces it');
assert.equal(record('R7').ratingHistory.at(-1).value,4);

// 4. A re-rating on a newer diary date changes the rating once. Two same-day rows keep both history entries and the
// first visible rating. An unrated newer viewing and a watched film without a rating prove no rating. An older day
// on the same page does not override the chosen visible rating.
const next=[{lid:'R1',date:'2026-10-30',stars:10},{lid:'R2',date:'2026-10-30'},{lid:'R4',date:'2026-10-30',stars:2,viewing:'401'},{lid:'R4',date:'2026-10-30',stars:8,viewing:'402'},{lid:'Older',date:day(20),stars:10},{lid:'Older',date:'2026-10-30',stars:4},{lid:'Plain',date:'2026-10-30'},...sixty];
publish(next);writes.length=0;
done=await commit('r4');
sync=records.get('sync.json');
assert.equal(record('R1').rating.value,5);assert.equal(record('R1').ratingHistory.filter(h=>h.kind==='changed').length,1);
assert.equal(record('R2').rating.value,1.5,'an unrated newer viewing keeps the earlier rating');
assert.equal(record('R4').rating.value,1,'the first visible rated row of that day');
const r4entries=Object.values(records.get('letterboxd/diary/history.json').entries).filter(e=>e.identity?.value==='R4'&&e.watchedDate==='2026-10-30');
assert.equal(r4entries.length,2,'both viewing ids are kept');
assert.equal(record('Older').rating.value,2,'an older viewing on the page does not override the latest day');
assert.deepEqual([record('Plain').watched.value,record('Plain').rating],[true,undefined]);
assert.equal(sync.diaryHistory.facts.ambiguous,0);assert.equal(sync.diaryHistory.facts.partial,0);assert.ok(sync.diaryHistory.facts.unrated>=2);
done=await commit('r4b');
assert.equal(record('R1').ratingHistory.filter(h=>h.kind==='changed').length,1,'no duplicate history on replay');

// 5. Page 1 blocked keeps no new facts and names no resume page. A later run reads page 1 only; page 2 stays unread.
records.clear();etags.clear();requests.length=0;
publish(sixty);site.set(url(1),()=>respond(403,'<title>Just a moment...</title>'));
done=await commit('r5');
sync=records.get('sync.json');
assert.deepEqual([sync.diaryHistory.outcome,sync.diaryHistory.stopReason,sync.diaryHistory.resumePage,sync.ratingAttempt.state,sync.ratingAttempt.cause],['blocked','http_403_page_1',null,'error','blocked']);
assert.equal(record('R0'),undefined);
publish(sixty);site.set(url(2),()=>respond(403,'<title>Just a moment...</title>'));requests.length=0;
done=await commit('r6');
assert.deepEqual(requests,[url(1)]);assert.equal(record('R0').rating.value,0.5);assert.equal(record('R55'),undefined);

// 6. A facts write that fails stops the run at page 1; the next run reads that same page again and completes.
records.clear();etags.clear();requests.length=0;publish(sixty);failFactsFor='R10';
done=await commit('r7');
sync=records.get('sync.json');
assert.equal(done.stage,'complete','the commit completes');
assert.match(sync.diaryHistory.stopReason,/^after_page:.*_page_1$/);assert.equal(sync.ratingAttempt.state,'error');
failFactsFor=null;requests.length=0;
done=await commit('r8');
assert.deepEqual(requests,[url(1)],'page 1 is read again');assert.equal(record('R10').rating.value,0.5);

// 7. LETTERBOXD_FACTS is retired (ADR 0055): no stale value of it (absent, off, a near miss, an object) stops the diary
// facts; each run writes the same fact records and reports the facts as enabled.
for(const stale of [undefined,'off','On',{token:'x'}]){
 records.clear();etags.clear();writes.length=0;publish(sixty.slice(0,10));
 const staleEnv=stale===undefined?env:{...env,LETTERBOXD_FACTS:stale};
 records.set('programme.json',report('r9'));await ctx.completeWithRatings(staleEnv,run('r9'),report('r9'));
 assert.equal(writes.some(key=>key.startsWith('letterboxd/facts/films/')),true,'facts written, binding '+JSON.stringify(stale));
 assert.equal(records.get('sync.json').diaryHistory.facts.enabled,true,JSON.stringify(stale));
}

// 8. A rating on the last day of page 1 is used even when the viewing count is not exact. Two viewing ids of one film
// on that day keep both history entries and the first visible rating. A published or blocked page 2 is not fetched.
const fill=n=>Array.from({length:n},(_,i)=>({lid:'P'+i,date:day(i),stars:2}));
for(const blocked of [false,true]){
 records.clear();etags.clear();requests.length=0;
 publish([...fill(47),{lid:'Edge',date:day(80),stars:8},{lid:'Split',date:day(80),stars:6,viewing:'901'},{lid:'Split',date:day(80),stars:10,viewing:'902'},...fill(10).map(e=>({...e,lid:'Q'+e.lid,date:day(81)}))]);
 if(blocked)site.set(url(2),()=>respond(403,'<title>Just a moment...</title>'));
 await commit('split-'+blocked);
 assert.deepEqual(requests,[url(1)],'blocked='+blocked);
 assert.equal(record('Edge').rating.value,4);
 const edge=(await D.readHistory(env,{filmId:'Edge'})).film;
 assert.equal(edge.viewingCountExact,false,'the cut day stays a lower bound and the rating is still used');
 assert.equal(record('Split').rating.value,3,'the first visible rated row');
 const splits=Object.values(records.get('letterboxd/diary/history.json').entries).filter(e=>e.identity?.value==='Split');
 assert.equal(splits.length,2);
 assert.equal(records.get('sync.json').diaryHistory.facts.partial,0);
 assert.equal(records.get('sync.json').diaryHistory.facts.ambiguous,0);
}
records.clear();etags.clear();
publish([...fill(10),{lid:'Split',date:day(60),stars:8,viewing:'901'},{lid:'Split',date:day(60),stars:10,viewing:'902'},{lid:'Same',date:day(61),stars:6,viewing:'903'},{lid:'Same',date:day(61),stars:6,viewing:'904'},{lid:'Last',date:day(62),stars:4}]);
await commit('split-whole');
assert.equal(record('Split').rating.value,4);assert.equal(record('Same').rating.value,3);

// 9. A removed film with a stored rating whose latest diary entry proves none is not spared the per-film lookup, and
// the stored rating is not reported as diary proof.
records.clear();etags.clear();
const lookupEnv={...env,REMOVAL_RATING_LOOKUP:'on'};
publish([{lid:'Old',date:day(1),stars:6},{lid:'Gone',date:day(30),stars:8},{lid:'Tail',date:day(40)}]);
await commit('prior');
assert.equal(record('Gone').rating.value,4,'rated at the time it was the latest');
publish([{lid:'Gone',date:'2026-10-30'},{lid:'Old',date:day(1),stars:6},{lid:'Gone',date:day(30),stars:8},{lid:'Tail',date:day(40)}]);
requests.length=0;
const removalRun={...run('rm'),removalLookups:[{id:'Gone',url:'https://letterboxd.com/film/gone/'}],events:[{id:'rm-watchlist',type:'watchlist',at:new Date().toISOString(),total:0,added:[],removed:[{id:'Gone',title:'Gone',year:2001}]}]};
records.set('programme.json',report('rm'));await ctx.completeWithRatings(lookupEnv,removalRun,report('rm'));
assert.ok(requests.some(u=>u.includes(`/${USER}/film/gone/`)),'the lookup still runs');
assert.equal(records.get('sync.json').removalDiaryResolved,undefined);
assert.equal(record('Gone').rating.value,4,'the stored rating stays');

// 10. Worst case for one commit: one full page of films never seen (50 facts records), bounded R2 operations.
records.clear();etags.clear();let ops=0;const realGet=bucket.get,realPut=bucket.put;
bucket.get=async function(...a){ops++;return realGet.apply(this,a);};bucket.put=async function(...a){ops++;return realPut.apply(this,a);};
publish(Array.from({length:200},(_,i)=>({lid:'W'+i,date:day(i),stars:(i%10)+1})));requests.length=0;
const started=Date.now();await commit('worst');const elapsed=Date.now()-started;
bucket.get=realGet;bucket.put=realPut;
assert.deepEqual(requests,[url(1)]);
assert.equal(Object.keys(records.get('letterboxd/diary/history.json').entries).length,50);
assert.ok(ops<=250,'R2 operations for 50 new films: '+ops);
fs.writeFileSync(process.env.DIARY_WORST_CASE_OUT||'/dev/null',JSON.stringify({films:50,r2Operations:ops,ms:elapsed}));

console.log('Diary-first ratings (AIR-304): page order, first visible rating, one page of 50 as facts, no films list, replay without writes, newer observation wins either way, re-rating once, unrated newer day and watched-only prove no rating, older day does not override, page 1 blocked then retried, failed facts write re-reads page 1, facts gate, edge rating kept with an inexact count, both viewing ids kept, stored rating never taken as diary proof, bounded R2 operations for 50 new films passed');
