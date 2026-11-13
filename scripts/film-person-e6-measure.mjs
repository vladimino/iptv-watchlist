// AIR-374 E6 (docs/runbooks/film-person-e6-budget-measurement.md): the OFFLINE helper of the read-only Film/Person/EPG budget measurement that precedes P3a. It touches no network, no D1, no R2, no Cloudflare and no
// connector, and it never reads or writes anything but the files named on its command line. It (1) EMITS the exact read-only SELECT statements an authorized reader would run, each with its row cap, expected columns and
// classification, (2) VERIFIES the results file an operator pasted back (shape, caps, no payload or identifier, stop rules) and (3) SUMMARIZES it into counts and percentiles and the proposed per-run unit ceiling by the stated formula.
// A pass is evidence, never permission: the production run needs its own owner GO (runbook section 8), and nothing here is a GO.
//
//   node scripts/film-person-e6-measure.mjs emit-sql                       the statements, caps and the statements digest
//   node scripts/film-person-e6-measure.mjs unit-cost                      the pinned round-trip cost of one applyFilmFacts unit (measured on the sqlite stand-in by tests/film-person-e6-measure.mjs)
//   node scripts/film-person-e6-measure.mjs next-step [--state <state.json>]   may the next statement be sent? (the pre-delta gate is enforced here)
//   node scripts/film-person-e6-measure.mjs verify-step <statement-id> <response.json> [--state <state.json>]   ONE response: CONTINUE or STOP with reasons; the state file (named on the command line) is the only file written
//   node scripts/film-person-e6-measure.mjs verify <results.json> [--allow-plain-rows]    the whole bundle: the final judgement
//   node scripts/film-person-e6-measure.mjs summarize <results.json> [--limits <limits.json>]
// A results file is {"_statementsDigest": "<digest of emit-sql>", "_capturedAt": "<ISO UTC>", "<statement id>": <D1 response envelope [{success,results,meta}] | rows array (diagnostic only)>}.
// Exit status 1 on a refusal. Output holds counts, percentiles and digests only.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertReadOnly} from './schema-preflight.mjs';

// Hard caps of one measurement run. PROPOSALS for the owner GO (the owner may lower them, never raise them in the field); the platform price or quota of D1 rows read is not verified.
export const CAPS=Object.freeze({
 rowsReadPerStatement:300000,
 rowsReadTotal:1500000,
 msPerStatement:5000,
 msTotal:60000,
 membersForDelta:20000,
});
// The cost of one applyFilmFacts unit in D1 round trips (a `first()/all()/run()` is one, a `batch()` is one: ADR 0106), measured on the sqlite stand-in with the route gate open and the receipt tables empty.
// tests/film-person-e6-measure.mjs asserts these numbers against the code, so a change of the adapter fails that test until the numbers and the runbook are updated.
export const UNIT_COST=Object.freeze({
 noop:Object.freeze({queries:14,batches:0,roundTrips:14}),
 applied:Object.freeze({queries:36,batches:2,roundTrips:38}),
});
export const SAFETY_DEFAULT=0.5;

const INT='int',TS='ts',DAY='day';
const word=(...values)=>({enum:values});
const cell=(sql,rowCap,columns,{minRows=0,answers,classification})=>({sql:assertReadOnly(sql),rowCap,columns,minRows,answers,classification});
const CLASS='D1 read through the Cloudflare D1 read path (connector d1_database_query or the API connector execute): one SELECT, no Worker route, MCP tool or Workflow runs; not an entry of docs/reference/api/read-side-effects.md; no write, lease, receipt or outbound request';

// The generation ranked by published_at, newest first (rank 1 is the live one).
const NUMBERED="SELECT programme_run_id, ROW_NUMBER() OVER (ORDER BY published_at DESC, programme_run_id) AS rn FROM published_epg_generation WHERE phase = 'published'";
const RUN=rank=>"(SELECT programme_run_id FROM ("+NUMBERED+") WHERE rn = "+Number(rank)+")";
const AT=rank=>"(SELECT published_at FROM published_epg_generation WHERE programme_run_id = "+RUN(rank)+")";
function deltaSql(rank){
 const branch=(kind)=>{
  const filter=alias=>kind==='any'?'':" AND "+alias+".kind = '"+kind+"'";
  const cur="m.programme_run_id = "+RUN(rank)+filter('m'),prev="p.programme_run_id = "+RUN(rank+1)+filter('p');
  return "SELECT '"+kind+"' AS kind, "+AT(rank)+" AS anchor, "+
   "(SELECT COUNT(DISTINCT m.film_id) FROM published_epg_member m WHERE "+cur+") AS members, "+
   "(SELECT COUNT(DISTINCT m.film_id) FROM published_epg_member m WHERE "+cur+" AND m.film_id NOT IN (SELECT p.film_id FROM published_epg_member p WHERE "+prev+")) AS joined, "+
   "(SELECT COUNT(DISTINCT p.film_id) FROM published_epg_member p WHERE "+prev+" AND p.film_id NOT IN (SELECT m.film_id FROM published_epg_member m WHERE "+cur+")) AS departed";
 };
 return ['programme','watchlist','any'].map(branch).join(' UNION ALL ');
}
const DELTA_COLUMNS={kind:word('programme','watchlist','any'),anchor:TS,members:INT,joined:INT,departed:INT};
const countOf=table=>'(SELECT COUNT(*) FROM '+table+') AS ';

