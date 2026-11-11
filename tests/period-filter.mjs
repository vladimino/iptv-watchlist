import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';

// AIR-434 (ADR 0114): the main period selector «Все показы / Архив / Скоро». «Архив» is film-level `available`, «Скоро» is film-level `soon`, «Все показы» is their
// union; the three counters, the cards, the shortlist and the Finds read the same lifecycle, so the sets never overlap and need no EPG reload to change.
const hour=3600000,min=60000;
const t0=Date.parse('2026-10-15T10:00:00Z');
const html=fs.readFileSync('public/index.html','utf8'),source=fs.readFileSync('public/app.js','utf8');

// The labels and controls: no «Сегодня» / «Следующие сутки» filter, no «Сначала появляющиеся» sort, the new selectors name the lifecycle.
assert.match(html,/<div class="period-tabs" role="group" aria-label="Период показов"><button data-period="all"[^>]*>Все показы <span id="count-all"><\/span><\/button><button data-period="archive"[^>]*>Архив <span id="count-archive"><\/span><\/button><button data-period="soon"[^>]*>Скоро <span id="count-soon"><\/span><\/button><\/div>/);
assert.match(html,/data-shortlist-mode="available"[^>]*>Доступно<\/button><button type="button" data-shortlist-mode="soon"[^>]*>Скоро<\/button>/);
assert.doesNotMatch(html,/Следующие сутки|>Сегодня<|>Сейчас<|Сначала появляющиеся|data-period="future"|data-shortlist-mode="(?:now|today)"/);
assert.match(html,/<option value="expiring">Сначала исчезающие<\/option>/,'the sort that exists is kept');
assert.doesNotMatch(source,/appearing|появляющ/i);

const box=()=>({hidden:false,textContent:'',innerHTML:'',value:'',title:'',checked:false,className:'',classList:{remove(){},add(){},contains(){return false}},style:{},dataset:{},setAttribute(){},getAttribute(){return null},removeAttribute(){},querySelector(){return box()},focus(){}});
const nodes=new Map();
const ctx=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,JSON,console,document:{querySelector:selector=>{if(!nodes.has(selector))nodes.set(selector,box());return nodes.get(selector);},querySelectorAll:()=>[],documentElement:{classList:{toggle(){}}}},window:{history:{state:null,pushState(){},replaceState(){}},location:{href:'https://iptv.local/',pathname:'/',search:'',hash:''}}});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability')+'\n'+fs.readFileSync('public/return-home.js','utf8')+source.replace(/init\(\);\s*$/,''),ctx);
const run=code=>vm.runInContext(code,ctx);
const show=(start,length=2,channel='Кино')=>({channelId:'c',channel,start,end:start+length*hour});
const film=(id,shows,extra={})=>({id,tmdbId:id,title:id,original:id,year:2020,runtime:100,genres:['Драма'],directors:[],actors:[],shows,...extra});
const install=(list,clock)=>{ctx.list=list;run(`report={updatedAt:new Date(${clock}).toISOString(),window:{from:${clock}-72*${hour},to:${clock}+48*${hour}},films:[]};films=list;enrichment={films:{}};ratingsLoaded=true;viewClock=${clock};state.includeUnscheduled=false;state.lastChanceOnly=false;state.query='';state.period='all';state.sort='title';state.channels=new Set();state.to=MAX_YEAR;state.shortlistMode='available'`);};
const set=period=>run(`films.filter(f=>eligible(f)&&periodShows(f,'${period}').length).map(f=>f.id).sort()`);
const count=period=>run(`films.filter(f=>eligible(f)&&countedScope(f,'${period}')).length`);

