// AIR-412: the offline harness behind tests/get-write-audit.mjs. It runs the production bundle (the file `build.mjs` writes), not a vm re-assembly of sources,
// against an instrumented R2 bucket and an instrumented D1 (the sqlite stand-in with every migration applied), and reports every effect one request has:
//   r2        `put:key` / `delete:key` (a conditional put is a put), in order
//   d1        the write statements as `VERB table` (SELECT is a read and is not listed); a statement that is neither a read nor a recognised write is `UNCLASSIFIED ...`
//   d1Changed the database file changed although no write statement was seen (a writer the classifier missed)
//   fetches   outbound requests as `METHOD url`; a body or a method other than GET is reported as it is
//   background `waitUntil` calls; dispatches `DiscoveryContinuation` fetches; workflows `create()` calls on the three Workflow bindings
// Nothing here calls Cloudflare, TMDB or production. A scenario is a pair (database file, R2 snapshot) built once and copied for every request, so one probe
// never sees what the previous one wrote and a repeat of the same GET is a separate, equal probe.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import * as PublishedEpg from '../src/published-epg.js';

export const TEAM='https://audit-team.cloudflareaccess.com',AUD='c3'.repeat(32),SITE='https://iptv.vladimino.workers.dev';
const RSA={name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'};
const encode=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');

export const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-get-audit-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});

// ---- the production bundle, built into a directory of this test's own ----
// `seeded` is the same bundle with a non-empty personal-ratings seed: the repository ships an empty seed ("replace it only in a private build"). A scenario with
// `seeded: true` runs against it so a GET that used to persist that seed still has a seed to overlay.
export async function loadBundle(){
 // `build.mjs` writes `dist` relative to its working directory: run it in a directory whose entries are links to the repository's, so the bundle is built from
 // the real sources into a `dist` of this test's own and no other test sees it change.
 const work=path.join(root,'build');fs.mkdirSync(work);
 for(const entry of fs.readdirSync('.'))if(!['dist','.git','node_modules','docs','tests','.claude'].includes(entry))fs.symlinkSync(path.resolve(entry),path.join(work,entry));
 const built=spawnSync(process.execPath,['build.mjs'],{cwd:work,encoding:'utf8'});
 if(built.status!==0)throw new Error('build failed: '+built.stderr);
 const out=path.join(work,'dist');
 const file=path.join(out,'server/index.js'),source=fs.readFileSync(file,'utf8');
 const marker='const INITIAL_PERSONAL_RATINGS={};';
 if(!source.includes(marker))throw new Error('the ratings seed is not an empty literal in the bundle any more; update the harness');
 const seededFile=path.join(out,'server/index.seeded.js');
 fs.writeFileSync(seededFile,source.replace(marker,'const INITIAL_PERSONAL_RATINGS={"w1":4};'));
 return {worker:(await import(pathToFileURL(file).href)).default,seeded:{worker:(await import(pathToFileURL(seededFile).href)).default},source};
}

