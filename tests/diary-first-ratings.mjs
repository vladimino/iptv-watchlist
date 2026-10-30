// AIR-287 / ADR 0054: Diary-first EPG ratings. Synthetic diary pages only; no real Letterboxd request.
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
const env={LETTERBOXD_USERNAME:USER,EPG_XML_URL:'https://epg.test/guide.xml',BUCKET:bucket,LETTERBOXD_DIARY_HISTORY:'on',LETTERBOXD_FACTS:'on'};
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

// The rule, on stored history alone: latest watched date; rated only when that date's rows are all known and agree.
const H={entries:{
 a1:{key:'a1',keyBasis:'identity_date',identity:{type:'letterboxd_lid',value:'A'},watchedDate:'2026-01-01',viewings:1,viewingsCertain:true,ratingsAtEntry:[3]},
 a2:{key:'a2',keyBasis:'identity_date',identity:{type:'letterboxd_lid',value:'A'},watchedDate:'2026-05-01',viewings:1,viewingsCertain:true,ratingsAtEntry:[4.5]},
 b:{key:'b',keyBasis:'identity_date',identity:{type:'letterboxd_lid',value:'B'},watchedDate:'2026-05-01',viewings:2,viewingsCertain:true,ratingsAtEntry:[4,3]},
 c:{key:'c',keyBasis:'identity_date',identity:{type:'letterboxd_lid',value:'C'},watchedDate:'2026-05-01',viewings:2,viewingsCertain:false,ratingsAtEntry:[4]},
 d1:{key:'d1',keyBasis:'identity_date',identity:{type:'letterboxd_lid',value:'D'},watchedDate:'2026-01-01',viewings:1,viewingsCertain:true,ratingsAtEntry:[2]},
 d2:{key:'d2',keyBasis:'identity_date',identity:{type:'letterboxd_lid',value:'D'},watchedDate:'2026-06-01',viewings:1,viewingsCertain:true,ratingsAtEntry:[null]},
 e:{key:'viewing:9',keyBasis:'viewing_id',identity:{type:'letterboxd_lid',value:'E'},watchedDate:'2026-05-01',viewings:1,viewingsCertain:true,ratingAtEntry:5},
 f:{key:'f',keyBasis:'identity_date',identity:{type:'letterboxd_lid',value:'F'},watchedDate:'2026-05-01',viewings:2,viewingsCertain:true,ratingsAtEntry:[4,4]},
 u:{key:'u',keyBasis:'identity_date',identity:null,aliases:[{type:'letterboxd_slug',value:'unresolved'}],watchedDate:'2026-05-01',viewings:1,viewingsCertain:true,ratingsAtEntry:[5]}
}};
assert.deepEqual(plain(D.ratingEvidence(H).map(e=>[e.lid,e.watchedDate,e.rating,e.ratingState])),[
 ['A','2026-05-01',4.5,'rated'],['B','2026-05-01',null,'ambiguous'],['C','2026-05-01',null,'partial'],['D','2026-06-01',null,'unrated'],['E','2026-05-01',5,'rated'],['F','2026-05-01',4,'rated']]);
assert.deepEqual(plain(D.ratingEvidence(H,new Set(['A'])).map(e=>e.lid)),['A']);

// 1. Sixty diary rows over two pages: every film becomes a watched fact and its proved rating a rating fact, with no cap;
// the films list is never requested; ratingHistory says first_observed at the watched date.
const sixty=Array.from({length:60},(_,i)=>({lid:'R'+i,date:day(i),stars:(i%10)+1}));
publish(sixty);
let done=await commit('r1');
assert.equal(done.stage,'complete');
assert.deepEqual(requests,[url(1),url(2)],'two diary pages, nothing else');
let sync=records.get('sync.json');
// The two rows at the page boundary (R49, R50) are watched but their day is not proved by one page: no rating yet.
assert.deepEqual([sync.diaryHistory.outcome,sync.diaryHistory.counts.added,sync.diaryHistory.facts.written,sync.diaryHistory.facts.rated,sync.diaryHistory.facts.partial],['complete',60,60,58,2]);
assert.deepEqual([sync.ratingAttempt.state,sync.ratingAttempt.source,sync.ratingPending],['finished','letterboxd_diary',undefined]);
for(let i=0;i<60;i++){const r=record('R'+i);assert.equal(r.watched.value,true);if(i===49||i===50){assert.equal(r.rating,undefined);continue;}assert.equal(r.rating.value,((i%10)+1)/2);assert.equal(r.rating.observedAt,day(i)+'T00:00:00.000Z');assert.equal(r.rating.source,'letterboxd_diary');}
assert.deepEqual(plain(record('R3').ratingHistory.map(h=>[h.kind,h.value,h.observedAt])),[['first_observed',2,day(3)+'T00:00:00.000Z']]);
assert.deepEqual([view().R0.actualRating,view().R0.watched,view().R59.actualRating],[0.5,true,5]);

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

