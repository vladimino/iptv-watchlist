import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// AIR-268: bounded per-film rating lookup for films removed from the watchlist, behind REMOVAL_RATING_LOOKUP.
const records=new Map(),etags=new Map(),fetches=[];let revision=0;
const QUEUE='enrichment/removal-rating-lookups.json';
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(bucket.killOutcome&&key===QUEUE&&Object.values(JSON.parse(value).films).some(entry=>entry.lastResult&&entry.lastResult!=='claimed'))throw new Error('isolate killed');
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};
 },
 async list({prefix='',cursor,limit=20}={}){const keys=[...records.keys()].filter(key=>key.startsWith(prefix)).sort();const offset=Number(cursor||0),slice=keys.slice(offset,offset+limit);return {objects:slice.map(key=>({key})),truncated:offset+limit<keys.length,cursor:String(offset+limit)};}
};
const review=(slug,rating)=>`<script type="application/ld+json">{"@type":"Review","author":[{"sameAs":"https://letterboxd.com/demo-user/"}],"itemReviewed":{"sameAs":"https://letterboxd.com/film/${slug}/"},"reviewRating":{"ratingValue":${rating}}}</script>`;
// Per-film page behavior by slug: a number is the owner's rating, 'none' a page without the owner's rating, 404, 403 or 429.
const pages=new Map();let diaryPage=null;
const diaryRow=(lid,stars,date)=>{const [y,m,d]=date.split('-');return `<tr class="diary-entry-row"><td><a href="/demo-user/diary/films/for/${y}/${m}/${d}/">${d}</a></td><td><div data-postered-identifier="{&quot;lid&quot;:&quot;${lid}&quot;}"></div></td><td>${stars?`<span class="rating rated-${stars}"></span>`:''}</td></tr>`;};
const ctx=vm.createContext({Response,Request,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console,setTimeout:fn=>fn(),fetch:async url=>{
 url=String(url);fetches.push(url);
 if(url.includes('/films/'))return {ok:false,status:403,text:async()=>'<title>Just a moment...</title>'};
 if(url.includes('/diary/'))return diaryPage?{ok:true,status:200,text:async()=>diaryPage}:{ok:false,status:403,text:async()=>'<title>Just a moment...</title>'};
 const slug=url.match(/\/film\/([a-z0-9-]+)\/$/)?.[1],page=pages.get(slug);
 if(page===403||page===429)return {ok:false,status:page,text:async()=>'<title>Just a moment...</title>'};
 if(typeof page==='number')return {ok:true,status:200,text:async()=>review(slug,page)};
 if(page==='none')return {ok:true,status:200,text:async()=>'<html>no review</html>'};
 return {ok:false,status:404,text:async()=>''};
}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const off={LETTERBOXD_USERNAME:'demo-user',EPG_XML_URL:'https://epg.test/guide.xml',BUCKET:bucket};
const env={...off,REMOVAL_RATING_LOOKUP:'on'};
const film=slug=>({id:'lb-'+slug,url:`https://letterboxd.com/film/${slug}/`});
const memberPages=()=>fetches.filter(url=>/\/demo-user\/film\//.test(url));
const queue=()=>records.get(QUEUE);
const plain=value=>JSON.parse(JSON.stringify(value));
const T0=Date.parse('2026-10-29T10:00:00.000Z'),H=3600000;

// 1. Gate off: nothing is queued, read or fetched, and the EPG completion is unchanged.
assert.equal(await ctx.lookupRemovalRatings(off,[film('gone')],T0),null);
assert.equal(records.has(QUEUE),false);
assert.equal(fetches.length,0);
for(const value of [undefined,'off','On',' on','true'])assert.equal(vm.runInContext('removalLookupEnabled',ctx)({REMOVAL_RATING_LOOKUP:value}),false,String(value));

// 2. The EPG commit does not read Diary. A later lookup rates a removed film on its own page; the films list is never requested (AIR-287);
// the removal event gets the rating once.
pages.set('gone',4.5);
const at='2026-10-29T09:00:00.000Z';
const event={id:'run-1-watchlist',type:'watchlist',at,total:1,baseline:false,added:[],removed:[{id:'lb-gone',title:'Gone',year:2019}]};
await ctx.writeEvent(env,event);
const report={runId:'run-1',updatedAt:at,watchlistCount:1,films:[{id:'stay',title:'Stay',year:2021,shows:[]}],stats:{}};
records.set('programme.json',report);
const run={runId:'run-1',stage:'epg',events:[structuredClone(event)],ratingPending:['letterboxd-diary'],watchlist:report.films,pending:[],removalLookups:[film('gone')]};
const completed=await ctx.completeWithRatings(env,run,report);
assert.equal(completed.stage,'complete');
assert.equal(completed.ratingsPipeline,'blocked');
assert.equal(fetches.filter(url=>url.includes('letterboxd.com')).length,0,'the commit requests nothing');
assert.deepEqual(plain(records.get('sync.json').removalLookups),[film('gone')],'an unmigrated commit leaves the hand-over');
const ref=vm.runInContext('removalHandoverRef',ctx)(run);
const looked=await ctx.lookupRemovalRatings(env,[film('gone')],Date.parse(at),ref);
assert.equal(looked.rated,1);
assert.equal(fetches.filter(url=>url.includes('/films/')).length,0,'no films-list request');
assert.ok(fetches.some(url=>url.includes('/demo-user/film/gone/')),'the removed film is looked up on its own page');
const stored=records.get([...records.keys()].find(key=>key.endsWith('run-1-watchlist.json')));
assert.equal(stored.removed[0].rating,4.5);
assert.equal([...records.keys()].filter(key=>key.startsWith('events/items/')).length,1,'no second event');
assert.equal(records.get('enrichment/view-index.json')['lb-gone'].actualRating,4.5);
assert.equal(queue().films['lb-gone'].state,'rated');
assert.equal(queue().films['lb-gone'].attempts,1);
const sync=records.get('sync.json');
assert.deepEqual(plain(sync.removalLookups),[film('gone')],'the commit does not clear the hand-over');
assert.equal(sync.ratingError,undefined);
assert.equal(sync.ratingAttempt,undefined);

// 2b. Diary first (AIR-287): a removed film whose rating the diary proves is not looked up; one the diary does not cover
// is. A blocked diary leaves every removed film to the bounded lookup.
const diaryEnv={...env,LETTERBOXD_DIARY_HISTORY:'on'},savedQueue=structuredClone(queue()),savedSync=structuredClone(records.get('sync.json'));
for(const [label,html,expectLookup] of [['proved','<html><head><title>Diary</title></head><table>'+diaryRow('lb-dproved',8,'2026-10-28')+diaryRow('lb-other',6,'2026-10-27')+'</table></html>',false],['blocked',null,true]]){
 records.delete(QUEUE);records.delete('letterboxd/diary/history.json');records.delete('letterboxd/diary/state.json');fetches.length=0;diaryPage=html;pages.set('dproved',2.5);pages.set('dmissing',3);
 const ev={id:'run-d-'+label+'-watchlist',type:'watchlist',at,total:0,baseline:false,added:[],removed:[{id:'lb-dproved',title:'P',year:2001},{id:'lb-dmissing',title:'M',year:2002}]};
 await ctx.writeEvent(diaryEnv,ev);
 const dRun={runId:'run-d-'+label,stage:'epg',events:[structuredClone(ev)],ratingPending:['letterboxd-diary'],watchlist:[],pending:[],removalLookups:[film('dproved'),film('dmissing')]};
 const done=await ctx.completeWithRatings(diaryEnv,dRun,{runId:'run-d-'+label,updatedAt:at,watchlistCount:0,films:[],stats:{}});
 assert.equal(done.stage,'complete');
 assert.equal(done.ratingsPipeline,'blocked');
 assert.equal(fetches.filter(url=>url.includes('letterboxd.com')).length,0,label+': the commit does not read Diary or look up films');
 assert.deepEqual(plain(records.get('sync.json').removalLookups).map(film=>film.id).sort(),['lb-dmissing','lb-dproved']);
 assert.equal(records.get('sync.json').removalDiaryResolved,undefined);
}
diaryPage=null;records.set(QUEUE,savedQueue);etags.set(QUEUE,String(++revision));records.set('sync.json',savedSync);

// 3. Duplicates and repeats: a rated film is neither queued twice nor fetched again.
fetches.length=0;
let summary=await ctx.lookupRemovalRatings(env,[film('gone'),film('gone')],T0);
assert.equal(summary.checked,0);
assert.equal(memberPages().length,0);
assert.equal(Object.keys(queue().films).length,1);

// 4. Mixed outcomes: rated, not found (final), not rated (retried later, never treated as watched).
records.delete(QUEUE);fetches.length=0;
pages.set('mixed-rated',3);pages.set('mixed-unrated','none');
summary=await ctx.lookupRemovalRatings(env,[film('mixed-rated'),film('mixed-missing'),film('mixed-unrated')],T0);
assert.deepEqual([summary.checked,summary.rated,summary.notRated,summary.pending],[3,1,1,1]);
const q=queue().films;
assert.equal(q['lb-mixed-rated'].state,'rated');
assert.equal(q['lb-mixed-missing'].state,'not_found');
assert.equal(q['lb-mixed-unrated'].state,'pending');
assert.equal(q['lb-mixed-unrated'].nextAttemptAt,new Date(T0+24*H).toISOString());
assert.equal(records.get('enrichment/view-index.json')['lb-mixed-unrated'],undefined,'no rating, no watched mark');

// 5. Not rated after the last attempt is final; nothing is fetched after that.
fetches.length=0;
await ctx.lookupRemovalRatings(env,[],T0+24*H);await ctx.lookupRemovalRatings(env,[],T0+48*H);
assert.equal(queue().films['lb-mixed-unrated'].state,'not_rated');
assert.equal(queue().films['lb-mixed-unrated'].attempts,3);
assert.equal(memberPages().length,2);
fetches.length=0;await ctx.lookupRemovalRatings(env,[],T0+96*H);
assert.equal(memberPages().length,0);

// 6. A 403 stops the batch: the films after it are not requested, and nothing is retried before the backoff.
records.delete(QUEUE);fetches.length=0;
pages.set('wall',403);pages.set('after-wall',4);
summary=await ctx.lookupRemovalRatings(env,[film('wall'),film('after-wall')],T0);
assert.equal(summary.stoppedBy,'blocked');
assert.deepEqual(memberPages().map(url=>url.match(/film\/([a-z-]+)\//)[1]),['wall'],'one request, no retry, the next film untouched');
assert.equal(queue().films['lb-wall'].lastResult,'blocked');
assert.equal(queue().films['lb-wall'].nextAttemptAt,new Date(T0+6*H).toISOString());
assert.equal(queue().films['lb-after-wall'].attempts,0);
fetches.length=0;await ctx.lookupRemovalRatings(env,[],T0+H);
assert.equal(memberPages().length,0,'inside the backoff nothing is requested, not even another film');
assert.equal(queue().pausedUntil,new Date(T0+6*H).toISOString());
pages.set('wall',2);
summary=await ctx.lookupRemovalRatings(env,[],T0+6*H);
assert.equal(summary.rated,2);
// 429 stops the batch the same way.
records.delete(QUEUE);fetches.length=0;pages.set('busy',429);pages.set('after-busy',4);
summary=await ctx.lookupRemovalRatings(env,[film('busy'),film('after-busy')],T0);
assert.equal(summary.stoppedBy,'rate_limited');
assert.equal(memberPages().length,1);

// 7. Killed request: the attempt was recorded before the request, so the film is retried later and counted, not looped.
records.delete(QUEUE);fetches.length=0;pages.set('killed',5);
bucket.killOutcome=true;
summary=await ctx.lookupRemovalRatings(env,[film('killed')],T0);
bucket.killOutcome=false;
assert.match(summary.error,/isolate killed/);
assert.equal(queue().films['lb-killed'].lastResult,'claimed');
assert.equal(queue().films['lb-killed'].attempts,1);
fetches.length=0;await ctx.lookupRemovalRatings(env,[],T0+30*60000);
assert.equal(memberPages().length,0,'not retried inside the claim window');
summary=await ctx.lookupRemovalRatings(env,[],T0+H);
assert.equal(queue().films['lb-killed'].state,'rated');
assert.equal(queue().films['lb-killed'].attempts,2);

// 8. More than five removals: five requests per call, the rest stay pending (never dropped) and follow on later calls.
records.delete(QUEUE);fetches.length=0;
const seven=Array.from({length:7},(_,i)=>film('seven-'+i));
for(let i=0;i<7;i++)pages.set('seven-'+i,4);
summary=await ctx.lookupRemovalRatings(env,seven,T0);
assert.deepEqual([memberPages().length,summary.rated,summary.pending,summary.queued],[5,5,2,7]);
summary=await ctx.lookupRemovalRatings(env,[],T0+1);
assert.deepEqual([memberPages().length,summary.rated,summary.pending],[7,2,0]);
assert.equal(Object.values(queue().films).every(entry=>entry.state==='rated'),true,'every removed film was looked up');

// 9. Bounded fan-out with a large diff: still five requests per call, every pending film kept (the cap counts finished
// entries only), invalid identities never queued.
records.delete(QUEUE);fetches.length=0;
const many=Array.from({length:150},(_,i)=>film('bulk-'+i));
for(let i=0;i<150;i++)pages.set('bulk-'+i,3);
summary=await ctx.lookupRemovalRatings(env,[...many,{id:'bad id',url:'https://letterboxd.com/film/x/'},{id:'ok',url:'https://example.com/film/x/'},{id:'ok2'}],T0);
assert.equal(memberPages().length,5);
assert.deepEqual([summary.queued,summary.pending],[150,145]);
assert.equal(Object.keys(queue().films).every(id=>id.startsWith('lb-bulk-')),true);
for(let i=1;i<=29;i++)await ctx.lookupRemovalRatings(env,[],T0+i);
assert.equal(memberPages().length,150,'one request per film, no repeats, none dropped');
assert.equal(new Set(memberPages()).size,150);
summary=await ctx.lookupRemovalRatings(env,[],T0+30);
assert.deepEqual([summary.pending,summary.queued],[0,100],'only finished entries are capped');

// 9b. Expiry: a film still pending after 14 days is kept as `expired` and not requested; finished entries are dropped.
records.delete(QUEUE);fetches.length=0;pages.set('late','none');pages.set('early',4);
await ctx.lookupRemovalRatings(env,[film('late'),film('early')],T0);
summary=await ctx.lookupRemovalRatings(env,[],T0+15*24*H);
assert.equal(queue().films['lb-late'].state,'expired');
assert.equal(queue().films['lb-early'],undefined);
assert.deepEqual([summary.expired,summary.pending],[1,0]);
fetches.length=0;await ctx.lookupRemovalRatings(env,[],T0+16*24*H);
assert.equal(memberPages().length,0);

// 10. The worker hands over only the films removed in this diff, with their Letterboxd URL.
assert.deepEqual(plain(vm.runInContext('removalLookupFilm',ctx)({id:'x',url:'https://letterboxd.com/film/x/',title:'X'})),{id:'x',url:'https://letterboxd.com/film/x/'});
assert.equal(vm.runInContext('removalLookupFilm',ctx)({id:'x',url:'https://letterboxd.com/demo-user/film/x/'}),null);
const source=fs.readFileSync('src/worker.js','utf8');
assert.match(source,/removed\.has\(String\(film\.id\)\)\)\.map\(removalLookupFilm\)/,'the hand-over is built from the removed ids of this run');

// 11. A hand-over left on a completed run is not looked up by the next step while migration is not complete (ADR 0074).
// The direct lookup above still rates a film, and a killed lookup still leaves the claim.
records.delete(QUEUE);fetches.length=0;pages.set('crash',3.5);
const crashEvent={id:'run-2-watchlist',type:'watchlist',at,total:0,baseline:false,added:[],removed:[{id:'lb-crash',title:'Crash',year:2018}]};
const crashReport={runId:'run-2',updatedAt:at,watchlistCount:0,films:[],stats:{}};
const crashRun={runId:'run-2',stage:'epg',events:[structuredClone(crashEvent)],ratingPending:['letterboxd-diary'],watchlist:[],pending:[],removalLookups:[film('crash')]};
await ctx.finishSync(env,crashRun,crashReport);
let saved=records.get('sync.json');
assert.equal(saved.stage,'complete');
assert.deepEqual(plain(saved.removalLookups),[film('crash')],'the hand-over survives in sync.json');
assert.equal(records.has(QUEUE),false,'nothing was queued');
const step={caller:'http',diagnostic:{}};
try{await ctx.syncStep(env,'/api/sync/epg',{runId:'run-2'},step);}catch{}
assert.equal(step.branch,'continuation');
assert.equal(records.has(QUEUE),false,'the continuation does not look up or enqueue');
saved=records.get('sync.json');
assert.deepEqual(plain(saved.removalLookups),[film('crash')]);
assert.equal(memberPages().length,0);
fetches.length=0;
try{await ctx.syncStep(env,'/api/sync/epg',{runId:'run-2'},{caller:'http',diagnostic:{}});}catch{}
assert.equal(memberPages().length,0,'a further step still requests nothing');
assert.deepEqual(plain(records.get('sync.json').removalLookups),[film('crash')]);

console.log('Removal rating lookup (AIR-268, ADR 0074): gate off untouched, per-film rating with no films list, diary-proved removals skip the lookup and a blocked diary falls back (AIR-287), one event, duplicates, mixed outcomes, final not-rated, 403/429 stop, killed request resumes without a loop, bounded fan-out, pruning, the commit leaves a hand-over and does not look up passed');