export const STATEMENTS=Object.freeze({
 schema:cell('SELECT version FROM schema_contract WHERE id = 1',1,{version:INT},{minRows:1,answers:'schema version (stop rule: not 21)',classification:CLASS}),
 film_person_marker:cell('SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1',1,{mode:{pattern:/^[a-z0-9_]{1,16}$/},cutover:word('open','held'),generation:INT},{minRows:1,answers:'Film/Person marker state (stop rule: held)',classification:CLASS}),
 epg_authority:cell('SELECT mode, cutover, generation, watchlist_generation FROM published_epg_authority WHERE id = 1',1,{mode:word('r2','d1'),cutover:word('open','held'),generation:INT,watchlist_generation:INT},{minRows:1,answers:'published EPG authority (stop rule: not d1 / open)',classification:CLASS}),
 table_counts:cell('SELECT '+[['film','films'],['person','persons'],['film_person_credit','credit_rows'],['watchlist_film','watchlist_films'],['film_metadata','metadata_rows'],['film_sync_state','sync_rows'],['film_dimension','dimension_rows'],['canonical_write_receipt','receipt_rows']].map(([t,a])=>countOf(t)+a).join(', '),1,{films:INT,persons:INT,credit_rows:INT,watchlist_films:INT,metadata_rows:INT,sync_rows:INT,dimension_rows:INT,receipt_rows:INT},{minRows:1,answers:'Film, Person, credit and watchlist counts; receipts must be 0 (no producer wired)',classification:CLASS}),
 generation_summary:cell("SELECT COUNT(*) AS published_generations, MIN(published_at) AS oldest, MAX(published_at) AS newest FROM published_epg_generation WHERE phase = 'published'",1,{published_generations:INT,oldest:TS,newest:TS},{minRows:1,answers:'how many published generations exist (retention) and the anchor of the newest',classification:CLASS}),
 generation_members:cell("SELECT g.rn AS rank, g.published_at AS published_at, "+
  "(SELECT COUNT(*) FROM published_epg_member m WHERE m.programme_run_id = g.programme_run_id AND m.kind = 'programme') AS programme_members, "+
  "(SELECT COUNT(*) FROM published_epg_member m WHERE m.programme_run_id = g.programme_run_id AND m.kind = 'watchlist') AS watchlist_members, "+
  "(SELECT COUNT(DISTINCT m.film_id) FROM published_epg_member m WHERE m.programme_run_id = g.programme_run_id) AS distinct_films, "+
  "(SELECT COUNT(*) FROM published_epg_show s WHERE s.programme_run_id = g.programme_run_id) AS shows "+
  "FROM (SELECT x.programme_run_id AS programme_run_id, x.rn AS rn, y.published_at AS published_at FROM ("+NUMBERED+") x JOIN published_epg_generation y ON y.programme_run_id = x.programme_run_id) g WHERE g.rn <= 8 ORDER BY g.rn",
  8,{rank:INT,published_at:TS,programme_members:INT,watchlist_members:INT,distinct_films:INT,shows:INT},{minRows:1,answers:'observed Films per published generation (programme and watchlist members, union, shows), newest 8',classification:CLASS}),
 membership_delta_1:cell(deltaSql(1),3,DELTA_COLUMNS,{minRows:3,answers:'Films that joined and departed between the newest and the previous generation (departed members)',classification:CLASS+'; membership sets are compared inside SQL, only counts leave it'}),
 membership_delta_2:cell(deltaSql(2),3,DELTA_COLUMNS,{minRows:3,answers:'the same for the previous pair (a second run)',classification:CLASS+'; membership sets are compared inside SQL, only counts leave it'}),
 film_updates_by_day:cell("SELECT substr(updated_at, 1, 10) AS day, COUNT(*) AS films FROM film WHERE updated_at >= date('now', '-14 day') GROUP BY day ORDER BY day DESC LIMIT 15",15,{day:DAY,films:INT},{answers:'Films whose row the current writer (the projector) touched per day: a proxy for changed Films per run, NOT the number of producer units',classification:CLASS}),
 person_updates_by_day:cell("SELECT substr(updated_at, 1, 10) AS day, COUNT(*) AS persons FROM person WHERE updated_at >= date('now', '-14 day') GROUP BY day ORDER BY day DESC LIMIT 15",15,{day:DAY,persons:INT},{answers:'Persons touched per day (the same proxy)',classification:CLASS}),
 credits_histogram:cell('SELECT MIN(n, 100) AS credits, COUNT(*) AS films FROM (SELECT w.film_id AS film_id, COUNT(c.person_id) AS n FROM watchlist_film w LEFT JOIN film_person_credit c ON c.film_id = w.film_id GROUP BY w.film_id) GROUP BY credits ORDER BY credits LIMIT 101',101,{credits:INT,films:INT},{minRows:1,answers:'credits per watchlist Film (histogram, 100 means 100 or more)',classification:CLASS}),
 persons_of_watchlist:cell('SELECT COUNT(DISTINCT c.person_id) AS persons_credited, COUNT(*) AS credit_rows FROM watchlist_film w JOIN film_person_credit c ON c.film_id = w.film_id',1,{persons_credited:INT,credit_rows:INT},{minRows:1,answers:'distinct Persons credited by the watchlist and their credit rows',classification:CLASS}),
 person_credit_fanout:cell('SELECT MIN(n, 50) AS films_per_person, COUNT(*) AS persons FROM (SELECT person_id, COUNT(*) AS n FROM film_person_credit GROUP BY person_id) GROUP BY films_per_person ORDER BY films_per_person LIMIT 51',51,{films_per_person:INT,persons:INT},{answers:'Films per Person (histogram, 50 means 50 or more): the fan-out of a Person unit',classification:CLASS}),
 receipt_states:cell('SELECT state, COUNT(*) AS n FROM canonical_write_receipt GROUP BY state ORDER BY state LIMIT 10',10,{state:{pattern:/^[a-z_]{1,24}$/},n:INT},{answers:'receipt states (expected: no rows while no producer is wired)',classification:CLASS}),
});
export const ORDER=Object.freeze(Object.keys(STATEMENTS));

