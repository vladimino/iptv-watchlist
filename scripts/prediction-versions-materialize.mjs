// One-time materialization of historical prediction version objects (ADR-0026, docs/runbooks/prediction-versions.md).
// `plan` reads a verified consistent_fenced snapshot only and writes a private plan: per film, the bundle's ETag and SHA-256
// exactly as the snapshot saw them, in batches of at most 50. `rehearse` runs the Worker's own materialization code against an
// in-memory copy of the snapshot's bundles (no network) and checks the result. `validate` and `apply` send the planned batches
// to the owner-only Worker route; both first re-check the plan against origin.json. Film ids and keys stay in the private
// output directory; standard output carries counts only.
import {createHash,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {planMaterialization} from './prediction-versions-plan.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const BATCH_SIZE=50;
const sha256=value=>createHash('sha256').update(value).digest('hex');
export class MaterializeError extends Error{constructor(message,exitCode=1){super(message);this.name='MaterializeError';this.exitCode=exitCode;}}
function outside(target,label){
 if(typeof target!=='string'||!path.isAbsolute(target))throw new MaterializeError(label+' must be an absolute path',2);
 const resolved=path.resolve(target);
 if(resolved===ROOT||resolved.startsWith(ROOT+path.sep))throw new MaterializeError(label+' must be outside the Git repository',2);
 return resolved;
}

// The plan: films whose bundle needs a rewrite and has no stop condition, with the snapshot's view of each bundle.
export async function plan({snapshot,output}){
 const snapshotPath=outside(snapshot,'--snapshot'),outputPath=outside(output,'--output');
 const manifest=JSON.parse(await readFile(path.join(snapshotPath,'manifest.json'),'utf8'));
 if(manifest.status!=='consistent_fenced')throw new MaterializeError('The snapshot is not consistent_fenced',3);
 const planned=await planMaterialization(snapshotPath),byKey=new Map(manifest.objects.map(entry=>[entry.key,entry]));
 const items=[],stops={malformed:0,checksumMismatch:0,unreadable:0};
 for(const film of planned.films){
  if(film.unreadable){stops.unreadable++;continue;}
  if(film.malformed?.length){stops.malformed++;continue;}
  if(film.objects?.some(object=>object.action==='checksum_mismatch')){stops.checksumMismatch++;continue;}
  if(!film.bundleRewriteNeeded)continue;
  const entry=byKey.get(film.bundleKey),etag=entry?.metadata?.etag;
  if(!etag)throw new MaterializeError('The snapshot manifest lacks the ETag of a bundle',3);
  items.push({filmId:film.storedId,expectedEtag:String(etag).replace(/^"(.*)"$/,'$1'),expectedSha256:entry.sha256,records:film.objects.length});
 }
 items.sort((a,b)=>a.filmId<b.filmId?-1:a.filmId>b.filmId?1:0);
 const lines=items.map((item,index)=>JSON.stringify({batch:Math.floor(index/BATCH_SIZE),item})),planText=lines.join('\n')+(lines.length?'\n':'');
 const origin={schemaVersion:1,planId:planned.snapshot.aggregateSha256,snapshotFinishedAt:planned.snapshot.finishedAt,planSha256:sha256(planText),batches:Math.ceil(items.length/BATCH_SIZE),films:items.length,records:items.reduce((sum,item)=>sum+item.records,0)};
 const report={schemaVersion:1,tool:'prediction-versions-materialize',privacy:'Counts only; film ids are in the private plan.jsonl.',planId:origin.planId,snapshotFinishedAt:origin.snapshotFinishedAt,totals:planned.totals,planned:{films:origin.films,records:origin.records,batches:origin.batches},stops};
 await mkdir(outputPath,{recursive:true,mode:0o700});
 await writeFile(path.join(outputPath,'origin.json'),JSON.stringify(origin,null,1)+'\n',{mode:0o600});
 await writeFile(path.join(outputPath,'plan.jsonl'),planText,{mode:0o600});
 await writeFile(path.join(outputPath,'report.json'),JSON.stringify(report,null,1)+'\n',{mode:0o600});
 return report;
}

export async function loadPlan(output){
 const outputPath=outside(output,'--output');
 let origin;try{origin=JSON.parse(await readFile(path.join(outputPath,'origin.json'),'utf8'));}catch{throw new MaterializeError('origin.json is missing; run plan first',2);}
 const text=await readFile(path.join(outputPath,'plan.jsonl'),'utf8');
 if(sha256(text)!==origin.planSha256)throw new MaterializeError('plan.jsonl differs from origin.json',3);
 const batches=[];for(const line of text.split('\n').filter(Boolean)){const {batch,item}=JSON.parse(line);(batches[batch]||=[]).push({filmId:item.filmId,expectedEtag:item.expectedEtag,expectedSha256:item.expectedSha256});}
 return {origin,batches,outputPath};
}

// An in-memory bucket with the snapshot's bundles and version objects, keyed and tagged as R2 had them.
function snapshotBucket(snapshotPath,manifest){
 const records=new Map(),etags=new Map();let revision=0;
 for(const entry of manifest.objects){
  if(!/^enrichment\/films\/[^/]+\/predictions(\.json|\/versions\/[0-9a-f]{64}\.json)$/.test(entry.key))continue;
  records.set(entry.key,fs.readFileSync(path.join(snapshotPath,entry.file),'utf8'));etags.set(entry.key,String(entry.metadata?.etag||'snapshot').replace(/^"(.*)"$/,'$1'));
 }
 return {records,etags,
  async get(key){return records.has(key)?{etag:etags.get(key),text:async()=>records.get(key),json:async()=>JSON.parse(records.get(key))}:null;},
  async put(key,value,options={}){const c=options.onlyIf||{};if(c.etagDoesNotMatch==='*'&&records.has(key)||c.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,String(value));etags.set(key,'rehearsal-'+(++revision));return {etag:etags.get(key)};},
  async delete(key){records.delete(key);},async list(){return {objects:[],truncated:false};}};
}
export function workerContext(){
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{}});
 vm.runInContext(['src/domain/film-person.js','src/domain/prediction-versions.js'].map(file=>fs.readFileSync(path.join(ROOT,file),'utf8')).join('\n'),ctx);
 for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(path.join(ROOT,file),'utf8').replace('export default','globalThis.worker='),ctx);
 return ctx;
}
async function post(ctx,env,body){const response=await ctx.worker.fetch(new Request('https://rehearsal.local/api/enrichment/predictions/materialize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);return {status:response.status,data:await response.json()};}

// Offline rehearsal on the snapshot: apply every batch, apply them all again (replays), then check every bundle and object.
export async function rehearse({snapshot,output}){
 const snapshotPath=outside(snapshot,'--snapshot'),{origin,batches,outputPath}=await loadPlan(output);
 const manifest=JSON.parse(await readFile(path.join(snapshotPath,'manifest.json'),'utf8'));
 if(manifest.totals?.aggregateSha256!==origin.planId)throw new MaterializeError('The snapshot is not the one the plan was made from',3);
 const bucket=snapshotBucket(snapshotPath,manifest),env={BUCKET:bucket,PREDICTION_MATERIALIZATION:'on',PREDICTION_VERSION_OBJECTS:'on'},ctx=workerContext();
 const before=new Map([...bucket.records].filter(([key])=>key.endsWith('/predictions.json')).map(([key,text])=>[key,JSON.parse(text)]));
 const outcomes={},statuses={},replays={},incomplete=[];
 for(const [batch,items] of batches.entries()){
  const dry=await post(ctx,env,{planId:origin.planId,batch,items,dryRun:true});statuses['dry_'+dry.status]=(statuses['dry_'+dry.status]||0)+1;
  const result=await post(ctx,env,{planId:origin.planId,batch,items});statuses[result.status]=(statuses[result.status]||0)+1;
  if(dry.data.complete!==true||result.data.complete!==true)incomplete.push(batch);
  for(const [key,value] of Object.entries(result.data.outcomes||{}))outcomes[key]=(outcomes[key]||0)+value;
 }
 for(const [batch,items] of batches.entries()){const again=await post(ctx,env,{planId:origin.planId,batch,items});replays[again.data.replay?'replay':'not_replay']=(replays[again.data.replay?'replay':'not_replay']||0)+1;}
 const rules=vm.runInContext('({predictionMaterializationPlan,predictionVersionBody})',ctx),check={bundles:0,pending:0,malformed:0,linked:0,objectMismatch:0,bodyChanged:0,provenance:0};
 for(const [key,old] of before){
  const filmId=decodeURIComponent(key.split('/')[2]),now=JSON.parse(bucket.records.get(key)),result=rules.predictionMaterializationPlan(filmId,now);
  check.bundles++;check.pending+=result.pending.length;check.malformed+=result.malformed.length;check.linked+=result.linked.length;
  if(now.materialized?.planId===origin.planId)check.provenance++;
  if(JSON.stringify(rules.predictionVersionBody(old.current))!==JSON.stringify(rules.predictionVersionBody(now.current)))check.bodyChanged++;
  for(const item of result.linked){const text=bucket.records.get(item.r2Key);if(!text||sha256(text)!==item.contentSha256||text!==JSON.stringify(rules.predictionVersionBody(item.role==='current'?now.current:now.history[item.index])))check.objectMismatch++;}
 }
 const report={schemaVersion:1,mode:'rehearse',network:false,planId:origin.planId,batches:batches.length,statuses,outcomes,replays,incomplete,check,ok:!incomplete.length&&check.pending===0&&check.malformed===0&&check.objectMismatch===0&&check.bodyChanged===0&&check.provenance===check.bundles&&!replays.not_replay};
 await writeFile(path.join(outputPath,'rehearse.json'),JSON.stringify(report,null,1)+'\n',{mode:0o600});
 return report;
}

// Cloudflare Access service-token headers come from the environment only and are never printed or written.
function accessHeaders(env){const id=env.PREDICTION_MATERIALIZE_ACCESS_CLIENT_ID,secret=env.PREDICTION_MATERIALIZE_ACCESS_CLIENT_SECRET;return id&&secret?{'CF-Access-Client-Id':id,'CF-Access-Client-Secret':secret}:{};}
export async function remote({mode,output,endpoint,fromBatch=0,toBatch=null,fetchImpl=fetch,env=process.env}){
 if(!['validate','apply'].includes(mode))throw new MaterializeError('Unknown mode',2);
 let url;try{url=new URL(endpoint);}catch{throw new MaterializeError('--endpoint must be a URL',2);}
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.hostname.endsWith('.localhost');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local))throw new MaterializeError('--endpoint must use HTTPS',2);
 const target=new URL('/api/enrichment/predictions/materialize',url.origin).toString(),{origin,batches,outputPath}=await loadPlan(output);
 const last=Math.min(toBatch??batches.length-1,batches.length-1),results=[],totals={};
 for(let batch=fromBatch;batch<=last;batch++){
  const response=await fetchImpl(target,{method:'POST',headers:{'Content-Type':'application/json',...accessHeaders(env)},body:JSON.stringify({planId:origin.planId,batch,items:batches[batch],dryRun:mode==='validate'}),redirect:'error'});
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok){results.push({batch,status:response.status,error:data?.reason||data?.error||'http_'+response.status});break;}
  for(const [key,value] of Object.entries(data.outcomes||{}))totals[key]=(totals[key]||0)+value;
  // An incomplete batch (a film to re-plan or to investigate) is reported and left unsealed; the next batches are independent.
  results.push({batch,status:response.status,replay:!!data.replay,complete:data.complete===true,classes:data.classes,outcomes:data.outcomes});
 }
 const failed=results.find(result=>result.error)||null,incomplete=results.filter(result=>!result.error&&!result.complete).map(result=>({batch:result.batch,classes:result.classes}));
 const summary={schemaVersion:2,mode,planId:origin.planId,batchesRequested:last-fromBatch+1,batchesDone:results.filter(result=>!result.error).length,batchesComplete:results.filter(result=>result.complete).length,incomplete,failed,totals};
 await writeFile(path.join(outputPath,mode+'.json'),JSON.stringify({...summary,results},null,1)+'\n',{mode:0o600});
 return summary;
}

