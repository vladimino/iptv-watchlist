// AIR-541 (ADR 0177): the client of the degraded read path. Data from a saved copy is labelled, read-only (controls disabled, no write sent, `X-Data-Origin: mirror` on any write that
// is sent), kept only in memory, replaced by the authoritative source only after a successful authoritative read, and a film that cannot be read is a neutral shell with a retry,
// never "absent". Local stand-ins only: no network.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';


const source=fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,'');
const nodes=new Map(),classes=new Set(),stack=[],fetches=[];let index=-1;
const element=selector=>({selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,open:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},addEventListener(){},removeEventListener(){},focus(){},querySelector(){return null;},querySelectorAll(){return [];},closest(){return null;},contains(){return false;},appendChild(){},remove(){}});
const query=selector=>{if(!nodes.has(selector))nodes.set(selector,element(selector));return nodes.get(selector);};
const window={
 scrollY:0,scrollTo(_x,y){window.scrollY=y;},location:{href:'https://iptv.example/'},
 history:{
  get state(){return index>=0?stack[index].state:null;},
  pushState(state,_t,url){stack.splice(index+1);stack.push({href:new URL(url,window.location.href).href,state});index++;window.location.href=stack[index].href;},
  replaceState(state,_t,url){const href=new URL(url,window.location.href).href;if(index<0){stack.push({href,state});index=0;}else stack[index]={href,state};window.location.href=href;},
  back(){if(index<=0)return;index--;window.location.href=stack[index].href;run('onHistoryNavigation()');},
 },
};
const document={documentElement:{classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},add(name){classes.add(name);},remove(name){classes.delete(name);}}},querySelector:query,querySelectorAll(){return [];},addEventListener(){}};
const plan=new Map();
const live=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams,JSON,window,document,
 sessionStorage:{getItem:()=>null,setItem(){}},localStorage:{getItem:()=>null,setItem(){}},
 fetch(url,options){
  const text=String(url);fetches.push({url:text,method:options?.method||'GET'});
  const answer=plan.get(text);
  if(answer instanceof Error)return Promise.reject(answer);
  const {status=500,body={}}=answer||{};
  return Promise.resolve({ok:status>=200&&status<300,status,json:async()=>body,headers:{get(){return null;}}});
 }});
vm.runInContext(source,live);
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),live);
const run=(code,input)=>{live.input=input;return vm.runInContext(code,live);};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const html=id=>query(id).innerHTML;

const movie=n=>({status:'resolved',reason:null,link:{type:'movie',id:String(n)},links:[],attributes:{types:['movie'],ids:[String(n)]}});
const tv=n=>({status:'resolved',reason:null,link:{type:'tv',id:String(n)},links:[],attributes:{types:['tv'],ids:[String(n)]}});
const lid=(id,tmdbId,tmdbLink,extra={})=>({id,title:'Фильм '+id,original:'Original '+id,year:2001,runtime:100,genres:['Драма'],directors:[],actors:[],shows:[],synopsis:'секретный сюжет',tmdbId,...(tmdbLink===undefined?{}:{tmdbLink}),...extra});
const realNow=Date.now,now=Date.now(),hour=3600000;
const setFilms=list=>{live.listFilms=list;run('films=listFilms');};
const reset=({programmeReady=true}={})=>{
 plan.clear();fetches.length=0;stack.length=0;index=-1;window.location.href='https://iptv.example/';
 run(`films=[];report={runId:'G1',people:{directors:[],actors:[]},updatedAt:'2026-10-24T12:00:00Z',window:{from:${now-72*hour},to:${now+24*hour}}};enrichment={profile:null,films:{}};urlReady=true;catalogFilmReads.clear();findsSource={films:[],programmeRunId:null,generatedAt:null,ready:false,error:false,watchedMarkEnabled:false};programmeReady=${programmeReady};programmeRefreshError=false;filmScreen=null;filmHistory={filmId:null,status:'idle',events:[],data:null,error:null,truncated:false,token:0};similarMarkup=''`);
};
const entry=(n,extra={})=>({id:'tmdb_'+n,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,title:'Каталожный '+n,original:'Catalog '+n,year:2020,runtime:101,genres:['Триллер'],poster:null,url:'https://www.themoviedb.org/movie/'+n,directors:[],actors:[],shows:[],...extra});
const open=async id=>{run(`filmScreen=null;applyFilmScreen("${id}")`);await tick();await tick();};
const plain=value=>JSON.parse(JSON.stringify(value));
const meta={source:'mirror',readOnly:true,runId:'R1',asOf:'2026-11-19T10:00:00.000Z',reason:'published_epg_unavailable',joined:'best_effort'};
const film={id:'w1',title:'Фильм',original:'Film',year:2001,runtime:100,genres:['Драма'],directors:[],actors:[],shows:[],tmdbId:'42',tmdbLink:{status:'resolved',link:{type:'movie',id:'42'}}};

