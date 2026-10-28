import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Contextual finds: the watchlist filters that a catalog record can answer from its own fields narrow «Находки» as hard
// constraints, mechanics and moods rank above genres, and nothing names a person.
const now=Date.UTC(2026,5,15,10,0,0),hour=3600000;
const app=fs.readFileSync('public/app.js','utf8');
const node=()=>({hidden:true,textContent:'',innerHTML:''});
const nodes={'#finds':node(),'#finds-cards':node(),'#finds-caption':node(),'#finds-title':{...node(),textContent:'Находки'},'#finds-notice':node(),'#watchlist-title':node(),'#empty':node()};
let fetches=0;
const ui=vm.createContext({Date,Intl,Set,Map,URL,console,fetch:async()=>{fetches++;throw new Error('no network in this test');},document:{querySelector:selector=>nodes[selector]||null,querySelectorAll:()=>[]}});
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

// Person filters, «Начатые» and «Пересмотреть» are watchlist facts: the section has no find for them.
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

console.log('contextual finds: filters, ranking, exclusions and render passed');
