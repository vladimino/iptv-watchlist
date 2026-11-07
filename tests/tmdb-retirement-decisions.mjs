// AIR-370 / ADR 0099 decision 7: the owner-only, append-only TMDB retirement decision history. Migration 0016 (a file only), the pure checks and
// the prepare-only R2 loader, the fenced decision writer, held cases, replay and the explicit inverse, on the sqlite3-CLI D1 stand-in. No Worker,
// R2, TMDB or production access; the historical four Films come from the committed constants, never from R2. Repeat in AIR-371 (producers apply
// a decision through the fenced identity mutation), AIR-373 (the loader and parity against the real object) and AIR-374 (activation).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {d1Standin} from './d1-standin.mjs';
import {mutateFilm,mergeFilms} from '../src/canonical-mutations.js';
import {CONFIRMED_RETIREMENTS,OWNER_CONFIRMATION} from '../scripts/tmdb-tv-identity-plan.mjs';
import {checkRetirementEntry,prepareRetirementImport,normalizeDecision,recordRetirementDecision,retirementHistory,currentRetirements,compareRetirementImport,sha256Hex} from '../src/tmdb-retirement-decisions.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-retirement-decisions-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>name.replace(/\.sql$/,''));
const NEW='0016_tmdb_retirement_decision';
assert.ok(names.includes(NEW),'0016 is a migration file');
// 0016 follows a COMPLETE schema v15 (migrations are contiguous): the test applies the real chain 0001..0015, then 0016. `chain` is the chain
// up to 0014; the real migrations/0015_film_admission.sql (AIR-369) takes it to v15.
const chain=names.filter(name=>name<'0015');
const real15=names.find(name=>name.startsWith('0015_'));
assert.equal(real15,'0015_film_admission','the real 0015 is in the tree');
const v15=()=>sql(real15);
assert.ok(chain.includes('0014_localization_source')&&chain.includes('0013_film_person_authority'));
let n=0;
const sqlite=(file,text)=>spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=spawnSync('sqlite3',['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const sql=name=>fs.readFileSync('migrations/'+name+'.sql','utf8');
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern);};
function database({upTo=chain.length,apply=true,open=false,at15=true}={}){
 const file=path.join(root,'rd-'+(n++)+'.sqlite');
 const r=sqlite(file,chain.slice(0,upTo).map(sql).join('\n')+(upTo===chain.length&&at15?'\n'+v15():''));assert.equal(r.status,0,r.stderr);
 if(apply){const r2=sqlite(file,sql(NEW));assert.equal(r2.status,0,r2.stderr);}
 if(open)assert.equal(sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 return file;
}
const AT='2026-11-07T10:00:00.000Z';
const state=file=>({DB:d1Standin(file)});
const code=expected=>error=>error.code===expected;
const plain=value=>JSON.parse(JSON.stringify(value));

// The historical entry shape (AIR-290/291), built from the committed four Films with synthetic evidence timestamps.
const entry=(confirmed,over={})=>({filmId:confirmed.filmId,lid:confirmed.lid,movieId:confirmed.movieId,tvId:confirmed.tvId,evidence:{movieStatus:404,movieCheckedAt:'2026-10-30T10:00:00Z',letterboxdUrl:confirmed.letterboxdUrl,link:'tv/'+confirmed.tvId,linkCheckedAt:'2026-10-30T10:01:00Z',tvResponseId:confirmed.tvId,tvCheckedAt:'2026-10-30T10:02:00Z'},confirmation:{...OWNER_CONFIRMATION},...over});
const body=()=>({schemaVersion:1,retirements:CONFIRMED_RETIREMENTS.map(item=>entry(item))});
assert.equal(CONFIRMED_RETIREMENTS.length,4);
const [ODYSSEY,TESS]=CONFIRMED_RETIREMENTS;
const decisionFor=(confirmed,over={})=>({requestId:'req-'+confirmed.lid,kind:'retire',filmId:confirmed.filmId,lid:confirmed.lid,movieId:confirmed.movieId,tvId:confirmed.tvId,expectedRevision:1,at:AT,evidence:entry(confirmed).evidence,confirmation:{...OWNER_CONFIRMATION},...over});
// A Film as the projector leaves it before a decision is applied: a trusted tmdb movie id.
async function seedFilm(env,confirmed,{tmdb=confirmed.movieId,trusted=true}={}){
 return mutateFilm(env,{id:confirmed.filmId,expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:confirmed.lid,externalIds:tmdb?[{scheme:'tmdb',value:tmdb,trusted}]:[]}});
}

