import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const listeners={document:new Map(),window:new Map()};
function add(map,type,fn){const list=map.get(type)||[];list.push(fn);map.set(type,list);}
function remove(map,type,fn){map.set(type,(map.get(type)||[]).filter(item=>item!==fn));}
const nodes=new Map();
function el(selector){
 if(!nodes.has(selector))nodes.set(selector,{selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,scrollTop:0,dataset:{},style:{},classList:{toggle(){},add(){},remove(){}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},addEventListener(){},removeEventListener(){},focus(){},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(sel){return el(selector+' '+sel);},querySelectorAll(){return [];}});
 return nodes.get(selector);
}
const document={
 hidden:false,
 addEventListener(type,fn){add(listeners.document,type,fn);},
 removeEventListener(type,fn){remove(listeners.document,type,fn);},
 querySelector(selector){return el(selector);},
 querySelectorAll(){return [];},
};
const window={
 scrollY:0,
 scrollTo(x,y){window.scrollY=y;scrolls.push(y);},
 addEventListener(type,fn){add(listeners.window,type,fn);},
 removeEventListener(type,fn){remove(listeners.window,type,fn);},
 location:{href:'https://iptv.example/'},
 history:{state:null,replaceState(_state,_title,url){window.location.href=new URL(url,window.location.href).href;}},
};
let timer=null,inFlight=0,maxInFlight=0,programmeVersion=1;
const calls=[],pending=[],scrolls=[];
const failed=new Set();
const startedIds=['keep'];
let events=[{id:'e1',type:'epg',at:'2026-10-18T10:00:00Z',films:1,archive:0,future:1,broadcasts:1}];
let footer={profile:null,coverage:{currentPredictionsTotal:1,confirmedFilmsTotal:2,windowCurrentPredictions:1,windowFilmsTotal:2,cacheOffWindowTotal:0,pendingOffWindowTotal:0},predictions:{pendingHot:0,pendingCold:0,pendingOffWindow:0,currentBatch:null,nextBatchSize:0,nextScheduledRun:'2026-10-18T18:00:00Z'},epgTmdb:{},watchlist:{films:1},lastRun:null};
const enrichment={profile:null,films:{}};
function programme(version){
 const year=version===3?2031:version===2?2030:2020;
 return {updatedAt:version===1?'2026-10-18T12:00:00Z':'2026-10-18T13:00:00Z',window:{from:Date.parse('2026-10-15T12:00:00Z'),to:Date.parse('2026-10-19T12:00:00Z')},films:[{id:'film-1',title:version===1?'Первый':'Второй',original:'First',year,runtime:100,genres:['Драма'],shows:[]}],people:{directors:[{id:'d1',name:'Нолан',original:'Nolan'}],actors:[]}};
}
function payload(url){
 if(url==='/api/programme')return programme(programmeVersion);
 if(url==='/api/events')return {events,cursor:null};
 if(url==='/api/started')return {ids:[...startedIds]};
 if(url==='/api/enrichment/view')return enrichment;
 if(url==='/api/enrichment/footer/status')return footer;
 if(url==='/api/catalog/available')return {programmeRunId:'run',pinned:true,films:[]};
 throw new Error('unexpected '+url);
}
const context=vm.createContext({
 Date,Intl,URL,Set,Map,Promise,console,document,window,
 setInterval(fn,ms){timer={fn,ms};return 1;},
 clearInterval(){timer=null;},
 fetch(url){
  const path=String(url);
  calls.push(path);
  inFlight++;
  maxInFlight=Math.max(maxInFlight,inFlight);
  return new Promise(resolve=>pending.push(()=>{
   inFlight--;
   resolve({ok:!failed.has(path),status:failed.has(path)?503:200,json:async()=>payload(path)});
  }));
 },
});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
const run=code=>vm.runInContext(code,context);
// The fixture archive closes 72 hours after 2026-10-19T12:00:00Z. Later than that, the black zone shows films with no broadcasts, and the search below changes the grid.
run('viewClock=Date.parse("2026-10-18T12:00:00Z")');
let paints=0,shortPaints=0;
const originalRender=context.render;
context.render=function(...args){paints++;window.scrollY=0;el('.activity-scroll').scrollTop=0;return originalRender.apply(this,args);};
const originalShortlist=context.renderShortlist;
context.renderShortlist=function(...args){shortPaints++;return originalShortlist.apply(this,args);};
function resetTraffic(){calls.length=0;pending.length=0;scrolls.length=0;inFlight=0;maxInFlight=0;}
function flush(){for(const finish of pending.splice(0))finish();}
async function untilIdle(){
 for(let i=0;i<50&&(pending.length||run('liveRunning')||run('livePending')||run('liveCoalesced'));i++){flush();await Promise.resolve();}
}
function handler(target,type){return listeners[target].get(type)?.[0];}