// ---- 1. the note, the state and the headers ----
reset();
assert.equal(run('isDegraded()'),false);
assert.deepEqual(plain(run('writeHeaders({"Content-Type":"application/json"})')),{'Content-Type':'application/json'},'a healthy page adds no header');
run('noteDegraded("programme",input)',meta);
assert.equal(run('isDegraded()'),true);
assert.equal(query('#degraded-note').hidden,false);assert.match(query('#degraded-note').textContent,/^Сохранённая копия · обновлена /);
assert.equal(query('#film-degraded-note').hidden,false);assert.match(query('#degraded-note').title,/изменения отключены/);assert.match(query('#degraded-note').title,/доступность сейчас не проверена/);
assert.deepEqual(plain(run('writeHeaders({"Content-Type":"application/json"})')),{'Content-Type':'application/json','X-Data-Origin':'mirror'},'a write that slips through is labelled');
assert.equal(run('degradedSources.size'),1);

// ---- 2. every write control is disabled and no write is sent ----
run('startedReady=true;startedIds=new Set();startedLoading=false;savingStarted.clear()');
const degradedButton=run('startedButton(input)',film);
assert.match(degradedButton,/disabled/);assert.match(degradedButton,/aria-disabled="true"/);
fetches.length=0;run('toggleStarted("w1")');await tick();
assert.deepEqual(fetches,[],'no POST /api/started while degraded');
run('findsSource.watchedMarkEnabled=true;findsSource.films=[input]',{id:'c1',tmdbId:'42',title:'Находка'});
assert.match(run('findsMarkAction(findsSource.films[0])'),/disabled aria-disabled="true"/);
fetches.length=0;await run('markFindWatched("42")');await run('undoFindWatched("42")');assert.deepEqual(fetches,[],'no POST /api/catalog/watched while degraded');
run('presetsEtag="e";presetSaving=false');
assert.equal(await run('createPreset("x")'),false);assert.deepEqual(fetches.filter(item=>item.method!=='GET'),[],'no preset write while degraded');
// Back to authoritative: the button is live again.
assert.equal(run('clearDegraded("programme")'),true);assert.equal(run('isDegraded()'),false);assert.equal(query('#degraded-note').hidden,true);
assert.doesNotMatch(run('startedButton(input)',film),/aria-disabled/);assert.deepEqual(plain(run('writeHeaders({})')),{});
assert.equal(run('clearDegraded("programme")'),false,'clearing what is not degraded is a no-op');

