import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';

// AIR-435 (ADR 0114): Finds, the lists and the film page read the film availability lifecycle through the shared module. A ready archive always wins over a
// repeat; a film with no archive that is on air or ahead is «Скоро» and gets one hourglass in the corner of the poster; the badge and the text follow the clock.
const now=Date.UTC(2026,5,15,10,0,0),hour=3600000,min=60000;
const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/styles.css','utf8'),app=fs.readFileSync('public/app.js','utf8');
assert.ok(html.indexOf('/film-availability.js')>0&&html.indexOf('/film-availability.js')<html.indexOf('/app.js'),'the shared module loads before app.js');

const node=()=>({hidden:true,textContent:'',innerHTML:''});
const nodes={'#finds':node(),'#finds-cards':node(),'#finds-caption':node(),'#finds-title':{...node(),textContent:'Находки'},'#watchlist-title':node(),'#empty':node(),'#film-poster':node()};
const ui=vm.createContext({Date,Intl,Set,Map,console,document:{querySelector:selector=>nodes[selector]||null,querySelectorAll:()=>[]}});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ui);
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
vm.runInContext(`viewClock=${now};report={runId:'G1',films:[],window:{from:${now-72*hour},to:${now+24*hour}},cutoff:${now}};`,ui);
ui.now=now;

const show=(startOffsetHours,channel='Один',length=2,extra={})=>({channelId:channel,channel,start:now+startOffsetHours*hour,end:now+(startOffsetHours+length)*hour,...extra});
const film=(id,tmdb,title,shows,extra={})=>({id,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title,original:title,year:2020,runtime:extra.runtime===undefined?100:extra.runtime,genres:['Драма'],poster:extra.poster===undefined?'https://image.tmdb.org/t/p/w342/'+id+'.jpg':extra.poster,url:'https://www.themoviedb.org/movie/'+tmdb,directors:[],actors:[],shows,prediction:{predictedRating:4.5,probability4Plus:.8,confidence:'high',matchSignals:[],mainRisk:null,moodIds:[]},fingerprint:null});
const run=(expression,input)=>{ui.input=input;return vm.runInContext(expression,ui);};
const ids=list=>Array.from(list).map(item=>item.id);
const scope=(channels=[],period='all')=>vm.runInContext(`state.channels=new Set(${JSON.stringify(channels)});state.period=${JSON.stringify(period)};`,ui);
const clock=value=>vm.runInContext(`viewClock=${value}`,ui);
const badges=markup=>(markup.match(/class="soon-badge"/g)||[]).length;
scope();

const archiveRepeat=film('tmdb_1',1,'Архив и повтор',[show(-5),show(2,'Два')]);                  // ended 3 h ago, repeat in 2 h
const futureOnly=film('tmdb_2',2,'Только будущее',[show(5,'Два')]);
const onAirOnly=film('tmdb_3',3,'Идёт сейчас',[show(-0.5)]);                                       // started 30 min ago, ends in 90 min
const noEndRuntime=film('tmdb_4',4,'Без конца, длительность есть',[{channelId:'c',channel:'Три',start:now-30*min}],{runtime:100});
const noEndNoRuntime=film('tmdb_5',5,'Без конца и длительности',[{channelId:'c',channel:'Три',start:now+3*hour}],{runtime:null});
const startedNoEnd=film('tmdb_6',6,'Начался, конца нет',[{channelId:'c',channel:'Три',start:now-hour}],{runtime:null});
const catalog=[archiveRepeat,futureOnly,onAirOnly,noEndRuntime,noEndNoRuntime,startedNoEnd];

