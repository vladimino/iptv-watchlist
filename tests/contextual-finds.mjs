import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Contextual finds: the watchlist filters that a catalog record can answer from its own fields narrow «Находки» as hard
// constraints, mechanics and moods rank above genres, and a person name never matches. A selected actor or director
// stays empty until a confirmed identity GET names that film by typed tmdb id.
const now=Date.UTC(2026,5,15,10,0,0),hour=3600000;
const app=fs.readFileSync('public/app.js','utf8');
const node=()=>({hidden:true,textContent:'',innerHTML:''});
const nodes={'#finds':node(),'#finds-cards':node(),'#finds-caption':node(),'#finds-title':{...node(),textContent:'Находки'},'#finds-notice':node(),'#watchlist-title':node(),'#empty':node()};
let fetches=0;
const ui=vm.createContext({Date,Intl,Set,Map,URL,Promise,console,fetch:async()=>{fetches++;throw new Error('no network in this test');},document:{querySelector:selector=>nodes[selector]||null,querySelectorAll:()=>[]}});
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
vm.runInContext(`viewClock=${now};report={runId:'G1',films:[],window:{from:${now-72*hour},to:${now+24*hour}},cutoff:${now}};MAX_YEAR=2026;`,ui);
ui.now=now;

const show=(offset,channel='Один',length=2)=>({channelId:channel,channel,start:now+offset*hour,end:now+(offset+length)*hour});
const film=(id,options={})=>({id,tmdbId:id.replace('tmdb_',''),canonicalIdentity:'tmdb:'+id.replace('tmdb_',''),title:options.title||'Фильм '+id,original:options.original||'Film '+id,year:options.year??2020,runtime:options.runtime??100,genres:options.genres||['Драма'],poster:null,url:null,
 directors:options.directors||[],actors:options.actors||[],shows:options.shows||[show(-5)],
 prediction:{predictedRating:options.rating??4.5,probability4Plus:options.probability??.8,confidence:'high',matchSignals:[],mainRisk:'',moodIds:options.predictionMoods||[]},
 fingerprint:options.fingerprint===null?null:{plotMechanics:options.mechanics||[],moodIds:options.moods||[],execution:options.execution||{}}});
const ids=list=>Array.from(list).map(item=>item.id);
const reset=()=>vm.runInContext(`state.period='all';state.query='';state.searchScopes=defaultSearchScopes();state.genres=new Set();state.mechanics=new Set();state.moods=new Set();state.channels=new Set();state.execution=emptyExecution();state.from=1900;state.to=MAX_YEAR;state.maxRuntime=null;state.minPrediction=null;state.minProbability=null;state.viewing='any';state.startedOnly=false;state.lastChanceOnly=false;state.directors='';state.actors='';`,ui);
const set=code=>vm.runInContext(code,ui);
const finds=input=>{ui.input=input;return ids(vm.runInContext('buildFinds(input,now)',ui));};
const baseline=input=>{ui.input=input;return ids(vm.runInContext('buildFinds(input,now,findsScope(),null)',ui));};

const catalog=[
 film('tmdb_1',{title:'Ограбление века',rating:4.9,genres:['Криминал'],mechanics:['heist'],moods:['tense'],year:2001,runtime:95,execution:{pace:'fast'}}),
 film('tmdb_2',{title:'Тихий дом',rating:4.7,genres:['Драма'],moods:['dark'],year:2015,runtime:130,execution:{pace:'slow'}}),
 film('tmdb_3',{title:'Расследование',rating:4.6,genres:['Детектив','Драма'],mechanics:['investigation'],predictionMoods:['dark'],year:2018,runtime:110}),
 film('tmdb_4',{title:'Комедия положений',rating:4.4,genres:['Комедия'],moods:['funny'],year:1995,runtime:88,shows:[show(5,'Два')]}),
 film('tmdb_5',{title:'Без отпечатка',rating:4.3,genres:['Криминал'],fingerprint:null,year:2010,runtime:100}),
];

// No context: the AIR-15 ranking and limit, identical to the section without filters.
reset();
assert.equal(vm.runInContext('findsContextActive(findsContext())',ui),false);
assert.deepEqual(finds(catalog),baseline(catalog),'without context the contextual path is the plain ranking');
assert.deepEqual(finds(catalog),['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5']);
const many=Array.from({length:8},(_,i)=>film('tmdb_'+(20+i),{title:'Серия '+String.fromCharCode(1040+i),rating:4.2+i/100}));
assert.deepEqual(finds(many),baseline(many));assert.equal(finds(many).length,5,'more than five qualify: five shown');
assert.deepEqual(finds([]),[],'an empty catalog shows nothing');

