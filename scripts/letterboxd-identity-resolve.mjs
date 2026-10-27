// Identity of unresolved Letterboxd export films from their boxd.it shortlinks. It reads the private reconciliation ledger
// (matches.jsonl) and the imported identities (the baseline import plan.jsonl), and decides each unresolved code with
// src/letterboxd-identity.js. Network access is opt-in (--network): without it the command only re-decides what the private
// checkpoint already holds. With it, it fetches one page at a time, at most one request per second, with bounded timeouts and
// retries, and stops the run on 429, 403 or a challenge page without trying to get past it. Output stays in a private
// directory outside this repository; standard output and error carry counts only, never a code, name, path or rating.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {appendFile,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {allowedHop,buildQueue,decide,isChallenge,isFilmPage,pageEvidence,summarize} from '../src/letterboxd-identity.js';
import {ReconcileError,assertOutsideRepository} from './letterboxd-reconcile.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const sha256=value=>createHash('sha256').update(value).digest('hex');
export const POLICY=Object.freeze({minIntervalMs:1000,timeoutMs:15000,maxRetries:2,retryDelayMs:5000,maxHops:4,maxConsecutiveFailures:3,maxBytes:3_000_000});
const HEADERS={'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html','Accept-Language':'en-US,en;q=0.9'};
const STOP={429:'rate_limited',403:'forbidden'};
export class ResolveError extends Error{constructor(message,exitCode=1){super(message);this.name='ResolveError';this.exitCode=exitCode;}}

// The film page parser the Worker's metadata cache uses; src/sources.js is a Worker script, so it is evaluated in a sandbox.
export function loadPageTools(){
 const context=vm.createContext({});
 vm.runInContext(readFileSync(path.join(ROOT,'src/sources.js'),'utf8')+'\nglobalThis.pageTools={parseFilm,attr,extractYear};',context);
 return context.pageTools;
}

async function readJsonl(file,label){
 let text;try{text=await readFile(file,'utf8');}catch{throw new ResolveError(label+' could not be read',2);}
 const rows=[];
 for(const line of text.split('\n')){if(!line.trim())continue;try{rows.push(JSON.parse(line));}catch{throw new ResolveError(label+' is not JSON Lines',3);}}
 return {rows,sha256:sha256(text)};
}

// The checkpoint is bound to the exact ledger and plan it was made from. A truncated last line (an interrupted write) is ignored.
async function readCheckpoint(file,binding){
 let text;try{text=await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw new ResolveError('Checkpoint could not be read');}
 const lines=text.split('\n').filter(Boolean),observations=new Map();
 lines.forEach((line,i)=>{
  let row;try{row=JSON.parse(line);}catch{if(i===lines.length-1)return;throw new ResolveError('Checkpoint is corrupt',3);}
  if(i===0){if(row.type!=='binding'||row.ledgerSha256!==binding.ledgerSha256||row.importedSha256!==binding.importedSha256)throw new ResolveError('Checkpoint belongs to another ledger or plan',3);return;}
  if(row.type==='observation'&&typeof row.code==='string')observations.set(row.code,row.observation);
 });
 return observations;
}

async function writeAtomic(file,text){await writeFile(file+'.tmp',text,{mode:0o600});await rename(file+'.tmp',file);}

// One request under the network policy. Returns {response, html} or throws a transient error; a stop condition is returned.
function makeClient({fetchImpl,now,sleep,policy,stats}){
 let last=-Infinity;
 return async url=>{
  const wait=last+policy.minIntervalMs-now();if(wait>0)await sleep(wait);
  last=now();stats.requests++;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),policy.timeoutMs);
  try{
   const response=await fetchImpl(url.toString(),{method:'GET',redirect:'manual',headers:HEADERS,signal:controller.signal});
   const html=response.status===200||response.status>=400?String(await response.text()).slice(0,policy.maxBytes):'';
   return {response,html};
  }finally{clearTimeout(timer);}
 };
}

// Follows the shortlink one hop at a time so that every hop is paced and checked. Returns an observation or {stop}.
async function observe(code,request,tools,policy,stats){
 for(let attempt=0;;attempt++){
  let transient=false;
  try{
   let url=new URL('https://boxd.it/'+code);
   for(let hop=0;hop<policy.maxHops;hop++){
    const {response,html}=await request(url),status=response.status;
    if(STOP[status])return {stop:STOP[status]};
    if(isChallenge(status,response.headers,html))return {stop:'challenge'};
    if(status>=300&&status<400){const next=allowedHop(response.headers?.get?.('location'),url);if(!next)return {kind:'redirect_off_site'};url=next;continue;}
    if(status===404||status===410)return {kind:'not_found'};
    if(status>=500){transient=true;break;}
    if(status!==200)return {kind:'unexpected_status'};
    if(!isFilmPage(url))return {kind:'not_film_page'};
    return pageEvidence(html,url,tools);
   }
   if(!transient)return {kind:'too_many_redirects'};
  }catch(error){if(error instanceof ResolveError)throw error;transient=true;}
  if(attempt>=policy.maxRetries)return {kind:'failed'};
  stats.retries++;
  await policy.sleep(policy.retryDelayMs*(attempt+1));
 }
}

