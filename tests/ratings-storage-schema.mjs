import assert from 'node:assert/strict';
import * as RatingsD1 from '../src/ratings-d1.js';
import {ratingsAuthorityModule,makeBucket,makeClock,makeNetwork,loadContext,baseEnv,QUEUE,CURSOR,SEPARATE,H,film,plain,g,migrated} from './ratings-harness.mjs';

// ADR 0160: the ratings pipeline works only on version 2 storage, and the Worker has no code that converts it. Start, step and the
// status read the removal queue and the Diary cursor and refuse anything else without a write, a request, a conversion or a read
// through another store.
const T0=Date.parse('2026-10-31T08:00:00.000Z');
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
const at=ms=>new Date(ms).toISOString();
function setup(extra={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 return {clock,net,bucket,ctx,env:baseEnv(bucket,{...SEPARATE,...extra}),R:g(ctx,'LetterboxdRatings')};
}
const V1_ENTRY={url:film('old').url,state:'not_rated',attempts:3,enqueuedAt:at(T0-H),nextAttemptAt:null,lastAttemptAt:at(T0-H),lastResult:'not_rated'};
const V1_CURSOR={schemaVersion:1,lastAttemptAt:at(T0-H),lastSuccessAt:at(T0-H),lastFailureAt:null,lastOutcome:'partial',stopReason:'page_budget',counts:{pages:3},coverage:{newestWatchedDate:'2026-10-30',oldestWatchedDate:'2026-09-01',reachedEnd:false},resumePage:4};
const V2_CURSOR={schemaVersion:2,coverage:{newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false},resumePage:null,writer:{runId:'earlier-run',step:'diary'}};
const QUEUES={absent:null,emptyV1:{schemaVersion:1,films:{}},v1:{schemaVersion:1,films:{old:V1_ENTRY},pausedUntil:at(T0+H),pausedBy:'rate_limited'},v2:{schemaVersion:2,films:{},droppedRefs:0}};
const CURSORS={absent:null,v1:V1_CURSOR,v2:V2_CURSOR};

// 1. The matrix: every stored queue against every stored cursor. Only version 2 with a merge-form cursor is supported. Any other
// pair is refused by start and step and reported by the status; nothing is written, requested, converted or deleted.
for(const [qName,queue] of Object.entries(QUEUES))for(const [cName,cursor] of Object.entries(CURSORS)){
 const label=qName+'/'+cName,supported=qName==='v2'&&cName==='v2';
 const {bucket,env,R,net}=setup();
 if(queue)bucket.set(QUEUE,queue);if(cursor)bucket.set(CURSOR,cursor);
 const before={queue:plain(bucket.value(QUEUE)??null),cursor:plain(bucket.value(CURSOR)??null)};
 const storage={supported,authority:'open',queueV2:qName==='v2',cursorV2:cName==='v2'};
 const status=plain(await R.status(env));
 eq([status.storage,status.pipeline],[storage,supported?'idle':'blocked'],label);
 assert.equal('migration' in status,false,label+': the status has no migration field');
 assert.equal('regressedObjects' in status,false,label);
 assert.equal('migrated' in status.diary,false,label);
 assert.equal(bucket.writes().length,0,label+': the status writes nothing');
 const writesBefore=bucket.writes().length;
 if(supported){
  const started=plain(await R.start(env,{trigger:'manual'}));
  eq([started.created,started.reason],[true,'started'],label);
  continue;
 }
 eq(await R.start(env,{trigger:'manual'}),{runId:null,created:false,nextAction:'stop',reason:'storage_unsupported',storage},label);
 const stepped=plain(await R.step(env,{runId:'00000000-0000-4000-8000-000000000001'}));
 eq([stepped.reason,stepped.nextAction,stepped.storage,stepped.runId],['storage_unsupported','stop',storage,null],label);
 assert.equal(bucket.writes().length,writesBefore,label+': start and step write nothing');
 assert.equal(net.fetches.length,0,label+': no request');
 eq({queue:bucket.value(QUEUE)??null,cursor:bucket.value(CURSOR)??null},before,label+': nothing is converted');
}

// 2. An object found back at version 1 after the pipeline ran on version 2 (a restore, or a writer of older code) is refused the
// same way. The refusal does not depend on any record of an earlier conversion, and nothing repairs the object.
{
 const {bucket,env,R,net}=setup();
 migrated(bucket);
 eq((await R.start(env,{trigger:'manual'})).reason,'started');
 bucket.set(QUEUE,{schemaVersion:1,films:{x:V1_ENTRY}});
 const writes=bucket.writes().length;
 const status=plain(await R.status(env));
 eq([status.storage,status.pipeline],[{supported:false,authority:'open',queueV2:false,cursorV2:true},'blocked']);
 const second=plain(await R.start(env,{trigger:'manual'}));
 eq([second.reason,second.created],['storage_unsupported',false]);
 assert.equal(bucket.writes().length,writes);assert.equal(net.fetches.length,0);
 assert.equal(bucket.value(QUEUE).schemaVersion,1);
 bucket.set(CURSOR,V1_CURSOR);
 eq(plain(await R.status(env)).storage,{supported:false,authority:'open',queueV2:false,cursorV2:false});
}

// 3. There is no conversion entry point left: neither the functions nor the request action exist, and a request for the retired
// action is refused as unknown without a write.
{
 const {bucket,env,R,ctx}=setup();
 migrated(bucket);
 for(const name of ['migrate','migrationState','separateActive'])assert.equal(R[name],undefined,name);
 for(const name of ['migrateRemovalQueue'])assert.equal(typeof g(ctx,'globalThis')[name],'undefined',name);
 eq(await R.handle(env,'migrate',{mode:'apply'}),{status:400,body:{error:'Unknown action'}});
 eq(await R.handle(env,'migrate',{mode:'dry_run'}),{status:400,body:{error:'Unknown action'}});
 assert.equal(bucket.writes().length,0);
}

// 4. Supported storage processes as before: a version 2 pair starts a run and the status reports it supported and idle.
{
 const {bucket,env,R}=setup();
 migrated(bucket);
 const status=plain(await R.status(env));
 eq([status.storage,status.pipeline],[{supported:true,authority:'open',queueV2:true,cursorV2:true},'idle']);
 eq((await R.start(env,{trigger:'manual'})).created,true);
}

// 5. Malformed requests write nothing.
{
 const {bucket,env,R}=setup();
 migrated(bucket);
 for(const [action,body] of [['start',null],['start',{}],['start',{trigger:'weekly'}],['step',{}],['step',{runId:'a b'}],['start',{trigger:'manual',extra:1}]])assert.equal((await R.handle(env,action,body)).status,400,action+JSON.stringify(body));
 assert.equal(bucket.writes().length,0);
}

// 6. The Ratings D1 authority is read before the stored shapes. A held marker, or one that cannot be read, refuses the pipeline even
// when stale R2 copies of both objects have the version 2 form: start and step write nothing, request nothing and report the
// authority; nothing falls through to the R2 copies.
for(const kind of ['held','unavailable']){
 const {bucket,env,R,net,ctx}=setup();
 migrated(bucket);
 ctx.RatingsD1=ratingsAuthorityModule(RatingsD1,kind);
 const writes=bucket.writes().length;
 const expected={supported:false,authority:kind,queueV2:false,cursorV2:false};
 const status=plain(await R.status(env));
 eq([status.storage,status.pipeline],[expected,'blocked'],kind);
 eq(await R.start(env,{trigger:'manual'}),{runId:null,created:false,nextAction:'stop',reason:'storage_unsupported',storage:expected},kind);
 const stepped=plain(await R.step(env,{runId:'00000000-0000-4000-8000-000000000001'}));
 eq([stepped.reason,stepped.storage],['storage_unsupported',expected],kind);
 assert.equal(bucket.writes().length,writes,kind+': nothing is written');assert.equal(net.fetches.length,0,kind+': no request');
}

console.log('Ratings storage schema (ADR 0160): only a version 2 queue with a merge-form cursor is supported; any other pair is refused by start, step and the status with no write, request or conversion; a version 1 object found after version 2 is refused the same way; no conversion entry point exists in the Worker');