// 1. The migration: it refuses anything but a complete v15, creates nothing then, and creates one empty append-only table.
{
 // A database at v14 refuses 0016 and changes nothing (no contiguous skip over 0015); so do versions below it and a v15 without the 0015 tables.
 const snapshot=file=>JSON.stringify([rows(file,"SELECT name FROM sqlite_master ORDER BY name"),rows(file,'SELECT version,note FROM schema_contract')]);
 for(const upTo of [chain.length,chain.indexOf('0013_film_person_authority')+1,chain.indexOf('0013_film_person_authority'),9]){
  const file=database({upTo,apply:false,at15:false});
  const before=snapshot(file);
  refused(file,sql(NEW));
  assert.equal(snapshot(file),before,'a refused file changes nothing (chain '+upTo+')');
 }
 assert.equal(one(database({apply:false,at15:false}),'SELECT version FROM schema_contract'),14,'the v14 case is really v14');
 const hollow=database({apply:false,at15:false});
 sqlite(hollow,'UPDATE schema_contract SET version=15');
 const hollowBefore=snapshot(hollow);
 refused(hollow,sql(NEW));
 assert.equal(snapshot(hollow),hollowBefore,'a version 15 without the 0015 tables is refused and changes nothing');
 // Version 14 with the 0015 tables already present (a half-done or hand-made state) is still not v15: refused, nothing changed.
 const mixed=database({apply:false});
 sqlite(mixed,'DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=14;');
 const mixedBefore=snapshot(mixed);
 refused(mixed,sql(NEW));
 assert.equal(snapshot(mixed),mixedBefore,'version 14 with the 0015 tables present is refused and changes nothing');
 const partial=database({apply:false});
 sqlite(partial,'DROP TABLE film_retention');
 refused(partial,sql(NEW));
 assert.equal(one(partial,'SELECT version FROM schema_contract'),15,'a v15 missing one 0015 table is refused');
 // A complete v15 advances 15 -> 16 and only that.
 const v15file=database({apply:false});
 assert.equal(one(v15file,'SELECT version FROM schema_contract'),15);
 assert.deepEqual(rows(v15file,"SELECT name FROM sqlite_master WHERE name IN ('film_rated_admission','film_retention') ORDER BY name").map(item=>item.name),['film_rated_admission','film_retention'],'the real 0015 creates the tables the 0016 guard names');
 assert.equal(sqlite(v15file,sql(NEW)).status,0);
 assert.equal(one(v15file,'SELECT version FROM schema_contract'),16);
 // A database already at 16 (or higher) refuses it again.
 const file=database();
 assert.equal(one(file,'SELECT version FROM schema_contract'),16);
 assert.equal(one(file,'SELECT COUNT(*) FROM tmdb_retirement_decision'),0,'no row is written');
 assert.deepEqual(rows(file,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'r2',cutover:'open',generation:0}],'the marker is not moved');
 refused(database(),sql(NEW));
 refused(file,'UPDATE schema_contract SET version=15',/schema_contract_downgrade/);
 const insert=(over={})=>{
  const v={request_id:"'r1'",film_id:"'film:1IUo'",kind:"'retire'",lid:"'1IUo'",movie_id:"'17266'",tv_id:"'9687'",evidence:"'{}'",confirmation:`'{"by":"owner","at":"t","source":"s"}'`,origin:"'owner_request'",sha:'NULL',supersedes:'NULL',payload:"'{}'",...over};
  return `INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) VALUES (${v.request_id},${v.film_id},${v.kind},${v.lid},${v.movie_id},${v.tv_id},${v.evidence},${v.confirmation},${v.origin},${v.sha},${v.supersedes},${v.payload},'t')`;
 };
 assert.equal(sqlite(file,insert()).status,0,'a valid row');
 // The table's own checks: ids, owner confirmation, kinds, JSON, request id, import hash.
 // Each bad row is otherwise valid (a free Film and free ids), so only the named defect can refuse it; the control row proves it.
 const fresh=database();
 const base={request_id:"'c1'",film_id:"'film:ctl'",lid:"'ctl'",movie_id:"'111'",tv_id:"'222'"};
 for(const bad of [{movie_id:"'0123'"},{movie_id:"'12a'"},{tv_id:"'12345678901'"},{tv_id:"''"},{film_id:"'tmdb:1'"},{lid:"'a-b'"},{confirmation:`'{"by":"system","at":"t","source":"s"}'`},{confirmation:`'{"by":"owner","at":"t"}'`},{confirmation:"'{bad'"},{evidence:"'[]'"},{kind:"'delete'"},{origin:"'api'"},{origin:"'r2_import'"},{origin:"'r2_import'",sha:"'xyz'"},{kind:"'restore'"},{supersedes:'1'},{request_id:"''"}])refused(fresh,insert({...base,...bad}));
 assert.equal(sqlite(fresh,insert(base)).status,0,'the control row is valid');
 refused(fresh,insert({...base,film_id:"'film:other'",lid:"'other'",tv_id:"'333'"}),/UNIQUE/,'a request id is unique');
 // Append-only: no update, no delete, no truncate by any column.
 refused(file,"UPDATE tmdb_retirement_decision SET kind='restore'",/tmdb_retirement_append_only/);
 refused(file,"UPDATE tmdb_retirement_decision SET recorded_at='x'",/tmdb_retirement_append_only/);
 refused(file,'DELETE FROM tmdb_retirement_decision',/tmdb_retirement_append_only/);
 // State machine in SQL: a second active retire of a Film, a TV entry active on two Films, a restore that is not the inverse of the latest retire.
 refused(file,insert({request_id:"'r2'"}),/tmdb_retirement_active/);
 refused(file,insert({request_id:"'r3'",film_id:"'film:other'",lid:"'other'"}),/tmdb_retirement_tv_collision/);
 refused(file,insert({request_id:"'r4'",kind:"'restore'",supersedes:'1',movie_id:"'999'"}),/tmdb_restore_invalid/);
 refused(file,insert({request_id:"'r5'",kind:"'restore'",supersedes:'1',film_id:"'film:other'",lid:"'other'"}),/tmdb_restore_invalid/);
 refused(file,insert({request_id:"'r6'",kind:"'restore'",supersedes:'99'}),/FOREIGN KEY|tmdb_restore_invalid/);
 assert.equal(sqlite(file,insert({request_id:"'r7'",kind:"'restore'",supersedes:'1'})).status,0,'the explicit inverse');
 refused(file,insert({request_id:"'r8'",kind:"'restore'",supersedes:'1'}),/tmdb_restore_invalid/,'a restore of an already reversed retire');
 assert.equal(sqlite(file,insert({request_id:"'r9'"})).status,0,'a new retire after a restore');
 assert.deepEqual(rows(file,'SELECT film_id,state,seq FROM tmdb_retirement_current'),[{film_id:'film:1IUo',state:'retire',seq:3}]);
}