// Genres: OR within, hard constraint.
reset();set(`state.genres=new Set(['Криминал'])`);
assert.deepEqual(finds(catalog),['tmdb_1','tmdb_5']);
set(`state.genres=new Set(['Криминал','Комедия'])`);
assert.deepEqual(finds(catalog),['tmdb_1','tmdb_4','tmdb_5'],'OR within genres');
// Years and runtime.
reset();set(`state.from=2010;state.to=2020;`);
assert.deepEqual(finds(catalog),['tmdb_2','tmdb_3','tmdb_5']);
set(`state.from=2020;state.to=2010;`);
assert.deepEqual(finds(catalog),[],'an invalid year range leaves no find, as the grid shows none');
reset();set(`state.maxRuntime=100`);
assert.deepEqual(finds(catalog),['tmdb_1','tmdb_4','tmdb_5']);
assert.deepEqual(finds([film('tmdb_9',{runtime:0})]),[],'an unknown runtime does not pass a runtime limit');
// Mechanics and moods: only confirmed values of the current fingerprint and prediction; OR within each.
reset();set(`state.mechanics=new Set(['investigation','heist'])`);
assert.deepEqual(finds(catalog),['tmdb_1','tmdb_3']);
reset();set(`state.moods=new Set(['dark'])`);
assert.deepEqual(finds(catalog),['tmdb_2','tmdb_3'],'a mood of the current prediction counts as confirmed');
reset();set(`state.mechanics=new Set(['heist'])`);
assert.deepEqual(finds([catalog[4]]),[],'a record without a current fingerprint never matches a mechanic');
// Execution.
reset();set(`state.execution.pace=new Set(['slow'])`);
assert.deepEqual(finds(catalog),['tmdb_2']);
// Prediction thresholds and last chance.
reset();set(`state.minPrediction=4.6`);assert.deepEqual(finds(catalog),['tmdb_1','tmdb_2','tmdb_3']);
reset();set(`state.minProbability=.85`);assert.deepEqual(finds(catalog),[],'every probability is .80');
reset();set(`state.lastChanceOnly=true`);
assert.deepEqual(finds([film('tmdb_10',{shows:[show(-66)]}),film('tmdb_11',{shows:[show(-10)]})]),['tmdb_10'],'last chance: availability ends within eight hours');
// Channel and period, period alone included.
reset();set(`state.channels=new Set(['Два'])`);assert.deepEqual(finds(catalog),['tmdb_4']);
reset();set(`state.period='future'`);assert.deepEqual(finds(catalog),['tmdb_4'],'a period without a channel scopes the finds too');
reset();set(`state.period='archive'`);assert.deepEqual(finds(catalog),['tmdb_1','tmdb_2','tmdb_3','tmdb_5']);
assert.equal(vm.runInContext('findsCaption(4,findsScope(),false)',ui),'4 фильма вне watchlist · архив');
assert.equal(vm.runInContext('findsTitle(findsScope())',ui),'Находки');

// AND across dimensions: genre and mood and year together.
reset();set(`state.genres=new Set(['Драма']);state.moods=new Set(['dark']);state.from=2016;`);
assert.deepEqual(finds(catalog),['tmdb_3']);
set(`state.maxRuntime=100`);assert.deepEqual(finds(catalog),[],'no film satisfies every dimension: nothing, no filler');

// Text search: titles and original titles; the plot scope reads genres and facets only; the people scope never matches.
reset();set(`state.query='тихий'`);assert.deepEqual(finds(catalog),['tmdb_2']);
reset();set(`state.query='film tmdb_3'`);assert.deepEqual(finds(catalog),['tmdb_3'],'the original title is searched');
reset();set(`state.query='мрачный'`);assert.deepEqual(finds(catalog),[],'titles only by default');
set(`state.searchScopes={titles:true,people:false,plot:true}`);assert.deepEqual(finds(catalog),['tmdb_2','tmdb_3'],'the plot scope finds the mood label');
const credited=[film('tmdb_30',{title:'Обычное название',directors:[{id:'tmdb_director/1',name:'Кристофер Нолан'}],actors:[{id:'tmdb_actor/2',name:'Том Харди'}]})];
reset();set(`state.query='нолан';state.searchScopes={titles:true,people:true,plot:true}`);
assert.deepEqual(finds(credited),[],'a credit name never makes a find: no person matching');
set(`state.query='обычное'`);assert.deepEqual(finds(credited),['tmdb_30'],'the people scope does not hide a title match');

// Without a confirmed identity, a person filter still leaves no find. A catalog credit id is not a match.
reset();set(`state.directors='lb_director/1'`);assert.deepEqual(finds(credited),[]);
reset();set(`state.actors='tmdb_actor/2'`);assert.deepEqual(finds(credited),[],'not even a catalog credit with the same id');
reset();set(`state.startedOnly=true`);assert.deepEqual(finds(catalog),[]);
reset();set(`state.viewing='rewatch'`);assert.deepEqual(finds(catalog),[]);
reset();set(`state.viewing='new'`);assert.deepEqual(finds(catalog),baseline(catalog),'«Новые» keeps every unrated find');

// Ranking: mechanics and moods above genres, then predictedRating → probability4Plus → urgency.
reset();set(`state.genres=new Set(['Драма','Криминал']);state.moods=new Set(['dark','tense']);`);
const ranked=[
 film('tmdb_31',{rating:4.9,genres:['Драма','Криминал'],moods:['dark']}),
 film('tmdb_32',{rating:4.2,genres:['Драма'],moods:['dark','tense']}),
 film('tmdb_33',{rating:4.8,genres:['Драма'],moods:['tense']}),
 film('tmdb_34',{rating:4.1,genres:['Комедия'],moods:['dark']}),
];
assert.deepEqual(finds(ranked),['tmdb_32','tmdb_31','tmdb_33'],'two mood matches beat a higher rating; with equal mood matches two genres beat one; a film outside the genres is not a find');
reset();set(`state.moods=new Set(['dark','tense'])`);
const tie=[film('tmdb_40',{rating:4.5,probability:.8,moods:['dark'],shows:[show(-5)]}),film('tmdb_41',{rating:4.5,probability:.8,moods:['tense'],shows:[show(-50)]}),film('tmdb_42',{rating:4.5,probability:.9,moods:['dark']})];
assert.deepEqual(finds(tie),['tmdb_42','tmdb_41','tmdb_40'],'equal context: probability, then the nearest end of availability');

