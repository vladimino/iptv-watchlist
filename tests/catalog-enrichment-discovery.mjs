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
 // B2. before schema 49 the code is the former code: no origin column, the same writes, no signal
 const {file,env}=await setup({schema:48,activate:true});
 await Authority.replaceCatalog(env,catalog(50),{admission:{origin:'resolver',programmeRunId:RUN}});
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_admission WHERE tmdb_id='50'")[0].n,1);
 assert.deepEqual(sig(file),[],'schema 48: deploying the code before the migration changes nothing');
 assert.equal(sql(file,'SELECT version FROM schema_contract')[0].version,48);
}

// ---- C. the source_changed emitter: unit level (the parity with the producer's persisted state and the real revalidation path are proved in tests/catalog-enrichment-producer.mjs and tests/discovery-revalidation.mjs) ----
const movie=(over={})=>({id:603,release_date:'1999-03-30',runtime:136,overview:'top-level text',poster_path:'/p.jpg',genres:[{id:28,name:'боевик'}],credits:{cast:[{id:11,name:'A',order:0},{id:13,name:'B',order:1}],crew:[{id:12,name:'D',job:'Director'}]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица',overview:'русский синопсис'}},{iso_639_1:'en',iso_3166_1:'US',data:{title:'The Matrix',overview:'english synopsis'}}]},images:{posters:[{iso_639_1:'en',file_path:'/en.jpg',width:900},{iso_639_1:'ru',file_path:'/ru.jpg',width:600}]},...over});
{
 const versions=await D.tmdbPartVersions(movie(),603);
 assert.ok(['core','credits','localization'].every(part=>/^[0-9a-f]{64}$/.test(versions[part])));
 assert.equal(await D.tmdbPartVersions(movie({id:604}),603),null,'a document of another movie is not read');
 assert.equal(await D.tmdbPartVersions(movie(),'abc'),null);
 // the same pure projection as the producer: each part IS what Plan computes from the parsed response
 const parsed=parseTmdb(movie(),'603');
 assert.equal(versions.core,await Plan.coreVersion('tmdb','603',parsed.fields,parsed.projection));
 assert.equal(versions.credits,await Plan.creditsVersion('tmdb','603',parsed.credits));
 assert.equal(versions.localization,await Plan.localizationVersion('tmdb','603',parsed.title));
 // not compared: the top-level overview, the genre NAMES, the votes, the list order
 assert.deepEqual(await D.tmdbPartVersions(movie({overview:'another',genres:[{id:28,name:'Action'}],images:{posters:[{iso_639_1:'ru',file_path:'/ru.jpg',width:600,vote_average:9},{iso_639_1:'en',file_path:'/en.jpg',width:900}]}}),603),versions);
 // compared: the selected Russian synopsis, the selected poster, the genre ids, an unmapped id
 const tr=(ru,en='english synopsis')=>({translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица',overview:ru}},{iso_639_1:'en',iso_3166_1:'US',data:{title:'The Matrix',overview:en}}]}});
 assert.notEqual((await D.tmdbPartVersions(movie(tr('иной синопсис')),603)).core,versions.core,'a changed Russian synopsis');
 assert.notEqual((await D.tmdbPartVersions(movie({images:{posters:[{iso_639_1:'ru',file_path:'/ru2.jpg',width:700}]}}),603)).core,versions.core,'a changed selected poster');
 assert.notEqual((await D.tmdbPartVersions(movie({genres:[{id:28},{id:878}]}),603)).core,versions.core,'a changed genre id set');
 assert.notEqual((await D.tmdbPartVersions(movie({genres:[{id:28},{id:424242}]}),603)).core,versions.core,'an unmapped genre id');
 assert.notEqual((await D.tmdbPartVersions(movie(tr('')),603)).core,versions.core,'a Russian synopsis that disappears falls back to English');
 assert.equal((await D.tmdbPartVersions(movie({translations:undefined}),603)).core,null,'an unreadable translations section leaves the core unverified');
 assert.equal((await D.tmdbPartVersions(movie({images:undefined}),603)).core,null,'an unreadable images section');
 assert.equal((await D.tmdbPartVersions(movie({genres:undefined}),603)).core,null,'a missing genre list');
 assert.match((await D.tmdbPartVersions(movie({genres:[]}),603)).core,/^[0-9a-f]{64}$/,'a valid empty genre list');
 // real changes do
 assert.notEqual((await D.tmdbPartVersions(movie({runtime:137}),603)).core,versions.core);
 assert.notEqual((await D.tmdbPartVersions(movie({release_date:'2000-01-01'}),603)).core,versions.core);
 assert.notEqual((await D.tmdbPartVersions(movie({credits:{cast:[{id:11,name:'A',order:0}],crew:[]}}),603)).credits,versions.credits,'a changed credit set');
 assert.notEqual((await D.tmdbPartVersions(movie({credits:{cast:[{id:13,name:'B',order:0},{id:11,name:'A',order:1}],crew:[{id:12,name:'D',job:'Director'}]}}),603)).credits,versions.credits,'a reordered one (the chunks depend on the order)');
 assert.notEqual((await D.tmdbPartVersions(movie({translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Другая'}}]}}),603)).localization,versions.localization);
 // a valid empty credit set and a verified absence of a Russian title ARE verified coverage with a version of their own
 const empty=await D.tmdbPartVersions(movie({credits:{cast:[],crew:[]},translations:{translations:[{iso_639_1:'de',iso_3166_1:'DE',data:{title:'Matrix'}}]}}),603);
 assert.ok(/^[0-9a-f]{64}$/.test(empty.credits)&&/^[0-9a-f]{64}$/.test(empty.localization));
 assert.notEqual(empty.credits,versions.credits);assert.notEqual(empty.localization,versions.localization);
 // missing, malformed or unsupported sections are NOT verified coverage: no version, never "no data"
 const noCredits=await D.tmdbPartVersions(movie({credits:undefined}),603);
 assert.equal(noCredits.credits,null);assert.equal(noCredits.core,versions.core);assert.equal(noCredits.localization,versions.localization);
 assert.equal((await D.tmdbPartVersions(movie({credits:{cast:'x',crew:[]}}),603)).credits,null,'a malformed credits section');
 assert.equal((await D.tmdbPartVersions(movie({translations:undefined}),603)).localization,null,'a missing translations section');
 assert.equal((await D.tmdbPartVersions(movie({translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:null}]}}),603)).localization,null,'a malformed translation');
 assert.equal((await D.tmdbPartVersions(movie({translations:{translations:[{iso_639_1:'ru',iso_3166_1:'UA',data:{title:'A'}},{iso_639_1:'ru',iso_3166_1:'BY',data:{title:'B'}}]}}),603)).localization,null,'an ambiguous selection is an owner decision, not a version');
}
{
 const {file,env}=await setup({activate:true});
 const FILM='film:tmdb:603';
 sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${FILM}',2,NULL,'M','${T}');INSERT INTO film_external_id VALUES ('${FILM}','tmdb','603',1,0,NULL)`);
 const changed=()=>sql(file,"SELECT part,state,version,acked_version FROM enrichment_signal WHERE kind='source_changed' AND subject='film:tmdb:603' ORDER BY part");
 const wakes=[];
 globalThis.CatalogEnrichmentRunner={hasRunnable:async()=>{wakes.push('has');return true;},kick:async()=>{wakes.push('kick');}};
 try{
  // no retained membership: nothing is written, nothing wakes
  assert.deepEqual(await D.emitSourceChanged(env,{tmdbId:'603',movie:movie(),at:T}),{state:'unchanged',parts:[]});
  assert.deepEqual(changed(),[]);assert.deepEqual(wakes,[]);
  sql(file,`INSERT INTO catalog_enrichment_member (film_id,scope,admitted_at,signal_key) VALUES ('${FILM}','discovery','${T}','k')`);
  // the first observation of a Film that holds a membership IS signalled (the producer, not the observer, decides from its stored source version whether it needs a fetch)
  assert.deepEqual(await D.emitSourceChanged(env,{tmdbId:'603',movie:movie(),at:T}),{state:'written',parts:['core','credits','localization']});
  assert.deepEqual(changed().map(r=>[r.part,r.state,r.version]),[['core','pending',1],['credits','pending',1],['localization','pending',1]]);
  assert.deepEqual(wakes,['has','kick'],'woken after the write');
  // an identical observation changes nothing and wakes nothing (the count is the batch's own changes(), not a scan)
  wakes.length=0;
  assert.deepEqual(await D.emitSourceChanged(env,{tmdbId:'603',movie:movie(),at:T}),{state:'unchanged',parts:[]});
  assert.deepEqual(wakes,[]);assert.deepEqual(changed().map(r=>r.version),[1,1,1]);
  // an unrelated change elsewhere cannot make this attempt look written
  sql(file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_digest,cause_ref,armed_at,attempts) VALUES ('source_changed','film:other','tmdb','core',1,0,'pending','${'1'.repeat(64)}','discovery_revalidation','${T}',0)`);
  assert.equal((await D.emitSourceChanged(env,{tmdbId:'603',movie:movie(),at:T})).state,'unchanged');
  // a real change re-arms exactly the changed part
  assert.deepEqual(await D.emitSourceChanged(env,{tmdbId:'603',movie:movie({credits:{cast:[{id:11,name:'A',order:0}],crew:[]}}),at:T}),{state:'written',parts:['credits']});
  assert.deepEqual(sql(file,"SELECT part,version FROM enrichment_signal WHERE kind='source_changed' AND subject='film:tmdb:603' ORDER BY part").map(r=>[r.part,r.version]),[['core',1],['credits',2],['localization',1]]);
  // a missing credits section is not verified coverage: it writes no credits signal and cannot re-arm one
  const before=changed().find(r=>r.part==='credits').version;
  assert.equal((await D.emitSourceChanged(env,{tmdbId:'603',movie:movie({credits:undefined}),at:T})).state,'unchanged');
  assert.equal(changed().find(r=>r.part==='credits').version,before);
  // another movie, a lost lease, a redirected Film and a conflicting claim write nothing
  assert.deepEqual(await D.emitSourceChanged(env,{tmdbId:'603',movie:movie({id:999}),at:T}),{state:'absent',parts:[]});
  const gone={id:'lease-gone',expiresAt:Date.now()-1000};
  assert.equal((await D.emitSourceChanged(env,{tmdbId:'603',movie:movie({runtime:150}),at:T,lease:gone})).state,'unchanged','a Discovery lease that is not held applies nothing');
  sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:target',2,NULL,'T','${T}');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('${FILM}','film:target','${T}')`);
  assert.equal((await D.emitSourceChanged(env,{tmdbId:'603',movie:movie({runtime:151}),at:T})).state,'unchanged','a redirected Film');
  // a failed write is REPORTED (never swallowed) and the producer is still woken in case it landed
  wakes.length=0;
  const real=env.DB;
  env.DB={...real,prepare:sqlText=>{if(/INSERT INTO enrichment_signal/.test(sqlText))throw new Error('D1 down');return real.prepare(sqlText);},batch:real.batch.bind(real)};
  assert.deepEqual(await D.emitSourceChanged(env,{tmdbId:'603',movie:movie({runtime:152}),at:T}),{state:'failed',parts:[]});
  assert.deepEqual(wakes,['has','kick'],'woken after an uncertain outcome');
  env.DB=real;
 }finally{delete globalThis.CatalogEnrichmentRunner;}
 // before the apply of the producer schema the emitter ends quietly
 const old=await setup({schema:46});
 assert.deepEqual(await D.emitSourceChanged(old.env,{tmdbId:'603',movie:movie(),at:T}),{state:'absent',parts:[]});
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
