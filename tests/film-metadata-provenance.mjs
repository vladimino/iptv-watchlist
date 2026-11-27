// AIR-631 (card PV1, ADR 0214 Accepted): per-field provenance of film_metadata, on REAL SQLite (the sqlite3-CLI D1 stand-in). Offline only: no Worker, R2, TMDB or production access; synthetic ids; the module stays dormant.
// One template database per stage is built from the whole migration chain and copied per scenario.
//  1. the synchronous SHA-256 equals crypto, and the writer's anchor digest equals the planner's (ADR 0211 3b);
//  2. schema absent and mode `off` write today's rows (statements byte-identical, no field row) and the control fence is asserted at `off`;
//  3. binding, invalidation and declaration: A -> B -> A, delete + identical re-insert, move + re-create, a digest mismatch, an undeclared write, a future `observedAt`;
//  4. identity gates and races: an anchor change, a competing claim and a retirement after the plan; a disagreement; a mode switch after the plan;
//  5. the comparator: every rank row, adoption, refresh, an older observation, a lower precedence, superseded values, 0214-4 = B, and CONVERGENCE over every permutation;
//  6. locks and triggers: pins, the dimension lock, raw old-code statements, the release row, history and command immutability, the protection signal;
//  7. modes: the three legal transitions, hold fills and adopts only, pins survive enforce -> hold -> enforce, fail-closed;
//  8. owner actions (set, lock of an unknown value, release, revert, blank_field, identity_unknown, anchor_changed), the command record;
//  9. destructive paths: the clear rules and the field-wise merge;
// 10. bounds: real core, owner and merge batches stay within 60 statements, the caller's guards within 12.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {mutateFilm,mergeFilms,MUTATION_STATEMENT_CAP} from '../src/canonical-mutations.js';
import {planFilmFacts,readFilmSnapshot,writeFilmFacts} from '../src/canonical-film-writers.js';
import {filmFactsOf} from '../src/canonical-producer-workflow.js';
import {sha256Hex,valueDigest} from '../src/film-metadata-provenance.js';
import {anchorDigest,computeAnchors} from '../src/catalog-enrichment-plan.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-provenance-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sql=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const exec=(file,text)=>{const r=sqlite(file,text);if(r.status!==0)throw new Error(r.stderr);};
const fails=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'must be refused: '+text.slice(0,100));if(pattern)assert.match(String(r.stderr),pattern);};
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const templates={};
function template(stage){
 if(templates[stage])return templates[stage];
 const file=path.join(root,'tpl-'+stage+'.sqlite');
 const upTo=stage==='v48'?chain.findIndex(name=>name.startsWith('0049_')):chain.length;
 assert.equal(sqlite(file,chain.slice(0,upTo).map(sql).join('\n')).status,0);
 assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 return templates[stage]=file;
}
let n=0;
function fresh(stage='open'){
 const file=path.join(root,'w-'+(n++)+'.sqlite');
 fs.copyFileSync(template(stage),file);
 return {file,env:{DB:d1Standin(file)}};
}
const T='2026-11-27T10:00:00.000Z',T1='2026-11-27T10:00:01.000Z',T2='2026-11-27T11:00:00.000Z',T3='2026-11-27T12:00:00.000Z',OLD='2026-11-20T10:00:00.000Z';
const ID='film:tmdb:603';
const setMode=(file,mode)=>exec(file,`UPDATE film_metadata_provenance_control SET mode='${mode}',revision=revision+1,updated_at='${T}',updated_by='test' WHERE id=1`);
async function seed(env,{lid='lid603',tmdb='603',id=ID}={}){
 return mutateFilm(env,{id,expectedRevision:0,at:T,film:{contractVersion:1,originalTitle:'The Matrix',externalIds:[{scheme:'tmdb',value:tmdb,trusted:true},...(lid?[{scheme:'letterboxd',value:lid,trusted:true}]:[])],aliases:[]}});
}
const revisionOf=async(env,id=ID)=>(await readFilmSnapshot(env,id)).revision;
const digestOfFilm=async(env,id=ID)=>(await readFilmSnapshot(env,id)).provenance.anchors.digest;
let counter=0;
const req=()=>'req-'+(++counter);
// A declared (catalog enrichment) write of one or more fields.
async function declare(env,fields,{source='letterboxd',at=T,observedAt=at,agree=true,id=ID,requestId=req(),guards,rev}={}){
 const digest=await digestOfFilm(env,id),snapshot=await readFilmSnapshot(env,id);
 const anchor=snapshot.provenance.anchors.computed[source];
 const declared=Object.fromEntries(Object.keys(fields).map(field=>[field,{source,anchor:{scheme:source,value:anchor?.value??'x'},observedAt,agreedAnchorDigest:agree?digest:null}]));
 return writeFilmFacts(env,{id,at,requestId,expectedRevision:rev??snapshot.revision,film:{contractVersion:1},metadata:{updatedAt:at,declared,...fields},requireExisting:true,...(guards?{guards}:{})});
}
// An undeclared write (the EPG callers).
async function undeclared(env,fields,{at=T,id=ID,requestId=req()}={}){
 return writeFilmFacts(env,{id,at,requestId,expectedRevision:await revisionOf(env,id),film:{contractVersion:1},metadata:{updatedAt:at,...fields},requireExisting:true});
}
// The owner authority (the route sets it; PV3). `actions` are the owner actions of ADR 0214 decision 9.
async function owner(env,actions,{at=T,id=ID,requestId=req(),command}={}){
 return writeFilmFacts(env,{id,at,requestId,expectedRevision:await revisionOf(env,id),film:{contractVersion:1},metadata:{updatedAt:at,ownerActions:actions},metadataAuthority:{authority:'owner',origin:'owner_route'},requireExisting:true,...(command?{ownerCommand:command}:{})});
}
const fieldRows=(file,id=ID)=>rows(file,`SELECT * FROM film_metadata_field WHERE film_id='${id}' ORDER BY field`);
const field=(file,name,id=ID)=>fieldRows(file,id).find(item=>item.field===name);
const meta=(file,id=ID)=>rows(file,`SELECT * FROM film_metadata WHERE film_id='${id}'`)[0];
const history=file=>rows(file,'SELECT * FROM film_metadata_history ORDER BY id');
const CMD=text=>sha256Hex(text);
// Runs `statement` once, right before the writer's batch: the state the plan read moves under it (a race).
function racing(env,file,statement){
 let armed=true;
 return {DB:{...env.DB,prepare:env.DB.prepare,batch:async list=>{if(armed){armed=false;exec(file,statement);}return env.DB.batch(list);}}};
}

// ---- 1. the digests ----
for(const text of ['','a','abc','x'.repeat(55),'x'.repeat(56),'x'.repeat(63),'x'.repeat(64),'x'.repeat(65),'ёжик 日本語 '.repeat(40),JSON.stringify({a:[1,2,3]})]){
 assert.equal(sha256Hex(text),crypto.createHash('sha256').update(text).digest('hex'),'sha256 of '+text.length+' chars equals crypto');
}
{
 const rowsOfAnchors=[{scheme:'tmdb',value:'603',trusted:1,conflicting:0,otherOwner:false,retired:false},{scheme:'letterboxd',value:'lid603',trusted:1,conflicting:0,otherOwner:false,retired:false}];
 const {env}=fresh();await seed(env);
 const snapshot=await readFilmSnapshot(env,ID);
 assert.equal(snapshot.provenance.mode,'off');
 assert.equal(snapshot.provenance.anchors,null,'at off only the control row is read');
 const {file,env:env2}=fresh();await seed(env2);setMode(file,'enforce');
 const again=await readFilmSnapshot(env2,ID);
 assert.equal(again.provenance.anchors.digest,await anchorDigest(computeAnchors(rowsOfAnchors)),'the writer derives the SAME digest as the C1 planner (ADR 0211 3b)');
}

