import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';

// Film page timeline: the UI reads GET /api/enrichment/history on demand and renders predictions, rating observations and
// Diary viewings in the API's order. The backend here is the real Worker route over an in-memory R2, so the UI is checked
// against the actual contract; 409, errors and races use scripted responses.
const records=new Map(),etags=new Map();let revision=0;
const bucket={
 async get(key){if(!records.has(key))return null;const text=records.get(key);return {etag:etags.get(key),text:async()=>text,json:async()=>JSON.parse(text)};},
 async put(key){throw new Error('history must not write '+key);},async delete(key){throw new Error('history must not delete '+key);},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const set=(key,value)=>{records.set(key,typeof value==='string'?value:JSON.stringify(value));etags.set(key,'e'+(++revision));};
const server=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,
 ASSETS:{'/':{body:'<!doctype html>',type:'text/html'}},INITIAL_PERSONAL_RATINGS:{},fetch:async input=>{throw new Error('history must not fetch '+input);}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),server);
for(const file of ['src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/prediction-diagnostics.js','src/mcp.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),server);
const env={BUCKET:bucket,EPG_XML_URL:'https://epg.test/guide.xml',LETTERBOXD_USERNAME:'tester'};

const nodes=new Map();
function element(selector){return {selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,open:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},focus(){},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){}};}
const query=selector=>{if(!nodes.has(selector))nodes.set(selector,element(selector));return nodes.get(selector);};
const requests=[];let scripted=null;
const ui=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams,JSON,Promise,
 window:{scrollY:0,scrollTo(){},location:{href:'https://iptv.example/film/dia'},history:{state:null,pushState(){},replaceState(){},back(){}}},
 document:{documentElement:{classList:{toggle(){},add(){},remove(){}}},querySelector:query,querySelectorAll(){return [];},addEventListener(){}},
 async fetch(url){requests.push(String(url));if(scripted)return scripted(String(url));return server.worker.fetch(new Request('https://iptv.example'+url),env,{waitUntil(){throw new Error('no background work');}});}});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ui);
const run=code=>vm.runInContext(code,ui);
const html=()=>query('#film-screen-history').innerHTML;
const text=()=>html().replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
const order=(...parts)=>{const page=text();let at=-1;for(const part of parts){const next=page.indexOf(part,at+1);assert.ok(next>at,'"'+part+'" after the previous part in: '+page);at=next;}};
const open=async id=>{run(`filmScreen=${JSON.stringify(id)};renderFilmShell()`);await run('loadFilmHistory(String(filmScreen))');};

// Film `dia` (lid) with TMDB 501: two predictions, a rating first seen from the Diary and changed by the owner, Diary entries.
const d=(day,h=10)=>'2026-09-'+String(day).padStart(2,'0')+'T'+String(h).padStart(2,'0')+':00:00.000Z';
set('enrichment/profile/current.json',{version:2,profileHash:'p2'});
set('enrichment/films/dia/predictions.json',{current:{filmId:'dia',predictedRating:4,probability4Plus:.7,confidence:'high',matchSignals:['now'],mainRisk:'длинный',generatedAt:d(20),tasteProfileVersion:2,tasteProfileHash:'p2',runId:'r2',trigger:'scheduled',fingerprintPromptVersion:1},
 history:[{filmId:'dia',predictedRating:3,matchSignals:['then','<b>x</b>'],mainRisk:'старый риск',generatedAt:d(1),replacedAt:d(20),tasteProfileVersion:1,tasteProfileHash:'p1'}]});
set('letterboxd/facts/links.json',{'letterboxd:dia':'tmdb-501','tmdb:501':'tmdb-501','letterboxd:dia-old':'tmdb-501'});
set('letterboxd/facts/films/tmdb-501.json',{schemaVersion:1,factKey:'tmdb-501',links:{letterboxd:'dia',tmdb:'501'},rating:{value:4.5,observedAt:d(22),source:'owner',observationId:'o2'},
 ratingHistory:[{kind:'first_observed',recordedAt:d(6),value:4,observedAt:'2026-09-05T00:00:00.000Z',source:'letterboxd_diary',sourceRef:'diary:viewing:111',observationId:'o1',previous:null},
  {kind:'changed',recordedAt:d(22),value:4.5,observedAt:d(22),source:'owner',observationId:'o2',previous:{value:4,observedAt:'2026-09-05T00:00:00.000Z',source:'letterboxd_diary',observationId:'o1'}}]});
