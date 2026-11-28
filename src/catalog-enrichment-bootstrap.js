// AIR-605 (ADR 0219 decision 3): the GENERIC, OFFLINE bootstrap mechanism of the scopes that have existing members. It pages through the scope's existing members in a fixed key order and writes `admitted` signals through the same
// inbox the live trigger writes, so the producer treats a bootstrapped member exactly like a new admission. This module is DORMANT: nothing in the Worker imports it, and nothing here enables a scope, sets a cutoff, activates
// the producer or schedules a run. Enabling the rated scope and EXECUTING its qualifying bootstrap with the approved cutoff belong to the activation card (AIR-607); this file is the mechanism and its offline contract.
//   - GAP-FREE: the live trigger is enabled first (the scope is `activated` and `enabled`), the bootstrap runs after; a row inserted during the bootstrap is caught by the trigger, a row that exists is caught here.
//   - DEDUPLICATED: both write the same inbox key; the bootstrap inserts only when the key is absent (`ON CONFLICT DO NOTHING`), so the overlap with the live tail never re-arms a signal or doubles a version.
//   - FENCED: every page is ONE batch whose signal inserts and cursor advance are guarded by the scope's `revision` (a changed configuration stops the bootstrap instead of letting a stale one continue) and by the cursor the page
//     was read at (a concurrent pager advances nothing twice). The cursor and state live in the scope row and advance under that revision, so the bootstrap is resumable and idempotent.
//   - BOUNDED: a page reads at most `pageSize` rows; `runBootstrap` runs at most `maxPages` pages per call and reports where it stopped.
import {database,failed,many,one} from './film-person-authority.js';

export const BOOTSTRAP_PAGE=50;
export const BOOTSTRAP_MAX_PAGES=20;
// The scopes with existing members. rated: the verified rated admissions at or after the approved cutoff; c3a: every admitted rated Film. (c3b and discovery have their own cards; discovery has no bootstrap.)
const DEFINITIONS=Object.freeze({
 rated:{table:'film_rated_admission',cutoff:true,part:''},
 c3a:{table:'film_rated_admission',cutoff:false,part:'c3a'}, // its own signal key (part = the scope): a distinct authorized membership, never the rated one
});
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export async function readScope(env,scope){
 return one(database(env),'SELECT scope,activated,enabled,cutoff_at,bootstrap_state,bootstrap_cursor,revision FROM catalog_enrichment_scope WHERE scope=?',[scope]);
}

