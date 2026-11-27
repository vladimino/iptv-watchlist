// AIR-684 (C3c-D): the Discovery scope of the Catalog Enrichment Producer through the REAL writers on the real migrated schema (local sqlite stand-ins; no network, nothing applied anywhere).
//  A. `replaceCatalog`: the resolver publication declares `context.admission` and its commit settles the staged signals; an import (no admission), a mismatched run and a stale origin never promote; a retry settles by identity.
//  B. `upsertAdmissions` (the steady path): nothing before the first activation, one signal after, a TV row never, a repeat upsert none; the causal wake runs after the commit and never inside it.
//  C. the Discovery `source_changed` emitter: only for a Film with a retained Discovery membership, per-part digests with parity to the producer's own source version, first sight is a baseline, a changed digest re-arms once.
//  D. the activation preflight (read-only): schema not applied, a loading transfer and a stale staged signal each refuse; a clean database passes.
import assert from 'node:assert/strict';
import * as Authority from '../src/discovery-authority.js';
import * as D from '../src/catalog-enrichment-discovery.js';
import * as S from '../src/catalog-enrichment-store.js';
import {parseTmdb} from '../src/catalog-enrichment-sources.js';
import {Plan} from '../src/catalog-enrichment-plan.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {migrated,sql} from './prediction-d1-flow-lib.mjs';

