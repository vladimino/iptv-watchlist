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
export const CONFIRM=Object.freeze({schema:'APPLY_EPG_DIAGNOSTIC_SCHEMA',identity:'PROVISION_EPG_DIAGNOSTIC_IDENTITY'});
export const DEFAULT_ENDPOINT='https://api.cloudflare.com/client/v4';
const IDENTITY_OBJECT='diagnostic/identity.json';
const sha256=value=>createHash('sha256').update(value).digest('hex');

export class ProvisionError extends Error{constructor(message,exitCode=3,details={}){super(message);this.name='ProvisionError';this.exitCode=exitCode;this.details=details;}}

// The Worker's own module, loaded standalone (it has no imports): `assess` and `provision` are the Worker's judgement, not a copy of it.
export function loadDiagnostic(file=path.join(REPO,'src/epg-diagnostic.js')){return new Function(fs.readFileSync(file,'utf8')+'\nreturn EpgDiagnostic;')();}

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
export function guardedBucket(store){
 const writes=[];
 return {
  writes,
  get:key=>store.get(key),head:key=>store.head(key),list:options=>store.list(options),
  async put(key,value,options){
   if(key!==IDENTITY_OBJECT)throw new ProvisionError('Write refused: only '+IDENTITY_OBJECT+' may be written',3);
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

// Every step reports and returns; nothing but the two apply commands writes.
export async function run({command,apply=false,confirm=null,env=process.env,fetchImpl=fetch,store=null,files=null,diagnostic=null,sleep}={}){
 if(!['check','schema','identity'].includes(command))throw new ProvisionError('Usage: <check|schema|identity> [--apply --confirm <string>]',2);
 if(apply&&command==='check')throw new ProvisionError('check never writes',2);
 if(apply&&confirm!==CONFIRM[command])throw new ProvisionError('--apply needs --confirm '+CONFIRM[command],2);
 const config=readConfig(env);
 const Diag=diagnostic||loadDiagnostic();
 const d1=createD1Client({config,fetchImpl,sleep});
 const live=await target(d1,config);
 const bucketStore=store||createS3Store({credentials:readCredentials({R2_SNAPSHOT_ACCOUNT_ID:config.accountId,R2_SNAPSHOT_ACCESS_KEY_ID:config.accessKeyId,R2_SNAPSHOT_SECRET_ACCESS_KEY:config.secretAccessKey,R2_SNAPSHOT_BUCKET:config.bucket,R2_SNAPSHOT_ENDPOINT:config.r2Endpoint}),fetchImpl,allowedWrites:new Set([IDENTITY_OBJECT])});
 const bucket=guardedBucket(bucketStore);
 const report={command,mode:apply?'apply':'dry-run',database:{name:live.name,tables:await tableCount(d1)},bucket:{name:config.bucket,objects:((await bucket.list({limit:1})).objects||[]).length},resourceId:config.resourceId};

 if(command==='check'){report.assess=await Diag.assess({DB:d1.binding,BUCKET:bucket,resourceId:config.resourceId});report.writes={d1:d1.stats.writes,r2:bucket.writes.length};return report;}

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
 return run({command,apply:rest.includes('--apply'),confirm:value('--confirm')});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).then(report=>{console.log(JSON.stringify(report));}).catch(error=>{
  const known=error instanceof ProvisionError;
  console.error(JSON.stringify({error:known?error.message:'unexpected failure',details:known?error.details:undefined}));
  process.exit(known?error.exitCode:1);
 });
}