export function statementsDigest(){
 return createHash('sha256').update(JSON.stringify(ORDER.map(id=>[id,STATEMENTS[id].sql,STATEMENTS[id].rowCap]))).digest('hex');
}
export function emitSql(){
 return {
  readOnly:true,notAGo:true,
  note:'Nothing here authorizes a production read: the owner GO (runbook section 8) is separate.',
  statementsDigest:statementsDigest(),
  caps:CAPS,
  steps:ORDER.map(id=>({id,purpose:STATEMENTS[id].answers,sql:STATEMENTS[id].sql,rowCap:STATEMENTS[id].rowCap,columns:Object.keys(STATEMENTS[id].columns),classification:STATEMENTS[id].classification})),
  order:'run in this order, one statement per request, stop at the first refusal or stop rule; membership_delta_* only when generation_members shows every member count at or below caps.membersForDelta',
 };
}

// ---------- verification ----------
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/,DAYRE=/^\d{4}-\d\d-\d\d$/;
// Anything that looks like a payload, a title, an identifier or a URL is a refusal: results hold counts, timestamps and enum words only.
export const FORBIDDEN=/film:|person:|tmdb|https?:|@|\.(jpg|png)\b|run[-_:]/i;
function okValue(type,value){
 if(type===INT)return Number.isSafeInteger(value)&&value>=0;
 if(type===TS)return value===null||(typeof value==='string'&&ISO.test(value));
 if(type===DAY)return typeof value==='string'&&DAYRE.test(value);
 if(type&&type.enum)return type.enum.includes(value);
 if(type&&type.pattern)return typeof value==='string'&&type.pattern.test(value);
 return false;
}
const int=value=>Number.isSafeInteger(value)&&value>=0?value:null;
function rowsOf(value,id,refusals,{allowPlainRows,notes}){
 if(value===undefined||value===null){refusals.push('result_missing:'+id);return null;}
 if(!Array.isArray(value)){refusals.push('result_malformed:'+id);return null;}
 const first=value[0];
 if(value.length&&first&&typeof first==='object'&&!Array.isArray(first)&&('success' in first||'results' in first)){
  if(value.length!==1){refusals.push('result_malformed:'+id);return null;}
  if(first.success!==true||!Array.isArray(first.results)){refusals.push('result_failed:'+id);return null;}
  const meta=first.meta;
  const rowsRead=int(meta?.rows_read),duration=typeof meta?.duration==='number'&&meta.duration>=0?meta.duration:null;
  if(rowsRead===null||duration===null)refusals.push('meta_missing:'+id);
  else{
   if(rowsRead>CAPS.rowsReadPerStatement)refusals.push('rows_read_cap:'+id+':'+rowsRead);
   if(duration>CAPS.msPerStatement)refusals.push('duration_cap:'+id+':'+Math.round(duration));
  }
  return {rows:first.results,rowsRead:rowsRead??0,duration:duration??0};
 }
 if(value.some(row=>!row||typeof row!=='object'||Array.isArray(row))){refusals.push('result_malformed:'+id);return null;}
 if(!allowPlainRows)refusals.push('plain_rows_without_meta:'+id);
 else notes.push('caps_unverifiable:'+id);
 return {rows:value,rowsRead:0,duration:0};
}