failed.add('/api/programme');
const failedProgramme=run('loadProgramme()');
flush();
await assert.rejects(failedProgramme,/ещё не готова/);
assert.equal(run('films.length'),0,'a failed programme read leaves the page without a snapshot');
failed.delete('/api/programme');
const firstProgramme=run('loadProgramme({quiet:true})');
await untilIdle();
await firstProgramme;
assert.equal(run('films[0].title'),'Первый');
assert.equal(run('programmeReady'),true);
assert.ok(!calls.some(url=>url.includes('/api/sync')||url.includes('/api/enrichment/start')),'refresh only reads published snapshots');

resetTraffic();
run('startLiveRefresh()');
assert.equal(timer.ms,60000);
document.hidden=true;
handler('document','visibilitychange')();
assert.equal(timer,null,'a hidden tab clears the poll timer');
assert.equal(calls.length,0);
const hiddenTick=timer;
assert.equal(hiddenTick,null);
document.hidden=false;
handler('document','visibilitychange')();
await untilIdle();
assert.equal(calls.length,6,'returning to a visible tab refreshes once');
assert.deepEqual([...new Set(calls)].sort(),['/api/catalog/available','/api/enrichment/footer/status','/api/enrichment/view','/api/events','/api/programme','/api/started']);
run('stopLiveRefresh()');

resetTraffic();
document.hidden=false;
run('startLiveRefresh()');
resetTraffic();
handler('window','focus')();
handler('document','visibilitychange')();
await untilIdle();
assert.equal(calls.length,6,'focus and visibility in the same turn share one refresh');
run('stopLiveRefresh()');

resetTraffic();
const first=run('runLiveRefresh()');
const second=run('runLiveRefresh()');
assert.equal(calls.length,6);
assert.equal(maxInFlight,6,'one refresh does not overlap its own requests');
await untilIdle();
assert.equal(calls.length,12,'a refresh requested while one is running waits for a single follow-up');
assert.equal(maxInFlight,6);
await first;
await second;
run('stopLiveRefresh()');

resetTraffic();
document.hidden=false;
run('startLiveRefresh()');
const tick=timer.fn;
document.hidden=true;
tick();
assert.equal(calls.length,0,'a hidden tab does not poll on the interval');
document.hidden=false;
run('stopLiveRefresh()');
assert.equal(listeners.document.get('visibilitychange')?.length||0,0);
assert.equal(listeners.window.get('focus')?.length||0,0);
assert.equal(timer,null,'stop removes the timer and both listeners');

resetTraffic();
paints=0;
const primed=run('runLiveRefresh()');
await untilIdle();
await primed;
run(`state.query='поиск';state.sort='personal';state.directors='d1';startedIds=new Set(['keep']);`);
window.scrollY=180;
el('.activity-scroll').scrollTop=40;
const listBefore=el('#activity-list').innerHTML;
paints=0;
scrolls.length=0;
const unchanged=run('runLiveRefresh()');
await untilIdle();
await unchanged;
assert.equal(paints,0,'an unchanged programme snapshot does not rebuild the cards');
assert.equal(scrolls.length,0);
assert.equal(run('state.query'),'поиск');
assert.equal(run('state.sort'),'personal');
assert.equal(run('state.directors'),'d1');
assert.equal(el('#activity-list').innerHTML,listBefore);
programmeVersion=2;
window.scrollY=180;
el('.activity-scroll').scrollTop=40;
paints=0;
const changedRefresh=run('runLiveRefresh()');
await untilIdle();
await changedRefresh;
assert.equal(paints,1,'a changed snapshot renders once');
assert.equal(run('films[0].title'),'Второй');
assert.equal(run('state.query'),'поиск');
assert.equal(run('state.sort'),'personal');
assert.equal(run('state.directors'),'d1');
assert.ok(run('startedIds.has("keep")'));
assert.equal(window.scrollY,180);
assert.equal(el('.activity-scroll').scrollTop,40);
assert.equal(el('#activity-list').innerHTML,listBefore);

