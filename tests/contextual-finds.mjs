import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Contextual finds: the page's content filters are hard constraints on the catalog films, the survivors are ordered by confirmed context
// before the prediction order, and each card names only what its own record confirms.
const now=Date.UTC(2026,5,15,10,0,0),hour=3600000;
const app=fs.readFileSync('public/app.js','utf8'),css=fs.readFileSync('public/styles.css','utf8');
assert.equal((app.match(/fetch\('\/api\/catalog\/available'\)/g)||[]).length,1,'contextual ranking adds no second catalog request');
assert.doesNotMatch(app,/fetch\([^)]*catalog[^)]*\?/,'filters are never sent to the catalog route');
assert(/function restoreUrl\(\)\{[\s\S]*?Object\.assign\(state,readUrlState\(new URL\(window\.location\.href\)\)\);[\s\S]*?render\(\);urlRestoring=false;\s*\}/.test(app),'back and forward restore the state and render');
assert(/resultsView=\{visible:visible\.length,valid\};\n\s+renderFinds\(\);/.test(app),'every render re-ranks the finds after the grid');
assert(css.includes('.finds-reason{'),'the reason line has its own style');

const node=()=>({hidden:true,textContent:'',innerHTML:''});
const nodes={'#finds':node(),'#finds-cards':node(),'#finds-caption':node(),'#finds-title':{...node(),textContent:'Находки'},'#watchlist-title':node(),'#empty':node()};
let fetches=0;
const ui=vm.createContext({Date,Intl,Set,Map,URL,console,fetch:async()=>{fetches++;throw new Error('no fetch expected');},document:{querySelector:selector=>nodes[selector]||null,querySelectorAll:()=>[]}});
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
vm.runInContext(`viewClock=${now};report={runId:'G1',films:[],window:{from:${now-72*hour},to:${now+24*hour}},cutoff:${now}};`,ui);
ui.now=now;

const show=(startOffsetHours,channel='Один',length=2)=>({channelId:channel,channel,start:now+startOffsetHours*hour,end:now+(startOffsetHours+length)*hour});
const film=(id,title,rating,probability,extra={})=>{const tmdb=id.replace('tmdb_','');return {id,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,title,original:extra.original||title,year:'year' in extra?extra.year:2020,runtime:'runtime' in extra?extra.runtime:100,genres:extra.genres||['Драма'],poster:null,url:'https://www.themoviedb.org/movie/'+tmdb,directors:extra.directors||[],actors:extra.actors||[],shows:extra.shows||[show(-5)],prediction:{predictedRating:rating,probability4Plus:probability,confidence:'high',matchSignals:[],mainRisk:null,moodIds:extra.predictionMoods||[]},fingerprint:{plotMechanics:extra.mechanics||[],moodIds:extra.moods||[],execution:extra.execution||{}}};};
const run=(expression,input)=>{ui.input=input;return vm.runInContext(expression,ui);};
const ids=list=>Array.from(list).map(item=>item.id);
const finds=input=>ids(run('buildFinds(input,now)',input));
const reset=()=>vm.runInContext("films=[];enrichment={profile:null,films:{}};resultsView={visible:0,valid:true};Object.assign(state,readUrlState(new URL('https://iptv.example/')));",ui);
const set=(code)=>vm.runInContext(code,ui);
const at=url=>vm.runInContext(`Object.assign(state,readUrlState(new URL(${JSON.stringify(url)})));`,ui);

const hanks={id:'tmdb_actor/31',name:'Том Хэнкс'},namesake={id:'tmdb_actor/999',name:'Том Хэнкс'},nolan={id:'tmdb_director/525',name:'Кристофер Нолан'};
const catalog=[
 film('tmdb_1','Ограбление с Хэнксом',4.2,.8,{actors:[hanks],mechanics:['heist'],moods:['tense'],genres:['Криминал','Драма'],year:1998,runtime:95,execution:{pace:'fast'}}),
 film('tmdb_2','Выживание Нолана',4.4,.85,{directors:[nolan],mechanics:['survival','heist'],moods:['dark'],genres:['Триллер'],year:2014,runtime:169,execution:{pace:'slow'}}),
 film('tmdb_3','Тёзка',4.8,.95,{actors:[namesake],mechanics:['investigation'],predictionMoods:['tense'],genres:['Детектив'],year:2005,runtime:110}),
 film('tmdb_4','Комедия',4.6,.9,{mechanics:[],moods:['funny'],genres:['Комедия'],year:null,runtime:null}),
 film('tmdb_5','Расследование',4.3,.9,{mechanics:['investigation','heist'],moods:['tense','dark'],genres:['Криминал'],year:2001,runtime:100,shows:[show(-70,'Два')]}),
];

