// AIR-387: one permanent URL per film. `/film/tmdb_<n>` is the permalink of a TMDB movie, the Letterboxd id stays an alias that opens the same
// page, and a verified catalog-only film has a full internal page whatever its shows or prediction say. Local stand-ins only: no network, no TMDB.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

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

// ---- 1. Which films earn the TMDB permalink ----
reset();
assert.equal(run('routeTmdb("tmdb_42")'),'42');
for(const bad of ['tmdb_0','tmdb_042','tmdb_tv_42','tmdb_4.2','TMDB_42','tmdb_','tmdb_1234567890123','heat-1995','tmdb_42x',null,undefined,''])assert.equal(run('routeTmdb(input)',bad),null,'not a permalink: '+String(bad));
setFilms([lid('heat-1995','42',movie(42))]);
assert.equal(run('filmPermalinkId(listFilms[0])'),'tmdb_42','a record that proves a movie gets the permalink');
assert.equal(run('filmPath(listFilms[0])'),'/film/tmdb_42');
for(const [name,film] of [
 ['no tmdbLink (a record from before the field)',lid('a','42',undefined)],['tv link',lid('a','42',tv(42))],['link disagrees with the id',lid('a','42',movie(43))],
 ['unresolved',lid('a','42',{status:'unresolved',reason:'no_tmdb_link',link:null,links:[],attributes:{types:[],ids:[]}})],['review',lid('a','42',{status:'review',reason:'multiple_tmdb_links',link:null,links:[],attributes:{}})],
 ['no tmdbId',lid('a',null,movie(42))],['zero id',lid('a','0',movie(0))],['leading zero',lid('a','042',movie(42))],['not a number',lid('a','4x',movie(4))],['too long',lid('a','1234567890123',movie('1234567890123'))],
 ['link without a type',lid('a','42',{status:'resolved',link:{id:'42'}})],['link id as a number',lid('a','42',{status:'resolved',link:{type:'movie',id:43}})]]){
 setFilms([film]);
 assert.equal(run('filmPermalinkId(listFilms[0])'),'a','keeps the Letterboxd id: '+name);
 assert.equal(run('filmPath(listFilms[0])'),'/film/a');
}
setFilms([lid('a','42',movie(42)),lid('b','42',movie(42))]);
assert.deepEqual([run('filmPermalinkId(listFilms[0])'),run('filmPermalinkId(listFilms[1])')],['a','b'],'a number held by two loaded films is ambiguous: both keep their ids');
setFilms([lid('a','42',movie(42)),lid('b','42',tv(42))]);
assert.deepEqual([run('filmPermalinkId(listFilms[0])'),run('filmPermalinkId(listFilms[1])')],['tmdb_42','b'],'a TV record of the same number is another namespace and does not block the movie');
setFilms([lid('tmdb_42','7',movie(7))]);
assert.equal(run('filmPermalinkId(listFilms[0])'),'tmdb_42','a film whose own id is already a TMDB route keeps it');

// ---- 2. The programme card links to the permalink; the alias route opens the same film ----
setFilms([lid('heat-1995','42',movie(42)),lid('plain','77',undefined)]);
const card=run('card(listFilms[0])'),plain=run('card(listFilms[1])');
assert.match(card,/<a class="film-open" href="\/film\/tmdb_42" data-film-id="tmdb_42">/,'a proven movie links to its permalink');
assert.match(plain,/<a class="film-open" href="\/film\/plain" data-film-id="plain">/,'an unproven one keeps its Letterboxd id');
{
 const viaTmdb=run('resolveFilm("tmdb_42")'),viaLid=run('resolveFilm("heat-1995")');
 assert.deepEqual([viaTmdb.source,viaTmdb.status,viaTmdb.film.id,viaTmdb.alias],['programme','ready','heat-1995',true],'the permalink resolves to the programme film');
 assert.deepEqual([viaLid.source,viaLid.status,viaLid.film.id],['programme','ready','heat-1995'],'the Letterboxd id still resolves');
 assert.equal(run('resolveFilm("tmdb_77").status'),'loading','a number the programme cannot prove goes to the catalog read');
}
assert.equal(fetches.filter(entry=>/themoviedb|letterboxd\.com/.test(entry.url)).length,0);

