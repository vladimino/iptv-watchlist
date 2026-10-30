import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('src/prediction-diagnostics.js','utf8');
assert.doesNotMatch(source,/\b(fetch|import|export|BUCKET|wrangler)\b/);
assert.doesNotMatch(source,/chris-pratt|Крис Прэтт|example\.invalid/);

const context=vm.createContext({Date,Map,Set,JSON,encodeURIComponent,decodeURIComponent});
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
const NOW=Date.parse('2026-10-24T08:00:00.000Z');
const PROFILE={version:3,profileHash:'hash-zz',updatedAt:'2026-10-24T07:00:00.000Z',profile:'CANARY-PROFILE-TEXT'};
const IDS=['film-zz-1','film-zz-2','film-zz-3','film-zz-4','film-zz-5'];
const queue=(extra={})=>({schemaVersion:3,profileVersion:3,profileHash:'hash-zz',programmeRunId:'run-zz',refreshedAt:'2026-10-24T08:00:00.000Z',hotPending:[],coldPending:[],pending:[],priorityCount:0,retries:{},...extra});
const snap=(over={})=>({queue:queue(),queueStatus:'recorded',profile:PROFILE,profileStatus:'recorded',index:{},indexStatus:'recorded',programme:{runId:'run-zz',films:[]},programmeStatus:'recorded',catalog:{},catalogStatus:'recorded',publishedGeneration:{programmeRunId:'run-zz',phase:'published'},publishedGenerationStatus:'recorded',films:{},...over});
const retry=(at,extra={})=>({kind:'validation_error',scope:'item',attempts:2,failedAt:NOW-1000,retryAt:at,lastRunId:'run-zz-retry',...extra});
const fingerprint={fingerprintSchemaVersion:1,fingerprintHash:'fp-zz',plotMechanics:['CANARY-PLOT'.repeat(4000)]};
const currentPrediction={tasteProfileVersion:3,tasteProfileHash:'hash-zz',fingerprintHash:'fp-zz',fingerprintSchemaVersion:1,predictionPromptVersion:1,mainRisk:'CANARY-RISK'};
const calls=(name,...args)=>context[name](...args);

const deferred=Object.fromEntries(IDS.map(id=>[id,retry(NOW+3600000,id==='film-zz-2'?{kind:'Error: Bearer CANARY-TOKEN\nstack'}:{})]));
const five=snap({queue:queue({hotPending:[...IDS],coldPending:[],pending:[...IDS],priorityCount:5,retries:deferred})});
const overview=calls('predictionQueueOverview',five,NOW);
assert.equal(overview.state,'temporarily_ineligible');
assert.equal(overview.cause,'retry_backoff');
assert.equal(overview.pending.total,5);
assert.equal(overview.pending.hot,5);
assert.equal(overview.pending.cold,0);
assert.equal(overview.pending.eligibleNow,0);
assert.equal(overview.pending.deferredByRetry,5);
assert.equal(overview.pending.nextRetryAt,'2026-10-24T09:00:00.000Z');
assert.equal(overview.atomic,false);
assert.equal(overview.coverage.status,'recorded');
assert.equal(overview.coverage.total,0);
assert.equal(overview.coverage.percent,null);
assert.equal(overview.snapshot.consistent,true);

const drained=calls('predictionQueueOverview',snap(),NOW);
assert.equal(drained.state,'drained');
assert.equal(drained.pending.eligibleNow,0);
assert.equal(drained.pending.deferredByRetry,0);
assert.equal(drained.pending.nextRetryAt,null);

const missingQueue=calls('predictionQueueOverview',snap({queue:null,queueStatus:'not_recorded'}),NOW);
assert.equal(missingQueue.state,'unavailable');
assert.equal(missingQueue.cause,'queue_not_recorded');
assert.equal(missingQueue.pending.total,null);
assert.equal(missingQueue.coverage.status,'recorded');
const unavailableQueue=calls('predictionQueueOverview',snap({queue:null,queueStatus:'unavailable'}),NOW);
assert.equal(unavailableQueue.state,'unavailable');
assert.equal(unavailableQueue.cause,'queue_unavailable');
assert.equal(unavailableQueue.coverage.status,'recorded');