// One statement's response: the envelope, caps, shape and payload checks shared by `verify` (whole bundle) and `verifyStep` (one response). Returns {rows, rowsRead, duration} or null when the response is unusable;
// `rows` is undefined when it was read but failed the row or shape rules (a refusal is then recorded).
function checkStatement(id,value,{allowPlainRows,refusals,notes}){
 const spec=STATEMENTS[id];
 const got=rowsOf(value,id,refusals,{allowPlainRows,notes});
 if(!got)return null;
 const out={rows:undefined,rowsRead:got.rowsRead,duration:got.duration};
 if(got.rows.length>spec.rowCap){refusals.push('row_cap:'+id+':'+got.rows.length);return out;}
 if(got.rows.length<spec.minRows){refusals.push('rows_missing:'+id+':'+got.rows.length);return out;}
 const columns=Object.keys(spec.columns).sort().join(',');
 for(const row of got.rows){
  if(Object.keys(row).sort().join(',')!==columns){refusals.push('columns_mismatch:'+id);return out;}
  for(const [name,type] of Object.entries(spec.columns))if(!okValue(type,row[name])){refusals.push('value_invalid:'+id+':'+name);return out;}
  if(FORBIDDEN.test(JSON.stringify(row))){refusals.push('payload_pattern:'+id);return out;}
 }
 out.rows=got.rows;
 return out;
}

export const MIN_GENERATIONS=3;
const KINDS=['any','programme','watchlist'];
const biggestOf=members=>Math.max(...members.map(row=>Math.max(row.programme_members,row.watchlist_members,row.distinct_films)));

// Stop rules of ONE statement (preconditions of the measurement). `rowsOfId` are its verified rows.
function singleRules(id,rowsOfId,stops){
 const one=rowsOfId.length===1?rowsOfId[0]:null;
 if(id==='schema'&&one&&one.version!==21)stops.push('schema_version:'+one.version);
 if(id==='film_person_marker'&&one&&one.cutover==='held')stops.push('film_person_held');
 if(id==='epg_authority'&&one&&!(one.mode==='d1'&&one.cutover==='open'))stops.push('epg_authority_not_d1_open:'+one.mode+'/'+one.cutover);
 // receipts must be empty while the producer is dormant: an unexpected receipt is a stop, not a note (the world is not the one the measurement assumes)
 if(id==='table_counts'&&one&&one.receipt_rows!==0)stops.push('receipts_present:'+one.receipt_rows);
 if(id==='receipt_states'&&rowsOfId.length)stops.push('receipt_states_present:'+rowsOfId.length);
 if(id==='generation_summary'&&one&&one.published_generations<MIN_GENERATIONS)stops.push('insufficient_generations:'+one.published_generations);
}
// The generation sample against its summary. A budget needs two genuine consecutive generation pairs: at least three published generations, ranks 1..n in order, anchors that exist.
function generationRules(summary,members,refusals,stops){
 if(summary.newest!==members[0].published_at)refusals.push('generation_moved:summary_vs_members');
 if(members.length!==Math.min(8,summary.published_generations))refusals.push('generation_count_mismatch:'+members.length+'/'+summary.published_generations);
 if(members.some((row,index)=>row.rank!==index+1))refusals.push('generation_ranks_invalid');
 if(members.some(row=>row.published_at===null))refusals.push('generation_anchor_null');
 if(members.some((row,index)=>index>0&&row.published_at!==null&&members[index-1].published_at!==null&&row.published_at>members[index-1].published_at))refusals.push('generation_order_invalid');
}
// A delta statement against the sample: the pair (rank, rank+1), exactly one row per kind, the anchor of the current generation, the member counts the sample reports and counts that are possible.
function deltaRules(id,deltaRows,members,rank,refusals){
 const current=members[rank],previous=members[rank+1];
 if(!current||!previous){refusals.push('delta_pair_missing:'+id);return;}
 if(deltaRows.map(row=>row.kind).sort().join(',')!==KINDS.join(',')){refusals.push('delta_kinds_invalid:'+id);return;}
 const countsOf=row=>({any:row.distinct_films,programme:row.programme_members,watchlist:row.watchlist_members});
 const currentCount=countsOf(current),previousCount=countsOf(previous);
 for(const row of deltaRows){
  if(row.anchor===null||row.anchor!==current.published_at){refusals.push('generation_moved:'+id);break;}
  if(row.members!==currentCount[row.kind])refusals.push('delta_members_mismatch:'+id+':'+row.kind);
  if(row.joined>row.members||row.departed>previousCount[row.kind])refusals.push('delta_counts_impossible:'+id+':'+row.kind);
 }
}