// The card explains only a real match.
reset();set(`state.moods=new Set(['dark']);state.genres=new Set(['Драма'])`);
ui.input=catalog[2];
assert.match(vm.runInContext('findsCard(input,now,findsScope(),findsContext())',ui),/Совпадает с фильтрами: Мрачный · Драма/);
reset();assert.doesNotMatch(vm.runInContext('findsCard(input,now,findsScope(),findsContext())',ui),/Совпадает/,'no explanation without context');

// Eligibility, exclusions and dedupe are unchanged under context.
reset();set(`state.genres=new Set(['Драма'])`);
const weak=film('tmdb_50',{rating:3.9});assert.deepEqual(finds([weak]),[],'a weak prediction is not a find whatever the filters');
set(`films=[{id:'lb_1',tmdbId:'2',title:'Тихий дом',year:2015,genres:['Драма'],shows:[]}]`);
assert.deepEqual(finds(catalog),['tmdb_3'],'a watchlist film stays excluded');
set(`films=[];findsMarks.set('3',{state:'marked'})`);
assert.deepEqual(finds(catalog),['tmdb_2'],'a film marked «Смотрел» stays excluded');
set(`findsMarks.clear();enrichment={films:{tmdb_2:{actualRating:4}}}`);
assert.deepEqual(finds(catalog),['tmdb_3'],'a rated film stays excluded');
set(`enrichment={films:{}}`);
assert.deepEqual(finds([catalog[1],{...catalog[1],id:'tmdb_2b'}]),['tmdb_2'],'one entry per canonical identity');
reset();set(`state.moods=new Set(['dark'])`);
assert.deepEqual(finds([film('tmdb_60',{moods:['dark'],shows:[show(-72)]})]),[],'an expired catch-up is not revived by a matching filter');

// Render: stale generation, URL restore and no second request.
const before=fetches;
set(`findsSource={films:${JSON.stringify(catalog)},programmeRunId:'G1',generatedAt:null,ready:true,error:false,watchedMarkEnabled:false};resultsView={visible:0,valid:true};`);
reset();
assert.deepEqual(ids(vm.runInContext(`renderFinds(${now})`,ui)),['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5']);
set(`Object.assign(state,readUrlState(new URL('https://iptv.local/?mood=dark&genre=%D0%94%D1%80%D0%B0%D0%BC%D0%B0')))`);
assert.deepEqual(ids(vm.runInContext(`renderFinds(${now})`,ui)),['tmdb_2','tmdb_3'],'a URL state (Back/Forward) filters the loaded catalog');
assert.equal(nodes['#finds-caption'].textContent,'2 фильма вне watchlist по выбранным фильтрам: сильный прогноз и реальный показ');
assert.equal(nodes['#finds'].hidden,false);
set(`Object.assign(state,readUrlState(new URL('https://iptv.local/?mechanic=puzzle')))`);
assert.deepEqual(ids(vm.runInContext(`renderFinds(${now})`,ui)),[]);assert.equal(nodes['#finds'].hidden,true,'no find: the section is hidden');
set(`Object.assign(state,readUrlState(new URL('https://iptv.local/')))`);
assert.deepEqual(ids(vm.runInContext(`renderFinds(${now})`,ui)),['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5'],'Back to no filters restores the plain section');
assert.equal(fetches,before,'filter changes re-rank the loaded catalog without a request');
set(`report={...report,runId:'G2'}`);
assert.deepEqual(ids(vm.runInContext(`renderFinds(${now})`,ui)),[],'a catalog answer of another generation is not shown');
assert.equal(nodes['#finds'].hidden,true);


