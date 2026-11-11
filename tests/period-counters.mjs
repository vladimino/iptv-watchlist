import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';

// AIR-434 acceptance fix: the three period counters, the cards and the shortlist are period-INDEPENDENT sets with one fixed channel constraint. Selecting a tab
// never changes the counters; «Все показы» is exactly «Архив» + «Скоро» for scheduled films; a selected channel is not a view of another channel's shows.
const hour=3600000,min=60000;
const t0=Date.parse('2026-10-15T10:00:00Z');
const source=fs.readFileSync('public/app.js','utf8');
const box=()=>({hidden:false,textContent:'',innerHTML:'',value:'',title:'',checked:false,className:'',classList:{remove(){},add(){},contains(){return false}},style:{},dataset:{},setAttribute(){},getAttribute(){return null},removeAttribute(){},querySelector(){return box()},focus(){}});
const nodes=new Map();
const ctx=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,JSON,console,document:{querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,box());return nodes.get(selector);},querySelectorAll:()=>[],documentElement:{classList:{toggle(){}}}},window:{history:{state:null,pushState(){},replaceState(){}},location:{href:'https://iptv.local/',pathname:'/',search:'',hash:''}}});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability')+'\n'+fs.readFileSync('public/return-home.js','utf8')+source.replace(/init\(\);\s*$/,''),ctx);
const run=code=>vm.runInContext(code,ctx);
const show=(start,channel,length=2)=>({channelId:channel,channel,start,end:start+length*hour});
const film=(id,shows,extra={})=>({id,tmdbId:id,title:id,original:id,year:2020,runtime:100,genres:['Драма'],directors:[],actors:[],shows,...extra});
const install=(list,{clock=t0,channels=[],unscheduled=false,lastChance=false}={})=>{ctx.list=list;ctx.chans=channels;run(`report={updatedAt:new Date(${clock}).toISOString(),window:{from:${clock}-72*${hour},to:${clock}+48*${hour}},films:[]};films=list;enrichment={films:{}};ratingsLoaded=true;viewClock=${clock};state.includeUnscheduled=${unscheduled};state.lastChanceOnly=${lastChance};state.query='';state.period='all';state.sort='title';state.channels=new Set(chans);state.to=MAX_YEAR;state.shortlistMode='available'`);};
const counters=()=>{run('render()');return ['all','archive','soon'].map(p=>Number(nodes.get('#count-'+p).textContent));};
const tab=period=>{run(`state.period='${period}'`);return counters();};
const setOf=period=>run(`films.filter(f=>eligible(f)&&countedScope(f,'${period}')).map(f=>f.id).sort()`);

// The reported case: a saved scenario with a channel filter. 9 films with an archive on А, 1 film that is soon on А.
const reported=[...Array.from({length:9},(_,i)=>film('a'+i,[show(t0-10*hour,'А')])),film('s0',[show(t0+3*hour,'А')])];
install(reported,{channels:['А']});
assert.deepEqual(tab('all'),[10,9,1]);
assert.deepEqual(tab('soon'),[10,9,1],'choosing «Скоро» must not change any counter (it used to show 1 / 0 / 1)');
assert.deepEqual(tab('archive'),[10,9,1]);
assert.deepEqual(run('visibleFilms().map(f=>f.id).sort()'),Array.from({length:9},(_,i)=>'a'+i).sort());
run("state.period='soon'");assert.deepEqual(run('visibleFilms().map(f=>f.id)'),['s0']);

// Channel semantics: the state is the lifecycle over the SELECTED channels' shows. A recording on another channel is not an archive here.
const mix=[
 film('archive-A',[show(t0-10*hour,'А')]),
 film('future-B',[show(t0+4*hour,'Б')]),
 film('archive-A-repeat-B',[show(t0-10*hour,'А'),show(t0+3*hour,'Б')]),   // archive on А, repeat on Б
 film('archive-B',[show(t0-9*hour,'Б')]),
 film('ongoing-B',[show(t0-hour,'Б')]),
 film('none',[])];
const expectations=[
 [[],              {archive:['archive-A','archive-A-repeat-B','archive-B'],soon:['future-B','ongoing-B']}],           // no channel: whole programme; a repeat never makes «Скоро»
 [['А'],           {archive:['archive-A','archive-A-repeat-B'],soon:[]}],
 [['Б'],           {archive:['archive-B'],soon:['archive-A-repeat-B','future-B','ongoing-B']}],                       // on Б the repeat is the only show: «Скоро», not a false archive
 [['А','Б'],       {archive:['archive-A','archive-A-repeat-B','archive-B'],soon:['future-B','ongoing-B']}]];
for(const [channels,want] of expectations){
 install(mix,{channels});
 const base=tab('all');
 for(const period of ['archive','soon','all'])assert.deepEqual(tab(period),base,`counters are stable across the tabs, channels ${channels.join('+')||'none'}`);
 assert.deepEqual(setOf('archive'),want.archive,`archive, channels ${channels.join('+')||'none'}`);
 assert.deepEqual(setOf('soon'),want.soon,`soon, channels ${channels.join('+')||'none'}`);
 assert.deepEqual(setOf('archive').filter(id=>setOf('soon').includes(id)),[],'archive and soon are disjoint');
 assert.deepEqual([...setOf('archive'),...setOf('soon')].sort(),setOf('all'),'all = archive + soon for scheduled films');
 assert.deepEqual(base,[setOf('all').length,setOf('archive').length,setOf('soon').length]);
 for(const period of ['archive','soon','all']){run(`state.period='${period}'`);assert.deepEqual(run('visibleFilms().map(f=>f.id)').slice().sort(),setOf(period),`the visible list is the counted set, ${period}`);}
 // Every shown show is on a selected channel, and an archive group holds no show of another channel.
 if(channels.length){run("state.period='all'");for(const id of setOf('all')){ctx.fid=id;const shown=run('periodShows(films.find(f=>f.id===fid)).map(s=>s.channel)');assert.ok(shown.every(c=>channels.includes(c)),`${id} shows only selected channels: ${shown}`);}}
}