// No context: the plain prediction order and caption, no reason line.
reset();
assert.equal(run('findsContextActive()',null),false);
assert.deepEqual(finds(catalog),['tmdb_3','tmdb_4','tmdb_2','tmdb_5','tmdb_1'],'without context the order is the prediction order');
assert.doesNotMatch(run('findsCard(input,now)',catalog[0]),/finds-reason/,'no reason without context');
assert.equal(run('findsCaption(2,findsScope())',null),'2 фильма вне watchlist: сильный прогноз и реальный показ');

// Exact person: the same id only. A namesake with another id and a Letterboxd-style watchlist id never match a TMDB credit by name.
at('https://iptv.example/?actor=tmdb_actor%2F31');
assert.deepEqual(finds(catalog),['tmdb_1'],'only the credit with the same id');
assert.match(run('findsCard(input,now)',catalog[0]),/<p class="finds-reason"><span>Совпадает:<\/span> Актёр: Том Хэнкс<\/p>/);
at('https://iptv.example/?actor=actor%2Ftom-hanks');
assert.deepEqual(finds(catalog),[],'a watchlist person id is not matched to a catalog credit by name, so nothing qualifies');
at('https://iptv.example/?director=tmdb_director%2F525');
assert.deepEqual(finds(catalog),['tmdb_2']);
assert.match(run('findsCard(input,now)',catalog[1]),/Режиссёр: Кристофер Нолан/);
at('https://iptv.example/?director=tmdb_director%2F525&actor=tmdb_actor%2F31');
assert.deepEqual(finds(catalog),[],'actor and director together are AND');

// Mechanics and moods: OR inside a facet, AND across facets; more confirmed values rank first, before the prediction.
at('https://iptv.example/?mechanic=heist');
assert.deepEqual(finds(catalog),['tmdb_2','tmdb_5','tmdb_1'],'one confirmed value each: prediction order');
at('https://iptv.example/?mechanic=heist&mechanic=survival');
assert.deepEqual(finds(catalog),['tmdb_2','tmdb_5','tmdb_1'],'two confirmed mechanics outrank one');
at('https://iptv.example/?mechanic=heist&mechanic=investigation');
assert.deepEqual(finds(catalog),['tmdb_5','tmdb_3','tmdb_2','tmdb_1'],'the film confirming both mechanics leads, then the prediction order');
assert.match(run('findsCard(input,now)',catalog[4]),/Совпадает:<\/span> Расследование · Ограбление/);
at('https://iptv.example/?mechanic=heist&mood=dark');
assert.deepEqual(finds(catalog),['tmdb_2','tmdb_5'],'mechanic AND mood');
at('https://iptv.example/?mood=tense');
assert.deepEqual(finds(catalog),['tmdb_3','tmdb_5','tmdb_1'],'a mood from the prediction counts like one from the fingerprint');
assert.match(run('findsCard(input,now)',catalog[2]),/Совпадает:<\/span> Напряжённый/);

// Genres: OR inside the facet; more confirmed genres first.
at('https://iptv.example/?genre=Криминал&genre=Драма');
assert.deepEqual(finds(catalog),['tmdb_1','tmdb_5'],'two confirmed genres outrank one despite a weaker prediction');
assert.match(run('findsCard(input,now)',catalog[0]),/Совпадает:<\/span> Криминал · Драма/);
// Person outranks mechanics, mechanics outrank genres.
assert.deepEqual(run('[findsRelevance({people:1,facets:0,genres:0,rank:0},{people:0,facets:3,genres:3,rank:0}),findsRelevance({people:0,facets:1,genres:0,rank:0},{people:0,facets:0,genres:3,rank:0})].map(Math.sign).join()',null),'-1,-1');

// Search: titles by default, people and plot facets only when those scopes are on; the catalog has no synopsis.
at('https://iptv.example/?q=ограбление');
assert.deepEqual(finds(catalog),['tmdb_1']);
assert.match(run('findsCard(input,now)',catalog[0]),/Совпадает:<\/span> название по запросу/);
at('https://iptv.example/?q=кристофер');
assert.deepEqual(finds(catalog),[],'people are not searched in the titles scope');
at('https://iptv.example/?q=кристофер&searchIn=titles,people');
assert.deepEqual(finds(catalog),['tmdb_2']);
assert.match(run('findsCard(input,now)',catalog[1]),/имя по запросу/);
at('https://iptv.example/?q=расследование&searchIn=titles,plot');
assert.deepEqual(finds(catalog),['tmdb_5','tmdb_3'],'a title match ranks before a plot-facet match');
at('https://iptv.example/?q=несуществующее');
assert.deepEqual(finds(catalog),[]);

