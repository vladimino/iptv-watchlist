import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Channel-scoped finds: with a channel filter the watchlist grid and the finds are two sections of one channel and period scope.
const now=Date.UTC(2026,5,15,10,0,0),hour=3600000;
const html=fs.readFileSync('public/index.html','utf8'),app=fs.readFileSync('public/app.js','utf8');
assert.match(html,/<h2 id="watchlist-title" class="results-section-title" hidden>Из watchlist<\/h2>\s*<div class="movie-grid" id="movies"><\/div>/,'the watchlist heading sits right above the grid and starts hidden');
assert.match(html,/<h2 id="finds-title">Находки<\/h2>/,'without a channel filter the section keeps its plain title');
assert.doesNotMatch(app,/\$\('#empty'\)\.hidden=visible\.length>0\|\|!valid;/,'the shared empty state is decided together with the finds');

const node=()=>({hidden:true,textContent:'',innerHTML:''});
const nodes={'#finds':node(),'#finds-cards':node(),'#finds-caption':node(),'#finds-title':{...node(),textContent:'Находки'},'#watchlist-title':node(),'#empty':node()};
const ui=vm.createContext({Date,Intl,Set,Map,console,document:{querySelector:selector=>nodes[selector]||null,querySelectorAll:()=>[]}});
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
// The programme window is the usual (now − 72h, now + 24h) envelope; the catalog answer is for the same generation.
vm.runInContext(`viewClock=${now};report={runId:'G1',films:[],window:{from:${now-72*hour},to:${now+24*hour}},cutoff:${now}};`,ui);
ui.now=now;

const show=(startOffsetHours,channel,length=2)=>({channelId:channel,channel,start:now+startOffsetHours*hour,end:now+(startOffsetHours+length)*hour});
const film=(id,tmdb,title,rating,probability,shows)=>({id,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title,original:title,year:2020,runtime:100,genres:['Драма'],poster:null,url:'https://www.themoviedb.org/movie/'+tmdb,directors:[],actors:[],shows,prediction:{predictedRating:rating,probability4Plus:probability,confidence:'high',matchSignals:[],mainRisk:null,moodIds:['dark']},fingerprint:{plotMechanics:['heist'],moodIds:['dark'],execution:{}}});
const run=(expression,input)=>{ui.input=input;return vm.runInContext(expression,ui);};
const ids=list=>Array.from(list).map(item=>item.id);
const scope=(channels,period='all')=>{vm.runInContext(`state.channels=new Set(${JSON.stringify(channels)});state.period=${JSON.stringify(period)};`,ui);};

const catalog=[
 film('tmdb_1',1,'Только Один архив',4.6,.9,[show(-10,'Один')]),
 film('tmdb_2',2,'Только Два будущее',4.5,.9,[show(5,'Два')]),
 film('tmdb_3',3,'Оба канала',4.4,.9,[show(-30,'Два'),show(3,'Один')]),
 film('tmdb_4',4,'Только Три',4.8,.95,[show(-2,'Три')]),
];

// No channel filter: the plain section, unchanged ranking over every channel.
scope([]);
assert.equal(run('findsScope()',null),null);
assert.deepEqual(ids(run('buildFinds(input,now)',catalog)),['tmdb_4','tmdb_1','tmdb_2','tmdb_3']);

// One channel: only films with a show on it, and the airing line names that channel's show, not a nearer one elsewhere.
scope(['Один']);
assert.deepEqual(ids(run('buildFinds(input,now)',catalog)),['tmdb_1','tmdb_3'],'a film shown only on another channel is not a find on this one');
assert.equal(run('findsAiring(input,now).kind',catalog[2]),'next');
assert.match(run('findsAiring(input,now).text',catalog[2]),/ · Один$/,'the relevant show is on the selected channel');
assert.doesNotMatch(run('findsCard(input,now)',catalog[2]),/Два/,'the other channel never appears on the card');

// Two channels combine with OR and never show one film twice.
scope(['Один','Два']);
assert.deepEqual(ids(run('buildFinds(input,now)',catalog)),['tmdb_1','tmdb_2','tmdb_3'],'OR across channels, one entry per film');
const twins=[catalog[2],{...catalog[2],id:'tmdb_3b'}];
assert.deepEqual(ids(run('buildFinds(input,now)',twins)),['tmdb_3'],'canonical dedupe holds in channel mode');

// Period is a hard constraint on the selected channel's shows.
scope(['Один','Два'],'archive');
assert.deepEqual(ids(run('buildFinds(input,now)',catalog)),['tmdb_1','tmdb_3'],'archive keeps started shows only');
assert.match(run('findsAiring(input,now).text',catalog[2]),/^Архив · Два · до /,'in archive the catch-up show on the selected channel is the relevant one');
scope(['Один','Два'],'future');
assert.deepEqual(ids(run('buildFinds(input,now)',catalog)),['tmdb_2','tmdb_3'],'future keeps upcoming shows only');
assert.match(run('findsAiring(input,now).text',catalog[2]),/ · Один$/);
scope(['Один'],'future');
assert.deepEqual(ids(run('buildFinds(input,now)',catalog)),['tmdb_3'],'channel and period together');
scope(['Три'],'future');
assert.deepEqual(ids(run('buildFinds(input,now)',catalog)),[],'an empty intersection is empty, not filled from another channel or period');