// Genre identity: the watchlist labels (GENRE_MAP) and the catalog's TMDB ru-RU names meet on canonical keys, never on the raw string.
const aliasContext=vm.createContext({});
vm.runInContext(fs.readFileSync('src/domain/prediction-compatibility.js','utf8')+';globalThis.aliases=PROFILE_GENRE_ALIASES;',aliasContext);
assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('FINDS_GENRE_KEYS',ui))),JSON.parse(JSON.stringify(aliasContext.aliases)),'FINDS_GENRE_KEYS is the copy of PROFILE_GENRE_ALIASES');
const key=name=>{ui.input=name;return vm.runInContext('findsGenreKey(input)',ui);};
assert.equal(key('Криминал'),'crime');assert.equal(key('криминал'),'crime');assert.equal(key('  КРИМИНАЛ '),'crime');assert.equal(key('Crime'),'crime');
assert.equal(key('Фантастика'),'science_fiction');assert.equal(key('Science Fiction'),'science_fiction');assert.equal(key('science  fiction'),'science_fiction');
assert.equal(key('Исторический'),'history');assert.equal(key('история'),'history');assert.equal(key('Музыкальный'),'music');assert.equal(key('музыка'),'music');assert.equal(key('Телефильм'),'tv_movie');assert.equal(key('телевизионный фильм'),'tv_movie');
assert.equal(key('Нуар'),'raw:нуар');assert.equal(key(''),null);assert.equal(key(null),null);assert.equal(key(7),null);
const tmdb=[
 film('tmdb_70',{title:'Криминал ru',genres:['криминал','триллер'],rating:4.8}),
 film('tmdb_71',{title:'Фантастика en',genres:['Science Fiction'],rating:4.7}),
 film('tmdb_72',{title:'История ru',genres:['история'],rating:4.6}),
 film('tmdb_73',{title:'Нуар',genres:['нуар'],rating:4.5}),
 film('tmdb_74',{title:'Без жанров',genres:[],rating:4.4}),
 film('tmdb_75',{title:'Бойовик uk',genres:['бойовик'],rating:4.3}),
];
reset();set(`state.genres=new Set(['Криминал'])`);assert.deepEqual(finds(tmdb),['tmdb_70'],'«Криминал» finds the TMDB «криминал»');
set(`state.genres=new Set(['криминал'])`);assert.deepEqual(finds(tmdb),['tmdb_70'],'a lower-case selection matches too');
set(`state.genres=new Set(['Фантастика'])`);assert.deepEqual(finds(tmdb),['tmdb_71'],'«Фантастика» finds the English TMDB name');
set(`state.genres=new Set(['Исторический'])`);assert.deepEqual(finds(tmdb),['tmdb_72'],'«Исторический» finds TMDB «история»');
set(`state.genres=new Set(['Нуар'])`);assert.deepEqual(finds(tmdb),['tmdb_73'],'an unknown name matches the same unknown name, case-folded');
set(`state.genres=new Set(['Боевик'])`);assert.deepEqual(finds(tmdb),[],'an unknown catalog name (uk-UA «бойовик») does not match a known selection');
set(`state.genres=new Set(['Драма'])`);assert.deepEqual(finds(tmdb),[],'no false match: a film without that genre is not a find');
set(`state.genres=new Set(['Криминал','Science Fiction'])`);assert.deepEqual(finds(tmdb),['tmdb_70','tmdb_71'],'OR within genres across languages');
set(`state.genres=new Set(['Триллер']);state.moods=new Set(['dark']);`);assert.deepEqual(finds(tmdb),[],'AND with another filter still holds');
set(`state.genres=new Set(['Триллер']);state.moods=new Set();state.from=2020;state.to=2026;`);assert.deepEqual(finds(tmdb),['tmdb_70'],'genre and years together');
set(`state.genres=new Set(['Триллер']);state.from=1900;state.to=MAX_YEAR;state.maxRuntime=90;`);assert.deepEqual(finds(tmdb),[],'genre and a runtime limit together');
// Matched-genre ranking and the card text count canonical genres once and show the selected label.
reset();set(`state.genres=new Set(['Криминал','Триллер','Фантастика','фантастика'])`);
const twoGenres=film('tmdb_80',{title:'Два жанра',genres:['криминал','триллер'],rating:4.2}),oneGenre=film('tmdb_81',{title:'Один жанр',genres:['Science Fiction'],rating:4.9});
assert.deepEqual(finds([oneGenre,twoGenres]),['tmdb_80','tmdb_81'],'two matched canonical genres outrank one with a higher rating');
ui.input=twoGenres;assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('findsMatched(input,findsContext()).genres',ui))),['Криминал','Триллер']);
ui.input=oneGenre;assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('findsMatched(input,findsContext()).genres',ui))),['Фантастика'],'a genre selected under two spellings is counted once, under the first selected label');
assert.match(vm.runInContext('findsCard(input,now,findsScope(),findsContext())',ui),/Совпадает с фильтрами: Фантастика</,'the card names the selected label, not the catalog spelling');
assert.match(vm.runInContext('findsCard(input,now,findsScope(),findsContext())',ui),/Science Fiction/,'the card still shows the catalog genre as stored');
// Unchanged without a genre filter; watched exclusion and the single request hold with a genre selected.
reset();assert.deepEqual(finds(tmdb),baseline(tmdb));
set(`state.genres=new Set(['Криминал']);findsMarks.set('70',{state:'marked'})`);assert.deepEqual(finds(tmdb),[],'a marked film stays excluded under a genre filter');
set(`findsMarks.clear();films=[{id:'lb_70',tmdbId:'70',title:'x',year:2020,genres:[],shows:[]}]`);assert.deepEqual(finds(tmdb),[],'a watchlist film stays excluded');
set(`films=[]`);
const fetchesBeforeGenre=fetches;set(`findsSource={films:${JSON.stringify(tmdb)},programmeRunId:'G1',generatedAt:null,ready:true,error:false,watchedMarkEnabled:false};report={...report,runId:'G1'};`);
set(`Object.assign(state,readUrlState(new URL('https://iptv.local/?genre=%D0%9A%D1%80%D0%B8%D0%BC%D0%B8%D0%BD%D0%B0%D0%BB')))`);
assert.deepEqual(ids(vm.runInContext(`renderFinds(${now})`,ui)),['tmdb_70'],'the URL genre parameter (raw label) selects by canonical key');
assert.equal(fetches,fetchesBeforeGenre,'no request for a genre change');
assert.equal(vm.runInContext('urlForState("https://iptv.local/").searchParams.get("genre")',ui),'Криминал','the URL keeps the raw label');

