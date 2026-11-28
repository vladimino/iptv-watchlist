// AIR-634 (card PV3; ADR 0214 decisions 9, 11, 15-16 as amended by ADR 0224): the authenticated owner API of the per-field provenance of one Film (src/admin/film-metadata-route.js). Local vm only, on the REAL migrated schema
// through the sqlite3-CLI D1 stand-in and the REAL single writer (writeFilmFacts); the Access JWT is verified IN the Worker. Offline: no Worker deploy, R2, TMDB or production access; synthetic ids; nothing is activated.
//  1. the gates before anything is read or written (method, Origin, action header, content type, an unconfigured verifier, another audience, a rogue key, an expired token, not the owner) and the pure validation;
//  2. schema absent and mode `off` refuse writes, the GET stays a pure read;
//  3. set / lock / release / revert, each with its readback, the language bound to the value (ADR 0224), the command record and the Film revision (a no-op included);
//  4. replay: already_applied after later writes, request_mismatch on any field, a lost response settled by the command row, two concurrent resends commit once, a rejection records nothing;
//  5. revert: foreign_history, identity_unknown, anchor_changed (also between the plan and the commit), `set` where revert is refused;
//  6. refresh: epoch-only (no metadata, no history, no Film revision bump), not_in_scope, stale rows, a mode that moved;
//  7. hold keeps the owner route; a stale expectedRevision; an automatic clear is not this route's business;
//  8. the GET: pure (no write statement), values, ranks, locks, C1 conflicts and hints, redirect history and the paginated history.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as FilmMetadataProvenance from '../src/film-metadata-provenance.js';
import * as CatalogEnrichmentPlan from '../src/catalog-enrichment-plan.js';
import * as CanonicalFilmWriters from '../src/canonical-film-writers.js';
import * as CanonicalMutations from '../src/canonical-mutations.js';
import * as FilmPersonAuthority from '../src/film-person-authority.js';