// Returns {ok, refusals, stops, notes, rows:{id:[rows]}, totals}. `ok` is true only when every statement is present and inside its caps, no payload leaked and no stop rule fired; never a permission.
export function verify(results,{allowPlainRows=false}={}){
 const refusals=[],stops=[],notes=[],rows={};
 if(!results||typeof results!=='object'||Array.isArray(results))return {ok:false,diagnosticOnly:allowPlainRows,refusals:['results_not_an_object'],stops,notes,rows,totals:null};
 const known=new Set([...ORDER,'_statementsDigest','_capturedAt']);
 for(const key of Object.keys(results))if(!known.has(key))refusals.push('unknown_result:'+String(key).slice(0,40));
 if(typeof results._statementsDigest!=='string')refusals.push('statements_digest_missing');
 else if(results._statementsDigest!==statementsDigest())refusals.push('statements_digest_mismatch');
 if(typeof results._capturedAt!=='string'||!ISO.test(results._capturedAt))refusals.push('captured_at_invalid');
 let rowsReadTotal=0,msTotal=0;
 for(const id of ORDER){
  const got=checkStatement(id,results[id],{allowPlainRows,refusals,notes});
  if(!got)continue;
  rowsReadTotal+=got.rowsRead;msTotal+=got.duration;
  if(got.rows)rows[id]=got.rows;
 }
 if(rowsReadTotal>CAPS.rowsReadTotal)refusals.push('rows_read_total:'+rowsReadTotal);
 if(msTotal>CAPS.msTotal)refusals.push('duration_total:'+Math.round(msTotal));
 for(const id of ORDER)if(rows[id])singleRules(id,rows[id],stops);
 const summary=rows.generation_summary?.[0]??null,members=rows.generation_members;
 if(summary&&members?.length){
  generationRules(summary,members,refusals,stops);
  const biggest=biggestOf(members);
  for(const id of ['membership_delta_1','membership_delta_2'])if(rows[id]&&biggest>CAPS.membersForDelta)stops.push('delta_ran_over_size_cap:'+id+':'+biggest);
  for(const [id,rank] of [['membership_delta_1',0],['membership_delta_2',1]])if(rows[id])deltaRules(id,rows[id],members,rank,refusals);
 }
 const totals={rowsRead:rowsReadTotal,ms:Math.round(msTotal)};
 const ok=refusals.length===0&&stops.length===0;
 return allowPlainRows?{ok:false,diagnosticOnly:true,shapeOk:ok,refusals,stops,notes:[...notes,'diagnostic only: caps not proven, never a pass'],rows,totals}:{ok,refusals,stops,notes,rows,totals};
}