// 2. Pure checks: invalid input stops before any SQL; parity with the projector's own validation (tmdbRetirementSet) on valid and invalid objects.
{
 const source=['src/domain/film-person.js','src/domain/tmdb-tv-identity.js'].map(file=>fs.readFileSync(file,'utf8')).join('\n');
 const ctx=vm.createContext({Date,Map,Set,JSON,Object,URL,encodeURIComponent});
 vm.runInContext(source+'\nglobalThis.api={tmdbRetirementSet};',ctx);
 const real=value=>ctx.api.tmdbRetirementSet(plain(value));
 const sha='a'.repeat(64);
 const cases=[['valid',body()],
  ['empty list',{schemaVersion:1,retirements:[]}],['wrong version',{...body(),schemaVersion:2}],['no list',{schemaVersion:1}],['array body',[]],['null',null],
  ['lid',(()=>{const b=body();b.retirements[0].lid='bad id';return b;})()],['film id',(()=>{const b=body();b.retirements[0].filmId='film:other';return b;})()],
  ['movie id',(()=>{const b=body();b.retirements[0].movieId='abc';return b;})()],['tv id',(()=>{const b=body();b.retirements[1].tvId='0';return b;})()],
  ['no 404',(()=>{const b=body();b.retirements[0].evidence.movieStatus=200;return b;})()],['url',(()=>{const b=body();b.retirements[0].evidence.letterboxdUrl='https://example.com/film/x/';return b;})()],
  ['link',(()=>{const b=body();b.retirements[0].evidence.link='movie/9687';return b;})()],['tv entry',(()=>{const b=body();b.retirements[0].evidence.tvResponseId='1';return b;})()],
  ['owner',(()=>{const b=body();b.retirements[0].confirmation.by='bot';return b;})()],['source',(()=>{const b=body();delete b.retirements[0].confirmation.source;return b;})()],
  ['duplicate film',(()=>{const b=body();b.retirements.push(b.retirements[0]);return b;})()],['duplicate tv',(()=>{const b=body();b.retirements[1].tvId=b.retirements[0].tvId;b.retirements[1].evidence.link='tv/'+b.retirements[0].tvId;b.retirements[1].evidence.tvResponseId=b.retirements[0].tvId;return b;})()]];
 for(const [label,input] of cases){
  const expected=real(input),got=prepareRetirementImport(input,{sha256:sha});
  assert.equal(got.ok,expected.ok,'parity: '+label);
  if(expected.ok)assert.equal(got.decisions.length,expected.retirements.length);
  else assert.deepEqual(got.reasons,plain(expected.reasons),'the same reasons: '+label);
 }
 // The historical four Films: the object prepares four retire decisions with deterministic request ids and the exact input hash; nothing is read.
 const prepared=prepareRetirementImport(body(),{sha256:sha});
 assert.deepEqual(prepared.decisions.map(item=>[item.filmId,item.movieId,item.tvId,item.kind,item.origin]),CONFIRMED_RETIREMENTS.map(item=>[item.filmId,item.movieId,item.tvId,'retire','r2_import']));
 assert.deepEqual(prepared.decisions.map(item=>item.requestId),CONFIRMED_RETIREMENTS.map(item=>'r2-import:'+sha.slice(0,16)+':'+item.filmId));
 assert.deepEqual(prepareRetirementImport(body(),{sha256:sha}),prepared,'deterministic');
 assert.equal(prepareRetirementImport(body(),{sha256:'nope'}).ok,false,'a missing or malformed digest prepares nothing');
 assert.equal(await sha256Hex('abc'),crypto.createHash('sha256').update('abc').digest('hex'));
 assert.equal(checkRetirementEntry(entry(ODYSSEY)).ok,true);
 // normalizeDecision: invalid input throws retirement_invalid before any SQL (no marker read, no query).
 const spy={DB:{prepare(){throw new Error('SQL must not run');},batch(){throw new Error('SQL must not run');}}};
 for(const bad of [null,{},{...decisionFor(ODYSSEY),requestId:''},{...decisionFor(ODYSSEY),kind:'delete'},{...decisionFor(ODYSSEY),filmId:'tmdb:17266'},{...decisionFor(ODYSSEY),lid:'xxxx'},{...decisionFor(ODYSSEY),movieId:'abc'},{...decisionFor(ODYSSEY),tvId:'x'},{...decisionFor(ODYSSEY),confirmation:{by:'owner',at:'t'}},{...decisionFor(ODYSSEY),confirmation:{by:'model',at:'t',source:'s'}},{...decisionFor(ODYSSEY),evidence:{}},{...decisionFor(ODYSSEY),supersedesSeq:1},{...decisionFor(ODYSSEY),origin:'r2_import'},{...decisionFor(ODYSSEY),origin:'nowhere'},{...decisionFor(ODYSSEY),kind:'restore',evidence:{reason:'x'}},{...decisionFor(ODYSSEY),kind:'restore',supersedesSeq:1,evidence:{}},{...decisionFor(ODYSSEY),kind:'restore',supersedesSeq:0,evidence:{reason:'x'}}])
  await assert.rejects(()=>recordRetirementDecision(spy,{expectedRevision:1,at:AT,...bad}),code('retirement_invalid'));
 assert.throws(()=>normalizeDecision({...decisionFor(ODYSSEY),movieId:'17266',tvId:'9687',filmId:'film:1IUo',lid:'1IUo',evidence:{...decisionFor(ODYSSEY).evidence,movieStatus:500}}),code('retirement_invalid'));
}

