// AIR-579: `prediction_pending` reads the stored queue only. Its page function takes `queue` and `queueStatus` of a snapshot and nothing else, so the
// whole-catalog read (`readCatalog`) and the other five reads of the full diagnostic snapshot were pure waste. Before and after: statements and catalog
// reads of the same call, and the page, byte for byte, for the same stored queue. Real Worker in a vm over a D1 stand-in at the real schema; no
// Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld} from './prediction-d1-flow-lib.mjs';

const world=await flowWorld({films:30});
vm.runInContext(fs.readFileSync('src/prediction-diagnostics.js','utf8').replace(/^export /gm,''),world.ctx);
const CATALOG=/FROM discovery_admission WHERE state='current' ORDER BY film_id/;
let catalogReads=0,statements=0,failAll=false,failCatalog=false;
world.hooks.query=text=>{
 statements++;
 if(CATALOG.test(text)){catalogReads++;if(failCatalog)throw new Error('D1_ERROR: catalog unavailable');}
 if(failAll)throw new Error('D1_ERROR: unavailable');
};
const full=vm.runInContext('loadPredictionDiagnosticSnapshot',world.ctx);
const queueOnly=vm.runInContext('loadPredictionQueueSnapshot',world.ctx);
const page=(snapshot,args,now)=>vm.runInContext('predictionPendingPage',world.ctx)(snapshot,args,now);
const plain=value=>JSON.parse(JSON.stringify(value));
const measure=async loader=>{catalogReads=0;statements=0;const snapshot=await loader(world.env);return {snapshot,catalogReads,statements};};
const NOW=Date.now();

// A real stored queue: 30 admitted films, all cold, then one of them with a retry record so the lanes differ.
assert.equal((await world.api('queue/reconcile',{})).status,200);

// Before and after: the same call, the same stored queue.
const before=await measure(full),after=await measure(queueOnly);
console.log(JSON.stringify({before:{statements:before.statements,catalogReads:before.catalogReads},after:{statements:after.statements,catalogReads:after.catalogReads}}));
assert.equal(before.catalogReads,1,'the full snapshot reads the whole catalog once');
assert.equal(after.catalogReads,0,'the pending snapshot never reads the catalog');
assert.ok(after.statements<before.statements,'fewer statements: '+after.statements+' against '+before.statements);
assert.equal(after.snapshot.queueStatus,'recorded');
assert.equal(after.snapshot.queue?.coldPending?.length>0||after.snapshot.queue?.hotPending?.length>0,true,'a non-empty queue is the baseline');
assert.deepEqual(plain(after.snapshot.queue),plain(before.snapshot.queue),'the queue is read exactly as before');

// Parity of the page for every filter and for paging, from the two snapshots.
const cases=[{},{filter:'all'},{filter:'eligible'},{filter:'deferred'},{filter:'exhausted'},{limit:7},{filter:'all',limit:1}];
for(const args of cases)assert.deepEqual(plain(page(after.snapshot,args,NOW)),plain(page(before.snapshot,args,NOW)),'page parity '+JSON.stringify(args));
const first=page(after.snapshot,{limit:7},NOW);
assert.ok(first.nextCursor,'the queue spans more than one page');
for(let cursor=first.nextCursor,guard=0;cursor&&guard<10;guard++){
 const next=page(after.snapshot,{limit:7,cursor},NOW);
 assert.deepEqual(plain(next),plain(page(before.snapshot,{limit:7,cursor},NOW)),'cursor parity');
 cursor=next.nextCursor;
}
assert.deepEqual(plain(page(after.snapshot,{limit:7,cursor:'not-a-cursor'},NOW)),plain(page(before.snapshot,{limit:7,cursor:'not-a-cursor'},NOW)),'a bad cursor answers the same');

// By construction: the page function touches nothing of the snapshot but the queue and its status.
const guarded=new Proxy({queue:after.snapshot.queue,queueStatus:after.snapshot.queueStatus},{get(target,key){if(key==='queue'||key==='queueStatus')return target[key];throw new Error('the pending page read snapshot.'+String(key));}});
for(const args of cases)assert.deepEqual(plain(page(guarded,args,NOW)),plain(page(before.snapshot,args,NOW)),'only the queue is read '+JSON.stringify(args));

// The catalog is no input: an unreadable catalog (and a superseded admission set) changes the full snapshot's catalog status and never the pending page.
await world.env.DB.prepare("UPDATE discovery_admission SET state='superseded' WHERE film_id IN ('tmdb_1','tmdb_2')").run();
failCatalog=true;
const catalogDown=await measure(full);
assert.equal(catalogDown.snapshot.catalogStatus,'unavailable','the full snapshot reports an unreadable catalog');
const queueWithCatalogDown=await measure(queueOnly);
failCatalog=false;
assert.equal(queueWithCatalogDown.catalogReads,0);
assert.deepEqual(plain(page(queueWithCatalogDown.snapshot,{},NOW)),plain(page(before.snapshot,{},NOW)),'an unreadable catalog and a superseded admission do not change the page');

// A queue that cannot be read is `unavailable` in both snapshots, and a queue that was never stored is `not_recorded` in both; the page answers the same.
failAll=true;
const unreadable=await measure(queueOnly),unreadableFull=await measure(full);
failAll=false;
assert.equal(unreadable.snapshot.queueStatus,'unavailable');assert.equal(unreadableFull.snapshot.queueStatus,'unavailable');
assert.deepEqual(plain(page(unreadable.snapshot,{},NOW)),plain(page(unreadableFull.snapshot,{},NOW)));
// Never stored: a second world that never built a queue.
const empty=await flowWorld({films:30});
vm.runInContext(fs.readFileSync('src/prediction-diagnostics.js','utf8').replace(/^export /gm,''),empty.ctx);
const emptyQueue=await vm.runInContext('loadPredictionQueueSnapshot',empty.ctx)(empty.env),emptyFull=await vm.runInContext('loadPredictionDiagnosticSnapshot',empty.ctx)(empty.env);
assert.equal(emptyQueue.queueStatus,'not_recorded');assert.equal(emptyFull.queueStatus,'not_recorded');
assert.deepEqual(plain(vm.runInContext('predictionPendingPage',empty.ctx)(emptyQueue,{},NOW)),plain(vm.runInContext('predictionPendingPage',empty.ctx)(emptyFull,{},NOW)));

// The route: only `prediction_pending` moved to the queue snapshot; the overview and the film diagnostic still need the full one.
const mcp=fs.readFileSync('src/mcp.js','utf8');
assert.match(mcp,/predictionPendingPage\(await loadPredictionQueueSnapshot\(env\),args,now\)/);
assert.match(mcp,/predictionFilmDiagnostic\(await loadPredictionDiagnosticSnapshot\(env,args\.filmId\)/);
assert.match(mcp,/predictionQueueOverview\(await loadPredictionDiagnosticSnapshot\(env\),now\)/);
assert.doesNotMatch(mcp,/predictionPendingPage\(await loadPredictionDiagnosticSnapshot/);
console.log('prediction pending queue-only ok');