// ---------- stepwise validation (the operator holdpoint) ----------
// One response at a time, in the emitted order, with a small state file (statements digest, position, running totals, the generation sample). The answer is CONTINUE or STOP with named reasons. Every check here is
// AFTER THE FACT: `rows_read` and `duration` arrive only once the SELECT has run, so a cap stops the NEXT statement but cannot undo the one that already ran (runbook section 5).
export function newStepState(){return {version:1,statementsDigest:statementsDigest(),done:[],rowsRead:0,ms:0,stopped:null,summary:null,members:null,deltaGate:null};}
const STATE_KEYS=['version','statementsDigest','done','rowsRead','ms','stopped','summary','members','deltaGate'];
function stateProblem(state){
 if(!state||typeof state!=='object'||Array.isArray(state))return 'state_invalid';
 if(Object.keys(state).sort().join(',')!==[...STATE_KEYS].sort().join(','))return 'state_invalid';
 if(state.version!==1||typeof state.statementsDigest!=='string'||!Array.isArray(state.done)||state.done.some((id,index)=>id!==ORDER[index]))return 'state_invalid';
 if(!Number.isSafeInteger(state.rowsRead)||state.rowsRead<0||typeof state.ms!=='number'||!Number.isFinite(state.ms)||state.ms<0)return 'state_invalid';
 if(state.stopped!==null&&!(Array.isArray(state.stopped)&&state.stopped.every(item=>typeof item==='string')))return 'state_invalid';
 if(state.deltaGate!==null&&state.deltaGate!=='open')return 'state_invalid';
 if(state.members!==null&&!(Array.isArray(state.members)&&state.members.length>=1&&state.members.length<=8))return 'state_invalid';
 if(state.summary!==null&&!(state.summary&&typeof state.summary==='object'&&Number.isSafeInteger(state.summary.published_generations)))return 'state_invalid';
 const sampleOk=row=>row&&typeof row==='object'&&['rank','programme_members','watchlist_members','distinct_films'].every(key=>Number.isSafeInteger(row[key])&&row[key]>=0)&&(row.published_at===null||typeof row.published_at==='string');
 if(state.members!==null&&!state.members.every(sampleOk))return 'state_invalid';
 // the carried facts must match the position: a statement that is done left its facts, the gate exists only after the sample
 if(!state.stopped&&state.done.includes('generation_summary')!==(state.summary!==null))return 'state_invalid';
 if(!state.stopped&&state.done.includes('generation_members')!==(state.members!==null))return 'state_invalid';
 if(state.deltaGate==='open'&&state.members===null)return 'state_invalid';
 return null;
}
// May the next statement be sent? The delta statements only after the generation sample opened their gate (at least 3 generations, no member count over caps.membersForDelta).
export function nextStep(state=newStepState()){
 const bad=stateProblem(state);
 if(bad)return {allowed:false,next:null,reasons:[bad]};
 if(state.statementsDigest!==statementsDigest())return {allowed:false,next:null,reasons:['statements_digest_mismatch']};
 if(state.stopped)return {allowed:false,next:null,reasons:['already_stopped',...state.stopped]};
 const next=ORDER[state.done.length]??null;
 if(next===null)return {allowed:false,next:null,complete:true,reasons:['all_statements_done: run the whole-bundle verify for the final judgement']};
 if(next.startsWith('membership_delta_')&&state.deltaGate!=='open')return {allowed:false,next,reasons:['delta_gate_closed']};
 return {allowed:true,next,reasons:[]};
}
export function verifyStep(id,response,state=newStepState()){
 const stopWith=(reasons,after)=>({decision:'STOP',statement:id,reasons,next:null,totals:{rowsRead:after.rowsRead,ms:Math.round(after.ms)},state:{...after,stopped:reasons}});
 const bad=stateProblem(state);
 if(bad)return stopWith([bad],newStepState());
 if(state.statementsDigest!==statementsDigest())return stopWith(['statements_digest_mismatch'],state);
 if(state.stopped)return stopWith(['already_stopped',...state.stopped],state);
 if(!ORDER.includes(id))return stopWith(['unknown_statement:'+String(id).slice(0,40)],state);
 const gate=nextStep(state);
 if(gate.next!==id)return stopWith(['out_of_order:'+id+':expected '+gate.next],state);
 if(!gate.allowed)return stopWith(gate.reasons,state);
 const refusals=[],stops=[],notes=[];
 const after={...state,done:[...state.done]};
 const got=checkStatement(id,response,{allowPlainRows:false,refusals,notes});
 if(got){after.rowsRead+=got.rowsRead;after.ms+=got.duration;}
 if(after.rowsRead>CAPS.rowsReadTotal)refusals.push('rows_read_total:'+after.rowsRead);
 if(after.ms>CAPS.msTotal)refusals.push('duration_total:'+Math.round(after.ms));
 const verified=got?.rows;
 if(verified){
  singleRules(id,verified,stops);
  if(id==='generation_summary')after.summary={newest:verified[0].newest,published_generations:verified[0].published_generations};
  if(id==='generation_members'){
   generationRules(state.summary,verified,refusals,stops);
   after.members=verified;
   // the gate for the two delta statements, decided here, before either may be sent
   if(biggestOf(verified)>CAPS.membersForDelta)stops.push('delta_gate_closed:'+biggestOf(verified));
   if(refusals.length===0&&stops.length===0)after.deltaGate='open';
  }
  if(id==='membership_delta_1')deltaRules(id,verified,state.members,0,refusals);
  if(id==='membership_delta_2')deltaRules(id,verified,state.members,1,refusals);
 }
 const reasons=[...refusals,...stops];
 if(reasons.length)return stopWith(reasons,after);
 after.done.push(id);
 const following=nextStep(after);
 return {decision:'CONTINUE',statement:id,reasons:[],notes,next:following.next,complete:following.complete===true,totals:{rowsRead:after.rowsRead,ms:Math.round(after.ms)},state:after};
}

