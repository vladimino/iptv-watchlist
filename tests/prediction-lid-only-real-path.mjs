// AIR-673 / ADR 0217 (Accepted) decision 9, choice M1, test 15, on the REAL Worker code (the prediction runner over the sqlite D1 stand-in with the real migrations and an in-memory R2): the queue rebuild, the manifest
// build and the per-film `submit` guard all honor ONE cohort rule on the resolved Film. No model is invoked; nothing here scores. DORMANT: the module is loaded into the Worker context by the test, as the bundle does.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {scoped,scopedImports} from '../scripts/bundle-scope.mjs';

const STAMP="'2026-11-27T10:00:00.000Z'";
const load=w=>vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority')+'\n'+scopedImports('src/prediction-lid-only-exclusion.js','PredictionLidOnly','const {database,failed,many}=FilmPersonAuthority;'),w.ctx);
const QUEUE='enrichment/prediction-queue.json';
const queued=async w=>{const stored=await w.records.get(QUEUE);const q=stored||{};return new Set([...(q.pending||[]),...(q.hotPending||[]),...(q.coldPending||[])].map(String));};
const filmRow=(w,id)=>sql(w.file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+id+"',1,NULL,'T',"+STAMP+");INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','"+id+"',1,"+STAMP+")");
const claim=(w,film,scheme,value)=>sql(w.file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+film+"','"+scheme+"','"+value+"',1,0)");
const admission=(w,lid,film)=>sql(w.file,"INSERT INTO film_lid_admission (lid,film_id,route,admitted_at,receipt_key,proof_version,final_url,slug,canonical_path,shortlink,type_marker,id_block_outcome,completeness_outcome,title,year,proof_digest,checked_at,redirect_status,page_status) VALUES ('"+lid+"','"+film+"','watchlist_admission',"+STAMP+",'admission:lid:"+lid+"',1,'https://letterboxd.com/film/s/','s','/film/s/','"+lid+"','film','absent','complete','T',1999,'"+'a'.repeat(64)+"',"+STAMP+",301,200)");
// A catalog admission whose id is a lid (the queue names the Film by that id), beside the ordinary tmdb_<n> films.
const catalog=(w,id)=>{const f={id,title:id,original:id,year:2020,tmdbId:'990001',canonicalIdentity:'tmdb:990001',genres:[],actors:[],directors:[],shows:[{start:Date.now()}]};sql(w.file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES ('"+id+"','990001','movie','tmdb:990001','"+id+"','p1',1,'current','"+JSON.stringify(f).replace(/'/g,"''")+"')");};
const start=async(w,body={})=>{const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...body});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));return r.data;};
const world=async()=>{
 const w=await flowWorld({films:5});
 // the lid-only Film: proof row on `film:lb:lo1`, trusted letterboxd claim, NO trusted tmdb claim
 filmRow(w,'film:lb:lo1');claim(w,'film:lb:lo1','letterboxd','lo1');admission(w,'lo1','film:lb:lo1');catalog(w,'lo1');
 return w;
};

// 1. Without the module (the legacy bundle) nothing changes: the lid-only candidate is queued and delivered. This is the control the next steps differ from.
{
 const w=await world();
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 assert.ok((await queued(w)).has('lo1'),'control: without the module the queue holds the candidate');
}

// 2. The QUEUE REBUILD does not admit it (a fresh rebuild with the module loaded), and a MANIFEST built from that queue does not hold it.
{
 const w=await world();load(w);
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const q=await queued(w);
 assert.equal(q.has('lo1'),false,'the rebuilt queue does not admit the lid-only Film');
 assert.ok(q.has('tmdb_1'),'ordinary films are untouched');
 const m=await start(w);
 assert.equal(m.films.some(f=>f.filmId==='lo1'),false);
}

