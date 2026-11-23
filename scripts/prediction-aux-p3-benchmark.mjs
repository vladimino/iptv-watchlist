// AIR-554 P3 rehearsal: measures the chunked auxiliary cutover (ADR 0202) on ONE disposable, remote Cloudflare D1 database that the owner authorized for this purpose.
// It drives the REAL operator (`execute` of scripts/prediction-aux-cutover-production.mjs: apply 0034 and 0035, close, chunked import, seal, chunked verify, flip) over the SAME D1 REST surface the cutover would use
// (createD1Adapter + createPublishedBinding), with a fetch wrapper that records wall clock and D1's own `meta` per request. Nothing is read from or written to production:
//   - the target is a database uuid AND name given on the command line, which must read back from the API exactly; the production uuid, the production name and any name that is not `iptv-aux-p3-benchmark-*` are refused
//     before the first request; the database must be empty (no table) when the run starts;
//   - the data is SYNTHETIC (the generator below), cut by the real exporter from a loopback fake bucket and converted by the real converter; no production object, no R2 credential and no PII is involved;
//   - the operator itself is not reconfigured: it never sees a production identity here, because the binding is injected, and its own pin is not weakened.
// Usage: node scripts/prediction-aux-p3-benchmark.mjs --database-id <uuid> --database-name iptv-aux-p3-benchmark-YYYYMMDD --output <dir> [--runs 800] [--bytes 45000]
// Credentials: D1_BACKFILL_ACCOUNT_ID and D1_BACKFILL_API_TOKEN from the environment (never printed). Needs NODE_USE_ENV_PROXY=1 behind a proxy.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createD1Adapter,DEFAULT_ENDPOINT} from './d1-backfill.mjs';
import {createPublishedBinding,migrationStatements,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,OperatorStop} from './published-epg-production.mjs';
import * as Op from './prediction-aux-cutover-production.mjs';
import {buildPlan,chunkPlan,slicePlan} from './prediction-aux-d1-import.mjs';
import {exportProductionSnapshot,readCredentials} from './r2-snapshot-export.mjs';
import {convertSnapshot} from './prediction-aux-export-convert.mjs';
import {fakeBucket,envFor,ACCOUNT} from '../tests/r2-fake-bucket-lib.mjs';

export const NAME_PREFIX='iptv-aux-p3-benchmark-';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function scratchTarget(env,{databaseId,databaseName}){
 if(!UUID.test(String(databaseId||'')))throw new Error('--database-id must be a database uuid');
 if(databaseId===PRODUCTION_DATABASE_ID)throw new Error('refused: the target is the production database id');
 if(!String(databaseName||'').startsWith(NAME_PREFIX)||databaseName===PRODUCTION_DATABASE_NAME)throw new Error('refused: the target name must start with '+NAME_PREFIX);
 const accountId=String(env.D1_BACKFILL_ACCOUNT_ID||'').trim(),apiToken=String(env.D1_BACKFILL_API_TOKEN||'').trim();
 if(!/^[0-9a-f]{32}$/.test(accountId)||!apiToken)throw new Error('D1_BACKFILL_ACCOUNT_ID and D1_BACKFILL_API_TOKEN are required in the environment');
 // D1_BACKFILL_ENDPOINT and D1_BACKFILL_DATABASE_ID are deliberately ignored: the only endpoint is Cloudflare's and the only database is the one named on the command line.
 return {accountId,apiToken,endpoint:DEFAULT_ENDPOINT,maxBatchStatements:2000,maxBatchBytes:8*1048576};
}