// One page. -> {outcome:'advanced'|'done'|'stopped', reason?, rows, cursor, state}
// `pin` ({revision, cutoffAt}, optional) is the configuration the CALLER approved: a page that finds another revision or cutoff stops (`configuration_changed`) instead of adopting it, so an activation keeps its approved envelope on every page.
export async function bootstrapPage(env,{scope,at,pageSize=BOOTSTRAP_PAGE,pin=null}){
 if(!ISO.test(String(at))||!Number.isInteger(pageSize)||pageSize<1||pageSize>200)throw failed('film_person_invalid');
 const definition=DEFINITIONS[scope];
 if(!definition)throw failed('catalog_enrichment_bootstrap_scope_unsupported');
 const handle=database(env);
 const row=await readScope(env,scope);
 if(!row||Number(row.activated)!==1||Number(row.enabled)!==1)return {outcome:'stopped',reason:'scope_not_enabled',rows:0,cursor:row?.bootstrap_cursor??null,state:row?.bootstrap_state??'none'};
 if(pin&&(Number(row.revision)!==pin.revision||(row.cutoff_at??null)!==(pin.cutoffAt??null)))return {outcome:'stopped',reason:'configuration_changed',rows:0,cursor:row.bootstrap_cursor??null,state:row.bootstrap_state};
 if(row.bootstrap_state==='done')return {outcome:'done',rows:0,cursor:row.bootstrap_cursor??null,state:'done'};
 if(definition.cutoff&&!row.cutoff_at)return {outcome:'stopped',reason:'cutoff_missing',rows:0,cursor:row.bootstrap_cursor??null,state:row.bootstrap_state};
 const revision=Number(row.revision),cursor=row.bootstrap_cursor??null;
 const page=await many(handle,`SELECT film_id,tmdb FROM ${definition.table} WHERE (? IS NULL OR film_id>?)${definition.cutoff?' AND verified_at>=?':''} ORDER BY film_id LIMIT ?`,[cursor,cursor,...(definition.cutoff?[row.cutoff_at]:[]),pageSize]);
 const last=page.length?page[page.length-1].film_id:cursor;
 const done=page.length<pageSize;
 const fence="EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE scope=? AND revision=? AND cutoff_at IS ? AND activated=1 AND enabled=1 AND bootstrap_state IN ('none','running') AND bootstrap_cursor IS ?)";
 const fenceParams=[scope,revision,row.cutoff_at??null,cursor];
 const statements=page.map(item=>[`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_ref,armed_at,attempts) SELECT 'admitted',?,'rated',?,1,0,'pending','bootstrap:'||?,?,0 WHERE ${fence} ON CONFLICT (kind,subject,source,part) DO NOTHING`,['tmdb:'+item.tmdb,definition.part,scope,at,...fenceParams]]);
 // the cursor advance is the LAST statement, with the same fence: it moves only when the page was read at the current revision and cursor
 statements.push([`UPDATE catalog_enrichment_scope SET bootstrap_cursor=?,bootstrap_state=?,updated_at=? WHERE scope=? AND revision=? AND cutoff_at IS ? AND activated=1 AND enabled=1 AND bootstrap_state IN ('none','running') AND bootstrap_cursor IS ?`,[last,done?'done':'running',at,scope,revision,row.cutoff_at??null,cursor]]);
 await handle.batch(statements.map(([sql,params])=>handle.prepare(sql).bind(...params)));
 const after=await readScope(env,scope);
 // the page committed when the cursor and state moved to where this page put them; a revision that moved AFTER that commit stops the next page but does not make the written rows disappear, so they are still reported
 const advanced=(after?.bootstrap_cursor??null)===(last??null)&&after?.bootstrap_state===(done?'done':'running');
 const unchanged=Number(after?.revision)===revision;
 if(!advanced||!unchanged)return {outcome:'stopped',reason:!unchanged?'revision_moved':'cursor_moved',rows:advanced?page.length:0,cursor:after?.bootstrap_cursor??null,state:after?.bootstrap_state??'none'};
 return {outcome:done?'done':'advanced',rows:page.length,cursor:last,state:done?'done':'running'};
}

// Runs pages until done, stopped or `maxPages`; resumable from the stored cursor. -> {outcome, pages, rows, cursor, state, reason?}
export async function runBootstrap(env,{scope,at,pageSize=BOOTSTRAP_PAGE,maxPages=BOOTSTRAP_MAX_PAGES,pin=null}){
 let pages=0,rows=0,last={outcome:'advanced',cursor:null,state:'none'};
 while(pages<maxPages){
  last=await bootstrapPage(env,{scope,at,pageSize,pin});
  rows+=last.rows;
  if(last.outcome==='stopped')break;
  pages++;
  if(last.outcome==='done')break;
 }
 return {outcome:last.outcome,pages,rows,cursor:last.cursor,state:last.state,...(last.reason?{reason:last.reason}:{})};
}

// The re-enable of a scope re-runs its idempotent bootstrap (decision 3): reset the state and the cursor under the scope's revision, which also raises it (a configuration change). It enables or activates nothing.
export async function rearmBootstrap(env,{scope,at,expectedRevision}){
 if(!DEFINITIONS[scope]||!ISO.test(String(at))||!Number.isInteger(expectedRevision))throw failed('film_person_invalid');
 const handle=database(env);
 await handle.prepare("UPDATE catalog_enrichment_scope SET bootstrap_state='none',bootstrap_cursor=NULL,revision=revision+1,updated_at=? WHERE scope=? AND revision=? AND activated=1").bind(at,scope,expectedRevision).run();
 const row=await readScope(env,scope);
 return {rearmed:!!row&&Number(row.revision)===expectedRevision+1&&row.bootstrap_state==='none',revision:row?Number(row.revision):null};
}
