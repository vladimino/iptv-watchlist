// A run that ends with one hot film deferred by retry is a normal completion, but not a drained queue:
// the server stores `eligible_queue_empty` from the refreshed outstanding set, the Event snapshot and the
// footer status carry the read-only queue slices (outstanding, eligible now, deferred by retry, earliest
// retry time), and the UI never claims that the queue was processed completely.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0;
const env={BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},list:async()=>({objects:[],truncated:false})}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;const call=code=>vm.runInContext(code,ctx),plain=value=>JSON.parse(JSON.stringify(value));
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};}
const ui=vm.createContext({Date,Intl,URL,Set,Map});vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ui);
const render=(fn,value)=>{ui.value=value;return vm.runInContext(fn+'(value)',ui);};
const now=Date.now(),execution=Object.fromEntries(Object.entries(call('EXECUTION')).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']},prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
const PROFILE={version:7,profileHash:'profile-7',updatedAt:'2026-10-12T18:00:00Z',profile:{ratingScale:'Half stars'}};
const film=(i,start)=>({id:'tmdb_'+i,tmdbId:String(i),title:'Film '+i,original:'Film '+i,year:2020,genres:[],actors:[],directors:[],shows:[{start}]});
const current=id=>({fingerprintHash:'fp-'+id,prediction:{tasteProfileVersion:PROFILE.version,tasteProfileHash:PROFILE.profileHash,fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,predictionPromptVersion:1}});
const FORBIDDEN=/обработана полностью|очередь обработана|пакет завершён/i;
// The production shape: 2287 confirmed films, 1878 in the viewing window; every film but one hot film already has a current prediction.
const HOT=1878,COLD=2287-HOT,catalog={},index={};
for(let i=1;i<=HOT+COLD;i++){const f=film(i,i<=HOT?now:now-10*86400000);catalog[f.id]=f;if(i!==1)index[f.id]=current(f.id);}
records.set('enrichment/profile/current.json',PROFILE);records.set('sync.json',{runId:'programme-1',stage:'complete'});
records.set('programme.json',{runId:'programme-1',updatedAt:new Date(now).toISOString(),films:[],stats:{}});records.set('epg/discovered-films.json',catalog);records.set('enrichment/view-index.json',index);
let start=(await api('start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'})).data;assert.equal(start.status,'running');
let next=(await api('next',{runId:start.runId})).data;assert.equal(next.items.length,1);assert.equal(next.items[0].filmId,'tmdb_1');
const rejected=(await api('submit',{runId:start.runId,items:[{filmId:'tmdb_1',failure:{kind:'parse_error'}}]})).data;assert.equal(rejected.results[0].status,'retryable_failure');assert.equal(rejected.mustComplete,false);
const retryAt=records.get('enrichment/prediction-queue.json').retries.tmdb_1.retryAt;assert(retryAt>now);
next=(await api('next',{runId:start.runId})).data;assert.equal(next.mustComplete,true);assert.equal(next.stopReason,'eligible_queue_empty');assert.equal(next.hotRemaining,1);
// The caller claims queue_empty; the server stores the reason the refreshed outstanding set supports.
const finished=(await api('complete',{runId:start.runId,reason:'queue_empty'})).data;
assert.equal(finished.status,'complete','a deferred run is a normal completion, not an error');assert.equal(finished.reason,null);assert.equal(finished.stopReason,'eligible_queue_empty','queue_empty is reserved for an empty outstanding set');
assert.equal(finished.hotRemaining,1);assert.equal(finished.coldRemaining,0);assert.deepEqual(finished.counts,{created:0,recalculated:0,failed:1,pending:0});
assert.deepEqual(plain(finished.snapshot.queue),{hotPending:1,coldPending:0,outstanding:1,eligibleNow:0,deferredByRetry:1,nextRetryAt:new Date(retryAt).toISOString()});
assert.deepEqual([finished.snapshot.coverage.currentPredictionsTotal,finished.snapshot.coverage.confirmedFilmsTotal,finished.snapshot.coverage.windowCurrentPredictions,finished.snapshot.coverage.windowFilmsTotal],[2286,2287,1877,1878]);
assert.equal(finished.snapshot.coverage.localPercent,99.9);assert.equal(finished.snapshot.coverage.windowPercent,99.9);
const stored=records.get('enrichment/runs/'+start.runId+'.json');assert.equal(stored.stopReason,'eligible_queue_empty');assert.equal(records.get('enrichment/prediction-queue.json').lastBatch.stage,'complete');
// The Event renders from the stored snapshot: one film outstanding, deferred, with its retry time; no "processed completely".
const event=plain([...records].find(([key,value])=>key.startsWith('events/items/')&&value.id==='enrichment-'+start.runId)[1]);
assert.equal(event.stopReason,'eligible_queue_empty');assert.equal(event.stage,'complete');
const eventHTML=render('eventHTML',event);
assert.match(eventHTML,/Прогнозы обновлены/);assert.match(eventHTML,/Локальная база: 2286 из 2287 · 99,9%/);assert.match(eventHTML,/Окно просмотра: 1877 из 1878 · 99,9%/);
assert.match(eventHTML,/Остался 1 фильм без актуального прогноза\. Ожидает повторной попытки не раньше (\d+ [а-я]+\., )?\d{2}:\d{2}/);
assert.doesNotMatch(eventHTML,FORBIDDEN);assert.doesNotMatch(eventHTML,/приостановлен|прерван|ошибка/);
// The footer reads the same slices from the stored queue, read-only, and keeps the schedule estimate apart from the film retry time.
const writesBefore=revision;
const footer=await (await ctx.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json();
assert.equal(revision,writesBefore,'footer status is read-only');
assert.equal(footer.lastRun.status,'completed');assert.equal(footer.lastRun.reason,'eligible_queue_empty');
assert.deepEqual({pendingHot:footer.predictions.pendingHot,pendingCold:footer.predictions.pendingCold,outstanding:footer.predictions.outstanding,eligibleNow:footer.predictions.eligibleNow,deferredByRetry:footer.predictions.deferredByRetry,nextRetryAt:footer.predictions.nextRetryAt},{pendingHot:1,pendingCold:0,outstanding:1,eligibleNow:0,deferredByRetry:1,nextRetryAt:new Date(retryAt).toISOString()});
assert.notEqual(footer.predictions.nextRetryAt,footer.predictions.nextScheduledRun);
const footerText=render('footerStatusText',footer);
assert.match(footerText.runLine,/^завершён · 1 фильм ожидает повторной попытки не раньше /);assert.match(footerText.runResult,/^завершён · 1 фильм ожидает повторной попытки/);assert.equal(footerText.nextBatch,'ждёт повторной попытки');assert.match(footerText.deferred,/^1 фильм · не раньше /);
assert.match(footerText.local,/^2[\s  ]?286\/2[\s  ]?287 с актуальным прогнозом · 99,9%$/);assert.match(footerText.windowCoverage,/^1[\s  ]?877\/1[\s  ]?878 с актуальным прогнозом · 99,9%$/);
for(const value of Object.values(footerText))if(typeof value==='string')assert.doesNotMatch(value,FORBIDDEN);
assert.doesNotMatch(JSON.stringify(footer),FORBIDDEN);assert.doesNotMatch(JSON.stringify(footer),/Film 1|Bearer|token/);
// The diagnostics tool reads the same picture: not drained, temporarily ineligible, one deferred film.
const overview=call('predictionQueueOverview')({queueStatus:'recorded',queue:records.get('enrichment/prediction-queue.json'),programmeStatus:'recorded',programme:records.get('programme.json'),profileStatus:'recorded',profile:PROFILE,indexStatus:'recorded',index,catalogStatus:'recorded',catalog,publishedGenerationStatus:'not_recorded',publishedGeneration:null},Date.now());
assert.equal(overview.state,'temporarily_ineligible');assert.equal(overview.cause,'retry_backoff');assert.equal(overview.pending.deferredByRetry,1);assert.equal(overview.pending.nextRetryAt,finished.snapshot.queue.nextRetryAt);
// Once the retry matures and the film is predicted, the next run drains the queue and says so.
records.get('enrichment/prediction-queue.json').retries.tmdb_1.retryAt=0;
start=(await api('start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'})).data;assert.equal(start.status,'running');
next=(await api('next',{runId:start.runId})).data;assert.equal(next.items[0].filmId,'tmdb_1');
await api('submit',{runId:start.runId,items:[{filmId:'tmdb_1',fingerprint,prediction}]});
next=(await api('next',{runId:start.runId})).data;assert.equal(next.stopReason,'queue_empty');
const drained=(await api('complete',{runId:start.runId,reason:next.stopReason})).data;
assert.equal(drained.stopReason,'queue_empty');assert.deepEqual(plain(drained.snapshot.queue),{hotPending:0,coldPending:0,outstanding:0,eligibleNow:0,deferredByRetry:0,nextRetryAt:null});
assert.equal(drained.snapshot.coverage.currentPredictionsTotal,2287);assert.equal(drained.snapshot.coverage.localPercent,100);
const drainedHTML=render('eventHTML',plain([...records].find(([key,value])=>key.startsWith('events/items/')&&value.id==='enrichment-'+start.runId)[1]));
assert.match(drainedHTML,/Все фильмы с актуальными прогнозами\./);assert.doesNotMatch(drainedHTML,/без (актуального )?прогноза|повторной попытки/);
const drainedFooter=render('footerStatusText',await (await ctx.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env)).json());
assert.equal(drainedFooter.runLine,'завершён · все фильмы с актуальными прогнозами');assert.equal(drainedFooter.deferred,'нет');assert.equal(drainedFooter.nextBatch,'очередь пуста');
console.log('Deferred completion status: one hot film deferred by retry → eligible_queue_empty with 2286/2287 and 1877/1878, queue slices in the Event snapshot and footer, honest UI texts without "processed completely", read-only footer, diagnostics agreement, and a drained queue after the retry passed');