// ---- classification of one D1 statement ----
export function d1Shape(sql){
 const text=String(sql).replace(/--[^\n]*\n/g,' ').replace(/\/\*[\s\S]*?\*\//g,' ').trim();
 const word=/^[A-Za-z]+/.exec(text)?.[0]?.toUpperCase();
 const name='([`"\\[]?[A-Za-z_][A-Za-z0-9_.]*[`"\\]]?)';
 const table=match=>String(match?.[1]??'?').replace(/[`"\[\]]/g,'');
 if(word==='SELECT'||word==='EXPLAIN')return null;
 if(word==='WITH'){
  const verb=/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.exec(text);
  if(!verb)return null;
  return d1Shape(text.slice(verb.index));
 }
 let match;
 if(word==='INSERT'||word==='REPLACE'){match=new RegExp('^(?:INSERT(?:\\s+OR\\s+\\w+)?|REPLACE)\\s+INTO\\s+'+name,'i').exec(text);return (word==='REPLACE'?'REPLACE':'INSERT')+' INTO '+table(match);}
 if(word==='UPDATE'){match=new RegExp('^UPDATE(?:\\s+OR\\s+\\w+)?\\s+'+name,'i').exec(text);return 'UPDATE '+table(match);}
 if(word==='DELETE'){match=new RegExp('^DELETE\\s+FROM\\s+'+name,'i').exec(text);return 'DELETE FROM '+table(match);}
 if(word==='CREATE'||word==='DROP'||word==='ALTER'){match=new RegExp('^(?:CREATE|DROP|ALTER)\\s+(?:TEMP\\s+|TEMPORARY\\s+|UNIQUE\\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?'+name,'i').exec(text);return word+' '+table(match);}
 return 'UNCLASSIFIED '+text.slice(0,60);
}

// The statement as the Worker wrote it: whitespace collapsed, every bound literal replaced by `?`, so the text is the same whatever ids a fixture holds.
export const normalizeSql=sql=>String(sql).replace(/'(?:[^']|'')*'/g,'?').replace(/\b\d+(?:\.\d+)?\b/g,'?').replace(/\s+/g,' ').trim().slice(0,260);

// ---- instrumented bindings ----
class AuditBucket extends MemoryBucket{
 constructor(snapshot){super();this.writes=[];for(const [key,item] of snapshot)this.objects.set(key,{text:item.text,customMetadata:{...item.customMetadata}});}
 async put(key,body,options){const result=await super.put(key,body,options);this.writes.push('put:'+key);return result;}
 async delete(key){this.writes.push('delete:'+key);return super.delete(key);}
}
const hashOf=file=>fs.existsSync(file)?crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'):'none';

// ---- scenarios ----
const migrations=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const G='22222222-2222-4222-8222-222222222222',PAST=new Date(Date.now()-3600000).toISOString();
const film={id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,genres:[],directors:[{id:'director/one',name:'One',original:'One'}],actors:[],shows:[]};
const programme=runId=>({runId,updatedAt:PAST,watchlistCount:1,films:[film],stats:{}});
const profile={version:1,profileHash:'p',updatedAt:PAST,profile:{}};
const r2Common=map=>{
 map.set('enrichment/profile/current.json',profile);
 map.set('enrichment/view-index.json',{w1:{actualRating:4}});
 map.set('metadata.json',{});map.set('titles.json',{});map.set('people.json',{});
};
// pending work a GET could be tempted to settle: an undelivered stop event, a run whose lease expired, a runner lease that expired
const expiredRun={runId:'run-expired',status:'running',createdAt:PAST,diagnosticStartedAt:PAST,leaseAcquiredAt:PAST,lastHeartbeatAt:PAST,batchSize:1,selectedIds:[],results:{},failures:{}};
const r2Pending=map=>{
 map.set('enrichment/stop-events/run-stopped.json',{event:{id:'stop-run-stopped',type:'enrichment',runId:'run-stopped',reason:'quota',at:PAST},delivered:false});
 map.set('enrichment/run-diagnostics/run-expired.json',{runId:'run-expired',state:'running',startedAt:PAST,leaseAcquiredAt:PAST,leaseExpiredAt:PAST});
 map.set('enrichment/runs/run-expired.json',expiredRun);
 map.set('enrichment/latest-run.json',expiredRun);
 map.set('enrichment/runner-lease.json',{runId:'run-expired',owner:'t',acquiredAt:PAST,heartbeatAt:PAST,expiresAt:Date.now()-3600000});
 map.set('epg/resolver-lease.json',{runId:'resolver',owner:'t',acquiredAt:PAST,expiresAt:PAST});
};
// Publishing records the generation in D1 and leaves the R2 compatibility mirrors to the repair: `current` runs it, `missing` and `stale` do not.
async function publishInto(db,bucket,{mirrors}){
 const result=await PublishedEpg.publishGeneration({DB:db,BUCKET:bucket},{programmeRunId:G,phase:'published',expectedProgrammeRunId:null,programme:programme(G),watchlist:{updatedAt:PAST,films:[film]}},{now:Date.now()});
 if(!result.pointed)throw new Error('the D1 generation was not published');
 if(mirrors==='current')await PublishedEpg.repairMirrors({DB:db,BUCKET:bucket});
}

// A scenario: `r2` seeds the R2 snapshot, `d1` says what D1 holds. `label` is what the baseline and the evidence call it.
export const SCENARIOS={
 'r2':{label:'R2 authority, healthy',d1:null,seed:map=>{r2Common(map);r2Published(map);}},
 'r2-pending':{label:'R2 authority, undelivered stop event, expired run lease and expired leases, personal-ratings seed not yet merged',d1:null,seeded:true,seed:map=>{r2Common(map);r2Published(map);r2Pending(map);map.set('enrichment/view-index.json',{});}},
 'empty':{label:'R2 authority, nothing seeded (missing seed)',d1:null,seed:()=>{}},
 'd1':{label:'D1 published EPG/discovery/owner-review authority, mirrors current',d1:{mirrors:'current'},seed:map=>{r2Common(map);}},
 'd1-mirror-missing':{label:'D1 authority, R2 compatibility mirrors missing (pending repair)',d1:{mirrors:'missing'},seed:map=>{r2Common(map);}},
 'd1-mirror-stale':{label:'D1 authority, R2 compatibility mirrors from an older generation',d1:{mirrors:'stale'},seed:map=>{r2Common(map);map.set('epg/published-generation.json',{phase:'published',programmeRunId:'11111111-1111-4111-8111-aaaaaaaaaaaa'});map.set('programme.json',programme('old'));}},
 'd1-held':{label:'D1 published EPG cutover held (fence)',d1:{mirrors:'current',held:true},seed:map=>{r2Common(map);}},
 'd1-pending':{label:'D1 authority with pending work: undelivered event, expired leases, interrupted run, personal-ratings seed not yet merged',d1:{mirrors:'current'},seeded:true,seed:map=>{r2Common(map);r2Pending(map);map.set('enrichment/view-index.json',{});}},
};
function r2Published(map){
 map.set('programme.json',programme('run-1'));map.set('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 map.set('epg/generations/run-1/programme.json',programme('run-1'));map.set('watchlist.json',{updatedAt:PAST,films:[film]});
 map.set('sync.json',{runId:'run-1',stage:'complete',updatedAt:PAST});
}

let scenarioCount=0;
export async function buildScenario(name){
 const spec=SCENARIOS[name];if(!spec)throw new Error('unknown scenario '+name);
 const dir=path.join(root,'s'+(scenarioCount++));fs.mkdirSync(dir);
 const dbFile=path.join(dir,'template.sqlite'),snapshot=new Map();
 const seeded=new Map();spec.seed(seeded);
 const db=d1Standin(dbFile);
 for(const migration of migrations)db.sql(fs.readFileSync('migrations/'+migration,'utf8'));
 if(spec.d1){
  db.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
  db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
  db.sql("UPDATE owner_review_authority SET mode='d1' WHERE id=1");
  const scratch=new MemoryBucket();
  await publishInto(db,scratch,{mirrors:spec.d1.mirrors==='current'?'current':'none'});
  // What publishing wrote to the scratch bucket is the R2 side of a healthy D1 authority; the other scenarios start without it.
  if(spec.d1.mirrors==='current')for(const [key,item] of scratch.objects)snapshot.set(key,item);
  if(spec.d1.held)db.sql("UPDATE published_epg_authority SET cutover='held' WHERE id=1");
 }
 for(const [key,value] of seeded)snapshot.set(key,{text:JSON.stringify(value),customMetadata:{}});
 // The sqlite session keeps the template open; copy the file only after a checkpoint-free read made sure nothing is pending.
 db.sql('SELECT 1');
 return {name,spec,dbFile,snapshot};
}

// ---- one request ----
let probeCount=0;
export function Probe(bundle){
 const certs={keys:[]};let jwtPromise=null;
 const ready=(async()=>{
  const signing=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']);
  certs.keys.push({...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'});
  const now=Math.floor(Date.now()/1000),input=encode({alg:'RS256',kid:'kid-1',typ:'JWT'})+'.'+encode({aud:[AUD],email:'owner@example.test',exp:now+36000,iat:now,nbf:now,iss:TEAM,sub:'owner-identity',type:'app'});
  const signature=await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',signing.privateKey,new TextEncoder().encode(input));
  return input+'.'+Buffer.from(signature).toString('base64url');
 })();
 const jwt=()=>jwtPromise??=ready;
 const realFetch=globalThis.fetch;
 // One recorder for the whole run: every outbound request of every probe goes through it. Access signing keys are the MCP's own read and are not an effect.
 let current=null;
 globalThis.fetch=async(input,init)=>{
  const url=String(input instanceof Request?input.url:input),method=(input instanceof Request?input.method:init?.method)||'GET';
  if(url===TEAM+'/cdn-cgi/access/certs')return Response.json(certs);
  if(current)current.fetches.push((init?.body||input?.body?method+'+body':method)+' '+url.replace(/\?.*$/,''));
  if(url.startsWith('https://api.themoviedb.org/3/movie/11'))return new Response('{"id":11}');
  return new Response('unexpected',{status:599});
 };
 const restore=()=>{globalThis.fetch=realFetch;};
 return {
  restore,
  // `request` is a Request or [path, init]. Returns {status, ...effects}.
  async run(scenario,request,{mcp=null}={}){
   // AIR-418: a probe that wrote nothing to D1 left its copy exactly as the template (no write statement seen and the file hash unchanged), so the next probe of
   // the same scenario uses that copy, and its sqlite process, again. Any D1 write, classified or not, retires the copy: the next probe starts from a new one.
   let live=scenario.live;
   if(!live){const fresh=path.join(root,'p'+(probeCount++)+'.sqlite');fs.copyFileSync(scenario.dbFile,fresh);live=scenario.live={file:fresh,hash:hashOf(fresh)};}
   const file=live.file,before=live.hash;
   const effects={r2:[],d1:[],statements:[],fetches:[],background:0,dispatches:0,workflows:0,status:0};
   const bucket=new AuditBucket(scenario.snapshot);
   const db=d1Standin(file,{onQuery:async text=>{const shape=d1Shape(text);if(shape){effects.d1.push(shape);effects.statements.push(normalizeSql(text));}},onBatch:async statements=>{for(const item of statements){const shape=d1Shape(item.text);if(shape){effects.d1.push(shape);effects.statements.push(normalizeSql(item.text));}}}});
   const stub={create:async()=>{effects.workflows++;return {id:'x'};},get:async()=>{effects.workflows++;return {status:async()=>({status:'running'})};}};
   const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',EPG_XML_URL:'https://epg.test/guide.xml',LETTERBOXD_USERNAME:'tester',MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:AUD,DISCOVERY_WORKFLOW:stub,RATINGS_WORKFLOW:stub,EPG_WORKFLOW:stub};
   if(scenario.spec.d1)env.DB=db;
   else{env.PUBLISHED_EPG_DB_OPTIONAL='standin';env.OWNER_REVIEW_DB_OPTIONAL='standin';}
   const execution={waitUntil:()=>{effects.background++;},exports:{DiscoveryContinuation:{fetch:async()=>{effects.dispatches++;return new Response('{}');}}}};
   current=effects;
   // The Worker logs a route error with console.error; the audit reads it as `routeErrors` and keeps the test output clean.
   const logged=console.error;effects.routeErrors=0;console.error=(...args)=>{if(String(args[0]).includes('route_error'))effects.routeErrors++;};
   let response;
   try{
    if(mcp){
     response=await (scenario.spec.seeded?bundle.seeded.worker:bundle.worker).fetch(new Request(SITE+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25','Cf-Access-Jwt-Assertion':await jwt()},body:JSON.stringify({jsonrpc:'2.0',id:1,method:mcp.method||'tools/call',...(mcp.method?{}:{params:{name:mcp.name,arguments:mcp.arguments||{}}})})}),env,execution);
    }else{
     const [pathname,init]=Array.isArray(request)?request:[request,{}];
     response=await (scenario.spec.seeded?bundle.seeded.worker:bundle.worker).fetch(new Request(SITE+pathname,{method:'GET',...init}),env,execution);
    }
    effects.status=response.status;
    try{effects.body=await response.clone().text();}catch{}
   }catch(error){effects.status=599;effects.error=String(error?.message||error).slice(0,120);}
   finally{current=null;console.error=logged;}
   effects.r2=bucket.writes;
   const after=hashOf(file);
   effects.d1Changed=effects.d1.length===0&&after!==before;
   if(effects.d1.length||after!==before){scenario.live=null;for(const suffix of ['','-journal','-wal','-shm'])try{fs.rmSync(file+suffix,{force:true});}catch{}}
   return effects;
  },
 };
}
// Reverse-timestamp prefixes of journal keys come from the clock of the run, so a key is compared without it.
const stable=key=>key.replace(/\/\d{10,16}-/g,'/<ts>-');
export const effectsOf=result=>[...result.r2.map(stable),...result.d1.map(shape=>'d1:'+shape),...result.fetches.map(item=>'fetch:'+item),...(result.background?['background:'+result.background]:[]),...(result.dispatches?['dispatch:'+result.dispatches]:[]),...(result.workflows?['workflow:'+result.workflows]:[]),...(result.d1Changed?['d1:UNREPORTED_FILE_CHANGE']:[])];
