// AIR-456 H1 / ADR 0121, ADR 0124. The operator for the EPG diagnostic domain: it checks, and (only with an explicit flag, a per-command confirmation and the owner's
// operation-specific GO) writes the schema and the identity of the DIAGNOSTIC D1 database and R2 bucket. It never touches the production database `iptv` or the production
// bucket `iptv`: both are refused by id and by name before the first request, and the live database name must read back as the diagnostic one.
//
//   node scripts/epg-diagnostic-provision.mjs check                                   read only: the target, the schema state, the judgement `provision` would make
//   node scripts/epg-diagnostic-provision.mjs schema                                  dry run: the files that would be applied
//   node scripts/epg-diagnostic-provision.mjs schema   --apply --confirm APPLY_EPG_DIAGNOSTIC_SCHEMA
//   node scripts/epg-diagnostic-provision.mjs identity                                dry run: the judgement `provision` would make
//   node scripts/epg-diagnostic-provision.mjs identity --apply --confirm PROVISION_EPG_DIAGNOSTIC_IDENTITY
//
//   node scripts/epg-diagnostic-provision.mjs prepare-domain                           dry run: the Discovery authority state of the diagnostic D1
//   node scripts/epg-diagnostic-provision.mjs prepare-domain --apply --confirm PREPARE_EPG_DIAGNOSTIC_DOMAIN
//   node scripts/epg-diagnostic-provision.mjs dataset-build --output /abs/private/dir [--generation <programmeRunId>] --confirm READ_PRODUCTION_EPG_GENERATION
//   node scripts/epg-diagnostic-provision.mjs dataset-put --input /abs/private/dir/epg-replay-<digest>.json                  dry run
//   node scripts/epg-diagnostic-provision.mjs dataset-put --input … --apply --confirm PUT_EPG_DIAGNOSTIC_DATASET
//
// H2 commands. `prepare-domain` sets the Discovery authority of the DIAGNOSTIC D1 from its seeded state (r2/open) to d1/open, the production state, so a canary measures the D1-owned ledger path and not the
// legacy R2 one. `dataset-build` only READS the production bucket `iptv` (the read-only snapshot key, GET only; any write is refused before a request exists) and writes one private file outside the repository:
// the report carries digest, counts and fidelity, never a payload. `dataset-put` verifies a dataset file with the Worker's own `verifyDataset` and writes it, once, to `diagnostic/replay/<digest>.json` of the
// diagnostic bucket (create-only, read back). Each needs the owner's operation-specific GO.
//
// `schema` applies migrations/NNNN_*.sql in order, then diagnostic-migrations/NNNN_*.sql, each file as one request, only to a database with no tables, and stops at the first
// failure without a retry (a half-applied empty diagnostic database is deleted and created again by the owner). `identity` calls the Worker's own `EpgDiagnostic.provision`,
// which writes only into an empty bucket and a database whose seed rows are exactly the canonical ones. The confirmation strings are guards against accident, not authorization.
//
// Configuration (names only; values come from the environment, never from arguments, and are never printed):
//   EPG_DIAGNOSTIC_ACCOUNT_ID, EPG_DIAGNOSTIC_D1_DATABASE_ID, EPG_DIAGNOSTIC_D1_API_TOKEN,
//   EPG_DIAGNOSTIC_R2_ACCESS_KEY_ID, EPG_DIAGNOSTIC_R2_SECRET_ACCESS_KEY (bucket-scoped to the diagnostic bucket), EPG_DIAGNOSTIC_RESOURCE_ID,
//   optional EPG_DIAGNOSTIC_R2_BUCKET (only the diagnostic bucket name is accepted).
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createS3Store} from './discovery-ledger-install.mjs';
import {readCredentials} from './r2-snapshot-export.mjs';

