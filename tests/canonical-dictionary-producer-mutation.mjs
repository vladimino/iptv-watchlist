// AIR-374 P3a (ADR 0127): mutation check of the dormant dictionary-store producer layer (src/canonical-dictionary-producer.js), in the pattern of tests/canonical-epg-producer-mutation.mjs. Each mutant is a copy of src/ with ONE rule removed or
// inverted in this one file; tests/canonical-dictionary-producer.mjs, pointed at the copy through DICT_SRC, must FAIL on it. A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. The copies live OUTSIDE the
// repository tree (a temporary directory, removed afterwards), so one can never be committed. Four at a time, one shared template database.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

// [name, file in src/, exact text that occurs once, replacement]
const MUTANTS=[
 ["the gate ignores the route", "canonical-dictionary-producer.js", "if(!(await producerRouteOpen(env)))return {skipped:true", "if(false)return {skipped:true"],
 ["the gate always skips", "canonical-dictionary-producer.js", "if(!(await producerRouteOpen(env)))return {skipped:true", "if(true)return {skipped:true"],
 ["the origin is not dictionary", "canonical-dictionary-producer.js", "export const DICTIONARY_ORIGIN='dictionary';", "export const DICTIONARY_ORIGIN='epg';"],
 ["the title source is not dictionary", "canonical-dictionary-producer.js", "export const DICTIONARY_SOURCE='dictionary';", "export const DICTIONARY_SOURCE='tmdb';"],
 ["the localization source version carries the dictionary version", "canonical-dictionary-producer.js", "export const DICTIONARY_SOURCE_VERSION='verified';", "export const DICTIONARY_SOURCE_VERSION='v';"],
 ["the hard cap is lifted", "canonical-dictionary-producer.js", "Math.min(Math.max(Number(limit)||1,1),DICTIONARY_UNIT_HARD_CAP)", "Math.max(Number(limit)||1,1)"],
 ["the cap floor is removed", "canonical-dictionary-producer.js", "Math.min(Math.max(Number(limit)||1,1),DICTIONARY_UNIT_HARD_CAP)", "Math.min(Number(limit),DICTIONARY_UNIT_HARD_CAP)"],
 ["the hard cap exceeds the budget", "canonical-dictionary-producer.js", "export const DICTIONARY_UNIT_HARD_CAP=50;", "export const DICTIONARY_UNIT_HARD_CAP=500;"],
 ["the default exceeds the ceiling", "canonical-dictionary-producer.js", "export const DICTIONARY_UNIT_LIMIT_DEFAULT=25;", "export const DICTIONARY_UNIT_LIMIT_DEFAULT=250;"],
 ["the pass ignores the cursor", "canonical-dictionary-producer.js", "let index=cursor,stoppedBy=null;", "let index=0,stoppedBy=null;"],
 ["the pass ignores the limit", "canonical-dictionary-producer.js", "index-cursor<cap;index++", "index<plan.units.length;index++"],
 ["done is always true", "canonical-dictionary-producer.js", "done:index>=plan.units.length,counts,conflicts", "done:true,counts,conflicts"],
 ["a held marker does not stop the pass", "canonical-dictionary-producer.js", "if(HELD.has(code)){stoppedBy=code;break;}", "if(false){stoppedBy=code;break;}"],
 ["an unreadable marker does not stop the pass", "canonical-dictionary-producer.js", "const HELD=new Set(['film_person_held','film_person_unavailable']);", "const HELD=new Set(['film_person_held']);"],
 ["a refusal stops the whole pass", "canonical-dictionary-producer.js", "counts.failed++;failures.push({id:unit.id,code});", "counts.failed++;failures.push({id:unit.id,code});break;"],
 ["a refusal is not recorded", "canonical-dictionary-producer.js", "counts.failed++;failures.push({id:unit.id,code});", "counts.failed++;"],
 ["the unit does not use the snapshot event", "canonical-dictionary-producer.js", "event:plan.event,input:built.input", "event:'fixed',input:built.input"],
 ["the event is not bound to the digest", "canonical-dictionary-producer.js", "event:'dictionary:'+snapshot.version+':'+snapshot.digest,", "event:'dictionary:'+snapshot.version,"],
 ["the event is not bound to the version", "canonical-dictionary-producer.js", "event:'dictionary:'+snapshot.version+':'+snapshot.digest,", "event:'dictionary:'+snapshot.digest,"],
 ["the digest ignores the version", "canonical-dictionary-producer.js", "operation:'dictionary_snapshot',version,entries:list", "operation:'dictionary_snapshot',entries:list"],
 ["the digest ignores the entries", "canonical-dictionary-producer.js", "operation:'dictionary_snapshot',version,entries:list", "operation:'dictionary_snapshot',version,entries:[]"],
 ["the digest is not ordered", "canonical-dictionary-producer.js", "const list=entries.map(normaliseEntry).sort(byFilm);", "const list=entries.map(normaliseEntry);"],
 ["the units are not sorted", "canonical-dictionary-producer.js", "snapshot.entries.map(entry=>({id:entry.filmId,entry}))", "[...snapshot.entries].reverse().map(entry=>({id:entry.filmId,entry}))"],
 ["the sort is descending", "canonical-dictionary-producer.js", "a.filmId<b.filmId?-1:a.filmId>b.filmId?1:0", "a.filmId<b.filmId?1:a.filmId>b.filmId?-1:0"],
 ["duplicate Films are accepted", "canonical-dictionary-producer.js", "new Set(list.map(entry=>entry.filmId)).size!==list.length||", "false||"],
 ["duplicate entry ids are accepted", "canonical-dictionary-producer.js", "||new Set(list.map(entry=>entry.id)).size!==list.length)throw", "||false)throw"],
 ["a non-verified entry is accepted", "canonical-dictionary-producer.js", "||raw.status!=='verified')throw", "||false)throw"],
 ["an entry without a Film is accepted", "canonical-dictionary-producer.js", "typeof raw.filmId!=='string'||!raw.filmId.startsWith('film:')||", "false||"],
 ["an entry id is not bounded", "canonical-dictionary-producer.js", "||raw.id.length>64||", "||false||"],
 ["a malformed tmdb id is accepted", "canonical-dictionary-producer.js", "if(tmdb!==null&&!TMDB.test(tmdb))throw failed('film_person_invalid');", "if(false)throw failed('film_person_invalid');"],
 ["an entry without facts is accepted", "canonical-dictionary-producer.js", "if(!original&&!title)throw failed('film_person_invalid');", "if(false)throw failed('film_person_invalid');"],
 ["aliases are unbounded", "canonical-dictionary-producer.js", "strings(raw.aliases,50)", "strings(raw.aliases,5000)"],
 ["sources are unbounded", "canonical-dictionary-producer.js", "strings(raw.sources,10)", "strings(raw.sources,1000)"],
 ["an empty alias is accepted", "canonical-dictionary-producer.js", "value.some(item=>typeof item!=='string'||!item.trim())", "value.some(item=>typeof item!=='string')"],
 ["the version is not validated", "canonical-dictionary-producer.js", "if(typeof version!=='string'||!VERSION.test(version)||!Array.isArray(entries))", "if(!Array.isArray(entries))"],
 ["the clock is not required", "canonical-dictionary-producer.js", "if(typeof at!=='string'||!at)throw failed('film_person_invalid');\n const snapshot", "const snapshot"],
 ["an absent Film is created", "canonical-dictionary-producer.js", "if(!stored||!Number.isInteger(stored.contract_version))return {outcome:'absent',conflicts};", "if(!stored||!Number.isInteger(stored.contract_version))stored=snapshot.film={contract_version:1,canonical_identity:null,original_title:null,updated_at:at};"],
 ["an absent Film is not recognised", "canonical-dictionary-producer.js", "if(!stored||!Number.isInteger(stored.contract_version))return {outcome:'absent',conflicts};", "if(false)return {outcome:'absent',conflicts};"],
 ["a redirect is written", "canonical-dictionary-producer.js", "if(snapshot.redirect)return {outcome:'redirected',conflicts};", ""],
 ["a trusted other tmdb id is ignored", "canonical-dictionary-producer.js", "(trusted.length>0&&!trusted.includes(entry.tmdbId))||", "false||"],
 ["a stored other identity is ignored", "canonical-dictionary-producer.js", "||(stored.canonical_identity&&stored.canonical_identity!==wantedIdentity))", "||false)"],
 ["a mismatch is named as another reason", "canonical-dictionary-producer.js", "reason:'identity_mismatch',kind:'kept'}]}", "reason:'owner_kept',kind:'kept'}]}"],
 ["the identity is filled without a trusted id", "canonical-dictionary-producer.js", "if(!trusted.includes(entry.tmdbId))conflicts.push", "if(false)conflicts.push"],
 ["the identity is never filled", "canonical-dictionary-producer.js", "else{film.canonicalIdentity=wantedIdentity;filmChanges=true;}", "else{filmChanges=true;}"],
 ["an existing identity is overwritten", "canonical-dictionary-producer.js", "if(wantedIdentity!==null&&!stored.canonical_identity){", "if(wantedIdentity!==null){"],
 ["the contract version is a constant", "canonical-dictionary-producer.js", "const film={contractVersion:stored.contract_version};", "const film={contractVersion:1};"],
 ["the Film clock always moves", "canonical-dictionary-producer.js", "updatedAt:filmChanges?at:(stored.updated_at||at)", "updatedAt:at"],
 ["the Film clock never moves", "canonical-dictionary-producer.js", "updatedAt:filmChanges?at:(stored.updated_at||at)", "updatedAt:stored.updated_at||at"],
 ["the title is written without an identity row", "canonical-dictionary-producer.js", "else if(!identity)conflicts.push({field:'originalTitle',reason:'no_identity_row',kind:'kept'});", "else if(false)conflicts.push({field:'originalTitle',reason:'no_identity_row',kind:'kept'});"],
 ["an equal title is not restated", "canonical-dictionary-producer.js", "if(storedTitle===entry.original){if(identity)send();}", "if(storedTitle===entry.original){}"],
 ["an equal title is restated without an identity row", "canonical-dictionary-producer.js", "if(storedTitle===entry.original){if(identity)send();}", "if(storedTitle===entry.original){send();}"],
 ["an empty title is not filled", "canonical-dictionary-producer.js", "else if(storedTitle===null){send();filmChanges=true;}", "else if(storedTitle===null){}"],
 ["a fill does not move the clock", "canonical-dictionary-producer.js", "else if(storedTitle===null){send();filmChanges=true;}", "else if(storedTitle===null){send();}"],
 ["a reviewed or owner identity row does not protect the title", "canonical-dictionary-producer.js", "else if(strong||storedSource==='owner')", "else if(false)"],
 ["the owner title source does not protect the title", "canonical-dictionary-producer.js", "else if(strong||storedSource==='owner')", "else if(strong)"],
 ["the title reason ignores the owner authority", "canonical-dictionary-producer.js", "reason:identity.authority==='owner'||storedSource==='owner'?'owner_kept':'reviewed_kept'", "reason:'reviewed_kept'"],
 ["the title reason always owner", "canonical-dictionary-producer.js", "reason:identity.authority==='owner'||storedSource==='owner'?'owner_kept':'reviewed_kept'", "reason:'owner_kept'"],
 ["an unranked stored title is overwritten", "canonical-dictionary-producer.js", "else if(storedSource===null)conflicts.push({field:'originalTitle',reason:'unranked_kept',kind:'kept'});", "else if(false)conflicts.push({field:'originalTitle',reason:'unranked_kept',kind:'kept'});"],
 ["a replaced title is not named", "canonical-dictionary-producer.js", "conflicts.push({field:'originalTitle',reason:'replaced_lower',kind:'replaced',from:storedSource});", "/* unnamed */"],
 ["a replaced title forgets its source", "canonical-dictionary-producer.js", "reason:'replaced_lower',kind:'replaced',from:storedSource}", "reason:'replaced_lower',kind:'replaced'}"],
 ["a replaced title is not written", "canonical-dictionary-producer.js", "else{send();filmChanges=true;conflicts.push({field:'originalTitle',reason:'replaced_lower'", "else{filmChanges=true;conflicts.push({field:'originalTitle',reason:'replaced_lower'"],
 ["the title is written under another source", "canonical-dictionary-producer.js", "film.source=DICTIONARY_SOURCE;", "film.source='epg';"],
 ["the title is written with the Film original", "canonical-dictionary-producer.js", "film.originalTitle=entry.original;", "film.originalTitle=entry.title;"],
 ["an owner localization is overwritten", "canonical-dictionary-producer.js", "if(localization&&localization.authority==='owner')conflicts.push", "if(false)conflicts.push"],
 ["an owner localization is named as reviewed", "canonical-dictionary-producer.js", "reason:'owner_kept',kind:'kept'});\n  else{", "reason:'reviewed_kept',kind:'kept'});\n  else{"],
 ["a reviewed localization replacement is not named", "canonical-dictionary-producer.js", "if(other&&localization.status==='reviewed')conflicts.push({field:'localization',reason:'replaced_reviewed',kind:'replaced'});", "if(other&&localization.status==='reviewed'){}"],
 ["an automatic localization replacement is not named", "canonical-dictionary-producer.js", "else if(other)conflicts.push({field:'localization',reason:'replaced_automatic',kind:'replaced'});", "else if(other){}"],
 ["an equal localization is a conflict", "canonical-dictionary-producer.js", "localization.value!==entry.title;", "localization.value!==undefined;"],
 ["a blank stored localization is a conflict", "canonical-dictionary-producer.js", "text(localization.value)!==null&&", "true&&"],
 ["the localization is not reviewed", "canonical-dictionary-producer.js", "status:'reviewed',source:DICTIONARY_SOURCE,", "status:'provisional',source:DICTIONARY_SOURCE,"],
 ["the localization authority is not dictionary", "canonical-dictionary-producer.js", "provenance:{authority:'dictionary',sources:entry.sources}", "provenance:{authority:'owner',sources:entry.sources}"],
 ["the localization value is the original title", "canonical-dictionary-producer.js", "value:entry.title,updatedAt:at", "value:entry.original,updatedAt:at"],
 ["the localization drops the sources", "canonical-dictionary-producer.js", "provenance:{authority:'dictionary',sources:entry.sources}", "provenance:{authority:'dictionary',sources:[]}"],
 ["the localization is not sent", "canonical-dictionary-producer.js", "if(entry.title){\n  if(localization", "if(false){\n  if(localization"],
 ["nothing-to-write is always proceed", "canonical-dictionary-producer.js", "if(film.originalTitle===undefined&&film.canonicalIdentity===undefined&&input.localization===undefined)return {outcome:'kept',conflicts};", "if(false)return {outcome:'kept',conflicts};"],
 ["nothing-to-write needs no localization check", "canonical-dictionary-producer.js", "film.canonicalIdentity===undefined&&input.localization===undefined)return", "film.canonicalIdentity===undefined)return"],
 ["nothing-to-write needs no identity check", "canonical-dictionary-producer.js", "film.originalTitle===undefined&&film.canonicalIdentity===undefined&&", "film.originalTitle===undefined&&"],
 ["nothing-to-write needs no title check", "canonical-dictionary-producer.js", "if(film.originalTitle===undefined&&film.canonicalIdentity===undefined&&", "if(film.canonicalIdentity===undefined&&"],
 ["the builder accepts a missing clock", "canonical-dictionary-producer.js", "||typeof at!=='string'||!at)throw failed('film_person_invalid');\n const conflicts", "||false)throw failed('film_person_invalid');\n const conflicts"],
 ["conflicts are not reported", "canonical-dictionary-producer.js", "for(const item of built.conflicts)conflicts.push({id:unit.id,...item});", ""],
 ["conflicts lose the unit id", "canonical-dictionary-producer.js", "conflicts.push({id:unit.id,...item})", "conflicts.push({...item})"],
 ["a non-proceed outcome is applied anyway", "canonical-dictionary-producer.js", "if(built.outcome!=='proceed'){counts[built.outcome]++;continue;}", "if(false){counts[built.outcome]++;continue;}"],
 ["a non-proceed outcome is not counted", "canonical-dictionary-producer.js", "if(built.outcome!=='proceed'){counts[built.outcome]++;continue;}", "if(built.outcome!=='proceed'){continue;}"],
 ["noop is counted as applied", "canonical-dictionary-producer.js", "if(outcome.state==='noop')counts.noop++;", "if(outcome.state==='noop')counts.applied++;"],
 ["already is not counted", "canonical-dictionary-producer.js", "else if(outcome.already===true)counts.already++;", "else if(outcome.already===true){/* lost */}"],
 ["an unknown outcome is counted applied", "canonical-dictionary-producer.js", "else if(outcome.state==='unknown')counts.unknown++;", "else if(outcome.state==='unknown')counts.applied++;"],
 ["the cursor is malformed-tolerant", "canonical-dictionary-producer.js", "||!Number.isInteger(cursor)||cursor<0)throw", "||false)throw"],
 ["a plan without an event is accepted", "canonical-dictionary-producer.js", "typeof plan.event!=='string'||typeof plan.at!=='string'||", "typeof plan.at!=='string'||"],
 ["a plan without a clock is accepted", "canonical-dictionary-producer.js", "||typeof plan.at!=='string'||!Number.isInteger(cursor)", "||!Number.isInteger(cursor)"],
 ["the replay is not bound to the snapshot", "canonical-dictionary-producer.js", "if(expected!==receipt.requestId)return null;", ""],
 ["the replay binds to a fixed event", "canonical-dictionary-producer.js", "event:plan.event,target:receipt.target,digest:receipt.contentDigest", "event:'dictionary:fixed',target:receipt.target,digest:receipt.contentDigest"],
 ["the replay ignores the receipt digest", "canonical-dictionary-producer.js", "target:receipt.target,digest:receipt.contentDigest}", "target:receipt.target,digest:'0'.repeat(64)}"],
 ["the replay ignores the Film", "canonical-dictionary-producer.js", "const unit=byId.get(receipt?.target?.id);", "const unit=[...byId.values()][0];"],
 ["the replay is always empty", "canonical-dictionary-producer.js", "if(!unit||typeof plan?.event!=='string'||typeof plan?.at!=='string'||!env)return null;", "return null;"],
 ["the replay is planned without the store", "canonical-dictionary-producer.js", "||typeof plan?.at!=='string'||!env)return null;", "||typeof plan?.at!=='string')return null;"],
 ["reconcile does not give the store to the re-plan", "canonical-dictionary-producer.js", "replan:dictionaryReplan(plan,env),", "replan:dictionaryReplan(plan),"],
 ["reconcile uses another origin", "canonical-dictionary-producer.js", "reconcileOwnOrigin(env,{origin:DICTIONARY_ORIGIN,", "reconcileOwnOrigin(env,{origin:'epg',"],
 ["reconcile drops the origin", "canonical-dictionary-producer.js", "reconcileOwnOrigin(env,{origin:DICTIONARY_ORIGIN,operations", "reconcileOwnOrigin(env,{origin:undefined,operations"],
 ["reconcile drops the limit", "canonical-dictionary-producer.js", "...(limit!==undefined?{limit}:{}),", ""],
 ["reconcile drops the plan", "canonical-dictionary-producer.js", "filmFactsOperation({replan:dictionaryReplan(plan,env),", "filmFactsOperation({replan:async()=>null,"]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dict-producer-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=(env)=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-dictionary-producer.mjs'],{env:{...process.env,DICT_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const queue=MUTANTS.map(([name,file,from,to],index)=>{
  const copy=path.join(dir,'src'+index);
  fs.cpSync('src',copy,{recursive:true});
  fs.writeFileSync(path.join(copy,file),text(file).replace(from,()=>to));
  return {name,env:{DICT_SRC:copy}};
 });
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.env);fs.rmSync(item.env.DICT_SRC,{recursive:true,force:true});if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-dictionary-producer-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
