import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import {scoped as scopedAvailability} from '../scripts/bundle-scope.mjs';
const AVAILABILITY_LIB=scopedAvailability('src/domain/film-availability.js','FilmAvailability')+'\n';
const ctx=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams});vm.runInContext(AVAILABILITY_LIB+fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
const now=Date.parse('2026-10-15T12:00:00+02:00'),hour=3600000;
const f=(id,rating,runtime=110,start=now-hour,extra={})=>({id,tmdbId:id,title:id,original:id,year:2020,runtime,genres:['Драма'],actors:[],directors:[],shows:start===null?[]:[{start,end:start+hour,offset:(start-now)/hour,channel:'Канал'}],availableUntil:start===null?null:new Date(start+72*hour).toISOString(),...extra});
ctx.now=now;const initialize=(sample,ratings,started=[])=>{ctx.sample=sample;ctx.ratings=ratings;ctx.started=started;vm.runInContext('films=sample;enrichment={films:ratings};startedIds=new Set(started);ratingsLoaded=true;WINDOW_START=now-72*3600000;CUTOFF=now;viewClock=now;WINDOW_END=now+24*3600000;MAX_YEAR=2027;Object.assign(state,{period:"all",viewing:"any",sort:"title",query:"",genres:new Set(),mechanics:new Set(),moods:new Set(),maxRuntime:null,from:1900,to:2027,includeUnscheduled:false,startedOnly:false,lastChanceOnly:false,minPrediction:null,minProbability:null,directors:"",actors:"",shortlistMode:"available"})',ctx)};
const result=(mode='available')=>JSON.parse(vm.runInContext('JSON.stringify(buildShortlist(visibleFilms(),'+JSON.stringify(mode)+',now))',ctx));
const pred=(rating,probability=.7)=>({prediction:{predictedRating:rating,probability4Plus:probability}});
initialize([f('best',4.5,80),f('urgent',4,90,now-71*hour),f('started',4,130),f('rewatch',4,95),f('rewatch2',3.5,105),f('unknown',null,50)],{best:pred(4.5),urgent:pred(4),started:pred(4),rewatch:{actualRating:4},rewatch2:{actualRating:3.5}},['started']);
let rows=result();assert(rows.length>=3&&rows.length<=5);assert.equal(new Set(rows.map(x=>x.film.id)).size,rows.length);assert(rows.some(x=>x.film.id==='urgent'&&x.reasons.includes('последний шанс')));assert(rows.some(x=>x.film.id==='started'&&x.reasons.includes('продолжить')));assert(rows.some(x=>x.reasons.includes('сильный пересмотр')));assert(!rows.some(x=>x.film.id==='unknown'));
vm.runInContext('state.query="urgent";state.genres=new Set(["Драма"]);state.maxRuntime=100',ctx);assert.deepEqual(result().map(x=>x.film.id),['urgent']);vm.runInContext('state.genres=new Set(["Комедия"])',ctx);assert.equal(result().length,0,'hard genre constraints cannot be relaxed');
// Multiple roles share a winner, but later role finds next qualified candidate.
initialize([f('a',4.5,75,now-71*hour),f('b',4,80,now-70*hour),f('c',2,200)],{a:pred(4.5),b:pred(4),c:pred(2)},['a','b']);rows=result();assert.equal(rows.filter(x=>x.film.id==='a').length,1);assert(rows.find(x=>x.film.id==='a').reasons.includes('последний шанс'));assert(rows.some(x=>x.film.id==='b'),'fallback preserves distinct appropriate candidate');assert(!rows.some(x=>x.film.id==='c'),'no low-score filler');assert(rows.every(x=>x.reasons.length<=2));
// AIR-434: «Доступно» and «Скоро» are disjoint sets of FILMS from the one lifecycle. A show on air is no archive until it ends; archive beats a future repeat.
const tomorrow=now+24*hour,sh=(start,end=start+hour,channel='Канал')=>({start,end,offset:(start-now)/hour,channel});
const ids=rows=>rows.map(x=>x.film.id).sort();
const pool=()=>[f('cold',5,80,now-80*hour),f('none',5,80,null),f('live',4.2,100,now-.1*hour),f('future',4.1,100,now+.1*hour),f('tomorrow',5,90,tomorrow),f('archive',4.3,100,now-5*hour),
 f('repeat',4.4,100,now-5*hour,{shows:[sh(now-5*hour),sh(now+2*hour,now+3*hour,'Второй')]})];
const ratings=Object.fromEntries(['cold','none','live','future','tomorrow','archive','repeat'].map(id=>[id,pred(4.5)]));
initialize(pool(),ratings);
assert.deepEqual(ids(result('available')),['archive','repeat'],'a ready archive, with or without a future repeat; on air, future, cold and tomorrow are not archive');
assert.deepEqual(ids(result('soon')),['future','live'],'soon: on air or inside the next 24 h, no ready archive; the repeat of an archive film never makes it soon; exactly 24 h ahead is outside');
assert.equal(ids(result('available')).filter(id=>ids(result('soon')).includes(id)).length,0,'the two sets never intersect');
for(const mode of ['available','soon'])assert(!result(mode).some(x=>['none','cold','tomorrow'].includes(x.film.id)),'an unscheduled, expired or too-far film is in neither set');
vm.runInContext('state.includeUnscheduled=true',ctx);assert(!result('soon').some(x=>x.film.id==='none')&&!result('available').some(x=>x.film.id==='none'),'«включить без показа» never fills a shortlist');vm.runInContext('state.includeUnscheduled=false',ctx);
// Fewer than five soon candidates: no archive film fills the gap, and an empty soon set is empty.
assert.equal(result('soon').length,2);initialize([f('archive',4.3,100,now-5*hour)],{archive:pred(4.5)});assert.equal(result('soon').length,0,'no automatic substitution of archive films');
// The text and the role use the shared wording; «последний шанс» exists only for an archive.
initialize([f('urgent',4,90,now-71*hour),f('live',4.2,100,now-.1*hour),f('future',4.1,100,now+2*hour)],{urgent:pred(4.5),live:pred(4.5),future:pred(4.5)});
const text=(film,mode)=>{ctx.film=vm.runInContext('sample',ctx).find(x=>x.id===film);ctx.mode=mode;return vm.runInContext('(a=>a?shortlistAvailabilityText({availability:a}):"Нет показов в текущем окне")(shortlistAvailability(film,mode,now))',ctx);};
assert.match(text('urgent','available'),/^Архив · Канал · до /);assert.match(text('live','soon'),/^Сейчас в эфире · Канал · архив появится после /);assert.match(text('future','soon'),/ · Канал · архив появится после /);
assert(result('available').find(x=>x.film.id==='urgent').reasons.includes('последний шанс'));assert(!result('soon').some(x=>x.role==='last_chance'||x.reasons.includes('последний шанс')),'soon is never a last chance');
assert.equal(vm.runInContext('shortlistAvailability(sample[0],"soon",now)',ctx),null,'an archive film has no soon entry');
// The archive appears at the END of the show, with no reload: on air → soon, one minute after its end → available.
initialize([f('timed',4,100,now-.5*hour,{shows:[sh(now-.5*hour,now+.5*hour)]})],{timed:pred(4.5)});
assert.deepEqual([ids(result('soon')),ids(result('available'))],[['timed'],[]]);
for(const [at,soon,available] of [[now+.5*hour-1,1,0],[now+.5*hour,0,1],[now-.5*hour+72*hour-1,0,1],[now-.5*hour+72*hour,0,0]]){ctx.at=at;vm.runInContext('viewClock=at',ctx);const mode=m=>JSON.parse(vm.runInContext('JSON.stringify(buildShortlist(visibleFilms(),"'+m+'",at))',ctx)).length;assert.deepEqual([mode('soon'),mode('available')],[soon,available],'clock '+(at-now));}
vm.runInContext('viewClock=now',ctx);
// A show with no EPG end uses the film runtime; with neither the hour stays unknown and nothing is promised.
initialize([f('rt',4,100,null,{shows:[{start:now-.5*hour,offset:-.5,channel:'К'}]}),f('unk',4,null,null,{runtime:null,shows:[{start:now+3*hour,offset:3,channel:'К'}]})],{rt:pred(4.5),unk:pred(4.5)});
assert.deepEqual(['rt','unk'].filter(id=>text(id,'soon')!=='Нет показов в текущем окне'),['rt','unk']);assert.match(text('rt','soon'),/архив ожидается около .* \(по длительности фильма\)/);assert.match(text('unk','soon'),/время появления архива неизвестно$/);
// The window is elapsed time: 23:57 Madrid, a show 2 and 6 minutes later are both «Скоро» (no calendar-day cut-off); exactly 24 h ahead is not.
const late = Date.parse('2026-10-20T23:57:00+02:00');ctx.late=late;
initialize([f('two',4,100,null,{shows:[sh(late+2*60000)]}),f('six',4,100,null,{shows:[sh(late+6*60000)]}),f('edge',4,100,null,{shows:[sh(late+24*hour)]}),f('inside',4,100,null,{shows:[sh(late+24*hour-1)]})],{two:pred(4.5),six:pred(4.5),edge:pred(4.5),inside:pred(4.5)});
vm.runInContext('CUTOFF=late;viewClock=late;WINDOW_START=late-72*3600000;WINDOW_END=late+48*3600000',ctx);
assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(sample.filter(film=>shortlistAvailability(film,"soon",late)).map(film=>film.id).sort())',ctx)),['inside','six','two']);
vm.runInContext('viewClock=now;CUTOFF=now;WINDOW_START=now-72*3600000;WINDOW_END=now+24*3600000',ctx);
// The shortlist follows the main period filter: the selected period constrains the same films.
initialize(pool(),ratings);vm.runInContext('state.period="archive"',ctx);assert.equal(result('soon').length,0,'period «Архив» leaves no soon film for the shortlist');assert.deepEqual(ids(result('available')),['archive','repeat']);
vm.runInContext('state.period="soon"',ctx);assert.equal(result('available').length,0,'period «Скоро» leaves no archive film for the shortlist');assert.deepEqual(ids(result('soon')),['future','live']);
// Counts and cards: the three period sets are archive + soon = all, with an empty intersection.
const set=p=>vm.runInContext('films.filter(film=>periodShows(film,"'+p+'").length).map(film=>film.id).sort()',ctx);
vm.runInContext('state.period="all"',ctx);assert.deepEqual(set('archive').filter(id=>set('soon').includes(id)),[]);assert.deepEqual([...set('archive'),...set('soon')].sort(),set('all'));
assert.deepEqual(set('future'),set('soon'),'the old period name is an alias of «Скоро»');
// Actual wins over prediction for score, and remains explicitly a rewatch.
initialize([f('a',null),f('b',null),f('c',null)],{a:{actualRating:3,prediction:{predictedRating:5,probability4Plus:.99}},b:pred(4,.7),c:pred(4,.9)});rows=result();assert.equal(rows[0].film.id,'c','predicted-only tie breaks by probability');assert.equal(vm.runInContext('personal(sample[0]).rating',ctx),3);assert(!rows.some(x=>x.film.id==='a'),'weak actual must not be presented as a strong new prediction');
initialize([f('actual',null)],{actual:{actualRating:4,prediction:{predictedRating:2,probability4Plus:.1}}});rows=result();assert.equal(rows[0].score.rating,4);assert.deepEqual(rows[0].reasons,['сильный пересмотр','короткий вариант']);
// No padding when only one valid score is available; empty is safe.
initialize([f('one',null),f('missing',null)],{one:pred(3)});assert.equal(result().length,1);initialize([f('missing',null)],{});assert.equal(result().length,0);initialize([],{});assert.equal(result().length,0);
// Canonical identity dedup and selected period are also hard constraints.
initialize([f('alias1',null,100,now-hour,{tmdbId:100}),f('alias2',null,90,now-hour,{tmdbId:100})],{alias1:pred(4),alias2:pred(4.5)});assert.equal(result().length,1);assert.equal(result()[0].film.id,'alias2');vm.runInContext('state.period="soon"',ctx);assert.equal(result().length,0);
// Full filter set, not just search/genre, is inherited from eligible().
initialize([f('a',null,85),f('b',null,95)],{a:{...pred(4.5),moodIds:['dark'],fingerprint:{plotMechanics:['heist']}},b:{...pred(4),moodIds:['light'],fingerprint:{plotMechanics:['rescue']}}});vm.runInContext('state.mechanics=new Set(["heist"]);state.moods=new Set(["dark"]);state.minPrediction=4.5;state.minProbability=.7',ctx);assert.deepEqual(result().map(x=>x.film.id),['a']);vm.runInContext('state.startedOnly=true',ctx);assert.equal(result().length,0);
// Deep links: `shortlist=soon` and `period=soon` round-trip; the old `shortlist=today|now` and `period=future` values are normalised, never rejected.
vm.runInContext('Object.assign(state,{shortlistMode:"available",period:"all"})',ctx);assert.equal(vm.runInContext('urlForState(new URL("https://example.test/")).searchParams.has("shortlist")',ctx),false,'the default is not serialised');
vm.runInContext('state.shortlistMode="soon";state.period="soon"',ctx);const url=vm.runInContext('urlForState(new URL("https://example.test/?campaign=keep"))',ctx);assert.equal(url.searchParams.get('shortlist'),'soon');assert.equal(url.searchParams.get('period'),'soon');assert.equal(url.searchParams.get('campaign'),'keep');ctx.link=url;assert.equal(vm.runInContext('readUrlState(link).shortlistMode',ctx),'soon');assert.equal(vm.runInContext('readUrlState(link).period',ctx),'soon');
const read=(query,key)=>{ctx.query='https://example.test/?'+query;return vm.runInContext('readUrlState(new URL(query)).'+key,ctx);};
assert.equal(read('shortlist=today','shortlistMode'),'soon','old today');assert.equal(read('shortlist=now','shortlistMode'),'available','old now');assert.equal(read('shortlist=bad','shortlistMode'),'available');assert.equal(read('period=future','period'),'soon','old future');assert.equal(read('period=archive','period'),'archive');assert.equal(read('period=bad','period'),'all');
// A preset saved with the old values is the same preset as the new one (the key is canonical).
assert.equal(vm.runInContext('presetKey("shortlist=today&period=future")===presetKey("period=soon&shortlist=soon")',ctx),true);
console.log('Shortlist: hard constraints, live/catch-up/future/cold availability, distinct role fallback, no filler, started/urgency, actual/predicted score, partial coverage, empty, canonical identity and URL mode passed');