const catalog=()=>[
 film('archive',[show(t0-10*hour)]),
 film('repeat',[show(t0-10*hour),show(t0+3*hour)]),                  // ready archive plus a future repeat: archive only
 film('ongoing',[show(t0-hour)]),                                      // on air, ends in 1 h: soon, never an archive
 film('future',[show(t0+5*hour)]),                                     // ahead only: soon
 film('onair-repeat',[show(t0-hour),show(t0-20*hour)]),                // an older ready archive and a show on air now: archive
 film('far',[show(t0+24*hour)]),                                       // exactly 24 h ahead: outside
 film('old',[show(t0-72*hour)]),                                       // exactly 72 h after its start: gone
 film('noend',[{channelId:'c',channel:'Кино',start:t0-hour}],{runtime:null}), // started, no end and no runtime: neither
 film('runtime',[{channelId:'c',channel:'Кино',start:t0-30*min}],{runtime:100}), // no end, runtime: on air until start+runtime
];
install(catalog(),t0);
assert.deepEqual(set('archive'),['archive','onair-repeat','repeat']);
assert.deepEqual(set('soon'),['future','ongoing','runtime']);
assert.deepEqual(set('all'),['archive','future','onair-repeat','ongoing','repeat','runtime']);
assert.deepEqual(set('archive').filter(id=>set('soon').includes(id)),[],'archive and soon never intersect');
assert.deepEqual([...set('archive'),...set('soon')].sort(),set('all'),'«Все показы» is exactly their union');
assert.deepEqual([count('all'),count('archive'),count('soon')],[6,3,3],'the three counters are the same sets');
assert.deepEqual(set('future'),set('soon'),'the old period name is an alias, never a second set');
// The visible list follows the selected period, with the card groups of the same lifecycle.
for(const [period,expected] of [['archive',['archive','onair-repeat','repeat']],['soon',['future','ongoing','runtime']],['all',['archive','future','onair-repeat','ongoing','repeat','runtime']]]){run(`state.period='${period}'`);assert.deepEqual(run('visibleFilms().map(f=>f.id)').slice().sort(),expected,period);}
run("state.period='soon'");let card=run("card(films.find(f=>f.id==='ongoing'))");assert.match(card,/class="soon-badge"/,'one shared hourglass');assert.match(card,/ДАЛЬШЕ/);assert.doesNotMatch(card,/АРХИВ/);
run("state.period='all'");card=run("card(films.find(f=>f.id==='repeat'))");assert.match(card,/АРХИВ/);assert.match(card,/ДАЛЬШЕ/,'the repeat stays visible as information');assert.doesNotMatch(card,/soon-badge/,'a film with a ready archive never shows the hourglass');
// The retired «Следующие сутки» copy is gone: a film with an archive and no repeat has no extra note, and no filter or card text uses the phrase.
install([film('lonely',[show(t0-6*hour)])],t0);run("state.period='all'");card=run("card(films[0])");assert.doesNotMatch(card,/следующие сутки|archive-only/i,'no legacy note on an archive-only card');assert.doesNotMatch(card,/ДАЛЬШЕ/);
assert.doesNotMatch(source.split('\n').filter(line=>!line.startsWith('//')).join('\n').replace(/<dt>В следующие сутки<\/dt>/,''),/[Сс]ледующие сутки/,'the phrase survives only as the EPG event log field, not in filters or cards');
install(catalog(),t0);
// «Последний шанс» is an archive notion and the expiring sort puts soon films after the archive ones.
run("state.sort='expiring';state.period='all'");assert.deepEqual(run('visibleFilms().map(f=>f.id)').slice(0,3).sort(),['archive','onair-repeat','repeat'].sort());
install([film('ending',[show(t0-71*hour,1)]),film('ongoing',[show(t0-hour)])],t0);run('state.lastChanceOnly=true');assert.deepEqual(run('visibleFilms().map(f=>f.id)'),['ending'],'a soon film is never a last chance');

// The state follows the clock with no EPG reload: on air → archive at the effective end, archive → gone 72 h after the START.
const timed=[film('t',[show(t0+2*hour,2)])];
const at=(clock)=>{install(timed,clock);return [set('soon').length,set('archive').length];};
assert.deepEqual(at(t0),[1,0],'ahead');assert.deepEqual(at(t0+2*hour),[1,0],'on air at its start');assert.deepEqual(at(t0+4*hour-1),[1,0],'one ms before its end');
assert.deepEqual(at(t0+4*hour),[0,1],'ready at the end');assert.deepEqual(at(t0+2*hour+72*hour-1),[0,1]);assert.deepEqual(at(t0+2*hour+72*hour),[0,0],'72 h counted from the start');
// The change is detected by the quiet tick (the grid and the shortlist rebuild once when a film crosses the boundary, not before).
install(timed,t0+4*hour-2*min);run('render();noteTimeView()');
let paints=0;const realRender=ctx.render;ctx.render=()=>{paints++;};
run(`viewClock=${t0+4*hour-min};refreshTimeSensitiveView();`);assert.equal(paints,0,'no change, no rebuild');
run(`viewClock=${t0+4*hour};refreshTimeSensitiveView();`);assert.equal(paints,1,'ongoing → archive rebuilds the grid');ctx.render=realRender;

