import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Similar films on the open film page: at most eight available candidates from the loaded watchlist
// and the catalog answer Finds already cached. No second catalog read.
const now=Date.UTC(2026,5,15,10,0,0),hour=3600000;
const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/styles.css','utf8'),app=fs.readFileSync('public/app.js','utf8');
assert.equal((app.match(/fetch\('\/api\/catalog\/available'\)/g)||[]).length,1,'similar films do not add a catalog read');
const similarSource=app.slice(app.indexOf('function similarVerifiedIdentity'),app.indexOf('function findsLabels'));
assert.doesNotMatch(similarSource,/fetch\(|XMLHttpRequest|Worker\(/,'ranking stays inside the films and catalog answer already in memory');
assert.match(html,/id="film-similar"/);
assert(html.indexOf('id="film-screen-availability"')<html.indexOf('id="film-similar"')&&html.indexOf('id="film-similar"')<html.indexOf('id="film-screen-identity"'),'the open film availability stays above similar films');
assert.match(html,/id="film-similar" class="film-section film-similar" hidden/);
assert.match(css,/\.film-similar\[hidden\]\{display:none\}/);
assert.match(css,/\.film-similar-cards\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(360px,1fr\)\);gap:12px\}/);
assert.match(css,/\.film-similar-card\{[^}]*background:var\(--surface\)/);
assert.match(css,/\.film-similar-card\.is-catalog\{border-color:#3f7a52;background:#1a2d21\}/);
assert.match(css,/@media\(max-width:760px\)\{\.film-similar-cards\{grid-template-columns:1fr\}/);
assert.match(css,/@media\(max-width:410px\)\{\.film-similar-card\.has-score \.film-head\{padding-top:84px/);
assert.match(css,/\.film-similar-open:focus-visible,\.film-similar-external:focus-visible\{outline:2px solid var\(--lime\)/);
assert.match(css,/\.film-similar-open,\.film-similar-external\{[^}]*overflow-wrap:anywhere/);
assert.match(css,/#film-screen\{max-width:1280px\}/);
assert.doesNotMatch(css,/\.film-screen\{[^}]*max-width/,'the film route sets this class on the document element, so the width cap stays on the section');
assert.match(css,/\.film-read\{max-width:760px\}/);
assert.match(css,/\.film-similar-card\{[^}]*max-width:none;justify-self:stretch\}/);
const readOpen=html.indexOf('<div class="film-read">'),similarAt=html.indexOf('id="film-similar"'),readSlice=html.slice(readOpen,similarAt);
assert(readOpen>0&&readOpen<html.indexOf('id="film-back"')&&similarAt>readOpen,'the readable column opens before the film body and closes before similar films');
assert.equal((readSlice.match(/<div\b/g)||[]).length,(readSlice.match(/<\/div>/g)||[]).length,'the readable column is closed before similar films');
assert.match(css,/color-scheme:dark/);
assert.doesNotMatch(css,/prefers-color-scheme:\s*light/);

const nodes={'#film-similar':{hidden:true},'#film-similar-cards':{innerHTML:''},'#film-screen':{hidden:true,dataset:{}},'#film-screen-title':{textContent:'',focus(){}}};
const fetches=[];
const stack=[];
let index=-1;
const window={
 scrollY:0,
 scrollTo(_x,y){window.scrollY=y;},
 location:{href:'https://iptv.example/'},
 history:{
  get state(){return index>=0?stack[index].state:null;},
  pushState(state,_title,url){stack.splice(index+1);stack.push({href:new URL(url,'https://iptv.example').href,state});index++;window.location.href=stack[index].href;},
  replaceState(state,_title,url){if(index<0){stack.push({href:new URL(url,'https://iptv.example').href,state});index=0;}else stack[index]={href:new URL(url,'https://iptv.example').href,state};window.location.href=stack[index].href;},
  back(){if(index<=0)return;index--;window.location.href=stack[index].href;vm.runInContext('onHistoryNavigation()',ui);},
  forward(){if(index>=stack.length-1)return;index++;window.location.href=stack[index].href;vm.runInContext('onHistoryNavigation()',ui);},
 },
};
const ui=vm.createContext({
 Date,Intl,Set,Map,URL,URLSearchParams,JSON,window,
 document:{
  documentElement:{classList:{toggle(){},add(){},remove(){}}},
  querySelector:selector=>nodes[selector]||null,
  querySelectorAll:()=>[],
  addEventListener(){},
 },
 fetch(url){fetches.push(String(url));throw new Error('similar films must not fetch');},
});
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
ui.now=now;
vm.runInContext(`viewClock=${now};urlReady=true`,ui);
const run=(expression,input)=>{ui.input=input;return vm.runInContext(expression,ui);};
const show=(offset,channel='Один')=>({channel,start:now+offset*hour,end:now+(offset+2)*hour});
const strong=(rating=4.4,probability=.8,confidence='high')=>({predictedRating:rating,probability4Plus:probability,confidence,stale:false,moodIds:[]});
const watch=(id,extra={})=>({id,title:extra.title||id,original:extra.original||extra.title||id,year:extra.year??2001,runtime:extra.runtime,poster:extra.poster,tmdbId:extra.tmdbId,canonicalIdentity:extra.canonicalIdentity,directors:extra.directors||[],actors:extra.actors||[],shows:extra.shows===undefined?[show(-5)]:extra.shows,url:extra.url,genres:extra.genres||['Драма'],catalogOnly:extra.catalogOnly===true});
const catalog=(id,tmdb,extra={})=>({id,tmdbId:String(tmdb),canonicalIdentity:extra.canonicalIdentity||'tmdb:'+tmdb,title:extra.title||id,original:extra.original||extra.title||id,year:extra.year??2011,runtime:extra.runtime,poster:extra.poster,directors:extra.directors||[],actors:extra.actors||[],shows:extra.shows===undefined?[show(-4)]:extra.shows,url:Object.hasOwn(extra,'url')?extra.url:`https://www.themoviedb.org/movie/${tmdb}`,genres:extra.genres||['триллер'],fingerprint:Object.hasOwn(extra,'fingerprint')?extra.fingerprint:{plotMechanics:extra.mechanics||[],moodIds:extra.moods||[],execution:extra.execution||{}},prediction:extra.prediction===undefined?null:extra.prediction});
const stored=(extra={})=>{const row={fingerprint:Object.hasOwn(extra,'fingerprint')?extra.fingerprint:{plotMechanics:extra.mechanics||[],moodIds:extra.moods||[],execution:extra.execution||{}},prediction:extra.prediction===undefined?null:extra.prediction,actualRating:extra.actualRating};if(Object.hasOwn(extra,'watched'))row.watched=extra.watched;return row;};
function load({films,enrichment,catalogFilms=null,runId='G1',filmId='open'}){
 ui.filmsList=films;
 ui.enrichmentFilms=enrichment;
 ui.catalogFilms=catalogFilms||[];
 const source=catalogFilms?`findsSource={films:catalogFilms,programmeRunId:'${runId}',generatedAt:'2026-06-15T10:00:00Z',ready:true,error:false,watchedMarkEnabled:false}`:`findsSource={films:[],programmeRunId:null,generatedAt:null,ready:false,error:false,watchedMarkEnabled:false}`;
 vm.runInContext(`films=filmsList;enrichment={profile:null,films:enrichmentFilms};report={runId:'${runId}',films:[]};${source};findsMarks.clear();state.channels.clear();state.period='all';state.genres.clear();state.mechanics.clear();state.moods.clear();state.directors='';state.actors='';state.startedOnly=false;state.viewing='any';startedIds=new Set();filmScreen='${filmId}'`,ui);
}
const rows=()=>run('buildSimilar(films.find(item=>item.id===filmScreen),now)');
const ids=list=>JSON.stringify(Array.from(list,row=>row.film.id));
const same=(actual,expected,message)=>assert.equal(actual,JSON.stringify(expected),message);
const open=watch('open',{title:'Жара',original:'Heat',year:1995,tmdbId:'100',canonicalIdentity:'tmdb:100',directors:[{id:'tmdb_director/525',name:'Манн'}],actors:[{id:'tmdb_actor/7',name:'Де Ниро'},{id:'tmdb_actor/8',name:'Пакчино'}]});
const openStored=stored({mechanics:['heist','investigation'],moods:['tense'],execution:{pace:'fast',plot_engine:'strong'},prediction:strong(4.1,.75)});

// No shared substance: genre, mood alone, unknown execution and a weak forecast are not a recommendation.
load({films:[open,watch('genre',{title:'Тот же жанр',genres:['Драма']}),watch('mood'),watch('unknown'),watch('weak')],enrichment:{
 open:openStored,
 genre:stored({prediction:strong(3.2,.4,'low')}),
 mood:stored({moods:['tense'],prediction:strong(3.2,.4,'low')}),
 unknown:stored({execution:{pace:'unknown',stakes:'not_applicable',action_readability:'strong'}}),
 weak:stored({prediction:strong(3.9,.9)}),
}});
same(ids(rows()),[],'genre, mood alone, unknown execution and a forecast under the floor add nothing');
assert.equal(run('renderSimilar(now).length'),0);
assert.equal(nodes['#film-similar'].hidden,true,'no strong match hides the section');
assert.equal(nodes['#film-similar-cards'].innerHTML,'');

// One substantive peer is one card, not a padded row.
load({films:[open,watch('only',{title:'Один'})],enrichment:{open:openStored,only:stored({mechanics:['heist']})}});
same(ids(rows()),['only']);
assert.equal(run('renderSimilar(now).length'),1);
assert.equal(nodes['#film-similar'].hidden,false);
assert.equal((nodes['#film-similar-cards'].innerHTML.match(/class="film-similar-card\b/g)||[]).length,1);

// Mechanics outrank people, execution, genre and a higher forecast. Mood counts only beside a mechanic.
const mechanic=watch('mechanic',{title:'Ограбление'});
const richer=watch('richer',{title:'Две механики'});
const withMood=watch('with-mood',{title:'Ограбление и тон'});
const director=watch('director',{title:'Тот же режиссёр',directors:[{id:'tmdb_director/525',name:'Другое имя'}]});
const actors=watch('actors',{title:'Те же актёры',actors:[{id:'tmdb_actor/7',name:'Де Ниро'},{id:'tmdb_actor/8',name:'Пакчино'}]});
const pace=watch('pace',{title:'Тот же темп'});
const genreForecast=watch('genre-forecast',{title:'Только жанр',genres:['Криминал']});
load({films:[open,genreForecast,pace,actors,director,withMood,mechanic,richer],enrichment:{
 open:openStored,
 mechanic:stored({mechanics:['heist'],prediction:strong(3.1,.5,'low')}),
 richer:stored({mechanics:['investigation','heist'],prediction:strong(3.0,.5,'low')}),
 'with-mood':stored({mechanics:['heist'],moods:['tense'],prediction:strong(3.0,.5,'low')}),
 director:stored({prediction:strong(4.9,.99)}),
 actors:stored({prediction:strong(4.8,.99)}),
 pace:stored({execution:{pace:'fast'},prediction:strong(4.7,.99)}),
 'genre-forecast':stored({prediction:strong(4.95,.99)}),
}});
same(ids(rows()),['richer','with-mood','mechanic','director','actors','pace','genre-forecast'],'a mechanic beats mood-less mechanic, people, execution and a prediction-only film');
assert.equal(rows().find(row=>row.film.id==='with-mood').reasonKind,'mechanic_mood');
assert.equal(rows().find(row=>row.film.id==='with-mood').label,'Ограбление · Напряжённый');
assert.equal(rows().find(row=>row.film.id==='richer').label,'Ограбление и Расследование');
assert.equal(rows().find(row=>row.film.id==='director').label,'Общий режиссёр');
assert.equal(rows().find(row=>row.film.id==='actors').label,'Общие актёры');
assert.equal(rows().find(row=>row.film.id==='pace').label,'Похожий темп');
assert.equal(rows().find(row=>row.film.id==='genre-forecast').label,'Подходит по прогнозу');
assert.equal(rows().find(row=>row.film.id==='genre-forecast').reasonKind,'prediction');

// One shared actor, and a director match wins the label when both are present. Names are not ids.
load({films:[open,watch('one-actor',{actors:[{id:'tmdb_actor/7',name:'Совсем другой'}]}),watch('both',{directors:[{id:'tmdb_director/525',name:'Манн'}],actors:[{id:'tmdb_actor/7',name:'Де Ниро'}]}),watch('name-only',{directors:[{name:'Манн'}],actors:[{id:'actor/hardy',name:'Де Ниро'}]})],enrichment:{open:openStored, 'one-actor':stored(), both:stored(), 'name-only':stored()}});
assert.equal(rows().find(row=>row.film.id==='one-actor').label,'Общий актёр');
assert.equal(rows().find(row=>row.film.id==='both').label,'Общий режиссёр');
assert.equal(rows().find(row=>row.film.id==='name-only'),undefined,'a shared name or a Letterboxd id is not a TMDB credit');

// Execution: a known value matches, unknown and not_applicable do not, and the first stored dimension names the reason.
load({films:[open,watch('engine'),watch('blind')],enrichment:{
 open:stored({execution:{plot_engine:'strong',pace:'fast',stakes:'unknown'}}),
 engine:stored({execution:{pace:'fast',plot_engine:'strong',stakes:'not_applicable'}}),
 blind:stored({execution:{pace:'unknown',stakes:'not_applicable'}}),
}});
same(ids(rows()),['engine']);
assert.equal(rows()[0].label,'Похожий сюжетный двигатель');

// Tie-break after the theme: rating, probability, earlier end of availability, then the canonical key.
load({films:[open,watch('low-prob',{original:'low-prob'}),watch('high-prob',{original:'high-prob'}),watch('sooner',{original:'sooner',shows:[show(-40)]}),watch('later',{original:'later',shows:[show(-5)]}),watch('id-b',{original:'id-b'}),watch('id-a',{original:'id-a'})],enrichment:{
 open:openStored,
 'low-prob':stored({mechanics:['heist'],prediction:strong(4.2,.71)}),
 'high-prob':stored({mechanics:['heist'],prediction:strong(4.2,.9)}),
 sooner:stored({mechanics:['heist'],prediction:strong(4.0,.8)}),
 later:stored({mechanics:['heist'],prediction:strong(4.0,.8)}),
 'id-b':stored({mechanics:['heist'],prediction:strong(3.5,.8)}),
 'id-a':stored({mechanics:['heist'],prediction:strong(3.5,.8)}),
}});
same(ids(rows()),['high-prob','low-prob'],'the same mechanic keeps the two strongest: rating, then probability');
load({films:[open,watch('low-prob'),watch('high-prob'),watch('sooner',{shows:[show(-40)]}),watch('later',{shows:[show(-5)]}),watch('id-b'),watch('id-a')],enrichment:{
 open:stored({mechanics:['heist','investigation','mystery','puzzle','chase_escape','rescue'],prediction:strong(4.1,.75)}),
 'low-prob':stored({mechanics:['heist'],prediction:strong(4.2,.71)}),
 'high-prob':stored({mechanics:['investigation'],prediction:strong(4.2,.9)}),
 sooner:stored({mechanics:['mystery'],prediction:strong(4.0,.8)}),
 later:stored({mechanics:['puzzle'],prediction:strong(4.0,.8)}),
 'id-b':stored({mechanics:['chase_escape'],prediction:strong(3.5,.8)}),
 'id-a':stored({mechanics:['rescue'],prediction:strong(3.5,.8)}),
}});
same(ids(rows()),['high-prob','low-prob','sooner','later','id-a','id-b'],'distinct reasons keep the tie-break: rating, probability, earlier availability, then the id');

// A stale or missing forecast is not a number and does not outrank a current lower one.
load({films:[open,watch('stale'),watch('fresh'),watch('none')],enrichment:{
 open:openStored,
 stale:stored({mechanics:['heist'],prediction:{predictedRating:4.9,probability4Plus:.99,confidence:'high',stale:true}}),
 fresh:stored({mechanics:['heist'],prediction:strong(4.0,.7,'medium')}),
 none:stored({mechanics:['heist'],prediction:null}),
}});
same(ids(rows()),['fresh','none']);
assert.equal(rows().find(row=>row.film.id==='stale'),undefined,'a third copy of the same mechanic is left out, so the stale forecast is not a ninth label');
load({films:[open,watch('stale'),watch('fresh'),watch('none')],enrichment:{
 open:stored({mechanics:['heist','mystery','puzzle'],moods:['tense'],execution:{pace:'fast',plot_engine:'strong'},prediction:strong(4.1,.75)}),
 stale:stored({mechanics:['puzzle'],prediction:{predictedRating:4.9,probability4Plus:.99,confidence:'high',stale:true}}),
 fresh:stored({mechanics:['heist'],prediction:strong(4.0,.7,'medium')}),
 none:stored({mechanics:['mystery'],prediction:null}),
}});
same(ids(rows()),['fresh','none','stale'],'distinct mechanics keep the tie-break: a current forecast, then no number, then a stale one');
assert.equal(rows().find(row=>row.film.id==='stale').prediction,null);
const staleMarkup=run('renderSimilar(now).map(row=>similarCard(row,now)).join("")');
assert.doesNotMatch(staleMarkup,/4\.9/);
assert.match(staleMarkup,/<span>ПРОГНОЗ<\/span><strong>4\.0<\/strong><small>70% на 4\.0\+<\/small>/);

// One shared mechanic is one reason. Two cards may repeat it; the rest are left out. Nothing is invented to fill.
function peers(count){
 const films=[open],enrichment={open:openStored};
 for(let i=0;i<count;i++){const id=`m${String(i).padStart(2,'0')}`;films.push(watch(id,{title:`Фильм ${String.fromCharCode(65+i)}`,original:`Peer${String.fromCharCode(65+i)}`}));enrichment[id]=stored({mechanics:['heist'],prediction:strong(4+i/100,.8)});}
 return {films,enrichment};
}
load(peers(6));
same(ids(rows()),['m05','m04'],'six films that share one mechanic stay the two strongest');
assert.equal(new Set(rows().map(row=>row.label)).size,1);
assert.equal(new Set(rows().map(row=>row.signature)).size,1);
load(peers(8));
same(ids(rows()),['m07','m06']);
load(peers(10));
same(ids(rows()),['m09','m08'],'eight identical rationales do not become eight cards');

// Franchise stem: a repeat of the same reason is skipped; a different reason or an extra mechanic is kept.
load({films:[
 open,
 watch('rocky',{title:'Рокки',original:'Rocky'}),
 watch('rocky-2',{title:'Рокки 2',original:'Rocky II'}),
 watch('rocky-3',{title:'Рокки 3',original:'Rocky III'}),
 watch('rocky-4',{title:'Рокки 4',original:'Rocky IV',directors:[{id:'tmdb_director/525',name:'Сталлоне'}]}),
 watch('other',{title:'Другой',original:'Other'}),
],enrichment:{
 open:openStored,
 rocky:stored({mechanics:['heist'],prediction:strong(4.5,.8)}),
 'rocky-2':stored({mechanics:['investigation'],prediction:strong(4.0,.8)}),
 'rocky-3':stored({mechanics:['heist'],prediction:strong(4.2,.8)}),
 'rocky-4':stored({prediction:strong(4.6,.9)}),
 other:stored({mechanics:['heist'],prediction:strong(3.4,.5,'low')}),
}});
same(ids(rows()),['rocky','rocky-2','other','rocky-4'],'a sequel stays only for a different mechanic or a director, not for the same heist');
load({films:[open,watch('origin',{original:'Dungeons and Dragons'}),watch('sequel',{original:'Dungeons and Dragons 2'})],enrichment:{
 open:openStored,
 origin:stored({mechanics:['heist'],moods:['tense'],prediction:strong(4.4,.8)}),
 sequel:stored({mechanics:['heist'],moods:['tense'],prediction:strong(4.8,.9)}),
}});
same(ids(rows()),['sequel'],'the same mechanic plus a mood is not an independent franchise reason');
load({films:[open,watch('rocky',{original:'Rocky'}),watch('rocky-2',{original:'Rocky II'})],enrichment:{open:openStored,rocky:stored({mechanics:['heist'],prediction:strong(4.5,.9)}),'rocky-2':stored({mechanics:['heist'],prediction:strong(4.9,.99)})}});
same(ids(rows()),['rocky-2'],'a higher forecast does not keep a second copy of the same reason');

// The open film is excluded by id and by a verified TMDB identity. A shared title is not identity.
load({films:[
 open,
 watch('open',{title:'Другой id',tmdbId:'999',canonicalIdentity:'tmdb:999'}),
 watch('same-tmdb',{title:'Другое название',original:'Other Heat',tmdbId:'100',canonicalIdentity:'tmdb:100'}),
 watch('title-twin',{title:'Жара',original:'Heat',year:1995,tmdbId:'101',canonicalIdentity:'tmdb:101'}),
 watch('unverified',{title:'Жара',tmdbId:'100'}),
],enrichment:{
 open:openStored,
 'same-tmdb':stored({mechanics:['heist']}),
 'title-twin':stored({mechanics:['heist']}),
 unverified:stored({mechanics:['heist']}),
}});
same(ids(rows()),['title-twin'],'the same id, the same verified identity, and a bare TMDB id of the open film are excluded; the title twin stays');

// Catalog and watchlist. A catalog row already loaded is not repeated. Rated needs a real match and is a rewatch.
const outside=catalog('tmdb_8',8,{title:'Снаружи',mechanics:['heist'],prediction:strong(4.6,.86),directors:[{id:'tmdb_director/525',name:'Манн'}]});
const listed=watch('listed',{title:'Уже в списке',tmdbId:'8',canonicalIdentity:'tmdb:8'});
const rated=watch('rated',{title:'Уже смотрел'});
const started=watch('started',{title:'Начат'});
const expired=catalog('tmdb_9',9,{title:'Истёк',mechanics:['heist'],shows:[show(-72)],prediction:strong(4.9,.9)});
const far=catalog('tmdb_10',10,{title:'Далеко',mechanics:['heist'],shows:[show(24)],prediction:strong(4.9,.9)});
const edge=catalog('tmdb_11',11,{title:'На границе',mechanics:['investigation'],shows:[show(-71)],prediction:strong(4.2,.8)});
const soon=catalog('tmdb_12',12,{title:'Скоро',mechanics:['heist'],moods:['dark'],shows:[show(23)],prediction:strong(4.3,.8)});
load({films:[open,listed,rated,started,watch('program-only',{title:'Только в программе',catalogOnly:true,directors:[{id:'tmdb_director/525',name:'Манн'}]})],enrichment:{
 open:openStored,
 listed:stored({mechanics:['investigation']}),
 rated:stored({mechanics:['heist'],actualRating:5,prediction:strong(4.9,.99)}),
 started:stored({mechanics:['heist']}),
},catalogFilms:[outside,expired,far,edge,soon,catalog('tmdb_13',13,{title:'Оценён в каталоге',mechanics:['heist'],prediction:strong(4.4,.8)}),catalog('tmdb_14',14,{title:'<Скрипт>',mechanics:['scam'],url:'https://evil.example/movie/14',prediction:strong(4.4,.8)})]});
vm.runInContext("enrichment.films.tmdb_13={actualRating:4,prediction:null};startedIds=new Set(['started']);findsMarks.set('12',{state:'marked'})",ui);
const mixed=rows();
same(ids(mixed),['rated','started','listed','tmdb_11','tmdb_14'],'watchlist films come first, then finds; expired, future-edge, marked and rated catalog rows do not');
assert.equal(mixed.find(row=>row.film.id==='program-only'),undefined,'a loaded catalog-only programme row is neither watchlist nor a second catalog card');
assert.equal(mixed.find(row=>row.film.id==='listed').badge,'watchlist');
assert.equal(mixed.find(row=>row.film.id==='rated').badge,'rewatch');
assert.equal(mixed.find(row=>row.film.id==='started').badge,'watchlist','started is not watched');
assert.equal(mixed.find(row=>row.film.id==='tmdb_11').badge,'new');
const markup=run('renderSimilar(now).map(row=>similarCard(row,now)).join("\\n")');
assert.match(markup,/data-similar-source="watchlist" data-similar-id="listed"/);
assert.match(markup,/В watchlist/);
assert.match(markup,/Пересмотр/);
const ratedCard=markup.slice(markup.indexOf('data-similar-id="rated"'),markup.indexOf('</article>',markup.indexOf('data-similar-id="rated"')));
assert.match(ratedCard,/Пересмотр/);
assert.doesNotMatch(ratedCard,/NEW/);
assert.match(markup,/data-similar-open="listed"/);
assert.match(markup,/class="film-similar-badge is-new" title="Фильм вне watchlist, не новинка проката">NEW/);
assert.match(markup,/href="https:\/\/www\.themoviedb\.org\/movie\/11" target="_blank" rel="noopener noreferrer"/);
assert.match(markup,/<span class="film-similar-out">TMDB<\/span>/);
assert.match(markup,/&lt;Скрипт&gt;/);
assert.doesNotMatch(markup,/evil\.example|href="https:\/\/evil/);
assert.equal(fetches.length,0,'rendering the cards does not fetch');

// Taking the film off the watchlist lets the catalog row through, as NEW, on the next render.
vm.runInContext("films=films.filter(item=>item.id!=='listed')",ui);
assert.equal(rows().some(row=>row.film.id==='tmdb_8'&&row.badge==='new'),true,'leaving the watchlist returns the catalog row');
assert.match(run('similarCard(buildSimilar(films.find(item=>item.id===filmScreen),now).find(row=>row.film.id==="tmdb_8"),now)'),/data-similar-source="catalog"/);

// Page filters, channel and period do not narrow this block. The same show would leave Finds.
load({films:[open,watch('elsewhere',{shows:[show(-5,'Другой канал')]})],enrichment:{open:openStored,elsewhere:stored({mechanics:['heist']})}});
vm.runInContext("state.channels=new Set(['Один']);state.period='future';state.genres.add('Комедия');state.mechanics.add('scam');state.directors='tmdb_director/999'",ui);
same(ids(rows()),['elsewhere'],'channel, period and the other filters stay on Finds');
assert.equal(run('findsShows(films.find(item=>item.id==="elsewhere"),now).length'),0,'the Finds scope really does exclude that show');

// Generation pin: a mismatch or a 409 drops the catalog half and keeps the watchlist half.
// A failed refresh of the same generation keeps the last answer.
load({films:[open,watch('kept',{title:'В списке'})],enrichment:{open:openStored,kept:stored({mechanics:['heist']})},catalogFilms:[catalog('tmdb_20',20,{title:'Каталог',mechanics:['heist'],prediction:strong(4.5,.9)})]});
assert.equal(JSON.stringify(Array.from(rows(),row=>row.film.id).sort()),JSON.stringify(['kept','tmdb_20']));
vm.runInContext("report={runId:'G2',films:[]}",ui);
same(ids(rows()),['kept'],'a new generation hides the previous catalog answer');
vm.runInContext("report={runId:'G1',films:[]};findsSource={...findsSource,error:true}",ui);
assert.equal(JSON.stringify(Array.from(rows(),row=>row.film.id).sort()),JSON.stringify(['kept','tmdb_20']),'a failed refresh on the same generation keeps the catalog half');
vm.runInContext("report={runId:'G2',films:[]}",ui);
same(ids(rows()),['kept'],'a 409 leaves the cached generation unchanged, so the catalog half stays hidden');

// A catalog film that is already loaded opens in place. Anything else uses a TMDB URL or plain text.
load({films:[open,watch('local-peer',{title:'Сосед'})],enrichment:{open:openStored,'local-peer':stored({mechanics:['heist']})},catalogFilms:[catalog('tmdb_30',30,{title:'Снаружи',mechanics:['investigation'],prediction:strong(4.4,.8)})]});
const linked=run('renderSimilar(now).map(row=>similarCard(row,now)).join("\\n")');
assert.match(linked,/data-similar-open="local-peer"/);
assert.match(linked,/href="https:\/\/www\.themoviedb\.org\/movie\/30"/);
assert.doesNotMatch(linked,/href="\/film\//,'a catalog film that is not loaded does not get an internal route');

// Opening a loaded recommendation pushes a film URL and Back returns. No request either way.
load({films:[watch('source',{title:'Источник'}),watch('peer',{title:'Сосед'})],enrichment:{source:openStored,peer:stored({mechanics:['heist']})},filmId:'source'});
vm.runInContext("filmScreen=null;openFilm('source')",ui);
assert.equal(run('filmScreen'),'source');
assert.match(nodes['#film-similar-cards'].innerHTML,/data-similar-open="peer"/);
ui.click={target:{dataset:{similarOpen:'peer'},closest(selector){return selector==='[data-similar-open]'?ui.click.target:null;}},preventDefault(){this.prevented=true;}};
vm.runInContext('onMovieClick(click)',ui);
assert.equal(ui.click.prevented,true);
assert.equal(run('filmScreen'),'peer');
assert.equal(new URL(window.location.href).pathname,'/film/peer');
window.history.back();
assert.equal(run('filmScreen'),'source');
assert.equal(new URL(window.location.href).pathname,'/film/source');
window.history.forward();
assert.equal(run('filmScreen'),'peer');
assert.equal(fetches.length,0,'opening a similar film and going back does not fetch');
const before=run('JSON.stringify(enrichment)');
run('renderSimilar(now)');
assert.equal(run('JSON.stringify(enrichment)'),before,'rendering does not write enrichment');

// watched true or a stored rating is a rewatch, and only with a real match. watched false, null, absent and started are not.
load({films:[
 open,
 watch('seen',{title:'Смотрел без оценки'}),
 watch('forecast-seen',{title:'Смотрел, только прогноз'}),
 watch('denied',{title:'Явно не смотрел'}),
 watch('forecast-denied',{title:'Не смотрел, только прогноз'}),
 watch('unknown',{title:'Неизвестно'}),
 watch('forecast-unknown',{title:'Неизвестно, только прогноз'}),
 watch('absent',{title:'Нет поля'}),
 watch('rated-denied',{title:'Оценка важнее'}),
 watch('rated-unknown',{title:'Оценка без факта'}),
 watch('started',{title:'Только начат'}),
],enrichment:{
 open:stored({mechanics:['heist','investigation','mystery','puzzle','scam'],moods:['tense'],execution:{pace:'fast',plot_engine:'strong'},prediction:strong(4.1,.75)}),
 seen:stored({mechanics:['heist'],watched:true,prediction:strong(4.4,.8)}),
 'forecast-seen':stored({watched:true,prediction:strong(4.8,.95)}),
 denied:stored({mechanics:['investigation'],watched:false,prediction:strong(4.4,.8)}),
 'forecast-denied':stored({watched:false,prediction:strong(4.8,.95)}),
 unknown:stored({mechanics:['mystery'],watched:null,prediction:strong(4.4,.8)}),
 'forecast-unknown':stored({watched:null,prediction:strong(4.8,.95)}),
 absent:stored({mechanics:['puzzle'],prediction:strong(4.4,.8)}),
 'rated-denied':stored({mechanics:['scam'],watched:false,actualRating:4,prediction:strong(4.9,.99)}),
 'rated-unknown':stored({watched:null,actualRating:4,prediction:strong(4.9,.99)}),
 started:stored({watched:false,prediction:strong(4.7,.9)}),
}});
vm.runInContext("startedIds=new Set(['started','seen'])",ui);
const watchedRows=rows();
const watchedBadge=(id,badge,message)=>assert.equal(watchedRows.find(row=>row.film.id===id)?.badge,badge,message);
const watchedGone=(id,message)=>assert.equal(watchedRows.find(row=>row.film.id===id),undefined,message);
watchedBadge('seen','rewatch','a confirmed viewing without a rating is a rewatch when the match is real');
assert.equal(watchedRows.find(row=>row.film.id==='seen').label,'Ограбление');
watchedGone('forecast-seen','a confirmed viewing with only a strong forecast is not shown');
watchedBadge('denied','watchlist','an explicit watched:false without a rating stays on the watchlist');
watchedBadge('forecast-denied','watchlist');
assert.equal(watchedRows.find(row=>row.film.id==='forecast-denied').label,'Подходит по прогнозу');
watchedBadge('unknown','watchlist','unknown is not a first viewing and not a rewatch');
watchedBadge('forecast-unknown','watchlist');
watchedBadge('absent','watchlist','a missing watched field is unknown, not false');
watchedBadge('rated-denied','rewatch','a stored rating wins over watched:false');
watchedGone('rated-unknown','a rating without a substantive match is not a prediction-only card');
assert.equal(watchedRows.find(row=>row.film.id==='started'),undefined,'a third prediction-only label is not added beside two already shown');
load({films:[open,watch('started',{title:'Только начат'})],enrichment:{open:openStored,started:stored({watched:false,prediction:strong(4.7,.9)})},filmId:'open'});
vm.runInContext("startedIds=new Set(['started'])",ui);
assert.equal(rows().find(row=>row.film.id==='started')?.badge,'watchlist','started is not watched');
assert.equal(rows().find(row=>row.film.id==='started').label,'Подходит по прогнозу');
assert.equal(fetches.length,0,'the watched matrix does not fetch');
const watchedBefore=run('JSON.stringify(enrichment)');
run('renderSimilar(now)');
assert.equal(run('JSON.stringify(enrichment)'),watchedBefore,'rendering a rewatch does not write enrichment');

// A catalog candidate already confirmed watched or rated in the loaded view is dropped. The alias is a verified TMDB id.
// A Letterboxd id with two TMDB ids does not bridge, and a shared title does not either.
const alias=catalog('other-id',50,{title:'Другой ключ',mechanics:['heist'],prediction:strong(4.4,.8)});
const link=catalog('solo-lid',90,{title:'Одна связь',shows:[]});
const agreed=catalog('tmdb_90',90,{title:'Согласованный',mechanics:['investigation'],prediction:strong(4.3,.8)});
const clashA=catalog('heat-lid',60,{title:'Связь А',shows:[]});
const clashB=catalog('heat-lid',61,{title:'Связь Б',shows:[]});
const disputed=catalog('tmdb_60',60,{title:'Спорный',mechanics:['heist'],prediction:strong(4.4,.8)});
const namesake=catalog('tmdb_70',70,{title:'Жара',original:'Heat',year:1995,mechanics:['heist'],prediction:strong(4.4,.8)});
const explicitNo=catalog('tmdb_80',80,{title:'Явно нет',mechanics:['mystery'],prediction:strong(4.4,.8)});
const ratedNo=catalog('tmdb_82',82,{title:'Оценка без просмотра',mechanics:['scam'],prediction:strong(4.4,.8)});
const loose=catalog('loose-50',50,{title:'Без идентичности',canonicalIdentity:'unverified',mechanics:['puzzle'],prediction:strong(4.2,.8)});
load({films:[open],enrichment:{
 open:stored({mechanics:['heist','investigation','mystery','puzzle'],moods:['tense'],execution:{pace:'fast',plot_engine:'strong'},prediction:strong(4.1,.75)}),
 tmdb_50:stored({watched:true}),
 'solo-lid':stored({watched:true}),
 'heat-lid':stored({watched:true}),
 tmdb_80:stored({watched:false}),
 tmdb_82:stored({watched:false,actualRating:3}),
},catalogFilms:[alias,link,agreed,clashA,clashB,disputed,namesake,explicitNo,ratedNo,loose]});
const guarded=rows();
assert.equal(guarded.find(row=>row.film.id==='other-id'),undefined,'a verified TMDB alias with watched:true drops the catalog row');
assert.equal(guarded.find(row=>row.film.id==='tmdb_90'),undefined,'one agreed Letterboxd to TMDB link drops the catalog row');
assert.equal(guarded.find(row=>row.film.id==='tmdb_60')?.badge,'new','two TMDB ids for one Letterboxd id do not bridge a watched fact');
assert.equal(guarded.find(row=>row.film.id==='tmdb_70')?.badge,'new','a shared title is not a watched alias');
assert.equal(guarded.find(row=>row.film.id==='tmdb_80')?.badge,'new','watched:false without a rating leaves the catalog row');
assert.equal(guarded.find(row=>row.film.id==='tmdb_82'),undefined,'a rating still excludes a catalog row when watched is false');
assert.equal(guarded.find(row=>row.film.id==='loose-50')?.badge,'new','an unverified catalog id is not joined to a watched TMDB key');
assert.equal(fetches.length,0,'catalog guarding does not fetch');

// A same-generation refresh keeps the focused control. A real markup change restores it when that film is still shown.
function richCards(){
 const el={children:[],_html:''};
 Object.defineProperty(el,'innerHTML',{get(){return this._html;},set(html){
  this._html=html;this.children=[];
  for(const match of String(html).matchAll(/<article class="film-similar-card[^"]*"([\s\S]*?)<\/article>/g)){
   const body=match[1],card={dataset:{similarId:(body.match(/data-similar-id="([^"]*)"/)||[])[1]||''},buttons:[],links:[]};
   card.contains=node=>card.buttons.includes(node)||card.links.includes(node);
   for(const buttonMatch of body.matchAll(/data-similar-open="([^"]*)"/g)){const button={dataset:{similarOpen:buttonMatch[1]},classList:{contains(){return false;}},closest(){return card;},focus(){ui.document.activeElement=button;}};card.buttons.push(button);}
   for(const linkMatch of body.matchAll(/<a class="film-similar-external" href="([^"]*)"/g)){const link={dataset:{},classList:{contains(name){return name==='film-similar-external';}},getAttribute(name){return name==='href'?linkMatch[1]:null;},closest(){return card;},focus(){ui.document.activeElement=link;}};card.links.push(link);}
   this.children.push(card);
  }
 }});
 el.contains=node=>el.children.some(card=>card===node||card.contains(node));
 el.querySelectorAll=selector=>{const found=[];for(const card of el.children){if(selector==='[data-similar-open]')found.push(...card.buttons);if(selector==='a.film-similar-external')found.push(...card.links);}return found;};
 return el;
}
const rich=richCards();
nodes['#film-similar-cards']=rich;
nodes['#finds']={hidden:true,setAttribute(){}};
nodes['#finds-cards']={innerHTML:''};
nodes['#finds-title']={textContent:''};
nodes['#finds-caption']={textContent:''};
nodes['#finds-notice']={innerHTML:'',hidden:true};
ui.document.activeElement=null;
load({films:[open,watch('peer',{title:'Сосед',shows:[show(-1)]})],enrichment:{open:openStored,peer:stored({mechanics:['heist']})},catalogFilms:[catalog('tmdb_40',40,{title:'Снаружи',mechanics:['investigation'],shows:[show(-1)],prediction:strong(4.4,.8)})]});
vm.runInContext('similarMarkup=""',ui);
run('renderSimilar(now)');
const focused=rich.querySelectorAll('[data-similar-open]')[0];
assert.equal(focused.dataset.similarOpen,'peer');
ui.document.activeElement=focused;
run('renderFinds(now)');
assert.equal(ui.document.activeElement,focused,'a same-generation catalog refresh does not rebuild the focused title');
assert.equal(fetches.length,0,'the refresh test does not fetch');
vm.runInContext("films.find(item=>item.id==='peer').title='Сосед 2'",ui);
run('renderSimilar(now)');
const moved=ui.document.activeElement;
assert.notEqual(moved,focused,'a changed title replaces the card');
assert.equal(moved.dataset.similarOpen,'peer','focus returns to the same loaded film');
const external=rich.querySelectorAll('a.film-similar-external')[0];
ui.document.activeElement=external;
vm.runInContext("findsSource.films.find(item=>item.id==='tmdb_40').title='Другое снаружи'",ui);
run('renderSimilar(now)');
assert.notEqual(ui.document.activeElement,external);
assert.equal(ui.document.activeElement.getAttribute('href'),'https://www.themoviedb.org/movie/40','focus returns to the same TMDB link');
ui.document.activeElement=rich.querySelectorAll('[data-similar-open]')[0];
vm.runInContext("films=films.filter(item=>item.id!=='peer')",ui);
run('renderSimilar(now)');
assert.equal(rich.querySelectorAll('[data-similar-open]').length,0,'the loaded film is gone');
assert.equal(ui.document.activeElement?.classList?.contains('film-similar-external')||false,false,'focus is not moved onto a different card');

// Source order: up to four watchlist films, then finds. A fifth watchlist film does not come back after a short catalog tail.
const sourceOpen=stored({mechanics:['heist','investigation'],moods:['tense'],execution:{pace:'fast',plot_engine:'strong'},prediction:strong(4.1,.75)});
load({films:[
 open,
 watch('w-both',{title:'Две механики'}),
 watch('w-mood',{title:'Механика и тон'}),
 watch('w-director',{title:'Режиссёр',directors:[{id:'tmdb_director/525',name:'Манн'}]}),
 watch('w-actors',{title:'Актёры',actors:[{id:'tmdb_actor/7',name:'Де Ниро'},{id:'tmdb_actor/8',name:'Пакчино'}]}),
 watch('w-pace',{title:'Темп'}),
],enrichment:{
 open:sourceOpen,
 'w-both':stored({mechanics:['heist','investigation'],prediction:strong(4.9,.9)}),
 'w-mood':stored({mechanics:['heist'],moods:['tense'],prediction:strong(4.8,.9)}),
 'w-director':stored({prediction:strong(4.7,.9)}),
 'w-actors':stored({prediction:strong(4.6,.9)}),
 'w-pace':stored({execution:{pace:'fast'},prediction:strong(4.5,.9)}),
},catalogFilms:[catalog('tmdb_61',61,{title:'Находка',mechanics:['investigation'],prediction:strong(4.9,.95)})]});
same(ids(rows()),['w-both','w-mood','w-director','w-actors','tmdb_61'],'four watchlist films, then one find; the fifth watchlist film is not backfilled');
same(JSON.stringify(rows().map(row=>row.source)),['watchlist','watchlist','watchlist','watchlist','catalog'],'the watchlist block stays ahead of the find');

// Both sources can fill the eight. One source alone can use all eight. A single shared rationale still stops at two.
const manyMechanics=['heist','investigation','mystery','puzzle','chase_escape','rescue','scam','survival','siege','ticking_clock'];
const manyFilms=[open],manyEnrichment={open:stored({mechanics:manyMechanics,prediction:strong(4.1,.75)})};
for(let i=0;i<manyMechanics.length;i++){const id=`u${i}`;manyFilms.push(watch(id,{title:`Разный ${i}`}));manyEnrichment[id]=stored({mechanics:[manyMechanics[i]],prediction:strong(4.5-i/100,.8)});}
load({films:manyFilms,enrichment:manyEnrichment});
assert.equal(rows().length,8,'a watchlist-only slate can use all eight when the reasons differ');
assert.equal(new Set(rows().map(row=>row.signature)).size,8);
assert.equal(rows().every(row=>row.source==='watchlist'),true);
const catalogOnly=[open],catalogFilms=[];
for(let i=0;i<manyMechanics.length;i++)catalogFilms.push(catalog(`tmdb_${80+i}`,80+i,{title:`Каталог ${i}`,mechanics:[manyMechanics[i]],prediction:strong(4.5-i/100,.8)}));
load({films:catalogOnly,enrichment:{open:manyEnrichment.open},catalogFilms});
assert.equal(rows().length,8,'a finds-only slate can use all eight when the reasons differ');
assert.equal(rows().every(row=>row.source==='catalog'),true);
load({films:[open],enrichment:{open:openStored},catalogFilms:Array.from({length:8},(_,i)=>catalog(`tmdb_${180+i}`,180+i,{title:`Одинаковый ${String.fromCharCode(65+i)}`,original:`SameHeist${String.fromCharCode(65+i)}`,mechanics:['heist'],prediction:strong(4.5-i/100,.8)}))});
assert.equal(rows().length,2,'eight finds that share one rationale stay two');
assert.equal(new Set(rows().map(row=>row.label)).size,1);

// A second mechanic label is kept before a person. Generic execution does not replace that mechanic or rescue a film whose mechanic is already capped. A person or a pace label appears only when that is the film's only overlap.
load({films:[
 open,
 watch('only-a',{title:'Только ограбление A'}),
 watch('only-b',{title:'Только ограбление B'}),
 watch('also-director',{title:'Ещё режиссёр',directors:[{id:'tmdb_director/525',name:'Манн'}]}),
 watch('also-actors',{title:'Ещё актёры',actors:[{id:'tmdb_actor/7',name:'Де Ниро'},{id:'tmdb_actor/8',name:'Пакчино'}]}),
 watch('also-pace',{title:'Ещё темп'}),
 watch('only-c',{title:'Только ограбление C'}),
 watch('only-d',{title:'Только ограбление D'}),
 watch('director-only',{title:'Только режиссёр',directors:[{id:'tmdb_director/525',name:'Манн'}]}),
 watch('pace-only',{title:'Только темп'}),
],enrichment:{
 open:openStored,
 'only-a':stored({mechanics:['heist'],prediction:strong(4.2,.8)}),
 'only-b':stored({mechanics:['heist'],prediction:strong(4.1,.8)}),
 'also-director':stored({mechanics:['heist'],prediction:strong(4.6,.8)}),
 'also-actors':stored({mechanics:['heist'],prediction:strong(4.5,.8)}),
 'also-pace':stored({mechanics:['heist'],execution:{pace:'fast'},prediction:strong(4.4,.8)}),
 'only-c':stored({mechanics:['heist'],prediction:strong(4.0,.8)}),
 'only-d':stored({mechanics:['heist'],prediction:strong(3.9,.8)}),
 'director-only':stored({prediction:strong(4.3,.8)}),
 'pace-only':stored({execution:{pace:'fast'},prediction:strong(4.8,.99)}),
}});
const varied=rows();
assert.equal(varied.filter(row=>row.label==='Ограбление').length,2,'the mechanic label itself is not repeated past two');
assert.equal(varied.find(row=>row.film.id==='also-director').label,'Ограбление','a shared director does not replace the first mechanic label');
assert.equal(varied.find(row=>row.film.id==='also-actors').label,'Ограбление','a second mechanic label is kept before an unused actors label');
assert.equal(varied.find(row=>row.film.id==='also-pace'),undefined,'a generic pace label does not rescue a capped mechanic');
assert.equal(varied.find(row=>row.film.id==='only-c'),undefined);
assert.equal(varied.find(row=>row.film.id==='only-d'),undefined);
assert.equal(varied.find(row=>row.film.id==='director-only').label,'Общий режиссёр','a person label appears once the mechanic signature is exhausted and the film has no mechanic');
assert.equal(varied.find(row=>row.film.id==='pace-only').label,'Похожий темп','a generic execution label appears only when it is the film\'s only overlap');
same(ids(varied),['also-director','also-actors','director-only','pace-only'],'the stronger mechanic matches stay ahead of a higher-rated generic reason');
assert.ok(varied.length<8,'a slate of one mechanic does not fill eight cards by renaming it');

// Catalog NEW films clear the Finds floor before they are ranked. One qualifier stays one. A watchlist rewatch is not held to that floor.
load({films:[open,watch('rewatch',{title:'Уже смотрел'})],enrichment:{
 open:stored({mechanics:['heist'],execution:{protagonist_competence:'high',multi_party_goals:'strong',payoff:'strong',plot_engine:'strong'},prediction:strong(4.2,.8)}),
 rewatch:stored({mechanics:['heist'],actualRating:4.5,watched:false,prediction:strong(2.0,.04)}),
},catalogFilms:[
 catalog('tmdb_dragon',4935,{title:'Как приручить дракона 2',mechanics:['heist'],prediction:strong(4.5,.87)}),
 catalog('tmdb_ugly',429,{title:'Хороший, плохой, злой',execution:{protagonist_competence:'high'},prediction:strong(4.0,.61)}),
 catalog('tmdb_eternals',524434,{title:'Вечные',execution:{multi_party_goals:'strong'},prediction:strong(2.5,.13)}),
 catalog('tmdb_lorax',73723,{title:'Лоракс',execution:{payoff:'strong'},prediction:strong(2.0,.04)}),
 catalog('tmdb_low',3,{title:'Низкая уверенность',mechanics:['investigation'],prediction:strong(4.6,.9,'low')}),
 catalog('tmdb_stale',4,{title:'Устаревший',mechanics:['mystery'],prediction:{predictedRating:4.8,probability4Plus:.95,confidence:'high',stale:true,moodIds:[]}}),
 catalog('tmdb_none',5,{title:'Без прогноза',mechanics:['puzzle'],prediction:null}),
]});
same(ids(rows()),['rewatch','tmdb_dragon'],'4.0/61%, 2.5/13% and 2.0/4% catalog films are not offered, and a rated rewatch with a weak forecast stays');
assert.equal(rows().find(row=>row.film.id==='tmdb_dragon').label,'Ограбление');
assert.equal(rows().length,2,'one qualifying catalog film is not padded to four');
load({films:[open],enrichment:{open:stored({mechanics:['heist'],execution:{payoff:'strong',protagonist_competence:'high'},prediction:strong(4.1,.75)})},catalogFilms:[
 catalog('tmdb_mech',1,{title:'Механика',mechanics:['heist'],execution:{protagonist_competence:'high'},prediction:strong(4.5,.8)}),
 catalog('tmdb_pay',2,{title:'Отдача',execution:{payoff:'strong'},prediction:strong(4.6,.9)}),
]});
same(ids(rows()),['tmdb_mech','tmdb_pay'],'a mechanic match outranks a higher forecast whose only overlap is a generic execution value');
assert.equal(rows()[0].label,'Ограбление','the mechanic label is not swapped for the unused competence label');
assert.equal(rows()[1].label,'Похожая отдача');
load({films:[open,watch('origin',{original:'Dragon Film'}),watch('sequel',{original:'Dragon Film 2'})],enrichment:{
 open:stored({mechanics:['heist'],execution:{payoff:'strong',plot_engine:'strong'},prediction:strong(4.1,.75)}),
 origin:stored({mechanics:['heist'],prediction:strong(4.2,.8)}),
 sequel:stored({execution:{payoff:'strong'},prediction:strong(4.9,.99)}),
}});
same(ids(rows()),['origin'],'a generic execution value does not keep a franchise sequel');
load({films:[open,watch('origin',{original:'Dragon Film'}),watch('sequel',{original:'Dragon Film 2'})],enrichment:{
 open:stored({mechanics:['heist'],execution:{payoff:'strong',plot_engine:'strong'},prediction:strong(4.1,.75)}),
 origin:stored({mechanics:['heist'],prediction:strong(4.2,.8)}),
 sequel:stored({execution:{plot_engine:'strong'},prediction:strong(4.9,.99)}),
}});
same(ids(rows()),['origin','sequel'],'a shared plot engine can keep a franchise sequel');
assert.equal(rows().find(row=>row.film.id==='sequel').label,'Похожий сюжетный двигатель');

// Posters and corner scores come from the films already loaded. A missing poster uses the Finds placeholder and adds no request.
load({films:[
 open,
 watch('posted',{title:'С постером',original:'With Poster',poster:'https://image.tmdb.org/t/p/w185/abc.jpg',runtime:101}),
 watch('plain',{title:'Без постера',year:1999}),
],enrichment:{
 open:openStored,
 posted:stored({mechanics:['heist'],actualRating:4.5,prediction:strong(4.2,.8)}),
 plain:stored({mechanics:['investigation']}),
},catalogFilms:[catalog('tmdb_77',77,{title:'Находка без постера',original:'Find',year:2014,mechanics:[],execution:{plot_engine:'strong'},prediction:strong(4.4,.86)})]});
const cardHtml=run('renderSimilar(now).map(row=>similarCard(row,now)).join("\\n")');
const cardSlice=(id)=>{const at=cardHtml.indexOf(`data-similar-id="${id}"`),start=cardHtml.lastIndexOf('<article',at);return cardHtml.slice(start,cardHtml.indexOf('</article>',start));};
const postedCard=cardSlice('posted'),plainCard=cardSlice('plain'),findCard=cardSlice('tmdb_77');
assert.match(postedCard,/class="film-similar-card is-watchlist has-both-scores"/);
assert.match(postedCard,/class="poster" src="https:\/\/image\.tmdb\.org\/t\/p\/w185\/abc\.jpg"/);
assert.match(postedCard,/<span>МОЯ ОЦЕНКА<\/span><strong>4\.5<\/strong>/);
assert.match(postedCard,/<span>ПРОГНОЗ<\/span><strong>4\.2<\/strong>/);
assert.match(postedCard,/101 мин/);
assert.match(postedCard,/Пересмотр/);
assert.doesNotMatch(postedCard,/NEW/);
assert.match(plainCard,/class="poster no-poster" aria-label="Постер недоступен">1999</);
assert.doesNotMatch(plainCard,/score-badge|fetch\(/);
assert.match(findCard,/class="film-similar-card is-catalog has-score"/);
assert.match(findCard,/class="poster no-poster"/);
assert.match(findCard,/class="film-similar-badge is-new"/);
assert.equal(fetches.length,0,'a poster already on the film is not fetched again');
assert.doesNotMatch(app.slice(app.indexOf('function similarPoster'),app.indexOf('function similarScoreBadges')),/fetch\(|image\.tmdb\.org\/t\/p\//,'the card does not invent a poster URL');

console.log('Similar films: eligibility, ranking, limits, franchise, identity, catalog and watchlist, freshness, links, focus and no fetch passed');