// Year and runtime.
at('https://iptv.example/?from=1995&to=2005');
assert.deepEqual(finds(catalog),['tmdb_3','tmdb_5','tmdb_1'],'a film without a year leaves once a range is set');
assert.match(run('findsCard(input,now)',catalog[0]),/Совпадает:<\/span> 1995–2005/);
at('https://iptv.example/?runtime=100');
assert.deepEqual(finds(catalog),['tmdb_5','tmdb_1'],'unknown runtime never passes a runtime limit; the limit is inclusive');
assert.match(run('findsCard(input,now)',catalog[0]),/Совпадает:<\/span> до 100 мин/);

// Execution, prediction thresholds and the viewing-history filters.
at('https://iptv.example/?execution=pace:fast');
assert.deepEqual(finds(catalog),['tmdb_1']);
assert.match(run('findsCard(input,now)',catalog[0]),/Темп: быстрый/);
at('https://iptv.example/?prediction=4.5');
assert.deepEqual(finds(catalog),['tmdb_3','tmdb_4']);
at('https://iptv.example/?chance=0.85');
assert.deepEqual(finds(catalog),['tmdb_3','tmdb_4','tmdb_2','tmdb_5'],'the chance threshold is inclusive');
at('https://iptv.example/?viewing=rewatch');
assert.deepEqual(finds(catalog),[],'a find is never a rewatch');
at('https://iptv.example/?started=1');
assert.deepEqual(finds(catalog),[],'a find is never started');
at('https://iptv.example/?viewing=new');
assert.deepEqual(finds(catalog),['tmdb_3','tmdb_4','tmdb_2','tmdb_5','tmdb_1'],'every find is new');
at('https://iptv.example/?lastChance=1');
assert.deepEqual(finds(catalog),['tmdb_5'],'last chance: the catch-up ends within eight hours');
at('https://iptv.example/?sort=title&shortlist=today&view=watchlist');
assert.equal(run('findsContextActive()',null),false,'sorting and presentation settings are not context');
assert.deepEqual(finds(catalog),['tmdb_3','tmdb_4','tmdb_2','tmdb_5','tmdb_1']);

// Several filters are AND; channels stay OR.
at('https://iptv.example/?mechanic=heist&genre=Криминал&from=1990&to=2010');
assert.deepEqual(finds(catalog),['tmdb_5','tmdb_1']);
at('https://iptv.example/?mechanic=heist&channel=Два');
assert.deepEqual(finds(catalog),['tmdb_5'],'channel narrows the context result');
at('https://iptv.example/?mechanic=heist&channel=Два&channel=Один');
assert.deepEqual(finds(catalog),['tmdb_2','tmdb_5','tmdb_1'],'channels combine with OR');
assert.equal(run('findsCaption(3,findsScope())',null),'3 фильма вне watchlist по выбранным фильтрам с показом на каналах Два, Один');

// Period without a channel filter is a hard constraint inside the effective window; catch-up expiry hides the film without a new request.
at('https://iptv.example/?period=future');
assert.deepEqual(finds(catalog),[],'no upcoming show, no find in the future tab');
const upcoming=film('tmdb_6','Скоро',4.1,.8,{shows:[show(3)]});
assert.deepEqual(finds([...catalog,upcoming]),['tmdb_6']);
assert.equal(run('findsCaption(1,findsScope())',null),'1 фильм вне watchlist с показом · следующие сутки');
at('https://iptv.example/?period=archive');
assert.deepEqual(finds([...catalog,upcoming]),['tmdb_3','tmdb_4','tmdb_2','tmdb_5','tmdb_1']);
assert.deepEqual(ids(run(`buildFinds(input,now+3*${hour})`,[catalog[4]])),[],'the 72-hour catch-up has expired three hours later');
at('https://iptv.example/?period=archive&mood=funny');
assert.equal(run('findsCaption(1,findsScope())',null),'1 фильм вне watchlist по выбранным фильтрам · архив');

