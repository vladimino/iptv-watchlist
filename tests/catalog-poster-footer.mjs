// AIR-543 / ADR 0179. The footer source `posters` (server) and its client rendering (both footer renderers) and the `catalog_posters` Events card.
// The source is one projection of the B1 checkpoint: every state maps to the documented integration state, absent or unreadable evidence is never
// healthy, a normal no-poster verdict is never a fault, and the GET writes nothing.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,plain,g} from './ratings-harness.mjs';

const H=3600000,at=ms=>new Date(ms).toISOString(),T0=Date.parse('2026-11-17T10:00:00Z'),MON='monitor/state.json',CP='epg/catalog-poster-weekly.json';
function setup(extra={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 vm.runInContext(scoped('src/catalog-poster-weekly.js','CatalogPosterWeekly'),ctx);
 return {bucket,ctx,env:baseEnv(bucket,{MONITOR:'on',...extra})};
}
const cp=(over={})=>({schemaVersion:1,runId:'catalog_posters-2026-11-15',weekStart:'2026-11-15T00:00:00.000Z',status:'completed',lastScheduledAt:'2026-11-15T03:24:00.000Z',lastAttemptAt:'2026-11-15T03:24:00.000Z',lastCompletedAt:'2026-11-15T03:24:00.000Z',cursor:null,nextRetryAt:null,retryAttempts:0,rateLimitStreak:0,deferredReported:false,summary:{scanned:9,due:5,checked:5,hydrated:0,noPoster:3,retryable:0,deferredBusy:0,pending:0,rateLimit:false,durationMs:10},outbox:[],...over});
const posters=async(ctx,env)=>{const body=plain(await ctx.footerStatus(env));return {body,source:body.integrations.sources.find(item=>item.id==='posters')};};

const CASES=[
 ['healthy_idle',{cp:cp()},['healthy','poster_idle']],
 ['healthy_idle with hydration',{cp:cp({summary:{...cp().summary,hydrated:2}})},['healthy','poster_hydrated']],
 ['grace',{markers:{catalogPostersBaselineAt:at(T0-H)}},['waiting','poster_first_run']],
 ['waiting',{cp:cp({status:'pending',weekStart:'2026-11-15T00:00:00.000Z',nextRetryAt:at(T0+2*H),cursor:'c',summary:{...cp().summary,pending:4}})},['waiting','poster_retry_scheduled']],
 ['overdue (no first checkpoint)',{markers:{catalogPostersBaselineAt:at(T0-10*24*H)}},['degraded','poster_overdue']],
 ['stalled',{cp:cp({status:'pending',nextRetryAt:at(T0-40*H),cursor:'c'})},['degraded','poster_stalled']],
 ['lost',{markers:{catalogPostersBaselineAt:at(T0-9*24*H),catalogPostersSeenAt:at(T0-3*24*H)}},['degraded','poster_lost']],
 ['failed',{cp:cp({status:'failed',retryAttempts:6})},['failed','poster_failed']],
 ['unknown (corrupt checkpoint)',{cp:{schemaVersion:99}},['unknown','no_data']],
];
for(const [name,spec,[state,code]] of CASES){
 const {ctx,env,bucket}=setup();
 if(spec.cp)bucket.set(CP,spec.cp);
 bucket.set(MON,{schemaVersion:1,...(spec.markers||{})});
 const before=JSON.stringify(bucket.snapshot());
 const {body,source}=await posters(ctx,env);
 assert.deepEqual([source.state,source.code,source.role],[state,code,'source'],name);
 assert.equal(body.integrations.sources.length,6+(body.integrations.sources.some(item=>item.id==='metadata')?1:0),name+': six sources (a seventh only for the metadata attention)');
 assert.equal(JSON.stringify(bucket.snapshot()),before,name+': the footer GET writes nothing');
 if(state==='healthy'||state==='waiting')assert.ok(['healthy','attention'].includes(body.integrations.aggregate));
 if(['degraded','failed','unknown'].includes(state))assert.notEqual(body.integrations.aggregate,'healthy',name+': a bad or unknown poster source is never a healthy aggregate');
 if(state==='failed')assert.equal(body.integrations.aggregate,'failed',name);
 if(state==='unknown')assert.equal(source.lastSuccessAt,null,name+': no invented success');
}
// Counts, next attempt and a truthful freshness: lastSuccessAt only for a completed, healthy receipt.
{
 const {ctx,env,bucket}=setup();bucket.set(MON,{schemaVersion:1});
 bucket.set(CP,cp({summary:{...cp().summary,hydrated:2}}));
 let {source}=await posters(ctx,env);
 assert.deepEqual(source.lastWeek,{weekStart:'2026-11-15T00:00:00.000Z',checked:5,hydrated:2,noPoster:3,pending:0});
 assert.equal(source.lastSuccessAt,'2026-11-15T03:24:00.000Z');assert.equal(source.freshnessAt,'2026-11-15T03:24:00.000Z');assert.equal(source.lastFailureAt,null);
 assert.equal(source.nextAttemptAt,'2026-11-22T03:24:00.000Z');
 bucket.set(CP,cp({status:'pending',nextRetryAt:at(T0+2*H),cursor:'c'}));
 source=(await posters(ctx,env)).source;
 assert.equal(source.lastSuccessAt,null,'a pending run is not a success');assert.equal(source.nextAttemptAt,at(T0+2*H));
 bucket.set(CP,cp({summary:{...cp().summary,due:5,checked:5,hydrated:0,noPoster:5}}));
 source=(await posters(ctx,env)).source;
 assert.deepEqual([source.state,source.code],['healthy','poster_idle'],'a week of only no-poster verdicts is not a fault');
}
// Monitor off: absence reads unknown, never grace/green.
{
 const {ctx,env,bucket}=setup({MONITOR:'off'});bucket.set(MON,{schemaVersion:1});
 const {source,body}=await posters(ctx,env);
 assert.deepEqual([source.state,source.code],['unknown','no_data']);assert.notEqual(body.integrations.aggregate,'healthy');
}
// An unreadable checkpoint read leaves the source unknown, never healthy and never dropped.
{
 const {ctx,env,bucket}=setup();bucket.set(MON,{schemaVersion:1});
 const real=env.BUCKET.get.bind(env.BUCKET);env.BUCKET.get=async key=>{if(key===CP)throw new Error('r2 down');return real(key);};
 const {source}=await posters(ctx,env);assert.deepEqual([source.state,source.code],['unknown','no_data']);
}

// Client: both footer renderers give the same six rows and copy; the new row is in all three markups.
const html=fs.readFileSync('public/index.html','utf8'),inject=fs.readFileSync('public/status-footer.js','utf8'),app=fs.readFileSync('public/app.js','utf8');
for(const [name,text] of [['index.html',html],['status-footer.js',inject]])assert.match(text,/<div data-integration="posters"[^>]*><dt>Постеры<\/dt><dd id="integration-posters">/,name+': the Постеры row');
for(const [name,text] of [['app.js',app],['status-footer.js',inject]]){
 assert.match(text,/\['integration-posters','posters'\]/,name);
 for(const code of ['poster_idle','poster_hydrated','poster_first_run','poster_retry_scheduled','poster_overdue','poster_stalled','poster_lost','poster_failed'])assert.match(text,new RegExp(code+':'),name+' '+code);
}
const unwrapped=inject.replace(/^\(\(\) => \{/m,'').replace(/\}\)\(\);\s*$/,''),appJs=app.replace(/init\(\);\s*$/,'');
const line=(source,file)=>{
 const context=vm.createContext({Date,Intl,URL,Set,Map,document:{querySelector:()=>null,body:null,addEventListener(){}},setInterval(){}});
 vm.runInContext(file,context);
 context.input={generatedAt:'2026-11-17T10:00:00Z',integrations:{aggregate:'attention',sources:[source]}};
 return vm.runInContext('footerStatusText(input)',context).integrations.posters;
};
const stateless={id:'posters',role:'source',lastSuccessAt:null,lastFailureAt:null,freshnessAt:null,nextAttemptAt:null,lastWeek:null};
const expectations=[
 [{state:'healthy',code:'poster_idle',lastSuccessAt:'2026-11-15T03:24:00.000Z',freshnessAt:'2026-11-15T03:24:00.000Z',lastWeek:{checked:5,hydrated:0,noPoster:3,pending:0},nextAttemptAt:'2026-11-22T03:24:00.000Z'},/^работает/,/проверено 5 · новых постеров 0 · без постера 3 · ждут 0/],
 [{state:'waiting',code:'poster_retry_scheduled',nextAttemptAt:'2026-11-17T12:00:00.000Z'},/^ожидает · повторная попытка запланирована/,/следующая попытка/],
 [{state:'waiting',code:'poster_first_run'},/первая проверка ещё впереди/,/./],
 [{state:'degraded',code:'poster_overdue'},/^требует внимания · еженедельная проверка не выполнена вовремя/,/./],
 [{state:'degraded',code:'poster_stalled'},/зависла или отчёт не доставлен/,/./],
 [{state:'degraded',code:'poster_lost'},/пропали/,/./],
 [{state:'failed',code:'poster_failed'},/^сбой · проверка постеров не удалась/,/./],
 [{state:'unknown',code:'no_data'},/^нет данных$/,/^нет данных$/],
];
for(const [source,first,second] of expectations){
 const a=line({...stateless,...source},appJs),b=line({...stateless,...source},unwrapped);
 assert.equal(a,b,'the two footer renderers agree for '+source.code);assert.match(a,first);assert.match(a,second);
}
{
 const context=vm.createContext({Date,Intl,URL,Set,Map});vm.runInContext(app.replace(/init\(\);\s*$/,''),context);
 context.input={generatedAt:'2026-11-17T10:00:00Z',integrations:{aggregate:'healthy',sources:[]}};
 assert.equal(vm.runInContext('footerStatusText(input)',context).integrations.posters,'','an older server without the source hides the row rather than inventing one');
}

// Events: card, filter and detail for completed, deferred and failed; nothing stored reaches the page as markup.
const ctx=vm.createContext({Date,Intl,URL,Set,Map});vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+app.replace(/init\(\);\s*$/,''),ctx);
const base={id:'catalog_posters:2026-11-15T00:00:00.000Z:final',type:'catalog_posters',at:'2026-11-15T03:30:00.000Z',outcome:'completed',final:true,weekStart:'2026-11-15T00:00:00.000Z',runId:'catalog_posters-2026-11-15',scanned:9,due:5,checked:5,hydrated:2,noPoster:3,retryable:0,deferredBusy:0,pending:0,rateLimit:false,durationMs:1200};
const card=event=>{ctx.ev=event;return vm.runInContext('eventHTML(ev)',ctx);};
let card1=card(base);
assert.match(card1,/Постеры каталога проверены/);assert.match(card1,/<dt>Проверено<\/dt><dd>5<\/dd>/);assert.match(card1,/<dt>Постеров добавлено<\/dt><dd>2<\/dd>/);assert.match(card1,/<dt>Нет постера на TMDB<\/dt><dd>3<\/dd>/);assert.match(card1,/data-event-id="catalog_posters:/);assert.match(card1,/<time datetime="2026-11-15T03:30:00.000Z">/);assert.match(card1,/не ошибка/);
card1=card({...base,id:'catalog_posters:2026-11-15T00:00:00.000Z:deferred',outcome:'deferred',final:false,pending:4,retryable:1,deferredBusy:1,nextRetryAt:'2026-11-17T12:00:00.000Z'});
assert.match(card1,/Проверка постеров отложена/);assert.match(card1,/не итог недели/);assert.match(card1,/Следующая попытка не раньше/);assert.match(card1,/<dt>Ещё в очереди<\/dt><dd>4<\/dd>/);assert.doesNotMatch(card1,/проверены/,'a deferred report is never shown as final success');
card1=card({...base,outcome:'failed',final:true});
assert.match(card1,/не удалась/);assert.match(card1,/нужно внимание владельца/);assert.doesNotMatch(card1,/Постеры каталога проверены/);
card1=card({...base,checked:null,noPoster:'<img src=x onerror=1>',runId:'<script>'});
assert.match(card1,/<dt>Проверено<\/dt><dd>неизвестно<\/dd>/);assert.doesNotMatch(card1,/<img|<script|onerror|catalog_posters-2026/,'unknown counts are not 0 and stored text is not markup; no run id or raw log');
assert.ok(vm.runInContext("EVENT_TYPE_FILTERS.some(f=>f.id==='catalog_posters'&&f.types.includes('catalog_posters')&&f.label==='Постеры')",ctx),'the type filter');
assert.match(html,/data-event-type="catalog_posters" aria-pressed="false">Постеры</);
console.log('catalog-poster-footer: every poster state maps to the footer source, unknown and degraded are never healthy, no GET write, both footer renderers agree, and the catalog_posters card shows completed, deferred and failed truthfully');
