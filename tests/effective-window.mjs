import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const hour=3600000;
const t0=Date.parse('2026-06-15T10:00:00Z');
const ctx=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,JSON,console,document:{querySelector(){return null;},querySelectorAll(){return [];},documentElement:{classList:{toggle(){}}}},window:{history:{state:null,pushState(){},replaceState(){}},location:{href:'https://iptv.example/'}}});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
const run=code=>vm.runInContext(code,ctx);
const film=(id,starts,extra={})=>{ctx[id]={id,title:id,original:id,year:2020,genres:['Драма'],runtime:100,directors:[],actors:[],shows:starts.map(start=>({start,end:start+2*hour,channel:'One'})),...extra};return id;};

run(`viewClock=${t0}`);
const fresh=run(`effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}},updatedAt:new Date(${t0}).toISOString(),stats:{epgEnd:${t0}+20*${hour}}},${t0})`);
assert.equal(fresh.basis,'snapshot');
assert.equal(fresh.archive.from,t0-72*hour);
assert.equal(fresh.archive.fromExclusive,true);
assert.equal(fresh.future.to,t0+24*hour);
assert.equal(fresh.black,false);
assert.ok(fresh.epgEnd<fresh.envelope.to);
assert.equal(run(`inArchive(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}),{start:${t0}-72*${hour}})`),false,'retention has ended on the exact 72h boundary');
assert.equal(run(`inFuture(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}),{start:${t0}})`),false);
assert.equal(run(`onAir(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}),{start:${t0},end:${t0}+${hour}})`),true);
assert.equal(run(`inFuture(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}),{start:${t0}+24*${hour}})`),false,'a start on window.to is outside the envelope');
assert.equal(run(`inEnvelope(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}),${t0}+30*${hour})`),false);

const phases=[[0,true,true],[1,true,true],[24,true,false],[72,true,false],[95,true,false],[96,false,false]];
for(const [plus,archive,future] of phases){
 const model=run(`effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}+${plus}*${hour})`);
 assert.equal(!!model.archive,archive,`archive at +${plus}h`);
 assert.equal(!!model.future,future,`future at +${plus}h`);
 assert.equal(model.black,!archive&&!future,`black at +${plus}h`);
}
const late=run(`effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}+95*${hour})`);
assert.ok(late.archive.to-late.archive.from<=hour);
assert.equal(run(`programmeStatus(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}+95*${hour})).badge`),'Архив заканчивается');
assert.equal(run(`programmeStatus(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}+30*${hour})).badge`),'Будущее закончилось');
assert.equal(run(`programmeStatus(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0})).badge`),'Программа актуальна');
assert.equal(run(`programmeStatus(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}},${t0}+96*${hour})).badge`),'Нет актуального окна');
assert.doesNotMatch(run(`programmeStatus(effectiveWindow({window:{from:${t0}-72*${hour},to:${t0}+24*${hour}},stats:{epgEnd:${t0}}},${t0})).title`),/всех каналов есть передача до конца|Источники подключены/);

const summer=run(`madridStamp(Date.parse('2026-07-15T12:00:00Z'),{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})`);
const winter=run(`madridStamp(Date.parse('2026-01-15T12:00:00Z'),{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})`);
const spring=run(`madridStamp(Date.parse('2026-03-29T01:30:00Z'),{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})`);
const autumn=run(`madridStamp(Date.parse('2026-10-25T01:30:00Z'),{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})`);
assert.equal(summer,'14:00');
assert.equal(winter,'13:00');
assert.equal(spring,'03:30');
assert.equal(autumn,'02:30');

assert.equal(run(`effectiveWindow({updatedAt:new Date(${t0}).toISOString()},${t0}).basis`),'estimate');
assert.equal(run(`effectiveWindow({window:{from:5,to:5},stats:{epgEnd:1}},${t0}).basis`),'unavailable');
assert.equal(run(`effectiveWindow({window:{from:'no',to:'later'}},${t0}).basis`),'unavailable');
assert.equal(run('programmeStatus(effectiveWindow({},1)).badge'),'Нет актуального окна');