// Opening by the alias moves the URL to the permalink in place: same entry, same `return`, nothing new in the history.
reset();
setFilms([lid('heat-1995','42',movie(42))]);
window.history.replaceState(null,'','https://iptv.example/?q=heat');
window.history.pushState({iptvFilm:'heat-1995',iptvHome:'/?q=heat'},'','https://iptv.example/film/heat-1995?return=%2F%3Fq%3Dheat');
const before=stack.length;
run('filmScreen=null;applyFilmScreen("heat-1995")');
assert.equal(new URL(window.location.href).pathname,'/film/tmdb_42','the visible URL is the permanent one');
assert.equal(new URL(window.location.href).searchParams.get('return'),'/?q=heat','the return target survives');
assert.equal(stack.length,before,'no new history entry');
assert.equal(run('filmScreen'),'tmdb_42');
assert.equal(query('#film-screen-title').textContent,'Фильм heat-1995');
assert.equal(query('#film-screen').dataset.filmId,'tmdb_42');
// An unproven film is not rewritten, and a reload of the alias still opens it.
reset();
setFilms([lid('plain','77',undefined)]);
window.history.replaceState(null,'','https://iptv.example/film/plain?return=%2F');
run('filmScreen=null;applyFilmScreen("plain")');
assert.equal(new URL(window.location.href).pathname,'/film/plain');

// ---- 3. A catalog-only film: the permanent read, every state ----
const entry=(n,extra={})=>({id:'tmdb_'+n,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,title:'Каталожный '+n,original:'Catalog '+n,year:2020,runtime:101,genres:['Триллер'],poster:null,url:'https://www.themoviedb.org/movie/'+n,directors:[{id:'tmdb_director/1',name:'Режиссёр'}],actors:[{id:'tmdb_actor/2',name:'Актёр'}],shows:[],availableNow:false,nextStart:null,availableUntil:null,prediction:{predictedRating:4.6,probability4Plus:.8,confidence:'high',matchSignals:['Расследование'],mainRisk:'Медленный старт',moodIds:['dark']},fingerprint:{plotMechanics:['investigation'],moodIds:['dark'],execution:{}},...extra});
const found=(n,extra,runId='G1')=>({status:200,body:{status:'found',programmeRunId:runId,film:entry(n,extra)}});
const open=async id=>{run(`filmScreen=null;applyFilmScreen("${id}")`);await tick();await tick();};

reset();
plan.set('/api/catalog/film/50',found(50));
await open('tmdb_50');
assert.deepEqual(fetches.map(f=>f.url),['/api/catalog/film/50'],'one read-only GET, nothing else');
assert.equal(query('#film-screen-title').textContent,'Каталожный 50');
assert.equal(query('#film-screen-status').textContent,'Только в каталоге');
assert.match(html('#film-screen-score'),/Прогноз<\/span><strong>4\.6<\/strong>/,'the current prediction');
assert.doesNotMatch(html('#film-screen-score'),/Оценка Letterboxd/,'no rating card for a film outside the watchlist');
assert.match(html('#film-screen-fingerprint'),/Расследование|investigation|Механика/i);
assert.match(html('#film-screen-credits'),/Режиссёр/);assert.match(html('#film-screen-credits'),/Актёр/);
assert.match(html('#film-screen-availability'),/Осталось показов <strong>0<\/strong>/,'zero shows is an honest placeholder');
assert.equal(html('#film-screen-synopsis'),'','no synopsis block');
assert.equal(html('#film-compare-result'),'','no compare result');
assert.equal(query('#film-compare').hidden,true,'the compare block is hidden');
assert.doesNotMatch(html('#film-screen-actions'),/data-started-id|Начал/,'no started control');
assert.match(html('#film-screen-actions'),/class="letterboxd-link" href="https:\/\/letterboxd\.com\/tmdb\/50"/,'the AIR-384 redirect for a verified catalog film');
assert.doesNotMatch(html('#film-screen-actions'),/themoviedb\.org/,'the TMDB url is never the Letterboxd link');
assert.equal(run('currentFilm().catalogRoute'),true);
// A second open is served from the session cache.
await open('tmdb_50');assert.equal(fetches.length,1,'cached for the session');
// A watchlist film keeps everything it had: started control, compare, synopsis.
reset();setFilms([lid('plain','77',undefined)]);
run('filmScreen=null;applyFilmScreen("plain")');
assert.equal(query('#film-compare').hidden,false);assert.match(html('#film-screen-synopsis'),/секретный сюжет/);assert.match(html('#film-screen-actions'),/data-started-id/);