// Person identity: Finds reads one GET per selected role and binds film:tmdb:N only to a catalog row whose id is tmdb_N
// and whose canonicalIdentity is tmdb:N. The watchlist grid keeps matching the stored role id. No person, no request.
const identityCalls=[];
const waiters=new Map();
ui.fetch=async(url,init)=>{
 fetches++;
 const path=String(url);
 identityCalls.push({url:path,method:init?.method||'GET'});
 if(!path.startsWith('/api/d1/persons/')||!path.endsWith('/identity'))throw new Error('no network in this test');
 return new Promise(resolve=>{const list=waiters.get(path)||[];list.push(resolve);waiters.set(path,list);});
};
const reply=(path,response)=>{const list=waiters.get(path)||[];const resolve=list.shift();if(!resolve)throw new Error('no waiter for '+path);resolve(response);};
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const http=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});
const personBody=(id,role,catalog,{state='trusted',cross='verified',bounded=false,limitations=['owner_decisions_not_stored','role_links_not_stored'],links,actorCatalog,directorCatalog}={})=>{
 const evidence=links||[{basis:'co_credit',personIds:['person:'+id,'person:tmdb_'+role+'/9'],films:catalog,roles:[role],names:['Имя']}];
 const surface=(which,ids)=>({state,crossSource:cross,humanId:'human:1',watchlist:[],catalog:ids});
 return {source:'d1',authoritative:false,recordId:'person:'+id,bounded,limitations,reference:{state,crossSource:cross,humanId:'human:1',formerIds:[],memberIds:[],links:evidence,reviews:[],externalIds:[],reversal:{destructive:false,stored:false,formerIds:[],splits:[]}},films:{actor:surface('actor',actorCatalog||(role==='actor'?catalog:[])),director:surface('director',directorCatalog||(role==='director'?catalog:[]))}};
};
const arm=()=>{set(`findsPeople={generation:undefined,cache:new Map(),inflight:new Set()};findsSource={films:${JSON.stringify(catalog)},programmeRunId:'G1',generatedAt:null,ready:true,error:false,watchedMarkEnabled:false};report={...report,runId:'G1',people:{directors:[{id:'director/nolan',name:'Кристофер Нолан'}],actors:[{id:'actor/hardy',name:'Том Харди'},{id:'actor/<b>',name:'<b>Харди</b>'}]}};`);};
const showFinds=()=>ids(vm.runInContext(`renderFinds(${now})`,ui));
for(const item of Object.values(nodes)){item.attributes={};item.setAttribute=(name,value)=>{item.attributes[name]=value;};item.getAttribute=name=>item.attributes[name]??null;}
const quiet=fetches;
reset();arm();
assert.deepEqual(showFinds(),['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5']);
assert.equal(fetches,quiet,'no person selected: no identity request');
assert.equal(identityCalls.length,0);

// Verified Letterboxd actor to TMDB catalog films. The co_credit is for the actor role.
reset();arm();set(`state.actors='actor/hardy'`);
assert.deepEqual(showFinds(),[]);
assert.equal(nodes['#finds'].hidden,false);
assert.match(nodes['#finds-cards'].innerHTML,/Проверяем фильмы этого человека/);
assert.equal(nodes['#finds'].getAttribute('aria-busy'),'true');
assert.deepEqual(identityCalls.map(call=>call.url),['/api/d1/persons/actor/hardy/identity']);
assert.deepEqual(identityCalls.map(call=>call.method),['GET']);
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:1','film:tmdb:3'])));
await flush();
assert.deepEqual(showFinds(),['tmdb_1','tmdb_3'],'verified co_credit catalog ids become finds');
ui.input=catalog[0];
assert.match(vm.runInContext('findsCard(input,now,findsScope(),findsContext())',ui),/Совпадает с фильтрами: Том Харди/);
assert.doesNotMatch(vm.runInContext('findsCard(input,now,findsScope(),findsContext())',ui),/owner|решени/i,'the card does not claim an owner decision');

// The watchlist grid still matches the stored role id and does not need the identity answer.
set(`films=[{id:'lb-1',title:'Дозор',original:'Watch',year:2010,runtime:100,genres:['Драма'],directors:[],actors:[{id:'actor/hardy',name:'Том Харди'}],shows:[]}]`);
assert.equal(vm.runInContext('films.filter(eligible).map(film=>film.id).join()',ui),'lb-1');
set(`films=[]`);

// Role awareness: a director filter reads films.director, not the actor catalog of the same human.
reset();arm();identityCalls.length=0;set(`state.directors='director/nolan'`);
showFinds();
reply('/api/d1/persons/director/nolan/identity',http(200,personBody('director/nolan','director',['film:tmdb:2'],{actorCatalog:['film:tmdb:1'],directorCatalog:['film:tmdb:2']})));
await flush();
assert.deepEqual(showFinds(),['tmdb_2'],'the director role does not take the actor catalog');