film('past',[]);
film('soon',[t0+3*hour]);
film('kept',[t0-70*hour,t0-2*hour]);
film('gone',[t0-80*hour]);
film('edge',[t0+24*hour]);
run(`report={updatedAt:new Date(${t0}).toISOString(),window:{from:${t0}-72*${hour},to:${t0}+24*${hour}},films:[]};films=[past,soon,kept,gone,edge];state.includeUnscheduled=false;state.lastChanceOnly=false;state.query='';state.period='all';state.sort='title';state.to=MAX_YEAR;`);
assert.equal(run(`viewClock=${t0};availabilityTime(kept)`),t0-2*hour+72*hour,'a later showing extends retention past an older one');
assert.equal(run(`viewClock=${t0};availabilityTime(gone)`),null);
assert.equal(run(`viewClock=${t0};isLastChance(kept)`),false);
assert.equal(run(`viewClock=${t0+64*hour};isLastChance(kept)`),true,'the surviving showing, not a stale field, makes the last chance');
assert.equal(run(`viewClock=${t0};films.filter(f=>periodShows(f,'future').length).map(f=>f.id).join()`),'soon');
assert.equal(run(`viewClock=${t0+30*hour};films.filter(f=>periodShows(f,'future').length).length`),0,'yesterday future is not still future');
assert.equal(run(`viewClock=${t0+30*hour};periodShows(soon,'archive').length`),1);
assert.equal(run(`viewClock=${t0+80*hour};periodShows(kept,'all').length`),0);
assert.equal(run(`viewClock=${t0};availabilityTime(soon)===${t0}+24*${hour}`),false,'retention is not clipped to the snapshot end');

run(`viewClock=${t0+96*hour};state.includeUnscheduled=false;state.lastChanceOnly=false;`);
assert.equal(run('blackZone()'),true);
assert.equal(run('state.includeUnscheduled'),false);
assert.equal(run(`films.filter(f=>inSelectedScope(f,'all')).length`),5);
assert.equal(run(`films.filter(f=>inSelectedScope(f,'archive')).length`),5,'the open archive tab still lists the watchlist');
assert.equal(run(`films.filter(f=>inSelectedScope(f,'future')).length`),5,'the open next-day tab still lists the watchlist');
assert.equal(run(`films.filter(f=>countedScope(f,'archive')).length`),0);
assert.equal(run(`films.filter(f=>countedScope(f,'future')).length`),0);
run(`state.query='nomatch';`);
assert.equal(run(`films.filter(f=>eligible(f)&&inSelectedScope(f)).length`),0,'search still applies in the black zone');
run(`state.query='';state.lastChanceOnly=true;`);
assert.equal(run(`films.filter(f=>eligible(f)&&inSelectedScope(f)).length`),0);
assert.equal(run('state.lastChanceOnly'),true);
run(`state.lastChanceOnly=false;state.includeUnscheduled=true;viewClock=${t0};`);
assert.equal(run('blackZone()'),false);
assert.equal(run('state.includeUnscheduled'),true,'a manual watchlist choice survives a fresh window');
run('state.includeUnscheduled=false');