// 1. Archive plus a future repeat: «Архив», never «Скоро», no hourglass.
let airing=run('findsAiring(input,now)',archiveRepeat);
assert.equal(airing.kind,'catchup');assert.match(airing.text,/^Архив · Один · до /,'the repeat is not named, the archive is');assert.equal(airing.availability.state,'available');
assert.doesNotMatch(run('findsCard(input,now)',archiveRepeat),/soon-badge/,'no hourglass for a film with a ready archive');
// 2. Future only: «Скоро» with the expected archive time from the END of the show, and one hourglass.
airing=run('findsAiring(input,now)',futureOnly);
assert.equal(airing.kind,'next');assert.equal(airing.availability.state,'soon');assert.match(airing.text,/ · Два · архив появится после /);
assert.equal(airing.availability.appearsAt,now+7*hour,'ready at the end of the show, not at its start');
assert.equal(badges(run('findsCard(input,now)',futureOnly)),1,'exactly one hourglass on the find (no double render)');
// 3. Ongoing only: still «Скоро» until the end.
airing=run('findsAiring(input,now)',onAirOnly);
assert.equal(airing.kind,'live');assert.match(airing.text,/^Сейчас в эфире · Один · архив появится после /);assert.equal(airing.availability.appearsAt,now+90*min);
assert.equal(badges(run('findsCard(input,now)',onAirOnly)),1);
// 4. No EPG end but a film runtime: the end is start + runtime, said honestly as an estimate.
airing=run('findsAiring(input,now)',noEndRuntime);
assert.equal(airing.kind,'live');assert.equal(airing.availability.appearsAt,now-30*min+100*min);assert.match(airing.text,/архив ожидается около .* \(по длительности фильма\)/);
// 5. No end and no runtime: the hour is unknown and nothing is invented; a started show with neither is not a find at all.
airing=run('findsAiring(input,now)',noEndNoRuntime);
assert.equal(airing.kind,'next');assert.match(airing.text,/время появления архива неизвестно$/);assert.equal(airing.availability.appearsAt,null);
assert.equal(run('findsAiring(input,now).kind',startedNoEnd),'none','a started show with no determinable end is neither an archive nor a promise');
assert.deepEqual(ids(run('buildFinds(input,now)',catalog)).sort(),['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5'],'the started show with no end is not offered');

// 6. Dynamic expiration with no new data: the same film is soon, then available the moment the show ends, then gone 72 h after its start.
const single=film('tmdb_9',9,'Часы',[show(-0.5)]);
const at=offsetMs=>{clock(now+offsetMs);return run('findsAiring(input,viewClock)',single);};
assert.equal(at(0).availability.state,'soon');assert.equal(at(90*min-1).availability.state,'soon','a millisecond before the end');
assert.equal(at(90*min).availability.state,'available','exactly at the end, with no delay');assert.equal(at(90*min).kind,'catchup');
assert.equal(at(90*min).availability.archiveUntil,now-30*min+72*hour);
assert.equal(at(72*hour-30*min-1).availability.state,'available');assert.equal(at(72*hour-30*min).availability.state,'unavailable','72 h elapsed from the start');
assert.equal(badges(run('soonBadge(input,{now:viewClock})',single)),0,'no hourglass once unavailable');clock(now+90*min);assert.equal(badges(run('soonBadge(input,{now:viewClock})',single)),0,'no hourglass once the archive exists');
clock(now);assert.equal(badges(run('soonBadge(input,{now:viewClock})',single)),1);

// 7. The period filter is archive-first: «Скоро» (period future) never returns a film with a ready archive, «Архив» never returns a soon film.
scope([],'future');assert.deepEqual(ids(run('buildFinds(input,now)',catalog)).sort(),['tmdb_2','tmdb_3','tmdb_4','tmdb_5'],'archive plus repeat is not «Скоро»');
scope([],'archive');assert.deepEqual(ids(run('buildFinds(input,now)',catalog)),['tmdb_1']);
scope([],'all');assert.deepEqual(ids(run('buildFinds(input,now)',catalog)).sort(),['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5']);
// 8. Channel filter: an archive on another channel is not an archive here; a repeat on the selected channel does not hide the archive.
scope(['Два'],'all');assert.equal(run('findsAiring(input,now)',archiveRepeat).kind,'next','on channel Два the film is only a repeat ahead: «Скоро»');
assert.equal(badges(run('findsCard(input,now)',archiveRepeat)),1);
scope(['Один'],'all');assert.equal(run('findsAiring(input,now)',archiveRepeat).kind,'catchup');assert.equal(badges(run('findsCard(input,now)',archiveRepeat)),0);
scope();