// Actor AND director, and AND with another facet. OR inside genres still applies to the person matches.
reset();arm();identityCalls.length=0;
set(`state.actors='actor/hardy';state.directors='director/nolan'`);
showFinds();
assert.deepEqual(identityCalls.map(call=>call.url),['/api/d1/persons/director/nolan/identity','/api/d1/persons/actor/hardy/identity']);
reply('/api/d1/persons/director/nolan/identity',http(200,personBody('director/nolan','director',['film:tmdb:1','film:tmdb:2'])));
await flush();
assert.deepEqual(showFinds(),[],'one confirmed role is not enough while the other is still loading');
assert.match(nodes['#finds-cards'].innerHTML,/Проверяем фильмы этого человека/);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,/нет подходящих|не подтверждена|Не удалось проверить/);
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:1','film:tmdb:4'])));
await flush();
assert.deepEqual(showFinds(),['tmdb_1'],'actor AND director');
set(`state.genres=new Set(['Криминал','Комедия'])`);
assert.deepEqual(showFinds(),['tmdb_1'],'a genre the film does not carry still excludes it');
set(`state.genres=new Set(['Криминал','Драма'])`);
assert.deepEqual(showFinds(),['tmdb_1'],'OR within genres, AND with both people');

// Person relevance is compared before mechanics and moods. Both films still have to pass every hard facet.
reset();arm();set(`state.actors='actor/hardy';state.moods=new Set(['dark','tense'])`);
showFinds();
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:1','film:tmdb:2'])));
await flush();
const moodRanked=[
 film('tmdb_1',{title:'Человек',rating:4.9,genres:['Драма'],moods:['dark']}),
 film('tmdb_2',{title:'Два настроения',rating:4.1,genres:['Драма'],moods:['dark','tense']}),
 film('tmdb_3',{title:'Чужой',rating:4.8,genres:['Драма'],moods:['dark','tense']}),
];
assert.deepEqual(finds(moodRanked),['tmdb_2','tmdb_1'],'among verified people, more moods still rank first; a mood match that is not this person is not a find');
ui.a=film('tmdb_1',{rating:4.1,moods:[]});ui.b=film('tmdb_9',{rating:4.9,moods:['dark','tense']});
assert.ok(vm.runInContext('findsCompare(a,b,now,findsScope(),findsContext())<0',ui),'a verified person outranks more moods on another film');
ui.input=moodRanked[1];
assert.match(vm.runInContext('findsCard(input,now,findsScope(),findsContext())',ui),/Совпадает с фильтрами: Том Харди · Мрачный · Напряжённый/);

// A rejected identity and a failed request both add no film, and they say different things.
const REFUSED=/Связь этого человека с каталогом не подтверждена/;
const FAILED=/Не удалось проверить фильмы этого человека/;
const NONE=/В «Находках» нет подходящих фильмов этого человека/;
const ABSENCE=/Подтверждённых фильмов этого человека/;
async function expectPersonLine(label,response,pattern){
 reset();arm();identityCalls.length=0;set(`state.actors='actor/hardy';resultsView={visible:0,valid:true};`);
 showFinds();
 reply('/api/d1/persons/actor/hardy/identity',response);
 await flush();
 assert.deepEqual(showFinds(),[],label);
 assert.equal(nodes['#finds'].hidden,false,label);
 assert.match(nodes['#finds-cards'].innerHTML,pattern,label);
 assert.doesNotMatch(nodes['#finds-cards'].innerHTML,ABSENCE,label);
 assert.equal(nodes['#empty'].hidden,true,'the shared empty state stays hidden while Finds explains the person');
 assert.equal((nodes['#finds-cards'].innerHTML.match(/class="finds-card"/g)||[]).length,0,label);
}
const verified=personBody('actor/hardy','actor',['film:tmdb:1']);
await expectPersonLine('name only',http(200,personBody('actor/hardy','actor',['film:tmdb:1'],{state:'ambiguous',cross:'none',links:[{basis:'same_name',roles:['actor'],personIds:[],films:[],names:['Том']}]})),REFUSED);
await expectPersonLine('ambiguous',http(200,personBody('actor/hardy','actor',['film:tmdb:1'],{state:'ambiguous',cross:'ambiguous',links:[]})),REFUSED);
await expectPersonLine('conflicting',http(200,personBody('actor/hardy','actor',['film:tmdb:1'],{state:'conflicting',cross:'refused',links:[]})),REFUSED);
await expectPersonLine('bounded',http(200,{...verified,bounded:true,limitations:[...verified.limitations,'neighborhood_bounded']}),REFUSED);
await expectPersonLine('unknown state',http(200,personBody('actor/hardy','actor',['film:tmdb:1'],{state:'unresolved',cross:'none',links:[]})),REFUSED);
await expectPersonLine('co_credit for the other role',http(200,personBody('actor/hardy','actor',['film:tmdb:1'],{links:[{basis:'co_credit',roles:['director'],personIds:[],films:['film:tmdb:1'],names:['Имя']}]})),REFUSED);
await expectPersonLine('broken body',http(200,{source:'d1',authoritative:false}),REFUSED);
await expectPersonLine('404',http(404,{error:'Person not found'}),FAILED);
await expectPersonLine('503',http(503,{error:'no db'}),FAILED);
await expectPersonLine('unreadable body',{ok:true,status:200,json:async()=>{throw new Error('bad json');}},FAILED);
reset();arm();set(`state.actors='actor/hardy';resultsView={visible:0,valid:true};`);
ui.fetch=async()=>{fetches++;throw new Error('offline');};
showFinds();
await flush();
assert.deepEqual(showFinds(),[],'a network error matches nothing');
assert.match(nodes['#finds-cards'].innerHTML,FAILED);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,ABSENCE);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,NONE);
assert.equal(nodes['#finds'].hidden,false);
assert.equal(nodes['#empty'].hidden,true);
ui.fetch=async(url,init)=>{
 fetches++;
 const path=String(url);
 identityCalls.push({url:path,method:init?.method||'GET'});
 if(!path.startsWith('/api/d1/persons/'))throw new Error('no network in this test');
 return new Promise(resolve=>{const list=waiters.get(path)||[];list.push(resolve);waiters.set(path,list);});
};