// ---- 3. the programme: a saved copy is shown on a cold load, never replaces what is already shown ----
const stubs='installProgramme=function(d){report=d;return true;};finishProgrammeUi=async function(){programmeReady=true;};refreshGenreOptions=function(){};updateFacetOptions=function(){};updateSourceInfo=function(){};renderPreservingScroll=function(){};renderFinds=function(){};loadStarted=async function(){loadedStarted++;return true;};updateProgrammeStatus=function(){};showProgrammeUnavailable=function(){};';
live.loadedStarted=0;run('var loadedStarted=0');run(stubs);
reset({programmeReady:false});plan.set('/api/programme',{status:200,body:{runId:'R1',films:[film],...meta}});
assert.equal(await run('loadProgramme()'),true);
assert.equal(run('isDegraded()'),true,'a cold load from a saved copy is shown, labelled and read-only');assert.equal(run('report.runId'),'R1');
// Recovery: the next AUTHORITATIVE programme ends the degradation and reloads the started marks; nothing was sent meanwhile.
plan.set('/api/programme',{status:200,body:{runId:'R2',films:[film]}});run('programmeLoading=false');
assert.equal(await run('loadProgramme()'),true);
assert.equal(run('isDegraded()'),false,'after an authoritative refresh the normal source and the actions return');assert.equal(run('loadedStarted'),1,'the started marks are read again from the authoritative source');
// An authoritative programme already in memory is the last known good: a later saved-copy answer does not replace it, but the page is READ-ONLY until an authoritative refresh succeeds.
plan.set('/api/programme',{status:200,body:{runId:'R0-old',films:[],...meta}});run('programmeLoading=false');
assert.equal(await run('loadProgramme()'),false);assert.equal(run('report.runId'),'R2','the authoritative result stays in memory');
assert.equal(run('isDegraded()'),true,'the unsafe state is gone: a refresh that failed makes the page read-only');assert.equal(run('degradedSources.get("programme").kind'),'lkg');
assert.equal(run('mirrorSnapshotShown()'),false,'the data is authoritative, only its refresh failed: no saved-copy claims are suppressed');
assert.equal(run('programmeRefreshError'),true,'the page says the refresh failed, quietly');assert.match(query('#degraded-note').textContent,/^Сохранённая копия · обновлена /);
run('startedReady=true;startedIds=new Set();startedLoading=false;savingStarted.clear()');
assert.match(run('startedButton(input)',film),/disabled/);fetches.length=0;run('toggleStarted("w1")');await tick();assert.deepEqual(fetches,[],'no write from a page whose refresh failed');
assert.deepEqual(plain(run('writeHeaders({})')),{'X-Data-Origin':'mirror'});
// The next authoritative refresh restores the actions and reads the started marks again.
plan.set('/api/programme',{status:200,body:{runId:'R3',films:[film]}});run('programmeLoading=false;loadedStarted=0');
assert.equal(await run('loadProgramme()'),true);assert.equal(run('isDegraded()'),false);assert.equal(run('loadedStarted'),1);assert.doesNotMatch(run('startedButton(input)',film),/aria-disabled/);
// A refresh that fails outright (a network error, or a 503 with no usable saved copy) has the same read-only consequence, and the data stays.
for(const failure of [new Error('offline'),{status:503,body:{error:'x'}}]){
 plan.set('/api/programme',failure);run('programmeLoading=false');
 assert.equal(await run('loadProgramme({quiet:true})'),false);
 assert.equal(run('report.runId'),'R3','the last authoritative result stays');assert.equal(run('isDegraded()'),true,'a failed refresh makes the page read-only: '+(failure.status||failure.message));
 fetches.length=0;run('toggleStarted("w1")');await tick();assert.deepEqual(fetches,[],'no write');
 plan.set('/api/programme',{status:200,body:{runId:'R3',films:[film]}});run('programmeLoading=false');await run('loadProgramme()');assert.equal(run('isDegraded()'),false,'and an authoritative success ends it');
}
assert.deepEqual(fetches.filter(item=>item.method!=='GET'),[]);

