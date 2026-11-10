// AIR-373: the one measuring operation of the cutover_minimum gate (scripts/film-person-cutover-run.mjs). Synthetic and local only: the sqlite3-CLI D1 stand-in and a
// fake read-only S3 server on loopback, the same fixtures as tests/film-person-capture.mjs. No production read or write. What this file proves about `verified`:
// a synthetic run that satisfies EVERY check of the run still ends verified:false, because its transports are not the registered production ones; every incomplete,
// changed or ambiguous run is refused with no ledger at all. The mutation check (tests/film-person-cutover-record-mutation.mjs) points this file at a mutant
// through CUTOVER_RUN_MODULE.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {RECORDING_PATHS,baselineGate,recordBaselineVerified} from '../src/film-person-baseline.js';
import {OWNER_LINK_WAIVER,cutoverMinimumGate} from '../src/film-person-cutover-minimum.js';
import {createReadOnlyClient,readCredentials} from '../scripts/r2-snapshot-export.mjs';
const R=await import(process.env.CUTOVER_RUN_MODULE?pathToFileURL(path.resolve(process.env.CUTOVER_RUN_MODULE)).href:'../scripts/film-person-cutover-run.mjs');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-cutover-run-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';'});if(r.status!==0)throw new Error(r.stderr);const out=r.stdout.trim();return out?JSON.parse(out):[];};
// The migrated schema is built once; each test database is a file copy. The fixture changes authority rows directly, so the guard triggers of those tables are
// dropped in the template (a test-only stand-in for a writer's own path).
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sql(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
for(const trigger of rows(template,"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('film_person_authority','film_person_cas','discovery_authority','published_epg_authority','owner_review_authority','projector_window','film','projection_run','owner_review_entry')"))sql(template,'DROP TRIGGER '+trigger.name+';');
let n=0;
const database=()=>{const file=path.join(root,'r-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;};
const AT='2026-11-10T12:00:00.000Z',NOW=()=>AT;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ACCOUNT='0123456789abcdef0123456789abcdef',DATABASE_ID='01234567-89ab-cdef-0123-456789abcdef';

async function fakeBucket(initial){
 const items=new Map();let revision=0;
 const put=(key,value)=>{revision++;const bytes=Buffer.from(JSON.stringify(value));items.set(key,{bytes,etag:sha(bytes).slice(0,24)+'-'+revision});};
 for(const [key,value] of Object.entries(initial))put(key,value);
 const requests=[];
 const server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://x');
  requests.push(request.method);
  const key=decodeURIComponent(url.pathname).replace(/^\/iptv\//,'');
  if(!['GET','HEAD'].includes(request.method)||!url.pathname.startsWith('/iptv/')||url.pathname==='/iptv/'||url.search){response.writeHead(405);response.end();return;}
  const item=items.get(key);
  if(!item){response.writeHead(404);response.end();return;}
  const match=request.headers['if-match'];
  if(match&&match.replace(/"/g,'')!==item.etag){response.writeHead(412);response.end();return;}
  response.writeHead(200,{'content-length':item.bytes.length,etag:'"'+item.etag+'"','content-type':'application/json'});
  response.end(request.method==='HEAD'?undefined:item.bytes);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const endpoint='http://127.0.0.1:'+server.address().port;
 const credentials=readCredentials({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:'a',R2_SNAPSHOT_SECRET_ACCESS_KEY:'b',R2_SNAPSHOT_ENDPOINT:endpoint});
 return {put,items,requests,endpoint,close:()=>server.close(),client:()=>createReadOnlyClient({credentials,retries:0,sleep:async()=>{}})};
}
const film=id=>({id,title:'Film '+id,original:'Film '+id,year:2001,tmdbId:String(500+id.length*7+id.charCodeAt(0)),url:'https://letterboxd.com/film/'+id+'/',directors:[{id:'director/'+id,name:'Dir '+id,original:'Dir '+id}],actors:[{id:'actor/'+id+'-a',name:'Act '+id,original:'Act '+id}]});
const INPUT={
 'epg/published-generation.json':{phase:'published',programmeRunId:'run-1'},
 'watchlist.json':{films:[film('alpha'),film('beta')]},
 'epg/generations/run-1/programme.json':{films:[{...film('alpha'),shows:[]}]},
 'metadata.json':{},'titles.json':{},'people.json':{},
 'epg/generations/run-1/discovered-films.json':{},
 'epg/discovery-resolution.json':{},
};
const TRANSPORT=['source_transport_not_production:r2','source_transport_not_production:d1'];
const baselineRow=file=>rows(file,'SELECT state, reference FROM film_person_baseline')[0];
const leaseRow=file=>rows(file,"SELECT lease_id, lease_until FROM projection_run WHERE projection='enrichment'")[0]??null;
const go=async({input=INPUT,seed=null,standin={},over={}}={})=>{
 const bucket=await fakeBucket(input);const file=database();if(seed)seed(file);
 const context={bucket,file};
 const hooks=typeof over.hooks==='function'?over.hooks(context):over.hooks;
 const out=await R.runCutoverMinimum({client:bucket.client(),db:d1Standin(file,typeof standin==='function'?standin(context):standin),leaseId:'cutover:test',asOf:AT,now:NOW,...over,...(hooks?{hooks}:{})});
 bucket.close();
 return {...context,out};
};
const refusedWith=(out,reason,label)=>{
 assert.equal(out.ok,false,label);assert.equal(out.verified,false,label);
 assert.ok(out.reasons.includes(reason),label+': expected '+reason+' in '+out.reasons.join());
 assert.equal(out.ledger,undefined,'a refused run builds no ledger: '+label);assert.equal(out.gate,undefined,label);assert.equal(out.report,undefined,label);
};

// 1. a synthetic run in which EVERY check of the run holds: a ledger is built, and it is verified:false for exactly one reason, the transport
let clean;
{
 clean=await go();
 const out=clean.out;
 assert.equal(out.ok,true,out.reasons.join());
 assert.equal(out.verified,false,'a synthetic run is never verified');
 assert.deepEqual(out.reasons,TRANSPORT,'the transports are the only thing between this run and verified:true');
 assert.equal(out.ledger.source.verified,false);
 assert.equal(out.ledger.source.aggregateSha256,out.run.manifest.digest);
 const evidence=out.ledger.cutoverMinimum.source;
 assert.equal(evidence.manifestDigest,out.run.manifest.digest);
 assert.match(evidence.r2Etags.before,/^[0-9a-f]{64}$/);assert.equal(evidence.r2Etags.before,evidence.r2Etags.after);
 assert.deepEqual(evidence.d1.before,evidence.d1.after);assert.equal(evidence.d1.after.marker.generation,0);assert.equal(evidence.d1.after.marker.mode,'r2');
 assert.deepEqual(evidence.witness.before,evidence.witness.after);
 assert.deepEqual([evidence.fenceHeld,evidence.leaseLost,evidence.probeComplete,evidence.atomicSnapshot],[true,false,true,false]);
 assert.deepEqual(out.ledger.cutoverMinimum.waivers,[OWNER_LINK_WAIVER],'only the pinned waiver is carried');
 // the gate, called on the ledger, refuses it as unverified and finds nothing wrong with the carried evidence
 const gate=await cutoverMinimumGate(out.ledger);
 assert.deepEqual(gate,out.gate);
 assert.equal(gate.pass,false);assert.ok(gate.reasons.includes('source_unverified'));
 for(const reason of ['source_manifest_mismatch','r2_etags_missing','r2_etags_changed','d1_identity_changed','witness_moved','fence_or_lease_lost','probe_incomplete','owner_review_facts_missing','owner_review_facts_changed','owner_review_count_mismatch','digest_mismatch','cutover_digest_mismatch','waiver_missing:ownerLink/link_values'])assert.ok(!gate.reasons.includes(reason),reason);
 assert.ok(!gate.reasons.some(item=>item.startsWith('waiver_not_permitted')));
 assert.deepEqual(gate.accepted,[]);
 assert.ok((await baselineGate(out.ledger)).reasons.includes('source_unverified'));
 // neither recording path records it, and nothing was written but the lease row, which is released
 for(const recordPath of [undefined,RECORDING_PATHS.strict,RECORDING_PATHS.cutover_minimum])await assert.rejects(()=>recordBaselineVerified({DB:d1Standin(clean.file)},{ledger:out.ledger,expectedGeneration:0,at:AT,path:recordPath}),error=>error.code==='baseline_gate_failed'&&error.reasons.includes('source_unverified'));
 assert.deepEqual(baselineRow(clean.file),{state:'empty',reference:null});
 assert.deepEqual(leaseRow(clean.file),{lease_id:null,lease_until:null},'the lease row is the one write and it is released');
 assert.deepEqual(rows(clean.file,'SELECT mode, cutover, generation FROM film_person_authority')[0],{mode:'r2',cutover:'open',generation:0});
 assert.ok(clean.bucket.requests.every(method=>method==='GET'||method==='HEAD'));
 // the report: a measurement that authorizes nothing, counts and digests only
 const report=out.report;
 assert.deepEqual([report.measurement,report.authorizes,report.verified,report.gate,report.gateVersion,report.gatePass],[true,'nothing',false,'cutover_minimum',1,false]);
 assert.deepEqual(report.verificationReasons,TRANSPORT);
 assert.equal(report.cutoverDigest,out.ledger.cutoverDigest);assert.match(report.digest,/^[0-9a-f]{64}$/);
 assert.ok(report.notProved.includes('r2_d1_not_atomic_snapshot'));
 assert.doesNotMatch(JSON.stringify(report),/Film alpha|Dir alpha|film:alpha|letterboxd/,'no title, name or id in the report');
}

// 2. deriveEvidence on the record of that run: untouched it is clean, and each tampered observation is a named reason
{
 const record=()=>JSON.parse(JSON.stringify(clean.out.run));
 const base=R.deriveEvidence(record());
 assert.deepEqual(base.reasons,[]);
 assert.deepEqual([base.evidence.fenceHeld,base.evidence.leaseLost,base.evidence.probeComplete],[true,false,true]);
 const derive=change=>{const run=record();change(run);return R.deriveEvidence(run);};
 const has=(change,reason,label=reason)=>{const out=derive(change);assert.ok(out.reasons.includes(reason),label+': '+out.reasons.join());return out;};
 const titles=run=>run.etagsAfterCut.find(item=>item.key==='titles.json');
 // a changed ETag, a missing or failed observation after the cut
 const moved=has(run=>{titles(run).etag='moved';},'etag_changed_after_cut:titles');
 assert.notEqual(moved.evidence.r2Etags.before,moved.evidence.r2Etags.after);
 has(run=>{titles(run).state='absent';titles(run).etag=null;},'etag_changed_after_cut:titles');
 assert.equal(has(run=>{run.etagsAfterCut=run.etagsAfterCut.filter(item=>item.key!=='titles.json');},'probe_incomplete:etag_after_cut:titles').evidence.probeComplete,false);
 has(run=>{run.etagsAfterCut=run.etagsAfterCut.filter(item=>item.key!=='titles.json');},'probe_incomplete:etags_after_cut');
 has(run=>{const item=titles(run);delete item.state;item.error=true;},'probe_incomplete:etag_after_cut:titles');
 has(run=>{run.etagsAfterCut=null;},'probe_incomplete:etags_after_cut');
 // a changed generation or authority at any of the four reads
 for(const stage of ['captureAfter','parityBefore','parityAfter']){
  has(run=>{run.gates[stage].marker.generation++;},'d1_identity_moved:'+stage+':marker.generation');
  has(run=>{run.gates[stage].discovery.generation++;},'d1_identity_moved:'+stage+':discovery.generation');
  has(run=>{run.gates[stage].published.generation++;},'d1_identity_moved:'+stage+':published.generation');
  has(run=>{run.gates[stage].owner.generation++;},'d1_identity_moved:'+stage+':owner.generation');
  has(run=>{run.gates[stage].baseline.state='loading';},'d1_identity_moved:'+stage+':baseline.state');
  has(run=>{run.gates[stage].schema.version++;},'d1_identity_moved:'+stage+':schema.version');
  has(run=>{delete run.gates[stage];},'d1_identity_missing:'+stage);
 }
 // the fence and foreign leases
 for(const stage of ['captureBefore','captureAfter','parityBefore','parityAfter']){
  assert.equal(has(run=>{run.gates[stage].fence.ok=0;},'fence_lost:'+stage).evidence.fenceHeld,false);
  assert.equal(has(run=>{run.gates[stage].lease.held=true;},'lease_foreign:projector:'+stage).evidence.leaseLost,true);
  has(run=>{run.gates[stage].window.live=true;},'lease_foreign:window:'+stage);
  has(run=>{run.gates[stage].discoveryLease.live=true;},'lease_foreign:discovery:'+stage);
  has(run=>{delete run.gates[stage].lease;},'lease_foreign:projector:'+stage,'an unreadable lease state is not "no lease"');
 }
 // our own lease across the cut
 assert.equal(has(run=>{run.cut.consistent=false;run.cut.reasons=['lease_lost'];},'lease_lost:lease_lost').evidence.leaseLost,true);
 has(run=>{run.cut.consistent=false;run.cut.reasons=['lease_lost'];},'cut_not_consistent');
 has(run=>{run.cut.consistent=false;},'cut_not_consistent');
 has(run=>{run.cut.reasons=['lease_unavailable'];},'lease_lost:lease_unavailable');
 has(run=>{run.cut.reasons=['unstable_cut:film'];},'cut:unstable_cut:film');
 has(run=>{delete run.cut.reasons;},'cut:cut_reasons_missing');
 has(run=>{run.cut.leaseAfter.id='thief';},'lease_lost:not_held_at_end');
 has(run=>{run.cut.leaseAfter=null;},'lease_lost:not_held_at_end');
 has(run=>{run.cut.leaseAfter.live=false;},'lease_lost:not_held_at_end');
 has(run=>{run.cut.leaseBefore.id='thief';},'lease_lost:not_held_at_start');
 has(run=>{run.cut.leaseBefore.live=false;},'lease_lost:not_held_at_start');
 has(run=>{run.leaseId='';},'lease_lost:not_held_at_start');
 has(run=>{delete run.cut;},'lease_lost:not_held_at_end');
 // an incomplete probe
 assert.equal(has(run=>{run.cut.done=false;},'probe_incomplete:cut').evidence.probeComplete,false);
 has(run=>{run.cut.unavailable=['retention'];},'probe_incomplete:class:retention');
 has(run=>{run.cut.unavailable=null;},'probe_incomplete:class:unknown');
 has(run=>{run.manifest.objects=run.manifest.objects.filter(item=>item.id!=='metadata');},'probe_incomplete:metadata');
 has(run=>{run.manifest.objects=run.manifest.objects.filter(item=>item.id!=='diary');},'probe_incomplete:diary','an optional key must still have been probed');
 has(run=>{const item=run.manifest.objects.find(entry=>entry.id==='metadata');item.state='absent';item.etag=null;item.sha256=null;},'probe_incomplete:metadata','a required key cannot be absent');
 has(run=>{run.manifest.objects.find(entry=>entry.id==='metadata').state='unknown';},'probe_incomplete:metadata');
 has(run=>{run.manifest.objects.find(entry=>entry.id==='metadata').sha256=null;},'probe_incomplete:metadata');
 has(run=>{run.manifest.objects.find(entry=>entry.id==='metadata').etag='';},'probe_incomplete:metadata');
 has(run=>{run.manifest.objects.find(entry=>entry.id==='programme').key='epg/generations/run-2/programme.json';},'probe_incomplete:programme');
 has(run=>{run.manifest.runId='../x';},'probe_incomplete:programme');
 has(run=>{run.manifest.objects.push({...run.manifest.objects[0]});},'probe_incomplete:'+clean.out.run.manifest.objects[0].id);
 has(run=>{run.manifest.objects.push({id:'other',key:'other.json',state:'present'});},'probe_incomplete:unknown_object');
 has(run=>{run.manifest.routes.discovery=true;},'probe_incomplete:routed_object:catalog');
 assert.equal(has(run=>{run.manifestProblems=['manifest_digest'];},'manifest_invalid:manifest_digest').evidence.probeComplete,false);
 has(run=>{delete run.manifestProblems;},'manifest_invalid:unchecked');
 has(run=>{run.derivedProblems=['derived_digest:ownerReviews'];},'derived_invalid:derived_digest:ownerReviews');
 has(run=>{delete run.derivedProblems;},'derived_invalid:unchecked');
 // the witness and the owner-review facts
 for(const stage of ['captureAfter','parityBefore','parityAfter']){
  has(run=>{run.witness[stage].film='{"n":9,"t":null}';},'witness_moved:'+stage);
  has(run=>{run.witness[stage]=null;},'witness_unreadable:'+stage);
 }
 has(run=>{run.witness.captureBefore=null;},'witness_unreadable:captureBefore');
 has(run=>{run.ownerFacts.after.count++;},'owner_facts_changed');
 has(run=>{run.ownerFacts.after.digest='0'.repeat(64);},'owner_facts_changed');
 has(run=>{run.ownerFacts.before=null;},'owner_facts_unreadable');
 has(run=>{run.ownerFacts.after.digest='short';},'owner_facts_unreadable');
 // no manifest, no evidence
 for(const change of [run=>{delete run.manifest;},run=>{run.manifest.digest='x';},run=>{run.manifest.objects=null;}])assert.deepEqual(derive(change),{reasons:['manifest_missing'],evidence:null});
 assert.deepEqual(R.deriveEvidence(null),{reasons:['manifest_missing'],evidence:null});
 // the ETag digest is over the list, in any order
 assert.equal(R.etagDigest([{key:'b',state:'present',etag:'2'},{key:'a',state:'absent',etag:null}]),R.etagDigest([{key:'a',state:'absent'},{key:'b',state:'present',etag:'2'}]));
 assert.notEqual(R.etagDigest([{key:'a',state:'present',etag:'1'}]),R.etagDigest([{key:'a',state:'present',etag:'2'}]));
}

// 3. the transport registry: only openProductionSource registers, only for the production endpoints, and it sends nothing
{
 const r2={R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:'a',R2_SNAPSHOT_SECRET_ACCESS_KEY:'b'};
 const d1={D1_BACKFILL_ACCOUNT_ID:ACCOUNT,D1_BACKFILL_API_TOKEN:'t',D1_BACKFILL_DATABASE_ID:DATABASE_ID};
 // every request of this block goes to a stub: nothing leaves the process
 const realFetch=globalThis.fetch;const calls=[];let answer=()=>({success:true,result:{uuid:DATABASE_ID,name:'iptv'}});
 globalThis.fetch=async(url,init)=>{calls.push([init?.method||'GET',String(url)]);const body=answer();if(body instanceof Error)throw body;return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const opened=R.openProductionSource({...r2,...d1});
  assert.deepEqual(opened.production,{r2:true,d1:true});
  assert.deepEqual([R.transportKind(opened.client),R.transportKind(opened.db)],['r2','d1']);
  assert.deepEqual(calls,[],'opening the source sends nothing');
  assert.deepEqual(opened.client.calls,{list:0,head:0,get:0});
  // every deviation from the production endpoint, bucket or database leaves the transport unregistered
  const cases=[
   ['R2 loopback endpoint',{...r2,...d1,R2_SNAPSHOT_ENDPOINT:'http://127.0.0.1:9'},[null,'d1']],
   ['R2 endpoint override naming the production host',{...r2,...d1,R2_SNAPSHOT_ENDPOINT:'https://'+ACCOUNT+'.r2.cloudflarestorage.com'},[null,'d1']],
   ['R2 other bucket',{...r2,...d1,R2_SNAPSHOT_BUCKET:'scratch'},[null,'d1']],
   ['D1 loopback endpoint',{...r2,...d1,D1_BACKFILL_ENDPOINT:'http://127.0.0.1:9'},['r2',null]],
   ['D1 endpoint override naming the production API',{...r2,...d1,D1_BACKFILL_ENDPOINT:'https://api.cloudflare.com/client/v4'},['r2',null]],
   ['D1 other database name',{...r2,...d1,D1_BACKFILL_DATABASE_NAME:'scratch'},['r2',null]],
  ];
  for(const [label,env,kinds] of cases){const other=R.openProductionSource(env);assert.deepEqual([R.transportKind(other.client),R.transportKind(other.db)],kinds,label);assert.deepEqual(other.production,{r2:kinds[0]==='r2',d1:kinds[1]==='d1'},label);}
  // nothing else is a production transport: a double, the stand-in, a copy of a registered object, a primitive
  for(const value of [null,undefined,'r2',1,{},{kind:'r2'},{...opened.client},{...opened.db},d1Standin(clean.file),createReadOnlyClient({credentials:readCredentials(r2)})])assert.equal(R.transportKind(value),null);
  assert.deepEqual(await R.transportReasons({...opened.client},{...opened.db}),TRANSPORT);
  assert.deepEqual(await R.transportReasons(opened.client,d1Standin(clean.file)),['source_transport_not_production:d1']);
  assert.deepEqual(await R.transportReasons({},opened.db),['source_transport_not_production:r2']);
  assert.deepEqual(calls.length,1,'only the registered D1 binding is asked to describe its database');
  assert.deepEqual(calls[0],['GET','https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+DATABASE_ID]);
  // the D1 API must describe the database as `iptv` with the configured id; anything else, or a failure, is not production
  assert.deepEqual(await R.transportReasons(opened.client,opened.db),[]);
  for(const wrong of [()=>({success:true,result:{uuid:DATABASE_ID,name:'scratch'}}),()=>({success:true,result:{uuid:'11111111-89ab-cdef-0123-456789abcdef',name:'iptv'}}),()=>({success:true,result:{}}),()=>({success:false,errors:[{message:'no'}]})]){
   answer=wrong;
   const fresh=R.openProductionSource({...r2,...d1,D1_BACKFILL_ENDPOINT:''});
   assert.deepEqual(await R.transportReasons(fresh.client,fresh.db),['source_transport_identity:d1']);
  }
  assert.ok(calls.every(([method,url])=>method==='GET'&&url.startsWith('https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/')),'only the describe request was built');
 }finally{globalThis.fetch=realFetch;}
 // the module exports no way to register a transport or to set the verdict
 assert.deepEqual(Object.keys(R).sort(),['OWNER_FACTS_CAP','OWNER_FACTS_SQL','PRODUCTION_BUCKET','RUN_VERSION','bindingOfAdapter','deriveEvidence','etagDigest','openProductionSource','readOwnerFacts','runCutoverMinimum','transportKind','transportReasons']);
 // the D1 binding over the HTTP adapter: first / all / run with their parameters
 const seen=[];
 const binding=R.bindingOfAdapter({get:async(text,params)=>{seen.push(['get',text,params]);return {a:1};},all:async(text,params)=>{seen.push(['all',text,params]);return [{a:1}];},run:async(text,params)=>{seen.push(['run',text,params]);}});
 assert.deepEqual(await binding.prepare('SELECT ?').bind(7).first(),{a:1});
 assert.deepEqual(await binding.prepare('SELECT 1').all(),{results:[{a:1}]});
 await binding.prepare('UPDATE t SET a=?').bind(2).run();
 assert.deepEqual(seen,[['get','SELECT ?',[7]],['all','SELECT 1',[]],['run','UPDATE t SET a=?',[2]]]);
 // the owner-review facts: a read-only SELECT, a count and a digest, never the link values
 assert.match(R.OWNER_FACTS_SQL,/^SELECT kind, source_key, payload_json, generation FROM owner_review_entry /);
 assert.doesNotMatch(R.OWNER_FACTS_SQL,/identity_/);
 const stub=list=>({prepare:()=>({all:async()=>({results:list})})});
 const one=await R.readOwnerFacts(stub([{kind:'film',source_key:'a',payload_json:'{}',generation:1}]));
 assert.equal(one.count,1);assert.match(one.digest,/^[0-9a-f]{64}$/);
 assert.notEqual((await R.readOwnerFacts(stub([{kind:'film',source_key:'a',payload_json:'{"x":1}',generation:1}]))).digest,one.digest);
 await assert.rejects(()=>R.readOwnerFacts(stub(null)),error=>error.reason==='owner_facts_unreadable');
 await assert.rejects(()=>R.readOwnerFacts(stub(Array.from({length:R.OWNER_FACTS_CAP+1},(_x,i)=>({kind:'film',source_key:String(i),payload_json:'{}',generation:1})))),error=>error.reason==='owner_facts_unreadable');
}

// 4. end to end: a run that changes, loses its lease or is incomplete is refused and builds NO ledger
{
 refusedWith((await go({over:{hooks:({bucket})=>({afterCut:async()=>bucket.put('titles.json',{moved:true})})}})).out,'etag_changed_after_cut:titles','an ETag changed after the cut');
 refusedWith((await go({over:{hooks:({file})=>({beforeCut:async()=>sql(file,'UPDATE film_person_authority SET generation=generation+1')})}})).out,'d1_identity_moved:parityAfter:marker.generation','the generation moved before the cut');
 refusedWith((await go({over:{hooks:({file})=>({afterCut:async()=>sql(file,'UPDATE discovery_authority SET generation=generation+1')})}})).out,'d1_identity_moved:parityAfter:discovery.generation','a generation moved after the cut');
 // the lease is taken by another holder while the cut reads
 let stolen=false;
 const theft=await go({standin:({file})=>({onQuery:async text=>{if(!stolen&&/FROM watchlist_film/.test(text)&&leaseRow(file)?.lease_id==='cutover:test'){stolen=true;sql(file,"UPDATE projection_run SET lease_id='thief', started_at='2026-11-10T11:59:59.000Z' WHERE projection='enrichment'");}}})});
 assert.equal(stolen,true);
 refusedWith(theft.out,'lease_lost:lease_lost','the lease was lost during the cut');
 assert.ok(theft.out.reasons.includes('cut_not_consistent'));
 // a foreign lease that is live when the run starts, and one that appears after the cut
 const foreign="INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','other','2999-01-01T00:00:00.000Z','2026-11-10T11:59:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='other',lease_until='2999-01-01T00:00:00.000Z'";
 refusedWith((await go({seed:file=>sql(file,foreign)})).out,'capture:projector_lease_live','a live foreign lease at the start');
 refusedWith((await go({over:{hooks:({file})=>({afterCut:async()=>sql(file,foreign)})}})).out,'lease_foreign:projector:parityAfter','a foreign lease after the cut');
 // a write the witness sees, and a manual owner-review entry that appears
 refusedWith((await go({over:{hooks:({file})=>({afterCut:async()=>sql(file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:late',1,'Late','"+AT+"')")})}})).out,'witness_moved:parityAfter','a write after the cut');
 refusedWith((await go({over:{hooks:({file})=>({afterCut:async()=>sql(file,"INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film','late','{}',NULL,'unlinked',1)")})}})).out,'owner_facts_changed','an owner-review entry appeared');
 // an incomplete capture: a required object is missing, an object changes while it is read
 const {['metadata.json']:_dropped,...withoutMetadata}=INPUT;
 refusedWith((await go({input:withoutMetadata})).out,'capture:missing:metadata','a required object is missing');
 refusedWith((await go({over:{hooks:({bucket})=>({capture:{beforeD1:async()=>bucket.put('people.json',{moved:true})}})}})).out,'capture:etag_changed_after:people','an object changed during the capture');
 // there is no argument that sets the verdict: a caller's `verified`, `source`, `evidence` or `waivers` is ignored
 const pushed=await go({over:{verified:true,source:{verified:true},evidence:{fenceHeld:true},waivers:[{...OWNER_LINK_WAIVER,class:'credit'}]}});
 assert.equal(pushed.out.verified,false);assert.equal(pushed.out.ledger.source.verified,false);assert.deepEqual(pushed.out.ledger.cutoverMinimum.waivers,[OWNER_LINK_WAIVER]);
 assert.equal(pushed.out.ledger.cutoverDigest,clean.out.ledger.cutoverDigest,'the same state gives the same ledger');
 // a run without a lease id or a usable time
 for(const over of [{leaseId:''},{leaseId:null},{asOf:'not a time'},{asOf:undefined}])refusedWith((await go({over})).out,'run_invalid','invalid arguments');
 assert.deepEqual((await R.runCutoverMinimum()).reasons,['run_invalid']);
}

// 5. static: inactive. Not bundled, not imported by the Worker or by any source file, no CLI entry, and the verdict is not an argument.
{
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('film-person-cutover-run'),file+' does not name the run module');
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&/film-person-cutover-run|film-person-capture/.test(fs.readFileSync(full,'utf8')))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,[],'no source file imports the run or the capture module');
 const text=fs.readFileSync('scripts/film-person-cutover-run.mjs','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/process\.argv|process\.env|import\.meta\.main|fetchImpl|fetch\(/.test(text),'no CLI, no environment read at import, no transport argument');
 assert.doesNotMatch(text,/runCutoverMinimum\(\{[^}]*\b(verified|waivers|evidence|source)\b/,'the verdict, the waiver and the evidence are not arguments');
 assert.equal((text.match(/PRODUCTION\.set\(/g)||[]).length,2,'the registry is written in one place, once per transport');
}
console.log('film-person-cutover-run: ok');