const mixedRetries={ 'film-zz-ready':retry(NOW-1000), 'film-zz-wait':retry(NOW+60000), 'film-zz-cold':retry(NOW-1000) };
const mixed=snap({queue:queue({hotPending:['film-zz-ready','film-zz-wait'],coldPending:['film-zz-cold'],pending:['film-zz-ready','film-zz-wait','film-zz-cold'],priorityCount:2,retries:mixedRetries})});
const mixedOverview=calls('predictionQueueOverview',mixed,NOW);
assert.equal(mixedOverview.state,'eligible');
assert.equal(mixedOverview.pending.total,3);
assert.equal(mixedOverview.pending.eligibleNow,1);
assert.equal(mixedOverview.pending.deferredByRetry,1);
assert.equal(mixedOverview.pending.nextRetryAt,'2026-10-24T08:01:00.000Z');

const behind=snap({queue:queue({hotPending:['film-zz-wait'],coldPending:['film-zz-cold'],pending:['film-zz-wait','film-zz-cold'],priorityCount:1,retries:{'film-zz-wait':retry(NOW+60000)}})});
assert.equal(calls('predictionQueueOverview',behind,NOW).state,'temporarily_ineligible');
assert.equal(calls('predictionQueueOverview',behind,NOW).cause,'retry_backoff');
const coldOnly=snap({queue:queue({hotPending:[],coldPending:['film-zz-cold'],pending:['film-zz-cold'],priorityCount:0})});
const coldOverview=calls('predictionQueueOverview',coldOnly,NOW);
assert.equal(coldOverview.state,'eligible');
assert.equal(coldOverview.pending.eligibleNow,1);

const shifted=snap({queue:queue({programmeRunId:'run-other',profileVersion:2,profileHash:'other-hash'})});
const shiftedOverview=calls('predictionQueueOverview',shifted,NOW);
assert.equal(shiftedOverview.snapshot.consistent,false);
assert.equal(shiftedOverview.snapshot.partial,true);
assert.ok(shiftedOverview.snapshot.reasons.includes('queue_programme_differs'));
assert.ok(shiftedOverview.snapshot.reasons.includes('profile_version_differs'));
assert.ok(shiftedOverview.snapshot.reasons.includes('profile_hash_differs'));
const unpublished=snap({publishedGeneration:{programmeRunId:'run-other',phase:'building'}});
const unpublishedOverview=calls('predictionQueueOverview',unpublished,NOW);
assert.ok(unpublishedOverview.snapshot.reasons.includes('published_generation_differs'));
assert.ok(unpublishedOverview.snapshot.reasons.includes('generation_not_published'));
const aheadIndex={[IDS[0]]:{fingerprintHash:'fp-zz',prediction:currentPrediction}};
const ahead=snap({queue:five.queue,index:aheadIndex});
assert.ok(calls('predictionQueueOverview',ahead,NOW).snapshot.reasons.includes('index_ahead_of_queue'));

const coveredFilm={id:'film-zz-done',tmdbId:'900001',shows:[{start:NOW}]};
const covered=snap({programme:{runId:'run-zz',films:[coveredFilm]},index:{'film-zz-done':{fingerprintHash:'fp-zz',prediction:currentPrediction}}});
const coveredOverview=calls('predictionQueueOverview',covered,NOW);
assert.equal(coveredOverview.coverage.current,1);
assert.equal(coveredOverview.coverage.total,1);
assert.equal(coveredOverview.coverage.percent,100);
assert.equal(coveredOverview.coverage.windowCurrent,1);
assert.equal(coveredOverview.coverage.windowTotal,1);
const unknownCoverage=calls('predictionQueueOverview',snap({programme:null,programmeStatus:'not_recorded'}),NOW);
assert.equal(unknownCoverage.coverage.status,'unknown');
assert.equal(unknownCoverage.coverage.percent,null);
const partialCoverage=calls('predictionQueueOverview',snap({catalog:null,catalogStatus:'not_recorded'}),NOW);
assert.equal(partialCoverage.coverage.status,'partial');