const REPO=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const PRODUCTION=Object.freeze({databaseId:'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',databaseName:'iptv',bucket:'iptv'});
export const NAMES=Object.freeze({database:'iptv-epg-diagnostic',bucket:'iptv-epg-diagnostic'});
export const CONFIRM=Object.freeze({schema:'APPLY_EPG_DIAGNOSTIC_SCHEMA',identity:'PROVISION_EPG_DIAGNOSTIC_IDENTITY','prepare-domain':'PREPARE_EPG_DIAGNOSTIC_DOMAIN','dataset-put':'PUT_EPG_DIAGNOSTIC_DATASET','dataset-build':'READ_PRODUCTION_EPG_GENERATION'});
const DATASET_KEY=/^diagnostic\/replay\/[0-9a-f]{64}\.json$/;
const PRODUCTION_POINTER='epg/published-generation.json';
export const DEFAULT_ENDPOINT='https://api.cloudflare.com/client/v4';
const IDENTITY_OBJECT='diagnostic/identity.json';
const sha256=value=>createHash('sha256').update(value).digest('hex');

export class ProvisionError extends Error{constructor(message,exitCode=3,details={}){super(message);this.name='ProvisionError';this.exitCode=exitCode;this.details=details;}}

// The Worker's own module, loaded standalone (it has no imports): `assess` and `provision` are the Worker's judgement, not a copy of it.
export function loadDiagnostic(file=path.join(REPO,'src/epg-diagnostic.js')){return new Function(fs.readFileSync(file,'utf8')+'\nreturn EpgDiagnostic;')();}

export function loadReplay(file=path.join(REPO,'src/epg-replay.js')){return new Function(fs.readFileSync(file,'utf8')+'\nreturn EpgReplay;')();}
// A private file path must be absolute and outside the Git repository (a dataset holds ledger payloads).
// Containment is checked on REAL paths: the nearest existing ancestor is resolved through every symlink, so a directory or a file that is a symlink into the repository is refused as well as a
// path that is lexically inside it.
function realResolve(target){
 const parts=[];let current=path.resolve(target);
 for(;;){
  try{const real=fs.realpathSync(current);return parts.length?path.join(real,...parts.reverse()):real;}
  catch(error){
   if(error?.code!=='ENOENT'&&error?.code!=='ENOTDIR')throw new ProvisionError('The path cannot be resolved',2);
   const parent=path.dirname(current);
   if(parent===current)return path.resolve(target);
   parts.push(path.basename(current));current=parent;
  }
 }
}
function outsideRepo(target,label){
 if(typeof target!=='string'||!path.isAbsolute(target))throw new ProvisionError(label+' must be an absolute path',2);
 const resolved=realResolve(target),repo=realResolve(REPO);
 if(resolved===repo||resolved.startsWith(repo+path.sep))throw new ProvisionError(label+' must be outside the Git repository',2);
 return resolved;
}