function parseArgs(argv){
 const [mode,...rest]=argv,args={mode},names={'--snapshot':'snapshot','--output':'output','--endpoint':'endpoint','--from-batch':'fromBatch','--to-batch':'toBatch'};
 for(let i=0;i<rest.length;i++){const name=names[rest[i]];if(!name||i+1>=rest.length)throw new MaterializeError('Usage: prediction-versions-materialize.mjs plan|rehearse --snapshot <abs> --output <abs> | validate|apply --output <abs> --endpoint <https://…> [--from-batch n] [--to-batch n]',2);args[name]=rest[++i];}
 for(const key of ['fromBatch','toBatch'])if(args[key]!=null){args[key]=Number(args[key]);if(!Number.isInteger(args[key])||args[key]<0)throw new MaterializeError('Batch numbers are non-negative integers',2);}
 return args;
}
async function main(){
 try{
  const args=parseArgs(process.argv.slice(2));
  if(args.mode==='plan'||args.mode==='rehearse'){if(!args.snapshot||!args.output)throw new MaterializeError(args.mode+' needs --snapshot and --output',2);const report=await(args.mode==='plan'?plan(args):rehearse(args));console.log(JSON.stringify(report));if(args.mode==='rehearse'&&!report.ok)process.exit(3);return;}
  if(!args.output||!args.endpoint)throw new MaterializeError(args.mode+' needs --output and --endpoint',2);
  const summary=await remote(args);console.log(JSON.stringify(summary));if(summary.failed)process.exit(1);if(summary.incomplete.length)process.exit(4);
 }catch(error){console.error(error instanceof MaterializeError?error.message:'Materialization failed');process.exit(error.exitCode||1);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