// The effective 72-hour catch-up and the 24-hour horizon still bound the selected channel's shows.
scope(['Один']);
assert.deepEqual(ids(run('buildFinds(input,now)',[film('tmdb_5',5,'Истёк',4.5,.9,[show(-72,'Один'),show(-1,'Два')])])),[],'an expired show on the channel is not revived by a live one elsewhere');
assert.deepEqual(ids(run('buildFinds(input,now)',[film('tmdb_6',6,'Далеко',4.5,.9,[show(24,'Один')])])),[]);
// Ranking uses the end of availability on the selected channel.
const ending=[film('tmdb_7',7,'А позже',4.5,.9,[show(-5,'Один'),show(-60,'Два')]),film('tmdb_8',8,'Б раньше',4.5,.9,[show(-40,'Один')])];
assert.deepEqual(ids(run('buildFinds(input,now)',ending)),['tmdb_8','tmdb_7'],'the nearest end of availability is the one on the selected channel');

// Black zone: no available show in the effective window, so no channel-scoped find is a phantom.
vm.runInContext(`report={runId:'G1',films:[],window:{from:${now-200*hour},to:${now-100*hour}},cutoff:${now-124*hour}};`,ui);
assert.equal(run('blackZone()',null),true);
scope(['Один']);
assert.deepEqual(ids(run('buildFinds(input,now)',catalog)),[],'the black zone has no channel-scoped finds');
vm.runInContext(`report={runId:'G1',films:[],window:{from:${now-72*hour},to:${now+24*hour}},cutoff:${now}};`,ui);

// Sections: headings, captions, independent empty states.
ui.catalogFilms=catalog;
vm.runInContext('findsSource={films:catalogFilms,ready:true,error:false,programmeRunId:"G1",generatedAt:null}',ui);
const render=visible=>{vm.runInContext(`resultsView={visible:${visible},valid:true}`,ui);return ids(run('renderFinds(now)',null));};
scope(['Один']);
assert.deepEqual(render(2),['tmdb_1','tmdb_3']);
assert.equal(nodes['#finds-title'].textContent,'Находки на выбранном канале');
assert.equal(nodes['#finds-caption'].textContent,'2 фильма вне watchlist с показом на канале Один');
assert.equal(nodes['#watchlist-title'].hidden,false,'both sections: the grid gets its heading');
assert.equal(nodes['#finds'].hidden,false);
assert.equal(nodes['#empty'].hidden,true);
scope(['Два','Один'],'archive');
render(2);
assert.equal(nodes['#finds-title'].textContent,'Находки на выбранных каналах');
assert.equal(nodes['#finds-caption'].textContent,'2 фильма вне watchlist с показом на каналах Два, Один · архив');
// Only finds: the empty watchlist section is not shown, and neither is the shared empty state.
scope(['Один']);
render(0);
assert.equal(nodes['#watchlist-title'].hidden,true);
assert.equal(nodes['#empty'].hidden,true,'finds alone do not sit under a "nothing found" block');
assert.equal(nodes['#finds'].hidden,false);
// Only the watchlist: the finds section is hidden.
scope(['Три'],'future');
render(3);
assert.equal(nodes['#finds'].hidden,true);
assert.equal(nodes['#watchlist-title'].hidden,false);
assert.equal(nodes['#empty'].hidden,true);
// Neither: the shared empty state.
render(0);
assert.equal(nodes['#finds'].hidden,true);
assert.equal(nodes['#watchlist-title'].hidden,true);
assert.equal(nodes['#empty'].hidden,false);
// Clearing the channel filter returns to the plain finds section and grid without a heading.
scope([]);
assert.deepEqual(render(3),['tmdb_4','tmdb_1','tmdb_2','tmdb_3']);
assert.equal(nodes['#finds-title'].textContent,'Находки');
assert.equal(nodes['#finds-caption'].textContent,'4 фильма вне watchlist: сильный прогноз и реальный показ');
assert.equal(nodes['#watchlist-title'].hidden,true);
render(0);
assert.equal(nodes['#empty'].hidden,false,'without a channel filter the empty state is the watchlist one, as before');
// Invalid filter values keep the grid heading hidden.
scope(['Один']);
vm.runInContext('resultsView={visible:0,valid:false}',ui);run('renderFinds(now)',null);
assert.equal(nodes['#watchlist-title'].hidden,true);
assert.equal(nodes['#empty'].hidden,true);

// A film that entered the watchlist leaves the channel finds too.
vm.runInContext("films=[{id:'tmdb_1',tmdbId:'1',title:'Теперь в watchlist',shows:[]}];",ui);
assert.deepEqual(render(1),['tmdb_3']);
console.log('Channel finds: single and multiple channels, period, catch-up bounds, black zone, cross-channel negatives, dedupe, relevant show, section headings and empty states passed');