// «включить без показа» belongs to «Все показы» only; it never fills «Архив» or «Скоро».
for(const channels of [[],['А']]){
 install([film('archive-A',[show(t0-10*hour,'А')]),film('future-A',[show(t0+4*hour,'А')]),film('none',[])],{channels,unscheduled:true});
 run("state.period='all'");const all=run('visibleFilms().map(f=>f.id).sort()');
 assert.deepEqual(all,channels.length?['archive-A','future-A']:['archive-A','future-A','none'],'unscheduled in «Все показы» only without a channel (a channel needs a show)');
 assert.deepEqual(tab('archive'),[channels.length?2:3,1,1]);assert.deepEqual(run('visibleFilms().map(f=>f.id)'),['archive-A']);
 assert.deepEqual(tab('soon'),[channels.length?2:3,1,1]);assert.deepEqual(run('visibleFilms().map(f=>f.id)'),['future-A']);
 install([film('none',[])],{channels,unscheduled:false});assert.deepEqual([tab('all'),tab('archive'),tab('soon')].map(c=>c.join()),['0,0,0','0,0,0','0,0,0']);
}
install([film('none',[]),film('archive-A',[show(t0-10*hour,'А')])],{unscheduled:true});
for(const period of ['archive','soon'])assert.equal(run(`inSelectedScope(films[0],'${period}')`),false,`an unscheduled film is not in ${period}`);
assert.equal(run("inSelectedScope(films[0],'all')"),true);

// Last chance with a channel reads the archive on the selected channels only.
const late=[film('ending-A',[show(t0-71*hour,'А',1)]),film('ending-B',[show(t0-71*hour,'Б',1)]),film('fresh-A',[show(t0-2*hour,'А')])];
install(late,{channels:['А'],lastChance:true});run("state.period='all'");assert.deepEqual(run('visibleFilms().map(f=>f.id)'),['ending-A']);
install(late,{channels:['Б'],lastChance:true});assert.deepEqual(run('visibleFilms().map(f=>f.id)'),['ending-B']);

// The clock moves a film between the sets without a reload and without breaking the invariants (on air → archive at its end).
const moving=[film('m',[show(t0+2*hour,'А',2)]),film('stay',[show(t0-10*hour,'А')])];
for(const [clock,want] of [[t0,[2,1,1]],[t0+2*hour,[2,1,1]],[t0+4*hour-1,[2,1,1]],[t0+4*hour,[2,2,0]],[t0+62*hour,[1,1,0]],[t0+74*hour-1,[1,1,0]],[t0+74*hour,[0,0,0]]]){install(moving,{clock,channels:['А']});assert.deepEqual(tab('soon'),want,'clock '+(clock-t0)/hour);assert.deepEqual(tab('archive'),want);}

// The shortlist follows the same constraint: with a channel only that channel's shows are named, and a film is in the group its selected-channel state says.
install(mix.map(f=>({...f})),{channels:['Б']});run("ratingsLoaded=true;enrichment={films:Object.fromEntries(films.map(f=>[f.id,{prediction:{predictedRating:4.5,probability4Plus:.8}}]))}");
for(const [mode,expected] of [['available',['archive-B']],['soon',['archive-A-repeat-B','future-B','ongoing-B']]]){
 const got=run(`films.filter(f=>eligible(f)&&inSelectedScope(f)&&shortlistAvailability(f,'${mode}',viewClock)).map(f=>f.id).sort()`);assert.deepEqual(got,expected,mode);
}
// The channel options follow the same states: a channel is offered under «Архив» when its own shows make the film an archive, under «Скоро» when they make it soon.
install(mix,{channels:[]});ctx.pick=mix[2];
for(const [period,expected] of [['all',['А','Б']],['archive',['А']],['soon',['Б']]]){run(`state.period='${period}'`);assert.deepEqual([...run('scopedChannels(pick)')].sort(),expected,'options, '+period);}
run("state.period='all'");
const facet=run("buildFacetCatalog().channels?.map?.(item=>item.value)||null");if(facet)assert.ok(facet.every(name=>['А','Б'].includes(name)));
run("state.channels=new Set(['Б'])");
// A saved scenario round-trips through the URL (channel, period, shortlist).
run("state.period='soon';state.shortlistMode='soon'");const url=run("urlForState('https://iptv.local/')");assert.equal(url.searchParams.get('channel'),'Б');assert.equal(url.searchParams.get('period'),'soon');
ctx.q=url.search;assert.equal(run('presetKey(q.slice(1))===presetKey(presetQuery())'),true);
console.log('Period counters: stable across tabs with channel filters, all = archive + soon, channel-scoped states, unscheduled only under «Все показы», last chance, clock moves and shortlist passed');