const previousMax=run('MAX_YEAR');
assert.equal(run('state.to'),previousMax);
run('installProgramme({updatedAt:"2026-10-18T14:00:00Z",window:{from:1,to:90000000},films:[{id:"film-1",title:"Второй",original:"First",year:2030,genres:["Драма"],shows:[]}],people:{directors:[{id:"d1",name:"Нолан",original:"Nolan"}],actors:[]}})');
assert.equal(run('state.to'),2030);
run('state.to=1990');
run('installProgramme({updatedAt:"2026-10-18T15:00:00Z",window:{from:1,to:90000000},films:[{id:"film-1",title:"Второй",original:"First",year:2031,genres:["Драма"],shows:[]}],people:{directors:[{id:"d1",name:"Нолан",original:"Nolan"}],actors:[]}})');
assert.equal(run('state.to'),1990,'an explicit year range stays in place');

const coverage=el('#status-local-coverage').textContent;
const eventsHtml=el('#activity-list').innerHTML;
el('#activity-status').textContent='события на месте';
failed.add('/api/enrichment/footer/status');
failed.add('/api/events');
const failedRefresh=run('runLiveRefresh()');
await untilIdle();
await failedRefresh;
assert.equal(el('#status-local-coverage').textContent,coverage,'a footer error keeps the last numbers');
assert.equal(el('#activity-list').innerHTML,eventsHtml);
assert.equal(el('#activity-status').textContent,'события на месте');
failed.delete('/api/enrichment/footer/status');
failed.delete('/api/events');
footer={...footer,coverage:{...footer.coverage,currentPredictionsTotal:9,confirmedFilmsTotal:9}};
const recoveredFooter=run('loadPredictionQueue({quiet:true})');
await untilIdle();
await recoveredFooter;
assert.match(el('#status-local-coverage').textContent,/9/);
failed.add('/api/events');
const failedEvents=run('loadEvents()');
flush();
await failedEvents;
assert.equal(el('#activity-status').textContent,'Не удалось загрузить события.');
assert.equal(el('#activity-list').innerHTML,eventsHtml,'an event error does not clear the list');
failed.delete('/api/events');