// 4. A re-rating on a newer diary date changes the rating once; an unrated newer viewing, an ambiguous day and a watched
// film without any rating prove no rating and change none.
const next=[{lid:'R1',date:'2026-10-30',stars:10},{lid:'R2',date:'2026-10-30'},{lid:'R4',date:'2026-10-30',stars:2},{lid:'R4',date:'2026-10-30',stars:8},{lid:'Plain',date:'2026-10-30'},...sixty];
publish(next);writes.length=0;
done=await commit('r4');
sync=records.get('sync.json');
assert.equal(record('R1').rating.value,5);assert.equal(record('R1').ratingHistory.filter(h=>h.kind==='changed').length,1);
assert.equal(record('R2').rating.value,1.5,'an unrated newer viewing keeps the earlier rating');
assert.equal(record('R4').rating.value,2.5,'an ambiguous day keeps the earlier rating');
assert.deepEqual([record('Plain').watched.value,record('Plain').rating],[true,undefined]);
assert.ok(sync.diaryHistory.facts.ambiguous>=1&&sync.diaryHistory.facts.unrated>=2);
done=await commit('r4b');
assert.equal(record('R1').ratingHistory.filter(h=>h.kind==='changed').length,1,'no duplicate history on replay');

// 5. Partial coverage: page 2 blocked keeps page 1's facts, reports blocked with its resume point; a later run resumes.
records.clear();etags.clear();requests.length=0;
publish(sixty);site.set(url(2),()=>respond(403,'<title>Just a moment...</title>'));
done=await commit('r5');
sync=records.get('sync.json');
assert.deepEqual([sync.diaryHistory.outcome,sync.diaryHistory.stopReason,sync.diaryHistory.resumePage,sync.ratingAttempt.state,sync.ratingAttempt.cause],['blocked','http_403_page_2',2,'error','blocked']);
assert.equal(record('R0').rating.value,0.5);assert.equal(record('R55'),undefined);
publish(sixty);requests.length=0;
done=await commit('r6');
assert.deepEqual(requests,[url(1),url(2)]);assert.equal(record('R55').rating.value,3);

// 6. A facts write that fails stops the run at that page; the next run reads it again and completes, nothing lost.
records.clear();etags.clear();requests.length=0;publish(sixty);failFactsFor='R55';
done=await commit('r7');
sync=records.get('sync.json');
assert.equal(done.stage,'complete','the commit completes');
assert.match(sync.diaryHistory.stopReason,/^after_page:.*_page_2$/);assert.equal(sync.ratingAttempt.state,'error');
failFactsFor=null;requests.length=0;
done=await commit('r8');
assert.deepEqual(requests,[url(1),url(2)],'page 2 is read again');assert.equal(record('R55').rating.value,3);

// 7. Without LETTERBOXD_FACTS: the diary is read, no fact is written.
records.clear();etags.clear();writes.length=0;publish(sixty.slice(0,10));
records.set('programme.json',report('r9'));await ctx.completeWithRatings({...env,LETTERBOXD_FACTS:'off'},run('r9'),report('r9'));
assert.equal(writes.some(key=>key.startsWith('letterboxd/facts/')||key==='enrichment/view-index.json'),false);
assert.equal(records.get('sync.json').diaryHistory.facts.enabled,false);

console.log('Diary-first ratings (AIR-287): rule on latest watched date, 60 rows over two pages as facts with no cap, no films list, replay without writes, newer observation wins either way, re-rating once, unrated/ambiguous/watched-only prove no rating, blocked page 2 resumes, failed facts write re-reads its page, facts gate passed');