// Every other answer is its own message, never a fake film.
const states=[[404,{status:'absent'},'Фильм не найден',/нет проверенного фильма/],[410,{status:'retired'},'Запись каталога снята',/заменена/],[409,{status:'conflict'},'Идентичность фильма не подтверждена',/конфликт/],[503,{status:'unavailable'},'Каталог сейчас недоступен',/Не удалось прочитать/],[500,{status:'error'},'Не удалось загрузить фильм',/ошибкой/]];
for(const [status,body,title,text] of states){
 reset();plan.set('/api/catalog/film/51',{status,body});await open('tmdb_51');
 assert.equal(query('#film-screen-title').textContent,title,String(status));assert.match(query('#film-screen-status').textContent,text);
 assert.equal(html('#film-screen-score'),'','no film, no score');assert.equal(run('currentFilm()'),null);
}
reset();plan.set('/api/catalog/film/51',new Error('offline'));await open('tmdb_51');
assert.equal(query('#film-screen-title').textContent,'Не удалось загрузить фильм','a network failure is an error, not "not found"');
reset();plan.set('/api/catalog/film/51',{status:200,body:{status:'found',film:entry(52)}});await open('tmdb_51');
assert.equal(query('#film-screen-title').textContent,'Не удалось загрузить фильм','a film of another identity than the route is refused');
reset();plan.set('/api/catalog/film/51',{status:200,body:{status:'found',film:entry(51,{tmdbId:'52'})}});await open('tmdb_51');
assert.equal(query('#film-screen-title').textContent,'Не удалось загрузить фильм','an identity that disagrees with its own tmdbId is refused');
reset();plan.set('/api/catalog/film/51',{status:200,body:{status:'found',film:entry(51,{canonicalIdentity:'tmdb_tv:51'})}});await open('tmdb_51');
assert.equal(query('#film-screen-title').textContent,'Не удалось загрузить фильм','a record without a verified movie identity is refused');
// A transient failure is asked again later, a settled answer is not.
reset();plan.set('/api/catalog/film/53',{status:503,body:{status:'unavailable'}});await open('tmdb_53');
assert.equal(fetches.length,1);run('renderFilmShell()');assert.equal(fetches.length,1,'not hammered on every render');
live.nowStamp=Date.now()+16000;run('Date.now=()=>nowStamp');plan.set('/api/catalog/film/53',found(53));run('renderFilmShell()');await tick();await tick();
assert.equal(fetches.length,2,'asked again after the pause');assert.equal(query('#film-screen-title').textContent,'Каталожный 53');
Date.now=realNow;
reset();plan.set('/api/catalog/film/54',{status:404,body:{status:'absent'}});await open('tmdb_54');run('renderFilmShell()');assert.equal(fetches.length,1,'an absence is settled for the session');

