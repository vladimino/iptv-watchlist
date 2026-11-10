// AIR-373 stage B: the narrow projector-input capture (scripts/film-person-capture.mjs). Synthetic and local only: the sqlite3-CLI D1 stand-in and a fake read-only
// S3 server on loopback. No production read or write; nothing here is bundled. Every guard has a mutation check at the end (a mutated copy of the module must fail).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {baselineGate} from '../src/film-person-baseline.js';
import {createReadOnlyClient,readCredentials} from '../scripts/r2-snapshot-export.mjs';
const C=await import(process.env.CAPTURE_MODULE||'../scripts/film-person-capture.mjs');
// AIR-418: the sections below are independent blocks, numbered in file order. With no CAPTURE_SECTIONS every one runs (the normal test). The mutation check
// (film-person-capture-mutation.mjs) names the one section that kills a mutant, so a mutant costs one section instead of the whole file; it falls back to the
// whole file before it calls a mutant a survivor.
const ONLY=process.env.CAPTURE_SECTIONS?new Set(process.env.CAPTURE_SECTIONS.split(',').map(Number)):null;
let sectionsRun=0;
const section=number=>{if(ONLY&&!ONLY.has(number))return false;sectionsRun++;return true;};
export const SECTION_COUNT=21;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-capture-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
let n=0;
// The same persistent sqlite session the D1 stand-in uses (AIR-408): a one-shot process per fixture statement was most of this file's time.
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text});if(r.status!==0)throw new Error(r.stderr);};
// The migrated schema is built ONCE (every migration through the sqlite3 CLI) and each test database is a file copy of it: the same bytes, a fraction of the time.
let template=null;
function database(){
 if(!template){template=path.join(root,'template.sqlite');sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));}
 const file=path.join(root,'c-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;
}
const AT='2026-11-10T12:00:00.000Z',NOW=()=>AT;
const stub=all=>({prepare:()=>{const s={bind:()=>s,all};return s;}});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const ACCOUNT='0123456789abcdef0123456789abcdef';