// ---- 2. schema absent and mode `off` ----
{
 const absent=fresh('v48'),off=fresh();
 await seed(absent.env);await seed(off.env);
 assert.equal((await readFilmSnapshot(absent.env,ID)).provenance,null,'schema absent reads null');
 const input={id:ID,at:T,requestId:'r',expectedRevision:1,film:{contractVersion:1},metadata:{updatedAt:T,year:1999,runtime:136,synopsis:'S',poster:'/p',url:'https://e.test/m',genres:['a'],declared:{year:{source:'letterboxd',anchor:{scheme:'letterboxd',value:'lid603'},observedAt:T,agreedAnchorDigest:null}}}};
 const planAbsent=planFilmFacts(await readFilmSnapshot(absent.env,ID),input),planOff=planFilmFacts(await readFilmSnapshot(off.env,ID),input);
 assert.deepEqual(planOff.statements,planAbsent.statements,'schema absent and `off` produce byte-identical statements (the declaration is ignored)');
 assert.deepEqual(planAbsent.guards,[]);assert.equal(planAbsent.control,null,'no control fence while the table is absent');
 assert.deepEqual(planOff.control,{mode:'off',revision:1},'`off` asserts the mode and revision it planned under');
 await writeFilmFacts(off.env,input);await writeFilmFacts(absent.env,input);
 assert.equal(fieldRows(off.file).length,0,'`off` writes no field row');
 assert.deepEqual(meta(off.file).year,1999);
 // owner actions and authority are refused while nothing is enforced
 await assert.rejects(owner(off.env,[{action:'set',field:'year',value:2000}]),error=>error.code==='film_person_precondition');
 await assert.rejects(owner(absent.env,[{action:'set',field:'year',value:2000}]),error=>error.code==='film_person_precondition');
 // a batch planned at `off` fails on the revision after off -> enforce, and replans
 const later=fresh();await seed(later.env);
 const input2={...input,requestId:'r2'};
 await assert.rejects(writeFilmFacts(racing(later.env,later.file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=revision+1,updated_at='"+T+"',updated_by='t' WHERE id=1"),input2),/.+/);
 assert.equal(rows(later.file,'SELECT COUNT(*) c FROM film_metadata')[0].c,0,'nothing written by the stale plan');
 await writeFilmFacts(later.env,input2);
 assert.equal(fieldRows(later.file).length,1,'the replan writes the attributed row');
}
// the control row: an absent row while the table exists fails the write closed; an unreadable mode too
{
 const {file,env}=fresh();await seed(env);
 sqlite(file,'PRAGMA foreign_keys=OFF;DROP TRIGGER film_metadata_provenance_no_delete;DELETE FROM film_metadata_provenance_control');
 await assert.rejects(readFilmSnapshot(env,ID),error=>error.code==='film_person_unavailable');
 await assert.rejects(undeclared(env,{year:1999}),error=>error.code==='film_person_unavailable');
}

// ---- 3. binding, invalidation, declaration ----
{
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 const done=await declare(env,{year:1999,runtime:136,genres:['sci-fi'],synopsis:'A hacker.'});
 assert.equal(done.written,true);
 const row=field(file,'year');
 assert.deepEqual([row.tier,row.source,row.origin,row.anchor_scheme,row.anchor_value,row.agreement,row.observed_at],['automatic','letterboxd','catalog_enrichment','letterboxd','lid603','confirmed',T]);
 assert.equal(row.value_digest,valueDigest(1999),'the row is bound to its value by the digest of its canonical JSON');
 assert.equal(row.anchor_digest,await digestOfFilm(env));
 assert.equal(field(file,'genres').value_digest,valueDigest(['sci-fi']));
 assert.equal(rows(file,'SELECT COUNT(*) c FROM film_metadata_history')[0].c,0,'a fill adds no history');
 // A -> B -> A: raw old-code statements leave the field unknown, only the changed field loses its row
 exec(file,`UPDATE film_metadata SET year=2000 WHERE film_id='${ID}'`);
 assert.equal(field(file,'year'),undefined,'the raw change removed the stale row');
 assert.ok(field(file,'runtime'),'an unchanged field keeps its row');
 exec(file,`UPDATE film_metadata SET year=1999 WHERE film_id='${ID}'`);
 assert.equal(field(file,'year'),undefined,'back to A: the earlier occurrence is never resurrected');
 // delete and identical re-insert
 const before=meta(file);
 exec(file,`DELETE FROM film_metadata WHERE film_id='${ID}'`);
 assert.equal(fieldRows(file).length,0,'a delete removes every non-owner field row');
 exec(file,`INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES ('${ID}',${before.schema_version},${before.year},${before.runtime},'${before.synopsis}',NULL,NULL,'${before.genres_json}',NULL,'{}',NULL,NULL,'${T}')`);
 assert.equal(fieldRows(file).length,0,'an identical re-insert leaves every field unknown');
}
{
 // a move and re-create: the old rows are not carried to the new occurrence
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await seed(env,{id:'film:tmdb:7',tmdb:'7',lid:null});
 await declare(env,{year:1999,runtime:136});
 exec(file,`PRAGMA foreign_keys=OFF;UPDATE film_metadata SET film_id='film:tmdb:9' WHERE film_id='${ID}'`);
 assert.equal(fieldRows(file).length,0,'a move removes the rows under the old id');
 assert.equal(fieldRows(file,'film:tmdb:9').length,0,'and none appears under the new id');
}
{
 // a digest mismatch reads unknown and is counted; an undeclared write replaces an unknown value with history
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await declare(env,{runtime:136});
 exec(file,`UPDATE film_metadata_field SET value_digest='${'0'.repeat(64)}' WHERE field='runtime'`);
 const result=await undeclared(env,{runtime:140},{at:T1});
 assert.equal(result.provenance.provenance_mismatch,1,'the mismatch is reported');
 assert.equal(meta(file).runtime,140,'an unknown value is replaced by an undeclared write');
 assert.equal(field(file,'runtime'),undefined,'and its field row is deleted (the value reads unknown)');
 const [h]=history(file);
 assert.deepEqual([h.reason,h.old_value_text,h.old_tier,h.new_value_digest],['replaced','136',null,valueDigest(140)],'history keeps the old value; the unknown old row leaves NULL semantic columns');
}
{
 // an undeclared write: fills a blank, never replaces an attributed value, in hold only fills
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 const filled=await undeclared(env,{year:1999});
 assert.equal(meta(file).year,1999);assert.equal(fieldRows(file).length,0,'an undeclared fill carries no provenance (unknown)');assert.equal(filled.provenance.fills,1);
 await declare(env,{runtime:136});
 const refused=await undeclared(env,{runtime:150});
 assert.equal(meta(file).runtime,136,'an undeclared write never replaces an attributed value');
 assert.deepEqual(refused.skipped.map(item=>item.reason),['attributed_kept']);
 assert.equal(history(file).length,0);
 setMode(file,'hold');
 const held=await undeclared(env,{year:2005});
 assert.equal(meta(file).year,1999,'in hold an undeclared write only fills');assert.deepEqual(held.skipped.map(item=>item.reason),['hold_fill_only']);
}
{
 // a future observedAt (more than 60 s past the write clock) is film_person_invalid
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await assert.rejects(declare(env,{year:1999},{at:T,observedAt:'2026-11-27T10:05:00.000Z'}),error=>error.code==='film_person_invalid');
 await declare(env,{year:1999},{at:T,observedAt:'2026-11-27T10:00:30.000Z'});
 assert.equal(meta(file).year,1999,'within the 60 s slack it is accepted');
 await assert.rejects(declare(env,{runtime:1},{at:T}).then(()=>writeFilmFacts(env,{id:ID,at:T,requestId:req(),expectedRevision:99,film:{contractVersion:1},metadata:{updatedAt:T,declared:{runtime:{source:'wikidata',anchor:{scheme:'wikidata',value:'q'},observedAt:T}},runtime:3}})),/.+/,'an undeclarable source is refused');
}

// ---- 4. identity gates and races ----
{
 const world=async()=>{const w=fresh();await seed(w.env);setMode(w.file,'enforce');return w;};
 const RETIRE=`INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('ret-1','${ID}','retire','lid603','603','77','{}','{"by":"owner","at":"${T}","source":"t"}','owner_request','{}','${T}')`;
 const races={
  'an anchor value changed (lid L -> L2)':`UPDATE film_external_id SET value='lid-other' WHERE film_id='${ID}' AND scheme='letterboxd'`,
  'a competing trusted claim of the Film (a second lid)':`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('${ID}','letterboxd','lid-second',1,0)`,
  'a retirement of the tmdb id':RETIRE,
 };
 for(const [name,statement] of Object.entries(races)){
  const {file,env}=await world();
  const snapshot=await readFilmSnapshot(env,ID),digest=snapshot.provenance.anchors.digest;
  const planned={id:ID,at:T,requestId:req(),expectedRevision:snapshot.revision,film:{contractVersion:1},requireExisting:true,metadata:{updatedAt:T,year:1999,declared:{year:{source:'letterboxd',anchor:{scheme:'letterboxd',value:'lid603'},observedAt:T,agreedAnchorDigest:digest}}}};
  await assert.rejects(writeFilmFacts(racing(env,file,statement),planned),error=>error.code==='film_person_precondition',name+': the planned anchor set no longer holds, the batch fails');
  assert.equal(meta(file),undefined,name+': nothing written');
  assert.equal(fieldRows(file).length,0,name+': no field row');
 }
 {
  // an undeclared batch is NOT blocked by an anchor change (it claims no anchor)
  const {file,env}=await world();
  const snapshot=await readFilmSnapshot(env,ID);
  const done=await writeFilmFacts(racing(env,file,races['an anchor value changed (lid L -> L2)']),{id:ID,at:T,requestId:req(),expectedRevision:snapshot.revision,film:{contractVersion:1},requireExisting:true,metadata:{updatedAt:T,year:1999}});
  assert.equal(done.written,true);
 }
 // a known disagreement blocks every declared write (fills included) but not an undeclared fill or an owner set
 const {file,env}=await world();
 exec(file,`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at,plan_epoch) VALUES ('${ID}','film','*',0,'identity_disagreement','${T}','${T}',0)`);
 await assert.rejects(declare(env,{year:1999}),error=>error.code==='film_person_precondition','a declared fill is blocked by a disagreement (the batch asserts its absence)');
 assert.equal(meta(file)?.year??null,null,'nothing written');
 const bare=await undeclared(env,{year:1999});
 assert.equal(meta(file).year,1999,'an undeclared fill is not blocked');assert.equal(bare.written,true);
 await owner(env,[{action:'set',field:'runtime',value:140}]);
 assert.equal(meta(file).runtime,140,'an owner set during a disagreement works');
}
{
 // a mode switch after the plan: enforce -> hold fails the in-flight replacement, which replans as a fill
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await declare(env,{runtime:112},{source:'tmdb',agree:false});
 const switching=racing(env,file,"UPDATE film_metadata_provenance_control SET mode='hold',revision=revision+1,updated_at='"+T+"',updated_by='t' WHERE id=1");
 const snapshot=await readFilmSnapshot(env,ID),digest=snapshot.provenance.anchors.digest;
 await assert.rejects(writeFilmFacts(switching,{id:ID,at:T1,requestId:req(),expectedRevision:snapshot.revision,film:{contractVersion:1},metadata:{updatedAt:T1,runtime:110,declared:{runtime:{source:'letterboxd',anchor:{scheme:'letterboxd',value:'lid603'},observedAt:T1,agreedAnchorDigest:digest}}}}),/.+/);
 assert.equal(meta(file).runtime,112,'the stale replacement did not commit');
 const replanned=await declare(env,{runtime:110},{at:T1});
 assert.equal(meta(file).runtime,112,'in hold the replan only fills: the value stays');assert.deepEqual(replanned.skipped.map(item=>item.reason),['hold_fill_only']);
}

// ---- 5. the comparator ----
const batchSize=env=>{const seen={size:0};return {seen,env:{DB:{...env.DB,prepare:env.DB.prepare,batch:async list=>{seen.size=list.length;return env.DB.batch(list);}}}};};
{
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 // fallback recovery (ADR 0214 worked example 1): an unconfirmed tmdb value fills; the earlier source confirms and replaces it, history keeps the old
 await declare(env,{runtime:112},{source:'tmdb',agree:false,at:T});
 assert.equal(field(file,'runtime').agreement,'unconfirmed');
 const fallbackSkip=await declare(env,{runtime:99},{source:'tmdb',agree:false,at:T1});
 assert.equal(meta(file).runtime,112,'an unconfirmed value never replaces a different non-blank one (0214-4 = B)');assert.deepEqual(fallbackSkip.skipped.map(item=>item.reason),['stored_differs']);
 const adopt=await declare(env,{runtime:112},{source:'letterboxd',agree:true,at:T1});
 assert.equal(field(file,'runtime').source,'letterboxd');assert.equal(field(file,'runtime').agreement,'confirmed');assert.equal(history(file).length,0,'an equal confirmed observation ADOPTS the value, with no history');assert.equal(adopt.provenance.adoptions,1);
 const same=fresh();await seed(same.env);setMode(same.file,'enforce');
 await declare(same.env,{runtime:112},{source:'tmdb',agree:false,at:T});
 const replaced=await declare(same.env,{runtime:110},{source:'letterboxd',agree:true,at:T1});
 assert.equal(meta(same.file).runtime,110);assert.equal(replaced.provenance.replacements,1);
 const [h]=history(same.file);
 assert.deepEqual([h.reason,h.old_value_text,h.old_source,h.old_agreement,h.new_value_digest,h.new_source],['replaced','112','tmdb','unconfirmed',valueDigest(110),'letterboxd'],'history keeps the replaced value and its lineage');
 // never degrade: an equal value of lower confidence changes nothing
 const degrade=await declare(same.env,{runtime:110},{source:'letterboxd',agree:false,at:T2});
 assert.equal(degrade.written,false,'an equal unconfirmed observation over a confirmed one is a no-op');assert.equal(field(same.file,'runtime').agreement,'confirmed','confidence never degrades');
 // a lower precedence at equal confidence is refused; an older observation of the same rank is refused; a refresh (later) replaces; a newer equal value only touches checked_at
 const lower=await declare(same.env,{runtime:111},{source:'tmdb',agree:true,at:T2});
 assert.deepEqual(lower.skipped.map(item=>item.reason),['stored_differs']);assert.equal(meta(same.file).runtime,110,'tmdb (confirmed) does not replace letterboxd (confirmed)');
 const olderObs=await declare(same.env,{runtime:105},{at:T2,observedAt:OLD});
 assert.deepEqual(olderObs.skipped.map(item=>item.reason),['stored_differs']);assert.equal(meta(same.file).runtime,110,'an older observation never wins');
 const agreed=await declare(same.env,{runtime:110},{at:T3,observedAt:T1});
 assert.equal(agreed.provenance.agreed,1);const row=field(same.file,'runtime');assert.deepEqual([row.observed_at,row.checked_at],[T1,T3],'the same observation seen again by a later write updates checked_at only');
 const refresh=await declare(same.env,{runtime:115},{at:T3,observedAt:T3});
 assert.equal(meta(same.file).runtime,115);assert.equal(refresh.provenance.replacements,1,'a refresh: the same source and confidence, a later observation');
 assert.equal(history(same.file).length,2);
}
{
 // legacy (worked example 5): an undeclared value is unknown; an equal declared observation adopts it without history; a different CONFIRMED one replaces it with history; an unconfirmed one leaves it alone
 const a=fresh();await seed(a.env);setMode(a.file,'enforce');
 await undeclared(a.env,{year:1999,runtime:136});
 await declare(a.env,{year:1999,runtime:130},{source:'tmdb',agree:false,at:T1});
 assert.equal(field(a.file,'year').source,'tmdb','an unconfirmed equal observation adopts the unknown value');
 assert.equal(meta(a.file).runtime,136,'an unconfirmed observation leaves a different legacy value alone');
 assert.equal(history(a.file).length,0);
 await declare(a.env,{runtime:130},{at:T2});
 assert.equal(meta(a.file).runtime,130);assert.equal(history(a.file).length,1,'a confirmed observation replaces the legacy value, with history (the unknown old row leaves NULL columns)');
 assert.equal(history(a.file)[0].old_tier,null);
}
{
 // identity correction (worked example 4): every automatic row becomes superseded; only a confirmed observation under the NEW anchors replaces it; otherwise the value stays
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await declare(env,{year:1985,runtime:100},{at:T});
 exec(file,`UPDATE film_external_id SET value='lid-new' WHERE film_id='${ID}' AND scheme='letterboxd'`);
 const keep=await declare(env,{year:1986},{agree:false,at:T1});
 assert.equal(meta(file).year,1985,'an unconfirmed observation never replaces a superseded value');assert.deepEqual(keep.skipped.map(item=>item.reason),['stored_differs']);
 const equal=await declare(env,{runtime:100},{at:T1});
 assert.equal(field(file,'runtime').anchor_value,'lid-new','an equal confirmed observation adopts a superseded value');assert.equal(history(file).length,0);
 const fixed=await declare(env,{year:1987},{at:T2});
 assert.equal(meta(file).year,1987);assert.equal(fixed.provenance.replacements,1,'a confirmed observation under the current anchors replaces a superseded value');
 assert.equal(history(file)[0].old_anchor_value,'lid603','history keeps the identity the old value was written under');
 void equal;
}
{
 // CONVERGENCE: every permutation of a set of confirmed automatic observations of one field ends with the same projection
 const OBS=[
  {name:'a',source:'letterboxd',value:113,at:T1},
  {name:'b',source:'letterboxd',value:114,at:T1},
  {name:'c',source:'tmdb',value:113,at:T3},
  {name:'d',source:'letterboxd',value:110,at:T},
 ];
 const permutations=list=>list.length<=1?[list]:list.flatMap((item,index)=>permutations([...list.slice(0,index),...list.slice(index+1)]).map(rest=>[item,...rest]));
 const results=new Set();
 for(const order of permutations(OBS)){
  const {file,env}=fresh();await seed(env);setMode(file,'enforce');
  for(const item of order)await declare(env,{runtime:item.value},{source:item.source,observedAt:item.at,at:T3});
  const row=field(file,'runtime');
  results.add(JSON.stringify({value:meta(file).runtime,tier:row.tier,source:row.source,anchor:[row.anchor_scheme,row.anchor_value,row.anchor_digest],agreement:row.agreement,observed_at:row.observed_at,value_digest:row.value_digest}));
 }
 assert.equal(results.size,1,'24 orders of arrival end with one projection: '+[...results].join(' | '));
 const final=JSON.parse([...results][0]);
 assert.equal(final.source,'letterboxd','the higher precedence wins at equal confidence');
 assert.equal(final.observed_at,T1,'then the later observation');
 assert.equal(final.value,[113,114].sort((x,y)=>valueDigest(x)<valueDigest(y)?-1:1)[1],'and the digest breaks the tie deterministically');
}

// ---- 6. owner actions, locks and triggers ----
const historyAction=(row,field)=>({id:row.id,field,oldValueText:row.old_value_text,oldSource:row.old_source,oldAnchorScheme:row.old_anchor_scheme,oldAnchorValue:row.old_anchor_value,oldAnchorDigest:row.old_anchor_digest,oldObservedAt:row.old_observed_at});
const signals=file=>rows(file,"SELECT kind,subject,part FROM enrichment_signal WHERE kind='protection_released'");
{
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await declare(env,{year:1999,runtime:136,synopsis:'S1'});
 // set: an owner value over an attributed one (worked example 2)
 const set=await owner(env,[{action:'set',field:'year',value:2000}],{command:{requestId:'cmd-1',action:'set',digest:CMD('cmd-1')}});
 assert.equal(meta(file).year,2000);
 const pin=field(file,'year');
 assert.deepEqual([pin.tier,pin.source,pin.origin,pin.anchor_scheme,pin.agreement,pin.anchor_digest],['owner','owner','owner_route',null,null,await digestOfFilm(env)],'an owner value: no anchor, the Film digest at the set');
 assert.deepEqual(rows(file,'SELECT reason,old_value_text,old_source FROM film_metadata_history'),[{reason:'owner_set',old_value_text:'1999',old_source:'letterboxd'}]);
 assert.equal(rows(file,'SELECT COUNT(*) c FROM film_metadata_owner_release')[0].c,0,'the release row never stays');
 assert.equal(set.revision,await revisionOf(env),'the command bumped the Film revision');
 const command=rows(file,'SELECT request_id,film_id,action,outcome,applied_revision FROM film_metadata_owner_command')[0];
 assert.deepEqual([command.request_id,command.action,command.outcome,command.applied_revision],['cmd-1','set','applied',set.revision]);
 // a later Letterboxd 1999 is refused (owner_kept), the EPG 1999 is skipped, old code aborts on the trigger
 const lb=await declare(env,{year:1999},{at:T1});assert.deepEqual(lb.skipped.map(item=>item.reason),['owner_kept']);
 const epg=await undeclared(env,{year:1999});assert.deepEqual(epg.skipped.map(item=>item.reason),['owner_kept']);
 assert.equal(meta(file).year,2000);
 fails(file,`UPDATE film_metadata SET year=1999 WHERE film_id='${ID}'`,/film_metadata_owner_locked/);
 fails(file,`DELETE FROM film_metadata WHERE film_id='${ID}'`,/film_metadata_owner_locked/);
 fails(file,`PRAGMA foreign_keys=OFF;UPDATE film_metadata SET film_id='film:tmdb:9' WHERE film_id='${ID}'`,/film_metadata_owner_locked/);
 fails(file,`UPDATE film_metadata_field SET value_digest='${'1'.repeat(64)}' WHERE field='year'`,/film_metadata_owner_locked/);
 fails(file,`DELETE FROM film_metadata_field WHERE field='year'`,/film_metadata_owner_locked/);
 exec(file,`UPDATE film_metadata SET runtime=140 WHERE film_id='${ID}'`);assert.equal(field(file,'runtime'),undefined,'an unpinned field is still invalidated by a raw change');
 exec(file,`UPDATE film_metadata SET people_version=3 WHERE film_id='${ID}'`);assert.equal(meta(file).people_version,3,'a statement that changes none of the six value columns is never refused');
 // the same raw statements pass inside a batch that holds the release row; an abort leaves no release row
 exec(file,`BEGIN;INSERT INTO film_metadata_owner_release (film_id) VALUES ('${ID}');UPDATE film_metadata SET year=1998 WHERE film_id='${ID}';DELETE FROM film_metadata_owner_release WHERE film_id='${ID}';COMMIT;`);
 assert.equal(meta(file).year,1998,'a statement under the release row passes');
 fails(file,`BEGIN;INSERT INTO film_metadata_owner_release (film_id) VALUES ('${ID}');UPDATE film_metadata SET year=1997 WHERE film_id='film:nope';INSERT INTO film_metadata_history (film_id,field,reason,write_key,at) VALUES ('x','nope','replaced','k','${T}');COMMIT;`);
 assert.equal(rows(file,'SELECT COUNT(*) c FROM film_metadata_owner_release')[0].c,0,'an aborted batch leaves no release row');
 // history and the command record are immutable; a second insert of the same request id is refused
 fails(file,"UPDATE film_metadata_history SET reason='cleared'",/film_metadata_history_append_only/);
 fails(file,'DELETE FROM film_metadata_history',/film_metadata_history_append_only/);
 fails(file,"UPDATE film_metadata_owner_command SET outcome='noop'",/film_metadata_owner_command_immutable/);
 fails(file,'DELETE FROM film_metadata_owner_command',/film_metadata_owner_command_immutable/);
 fails(file,`INSERT INTO film_metadata_owner_command (request_id,film_id,action,command_digest,outcome,applied_revision,at) VALUES ('cmd-1','${ID}','set','${CMD('x')}','applied',9,'${T}')`,/UNIQUE|PRIMARY/);
 // two different owner sets apply in command (revision) order, not by digest
 exec(file,"DELETE FROM film_metadata_owner_release");
 await owner(env,[{action:'set',field:'year',value:2002}],{at:T1});await owner(env,[{action:'set',field:'year',value:2001}],{at:T2});
 assert.equal(meta(file).year,2001,'the later command wins');
 // the protection signal: a release wakes the core part; a C1 write signals nothing
 assert.equal(signals(file).length,0);
 const before=rows(file,'SELECT COUNT(*) c FROM enrichment_signal')[0].c;
 await declare(env,{synopsis:'S2'},{at:T3,observedAt:T3});assert.equal(rows(file,'SELECT COUNT(*) c FROM enrichment_signal')[0].c,before,'the producer\'s own write emits nothing');
 await owner(env,[{action:'release',field:'year'}],{at:T3});
 assert.deepEqual(signals(file),[{kind:'protection_released',subject:ID,part:'core'}],'a pin released wakes the core part');
 const released=field(file,'year');assert.deepEqual([released.tier,released.source],['released','owner'],'release keeps the value and its lineage columns');
 const reDeclared=await declare(env,{year:1996},{at:T3,observedAt:T3});
 assert.equal(meta(file).year,1996,'a released value ranks unknown: a confirmed observation replaces it, with history');
}
{
 // lock of an unknown (legacy) value: pinned as unattributed, no invented source; a blank field cannot be locked; revert and its refusals
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await undeclared(env,{year:1999});
 const rejects=(promise,reasons)=>assert.rejects(promise,error=>error.code==='film_metadata_rejected'&&JSON.stringify(error.rejected)===JSON.stringify(reasons));
 const command=n=>({requestId:'rej-'+n,action:'lock',digest:CMD('rej-'+n)});
 const revBefore=await revisionOf(env);
 await rejects(owner(env,[{action:'lock',field:'year'},{action:'lock',field:'runtime'}],{command:command(1)}),[{field:'runtime',reason:'blank_field'}]);
 assert.equal(rows(file,'SELECT COUNT(*) c FROM film_metadata_owner_command')[0].c,0,'a rejected command commits no command record');
 assert.equal(await revisionOf(env),revBefore,'and no revision bump');assert.equal(field(file,'year'),undefined,'and no effect on the other action of the batch');
 await owner(env,[{action:'lock',field:'year'}]);
 const row=field(file,'year');
 assert.deepEqual([row.tier,row.source,row.origin,row.anchor_scheme,row.anchor_digest,row.agreement],['owner','unattributed','owner_route',null,null,null]);
 const h=history(file)[0];assert.deepEqual([h.reason,h.old_value_text,h.old_tier],['owner_lock','1999',null]);
 // release of the unattributed pin: ranks unknown, so an undeclared write may replace it (with history)
 await owner(env,[{action:'release',field:'year'}]);
 assert.equal(field(file,'year').tier,'released');
 await undeclared(env,{year:2004},{at:T1});assert.equal(meta(file).year,2004);
 // lock of an attributed value keeps its source and anchor columns
 await declare(env,{runtime:136},{at:T2});
 await owner(env,[{action:'lock',field:'runtime'}],{at:T2});
 const attributed=field(file,'runtime');assert.deepEqual([attributed.tier,attributed.source,attributed.origin,attributed.anchor_value,attributed.agreement],['owner','letterboxd','catalog_enrichment','lid603',null]);
 // revert: same identity restores the old value and its lineage, pinned
 await owner(env,[{action:'set',field:'runtime',value:150}],{at:T3});
 assert.equal(meta(file).runtime,150);
 const set=history(file).filter(item=>item.field==='runtime').at(-1);
 const reverted=await owner(env,[{action:'revert',field:'runtime',history:historyAction(set,'runtime')}],{at:T3});
 assert.equal(meta(file).runtime,136,'revert restores the old value');
 const back=field(file,'runtime');assert.deepEqual([back.tier,back.source,back.anchor_value],['owner','letterboxd','lid603'],'pinned, with the old lineage');
 assert.equal(history(file).at(-1).reason,'owner_revert');void reverted;
 // an identity change refuses the revert (anchor_changed); an old value of unknown identity is refused too (identity_unknown) and the owner may set it instead
 exec(file,`UPDATE film_external_id SET value='lid-new' WHERE film_id='${ID}' AND scheme='letterboxd'`);
 await rejects(owner(env,[{action:'revert',field:'runtime',history:historyAction(set,'runtime')}],{at:T3,command:command(2)}),[{field:'runtime',reason:'anchor_changed'}]);
 const unknown=history(file).find(item=>item.field==='year'&&item.old_anchor_digest===null);
 await rejects(owner(env,[{action:'revert',field:'year',history:historyAction(unknown,'year')}],{at:T3,command:command(3)}),[{field:'year',reason:'identity_unknown'}]);
 assert.equal(rows(file,"SELECT COUNT(*) c FROM film_metadata_owner_command WHERE request_id LIKE 'rej-%'")[0].c,0,'no rejected command was recorded');
 await owner(env,[{action:'set',field:'year',value:1999}],{at:T3});assert.equal(meta(file).year,1999,'set works where revert is refused');
 // owner authority from any other origin is refused; an invalid value is film_person_invalid
 await assert.rejects(writeFilmFacts(env,{id:ID,at:T,requestId:req(),expectedRevision:await revisionOf(env),film:{contractVersion:1},metadata:{updatedAt:T,ownerActions:[{action:'set',field:'year',value:2000}]},metadataAuthority:{authority:'owner',origin:'epg'}}),error=>error.code==='film_person_invalid');
 await assert.rejects(writeFilmFacts(env,{id:ID,at:T,requestId:req(),expectedRevision:await revisionOf(env),film:{contractVersion:1},metadata:{updatedAt:T,ownerActions:[{action:'set',field:'year',value:2000}]}}),error=>error.code==='film_person_invalid','owner actions without authority are refused');
 await assert.rejects(owner(env,[{action:'set',field:'year',value:1700}]),error=>error.code==='film_person_invalid');
 await assert.rejects(owner(env,[{action:'set',field:'url',value:'javascript:x'}]),error=>error.code==='film_person_invalid');
}
{
 // a no-op owner command is recorded as `noop` and bumps the Film revision
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await declare(env,{year:1999});
 const before=await revisionOf(env);
 const done=await owner(env,[{action:'release',field:'year'}],{command:{requestId:'cmd-noop',action:'release',digest:CMD('noop')}});
 assert.equal(done.written,true);assert.equal(done.revision,before+1);
 assert.deepEqual(rows(file,'SELECT outcome,applied_revision FROM film_metadata_owner_command'),[{outcome:'noop',applied_revision:before+1}]);
}
{
 // the dimension lock covers every field and lets owner authority pass
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await declare(env,{year:1999});
 exec(file,`INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,authority,attempts,next_action,updated_at) VALUES ('${ID}','metadata','reviewed','owner','{}','owner',0,'none','${T}')`);
 const skip=await declare(env,{runtime:136},{at:T1});assert.deepEqual(skip.skipped.map(item=>item.reason),['owner_kept']);
 const epg=await undeclared(env,{synopsis:'x'});assert.deepEqual(epg.skipped.map(item=>item.reason),['owner_kept']);
 assert.equal(meta(file).runtime,null);
 fails(file,`UPDATE film_metadata SET runtime=1 WHERE film_id='${ID}'`,/film_metadata_owner_locked/);
 await owner(env,[{action:'set',field:'runtime',value:99}]);assert.equal(meta(file).runtime,99,'owner authority passes the dimension lock');
 await owner(env,[{action:'release',field:'runtime'}]);fails(file,`UPDATE film_metadata SET runtime=2 WHERE film_id='${ID}'`,/film_metadata_owner_locked/);
}

// ---- 7. modes ----
{
 const {file,env}=fresh();await seed(env);
 const flip=mode=>sqlite(file,`UPDATE film_metadata_provenance_control SET mode='${mode}',revision=revision+1,updated_at='${T}',updated_by='t' WHERE id=1`);
 assert.notEqual(flip('hold').status,0,'off -> hold is refused');
 assert.equal(flip('enforce').status,0);
 assert.notEqual(flip('off').status,0,'enforce -> off is refused (one way)');
 assert.equal(flip('hold').status,0);assert.notEqual(flip('off').status,0,'hold -> off is refused');
 assert.equal(flip('enforce').status,0,'hold -> enforce');
 fails(file,"UPDATE film_metadata_provenance_control SET updated_by='x'",/film_metadata_provenance_transition/);
 fails(file,"UPDATE film_metadata_provenance_control SET revision=revision+2",/film_metadata_provenance_transition/);
 fails(file,'DELETE FROM film_metadata_provenance_control',/film_metadata_provenance_no_delete/);
 fails(file,"INSERT INTO film_metadata_provenance_control (id,mode,revision,updated_at,updated_by) VALUES (2,'off',1,'"+T+"','x')");
 // pins and confirmed values survive enforce -> hold -> enforce
 await declare(env,{year:1999,runtime:136});await owner(env,[{action:'lock',field:'year'}]);
 exec(file,"UPDATE film_metadata_provenance_control SET mode='hold',revision=revision+1,updated_at='"+T+"',updated_by='t'");
 const held=await declare(env,{year:2005,runtime:140},{at:T1});assert.equal(held.skipped.length,2);
 exec(file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=revision+1,updated_at='"+T+"',updated_by='t'");
 assert.equal(field(file,'year').tier,'owner');assert.equal(field(file,'runtime').agreement,'confirmed');assert.equal(meta(file).year,1999);
 // fail closed: an unreadable field table
 exec(file,'DROP TRIGGER film_metadata_field_invalidate_update;DROP TRIGGER film_metadata_field_invalidate_delete;DROP TRIGGER film_metadata_field_invalidate_move;DROP TRIGGER film_metadata_field_invalidate_insert;DROP TRIGGER film_metadata_field_protection_released;DROP TRIGGER film_metadata_field_owner_inserted;DROP TRIGGER film_metadata_owner_row_inserted;DROP TRIGGER film_metadata_owner_row_moved_in;DROP TRIGGER film_metadata_field_owner_updated;DROP TRIGGER film_metadata_field_owner_deleted;DROP TRIGGER film_metadata_owner_value_locked;DROP TRIGGER film_metadata_owner_row_deleted;DROP TRIGGER film_metadata_owner_row_moved;DROP TABLE film_metadata_field');
 await assert.rejects(undeclared(env,{poster:'/x'}),error=>error.code==='film_person_unavailable');
}

// ---- 8. destructive paths: the clear rules ----
{
 const clear=(env,extra={})=>writeFilmFacts(env,{id:ID,at:T,requestId:req(),expectedRevision:0,film:{contractVersion:1},metadata:null,...extra});
 const withRevision=async(env,extra)=>clear(env,{expectedRevision:await revisionOf(env),...extra});
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 await declare(env,{year:1999,runtime:136});
 await assert.rejects(withRevision(env),error=>error.code==='film_metadata_attributed','an automatic clear is refused while any field row is attributed');
 await owner(env,[{action:'lock',field:'year'}]);
 await assert.rejects(withRevision(env),error=>error.code==='film_metadata_locked','a clear is refused while a field is an owner pin');
 assert.equal(meta(file).year,1999);
 // owner authority clears: history of every value, every field row (pins included), no release row left
 const done=await withRevision(env,{metadataAuthority:{authority:'owner',origin:'owner_route'}});
 assert.equal(done.written,true);assert.equal(meta(file),undefined);assert.equal(fieldRows(file).length,0);
 assert.equal(rows(file,"SELECT COUNT(*) c FROM film_metadata_history WHERE reason='cleared'")[0].c,2,'each non-blank value gets a cleared row');
 assert.equal(rows(file,'SELECT COUNT(*) c FROM film_metadata_owner_release')[0].c,0);
 // an unknown-only Film is clearable by an automatic caller in enforce, never in hold
 const other=fresh();await seed(other.env);setMode(other.file,'enforce');
 await undeclared(other.env,{year:1999});
 setMode(other.file,'hold');
 await assert.rejects(withRevision(other.env),error=>error.code==='film_metadata_hold');
 exec(other.file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=revision+1,updated_at='"+T+"',updated_by='t'");
 await withRevision(other.env);assert.equal(meta(other.file),undefined,'clear allowed for unknown values');assert.equal(rows(other.file,"SELECT reason FROM film_metadata_history")[0].reason,'cleared');
 // a clear planned before a switch to hold fails on the control revision
 const late=fresh();await seed(late.env);setMode(late.file,'enforce');await undeclared(late.env,{year:1999});
 await assert.rejects(writeFilmFacts(racing(late.env,late.file,"UPDATE film_metadata_provenance_control SET mode='hold',revision=revision+1,updated_at='"+T+"',updated_by='t'"),{id:ID,at:T,requestId:req(),expectedRevision:await revisionOf(late.env),film:{contractVersion:1},metadata:null}),/.+/);
 assert.equal(meta(late.file).year,1999,'an older plan committing after a switch to hold fails');
}

// ---- 9. the field-wise merge (dormant mergeFilms) ----
{
 const B='film:tmdb:604';
 const merged=async({mutate,resolve,rows:fill=true})=>{
  const w=fresh();await seed(w.env);await seed(w.env,{id:B,tmdb:'604',lid:'lid604'});setMode(w.file,'enforce');
  await mutate(w);
  const res=await mergeFilms(w.env,{from:B,to:ID,expected:{from:await revisionOf(w.env,B),to:await revisionOf(w.env,ID)},at:T3,resolve,evidence:{verified:true}});
  return {...w,res};
 };
 const mergeInput=async w=>({from:B,to:ID,expected:{from:await revisionOf(w.env,B),to:await revisionOf(w.env,ID)},at:T3,evidence:{verified:true}});
 // equal bookkeeping with DIFFERENT values requires a choice
 {
  const w=fresh();await seed(w.env);await seed(w.env,{id:B,tmdb:'604',lid:'lid604'});setMode(w.file,'enforce');
  await declare(w.env,{year:1999,runtime:100});await declare(w.env,{year:1998,runtime:100},{id:B});
  await assert.rejects(mergeFilms(w.env,await mergeInput(w)),error=>error.code==='film_person_data_conflict','different values without a choice are refused');
  assert.ok(meta(w.file,B),'nothing was merged');
  const done=await mergeFilms(w.env,{...(await mergeInput(w)),resolve:{metadata:'retired'}});
  assert.equal(done.merged,true);assert.equal(meta(w.file).year,1998,'the retired value was chosen');
  assert.equal(field(w.file,'year').source,'letterboxd','its field row moved with it');
  const discarded=history(w.file).find(item=>item.reason==='merge_discarded');
  assert.deepEqual([discarded.film_id,discarded.merged_from,discarded.old_value_text],[ID,B,'1999'],'the discarded survivor value is in history');
  assert.equal(meta(w.file,B),undefined);assert.equal(fieldRows(w.file,B).length,0,'the retired Film leaves no field row');
  assert.ok(done.discarded.includes('metadata:year:survivor'));
 }
 // equal values: a pin on the retired side is preserved by default; two pins keep the survivor's
 {
  const w=fresh();await seed(w.env);await seed(w.env,{id:B,tmdb:'604',lid:'lid604'});setMode(w.file,'enforce');
  await declare(w.env,{year:1999});await declare(w.env,{year:1999},{id:B});await owner(w.env,[{action:'set',field:'year',value:1999}],{id:B});
  const done=await mergeFilms(w.env,await mergeInput(w));
  assert.equal(done.merged,true);assert.equal(field(w.file,'year').tier,'owner','the pin is preserved');
  assert.equal(rows(w.file,'SELECT COUNT(*) c FROM film_metadata_owner_release')[0].c,0);
  const both=fresh();await seed(both.env);await seed(both.env,{id:B,tmdb:'604',lid:'lid604'});setMode(both.file,'enforce');
  await declare(both.env,{year:1999});await declare(both.env,{year:1999},{id:B});
  await owner(both.env,[{action:'lock',field:'year'}]);await owner(both.env,[{action:'set',field:'year',value:1999}],{id:B});
  const survivor=field(both.file,'year');
  await mergeFilms(both.env,await mergeInput(both));
  assert.deepEqual([field(both.file,'year').source,field(both.file,'year').write_key],[survivor.source,survivor.write_key],'two pins with equal values keep the survivor\'s');
  assert.ok(history(both.file).some(item=>item.reason==='merge_discarded'&&item.merged_from===B),'the retired pin goes to history');
 }
 // different values with a pin need the per-field disposition
 {
  const w=fresh();await seed(w.env);await seed(w.env,{id:B,tmdb:'604',lid:'lid604'});setMode(w.file,'enforce');
  await declare(w.env,{year:1999});await owner(w.env,[{action:'set',field:'year',value:2001}],{id:B});
  await assert.rejects(mergeFilms(w.env,{...(await mergeInput(w)),resolve:{metadata:'retired'}}),error=>error.code==='film_person_data_conflict','a pin is not decided by the whole-row choice');
  const done=await mergeFilms(w.env,{...(await mergeInput(w)),resolve:{metadataFields:{year:'retired'}}});
  assert.equal(done.merged,true);assert.equal(meta(w.file).year,2001);assert.equal(field(w.file,'year').tier,'owner');
 }
 // the survivor holds no metadata row: the retired row moves whole, with its field rows; a dimension lock moves with its Film and does not refuse the merge
 {
  const w=fresh();await seed(w.env);await seed(w.env,{id:B,tmdb:'604',lid:'lid604'});setMode(w.file,'enforce');
  await declare(w.env,{year:1999,runtime:100},{id:B});
  exec(w.file,`INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,authority,attempts,next_action,updated_at) VALUES ('${B}','metadata','reviewed','owner','{}','owner',0,'none','${T}')`);
  const done=await mergeFilms(w.env,await mergeInput(w));
  assert.equal(done.merged,true);assert.deepEqual(fieldRows(w.file).map(item=>item.field),['runtime','year']);
  assert.equal(rows(w.file,"SELECT status FROM film_dimension WHERE film_id='"+ID+"' AND dimension='metadata'")[0].status,'reviewed','the lone retired lock moved');
  assert.equal(rows(w.file,'SELECT COUNT(*) c FROM film_metadata_owner_release')[0].c,0);
 }
 // at `off` or with the schema absent the old behaviour stays (whole-row choice; a lock refuses before any statement)
 {
  const w=fresh();await seed(w.env);await seed(w.env,{id:B,tmdb:'604',lid:'lid604'});
  exec(w.file,`INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,authority,attempts,next_action,updated_at) VALUES ('${B}','metadata','reviewed','owner','{}','owner',0,'none','${T}')`);
  await assert.rejects(mergeFilms(w.env,await mergeInput(w)),error=>error.code==='film_person_metadata_locked');
 }
 // bound: six differing fields, all chosen, within the 60 statements (or refused as film_person_bounded)
 {
  const w=fresh();await seed(w.env);await seed(w.env,{id:B,tmdb:'604',lid:'lid604'});setMode(w.file,'enforce');
  const all=(year)=>({year,runtime:100+year-1990,synopsis:'S'+year,poster:'/p'+year,url:'https://e.test/'+year,genres:['g'+year]});
  await declare(w.env,all(1999));await declare(w.env,all(1998),{id:B});
  const probe=batchSize(w.env);
  const done=await mergeFilms(probe.env,{...(await mergeInput(w)),resolve:{metadata:'retired'}});
  assert.equal(done.merged,true);assert.ok(probe.seen.size<=MUTATION_STATEMENT_CAP,'the merge batch of six differing fields is '+probe.seen.size+' statements (cap '+MUTATION_STATEMENT_CAP+')');
  console.log('measured: merge of six differing fields = '+probe.seen.size+' statements');
 }
 void merged;
}

// ---- 10. bounds ----
{
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 const all={year:1999,runtime:136,synopsis:'S',poster:'/p',url:'https://e.test/m',genres:['a','b']};
 const probe=batchSize(env);
 await declare(probe.env,all,{guards:[{sql:'1=1',params:[]}]});
 assert.ok(probe.seen.size<=MUTATION_STATEMENT_CAP);
 console.log('measured: a core batch of six declared fields = '+probe.seen.size+' statements');
 const replace={year:2000,runtime:140,synopsis:'S2',poster:'/p2',url:'https://e.test/m2',genres:['c']};
 const replaced=batchSize(env);
 await declare(replaced.env,replace,{at:T3,observedAt:T3});
 assert.ok(replaced.seen.size<=MUTATION_STATEMENT_CAP);
 assert.equal(history(file).length,6,'six replaced fields write six history rows');
 console.log('measured: a core batch replacing six fields = '+replaced.seen.size+' statements');
 const actions=['year','runtime','synopsis','poster','url','genres'].map(name=>({action:'lock',field:name}));
 const ownerProbe=batchSize(env);
 await owner(ownerProbe.env,actions,{command:{requestId:'cmd-b',action:'lock',digest:CMD('b')}});
 assert.ok(ownerProbe.seen.size<=MUTATION_STATEMENT_CAP);
 console.log('measured: an owner batch of six locks = '+ownerProbe.seen.size+' statements');
 const tooMany=Array.from({length:12},(_,i)=>({guards:i}));void tooMany;
}
// the real EPG path is undeclared: its facts carry no declaration, so its first write after activation stays `unknown` and an attributed value is never replaced by it
{
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 const facts=filmFactsOf({id:'tmdb:603',canonicalIdentity:'tmdb:603',original:'The Matrix',title:'The Matrix',year:1999,runtime:136,synopsis:'EPG text',poster:'/e.jpg',url:'https://e.test/m',genres:['x'],metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:1,peopleLocalizedAt:T},undefined);
 assert.equal(JSON.stringify(facts).includes('declared'),false,'the EPG facts carry no declaration');
 await writeFilmFacts(env,{...facts,id:ID,at:T,requestId:req(),expectedRevision:await revisionOf(env),requireExisting:true});
 assert.equal(meta(file).synopsis,'EPG text');assert.equal(fieldRows(file).length,0,'the first EPG write after activation stays unknown');
 await declare(env,{synopsis:'Confirmed text'},{at:T1});
 assert.equal(meta(file).synopsis,'Confirmed text','a confirmed observation replaces the unknown EPG text');
 await writeFilmFacts(env,{...facts,id:ID,at:T2,requestId:req(),expectedRevision:await revisionOf(env),requireExisting:true,metadata:{...facts.metadata,updatedAt:T2,synopsis:'October text'}});
 assert.equal(meta(file).synopsis,'Confirmed text','an EPG replay of old text never replaces a confirmed value (worked example 3)');
}
// D1 bounds of the writer's own statements: at most 100 bound parameters and 100 KB per statement; the caller's guards stay at most 12 (the writer's fences are its own)
{
 const {file,env}=fresh();await seed(env);setMode(file,'enforce');
 const snapshot=await readFilmSnapshot(env,ID);
 const all={year:1999,runtime:136,synopsis:'S'.repeat(5000),poster:'/p',url:'https://e.test/m',genres:['a','b']};
 const digest=snapshot.provenance.anchors.digest;
 const declared=Object.fromEntries(Object.keys(all).map(name=>[name,{source:'letterboxd',anchor:{scheme:'letterboxd',value:'lid603'},observedAt:T,agreedAnchorDigest:digest}]));
 const plan=planFilmFacts(snapshot,{id:ID,at:T,requestId:'r',expectedRevision:snapshot.revision,film:{contractVersion:1},metadata:{updatedAt:T,declared,...all},requireExisting:true});
 for(const [text,params] of [...plan.statements,...plan.guards.map(guard=>[guard.sql,guard.params])]){assert.ok(params.length<=100,'at most 100 bound parameters');assert.ok(text.length<100000,'at most 100 KB per statement');}
 const caller=n=>Array.from({length:n},()=>({sql:'1=1',params:[]}));
 await declare(env,all,{guards:caller(12)});
 assert.equal(meta(file).year,1999,'twelve caller guards plus the writer\'s own fences fit');
 await assert.rejects(declare(env,{year:2000},{at:T3,observedAt:T3,guards:caller(13)}),error=>error.code==='film_person_invalid','a thirteenth caller guard is still refused');
}
// ---- 11. review of 8c0cb0a5: merge authorization, destination protection, history binding, rejected commands, the wake ----
{
 const B='film:tmdb:604';
 const pair=async()=>{const w=fresh();await seed(w.env);await seed(w.env,{id:B,tmdb:'604',lid:'lid604'});setMode(w.file,'enforce');return w;};
 const mergeIn=async(w,extra={})=>({from:B,to:ID,expected:{from:await revisionOf(w.env,B),to:await revisionOf(w.env,ID)},at:T3,evidence:{verified:true},...extra});
 const releases=file=>rows(file,'SELECT COUNT(*) c FROM film_metadata_owner_release')[0].c;
 // a retired Film with NO metadata row merged into a pinned survivor leaves no release row behind, and the pin still protects
 {
  const w=await pair();
  await declare(w.env,{year:1999});await owner(w.env,[{action:'lock',field:'year'}]);
  const done=await mergeFilms(w.env,await mergeIn(w));
  assert.equal(done.merged,true);assert.equal(releases(w.file),0,'no transient authorization stays');
  fails(w.file,`UPDATE film_metadata SET year=1 WHERE film_id='${ID}'`,/film_metadata_owner_locked/);
  assert.equal(field(w.file,'year').tier,'owner');
 }
 // an UNATTRIBUTED retired value chosen over a pinned survivor replaces the pin with the exact provenance of the choice (none)
 {
  const w=await pair();
  await undeclared(w.env,{year:1998},{id:B});
  await declare(w.env,{year:1999});await owner(w.env,[{action:'set',field:'year',value:2001}]);
  await assert.rejects(mergeFilms(w.env,await mergeIn(w,{resolve:{metadata:'retired'}})),error=>error.code==='film_person_data_conflict');
  const done=await mergeFilms(w.env,await mergeIn(w,{resolve:{metadataFields:{year:'retired'}}}));
  assert.equal(done.merged,true);assert.equal(meta(w.file).year,1998);
  assert.equal(field(w.file,'year'),undefined,'the old pin does not survive on the value it did not describe');
  assert.equal(history(w.file).find(item=>item.reason==='merge_discarded').old_tier,'owner','the discarded pin is in history');
  assert.equal(releases(w.file),0);
  exec(w.file,`UPDATE film_metadata SET year=1997 WHERE film_id='${ID}'`);
 }
 // two pins with equal values keep the survivor's and record the retired PIN; equal values with different lineage compare the full semantic row
 {
  const w=await pair();
  await declare(w.env,{year:1999,runtime:100});await declare(w.env,{year:1999,runtime:100},{id:B});
  await owner(w.env,[{action:'lock',field:'year'}]);await owner(w.env,[{action:'lock',field:'year'}],{id:B});
  await mergeFilms(w.env,await mergeIn(w));
  const discarded=history(w.file).filter(item=>item.reason==='merge_discarded');
  assert.ok(discarded.some(item=>item.field==='year'&&item.old_tier==='owner'&&item.merged_from===B),'the retired pin is recorded');
  assert.ok(discarded.some(item=>item.field==='runtime'&&item.old_anchor_value==='lid604'),'equal values, different lineage (another anchor): the survivor row stays and the retired one is recorded');
  assert.equal(field(w.file,'runtime').anchor_value,'lid603');
 }
 // the destination of a raw insert or move is protected like the origin
 {
  const w=fresh();await seed(w.env);await seed(w.env,{id:'film:tmdb:700',tmdb:'700',lid:null});setMode(w.file,'enforce');
  const C='film:tmdb:700';
  exec(w.file,`INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,authority,attempts,next_action,updated_at) VALUES ('${C}','metadata','reviewed','owner','{}','owner',0,'none','${T}')`);
  const row=`INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES ('${C}',1,1999,NULL,NULL,NULL,NULL,'[]',NULL,'{}',NULL,NULL,'${T}')`;
  fails(w.file,row,/film_metadata_owner_locked/);
  const skipped=await declare(w.env,{year:1999},{id:C,source:'tmdb'}).catch(error=>error);
  assert.ok(!(skipped instanceof Error)||skipped.code!=='film_person_unavailable','an automatic writer does not even try to create a row in a locked empty Film');
  assert.equal(meta(w.file,C),undefined,'and nothing was created');
  exec(w.file,`BEGIN;INSERT INTO film_metadata_owner_release (film_id) VALUES ('${C}');${row};DELETE FROM film_metadata_owner_release WHERE film_id='${C}';COMMIT;`);
  assert.equal(meta(w.file,C).year,1999,'the release row opens the destination');
  // a move INTO a locked empty destination
  exec(w.file,`DELETE FROM film_metadata_owner_release;PRAGMA foreign_keys=OFF;BEGIN;INSERT INTO film_metadata_owner_release (film_id) VALUES ('${C}');DELETE FROM film_metadata WHERE film_id='${C}';DELETE FROM film_metadata_owner_release;COMMIT;`);
  await undeclared(w.env,{year:2000});
  fails(w.file,`PRAGMA foreign_keys=OFF;UPDATE film_metadata SET film_id='${C}' WHERE film_id='${ID}'`,/film_metadata_owner_locked/);
  // an owner field row at the destination (no metadata row) protects it as well; INSERT OR REPLACE cannot drop a pin
  const D='film:tmdb:701';
  await seed(w.env,{id:D,tmdb:'701',lid:null});
  exec(w.file,`PRAGMA foreign_keys=OFF;INSERT INTO film_metadata_field (film_id,field,tier,source,origin,anchor_scheme,anchor_value,anchor_digest,agreement,observed_at,checked_at,value_digest,write_key,written_revision,updated_at) VALUES ('${D}','year','owner','unattributed','owner_route',NULL,NULL,NULL,NULL,'${T}','${T}','${'a'.repeat(64)}','k',1,'${T}')`);
  fails(w.file,row.replace(`'${C}'`,`'${D}'`),/film_metadata_owner_locked/);
  fails(w.file,`INSERT OR REPLACE INTO film_metadata_field (film_id,field,tier,source,origin,anchor_scheme,anchor_value,anchor_digest,agreement,observed_at,checked_at,value_digest,write_key,written_revision,updated_at) VALUES ('${D}','year','released','unattributed','owner_route',NULL,NULL,NULL,NULL,'${T}','${T}','${'b'.repeat(64)}','k2',2,'${T}')`,/film_metadata_owner_locked/);
 }
 // the history a revert restores is bound to the stored row and to this Film (or one redirected into it)
 {
  const w=fresh();setMode(w.file,'enforce');
  const none=async id=>mutateFilm(w.env,{id,expectedRevision:0,at:T,film:{contractVersion:1,originalTitle:'X',externalIds:[],aliases:[]}});
  await none('film:x1');await none('film:x2');
  const X1='film:x1',X2='film:x2';
  await owner(w.env,[{action:'set',field:'year',value:2000}],{id:X2});await owner(w.env,[{action:'set',field:'year',value:2001}],{id:X2,at:T1});
  await owner(w.env,[{action:'set',field:'year',value:5000>2200?2100:5}],{id:X1});
  const foreign=history(w.file).find(item=>item.film_id===X2&&item.old_value_text==='2000');
  assert.ok(foreign&&foreign.old_anchor_digest,'a history row of another Film with the same (empty) anchor digest');
  const revision=await revisionOf(w.env,X1);
  await assert.rejects(owner(w.env,[{action:'revert',field:'year',history:historyAction(foreign,'year')}],{id:X1,command:{requestId:'foreign',action:'revert',digest:CMD('f')}}),/.+/,'a foreign history row is refused');
  assert.equal(await revisionOf(w.env,X1),revision);assert.equal(rows(w.file,"SELECT COUNT(*) c FROM film_metadata_owner_command WHERE request_id='foreign'")[0].c,0);
  exec(w.file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('${X2}','${X1}','${T}')`);
  await assert.rejects(owner(w.env,[{action:'revert',field:'year',history:{...historyAction(foreign,'year'),oldSource:'letterboxd'}}],{id:X1}),/.+/,'caller-supplied lineage that differs from the stored row is refused');
  await owner(w.env,[{action:'revert',field:'year',history:historyAction(foreign,'year')}],{id:X1});
  assert.equal(meta(w.file,X1).year,2000,'a row of a Film redirected into this one is accepted');
 }
 // an owner-authority clear is refused while nothing is enforced, like the non-null path
 {
  const w=fresh();await seed(w.env);
  await assert.rejects(writeFilmFacts(w.env,{id:ID,at:T,requestId:req(),expectedRevision:await revisionOf(w.env),film:{contractVersion:1},metadata:null,metadataAuthority:{authority:'owner',origin:'owner_route'}}),error=>error.code==='film_person_precondition');
 }
 // the wake: an actual release kicks an idle producer; an ordinary C1 write does not; no signal while the dimension lock still protects
 {
  const kicks=[];
  globalThis.CatalogEnrichmentRunner={hasRunnable:async()=>true,kick:async()=>{kicks.push(1);}};
  try{
   const w=fresh();await seed(w.env);setMode(w.file,'enforce');
   // the kick is decided from the batch's SQL: the provenance statements of an ordinary C1 write (field upserts, history, the agreed touch) match nothing of the release wake; only the owner `release` and an owner clear do
   const WAKES=/UPDATE film_metadata_field SET tier=|INTO enrichment_signal/;
   const snapshot=await readFilmSnapshot(w.env,ID);
   const ordinary=planFilmFacts(snapshot,{id:ID,at:T,requestId:'p',expectedRevision:snapshot.revision,film:{contractVersion:1},metadata:{updatedAt:T,year:1999,runtime:100,declared:Object.fromEntries(['year','runtime'].map(name=>[name,{source:'letterboxd',anchor:{scheme:'letterboxd',value:'lid603'},observedAt:T,agreedAnchorDigest:snapshot.provenance.anchors.digest}]))},requireExisting:true});
   assert.equal(ordinary.statements.some(([text])=>WAKES.test(text)),false,'an ordinary provenance write does not match the release wake');
   await declare(w.env,{year:1999,runtime:100});
   await owner(w.env,[{action:'lock',field:'year'}]);
   const beforeRelease=kicks.length;
   await owner(w.env,[{action:'release',field:'year'}]);
   assert.ok(kicks.length>beforeRelease,'an actual release kicks the idle producer');
   assert.deepEqual(signals(w.file),[{kind:'protection_released',subject:ID,part:'core'}]);
   const locked=fresh();await seed(locked.env);setMode(locked.file,'enforce');
   await declare(locked.env,{year:1999});await owner(locked.env,[{action:'lock',field:'year'}]);
   exec(locked.file,`INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,authority,attempts,next_action,updated_at) VALUES ('${ID}','metadata','reviewed','owner','{}','owner',0,'none','${T}')`);
   const before=rows(locked.file,'SELECT COUNT(*) c FROM enrichment_signal')[0].c;
   await owner(locked.env,[{action:'release',field:'year'}]);
   assert.equal(rows(locked.file,'SELECT COUNT(*) c FROM enrichment_signal')[0].c,before,'a still-protected field (dimension lock) signals nothing');
   // an owner clear of a pin signals; a merge that keeps the pin does not
   const cleared=fresh();await seed(cleared.env);setMode(cleared.file,'enforce');
   await undeclared(cleared.env,{year:1999});await owner(cleared.env,[{action:'lock',field:'year'}]);
   await writeFilmFacts(cleared.env,{id:ID,at:T,requestId:req(),expectedRevision:await revisionOf(cleared.env),film:{contractVersion:1},metadata:null,metadataAuthority:{authority:'owner',origin:'owner_route'}});
   assert.equal(signals(cleared.file).length,1,'an owner clear that removed a pin is an actual release');
   const merged=fresh();await seed(merged.env);await seed(merged.env,{id:B,tmdb:'604',lid:'lid604'});setMode(merged.file,'enforce');
   await undeclared(merged.env,{year:1999});await owner(merged.env,[{action:'lock',field:'year'}]);
   await mergeFilms(merged.env,{from:B,to:ID,expected:{from:await revisionOf(merged.env,B),to:await revisionOf(merged.env,ID)},at:T3,evidence:{verified:true}});
   assert.equal(signals(merged.file).length,0,'a merge that keeps the pin releases nothing');
  }finally{delete globalThis.CatalogEnrichmentRunner;}
 }
}
console.log('film metadata provenance (AIR-631): the sync SHA-256 and the writer digest, schema absent and off byte-identical, binding, invalidation and declaration, anchor and mode races, the comparator with convergence over every permutation, locks, triggers and owner actions, modes, clear rules and the field-wise merge, and the statement bounds: ok');