// 23:50 Madrid: a film that only starts at 00:10 (the next calendar day) is «Скоро»; «Следующие сутки» is not a calendar day any more.
const late=Date.parse('2026-10-20T23:50:00+02:00');install([film('after-midnight',[show(late+20*min)]),film('tomorrow-evening',[show(late+23*hour)]),film('exactly',[show(late+24*hour)])],late);
assert.deepEqual(set('soon'),['after-midnight','tomorrow-evening'],'rolling 24 h from 23:50, not the calendar day');
// Both DST nights: elapsed time, not wall time.
for(const night of ['2026-03-29T01:30:00+01:00','2026-10-25T01:30:00+02:00']){const clock=Date.parse(night);install([film('in',[show(clock+24*hour-1)]),film('out',[show(clock+24*hour)])],clock);assert.deepEqual(set('soon'),['in'],night);}

// URL and saved presets: new values round-trip, old ones are normalised, bad ones fall back.
const read=(query,key)=>{ctx.query='https://iptv.local/?'+query;return run('readUrlState(new URL(query)).'+key);};
assert.equal(read('period=soon','period'),'soon');assert.equal(read('period=future','period'),'soon','old link');assert.equal(read('period=archive','period'),'archive');assert.equal(read('period=today','period'),'all','an unknown value falls back to «Все показы»');assert.equal(read('shortlist=soon','shortlistMode'),'soon');assert.equal(read('shortlist=today','shortlistMode'),'soon','old link');
run("Object.assign(state,{period:'soon',shortlistMode:'soon'})");const url=run("urlForState('https://iptv.local/?campaign=keep')");assert.equal(url.searchParams.get('period'),'soon');assert.equal(url.searchParams.get('shortlist'),'soon');assert.equal(url.searchParams.get('campaign'),'keep');
run("Object.assign(state,{period:'all',shortlistMode:'available',sort:'personal'})");assert.equal(run("urlForState('https://iptv.local/').search"),'','defaults are not serialised');
assert.equal(run('presetKey("period=future&shortlist=today&genre=X")===presetKey("genre=X&shortlist=soon&period=soon")'),true,'an old preset is the same preset');
assert.notEqual(run('presetKey("period=soon")'),run('presetKey("period=archive")'));
// The assistant tool and the presets accept both names and store the new one.
install(catalog(),t0);
run("applyFilters({period:'future'})");assert.equal(run('state.period'),'soon','applyFilters normalises the old name');run("applyFilters({period:'soon'})");assert.equal(run('state.period'),'soon');
assert.throws(()=>run("applyFilters({period:'today'})"),/Invalid period/);
assert.deepEqual(run('applyFilters({period:"archive"}).films.map(f=>f.id)').slice().sort(),['archive','onair-repeat','repeat']);
// The result summary and counters after a render agree with the sets.
run("state.period='all';render()");assert.deepEqual(['all','archive','soon'].map(p=>String(nodes.get('#count-'+p).textContent)),['6','3','3']);
// The empty shortlist names the period conflict instead of a generic empty state.
run("ratingsLoaded=true;enrichment={films:{future:{prediction:{predictedRating:4.5,probability4Plus:.8}},archive:{prediction:{predictedRating:4.5,probability4Plus:.8}}}};state.period='archive';state.shortlistMode='soon';render()");assert.match(String(nodes.get('#shortlist-empty').textContent),/Период «Архив» оставил только фильмы с готовым архивом/);
run("state.period='soon';state.shortlistMode='available';render()");assert.match(String(nodes.get('#shortlist-empty').textContent),/Период «Скоро» оставил только фильмы без готового архива/);
console.log('Period filter: archive/soon/all film sets, counters, cards, clock transitions, 23:50 Madrid, DST, aliases and URL/preset round trip passed');