// 3. A STALE QUEUE and a STALE MANIFEST: the queue (and a run's manifest) were built before the Film became lid-only; the guards of the manifest build and of `submit` still hold.
{
 const w=await world();
 await w.api('queue/reconcile',{});
 assert.ok((await queued(w)).has('lo1'),'precondition: the stale queue names the candidate');
 const stale=await start(w,{manifestSize:100});
 assert.ok(stale.films.some(f=>f.filmId==='lo1'),'precondition: a manifest built before the cohort rule holds it');
 const before=sql(w.file,'SELECT film_id FROM prediction_pointer ORDER BY film_id').map(r=>r.film_id);
 load(w);
 // the real submit: the lid-only film is answered not_eligible, nothing is written for it; an ordinary film of the same manifest still settles
 const ordinary=stale.films.find(f=>f.filmId.startsWith('tmdb_')).filmId;
 const sub=await w.api('batch/submit',{runId:stale.runId,epoch:stale.lease.epoch,items:[{filmId:'lo1',fingerprint:w.fingerprint,prediction:w.prediction},{filmId:ordinary,fingerprint:w.fingerprint,prediction:w.prediction}]});
 assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,300));
 const byId=Object.fromEntries(sub.data.results.map(r=>[r.filmId,r]));
 assert.deepEqual([byId.lo1.status,byId.lo1.reason],['not_eligible','lid_only_deferred'],'the guarded submit refuses the lid-only Film');
 assert.equal(byId[ordinary].status,'created');
 const after=sql(w.file,'SELECT film_id FROM prediction_pointer ORDER BY film_id').map(r=>r.film_id);
 assert.deepEqual(after.filter(id=>!before.includes(id)),[ordinary],'no prediction pointer for the lid-only Film');
 assert.equal([...w.records.keys()].some(key=>/\/lo1\//.test(key)),false,'no fingerprint or prediction object for it');
}
// 3b. A NEW manifest built from the same stale queue (it still names the candidate) excludes it: the manifest build is its own enforcement point.
{
 const w=await world();
 await w.api('queue/reconcile',{});
 assert.ok((await queued(w)).has('lo1'),'precondition: the stale queue names the candidate');
 load(w);
 const m=await start(w,{manifestSize:100});
 assert.equal(m.films.some(f=>f.filmId==='lo1'),false,'the manifest build honors the same cohort');
 assert.ok(m.films.length>=5,'the other films still fill it: the excluded film costs no slot');
}

// 4. The cohort is decided on the RESOLVED Film: the proof moved to a survivor after a merge, and an attach ends the exclusion on all three points.
{
 const w=await world();load(w);
 // merge: `film:lb:lo1` redirects to `film:survivor`; the claim and the proof row follow the survivor (AIR-674's shape); the queue names the Film by its lid
 filmRow(w,'film:survivor');
 sql(w.file,"DELETE FROM film_external_id WHERE film_id='film:lb:lo1' AND scheme='letterboxd'");claim(w,'film:survivor','letterboxd','lo1');
 sql(w.file,"UPDATE film_lid_admission SET film_id='film:survivor' WHERE lid='lo1'");
 sql(w.file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb:lo1','film:survivor',"+STAMP+")");
 await w.api('queue/reconcile',{});
 assert.equal((await queued(w)).has('lo1'),false,'after a merge to an arbitrary survivor the queue still excludes it');
 // attach: a trusted movie claim on the survivor ends the exclusion at the queue rebuild, the manifest and the submit guard together
 claim(w,'film:survivor','tmdb','990001');
 await w.api('queue/reconcile',{});
 assert.ok((await queued(w)).has('lo1'),'after an attach the ordinary gates apply: the queue admits it');
 const m=await start(w,{manifestSize:100});
 assert.ok(m.films.some(f=>f.filmId==='lo1'),'and the manifest delivers it');
 const sub=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:[{filmId:'lo1',fingerprint:w.fingerprint,prediction:w.prediction}]});
 assert.equal(sub.data.results[0].status,'created','and submit accepts it');
}
console.log('prediction-lid-only-real-path: ok');