// ---------- summary ----------
// Nearest-rank percentile of a histogram [{value,count}] sorted by value.
export function percentile(histogram,p){
 const total=histogram.reduce((sum,item)=>sum+item.count,0);
 if(total===0)return null;
 const need=Math.max(1,Math.ceil(p/100*total));
 let seen=0;
 for(const item of histogram){seen+=item.count;if(seen>=need)return item.value;}
 return histogram[histogram.length-1].value;
}
export function describe(histogram,{capped=null}={}){
 const sorted=[...histogram].sort((a,b)=>a.value-b.value);
 const total=sorted.reduce((sum,item)=>sum+item.count,0);
 const sum=sorted.reduce((acc,item)=>acc+item.value*item.count,0);
 return {n:total,min:sorted[0]?.value??null,p50:percentile(sorted,50),p90:percentile(sorted,90),p95:percentile(sorted,95),p99:percentile(sorted,99),max:sorted.at(-1)?.value??null,mean:total?Math.round(sum/total*100)/100:null,...(capped!==null?{cappedBucket:capped,atCap:sorted.at(-1)?.value===capped?sorted.at(-1).count:0}:{})};
}
const series=values=>{const v=[...values].sort((a,b)=>a-b);return v.length?{n:v.length,min:v[0],median:v[Math.floor((v.length-1)/2)],max:v.at(-1)}:{n:0,min:null,median:null,max:null};};

// The formula. For one resumable step (one Worker invocation or Workflow step; the platform values come from the limits file and are NEVER defaulted here):
//   qUnit   = changedShare * applied + (1 - changedShare) * noop        round trips of an average unit (changedShare null: worst case 1, flagged)
//   cQuery  = floor((queryBudget * (1 - safety) - fixedQueries) / qUnit)
//   cWall   = floor((wallMs * (1 - safety) - fixedMs) / (qUnit * roundTripMs))
//   cCpu    = floor((cpuMs * (1 - safety) - fixedCpuMs) / cpuMsPerUnit)
//   ceiling = min of the three; null (status incomplete) while any input is unknown, and `upperBoundWithoutUnknowns` then holds the min of the known ones.
//   steps   = ceil(unitsPerRun / ceiling)
// Every input must be an explicit finite non-negative number (the fixed parts of a step may be an explicit 0, never an implicit one): an input that is missing, null, a string, NaN, Infinity or out of range is `unknown`.
// `safety` is the one proposal with a default (SAFETY_DEFAULT when absent); once given it must be a number in [0, 1).
export function ceilingOf({unitCost=UNIT_COST,limits={},unitsPerRun=null}={}){
 const safety=limits.safety??SAFETY_DEFAULT;
 const unknown=[],per={};
 if(unitsPerRun!==null&&!(Number.isSafeInteger(unitsPerRun)&&unitsPerRun>=0))return {status:'refused',reason:'units_per_run_invalid',proposed:null};
 const num=(name,{min=0}={})=>{const v=limits[name];if(typeof v==='number'&&Number.isFinite(v)&&v>=min)return v;unknown.push(name);return null;};
 if(!(typeof safety==='number'&&safety>=0&&safety<1))return {status:'refused',reason:'safety_out_of_range',proposed:null};
 let share=limits.changedShare;
 if(share===null||share===undefined){share=1;unknown.push('changedShare');}
 else if(!(typeof share==='number'&&share>=0&&share<=1))return {status:'refused',reason:'changed_share_out_of_range',proposed:null};
 const qUnit=share*unitCost.applied.roundTrips+(1-share)*unitCost.noop.roundTrips;
 const queryBudget=num('queryBudgetPerStep',{min:1}),wallMs=num('wallMsPerStep',{min:1}),rtt=num('roundTripMs',{min:0.001}),cpuMs=num('cpuMsPerStep',{min:1}),cpuUnit=num('cpuMsPerUnit',{min:0.001});
 const fixedQueriesIn=num('fixedQueries'),fixedMsIn=num('fixedMs'),fixedCpuMsIn=num('fixedCpuMs');
 // an unknown fixed part is left out of the arithmetic ONLY to give the upper bound of the known constraints; it is listed as unknown, so no ceiling is proposed
 const fixedQueries=fixedQueriesIn??0,fixedMs=fixedMsIn??0,fixedCpuMs=fixedCpuMsIn??0;
 if(queryBudget!==null)per.query=Math.max(0,Math.floor((queryBudget*(1-safety)-fixedQueries)/qUnit));
 if(wallMs!==null&&rtt!==null)per.wall=Math.max(0,Math.floor((wallMs*(1-safety)-fixedMs)/(qUnit*rtt)));
 if(cpuMs!==null&&cpuUnit!==null)per.cpu=Math.max(0,Math.floor((cpuMs*(1-safety)-fixedCpuMs)/cpuUnit));
 const known=Object.values(per);
 const complete=unknown.length===0&&known.length===3;
 const best=known.length?Math.min(...known):null;
 const binding=best===null?null:Object.keys(per).find(key=>per[key]===best);
 const out={status:complete?'complete':'incomplete',formula:'min(cQuery, cWall, cCpu) with each constraint x (1 - safety) less its fixed part',safety,qUnit:Math.round(qUnit*100)/100,ceilings:per,binding,unknown:[...new Set(unknown)],proposed:complete?best:null,upperBoundWithoutUnknowns:complete?null:best};
 const ceiling=complete?best:null;
 if(unitsPerRun!==null&&ceiling!==null)out.stepsPerRun=ceiling===0?null:Math.ceil(unitsPerRun/ceiling);
 return out;
}

