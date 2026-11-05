// AIR-188: the UI tells a fresh programme, a stale one that still has known future shows, and no known shows apart.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const hour=3600000,t0=Date.parse('2026-11-05T12:00:00Z');
const ctx=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,JSON,console,document:{querySelector(){return null;},querySelectorAll(){return [];},documentElement:{classList:{toggle(){}}}},window:{history:{state:null,pushState(){},replaceState(){}},location:{href:'https://iptv.local/',pathname:'/',search:'',hash:''},matchMedia:()=>({matches:false}),addEventListener(){},scrollY:0,scrollTo(){}},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>Promise.reject(new Error('no network'))});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
const run=code=>vm.runInContext(code,ctx);
const snapshot=(updatedAt,extra={})=>JSON.stringify({updatedAt:new Date(updatedAt).toISOString(),cutoff:updatedAt,window:{from:updatedAt-72*hour,to:updatedAt+168*hour,hotTo:updatedAt+24*hour},stats:{epgEnd:updatedAt+150*hour},...extra});
const status=(updatedAt,now,extra)=>{run(`report=${snapshot(updatedAt,extra)}`);return JSON.parse(JSON.stringify(run(`programmeStatus(effectiveWindow(report,${now}))`)));};

// The programme window of a seven-day snapshot keeps its own cutoff, not the old "window end minus 24 h".
const win=JSON.parse(JSON.stringify(run(`programmeWindow(${snapshot(t0)})`)));
assert.deepEqual(win,{start:t0-72*hour,cutoff:t0,end:t0+168*hour});
// A legacy 96-hour snapshot still reads as before.
assert.deepEqual(JSON.parse(JSON.stringify(run(`programmeWindow({updatedAt:new Date(${t0}).toISOString(),window:{from:${t0}-72*${hour},to:${t0}+24*${hour}}})`))),{start:t0-72*hour,cutoff:t0,end:t0+24*hour});

// Fresh: says how old the data is and where the known programme ends (the last show the feed had, not the window edge).
const fresh=status(t0,t0+2*hour);
assert.equal(fresh.level,'ok');assert.equal(fresh.badge,'Программа актуальна');assert.match(fresh.coverage,/обновлено 2 ч назад/);
assert.match(fresh.coverage,/Программа до 11 нояб/,'the known end is the last show of the feed (150 h), not the 168 h window edge');

// Skipped refresh: the saved future is still shown until it runs out, marked stale with the age and the remaining coverage.
const stale=status(t0,t0+40*hour);
assert.equal(stale.level,'warning');assert.equal(stale.badge,'Данные устарели');
assert.match(stale.coverage,/Обновлено 40 ч назад/);assert.match(stale.coverage,/осталось 4 дн/,'remaining coverage = last known show (150 h) minus 40 h = 110 h, said in days');
assert.match(stale.title,/последней целостной публикации/);
// Two days old reads in days.
assert.match(status(t0,t0+60*hour).coverage,/Обновлено 2 дн назад/);assert.match(status(t0,t0+72*hour).coverage,/Обновлено 3 дн назад/);

// Channels with a shallower feed: the known end is the feed's last show, never the window edge.
const shallow=status(t0,t0+2*hour,{stats:{epgEnd:t0+30*hour}});
assert.match(shallow.coverage,/осталось|до /);assert.doesNotMatch(shallow.coverage,/осталось 1[0-9]{2} ч/);
// A feed whose last show already started: the saved window may still run ahead, but no future schedule is known.
const feedBehind=status(t0,t0+1*hour,{stats:{epgEnd:t0-hour}});
assert.equal(feedBehind.level,'warning');assert.equal(feedBehind.badge,'Будущей программы нет','a fresh snapshot with a shallow feed that ends before now');
assert.match(feedBehind.coverage,/Лента закончилась/);assert.match(feedBehind.coverage,/расписание дальше неизвестно/);assert.doesNotMatch(feedBehind.coverage,/Программа до|известные показы до|осталось/);
assert.match(feedBehind.coverage,/Архив с/,'the archive stays available');assert.match(feedBehind.coverage,/Обновлено 1 ч назад/);
assert.match(feedBehind.title,/не додумывается/);
const staleBehind=status(t0,t0+40*hour,{stats:{epgEnd:t0+30*hour}});
assert.equal(staleBehind.badge,'Будущей программы нет','a stale snapshot whose feed end is behind now');
assert.match(staleBehind.coverage,/Обновлено 40 ч назад/,'the age warning is kept');assert.doesNotMatch(staleBehind.coverage,/известные показы до/);
// Feed end exactly at now: the last show has just started, nothing is ahead.
assert.equal(status(t0,t0+30*hour,{stats:{epgEnd:t0+30*hour}}).badge,'Будущей программы нет');
// A stale snapshot with a real future show keeps the stale warning and the remaining known coverage.
const staleReal=status(t0,t0+40*hour,{stats:{epgEnd:t0+100*hour}});
assert.equal(staleReal.badge,'Данные устарели');assert.match(staleReal.coverage,/осталось 2 дн/,'60 h remain of the known feed');assert.doesNotMatch(staleReal.coverage,/Лента закончилась/);
// The retained edge is never used to invent coverage: a feed longer than the window still ends at the window.
assert.match(status(t0,t0+2*hour,{stats:{epgEnd:t0+400*hour}}).coverage,/Программа до 12 нояб/);
// A snapshot without a feed end (legacy) reads as before.
const noEnd=JSON.parse(JSON.stringify(run(`(report=${snapshot(t0,{stats:{}})},programmeStatus(effectiveWindow(report,${t0+2*hour})))`)));
assert.equal(noEnd.badge,'Программа актуальна');

// Truly nothing known: the saved window is over.
const over=status(t0,t0+250*hour);
assert.equal(over.level,'critical');assert.equal(over.badge,'Нет актуального окна');
const ended=status(t0,t0+170*hour);
assert.equal(ended.badge,'Будущее закончилось');
console.log('AIR-188 UI: fresh, stale with remaining coverage, shallow feed, ended future and the 7-day programme window passed');