export async function resolve({ledger,imported,output,network=false,limit=null,fetchImpl=null,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),policy={},log=()=>{},tools=null}){
 const ledgerPath=await assertOutsideRepository(ledger,'--ledger'),importedPath=await assertOutsideRepository(imported,'--imported'),outputPath=await assertOutsideRepository(output,'--output');
 const effective={...POLICY,...policy,sleep};
 const ledgerFile=await readJsonl(ledgerPath,'--ledger'),importedFile=await readJsonl(importedPath,'--imported');
 const items=importedFile.rows.map(row=>row?.item??row);
 const {queue,importedTmdb,counts}=buildQueue(ledgerFile.rows,items);
 const binding={type:'binding',schemaVersion:1,ledgerSha256:ledgerFile.sha256,importedSha256:importedFile.sha256};
 await mkdir(outputPath,{recursive:true,mode:0o700});
 const checkpoint=path.join(outputPath,'checkpoint.jsonl');
 let observations=await readCheckpoint(checkpoint,binding);
 if(!observations){await writeFile(checkpoint,JSON.stringify(binding)+'\n',{mode:0o600});observations=new Map();}
 const stats={enabled:!!network,requests:0,retries:0,observedThisRun:0,stopReason:null,limitReached:false};
 if(network){
  if(typeof fetchImpl!=='function')throw new ResolveError('A fetch implementation is required with --network',2);
  tools??=loadPageTools();
  const request=makeClient({fetchImpl,now,sleep,policy:effective,stats});
  const todo=queue.filter(entry=>!observations.has(entry.code)||observations.get(entry.code)?.kind==='failed');
  let failures=0;
  for(const entry of todo){
   if(limit!=null&&stats.observedThisRun>=limit){stats.limitReached=true;break;}
   const result=await observe(entry.code,request,tools,effective,stats);
   if(result.stop){stats.stopReason=result.stop;break;}
   observations.set(entry.code,result);stats.observedThisRun++;
   await appendFile(checkpoint,JSON.stringify({type:'observation',code:entry.code,observation:result})+'\n',{mode:0o600});
   failures=result.kind==='failed'?failures+1:0;
   if(failures>=effective.maxConsecutiveFailures){stats.stopReason='consecutive_failures';break;}
   if(stats.observedThisRun%25===0)log(JSON.stringify({observed:stats.observedThisRun,of:todo.length,requests:stats.requests}));
  }
 }
 const decisions=decide(queue,observations,{importedTmdb});
 const report={schemaVersion:1,tool:'letterboxd-identity-resolve',privacy:'Aggregate counts only. Per-film decisions are in the private resolution.jsonl next to this file.',policy:{minIntervalMs:effective.minIntervalMs,timeoutMs:effective.timeoutMs,maxRetries:effective.maxRetries,concurrency:1},network:stats,...summarize(decisions,counts)};
 await writeAtomic(path.join(outputPath,'resolution.jsonl'),decisions.map(row=>JSON.stringify(row)).join('\n')+(decisions.length?'\n':''));
 await writeAtomic(path.join(outputPath,'report.json'),JSON.stringify(report,null,1)+'\n');
 return report;
}

function parseArgs(argv){
 const args={},names={'--ledger':'ledger','--imported':'imported','--output':'output','--limit':'limit'};
 const usage='Usage: letterboxd-identity-resolve.mjs --ledger <abs matches.jsonl> --imported <abs plan.jsonl> --output <abs dir outside the repository> [--network] [--limit n]';
 for(let i=0;i<argv.length;i++){
  if(argv[i]==='--network'){args.network=true;continue;}
  const name=names[argv[i]];if(!name||i+1>=argv.length||argv[i+1].startsWith('--'))throw new ResolveError(usage,2);
  args[name]=argv[++i];
 }
 if(!args.ledger||!args.imported||!args.output)throw new ResolveError(usage,2);
 if(args.limit!=null){args.limit=Number(args.limit);if(!Number.isInteger(args.limit)||args.limit<1)throw new ResolveError('--limit is a positive integer',2);}
 return args;
}

async function main(){
 try{
  const args=parseArgs(process.argv.slice(2));
  const report=await resolve({...args,fetchImpl:args.network?fetch:null,log:line=>console.error(line)});
  console.log(JSON.stringify({queue:report.queue.queued,byDecision:report.byDecision,complete:report.complete,network:report.network}));
  if(report.network.stopReason)process.exit(4);
 }catch(error){
  const known=error instanceof ResolveError||error instanceof ReconcileError;
  console.error(known?error.message:'Identity resolution failed');process.exit(error.exitCode||1);
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