const RUN='run-684';
const T='2026-11-27T10:00:00.000Z';
const obs=key=>({key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[100],shows:[{channelId:'c',channel:'C',start:Date.now()+3600000,end:Date.now()+3700000}],seenInLatestSnapshot:true,lastAiring:Date.now()+3600000});
const film=(tmdb,extra={})=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Film '+tmdb,...extra});
const tv=tmdb=>({id:'tmdb_tv_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb_tv:'+tmdb,title:'Show '+tmdb,mediaType:'tv'});
async function setup({schema=Infinity,activate=false}={}){
 const file=migrated(schema);
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 // The lease row is written directly: the EPG-priority pause of the day (ADR 0135) is not what these tests are about.
 const lease={id:'lease-684',expiresAt:Date.now()+3600000};
 sql(file,`UPDATE discovery_lease SET lease_id='${lease.id}', expires_at=${lease.expiresAt}, programme_run_id=NULL WHERE id=1`);
 env.discoveryLease=lease;
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease,items:(async function*(){yield obs('obs-a');})()});
 if(activate)sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('discovery',1,1,'${T}',1,'${T}')`);
 return {file,env,lease};
}
const sig=file=>sql(file,"SELECT subject,state,version,cause_ref FROM enrichment_signal WHERE kind='admitted' AND source='discovery' ORDER BY subject").map(r=>r.subject+'='+r.state+'@v'+r.version);
const transfer=file=>sql(file,'SELECT state,programme_run_id,origin,origin_batches,batches FROM discovery_transfer')[0];
const catalog=(...ids)=>Object.fromEntries(ids.map(id=>['tmdb_'+id,film(id)]));

// ---- A. replaceCatalog ----
{
 // A1. the resolver publication after the activation: new movies are stream; a TV row with a movie id is never signalled; the origin does not survive the commit
 const {file,env}=await setup({activate:true});
 const gate=await Authority.readAuthority(env);assert.equal(gate.programmeRunId,RUN);
 await Authority.replaceCatalog(env,{...catalog(1,2),tmdb_tv_2:tv(2)},{admission:{origin:'resolver',programmeRunId:RUN}});
 assert.deepEqual(sig(file),['tmdb:1=pending@v2','tmdb:2=pending@v2'],'a successful resolver publication admits each genuinely new movie once');
 assert.deepEqual([transfer(file).state,transfer(file).origin,transfer(file).origin_batches],['committed',null,null]);
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='staged'")[0].n,0);
 // A2. a later publication of the same catalog (repeat, retry of the same run) creates no second signal and re-arms nothing
 await Authority.replaceCatalog(env,{...catalog(1,2,3)},{admission:{origin:'resolver',programmeRunId:RUN}});
 assert.deepEqual(sig(file),['tmdb:1=pending@v2','tmdb:2=pending@v2','tmdb:3=pending@v2'],'only the new Film is added; the existing rows are upserts and emit nothing');
 // A3. a later steady upsert of an existing Film creates none
 await Authority.upsertAdmissions(env,{tmdb_3:film(3,{title:'Renamed'})});
 assert.deepEqual(sig(file),['tmdb:1=pending@v2','tmdb:2=pending@v2','tmdb:3=pending@v2']);
}
{
 // A4. an import or restore: no `context.admission` (the same call without it), a run that is not the gate's, and an origin that is not `resolver` are all non-authoritative; nothing is promoted
 for(const [name,context] of [['no admission',{}],['another run',{admission:{origin:'resolver',programmeRunId:'run-other'}}],['not a resolver',{admission:{origin:'import',programmeRunId:RUN}}],['no run',{admission:{origin:'resolver'}}]]){
  const {file,env}=await setup({activate:true});
  await Authority.replaceCatalog(env,catalog(7),context);
  assert.deepEqual(sig(file),[],name+': non-authoritative, its staged signal is deleted at the commit');
  assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_admission WHERE tmdb_id='7'")[0].n,1,name+': the catalog itself is written as before');
 }
 // A5. before the activation a resolver publication is history: nothing is signalled, and the next one after the activation is stream
 const {file,env}=await setup();
 await Authority.replaceCatalog(env,catalog(8),{admission:{origin:'resolver',programmeRunId:RUN}});
 assert.deepEqual(sig(file),[],'published before the activation: history');
 sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('discovery',1,1,'${T}',1,'${T}')`);
 await Authority.replaceCatalog(env,catalog(8,9),{admission:{origin:'resolver',programmeRunId:RUN}});
 assert.deepEqual(sig(file),['tmdb:9=pending@v2'],'published after the activation: stream; the historical row updated by a transfer emits nothing');
}
{
 // A6. a failed transfer leaves its staged signals inert: the loading is left open by a failed flush, the retry settles by identity
 const {file,env}=await setup({activate:true});
 let failOnce=true;
 const real=env.DB.batch.bind(env.DB);
 env.DB={...env.DB,prepare:env.DB.prepare.bind(env.DB),batch:async statements=>{
  if(failOnce&&statements.some(s=>/UPDATE discovery_transfer SET state='committed'/.test(s.text||s.sql||''))){failOnce=false;throw new Error('D1 unavailable');}
  return real(statements);
 }};
 await assert.rejects(()=>Authority.replaceCatalog(env,catalog(30),{admission:{origin:'resolver',programmeRunId:RUN}}));
 assert.deepEqual(sig(file),['tmdb:30=staged@v1'],'an interrupted resolver transfer: the signal is staged, inert and not consumable');
 assert.equal(transfer(file).state,'loading');
 assert.deepEqual(await S.runnableSignals({DB:d1Standin(file)},{now:'2026-11-27T11:00:00.000Z'}),[],'a staged signal is never runnable');
}

