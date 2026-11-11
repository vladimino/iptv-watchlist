// AIR-188 review: the reader sees the rolling [now - 72 h, now + 24 h]. Seven-day retention is storage and coverage metadata only.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped as scopedAvailability} from '../scripts/bundle-scope.mjs';
const AVAILABILITY_LIB=scopedAvailability('src/domain/film-availability.js','FilmAvailability')+'\n';

const hour=3600000,t0=Date.parse('2026-11-05T12:00:00Z');
const ctx=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,JSON,console,document:{querySelector(){return null;},querySelectorAll(){return [];},documentElement:{classList:{toggle(){}}}},window:{history:{state:null,pushState(){},replaceState(){}},location:{href:'https://iptv.local/',pathname:'/',search:'',hash:''},matchMedia:()=>({matches:false}),addEventListener(){},scrollY:0,scrollTo(){}},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>Promise.reject(new Error('no network'))});
vm.runInContext(AVAILABILITY_LIB+fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
const run=code=>vm.runInContext(code,ctx);
const plain=v=>JSON.parse(JSON.stringify(v));
const retained=(updatedAt,extra={})=>({updatedAt:new Date(updatedAt).toISOString(),publishedAt:new Date(updatedAt).toISOString(),cutoff:updatedAt,window:{from:updatedAt-72*hour,to:updatedAt+168*hour,hotTo:updatedAt+24*hour},stats:{epgEnd:updatedAt+160*hour},...extra});
const legacy=updatedAt=>({updatedAt:new Date(updatedAt).toISOString(),publishedAt:new Date(updatedAt).toISOString(),cutoff:updatedAt,window:{from:updatedAt-72*hour,to:updatedAt+24*hour},stats:{epgEnd:updatedAt+20*hour}});
const setup=(snapshot,clock)=>{ctx.snap=snapshot;run(`report=snap;viewClock=${clock}`);};
const show=(start,channel='Кино')=>({channelId:'c',channel,start,end:start+2*hour});
const film=(shows)=>{ctx.f={id:'f',title:'Фильм',original:'Film',year:2001,genres:['Драма'],runtime:100,directors:[],actors:[],shows};return ctx.f;};
const visible=(period='soon')=>plain(run(`periodShows(f,'${period}')`)).map(item=>item.start);

// Day 5 is retained but hidden now.
const day5=t0+120*hour;
film([show(t0+2*hour),show(day5),show(t0+167*hour)]);
setup(retained(t0),t0);
assert.deepEqual(visible('soon'),[t0+2*hour],'only the next 24 h is shown; day 5 and day 7 stay retained but hidden');
assert.equal(run('isFuture(f.shows[1])'),false);assert.equal(run('isArchive(f.shows[1])'),false);
assert.equal(run('group(f,"future")').includes('1 показ'),true,'the Дальше group counts one show');
assert.equal(run('group(f,"future")').includes('3 показа'),false);
assert.equal(run('showBucket(f.shows[1])'),'x','grouping and period counters put an off-window show in neither bucket');
assert.deepEqual(visible('all'),[t0+2*hour]);

// It appears when the clock reaches 24 h before the airing, with no new EPG sync: the same snapshot, a later clock.
setup(retained(t0),day5-24*hour-1);assert.deepEqual(visible('soon'),[],'one ms before the 24 h edge');
setup(retained(t0),day5-24*hour);assert.deepEqual(visible('soon'),[],'a start exactly 24 h ahead is outside the horizon');
setup(retained(t0),day5-24*hour+1);assert.deepEqual(visible('soon'),[day5],'one ms inside the horizon');
assert.equal(run('group(f,"future")').includes('1 показ'),true);
setup(retained(t0),day5+1);assert.deepEqual(visible('soon'),[day5],'once started it is on air: still «Скоро» until it ends');assert.deepEqual(visible('archive'),[],'a show on air is not an archive yet');
setup(retained(t0),day5+2*hour);assert.deepEqual(visible('soon'),[],'at its end it is no longer soon');assert.deepEqual(visible('archive'),[day5],'and it is archive for 72 h counted from its start');

// Strict boundaries of the rolling window.
film([show(t0-72*hour),show(t0-72*hour+1),show(t0+24*hour-1),show(t0+24*hour)]);
setup(retained(t0),t0);
assert.deepEqual(visible('archive'),[t0-72*hour+1],'exactly 72 h ago has expired');
assert.deepEqual(visible('soon'),[],'a film with a ready archive is not soon because of a repeat');
assert.deepEqual(visible('all'),[t0-72*hour+1,t0+24*hour-1],'the repeat is information; exactly 24 h ahead is outside');
film([show(t0+24*hour-1),show(t0+24*hour)]);setup(retained(t0),t0);
assert.deepEqual(visible('soon'),[t0+24*hour-1],'exactly 24 h ahead is outside');
const model=plain(run('viewingWindow()'));
assert.equal(model.envelope.to,t0+24*hour);assert.equal(model.retained.to,t0+168*hour);assert.equal(model.future.to,t0+24*hour);

// Stale fallback: the refresh was skipped for 40 h. The saved schedule reads on the rolling clock and stays honest.
film([show(t0+50*hour),show(t0+70*hour),show(t0+130*hour)]);
setup(retained(t0),t0+40*hour);
assert.deepEqual(visible('soon'),[t0+50*hour],'now+24h = t0+64h: only the first one is inside');
const stale=plain(run('programmeStatus(viewingWindow())'));
assert.equal(stale.badge,'Данные устарели');assert.match(stale.coverage,/Обновлено 40 ч назад/);
assert.match(stale.coverage,/известные показы до 12 нояб\./,'coverage reads from the feed end (t0+160 h), not from the 24 h display edge');
setup(retained(t0),t0+107*hour);assert.deepEqual(visible('archive'),[t0+50*hour,t0+70*hour],'the two earlier airings are in the 72 h catch-up');
assert.deepEqual(visible('all'),[t0+50*hour,t0+70*hour,t0+130*hour],'the day-6 airing has entered the horizon without any refresh');
film([show(t0+130*hour)]);setup(retained(t0),t0+107*hour);assert.deepEqual(visible('soon'),[t0+130*hour],'alone it is soon');

// Legacy snapshots read exactly as before.
film([show(t0+10*hour),show(t0+30*hour)]);
setup(legacy(t0),t0);
assert.deepEqual(visible('soon'),[t0+10*hour]);
const old=plain(run('viewingWindow()'));assert.equal(old.envelope.to,t0+24*hour);assert.equal(old.retained.to,t0+24*hour);
assert.equal(plain(run('programmeStatus(viewingWindow())')).badge,'Программа актуальна');
setup({updatedAt:new Date(t0).toISOString()},t0);
assert.equal(plain(run('viewingWindow()')).basis,'estimate');assert.deepEqual(visible('soon'),[t0+10*hour],'a snapshot without a window is estimated at the old 24 h');
console.log('AIR-188 display: rolling 72 h / 24 h reader window, hidden day-5 airing appears on a later clock, strict boundaries, stale fallback, grouping and legacy snapshots passed');