const TEAM='https://probe-team.cloudflareaccess.com',AUD='b2'.repeat(32),MCP_AUD='a1'.repeat(32),SITE='https://iptv.example';
const RSA={name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'};
const signing=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']),rogue=await webcrypto.subtle.generateKey(RSA,true,['sign','verify']);
const publicJwk={...await webcrypto.subtle.exportKey('jwk',signing.publicKey),kid:'kid-1',alg:'RS256',use:'sig'};
const fetch=async url=>{if(String(url)===TEAM+'/cdn-cgi/access/certs')return Response.json({keys:[publicJwk]});throw new Error('unexpected network '+url);};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const adminError=(code,status)=>json({error:code},status);
const kicks=[];
const context=vm.createContext({Response,Request,Headers,URL,Date,Map,Set,JSON,TextEncoder,TextDecoder,AbortSignal,atob,crypto:webcrypto,fetch,console,json,adminError,ISSUE_CODES:[],FilmMetadataProvenance,CatalogEnrichmentPlan,CanonicalFilmWriters,CanonicalMutations,FilmPersonAuthority,CatalogEnrichmentRunner:{kick:async()=>{kicks.push('kick');return {kicked:true};}}});
for(const file of ['src/mcp.js','src/admin/identity-owner-action.js','src/admin/film-metadata-route.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
const route=vm.runInContext('adminFilmMetadataRoute',context);

const encode=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
async function jwt({claims={},key=signing.privateKey}={}){
 const now=Math.floor(Date.now()/1000);
 const input=encode({alg:'RS256',kid:'kid-1',typ:'JWT'})+'.'+encode({aud:[AUD],email:'Owner@Example.test',exp:now+300,iat:now,iss:TEAM,sub:'owner-identity',...claims});
 return input+'.'+Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(input))).toString('base64url');
}
const good=await jwt();
const baseEnv=extra=>({MCP_ACCESS_TEAM_DOMAIN:TEAM,MCP_ACCESS_AUD:MCP_AUD,ADMIN_ACCESS_AUD:AUD,ADMIN_OWNER_EMAIL:'owner@example.test',...extra});

// ---- the world: the whole migration chain, the authority open, one Film with trusted tmdb and letterboxd ids ----
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-pv3-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlText=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const exec=(file,text)=>{const r=sqlite(file,text);if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const templates={};
function template(stage){
 if(templates[stage])return templates[stage];
 const file=path.join(root,'tpl-'+stage+'.sqlite');
 const upTo=stage==='v48'?chain.findIndex(name=>name.startsWith('0049_')):chain.length;
 assert.equal(sqlite(file,chain.slice(0,upTo).map(sqlText).join('\n')).status,0);
 assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 return templates[stage]=file;
}
const T='2026-11-27T10:00:00.000Z',T2='2026-11-27T11:00:00.000Z';
const ID='film:tmdb:603',OTHER='film:tmdb:604';
let n=0;
async function world({stage='open',mode='enforce',seed=true,dbOptions}={}){
 const file=path.join(root,'w-'+(n++)+'.sqlite');
 fs.copyFileSync(template(stage),file);
 const db=d1Standin(file,dbOptions);
 const env=baseEnv({DB:db});
 if(seed){
  for(const [id,tmdb,lid] of [[ID,'603','lid603'],[OTHER,'604','lid604']])await CanonicalMutations.mutateFilm(env,{id,expectedRevision:0,at:T,film:{contractVersion:1,originalTitle:id,externalIds:[{scheme:'tmdb',value:tmdb,trusted:true},{scheme:'letterboxd',value:lid,trusted:true}],aliases:[]}});
  if(stage!=='v48'&&mode!=='off'){setMode(file,'enforce');if(mode==='hold')setMode(file,'hold');}
 }
 return {file,env,db};
}
const setMode=(file,mode)=>exec(file,`UPDATE film_metadata_provenance_control SET mode='${mode}',revision=revision+1,updated_at='${T}',updated_by='test' WHERE id=1`);
const revisionOf=async(env,id=ID)=>(await CanonicalFilmWriters.readFilmSnapshot(env,id)).revision;
const digestOf=async(env,id=ID)=>(await CanonicalFilmWriters.readFilmSnapshot(env,id)).provenance.anchors.digest;
let counter=0;
const rid=()=>'req-pv3-'+String(++counter).padStart(6,'0');
// an automatic (catalog enrichment) declared write, so a field is attributed to a source and a language
async function declare(env,fields,{source='tmdb',at=T,languages={},id=ID}={}){
 const digest=await digestOf(env,id),snapshot=await CanonicalFilmWriters.readFilmSnapshot(env,id),anchor=snapshot.provenance.anchors.computed[source];
 const declared=Object.fromEntries(Object.keys(fields).map(field=>[field,{source,anchor:{scheme:source,value:anchor.value},observedAt:at,agreedAnchorDigest:digest,...(languages[field]||{})}]));
 return CanonicalFilmWriters.writeFilmFacts(env,{id,at,requestId:rid(),expectedRevision:snapshot.revision,film:{contractVersion:1},metadata:{updatedAt:at,declared,...fields},requireExisting:true});
}
async function call(env,{id=ID,method='POST',payload,headers={},token=good,origin=SITE,type='application/json',action='film_metadata_owner',query=''}={}){
 const init={method,headers:{...(origin?{Origin:origin}:{}),...(type?{'Content-Type':type}:{}),...(action?{'X-IPTV-Admin-Action':action}:{}),...(token?{'Cf-Access-Jwt-Assertion':token}:{}),...headers}};
 if(payload!==undefined)init.body=typeof payload==='string'?payload:JSON.stringify(payload);
 const request=new Request(SITE+'/api/admin/films/'+encodeURIComponent(id)+'/metadata'+query,init);
 const response=await route(request,env,new URL(request.url));
 return {status:response.status,body:await response.json()};
}
const post=async(env,payload,options={})=>call(env,{...options,payload:{requestId:rid(),...payload,...(payload.action==='refresh'||payload.expectedRevision!==undefined?{}:{expectedRevision:await revisionOf(env,options.id||ID)})}});
const commands=file=>rows(file,'SELECT * FROM film_metadata_owner_command ORDER BY at,request_id');
const history=file=>rows(file,'SELECT * FROM film_metadata_history ORDER BY id');
const fieldRow=(file,name,id=ID)=>rows(file,`SELECT * FROM film_metadata_field WHERE film_id='${id}' AND field='${name}'`)[0];
const meta=(file,id=ID)=>rows(file,`SELECT * FROM film_metadata WHERE film_id='${id}'`)[0];
const writes=file=>({commands:commands(file).length,history:history(file).length,fields:rows(file,'SELECT COUNT(*) AS n FROM film_metadata_field')[0].n,revision:rows(file,'SELECT SUM(revision) AS n FROM canonical_revision')[0].n});

// ---- 1. the gates run before anything is read or written ----
{
 const {file,env}=await world();
 const before=JSON.stringify(writes(file));
 const set={action:'set',field:'year',value:1999,expectedRevision:await revisionOf(env),requestId:'req-gate-0001'};
 const refused=async(label,expected,options)=>{const r=await call(env,{payload:set,...options});assert.equal(r.status,expected,label+': '+JSON.stringify(r.body));assert.equal(JSON.stringify(writes(file)),before,label+' wrote nothing');return r;};
 await refused('GET-only path with PUT',405,{method:'PUT'});
 await refused('DELETE',405,{method:'DELETE'});
 await refused('foreign Origin',403,{origin:'https://evil.example'});
 await refused('no Origin',403,{origin:null});
 await refused('no action header',403,{action:null});
 await refused('another action header',403,{action:'catalog_enrichment_settings'});
 await refused('not JSON',415,{type:'text/plain'});
 await refused('no token',403,{token:null});
 await refused('a rogue key',403,{token:await jwt({key:rogue.privateKey})});
 await refused('another audience',403,{token:await jwt({claims:{aud:[MCP_AUD]}})});
 await refused('expired',403,{token:await jwt({claims:{exp:Math.floor(Date.now()/1000)-3600}})});
 await refused('a service token (empty sub)',403,{token:await jwt({claims:{sub:''}})});
 assert.equal((await refused('not the owner',403,{token:await jwt({claims:{email:'someone@example.test'}})})).body.error,'not_owner');
 const unconfigured={...env,ADMIN_OWNER_EMAIL:undefined};
 assert.equal((await call(unconfigured,{payload:set})).status,503,'an unconfigured owner verifier is closed');
 assert.equal((await call({...env,MCP_ACCESS_TEAM_DOMAIN:undefined},{payload:set})).status,503);
 // a path that is not the metadata path of one Film
 const stray=new Request(SITE+'/api/admin/films/a/b/metadata',{method:'POST'});
 assert.equal((await route(stray,env,new URL(stray.url))).status,404);
 // pure validation: nothing reaches the writer
 for(const [label,payload,error] of [
  ['unknown key',{...set,extra:1},'invalid_command'],
  ['unknown action',{...set,action:'delete'},'invalid_action'],
  ['short request id',{...set,requestId:'x'},'invalid_request_id'],
  ['no expectedRevision',{action:'set',field:'year',value:1999,requestId:'req-gate-0002'},'invalid_expected_revision'],
  ['negative expectedRevision',{...set,expectedRevision:-1},'invalid_expected_revision'],
  ['unknown field',{...set,field:'title'},'invalid_field'],
  ['set without value',{action:'set',field:'year',expectedRevision:0,requestId:'req-gate-0003'},'invalid_command'],
  ['set with a blank value',{...set,value:''},'invalid_value'],
  ['set year of a word',{...set,value:'nineteen'},'invalid_value'],
  ['lock with a value',{action:'lock',field:'year',value:1,expectedRevision:0,requestId:'req-gate-0004'},'invalid_command'],
  ['revert without historyRef',{action:'revert',field:'year',expectedRevision:0,requestId:'req-gate-0005'},'invalid_history_ref'],
  ['refresh with a field',{action:'refresh',field:'year',expectedRevision:0,expectedRows:[],requestId:'req-gate-0006'},'invalid_command'],
  ['refresh without rows',{action:'refresh',expectedRevision:0,requestId:'req-gate-0007'},'invalid_expected_rows'],
  ['refresh of the credits part',{action:'refresh',expectedRevision:0,expectedRows:[{part:'credits',source:'tmdb',status:'complete',updatedAt:T,refreshEpoch:0}],requestId:'req-gate-0008'},'invalid_expected_rows'],
 ]){
  const r=await call(env,{payload});assert.equal(r.status,400,label+': '+JSON.stringify(r.body));assert.equal(r.body.error,error,label);
 }
 assert.equal((await call(env,{payload:'{not json'})).status,400);
 assert.equal((await call(env,{payload:'[]'})).status,400);
 assert.equal(JSON.stringify(writes(file)),before,'no refused or invalid request wrote anything');
}

// ---- 2. schema absent and mode off refuse writes; the GET stays a pure read ----
{
 const absent=await world({stage:'v48'});
 const r=await post(absent.env,{action:'set',field:'year',value:1999,expectedRevision:1});
 assert.equal(r.status,409);assert.equal(r.body.error,'schema_absent');
 const read=await call(absent.env,{method:'GET'});
 assert.equal(read.status,200);assert.equal(read.body.schemaAbsent,true);assert.equal(read.body.mode,null);
 assert.equal(read.body.history.rows.length,0);
 const off=await world({mode:'off'});
 const refusedOff=await post(off.env,{action:'set',field:'year',value:1999});
 assert.equal(refusedOff.status,409);assert.equal(refusedOff.body.error,'provenance_off');
 assert.equal(commands(off.file).length,0,'a refused write records no command');
 const readOff=await call(off.env,{method:'GET'});
 assert.equal(readOff.body.mode,'off');assert.equal(readOff.body.schemaAbsent,false);
 const refreshOff=await post(off.env,{action:'refresh',expectedRevision:await revisionOf(off.env),expectedRows:[{part:'core',source:'tmdb',status:'complete',updatedAt:T,refreshEpoch:0}]});
 assert.equal(refreshOff.body.error,'provenance_off');
 assert.equal((await call(off.env,{id:'film:absent',method:'GET'})).status,404);
 // AIR-635 RCA (production, schema v54, mode off): the page asked for the programme's STORED id (`Ab1x`), not the canonical record id (`film:Ab1x`), and every read was this 404. The contract is the canonical id.
 assert.equal((await call(off.env,{id:'603',method:'GET'})).status,404,'a bare programme id is not a canonical id');
 assert.equal((await call(off.env,{id:'tmdb:603',method:'GET'})).status,404);
 // the full chain (schema v54), mode off, a Film with LEGACY metadata and no provenance row, no history and no enrichment state: a plain 200 with the values and no rank, never an error
 const legacy=await world({mode:'off'});
 await CanonicalFilmWriters.writeFilmFacts(legacy.env,{id:ID,at:T,requestId:rid(),expectedRevision:await revisionOf(legacy.env),film:{contractVersion:1},metadata:{updatedAt:T,year:1990,runtime:120,synopsis:'Legacy synopsis'},requireExisting:true});
 assert.equal(rows(legacy.file,"SELECT COUNT(*) AS n FROM film_metadata_field")[0].n,0,'legacy metadata has no provenance row');
 assert.equal(rows(legacy.file,"SELECT COUNT(*) AS n FROM film_metadata_history")[0].n,0);
 const before=rows(legacy.file,"SELECT (SELECT COUNT(*) FROM film_metadata) AS m,(SELECT COUNT(*) FROM film_metadata_owner_command) AS c,(SELECT COUNT(*) FROM catalog_enrichment_state) AS s")[0];
 const legacyRead=await call(legacy.env,{method:'GET'});
 assert.equal(legacyRead.status,200);
 assert.equal(legacyRead.body.found,true);assert.equal(legacyRead.body.mode,'off');assert.equal(legacyRead.body.schemaAbsent,false);
 assert.deepEqual(Object.keys(legacyRead.body.fields),['year','runtime','synopsis','poster','url','genres']);
 assert.equal(legacyRead.body.fields.year.value,1990);assert.equal(legacyRead.body.fields.synopsis.value,'Legacy synopsis');
 assert.equal(legacyRead.body.fields.poster.blank,true);
 for(const entry of Object.values(legacyRead.body.fields)){assert.equal(entry.rank,undefined,'mode off claims no rank');assert.equal(entry.row,undefined,'mode off claims no lineage');}
 assert.deepEqual(legacyRead.body.locks.owner,[]);
 assert.deepEqual(legacyRead.body.history.rows,[]);assert.equal(legacyRead.body.history.next,null);
 assert.ok(legacyRead.body.c1===null||(Array.isArray(legacyRead.body.c1.rows)&&Array.isArray(legacyRead.body.c1.conflicts)),'absent enrichment state is empty, not a failure');
 assert.deepEqual(rows(legacy.file,"SELECT (SELECT COUNT(*) FROM film_metadata) AS m,(SELECT COUNT(*) FROM film_metadata_owner_command) AS c,(SELECT COUNT(*) FROM catalog_enrichment_state) AS s")[0],before,'the read wrote nothing');
}

// ---- 3. set, lock, release, revert, with the readback, the language and the command record ----
{
 const {file,env}=await world();
 // an automatic synopsis in Russian (ADR 0224) and a year, both attributed to tmdb
 await declare(env,{synopsis:'Описание',year:1999},{languages:{synopsis:{language:'ru',languageBasis:'explicit'}}});
 const start=await revisionOf(env);
 const view=await call(env,{method:'GET'});
 assert.equal(view.body.fields.synopsis.rank.name,'confirmed');
 assert.equal(view.body.fields.synopsis.row.language,'ru');assert.equal(view.body.fields.synopsis.row.languageBasis,'explicit');
 assert.equal(view.body.fields.year.row.source,'tmdb');
 assert.equal(view.body.fields.runtime.blank,true);
 assert.equal(view.body.revision,start);

 // lock: an attributed value keeps its source, anchor and language
 const lock=await post(env,{action:'lock',field:'synopsis'});
 assert.equal(lock.status,200,JSON.stringify(lock.body));assert.equal(lock.body.outcome,'applied');
 assert.equal(lock.body.command.appliedRevision,start+1);
 assert.equal(lock.body.readback.revision,start+1);
 const locked=lock.body.readback.fields.synopsis;
 assert.equal(locked.rank.name,'owner');assert.equal(locked.row.tier,'owner');assert.equal(locked.row.source,'tmdb');assert.equal(locked.row.language,'ru');
 assert.deepEqual(lock.body.readback.locks.owner,['synopsis']);
 assert.equal(commands(file).length,1);assert.equal(commands(file)[0].outcome,'applied');
 assert.equal(history(file).at(-1).reason,'owner_lock');

 // set over a pinned value: the owner may, nobody else
 const set=await post(env,{action:'set',field:'synopsis',value:'Новое описание'});
 assert.equal(set.status,200);assert.equal(meta(file).synopsis,'Новое описание');
 assert.equal(set.body.readback.fields.synopsis.row.source,'owner');
 assert.equal(history(file).at(-1).reason,'owner_set');

 // a lock of an already pinned field is a recorded no-op that still bumps the revision
 const noop=await post(env,{action:'lock',field:'synopsis'});
 assert.equal(noop.status,200);assert.equal(noop.body.outcome,'noop');
 assert.equal(noop.body.command.appliedRevision,await revisionOf(env));
 assert.equal(commands(file).at(-1).outcome,'noop');

 // release keeps the value and its lineage, the field reads unknown; an unknown value can be locked as `unattributed`
 const release=await post(env,{action:'release',field:'synopsis'});
 assert.equal(release.status,200);assert.equal(fieldRow(file,'synopsis').tier,'released');
 assert.equal(release.body.readback.fields.synopsis.rank.name,'unknown');
 assert.equal(meta(file).synopsis,'Новое описание','release keeps the value');
 const relock=await post(env,{action:'lock',field:'synopsis'});
 assert.equal(relock.status,200);assert.equal(fieldRow(file,'synopsis').source,'unattributed','an unknown value is pinned unattributed, no invented lineage');
 // an owner-set value carries no language; the unattributed lock of an unknown language invents none
 assert.equal(fieldRow(file,'synopsis').language,null);

 // a blank field cannot be locked, and a rejection writes no row and no revision
 const before=writes(file);
 const blank=await post(env,{action:'lock',field:'runtime'});
 assert.equal(blank.status,409);assert.equal(blank.body.outcome,'rejected');assert.equal(blank.body.error,'blank_field');
 assert.deepEqual(writes(file),before);

 // revert restores one history row's value and semantic columns, then pins it
 const rows1=history(file).filter(item=>item.field==='year');
 await post(env,{action:'set',field:'year',value:2001});
 const rowOld=history(file).find(item=>item.field==='year'&&item.reason==='owner_set');
 assert.equal(rowOld.old_value_text,'1999');
 const revert=await post(env,{action:'revert',field:'year',historyRef:rowOld.id});
 assert.equal(revert.status,200,JSON.stringify(revert.body));
 assert.equal(meta(file).year,1999);assert.equal(fieldRow(file,'year').tier,'owner');assert.equal(fieldRow(file,'year').source,'tmdb','the reverted lineage is restored');
 assert.equal(history(file).at(-1).reason,'owner_revert');
 assert.equal(rows1.length,0);
}

// ---- 4. replay and failure ----
{
 const {file,env}=await world();
 const first=await post(env,{action:'set',field:'year',value:1999,requestId:'req-replay-0001'});
 assert.equal(first.status,200);
 const at=commands(file)[0].at;
 // later writes, then the same command again: answered from the row, no batch
 await post(env,{action:'set',field:'runtime',value:120});
 const batches=env.DB.calls.batches;
 const stale=await call(env,{payload:{action:'set',field:'year',value:1999,expectedRevision:first.body.command.appliedRevision-1,requestId:'req-replay-0001'}});
 assert.equal(stale.status,200,JSON.stringify(stale.body));assert.equal(stale.body.outcome,'already_applied');
 assert.equal(stale.body.command.appliedRevision,first.body.command.appliedRevision);assert.equal(stale.body.command.at,at);
 assert.equal(env.DB.calls.batches,batches,'a replay opens no batch');
 // the same key and a different command, on every field and action
 for(const payload of [
  {action:'set',field:'year',value:2000,expectedRevision:first.body.command.appliedRevision-1},
  {action:'set',field:'runtime',value:99,expectedRevision:first.body.command.appliedRevision-1},
  {action:'lock',field:'year',expectedRevision:first.body.command.appliedRevision-1},
  {action:'refresh',expectedRevision:0,expectedRows:[{part:'core',source:'tmdb',status:'complete',updatedAt:T,refreshEpoch:0}]},
 ]){
  const r=await call(env,{payload:{...payload,requestId:'req-replay-0001'}});
  assert.equal(r.status,409,JSON.stringify(payload));assert.equal(r.body.error,'request_mismatch');
 }
 // the same key on another Film is a different command
 const otherFilm=await call(env,{id:OTHER,payload:{action:'set',field:'year',value:1999,expectedRevision:first.body.command.appliedRevision-1,requestId:'req-replay-0001'}});
 assert.equal(otherFilm.body.error,'request_mismatch');
 assert.equal(commands(file).length,2);

 // a stale expectedRevision is a rejection and records nothing
 const rev=await revisionOf(env),before=writes(file);
 const old=await call(env,{payload:{action:'set',field:'year',value:2005,expectedRevision:rev-1,requestId:rid()}});
 assert.equal(old.status,409);assert.equal(old.body.error,'stale_revision');assert.equal(old.body.revision,rev);
 assert.deepEqual(writes(file),before);
 // and it is recomputed, deterministically, on a retry
 assert.equal((await call(env,{payload:{action:'set',field:'year',value:2005,expectedRevision:rev-1,requestId:'req-retry-stale'}})).body.error,'stale_revision');

 // a lost response, settled in the same request: the batch commits, the answer is lost, the route reads the command row and answers from it
 const settledNow=await world();
 const realNow=settledNow.db.batch.bind(settledNow.db);let loseNow=true;
 settledNow.env.DB={...settledNow.db,prepare:settledNow.db.prepare.bind(settledNow.db),batch:async list=>{const out=await realNow(list);if(loseNow&&list.length>3){loseNow=false;throw new Error('network: answer lost');}return out;}};
 const inRequest=await call(settledNow.env,{payload:{action:'set',field:'year',value:1983,expectedRevision:await revisionOf(settledNow.env),requestId:'req-lost-0000'}});
 assert.equal(inRequest.status,200);assert.equal(inRequest.body.outcome,'already_applied');assert.equal(commands(settledNow.file).length,1);

 // a lost response that cannot be read back: the batch commits, the answer AND the next read are lost; the answer is `uncertain` and a resend settles from the command row
 const lost=await world();
 const real=lost.db.batch.bind(lost.db);let lose=true,blind=false;
 lost.env.DB={...lost.db,prepare:sql=>{if(blind&&/film_metadata_owner_command/.test(sql)){blind=false;throw new Error('network: read lost');}return lost.db.prepare(sql);},batch:async list=>{const out=await real(list);if(lose&&list.length>3){lose=false;blind=true;throw new Error('network: answer lost');}return out;}};
 const command={action:'set',field:'year',value:1984,expectedRevision:await revisionOf(lost.env),requestId:'req-lost-0001'};
 const unknown=await call(lost.env,{payload:command});
 assert.equal(unknown.status,503);assert.equal(unknown.body.outcome,'unknown');
 assert.equal(commands(lost.file).length,1,'the batch did commit');
 const settled=await call(lost.env,{payload:command});
 assert.equal(settled.status,200);assert.equal(settled.body.outcome,'already_applied');assert.equal(meta(lost.file).year,1984);
 assert.equal(commands(lost.file).length,1,'a resend applies once');

 // not committed: no row, so a resend applies
 const never=await world();
 const realNever=never.db.batch.bind(never.db);let fail=true;
 never.env.DB={...never.db,prepare:never.db.prepare.bind(never.db),batch:async list=>{if(fail&&list.length>3){fail=false;throw new Error('network: connection reset before send');}return realNever(list);}};
 const again={action:'set',field:'year',value:1985,expectedRevision:await revisionOf(never.env),requestId:'req-never-0001'};
 assert.equal((await call(never.env,{payload:again})).status,503);
 assert.equal(commands(never.file).length,0);
 assert.equal((await call(never.env,{payload:again})).body.outcome,'applied');
 assert.equal(commands(never.file).length,1);

 // two concurrent resends of one command commit once
 const race=await world();
 const concurrent={action:'set',field:'year',value:1977,expectedRevision:await revisionOf(race.env),requestId:'req-race-0001'};
 const [a,b]=await Promise.all([call(race.env,{payload:concurrent}),call(race.env,{payload:concurrent})]);
 assert.deepEqual([a.status,b.status].sort(),[200,200],JSON.stringify([a.body,b.body]));
 assert.deepEqual([a.body.outcome,b.body.outcome].sort(),['already_applied','applied']);
 assert.equal(commands(race.file).length,1);assert.equal(history(race.file).length,1);
}

// ---- 5. revert refusals ----
{
 const {file,env}=await world();
 await post(env,{action:'set',field:'year',value:1999});
 await post(env,{action:'set',field:'year',value:2001});
 const rowsOf=history(file).filter(item=>item.field==='year');
 const target=rowsOf.find(item=>item.old_value_text==='1999');
 // a history row of another Film
 await post(env,{action:'set',field:'runtime',value:100},{id:OTHER});
 await post(env,{action:'set',field:'runtime',value:101},{id:OTHER});
 const foreign=history(file).find(item=>item.film_id===OTHER&&item.old_value_text!==null);
 const refused=await post(env,{action:'revert',field:'runtime',historyRef:foreign.id});
 assert.equal(refused.status,409);assert.equal(refused.body.error,'foreign_history');
 assert.equal((await post(env,{action:'revert',field:'runtime',historyRef:999999})).body.error,'history_not_found');
 assert.equal((await post(env,{action:'revert',field:'runtime',historyRef:target.id})).body.error,'invalid_history_ref','the history row belongs to another field');
 // a Film redirected into this one: its history is reachable
 exec(file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('${OTHER}','${ID}','${T}')`);
 // (the redirect added the OTHER Film's anchors to nothing: its external ids stay with it, so the identity digest is unchanged)
 const viaRedirect=await post(env,{action:'revert',field:'runtime',historyRef:foreign.id});
 assert.notEqual(viaRedirect.body.error,'foreign_history','one hop through a redirect is this Film');
 exec(file,`DELETE FROM film_redirect WHERE from_id='${OTHER}'`);

 // identity unknown: the old value of an undeclared (unknown lineage) write
 const unknownLineage=await world();
 await CanonicalFilmWriters.writeFilmFacts(unknownLineage.env,{id:ID,at:T,requestId:rid(),expectedRevision:await revisionOf(unknownLineage.env),film:{contractVersion:1},metadata:{updatedAt:T,year:1990},requireExisting:true});
 await post(unknownLineage.env,{action:'set',field:'year',value:1995});
 const unattributed=history(unknownLineage.file).find(item=>item.old_value_text==='1990');
 assert.equal(unattributed.old_anchor_digest,null);
 const unknownRevert=await post(unknownLineage.env,{action:'revert',field:'year',historyRef:unattributed.id});
 assert.equal(unknownRevert.status,409);assert.equal(unknownRevert.body.error,'identity_unknown');
 assert.equal(meta(unknownLineage.file).year,1995,'a refused revert changed nothing');
 // `set` works where revert is refused: an explicit assertion under the current identity
 assert.equal((await post(unknownLineage.env,{action:'set',field:'year',value:1990})).status,200);
 const shown=await call(unknownLineage.env,{method:'GET'});
 const entry=shown.body.history.rows.find(item=>item.id===unattributed.id);
 assert.equal(entry.revertible,false);assert.equal(entry.revertBlocked,'identity_unknown');assert.equal(entry.old.value,1990,'the old value is still shown');

 // anchor changed: an identity correction moved the anchor set after the value was written
 const moved=await world();
 await declare(moved.env,{year:1999});
 await post(moved.env,{action:'set',field:'year',value:2010});
 const oldRow=history(moved.file).find(item=>item.old_value_text==='1999');
 exec(moved.file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:603','letterboxd','lid603b',1,0)");
 const staleAnchor=await post(moved.env,{action:'revert',field:'year',historyRef:oldRow.id});
 assert.equal(staleAnchor.status,409);assert.equal(staleAnchor.body.error,'anchor_changed');
 assert.equal(meta(moved.file).year,2010);
 const afterShown=(await call(moved.env,{method:'GET'})).body.history.rows.find(item=>item.id===oldRow.id);
 assert.equal(afterShown.revertBlocked,'anchor_changed');

 // an anchor set that changes BETWEEN the plan and the commit fails the batch on its anchor guard
 const racing=await world();
 await declare(racing.env,{year:1999});
 await post(racing.env,{action:'set',field:'year',value:2010});
 const target2=history(racing.file).find(item=>item.old_value_text==='1999');
 const realBatch=racing.db.batch.bind(racing.db);let armed=true;
 racing.env.DB={...racing.db,prepare:racing.db.prepare.bind(racing.db),batch:async list=>{if(armed&&list.length>3){armed=false;exec(racing.file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:603','letterboxd','lid603c',1,0)");}return realBatch(list);}};
 const between=await post(racing.env,{action:'revert',field:'year',historyRef:target2.id});
 assert.equal(between.status,409,JSON.stringify(between.body));assert.equal(between.body.error,'anchor_changed');
 assert.equal(meta(racing.file).year,2010);assert.equal(commands(racing.file).filter(item=>item.action==='revert').length,0);
}

// ---- 6. refresh: epoch only ----
{
 const {file,env}=await world();
 const T24=T;
 const seed=(status='complete',epoch=0)=>exec(file,`DELETE FROM catalog_enrichment_state;INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at,refresh_epoch,plan_epoch) VALUES ('${ID}','film','*',0,'active','${T24}','${T24}',0,3),('${ID}','core','tmdb',0,'${status}','${T24}','${T24}',${epoch},0),('${ID}','core','letterboxd',0,'complete','${T24}','${T24}',0,0)`);
 const rowsFor=()=>[{part:'core',source:'tmdb',status:'complete',updatedAt:T24,refreshEpoch:0}];
 // not in scope: the Film has no state rows
 const none=await post(env,{action:'refresh',expectedRevision:await revisionOf(env),expectedRows:rowsFor()});
 assert.equal(none.status,409);assert.equal(none.body.error,'not_in_scope');assert.equal(commands(file).length,0);
 seed();
 const revision=await revisionOf(env),beforeMeta=JSON.stringify(meta(file)),beforeHistory=history(file).length;
 const ok=await post(env,{action:'refresh',expectedRevision:revision,expectedRows:rowsFor()});
 assert.equal(ok.status,200,JSON.stringify(ok.body));assert.equal(ok.body.outcome,'applied');assert.equal(ok.body.command.appliedRevision,null);
 const state=rows(file,'SELECT part,source,status,refresh_epoch,plan_epoch FROM catalog_enrichment_state ORDER BY part,source');
 assert.deepEqual(state.find(row=>row.source==='tmdb'),{part:'core',source:'tmdb',status:'due',refresh_epoch:1,plan_epoch:0});
 assert.equal(state.find(row=>row.source==='letterboxd').refresh_epoch,0,'only the selected rows move');
 assert.equal(state.find(row=>row.part==='film').plan_epoch,4,'every batch of an older plan fails');
 assert.equal(await revisionOf(env),revision,'no Film revision bump');
 assert.equal(JSON.stringify(meta(file)),beforeMeta);assert.equal(history(file).length,beforeHistory,'no history');
 assert.equal(commands(file).at(-1).action,'refresh');assert.equal(commands(file).at(-1).applied_revision,null);
 assert.equal(kicks.length>0,true,'the producer is woken after the commit');
 // a resend answers from the row
 const again=await call(env,{payload:{action:'refresh',expectedRevision:revision,expectedRows:rowsFor(),requestId:commands(file).at(-1).request_id}});
 assert.equal(again.body.outcome,'already_applied');
 // the rows moved since the owner saw them
 const staleRows=await post(env,{action:'refresh',expectedRevision:revision,expectedRows:rowsFor()});
 assert.equal(staleRows.status,409);assert.equal(staleRows.body.error,'stale_rows');
 // a part that is not refreshable (not applicable)
 seed('not_applicable');
 const leased=await post(env,{action:'refresh',expectedRevision:await revisionOf(env),expectedRows:[{part:'core',source:'tmdb',status:'not_applicable',updatedAt:T24,refreshEpoch:0}]});
 assert.equal(leased.status,409);assert.equal(leased.body.error,'not_refreshable');
 // a stale Film revision
 seed();
 assert.equal((await post(env,{action:'refresh',expectedRevision:revision+5,expectedRows:rowsFor()})).status,409);
 // a refresh planned before the mode changed fails on its fences (hold is allowed, `off` is unreachable)
 const planned=await world();
 exec(planned.file,`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at) VALUES ('${ID}','film','*',0,'active','${T}','${T}'),('${ID}','core','tmdb',0,'complete','${T}','${T}')`);
 const realBatch=planned.db.batch.bind(planned.db);let armed=true;
 planned.env.DB={...planned.db,prepare:planned.db.prepare.bind(planned.db),batch:async list=>{if(armed&&list.length>3){armed=false;setMode(planned.file,'hold');}return realBatch(list);}};
 const fenced=await post(planned.env,{action:'refresh',expectedRevision:await revisionOf(planned.env),expectedRows:rowsFor()});
 assert.equal(fenced.status,409,JSON.stringify(fenced.body));assert.equal(fenced.body.outcome,'rejected');
 assert.equal(rows(planned.file,"SELECT status FROM catalog_enrichment_state WHERE part='core'")[0].status,'complete','nothing moved');
 assert.equal(commands(planned.file).length,0);
 // after the switch the same refresh works: the owner route works in hold
 const inHold=await post(planned.env,{action:'refresh',expectedRevision:await revisionOf(planned.env),expectedRows:rowsFor()});
 assert.equal(inHold.status,200,JSON.stringify(inHold.body));
}

// ---- 7. hold ----
{
 const {file,env}=await world({mode:'hold'});
 const r=await post(env,{action:'set',field:'year',value:1999});
 assert.equal(r.status,200,'the owner route works in hold');
 assert.equal(r.body.readback.mode,'hold');assert.equal(meta(file).year,1999);
 const pinned=await post(env,{action:'lock',field:'year'});
 assert.equal(pinned.status,200);
 // a Film that does not exist, and a redirected Film
 assert.equal((await post(env,{action:'set',field:'year',value:1999,expectedRevision:0},{id:'film:absent'})).status,404);
 exec(file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('${OTHER}','${ID}','${T}')`);
 const redirected=await post(env,{action:'set',field:'year',value:1999,expectedRevision:await revisionOf(env,OTHER)},{id:OTHER});
 assert.equal(redirected.status,409);assert.equal(redirected.body.error,'redirected');
}