// ---- 3b. no claim about the PRESENT is derived from a saved schedule (ADR 0177 decision 5, owner A) ----
{
 const hourMs=3600000,at=Date.now();
 const live={...film,id:'tmdb_42',shows:[{channelId:'c',channel:'Канал',start:at-3*hourMs,end:at-hourMs},{channelId:'c',channel:'Канал',start:at+2*hourMs,end:at+4*hourMs}]};
 const setReport=()=>run(`films=[input];report={runId:"R1",updatedAt:"2026-11-19T10:00:00Z",window:{from:${at-72*hourMs},to:${at+24*hourMs}},people:{directors:[],actors:[]}};enrichment={profile:null,films:{}};ratingsLoaded=true`,live);
 reset();setReport();
 // Authoritative: the lifecycle talks about the present (an archive, a deadline).
 const normal=run('filmLifecycle(films[0])');
 assert.ok(normal.avail,'authoritative data has a lifecycle');assert.equal(typeof normal.avail.state,'string');
 assert.match(run('filmAvailability(films[0])'),/film-avail-head/);
 // Saved copy: the same stored shows, but no state, no deadline, no «скоро», no last-chance badge, no shortlist, no phase labels.
 run('noteDegraded("programme",input,"mirror")',meta);
 const saved=run('filmLifecycle(films[0])');
 assert.equal(saved.avail,null);assert.equal(saved.archive.length,0);assert.equal(saved.ahead.length,0);assert.equal(saved.saved.length,2,'the historical schedule is kept');
 assert.equal(run('filmAvail(films[0])'),null);assert.equal(run('isLastChance(films[0])'),false);assert.equal(run('archiveDeadline(films[0])'),null);assert.equal(run('soonBadge(films[0])'),'');assert.equal(run('lastChanceBadge(films[0])'),'');
 const head=run('filmAvailability(films[0])');
 assert.doesNotMatch(head,/Архив доступен до|Сейчас в эфире|В эфире|Повтор в эфире|Дальше|Готового архива|film-avail-head|last-chance|Скоро/);
 assert.match(head,/Расписание из сохранённой копии/);assert.match(head,/Доступность сейчас не проверена/);assert.equal((head.match(/class="show-row/g)||[]).length+(head.match(/film-show-row|show-row/g)||[]).length>=2,true,'the stored shows are still readable');
 const cardHtml=run('card(films[0])');
 assert.doesNotMatch(cardHtml,/АРХИВ|ДАЛЬШЕ|last-chance|soon-badge|Последний шанс|Скоро:/);assert.match(cardHtml,/СОХРАНЁННОЕ РАСПИСАНИЕ/);
 assert.equal(run('periodShows(films[0],"all").length'),2);assert.equal(run('periodShows(films[0],"archive").length'),0);assert.equal(run('periodShows(films[0],"soon").length'),0);
 assert.equal(run('inSelectedScope(films[0],"all")'),true,'the film is still listed');
 assert.deepEqual(plain(run('buildShortlist([films[0]],"available",Date.now())')),[],'no availability shortlist from a saved copy');
 run('renderShortlist([films[0]],true)');assert.match(query('#shortlist-empty').textContent,/сохранённой копии/);assert.match(query('#shortlist-caption').textContent,/не проверена/);
 // A last-known-good (authoritative data, failed refresh) is NOT a saved copy: its lifecycle is still computed.
 run('clearDegraded("programme");noteDegraded("programme",input,"lkg")',{asOf:null});
 assert.ok(run('filmLifecycle(films[0])').avail,'an authoritative result keeps its lifecycle when only the refresh failed');
 run('clearDegraded("programme")');
}

// ---- 3c. mixed authority: a valid D1 programme keeps its availability while ONE film outside it is shown from a saved copy ----
{
 const hourMs=3600000,at=Date.now();
 const shows=[{channelId:'c',channel:'Канал',start:at-3*hourMs,end:at-hourMs}];
 const d1Film={...film,id:'tmdb_42',shows};
 const win={from:at-72*hourMs,to:at+24*hourMs};
 reset();
 run(`films=[input];report={runId:"R9",updatedAt:"2026-11-19T10:00:00Z",window:${JSON.stringify(win)},people:{directors:[],actors:[]}};enrichment={profile:null,films:{}};ratingsLoaded=true;startedReady=true;startedIds=new Set();startedLoading=false;savingStarted.clear()`,d1Film);
 const before=plain(run('periodShows(films[0],"all")')).length;
 assert.ok(run('filmLifecycle(films[0])').avail,'the authoritative programme has a lifecycle');
 // Open a film that is NOT in the programme and whose catalog read alone fell back to a saved copy.
 plan.set('/api/catalog/film/99',{status:200,body:{status:'found',programmeRunId:'R1',film:entry(99,{shows}),...meta}});await open('tmdb_99');
 assert.equal(run('degradedSources.get("film:99").kind'),'mirror');assert.equal(run('mirrorSnapshotShown()'),false,'the programme is not a saved copy');
 const mirrored=run('resolveFilm("tmdb_99").film');
 assert.equal(run('savedCopyFilm(input)',mirrored),true);assert.equal(run('filmLifecycle(input).avail',mirrored),null,'the mirror-backed film makes no present-tense claim');
 assert.doesNotMatch(run('filmAvailability(input)',mirrored),/film-avail-head|Архив доступен до|В эфире/);
 assert.ok(run('filmLifecycle(films[0])').avail,'the D1 programme film keeps its availability while the other film is a saved copy');
 assert.equal(plain(run('periodShows(films[0],"all")')).length,before);assert.doesNotMatch(run('card(films[0])'),/СОХРАНЁННОЕ РАСПИСАНИЕ/);
 assert.match(run('filmAvailability(films[0])'),/film-avail-head/);
 assert.equal(run('isDegraded()'),true,'the write fence stays global and conservative');assert.match(run('startedButton(films[0])'),/disabled/);
 fetches.length=0;run('toggleStarted("tmdb_42")');await tick();assert.deepEqual(fetches.filter(item=>item.method!=='GET'),[]);
 // Navigating away does not change the programme's availability either.
 run('filmScreen=null;applyFilmScreen(null)');await tick();
 assert.ok(run('filmLifecycle(films[0])').avail,'after leaving the film the D1 programme still shows current availability');
 // Recovery: an authoritative programme read asks the mirror-backed film again; its authoritative answer ends the read-only state.
 run(stubs);plan.set('/api/programme',{status:200,body:{runId:'R9',films:[d1Film],window:win,updatedAt:'2026-11-19T10:00:00Z'}});
 plan.set('/api/catalog/film/99',{status:200,body:{status:'found',programmeRunId:'R9',film:entry(99,{shows})}});
 run('programmeLoading=false');assert.equal(await run('loadProgramme()'),true);await tick();await tick();await tick();
 assert.equal(run('isDegraded()'),false,'the film was asked again and its authoritative answer ended the degradation');
 assert.equal(run('catalogFilmReads.get("99").film.mirrorCopy'),undefined,'the authoritative film carries no saved-copy mark');
}

// ---- 4. the film page ----
// A film proven by the mirrors is shown with the note and no write.
reset();plan.set('/api/catalog/film/42',{status:200,body:{status:'found',programmeRunId:'R1',film:entry(42),...meta}});await open('tmdb_42');
assert.equal(query('#film-screen-title').textContent,'Каталожный 42');assert.equal(run('isDegraded()'),true);assert.equal(query('#film-degraded-note').hidden,false);
assert.equal(run('catalogFilmReads.get("42").mirror'),true);assert.equal(query('#film-screen-retry').hidden,true);
// The authoritative answer for the same film ends the degradation.
run('catalogFilmReads.get("42").at=0');plan.set('/api/catalog/film/42',{status:200,body:{status:'found',programmeRunId:'R2',film:entry(42,{title:'Каталожный 42 (D1)'})}});
run('resolveFilm("tmdb_42")');await tick();await tick();
assert.equal(run('isDegraded()'),false);assert.equal(run('catalogFilmReads.get("42").film.title'),'Каталожный 42 (D1)');
// A film nothing can prove: the neutral shell and a retry, not "not found".
reset();plan.set('/api/catalog/film/51',{status:503,body:{status:'unavailable',reason:'discovery_unavailable'}});await open('tmdb_51');
assert.equal(query('#film-screen-title').textContent,'Сведения пока не загружаются');
assert.match(query('#film-screen-status').textContent,/не значит, что фильма нет/);assert.equal(query('#film-screen-retry').hidden,false,'a retry is offered');
assert.notEqual(query('#film-screen-title').textContent,'Фильм не найден');assert.equal(query('#film-compare').hidden,true);
// The retry asks again and a later answer replaces the shell.
fetches.length=0;plan.set('/api/catalog/film/51',{status:200,body:{status:'found',programmeRunId:'R1',film:entry(51)}});
run('ensureCatalogFilm("51",{refresh:true})');await tick();await tick();
assert.equal(fetches.filter(item=>item.url==='/api/catalog/film/51').length,1);assert.equal(query('#film-screen-title').textContent,'Каталожный 51');assert.equal(query('#film-screen-retry').hidden,true);
// A confirmed absence is still an absence (only the authoritative route says it).
reset();plan.set('/api/catalog/film/52',{status:404,body:{status:'absent'}});await open('tmdb_52');
assert.equal(query('#film-screen-title').textContent,'Фильм не найден');assert.equal(query('#film-screen-retry').hidden,true,'no retry button on a settled absence');
// A mirror body that is not read-only is not trusted as a copy: it is treated like any found film (authoritative), so a missing flag cannot disable the page.
reset();plan.set('/api/catalog/film/53',{status:200,body:{status:'found',source:'mirror',film:entry(53)}});await open('tmdb_53');
assert.equal(run('isDegraded()'),false);
// LKG: a failed refresh keeps the film already shown (memory only).
reset();plan.set('/api/catalog/film/54',{status:200,body:{status:'found',programmeRunId:'R1',film:entry(54)}});await open('tmdb_54');
plan.set('/api/catalog/film/54',{status:503,body:{status:'unavailable'}});run('ensureCatalogFilm("54",{refresh:true})');await tick();await tick();
assert.equal(query('#film-screen-title').textContent,'Каталожный 54','the film already shown is kept through a transient failure');
assert.equal(run('isDegraded()'),true,'a film whose refresh failed is read-only');assert.equal(run('degradedSources.get("film:54").kind'),'lkg');
plan.set('/api/catalog/film/54',{status:200,body:{status:'found',programmeRunId:'R2',film:entry(54)}});run('ensureCatalogFilm("54",{refresh:true})');await tick();await tick();
assert.equal(run('isDegraded()'),false,'an authoritative read of the film ends it');

// ---- 5. nothing is persisted: a reload starts empty and authoritative-first ----
const appSource=fs.readFileSync('public/app.js','utf8');
const stateBlock=appSource.slice(appSource.indexOf('const degradedSources'),appSource.indexOf('function catalogPageFilm'));
assert.ok(!/localStorage|sessionStorage|indexedDB|caches\./.test(stateBlock),'the degraded state and its notice never touch browser storage');
assert.ok(!/localStorage\.setItem|sessionStorage\.setItem/.test(appSource.slice(appSource.indexOf('async function ensureCatalogFilm'),appSource.indexOf('function resolveFilm'))),'the film read never persists a result');
console.log('mirror fallback client: labelled read-only copy, disabled controls with no write, memory-only LKG, authoritative-only recovery, neutral film shell with retry');