// Counts: 0, 1, 5 and more than 5 stay at five, never padded with films that miss the context.
reset();
const many=Array.from({length:7},(_,i)=>film('tmdb_'+(40+i),'Ограбление '+String.fromCharCode(1040+i),4.0+i*.1,.8,{mechanics:['heist'],original:'Heist '+String.fromCharCode(65+i)}));
const others=Array.from({length:3},(_,i)=>film('tmdb_'+(60+i),'Другое '+i,4.9,.95,{original:'Other '+i}));
at('https://iptv.example/?mechanic=heist');
assert.deepEqual(finds([...many,...others]),['tmdb_46','tmdb_45','tmdb_44','tmdb_43','tmdb_42'],'more than five: the five strongest matching ones');
assert.equal(finds([many[0],...others]).length,1,'one match is one card, not padded');
assert.equal(finds(many.slice(0,5)).length,5);
assert.equal(finds(others).length,0);

// Exclusions survive context: a watchlist, rated or weak film stays out even when it matches everything selected.
reset();
at('https://iptv.example/?mechanic=heist');
set("films=[{id:'listed',tmdbId:'1',title:'В watchlist',shows:[]}];enrichment={profile:null,films:{tmdb_2:{actualRating:4,prediction:null}}};");
assert.deepEqual(finds(catalog),['tmdb_5'],'a watchlist identity and a rated film are not revived by context');
assert.deepEqual(finds([film('tmdb_7','Слабый грабёж',3.8,.9,{mechanics:['heist']})]),[],'thresholds still apply');
const twins=[film('tmdb_8','Двойник',4.5,.9,{mechanics:['heist']}),{...film('tmdb_8','Двойник копия',4.5,.9,{mechanics:['heist']}),id:'tmdb_8b'}];
assert.deepEqual(finds(twins),['tmdb_8'],'canonical dedupe holds');

// Rendering: section hidden at zero, captions, invalid filters, URL back and forward, no fetch while filtering.
reset();
ui.catalogFilms=catalog;
set('findsSource={films:catalogFilms,ready:true,error:false,programmeRunId:"G1",generatedAt:null}');
const render=()=>ids(run('renderFinds(now)',null));
at('https://iptv.example/?mechanic=heist');
assert.deepEqual(render(),['tmdb_2','tmdb_5','tmdb_1']);
assert.equal(nodes['#finds'].hidden,false);
assert.equal(nodes['#finds-title'].textContent,'Находки','no extra section or title for context');
assert.equal(nodes['#finds-caption'].textContent,'3 фильма вне watchlist по выбранным фильтрам');
assert.equal((nodes['#finds-cards'].innerHTML.match(/class="finds-reason"/g)||[]).length,3);
at('https://iptv.example/?mechanic=siege');
assert.deepEqual(render(),[]);
assert.equal(nodes['#finds'].hidden,true,'no match hides the section');
at('https://iptv.example/?mechanic=heist');
assert.deepEqual(render(),['tmdb_2','tmdb_5','tmdb_1'],'back restores the earlier ranking');
at('https://iptv.example/');
assert.deepEqual(render(),['tmdb_3','tmdb_4','tmdb_2','tmdb_5','tmdb_1'],'clearing the context restores the plain ranking');
assert.equal(nodes['#finds-caption'].textContent,'5 фильмов вне watchlist: сильный прогноз и реальный показ');
set('resultsView={visible:0,valid:false}');
assert.deepEqual(render(),[],'an invalid year or runtime filter hides the finds too');
assert.equal(nodes['#finds'].hidden,true);
set('resultsView={visible:0,valid:true}');
// A catalog answer for another generation is still hidden under any context.
set("report={...report,runId:'G2'}");
at('https://iptv.example/?mechanic=heist');
assert.deepEqual(render(),[],'stale generation stays hidden with context');
set("report={...report,runId:'G1'}");
assert.deepEqual(render(),['tmdb_2','tmdb_5','tmdb_1']);
assert.equal(fetches,0,'filtering never requests anything');

// Output escaping of reason text.
reset();
const odd=film('tmdb_9','Странный',4.5,.9,{actors:[{id:'tmdb_actor/7',name:'<b>Имя</b>'}]});
at('https://iptv.example/?actor=tmdb_actor%2F7');
assert.match(run('findsCard(input,now)',odd),/Актёр: &lt;b&gt;Имя&lt;\/b&gt;/);
console.log('Contextual finds: exact people, facets AND/OR, relevance order, search scopes, year and runtime, execution, thresholds, history filters, channel and period, counts, exclusions, captions, reasons, URL changes, stale generation and no extra fetch passed');