export function readConfig(env=process.env){
 const value=name=>String(env[name]||'').trim();
 const accountId=value('EPG_DIAGNOSTIC_ACCOUNT_ID'),databaseId=value('EPG_DIAGNOSTIC_D1_DATABASE_ID'),apiToken=value('EPG_DIAGNOSTIC_D1_API_TOKEN');
 const accessKeyId=value('EPG_DIAGNOSTIC_R2_ACCESS_KEY_ID'),secretAccessKey=value('EPG_DIAGNOSTIC_R2_SECRET_ACCESS_KEY'),resourceId=value('EPG_DIAGNOSTIC_RESOURCE_ID');
 const bucket=value('EPG_DIAGNOSTIC_R2_BUCKET')||NAMES.bucket;
 const fail=message=>{throw new ProvisionError(message,2);};
 if(!/^[0-9a-f]{32}$/.test(accountId))fail('EPG_DIAGNOSTIC_ACCOUNT_ID must be the 32-character account id');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(databaseId))fail('EPG_DIAGNOSTIC_D1_DATABASE_ID must be the database uuid');
 if(databaseId===PRODUCTION.databaseId)throw new ProvisionError('The production database is refused',3);
 if(bucket===PRODUCTION.bucket)throw new ProvisionError('The production bucket is refused',3);
 if(bucket!==NAMES.bucket)fail('EPG_DIAGNOSTIC_R2_BUCKET can only name '+NAMES.bucket);
 if(!apiToken)fail('EPG_DIAGNOSTIC_D1_API_TOKEN is required');
 if(!accessKeyId||!secretAccessKey)fail('EPG_DIAGNOSTIC_R2_ACCESS_KEY_ID and EPG_DIAGNOSTIC_R2_SECRET_ACCESS_KEY are required');
 if(!/^[a-z0-9][a-z0-9-]{7,63}$/.test(resourceId))fail('EPG_DIAGNOSTIC_RESOURCE_ID must match ^[a-z0-9][a-z0-9-]{7,63}$');
 const endpoint=trustedOrigin(env.EPG_DIAGNOSTIC_API_ENDPOINT,DEFAULT_ENDPOINT,DEFAULT_ENDPOINT,'EPG_DIAGNOSTIC_API_ENDPOINT');
 // The diagnostic bucket lives in the EU jurisdiction (the default placement landed it in ENAM, which would distort the latencies the canary measures), and an EU bucket is only
 // reachable on the EU endpoint of the account.
 const r2Canonical='https://'+accountId+'.eu.r2.cloudflarestorage.com';
 const r2Endpoint=trustedOrigin(env.EPG_DIAGNOSTIC_R2_ENDPOINT,r2Canonical,r2Canonical,'EPG_DIAGNOSTIC_R2_ENDPOINT');
 return {accountId,databaseId,apiToken,accessKeyId,secretAccessKey,bucket,resourceId,endpoint,r2Endpoint};
}
// The credentials are sent to this origin, so it is not configurable to an arbitrary host: only the canonical Cloudflare endpoint (the default, or the same value written out) or a
// loopback test server (http or https on 127.0.0.1, localhost or [::1]) is accepted. No credentials, query or fragment in the URL.
function trustedOrigin(raw,fallback,canonical,label){
 const text=String(raw||'').trim();
 if(!text)return fallback;
 let url;try{url=new URL(text);}catch{throw new ProvisionError(label+' is not a URL',2);}
 if(url.username||url.password||url.search||url.hash)throw new ProvisionError(label+' must not carry credentials, a query or a fragment',2);
 const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&(url.protocol==='http:'||url.protocol==='https:');
 const value=url.origin+url.pathname.replace(/\/$/,'');
 if(loopback)return value;
 if(url.protocol==='https:'&&value===canonical)return value;
 throw new ProvisionError(label+' must be the canonical Cloudflare endpoint or a loopback test server',2);
}