run(`viewClock=${t0};noteTimeView();`);
let paints=0;
const realRender=ctx.render;
ctx.render=()=>{paints++;};
run(`viewClock=${t0+1000};refreshTimeSensitiveView();`);
assert.equal(paints,0,'a tick inside the same shows does not rebuild the grid');
run(`viewClock=${t0+30*hour};refreshTimeSensitiveView();`);
assert.equal(paints,1,'crossing from future into the archive rebuilds the grid');
const details={open:true};
const card={dataset:{filmId:'kept'},querySelector:()=>details};
ctx.document.querySelectorAll=selector=>selector.includes('details')?[{className:'film-synopsis',closest:()=>card}]:[];
ctx.document.querySelector=selector=>selector.includes('data-film-id')?card:null;
ctx.render=()=>{details.open=false;};
run('renderPreservingScroll()');
assert.equal(details.open,true,'an open synopsis is restored after a time redraw');
ctx.render=realRender;
function box(){return {hidden:false,textContent:'',innerHTML:'',value:'',title:'',className:'',classList:{remove(){},add(){},contains(){return false}},style:{},dataset:{},setAttribute(){},getAttribute(){return null},removeAttribute(){},querySelector(){return box()},focus(){}};}
const nodes=new Map();
ctx.document.querySelector=selector=>{if(!nodes.has(selector))nodes.set(selector,box());return nodes.get(selector);};
ctx.document.querySelectorAll=()=>[];
const start=t0+60000;
run(`report={updatedAt:new Date(${t0}).toISOString(),window:{from:${t0}-72*${hour},to:${t0}+24*${hour}},films:[]};films=[{id:'soon',title:'Soon',original:'Soon',year:2020,genres:['Драма'],runtime:90,directors:[],actors:[],shows:[{start:${start},end:${start}+2*${hour},channel:'One'}]}];state.period='all';state.includeUnscheduled=false;state.lastChanceOnly=false;state.query='';state.sort='title';state.sortExplicit=false;state.genres=new Set();state.mechanics=new Set();state.moods=new Set();state.channels=new Set();state.from=1900;state.to=MAX_YEAR;state.maxRuntime=null;viewClock=${t0};`);
run('render();noteTimeView()');
assert.match(nodes.get('#movies').innerHTML,/ДАЛЬШЕ/);
assert.doesNotMatch(nodes.get('#movies').innerHTML,/АРХИВ/);
assert.equal(String(nodes.get('#count-future').textContent),'1');
assert.equal(String(nodes.get('#count-archive').textContent),'0');
run(`viewClock=${start};refreshTimeSensitiveView();`);
assert.match(nodes.get('#movies').innerHTML,/АРХИВ/);
assert.doesNotMatch(nodes.get('#movies').innerHTML,/ДАЛЬШЕ/);
assert.equal(String(nodes.get('#count-archive').textContent),'1');
assert.equal(String(nodes.get('#count-future').textContent),'0');
assert.equal(run('state.period'),'all');
run(`films.push({id:'bare',title:'Bare',original:'Bare',year:2020,genres:['Драма'],runtime:90,directors:[],actors:[],shows:[]});`);
for(const period of ['all','archive','future'])for(const checked of [false,true]){
 run(`state.period='${period}';state.includeUnscheduled=${checked};state.lastChanceOnly=false;state.query='';viewClock=${t0+96*hour};`);
 assert.equal(run('visibleFilms().length'),2,`${period} with the box ${checked?'on':'off'} still lists the watchlist`);
 assert.equal(run(`films.filter(film=>eligible(film)&&countedScope(film,'archive')).length`),0);
 assert.equal(run(`films.filter(film=>eligible(film)&&countedScope(film,'future')).length`),0);
 assert.equal(run('state.period'),period);
 assert.equal(run('state.includeUnscheduled'),checked);
 assert.equal(run("presetQuery().includes('view=watchlist')"),checked);
 run(`viewClock=${t0};`);
 assert.equal(run('blackZone()'),false);
 const restored=period==='archive'?checked?1:0:checked?2:1;
 assert.equal(run('visibleFilms().length'),restored,`${period} restores the schedule and keeps the box ${checked?'on':'off'}`);
 assert.equal(run(`films.filter(film=>eligible(film)&&countedScope(film,'future')).length`),checked?2:1);
 assert.equal(run(`films.filter(film=>eligible(film)&&countedScope(film,'archive')).length`),checked?1:0);
 assert.equal(run('state.includeUnscheduled'),checked);
 assert.equal(run('state.period'),period);
}

const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/styles.css','utf8');
assert.doesNotMatch(html,/id="archive-range"|id="future-range"|Время — Europe\/Madrid|Источники подключены/);
assert.match(html,/id="snapshot-coverage"/);
assert.match(html,/id="window-note"/);
assert.match(css,/snapshot-coverage/);
assert.doesNotMatch(css,/\.coverage p time/);
console.log('Effective window: moving clock, boundaries, black zone, Madrid labels and quiet ticks passed');
