// AIR-374 P3-0b: mutation check of the producer receipt adapter (src/canonical-producer-adapters.js) and the origin filter of src/canonical-receipts.js, in the pattern of tests/canonical-film-writers-mutation.mjs. Each mutant is a copy of the whole src/ directory with ONE
// rule removed or inverted in ONE file; tests/canonical-producer-adapters.mjs, pointed at the copy through ADAPTER_SRC, must FAIL on it. A surviving mutant is a rule no test depends on; a mutant
// that does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards), so one can never be committed. Four at a time, one shared template database.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

// [name, file in src/, exact text that occurs once, replacement]
const MUTANTS=[
 ["applyFilmFacts ignores the route", "canonical-producer-adapters.js", "const route=await writerRoute(env);\n if(route.writer!=='canonical')return {state:'skipped'", "const route=await writerRoute(env);\n if(false)return {state:'skipped'"],
 ["reconcileOwnOrigin ignores the route", "canonical-producer-adapters.js", "if(route.writer!=='canonical')return {skipped:true", "if(false)return {skipped:true"],
 ["the digest keeps the write clock at", "canonical-producer-adapters.js", "if(key!=='at'&&key!=='updatedAt'&&value[key]!==undefined)", "if(key!=='updatedAt'&&value[key]!==undefined)"],
 ["the digest keeps updatedAt", "canonical-producer-adapters.js", "if(key!=='at'&&key!=='updatedAt'&&value[key]!==undefined)", "if(key!=='at'&&value[key]!==undefined)"],
 ["the digest ignores the target id", "canonical-producer-adapters.js", "digestOf({operation:FILM_FACTS_OPERATION,id:input?.id,content:", "digestOf({operation:FILM_FACTS_OPERATION,content:"],
 ["the digest ignores the facts", "canonical-producer-adapters.js", "for(const key of CONTENT_KEYS)if(input[key]!==undefined)", "for(const key of ['film'])if(input[key]!==undefined)"],
 ["the request id drops the source event", "canonical-producer-adapters.js", "source:{event,target:{kind:target.kind,id:target.id},digest}", "source:{target:{kind:target.kind,id:target.id},digest}"],
 ["the request id drops the digest", "canonical-producer-adapters.js", "source:{event,target:{kind:target.kind,id:target.id},digest}", "source:{event,target:{kind:target.kind,id:target.id}}"],
 ["the request id drops the target", "canonical-producer-adapters.js", "source:{event,target:{kind:target.kind,id:target.id},digest}", "source:{event,digest}"],
 ["the event is optional", "canonical-producer-adapters.js", "typeof event!=='string'||!event.trim()||event.length>300||", "false||"],
 ["a blank event is accepted", "canonical-producer-adapters.js", "typeof event!=='string'||!event.trim()||", "typeof event!=='string'||"],
 ["the event length is unbounded", "canonical-producer-adapters.js", "||event.length>300||", "||"],
 ["the target kind is unchecked", "canonical-producer-adapters.js", "||(target.kind!=='film'&&target.kind!=='person')||", "||"],
 ["the digest shape is unchecked", "canonical-producer-adapters.js", "||!DIGEST.test(digest||''))throw failed('film_person_invalid');\n return requestIdOf", "||false)throw failed('film_person_invalid');\n return requestIdOf"],
 ["a no-op still creates a receipt", "canonical-producer-adapters.js", "if(plan.noop)return {state:'noop'", "if(false)return {state:'noop'"],
 ["the pre-plan reports the planned revision as 0", "canonical-producer-adapters.js", "expectedRevision:snapshot.revision,changes", "expectedRevision:0,changes"],
 ["the adapter write is not atomic", "canonical-producer-adapters.js", "  atomic:true,\n  readback:spec.readback,", "  atomic:false,\n  readback:spec.readback,"],
 ["the spec is not atomic", "canonical-producer-adapters.js", "  operation:FILM_FACTS_OPERATION,\n  atomic:true,", "  operation:FILM_FACTS_OPERATION,\n  atomic:false,"],
 ["the writer gets no receipt mark", "canonical-producer-adapters.js", "expectedRevision:ctx.currentRevision,receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target}}),\n });", "expectedRevision:ctx.currentRevision}),\n });"],
 ["the replay gets no receipt mark", "canonical-producer-adapters.js", "expectedRevision:ctx.currentRevision,receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:now(),target:ctx.target}});", "expectedRevision:ctx.currentRevision});"],
 ["the writer runs against the planned revision on a retry", "canonical-producer-adapters.js", "expectedRevision:ctx.currentRevision,receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:clock()", "expectedRevision:plan.expectedRevision,receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:clock()"],
 ["the replay runs against the planned revision", "canonical-producer-adapters.js", "expectedRevision:ctx.currentRevision,receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:now()", "expectedRevision:receipt.plannedRevision,receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:now()"],
 ["the writer uses another request id than the receipt", "canonical-producer-adapters.js", "writeFilmFacts(env,{...input,requestId,expectedRevision:ctx.currentRevision", "writeFilmFacts(env,{...input,requestId:'x',expectedRevision:ctx.currentRevision"],
 ["the writer mark carries another attempt", "canonical-producer-adapters.js", "receiptMark:{requestId:ctx.requestId,attempt:ctx.attempt,now:clock()", "receiptMark:{requestId:ctx.requestId,attempt:1,now:clock()"],
 ["the reconcile drops the origin", "canonical-producer-adapters.js", "return reconcileReceipts(env,{operations,origin,limit:cap,policy,", "return reconcileReceipts(env,{operations,limit:cap,policy,"],
 ["the inline limit is not applied", "canonical-producer-adapters.js", "Math.min(Math.max(Number(limit)||1,1),INLINE_RECONCILE_LIMIT,RECONCILE_LIMIT_MAX)", "Math.min(Math.max(Number(limit)||1,1),RECONCILE_LIMIT_MAX)"],
 ["the inline reconcile needs no origin", "canonical-producer-adapters.js", "if(!IDENT.test(origin||'')||!operations||typeof operations.get!=='function')throw", "if(!operations||typeof operations.get!=='function')throw"],
 ["the inline reconcile needs no registry", "canonical-producer-adapters.js", "if(!IDENT.test(origin||'')||!operations||typeof operations.get!=='function')throw", "if(!IDENT.test(origin||''))throw"],
 ["the replay trusts a changed re-plan", "canonical-producer-adapters.js", "if(!found.ok)throw failed('film_person_invalid');", ""],
 ["the replay trusts a missing re-plan", "canonical-producer-adapters.js", "if(!found)throw failed('producer_replan_unavailable');", ""],
 ["the re-plan digest is not compared", "canonical-producer-adapters.js", "ok:matches(input,receipt,await filmFactsDigest(input))", "ok:matches(input,receipt,receipt.contentDigest)"],
 ["the readback treats absent content as present", "canonical-producer-adapters.js", "digest:present?receipt.contentDigest:null", "digest:receipt.contentDigest"],
 ["the readback treats present content as absent", "canonical-producer-adapters.js", "digest:present?receipt.contentDigest:null", "digest:null"],
 ["the revalidation always proceeds", "canonical-producer-adapters.js", ".noop?'superseded':'proceed';\n  },", "?'proceed':'proceed';\n  },"],
 ["the revalidation never proceeds", "canonical-producer-adapters.js", ".noop?'superseded':'proceed';\n  },", ".noop?'superseded':'stale';\n  },"],
 ["the revalidation proceeds without a re-plan", "canonical-producer-adapters.js", "if(!found||!found.ok)return 'stale';", "if(!found)return 'stale';"],
 ["the spec needs no re-plan hook", "canonical-producer-adapters.js", "if(typeof replan!=='function')throw failed('film_person_invalid');", "if(false)throw failed('film_person_invalid');"],
 ["the outcome loses the request id", "canonical-producer-adapters.js", "return {...outcome,requestId};", "return {...outcome};"],
 ["the listing ignores the origin", "canonical-receipts.js", "+(origin!==null?' AND origin=?':'');\n return (await many(db,'SELECT '+COLUMNS+' FROM canonical_write_receipt WHERE '+where+' ORDER BY next_attempt_at,request_id LIMIT ?',[...list,...(dueBefore?[dueBefore]:[]),...(origin!==null?[origin]:[]),cap])", "+'';\n return (await many(db,'SELECT '+COLUMNS+' FROM canonical_write_receipt WHERE '+where+' ORDER BY next_attempt_at,request_id LIMIT ?',[...list,...(dueBefore?[dueBefore]:[]),cap])"],
 ["the listing origin is applied after the limit", "canonical-receipts.js", "+(origin!==null?' AND origin=?':'');\n return (await many(db,'SELECT '+COLUMNS+' FROM canonical_write_receipt WHERE '+where+' ORDER BY next_attempt_at,request_id LIMIT ?',[...list,...(dueBefore?[dueBefore]:[]),...(origin!==null?[origin]:[]),cap])).map(view);", "+'';\n return (await many(db,'SELECT '+COLUMNS+' FROM canonical_write_receipt WHERE '+where+' ORDER BY next_attempt_at,request_id LIMIT ?',[...list,...(dueBefore?[dueBefore]:[]),cap])).map(view).filter(row=>origin===null||row.origin===origin);"],
 ["the listing origin is not validated", "canonical-receipts.js", "export async function listReceipts(env,{states=NON_TERMINAL,dueBefore=null,limit=RECONCILE_LIMIT_MAX,origin=null}={}){\n const db=database(env);\n if(origin!==null&&!IDENT.test(origin||''))throw failed('film_person_invalid');", "export async function listReceipts(env,{states=NON_TERMINAL,dueBefore=null,limit=RECONCILE_LIMIT_MAX,origin=null}={}){\n const db=database(env);"],
 ["the reconcile does not pass the origin on", "canonical-receipts.js", "listReceipts(env,{dueBefore:at,limit,origin})", "listReceipts(env,{dueBefore:at,limit})"],
 ["the reconcile origin is not validated", "canonical-receipts.js", "limit=20,policy=RETRY_POLICY,origin=null}={}){\n if(origin!==null&&!IDENT.test(origin||''))throw failed('film_person_invalid');", "limit=20,policy=RETRY_POLICY,origin=null}={}){"],
 ["a changed re-plan throws instead of declaring a disposition", "canonical-producer-adapters.js", "if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};", "if(found&&!found.ok)throw failed('producer_replan_unavailable');"],
 ["a changed re-plan reads as present or absent content", "canonical-producer-adapters.js", "if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};", ""],
 ["the source-changed class is another one", "canonical-producer-adapters.js", "export const SOURCE_CHANGED='producer_source_changed';", "export const SOURCE_CHANGED='producer_replan_unavailable';"],
 ["a missing re-plan is terminal", "canonical-producer-adapters.js", "if(!found)return {digest:null,revision:snapshot.revision};", "if(!found)return {disposition:'abandon',errorClass:SOURCE_CHANGED};"],
 ["a missing re-plan throws out of the readback", "canonical-producer-adapters.js", "if(!found)return {digest:null,revision:snapshot.revision};", "if(!found)throw failed('producer_replan_unavailable');"],
 ["a throwing re-plan escapes", "canonical-producer-adapters.js", "try{input=await replan(receipt);}catch{input=null;}", "input=await replan(receipt);"],
 ["a declared disposition is not recognised", "canonical-receipts.js", "observed.disposition==='abandon'&&IDENT.test", "false&&IDENT.test"],
 ["a declared class is not validated", "canonical-receipts.js", "observed.disposition==='abandon'&&IDENT.test(observed.errorClass||'')?", "observed.disposition==='abandon'?"],
 ["the reconcile does not act on a declared disposition", "canonical-receipts.js", "const declared=abandonOf(seen);\n  if(declared){", "const declared=null;\n  if(declared){"],
 ["the reconcile abandons with another class", "canonical-receipts.js", "{kind:'abandoned',errorClass:declared},clock());result.abandoned.push({requestId:row.requestId,reason:declared})", "{kind:'abandoned',errorClass:'other_class'},clock());result.abandoned.push({requestId:row.requestId,reason:declared})"],
 ["the natural path ignores a declared disposition", "canonical-receipts.js", "const declared=abandonOf(observed);\n  const action=declared?", "const declared=null;\n  const action=declared?"],
 ["an unreadable target waits forever", "canonical-receipts.js", "if(timeOf(at)-timeOf(row.createdAt)>policy.abandonAfterMs){\n    try", "if(false){\n    try"],
 ["an unreadable target is abandoned at once", "canonical-receipts.js", "if(timeOf(at)-timeOf(row.createdAt)>policy.abandonAfterMs){\n    try", "if(true){\n    try"],
 ["film_facts is not an operation kind", "canonical-receipts.js", "'film_merge','film_facts','film_credits','film_metadata'", "'film_merge','film_credits','film_metadata'"]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'producer-adapters-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=(env)=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-producer-adapters.mjs'],{env:{...process.env,ADAPTER_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const queue=MUTANTS.map(([name,file,from,to],index)=>{
  const copy=path.join(dir,'src'+index);
  fs.cpSync('src',copy,{recursive:true});
  fs.writeFileSync(path.join(copy,file),text(file).replace(from,()=>to));
  return {name,env:{ADAPTER_SRC:copy}};
 });
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.env);fs.rmSync(item.env.ADAPTER_SRC,{recursive:true,force:true});if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-producer-adapters-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