const sha256=value=>createHash('sha256').update(value).digest('hex');
const rnd=(n,seed)=>{let s=seed,out='';while(out.length<n){s=(s*1103515245+12345)&0x7fffffff;out+=s.toString(36);}return out.slice(0,n);};
export const synthetic=(runs,bytes)=>{
 const o={};
 for(let i=0;i<runs;i++){
  const id='run-'+String(i).padStart(5,'0');
  o['enrichment/sources/'+id+'.json']={['tmdb_'+i]:{title:'Film '+i,modelMetadata:{note:rnd(bytes,i+1)}}};
  o['enrichment/stop-events/'+id+'.json']={event:{id:'evt-'+id,at:'2026-11-20T10:'+String(i%60).padStart(2,'0')+':00.000Z',type:'stop'},delivered:true};
 }
 return o;
};
const json=value=>JSON.stringify(value);
const fenceObjects=()=>({
 'watchlist.json':json({films:[{id:'heat-1995'}]}),'programme.json':json({runId:'run-1',films:[]}),'sync.json':json({updatedAt:'2026-10-26T10:00:00.000Z',failures:[]}),
 'epg/published-generation.json':json({programmeRunId:'run-1',phase:'published'}),'epg/resolver-lease.json':json({id:'lease-1'}),'epg/resolver-continuation.json':json({at:'2026-10-26T10:05:00.000Z',hopId:'hop-7'}),
 'enrichment/writer-lease.json':json({id:'writer-1'}),'enrichment/runner-lease.json':json({id:'runner-1'}),'enrichment/profile/current.json':json({version:3,profileHash:'profile-3'}),
 'enrichment/latest-run.json':json({runId:'enrichment-run-9'})
});

const quantile=(sorted,q)=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(q*sorted.length)-1)]:null;
export const summary=values=>{const s=[...values].sort((a,b)=>a-b);return {n:s.length,min:s[0]??null,median:quantile(s,0.5),p95:quantile(s,0.95),max:s.at(-1)??null,sum:s.reduce((a,b)=>a+b,0)};};

// Every request is recorded: the phase the harness is in, its size, the wall clock of the HTTP round trip and the sums of D1's own per-statement meta.
export function recordingFetch(fetchImpl,log,phase){
 return async(url,init={})=>{
  const started=performance.now();
  const response=await fetchImpl(url,init);
  const ms=performance.now()-started;
  let body=null;try{body=await response.clone().json();}catch{body=null;}
  let request=null;try{request=init.body?JSON.parse(init.body):null;}catch{request=null;}
  const results=Array.isArray(body?.result)?body.result:[];
  const sum=key=>results.reduce((n,item)=>n+Number(item?.meta?.[key]??0),0);
  log.push({at:new Date().toISOString(),phase:phase(),method:init.method||'GET',httpStatus:response.status,wallMs:Math.round(ms*10)/10,
   statements:request?.batch?.length??(request?.sql?request.sql.split(';\n').length:0),requestBytes:Buffer.byteLength(init.body||'','utf8'),
   results:results.length,allSuccess:results.length>0&&results.every(item=>item?.success===true),d1DurationMs:Math.round(sum('duration')*100)/100,rowsRead:sum('rows_read'),rowsWritten:sum('rows_written'),changes:sum('changes'),
   sizeAfter:results.at(-1)?.meta?.size_after??null,servedByRegion:results.at(-1)?.meta?.served_by_region??null,servedByPrimary:results.at(-1)?.meta?.served_by_primary??null});
  return response;
 };
}