// ---- 4. No flicker and no second source mixed in ----
reset({programmeReady:false});
run('filmScreen=null;applyFilmScreen("tmdb_60")');
assert.equal(query('#film-screen-title').textContent,'Фильм');assert.equal(query('#film-screen-status').textContent,'Загружаем фильм…','while the programme loads, not "not found"');
assert.equal(fetches.length,0,'no read until the programme could still resolve the alias');
plan.set('/api/catalog/film/60',found(60));
run('programmeReady=true;renderFilmShell()');await tick();await tick();
assert.equal(fetches.length,1);assert.equal(query('#film-screen-title').textContent,'Каталожный 60');
// A film the Finds already hold opens at once, with no read.
reset();
live.held=entry(61);run('findsSource={films:[held],programmeRunId:"G1",generatedAt:null,ready:true,error:false,watchedMarkEnabled:false}');
run('filmScreen=null;applyFilmScreen("tmdb_61")');
assert.equal(query('#film-screen-title').textContent,'Каталожный 61');assert.equal(fetches.length,0,'a held film needs no request');
// A film that has since entered the watchlist opens as that film (the alias), and its catalog twin does not shadow it.
reset();setFilms([lid('heat-1995','62',movie(62))]);
live.held=entry(62);run('findsSource={films:[held],programmeRunId:"G1",generatedAt:null,ready:true,error:false,watchedMarkEnabled:false}');
assert.equal(run('resolveFilm("tmdb_62").film.id'),'heat-1995','catalog to watchlist keeps the permalink and shows the watchlist film');
assert.equal(fetches.length,0);
// Two watchlist films proving one number: a conflict, never a guess.
reset();setFilms([lid('a','63',movie(63)),lid('b','63',movie(63))]);
assert.equal(run('resolveFilm("tmdb_63").status'),'conflict');assert.equal(fetches.length,0);
// A generation change refreshes the film in the background and keeps the old one on screen until the new answer arrives.
reset();plan.set('/api/catalog/film/64',found(64,{title:'Старый'},'G1'));await open('tmdb_64');
assert.equal(query('#film-screen-title').textContent,'Старый');assert.equal(fetches.length,1);
plan.set('/api/catalog/film/64',found(64,{title:'Новый'},'G2'));
run("report.runId='G2'");run('renderFilmShell()');
assert.equal(query('#film-screen-title').textContent,'Старый','the old film stays while the refresh is in flight');
await tick();await tick();
assert.equal(query('#film-screen-title').textContent,'Новый');assert.equal(fetches.length,2);
run('renderFilmShell()');await tick();await tick();assert.equal(fetches.length,2,'a settled generation is not asked again');
plan.set('/api/catalog/film/64',{status:503,body:{status:'unavailable'}});
run("report.runId='G3'");run('renderFilmShell()');await tick();await tick();
assert.equal(query('#film-screen-title').textContent,'Новый','a failed refresh keeps the film already shown');
assert.equal(fetches.length,3);run('renderFilmShell()');await tick();await tick();assert.equal(fetches.length,3,'and is not retried in a loop');
// An answer pinned to another generation than the loaded programme is shown, and is not asked for again until the programme moves.
reset();plan.set('/api/catalog/film/65',found(65,{title:'Другой прогон'},'G0'));await open('tmdb_65');
assert.equal(query('#film-screen-title').textContent,'Другой прогон');
for(let i=0;i<3;i++){run('renderFilmShell()');await tick();await tick();}
assert.equal(fetches.length,1,'no request loop on a generation mismatch');

