// Owner-only prediction recovery assessment of one stored film behind the existing Cloudflare Access application:
// GET /api/admin/prediction-recovery?film=<stored id>. It reads what the prediction_film_diagnostics MCP tool reads (the
// prediction queue, the taste profile, the view index, the published programme and catalog, the generation pointer and
// this film's fingerprint and prediction bundle) plus the runner lease and the latest run, and evaluates the pure
// assessment over them. The loader gets a bucket that has nothing but `get`, so no code path of this route can write,
// list or delete. It starts no run, calls no model and makes no outbound request. There is no matching POST: a targeted
// prediction write does not exist (docs/reference/api/admin-actions.md#prediction-recovery).
const RECOVERY_FILM_ID=/^[A-Za-z0-9_-]{1,80}$/;
const RECOVERY_LATEST_RUN_KEY=ENRICHMENT_KEY+'latest-run.json';

function recoveryReadOnlyEnv(env){
 const versions=new Map();
 const bucket={async get(key){const object=await env.BUCKET.get(key);versions.set(key,object?String(object.etag??'present'):'absent');return object;}};
 return {env:{...env,BUCKET:bucket},versions};
}
async function recoveryRead(env,key){
 try{const value=await loadJSON(env,key);return {status:value==null?'not_recorded':'recorded',value};}
 catch{return {status:'unavailable',value:null};}
}
// The pin names every object version this assessment rests on; any change to one of them, including a lease heartbeat,
// makes the pin stale.
async function recoveryPin(versions){
 const tuple=[...versions.entries()].sort(([left],[right])=>left.localeCompare(right,'en'));
 return 'R1.'+(await adminDigest(JSON.stringify(tuple))).slice(0,32);
}
function recoveryActivity(queue){
 const times=[queue?.lastCheckAt,queue?.lastBatch?.finishedAt].map(value=>typeof value==='string'?Date.parse(value):NaN).filter(Number.isFinite);
 return times.length?new Date(Math.max(...times)).toISOString():null;
}
async function adminPredictionRecoveryRoute(request,env,url){
 if(request.method!=='GET')return adminError('method_not_allowed',405);
 const params=url.searchParams;
 const filmId=params.get('film');
 if(!filmId||!RECOVERY_FILM_ID.test(filmId))return adminError('invalid_film',400);
 let pin=null;
 if(params.has('pin')){pin=params.get('pin');if(!/^R1\.[0-9a-f]{32}$/.test(pin))return adminError('invalid_pin',400);}
 const {env:readEnv,versions}=recoveryReadOnlyEnv(env);
 let snapshot,lease,run;
 try{
  snapshot=await loadPredictionDiagnosticSnapshot(readEnv,filmId);
  [lease,run]=await Promise.all([recoveryRead(readEnv,RUNNER_LEASE_KEY),recoveryRead(readEnv,RECOVERY_LATEST_RUN_KEY)]);
 }catch{return adminError('storage_unavailable',503);}
 const current=await recoveryPin(versions);
 if(pin&&pin!==current)return adminError('stale_pin',409);
 const nowMs=Date.now();
 const diagnostic=predictionFilmDiagnostic(snapshot,filmId,nowMs);
 const runValue=run.value&&typeof run.value==='object'?run.value:null;
 // Absence from the programme and the catalog is a fact only when both were read.
 const catalogRead=snapshot.programmeStatus==='recorded'&&snapshot.catalogStatus==='recorded';
 const assessment=PredictionRecovery.assessPredictionRecovery({
  filmId,now:nowMs,diagnostic,snapshotReasons:diagnostic.snapshot.reasons,
  sources:{film:snapshot.films?.[filmId]?.status==='unavailable'?'unavailable':'recorded',queue:snapshot.queueStatus,profile:snapshot.profileStatus},
  catalogMember:snapshot.filmsById.has(filmId)?true:catalogRead?false:null,
  queueActivityAt:recoveryActivity(snapshot.queue),
  nominalNextRunAt:scheduledRunFields().nextScheduledRunAt,
  runner:{lease:lease.status,leaseRunId:lease.value?.runId??null,leaseExpiresAt:lease.value?.expiresAt??null,run:run.status,runId:runValue?.runId??null,selectedIds:Array.isArray(runValue?.selectedIds)?runValue.selectedIds:[],resultIds:runValue?.results&&typeof runValue.results==='object'?Object.keys(runValue.results):[]},
 });
 return json({
  pin:current,
  evaluatedAt:new Date(nowMs).toISOString(),
  atomic:false,
  assessment,
  snapshot:{
   consistent:diagnostic.snapshot.consistent,reasons:diagnostic.snapshot.reasons,
   queue:{status:snapshot.queueStatus,refreshedAt:snapshot.queue?.refreshedAt??null,programmeRunId:snapshot.queue?.programmeRunId??null,lastActivityAt:recoveryActivity(snapshot.queue)},
   profile:{status:snapshot.profileStatus,version:snapshot.profile?.version??null},
   programme:{status:snapshot.programmeStatus,programmeRunId:snapshot.programme?.runId??null},
   publishedGeneration:{status:snapshot.publishedGenerationStatus,programmeRunId:snapshot.publishedGeneration?.programmeRunId??null},
   runnerLease:lease.status,latestRun:run.status,
   nominalNextRunAt:scheduledRunFields().nextScheduledRunAt,
  },
  sources:[...versions.keys()].sort((left,right)=>left.localeCompare(right,'en')),
 });
}
