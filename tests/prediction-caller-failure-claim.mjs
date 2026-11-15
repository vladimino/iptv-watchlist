// Caller failure claim of batch_submit: failure.reason is required; failure.preflight.issues is optional.
// A kind-only item is 400 and writes nothing. Replay identity covers the claim; a candidate is never accepted through it.
// Offline: sqlite D1 stand-in, in-memory R2, no model, no production.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const ready=async n=>{const w=await flowWorld({films:n});assert.equal((await w.api('queue/reconcile',{})).status,200);return w;};
const start=async w=>{const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.equal(r.status,200);return r.data;};
const submit=(w,m,items,extra={})=>w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items,...extra});
const run=(w,m)=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+m.runId+"'")[0].d);
const queue=w=>JSON.parse(sql(w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
const pointers=w=>sql(w.file,'SELECT film_id FROM prediction_pointer ORDER BY film_id').map(r=>r.film_id);
const ids=m=>m.films.map(f=>f.filmId);
const claim={kind:'parse_error',reason:'insufficient_evidence',preflight:{issues:[{path:'fingerprint.evidence',code:'too_few'}]}};
const issuesOf=r=>(r.data&&r.data.issues)||[];

// 1. A missing reason is 400 even beside a valid neighbour; a claim is stored next to empty Worker issues; replay covers the claim.
{
 const w=await ready(8);const m=await start(w),pick=ids(m);
 const missing=await submit(w,m,[{filmId:pick[0],failure:{kind:'parse_error'}},{filmId:pick[2],fingerprint:w.fingerprint,prediction:w.prediction}]);
 assert.equal(missing.status,400);assert.ok(issuesOf(missing).some(i=>i.path==='items[0].failure.reason'&&i.code==='required'),JSON.stringify(missing.data).slice(0,300));
 assert.equal(Object.keys(run(w,m).submitted||{}).length,0);assert.deepEqual(pointers(w),[]);
 const r=await submit(w,m,[{filmId:pick[1],failure:claim},{filmId:pick[2],fingerprint:w.fingerprint,prediction:w.prediction}]);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
 const by=Object.fromEntries(r.data.results.map(x=>[x.filmId,x]));
 assert.deepEqual(by[pick[1]].validation,{stage:'caller_reported',reportedBy:'caller',issues:[],claimed:{reason:'insufficient_evidence',preflightIssues:[{path:'fingerprint.evidence',code:'too_few'}]}},'the claim is separate from the verified issues');
 assert.equal(by[pick[2]].status,'created','a valid neighbour in the same batch continues');
 const stored=run(w,m);
 assert.deepEqual(stored.failures[pick[1]].validation.claimed,by[pick[1]].validation.claimed);
 assert.deepEqual(queue(w).retries[pick[1]].validation.claimed,by[pick[1]].validation.claimed,'the retry record carries the claim');
 assert.equal(stored.formatFailureStreak,0,'the existing streak rule is unchanged: a created film after the failures resets it');assert.equal(stored.failures[pick[1]].kind,'parse_error');assert.equal(stored.failures[pick[1]].retryable,true);
 const two={kind:'parse_error',reason:'preflight_validation_failed',preflight:{issues:[{path:'fingerprint.evidence',code:'too_few'},{path:'prediction.moodLabels',code:'required'},{path:'fingerprint.evidence.plotMechanics.heist',code:'too_few'},{path:'assessment.sources.ref',code:'invalid_ref'}]}};
 const sw=await submit(w,m,[{filmId:pick[3],failure:two}]);assert.equal(sw.data.results[0].status,'validation_failure');
 const reordered={...two,preflight:{issues:[...two.preflight.issues].reverse()}};
 assert.equal((await submit(w,m,[{filmId:pick[3],failure:reordered}])).data.results[0].replayed,true,'canonical order: a reordered identical claim replays');
 assert.equal((await submit(w,m,[{filmId:pick[3],failure:two}])).data.results[0].replayed,true,'the same claim replays');
 assert.equal((await submit(w,m,[{filmId:pick[3],failure:{...two,reason:'insufficient_evidence'}}])).data.results[0].status,'conflict','another reason conflicts');
 assert.equal((await submit(w,m,[{filmId:pick[3],failure:{...two,preflight:{issues:[two.preflight.issues[0]]}}}])).data.results[0].status,'conflict','other issues conflict');
 assert.equal((await submit(w,m,[{filmId:pick[3],failure:{kind:'parse_error'}}])).status,400,'kind-only does not replay a claim');
 assert.equal((await submit(w,m,[{filmId:pick[1],failure:{kind:'parse_error',reason:'json_unparseable'}}])).data.results[0].status,'conflict','another reason does not replay');
 assert.deepEqual(pointers(w),[pick[2]],'only the valid film was written');
}

// 2. Closed vocabulary and bounds: everything outside it is refused whole, nothing is written, nothing is echoed.
{
 const w=await ready(6);const m=await start(w),pick=ids(m);
 const bad=[
  {kind:'parse_error'},
  {kind:'parse_error',reason:'because I said so'},
  {kind:'parse_error',reason:7},
  {kind:'parse_error',extra:1},
  {kind:'parse_error',reason:'insufficient_evidence',preflight:{issues:[],note:'x'}},
  {kind:'parse_error',preflight:{}},
  {kind:'parse_error',preflight:'fingerprint.evidence too_few'},
  {kind:'parse_error',preflight:{issues:[{path:'fingerprint.evidence',code:'too_few',text:'secret-text'}]}},
  {kind:'parse_error',preflight:{issues:[{path:'https://example.com/x',code:'too_few'}]}},
  {kind:'parse_error',preflight:{issues:[{path:'fingerprint.evidence',code:'made_up'}]}},
  {kind:'parse_error',preflight:{issues:[{path:'secret.thing',code:'too_few'}]}},
  {kind:'parse_error',preflight:{issues:[{path:'fingerprint.notARealField',code:'too_few'}]}},
  {kind:'parse_error',preflight:{issues:[{path:'fingerprint.evidence.group0.claim',code:'too_few'}]}},
  {kind:'parse_error',preflight:{issues:[{path:'fingerprint.evidence.execution.notADim',code:'too_few'}]}},
  {kind:'parse_error',preflight:{issues:[{path:'prediction.secretField',code:'too_few'}]}},
  {kind:'parse_error',preflight:{issues:[{path:'assessment.research.invented',code:'too_few'}]}},
  {kind:'parse_error',preflight:{issues:Array.from({length:21},()=>({path:'fingerprint.moodLabels',code:'too_few'}))}},
 ];
 for(const failure of bad){
  const r=await submit(w,m,[{filmId:pick[0],failure}]);
  assert.equal(r.status,400,JSON.stringify(failure));assert.ok(!JSON.stringify(r.data).includes('secret-text')&&!JSON.stringify(r.data).includes('because I said so'),'a refused value is not echoed');
 }
 assert.equal(Object.keys(run(w,m).submitted||{}).length,0,'nothing was recorded');assert.deepEqual(pointers(w),[]);
 const ok=await submit(w,m,[{filmId:pick[0],failure:{kind:'parse_error',reason:'json_unparseable'}}]);assert.equal(ok.status,200);assert.deepEqual(ok.data.results[0].validation.claimed,{reason:'json_unparseable'});
 for(const [index,paths] of [['assessment.model.id','assessment.research.attempts.outcome'],['assessment.conflicts.handling','assessment.conflicts.positions.stance','assessment.conflicts.topic','assessment.model.effort','assessment.model.version','assessment.research.attempts.note']].entries()){
  const r=await submit(w,m,[{filmId:pick[2+index],failure:{kind:'parse_error',reason:'preflight_validation_failed',preflight:{issues:paths.map(path=>({path,code:'invalid_enum'}))}}}]);
  assert.equal(r.status,200,paths.join());assert.deepEqual(r.data.results[0].validation.claimed.preflightIssues.map(x=>x.path).sort(),[...paths].sort(),'a path the assessment validator reports is accepted as a claim');
 }
 const max=await submit(w,m,[{filmId:pick[1],failure:{kind:'parse_error',reason:'preflight_validation_failed',preflight:{issues:Array.from({length:20},()=>({path:'fingerprint.evidence.execution.pace',code:'too_few'}))}}}]);
 assert.equal(max.status,200);assert.equal(max.data.results[0].validation.claimed.preflightIssues.length,1,'equal issues are deduplicated');
}

// 3. A candidate is still validated by the Worker: a claim on an item that also carries an invalid prediction does not bypass the schema, and a failure item never writes.
{
 const w=await ready(6);const m=await start(w),pick=ids(m);
 const r=await submit(w,m,[{filmId:pick[0],fingerprint:w.fingerprint,prediction:{...w.prediction,predictedRating:99},failure:claim}]);
 assert.ok(r.status===200&&r.data.results[0].status!=='created','an invalid candidate is not accepted');
 assert.ok(r.data.results[0].validation.stage!=='caller_reported'||r.data.results[0].validation.issues.length===0);
 assert.deepEqual(pointers(w),[],'nothing written');
}

// 4. Historical production identities from run c6b2c3d7 remain the legacy string digest (no claim). New submits cannot recreate that shape.
{
 const {createHash}=await import('node:crypto');
 const canonical=value=>{if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object'&&!Array.isArray(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;};
 const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
 const observed={
  tmdb_514684:'c2cf9bd49958ecb507e89a441fcacc85c290159826fade722a38a300f5b73de5',
  tmdb_492618:'67412d8c9b15ad69a8bd23605e90b53af5c7b8a478d9c9eadb5bc89ddc63fea3',
  tmdb_262733:'b114b7735a0e7be74f974bc39759e3e56e67d53d61159ce2a29ef519023578ec',
 };
 for(const [id,want] of Object.entries(observed)){
  const legacy=digest({filmId:id,fingerprint:null,prediction:null,failure:'parse_error'});
  assert.equal(legacy,want,'historical inputDigest is the legacy failure identity for '+id);
  for(const reason of ['insufficient_evidence','preflight_validation_failed','json_unparseable','request_too_large']){
   assert.notEqual(digest({filmId:id,fingerprint:null,prediction:null,failure:{kind:'parse_error',reason}}),want,'a stored claim would not match '+id);
  }
 }
}

// 5. Mixed batch: two claimed failures, a valid neighbour, a schema-invalid candidate. Kind-only in the same body 400s the call.
{
 const w=await ready(8);const m=await start(w),pick=ids(m);
 const withLegacy=await submit(w,m,[
  {filmId:pick[1],failure:{kind:'parse_error'}},
  {filmId:pick[4],fingerprint:w.fingerprint,prediction:w.prediction},
 ]);
 assert.equal(withLegacy.status,400);assert.equal(Object.keys(run(w,m).submitted||{}).length,0);
 const mixed=await submit(w,m,[
  {filmId:pick[2],failure:{kind:'parse_error',reason:'json_unparseable'}},
  {filmId:pick[3],failure:{kind:'parse_error',reason:'request_too_large'}},
  {filmId:pick[4],fingerprint:w.fingerprint,prediction:w.prediction},
  {filmId:pick[5],fingerprint:w.fingerprint,prediction:{...w.prediction,predictedRating:99}},
 ]);
 assert.equal(mixed.status,200,JSON.stringify(mixed.data).slice(0,300));
 const by=Object.fromEntries(mixed.data.results.map(x=>[x.filmId,x]));
 assert.deepEqual(by[pick[2]].validation.claimed,{reason:'json_unparseable'});
 assert.deepEqual(by[pick[3]].validation.claimed,{reason:'request_too_large'});
 assert.notEqual(run(w,m).submitted[pick[2]].inputDigest,run(w,m).submitted[pick[3]].inputDigest);
 assert.equal(by[pick[4]].status,'created','a valid neighbour in a mixed batch continues');
 assert.ok(by[pick[5]].status!=='created');assert.equal(by[pick[5]].validation.reportedBy,'worker');
 assert.deepEqual(pointers(w),[pick[4]]);
}

console.log('prediction-caller-failure-claim: ok');