const entry=(key,fields)=>({key,source:'letterboxd_diary',identity:{type:'letterboxd_lid',value:'dia'},aliases:[{type:'letterboxd_slug',value:'dia-film',firstObservedAt:d(28)}],firstObservedAt:d(28),observedAt:d(29),page:1,changes:[],...fields});
set('letterboxd/diary/history.json',{schemaVersion:1,entries:{
 'viewing:111':entry('viewing:111',{keyBasis:'viewing_id',viewingId:'111',watchedDate:'2026-09-05',viewings:1,viewingsCertain:true,ratingAtEntry:4,ratingsAtEntry:[4],rewatch:false,changes:[{field:'ratingAtEntry',from:3.5,to:4,observedAt:d(29)}]}),
 'day:lid:dia|2026-09-20':entry('day:lid:dia|2026-09-20',{keyBasis:'identity_date',viewingId:null,watchedDate:'2026-09-20',viewings:2,viewingsCertain:true,ratingAtEntry:null,ratingsAtEntry:[3.5,5],rewatch:true,rewatchRows:1,rewatchUnknownRows:0}),
 'day:lid:dia|2026-09-25':entry('day:lid:dia|2026-09-25',{keyBasis:'identity_date',viewingId:null,watchedDate:'2026-09-25',viewings:1,viewingsCertain:false,ratingAtEntry:2,ratingsAtEntry:[2],rewatch:'unknown',rewatchRows:0,rewatchUnknownRows:1}),
 'day:lid:other|2026-09-07':{...entry('day:lid:other|2026-09-07',{keyBasis:'identity_date',watchedDate:'2026-09-07',viewings:1,viewingsCertain:true,ratingAtEntry:1,ratingsAtEntry:[1],rewatch:false,rewatchRows:0,rewatchUnknownRows:0}),identity:{type:'letterboxd_lid',value:'other'}}}});
set('letterboxd/diary/state.json',{schemaVersion:1,lastOutcome:'partial',coverage:{newestWatchedDate:'2026-09-25',oldestWatchedDate:'2026-01-01',reachedEnd:false},resumePage:4});

const films=[{id:'dia',title:'Диа',genres:[],directors:[],actors:[],shows:[]},{id:'tmdb_501',title:'Диа (TMDB)',genres:[],directors:[],actors:[],shows:[]},{id:'dia-old',title:'Старый lid',genres:[],directors:[],actors:[],shows:[]},
 {id:'tmdb_777',title:'Без Diary',genres:[],directors:[],actors:[],shows:[]},{id:'bad.id',title:'Странный id',genres:[],directors:[],actors:[],shows:[]},{id:'long',title:'Длинная',genres:[],directors:[],actors:[],shows:[]}];
ui.filmsSeed=films;
run(`films=filmsSeed;enrichment={films:{dia:{actualRating:4.5,prediction:{predictedRating:4,matchSignals:['now']}}}};report={window:{from:0,to:1},people:{directors:[],actors:[]}};urlReady=true`);

// The page renders without the history: a button, no request.
run(`filmScreen='dia';renderFilmShell()`);
assert.equal(requests.length,0,'rendering the film page does not fetch the history');
assert.match(html(),/data-history-action="open"/);assert.match(query('#film-screen-score').innerHTML,/4\.5/);