// ---- B. the steady path and the causal wake ----
{
 const {file,env}=await setup();
 const calls=[];
 globalThis.CatalogEnrichmentRunner={hasRunnable:async()=>{calls.push('has:'+sig(file).join(','));return true;},kick:async()=>{calls.push('kick');}};
 try{
  await Authority.upsertAdmissions(env,{tmdb_41:film(41)});
  assert.deepEqual(sig(file),[],'before the first activation the steady path records nothing');
  sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('discovery',1,1,'${T}',1,'${T}')`);
  calls.length=0;
  await Authority.upsertAdmissions(env,{tmdb_42:film(42),tmdb_tv_43:tv(43)});
  assert.deepEqual(sig(file),['tmdb:42=pending@v1'],'one signal for a genuinely new movie, none for a TV row');
  assert.deepEqual(calls,['has:tmdb:42=pending@v1','kick'],'the wake runs AFTER the commit (the signal is already visible) and kicks once');
  await Authority.upsertAdmissions(env,{tmdb_42:film(42,{title:'Again'})});
  assert.deepEqual(sig(file),['tmdb:42=pending@v1'],'a repeat upsert creates no second signal');
  // a throwing wake never fails the write
  globalThis.CatalogEnrichmentRunner={hasRunnable:async()=>{throw new Error('boom');},kick:async()=>{}};
  assert.deepEqual((await Authority.upsertAdmissions(env,{tmdb_44:film(44)})).written,['tmdb_44']);
  // a disabled scope keeps recording (the gate is `activated`)
  sql(file,"UPDATE catalog_enrichment_scope SET enabled=0, revision=2 WHERE scope='discovery'");
  await Authority.upsertAdmissions(env,{tmdb_45:film(45)});
  assert.ok(sig(file).includes('tmdb:45=pending@v1'));
 }finally{delete globalThis.CatalogEnrichmentRunner;}
 // an old Worker (no runner global) writes exactly the same signals and calls nothing
 await Authority.upsertAdmissions(env,{tmdb_46:film(46)});
 assert.ok(sig(file).includes('tmdb:46=pending@v1'));
}
{
 // B2. before schema 48 the code is the former code: no origin column, the same writes, no signal
 const {file,env}=await setup({schema:48,activate:true});
 await Authority.replaceCatalog(env,catalog(50),{admission:{origin:'resolver',programmeRunId:RUN}});
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_admission WHERE tmdb_id='50'")[0].n,1);
 assert.deepEqual(sig(file),[],'schema 48: deploying the code before the migration changes nothing');
 assert.equal(sql(file,'SELECT version FROM schema_contract')[0].version,48);
}

// ---- C. the source_changed emitter ----
const movie=(over={})=>({id:603,release_date:'1999-03-30',runtime:136,overview:'ru synopsis',poster_path:'/p.jpg',genres:[{name:'Боевик'}],credits:{cast:[{id:11,name:'A',order:0},{id:13,name:'B',order:1}],crew:[{id:12,name:'D',job:'Director'}]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица'}}]},...over});
{
 const digests=await D.tmdbPartDigests(movie(),603);
 assert.ok(['core','credits','localization'].every(part=>/^[0-9a-f]{64}$/.test(digests[part])));
 assert.equal(await D.tmdbPartDigests(movie({id:604}),603),null,'a document of another movie is not read');
 assert.equal(await D.tmdbPartDigests(movie(),'abc'),null);
 // parity: the localization digest IS the producer's source version for the same response; the core digest ignores what the request language changes
 const parsed=parseTmdb(movie(),'603');
 assert.equal(digests.localization,await Plan.digestOf({source:'tmdb',anchor:'603',title:parsed.title.value}),'digest parity with the producer for the localization part');
 const other=await D.tmdbPartDigests(movie({overview:'en synopsis',poster_path:'/q.jpg',genres:[{name:'Action'}]}),603);
 assert.equal(other.core,digests.core,'a synopsis, genre or poster of another request language is not a change');
 assert.notEqual((await D.tmdbPartDigests(movie({runtime:137}),603)).core,digests.core,'a runtime change is');
 assert.notEqual((await D.tmdbPartDigests(movie({credits:{cast:[{id:11,name:'A',order:0}],crew:[]}}),603)).credits,digests.credits,'a changed credit set is');
 assert.notEqual((await D.tmdbPartDigests(movie({credits:undefined}),603)).credits,digests.credits,'an unreadable credits section is not "no credits"');
 assert.notEqual((await D.tmdbPartDigests(movie({translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Другая'}}]}}),603)).localization,digests.localization);
}
{
 const {file,env}=await setup({activate:true});
 const db=env.DB;
 const FILM='film:tmdb:603';
 sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${FILM}',2,NULL,'M','${T}');INSERT INTO film_external_id VALUES ('${FILM}','tmdb','603',1,0,NULL)`);
 const changed=()=>sql(file,"SELECT part,state,version,acked_version FROM enrichment_signal WHERE kind='source_changed' ORDER BY part");
 // no retained membership: nothing is written
 assert.deepEqual(await D.emitSourceChanged(env,{tmdbId:'603',movie:movie(),at:T}),{emitted:false});
 assert.deepEqual(changed(),[],'a Film with no Discovery membership has no signal');
 sql(file,`INSERT INTO catalog_enrichment_member (film_id,scope,admitted_at,signal_key) VALUES ('${FILM}','discovery','${T}','k')`);
 assert.equal((await D.emitSourceChanged(env,{tmdbId:'603',movie:movie(),at:T})).emitted,true);
 assert.deepEqual(changed(),[{part:'core',state:'consumed',version:1,acked_version:1},{part:'credits',state:'consumed',version:1,acked_version:1},{part:'localization',state:'pending',version:1,acked_version:0}],
  'first sight: core and credits are a consumed baseline (not a change); localization is pending and dropped by the producer without a fetch when the applied source version equals the digest');
 // an identical observation writes nothing
 assert.equal((await D.emitSourceChanged(env,{tmdbId:'603',movie:movie(),at:T})).emitted,false,'an identical digest writes and wakes nothing');
 assert.deepEqual(changed().map(r=>r.version),[1,1,1]);
 // a real change re-arms exactly the changed part
 assert.equal((await D.emitSourceChanged(env,{tmdbId:'603',movie:movie({credits:{cast:[{id:11,name:'A',order:0}],crew:[]}}),at:T})).emitted,true);
 assert.deepEqual(changed(),[{part:'core',state:'consumed',version:1,acked_version:1},{part:'credits',state:'pending',version:2,acked_version:1},{part:'localization',state:'pending',version:1,acked_version:0}]);
 // a redirected or conflicting identity, and another movie, write nothing
 assert.deepEqual(await D.emitSourceChanged(env,{tmdbId:'603',movie:movie({id:999}),at:T}),{emitted:false,reason:'not_this_movie'});
 // a pending credits signal is runnable (the member exists) and the producer's consume reopens the part
 assert.deepEqual((await S.runnableSignals(env,{now:'2026-11-27T11:00:00.000Z'})).filter(s=>s.kind==='source_changed').map(s=>s.part),['credits','localization']);
 // before the apply (schema 46) the emitter ends quietly
 const old=await setup({schema:46});
 assert.deepEqual(await D.emitSourceChanged(old.env,{tmdbId:'603',movie:movie(),at:T}),{emitted:false,reason:'schema_absent'});
}

