import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const files=new Map(),env={BUCKET:{get:async key=>files.has(key)?{json:async()=>structuredClone(files.get(key))}:null,put:async(key,body)=>{files.set(key,JSON.parse(body));}}};
const ctx=vm.createContext({Map,Set,Date,JSON,Response,URL,env});vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8')+'\n'+fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),ctx);
const old={updatedAt:'old',films:[{id:'a',title:'А',shows:[]}]},report={runId:'run',updatedAt:'2026-10-03T12:00:00Z',watchlistCount:2,films:[{id:'a',title:'А',shows:[{start:1}]},{id:'b',title:'Б',shows:[]}],stats:{uniqueFilms:1,broadcasts:1}},run={runId:'run',stage:'epg',events:[],watchlist:report.films,pending:[]};
files.set('watchlist.json',old);files.set('programme.json',report);files.set('started/a.json',{id:'a',started:true});
assert.equal(ctx.programmeWithWatchlist(report,old),report);
ctx.run=run;ctx.report=report;await vm.runInContext('finishSync(env,run,report)',ctx);
assert.equal(files.get('watchlist.json').updatedAt,report.updatedAt);assert.equal(files.get('watchlist.json').films.length,2);assert.equal(files.get('started/a.json').started,true);assert.equal(run.stage,'complete');assert.equal(vm.runInContext('epgEvent(report,"event")',ctx).films,1);
console.log('Snapshot recovery: complete report remains authoritative, stale secondary copy repaired, started marker preserved');