async function main(argv){
 const arg=name=>{const i=argv.indexOf(name);return i>=0?argv[i+1]:undefined;};
 const databaseId=arg('--database-id'),databaseName=arg('--database-name'),output=arg('--output');
 const runs=Number(arg('--runs')||800),bytes=Number(arg('--bytes')||45000);
 if(!output)throw new Error('--output is required');
 const target=scratchTarget(process.env,{databaseId,databaseName});
 fs.mkdirSync(output,{recursive:true});
 const log=[];let phase='setup';const marks=[];
 const adapter=createD1Adapter({target,databaseId,fetchImpl:recordingFetch(globalThis.fetch,log,()=>phase)});
 const mark=(name,extra={})=>marks.push({at:new Date().toISOString(),name,...extra});
 const timed=async(name,fn)=>{phase=name;const started=performance.now();const value=await fn();const ms=Math.round((performance.now()-started)*10)/10;marks.push({at:new Date().toISOString(),name,wallMs:ms});return {value,ms};};
 // 1. identity: the API must name exactly the database given on the command line, and it must be empty
 const described=await adapter.describe();
 if(described.uuid!==databaseId||described.name!==databaseName)throw new OperatorStop('target_identity_mismatch',3);
 const tables=await adapter.all("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'");
 if(Number(tables[0].n)!==0)throw new Error('refused: the scratch database is not empty');
 mark('identity_verified',{databaseId,databaseName});
 // 2. network baseline: single trivial reads (HTTP round trip, D1 duration near zero)
 phase='baseline';for(let i=0;i<10;i++)await adapter.all('SELECT 1 AS one');
 // 3. base schema: migrations 0001..0033 as the plain statements of the files, then the fixture row the operator's apply gate requires
 const files=fs.readdirSync('migrations').filter(f=>/^\d{4}_.*\.sql$/.test(f)).sort();
 const base=files.filter(f=>Number(f.slice(0,4))<=33);
 const schema=await timed('schema_0001_0033',async()=>{for(const file of base){phase='schema:'+file.slice(0,4);const statements=migrationStatements(fs.readFileSync(path.join('migrations',file),'utf8'));for(let i=0;i<statements.length;i+=500)await adapter.executeRendered(statements.slice(i,i+500));}});
 await adapter.executeRendered(["UPDATE prediction_domain_authority SET mode='d1' WHERE id=1"]);
 const binding=createPublishedBinding(adapter);
 // 4. the synthetic dataset, cut by the real exporter and converted by the real converter (twice: the capture at the close and the final cut)
 phase='fixture';
 const objects=synthetic(runs,bytes);
 const legacy=Object.fromEntries(Object.entries(objects).map(([k,v])=>[k,json(v)]));
 const bucket=fakeBucket({...fenceObjects(),...legacy},{pageSize:200});
 const endpoint=await bucket.start();
 const credentials=readCredentials(envFor(endpoint));
 const cut=async name=>{const snapshot=fs.mkdtempSync(path.join(os.tmpdir(),'aux-p3-snap-')),out=path.join(output,'capture-'+name);await exportProductionSnapshot({directory:snapshot,credentials,sleep:async()=>{}});await convertSnapshot({snapshot,output:out});fs.rmSync(snapshot,{recursive:true,force:true});await new Promise(r=>setTimeout(r,5));return out;};
 const closeDir=await cut('close'),finalDir=await cut('final');
 await bucket.stop();
 const conv=await Op.loadConverted(closeDir);
 const plan=conv.plan,report=conv.report;
 const chunking=chunkPlan(plan,{generation:1}),slicing=slicePlan(plan,{generation:1,chunkCount:chunking.chunkCount});
 const fixture={source:'synthetic generator of scripts/prediction-aux-p3-benchmark.mjs (no production object)',runs,bytesPerRun:bytes,r2Objects:Object.keys(objects).length,planSha256:conv.planSha256,
  statements:chunking.chunks.reduce((n,c)=>n+c.dataStatements,0),dataBytes:chunking.chunks.reduce((n,c)=>n+c.dataBytes,0),K:chunking.chunkCount,M:slicing.sliceCount,
  chunks:chunking.chunks.map(c=>({no:c.chunkNo,statements:c.statements,bytes:c.bytes})),slices:slicing.slices.map(s=>({no:s.sliceNo,statements:s.statements,bytes:s.bytes}))};
 mark('fixture_ready',fixture);
 const ctx={track:()=>{}};const NOW=Date.now();
 const run=(command,params)=>Op.execute(command,{binding,now:NOW,ctx,params});
 const pin=conv.planSha256;
 // 5. the operator, command by command, each timed; the import and the verification are measured request by request through the recording fetch
 const status0=(await timed('status_before',()=>run('status',{}))).value;
 const apply=await timed('apply_0034_0035',()=>run('apply',{migrationSha256:Op.migrationSha256()}));
 const close=await timed('close',()=>run('close',{generation:0}));
 const imp=await timed('import',()=>run('import',{generation:1,converted:conv,planSha256:pin}));
 const seal=await timed('seal',()=>run('seal',{generation:1,converted:conv,planSha256:pin}));
 const ver=await timed('verify',()=>run('verify',{generation:1,converted:conv,planSha256:pin}));
 const finalCapture=Op.readCapture(finalDir);
 const atFinal=Date.parse(finalCapture.report.snapshot.finishedAt)+60000;
 const SOURCE={kind:'cloudflare-r2-s3',bucket:'iptv',accountId:ACCOUNT};
 const flipParams={generation:1,captureBefore:conv,planSha256:pin,source:SOURCE,captureNow:finalCapture};
 const needed=await run2(Op,binding,ctx,atFinal,flipParams).catch(error=>error);
 const release=needed?.details?.release;
 if(!release)throw new Error('the flip did not print its release: '+(needed?.reason||'unknown'));
 const flip=await timed('flip',()=>Op.execute('flip',{binding,now:atFinal,ctx,params:{...flipParams,release}}));
 const status1=(await timed('status_after',()=>run('status',{}))).value;
 // 6. post-flip readbacks: parity of the totals against the plan
 phase='readback';
 const counts={};for(const [table,n] of (await import('./prediction-aux-d1-import.mjs')).planTotals(plan)){const row=await adapter.get('SELECT count(*) AS n FROM '+table);counts[table]={planned:n,actual:Number(row.n)};}
 const markerRow=await adapter.get('SELECT mode, generation, activated_at FROM prediction_aux_authority WHERE id=1');
 const receipts={chunks:Number((await adapter.get('SELECT count(*) AS n FROM prediction_aux_import_chunk')).n),seals:Number((await adapter.get('SELECT count(*) AS n FROM prediction_aux_seal')).n),slices:Number((await adapter.get('SELECT count(*) AS n FROM prediction_aux_verify_slice')).n)};
 const parity=Object.values(counts).every(c=>c.planned===c.actual)&&markerRow.mode==='d1'&&receipts.chunks===fixture.K&&receipts.slices===fixture.M&&receipts.seals===1;
 // 7. the measurements
 const phaseRows=name=>log.filter(r=>r.phase===name&&r.method==='POST'&&r.results>0&&r.statements>2);
 const importBatches=log.filter(r=>r.phase==='import'&&r.method==='POST'&&r.statements>10);
 const verifyBatches=log.filter(r=>r.phase==='verify'&&r.method==='POST'&&r.statements>10);
 const pick=(rows,key)=>summary(rows.map(r=>r[key]));
 const result={schemaVersion:1,measuredAt:new Date().toISOString(),codeCommit:process.env.BENCH_CODE_COMMIT||null,target:{databaseId,databaseName,region:'WEUR (primary location hint weur)'},fixture,
  marks,wall:{schema_0001_0033Ms:schema.ms,applyMs:apply.ms,closeMs:close.ms,importMs:imp.ms,sealMs:seal.ms,verifyMs:ver.ms,flipMs:flip.ms},
  baselineRoundTripMs:summary(log.filter(r=>r.phase==='baseline').map(r=>r.wallMs)),
  importChunks:{requests:importBatches.length,wallMs:pick(importBatches,'wallMs'),d1DurationMs:pick(importBatches,'d1DurationMs'),rowsWritten:pick(importBatches,'rowsWritten'),rowsRead:pick(importBatches,'rowsRead'),statements:pick(importBatches,'statements'),requestBytes:pick(importBatches,'requestBytes')},
  verifySlices:{requests:verifyBatches.length,wallMs:pick(verifyBatches,'wallMs'),d1DurationMs:pick(verifyBatches,'d1DurationMs'),rowsWritten:pick(verifyBatches,'rowsWritten'),rowsRead:pick(verifyBatches,'rowsRead'),statements:pick(verifyBatches,'statements'),requestBytes:pick(verifyBatches,'requestBytes')},
  integrity:{counts,marker:markerRow,receipts,parity,planShaPinned:pin,flipCommitted:flip.value?.writeState==='committed',allRequestsSucceeded:log.filter(r=>r.method==='POST').every(r=>r.httpStatus===200&&r.allSuccess),statusAfter:{mode:status1?.marker?.mode,generation:status1?.marker?.generation}},
  requests:log};
 fs.writeFileSync(path.join(output,'measurements.json'),JSON.stringify(result,null,1));
 process.stdout.write(JSON.stringify({ok:true,parity,K:fixture.K,M:fixture.M,wall:result.wall,importChunks:result.importChunks.wallMs,verifySlices:result.verifySlices.wallMs,output})+'\n');
}
async function run2(OpMod,binding,ctx,at,params){return OpMod.execute('flip',{binding,now:at,ctx,params});}
const invoked=process.argv[1]&&import.meta.url===new URL('file://'+path.resolve(process.argv[1])).href;
if(invoked){main(process.argv.slice(2)).catch(error=>{process.stderr.write(String(error?.reason||error?.message||error)+'\n');if(error?.details)process.stderr.write(JSON.stringify(error.details)+'\n');process.exitCode=1;});}
void sha256;