// ---- D. the activation preflight ----
{
 const {file,env}=await setup({schema:48});
 const before=sql(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n;
 const old=await D.activationPreflight(env);
 assert.deepEqual([old.ok,old.problems],[false,['schema_not_applied']],'schema 48: the settlement is not deployed');
 const clean=await setup();
 const ok=await D.activationPreflight(clean.env);
 assert.deepEqual([ok.ok,ok.problems],[true,[]]);
 assert.deepEqual(ok.facts.triggers.length,4);assert.equal(ok.facts.scope,null);
 // a transfer is loading
 sql(clean.file,"UPDATE discovery_transfer SET state='loading', batches=batches+1 WHERE id=1");
 assert.deepEqual((await D.activationPreflight(clean.env)).problems,['transfer_loading']);
 // a stale staged signal (an interrupted resolver transfer)
 sql(clean.file,"UPDATE discovery_transfer SET state='idle' WHERE id=1");
 sql(clean.file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_ref,armed_at,attempts) VALUES ('admitted','tmdb:5','discovery','',1,0,'staged','resolver:${RUN}','${T}',0)`);
 const stale=await D.activationPreflight(clean.env);
 assert.deepEqual(stale.problems,['stale_staged_signals']);assert.equal(stale.facts.stagedSignals,1);
 // read-only: it wrote nothing
 assert.equal(sql(clean.file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,1);assert.equal(before,0);
}
console.log('catalog enrichment discovery scope ok');