const absent={updatedAt:'2026-10-18T16:00:00Z',window:{from:Date.parse('2026-10-15T12:00:00Z'),to:Date.parse('2026-10-19T12:00:00Z')},films:[{id:'drama',title:'Драма',original:'Drama',year:2010,genres:['Драма'],directors:[],actors:[],shows:[]}],people:{directors:[],actors:[]}};
const returned={updatedAt:'2026-10-18T17:00:00Z',window:absent.window,films:[{id:'back',title:'Фантастика',original:'Fantasy',year:2011,genres:['Фантастика'],directors:[{id:'d-missing',name:'Пропавший'}],actors:[],shows:[{start:Date.parse('2026-10-18T13:00:00Z'),end:Date.parse('2026-10-18T15:00:00Z'),channel:'Кино',channelId:'k'}]}],people:{directors:[{id:'d-missing',name:'Пропавший',original:'Missing'}],actors:[]}};
context.absent=absent;context.returned=returned;
run(`state.query='';state.from=1900;state.to=MAX_YEAR;state.genres=new Set(['Фантастика']);state.directors='d-missing';state.actors='';state.mechanics=new Set(['heist']);state.moods=new Set(['dark']);enrichment.films.back={actualRating:4,fingerprint:{plotMechanics:['heist'],moodIds:['dark']}};`);
el('#directors-input').value='Пропавший';
run('installProgramme(absent);refreshGenreOptions();updateFacetOptions();');
assert.ok(run(`state.genres.has('Фантастика')&&state.directors==='d-missing'&&state.mechanics.has('heist')&&state.moods.has('dark')`),'selected filters survive a snapshot with no matches');
assert.match(el('#genres').innerHTML,/Фантастика[\s\S]*genre-count">0</);
assert.match(el('#mechanics').innerHTML,/value="heist"[\s\S]*genre-count">0</);
assert.match(el('#moods').innerHTML,/value="dark"[\s\S]*genre-count">0</);
assert.equal(el('#directors-input').value,'Пропавший');
assert.equal(run('films.some(eligible)'),false);
run('installProgramme(returned);refreshGenreOptions();updateFacetOptions();');
assert.equal(run(`films.filter(eligible).map(film=>film.id).join()`),'back','the same filters match again when the film returns');
assert.match(el('#genres').innerHTML,/genre-count">1</);
assert.match(el('#mechanics').innerHTML,/value="heist"[\s\S]*genre-count">1</);

run(`state.genres=new Set();state.mechanics=new Set();state.moods=new Set();state.directors='';state.lastChanceOnly=false;`);
const clock=Date.parse('2026-10-18T18:00:00Z');
context.timed={updatedAt:'2026-10-18T18:00:00Z',window:{from:clock-72*3600000,to:clock+24*3600000},films:[{id:'live',title:'Сейчас',original:'Now',year:2024,genres:['Драма'],directors:[],actors:[],shows:[{start:clock-64*3600000,end:clock-62*3600000,channel:'Кино',channelId:'k'}]}],people:{directors:[],actors:[]}};
run(`enrichment.films.live={actualRating:5};viewClock=${clock};installProgramme(timed);render();`);
paints=0;shortPaints=0;
run(`viewClock=${clock+1000};refreshTimeSensitiveView();`);
assert.equal(paints,1,'crossing the last-chance boundary rerenders the programme');
assert.equal(run('isLastChance(films[0])'),true);
run(`films[0].shows=[{start:${clock-3600000},end:${clock+4*3600000},channel:'Кино'}];viewClock=${clock};render();`);
paints=0;shortPaints=0;
run(`viewClock=${clock+30000};refreshTimeSensitiveView();`);
assert.equal(paints,0,'a tick that changes no show or deadline does not rebuild the cards');
assert.equal(shortPaints,0,'the shortlist stays mounted when the on-air show does not change');
assert.match(el('#shortlist-cards').innerHTML,/Сейчас/);
run('viewClock=null');
run(`urlReady=true;state.query='';state.from=1900;state.to=MAX_YEAR;state.genres=new Set(['Фантастика']);state.directors='d-missing';state.actors='';state.mechanics=new Set();state.moods=new Set();state.lastChanceOnly=false;enrichment.films.back={actualRating:4,fingerprint:{plotMechanics:['heist'],moodIds:['dark']}};`);
run('render()');
assert.match(window.location.href,/genre=/);
assert.match(window.location.href,/director=d-missing/);
run('installProgramme(absent)');
run(`state.genres=new Set();state.directors='';state.actors='';`);
el('#directors-input').value='';
run('restoreUrl()');
assert.ok(run(`state.genres.has('Фантастика')&&state.directors==='d-missing'`),'reload keeps genre and director selections from the URL');
assert.match(el('#genres').innerHTML,/Фантастика[\s\S]*genre-count">0</);
assert.equal(el('#directors-input').value,'d-missing');
run('installProgramme(returned);refreshGenreOptions();updateFacetOptions();');
assert.equal(run(`films.filter(eligible).map(film=>film.id).join()`),'back','returning films match the restored filters without selecting them again');

const hostile='"><img src=x onerror=\'alert(1)\'>&';
window.location.href='https://iptv.example/?genre='+encodeURIComponent(hostile);
run('films=[{id:"plain",title:"Фильм",original:"Film",year:2020,genres:["Драма"],directors:[],actors:[],shows:[]}];restoreUrl();');
const hostileHtml=el('#genres').innerHTML;
assert.equal(hostileHtml.includes('<img'),false,'a genre from the URL is not inserted as HTML');
assert.match(hostileHtml,/value="&quot;&gt;&lt;img src=x onerror=&#39;alert\(1\)&#39;&gt;&amp;"/);
assert.match(hostileHtml,/<span>&quot;&gt;&lt;img src=x onerror=&#39;alert\(1\)&#39;&gt;&amp;<\/span>/);
assert.match(hostileHtml,/genre-count">0</);
assert.match(hostileHtml,/Драма[\s\S]*genre-count">1</);
assert.equal(run(`state.genres.has(${JSON.stringify(hostile)})`),true,'the escaped option stays selected when the genre is absent from the snapshot');

console.log('Live refresh: visibility pause and catch-up, one shared return pass, no overlapping requests, preserved filters, time boundaries, facet counts, and quiet error recovery passed');