// Identity namespaces. A TV id, a retired movie id and a second row of the same typed identity do not match.
const movie=film('tmdb_9',{title:'Фильм'});
const tv={...film('tmdb_9',{title:'Сериал'}),id:'tmdb_tv_9',canonicalIdentity:'tmdb_tv:9',tmdbId:'9'};
const retired={...film('tmdb_17266',{title:'Снятый id'}),canonicalIdentity:null};
const sameTyped=[film('tmdb_8',{title:'Один'}),{...film('tmdb_8',{title:'Другой'}),title:'Другой'}];
function bind(ids,rows){ui.ids=ids;ui.rows=rows;return vm.runInContext('findsBindPerson(ids,rows)',ui);}
assert.deepEqual([...bind(['film:tmdb:9'],[movie])],['tmdb_9']);
assert.deepEqual([...bind(['film:tmdb_tv:9'],[movie])],[],'a TV id does not bind a movie with the same number');
assert.deepEqual([...bind(['film:tmdb:9'],[tv])],[],'a movie id does not bind a TV row');
assert.deepEqual([...bind(['film:tmdb:17266'],[retired])],[],'a row without the typed canonical identity does not bind');
assert.deepEqual([...bind(['film:retired:1','film:letterboxd:abc'],[movie])],[],'only film:tmdb:N can bind');
assert.deepEqual([...bind(['film:tmdb:8'],sameTyped)],[],'two catalog rows of one typed identity bind nothing');
assert.deepEqual([...bind(['film:tmdb:8'],[{...movie,id:'other',canonicalIdentity:'tmdb:8',tmdbId:'8'}])],[],'a bare number or a mismatched catalog id does not bind');

// Counts: 0, 1, 5 and more than 5. Eligibility is unchanged, so a weak film in the catalog ids is still not a find.
function personFilms(count){return Array.from({length:count},(_,i)=>film('tmdb_'+(100+i),{title:'Человек '+i,rating:4.2+i/100}));}
async function withActor(rows,catalogIds){
 reset();arm();
 set(`findsSource={films:${JSON.stringify(rows)},programmeRunId:'G1',generatedAt:null,ready:true,error:false,watchedMarkEnabled:false};state.actors='actor/hardy'`);
 showFinds();
 reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',catalogIds)));
 await flush();
 return showFinds();
}
assert.deepEqual(await withActor(personFilms(3),['film:tmdb:999']),[],'no catalog row for the D1 id');
assert.match(nodes['#finds-cards'].innerHTML,NONE,'a verified identity with no eligible film stays visible');
assert.equal(nodes['#finds'].hidden,false);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,FAILED);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,REFUSED);
assert.equal((await withActor(personFilms(3),['film:tmdb:100'])).length,1);
assert.equal((await withActor(personFilms(5),personFilms(5).map(item=>'film:tmdb:'+item.tmdbId))).length,5);
assert.equal((await withActor(personFilms(8),personFilms(8).map(item=>'film:tmdb:'+item.tmdbId))).length,5,'more than five still shows five');
const weakPerson=film('tmdb_100',{rating:3.2});
assert.deepEqual(await withActor([weakPerson],['film:tmdb:100']),[],'a weak prediction stays ineligible');
assert.match(nodes['#finds-cards'].innerHTML,NONE);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,FAILED);

// Async: reset, Back/Forward, a rapid switch and a generation change never show the previous answer.
reset();arm();identityCalls.length=0;
set(`state.actors='actor/hardy'`);
showFinds();
const callsBeforeReset=identityCalls.length;
set(`state.actors=''`);
assert.deepEqual(showFinds(),['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5'],'clearing the person restores the plain section');
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:1'])));
await flush();
assert.deepEqual(showFinds(),['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5'],'a late answer for a cleared person is not shown');
assert.equal(identityCalls.length,callsBeforeReset,'clearing the person makes no second request');

reset();arm();identityCalls.length=0;
set(`Object.assign(state,readUrlState(new URL('https://iptv.local/?actor=actor%2Fhardy')))`);
showFinds();
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:2'])));
await flush();
assert.deepEqual(showFinds(),['tmdb_2'],'a deeplink loads that person');
set(`Object.assign(state,readUrlState(new URL('https://iptv.local/')))`);
assert.deepEqual(showFinds(),['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5'],'Back to no person restores the section without a request');
const beforeForward=identityCalls.length;
set(`Object.assign(state,readUrlState(new URL('https://iptv.local/?actor=actor%2Fhardy')))`);
assert.deepEqual(showFinds(),['tmdb_2'],'Forward uses the cached answer for this generation');
assert.equal(identityCalls.length,beforeForward,'Forward does not ask again');

reset();arm();identityCalls.length=0;
set(`state.actors='actor/hardy'`);
showFinds();
set(`state.actors='actor/other'`);
showFinds();
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:1'])));
await flush();
assert.deepEqual(showFinds(),[],'the first person arriving late does not fill the second selection');
assert.match(nodes['#finds-cards'].innerHTML,/Проверяем фильмы этого человека/);
reply('/api/d1/persons/actor/other/identity',http(200,personBody('actor/other','actor',['film:tmdb:4'])));
await flush();
assert.deepEqual(showFinds(),['tmdb_4']);