// ---- the fake read-only bucket: GET and HEAD of a key only; a listing, a write or an unknown method is recorded as a violation ----
async function fakeBucket(initial){
 const items=new Map();let revision=0;
 const put=(key,value)=>{revision++;const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));items.set(key,{bytes,etag:sha(bytes).slice(0,24)+'-'+revision});};
 for(const [key,value] of Object.entries(initial))put(key,value);
 const requests=[],hooks=[];
 const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://x');
  requests.push({method:request.method,path:decodeURIComponent(url.pathname),query:url.search});
  for(const hook of hooks.splice(0))await hook({method:request.method,key:decodeURIComponent(url.pathname).replace(/^\/iptv\//,'')});
  const key=decodeURIComponent(url.pathname).replace(/^\/iptv\//,'');
  if(!['GET','HEAD'].includes(request.method)||!url.pathname.startsWith('/iptv/')||url.pathname==='/iptv/'){response.writeHead(405);response.end();return;}
  const item=items.get(key);
  if(!item){response.writeHead(404);response.end();return;}
  const match=request.headers['if-match'];
  if(match&&match.replace(/"/g,'')!==item.etag){response.writeHead(412);response.end();return;}
  response.writeHead(200,{'content-length':item.bytes.length,etag:'"'+item.etag+'"','content-type':'application/json'});
  response.end(request.method==='HEAD'?undefined:item.bytes);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const credentials=readCredentials({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:'a',R2_SNAPSHOT_SECRET_ACCESS_KEY:'b',R2_SNAPSHOT_ENDPOINT:'http://127.0.0.1:'+server.address().port});
 return {put,items,requests,hooks,credentials,close:()=>server.close(),client:()=>createReadOnlyClient({credentials,retries:0,sleep:async()=>{}}),drop:key=>items.delete(key)};
}
const film=(id,extra={})=>({id,title:'Film '+id,original:'Film '+id,year:2001,tmdbId:String(500+id.length*7+id.charCodeAt(0)),url:'https://letterboxd.com/film/'+id+'/',directors:[{id:'director/'+id,name:'Dir '+id,original:'Dir '+id}],actors:[{id:'actor/'+id+'-a',name:'Act '+id,original:'Act '+id}],...extra});
const INPUT={
 'epg/published-generation.json':{phase:'published',programmeRunId:'run-1'},
 'watchlist.json':{films:[film('alpha'),film('beta')]},
 'epg/generations/run-1/programme.json':{films:[film('alpha',{shows:[]})]},
 'metadata.json':{},'titles.json':{},'people.json':{},
 'epg/generations/run-1/discovered-films.json':{},
 'epg/discovery-resolution.json':{},
};
// The fixture changes authority rows directly, so the guard triggers of the tables it touches are dropped first (a test-only stand-in for a writer's own path).
const gateRowsOk=file=>{const r=sqliteSync(['-json',file],{input:"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('film_person_authority','film_person_baseline','film_person_cas','discovery_authority','published_epg_authority','owner_review_authority','projector_window','film','projection_run');"});for(const t of JSON.parse(r.stdout||'[]'))sqlite(file,'DROP TRIGGER '+t.name+';');};
const run=async(over={})=>{const bucket=over.bucket||await fakeBucket(INPUT);const file=over.file||database();gateRowsOk(file);const db=d1Standin(file,over.standin||{});const result=await C.captureProjectorInputs({client:bucket.client(),db,now:NOW,...over.options});return {bucket,file,db,result};};

// AIR-418: the derived-payload binding is pure (no database, no bucket), so it runs first: the mutation check (film-person-capture-mutation.mjs) runs this whole
// file once per mutant, and a mutant of verifyDerived is now killed in a fraction of a second instead of after every section above it. Nothing was removed;
// the end-to-end refusal of a tampered derived set stays in section 12.
if(section(1)){
 const man=(derived,routes,after={published:{generation:3,programmeRunId:'run-1'},owner:{generation:2}})=>({runId:'run-1',routes,derived,d1:{after}});
 const sha256=v=>createHash('sha256').update(JSON.stringify(v,(_k,val)=>val&&typeof val==='object'&&!Array.isArray(val)?Object.fromEntries(Object.keys(val).sort().map(k=>[k,val[k]])):val)).digest('hex');
 const catalog={b:1,a:{y:2,x:1}},resolution={r:1},owner={o:1},pub={generation:3,programmeRunId:'run-1',programme:{films:[1]},watchlist:{films:[2]}};
 const derived={publishedEpg:{generation:3,programmeRunId:'run-1',sha256:sha256({programme:pub.programme,watchlist:pub.watchlist})},discoveryCatalog:{sha256:sha256(catalog)},discoveryResolution:{sha256:sha256(resolution)},ownerReviews:{generation:2,sha256:sha256(owner)}};
 const routes={publishedEpg:true,discovery:true,ownerReview:true};
 const good={publishedEpg:pub,discoveryCatalog:catalog,discoveryResolution:resolution,ownerReviews:owner};
 assert.deepEqual(C.verifyDerived(man(derived,routes),good),[]);
 // canonical, order-independent serialization: the same object with its keys in another order verifies
 assert.deepEqual(C.verifyDerived(man(derived,routes),{...good,discoveryCatalog:{a:{x:1,y:2},b:1}}),[]);
 for(const id of ['publishedEpg','discoveryCatalog','discoveryResolution','ownerReviews']){
  const mutated={...good,[id]:id==='publishedEpg'?{...pub,watchlist:{films:[3]}}:{...good[id],extra:1}};
  assert.deepEqual(C.verifyDerived(man(derived,routes),mutated),['derived_digest:'+id],'a well-formed but mutated '+id+' is refused');
  const missing={...good};delete missing[id];
  assert.deepEqual(C.verifyDerived(man(derived,routes),missing),['derived_missing:'+id],id+' missing');
 }
 assert.deepEqual(C.verifyDerived(man(derived,routes),{...good,publishedEpg:{...pub,generation:4}}),['derived_identity:publishedEpg'],'a payload from another generation is refused');
 assert.deepEqual(C.verifyDerived(man(derived,routes),{...good,publishedEpg:{...pub,programmeRunId:'run-2'}}),['derived_identity:publishedEpg']);
 assert.deepEqual(C.verifyDerived(man(derived,routes,{published:{generation:3,programmeRunId:'run-1'},owner:{generation:9}}),good),['derived_identity:ownerReviews'],'owner payload bound to the recorded owner generation');
 assert.deepEqual(C.verifyDerived(man(derived,routes),{...good,surprise:{}}),['derived_extra:surprise']);
 assert.deepEqual(C.verifyDerived(man({},{publishedEpg:false,discovery:false,ownerReview:false}),{discoveryCatalog:{}}),['derived_extra:discoveryCatalog']);
 assert.ok(C.verifyDerived(man({...derived},{...routes,discovery:false}),good).some(item=>item.startsWith('derived_route_mismatch')),'a payload recorded for a route the manifest says is closed');
}
// 1. the allowlist is one constant derived from the projector's loader: every R2 key the loader names is in it, and nothing else is
if(section(2)){
 const loader=fs.readFileSync('src/d1-enrichment.js','utf8');
 const named=new Set([...loader.matchAll(/d1EnrichmentRead\(env,etags,'([^']+)'/g)].map(m=>m[1]));
 const fixedKeys=C.ALLOWLIST.filter(item=>item.key).map(item=>item.key);
 for(const key of named)assert.ok(fixedKeys.includes(key),'the loader reads '+key+' which the allowlist lacks');
 for(const key of fixedKeys){const source=fs.readFileSync('src/sources.js','utf8')+fs.readFileSync('src/discovery.js','utf8')+fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8')+fs.readFileSync('src/owner-review-d1.js','utf8')+loader;assert.ok(source.includes("'"+key+"'"),'allowlist key not found in the code: '+key);}
 assert.ok(loader.includes("epgGenerationKey(runId,'programme.json')")&&loader.includes("epgGenerationKey(runId,'discovered-films.json')"));
 assert.deepEqual(C.ALLOWLIST.filter(item=>item.template).map(item=>item.template),['epg/generations/{runId}/programme.json','epg/generations/{runId}/discovered-films.json']);
 assert.ok(C.ALLOWLIST.every(item=>['record','filmList','archive','owner','pointer'].includes(item.shape)&&typeof item.required==='boolean'&&item.role&&item.projector));
 assert.ok(Object.isFrozen(C.ALLOWLIST));
 // drift: the prediction-fact SQL is the repository's own
 const repo=fs.readFileSync('src/canonical-repository.js','utf8');
 assert.ok(repo.includes("const PREDICTION_FACT_TABLES="+JSON.stringify(C.FACT_TABLES).replaceAll('"',"'").replaceAll(',',',')));
 assert.ok(repo.includes(`"SELECT '"+table+"' AS held FROM (SELECT 1 FROM "+table+' WHERE film_id=? LIMIT 1)'`));
 // a key outside the allowlist is never allowed
 for(const key of ['sync.json','metadata.json'])assert.equal(C.isAllowed(key),true);
 for(const key of ['enrichment/writer-lease.json','epg/generations/run-1/programme.json','../metadata.json','metadata.json/','','epg/generations/run-1/discovery-latest.json',null,undefined,'admin/other.json'])assert.equal(C.isAllowed(key,'run-1'),key==='epg/generations/run-1/programme.json');
 assert.equal(C.isAllowed('epg/generations/run-2/programme.json','run-1'),false);
 assert.equal(C.isAllowed('epg/generations/x/programme.json','a/b'),false);
 assert.throws(()=>C.resolveKey(C.ALLOWLIST.find(item=>item.template),'../x'),/run_id_invalid/);
 const client=C.limitedClient({head:async()=>assert.fail('requested'),get:async()=>assert.fail('requested')},()=>null);
 await assert.rejects(client.head('enrichment/writer-lease.json'),/key_not_allowlisted/);
 await assert.rejects(client.get('x'),/key_not_allowlisted/);
}

// 2. a good capture: stable ETags, only GET/HEAD of allowlisted keys, no listing, a deterministic manifest digest
if(section(3)){
 const {bucket,result}=await run();
 assert.equal(result.ok,true,JSON.stringify(result.reasons));
 const m=result.manifest;
 assert.equal(m.manifestVersion,1);assert.equal(m.source.bucket,'iptv');assert.equal(m.source.accountId,undefined);assert.equal(m.source.readOnly,true);
 assert.equal(m.runId,'run-1');
 for(const o of m.objects){assert.ok(['present','absent'].includes(o.state));if(o.state==='present'){assert.match(o.etag,/\S/);assert.ok(o.size>0);assert.match(o.sha256,/^[0-9a-f]{64}$/);}assert.ok(o.role);}
 const absent=m.objects.filter(o=>o.state==='absent').map(o=>o.id).sort();
 assert.deepEqual(absent,['diary','discoveryLease','ownerMirror','retirements','sync','verifiedFilms','viewIndex']);
 assert.deepEqual(C.verifyManifest(m,result.bodies),[]);
 assert.ok(m.notCovered.some(text=>/do not prove a consistent R2\+D1 snapshot/.test(text)));
 assert.ok(m.d1.before.marker&&m.d1.before.schema.version===18&&m.d1.before.window&&m.d1.before.discovery&&m.d1.before.baseline&&m.d1.before.fence&&m.d1.before.lease&&m.witness.before.film);
 for(const r of bucket.requests){assert.ok(['GET','HEAD'].includes(r.method),r.method);assert.equal(r.query,'');assert.ok(C.isAllowed(r.path.replace('/iptv/',''),'run-1'),r.path);}
 // per key the order is HEAD, GET, HEAD, and the final recheck HEAD again
 const metadataRequests=bucket.requests.filter(r=>r.path==='/iptv/metadata.json').map(r=>r.method);
 assert.deepEqual(metadataRequests,['HEAD','GET','HEAD','HEAD']);
 const again=await run();
 assert.equal(again.result.manifest.digest,m.digest,'the digest is deterministic (no timestamp in it)');
 const edited=JSON.parse(JSON.stringify(m));edited.objects[0].size++;assert.ok(C.verifyManifest(edited,result.bodies).includes('manifest_digest'));
 const tampered={...result.bodies,'metadata.json':Buffer.from('{"x":1}')};assert.ok(C.verifyManifest(m,tampered).some(r=>r.startsWith('object_digest')));
 bucket.close();again.bucket.close();
}

// 3. R2 failures fail closed with a stable reason
for(const [name,mutate,reason] of [
 ['missing required',b=>b.drop('metadata.json'),'missing:metadata'],
 ['malformed JSON',b=>b.put('titles.json','{not json'),'malformed:titles'],
 ['wrong shape',b=>b.put('watchlist.json',{films:'x'}),'malformed:watchlist'],
 ['malformed optional present',b=>b.put('identity/tmdb-retirements.json','[1]'),'malformed:retirements'],
 ['pointer unpublished',b=>b.put('epg/published-generation.json',{phase:'building',programmeRunId:'run-1'}),'malformed:publishedPointer'],
 ['hostile run id',b=>b.put('epg/published-generation.json',{phase:'published',programmeRunId:'../x'}),'malformed:publishedPointer'],
 ['live discovery lease',b=>b.put('epg/resolver-lease.json',{expiresAt:Date.parse(AT)+1000}),'writer_active:discoveryLease'],
 ['running sync',b=>b.put('sync.json',{stage:'metadata',updatedAt:'2026-11-10T11:55:00.000Z'}),'writer_active:sync'],
]){
 const bucket=await fakeBucket(INPUT);mutate(bucket);
 const {result}=await run({bucket});
 assert.equal(result.ok,false,name);assert.ok(result.reasons.includes(reason),name+': '+result.reasons);assert.equal(result.manifest,undefined);
 bucket.close();
}
if(section(4)){
 const bucket=await fakeBucket(INPUT);
 const {result}=await run({bucket,options:{maxBytes:50}});
 assert.ok(result.reasons.some(r=>r.startsWith('size_cap:')));bucket.close();
 const b2=await fakeBucket(INPUT);
 assert.ok((await run({bucket:b2,options:{maxTotalBytes:100}})).result.reasons.includes('size_cap:total'));b2.close();
}
// an old fence object (expired lease, finished sync) does not refuse
if(section(5)){
 const bucket=await fakeBucket({...INPUT,'epg/resolver-lease.json':{expiresAt:1},'sync.json':{stage:'complete',updatedAt:'2026-11-10T11:55:00.000Z'}});
 assert.equal((await run({bucket})).result.ok,true);bucket.close();
}

// 4. a moving ETag: between HEAD and GET, between GET and the second HEAD, and between the R2 reads and the D1 reads
for(const [name,when,which] of [['HEAD/GET','GET','metadata.json'],['GET/HEAD','HEAD2','people.json']]){
 const bucket=await fakeBucket(INPUT);
 let heads=0;
 bucket.hooks.length=0;
 const file=database();gateRowsOk(file);
 const hook=async({method,key})=>{
  bucket.hooks.push(hook);
  if(key!==which)return;
  if(when==='GET'&&method==='GET')bucket.put(which,{changed:1});
  if(when==='HEAD2'&&method==='HEAD'&&++heads===2)bucket.put(which,{changed:1});
 };
 bucket.hooks.push(hook);
 const result=await C.captureProjectorInputs({client:bucket.client(),db:d1Standin(file),now:NOW});
 assert.equal(result.ok,false,name);assert.ok(result.reasons.some(r=>r.startsWith('etag_changed:')||r.startsWith('size_mismatch')),name+result.reasons);
 bucket.close();
}
if(section(6)){
 const bucket=await fakeBucket(INPUT);
 const {result}=await run({bucket,options:{hooks:{beforeD1:async()=>bucket.put('titles.json',{moved:1})}}});
 assert.equal(result.ok,false);assert.ok(result.reasons.includes('etag_changed_after:titles'),result.reasons);bucket.close();
}
// a key appearing / disappearing after capture (absent -> present)
if(section(7)){
 const bucket=await fakeBucket(INPUT);
 const {result}=await run({bucket,options:{hooks:{beforeD1:async()=>bucket.put('letterboxd/diary/history.json',{x:1})}}});
 assert.ok(result.reasons.includes('etag_changed_after:diary'));bucket.close();
}

// the second HEAD is compared even where the server does not enforce If-Match
if(section(8)){
 const bucket=await fakeBucket(INPUT);let heads=0;
 const real=bucket.client(),client={get:real.get,head:async(key,options)=>{const value=await real.head(key,{});return key==='metadata.json'&&++heads===2?{...value,etag:'moved'}:value;}};
 const file=database();gateRowsOk(file);
 const result=await C.captureProjectorInputs({client,db:d1Standin(file),now:NOW});
 assert.equal(result.ok,false);assert.ok(result.reasons.includes('etag_changed:metadata'),result.reasons);bucket.close();
}
// 5. the D1 side: schema, marker, baseline, fence, lease, window, discovery generation; failed probes; concurrent writer
const sql=(file,text)=>sqlite(file,text);
for(const [name,setup,reason] of [
 ['schema moved',f=>sql(f,"UPDATE schema_contract SET version=version"),null],
 ['marker d1 held',f=>sql(f,"UPDATE film_person_authority SET mode='d1',cutover='held'"),'marker_not_capturable:d1/held'],
 ['marker d1',f=>sql(f,"UPDATE film_person_authority SET mode='d1'"),'marker_not_capturable:d1/open'],
 ['fence closed',f=>sql(f,"UPDATE film_person_cas SET ok=2"),'fence_not_ok'],
 ['foreign live lease',f=>sql(f,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','other','2026-11-10T12:30:00.000Z','2026-11-10T11:59:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='other',lease_until='2026-11-10T12:30:00.000Z'"),'projector_lease_live'],
 ['live window',f=>sql(f,"UPDATE projector_window SET state='held',owner='x',requested_at="+(Date.parse(AT)-1000)+",expires_at="+(Date.parse(AT)+60000)),'window_live'],
]){
 const bucket=await fakeBucket(INPUT);const file=database();gateRowsOk(file);setup(file);
 const result=await C.captureProjectorInputs({client:bucket.client(),db:d1Standin(file),now:NOW,expectedSchema:name==='schema moved'?17:18});
 assert.equal(result.ok,false,name);
 assert.ok(name==='schema moved'?result.reasons.includes('schema_unexpected:18'):result.reasons.includes(reason),name+': '+result.reasons);
 assert.equal(bucket.requests.length,0,name+': nothing is requested from R2 when the D1 gate refuses');
 bucket.close();
}
// expired lease / expired window do not refuse
if(section(9)){
 const bucket=await fakeBucket(INPUT);const file=database();gateRowsOk(file);
 sql(file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','old','2026-11-10T11:00:00.000Z','2026-11-10T10:50:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='old',lease_until='2026-11-10T11:00:00.000Z'");
 const result=await C.captureProjectorInputs({client:bucket.client(),db:d1Standin(file),now:NOW});assert.equal(result.ok,true,result.reasons);bucket.close();
}
// a concurrent writer: the marker, the baseline, the discovery generation, the lease and a witnessed table move between the pages of the capture
for(const [name,statement,reason] of [
 ['marker moved',"UPDATE film_person_authority SET generation=generation+1",'marker_moved'],
 ['baseline moved',"UPDATE film_person_baseline SET state='loading'",'baseline_moved'],
 ['discovery generation moved',"UPDATE discovery_authority SET generation=generation+1",'discovery_generation_moved'],
 ['published moved',"UPDATE published_epg_authority SET generation=generation+1",'published_moved'],
 ['lease taken',"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','w','2026-11-10T13:00:00.000Z','2026-11-10T12:00:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='w',lease_until='2026-11-10T13:00:00.000Z'",'projector_lease_live_after'],
 ['witnessed table written',"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:w',1,'W','2026-11-10T12:00:01.000Z')",'witness_moved'],
]){
 const bucket=await fakeBucket(INPUT);const file=database();gateRowsOk(file);
 const result=await C.captureProjectorInputs({client:bucket.client(),db:d1Standin(file),now:NOW,hooks:{beforeD1:async()=>sql(file,statement)}});
 assert.equal(result.ok,false,name);assert.ok(result.reasons.includes(reason),name+': '+result.reasons);
 bucket.close();
}
// failed probes: a missing table, an error envelope, a non-array result, a malformed row
if(section(10)){
 const bucket=await fakeBucket(INPUT);
 const missing=await C.readCaptureGate({prepare:()=>({all:async()=>{throw new Error('no such table: projector_window');}})}).catch(e=>e);
 assert.match(missing.message,/gate_unreadable/);
 const binding=C.envelopeBinding(async()=>[{success:false,error:'x'}]);
 await assert.rejects(binding.prepare('SELECT 1').all(),/probe_failed/);
 await assert.rejects(C.envelopeBinding(async()=>({results:[]})).prepare('SELECT 1').first(),/probe_failed/);
 await assert.rejects(C.envelopeBinding(async()=>[{success:true,results:'x'}]).prepare('SELECT 1').all(),/probe_failed/);
 assert.deepEqual(await C.envelopeBinding(async()=>[{success:true,results:[{a:1}]}]).prepare('SELECT 1').first(),{a:1});
 const bad=await C.captureProjectorInputs({client:bucket.client(),db:stub(async()=>({results:{not:'an array'}})),now:NOW});
 assert.equal(bad.ok,false);assert.ok(bad.reasons[0].startsWith('probe_malformed'),bad.reasons);
 const failing=await C.captureProjectorInputs({client:bucket.client(),db:stub(async()=>{throw new Error('boom');}),now:NOW});
 assert.ok(failing.reasons[0].startsWith('probe_failed'),failing.reasons);
 const twoRows=await C.captureProjectorInputs({client:bucket.client(),db:stub(async()=>({results:[{id:1,version:18},{id:2,version:18}]})),now:NOW});
 assert.ok(twoRows.reasons[0].startsWith('probe_malformed'));
 assert.equal(bucket.requests.length,0);bucket.close();
}

// 6. the read-only guard: only one SELECT; a write or a second statement is refused before D1 sees it
if(section(11)){
 const env=C.derivedEnv({prepare:()=>assert.fail('d1')});
 await assert.rejects(env.BUCKET.get('metadata.json'),/r2_read_in_d1_derived/);await assert.rejects(env.BUCKET.head('metadata.json'),/r2_read_in_d1_derived/);assert.equal(env.BUCKET.put,undefined);
}
if(section(12)){
 const seen=[];const binding=C.readOnlyBinding({prepare:text=>{seen.push(text);return {bind:()=>({first:async()=>null,all:async()=>({results:[]})})};}});
 for(const text of ['DELETE FROM film','INSERT INTO film VALUES (1)','UPDATE film SET id=1','SELECT 1; DROP TABLE film','PRAGMA writable_schema=1','CREATE TABLE x (a)','REPLACE INTO film VALUES (1)'])assert.throws(()=>binding.prepare(text),/d1_statement_refused/);
 assert.equal(seen.length,0);
 binding.prepare('SELECT 1').bind().all();assert.equal(seen.length,1);
 assert.equal(binding.batch,undefined);assert.equal(typeof binding.prepare('SELECT 1').run,'undefined');
 for(const sqlText of Object.values(C.GATE_STATEMENTS))assert.match(sqlText,/^SELECT /);
 // every statement of a real capture is a SELECT
 const stats=[];const file=database();gateRowsOk(file);const bucket=await fakeBucket(INPUT);
 const standin=d1Standin(file,{onQuery:async text=>{stats.push(text);}});
 assert.equal((await C.captureProjectorInputs({client:bucket.client(),db:standin,now:NOW})).ok,true);
 assert.ok(stats.length>10&&stats.every(text=>/^\s*SELECT\b/i.test(text)&&!/\b(INSERT|UPDATE|DELETE|DROP|CREATE|REPLACE)\b/i.test(text)),'a non-SELECT statement was issued');
 bucket.close();
}
// no write method is ever built: the client throws on anything but GET/HEAD, and the fake bucket recorded none
if(section(13)){
 const src=fs.readFileSync('scripts/film-person-capture.mjs','utf8').replace(/^\s*\/\/.*$/gm,'');
 assert.doesNotMatch(src,/'PUT'|'POST'|'DELETE'|\.list\(|R2_INSTALL|\bBUCKET\.put\b|wrangler/);
 assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/film-person-capture/);
 assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/film-person-capture/);
 assert.doesNotMatch(src,/process\.env/,'credentials are read by the caller through readCredentials, never here');
}

// 7. resume: only with unchanged ETags and an unchanged D1 gate; never two cuts in one manifest
if(section(14)){
 const bucket=await fakeBucket(INPUT);const file=database();gateRowsOk(file);const db=d1Standin(file);
 const first=await C.captureProjectorInputs({client:bucket.client(),db,now:NOW,maxKeys:4});
 assert.equal(first.ok,false);assert.equal(first.done,false);assert.deepEqual(first.reasons,['checkpoint']);
 assert.ok(first.checkpoint.entries.length>=3);
 const before=bucket.requests.length;
 const resumed=await C.captureProjectorInputs({client:bucket.client(),db,now:NOW,checkpoint:first.checkpoint});
 assert.equal(resumed.ok,true,resumed.reasons);
 const fresh=await run();
 assert.equal(resumed.manifest.digest,fresh.result.manifest.digest,'resume gives the manifest of an uninterrupted capture');
 const getsOfSaved=bucket.requests.slice(before).filter(r=>r.method==='GET'&&first.checkpoint.entries.some(e=>'/iptv/'+e.key===r.path));
 assert.equal(getsOfSaved.length,0,'saved objects are not read again');
 fresh.bucket.close();
 // an ETag moved after the checkpoint: the checkpoint is discarded whole and the capture restarts (one cut only)
 const second=await C.captureProjectorInputs({client:bucket.client(),db,now:NOW,maxKeys:4});
 bucket.put(second.checkpoint.entries[0].key,{moved:true});
 const restarted=await C.captureProjectorInputs({client:bucket.client(),db,now:NOW,checkpoint:second.checkpoint});
 assert.equal(restarted.ok,true,restarted.reasons);assert.equal(restarted.manifest.objects.find(o=>o.key===second.checkpoint.entries[0].key).state,'present','the checkpoint was discarded and the new cut holds the moved object');
 // the same, with a still valid object moved
 const bucket2=await fakeBucket(INPUT);const f2=database();gateRowsOk(f2);const db2=d1Standin(f2);
 const c1=await C.captureProjectorInputs({client:bucket2.client(),db:db2,now:NOW,maxKeys:6});
 bucket2.put('metadata.json',{a:1});
 const r2=await C.captureProjectorInputs({client:bucket2.client(),db:db2,now:NOW,checkpoint:c1.checkpoint});
 assert.equal(r2.ok,true);
 const live=JSON.parse(Buffer.from(r2.bodies['metadata.json']).toString());assert.deepEqual(live,{a:1},'the restarted capture holds the new cut only');
 const stale=r2.manifest.objects.find(o=>o.id==='metadata');assert.equal(stale.sha256,sha(Buffer.from('{"a":1}')));
 // a D1 gate that moved since the checkpoint discards it too
 const c2=await C.captureProjectorInputs({client:bucket2.client(),db:db2,now:NOW,maxKeys:3});
 sql(f2,"UPDATE film_person_authority SET generation=generation+1");
const mark3=bucket2.requests.length;
 const r3=await C.captureProjectorInputs({client:bucket2.client(),db:db2,now:NOW,checkpoint:c2.checkpoint});
 assert.equal(r3.ok,true);assert.notEqual(r3.manifest.d1.before.marker.generation,c2.checkpoint.gate.marker.generation);
 for(const e of c2.checkpoint.entries.filter(e=>e.state==='present'))assert.ok(bucket2.requests.slice(mark3).some(r=>r.method==='GET'&&r.path==='/iptv/'+e.key),'a checkpoint of another D1 gate is discarded: its objects are read again');
 // a checkpoint naming a key outside the allowlist is never used
 const forged={...c2.checkpoint,gate:r3.manifest.d1.before,entries:[{key:'enrichment/writer-lease.json',id:'x',state:'present',etag:'e',size:1}]};
 const bucket3=await fakeBucket(INPUT);
 const r4=await C.captureProjectorInputs({client:bucket3.client(),db:db2,now:NOW,checkpoint:forged});
 assert.equal(r4.ok,true);assert.ok(!bucket3.requests.some(r=>r.path==='/iptv/enrichment/writer-lease.json'));
 bucket.close();bucket2.close();bucket3.close();
}

// 8. D1-routed inputs: with the discovery authority d1 the catalog is read from D1 and is NOT requested from R2
if(section(15)){
 const bucket=await fakeBucket(INPUT);const file=database();gateRowsOk(file);
 sql(file,"UPDATE discovery_authority SET mode='d1',cutover='open',programme_run_id='run-1'");
 const result=await C.captureProjectorInputs({client:bucket.client(),db:d1Standin(file),now:NOW});
 assert.equal(result.ok,true,result.reasons);
 assert.ok(!bucket.requests.some(r=>/discovered-films|discovery-resolution/.test(r.path)));
 assert.ok(result.manifest.derived.discoveryCatalog&&result.manifest.derived.discoveryResolution);
 assert.equal(result.manifest.routes.discovery,true);
 bucket.close();
 const b2=await fakeBucket(INPUT);const f2=database();gateRowsOk(f2);
 sql(f2,"UPDATE discovery_authority SET mode='d1',cutover='held'");
 assert.ok((await C.captureProjectorInputs({client:b2.client(),db:d1Standin(f2),now:NOW})).reasons.includes('discovery_held'));b2.close();
}

// 9. the diagnostics on fixtures (pure) and the report
const SEP='\u001f';
const enc=values=>JSON.stringify(values);
if(section(16)){
 const expected={classes:{person:[['person:a',enc(['a'])],['person:b',enc(['b'])]],personExternalId:[[['person:b','tmdb','7'].join(SEP),enc([1,0])]],retirement:[['film:r1',enc(['retire','1','2'])]],redirect:[['film:old1',enc(['film:new1'])]]}};
 const actual={classes:{
  person:[['person:a',enc(['a'])],['person:b',enc(['b'])],['person:merged',enc(['m'])],['person:renamed',enc(['a'])],['person:gone',enc(['g'])],['person:retired',enc(['q'])]],
  personExternalId:[[['person:merged','tmdb','7'].join(SEP),enc([1,0])]],
  credit:[[['film:r1','person:retired','actor'].join(SEP),enc([0])]],
  projectionKey:['a','b','merged','renamed','gone','retired','nokey'].map(id=>[['person','person:'+id].join(SEP),enc(['k'])]),
  redirect:[['film:old1',enc(['film:new1'])],['film:old2',enc(['film:r1'])],['film:old3',enc(['film:new3'])],['film:old4',enc(['film:new4'])],['film:old5',enc(['film:new5'])]],
 }};
 const personKeys=C.diagnosePersonKeys({expected,actual});
 assert.equal(personKeys.keyedPersons,7);assert.equal(personKeys.viewPersons,2);assert.equal(personKeys.absentFromView,5);
 assert.deepEqual(Object.fromEntries(Object.entries(personKeys.causes).map(([k,v])=>[k,v.count])),{merged_or_deduplicated:1,renamed_id:1,removed_from_sources:1,retired:1,key_without_person_row:1});
 assert.doesNotMatch(JSON.stringify(personKeys),/person:/,'ids appear as hashes only');
 for(const entry of Object.values(personKeys.causes))for(const h of entry.hashes)assert.match(h,/^[0-9a-f]{12}$/);
 const redirects=C.diagnoseRedirects({expected,actual,redirectRows:[{from_id:'film:old1',at:'2026-11-10T02:00:42.000Z'},{from_id:'film:old2',at:'2026-11-10T02:00:42.000Z'},{from_id:'film:old3',at:'2026-11-10T02:00:42.000Z'},{from_id:'film:old4',at:'2026-11-10T02:00:42.000Z'},{from_id:'film:old5',at:'2026-11-10T02:00:42.000Z'}]});
 assert.equal(redirects.actual,5);assert.deepEqual(redirects.byClass,{expected_redirect:1,corresponds_to_retirement:1,no_expected_source:3});
 assert.deepEqual(redirects.batchAt,['2026-11-10T02:00:42.000Z']);assert.equal(redirects.retirementsWithoutRedirect,0);
 assert.doesNotMatch(JSON.stringify(redirects),/film:/);
 assert.equal(redirects.items.filter(i=>i.kind==='no_expected_source').length,3);
 // determinism
 assert.equal(JSON.stringify(C.diagnosePersonKeys({expected,actual})),JSON.stringify(personKeys));
}
if(section(17)){
 // (c) through the real view: a Film whose change key differs from the stored one, with and without prediction facts on the redirect source
 const bucket=await fakeBucket(INPUT);const file=database();gateRowsOk(file);const db=d1Standin(file);
 const cap=await C.captureProjectorInputs({client:bucket.client(),db,now:NOW});assert.equal(cap.ok,true,cap.reasons);
 const built=C.buildExpected({manifest:cap.manifest,bodies:cap.bodies,derivedValues:cap.derivedValues,asOf:AT});
 assert.ok(built.inputs.films.length>=1&&built.inputs.people.length>=1,'the real view built Films and People from the captured objects');
 const target=built.inputs.films[0];
 const withRedirect={...built.inputs,films:[{...target,film:{...target.film,redirects:[{from:'film:old',to:target.id}]}},...built.inputs.films.slice(1)]};
 const actual={classes:{film:[['film:old','["1",null,null]']],projectionKey:[]}};
 const none=await C.diagnoseChangedFilms({inputs:withRedirect,actual,factsOf:async()=>[],asOf:AT});
 assert.equal(none.changed,built.inputs.films.length);assert.equal(none.classes.changed_but_unwritten.count,1);assert.equal(none.classes.other?.count??0,built.inputs.films.length-1);
 const held=await C.diagnoseChangedFilms({inputs:withRedirect,actual,factsOf:async id=>id==='film:old'?['prediction_current']:[],asOf:AT});
 assert.equal(held.classes.retained_duplicate.count,1);
 assert.equal(C.factsSql().split('UNION ALL').length,5);
 // a real facts query against the stand-in: the projector's SQL runs
 sql(file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:old',1,'Old','"+AT+"')");
 const reader=(await import('../src/film-person-baseline.js')).readerOf(db);
 assert.deepEqual((await reader.all(C.factsSql(),C.FACT_TABLES.map(()=>'film:old'))),[]);
 bucket.close();
}

// 10. the parity run: the stage A stable cut on D1, the ledger, the report, and refusals
if(section(18)){
 const bucket=await fakeBucket(INPUT);const file=database();gateRowsOk(file);const db=d1Standin(file);
 const cap=await C.captureProjectorInputs({client:bucket.client(),db,now:NOW});assert.equal(cap.ok,true);
 const go=(over={})=>C.runParity({manifest:cap.manifest,bodies:cap.bodies,derivedValues:cap.derivedValues,db:d1Standin(file),client:bucket.client(),leaseId:'capture:test',asOf:AT,now:NOW,...over});
 const first=await go();
 assert.equal(first.ok,true,first.reasons);
 const r=first.report;
 assert.equal(r.measurement,true);assert.equal(r.authorizes,'nothing');assert.equal(r.manifestDigest,cap.manifest.digest);
 for(const name of ['film','person','filmExternalId','personExternalId','filmAlias','personAlias','credit','filmLocalization','personLocalization','watchlist','redirect','retirement','ratedAdmission','retention','ownerLink','projectionKey'])assert.ok(name in r.coverage,name);
 assert.equal(r.coverage.ownerLink.unavailable,true,'ownerLink is not derivable offline and is reported as unavailable');
 assert.ok(r.coverage.film.expected>=1&&r.coverage.film.actual===0&&r.coverage.film.missing===r.coverage.film.expected,'an empty D1 misses every expected Film');
 assert.match(r.digest,/^[0-9a-f]{64}$/);assert.ok(r.diagnostics.personKeys&&r.diagnostics.redirects&&r.diagnostics.changedFilms);
 assert.doesNotMatch(JSON.stringify(r),/Film alpha|Dir alpha|film:alpha/,'no title, name or id in the report');
 assert.equal(first.ledger.source.verified,false);
 assert.equal((await baselineGate(first.ledger)).pass,false);assert.ok((await baselineGate(first.ledger)).reasons.includes('source_unverified'));
 // determinism of the ledger and the report digest
 const second=await go({leaseId:'capture:other'});
 assert.equal(second.ledger.digest,first.ledger.digest);assert.equal(second.report.digest,first.report.digest);
 // diagnostics never create an exception: an unexplained difference stays unexplained and the ledger digest does not move
 assert.ok(first.ledger.totals.unexplained>0);
 // an exception in the existing shape is applied; one without an approver is ignored
 const key=first.ledger.unexplainedList[0];
 const excepted=await go({exceptions:[{class:key.class,key:key.key,reason:'owner reviewed',approvedBy:'owner'}]});
 assert.equal(excepted.ledger.totals.unexplained,first.ledger.totals.unexplained-1);
 const ignored=await go({exceptions:[{class:key.class,key:key.key,reason:'x'}]});
 assert.equal(ignored.ledger.invalidExceptions,1);assert.equal(ignored.ledger.totals.unexplained,first.ledger.totals.unexplained);
 // an R2 ETag that moved after the D1 cut is reported, and the read is not consistent
 const movedAfter=await go({client:(()=>{const c=bucket.client();const head=c.head;let n=0;return {head:async(k,o)=>{const v=await head(k,o);return k==='titles.json'&&++n>=1?{...v,etag:'zzz'}:v;},get:c.get};})()});
 assert.equal(movedAfter.ok,false);assert.ok(movedAfter.reasons.includes('etag_changed_after_cut:titles'));
 // a doctored manifest or object is refused before any D1 read
 const reads=[];
 const doctored=await C.runParity({manifest:{...cap.manifest,runId:'run-2'},bodies:cap.bodies,derivedValues:cap.derivedValues,db:d1Standin(file,{onQuery:async t=>reads.push(t)}),client:bucket.client(),leaseId:'x',asOf:AT});
 assert.equal(doctored.ok,false);assert.ok(doctored.reasons[0].startsWith('manifest_invalid'));assert.equal(reads.length,0);
 // a foreign live lease or a concurrent writer during the cut makes the read inconsistent (stage A guard) and the run refuses
 sql(file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','foreign','2999-01-01T00:00:00.000Z','2026-11-10T11:59:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='foreign',lease_until='2999-01-01T00:00:00.000Z',started_at='2026-11-10T11:59:00.000Z'");
 const blocked=await go();assert.equal(blocked.ok,false);assert.ok(blocked.reasons.includes('projector_lease_live'),'a live lease is refused before the cut');
 bucket.close();
}
// incomplete coverage: a class that cannot be read is unavailable, never empty, and the gate stays closed
if(section(19)){
 const bucket=await fakeBucket(INPUT);const file=database();gateRowsOk(file);
 sql(file,"DROP VIEW tmdb_retirement_current;");
 const cap=await C.captureProjectorInputs({client:bucket.client(),db:d1Standin(file),now:NOW});
 assert.equal(cap.ok,true,cap.reasons);
 const out=await C.runParity({manifest:cap.manifest,bodies:cap.bodies,derivedValues:cap.derivedValues,db:d1Standin(file),client:bucket.client(),leaseId:'x',asOf:AT,now:NOW});
 assert.equal(out.report.coverage.retirement.unavailable,true);assert.equal(out.ledger.complete,false);assert.equal((await baselineGate(out.ledger)).pass,false);
 bucket.close();
}

// 11. a class-C difference (a retired, held or owner-only fact) needs the owner exception and is never explained by a diagnostic
if(section(20)){
 const bucket=await fakeBucket({...INPUT,'identity/tmdb-retirements.json':{schemaVersion:1,retirements:[]}});const file=database();gateRowsOk(file);
 const cap=await C.captureProjectorInputs({client:bucket.client(),db:d1Standin(file),now:NOW});
 const out=await C.runParity({manifest:cap.manifest,bodies:cap.bodies,derivedValues:cap.derivedValues,db:d1Standin(file),client:bucket.client(),leaseId:'x',asOf:AT,now:NOW});
 assert.ok(out.ledger.totals.unexplained>0);assert.equal(out.report.diagnostics.note,'diagnostics classify and count; none is an exception');
 assert.equal(out.ledger.explainedSample.filter(item=>item.rule==='owner_exception').length,0);
 bucket.close();
}

// 12. corrected consistency contract: the recorded D1 identity must still be the live one, and every derived payload is bound to its manifest
if(section(21)){
 const fresh=async(seed=()=>{})=>{const bucket=await fakeBucket(INPUT);const file=database();gateRowsOk(file);seed(file);const cap=await C.captureProjectorInputs({client:bucket.client(),db:d1Standin(file),now:NOW});assert.equal(cap.ok,true,cap.reasons);return {bucket,file,cap,go:(over={})=>C.runParity({manifest:cap.manifest,bodies:cap.bodies,derivedValues:cap.derivedValues,db:d1Standin(file),client:bucket.client(),leaseId:'capture:test',asOf:AT,now:NOW,...over})};};
 const base=await fresh();
 assert.equal((await base.go()).ok,true,'an unchanged identity passes');
 base.bucket.close();
 const MOVES=[
  ['discovery generation',"UPDATE discovery_authority SET generation=generation+1",'d1_identity_moved:discovery.generation'],
  ['published run id',"UPDATE published_epg_authority SET programme_run_id='run-9'",'d1_identity_moved:published.programmeRunId'],
  ['published generation',"UPDATE published_epg_authority SET generation=generation+1",'d1_identity_moved:published.generation'],
  ['owner-review generation',"UPDATE owner_review_authority SET generation=generation+1",'d1_identity_moved:owner.generation'],
  ['marker generation',"UPDATE film_person_authority SET generation=generation+1",'d1_identity_moved:marker.generation'],
  ['schema version',"UPDATE schema_contract SET version=version+1",'d1_identity_moved:schema.version'],
  ['baseline state',"UPDATE film_person_baseline SET state='loading'",'d1_identity_moved:baseline.state'],
  ['live lease',"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','other','2999-01-01T00:00:00.000Z','2026-11-10T11:59:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='other',lease_until='2999-01-01T00:00:00.000Z'",'projector_lease_live'],
  ['live window',"UPDATE projector_window SET state='held',owner='x',requested_at="+(Date.parse(AT)-1000)+",expires_at="+(Date.parse(AT)+60000),'window_live'],
 ];
 for(const [name,statement,reason] of MOVES){
  const run=await fresh();sql(run.file,statement);
  const out=await run.go();
  assert.equal(out.ok,false,name);assert.ok(out.reasons.includes(reason),name+': '+out.reasons.join());
  assert.doesNotMatch(out.reasons.join(),/run-9|film:|Film /,'the reason names the field, never a value: '+name);
  assert.equal(out.report,undefined,'no report is produced: '+name);
  run.bucket.close();
 }
 // a move that lands DURING the cut window (after the cut, before the identity recheck) is caught by the second comparison
 for(const [name,statement,reason] of [['discovery generation after cut',"UPDATE discovery_authority SET generation=generation+1",'d1_identity_moved_after_cut:discovery.generation'],['owner generation after cut',"UPDATE owner_review_authority SET generation=generation+1",'d1_identity_moved_after_cut:owner.generation']]){
  const run=await fresh();
  const out=await run.go({hooks:{afterCut:async()=>sql(run.file,statement)}});
  assert.equal(out.ok,false,name);assert.ok(out.reasons.includes(reason),name+': '+out.reasons.join());run.bucket.close();
 }
 // identity helpers: only the named fields count, in a stable order
 assert.deepEqual(C.identityMoved(base.cap.manifest.d1.after,base.cap.manifest.d1.after),[]);
 assert.deepEqual(C.identityMoved({...base.cap.manifest.d1.after,lease:{held:true}},base.cap.manifest.d1.after),[],'leases are not identity');

 // ---- derived payload binding ----
 // (the pure verifyDerived cases run first in this file, see the top; here: the end-to-end refusal)
 // end to end: runParity refuses a tampered derived set before any D1 read
 const routed=await fresh(f=>sql(f,"UPDATE discovery_authority SET mode='d1',cutover='open',programme_run_id='run-1'"));
 assert.equal((await routed.go()).ok,true);
 const reads=[];
 const tampered=await C.runParity({manifest:routed.cap.manifest,bodies:routed.cap.bodies,derivedValues:{...routed.cap.derivedValues,discoveryCatalog:{...routed.cap.derivedValues.discoveryCatalog,'film:extra':{}}},db:d1Standin(routed.file,{onQuery:async t=>reads.push(t)}),client:routed.bucket.client(),leaseId:'x',asOf:AT,now:NOW});
 assert.equal(tampered.ok,false);assert.deepEqual(tampered.reasons,['derived_invalid:derived_digest:discoveryCatalog']);assert.equal(reads.length,0);
 const dropped=await routed.go({derivedValues:{discoveryCatalog:routed.cap.derivedValues.discoveryCatalog}});
 assert.deepEqual(dropped.reasons,['derived_invalid:derived_missing:discoveryResolution']);
 const extra=await routed.go({derivedValues:{...routed.cap.derivedValues,ownerReviews:{}}});
 assert.deepEqual(extra.reasons,['derived_invalid:derived_extra:ownerReviews']);
 routed.bucket.close();

 // ---- diagnostics: a separate observation, flagged when D1 moved under it ----
 const diag=await fresh();
 const calm=await diag.go();
 assert.equal(calm.report.diagnostics.cut,'separate_observation');assert.equal(calm.report.diagnostics.stable,true);
 const moved=await diag.go({hooks:{afterLedger:async()=>sql(diag.file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:between',1,'B','"+AT+"')")}});
 assert.equal(moved.ok,true);assert.equal(moved.report.diagnostics.cut,'separate_observation');assert.equal(moved.report.diagnostics.stable,false,'a write between the ledger read and the diagnostics read is flagged');
 assert.match(moved.report.diagnostics.note,/different state than the ledger/);
 diag.bucket.close();
}
if(ONLY)for(const number of ONLY)assert.ok(Number.isInteger(number)&&number>=1&&number<=SECTION_COUNT,'CAPTURE_SECTIONS names a section that does not exist: '+number);
assert.equal(sectionsRun,ONLY?ONLY.size:SECTION_COUNT,'every requested section ran');
console.log('film-person-capture: ok'+(ONLY?' (sections '+[...ONLY].join(',')+' only)':''));