// 3. The writer refuses before the database unless the marker is open: the projector stays the only writer in r2 and prepared (and legacy, held).
{
 const input=decisionFor(ODYSSEY);
 const legacy=database({apply:false});
 await assert.rejects(()=>recordRetirementDecision(state(legacy),input),code('film_person_not_open'));
 const r2=database();
 await assert.rejects(()=>recordRetirementDecision(state(r2),input),code('film_person_not_open'),'r2');
 sqlite(r2,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1");
 await assert.rejects(()=>recordRetirementDecision(state(r2),input),code('film_person_not_open'),'prepared');
 assert.equal(one(r2,'SELECT COUNT(*) FROM tmdb_retirement_decision'),0);
 const held=database({open:true});
 sqlite(held,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 await assert.rejects(()=>recordRetirementDecision(state(held),input),code('film_person_held'),'held');
}

// 4. The writer when open: one batch, revision, replay, replay mismatch, explicit inverse, full history, typed ids.
{
 const file=database({open:true});
 const env=state(file);
 await seedFilm(env,ODYSSEY);await seedFilm(env,TESS);
 const batches=env.DB.calls.batches;
 const first=await recordRetirementDecision(env,decisionFor(ODYSSEY));
 assert.deepEqual([first.replayed,first.seq,first.revision],[false,1,2]);
 assert.equal(env.DB.calls.batches,batches+1,'one batch');
 assert.equal(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:1IUo'"),2);
 // The ledger writes decisions only: no external id, canonical identity or dimension moved.
 assert.deepEqual(rows(file,"SELECT scheme,value,trusted FROM film_external_id WHERE film_id='film:1IUo'"),[{scheme:'tmdb',value:'17266',trusted:1}]);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_dimension'),0);
 // Replay: the same request id with the same content opens no batch, even with a stale revision; other content is refused.
 const replay=await recordRetirementDecision(env,decisionFor(ODYSSEY));
 assert.deepEqual([replay.replayed,replay.seq],[true,1]);
 assert.equal(env.DB.calls.batches,batches+1,'a replay writes nothing');
 await assert.rejects(()=>recordRetirementDecision(env,{...decisionFor(ODYSSEY),confirmation:{...OWNER_CONFIRMATION,source:'https://trello.com/c/other'}}),code('retirement_replay_mismatch'));
 // A second active retire of the same Film (new request id) and a stale revision are refused with nothing written.
 await assert.rejects(()=>recordRetirementDecision(env,{...decisionFor(ODYSSEY),requestId:'again',expectedRevision:2}),code('tmdb_retirement_active'));
 await assert.rejects(()=>recordRetirementDecision(env,{...decisionFor(TESS),expectedRevision:7}),code('film_person_revision_conflict'));
 assert.equal(one(file,'SELECT COUNT(*) FROM tmdb_retirement_decision'),1);
 // There is no implicit un-retirement: the Film stays retired until an explicit owner restore.
 assert.equal((await currentRetirements(env,['film:1IUo'])).get('film:1IUo').state,'retire');
 const restoreInput={requestId:'restore-1',kind:'restore',filmId:'film:1IUo',lid:'1IUo',movieId:'17266',tvId:'9687',expectedRevision:2,at:AT,supersedesSeq:1,evidence:{reason:'owner reviewed the Letterboxd link again'},confirmation:{by:'owner',at:'2026-11-08',source:'https://trello.com/c/inverse'}};
 for(const bad of [{movieId:'999'},{tvId:'1'},{supersedesSeq:2},{confirmation:{by:'owner',at:'t'}}])await assert.rejects(()=>recordRetirementDecision(env,{...restoreInput,...bad}),error=>/^(retirement_invalid|tmdb_restore_invalid)$/.test(error.code));
 const restored=await recordRetirementDecision(env,restoreInput);
 assert.deepEqual([restored.seq,restored.revision],[2,3]);
 assert.equal((await currentRetirements(env,['film:1IUo'])).get('film:1IUo').state,'restore');
 await assert.rejects(()=>recordRetirementDecision(env,{...restoreInput,requestId:'restore-2',expectedRevision:3}),code('tmdb_restore_invalid'),'only the latest retire can be reversed, once');
 // Retiring again after a restore is a new explicit owner decision.
 const again=await recordRetirementDecision(env,{...decisionFor(ODYSSEY),requestId:'retire-again',expectedRevision:3,confirmation:{by:'owner',at:'2026-11-09',source:'https://trello.com/c/again'}});
 assert.equal(again.seq,3);
 // The full history is kept, in order, with the evidence and the confirmations, and cannot be changed.
 const history=await retirementHistory(env,'film:1IUo');
 assert.deepEqual(history.map(item=>[item.seq,item.kind,item.requestId,item.supersedesSeq]),[[1,'retire','req-1IUo',null],[2,'restore','restore-1',1],[3,'retire','retire-again',null]]);
 assert.equal(history[0].evidence.movieStatus,404);assert.equal(history[1].evidence.reason,'owner reviewed the Letterboxd link again');
 assert.deepEqual(history.map(item=>item.confirmation.by),['owner','owner','owner']);
 refused(file,"UPDATE tmdb_retirement_decision SET kind='retire' WHERE seq=2",/tmdb_retirement_append_only/);
 // Another Film is independent.
 assert.equal((await recordRetirementDecision(env,decisionFor(TESS))).seq,4);
 assert.deepEqual([...(await currentRetirements(env,['film:1IUo','film:3tCe','film:none'])).entries()].map(([id,item])=>[id,item.state]),[['film:1IUo','retire'],['film:3tCe','retire']]);
}

// 5. Held cases: a typed collision or an identity mismatch is refused, never written; tmdb and tmdb_tv are different namespaces.
{
 const file=database({open:true});
 const env=state(file);
 await seedFilm(env,ODYSSEY);await seedFilm(env,TESS);
 const other=await mutateFilm(env,{id:'film:other',expectedRevision:0,at:AT,film:{contractVersion:1,externalIds:[{scheme:'tmdb_tv',value:ODYSSEY.tvId,trusted:true}]}});
 await assert.rejects(()=>recordRetirementDecision(env,decisionFor(ODYSSEY)),code('retirement_tv_collision'),'another Film trusts the TV entry');
 // The same NUMBER as a movie id on another Film is not a collision (separate namespaces).
 await mutateFilm(env,{id:'film:num',expectedRevision:0,at:AT,film:{contractVersion:1,externalIds:[{scheme:'tmdb',value:ODYSSEY.tvId,trusted:true}]}});
 assert.equal((await recordRetirementDecision(env,decisionFor(TESS))).seq,1,'a movie id equal to a TV number does not block');
 // Another Film trusting the retired movie id is the same entry twice: held.
 // (The one-trusted-owner index forbids two trusted owners, so the Film's own row is untrusted first, as after a partial correction.)
 assert.equal(sqlite(file,"UPDATE film_external_id SET trusted=0 WHERE film_id='film:1IUo' AND scheme='tmdb';INSERT INTO film (id,contract_version,updated_at) VALUES ('film:dup',1,'t');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:dup','tmdb','"+ODYSSEY.movieId+"',1,0)").status,0);
 sqlite(file,"DELETE FROM film_external_id WHERE film_id='film:other'");
 await assert.rejects(()=>recordRetirementDecision(env,decisionFor(ODYSSEY)),code('retirement_movie_on_other_film'));
 sqlite(file,"DELETE FROM film_external_id WHERE film_id='film:dup';UPDATE film_external_id SET trusted=1 WHERE film_id='film:1IUo' AND scheme='tmdb'");
 // The Film must carry the retired movie id, and no other trusted TMDB id of either scheme.
 const orphan=CONFIRMED_RETIREMENTS[2],mismatch=CONFIRMED_RETIREMENTS[3];
 await seedFilm(env,orphan,{tmdb:null});await seedFilm(env,mismatch,{tmdb:'555'});
 await assert.rejects(()=>recordRetirementDecision(env,decisionFor(orphan)),code('retirement_movie_missing'));
 await assert.rejects(()=>recordRetirementDecision(env,decisionFor(mismatch)),code('retirement_movie_missing'),'a different movie id is not the retired one');
 sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+mismatch.filmId+"','tmdb','"+mismatch.movieId+"',0,0)");
 await assert.rejects(()=>recordRetirementDecision(env,decisionFor(mismatch)),code('retirement_identity_mismatch'),'it trusts another movie id');
 // A missing Film and a redirect.
 await assert.rejects(()=>recordRetirementDecision(env,{...decisionFor(ODYSSEY),filmId:'film:ghost',lid:'ghost',requestId:'g'}),code('film_person_reference'));
 sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:num','film:other','t')");
 assert.equal(one(file,'SELECT COUNT(*) FROM tmdb_retirement_decision'),1,'only the one valid decision exists');
 // A held decision writes nothing and moves no revision.
 assert.equal(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:1IUo'"),1);
 assert.equal(other.revision,1);
}

// 6. Races and crashes: a marker that moved, an entity that moved, a TV entry taken between the read and the batch, and the same request twice at once.
{
 const file=database({open:true});
 const env=state(file);
 await seedFilm(env,ODYSSEY);await seedFilm(env,TESS);
 const racing=sql=>({DB:d1Standin(file,{onBatch:async()=>{sqlite(file,sql);}})});
 await assert.rejects(()=>recordRetirementDecision(racing("UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1"),decisionFor(ODYSSEY)),code('film_person_fence'));
 sqlite(file,"UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1");
 await assert.rejects(()=>recordRetirementDecision(racing("INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:1IUo',2,'t') ON CONFLICT(kind,id) DO UPDATE SET revision=2"),decisionFor(ODYSSEY)),code('film_person_revision_conflict'));
 // Another Film starts trusting the TV entry after the read: the in-batch assertion fails the whole batch.
 await assert.rejects(()=>recordRetirementDecision(racing("INSERT INTO film (id,contract_version,updated_at) VALUES ('film:late',1,'t');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:late','tmdb_tv','"+ODYSSEY.tvId+"',1,0)"),{...decisionFor(ODYSSEY),expectedRevision:2}),code('film_person_precondition'));
 sqlite(file,"DELETE FROM film_external_id WHERE film_id='film:late'");
 assert.equal(one(file,'SELECT COUNT(*) FROM tmdb_retirement_decision'),0,'every raced attempt wrote nothing');
 // The Film's OWN typed ids change between the read and the batch: the decision is not appended on stale identity evidence.
 const own=(label,change,restore)=>async()=>{
  await assert.rejects(()=>recordRetirementDecision(racing(change),{...decisionFor(ODYSSEY),expectedRevision:Number(one(file,"SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:1IUo'),0)"))}),code('film_person_precondition'),label);
  assert.equal(one(file,'SELECT COUNT(*) FROM tmdb_retirement_decision'),0,label+': no decision row');
  assert.equal(one(file,'SELECT COUNT(*) FROM tmdb_retirement_current'),0,label+': no history state');
  sqlite(file,restore);
 };
 const FILM="film:1IUo";
 await own('the own tmdb row removed',"DELETE FROM film_external_id WHERE film_id='"+FILM+"' AND scheme='tmdb'","INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+FILM+"','tmdb','"+ODYSSEY.movieId+"',1,0)")();
 await own('the own tmdb row became conflicting',"UPDATE film_external_id SET conflicting=1 WHERE film_id='"+FILM+"' AND scheme='tmdb'","UPDATE film_external_id SET conflicting=0 WHERE film_id='"+FILM+"' AND scheme='tmdb'")();
 await own('the own tmdb row now names another movie id',"UPDATE film_external_id SET value='999' WHERE film_id='"+FILM+"' AND scheme='tmdb'","UPDATE film_external_id SET value='"+ODYSSEY.movieId+"' WHERE film_id='"+FILM+"' AND scheme='tmdb'")();
 await own('another trusted movie id appeared on the Film',"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+FILM+"','tmdb','888',1,0)","DELETE FROM film_external_id WHERE film_id='"+FILM+"' AND value='888'")();
 await own('another trusted TV id appeared on the Film',"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+FILM+"','tmdb_tv','777',1,0)","DELETE FROM film_external_id WHERE film_id='"+FILM+"' AND value='777'")();
 // Control: a Film with the same shape and nothing changing gets exactly one decision (the assertions do not refuse a valid decision), and an
 // untrusted extra id of the Film is not an identity conflict.
 const ctlFile=database({open:true}),ctlEnv=state(ctlFile),ctl=CONFIRMED_RETIREMENTS[2];
 await seedFilm(ctlEnv,ctl);
 sqlite(ctlFile,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+ctl.filmId+"','tmdb_tv','4242',0,0)");
 assert.equal((await recordRetirementDecision(ctlEnv,decisionFor(ctl))).replayed,false);
 assert.equal(one(ctlFile,'SELECT COUNT(*) FROM tmdb_retirement_decision'),1);
 // The same request written by a concurrent writer between the read and the batch: the same content is a replay, other content is a mismatch.
 const insertSame=(over='')=>"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) VALUES ('same','film:3tCe','retire','3tCe','101915','8042','{}','{\"by\":\"owner\",\"at\":\"t\",\"source\":\"s\"}','owner_request',NULL,NULL,'"+over+"','t')";
 const input=decisionFor(TESS,{requestId:'same',expectedRevision:1});
 const payload=normalizeDecision(input).payload.replace(/'/g,"''");
 assert.deepEqual((({replayed,seq})=>({replayed,seq}))(await recordRetirementDecision(racing(insertSame(payload)),input)),{replayed:true,seq:1});
 const other=insertSame('{}').replace("'same'","'same2'").replace("'film:3tCe'","'film:1IUo'").replace("'3tCe'","'1IUo'").replace("'101915'","'17266'").replace("'8042'","'9687'");
 await assert.rejects(()=>recordRetirementDecision(racing(other),decisionFor(ODYSSEY,{requestId:'same2'})),code('retirement_replay_mismatch'));
}

// 7. Compare-only: the current D1 state against a prepared import (the real load is a later, owner-gated card).
{
 const file=database({open:true});
 const env=state(file);
 for(const item of CONFIRMED_RETIREMENTS)await seedFilm(env,item);
 const prepared=prepareRetirementImport(body(),{sha256:'b'.repeat(64)});
 assert.deepEqual(compareRetirementImport(await currentRetirements(env,CONFIRMED_RETIREMENTS.map(item=>item.filmId)),prepared),{same:[],missing:CONFIRMED_RETIREMENTS.map(item=>item.filmId),restored:[],differs:[],extra:[]});
 // Loading the prepared decisions is a replay-safe sequence of fenced writes; run twice, it adds nothing the second time.
 const load=async()=>{const out=[];for(const item of prepared.decisions){const revision=Number(one(file,"SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+item.filmId+"'),0)"));out.push(await recordRetirementDecision(env,{...item,expectedRevision:revision,at:AT}));}return out;};
 assert.deepEqual((await load()).map(item=>item.replayed),[false,false,false,false]);
 assert.deepEqual((await load()).map(item=>item.replayed),[true,true,true,true],'a second load is all replays');
 assert.equal(one(file,'SELECT COUNT(*) FROM tmdb_retirement_decision'),4);
 assert.deepEqual(compareRetirementImport(await currentRetirements(env,CONFIRMED_RETIREMENTS.map(item=>item.filmId)),prepared).same.length,4);
 // An owner restore after the load stands: the object is not re-applied, and the comparison says so.
 const revision=Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:1IUo'"));
 await recordRetirementDecision(env,{requestId:'inv',kind:'restore',filmId:'film:1IUo',lid:'1IUo',movieId:'17266',tvId:'9687',expectedRevision:revision,at:AT,supersedesSeq:1,evidence:{reason:'owner decided'},confirmation:{by:'owner',at:'t',source:'s'}});
 const after=compareRetirementImport(await currentRetirements(env,CONFIRMED_RETIREMENTS.map(item=>item.filmId)),prepared);
 assert.deepEqual([after.restored,after.same.length],[['film:1IUo'],3]);
 assert.deepEqual((await load()).map(item=>item.replayed),[true,true,true,true],'the load does not re-apply a restored Film');
 // Differences and extras are reported.
 const cur=new Map([['film:1IUo',{state:'retire',movieId:'1',tvId:'2'}],['film:zzz',{state:'retire',movieId:'3',tvId:'4'}]]);
 const cmp=compareRetirementImport(cur,prepared);
 assert.deepEqual([cmp.differs,cmp.extra],[['film:1IUo'],['film:zzz']]);
}

// 8. A Film with a decision is not merged away silently; the history outlives it. Merges of other Films are unchanged.
{
 const file=database({open:true});
 const env=state(file);
 await seedFilm(env,ODYSSEY);
 await mutateFilm(env,{id:'film:keep',expectedRevision:0,at:AT,film:{contractVersion:1}});
 await mutateFilm(env,{id:'film:plain',expectedRevision:0,at:AT,film:{contractVersion:1}});
 await recordRetirementDecision(env,decisionFor(ODYSSEY));
 await assert.rejects(()=>mergeFilms(env,{from:'film:1IUo',to:'film:keep',expected:{from:2,to:1},at:AT,evidence:{verified:true}}),code('film_person_retirement_history'));
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='film:1IUo'"),1,'nothing merged');
 assert.equal((await mergeFilms(env,{from:'film:plain',to:'film:keep',expected:{from:1,to:1},at:AT,evidence:{verified:true}})).merged,true);
 // Before schema 16 a merge behaves as in AIR-367.
 const v14=database({apply:false,open:true});const env2=state(v14);
 await mutateFilm(env2,{id:'film:a',expectedRevision:0,at:AT,film:{contractVersion:1}});await mutateFilm(env2,{id:'film:b',expectedRevision:0,at:AT,film:{contractVersion:1}});
 assert.equal((await mergeFilms(env2,{from:'film:a',to:'film:b',expected:{from:1,to:1},at:AT,evidence:{verified:true}})).merged,true);
}

// 9. Static: inactive. No source file imports the module, the build does not bundle it, nothing writes the R2 object or the projector's path.
{
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('tmdb-retirement-decisions'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers.filter(file=>!file.endsWith('tmdb-retirement-decisions.js')),[],'no source file imports it');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('tmdb-retirement-decisions'),file+' does not bundle or name it');
 const module=fs.readFileSync('src/tmdb-retirement-decisions.js','utf8');
 assert.doesNotMatch(module,/\bfetch\(|\.put\(|env\.R2|\.BUCKET|\.get\(RETIREMENTS_KEY|INSERT INTO film_external_id|UPDATE film_external_id|DELETE FROM film_external_id|UPDATE film\b|INSERT INTO film_dimension/,'no R2 access and no identity write');
 assert.ok(!/tmdb_retirement_decision/.test(fs.readFileSync('src/canonical-repository.js','utf8')),'the projector path does not write the ledger');
 assert.ok(fs.readFileSync('migrations/README.md','utf8').includes(NEW),'migrations/README.md lists 0016');
}

console.log('tmdb-retirement-decisions: migration 0016 refuses anything but a complete v15 (a v14, a hollow v15 and a v14 carrying the 0015 tables change nothing) and creates one empty append-only table; invalid input stops before any SQL and the prepare-only loader validates exactly like tmdbRetirementSet; the writer refuses unless the marker is open, is fenced and revision-checked, replay-safe, holds typed collisions, and only an explicit owner restore reverses a retirement; the history is kept; the module is inactive');