reset();arm();
set(`state.actors='actor/hardy'`);
showFinds();
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:1'])));
await flush();
assert.deepEqual(showFinds(),['tmdb_1']);
set(`findsSource={...findsSource,error:true}`);
assert.deepEqual(showFinds(),['tmdb_1'],'a failed catalog refresh on this generation keeps the finds');
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,FAILED);
const beforeGeneration=identityCalls.length;
set(`report={...report,runId:'G2'}`);
assert.deepEqual(showFinds(),[],'a new programme generation hides the old catalog and the old person answer');
assert.equal(nodes['#finds'].hidden,true);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,/нет подходящих|не подтверждена|Не удалось проверить/,'a generation mismatch does not explain an empty person');
set(`findsSource={...findsSource,programmeRunId:'G2',error:false}`);
showFinds();
assert.equal(identityCalls.length,beforeGeneration+1,'the new generation asks again');
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:5'])));
await flush();
assert.deepEqual(showFinds(),['tmdb_5'],'only the answer for the current generation is shown');

// An invalid stored id fails closed and does not request. «Начатые» and «Пересмотр» stay empty with a person selected.
reset();arm();const beforeInvalid=identityCalls.length;
set(`state.directors='lb_director/1'`);
assert.deepEqual(showFinds(),[]);
assert.equal(identityCalls.length,beforeInvalid,'an id that is not a person route is not fetched');
assert.match(nodes['#finds-cards'].innerHTML,REFUSED);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,ABSENCE);
assert.equal(nodes['#finds'].hidden,false);
set(`state.directors='director/nolan';state.startedOnly=true`);
showFinds();
assert.deepEqual(showFinds(),[],'«Начатые» still leaves no find');
assert.equal(nodes['#finds'].hidden,true);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,/нет подходящих|не подтверждена|Не удалось проверить/);
set(`state.startedOnly=false;state.viewing='rewatch'`);
assert.deepEqual(showFinds(),[],'«Пересмотр» still leaves no find');
assert.equal(nodes['#finds'].hidden,true);

// Actor AND director: an error is not an unverified identity, and two verified answers with no shared film stay visible.
reset();arm();set(`state.actors='actor/hardy';state.directors='director/nolan';resultsView={visible:0,valid:true};`);
showFinds();
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:1'])));
reply('/api/d1/persons/director/nolan/identity',http(503,{error:'no db'}));
await flush();
assert.deepEqual(showFinds(),[]);
assert.match(nodes['#finds-cards'].innerHTML,FAILED);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,NONE);
assert.equal(nodes['#empty'].hidden,true);
reset();arm();set(`state.actors='actor/hardy';state.directors='director/nolan';resultsView={visible:0,valid:true};`);
showFinds();
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:1'])));
reply('/api/d1/persons/director/nolan/identity',http(200,{source:'d1',authoritative:false}));
await flush();
assert.deepEqual(showFinds(),[]);
assert.match(nodes['#finds-cards'].innerHTML,REFUSED);
assert.doesNotMatch(nodes['#finds-cards'].innerHTML,FAILED);
reset();arm();set(`state.actors='actor/hardy';state.directors='director/nolan';resultsView={visible:2,valid:true};`);
showFinds();
reply('/api/d1/persons/actor/hardy/identity',http(200,personBody('actor/hardy','actor',['film:tmdb:1'])));
reply('/api/d1/persons/director/nolan/identity',http(200,personBody('director/nolan','director',['film:tmdb:2'])));
await flush();
assert.deepEqual(showFinds(),[]);
assert.match(nodes['#finds-cards'].innerHTML,NONE,'two verified people with no shared film keep the section');
assert.equal(nodes['#empty'].hidden,true,'a visible watchlist does not add the shared empty state');
set(`state.genres=new Set(['Комедия'])`);
assert.deepEqual(showFinds(),[]);
assert.match(nodes['#finds-cards'].innerHTML,NONE,'another hard filter that removes the person match stays explained');
set(`state.actors='';state.directors='';state.genres=new Set();`);
assert.ok(showFinds().length>0,'clearing the person restores the catalog finds');
set(`state.mechanics=new Set(['puzzle'])`);
assert.deepEqual(showFinds(),[]);
assert.equal(nodes['#finds'].hidden,true,'without a person an empty section stays hidden');
set(`resultsView={visible:0,valid:true};`);
showFinds();
assert.equal(nodes['#empty'].hidden,false,'the shared empty state returns when Finds has nothing to explain');

// HTML in a person name is escaped inside the match line.
reset();arm();set(`state.actors='actor/<b>'`);
showFinds();
assert.equal(identityCalls.at(-1).url,'/api/d1/persons/actor/%3Cb%3E/identity');
reply('/api/d1/persons/actor/%3Cb%3E/identity',http(200,personBody('actor/<b>','actor',['film:tmdb:1'])));
await flush();
const escaped=nodes['#finds-cards'].innerHTML;
assert.match(escaped,/Совпадает с фильтрами: &lt;b&gt;Харди&lt;\/b&gt;/);
assert.doesNotMatch(escaped,/<b>Харди<\/b>/);

console.log('contextual finds: filters, ranking, exclusions, genre identity, person identity and render passed');
