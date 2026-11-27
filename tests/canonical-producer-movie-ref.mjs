// AIR-671 / ADR 0217 decision 8d (test 11), at the SOURCE boundary. A typed movie reference of a source (`tmdb_<n>`, `tmdb:<n>`) is an external claim, resolved to the Film that holds the movie id today, with the exact owner proof
// asserted inside the fenced batch of every write to that Film. An explicit canonical Film id (`film:...`) is a permanent entity key and is never reinterpreted. sqlite3-CLI D1 stand-in; no Worker, R2, TMDB or production access.
// What is NOT exercised here, and is not claimed: the future TMDB attach (AIR-675). A Film that already holds a trusted `tmdb` claim is a clearly labelled FIXTURE of the state the attach will produce (a LID-minted Film
// carrying the movie id), written by SQL; the facts path must then resolve it, never mint a second Film, and fail closed when the claim moves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Chain from '../src/canonical-producer-chain.js';
import {acquireSealedSnapshot,guardsOf,resolveIdentity,resolveSourceIdentities,runProducerWorkflow,movieOf} from '../src/canonical-producer-workflow.js';
import {applyEpgUnits,planEpgUnits,reconcileEpg} from '../src/canonical-epg-producer.js';
import {applyFilmFacts} from '../src/canonical-producer-adapters.js';
import {applyDiscoveryAdmission} from '../src/canonical-discovery-admission-producer.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-movie-ref-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const chainFiles=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'t.sqlite');
assert.equal(sqlite(template,chainFiles.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const AT='2026-11-16T10:00:00.000Z';
const P='run-p';
let n=0;
function database(){
 const file=path.join(root,'m-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='run-p',generation=10 WHERE id=1;"+
  "INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','"+AT+"')").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
function publish(file,rawIds){
 const sha='f'.repeat(64);
 const docFilms=rawIds.map(id=>JSON.stringify({id,title:'T '+id}).replace(/'/g,"''"));
 const members=rawIds.map((id,ordinal)=>"('run-p','watchlist',"+ordinal+",'"+id+"')").join(',');
 sqlite(file,"INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+sha+"','"+AT+"');"+
  "INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[]}'),('run-p','watchlist',0,'{\"films\":["+docFilms.join(',')+"]}');"+
  (members?"INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES "+members+";":''));
}
const addFilm=(file,id)=>sqlite(file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('"+id+"',1,'"+id+"','"+AT+"')");
const addMovie=(file,filmId,movie,trusted=1,conflicting=0)=>sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+filmId+"','tmdb','"+movie+"',"+trusted+","+conflicting+")");
const films=file=>rows(file,'SELECT id FROM film ORDER BY id').map(row=>row.id);
const SURVIVOR='film:lbx1';
// FIXTURE of the state the future attach (AIR-675) produces: a LID-minted Film that carries the trusted movie id. Written by SQL; no attach code is exercised.
const survivorFixture=file=>{addFilm(file,SURVIVOR);addMovie(file,SURVIVOR,'603');};
async function workflow(file,env,nonce){
 const launched=await Chain.launchChain(env,{programmeRunId:P,generation:10,at:AT,nowMs:Date.parse(AT)});
 return runProducerWorkflow(env,{programmeRunId:P,epoch:launched.epoch||1},{do:(name,fn)=>name==='nonce'?Promise.resolve(nonce):fn()},{hold:false});
}

// 1. Pure decisions. A typed movie reference is resolved from the claims of the movie id; an explicit Film id never is.
{
 assert.equal(movieOf('tmdb_603'),'603');assert.equal(movieOf('tmdb:603'),'603');assert.equal(movieOf('film:tmdb:603'),null,'an explicit Film id is not a movie reference');
 assert.equal(movieOf('tmdb_0603'),null);assert.equal(movieOf('tmdb_'),null);assert.equal(movieOf('lid1'),null);
 const trusted=film=>({film_id:film,trusted:1,conflicting:0});
 // unclaimed: the minting spelling, with the no-other-claim proof
 const unclaimed=resolveIdentity('tmdb_603',{});
 assert.deepEqual([unclaimed.target,unclaimed.via,unclaimed.movie],['film:tmdb:603','movie_unclaimed','603']);
 // claimed by a LID-minted Film (the survivor): the survivor, never the spelling
 const claimed=resolveIdentity('tmdb_603',{claims:[trusted(SURVIVOR)]});
 assert.deepEqual([claimed.target,claimed.via,claimed.owner],[SURVIVOR,'movie_claim',SURVIVOR]);
 assert.equal(resolveIdentity('tmdb:603',{claims:[trusted(SURVIVOR)]}).target,SURVIVOR);
 // any other row of the movie id holds it, whatever the trust and whichever Film
 for(const claims of [[{film_id:SURVIVOR,trusted:0,conflicting:0}],[{film_id:SURVIVOR,trusted:0,conflicting:1}],[trusted(SURVIVOR),{film_id:'film:other',trusted:0,conflicting:0}],[trusted(SURVIVOR),{film_id:'film:other',trusted:0,conflicting:1}],[trusted(SURVIVOR),trusted('film:other')]])
  assert.deepEqual(resolveIdentity('tmdb_603',{claims}),{refused:'producer_identity_ambiguous'},JSON.stringify(claims));
 // a redirect is followed, with its own proof
 const redirected=resolveIdentity('tmdb_603',{claims:[trusted(SURVIVOR)],redirects:new Map([[SURVIVOR,'film:lbx2']])});
 assert.deepEqual([redirected.target,redirected.owner,redirected.redirected],['film:lbx2',SURVIVOR,true]);
 assert.deepEqual(resolveIdentity('tmdb_603',{claims:[trusted(SURVIVOR)],redirects:new Map([[SURVIVOR,'film:lbx2'],['film:lbx2','film:lbx3']])}),{refused:'producer_identity_redirect_chain'});
 // an explicit canonical id keeps its meaning, even when the number is claimed by another Film now (permanent entity key, ADR 0217 I1)
 const explicit=resolveIdentity('film:tmdb:603',{claims:[trusted(SURVIVOR)]});
 assert.deepEqual([explicit.target,explicit.via,explicit.movie],['film:tmdb:603','direct',undefined]);
 assert.deepEqual(guardsOf('film:tmdb:603',explicit),[],'no movie proof and no rebinding for an explicit target');
 // the write-time proofs
 const proofs=guardsOf('tmdb_603',claimed);
 assert.equal(proofs.length,2);assert.match(proofs[0].sql,/^EXISTS .*scheme='tmdb'.*trusted=1 AND conflicting=0/);assert.match(proofs[1].sql,/^NOT EXISTS .*NOT \(film_id=\? AND trusted=1 AND conflicting=0\)/);
 assert.deepEqual(proofs[0].params,[SURVIVOR,'603']);assert.deepEqual(proofs[1].params,['603',SURVIVOR]);
 const open=guardsOf('tmdb_603',unclaimed);
 assert.equal(open.length,2);
 assert.match(open[0].sql,/^NOT EXISTS .*scheme='tmdb' AND value=\? AND NOT \(film_id=\? AND trusted=1 AND conflicting=0\)/);assert.deepEqual(open[0].params,['603','film:tmdb:603']);
 assert.match(open[1].sql,/^NOT EXISTS .*film_id=\? AND scheme='tmdb' AND value<>\? AND trusted=1 AND conflicting=0/);assert.deepEqual(open[1].params,['film:tmdb:603','603']);
 assert.equal(guardsOf('tmdb_603',redirected).length,3,'owner proof plus the redirect proof');
 // The spelling is not current identity (ADR 0217 I1): an unclaimed movie id is a mint target only for a Film that is not redirected and holds no DIFFERENT trusted movie. Never followed, never accepted.
 assert.deepEqual(resolveIdentity('tmdb_603',{redirects:new Map([['film:tmdb:603','film:lbx2']])}),{refused:'producer_identity_ambiguous'},'a redirected spelling is refused, not followed');
 assert.deepEqual(resolveIdentity('tmdb_603',{trustedMovies:new Map([['film:tmdb:603',['700']]])}),{refused:'producer_identity_ambiguous'},'a Film that holds a different trusted movie is refused');
 assert.equal(resolveIdentity('tmdb_603',{trustedMovies:new Map([['film:tmdb:604',['700']]])}).target,'film:tmdb:603','the trusted movie of another Film is irrelevant');
}

// 2. The read of the claims: one statement per chunk, any trust, resolved on the real schema; explicit Film ids and Letterboxd ids are unaffected.
{
 const file=database();
 survivorFixture(file);
 addFilm(file,'film:tmdb:700');addMovie(file,'film:tmdb:700','700');
 addFilm(file,'film:tmdb:800');addFilm(file,'film:lbx9');addMovie(file,'film:lbx9','800',0,0);
 const out=await resolveSourceIdentities(envOf(file),['tmdb_603','tmdb:700','tmdb_5','film:tmdb:603']);
 assert.equal(out.ok,true);
 assert.equal(out.resolved.get('tmdb_603'),SURVIVOR);assert.equal(out.resolved.get('tmdb:700'),'film:tmdb:700');assert.equal(out.resolved.get('tmdb_5'),'film:tmdb:5');assert.equal(out.resolved.get('film:tmdb:603'),'film:tmdb:603');
 assert.equal(out.guards.get(SURVIVOR).length,2);assert.equal(out.guards.has('film:tmdb:603'),false,'the explicit id carries no movie proof');
 const held=await resolveSourceIdentities(envOf(file),['tmdb_800']);
 assert.equal(held.ok,false);assert.equal(held.code,'producer_identity_ambiguous');
 const seen=[];
 await resolveSourceIdentities({DB:d1Standin(file,{onQuery:async text=>{seen.push(text);}})},['tmdb_603','tmdb_604']);
 assert.equal(seen.filter(text=>/scheme='tmdb' AND value IN/.test(text)).length,1,'one claims statement for the movie references of a chunk');
 assert.equal(seen.filter(text=>/film_id IN \(SELECT value FROM json_each/.test(text)&&/scheme='tmdb'/.test(text)).length,1,'one statement for the trusted movies of the unclaimed candidates of a chunk');
}

// 3. The whole Workflow. Order 1: the Film already holds the movie id (fixture of the attached state): facts and membership land on the survivor, no `film:tmdb:603` is minted, the chain completes.
{
 const file=database();
 survivorFixture(file);publish(file,['tmdb_603']);
 const result=await workflow(file,envOf(file),'21212121-2121-2121-2121-212121212121');
 assert.equal(result.state,'complete');
 assert.deepEqual(films(file),[SURVIVOR],'one Film, the survivor');
 assert.equal(one(file,'SELECT film_id FROM watchlist_film'),SURVIVOR);
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE target_id='"+SURVIVOR+"' AND state='applied'"))>=1,true,'the receipt targets the survivor');
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE target_id='film:tmdb:603'")),0);
}
// 3b. Order 2: nothing holds the movie id yet (facts first): the Film is minted once under its spelling, carries no external id (the facts writer writes none), and a second pass changes nothing.
{
 const file=database();
 publish(file,['tmdb_603']);
 const first=await workflow(file,envOf(file),'22222222-2222-2222-2222-222222222222');
 assert.equal(first.state,'complete');assert.deepEqual(films(file),['film:tmdb:603']);
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film_external_id')),0);
 assert.equal(one(file,'SELECT film_id FROM watchlist_film'),'film:tmdb:603');
}
// 3c. A held movie id (an untrusted claim on another Film) stops the chain by name; nothing is written.
{
 const file=database();
 addFilm(file,'film:lbx9');addMovie(file,'film:lbx9','603',0,0);publish(file,['tmdb_603']);
 const result=await workflow(file,envOf(file),'23232323-2323-2323-2323-232323232323');
 assert.equal(result.state,'stopped');assert.equal(result.code,'producer_identity_ambiguous');
 assert.deepEqual(films(file),['film:lbx9']);assert.equal(Number(one(file,'SELECT COUNT(*) FROM watchlist_film')),0);
}
// 3d. An EXPLICIT canonical target is never rebound: the same number is held by the survivor now, and `film:tmdb:603` (the historical minting spelling) still receives the facts of its own source.
{
 const file=database();
 addFilm(file,'film:tmdb:603');survivorFixture(file);publish(file,['film:tmdb:603']);
 const result=await workflow(file,envOf(file),'24242424-2424-2424-2424-242424242424');
 assert.equal(result.state,'complete');
 assert.equal(one(file,'SELECT film_id FROM watchlist_film'),'film:tmdb:603','the explicit target is kept');
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE target_id='"+SURVIVOR+"'")),0);
}
// 3e. Explicit targets of the other producers are untouched too: a verified canonical Film written under `requireExisting` (the dictionary, metadata and release shape) lands on the Film it names.
{
 const file=database();
 addFilm(file,'film:tmdb:603');survivorFixture(file);
 const env=envOf(file);
 const done=await applyFilmFacts(env,{origin:'dictionary',event:'e1',input:{id:'film:tmdb:603',at:AT,requireExisting:true,film:{contractVersion:1,originalTitle:'Kept',source:'dictionary'}}});
 assert.equal(done.state,'applied');
 assert.equal(one(file,"SELECT original_title FROM film WHERE id='film:tmdb:603'"),'Kept');
 assert.equal(one(file,"SELECT original_title FROM film WHERE id='"+SURVIVOR+"'"),SURVIVOR,'the survivor was not written');
 const release=await applyFilmFacts(env,{origin:'epg',event:'e2',input:{id:'film:tmdb:603',at:AT,release:true,watchlist:false,film:{contractVersion:1},updatedAt:AT}});
 assert.ok(['applied','noop'].includes(release.state));assert.equal(one(file,"SELECT updated_at FROM film WHERE id='"+SURVIVOR+"'"),AT);
}

// 4. Races between the plan and the FIRST write batch, against an EXISTING survivor. The survivor's revision does not move (a competing claim sits on another Film, an owner move touches no revision of the survivor), so only the
// owner proof inside the batch can stop them. The receipt is real: nothing is applied, nothing is written, the receipt of the survivor is not `applied`.
{
 async function race(sources,setup,change,trigger=/INSERT INTO (film \(|watchlist_film )/){
  const file=database();
  setup(file);publish(file,sources);
  let raced=false;
  const env=envOf(file,{onBatch:async statements=>{if(!raced&&statements.some(item=>trigger.test(item.text))){raced=true;await change(file);}}});
  const result=await workflow(file,env,'31313131-3131-3131-3131-313131313131');
  return {file,result,raced};
 }
 const applied=(file,id)=>Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE target_id='"+id+"' AND state='applied'"));
 // 4.1 a competing UNTRUSTED claim of the movie id appears on another Film
 {
  const {file,result,raced}=await race(['tmdb_603'],survivorFixture,f=>{addFilm(f,'film:lbx7');addMovie(f,'film:lbx7','603',0,0);});
  assert.equal(raced,true);assert.notEqual(result.state,'complete');
  assert.equal(Number(one(file,'SELECT COUNT(*) FROM watchlist_film')),0);assert.equal(Number(one(file,'SELECT COUNT(*) FROM film_metadata')),0);
  assert.equal(applied(file,SURVIVOR),0,'no applied receipt for the survivor');
  assert.equal(Number(one(file,"SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+SURVIVOR+"'),0)")),0,'the survivor revision did not move');
 }
 // 4.2 the owner MOVES: the claim leaves the survivor for another Film before the first batch
 {
  const {file,result,raced}=await race(['tmdb_603'],survivorFixture,f=>{addFilm(f,'film:lbx8');sqlite(f,"UPDATE film_external_id SET film_id='film:lbx8' WHERE scheme='tmdb' AND value='603'");});
  assert.equal(raced,true);assert.notEqual(result.state,'complete');
  assert.equal(Number(one(file,'SELECT COUNT(*) FROM watchlist_film')),0);assert.equal(applied(file,SURVIVOR),0);assert.equal(applied(file,'film:lbx8'),0,'and nothing lands on the new owner by this stale plan');
 }
 // 4.3 the owner claim is removed
 {
  const {file,result,raced}=await race(['tmdb_603'],survivorFixture,f=>sqlite(f,"DELETE FROM film_external_id WHERE scheme='tmdb' AND value='603'"));
  assert.equal(raced,true);assert.notEqual(result.state,'complete');assert.equal(Number(one(file,'SELECT COUNT(*) FROM watchlist_film')),0);
 }
 // 4.4 unclaimed and the minting spelling does not exist yet: a claim lands on another Film (the attach race, with a FIXTURE claim): nothing is minted
 {
  const {file,result,raced}=await race(['tmdb_603'],()=>{},f=>{addFilm(f,SURVIVOR);addMovie(f,SURVIVOR,'603');});
  assert.equal(raced,true);assert.notEqual(result.state,'complete');
  assert.deepEqual(films(file),[SURVIVOR],'no film:tmdb:603 was minted over the claim');assert.equal(Number(one(file,'SELECT COUNT(*) FROM watchlist_film')),0);
 }
 // 4.5 unclaimed and `film:tmdb:603` EXISTS (facts first): a claim lands on another Film before the write
 {
  const {file,result,raced}=await race(['tmdb_603'],f=>addFilm(f,'film:tmdb:603'),f=>{addFilm(f,SURVIVOR);addMovie(f,SURVIVOR,'603');});
  assert.equal(raced,true);assert.notEqual(result.state,'complete');
  assert.equal(Number(one(file,'SELECT COUNT(*) FROM watchlist_film')),0);assert.equal(applied(file,'film:tmdb:603'),0);
 }
 // 4.6 the proof is part of EVERY write to the target: the credits batch carries it as well
 {
  const file=database();survivorFixture(file);
  sqlite(file,"INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+'f'.repeat(64)+"','"+AT+"');INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[]}'),('run-p','watchlist',0,'{\"films\":[{\"id\":\"tmdb_603\",\"title\":\"T\",\"directors\":[{\"id\":\"p1\",\"name\":\"Dir\"}]}]}');INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run-p','watchlist',0,'tmdb_603');");
  let raced=false;
  const env=envOf(file,{onBatch:async statements=>{if(!raced&&statements.some(item=>/INSERT INTO film_person_credit /.test(item.text))){raced=true;addFilm(file,'film:lbx7');addMovie(file,'film:lbx7','603',0,0);}}});
  const result=await workflow(file,env,'32323232-3232-3232-3232-323232323232');
  assert.equal(raced,true,'the credit batch was reached');assert.notEqual(result.state,'complete');
  assert.equal(Number(one(file,'SELECT COUNT(*) FROM film_person_credit')),0);
 }
 // 4.7 control: the same pass without a change completes (so the proofs above are what blocked it)
 {
  const {file,result}=await race(['tmdb_603'],survivorFixture,()=>{});
  assert.equal(result.state,'complete');assert.equal(one(file,'SELECT film_id FROM watchlist_film'),SURVIVOR);assert.deepEqual(films(file),[SURVIVOR]);
 }
}

// 4b. The unclaimed path accepts only a genuinely unclaimed, eligible target. Real writer, real receipt; planning and the batch both refuse.
{
 const sealed=async(setup,sources=['tmdb_603'])=>{const file=database();setup(file);publish(file,sources);return {file,snap:await acquireSealedSnapshot(envOf(file),P,{previousIds:[]})};};
 const applied=(file,id)=>Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE target_id='"+id+"' AND state='applied'"));
 const planOf=snap=>planEpgUnits({runId:'run-u',at:AT,films:snap.films.map(film=>({id:film.id,facts:film.facts}))});
 // (a) facts-first Film `film:tmdb:603`, unclaimed at source resolution: an untrusted row of the movie lands ON THAT FILM before the write (before prePlan reads its revision): the typed reference is now held, nothing is written
 for(const [trusted,conflicting] of [[0,0],[0,1]]){
  const {file,snap}=await sealed(f=>addFilm(f,'film:tmdb:603'));
  assert.equal(snap.ok,true);assert.deepEqual(snap.films.map(film=>film.id),['film:tmdb:603']);
  addMovie(file,'film:tmdb:603','603',trusted,conflicting);
  const out=await applyEpgUnits(envOf(file),{plan:planOf(snap),now:()=>AT});
  assert.equal(out.counts.applied,0,'trusted='+trusted+' conflicting='+conflicting);assert.equal(out.counts.failed,1);assert.equal(out.failures.length,1);assert.equal(out.failures[0].code,'film_person_precondition');
  assert.equal(applied(file,'film:tmdb:603'),0);assert.equal(Number(one(file,'SELECT COUNT(*) FROM watchlist_film')),0);assert.equal(Number(one(file,'SELECT COUNT(*) FROM film_metadata')),0);
  assert.equal(one(file,"SELECT state FROM canonical_write_receipt WHERE target_id='film:tmdb:603'"),'failed');
 }
 // (b) the same inside the batch, with no revision movement (the row lands between the pre-plan and the writer's batch)
 {
  const {file,snap}=await sealed(f=>addFilm(f,'film:tmdb:603'));
  let raced=false;
  const env=envOf(file,{onBatch:async statements=>{if(!raced&&statements.some(item=>/INSERT INTO film /.test(item.text))){raced=true;addMovie(file,'film:tmdb:603','603',0,1);}}});
  const out=await applyEpgUnits(env,{plan:planOf(snap),now:()=>AT});
  assert.equal(raced,true);assert.equal(out.counts.applied,0);assert.equal(applied(file,'film:tmdb:603'),0);assert.equal(Number(one(file,'SELECT COUNT(*) FROM film_metadata')),0);
 }
 // (c) the candidate already holds a DIFFERENT trusted movie (700) and no row of 603: refused at planning, by name, nothing written
 {
  const file=database();addFilm(file,'film:tmdb:603');addMovie(file,'film:tmdb:603','700');publish(file,['tmdb_603']);
  const out=await resolveSourceIdentities(envOf(file),['tmdb_603']);
  assert.equal(out.ok,false);assert.equal(out.code,'producer_identity_ambiguous');
  const result=await workflow(file,envOf(file),'51515151-5151-5151-5151-515151515151');
  assert.equal(result.state,'stopped');assert.equal(result.code,'producer_identity_ambiguous');assert.equal(Number(one(file,'SELECT COUNT(*) FROM film_metadata')),0);
 }
 // (d) ... and when the different trusted movie lands on the candidate after the plan
 {
  const {file,snap}=await sealed(f=>addFilm(f,'film:tmdb:603'));
  addMovie(file,'film:tmdb:603','700');
  const out=await applyEpgUnits(envOf(file),{plan:planOf(snap),now:()=>AT});
  assert.equal(out.counts.applied,0);assert.equal(applied(file,'film:tmdb:603'),0);assert.equal(Number(one(file,'SELECT COUNT(*) FROM film_metadata')),0);
 }
 // (e) a redirected spelling is refused, never followed
 {
  const file=database();addFilm(file,'film:tmdb:603');addFilm(file,'film:lbx2');sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:603','film:lbx2','"+AT+"')");publish(file,['tmdb_603']);
  const out=await resolveSourceIdentities(envOf(file),['tmdb_603']);
  assert.equal(out.ok,false);assert.equal(out.code,'producer_identity_ambiguous');
  assert.equal(Number(one(file,'SELECT COUNT(*) FROM film_metadata')),0);
 }
 // (f) the intended cases still hold: a facts-first Film with its OWN trusted claim of the same movie (a benign concurrent Discovery admission) is the owner and receives the facts
 {
  const {file,snap}=await sealed(f=>addFilm(f,'film:tmdb:603'));
  addMovie(file,'film:tmdb:603','603');
  const out=await applyEpgUnits(envOf(file),{plan:planOf(snap),now:()=>AT});
  assert.equal(out.counts.applied,1);assert.equal(applied(file,'film:tmdb:603'),1);assert.deepEqual(films(file),['film:tmdb:603']);
 }
}

// 4c. Capacity: the cap of the identity lookup counts Letterboxd ids only. A sealed Watchlist of more than IDENTITY_LOOKUP_CAP typed movie references (the Watchlist contract allows 5000), mixed with lids, resolves at the
// actual snapshot boundary through the existing 200-id statements; nothing stops the chain, and no cap of this change applies.
{
 const file=database();
 const lids=Array.from({length:30},(_v,i)=>'mix'+i);
 lids.forEach(lid=>addFilm(file,'film:'+lid));
 const refs=Array.from({length:1500},(_v,i)=>'tmdb_'+(1000+i));
 addFilm(file,SURVIVOR);addMovie(file,SURVIVOR,'1000');
 publish(file,[...refs,...lids,'film:explicit1']);
 const seen=[];
 const env={DB:d1Standin(file,{onQuery:async text=>{seen.push(text);}})};
 const snap=await acquireSealedSnapshot(env,P,{previousIds:[]});
 assert.equal(snap.ok,true,JSON.stringify(snap.code||''));
 assert.equal(snap.films.length,1531,'1500 movie references + 30 lids + 1 explicit id: every listed Film is a unit');
 assert.ok(snap.films.some(film=>film.id===SURVIVOR)&&!snap.films.some(film=>film.id==='film:tmdb:1000'),'the claimed reference resolved to its owner');
 assert.equal(seen.filter(text=>/FROM film_external_id WHERE scheme='tmdb' AND value IN/.test(text)).length,Math.ceil(1500/200),'one claims statement per 200 references');
 const lidCap=await resolveSourceIdentities(envOf(file),Array.from({length:1001},(_v,i)=>'l'+i));
 assert.equal(lidCap.code,'producer_identity_bounded','the cap of Letterboxd ids is unchanged');
}

// 5. A REAL Discovery admission interleaves with the facts write (the current writer, not a model of it). The facts plan was made while the movie id was unclaimed; Discovery admits `tmdb_603` first: it creates `film:tmdb:603`
// with the trusted claim, which is the facts target itself, so the write proceeds on the one Film. Both orders end with one Film and one trusted owner.
{
 const file=database();
 publish(file,['tmdb_603']);
 let raced=false;
 const env=envOf(file,{onBatch:async statements=>{
  if(!raced&&statements.some(item=>/INSERT INTO (film \(|watchlist_film )/.test(item.text)&&!/film_external_id/.test(item.text))){
   raced=true;
   const admitted=await applyDiscoveryAdmission(envOf(file),{event:'discovery:1',input:{tmdbId:'603',title:'The Matrix',at:AT},now:()=>AT});
   assert.equal(admitted.state,'applied');
  }
 }});
 const result=await workflow(file,env,'41414141-4141-4141-4141-414141414141');
 assert.equal(raced,true);
 assert.deepEqual(films(file),['film:tmdb:603'],'one Film');
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value='603' AND trusted=1 AND conflicting=0")),1,'one trusted owner');
 void result;
}
{
 // Discovery first, then the facts: the facts resolve the owner Discovery created (the same Film), no second Film.
 const file=database();
 publish(file,['tmdb_603']);
 const admitted=await applyDiscoveryAdmission(envOf(file),{event:'discovery:1',input:{tmdbId:'603',title:'The Matrix',at:AT},now:()=>AT});
 assert.equal(admitted.state,'applied');
 const result=await workflow(file,envOf(file),'42424242-4242-4242-4242-424242424242');
 assert.equal(result.state,'complete');assert.deepEqual(films(file),['film:tmdb:603']);
 assert.equal(one(file,'SELECT film_id FROM watchlist_film'),'film:tmdb:603');
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value='603' AND trusted=1 AND conflicting=0")),1);
}

// 6. The REAL Producer re-plan after a failed atomic attempt on the survivor. The plan units are keyed by the RESOLVED target, so the receipt target (the survivor) is found by `epgReplan` and the same request is reconciled
// and applied, with its proofs, after the race is gone. A synthetic re-plan that returns facts unconditionally would hide a unit that cannot be found: here the unit is looked up by the receipt's own target id.
{
 const file=database();
 survivorFixture(file);publish(file,['tmdb_603']);
 const snapshotEnv=envOf(file);
 const snap=await acquireSealedSnapshot(snapshotEnv,P,{previousIds:[]});
 assert.equal(snap.ok,true);assert.deepEqual(snap.films.map(film=>film.id),[SURVIVOR],'the unit is keyed by the resolved survivor, not by the spelling');
 assert.equal(snap.films[0].facts.guards.length,2,'the unit carries the owner proof');
 const plan=planEpgUnits({runId:'run-1',at:AT,films:snap.films.map(film=>({id:film.id,facts:film.facts}))});
 let raced=false;
 const raceEnv=envOf(file,{onBatch:async statements=>{if(!raced&&statements.some(item=>/INSERT INTO film /.test(item.text))){raced=true;addFilm(file,'film:lbx7');addMovie(file,'film:lbx7','603',0,0);}}});
 const first=await applyEpgUnits(raceEnv,{plan,now:()=>AT});
 assert.equal(raced,true);assert.equal(first.counts.applied,0);assert.equal(first.counts.failed+first.counts.unknown+first.counts.pending>=1,true,JSON.stringify(first.counts));
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE target_id='"+SURVIVOR+"' AND state='applied'")),0);
 const states=rows(file,"SELECT state FROM canonical_write_receipt WHERE target_id='"+SURVIVOR+"'").map(row=>row.state);
 assert.ok(states.length>=1&&!states.includes('applied'),'a receipt of the survivor exists and is not applied: '+states);
 // the competing claim is resolved by the owner (removed), then the real reconcile re-plans the receipt and applies it
 sqlite(file,"DELETE FROM film_external_id WHERE film_id='film:lbx7'");
 const LATER=new Date(Date.parse(AT)+3600000).toISOString();
 const reconciled=await reconcileEpg(envOf(file),{plan,now:()=>LATER});
 assert.ok(reconciled&&!reconciled.skipped,JSON.stringify(reconciled));
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE target_id='"+SURVIVOR+"' AND state='applied'")),1,'the same request was replayed on the survivor');
 assert.equal(one(file,'SELECT film_id FROM watchlist_film'),SURVIVOR);assert.deepEqual(films(file),[SURVIVOR,'film:lbx7']);
}

console.log('canonical-producer-movie-ref: typed movie references resolve to the trusted owner with the exact proof in the batch; explicit Film ids are never rebound; races against an existing survivor fail closed with real receipts; Discovery interleavings keep one Film; the real re-plan reconciles on the survivor');
