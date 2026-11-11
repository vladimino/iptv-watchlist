import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';

// AIR-436 (ADR 0114): the film page «Показы» block. The film state and every show phase come from the shared lifecycle; one show is one compact line with no
// counter and no nearest panel; an archive is listed above live and future; a repeat never turns a ready archive into «Скоро»; the expected archive time is a
// schedule-based calculation; «Последний шанс» is only for a ready archive; an unknown end promises no hour.
const hour=3600000,min=60000;
const app=fs.readFileSync('public/app.js','utf8'),css=fs.readFileSync('public/styles.css','utf8');
const nodes=new Map(),node=()=>({hidden:false,textContent:'',innerHTML:''});
const ui=vm.createContext({Date,Intl,Set,Map,console,document:{querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);},querySelectorAll:()=>[]}});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ui);
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
const at=(iso)=>{const now=Date.parse(iso);vm.runInContext(`viewClock=${now};report={runId:'G1',films:[],window:{from:${now-72*hour},to:${now+24*hour}},cutoff:${now}};`,ui);return now;};
let now=at('2026-06-15T10:00:00Z');
const show=(offsetHours,channel='Один',length=2,extra={})=>({channel,start:now+offsetHours*hour,end:now+(offsetHours+length)*hour,...extra});
const film=(shows,extra={})=>({id:'f1',title:'Фильм',original:'Film',year:2020,runtime:100,genres:[],directors:[],actors:[],poster:null,shows,...extra});
const block=f=>{ui.f=f;return vm.runInContext('filmAvailability(f)',ui);};
const count=(html,re)=>(html.match(re)||[]).length;
const rows=html=>count(html,/class="show-row/g),channels=(html,name)=>count(html,new RegExp(`data-channel="${name}"`,'g'));
const state=html=>(html.match(/data-availability="(\w+)"/)||[])[1];

// ---- one show: one compact line, no counter, no nearest panel, no repeated date ----
const single=block(film([show(-5)]));
assert.equal(state(single),'available');
assert.equal(rows(single),1);
assert.equal(channels(single,'Один'),1,'the channel appears once');
assert.equal(count(single,/datetime="/g),2,'the show time once, plus the archive deadline in the head: no pair of identical dates');
assert.doesNotMatch(single,/Осталось показов|Ближайший показ|Следующий показ|Сейчас в эфире|film-callouts|film-nearest|film-show-group/,'no counter, no nearest panel, no group header for one show');
assert.match(single,/Архив доступен до/);
assert.match(single,/>Доступно<\/span>/);
const until=new Date(now-5*hour+72*hour);
assert.ok(single.includes(`datetime="${until.toISOString()}"`),'the deadline is 72 h from the show START, not its end');

// ---- last chance only for a ready archive ----
const last=block(film([show(-69.5,'Один',2)]));                       // starts 69.5 h ago, archive until in 2.5 h
assert.match(last,/Последний шанс/);
assert.doesNotMatch(block(film([show(-5)])),/Последний шанс/);
const repeatNear=block(film([show(-69.5,'Один',2),show(1,'Два')]));   // a repeat does not extend the deadline and is not the deadline
assert.match(repeatNear,/Последний шанс/);
assert.ok(repeatNear.includes(`datetime="${new Date(now-69.5*hour+72*hour).toISOString()}"`),'a repeat never extends the archive deadline');
assert.doesNotMatch(block(film([show(3)])),/Последний шанс/,'a future-only film has no last chance');
assert.doesNotMatch(block(film([show(-1,'Один',3)])),/Последний шанс/,'a show on air is not a ready archive');

// ---- archive plus future repeat: archive first, still available, the repeat folded ----
const both=block(film([show(2,'Два'),show(-6,'Один'),show(20,'Три')]));
assert.equal(state(both),'available');
assert.doesNotMatch(both,/Скоро/);
assert.ok(both.indexOf('is-archive')<both.indexOf('is-future'),'the archive group is above the repeat');
assert.match(both,/Повтор в эфире/);
assert.match(both,/<details class="more"><summary>Ещё 1 показ<\/summary>/,'long repeats fold');
assert.equal(rows(both),3);

// ---- soon: future only, and a show on air ----
const soon=block(film([show(5,'Два',2)]));
assert.equal(state(soon),'soon');
assert.match(soon,/>Скоро<\/span>/);
assert.match(soon,/Архив появится после/);
assert.match(soon,/не проверяется/,'a schedule-based calculation, not a provider check');
assert.doesNotMatch(soon,/Архив доступен до/);
assert.doesNotMatch(soon,/film-show-group/,'one show has no group header');
const live=block(film([show(-1,'Эфир',3),show(10,'Повтор')]));
assert.equal(state(live),'soon');
assert.match(live,/В эфире до /);
assert.match(live,/is-on-air/);
assert.doesNotMatch(live,/Архив доступен до/,'a live show is not an archive');
assert.ok(live.indexOf('В эфире')<live.indexOf('Дальше'));
// ongoing -> available at the effective end, with no reload
const ongoing=film([show(-1,'Эфир',2)]);
assert.equal(state(block(ongoing)),'soon');
now=at('2026-06-15T11:00:00Z');                                         // exactly the end
ongoing.shows=[{channel:'Эфир',start:now-3*hour,end:now}];
assert.equal(state(block(ongoing)),'available');
now=at('2026-06-15T10:59:59Z');
assert.equal(state(block(ongoing)),'soon','one second before the end the show is still on air');

// ---- unknown end, runtime fallback, no runtime ----
now=at('2026-06-15T10:00:00Z');
const noEnd=(offset,extra)=>film([{channel:'Один',start:now+offset*hour}],extra);
const estimated=block(noEnd(2,{runtime:90}));
assert.equal(state(estimated),'soon');
assert.match(estimated,/по длительности фильма/,'an estimated end says so');
const unknownFuture=block(noEnd(2,{runtime:undefined}));
assert.equal(state(unknownFuture),'soon');
assert.match(unknownFuture,/время появления архива неизвестно/i,'an unknown end promises no hour');
const unknownStarted=block(noEnd(-1,{runtime:undefined}));
assert.equal(state(unknownStarted),'unavailable','a started show with no end is neither archive nor promised');
assert.match(unknownStarted,/data-phase="unknown"/);
assert.match(unknownStarted,/Окончание неизвестно/);
assert.doesNotMatch(unknownStarted,/Архив доступен до|Архив появится/);
assert.equal(state(block(noEnd(-1,{runtime:60}))),'available','the film runtime closes a started show with no end');
assert.equal(state(block(noEnd(-1,{runtime:300}))),'soon','a runtime longer than the elapsed time is still on air');

// ---- no shows, stale EPG, catalog-only ----
const none=block(film([]));
assert.equal(state(none),'unavailable');
assert.match(none,/Нет показов в текущем окне программы/);
assert.doesNotMatch(none,/film-show-list|Осталось показов/);
const stale=film([show(-100,'Старый',2)]);
const staleHtml=block(stale);
assert.equal(state(staleHtml),'unavailable','a recording older than 72 h from its start is gone');
assert.doesNotMatch(staleHtml,/data-channel="Старый"/,'a show outside the programme window is not listed');
const edge=block(film([show(-72,'Граница',2)]));
assert.equal(state(edge),'unavailable','at exactly start + 72 h the recording is gone');
assert.equal(state(block(film([show(-71.99,'Граница',2)]))),'available');
const catalogOnly=block(film([show(-30,'Ночной')],{catalogRoute:true,id:'tmdb_9'}));
assert.equal(state(catalogOnly),'available');
assert.equal(rows(catalogOnly),1);

// ---- the rolling 24 hours, 23:50 Madrid ----
now=at('2026-06-15T21:50:00Z');                                         // 23:50 Madrid
assert.equal(state(block(film([{channel:'Один',start:now+30*min,end:now+150*min}]))),'soon','a show after midnight is inside the rolling 24 h');
assert.equal(state(block(film([{channel:'Один',start:now+24*hour,end:now+26*hour}]))),'unavailable','exactly 24 h ahead is outside');

// ---- many shows fold, one group keeps its order ----
now=at('2026-06-15T10:00:00Z');
const many=block(film([show(-60,'A'),show(-50,'B'),show(-40,'C'),show(-30,'D'),show(-20,'E')]));
assert.equal(rows(many),5);
assert.match(many,/<summary>Ещё 2 показа<\/summary>/);
assert.match(many,/архив до /,'several archive rows each name their own deadline');
const stamps=[...many.matchAll(/class="show-time" datetime="([^"]+)"/g)].map(match=>match[1]);
assert.deepEqual(stamps,[...stamps].sort(),'start order inside a group');

// ---- reuse of the shared poster mark, no second hourglass, a live refresh ----
assert.doesNotMatch(app,/function nearestAvailable|function filmNowLine|film-callouts/,'the nearest panel code is gone');
assert.equal(count(app,/class="soon-badge"/g),1,'the one hourglass is drawn only by soonBadge');
for(const html of [single,soon,live,both])assert.doesNotMatch(html,/soon-badge|hourglass/,'the block draws no hourglass of its own');
assert.match(app,/refreshFilmPoster\(\);refreshFilmAvailability\(\)/,'the shared tick refreshes the block too');
assert.doesNotMatch(css,/\.film-callouts|\.film-nearest|\.is-nearest/);
assert.match(css,/\.film-avail-pill\.is-soon/);

// ---- the page does not request anything to render ----
assert.doesNotMatch(app.slice(app.indexOf('function filmAvailability(film)'),app.indexOf('function refreshFilmAvailability')),/fetch\(/);
console.log('Film show layout: one compact line for one show, archive above live and future, soon only without an archive, last chance only for a ready archive, effective end and unknown end, no shows, stale EPG, catalog-only, 23:50 Madrid and the clock-driven transition passed');
