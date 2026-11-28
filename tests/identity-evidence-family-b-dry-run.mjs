// AIR-622: the read-only dry-run operator of family (b) (scripts/identity-evidence-family-b-dry-run.mjs), offline: a scratch sqlite database built from the real migration chain behind a fake D1 REST
// endpoint and a fake R2 S3 endpoint, both driven through the REAL production wrapper (`run`). No network, no credential value, no production access.
//  - arguments never echo a token; the acquisition and its fail-closed cases; strict D1 reads (a missing result array, a missing COUNT row, a malformed marker, a stalled page);
//  - the R2 target is pinned (account, bucket `iptv`, canonical endpoint) before the first request; no retry; two complete scoped listings with pagination and one GET per object, counted;
//  - paging attacks (a repeated cursor, a broken chain, a truncated Contents, a KeyCount mismatch), 503 and a network failure with exactly one request;
//  - the output files: capture first and always, the import artifact ONLY for a candidate, a diagnostic plan otherwise (no digest), mode 600, a write failure stops;
//  - the report is closed over arbitrary source text (an unknown writer or status never reaches it, and stays in the private capture).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {parseArgs,acquireAndPlan,sanitize,run,describeFailure,r2Source,strictBinding,r2Credentials,PRODUCTION_R2_ENDPOINT} from '../scripts/identity-evidence-family-b-dry-run.mjs';
import {R2_ACTION_PREFIX,readFamilyBSources} from '../src/identity-evidence-family-b.js';
import {ControlledError,UsageError} from '../scripts/letterboxd-claim-cohort-preflight-production.mjs';
import {PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from '../scripts/published-epg-production.mjs';

const NEW='0044_identity_evidence_reconstruction_import.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const chain=files.slice(0,files.indexOf(NEW)+1);
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-family-b-dry-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text,json=false)=>sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const ok=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr);};
const template=path.join(root,'template.sqlite');
ok(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
ok(template,"UPDATE discovery_authority SET mode='d1',cutover='open',generation=5 WHERE id=1");
const lit=value=>"'"+String(value).replace(/'/g,"''")+"'";
let n=0;
const database=()=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;};
const argv=(...rest)=>['node','script',...rest];

// ---- fixtures ----
const OBS='film secret-title|2000';
const KEY=R2_ACTION_PREFIX+'req-r2-1.json';
const record=(id='req-r2-1',observation=OBS)=>({schemaVersion:1,kind:'discovery_identity_action',idempotencyKey:id,state:'succeeded',command:{effect:'reject',tmdbId:'555'},provenance:{observationKey:observation},
 receipt:{state:'succeeded',outcomes:[{id:observation,outcome:'written'}]},issued:{confirmedAt:'2026-11-01T00:00:00.000Z'},finishedAt:'2026-11-01T00:01:00.000Z'});
const history=(file,observation,writer,payload,revision=1)=>ok(file,'INSERT INTO discovery_decision_history (observation_key,revision,generation,written_at,writer,payload_json) VALUES ('+[lit(observation),revision,1,lit('2026-11-02T00:00:00.000Z'),lit(writer),lit(JSON.stringify(payload))].join(',')+')');
const seed=file=>history(file,'film other|1999','resolver_chunk',{status:'verified',identitySource:'tmdb_detail',tmdbId:100,checkedAt:'2026-11-01T00:00:00.000Z'});

// ---- 1. arguments never echo a token ----
assert.throws(()=>parseArgs(argv()),/--out/);
assert.throws(()=>parseArgs(argv('--out')),/needs a path/);
assert.throws(()=>parseArgs(argv('--out','x','--run-id','bad id')),/--run-id/);
{
 const sentinel='--private-sentinel-token';
 let error;try{parseArgs(argv('--out','x',sentinel));}catch(caught){error=caught;}
 assert.ok(error instanceof UsageError);assert.ok(!error.message.includes('sentinel'),'an unknown option is never echoed');assert.ok(!describeFailure(error).includes('sentinel'));
 let bad;try{parseArgs(argv('--out','x','--run-id','sentinel value'));}catch(caught){bad=caught;}
 assert.ok(!bad.message.includes('sentinel'));
}
assert.deepEqual(parseArgs(argv('--out','/tmp/x')),{out:'/tmp/x',runId:null,acceptR2Residual:false},'the R2 residual is never accepted by default');
assert.equal(parseArgs(argv('--out','/tmp/x','--accept-r2-residual','--run-id','r1')).acceptR2Residual,true);

// ---- 2. a fake world: D1 REST over sqlite, R2 S3 over memory ----
const ENV={D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,D1_BACKFILL_API_TOKEN:'token-not-real',R2_SNAPSHOT_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,R2_SNAPSHOT_ACCESS_KEY_ID:'key-not-real',R2_SNAPSHOT_SECRET_ACCESS_KEY:'secret-not-real'};
function world({file,objects={[KEY]:{etag:'e1',body:JSON.stringify(record())}},pageSize=1000,d1=null,r2=null}={}){
 const counts={d1:0,list:0,get:0,other:0};
 const fetchImpl=async(url,init={})=>{
  const target=new URL(url);const method=String(init.method||'GET').toUpperCase();
  if(target.hostname==='api.cloudflare.com'){
   counts.d1++;
   if(method==='GET')return new Response(JSON.stringify({success:true,result:{uuid:PRODUCTION_DATABASE_ID,name:PRODUCTION_DATABASE_NAME}}),{status:200});
   const sql=JSON.parse(init.body).sql;
   const custom=d1?.(sql,counts.d1);if(custom)return custom;
   const out=sqlite(file,sql,true);assert.equal(out.status,0,out.stderr);
   const rows=out.stdout.trim()?JSON.parse(out.stdout):[];
   return new Response(JSON.stringify({success:true,result:[{success:true,results:rows,meta:{rows_read:rows.length,rows_written:0,changed_db:false}}]}),{status:200});
  }
  if(target.hostname.endsWith('.r2.cloudflarestorage.com')){
   const custom=r2?.(target,method,counts);if(custom)return custom;
   const parts=target.pathname.split('/').filter(Boolean);
   if(parts.length===1&&target.searchParams.get('list-type')==='2'){
    counts.list++;
    const keys=Object.keys(objects).filter(key=>key.startsWith(target.searchParams.get('prefix')||'')).sort();
    const start=Number(target.searchParams.get('continuation-token')||0);const slice=keys.slice(start,start+pageSize);const more=start+pageSize<keys.length;
    const xml='<ListBucketResult><IsTruncated>'+more+'</IsTruncated><KeyCount>'+slice.length+'</KeyCount>'+(more?'<NextContinuationToken>'+(start+pageSize)+'</NextContinuationToken>':'')
     +slice.map(key=>'<Contents><Key>'+key+'</Key><Size>'+objects[key].body.length+'</Size><ETag>&quot;'+objects[key].etag+'&quot;</ETag><LastModified>2026-11-01T00:00:00.000Z</LastModified></Contents>').join('')+'</ListBucketResult>';
    return new Response(xml,{status:200});
   }
   if(parts.length>=2){
    counts.get++;
    const key=decodeURIComponent(parts.slice(1).join('/'));const object=objects[key];
    if(!object)return new Response('',{status:404});
    const match=new Headers(init.headers).get('if-match');
    if(match&&match.replace(/"/g,'')!==object.etag)return new Response('',{status:412});
    return new Response(object.body,{status:200,headers:{etag:'"'+object.etag+'"','content-length':String(Buffer.byteLength(object.body))}});
   }
  }
  counts.other++;throw new Error('unexpected request');
 };
 return {fetchImpl,counts};
}
const outputs=()=>path.join(root,'out-'+(n++));
const exec=async(options={},env=ENV,extra=[])=>{
 const w=world(options);const prefix=outputs();const logged=[];
 const report=await run({argv:argv('--out',prefix,...extra),env,fetchImpl:w.fetchImpl,log:text=>logged.push(text)});
 return {report,prefix,counts:w.counts,logged,w};
};
const mode=file=>fs.statSync(file).mode&0o777;

// ---- 3. a complete candidate: files, exact digest, mode 600, counted requests ----
{
 const file=database();seed(file);
 const result=await exec({file,pageSize:1,objects:{[KEY]:{etag:'e1',body:JSON.stringify(record())},[R2_ACTION_PREFIX+'z-nonterminal.json']:{etag:'e2',body:JSON.stringify({schemaVersion:9})}}},ENV,['--accept-r2-residual']);
 assert.equal(result.report.decision,'manifest_candidate');assert.match(result.report.digest,/^[0-9a-f]{64}$/);
 assert.deepEqual([result.counts.list,result.counts.get],[4,2],'two complete listings of two pages each, one GET per object, no retry');
 assert.deepEqual(result.report.r2Calls,{list:4,head:0,get:2});
 const manifest=JSON.parse(fs.readFileSync(result.prefix+'.manifest.json','utf8'));
 assert.equal(manifest.kind,'family_b_import_manifest');assert.equal(manifest.digest,result.report.digest,'the artifact carries exactly the published digest');
 assert.equal(mode(result.prefix+'.manifest.json'),0o600);assert.equal(mode(result.prefix+'.capture.json'),0o600);
 assert.ok(!fs.existsSync(result.prefix+'.diagnostic-plan.json'));
 const capture=JSON.parse(fs.readFileSync(result.prefix+'.capture.json','utf8'));assert.equal(capture.sources.r2Objects.length,2);assert.ok(capture.coverage.complete);
 const text=JSON.stringify(result.report);
 for(const secret of ['secret-title','req-r2-1',KEY,'film other','"555"','token-not-real','secret-not-real'])assert.ok(!text.includes(secret),'the report must not carry '+secret);
 assert.equal(result.logged.length,1);
}

// ---- 4. no_import: the artifact is NOT import-shaped ----
{
 // Without the residual acceptance every R2 record is an exclusion: a diagnostic plan, no digest, no manifest file.
 const file=database();seed(file);
 const refused=await exec({file});
 assert.equal(refused.report.decision,'no_import');assert.equal(refused.report.digest,null);assert.ok(refused.report.reasons.includes('coverage_not_complete'));
 assert.ok(!fs.existsSync(refused.prefix+'.manifest.json'),'no import-shaped file for a run that is not a candidate');
 assert.ok(fs.existsSync(refused.prefix+'.capture.json'));
 if(fs.existsSync(refused.prefix+'.diagnostic-plan.json')){
  const diagnostic=JSON.parse(fs.readFileSync(refused.prefix+'.diagnostic-plan.json','utf8'));
  assert.equal(diagnostic.kind,'family_b_diagnostic_plan_not_importable');assert.equal(diagnostic.digest,undefined);assert.equal(mode(refused.prefix+'.diagnostic-plan.json'),0o600);
 }
 // A listing that moves while the run reads: no candidate and no digest, even with valid D1 records.
 const moved=database();seed(moved);const objects={[KEY]:{etag:'e1',body:JSON.stringify(record())}};
 const shifting=await exec({file:moved,objects,r2:(target,method,counts)=>{if(target.searchParams.get('list-type')==='2'&&counts.list===1)objects[R2_ACTION_PREFIX+'late.json']={etag:'e9',body:JSON.stringify(record('late'))};return null;}},ENV,['--accept-r2-residual']);
 assert.equal(shifting.report.decision,'no_import');assert.equal(shifting.report.digest,null);assert.ok(shifting.report.reasons.includes('r2_listing_moved'));assert.ok(!fs.existsSync(shifting.prefix+'.manifest.json'));
 // A write failure stops the run: nothing is logged and the artifact is never written after a failed capture.
 const failing=world({file:database()});const written=[];const logged=[];
 await assert.rejects(()=>run({argv:argv('--out',outputs(),'--accept-r2-residual'),env:ENV,fetchImpl:failing.fetchImpl,log:text=>logged.push(text),write:file=>{written.push(file);throw new ControlledError('private_output_unavailable');}}),error=>error.code==='private_output_unavailable');
 assert.equal(written.length,1,'the capture is first, and nothing follows its failure');assert.equal(logged.length,0);
}

// ---- 5. strict D1 reads, through the real wrapper ----
{
 const emptyResults=()=>new Response(JSON.stringify({success:true,result:[{success:true,meta:{rows_read:0,rows_written:0,changed_db:false}}]}),{status:200});
 const noRows=()=>new Response(JSON.stringify({success:true,result:[{success:true,results:[],meta:{rows_read:0,rows_written:0,changed_db:false}}]}),{status:200});
 const failure=async(d1,pattern)=>{const w=world({file:database(),d1});await assert.rejects(()=>run({argv:argv('--out',outputs(),'--accept-r2-residual'),env:ENV,fetchImpl:w.fetchImpl,log:()=>{}}),pattern);};
 await failure(sql=>/FROM discovery_decision_history/.test(sql)?emptyResults():null,/no result rows array/);
 await failure(sql=>/FROM discovery_intent/.test(sql)?emptyResults():null,/no result rows array/);
 await failure(sql=>/COUNT\(\*\) AS n FROM discovery_observation\b/.test(sql)&&!/confirmed/.test(sql)?noRows():null,/count_unreadable/);
 // A malformed marker row makes the acquisition not coherent: no candidate.
 const w=world({file:database(),d1:sql=>/FROM discovery_authority/.test(sql)?new Response(JSON.stringify({success:true,result:[{success:true,results:[{mode:null,cutover:'open',generation:5}],meta:{rows_read:1,rows_written:0,changed_db:false}}]}),{status:200}):null});
 const report=await run({argv:argv('--out',outputs(),'--accept-r2-residual'),env:ENV,fetchImpl:w.fetchImpl,log:()=>{}});
 assert.equal(report.decision,'no_import');assert.equal(report.coverage.acquisition.d1.reason,'authority_unreadable');
 // A valid empty page is valid (an empty database).
 const valid=await exec({file:database()},ENV,['--accept-r2-residual']);assert.ok(valid.report.coverage.acquisition.d1.established);
 // A later page without a result array, and a page that does not advance, stop the read.
 const rowsOf=count=>Array.from({length:count},(_,i)=>({observation_key:'k'+i,revision:1,generation:1,written_at:null,writer:'resolver_chunk',payload_json:'{}'}));
 let call=0;
 await assert.rejects(()=>readFamilyBSources({prepare:()=>({bind:()=>({all:async()=>{call++;return call===1?{results:rowsOf(2)}:{};}})})},{pageSize:2}),/read_malformed/);
 await assert.rejects(()=>readFamilyBSources({prepare:()=>({bind:()=>({all:async()=>({results:rowsOf(2)})})})},{pageSize:2}),/page_stalled/);
 // The strict binding refuses a response without a result array.
 await assert.rejects(()=>strictBinding({allStrict:async()=>{throw new Error('no rows');}}).prepare('SELECT 1').bind().all(),/no rows/);
}

// ---- 6. the R2 target is pinned before the first request, and nothing retries ----
{
 const stop=async(env,code)=>{let calls=0;await assert.rejects(()=>run({argv:argv('--out',outputs()),env,fetchImpl:async()=>{calls++;throw new Error('network');},log:()=>{}}),error=>error.code===code);assert.equal(calls,0,'no request before both targets validate ('+code+')');};
 await stop({...ENV,R2_SNAPSHOT_ACCOUNT_ID:'a'.repeat(32)},'r2_target_identity_mismatch');
 await stop({...ENV,R2_SNAPSHOT_BUCKET:'other-bucket'},'r2_target_identity_mismatch');
 await stop({...ENV,R2_SNAPSHOT_ENDPOINT:'https://example.invalid'},'r2_endpoint_refused');
 await stop({...ENV,R2_SNAPSHOT_ENDPOINT:PRODUCTION_R2_ENDPOINT},'r2_endpoint_refused');
 await stop({D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,D1_BACKFILL_API_TOKEN:'t'},'r2_credentials_missing');
 assert.equal(r2Credentials(ENV).bucket,'iptv');
 // 503 and a network failure on a GET: exactly one request, the run stops.
 for(const [name,r2] of [['503',(target,method)=>method==='GET'&&target.pathname.split('/').filter(Boolean).length>=2?new Response('',{status:503}):null],['network',(target,method)=>{if(method==='GET'&&target.pathname.split('/').filter(Boolean).length>=2)throw new Error('reset');return null;}]]){
  const w=world({file:database(),r2});let gets=0;const inner=w.fetchImpl;
  await assert.rejects(()=>run({argv:argv('--out',outputs()),env:ENV,fetchImpl:async(url,init)=>{if(new URL(url).pathname.split('/').filter(Boolean).length>=2&&new URL(url).hostname.endsWith('r2.cloudflarestorage.com'))gets++;return inner(url,init);},log:()=>{}}),Error,name);
  assert.equal(gets,1,name+': one GET, no retry');
 }
 // A 503 on the first listing: one request, no retry.
 let lists=0;const wl=world({file:database(),r2:(target)=>{if(target.searchParams.get('list-type')==='2'){lists++;return new Response('',{status:503});}return null;}});
 await assert.rejects(()=>run({argv:argv('--out',outputs()),env:ENV,fetchImpl:wl.fetchImpl,log:()=>{}}),error=>error.kind==="source_http");assert.equal(lists,1);
}

// ---- 7. paging attacks on the real listing path ----
{
 const listing=async(r2,objects)=>{const w=world({file:database(),objects,r2});return run({argv:argv('--out',outputs(),'--accept-r2-residual'),env:ENV,fetchImpl:w.fetchImpl,log:()=>{}});};
 const two={[KEY]:{etag:'e1',body:JSON.stringify(record())},[R2_ACTION_PREFIX+'b.json']:{etag:'e2',body:'{}'}};
 // A repeated continuation token.
 await assert.rejects(()=>listing((target,method,counts)=>{if(target.searchParams.get('list-type')==='2')return new Response('<ListBucketResult><IsTruncated>true</IsTruncated><KeyCount>1</KeyCount><NextContinuationToken>same</NextContinuationToken><Contents><Key>'+R2_ACTION_PREFIX+'a'+counts.list+'.json</Key><Size>1</Size><ETag>&quot;x&quot;</ETag></Contents></ListBucketResult>',{status:200});return null;},two),error=>/cursor/i.test(error.message)||error.kind==='listing');
 // A truncated Contents element, a KeyCount that disagrees with the entries, a page without IsTruncated.
 const page=inner=>(target)=>target.searchParams.get('list-type')==='2'?new Response('<ListBucketResult><IsTruncated>false</IsTruncated>'+inner+'</ListBucketResult>',{status:200}):null;
 await assert.rejects(()=>listing(page('<KeyCount>1</KeyCount><Contents><Key>'+KEY+'</Key><Size>1</Size><ETag>&quot;x&quot;</ETag>'),two),/incomplete Contents/);
 await assert.rejects(()=>listing(page('<KeyCount>3</KeyCount><Contents><Key>'+KEY+'</Key><Size>1</Size><ETag>&quot;x&quot;</ETag></Contents>'),two),/KeyCount/);
 await assert.rejects(()=>listing((target)=>target.searchParams.get('list-type')==='2'?new Response('<ListBucketResult></ListBucketResult>',{status:200}):null,two),/IsTruncated/);
 // A key outside the scoped prefix is refused.
 await assert.rejects(()=>listing(page('<KeyCount>1</KeyCount><Contents><Key>other/x.json</Key><Size>1</Size><ETag>&quot;x&quot;</ETag></Contents>'),two),error=>error.code==='r2_listing_outside_prefix');
 // Multi-page listing is read whole.
 const many=Object.fromEntries(Array.from({length:5},(_,i)=>[R2_ACTION_PREFIX+'k'+i+'.json',{etag:'e'+i,body:'{}'}]));
 const w=world({file:database(),objects:many,pageSize:2});
 const source=r2Source({calls:{},list:async(cursor,prefix)=>{const r=await w.fetchImpl('https://'+PRODUCTION_ACCOUNT_ID+'.r2.cloudflarestorage.com/iptv?list-type=2&prefix='+encodeURIComponent(prefix)+(cursor?'&continuation-token='+cursor:''));return (await import('../scripts/r2-snapshot-export.mjs')).parseListing(await r.text());},get:async()=>null});
 assert.equal((await source.list()).length,5);
}

// ---- 8. the report is closed over arbitrary source text ----
{
 const file=database();seed(file);
 history(file,'film sentinel-a|2001','sentinel-writer-text',{status:'sentinel-status-text',identitySource:'tmdb_detail',tmdbId:9});
 history(file,'film sentinel-b|2002','resolver_chunk',{status:'sentinel-status-two'});
 ok(file,"INSERT INTO discovery_decision (observation_key,programme_run_id,generation,status,attempts,evidence_key,terminal_reason,retry_at,tmdb_id,media_kind,film_id,decision_hash,payload_json) VALUES ('film sentinel-b|2002',NULL,1,'x',0,NULL,NULL,NULL,NULL,NULL,NULL,'"+'0'.repeat(64)+"','{\"status\":\"sentinel-status-two\"}')");
 const result=await exec({file},ENV,['--accept-r2-residual']);
 const text=JSON.stringify(result.report);
 assert.ok(!text.includes('sentinel'),'no unknown source text in the public report: '+text.match(/.{20}sentinel.{20}/)?.[0]);
 assert.ok('unknown_writer' in result.report.coverage.unknownWriters||Object.keys(result.report.coverage.counts.b6.historyByWriterAndStatus).some(key=>key.startsWith('unknown_writer')));
 const capture=fs.readFileSync(result.prefix+'.capture.json','utf8');
 assert.ok(capture.includes('sentinel-writer-text')&&capture.includes('sentinel-status-text'),'the exact values stay in the private capture');
}
console.log('identity evidence family (b) dry-run operator tests passed');
