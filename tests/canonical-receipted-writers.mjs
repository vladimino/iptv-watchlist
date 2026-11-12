// AIR-374 P3-0a: the optional `receiptMark` of every fenced canonical writer (mutateFilm, mutatePerson, writeFilmFacts, recordPersonState, recordLocalizationConflicts, recordLocalizationSources, admitRatedFilm,
// retainFilm, recordRetirementDecision), dormant, on the sqlite3-CLI D1 stand-in. No Worker, R2, D1 or Cloudflare access. Covered: without a mark every writer is exactly as before; with one the receipt
// is applied INSIDE the writer's own batch (one batch, tail after the revision bump, two statements outside the cap); a receipt that is not this attempt's pending row rolls the whole mutation back;
// a malformed or foreign mark is refused before any statement; nothing reaches the database unless the marker is open; and the E5 rule: a writer that finds nothing to write opens no second batch, the
// receipt ends `unknown` (atomic_mark_missing) for readback. RECEIPTED_SRC points the file at a mutant copy of src/ (tests/canonical-receipted-writers-mutation.mjs); RECEIPTED_TEMPLATE a prebuilt template.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {CONFIRMED_RETIREMENTS,OWNER_CONFIRMATION} from '../scripts/tmdb-tv-identity-plan.mjs';