export function summarize(results,{limits={},allowPlainRows=false}={}){
 const checked=verify(results,{allowPlainRows});
 if(!checked.ok)return {ok:false,refusals:checked.refusals,stops:checked.stops,notes:checked.notes};
 const rows=checked.rows;
 const members=rows.generation_members;
 const delta=id=>Object.fromEntries(rows[id].map(row=>[row.kind,{members:row.members,joined:row.joined,departed:row.departed}]));
 const deltas=[delta('membership_delta_1'),delta('membership_delta_2')];
 const perRun=deltas.map(item=>({observed:item.any.members,joined:item.any.joined,departed:item.any.departed,units:item.any.members+item.any.departed}));
 const unitsPerRun=Math.max(...perRun.map(item=>item.units));
 const credits=describe(rows.credits_histogram.map(row=>({value:row.credits,count:row.films})),{capped:100});
 const fanout=describe(rows.person_credit_fanout.map(row=>({value:row.films_per_person,count:row.persons})),{capped:50});
 const day=key=>series(rows[key].map(row=>row[key==='film_updates_by_day'?'films':'persons']));
 const counts=rows.table_counts[0];
 return {
  ok:true,
  generations:{published:rows.generation_summary[0].published_generations,sampled:members.length,
   observedFilms:series(members.map(row=>row.distinct_films)),programmeMembers:series(members.map(row=>row.programme_members)),watchlistMembers:series(members.map(row=>row.watchlist_members)),shows:series(members.map(row=>row.shows))},
  perRun,
  unitsPerRun,
  departedMembers:series(perRun.map(item=>item.departed)),
  watchlistSize:counts.watchlist_films,
  counts,
  creditsPerWatchlistFilm:credits,
  filmsPerPerson:fanout,
  persons:rows.persons_of_watchlist[0],
  filmUpdatesPerDay:day('film_updates_by_day'),
  personUpdatesPerDay:day('person_updates_by_day'),
  unitCost:UNIT_COST,
  ceiling:ceilingOf({unitCost:UNIT_COST,limits,unitsPerRun}),
  d1:checked.totals,
  notes:[...checked.notes,'sample: '+perRun.length+' run pair(s); membership change is not content change: the share of units that really apply (changedShare) comes only from a producer dry run'],
 };
}

// ---------- CLI ----------
function main(argv){
 const [command,arg,arg2]=argv;
 const flag=name=>{const index=argv.indexOf(name);return index>=0?argv[index+1]:null;};
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
 let out;
 if(command==='emit-sql')out=emitSql();
 else if(command==='unit-cost')out={unitCost:UNIT_COST,note:'pinned by tests/film-person-e6-measure.mjs on the sqlite stand-in; a production number is only the wall time per round trip'};
 else if(command==='next-step'){const state=flag('--state');out=nextStep(state&&fs.existsSync(state)?read(state):newStepState());out.ok=out.allowed||out.complete===true;}
 else if(command==='verify-step'&&arg&&arg2){
  const stateFile=flag('--state');
  const state=stateFile&&fs.existsSync(stateFile)?read(stateFile):newStepState();
  const result=verifyStep(arg,read(arg2),state);
  if(stateFile)fs.writeFileSync(stateFile,JSON.stringify(result.state,null,1));
  const {state:_state,...rest}=result;out={...rest,ok:result.decision==='CONTINUE'};
 }
 else if(command==='verify'&&arg){const {rows:_rows,...rest}=verify(read(arg),{allowPlainRows:argv.includes('--allow-plain-rows')});out=rest;}
 else if(command==='summarize'&&arg){const limits=flag('--limits');out=summarize(read(arg),{limits:limits?read(limits):{},allowPlainRows:argv.includes('--allow-plain-rows')});}
 else{console.error('usage: emit-sql | unit-cost | next-step [--state <state.json>] | verify-step <statement-id> <response.json> [--state <state.json>] | verify <results.json> [--allow-plain-rows] | summarize <results.json> [--limits <limits.json>]');return 2;}
 console.log(JSON.stringify(out,null,1));
 return out.ok===false?1:0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main(process.argv.slice(2));