// A minimal D1 REST client. Reads retry on transient failures; a write is sent once and never retried (its outcome would be unknown).
export function createD1Client({config,fetchImpl=fetch,retries=3,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const base=config.endpoint+'/accounts/'+config.accountId+'/d1/database/'+config.databaseId;
 const headers={Authorization:'Bearer '+config.apiToken,'Content-Type':'application/json'};
 const stats={reads:0,writes:0};
 async function call(method,url,body,write){
  for(let attempt=0;;attempt++){
   let response;
   try{response=await fetchImpl(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(120000)});}
   catch{
    if(write)throw new ProvisionError('A write request failed in transit; its outcome is unknown and it is not retried',3,{kind:'write_uncertain'});
    if(attempt<retries){await sleep(100*2**attempt);continue;}
    throw new ProvisionError('D1 request failed after retries',3,{kind:'network'});
   }
   let payload=null;try{payload=await response.json();}catch{payload=null;}
   if(response.status===401||response.status===403)throw new ProvisionError('The D1 credential was refused',3,{kind:'authorization'});
   if([429,500,502,503,504].includes(response.status)){
    if(write)throw new ProvisionError('A write answered HTTP '+response.status+'; its outcome is unknown and it is not retried',3,{kind:'write_uncertain'});
    if(attempt<retries){await sleep(100*2**attempt);continue;}
   }
   if(!response.ok||payload?.success===false)throw new ProvisionError(String(payload?.errors?.[0]?.message||('D1 request failed with HTTP '+response.status)).slice(0,300),3,{kind:write?'statement':'request'});
   return payload;
  }
 }
 const literal=value=>{if(value==null)return 'NULL';if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('bad number');return String(value);}if(typeof value==='boolean')return value?'1':'0';return "'"+String(value).replaceAll("'","''")+"'";};
 const render=(sql,params)=>{let i=0;const text=sql.replace(/\?/g,()=>{if(i>=params.length)throw new Error('missing parameter');return literal(params[i++]);});if(i!==params.length)throw new Error('unused parameter');return text;};
 async function rows(sql,params=[]){
  stats.reads++;
  const payload=await call('POST',base+'/query',{sql:render(sql,params)+';'},false);
  // Positive proof only: exactly one successful statement result that carries a `results` array. Anything else is an unknown state, never an empty one.
  const list=payload?.result;
  const only=Array.isArray(list)&&list.length===1?list[0]:null;
  if(!only||only.success!==true||!Array.isArray(only.results))throw new ProvisionError('A read response did not prove its result; the state is unknown, not empty',3,{kind:'malformed_read'});
  return only.results;
 }
 async function write(sql,params=[]){
  stats.writes++;
  const payload=await call('POST',base+'/query',{sql:render(sql,params)+';'},true);
  const results=Array.isArray(payload?.result)?payload.result:[];
  if(!results.length||results.some(item=>item?.success!==true))throw new ProvisionError('A write response did not prove its statement',3,{kind:'write_uncertain'});
 }
 // A whole migration file as one request. D1 answers one result per statement; every one must report success.
 async function exec(text){
  stats.writes++;
  const payload=await call('POST',base+'/query',{sql:text},true);
  const results=Array.isArray(payload?.result)?payload.result:[];
  if(!results.length||results.some(item=>item?.success!==true))throw new ProvisionError('A migration response did not prove every statement',3,{kind:'write_uncertain'});
 }
 return {
  stats,rows,exec,
  async describe(){const payload=await call('GET',base,undefined,false);const result=payload?.result||{};return {uuid:result.uuid??null,name:result.name??null};},
  // The D1-binding shape `EpgDiagnostic.assess/provision` use. `batch` exists only to satisfy the shape and is never needed by them.
  binding:{
   prepare(sql){
    const make=params=>({
     async all(){return {results:await rows(sql,params)};},
     async first(){return (await rows(sql,params))[0]??null;},
     async run(){await write(sql,params);return {success:true};},
    });
    return {bind:(...params)=>make(params),all:()=>make([]).all(),first:()=>make([]).first(),run:()=>make([]).run()};
   },
   async batch(){throw new ProvisionError('batch is not available to the provisioning operator',3);},
  },
 };
}

// The bucket handle `provision` sees. Reads pass; the only write that exists is the identity object, with its precondition; delete never exists.
export function guardedBucket(store,{datasetWrites=false}={}){
 const writes=[];
 const allowed=key=>key===IDENTITY_OBJECT||(datasetWrites&&DATASET_KEY.test(key));
 return {
  writes,
  get:key=>store.get(key),head:key=>store.head(key),list:options=>store.list(options),
  async put(key,value,options){
   if(!allowed(key))throw new ProvisionError('Write refused: '+key+' is not a key this command may write',3);
   writes.push(key);return store.put(key,value,options);
  },
  async delete(){throw new ProvisionError('Delete refused: the operator never deletes',3);},
 };
}

export function migrationFiles(repo=REPO){
 const list=directory=>fs.readdirSync(path.join(repo,directory)).filter(name=>/^\d{4}_[A-Za-z0-9_]+\.sql$/.test(name)).sort().map(name=>{const file=path.join(directory,name),text=fs.readFileSync(path.join(repo,file),'utf8');return {file,bytes:Buffer.byteLength(text,'utf8'),sha256:sha256(text),text};});
 return [...list('migrations'),...list('diagnostic-migrations')];
}