const readyFilm=snap({queue:queue({hotPending:['film-zz-ready'],pending:['film-zz-ready'],priorityCount:1}),films:{'film-zz-ready':{status:'recorded',fingerprint:null,predictions:null}}});
const missingFingerprint=calls('predictionFilmDiagnostic',readyFilm,'film-zz-ready',NOW);
assert.equal(missingFingerprint.lane,'hot');
assert.equal(missingFingerprint.eligibleNow,true);
assert.equal(missingFingerprint.cause,'ready');
assert.equal(missingFingerprint.fingerprint.presence,'not_recorded');
assert.equal(missingFingerprint.prediction.presence,'not_recorded');
assert.equal(missingFingerprint.retry.classification,'not_recorded');
assert.equal(missingFingerprint.index,'not_recorded');

const staleFilm=snap({queue:queue({hotPending:['film-zz-stale'],pending:['film-zz-stale'],priorityCount:1,retries:{'film-zz-stale':retry(NOW-1000,{kind:'quota CANARY-KIND',scope:'batch',attempts:-1,failedAt:'not-a-time',lastRunId:'not a run'})}}),films:{'film-zz-stale':{status:'recorded',fingerprint,predictions:{current:{...currentPrediction,tasteProfileHash:'old-hash',mainRisk:'CANARY-RISK'}}}}});
const stale=calls('predictionFilmDiagnostic',staleFilm,'film-zz-stale',NOW);
assert.equal(stale.eligibleNow,true);
assert.equal(stale.cause,'ready');
assert.equal(stale.prediction.presence,'recorded');
assert.equal(stale.prediction.current,false);
assert.equal(stale.prediction.stale,true);
assert.equal(stale.prediction.cause,'profile_changed');
assert.equal(stale.retry.classification,'quota');
assert.equal(stale.retry.scope,'unknown');
assert.equal(stale.retry.attempts,null);
assert.equal(stale.retry.failedAt,null);
assert.equal(stale.retry.lastRunId,null);
assert.equal(stale.retry.retryAt,'2026-10-24T07:59:59.000Z');

const lost=snap({films:{'film-zz-lost':{status:'unavailable',fingerprint:null,predictions:null}}});
const lostFilm=calls('predictionFilmDiagnostic',lost,'film-zz-lost',NOW);
assert.equal(lostFilm.lane,'none');
assert.equal(lostFilm.eligibleNow,false);
assert.equal(lostFilm.cause,'not_in_queue');
assert.equal(lostFilm.fingerprint.presence,'unknown');
assert.equal(lostFilm.prediction.presence,'unknown');

const invalidated=snap({films:{'film-zz-old':{status:'recorded',fingerprint:{...fingerprint,invalidatedAt:'2026-10-24T07:30:00.000Z'},predictions:{current:currentPrediction}}}});
assert.equal(calls('predictionFilmDiagnostic',invalidated,'film-zz-old',NOW).prediction.cause,'fingerprint_not_current');
const emptyPrediction=snap({films:{'film-zz-empty':{status:'recorded',fingerprint,predictions:{}}}});
assert.equal(calls('predictionFilmDiagnostic',emptyPrediction,'film-zz-empty',NOW).prediction.presence,'recorded_without_current');

const disagreed=snap({index:{'film-zz-split':{fingerprintHash:'fp-zz',prediction:currentPrediction}},films:{'film-zz-split':{status:'recorded',fingerprint,predictions:{current:{...currentPrediction,tasteProfileHash:'old-hash'}}}}});
assert.equal(calls('predictionFilmDiagnostic',disagreed,'film-zz-split',NOW).index,'inconsistent');
const agreed=snap({index:{'film-zz-same':{fingerprintHash:'fp-zz',prediction:currentPrediction}},films:{'film-zz-same':{status:'recorded',fingerprint,predictions:{current:currentPrediction}}}});
assert.equal(calls('predictionFilmDiagnostic',agreed,'film-zz-same',NOW).index,'agreed');
assert.equal(calls('predictionFilmDiagnostic',agreed,'film-zz-same',NOW).prediction.current,true);