// ---- 5. Finds and Similar open the internal page, never TMDB ----
reset();
{
 const verified=entry(71),unverified=entry(72,{canonicalIdentity:null}),otherNamespace=entry(73,{canonicalIdentity:'tmdb_tv:73'});
 const finds=film=>run('findsCard(input,now)',{...film,prediction:{predictedRating:4.6,probability4Plus:.8,confidence:'high',matchSignals:[]},shows:[{channelId:'c',channel:'К',start:now-hour,end:now+hour}]});
 live.now=now;
 assert.match(finds(verified),/<h3><a class="film-open" href="\/film\/tmdb_71" data-film-id="tmdb_71">Каталожный 71<\/a>/);
 for(const bad of [unverified,otherNamespace]){const markup=finds(bad);assert.doesNotMatch(markup,/class="film-open"/,'no internal link without a verified movie identity');assert.doesNotMatch(markup,/themoviedb\.org/);}
 assert.match(run('similarTitle(input)',verified),/<button type="button" class="film-similar-open" data-similar-open="tmdb_71">/);
 for(const bad of [unverified,otherNamespace])assert.equal(run('similarTitle(input)',bad),bad.title,'plain text without a verified identity');
 setFilms([lid('heat-1995','74',movie(74))]);
 assert.match(run('similarTitle(input)',{id:'heat-1995',title:'Жара'}),/data-similar-open="tmdb_74"/,'a loaded film opens by its permalink');
}
// Clicking a find opens the internal film page and keeps the way home.
reset();
{
 window.history.replaceState(null,'','https://iptv.example/?q=find');
 let prevented=0;
 const link={dataset:{filmId:'tmdb_71'},href:'https://iptv.example/film/tmdb_71'};
 live.clickEvent={target:{closest(selector){return selector==='a.film-open'?link:selector==='[data-finds-watched]'||selector==='[data-finds-undo]'?null:null;}},button:0,preventDefault(){prevented++;}};
 plan.set('/api/catalog/film/71',found(71));
 run('onFindsClick(clickEvent)');await tick();await tick();
 assert.equal(prevented,1,'the click does not follow the link');
 assert.equal(new URL(window.location.href).pathname,'/film/tmdb_71');
 assert.equal(new URL(window.location.href).searchParams.get('return'),'/?q=find','the return target is the programme the click came from');
 assert.equal(query('#film-screen-title').textContent,'Каталожный 71');
 // A modified click is left to the browser.
 prevented=0;live.clickEvent.ctrlKey=true;run('onFindsClick(clickEvent)');assert.equal(prevented,0);
}

// ---- 6. Similar films work from a catalog-only source ----
reset();
{
 const source=entry(80,{prediction:{predictedRating:4.6,probability4Plus:.8,confidence:'high',matchSignals:['x'],moodIds:['dark']},fingerprint:{plotMechanics:['heist','investigation'],moodIds:['dark'],execution:{}},directors:[{id:'tmdb_director/9',name:'Общий'}]});
 const twin=entry(81,{directors:[{id:'tmdb_director/9',name:'Общий'}],fingerprint:{plotMechanics:['heist','investigation'],moodIds:['dark'],execution:{}},shows:[{channelId:'c',channel:'К',start:now-hour,end:now+hour,status:'on_air'}],prediction:{predictedRating:4.5,probability4Plus:.8,confidence:'high',matchSignals:[],moodIds:['dark']}});
 const sameFilm=entry(80,{shows:[{channelId:'c',channel:'К',start:now-hour,end:now+hour,status:'on_air'}]});
 const local=lid('local-1','90',movie(90),{shows:[{channelId:'c',channel:'К',start:now-hour,end:now+hour}],directors:[{id:'tmdb_director/9',name:'Общий'}]});
 setFilms([local]);
 live.catalogSource=source;live.catalogList=[twin,sameFilm];
 run('findsSource={films:catalogList,programmeRunId:"G1",generatedAt:null,ready:true,error:false,watchedMarkEnabled:false}');
 plan.set('/api/catalog/film/80',{status:200,body:{status:'found',programmeRunId:'G1',film:source}});
 await open('tmdb_80');
 assert.equal(query('#film-screen-title').textContent,'Каталожный 80');
 const picks=run('buildSimilar(currentFilm(),Date.now())').map(row=>row.film.id);
 assert.ok(picks.includes('tmdb_81'),'a catalog twin is offered');
 assert.ok(!picks.includes('tmdb_80'),'the source film is excluded by its verified identity from the catalog list');
 const rendered=run('renderSimilar(Date.now())').map(row=>row.film.id);
 assert.ok(!rendered.includes('tmdb_80'));
 assert.equal(fetches.filter(f=>!/\/api\/catalog\/film\//.test(f.url)).length,0,'ranking makes no further request');
}
// The permanent read never writes and never asks a provider.
assert.ok(fetches.every(f=>f.method==='GET'));
assert.ok(!fetches.some(f=>/themoviedb|letterboxd\.com/.test(f.url)));
console.log('Film permalink: proven-movie permalink and Letterboxd alias, in-place canonicalization with the return kept, catalog-only page from the permanent read in every state, no started/compare/synopsis, no flicker or mixed generations, internal Finds and Similar links, similar films from a catalog source, and no write or provider request passed');
