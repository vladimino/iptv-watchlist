// AIR-373 (ADR 0110): mutation check of the essential guards of the `cutover_accepted` gate (src/film-person-cutover-accepted.js), of its recording path
// (src/film-person-baseline.js) and of the connector tool (scripts/film-person-connector-run.mjs). Each mutant is a copy of ONE module with ONE guard removed or
// inverted; the module's test, pointed at the mutant through an environment variable, must FAIL on it. A surviving mutant is a guard no test depends on. A
// mutant that does not parse or load is a BROKEN mutant and fails this check: it is never counted as killed.
// The mutants are written OUTSIDE the repository tree (a fresh temporary directory, removed afterwards), so a mutant copy can never be committed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const ACCEPTED=[
 ['acceptance pinned',"if(!same(section.acceptance,ACCEPTED_DISCREPANCIES))reasons.push('acceptance_not_permitted');",''],
 ['permissions compared by deep equality',"const same=(candidate,pinned)=>record(candidate)&&stable(candidate)===stable(pinned);","const same=(candidate,pinned)=>record(candidate)&&candidate.id===pinned.id;"],
 ['cap enforced',"||entry.unexplained.total>cap)",")"],
 ['cap boundary',"entry.unexplained.total>cap","entry.unexplained.total>cap+1"],
 ['a differing value fails',"if(entry.differs!==0||entry.unexplained?.differs!==0)reasons.push('differs:'+name);",''],
 ['an explained differing value fails too',"if(entry.differs!==0||entry.unexplained?.differs!==0)","if(entry.unexplained?.differs!==0)"],
 ['differing total',"if(ledger.totals?.differs!==0)reasons.push('differs_total');",''],
 ['unlisted class',"if(!REQUIRED_CLASSES.includes(name)||!Number.isInteger(cap)){reasons.push('class_not_listed:'+name);continue;}","if(!Number.isInteger(cap))continue;"],
 ['totals are the sum of the classes',"if(ledger.totals?.unexplained!==unexplained)reasons.push('totals_mismatch');",''],
 ['declared discrepancies are derived',"if(stable(section.discrepancies)!==stable(discrepanciesOf(ledger)))reasons.push('discrepancies_mismatch');",''],
 ['class counts consistent',"reasons.push('unexplained_inconsistent:'+name);","void 0;"],
 ['accepted digest checked',"reasons.push('accepted_digest_mismatch');","void 0;"],
 ['accepted digest covers the section',",cutoverAccepted:ledger.cutoverAccepted}));","}));"],
 ['v1 checks kept',"const reasons=v1.reasons.filter(item=>!/^unexplained:/.test(item)&&item!=='unexplained_total');","const reasons=[];"],
 ['only the unexplained rule is replaced',"item=>!/^unexplained:/.test(item)&&item!=='unexplained_total'","item=>!/^(unexplained|source_unverified)/.test(item)"],
 ['section version',"if(!record(section)||section.version!==CUTOVER_ACCEPTED_VERSION){","if(!record(section)){"],
 ['declared accepted is derived',"if(stable(section.accepted)!==stable(acceptedList(section)))reasons.push('accepted_mismatch');",''],
 ['declared notProved is derived',"if(stable(section.notProved)!==stable(notProvedAccepted(section)))reasons.push('not_proved_mismatch');",''],
 ['permission pinned in the builder',"if(!same(permission,OPERATOR_COPY_PERMISSION))verification.push('source_permission_not_permitted');",''],
 ['permission pinned in the gate',"if(!same(section.permission,OPERATOR_COPY_PERMISSION))reasons.push('source_permission_not_permitted');",''],
 ['verdict derived from the evidence',"verified=verification.length===0;","verified=true;"],
 ['caller verdict ignored for an operator copy',"if(kind===OPERATOR_COPY_KIND){","if(kind===OPERATOR_COPY_KIND&&source?.verified!==true){"],
 ['gate derives the verdict again',"for(const item of await operatorCopyReasons(section.operatorCopy,contextOf(ledger,cm)))reasons.push('operator_copy:'+item);",''],
 ['source kind bound',"if(section.sourceKind!==(ledger.source?.kind??null))reasons.push('source_kind_mismatch');",''],
 ['no permission on another source kind',"}else if(section.permission!==null||section.operatorCopy!==null)reasons.push('source_permission_not_permitted');","}"],
 ['production equal at the three reads',"if(values[0]!==values[1]||values[1]!==values[2])reasons.push('production_moved:'+id);",''],
 ['T0 compared',"if(values[0]!==values[1]||values[1]!==values[2])","if(values[1]!==values[2])"],
 ['T2 compared',"if(values[0]!==values[1]||values[1]!==values[2])","if(values[0]!==values[1])"],
 ['copy equals production at T1',"if(hex(copied)&&copied!==values[1])reasons.push('copy_mismatch:'+id);",''],
 ['only Discovery may move',"if(id===LEASE_ID||movingStatement(id))continue;","if(id===LEASE_ID||movingStatement(id)||id.startsWith('witness:'))continue;"],
 ['Discovery may move',"if(id===LEASE_ID||movingStatement(id))continue;","if(id===LEASE_ID)continue;"],
 ['required counts come from the reviewed table list',"...GATE_IDS.map(id=>'gate:'+id),...COPY_TABLES.map(table=>'count:'+table)];}","...GATE_IDS.map(id=>'gate:'+id)];}"],
 ['every copied table is required',"...COPY_TABLES.map(table=>'count:'+table)];}","...COPY_TABLES.slice(1).map(table=>'count:'+table)];}"],
 ['required id present in the copy comparison',"if(!hex(copied))reasons.push('copy_missing:'+id);",''],
 ['unknown statement id refused',"if(!known.has(id))reasons.push('check_unknown:'+id);",''],
 ['unknown id refused in the copy comparison too',"...stages.map(stage=>checks[stage]?.digests),facts.copy?.t1?.digests]","...stages.map(stage=>checks[stage]?.digests)]"],
 ['caps are the measured counts',"caps:{film:8,","caps:{film:9,"],
 ['person cap is the 11 Nov count',"caps:{film:8,person:3,","caps:{film:8,person:6,"],
 ['personAlias cap is the 11 Nov count',"personAlias:155,credit:132,filmLocalization:8,personLocalization:3,watchlist:4,redirect:4,retirement:4,ratedAdmission:708,retention:401,projectionKey:11},\n});","personAlias:147,credit:132,filmLocalization:8,personLocalization:3,watchlist:4,redirect:4,retirement:4,ratedAdmission:708,retention:401,projectionKey:11},\n});"],
 ['gate version is 2',"export const CUTOVER_ACCEPTED_VERSION=2;","export const CUTOVER_ACCEPTED_VERSION=1;"],
 ['constant version is 2',"id:'AIR-373-accepted-discrepancies-2026-11-11',version:2,","id:'AIR-373-accepted-discrepancies-2026-11-11',version:1,"],
 ['moving list is Discovery only',"export const movingStatement=id=>id==='gate:discovery'||","export const movingStatement=id=>id.startsWith('gate:')||"],
 ['every statement present',"if(!values.every(hex)){reasons.push('check_missing:'+id);continue;}","if(!values.every(hex))continue;"],
 ['every read present',"reasons.push('check_missing:'+stage);continue;","continue;"],
 ['lease held at every read',"reasons.push('lease_not_held:'+stage);","void 0;"],
 ['lease is this run\'s',"lease.id===leaseId&&",''],
 ['lease live',"&&time(lease.until)>time(check.at)))","))"],
 ['lease is one holding',"&&lease.startedAt===checks.t0?.lease?.startedAt",''],
 ['lease id required',"if(!leaseId)reasons.push('lease_id_missing');",''],
 ['copy lease is this run\'s',"reasons.push('copy_mismatch:'+LEASE_ID);","void 0;"],
 ['lease released',"reasons.push('lease_not_released');","void 0;"],
 ['released means no holder',"released.id===null&&",''],
 ['released after the last read',"&&time(released.at)>=time(checks.t2?.at)))","))"],
 ['generation equal inside the resync',"&&discovery.generationFirst===discovery.generationLast))","))"],
 ['resync generation is the run\'s',"if(discovery.generationLast!==context?.discoveryGeneration)reasons.push('discovery_generation_not_the_run_generation');",''],
 ['Discovery copy equal',"else if(discovery.copy?.[table]!==production)reasons.push('discovery_copy_mismatch:'+table);",''],
 ['every Discovery table checked',"if(!hex(production))reasons.push('discovery_resync_missing:'+table);\n   else if","if(!hex(production))void 0;\n   else if"],
 ['resync present',"reasons.push('discovery_resync_missing');\n","void 0;\n"],
 ['resync between T1 and T2',"reasons.push('evidence_order:discovery');","void 0;"],
 ['ETags unchanged',"else if(r2.etagsBefore!==r2.etagsAfter)reasons.push('r2_etags_changed');",''],
 ['ETags are the run\'s',"&&r2.etagsBefore===context?.r2Etags?.before&&r2.etagsAfter===context?.r2Etags?.after",''],
 ['manifest is the run\'s',"&&r2.manifestDigest===context?.manifestDigest",''],
 ['complete probe',"if(!(facts.probeComplete===true&&context?.probeComplete===true))reasons.push('probe_incomplete');",''],
 ['probe as the run saw it',"&&context?.probeComplete===true",''],
 ['consistent read',"if(!(facts.readConsistent===true&&context?.readConsistent===true))reasons.push('inconsistent_read');",''],
 ['read as the run saw it',"&&context?.readConsistent===true",''],
 ['reads in order',"reasons.push('evidence_order');","void 0;"],
 ['evidence version',"if(!record(facts)||facts.version!==1)return ['evidence_missing'];","if(!record(facts))return ['evidence_missing'];"],
];
const RECORDER=[
 ['recording path is version 2',"cutover_accepted:Object.freeze({gate:'cutover_accepted',version:2})","cutover_accepted:Object.freeze({gate:'cutover_accepted',version:1})"],
 ['accepted path reaches its own gate',"if(pathIs(path,RECORDING_PATHS.cutover_accepted))return recordingAccepted(ledger,path,expectedGeneration);",''],
 ['accepted gate consulted',"const verdict=await cutoverAcceptedGate(ledger);","const verdict={gate:'cutover_accepted',version:2,pass:true,reasons:[]};"],
 ['gate reasons carried',"const why=[...verdict.reasons];","const why=[];"],
 ['recorder reasons enforced',"pass:verdict.pass===true&&why.length===0","pass:verdict.pass===true"],
 ['generation binding',"if(!(measured&&measured.mode==='r2'&&measured.generation===expectedGeneration))why.push('ledger_generation_mismatch');",''],
 ['reference names gate and version',"reference:recordingReference(path,ledger?.acceptedDigest)","reference:ledger?.acceptedDigest"],
];
const CONNECTOR=[
 ['re-load refused',"if(state.log.some(row=>row.sha256===sha256))throw stop('already_loaded');",''],
 ['plan digest on load',"if(value.planDigest!==plan.planDigest)throw stop('plan_mismatch');",''],
 ['second DDL refused',"throw stop('copy_not_empty');","void 0;"],
 ['DDL holds every copied table',"if(missing.length)throw stop('ddl_incomplete',missing.join(','));",''],
 ['no trigger in the copy',"if(rows.length!==value.rows.length)throw stop('ddl_malformed');",''],
 ['data needs the DDL',"if(!state.ddl)throw stop('ddl_not_loaded');",''],
 ['table in the plan',"if(!COPY_TABLES.includes(chunk?.t))throw stop('table_not_in_plan',String(chunk?.t));",''],
 ['complete table closed',"if(current.done)throw stop('table_already_complete',chunk.t);",''],
 ['chunk continuity',"if(chunk.from!==current.lastRowid)throw stop('chunk_out_of_order',chunk.t);",''],
 ['rows in rowid order',"if(!(row[0]>last))throw stop('chunk_out_of_order',chunk.t);",''],
 ['row count declared',"chunk.n!==chunk.rows.length||",''],
 ['columns equal',"if(stable(local)!==stable(chunk.cols))throw stop('columns_mismatch',chunk.t);",''],
 ['scalar cells only',"throw stop('cell_unsupported');","return 'NULL';"],
 ['chunk end declared',"if(chunk.after!==last||typeof chunk.done!=='boolean')throw stop('chunk_malformed',chunk.t);",''],
 ['corrupted file refused',"try{value=JSON.parse(text);}catch{throw stop('result_unreadable');}","try{value=JSON.parse(text);}catch{value={kind:'ddl',version:1,planDigest:'',at:'2026-01-01T00:00:00.000Z',rows:[]};}"],
 ['truncated resync refused',"if(value.truncated!==false)throw stop('resync_truncated');",''],
 ['generation moved inside the resync',"if(first!==last)throw stop('discovery_generation_moved');",''],
 ['resync tables fixed',"want(value.delta,['discovery_admission','discovery_decision']);",''],
 ['resync equality derived',"const equal=DISCOVERY_COPY_TABLES.every(table=>production[table]===copy[table]);","const equal=true;"],
 ['copy reads are one SELECT',"try{text=assertReadOnly(sql);}catch{throw refuse('connector_statement_refused');}","text=String(sql);"],
 ['uncopied table refused',"if(named(text).some(name=>LOG_TABLES.includes(name)||!readable(name)))throw refuse('connector_table_not_copied');",''],
 ['view needs its tables',"viewTables.has(name)?viewTables.get(name).every(table=>complete.has(table)):complete.has(name)","viewTables.has(name)||complete.has(name)"],
 ['only the lease statements write',"if(!writes.has(sql))throw refuse('connector_statement_refused');",''],
 ['copy compared statement by statement',"digests[item.id]===check.digests[item.id]);","true);"],
 ['copy lease holder compared',"&&lease.id===check.lease.id&&","&&"],
 ['check wrote nothing',"||value.written!==0)throw stop('check_malformed');",")throw stop('check_malformed');"],
 ['check ids are the plan\'s',"||stable(value.ids)!==stable(ids)",''],
 ['run needs a complete copy',"if(!state.ddl||!COPY_TABLES.every(table=>state.tables[table]?.done===true))return {ok:false,reasons:['copy_incomplete']};",''],
 ['run needs the T1 comparison',"if(!verified||verified.detail.equal!==true)return","if(!verified)return"],
 ['run needs an equal resync',"||resync.detail.equal!==true||resync.seq<verified.seq)",")"],
 ['no measurement for a refused run',"if(reasons.length)return {ok:false,reasons};",''],
 ['ETags are observed, not copied',"{key:entry.key,state:'present',etag:current.etag}","{key:entry.key,state:'present',etag:entry.etag}"],
 ['measurement digest',"||sha(stable(core))!==digest)return {ok:false,reasons:['measurement_invalid']};",")return {ok:false,reasons:['measurement_invalid']};"],
 ['check labels',"if(check.label!==stage.toUpperCase())return {ok:false,reasons:['check_label:'+stage]};",''],
 ['T1 is the compared one',"row.kind==='verify'&&row.sha256===shas.t1&&row.sha256===core.verifySha256","row.kind==='verify'&&row.sha256===core.verifySha256"],
 ['resync is the applied one',"row.kind==='resync'&&row.sha256===resyncSha&&","row.kind==='resync'&&"],
 ['release read from its file',"id:Array.isArray(release.row)&&release.row.length===1?release.row[0]?.lease_id??null:undefined","id:null"],
 ['ledger bound to runParity',"if(unverified.digest!==core.parity.ledgerDigest)return {ok:false,reasons:['parity_ledger_mismatch']};",''],
 ['plan arguments',"throw stop('plan_invalid');","void 0;"],
 // AIR-373, 11 Nov 2026: per-table page size, wall-clock guard, ignored `pad`
 ['page size reset per table',"if(done){i++;after=0;limit=PAGE_ROWS;}else after=last;","if(done){i++;after=0;}else after=last;",'full'],
 ['cursor limit resumes its own table',"limit=CURSOR&&CURSOR.limit>0?CURSOR.limit:PAGE_ROWS,used=0;","limit=PAGE_ROWS,used=0;",'full'],
 ['wall-clock guard',"if(chunks.length&&Date.now()-START>WALL_MS)break;","",'full'],
 ['wall clock starts at the call',"const START=Date.now();","const START=0;"],
 ['wall-clock budget is below the 60 s limit',"export const WALL_CLOCK_MS=40_000;","export const WALL_CLOCK_MS=400_000;",'full'],
 // AIR-373, 11 Nov 2026: the reviewed view build changes the published EPG snapshot in place; the derived inputs are verified and handed on as copies
 ['derived inputs verified from the pristine copy',"run.derivedProblems=verifyDerived(manifest,pristine);","run.derivedProblems=verifyDerived(manifest,parityInput);"],
 ['one view build, one copy',"const ledgerInput=derivedCopy();","const ledgerInput=parityInput;"],
 ['derived guard also fires on the mutated flag',"run.derivedInputsMutatedByView=verifyDerived(manifest,parityInput).length>0;","run.derivedInputsMutatedByView=false;"],
 ['pad ignored',"if('pad' in value){const {pad:_pad,...rest}=value;value=rest;}","",'full'],
];
const TARGETS=[
 {source:'src/film-person-cutover-accepted.js',test:'tests/film-person-cutover-accepted.mjs',variable:'ACCEPTED_MODULE',mutants:ACCEPTED},
 {source:'src/film-person-baseline.js',test:'tests/film-person-cutover-accepted.mjs',variable:'BASELINE_RECORD_MODULE',mutants:RECORDER},
 {source:'scripts/film-person-connector-run.mjs',test:'tests/film-person-connector.mjs',variable:'CONNECTOR_MODULE',mutants:CONNECTOR},
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connector-mutants-'));
assert.ok(path.relative(process.cwd(),dir).startsWith('..'),'the mutants are written outside the repository tree');
// A copy outside the tree keeps working: every relative import of the original becomes an absolute file URL.
const absolute=(text,from)=>text.replace(/(from\s*|import\()'(\.\.?\/[^']+)'/g,(_match,head,specifier)=>head+JSON.stringify(pathToFileURL(path.resolve(path.dirname(from),specifier)).href));
// AIR-374: a gate or recorder mutant (tests/film-person-cutover-accepted.mjs) first runs only the numbered section of that test that killed it when the hints were learned (HINTS: mutant name to
// section id, ACCEPTED_ONLY); a mutant that passes that run is run against the WHOLE file before it is called a survivor, so a stale hint costs time and never hides a survivor. Every distinct lean
// run of the UNMUTATED copy must pass too, or a lean run could "kill" for a reason of its own. ACCEPTED_LEARN=1 runs every mutant whole and prints HINTS for the file.
const LEARN=process.env.ACCEPTED_LEARN==='1';
const HINTS={
 "acceptance pinned":"2",
 "permissions compared by deep equality":"2",
 "cap enforced":"1",
 "cap boundary":"1",
 "a differing value fails":"1",
 "an explained differing value fails too":"1",
 "differing total":"1",
 "unlisted class":"1",
 "totals are the sum of the classes":"2",
 "declared discrepancies are derived":"2",
 "class counts consistent":"2",
 "accepted digest checked":"2",
 "accepted digest covers the section":"2",
 "v1 checks kept":"1",
 "only the unexplained rule is replaced":"3",
 "section version":"2",
 "declared accepted is derived":"2",
 "declared notProved is derived":"2",
 "permission pinned in the builder":"3",
 "permission pinned in the gate":"3",
 "verdict derived from the evidence":"3",
 "caller verdict ignored for an operator copy":"3",
 "gate derives the verdict again":"3",
 "source kind bound":"3",
 "no permission on another source kind":"3",
 "production equal at the three reads":"3",
 "T0 compared":"3",
 "T2 compared":"3",
 "copy equals production at T1":"3",
 "only Discovery may move":"3",
 "Discovery may move":"3",
 "required counts come from the reviewed table list":"-",
 "every copied table is required":"-",
 "required id present in the copy comparison":"3",
 "unknown statement id refused":"3",
 "unknown id refused in the copy comparison too":"3",
 "caps are the measured counts":"-",
 "person cap is the 11 Nov count":"-",
 "personAlias cap is the 11 Nov count":"-",
 "gate version is 2":"1",
 "constant version is 2":"-",
 "moving list is Discovery only":"3",
 "every statement present":"3",
 "every read present":"3",
 "lease held at every read":"3",
 "lease is this run's":"3",
 "lease live":"3",
 "lease is one holding":"3",
 "lease id required":"3",
 "copy lease is this run's":"3",
 "lease released":"3",
 "released means no holder":"3",
 "released after the last read":"3",
 "generation equal inside the resync":"3",
 "resync generation is the run's":"3",
 "Discovery copy equal":"3",
 "every Discovery table checked":"3",
 "resync present":"3",
 "resync between T1 and T2":"3",
 "ETags unchanged":"3",
 "ETags are the run's":"3",
 "manifest is the run's":"3",
 "complete probe":"3",
 "probe as the run saw it":"3",
 "consistent read":"3",
 "read as the run saw it":"3",
 "reads in order":"3",
 "evidence version":"3",
 "recording path is version 2":"-",
 "accepted path reaches its own gate":"3",
 "accepted gate consulted":"3",
 "gate reasons carried":"3",
 "recorder reasons enforced":"4",
 "generation binding":"4",
 "reference names gate and version":"4"
};
const learned={};
const run=(test,variable,file,extra={},name=null)=>new Promise(resolve=>{
 const child=spawn(process.execPath,[test],{env:{...process.env,[variable]:file,...extra},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 child.on('close',code=>{const seen=/LEAN_SECTION (\S+)/.exec(err);if(name&&code!==0&&seen)learned[name]=seen[1];resolve({code,broken:/SyntaxError|ERR_MODULE_NOT_FOUND|ReferenceError|does not provide an export/.test(err)?err.slice(0,300):null});});
});
try{
 const queue=[];const controls=new Map();
 for(const target of TARGETS){
  const original=fs.readFileSync(target.source,'utf8');
  for(const [name,from] of target.mutants)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+target.source);
  // the unmutated copy, moved the same way, must PASS: otherwise every mutant would be "killed" by the move itself
  const stem=path.basename(target.source,path.extname(target.source))+'.'+target.variable;
  const control=path.join(dir,stem+'.control.mjs');
  fs.writeFileSync(control,absolute(original,target.source));
  queue.push({name:'control '+target.source,test:target.test,variable:target.variable,file:control,control:true});
  controls.set(target.variable,{test:target.test,variable:target.variable,file:control});
  target.mutants.forEach(([name,from,to,hint],index)=>{
   const file=path.join(dir,stem+'.mutant'+index+'.mjs');
   fs.writeFileSync(file,absolute(original.replace(from,()=>to),target.source));
   queue.push({name,test:target.test,variable:target.variable,file,lean:target.test.endsWith('film-person-connector.mjs')&&hint!=='full',section:target.test.endsWith('film-person-cutover-accepted.mjs')&&!LEARN?HINTS[name]:undefined});
  });
 }
 const names=TARGETS.flatMap(target=>target.mutants.map(item=>item[0]));
 assert.equal(new Set(names).size,names.length,'mutant names are unique');
 for(const name of Object.keys(HINTS))assert.ok(names.includes(name),'a hint names no mutant: '+name);
 // the unmutated copy of each module, whole file but for one section: every lean run that is used
 const leans=new Set(queue.filter(item=>item.section).map(item=>item.variable+' '+item.section));
 for(const lean of leans){const [variable,section]=lean.split(' ');queue.unshift({name:'lean control '+lean,...controls.get(variable),control:true,only:section});}
 const survivors=[],broken=[];
 let killed=0,fullRuns=0;
 const workers=Array.from({length:Math.max(2,Math.min(8,os.availableParallelism()))},async()=>{
  while(queue.length){
   const item=queue.shift();
   // AIR-374: a connector mutant first runs WITHOUT section 3b of the connector test (CONNECTOR_SKIP_3B, an independent section that costs a third of the file). A mutant that passes
   // that run is run against the WHOLE file before it is called a survivor, so a wrong or stale choice costs time and never hides a survivor; the optional last element 'full' of a mutant
   // (the ones only section 3b kills) skips the first run. The unmutated control always runs the whole file.
   let out=await run(item.test,item.variable,item.file,item.lean?{CONNECTOR_SKIP_3B:'1'}:item.section?{ACCEPTED_ONLY:item.section}:item.only?{ACCEPTED_ONLY:item.only}:{},item.control?null:item.name);
   if(item.control){assert.equal(out.code,0,'the unmutated copy must pass: '+item.name+' '+(out.broken||''));continue;}
   if((item.lean||item.section)&&!out.broken&&out.code===0){fullRuns++;out=await run(item.test,item.variable,item.file,{},item.name);}
   if(out.broken)broken.push(item.name+': '+out.broken);
   else if(out.code===0)survivors.push(item.name);
   else killed++;
  }
 });
 await Promise.all(workers);
 if(LEARN)console.log('const HINTS='+JSON.stringify(Object.fromEntries(names.map(name=>[name,learned[name]]).filter(entry=>entry[1])),null,1)+';');
 assert.deepEqual(broken,[],'broken mutants (they do not parse or load, so they prove nothing)');
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 assert.equal(killed,ACCEPTED.length+RECORDER.length+CONNECTOR.length);
 console.log('film-person-connector-mutation: ok ('+ACCEPTED.length+' gate mutants, '+RECORDER.length+' recorder mutants and '+CONNECTOR.length+' connector mutants killed'+(fullRuns?', '+fullRuns+' needed the whole test file: mark the connector ones \'full\', refresh HINTS with ACCEPTED_LEARN=1 for the others':'')+')');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
assert.ok(!fs.existsSync(dir));