async function tableCount(d1){
 return (await d1.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'")).length;
}

async function target(d1,config){
 const live=await d1.describe();
 if(live.uuid!==config.databaseId)throw new ProvisionError('The database read back is not the configured one',3);
 if(live.name!==NAMES.database)throw new ProvisionError('The database name must read back as '+NAMES.database,3,{name:live.name});
 return live;
}

async function discoveryState(d1){
 const row=(await d1.rows('SELECT mode, cutover, generation, programme_run_id AS programmeRunId, published_programme_run_id AS publishedProgrammeRunId FROM discovery_authority WHERE id=1'))[0]||null;
 const transfer=(await d1.rows('SELECT state FROM discovery_transfer WHERE id=1'))[0]?.state??null;
 return row?{mode:row.mode,cutover:row.cutover,generation:Number(row.generation),programmeRunId:row.programmeRunId??null,publishedProgrammeRunId:row.publishedProgrammeRunId??null,transfer}:null;
}
const untouched=state=>!!state&&state.generation===0&&state.programmeRunId==null&&state.publishedProgrammeRunId==null&&state.transfer==='idle'&&state.cutover==='open';
// The diagnostic domain must carry its own identity (D1 row and R2 object) before anything is prepared or loaded into it.
async function verifyIdentity(d1,bucket,Diag,config){
 const row=(await d1.rows('SELECT domain, resource_id FROM '+Diag.IDENTITY_TABLE+' WHERE id=1'))[0];
 const object=await bucket.get(IDENTITY_OBJECT);const stored=object?await object.json():null;
 const ok=!!row&&row.domain===Diag.DOMAIN&&row.resource_id===config.resourceId&&stored?.domain===Diag.DOMAIN&&stored?.resourceId===config.resourceId;
 if(!ok)throw new ProvisionError('The identity of the diagnostic domain is not written or does not match; run identity first',3);
}

async function prepareDomain({d1,bucket,Diag,config,report,apply}){
 await verifyIdentity(d1,bucket,Diag,config);
 const before=await discoveryState(d1);
 report.discoveryAuthority={before};
 if(untouched(before)&&before.mode==='d1'){report.prepared='already';report.writes={d1:d1.stats.writes,r2:bucket.writes.length};return report;}
 if(!(untouched(before)&&before.mode==='r2'))throw new ProvisionError('The Discovery authority of the diagnostic domain is neither the seeded state nor the prepared one; nothing was changed',3,{report});
 if(!apply){report.prepared='would_write';report.writes={d1:0,r2:0};return report;}
 await d1.binding.prepare("UPDATE discovery_authority SET mode='d1' WHERE id=1 AND mode='r2' AND cutover='open' AND generation=0 AND programme_run_id IS NULL AND published_programme_run_id IS NULL AND EXISTS (SELECT 1 FROM discovery_transfer WHERE id=1 AND state='idle')").bind().run();
 const after=await discoveryState(d1);
 report.discoveryAuthority.after=after;report.writes={d1:d1.stats.writes,r2:bucket.writes.length};
 if(!(untouched(after)&&after.mode==='d1'))throw new ProvisionError('The Discovery authority read back is not d1/open',3,{report});
 report.prepared='written';
 return report;
}

async function putDataset({d1,bucket,Diag,config,report,apply,input,s3Allowed}){
 await verifyIdentity(d1,bucket,Diag,config);
 const file=outsideRepo(input,'--input');
 const text=fs.readFileSync(file,'utf8');
 let dataset;try{dataset=JSON.parse(text);}catch{throw new ProvisionError('The dataset file is not JSON',2);}
 const Replay=loadReplay();
 const checked=await Replay.verifyDataset(dataset);
 if(!checked.ok)throw new ProvisionError('The dataset does not verify: '+checked.problems.join(','),3,{problems:checked.problems});
 const key='diagnostic/replay/'+dataset.digest+'.json';
 if(apply)s3Allowed.add(key);
 report.dataset={digest:dataset.digest,programmeRunId:dataset.source.programmeRunId,counts:dataset.counts,fidelity:dataset.fidelity,bytes:Buffer.byteLength(text,'utf8'),key};
 const existing=await bucket.get(key);
 if(existing){
  if((await existing.text())!==text)throw new ProvisionError('An object with a different content already holds that key; nothing was written',3,{report});
  report.dataset.state='already_present';report.writes={d1:d1.stats.writes,r2:bucket.writes.length};return report;
 }
 if(!apply){report.dataset.state='would_write';report.writes={d1:0,r2:0};return report;}
 const stored=await bucket.put(key,text,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
 if(stored===null)throw new ProvisionError('The dataset object appeared meanwhile and was not overwritten; run the dry run again',3,{report});
 const back=await bucket.get(key);const backText=back?await back.text():null;
 let sound=backText===text;
 if(sound){const reread=await Replay.verifyDataset(JSON.parse(backText),{expectedDigest:dataset.digest});sound=reread.ok;}
 report.writes={d1:d1.stats.writes,r2:bucket.writes.length};
 if(!sound)throw new ProvisionError('The dataset read back does not equal the file',3,{report});
 report.dataset.state='written';
 return report;
}

// dataset-build: READS the production bucket only. The credential is the read-only snapshot key; the store has no allowed write, so a put is refused before a request exists.
export function readProductionRead(env=process.env){
 const value=name=>String(env[name]||'').trim();
 const accountId=value('EPG_DIAGNOSTIC_ACCOUNT_ID')||value('R2_SNAPSHOT_ACCOUNT_ID'),accessKeyId=value('R2_SNAPSHOT_ACCESS_KEY_ID'),secretAccessKey=value('R2_SNAPSHOT_SECRET_ACCESS_KEY');
 const fail=message=>{throw new ProvisionError(message,2);};
 if(!/^[0-9a-f]{32}$/.test(accountId))fail('EPG_DIAGNOSTIC_ACCOUNT_ID (or R2_SNAPSHOT_ACCOUNT_ID) must be the 32-character account id');
 if(!accessKeyId||!secretAccessKey)fail('R2_SNAPSHOT_ACCESS_KEY_ID and R2_SNAPSHOT_SECRET_ACCESS_KEY (the read-only production key) are required');
 const canonical='https://'+accountId+'.r2.cloudflarestorage.com';
 const endpoint=trustedOrigin(env.EPG_DIAGNOSTIC_PRODUCTION_R2_ENDPOINT,canonical,canonical,'EPG_DIAGNOSTIC_PRODUCTION_R2_ENDPOINT');
 return {accountId,accessKeyId,secretAccessKey,endpoint};
}
export async function buildDataset({env=process.env,fetchImpl=fetch,store=null,output=null,generation=null,confirm=null,now=()=>new Date()}={}){
 if(confirm!==CONFIRM['dataset-build'])throw new ProvisionError('dataset-build needs --confirm '+CONFIRM['dataset-build'],2);
 const dir=outsideRepo(output,'--output');
 if(generation!==null&&!/^[A-Za-z0-9-]{8,80}$/.test(String(generation)))throw new ProvisionError('--generation is not a programme run id',2);
 const cfg=readProductionRead(env);
 const source=store||createS3Store({credentials:readCredentials({R2_SNAPSHOT_ACCOUNT_ID:cfg.accountId,R2_SNAPSHOT_ACCESS_KEY_ID:cfg.accessKeyId,R2_SNAPSHOT_SECRET_ACCESS_KEY:cfg.secretAccessKey,R2_SNAPSHOT_BUCKET:PRODUCTION.bucket,R2_SNAPSHOT_ENDPOINT:cfg.endpoint}),fetchImpl});
 const reader={get:key=>source.get(key)};
 let id=generation;
 if(id===null){
  const pointer=await source.get(PRODUCTION_POINTER);
  const body=pointer?await pointer.json():null;
  if(!body||body.phase!=='published'||typeof body.programmeRunId!=='string')throw new ProvisionError('The production published-generation pointer does not name a published generation',3);
  id=body.programmeRunId;
 }
 const Replay=loadReplay();
 let dataset;
 try{dataset=await Replay.buildDataset(reader,{programmeRunId:id,builtAt:now().toISOString()});}
 catch(error){throw new ProvisionError('The generation cannot be turned into a dataset: '+String(error?.reason||error?.message||'failed').slice(0,120),3,{reason:error?.reason??null});}
 const text=JSON.stringify(dataset);
 const checked=await Replay.verifyDataset(JSON.parse(text),{expectedDigest:dataset.digest,expectedProgrammeRunId:id});
 if(!checked.ok)throw new ProvisionError('The built dataset does not verify: '+checked.problems.join(','),3,{problems:checked.problems});
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const file=path.join(dir,'epg-replay-'+dataset.digest+'.json');
 try{fs.writeFileSync(file,text,{flag:'wx',mode:0o600});}
 catch(error){throw new ProvisionError(error?.code==='EEXIST'?'The dataset file already exists and is never overwritten':'The dataset file cannot be written',3);}
 return {command:'dataset-build',mode:'read-only',source:{bucket:PRODUCTION.bucket,programmeRunId:id},dataset:{digest:dataset.digest,counts:dataset.counts,fidelity:dataset.fidelity,bytes:Buffer.byteLength(text,'utf8')},file,writes:{cloudflare:0}};
}

// Every step reports and returns; nothing but the two apply commands writes.
export async function run({command,apply=false,confirm=null,env=process.env,fetchImpl=fetch,store=null,files=null,diagnostic=null,input=null,sleep}={}){
 if(!['check','schema','identity','prepare-domain','dataset-put'].includes(command))throw new ProvisionError('Usage: <check|schema|identity|prepare-domain|dataset-put|dataset-build> [--apply --confirm <string>]',2);
 if(apply&&command==='check')throw new ProvisionError('check never writes',2);
 if(apply&&confirm!==CONFIRM[command])throw new ProvisionError('--apply needs --confirm '+CONFIRM[command],2);
 const config=readConfig(env);
 const Diag=diagnostic||loadDiagnostic();
 const d1=createD1Client({config,fetchImpl,sleep});
 const live=await target(d1,config);
 // The lower store allows the identity object only; `dataset-put` adds exactly the digest-derived key of the dataset it has verified, and no other command can write it.
 const s3Allowed=new Set([IDENTITY_OBJECT]);
 const bucketStore=store||createS3Store({credentials:readCredentials({R2_SNAPSHOT_ACCOUNT_ID:config.accountId,R2_SNAPSHOT_ACCESS_KEY_ID:config.accessKeyId,R2_SNAPSHOT_SECRET_ACCESS_KEY:config.secretAccessKey,R2_SNAPSHOT_BUCKET:config.bucket,R2_SNAPSHOT_ENDPOINT:config.r2Endpoint}),fetchImpl,allowedWrites:s3Allowed});
 const bucket=guardedBucket(bucketStore,{datasetWrites:command==='dataset-put'});
 const report={command,mode:apply?'apply':'dry-run',database:{name:live.name,tables:await tableCount(d1)},bucket:{name:config.bucket,objects:((await bucket.list({limit:1})).objects||[]).length},resourceId:config.resourceId};

 if(command==='check'){report.assess=await Diag.assess({DB:d1.binding,BUCKET:bucket,resourceId:config.resourceId});try{report.discoveryAuthority=await discoveryState(d1);}catch{report.discoveryAuthority=null;}report.writes={d1:d1.stats.writes,r2:bucket.writes.length};return report;}

 if(command==='schema'){
  const plan=files||migrationFiles();
  report.files=plan.map(({file,bytes,sha256:digest})=>({file,bytes,sha256:digest}));
  if(report.database.tables!==0)throw new ProvisionError('The diagnostic database already has tables; the schema is applied only to an empty one',3,{report});
  if(!apply){report.writes={d1:0,r2:0};return report;}
  const applied=[];
  for(const item of plan){
   try{await d1.exec(item.text);}catch(error){throw new ProvisionError('Stopped at '+item.file+': '+error.message,3,{report:{...report,applied,failedAt:item.file,kind:error.details?.kind||null}});}
   applied.push(item.file);
  }
  report.applied=applied;report.database.tables=await tableCount(d1);
  report.assess=await Diag.assess({DB:d1.binding,BUCKET:bucket,resourceId:config.resourceId});
  report.writes={d1:d1.stats.writes,r2:bucket.writes.length};
  if(!report.assess.ok)throw new ProvisionError('The schema is applied but the diagnostic domain is not in the state `provision` requires: '+report.assess.reason,3,{report});
  return report;
 }

 if(command==='prepare-domain')return prepareDomain({d1,bucket,Diag,config,report,apply});
 if(command==='dataset-put')return putDataset({d1,bucket,Diag,config,report,apply,input,s3Allowed});

 // identity
 report.assess=await Diag.assess({DB:d1.binding,BUCKET:bucket,resourceId:config.resourceId});
 if(!report.assess.ok)throw new ProvisionError('NO-GO: '+report.assess.reason,3,{report});
 if(!apply){report.writes={d1:0,r2:0};return report;}
 let done;
 try{done=await Diag.provision({DB:d1.binding,BUCKET:bucket,resourceId:config.resourceId});}
 catch(error){
  // `provision` writes the R2 identity object first, then the D1 row. An interruption between them leaves the bucket non-empty, so a retry is refused by design: report both sides, do not retry.
  const sides={r2:null,d1:null};
  try{sides.r2=(await bucket.head(IDENTITY_OBJECT))?'present':'absent';}catch{sides.r2='unreadable';}
  try{sides.d1=(await d1.rows('SELECT count(*) AS n FROM '+Diag.IDENTITY_TABLE))[0]?.n>0?'present':'absent';}catch{sides.d1='unreadable';}
  throw new ProvisionError('The identity write was interrupted; verify both sides, do not retry and do not insert by hand: '+String(error?.message||'').slice(0,200),3,{report:{...report,identity:'interrupted',sides,writes:{d1:d1.stats.writes,r2:bucket.writes.length}}});
 }
 if(!done.ok)throw new ProvisionError('provision refused: '+done.reason,3,{report:{...report,provision:done}});
 const row=await d1.rows('SELECT domain, resource_id FROM '+Diag.IDENTITY_TABLE+' WHERE id=1');
 const object=await bucket.get(IDENTITY_OBJECT);const stored=object?await object.json():null;
 report.readback={d1:row[0]?{domain:row[0].domain,resourceId:row[0].resource_id}:null,r2:stored?{domain:stored.domain,resourceId:stored.resourceId}:null};
 const ok=row.length===1&&row[0].domain===Diag.DOMAIN&&row[0].resource_id===config.resourceId&&stored?.domain===Diag.DOMAIN&&stored?.resourceId===config.resourceId;
 report.writes={d1:d1.stats.writes,r2:bucket.writes.length};
 if(!ok)throw new ProvisionError('The identity read back from D1 and R2 does not match',3,{report});
 report.identity='written';
 return report;
}

function main(argv){
 const [command,...rest]=argv;
 const value=flag=>{const i=rest.indexOf(flag);return i<0?null:rest[i+1];};
 if(command==='dataset-build')return buildDataset({output:value('--output'),generation:value('--generation'),confirm:value('--confirm')});
 return run({command,apply:rest.includes('--apply'),confirm:value('--confirm'),input:value('--input')});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).then(report=>{console.log(JSON.stringify(report));}).catch(error=>{
  const known=error instanceof ProvisionError;
  console.error(JSON.stringify({error:known?error.message:'unexpected failure',details:known?error.details:undefined}));
  process.exit(known?error.exitCode:1);
 });
}