// 9. Ranking: on equal predictions a ready archive comes before a soon film; ties are otherwise unchanged.
assert.equal(ids(run('buildFinds(input,now)',[futureOnly,archiveRepeat,onAirOnly]))[0],'tmdb_1','the ready archive is first on equal predictions');

// 10. The shared badge on every poster surface: one helper, one selector, accessible text, and it works without a poster.
const label=m=>m.match(/aria-label="([^"]+)"/)[1];
const soonMarkup=run('soonBadge(input)',futureOnly);
assert.match(soonMarkup,/^<span class="soon-badge" role="img" aria-label="Скоро: архив появится после [^"]+" title="Скоро: архив появится после [^"]+"><svg [^>]*aria-hidden="true">/);
assert.equal(run('soonBadge(input)',archiveRepeat),'','no badge for a film with a ready archive, even with a future repeat');
assert.equal(run('soonBadge(input)',noEndNoRuntime).includes('время появления архива неизвестно'),true);
assert.equal(label(run('soonBadge(input)',noEndRuntime)).includes('по длительности фильма'),true);
assert.equal(run('posterFrame("<img>","")',null),'<img>','no badge: the poster markup is untouched');
assert.equal(run('posterFrame("<img>","<b></b>")',null),'<div class="poster-frame"><b></b><img></div>');
const noPoster=film('tmdb_7',7,'Без постера',[show(5)],{poster:null});
assert.equal(badges(run('findsCard(input,now)',noPoster)),1,'a find without a poster keeps the badge');assert.match(run('findsCard(input,now)',noPoster),/class="poster no-poster"/);
assert.equal(run('filmPosterHTML(input)',futureOnly).includes('class="soon-badge"'),true,'the film page poster carries the same badge');
assert.equal(run('filmPosterHTML(input)',archiveRepeat).includes('soon-badge'),false);
assert.equal(run('filmPosterHTML(input)',noPoster).includes('film-page-poster no-poster'),true);
const similar=run('similarCard({film:input,source:"catalog",theme:null,prediction:{rating:4.5,probability:.8},options:{},badge:"new"},now)',futureOnly);
assert.equal(badges(similar),1,'the similar card shows it once');
assert.equal(badges(run('similarCard({film:input,source:"catalog",theme:null,prediction:{rating:4.5,probability:.8},options:{},badge:"new"},now)',archiveRepeat)),0);
assert.equal(badges(run('card(input)',{...futureOnly,offset:0,shows:futureOnly.shows,runtime:100,genres:['Драма'],original:'x',year:2020})||''),1,'a list card carries it once');

// 11. CSS contract: the badge sits in a positioned poster container in the opposite corner from NEW, is not interactive, and does not reuse NEW or last chance.
assert.match(css,/\.poster-frame\{position:relative;flex:none\}/);
assert.match(css,/\.soon-badge\{position:absolute;top:-6px;right:-6px;z-index:1;/);
assert.match(css,/#film-poster\{position:relative;/);
assert.doesNotMatch(css,/\.soon-badge[^{]*\{[^}]*(?:cursor:pointer|pointer-events)/,'purely informative');
assert.equal(app.split('class="soon-badge"').length-1,1,'one place writes the badge markup');

// 12. The clock re-renders with no request: soonBadge notes the moment the archive appears, armed after render, and a fixed view clock arms nothing.
assert.match(app,/function armSoonTick\(\)/);assert.match(app,/render\(\);refreshFilmPoster\(\);/);
assert.equal(vm.runInContext('soonTickAt',ui)!==undefined,true);
console.log('Finds availability: archive first, soon only without a ready archive, expected archive time from the effective end, dynamic expiry, archive-first period filter, channel scope, ranking and one shared accessible poster badge on every surface passed');