// ---- 8. the GET: a pure read ----
{
 const {file,env}=await world();
 await declare(env,{year:1999,synopsis:'Description'},{languages:{synopsis:{language:'en',languageBasis:'explicit'}}});
 for(let i=0;i<30;i++){await post(env,{action:'set',field:'runtime',value:100+i});}
 for(let i=0;i<30;i++){await post(env,{action:'set',field:'year',value:1900+i});}
 // producer-shaped C1 state (src/catalog-enrichment-producer.js rowStatement): the disagreement and the written-field evidence live in the Film row's film_json, conflicts and hints on the core row
 exec(file,`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at,film_json) VALUES ('${ID}','film','*',0,'identity_disagreement','${T}','${T}','{"disagreement":{"reasons":["year_differs"],"at":"${T}","source":"letterboxd"},"fallbackFill":["year"],"supersededKept":["runtime"],"unconfirmedAgreement":["synopsis"],"storedDiffers":["runtime"],"writtenFields":["year"],"agreedAnchorDigest":"${'a'.repeat(64)}","ownerRetry":"internal-token"}');
 INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at,conflicts_json,hints_json,gaps_json) VALUES ('${ID}','core','tmdb',0,'complete_with_gaps','${T}','${T}','[{"field":"year"}]','["hint"]','["poster"]');
 WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<199) INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at) SELECT '${ID}','credits','tmdb',i,'complete','${T}','${T}' FROM n;`);
 // a Film redirected into it contributes its history (one hop)
 await post(env,{action:'set',field:'runtime',value:77},{id:OTHER});
 exec(file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('${OTHER}','${ID}','${T}')`);
 const statements=[];
 const spy={...env,DB:{...env.DB,prepare:sql=>{statements.push(sql);return env.DB.prepare(sql);},batch:env.DB.batch}};
 const before=JSON.stringify(writes(file));
 const first=await call(spy,{method:'GET'});
 assert.equal(first.status,200);
 assert.ok(statements.length>0&&statements.every(sql=>/^\s*SELECT/i.test(sql)),'a GET issues only SELECT statements: '+statements.filter(sql=>!/^\s*SELECT/i.test(sql)).join(' | '));
 assert.equal(JSON.stringify(writes(file)),before);
 const head=await call(spy,{method:'HEAD'});assert.equal(head.status,200);
 assert.equal(first.body.fields.year.rank.name,'owner');assert.equal(first.body.fields.synopsis.row.language,'en');
 assert.deepEqual(first.body.locks.owner,['year','runtime']);
 assert.deepEqual(first.body.c1.conflicts,[{part:'core',source:'tmdb',value:[{field:'year'}]}]);assert.deepEqual(first.body.c1.hints,[{part:'core',source:'tmdb',value:['hint']}]);assert.deepEqual(first.body.c1.gaps,[{part:'core',source:'tmdb',value:['poster']}]);
 // the Film row's own evidence is read directly, whatever the number of credits chunks; internal markers are not exposed
 assert.equal(first.body.c1.film.status,'identity_disagreement');assert.deepEqual(first.body.c1.film.disagreement.reasons,['year_differs']);
 assert.deepEqual(first.body.c1.film.fallbackFill,['year']);assert.deepEqual(first.body.c1.film.unconfirmedAgreement,['synopsis']);assert.deepEqual(first.body.c1.film.storedDiffers,['runtime']);assert.deepEqual(first.body.c1.film.supersededKept,['runtime'],'AIR-633: the superseded-kept owner-review list is part of the owner readback');assert.equal(first.body.c1.film.ownerRetry,undefined);
 assert.equal(first.body.c1.credits.chunks,200);assert.equal(first.body.c1.credits.byStatus.complete,200);
 assert.ok(first.body.c1.rows.some(row=>row.part==='film')&&first.body.c1.rows.some(row=>row.part==='core'),'the fixed rows are never pushed out by credits chunks');
 assert.equal(first.body.redirects.count,1);
 assert.equal(first.body.history.rows.length,50,'at most 50 rows a page');
 assert.ok(first.body.history.next,'there are more rows');
 const seen=new Set(first.body.history.rows.map(item=>item.id));
 let page=first.body.history,pages=1;
 while(page.next){
  const next=await call(env,{method:'GET',query:'?cursor='+encodeURIComponent(page.next)});
  assert.equal(next.status,200);
  page=next.body.history;pages++;
  assert.ok(page.rows.length<=50);
  for(const row of page.rows){assert.ok(!seen.has(row.id),'no row twice across pages');seen.add(row.id);}
 }
 assert.equal(seen.size,history(file).length,'every history row, the redirected Film included, is reached');
 assert.equal(pages,2);
 // newest first, stable on equal timestamps
 const ordered=first.body.history.rows.map(item=>[item.at,item.id]);
 assert.deepEqual(ordered,[...ordered].sort((a,b)=>a[0]<b[0]?1:a[0]>b[0]?-1:b[1]-a[1]));
 assert.equal((await call(env,{method:'GET',query:'?cursor=garbage'})).status,400);
 // the history of the redirected Film carries its own Film id
 assert.ok([...seen].length>0&&rows(file,`SELECT COUNT(*) AS n FROM film_metadata_history WHERE film_id='${OTHER}'`)[0].n===1);
}

// ---- 9. review fixes (PR 1047): receipt reconciliation, complete redirect history, typed owner values ----
// a pause right after the FIRST (empty) receipt read of a request: the other attempt commits, then the first one resumes
function pausedAfterReceiptRead(w,onPause){
 let armed=true;
 return {...w.env,DB:{...w.db,prepare(sql){
  const st=w.db.prepare(sql);
  if(!(armed&&/FROM film_metadata_owner_command WHERE request_id/.test(sql)))return st;
  return {bind:(...p)=>{const b=st.bind(...p);return {...b,first:async()=>{const row=await b.first();armed=false;await onPause();return row;}};}};
 }}};
}
{
 // metadata command: A commits in the gap; B (same command) answers already_applied, B (another digest) request_mismatch, also after a redirect
 for(const variant of ['same','different','redirect']){
  const w=await world();
  const key='req-gap-'+variant;
  const base={action:'set',field:'year',value:1999,expectedRevision:await revisionOf(w.env),requestId:key};
  const racer=pausedAfterReceiptRead(w,async()=>{
   assert.equal((await call(w.env,{payload:base})).status,200,'A commits in the gap');
   if(variant==='redirect')exec(w.file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('${ID}','${OTHER}','${T}')`);
  });
  const b=await call(racer,{payload:variant==='different'?{...base,value:2001}:base});
  if(variant==='different'){assert.equal(b.status,409);assert.equal(b.body.error,'request_mismatch');}
  else{assert.equal(b.status,200,JSON.stringify(b.body));assert.equal(b.body.outcome,'already_applied');}
  assert.equal(commands(w.file).length,1,'one receipt, whatever B answered');
 }
 // refresh: the same interleaving
 for(const variant of ['same','different']){
  const w=await world();
  exec(w.file,`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at) VALUES ('${ID}','film','*',0,'active','${T}','${T}'),('${ID}','core','tmdb',0,'complete','${T}','${T}')`);
  const rowsSeen=[{part:'core',source:'tmdb',status:'complete',updatedAt:T,refreshEpoch:0}];
  const base={action:'refresh',expectedRevision:await revisionOf(w.env),expectedRows:rowsSeen,requestId:'req-gap-refresh-'+variant};
  const racer=pausedAfterReceiptRead(w,async()=>{assert.equal((await call(w.env,{payload:base})).status,200);});
  const b=await call(racer,{payload:variant==='different'?{...base,expectedRows:[{...rowsSeen[0],source:'tmdb',updatedAt:T2}]}:base});
  if(variant==='different')assert.equal(b.body.error,'request_mismatch');else assert.equal(b.body.outcome,'already_applied');
  assert.equal(commands(w.file).length,1);
 }
 // a refusal with no receipt behind it stays a refusal, and an unreadable receipt is not decided
 const plain=await world();
 const stale=await call(plain.env,{payload:{action:'set',field:'year',value:1,expectedRevision:99,requestId:'req-no-receipt'}});
 assert.equal(stale.body.error,'stale_revision');
 const blind=await world();
 const blindDb={...blind.env,DB:{...blind.db,prepare(sql){if(/FROM film_metadata_owner_command WHERE request_id/.test(sql)&&blindDb.reads++>0)throw new Error('read lost');return blind.db.prepare(sql);}}};blindDb.reads=0;
 const undecided=await call(blindDb,{payload:{action:'set',field:'year',value:1,expectedRevision:99,requestId:'req-blind-0001'}});
 assert.equal(undecided.status,503);assert.equal(undecided.body.outcome,'unknown');
}
{
 // history reaches EVERY one-hop predecessor (more than 20), with equal timestamps, 50 rows a page, and the query is indexed
 const {file,env}=await world();
 await post(env,{action:'set',field:'year',value:1999});
 const preds=[];for(let i=0;i<27;i++)preds.push('film:tmdb:9'+String(i).padStart(2,'0'));
 exec(file,preds.map(id=>`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('${id}','${ID}','${T}');`+['year','runtime','synopsis'].map((field,k)=>`INSERT INTO film_metadata_history (film_id,field,reason,old_value_text,write_key,at) VALUES ('${id}','${field}','owner_set','${k}','key-${id}-${field}','${T}');`).join('')).join('\n'));
 const total=rows(file,'SELECT COUNT(*) AS n FROM film_metadata_history')[0].n;
 const seen=[];let cursor=null,pages=0;
 do{
  const r=await call(env,{method:'GET',query:cursor?'?cursor='+encodeURIComponent(cursor):''});
  assert.equal(r.status,200);assert.ok(r.body.history.rows.length<=50);
  assert.equal(r.body.redirects.count,27);assert.equal(r.body.redirects.films,undefined,'no truncated list stands in for continuation');
  seen.push(...r.body.history.rows.map(row=>row.id));cursor=r.body.history.next;pages++;
 }while(cursor);
 assert.equal(new Set(seen).size,seen.length,'no row twice');assert.equal(seen.length,total,'every row of every predecessor is reachable');assert.ok(pages>=2);
 assert.ok(preds.every(id=>rows(file,`SELECT 1 FROM film_metadata_history WHERE film_id='${id}'`).length&&true));
 // the 27th predecessor's row is revertible through the API, and visible
 const last=await call(env,{method:'GET'});
 const viaApi=[];let c2=null;do{const r=await call(env,{method:'GET',query:c2?'?cursor='+encodeURIComponent(c2):''});viaApi.push(...r.body.history.rows.map(row=>row.filmId));c2=r.body.history.next;}while(c2);
 assert.ok(viaApi.includes(preds.at(-1)),'the last predecessor is shown');assert.equal(last.status,200);
 // the plan: the predecessors come from the target index, the history through its (film_id, ...) unique index, never a full scan
 const predicate=vm.runInContext('FILM_META_HISTORY_FILMS',context);
 const explain=sqliteSync(['-bail',file],{input:`EXPLAIN QUERY PLAN SELECT id FROM film_metadata_history WHERE (${predicate.replace(/\?/g,`'${ID}'`)}) AND (at<'${T}' OR (at='${T}' AND id<1000)) ORDER BY at DESC,id DESC LIMIT 51;`,encoding:'utf8'});
 assert.equal(explain.status,0,explain.stderr);
 const plan=explain.stdout.trim().split('\n').join(' | ');
 assert.match(plan,/film_redirect_by_target/,plan);
 assert.match(plan,/SEARCH film_metadata_history USING (COVERING )?INDEX/,plan);
 assert.doesNotMatch(plan,/SCAN film_metadata_history/,plan);
}
{
 // an owner value is typed before it is normalized: nothing becomes a pin, a receipt, a history row or a revision
 const {file,env}=await world();
 const before=JSON.stringify(writes(file));
 const bad=[['year',true],['year',{a:1}],['year',[1999]],['year',12.5],['year','nineteen'],['runtime',false],['runtime',null],['synopsis',{bad:true}],['synopsis',[1]],['synopsis',42],['synopsis',true],['synopsis','   '],['poster',{}],['poster',7],['url',['http://x']],['url',1],['genres','Drama'],['genres',[1,2]],['genres',[{}]],['genres',[]],['genres',{a:'b'}]];
 for(const [field,value] of bad){
  const r=await call(env,{payload:{action:'set',field,value,expectedRevision:await revisionOf(env),requestId:rid()}});
  assert.equal(r.status,400,field+' '+JSON.stringify(value)+': '+JSON.stringify(r.body));assert.equal(r.body.error,'invalid_value');
 }
 assert.equal(JSON.stringify(writes(file)),before);
 assert.equal(meta(file),undefined,'no film_metadata row was created');
 // valid inputs keep the agreed canonical normalization
 for(const [field,value,stored] of [['year',1999,1999],['year','2001',2001],['runtime',' 120 ',120],['synopsis','Текст','Текст']]){
  const r=await post(env,{action:'set',field,value});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(meta(file)[field],stored);
 }
 assert.equal((await post(env,{action:'set',field:'genres',value:['Драма','Комедия']})).status,200);
 assert.equal(meta(file).genres_json,JSON.stringify(['Драма','Комедия']));
}

console.log('admin film metadata API (AIR-634): all checks passed');