const isoRetry=snap({queue:queue({hotPending:['film-zz-iso'],pending:['film-zz-iso'],priorityCount:1,retries:{'film-zz-iso':retry('2026-10-24T09:00:00.000Z')}})});
const isoFilm=calls('predictionFilmDiagnostic',isoRetry,'film-zz-iso',NOW);
assert.equal(isoFilm.eligibleNow,true);
assert.equal(isoFilm.retry.retryAt,'2026-10-24T09:00:00.000Z');

const secretFilm=calls('predictionFilmDiagnostic',five,'film-zz-2',NOW);
assert.equal(secretFilm.retry.classification,'model_error');
assert.equal(secretFilm.eligibleNow,false);
assert.equal(secretFilm.cause,'retry_backoff');
const secretPage=calls('predictionPendingPage',five,{filter:'all',limit:20},NOW);
const secretText=JSON.stringify([overview,stale,secretFilm,secretPage]);
assert.doesNotMatch(secretText,/CANARY|Bearer|plotMechanics|mainRisk|enrichment\/|\.json/);
assert.ok(secretText.length<8000);

const first=calls('predictionPendingPage',five,{filter:'deferred',limit:2},NOW);
assert.equal(JSON.stringify(first.items.map(item=>item.filmId)),JSON.stringify(['film-zz-1','film-zz-2']));
assert.equal(first.items[0].retryAt,'2026-10-24T09:00:00.000Z');
assert.equal(first.items[0].classification,'validation_error');
const second=calls('predictionPendingPage',five,{filter:'deferred',limit:2,cursor:first.nextCursor},NOW);
assert.equal(JSON.stringify(second.items.map(item=>item.filmId)),JSON.stringify(['film-zz-3','film-zz-4']));
const third=calls('predictionPendingPage',five,{filter:'deferred',limit:2,cursor:second.nextCursor},NOW);
assert.equal(JSON.stringify(third.items.map(item=>item.filmId)),JSON.stringify(['film-zz-5']));
assert.equal(third.nextCursor,null);
assert.equal(calls('predictionPendingPage',five,{filter:'eligible',limit:20},NOW).items.length,0);
assert.equal(calls('predictionPendingPage',five,{limit:20},NOW).items.length,5);
const moved=snap({queue:queue({...five.queue,refreshedAt:'2026-10-24T08:05:00.000Z'})});
const changed=calls('predictionPendingPage',moved,{filter:'deferred',limit:2,cursor:first.nextCursor},NOW);
assert.equal(changed.status,'snapshot_changed');
assert.equal(changed.items.length,0);
assert.equal(changed.nextCursor,null);
assert.equal(calls('predictionPendingPage',five,{filter:'deferred',limit:21},NOW).error,'"limit" must be an integer from 1 to 20.');
assert.equal(calls('predictionPendingPage',five,{filter:'later',limit:1},NOW).error,'"filter" must be all, eligible or deferred.');
assert.equal(calls('predictionPendingPage',five,{filter:'all',limit:1,cursor:'pd1.nope'},NOW).error,'"cursor" does not match this queue page.');
assert.equal(calls('predictionPendingPage',snap({queue:null,queueStatus:'not_recorded'}),{limit:5},NOW).status,'unavailable');
const waiting=calls('predictionPendingPage',behind,{filter:'deferred',limit:10},NOW);
assert.equal(JSON.stringify(waiting.items.map(item=>item.cause)),JSON.stringify(['retry_backoff','waiting_behind_hot']));

console.log('prediction diagnostics: deferred queue stays distinct from drained, film facts stay explicit, and pending pages keep one snapshot');