// Prediction → Diary viewing → rating observation in one chronology, in the API's order.
await run(`filmHistoryAction('open')`);
assert.deepEqual(requests,['/api/enrichment/history?filmId=dia&limit=100']);
order('Прогноз 3.0','5 сент. 2026','Просмотр','Оценка 4.0 впервые замечена','Прогноз 4.0','20 сент. 2026','2 просмотра за день','Оценка 4.0 → 4.5','25 сент. 2026','Просмотр','возможно, больше');
{
 const page=html(),plain=text();
 assert.match(plain,/then, &lt;b&gt;x&lt;\/b&gt;|then, <b>x<\/b>/,'the old prediction keeps its own rationale');assert.doesNotMatch(page,/<b>x<\/b>/,'stored text is escaped');
 assert.match(plain,/Основной риск старый риск/);assert.match(plain,/заменён/);assert.match(plain,/без неизменяемой версии/);
 assert.match(plain,/Не сохранено в этой версии: .*runId/,'unknown lineage of an old version is said, not filled');
 assert.equal((page.match(/history-current">сейчас/g)||[]).length,2,'the current prediction and the event that applied the current rating are marked');
 assert.match(page,/<time datetime="2026-09-05">5 сент\. 2026 г?\.?<\/time>/,'a Diary day is shown as that calendar day');
 assert.match(plain,/Diary Letterboxd · дата просмотра 5 сент\. 2026/,'a Diary-dated rating observation shows the watched day, not 02:00 Madrid');
 assert.doesNotMatch(plain,/5 сент\. 2026( г\.)?,? 0[12]:00/,'no invented time of day');
 assert.match(plain,/оценки в записях: 3\.5, 5\.0 · пересмотров 1/,'several viewings of one day stay one event with their ratings');
 assert.match(plain,/оценка в записи: 2\.0 · пересмотр: неизвестно/);assert.match(plain,/Изменения записи: оценка: 3\.5 → 4\.0/);
 assert.match(plain,/Оценка 4\.5 · вручную/,'the summary rating is the rating observation, never a rating at a Diary entry');
 assert.match(plain,/Diary 4\+ просмотра · последний 25 сент\. 2026 г?\.? ?· пересмотров 1\+/);
 assert.match(plain,/Число просмотров за некоторые дни — нижняя граница/);assert.match(plain,/Diary прочитан не полностью/);assert.match(plain,/Нет записи в Diary — не значит, что фильм не смотрели/);
 assert.doesNotMatch(plain,/1\.0/,'a viewing of another lid with the same slug is never shown');
 assert.match(page,/data-history-action="close"/);
}
// Idempotent: reading again renders the same events once.
{const first=html();await run(`filmHistoryAction('open')`);assert.equal(html(),first);}
// Close keeps the page and offers the history again.
run(`filmHistoryAction('close')`);assert.match(html(),/Показать историю/);

// Through the TMDB id: the same Diary, no predictions stored under that id.
await open('tmdb_501');
assert.doesNotMatch(text(),/Прогноз \d/);assert.match(text(),/2 просмотра за день/);assert.match(text(),/Прогноз не сохранён/);

// Lids that disagree: no Diary, said so; the rating history stays.
await open('dia-old');
assert.match(text(),/Diary не показан: идентификаторы расходятся/);assert.doesNotMatch(text(),/просмотра за день/);assert.match(text(),/Оценка 4\.0 → 4\.5/);
assert.match(text(),/Идентификаторы Letterboxd расходятся/);

// A film without anything stored and without a Diary link: an empty, honest answer.
await open('tmdb_777');
assert.match(text(),/Событий в истории нет/);assert.match(text(),/Diary не привязан к фильму/);assert.match(text(),/Оценка наблюдений нет/);

// Production today: no Diary history stored.
{
 const saved=records.get('letterboxd/diary/history.json');records.delete('letterboxd/diary/history.json');
 await open('dia');
 assert.match(text(),/Diary история Diary не сохранена/);assert.match(text(),/История Diary ещё не сохранена/);assert.doesNotMatch(text(),/просмотра за день/);
 set('letterboxd/diary/history.json','{broken');
 await open('dia');
 assert.match(text(),/История неполная/);assert.match(text(),/история Diary не читается/);
 set('letterboxd/diary/history.json',saved);
}

// A long history: the latest events stay visible, the earlier ones fold away without being dropped.
{
 const history=Array.from({length:11},(_,i)=>({filmId:'long',predictedRating:2+i/10,generatedAt:d(i+1),replacedAt:d(i+2)}));
 set('enrichment/films/long/predictions.json',{current:{filmId:'long',predictedRating:4,generatedAt:d(15)},history});
 await open('long');
 assert.match(html(),/<details class="history-earlier"><summary>Ранние события · 4<\/summary>/);
 assert.equal((html().match(/<li class="history-event/g)||[]).length,12,'every event is rendered');
 assert.match(html(),/<ol class="history-list" start="5">/);
}

// Paging: a change between pages restarts from the first page and never mixes versions or duplicates events.
{
 const event=(id,at,rating)=>({type:'prediction',at,position:'history',predictedRating:rating,identity:id,version:{status:'none'},missingFields:[]});
 const body=(events,next,extra={})=>({schemaVersion:1,filmId:'dia',snapshot:{sources:{diary:{status:'missing',link:{status:'linked'}}}},current:{prediction:null,rating:null,diary:null},partial:false,notes:[],events,page:{nextCursor:next},...extra});
 let calls=0;const respond=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 scripted=url=>{calls++;
  if(calls===1)return respond(200,body([event('a',d(1),1),event('b',d(2),2)],'2.x'));
  if(calls===2)return respond(409,{error:'history_changed'});
  if(calls===3)return respond(200,body([event('a',d(1),1),event('b',d(2),2)],'2.y'));
  return respond(200,body([event('b',d(2),2),event('c',d(3),3)],null,{partial:true}));};
 requests.length=0;await open('dia');
 assert.deepEqual(requests,['/api/enrichment/history?filmId=dia&limit=100','/api/enrichment/history?filmId=dia&limit=100&cursor=2.x','/api/enrichment/history?filmId=dia&limit=100','/api/enrichment/history?filmId=dia&limit=100&cursor=2.y']);
 order('Прогноз 1.0','Прогноз 2.0','Прогноз 3.0');assert.equal((html().match(/Прогноз 2\.0/g)||[]).length,1,'an event repeated across pages is shown once');
 assert.match(text(),/История неполная/,'a partial later page makes the whole answer partial');
 // A history that keeps changing gives up with an explicit message.
 scripted=url=>url.includes('cursor=')?respond(409,{error:'history_changed'}):respond(200,body([event('a',d(1),1)],'1.z'));
 await open('dia');assert.match(text(),/История менялась во время чтения/);assert.match(html(),/Повторить/);
 // Errors stay inside the section; the rest of the film page is untouched.
 scripted=()=>respond(404,{error:'not found'});await open('dia');assert.match(text(),/История для этого фильма недоступна/);assert.match(query('#film-screen-title').textContent,/Диа/);
 scripted=()=>{throw new TypeError('offline');};await open('dia');assert.match(text(),/Не удалось загрузить историю/);
 scripted=()=>respond(200,{nope:true});await open('dia');assert.match(text(),/Не удалось загрузить историю/);
 // A slow answer for one film never lands on another film's page.
 let release;scripted=()=>new Promise(resolve=>{release=()=>resolve(respond(200,body([event('z',d(9),9)],null)));});
 run(`filmScreen='dia';renderFilmShell()`);const pending=run('loadFilmHistory("dia")');
 run(`filmScreen='tmdb_777';renderFilmShell()`);scripted=()=>respond(200,body([],null));await run('loadFilmHistory("tmdb_777")');
 release();await pending;assert.doesNotMatch(text(),/Прогноз 9\.0/);assert.match(text(),/Событий в истории нет/);
 scripted=null;
}

// An id the API would refuse: no request, a plain message.
requests.length=0;run(`filmScreen='bad.id';renderFilmShell()`);
assert.match(text(),/История недоступна для этого идентификатора/);assert.doesNotMatch(html(),/data-history-action/);assert.equal(requests.length,0);

// The click handler on the film screen routes the history buttons.
assert.match(fs.readFileSync('public/app.js','utf8'),/closest\?\.\('\[data-history-action\]'\)/);
assert.match(fs.readFileSync('public/index.html','utf8'),/<div id="film-screen-score"><\/div>\s*<div id="film-screen-history"><\/div>/);
console.log('Film timeline: on-demand read, prediction → viewing → rating order, current markers, snapshot rationale, Diary day without time shift, Diary-dated rating, day counts and lower bounds, unknown re-watch, rating at entry kept apart, other lid never shown, TMDB id, identity disagreement, unlinked, missing and unreadable Diary, long history folding, 409 restart without duplicates, errors contained, stale answers dropped, invalid id passed');