const SRC=process.env.RECEIPTED_SRC?path.resolve(process.env.RECEIPTED_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const {mutateFilm,mutatePerson,fenced,MUTATION_STATEMENT_CAP}=await load('canonical-mutations.js');
const {writeFilmFacts}=await load('canonical-film-writers.js');
const {recordPersonState,recordLocalizationConflicts}=await load('canonical-person-state.js');
const {recordLocalizationSources}=await load('localization-sources.js');
const {admitRatedFilm,retainFilm}=await load('film-admission.js');
const {recordRetirementDecision}=await load('tmdb-retirement-decisions.js');
const R=await load('canonical-receipts.js');
const {receiptedWrite,requestIdOf,digestOf,appliedStatements,listAttention,readReceipt}=R;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-receipted-writers-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
if(process.env.RECEIPTED_TEMPLATE)fs.copyFileSync(process.env.RECEIPTED_TEMPLATE,template);
else{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
let n=0;
function database(stage='open'){
 const file=path.join(root,'rw-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='open')assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const AT='2026-11-11T10:00:00.000Z';
const iso=ms=>new Date(Date.parse(AT)+ms).toISOString();
const revision=(file,kind,id)=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='"+kind+"' AND id='"+id+"'")??0);
const receipts=file=>rows(file,'SELECT request_id,operation,state,attempts,applied_revision,error_class FROM canonical_write_receipt ORDER BY request_id');
const dump=file=>JSON.stringify(['film','film_external_id','film_alias','film_dimension','film_sync_state','film_metadata','watchlist_film','person','person_dimension','person_localization_source','film_localization_source','localization_conflict','film_rated_admission','film_retention','tmdb_retirement_decision','canonical_revision','canonical_write_receipt'].map(table=>rows(file,'SELECT * FROM '+table+' ORDER BY 1,2')));

const PERSON='person:director/1';
const [ODYSSEY]=CONFIRMED_RETIREMENTS;
const dim=(slot,over={})=>({dimension:slot,status:'resolved',updatedAt:AT,source:'letterboxd',sourceVersion:'director/1',provenance:{scope:'role'},nextAction:'stop',...over});
const loc=(over={})=>({dimension:'localization',status:'provisional',updatedAt:AT,source:'wikidata',sourceVersion:'provisional',provenance:{value:'Value'},value:'Value',nextAction:'keep_provisional',...over});
const retire=()=>({requestId:'req-retire',kind:'retire',filmId:ODYSSEY.filmId,lid:ODYSSEY.lid,movieId:ODYSSEY.movieId,tvId:ODYSSEY.tvId,at:AT,evidence:{movieStatus:404,movieCheckedAt:'2026-10-30T10:00:00Z',letterboxdUrl:ODYSSEY.letterboxdUrl,link:'tv/'+ODYSSEY.tvId,linkCheckedAt:'2026-10-30T10:01:00Z',tvResponseId:ODYSSEY.tvId,tvCheckedAt:'2026-10-30T10:02:00Z'},confirmation:{...OWNER_CONFIRMATION}});
const rated=tmdb=>({tmdb:String(tmdb),sourceCode:'sc'+tmdb,archiveSha256:'a'.repeat(64),title:'Film '+tmdb,year:2001,filmPath:'/film/x/',verifiedAt:'2026-11-01T09:00:00.000Z'});

// One scenario per writer: `seed` prepares the stored state, `target` is the entity the receipt names, `call(env,mark)` is the writer call, `expected` the revision the writer is given.
const SCENARIOS=[
 {name:'mutateFilm',operation:'film_mutation',target:{kind:'film',id:'film:tmdb:1'},expected:0,seed:async()=>{},call:(env,mark)=>mutateFilm(env,{id:'film:tmdb:1',expectedRevision:0,at:AT,receiptMark:mark,film:{contractVersion:1,originalTitle:'One'}})},
 {name:'mutatePerson',operation:'person_mutation',target:{kind:'person',id:PERSON},expected:0,seed:async()=>{},call:(env,mark)=>mutatePerson(env,{id:PERSON,expectedRevision:0,at:AT,receiptMark:mark,person:{roleId:'director/1',contractVersion:1}})},
 {name:'writeFilmFacts',operation:'film_metadata',target:{kind:'film',id:'film:tmdb:2'},expected:0,seed:async()=>{},call:(env,mark)=>writeFilmFacts(env,{id:'film:tmdb:2',expectedRevision:0,at:AT,requestId:'req-facts',receiptMark:mark,film:{contractVersion:1,originalTitle:'Two',source:'tmdb'},watchlist:true})},
 {name:'recordPersonState',operation:'person_state',target:{kind:'person',id:PERSON},expected:1,seed:async env=>{await mutatePerson(env,{id:PERSON,expectedRevision:0,at:AT,person:{roleId:'director/1',contractVersion:1}});},call:(env,mark)=>recordPersonState(env,{id:PERSON,expectedRevision:1,at:AT,requestId:'req-state',receiptMark:mark,person:{identity:dim('identity'),localization:loc()}})},
 {name:'recordLocalizationConflicts',operation:'localization_conflict',target:{kind:'person',id:PERSON},expected:1,seed:async env=>{await mutatePerson(env,{id:PERSON,expectedRevision:0,at:AT,person:{roleId:'director/1',contractVersion:1}});},call:(env,mark)=>recordLocalizationConflicts(env,{kind:'person',id:PERSON,expectedRevision:1,at:AT,requestId:'req-conflict',receiptMark:mark,conflicts:[{value:'v',reason:'owner_kept',at:AT}]})},
 {name:'recordLocalizationSources',operation:'localization_source',target:{kind:'film',id:'film:tmdb:3'},expected:1,seed:async env=>{await mutateFilm(env,{id:'film:tmdb:3',expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'Three'}});},call:(env,mark)=>recordLocalizationSources(env,{kind:'film',id:'film:tmdb:3',expectedRevision:1,at:AT,requestId:'req-source',receiptMark:mark,sources:[{source:'wikidata',value:'Name',sourceVersion:'wd:1',provenance:{query:'label'},observedAt:'2026-11-07T09:00:00.000Z'}]})},
 {name:'admitRatedFilm',operation:'film_admission',target:{kind:'film',id:'film:tmdb:5'},expected:0,seed:async()=>{},call:(env,mark)=>admitRatedFilm(env,{receiptKey:'tmdb_5',receipt:rated(5),expectedRevision:0,at:AT,requestId:'req-admit',receiptMark:mark})},
 {name:'retainFilm',operation:'film_retention',target:{kind:'film',id:'film:tmdb:6'},expected:1,seed:async env=>{await mutateFilm(env,{id:'film:tmdb:6',expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'Six'}});},call:(env,mark)=>retainFilm(env,{id:'film:tmdb:6',expectedRevision:1,at:AT,requestId:'req-retain',receiptMark:mark,watchlist:true,observedAt:'2026-11-08T09:00:00.000Z'})},
 {name:'recordRetirementDecision',operation:'tmdb_retirement',target:{kind:'film',id:ODYSSEY.filmId},expected:1,seed:async env=>{await mutateFilm(env,{id:ODYSSEY.filmId,expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:ODYSSEY.lid,externalIds:[{scheme:'tmdb',value:ODYSSEY.movieId,trusted:true}]}});},call:(env,mark)=>recordRetirementDecision(env,{...retire(),expectedRevision:1,receiptMark:mark})},
];
const sourceOf=async(scenario,tag)=>requestIdOf({origin:'epg',operation:scenario.operation,source:{scenario:scenario.name,tag}});
const markOf=(requestId,attempt,target,now=AT)=>({requestId,attempt,now,target});
// One receipted write the way a producer adapter does it: the receipt is recorded pending, then `run` hands the writer its mark.
async function through(env,scenario,tag,{seen=null}={}){
 const requestId=await sourceOf(scenario,tag);
 const outcome=await receiptedWrite(env,{requestId,operation:scenario.operation,origin:'epg',target:scenario.target,expectedRevision:scenario.expected,digest:await digestOf({scenario:scenario.name,tag}),now:()=>AT},{
  atomic:true,
  run:({requestId:id,attempt,target})=>scenario.call(env,markOf(id,attempt,target)),
  readback:async()=>null,
 });
 if(seen)seen.requestId=requestId;
 return outcome;
}

// 1. Without a mark every writer is exactly as before: no receipt statement in the batch, no receipt row, the same revision.
for(const scenario of SCENARIOS){
 const file=database('open'),env=envOf(file);
 await scenario.seed(env);
 const seeded=env.DB.calls.statements;
 const batches=[];
 const spy=envOf(file,{onBatch:async statements=>{batches.push(statements.map(item=>item.text));}});
 const done=await scenario.call(spy,undefined);
 assert.ok(done,scenario.name+': the writer answers');
 assert.equal(batches.length,1,scenario.name+': one batch');
 assert.ok(!batches[0].some(text=>/canonical_write_receipt/.test(text)),scenario.name+': no receipt statement without a mark');
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM canonical_write_receipt')),0,scenario.name+': no receipt row');
 assert.equal(revision(file,scenario.target.kind,scenario.target.id),scenario.expected+1,scenario.name+': revision bumped once');
 void seeded;
}

// 2. With a mark through receiptedWrite (atomic): the receipt is applied INSIDE the writer's batch, the tail follows the revision bump, and the write is exactly one batch after the pending insert.
for(const scenario of SCENARIOS){
 const file=database('open');
 await scenario.seed(envOf(file));
 const batches=[];
 const env=envOf(file,{onBatch:async statements=>{batches.push(statements.map(item=>item.text));}});
 const outcome=await through(env,scenario,'a');
 assert.equal(outcome.state,'applied',scenario.name+': applied');
 assert.equal(outcome.attempt,1,scenario.name+': first attempt');
 assert.equal(batches.length,2,scenario.name+': a pending insert and ONE writer batch, no marking batch');
 const writer=batches[1];
 const last=writer.slice(-3);
 assert.match(last[0],/INSERT INTO canonical_revision/,scenario.name+': the revision bump comes before the tail');
 assert.match(last[1],/^UPDATE canonical_write_receipt SET state='applied'/,scenario.name+': the applied update is the second to last statement');
 assert.match(last[2],/film_person_cas/,scenario.name+': the changes()>=1 assertion closes the batch');
 assert.equal(writer.filter(text=>/canonical_write_receipt/.test(text)).length,1,scenario.name+': one receipt statement');
 const row=receipts(file);
 assert.equal(row.length,1,scenario.name+': one receipt');
 assert.equal(row[0].state,'applied');
 assert.equal(row[0].applied_revision,scenario.expected+1,scenario.name+': applied at the revision the batch produced');
 assert.equal(revision(file,scenario.target.kind,scenario.target.id),scenario.expected+1);
 // the same request id again is already applied and runs nothing
 const again=await through(envOf(file),scenario,'a');
 assert.equal(again.already,true,scenario.name+': the same request id is not run twice');
}

// 3. A receipt that is not this attempt's pending row rolls the WHOLE mutation back (atomic): a wrong attempt, a missing receipt, another request id, a failed receipt and an already applied one.
for(const scenario of SCENARIOS){
 const requestId=await sourceOf(scenario,'rollback');
 const pending=file=>sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('"+requestId+"','"+scenario.operation+"','epg','"+scenario.target.kind+"','"+scenario.target.id+"','"+'a'.repeat(64)+"',"+scenario.expected+",2,'pending',1,'"+iso(120000)+"','"+AT+"','"+AT+"')");
 for(const [label,mark,prepare] of [
  ['wrong attempt',markOf(requestId,2,scenario.target),pending],
  ['no receipt row',markOf(requestId,1,scenario.target),()=>{}],
  ['another request id',markOf(requestId+'-other',1,scenario.target),pending],
  ['failed, not pending',markOf(requestId,1,scenario.target),file=>{pending(file);assert.equal(sqlite(file,"UPDATE canonical_write_receipt SET state='failed',error_class='film_person_revision_conflict',next_attempt_at='"+iso(60000)+"',updated_at='"+AT+"' WHERE request_id='"+requestId+"'").status,0);}],
  ['already applied',markOf(requestId,1,scenario.target),file=>{pending(file);assert.equal(sqlite(file,"UPDATE canonical_write_receipt SET state='applied',applied_revision=1,next_attempt_at=NULL,settled_at='"+AT+"' WHERE request_id='"+requestId+"'").status,0);}],
 ]){
  const file=database('open');
  await scenario.seed(envOf(file));
  prepare(file);
  const before=dump(file);
  await assert.rejects(()=>scenario.call(envOf(file),mark),error=>/^film_person_|identity_|admission_|retirement_/.test(error.code)||error.code==='film_person_precondition',scenario.name+' '+label+': the batch is refused');
  assert.equal(dump(file),before,scenario.name+' '+label+': the mutation, its revision and the receipt are untouched (rolled back whole)');
 }
}

// 4. A malformed or foreign mark is refused before any statement: another entity, a bad attempt, a missing request id, a missing clock, not an object.
for(const scenario of SCENARIOS){
 const file=database('open');
 await scenario.seed(envOf(file));
 const before=dump(file);
 const other=scenario.target.kind==='film'?{kind:'film',id:'film:tmdb:999'}:{kind:'person',id:'person:director/999'};
 const kindSwap={kind:scenario.target.kind==='film'?'person':'film',id:scenario.target.id};
 const good=markOf('r-1',1,scenario.target);
 for(const [label,mark] of [['other entity',{...good,target:other}],['other kind',{...good,target:kindSwap}],['no target',{...good,target:undefined}],['attempt 0',{...good,attempt:0}],['attempt text',{...good,attempt:'1'}],['no request id',{...good,requestId:''}],['no clock',{...good,now:undefined}],['not an object',7]]){
  const env=envOf(file);
  await assert.rejects(()=>scenario.call(env,mark),code('film_person_invalid'),scenario.name+' '+label);
  assert.equal(env.DB.calls.batches,0,scenario.name+' '+label+': no batch');
 }
 assert.equal(dump(file),before,scenario.name+': nothing changed');
}

// 5. Dormant at r2, prepared and held: a writer with a mark opens no batch and writes no receipt (the projector stays the only writer).
for(const [stage,expected] of [['r2','film_person_not_open'],['prepared','film_person_not_open'],['held','film_person_held']]){
 for(const scenario of SCENARIOS){
  const file=database(stage);
  const env=envOf(file),before=dump(file);
  await assert.rejects(()=>scenario.call(env,markOf('r-1',1,scenario.target)),error=>error.code===expected||(stage!=='held'&&/^film_person_/.test(error.code)),stage+' '+scenario.name);
  assert.equal(env.DB.calls.batches,0,stage+' '+scenario.name+': no batch');
  assert.equal(dump(file),before,stage+' '+scenario.name+': nothing written');
 }
}

// 6. The statement cap counts the writer's own statements only; the two-statement tail rides on top of it and no more than two are accepted.
{
 const aliases=count=>Array.from({length:count},(_,i)=>({kind:'title',value:'alias '+i}));
 // the fixed part of mutateFilm is 5 statements (fence, revision, redirect assertion, film, bump)
 const body=MUTATION_STATEMENT_CAP-5;
 const requestId=await requestIdOf({origin:'epg',operation:'film_mutation',source:'cap'});
 const pendingFor=id=>"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('"+requestId+"','film_mutation','epg','film','"+id+"','"+'a'.repeat(64)+"',0,2,'pending',1,'"+iso(120000)+"','"+AT+"','"+AT+"')";
 const call=(env,id,count,mark)=>mutateFilm(env,{id,expectedRevision:0,at:AT,receiptMark:mark,film:{contractVersion:1,originalTitle:'Cap',aliases:aliases(count)}});
 const sizes=[];
 const file=database('open');
 const env=envOf(file,{onBatch:async statements=>{sizes.push(statements.length);}});
 await call(env,'film:tmdb:10',body);
 assert.equal(sizes.at(-1),MUTATION_STATEMENT_CAP,'a body at the cap is one batch of exactly the cap');
 sqlite(file,pendingFor('film:tmdb:11'));
 await call(env,'film:tmdb:11',body,markOf(requestId,1,{kind:'film',id:'film:tmdb:11'}));
 assert.equal(sizes.at(-1),MUTATION_STATEMENT_CAP+2,'the receipt tail is two statements on top of a body at the cap');
 assert.equal(receipts(file)[0].state,'applied');
 await assert.rejects(()=>call(env,'film:tmdb:12',body+1,markOf(requestId,1,{kind:'film',id:'film:tmdb:12'})),code('film_person_bounded'),'a body over the cap is refused even with a tail');
 await assert.rejects(()=>fenced.commit(env,{generation:2},[['SELECT 1',[]]],[],[['SELECT 1',[]],['SELECT 2',[]],['SELECT 3',[]]]),code('film_person_bounded'),'a tail of three statements is refused');
}

// 7. appliedStatements of the receipt module is the same pair of statements the writers append.
{
 const input={requestId:'r-1',attempt:3,target:{kind:'film',id:'film:tmdb:1'},now:AT};
 assert.deepEqual(appliedStatements(input),fenced.appliedTail(input));
 assert.deepEqual(fenced.receiptTail({requestId:'r-1',attempt:3,now:AT,target:input.target},input.target),appliedStatements(input));
 assert.deepEqual(fenced.receiptTail(undefined,input.target),[]);
 assert.deepEqual(fenced.receiptTail(null,input.target),[]);
 assert.equal(appliedStatements(input).length,2);
}

// 8. E5: a writer that finds nothing to write opens no second batch. The receipt ends `unknown` (atomic_mark_missing) and is listed for review; the entity revision does not move.
{
 const scenario=SCENARIOS.find(item=>item.name==='writeFilmFacts');
 const file=database('open');
 await through(envOf(file),scenario,'first');
 const revisionBefore=revision(file,'film','film:tmdb:2');
 const batches=[];
 const env=envOf(file,{onBatch:async statements=>{batches.push(statements.length);}});
 // identical content landed already: the planner says no-op, so the writer opens no batch, with a receipt just recorded for it
 const outcome=await through(env,{...scenario,expected:revisionBefore,call:(e,mark)=>writeFilmFacts(e,{id:'film:tmdb:2',expectedRevision:revisionBefore,at:AT,requestId:'req-facts',receiptMark:mark,film:{contractVersion:1,originalTitle:'Two',source:'tmdb'},watchlist:true})},'second');
 assert.equal(outcome.state,'unknown');
 assert.equal(outcome.errorClass,'atomic_mark_missing');
 assert.equal(outcome.needsReview,true);
 assert.equal(batches.length,2,'only the pending insert and the unknown mark: no write batch and no silent second batch');
 assert.equal(revision(file,'film','film:tmdb:2'),revisionBefore,'the revision did not move');
 const attention=await listAttention(envOf(file));
 assert.equal(attention.length,1);
 assert.equal(attention[0].errorClass,'atomic_mark_missing');
 assert.equal(attention[0].needsReview,true);
 assert.equal((await readReceipt(envOf(file),await sourceOf(scenario,'second'))).state,'unknown');
}

console.log('canonical-receipted-writers: ok');
