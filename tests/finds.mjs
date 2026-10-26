import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Finds: strong catalog films outside the watchlist, read from GET /api/catalog/available and presented in a separate section.
const now=Date.UTC(2026,5,15,10,0,0),hour=3600000;
const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/styles.css','utf8'),app=fs.readFileSync('public/app.js','utf8');
assert.match(html,/<section class="finds" id="finds" hidden aria-labelledby="finds-title">/);
assert.match(html,/id="finds-cards"/);
assert.match(html,/<h2 id="finds-title">Находки<\/h2>/);
assert.match(html,/NEW означает фильм вне твоего watchlist, а не новинку проката/);
assert(css.includes('.finds-badge{position:absolute;top:-6px;left:-6px'),'NEW badge sits at the top left of the poster');
assert(css.includes('.finds-card{position:relative;display:flex;flex-direction:column;min-width:0;border:1px solid #3f7a52;border-radius:12px;background:#1a2d21'),'finds card has its own soft green frame');
assert(css.includes('.finds{margin-bottom:24px;padding:18px;border:1px solid #3b6346'),'finds section is a separate container');
assert.equal((app.match(/fetch\('\/api\/catalog\/available'\)/g)||[]).length,1,'the section reads the catalog route once');
assert.match(app,/loadEnrichment\(\{quiet:true\}\),\n\s+loadCatalog\(\),/,'the catalog refreshes with the other live loaders');
assert.doesNotMatch(app,/finds-card[^`]*film-open/,'a find never opens the watchlist film route');

const nodes={'#finds':{hidden:true},'#finds-cards':{innerHTML:''},'#finds-caption':{textContent:''}};
const ui=vm.createContext({Date,Intl,Set,Map,console,document:{querySelector:selector=>nodes[selector]||null,querySelectorAll:()=>[]}});
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
vm.runInContext(`viewClock=${now}`,ui);
ui.now=now;

const show=(startOffsetHours,channel='Один',length=2)=>({channelId:channel,channel,start:now+startOffsetHours*hour,end:now+(startOffsetHours+length)*hour,status:startOffsetHours>0?'future':startOffsetHours+length>0?'on_air':'archive'});
const film=(id,tmdb,title,rating,probability,confidence,shows,extra={})=>({id,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title,original:extra.original||title,year:extra.year||2020,runtime:extra.runtime??100,genres:extra.genres||['Драма'],poster:extra.poster||null,url:'https://www.themoviedb.org/movie/'+tmdb,directors:[],actors:[],shows,availableNow:true,nextStart:null,availableUntil:null,prediction:{predictedRating:rating,probability4Plus:probability,confidence,matchSignals:[],mainRisk:null,moodIds:extra.moods||['dark'],...(extra.prediction||{})},fingerprint:extra.fingerprint===null?null:{plotMechanics:extra.mechanics||['heist'],moodIds:extra.moods||['dark'],execution:{}}});
const run=(expression,input)=>{ui.input=input;return vm.runInContext(expression,ui);};
const ids=list=>Array.from(list).map(item=>item.id);

// Thresholds and unknown or stale predictions.
const strong=film('tmdb_1',1,'Сильный',4.2,.8,'high',[show(-10)]);
assert.equal(run('findsEligible(input,now)',strong),true);
assert.equal(run('findsEligible(input,now)',film('tmdb_2',2,'Слабый прогноз',3.9,.9,'high',[show(-10)])),false,'rating below 4.0');
assert.equal(run('findsEligible(input,now)',film('tmdb_3',3,'Слабый шанс',4.5,.69,'high',[show(-10)])),false,'probability below 0.70');
assert.equal(run('findsEligible(input,now)',film('tmdb_4',4,'Низкая уверенность',4.5,.9,'low',[show(-10)])),false,'low confidence');
assert.equal(run('findsEligible(input,now)',film('tmdb_5',5,'Без уверенности',4.5,.9,undefined,[show(-10)])),false,'unknown confidence is not shown');
assert.equal(run('findsEligible(input,now)',film('tmdb_6',6,'Устаревший',4.5,.9,'high',[show(-10)],{prediction:{stale:true}})),false,'stale prediction is not shown');
assert.equal(run('findsEligible(input,now)',{...strong,prediction:null}),false,'no prediction');
assert.equal(run('findsEligible(input,now)',film('tmdb_7',7,'Граница',4,.7,'medium',[show(-10)])),true,'4.0 and 0.70 are inclusive');

// Real shows inside the window only; the client re-derives them from start and end with its own clock.
assert.equal(run('findsEligible(input,now)',film('tmdb_8',8,'Истёк',4.5,.9,'high',[show(-72)])),false,'a start exactly 72 hours ago has expired');
assert.equal(run('findsEligible(input,now)',film('tmdb_9',9,'Ещё доступен',4.5,.9,'high',[show(-71)])),true);
assert.equal(run('findsEligible(input,now)',film('tmdb_10',10,'Слишком далеко',4.5,.9,'high',[show(24)])),false,'a start exactly 24 hours ahead is outside the horizon');
assert.equal(run('findsEligible(input,now)',film('tmdb_11',11,'Скоро',4.5,.9,'high',[show(23)])),true);
assert.equal(run('findsEligible(input,now)',film('tmdb_12',12,'Без показов',4.5,.9,'high',[])),false,'no show, no find');
assert.equal(run('findsEligible(input,now)',film('tmdb_13',13,'Старые показы',4.5,.9,'high',[show(-100),show(-80)])),false,'only expired shows');

// Watchlist and watched exclusions from the loaded programme and enrichment index.
vm.runInContext("films=[{id:'listed',tmdbId:'20',title:'В списке',shows:[]},{id:'tmdb_21',title:'Тоже в списке',shows:[]}];enrichment={profile:null,films:{tmdb_22:{actualRating:4.5,prediction:null}}};",ui);
assert.equal(run('findsEligible(input,now)',film('tmdb_20',20,'Тот же TMDB',4.5,.9,'high',[show(-10)])),false,'same TMDB identity as a watchlist film');
assert.equal(run('findsEligible(input,now)',film('tmdb_21',21,'Тот же id',4.5,.9,'high',[show(-10)])),false,'same id as a watchlist film');
assert.equal(run('findsEligible(input,now)',film('tmdb_22',22,'Уже оценён',4.5,.9,'high',[show(-10)])),false,'a rated film is watched, not a find');
assert.equal(run('findsEligible(input,now)',film('tmdb_23',23,'Свободен',4.5,.9,'high',[show(-10)])),true);

// Ranking: rating, then probability, then the nearest end of availability; limit five; no filler.
vm.runInContext("films=[];enrichment={profile:null,films:{}};",ui);
const ranked=[
 film('tmdb_31',31,'Б рейтинг ниже',4.3,.95,'high',[show(-5)]),
 film('tmdb_32',32,'А лучший',4.6,.75,'high',[show(-5)]),
 film('tmdb_33',33,'В шанс ниже',4.3,.8,'high',[show(-5)]),
 film('tmdb_34',34,'Г заканчивается раньше',4.3,.8,'high',[show(-40)]),
 film('tmdb_35',35,'Д ещё один',4.1,.9,'high',[show(-5)]),
 film('tmdb_36',36,'Е ещё один',4.0,.9,'high',[show(-5)]),
 film('tmdb_37',37,'Ж седьмой',4.0,.85,'high',[show(-5)]),
];
assert.deepEqual(ids(run('buildFinds(input,now)',ranked)),['tmdb_32','tmdb_31','tmdb_34','tmdb_33','tmdb_35'],'rating, probability, nearest end, and at most five');
assert.equal(run('buildFinds(input,now).length',ranked.slice(0,2)),2,'two strong finds are two, not padded to three');
assert.equal(run('buildFinds(input,now).length',[ranked[0]]),1);
assert.equal(run('buildFinds(input,now).length',[]),0);
assert.equal(run('buildFinds(input,now).length',[film('tmdb_38',38,'Слабый',3.5,.9,'high',[show(-5)])]),0,'a weak film is never filler');

// Canonical dedupe and franchise diversity.
const twins=[film('tmdb_41',41,'Дубль',4.5,.9,'high',[show(-5)]),{...film('tmdb_41b',41,'Дубль копия',4.5,.9,'high',[show(-3)]),id:'tmdb_41b'}];
assert.deepEqual(ids(run('buildFinds(input,now)',twins)),['tmdb_41'],'one entry per canonical identity');
const franchise=[film('tmdb_51',51,'Рокки',4.5,.9,'high',[show(-5)],{original:'Rocky'}),film('tmdb_52',52,'Рокки 2',4.5,.9,'high',[show(-3)],{original:'Rocky II'}),film('tmdb_53',53,'Другой фильм',4.4,.9,'high',[show(-5)],{original:'Other'})];
assert.deepEqual(ids(run('buildFinds(input,now)',franchise)),['tmdb_51','tmdb_53'],'the adjacent part with equal signals is skipped');
const divergent=[franchise[0],{...franchise[1],prediction:{...franchise[1].prediction,predictedRating:4.4}}];
assert.deepEqual(ids(run('buildFinds(input,now)',divergent)),['tmdb_51','tmdb_52'],'a different signal lets the second part through');
assert.equal(run('franchiseKey(input)',{original:'Крёстный отец: Часть II'}),run('franchiseKey(input)',{original:'Крёстный отец'}));
assert.equal(run('franchiseKey(input)',{original:'Mission: Impossible 2'}),'mission impossible');
assert.notEqual(run('franchiseKey(input)',{original:'Apollo 13'}),run('franchiseKey(input)',{original:'Apollo'}),'a two-digit title number is not stripped as a sequel marker when it is the only number');

// Airing line.
assert.equal(run('findsAiring(input,now).text',film('tmdb_61',61,'Эфир',4.5,.9,'high',[show(-1,'Первый')])),'Сейчас в эфире · Первый');
assert.equal(run('findsAiring(input,now).kind',film('tmdb_62',62,'Скоро',4.5,.9,'high',[show(5,'Второй')])),'next');
assert.match(run('findsAiring(input,now).text',film('tmdb_62',62,'Скоро',4.5,.9,'high',[show(5,'Второй')])),/ · Второй$/);
assert.match(run('findsAiring(input,now).text',film('tmdb_63',63,'Архив',4.5,.9,'high',[show(-30,'Третий')])),/^Архив · Третий · до /);
assert.equal(run('findsAiring(input,now).kind',film('tmdb_64',64,'Приоритет эфира',4.5,.9,'high',[show(-30,'Третий'),show(-1,'Первый'),show(3,'Второй')])),'live','a live show wins over catch-up and future');

// Card markup: NEW on the poster, the usual title, year, poster, prediction, at most two labels, the airing, a TMDB link instead of the watchlist film route.
const rich=film('tmdb_71',71,'Богатый',4.7,.82,'high',[show(-1,'Первый')],{original:'Rich Film',poster:'https://img.example/p.jpg',mechanics:['heist','investigation'],moods:['tense','dark'],genres:['Триллер','Драма']});
const card=run('findsCard(input,now)',rich);
assert.match(card,/^<article class="finds-card" data-finds-film="tmdb_71">/);
assert.match(card,/<div class="finds-poster"><span class="finds-badge" title="Находка вне твоего watchlist" aria-label="Находка вне watchlist">NEW<\/span><img class="poster" src="https:\/\/img.example\/p.jpg"/);
assert.match(card,/score-predicted[^>]*><span>ПРОГНОЗ<\/span><strong>4\.7<\/strong><small>82% на 4\.0\+<\/small>/);
assert.match(card,/<a class="finds-title-link" href="https:\/\/www.themoviedb.org\/movie\/71" target="_blank" rel="noopener noreferrer" title="Открыть на TMDB">Богатый<\/a>/);
assert.match(card,/<p class="original">Rich Film<\/p>/);
assert.match(card,/<span class="film-year">2020 · 100 мин<\/span>/);
assert.match(card,/<div class="film-tags">Триллер · Драма<\/div>/);
assert.match(card,/<div class="film-moods finds-labels"><span>Ограбление<\/span><span>Напряжённый<\/span><\/div>/,'one mechanic and one mood, two labels at most');
assert.match(card,/<p class="finds-airing" data-airing="live">Сейчас в эфире · Первый<\/p>/);
assert.doesNotMatch(card,/data-film-id|film-open|data-started-id|Последний шанс/);
const bare=run('findsCard(input,now)',{...film('tmdb_72',72,'Голый',4.0,.7,'medium',[show(-30)],{fingerprint:null,moods:[]}),url:null,poster:null,runtime:null,genres:[]});
assert.match(bare,/<h3>Голый<\/h3>/);
assert.match(bare,/no-poster/);
assert.doesNotMatch(bare,/finds-labels/,'no labels block without known facets');
assert.match(bare,/<span class="film-year">2020<\/span>/);
assert.match(run('findsCard(input,now)',film('tmdb_73',73,'<Опасный>',4.5,.9,'high',[show(-1)],{original:'<b>x</b>'})),/&lt;Опасный&gt;/);

// Rendering: hidden before the catalog loads, hidden at zero, visible with cards, and gone again once the source excludes the film.
assert.equal(run('renderFinds(now).length',null),0);
assert.equal(nodes['#finds'].hidden,true,'hidden before the catalog is loaded');
vm.runInContext('findsSource={films:[],ready:true,error:false,programmeRunId:"run",generatedAt:null}',ui);
assert.equal(run('renderFinds(now).length',null),0);
assert.equal(nodes['#finds'].hidden,true,'hidden at zero candidates');
assert.equal(nodes['#finds-cards'].innerHTML,'');
ui.catalogFilms=ranked;
vm.runInContext('findsSource={films:catalogFilms,ready:true,error:false,programmeRunId:"run",generatedAt:null}',ui);
assert.equal(run('renderFinds(now).length',null),5);
assert.equal(nodes['#finds'].hidden,false);
assert.equal((nodes['#finds-cards'].innerHTML.match(/class="finds-card"/g)||[]).length,5);
assert.equal(nodes['#finds-caption'].textContent,'5 фильмов вне watchlist: сильный прогноз и реальный показ');
vm.runInContext("films=[{id:'tmdb_32',tmdbId:'32',title:'Теперь в watchlist',shows:[]}];enrichment={profile:null,films:{tmdb_31:{actualRating:4,prediction:null}}};",ui);
assert.deepEqual(ids(run('renderFinds(now)',null)),['tmdb_34','tmdb_33','tmdb_35','tmdb_36','tmdb_37'],'a film added to the watchlist or rated disappears on the next render');
assert.equal(nodes['#finds-caption'].textContent,'5 фильмов вне watchlist: сильный прогноз и реальный показ');
vm.runInContext("films=[];enrichment={profile:null,films:{}};",ui);
ui.catalogFilms=[ranked[1]];
vm.runInContext('findsSource={films:catalogFilms,ready:true,error:false,programmeRunId:"run",generatedAt:null}',ui);
assert.equal(run('renderFinds(now).length',null),1);
assert.equal(nodes['#finds-caption'].textContent,'1 фильм вне watchlist: сильный прогноз и реальный показ');
assert.equal(run(`renderFinds(now+200*${hour}).length`,null),0,'an expired catch-up hides the section without a new fetch');
assert.equal(nodes['#finds'].hidden,true);
console.log('Finds: thresholds, window, watchlist and watched exclusions, ranking, limit, no filler, dedupe, franchise, airing, NEW card and hidden empty section passed');
