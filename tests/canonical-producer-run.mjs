// AIR-374 S4-1 (ADR 0128): the PURE decision layer of the durable EPG canonical producer pass (src/canonical-producer-run.js). No database, no Worker, no R2, no network, no clock: every input is injected. Covered: the error classification table
// (exhaustive over the codes the producer path can raise, so a new code without a class fails here), the strike identity state machine (scripted and property-style), the plan fingerprint and the source-only unit digests of every existing
// planner kind (asserted, not assumed), the prerequisite stamp, the result-row state machine with the retry and revalidation decisions, generation-aware freshness (truth table and the no-false-freshness property), the cursor order and
// the durable-outcome rule, the dictionary version minting decision, the owner-review three-case guard, the three scenarios of the ADR S4-1 list as pure decisions, and dormancy.
// RUN_SRC points the module under test and the two planner files that hold the per-unit-refusal wrappers at a mutant copy of src/ (tests/canonical-producer-run-mutation.mjs); the adapters are always the real ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const SRC=process.env.RUN_SRC?path.resolve(process.env.RUN_SRC):path.resolve('src');
const R=await import(pathToFileURL(path.join(SRC,'canonical-producer-run.js')).href);
const real=name=>import(pathToFileURL(path.resolve('src',name)).href);
const {filmFactsDigest}=await real('canonical-producer-adapters.js');
const {unitDigest,CREDITS_PER_UNIT_MAX}=await real('canonical-person-adapters.js');
const planners=name=>import(pathToFileURL(path.join(SRC,name)).href);
const {planEpgUnits,planEpgUnitsWithRefusals}=await planners('canonical-epg-producer.js');
const {planEpgPersonUnits,planEpgPersonUnitsWithRefusals}=await planners('canonical-epg-person-producer.js');
const {planDictionaryUnits,buildDictionaryInput}=await real('canonical-dictionary-producer.js');
const {RETRY_POLICY,digestOf}=await real('canonical-receipts.js');
const {CLASS}=R;

const H=char=>char.repeat(64);
const NOW=Date.parse('2026-11-12T10:00:00.000Z');
const AT='2026-11-12T10:00:00.000Z';
const codeOf=fn=>{try{fn();}catch(error){return error.code;}return null;};
const codeOfAsync=async fn=>{try{await fn();}catch(error){return error.code;}return null;};
const sortedEq=(actual,expected,message)=>assert.deepEqual([...actual].sort(),[...expected].sort(),message);

// ---- 1. The classification table ----
{
 const byClass=cls=>Object.entries(R.ERROR_CLASSES).filter(([,value])=>value===cls).map(([code])=>code);
 sortedEq(byClass(CLASS.UNIT),['film_person_revision_conflict','film_person_precondition','identity_collision','person_role_collision','credit_ordinal_conflict','film_person_identity_conflict','film_person_data_conflict','film_person_redirect_conflict','film_person_retirement_history'],'unit-specific');
 sortedEq(byClass(CLASS.PERMANENT),['film_person_invalid','film_person_bounded','dictionary_source_ambiguous'],'permanent');
 sortedEq(byClass(CLASS.RECOVERABLE),['no_identity_row','needs_trusted_tmdb_id','film_person_reference','film_person_redirect','dictionary_identity_ambiguous','owner_review_inconsistent'],'recoverable');
 sortedEq(byClass(CLASS.KEPT),['owner_kept','reviewed_kept','unranked_kept','identity_mismatch','snapshot_already_applied','absent','credits_absent_from_source'],'kept');
 sortedEq(byClass(CLASS.UNCLASSIFIED),['unclassified'],'unclassified');
 for(const code of ['film_person_unavailable','film_person_held','film_person_not_open','film_person_fence','film_person_run_mismatch','producer_store_missing','producer_run_unreadable','producer_cas_lost','producer_slice_commit_failed','producer_strike_commit_failed','producer_marker_unreadable','producer_transport','producer_timeout','producer_storage','owner_review_check_failed'])assert.equal(R.ERROR_CLASSES[code],CLASS.SYSTEMIC,code+' is systemic');
 assert.ok(Object.isFrozen(R.ERROR_CLASSES),'the table is frozen');
 assert.ok(Object.values(R.ERROR_CLASSES).every(value=>Object.values(CLASS).includes(value)));
 // EXHAUSTIVE over the producer path: every code a planner, an adapter, a writer or the receipt layer raises (a `failed('code')` literal) or a dictionary conflict reason has a class. A new code without a row fails here.
 const files=['canonical-epg-producer','canonical-epg-person-producer','canonical-dictionary-producer','canonical-person-adapters','canonical-producer-adapters','canonical-person-state','canonical-film-writers','canonical-mutations','canonical-receipts','canonical-producers','film-person-authority'];
 const found=new Map();
 for(const file of files){
  const text=fs.readFileSync(path.resolve('src',file+'.js'),'utf8');
  for(const match of text.matchAll(/failed\('([a-z][a-z_0-9]*)'\s*[,)]/g))found.set(match[1],file);
  if(file==='canonical-dictionary-producer')for(const match of text.matchAll(/reason:'([a-z][a-z_0-9]*)',kind:'kept'/g))found.set(match[1],file);
 }
 assert.ok(found.size>=35,'the scan finds the code surface ('+found.size+')');
 const missing=[...found].filter(([code])=>!Object.hasOwn(R.ERROR_CLASSES,code)).map(([code,file])=>code+' ('+file+')');
 assert.deepEqual(missing,[],'every code of the producer path has a class: '+missing.join(', '));
 // The scan itself would catch a new code: a code that is not in the table classifies as `unclassified`.
 assert.equal(R.classOfCode('a_brand_new_code'),CLASS.UNCLASSIFIED);
 assert.deepEqual(['film_person_invalid','a_brand_new_code'].filter(code=>R.classOfCode(code)===CLASS.UNCLASSIFIED),['a_brand_new_code']);
 // The classification function.
 const verdict=error=>R.classifyProducerError(error);
 for(const count of [1,2,3,4,100])assert.deepEqual([verdict({code:'film_person_unavailable'}).class,verdict({code:'film_person_unavailable'}).action],[CLASS.SYSTEMIC,'stop'],'unavailable is a stop at any count '+count);
 assert.deepEqual(verdict(new Error('boom')),{code:'film_person_unavailable',class:CLASS.SYSTEMIC,action:'stop',replanFirst:false},'an error without a code is a storage failure');
 assert.deepEqual(verdict({code:'something_new'}),{code:'unclassified',class:CLASS.UNCLASSIFIED,action:'stop',replanFirst:false},'an unknown code stops the pass');
 assert.deepEqual(verdict({code:'Bad Code!'}),{code:'unclassified',class:CLASS.UNCLASSIFIED,action:'stop',replanFirst:false});
 assert.equal(verdict('unclassified').action,'stop');
 assert.equal(verdict({code:'film_person_precondition'}).replanFirst,true);
 assert.equal(verdict({code:'film_person_revision_conflict'}).replanFirst,true);
 assert.equal(verdict({code:'identity_collision'}).replanFirst,false);
 assert.deepEqual(['film_person_bounded','film_person_invalid','dictionary_source_ambiguous'].map(code=>verdict(code).action),['refuse_permanent','refuse_permanent','refuse_permanent']);
 assert.deepEqual(['no_identity_row','needs_trusted_tmdb_id','film_person_reference','film_person_redirect','dictionary_identity_ambiguous','owner_review_inconsistent'].map(code=>verdict(code).action),Array(6).fill('refuse_recoverable'));
 assert.deepEqual(['owner_kept','reviewed_kept','unranked_kept'].map(code=>verdict(code).action),['keep','keep','keep']);
 assert.equal(R.OUTCOME_CODES.redirected,'film_person_redirect');
 assert.equal(verdict(R.OUTCOME_CODES.redirected).action,'refuse_recoverable');
 assert.equal(R.classOfCode('toString'),CLASS.UNCLASSIFIED,'a prototype name is not a code');
}

// ---- 2. The strike state machine ----
const U=(id,kind='film_facts')=>({kind,id,digest:H('a')});
const fresh=(extra={})=>({cursor_kind:null,cursor_id:null,pass_no:1,pass_state:'passing',stopped_by:null,...R.NO_STRIKE,...extra});
const fail=(run,unit,code)=>R.strikeStep(run,{type:'unit_failed',unit,error:{code}});
{
 // scripted: 0 -> 1 -> 2 -> third strike (result, cursor, clear)
 const u=U('film:1');
 let step=fail(fresh(),u,'identity_collision');
 assert.deepEqual([step.action,step.run.strike_count,step.run.strike_id,step.run.strike_class,step.run.cursor_id],['strike',1,'film:1','identity_collision',null]);
 assert.equal(R.strikeViolation(fresh(),step.run,'failure'),null);
 let step2=fail(step.run,u,'identity_collision');
 assert.deepEqual([step2.action,step2.run.strike_count,step2.run.cursor_id],['strike',2,null],'the cursor does not move on a strike');
 const third=fail(step2.run,u,'identity_collision');
 assert.equal(third.action,'third_strike');
 assert.deepEqual([third.run.strike_count,third.run.strike_id,third.run.strike_kind,third.run.strike_digest,third.run.strike_class,third.run.cursor_kind,third.run.cursor_id],[0,null,null,null,null,'film_facts','film:1'],'the third strike clears the identity and advances the cursor');
 assert.deepEqual(third.result,{state:'open',code:'identity_collision',attempts:3});
 assert.equal(R.strikeViolation(step2.run,third.run,'third_strike'),null);
 // a new identity (other unit, digest or class) starts at 1 in the same step
 for(const other of [{...U('film:2')},{...u,digest:H('b')}]){const s=fail(step2.run,other,'identity_collision');assert.deepEqual([s.action,s.run.strike_count,s.run.strike_id,s.run.strike_digest],['strike',1,other.id,other.digest]);assert.equal(R.strikeViolation(step2.run,s.run,'failure'),null);}
 const otherClass=fail(step2.run,u,'film_person_data_conflict');assert.equal(otherClass.run.strike_count,1);assert.equal(otherClass.run.strike_class,'film_person_data_conflict');
 // success of the struck unit resets; success of a different unit does not touch it (the cursor still moves)
 const ok=R.strikeStep(step2.run,{type:'unit_done',unit:{kind:'film_facts',id:'film:1'}});
 assert.deepEqual([ok.run.strike_count,ok.run.strike_id,ok.run.cursor_id],[0,null,'film:1']);assert.equal(R.strikeViolation(step2.run,ok.run,'unit_done'),null);
 const later=R.strikeStep(step2.run,{type:'unit_done',unit:{kind:'film_facts',id:'film:9'}});
 assert.deepEqual([later.run.strike_count,later.run.strike_id,later.run.cursor_id],[2,'film:1','film:9']);assert.equal(R.strikeViolation(step2.run,later.run,'cursor'),null);
 // a plan change clears the strike, resets the cursor and raises pass_no
 const plan=R.strikeStep(step2.run,{type:'plan_changed'});
 assert.deepEqual([plan.action,plan.run.strike_count,plan.run.cursor_id,plan.run.pass_no,plan.run.pass_state],['replay',0,null,2,'passing']);assert.equal(R.strikeViolation(step2.run,plan.run,'plan_changed'),null);
 // a systemic failure at count 1 and 2 touches no strike column and no cursor, whatever the repeat count
 for(const count of [1,2]){
  let run=fresh();for(let i=0;i<count;i++)run=fail(run,u,'identity_collision').run;
  for(const code of ['film_person_unavailable','film_person_held','film_person_not_open','film_person_fence','film_person_run_mismatch','producer_slice_commit_failed','brand_new_code']){
   let current=run;
   for(let repeat=0;repeat<5;repeat++){
    const s=fail(current,u,code);
    assert.equal(s.action,'stop',code);
    assert.deepEqual([s.run.strike_count,s.run.strike_id,s.run.strike_digest,s.run.strike_class,s.run.strike_kind,s.run.cursor_id],[count,'film:1',u.digest,'identity_collision','film_facts',null],'systemic '+code+' at count '+count);
    assert.equal(s.run.pass_state,'stopped');assert.equal(s.run.stopped_by,R.classifyProducerError(code).code);
    assert.equal(R.strikeViolation(current,s.run,'systemic'),null);
    current=s.run;
   }
   // the stop resumes: the next failure continues from the same count
   const resumed=fail({...current,pass_state:'passing',stopped_by:null},u,'identity_collision');
   assert.equal(resumed.action,count===2?'third_strike':'strike');
  }
 }
 // an explicit systemic event (a failed slice or strike commit) is a stop that touches no strike
 const sys=R.strikeStep(step2.run,{type:'systemic',error:{code:'producer_strike_commit_failed'}});
 assert.deepEqual([sys.action,sys.run.strike_count,sys.run.stopped_by],['stop',2,'producer_strike_commit_failed']);
 assert.equal(R.strikeStep(step2.run,{type:'systemic',error:{code:'identity_collision'}}).action,'stop','a non-systemic code in a systemic event still stops');
 // a refusal is no strike; it moves the cursor with its result; it clears the strike only of the SAME unit
 const refusal=fail(step2.run,{kind:'film_facts',id:'film:1',digest:H('c')},'film_person_invalid');
 assert.deepEqual([refusal.action,refusal.run.strike_count,refusal.run.cursor_id,refusal.result],['refuse_permanent',0,'film:1',{state:'refused_permanent',code:'film_person_invalid',attempts:1}]);
 const refusalOther=fail(step2.run,{kind:'film_facts',id:'film:7',digest:H('c')},'no_identity_row');
 assert.deepEqual([refusalOther.action,refusalOther.run.strike_count,refusalOther.run.strike_id,refusalOther.result.state],['refuse_recoverable',2,'film:1','refused_recoverable']);
 const kept=fail(fresh(),U('film:3'),'owner_kept');assert.deepEqual([kept.action,kept.run.cursor_id,kept.run.strike_count],['unit_done','film:3',0]);
 // the cursor never moves backwards or stays
 assert.equal(codeOf(()=>R.strikeStep(fresh({cursor_kind:'film_facts',cursor_id:'film:5'}),{type:'unit_done',unit:{kind:'film_facts',id:'film:5'}})),'film_person_invalid');
 assert.equal(codeOf(()=>R.strikeStep(fresh({cursor_kind:'film_facts',cursor_id:'film:5'}),{type:'unit_done',unit:{kind:'film_facts',id:'film:4'}})),'film_person_invalid');
 // a malformed run row is refused: the CHECKs
 assert.equal(codeOf(()=>R.strikeStep(fresh({strike_count:2}),{type:'plan_changed'})),'film_person_invalid','a count without an identity');
 assert.equal(codeOf(()=>R.strikeStep(fresh({strike_count:3,strike_id:'x',strike_kind:'film_facts',strike_digest:H('a'),strike_class:'identity_collision'}),{type:'plan_changed'})),'film_person_invalid','a count at the limit is never stored');
 assert.equal(codeOf(()=>R.strikeStep(fresh(),{type:'unit_failed',unit:{kind:'film_facts',id:'film:1',digest:'short'},error:{code:'identity_collision'}})),'film_person_invalid');
 assert.equal(codeOf(()=>R.strikeStep(fresh(),{type:'nope'})),'film_person_invalid');
}
{
 // strikeViolation: the SQL trigger rules, on hand-built pairs
 const s=(count,id='film:1',digest=H('a'),cls='identity_collision')=>count===0?{...R.NO_STRIKE}:{strike_kind:'film_facts',strike_id:id,strike_digest:digest,strike_class:cls,strike_count:count};
 const v=(a,b,cause)=>R.strikeViolation(a,b,cause);
 assert.equal(v(s(1),s(2),'failure'),null);
 assert.equal(v(s(0),s(1),'failure'),null);
 assert.match(v(s(2),s(1),'failure'),/decrement/);
 assert.match(v(s(0),s(2),'failure'),/start at 1/);
 assert.equal(v(s(1),s(1,'film:2'),'failure'),null);
 assert.match(v(s(2),s(2,'film:2'),'failure'),/start at 1/,'a new identity must start at 1');
 assert.match(v(s(1),s(3),'failure'),/skip/,'a skip');assert.match(v(s(2),s(3),'failure'),/limit/,'a count at the limit is never stored');
 assert.match(v(s(1),s(0),'failure'),/reset outside/);
 assert.match(v(s(2),s(0),'cursor'),/another unit/);
 assert.equal(v(s(2),s(0),'unit_done'),null);assert.equal(v(s(2),s(0),'third_strike'),null);assert.equal(v(s(2),s(0),'plan_changed'),null);
 assert.match(v(s(1),s(2),'systemic'),/systemic/);assert.match(v(s(1),s(0),'systemic'),/systemic/);assert.equal(v(s(1),s(1),'systemic'),null);
 assert.match(v(s(1),s(2),'unit_done'),/not a failure/);
 assert.match(v(s(1),{...s(1),strike_id:null},'failure'),/disagree/);
}
{
 // PROPERTY: random sequences never violate the invariants, and the count follows an independent oracle.
 let seed=0x9e3779b9;
 const rnd=()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
 const pick=list=>list[Math.floor(rnd()*list.length)];
 const units=Array.from({length:6},(_,i)=>({kind:'film_facts',id:'film:'+i}));
 const unitCodes=['identity_collision','identity_collision','identity_collision','film_person_data_conflict','person_role_collision'];
 const systemic=['film_person_unavailable','film_person_held','film_person_fence','producer_slice_commit_failed','mystery'];
 let steps=0,thirds=0,stops=0,replays=0,maxStored=0;
 for(let sequence=0;sequence<300;sequence++){
  let run=fresh(),index=0;const durable=new Set();let oracle={id:null,digest:null,cls:null,count:0};
  for(let n=0;n<70;n++){
   const unit=units[index]??null;
   const roll=rnd();
   let event=null,expectCause=null;
   if(!unit||roll<0.04){event={type:'plan_changed'};}
   else if(roll<0.22)event={type:'systemic',error:{code:pick(systemic)}};
   else if(roll<0.30)event={type:'unit_failed',unit:{...unit,digest:H('a')},error:{code:pick(systemic)}};
   else if(roll<0.72)event={type:'unit_failed',unit:{...unit,digest:rnd()<0.1?H('b'):H('a')},error:{code:pick(unitCodes)}};
   else if(roll<0.82)event={type:'unit_failed',unit:{...unit,digest:H('a')},error:{code:pick(['film_person_invalid','no_identity_row','film_person_bounded'])}};
   else event={type:'unit_done',unit};
   const prev=run;
   const step=R.strikeStep(run,event);steps++;
   run=step.run;
   const cause={strike:'failure',third_strike:'third_strike',stop:'systemic',replay:'plan_changed',unit_done:run.strike_count===0&&prev.strike_count>0?'unit_done':'cursor'}[step.action]??(run.strike_count===0&&prev.strike_count>0?'unit_done':'cursor');
   assert.equal(R.strikeViolation(prev,run,cause),null,'step '+JSON.stringify(event)+' -> '+step.action+' violates the strike rules');
   assert.ok(run.strike_count<=2,'a stored count never reaches the limit');maxStored=Math.max(maxStored,run.strike_count);
   assert.equal(run.strike_count===0,run.strike_id===null,'the count and the identity agree');
   // the independent oracle
   if(event.type==='plan_changed'){oracle={id:null,digest:null,cls:null,count:0};index=0;durable.clear();replays++;assert.equal(run.cursor_id,null);assert.equal(run.pass_no,prev.pass_no+1);}
   else if(step.action==='stop'){stops++;assert.deepEqual([run.strike_count,run.strike_id,run.strike_digest,run.strike_class,run.cursor_id],[prev.strike_count,prev.strike_id,prev.strike_digest,prev.strike_class,prev.cursor_id],'a stop touches no strike and no cursor');run={...run,pass_state:'passing',stopped_by:null};}
   else if(step.action==='strike'||step.action==='third_strike'){
    const same=oracle.count>0&&oracle.id===unit.id&&oracle.digest===event.unit.digest&&oracle.cls===event.error.code;
    const count=same?oracle.count+1:1;
    if(count>=3){thirds++;assert.equal(step.action,'third_strike');oracle={id:null,digest:null,cls:null,count:0};durable.add(unit.id);index++;assert.equal(run.cursor_id,unit.id);}
    else{assert.equal(step.action,'strike');oracle={id:unit.id,digest:event.unit.digest,cls:event.error.code,count};assert.equal(run.strike_count,count);assert.equal(run.cursor_id,prev.cursor_id,'a strike does not move the cursor');}
   }
   else{
    // a refusal or a success: the unit's outcome is durable, the cursor passes it
    durable.add(unit.id);index++;assert.equal(run.cursor_id,unit.id);
    if(oracle.id===unit.id)oracle={id:null,digest:null,cls:null,count:0};
    assert.equal(run.strike_count,oracle.count);
   }
   // the cursor never passes a unit without a durable outcome in this pass
   if(run.cursor_id!==null)for(const other of units)if(R_cmp(other,{kind:'film_facts',id:run.cursor_id})<=0)assert.ok(durable.has(other.id),'the cursor passed '+other.id+' without a durable outcome');
  }
 }
 assert.ok(steps===300*70&&thirds>20&&stops>200&&replays>100&&maxStored===2,'the generator exercised every path: '+JSON.stringify({thirds,stops,replays,maxStored}));
 function R_cmp(a,b){return R.compareKeys(a,b);}
}

// ---- 3. Plan identity: the unit digests (asserted source-only), the fingerprint, the cursor order ----
const factsOf=extra=>({film:{contractVersion:1,original_title:'Heat',year:1995},metadata:{tmdb:{id:949}},watchlist:true,...extra});
const people=[{id:'person:2',state:{identity:{tmdbId:2,name:'B'},localization:{value:'Б',updatedAt:'2026-01-01T00:00:00.000Z'}}},{id:'person:1',state:{identity:{tmdbId:1,name:'A'}}}];
const creditsOf=n=>Array.from({length:n},(_,i)=>({personId:'person:'+(i+1),role:i%2?'actor':'director'}));
{
 // film_facts (ADR 0125): the unit input is the SOURCE facts plus id and the write clock; the adapter digest drops the clocks.
 const planA=planEpgUnits({runId:'r1',at:'2026-11-12T10:00:00.000Z',films:[{id:'film:1',facts:factsOf()},{id:'film:2',facts:factsOf({watchlist:false})}],departed:['film:3']});
 const planB=planEpgUnits({runId:'r2',at:'2026-11-13T22:00:00.000Z',films:[{id:'film:1',facts:factsOf()},{id:'film:2',facts:factsOf({watchlist:false})}],departed:['film:3']});
 const digestsOf=async plan=>Promise.all(plan.units.map(unit=>filmFactsDigest(unit.input)));
 const [da,db]=[await digestsOf(planA),await digestsOf(planB)];
 assert.deepEqual(da,db,'the Film unit digest does not move with the run, the event or the write clock');
 assert.equal(new Set(da).size,3);
 for(const unit of planA.units.filter(unit=>!unit.release)){const {id:_id,at:_at,...rest}=unit.input;assert.deepEqual(Object.keys(rest).sort(),['film','metadata','watchlist'],'only source facts enter the Film unit input');}
 const planC=planEpgUnits({runId:'r1',at:AT,films:[{id:'film:1',facts:factsOf({metadata:{tmdb:{id:950}}})},{id:'film:2',facts:factsOf({watchlist:false})}],departed:['film:3']});
 assert.notEqual((await digestsOf(planC))[0],da[0],'a source change moves the Film unit digest');
 assert.equal((await digestsOf(planC))[1],da[1]);
 // person_state and film_credits (ADR 0126): the existing unitDigest, source-only and clock-free.
 const pa=planEpgPersonUnits({runId:'r1',at:'2026-11-12T10:00:00.000Z',persons:people,credits:[{filmId:'film:1',credits:creditsOf(3)}]});
 const pb=planEpgPersonUnits({runId:'r9',at:'2027-01-01T00:00:00.000Z',persons:people,credits:[{filmId:'film:1',credits:creditsOf(3)}]});
 const pdig=async plan=>Promise.all(plan.units.map(unit=>unitDigest(unit.kind,unit.input)));
 assert.deepEqual(await pdig(pa),await pdig(pb),'the Person and credit digests do not move with the run, the event or the write clock');
 assert.deepEqual(pa.units.map(unit=>unit.kind+':'+unit.id),['person_state:person:1','person_state:person:2','film_credits:film:1']);
 for(const unit of pa.units){const {id:_id,at:_at,...rest}=unit.input;assert.deepEqual(Object.keys(rest),[unit.kind==='film_credits'?'credits':'person'],'only the source enters the unit input');}
 const reordered=planEpgPersonUnits({runId:'r1',at:AT,persons:people,credits:[{filmId:'film:1',credits:creditsOf(3).reverse()}]});
 assert.notEqual((await pdig(reordered))[2],(await pdig(pa))[2],'the credit order is source content');
 const changed=planEpgPersonUnits({runId:'r1',at:AT,persons:[{...people[0],state:{identity:{tmdbId:2,name:'C'}}},people[1]],credits:[]});
 assert.notEqual((await pdig(changed))[1],(await pdig(pa))[1]);
 // dictionary (ADR 0127): the ADAPTER digest of the built input depends on the stored Film, so it is NOT a unit digest; the entry digest is, and takes no stored state at all.
 const entry={id:'d1',filmId:'film:1',tmdbId:null,title:'Схватка',aliases:[],sources:['x'],status:'verified'};
 const dictA=await planDictionaryUnits({version:'d1',entries:[entry],at:'2026-11-12T10:00:00.000Z'});
 const dictB=await planDictionaryUnits({version:'d7',entries:[entry],at:'2026-12-01T00:00:00.000Z'});
 const stored=version=>({film:{contract_version:version,original_title:null,canonical_identity:null,updated_at:'2026-01-01T00:00:00.000Z'},dimensions:{identity:null,localization:null},trustedTmdb:[],redirect:null});
 const builtOne=buildDictionaryInput(stored(1),dictA.units[0],{at:AT}),builtTwo=buildDictionaryInput(stored(2),dictA.units[0],{at:AT});
 assert.equal(builtOne.outcome,'proceed');
 assert.notEqual(await filmFactsDigest(builtOne.input),await filmFactsDigest(builtTwo.input),'the adapter digest of a dictionary unit moves with STORED state: it cannot be the unit digest');
 assert.equal(await R.dictionaryUnitDigest(dictA.units[0]),await R.dictionaryUnitDigest(dictB.units[0]),'the dictionary unit digest does not move with the version label, the event or the write clock');
 const edited=await planDictionaryUnits({version:'d1',entries:[{...entry,title:'Другое'}],at:AT});
 assert.notEqual(await R.dictionaryUnitDigest(edited.units[0]),await R.dictionaryUnitDigest(dictA.units[0]),'a source change moves it');
 const aliased=await planDictionaryUnits({version:'d1',entries:[{...entry,aliases:['Heat']}],at:AT});
 assert.notEqual(await R.dictionaryUnitDigest(aliased.units[0]),await R.dictionaryUnitDigest(dictA.units[0]),'an alias is dictionary content');
 assert.equal(await R.dictionaryUnitDigest(dictA.units[0]),await R.dictionaryUnitDigest({...dictA.units[0],extra:undefined}));
 assert.notEqual(await R.dictionaryUnitDigest({id:'film:2',entry:dictA.units[0].entry}),await R.dictionaryUnitDigest(dictA.units[0]),'the digest binds the Film');
 assert.equal(await codeOfAsync(()=>R.dictionaryUnitDigest({id:'x',entry:{}})),'film_person_invalid');

 // the fingerprint
 const mk=async(kinds,extra={})=>({origin:'epg',event:'epg:r1',units:kinds,...extra});
 const unitsOf=plan=>Promise.all(plan.units.map(async unit=>({kind:'film_facts',id:unit.id,unitDigest:await filmFactsDigest(unit.input)})));
 const ua=await unitsOf(planA),ub=await unitsOf(planB);
 const base=await R.planFingerprint(await mk(ua));
 assert.match(base,/^[0-9a-f]{64}$/);
 assert.equal(await R.planFingerprint(await mk(ub)),base,'same source units: the same fingerprint whatever the write clock and run');
 assert.equal(await R.planFingerprint({...(await mk(ua)),slice:5,ceiling:50,sliceSize:7,markerGeneration:9}),base,'execution parameters are not part of the identity');
 assert.notEqual(await R.planFingerprint({...(await mk(ua)),planVersion:2}),base);
 assert.notEqual(await R.planFingerprint({...(await mk(ua)),event:'epg:r2'}),base);
 assert.notEqual(await R.planFingerprint({...(await mk(ua)),origin:'dictionary'}),base);
 assert.notEqual(await R.planFingerprint(await mk([{...ua[0],unitDigest:H('e')},...ua.slice(1)])),base,'a unit digest');
 assert.notEqual(await R.planFingerprint(await mk(ua.slice(1))),base,'a unit removed');
 assert.notEqual(await R.planFingerprint(await mk([{...ua[0],id:'film:0'},...ua.slice(1)])),base,'a unit id');
 assert.equal(await codeOfAsync(async()=>R.planFingerprint(await mk([ua[1],ua[0],ua[2]]))),'film_person_invalid','an unordered plan is refused, not sorted');
 assert.equal(await codeOfAsync(async()=>R.planFingerprint(await mk([ua[0],ua[0]]))),'film_person_invalid','a duplicate unit is refused');
 assert.equal(await codeOfAsync(async()=>R.planFingerprint(await mk([{kind:'nope',id:'film:1',unitDigest:H('a')}]))),'film_person_invalid');
 assert.equal(await codeOfAsync(async()=>R.planFingerprint(await mk([{kind:'film_facts',id:'film:1',unitDigest:'abc'}]))),'film_person_invalid');
 assert.equal(await codeOfAsync(()=>R.planFingerprint({origin:'other',event:'e',units:[]})),'film_person_invalid');
 assert.equal(await R.planFingerprint({origin:'epg',event:'e',units:[]}),await R.planFingerprint({planVersion:R.PRODUCER_PLAN_VERSION,origin:'epg',event:'e',units:[]}),'the default plan version');
 // the formula: sha256 of the canonical JSON, nothing else
 const {digestOf}=await real('canonical-receipts.js');
 assert.equal(base,await digestOf({planVersion:R.PRODUCER_PLAN_VERSION,origin:'epg',event:'epg:r1',units:ua.map(unit=>({kind:unit.kind,id:unit.id,unitDigest:unit.unitDigest}))}));
 // a mixed plan orders by (kind rank, id)
 const mixed=[{kind:'film_facts',id:'film:9',unitDigest:H('a')},{kind:'person_state',id:'person:1',unitDigest:H('b')},{kind:'film_credits',id:'film:1',unitDigest:H('c')}];
 assert.match(await R.planFingerprint({origin:'epg',event:'e',units:mixed}),/^[0-9a-f]{64}$/);
 assert.equal(await codeOfAsync(()=>R.planFingerprint({origin:'epg',event:'e',units:[mixed[1],mixed[0]]})),'film_person_invalid','person states come after Film facts');
 // cursor keys
 assert.equal(R.compareKeys(mixed[0],mixed[1]),-1);assert.equal(R.compareKeys(mixed[2],mixed[1]),1);assert.equal(R.compareKeys({kind:'film_facts',id:'film:1'},{kind:'film_facts',id:'film:1'}),0);
 assert.equal(R.compareKeys({kind:'film_facts',id:'film:10'},{kind:'film_facts',id:'film:2'}),-1,'ids compare by code unit, as the planners sort');
 assert.equal(R.resumeIndex(mixed,null),0);assert.equal(R.resumeIndex(mixed,{kind:'film_facts',id:'film:9'}),1);assert.equal(R.resumeIndex(mixed,{kind:'person_state',id:'person:1'}),2);assert.equal(R.resumeIndex(mixed,{kind:'film_credits',id:'film:1'}),3);
 assert.equal(R.resumeIndex(mixed,{kind:'film_facts',id:'film:95'}),1,'a cursor on a unit that left the plan resumes at the next unit');
 assert.equal(R.resumeIndex(mixed,{kind:'person_state',id:'person:0'}),1);
 // resume or replay
 const stored0={fingerprint:base,pass_no:3,cursor_kind:'film_facts',cursor_id:'film:1'};
 assert.deepEqual(R.resumeDecision({stored:stored0,fingerprint:base,units:ua}),{action:'resume',pass_no:3,startIndex:1});
 const replay=R.resumeDecision({stored:stored0,fingerprint:H('f'),units:ua});
 assert.deepEqual([replay.action,replay.pass_no,replay.startIndex,replay.cursor_id,replay.strike.strike_count,replay.pass_state],['replay',4,0,null,0,'passing']);
 assert.equal(R.resumeDecision({stored:{...stored0,cursor_kind:null,cursor_id:null},fingerprint:base,units:ua}).startIndex,0);
 assert.equal(codeOf(()=>R.resumeDecision({stored:{...stored0,pass_no:10000},fingerprint:H('f'),units:ua})),'producer_cas_lost');
 assert.equal(codeOf(()=>R.resumeDecision({stored:{...stored0,fingerprint:'x'},fingerprint:base,units:ua})),'film_person_invalid');
}

// ---- 4. The prerequisite stamp ----
{
 const it=(id,revision)=>({id,revision});
 const snaps={
  no_identity_row:{film:it('film:1',4),identity:null},
  needs_trusted_tmdb_id:{film:it('film:1',4),claims:[]},
  film_person_reference:{film:it('film:1',4),persons:[it('person:1',null),it('person:2',3)]},
  film_person_redirect:{film:it('film:1',4),redirect:it('film:9',2)},
  dictionary_identity_ambiguous:{film:it('film:1',4),claims:[it('claim:a',1),it('claim:b',1)],identities:[it('identity:x',2)]},
  owner_review_inconsistent:{film:it('film:1',4),entry:it('review:1',5),materialised:[it('dim:1',2)]},
 };
 const moved={
  no_identity_row:[s=>({...s,identity:it('identity:1',1)}),s=>({...s,film:it('film:1',5)}),s=>({...s,film:it('film:2',4)})],
  needs_trusted_tmdb_id:[s=>({...s,claims:[it('claim:t',1)]}),s=>({...s,film:it('film:1',5)})],
  film_person_reference:[s=>({...s,persons:[it('person:1',2),it('person:2',3)]}),s=>({...s,persons:[it('person:1',null),it('person:2',4)]}),s=>({...s,persons:[it('person:1',null)]})],
  film_person_redirect:[s=>({...s,redirect:it('film:9',3)}),s=>({...s,redirect:it('film:8',2)}),s=>({...s,redirect:null})],
  dictionary_identity_ambiguous:[s=>({...s,claims:[it('claim:a',2),it('claim:b',1)]}),s=>({...s,identities:[]})],
  owner_review_inconsistent:[s=>({...s,entry:it('review:1',6)}),s=>({...s,entry:null}),s=>({...s,materialised:[it('dim:1',3)]}),s=>({...s,materialised:[]})],
 };
 assert.deepEqual(Object.keys(R.PREREQ_FIELDS).sort(),Object.keys(snaps).sort(),'one stamp per recoverable code');
 sortedEq(Object.keys(R.PREREQ_FIELDS),Object.entries(R.ERROR_CLASSES).filter(([,cls])=>cls===CLASS.RECOVERABLE).map(([code])=>code),'every recoverable code has a stamp spec and nothing else does');
 const seen=new Set();
 for(const [code,snap] of Object.entries(snaps)){
  const stamp=await R.prereqStamp(code,snap);
  assert.match(stamp,/^[0-9a-f]{64}$/);assert.equal(await R.prereqStamp(code,JSON.parse(JSON.stringify(snap))),stamp,'deterministic');
  seen.add(stamp);
  for(const change of moved[code])assert.notEqual(await R.prereqStamp(code,change(snap)),stamp,code+': a prerequisite change moves the stamp');
  // identifiers and revisions only
  assert.equal(await codeOfAsync(()=>R.prereqStamp(code,{...snap,content:'a title'})),'film_person_invalid','no extra field');
  const {film:_film,...without}=snap;assert.equal(await codeOfAsync(()=>R.prereqStamp(code,without)),'film_person_invalid','no missing field');
  assert.equal(await codeOfAsync(()=>R.prereqStamp(code,{...snap,film:{id:'film:1',revision:4,title:'Heat'}})),'film_person_invalid','no content in an item');
  assert.equal(await codeOfAsync(()=>R.prereqStamp(code,{...snap,film:{id:'Heat (1995) a title',revision:4}})),'film_person_invalid','an id is an identifier, not text');
  assert.equal(await codeOfAsync(()=>R.prereqStamp(code,{...snap,film:{id:'film:1',revision:'4'}})),'film_person_invalid');
  assert.equal(await codeOfAsync(()=>R.prereqStamp(code,{...snap,film:null})),'film_person_invalid','the Film itself is never absent from its own stamp');
 }
 assert.equal(seen.size,6,'every code gives another stamp');
 // order independence of a set, duplicates refused
 assert.equal(await R.prereqStamp('film_person_reference',{film:it('film:1',4),persons:[it('person:2',3),it('person:1',null)]}),await R.prereqStamp('film_person_reference',snaps.film_person_reference));
 assert.equal(await codeOfAsync(()=>R.prereqStamp('film_person_reference',{film:it('film:1',4),persons:[it('person:1',1),it('person:1',2)]})),'film_person_invalid');
 // permanent refusals and unknown codes have no stamp
 for(const code of ['film_person_invalid','film_person_bounded','identity_collision','unknown_code'])assert.equal(await codeOfAsync(()=>R.prereqStamp(code,{})),'film_person_invalid');
 // absence is explicit and distinct from a revision of 0
 assert.notEqual(await R.prereqStamp('no_identity_row',{film:it('film:1',4),identity:null}),await R.prereqStamp('no_identity_row',{film:it('film:1',4),identity:it('identity:1',0)}));
 assert.notEqual(await R.prereqStamp('film_person_reference',{film:it('film:1',4),persons:[it('person:1',null)]}),await R.prereqStamp('film_person_reference',{film:it('film:1',4),persons:[it('person:1',0)]}),'an absent Person is not revision 0');
}

// ---- 5. The result-row state machine, failure writes, retry and revalidation ----
const PASS={origin:'epg',runKey:'epg:r1',passNo:1,fingerprint:H('1'),unit:{kind:'film_facts',id:'film:1',digest:H('a')},code:'identity_collision',at:AT};
const rowOf=(extra={})=>R.resultRow({...PASS,state:'open',attempts:3,...extra});
{
 for(const from of R.RESULT_STATES)for(const to of R.RESULT_STATES)assert.equal(R.canTransition(from,to),R.LIVE_STATES.includes(from),from+' -> '+to);
 assert.equal(R.canTransition('settled','open'),false);assert.equal(R.canTransition('superseded','refused_recoverable'),false);assert.equal(R.canTransition('abandoned','open'),false);assert.equal(R.canTransition('open','nope'),false);
 // the row builder enforces the schema CHECKs
 const third=rowOf();
 assert.deepEqual([third.state,third.retry_owner,third.attempts,third.next_attempt_at,third.prereq_stamp,third.request_id,third.settled_at],['open','unit',3,new Date(NOW+RETRY_POLICY.backoffMs[2]).toISOString(),null,null,null],'the third-strike row takes its schedule from the receipt policy');
 const perm=R.resultRow({...PASS,state:'refused_permanent',code:'film_person_bounded'});assert.deepEqual([perm.next_attempt_at,perm.prereq_stamp,perm.retry_owner],[null,null,'unit'],'a permanent refusal has no schedule and no stamp');
 const permWithStamp=R.resultRow({...PASS,state:'refused_permanent',code:'film_person_bounded',prereqStamp:H('9')});assert.equal(permWithStamp.prereq_stamp,null);
 const rec=R.resultRow({...PASS,state:'refused_recoverable',code:'no_identity_row',prereqStamp:H('5')});assert.deepEqual([rec.prereq_stamp,rec.next_attempt_at,rec.retry_owner],[H('5'),new Date(NOW+60000).toISOString(),'unit']);
 assert.equal(codeOf(()=>R.resultRow({...PASS,state:'refused_recoverable',code:'no_identity_row'})),'film_person_invalid','a recoverable refusal needs a stamp');
 const receipt=R.resultRow({...PASS,state:'open',retryOwner:'receipt',requestId:'epg:film_facts:abc'});assert.equal(receipt.next_attempt_at,null,'the receipt owns its schedule');
 assert.equal(codeOf(()=>R.resultRow({...PASS,state:'open',retryOwner:'receipt'})),'film_person_invalid','a receipt owner needs a request id');
 assert.equal(codeOf(()=>R.resultRow({...PASS,state:'open',retryOwner:'unit',requestId:'epg:x'})),'film_person_invalid','a unit owner has no request id');
 assert.equal(codeOf(()=>R.resultRow({...PASS,state:'settled'})),'film_person_invalid','a terminal row needs settled_at');
 assert.equal(codeOf(()=>R.resultRow({...PASS,state:'open',attempts:17})),'film_person_invalid');
 assert.equal(codeOf(()=>R.resultRow({...PASS,state:'open',attempts:0})),'film_person_invalid');
 assert.equal(codeOf(()=>R.resultRow({...PASS,state:'open',code:'Bad Code'})),'film_person_invalid');
 assert.equal(codeOf(()=>R.resultRow({...PASS,state:'open',unit:{...PASS.unit,digest:'x'}})),'film_person_invalid');
 assert.equal(codeOf(()=>R.resultRow({...PASS,state:'open',passNo:0})),'film_person_invalid');
 assert.equal(codeOf(()=>R.resultRow({...PASS,origin:'other',state:'open'})),'film_person_invalid');
 assert.equal(codeOf(()=>R.assertResultRow({...third,retry_owner:'receipt'})),'film_person_invalid');
 assert.equal(codeOf(()=>R.assertResultRow({...third,next_attempt_at:null})),'film_person_invalid','an open unit row needs a schedule');
 assert.equal(codeOf(()=>R.assertResultRow({...perm,next_attempt_at:AT})),'film_person_invalid');
 assert.equal(codeOf(()=>R.assertResultRow({...receipt,next_attempt_at:AT})),'film_person_invalid','a receipt row carries no schedule');
 assert.equal(codeOf(()=>R.assertResultRow({...rec,prereq_stamp:null})),'film_person_invalid');
 assert.equal(codeOf(()=>R.assertResultRow({...rec,retry_owner:'receipt',request_id:'x',next_attempt_at:null})),'film_person_invalid');
 // failure write, scenario A: pass 1 row (digest D1) is live; the plan changes; pass 2 fails the same unit with D2 -> the pass 1 row is superseded (source_changed), the pass 2 row inserted; both keyed with pass_no
 const pass1=rowOf();
 const writeA=R.failureWrite(pass1,{...PASS,passNo:2,fingerprint:H('2'),unit:{...PASS.unit,digest:H('b')},state:'open',attempts:3,at:'2026-11-12T11:00:00.000Z'});
 assert.deepEqual(writeA.supersede.key,{origin:'epg',run_key:'epg:r1',pass_no:1,kind:'film_facts',unit_id:'film:1'});
 assert.deepEqual([writeA.supersede.patch.state,writeA.supersede.patch.settled_by,writeA.supersede.patch.settled_at],['superseded','source_changed','2026-11-12T11:00:00.000Z']);
 assert.deepEqual([writeA.insert.pass_no,writeA.insert.unit_digest,writeA.insert.state],[2,H('b'),'open']);
 assert.notDeepEqual(R.keyOfRow(writeA.insert),writeA.supersede.key,'the keys differ by pass_no: both rows are durable');
 // D2 equal D1: the live row stays and its attempts increment (an execution failure)
 const writeSame=R.failureWrite(pass1,{...PASS,passNo:2,fingerprint:H('2'),state:'open',attempts:3,at:'2026-11-12T11:00:00.000Z'});
 assert.equal(writeSame.insert,undefined);assert.equal(writeSame.supersede,undefined);
 assert.deepEqual(writeSame.update.key.pass_no,1);assert.equal(writeSame.update.patch.attempts,4);assert.equal(writeSame.update.patch.next_attempt_at,new Date(Date.parse('2026-11-12T11:00:00.000Z')+RETRY_POLICY.backoffMs[3]).toISOString());
 // a refusal over the same live row reclassifies it (no attempt)
 const reclass=R.failureWrite(pass1,{...PASS,state:'refused_permanent',code:'film_person_bounded'});
 assert.deepEqual([reclass.update.patch.state,reclass.update.patch.attempts,reclass.update.patch.next_attempt_at,reclass.update.patch.prereq_stamp],['refused_permanent',3,null,null]);
 assert.equal(R.failureWrite(null,{...PASS,state:'open',attempts:3}).insert.state,'open');
 // a terminal row is never a live row: it cannot be written over
 for(const state of R.TERMINAL_STATES)assert.equal(codeOf(()=>R.failureWrite({...pass1,state,settled_at:AT},{...PASS,state:'open',attempts:3})),'film_person_invalid',state);
 assert.equal(codeOf(()=>R.failureWrite(pass1,{...PASS,unit:{...PASS.unit,id:'film:2'},state:'open',attempts:3})),'film_person_invalid','another unit is not the live row');
 // retry decision
 const dueCtx={nowMs:NOW+RETRY_POLICY.backoffMs[2]+1,currentUnitDigest:H('a'),trigger:'due'};
 const open2=R.resultRow({...PASS,state:'open',attempts:2});
 assert.deepEqual(R.retryDecision(open2,{...dueCtx,nowMs:NOW+1000}),{action:'none',reason:'not_due'});
 assert.equal(R.retryDecision(open2,{...dueCtx,nowMs:NOW+RETRY_POLICY.backoffMs[1]}).action,'retry_apply');
 assert.equal(R.retryDecision(open2,{...dueCtx,nowMs:NOW+1000,trigger:'reobserved'}).action,'retry_apply','a re-observation is not gated by the schedule');
 assert.equal(R.retryDecision(rowOf({attempts:5}),dueCtx).action,'abandon','5 attempts');
 assert.equal(R.retryDecision(rowOf({attempts:4}),{...dueCtx,nowMs:NOW+7200001}).action,'retry_apply');
 const aged=R.retryDecision(open2,{...dueCtx,nowMs:NOW+RETRY_POLICY.abandonAfterMs});assert.deepEqual([aged.action,aged.patch.state,aged.patch.settled_by],['abandon','abandoned','retry_exhausted']);
 assert.equal(R.retryDecision(open2,{...dueCtx,nowMs:NOW+RETRY_POLICY.abandonAfterMs-1}).action,'retry_apply','abandoned only at 7 days');
 const left=R.retryDecision(open2,{...dueCtx,currentUnitDigest:null});assert.deepEqual([left.action,left.patch.state,left.patch.settled_by],['supersede','superseded','left_plan']);
 const srcChanged=R.retryDecision(open2,{...dueCtx,currentUnitDigest:H('b')});assert.deepEqual([srcChanged.action,srcChanged.patch.settled_by],['supersede','source_changed']);
 assert.equal(R.retryDecision(perm,{...dueCtx,nowMs:NOW+9e9}).action,'none');assert.equal(R.retryDecision(perm,{...dueCtx,nowMs:NOW+9e9}).reason,'permanent_never_retried');
 assert.equal(R.retryDecision(perm,{...dueCtx,currentUnitDigest:H('b')}).action,'supersede','only a changed digest clears a permanent refusal');
 assert.equal(R.retryDecision(perm,{...dueCtx,currentUnitDigest:null}).patch.settled_by,'left_plan');
 assert.deepEqual(R.retryDecision(receipt,dueCtx),{action:'none',reason:'receipt_owned'});
 for(const state of R.TERMINAL_STATES)assert.deepEqual(R.retryDecision({...open2,state,settled_at:AT,next_attempt_at:null},{...dueCtx,currentUnitDigest:H('b')}),{action:'none',reason:'terminal'},'a terminal row never reopens: '+state);
 assert.equal(codeOf(()=>R.retryDecision(open2,{...dueCtx,currentUnitDigest:undefined})),'film_person_invalid');
 assert.equal(codeOf(()=>R.retryDecision(open2,{...dueCtx,trigger:'cron'})),'film_person_invalid');
 // recoverable: unchanged stamp = no apply, no attempt, only the schedule moves to the last policy step; changed = plan and apply; never abandoned
 const recDue={nowMs:NOW+60000,currentUnitDigest:H('a'),trigger:'due',currentStamp:H('5')};
 const deferred=R.retryDecision(rec,recDue);
 assert.deepEqual(deferred,{action:'defer',patch:{next_attempt_at:new Date(NOW+60000+7200000).toISOString(),updated_at:new Date(NOW+60000).toISOString()}});
 assert.equal(deferred.patch.attempts,undefined,'no attempt is consumed');
 assert.equal(R.lastBackoffMs(),7200000);
 assert.deepEqual(R.retryDecision(rec,{...recDue,currentStamp:H('6')}),{action:'plan_and_apply',stamp:H('6')});
 assert.deepEqual(R.retryDecision(rec,{...recDue,nowMs:NOW+1000}),{action:'none',reason:'not_due'});
 assert.equal(R.retryDecision(rec,{...recDue,nowMs:NOW+1000,trigger:'reobserved'}).action,'defer','a re-observation revalidates at once');
 const old=R.retryDecision({...rec,attempts:16,created_at:'2020-01-01T00:00:00.000Z'},{...recDue,nowMs:NOW+RETRY_POLICY.abandonAfterMs*10});assert.equal(old.action,'defer','a recoverable refusal is never abandoned by attempts or age');
 assert.equal(codeOf(()=>R.retryDecision(rec,{...recDue,currentStamp:undefined})),'film_person_invalid');
 assert.equal(R.retryDecision(rec,{...recDue,currentUnitDigest:H('b')}).patch.settled_by,'source_changed');
 // after the retry
 const proof=R.afterRetry(rec,{kind:'proof',proof:'applied_receipt'},{nowMs:NOW});assert.deepEqual([proof.action,proof.patch.state,proof.patch.settled_by],['settle','settled','prerequisite_resolved']);
 assert.equal(R.afterRetry(rec,{kind:'proof',proof:'verified_noop'},{nowMs:NOW}).patch.settled_by,'prerequisite_resolved');
 assert.equal(R.afterRetry(open2,{kind:'proof',proof:'applied_receipt'},{nowMs:NOW}).patch.settled_by,'applied');
 assert.equal(codeOf(()=>R.afterRetry(rec,{kind:'proof',proof:'it_seems_fine'},{nowMs:NOW})),'film_person_invalid','only a write proof settles');
 assert.deepEqual(R.afterRetry(rec,{kind:'not_proven'},{nowMs:NOW}),{action:'none',reason:'no_write_proof'});
 const again=R.afterRetry(rec,{kind:'refused',error:{code:'film_person_reference'},stamp:H('7')},{nowMs:NOW});assert.deepEqual([again.action,again.patch.state,again.patch.prereq_stamp,again.patch.code,again.patch.attempts],['update','refused_recoverable',H('7'),'film_person_reference',undefined],'refused again with a new stamp keeps the state and takes the stamp');
 assert.equal(codeOf(()=>R.afterRetry(rec,{kind:'refused',error:{code:'film_person_reference'}},{nowMs:NOW})),'film_person_invalid','a recoverable refusal needs its stamp');
 const toPerm=R.afterRetry(rec,{kind:'refused',error:{code:'film_person_invalid'}},{nowMs:NOW});assert.deepEqual([toPerm.patch.state,toPerm.patch.prereq_stamp,toPerm.patch.next_attempt_at],['refused_permanent',null,null],'reclassified in one patch');
 const toOpen=R.afterRetry(rec,{kind:'failed',error:{code:'identity_collision'}},{nowMs:NOW});assert.deepEqual([toOpen.patch.state,toOpen.patch.attempts,toOpen.patch.prereq_stamp,toOpen.patch.next_attempt_at],['open',2,null,new Date(NOW+300000).toISOString()]);
 const openFail=R.afterRetry(open2,{kind:'failed',error:{code:'identity_collision'}},{nowMs:NOW});assert.deepEqual([openFail.patch.attempts,openFail.patch.next_attempt_at],[3,new Date(NOW+1800000).toISOString()]);
 for(const code of ['film_person_unavailable','film_person_fence','mystery'])assert.deepEqual(R.afterRetry(rec,{kind:'failed',error:{code}},{nowMs:NOW}),{action:'stop',code:R.classifyProducerError(code).code},'a systemic failure changes no row: '+code);
 assert.equal(R.afterRetry(rec,{kind:'failed',error:{code:'owner_kept'}},{nowMs:NOW}).action,'settle');
 assert.equal(codeOf(()=>R.afterRetry({...rec,state:'settled',settled_at:AT,next_attempt_at:null},{kind:'not_proven'},{nowMs:NOW})),'film_person_invalid','a terminal row is not retried');
}

// ---- 6. Freshness ----
{
 const run=(extra={})=>({source_generation:'G2',applied_generation:'G2',pass_state:'passed',...extra});
 const f=(published,r,live)=>R.canonicalFreshness({publishedGeneration:published,run:r,liveFilmFactsResults:live});
 assert.equal(f('G2',run(),0),'current');
 assert.equal(f('G2',run(),1),'partial');
 assert.equal(f('G3',run(),0),'lagging','a newer published generation');
 assert.equal(f('G1',run(),0),'lagging','a published generation that moves backwards is lagging, not current');
 assert.equal(f('G2',run({pass_state:'passing',applied_generation:null}),0),'lagging');assert.equal(f('G2',run({pass_state:'stopped',applied_generation:null}),0),'lagging');assert.equal(f('G2',run({pass_state:'superseded',applied_generation:null}),0),'lagging');
 assert.equal(f('G2',run({applied_generation:null}),0),'lagging','passed without an applied generation');
 assert.equal(f('G2',run({pass_state:'passing',applied_generation:null}),5),'lagging','not complete beats partial');
 assert.equal(f('G2',null,0),'lagging','no run yet');
 assert.equal(f('G2',undefined,0),'unknown');assert.equal(f('G2',run(),undefined),'unknown');assert.equal(f('G2',run(),null),'unknown');assert.equal(f('G2',run(),-1),'unknown');assert.equal(f('G2',run(),1.5),'unknown');
 assert.equal(f('',run(),0),'unknown');assert.equal(f(undefined,run(),0),'unknown');assert.equal(f(2,run(),0),'unknown');
 assert.equal(f('G2',run({pass_state:'weird'}),0),'unknown');assert.equal(f('G2',run({source_generation:undefined}),0),'unknown');
 assert.equal(f('G2',run({source_generation:'G1'}),0),'unknown','an applied generation that is not the planned one is inconsistent');
 assert.equal(f('G2',run({pass_state:'stopped',applied_generation:'G2'}),0),'unknown','an applied generation outside a passed pass is inconsistent');
 assert.equal(R.canonicalFreshness(),'unknown');
 // exhaustive truth table against an independent oracle
 const gens=['G1','G2','G3'];let combos=0,currents=0;
 for(const published of [...gens,'',undefined])for(const state of ['passing','passed','stopped','superseded','weird'])for(const source of ['G1','G2','G3',undefined])for(const applied of [null,'G1','G2','G3'])for(const live of [0,1,3,undefined,-1]){
  combos++;
  const got=f(published,{source_generation:source,applied_generation:applied,pass_state:state},live);
  const wellFormed=typeof published==='string'&&published&&Number.isInteger(live)&&live>=0&&['passing','passed','stopped','superseded'].includes(state)&&typeof source==='string'&&(applied===null||(state==='passed'&&applied===source));
  const expected=!(typeof published==='string'&&published&&Number.isInteger(live)&&live>=0)?'unknown':!wellFormed?'unknown':state!=='passed'||applied===null?'lagging':applied!==published?'lagging':live>0?'partial':'current';
  assert.equal(got,expected,JSON.stringify({published,state,source,applied,live}));
  if(got==='current'){currents++;assert.ok(state==='passed'&&applied===published&&applied===source&&live===0);}
 }
 assert.ok(combos>1000&&currents>0);
 // no false freshness across publish / pass / crash interleavings
 let seed=7;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
 let sawCurrent=0;
 for(let s=0;s<400;s++){
  let published='G0',row=null,live=0,gen=0,truth=null;
  for(let n=0;n<40;n++){
   const roll=rnd();
   if(roll<0.2){gen++;published='G'+gen;}                                                  // a new EPG publication (never rolls back here)
   else if(roll<0.25&&gen>0){published='G'+Math.max(0,gen-1-Math.floor(rnd()*gen));}      // a backwards generation
   else if(roll<0.45)row={source_generation:published,applied_generation:null,pass_state:'passing'};
   else if(roll<0.6&&row&&row.pass_state==='passing')row={...row,pass_state:'stopped'};   // a crash
   else if(roll<0.75&&row&&row.pass_state==='passing')row={...row,pass_state:'passed',applied_generation:row.source_generation};
   else if(roll<0.82&&row&&row.pass_state==='passing')row={...row,pass_state:'superseded'};
   else if(roll<0.9)live=live+1;else if(live>0)live--;
   const got=f(published,row,live);
   const trulyCurrent=!!row&&row.pass_state==='passed'&&row.applied_generation===published&&live===0;
   assert.equal(got==='current',trulyCurrent,'current iff a passed pass of exactly the published generation with no live film_facts result');
   if(got==='current')sawCurrent++;
  }
 }
 assert.ok(sawCurrent>50,'the interleavings reach current ('+sawCurrent+')');
}

// ---- 7. The durable-outcome rule for the cursor ----
{
 const units=[{kind:'film_facts',id:'film:1'},{kind:'film_facts',id:'film:2'},{kind:'film_facts',id:'film:3'},{kind:'person_state',id:'person:1'}];
 const out=(...list)=>list.map((outcome,i)=>({...units[i],outcome}));
 assert.deepEqual(R.sliceCursor(units,null,out('applied','noop','kept','result_written')),{kind:'person_state',id:'person:1'});
 assert.deepEqual(R.sliceCursor(units,null,out('applied','strike','applied')),{kind:'film_facts',id:'film:1'},'a first or second strike is not durable: the cursor stops before it');
 assert.deepEqual(R.sliceCursor(units,null,out('systemic','applied')),null,'a systemic stop leaves the cursor');
 assert.deepEqual(R.sliceCursor(units,{kind:'film_facts',id:'film:1'},[{...units[1],outcome:'absent'}]),{kind:'film_facts',id:'film:2'});
 assert.deepEqual(R.sliceCursor(units,{kind:'film_facts',id:'film:1'},[{...units[2],outcome:'applied'}]),{kind:'film_facts',id:'film:1'},'a unit out of order is not accepted');
 assert.deepEqual(R.sliceCursor(units,null,[]),null);
 assert.deepEqual(R.sliceCursor(units,null,out('mystery')),null,'an unknown outcome is not durable');
 assert.deepEqual([...R.DURABLE_OUTCOMES],['applied','noop','kept','absent','result_written']);
 // property: over random outcome lists, the cursor is the end of the longest durable prefix
 let seed=11;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
 const all=['applied','noop','kept','absent','result_written','strike','systemic','pending'];
 for(let n=0;n<500;n++){
  const list=out(...units.map(()=>all[Math.floor(rnd()*all.length)]));
  const cursor=R.sliceCursor(units,null,list);
  let expected=null;for(const item of list){if(!R.DURABLE_OUTCOMES.includes(item.outcome))break;expected={kind:item.kind,id:item.id};}
  assert.deepEqual(cursor,expected);
  const idx=cursor?units.findIndex(unit=>unit.id===cursor.id):-1;
  for(let i=0;i<=idx;i++)assert.ok(R.DURABLE_OUTCOMES.includes(list[i].outcome),'the cursor never passes a unit without a durable outcome');
 }
}

// ---- 8. The dictionary version minting decision ----
{
 const D=char=>H(char);
 // an in-memory store with the UNIQUE (seq) constraint: the INSERT succeeds only for the next seq whose predecessor holds another digest
 const store=[];
 const latest=()=>store.length?store[store.length-1]:null;
 const insert=decision=>{
  if(store.some(row=>row.seq===decision.seq))return false;
  if(decision.guard.previous_exists&&!store.some(row=>row.seq===decision.guard.prev_seq&&row.snapshot_digest!==decision.snapshot_digest))return false;
  if(!decision.guard.previous_exists&&store.length)return false;
  store.push({seq:decision.seq,run_key:decision.run_key,snapshot_digest:decision.snapshot_digest});return true;
 };
 const plan=digest=>{for(let tries=0;tries<6;tries++){const d=R.mintDictionaryVersion({latest:latest(),snapshotDigest:digest});if(d.action==='reuse')return d.run_key;if(insert(d))return d.run_key;}throw new Error('minting did not converge');};
 assert.equal(plan(D('a')),'d1');assert.equal(plan(D('b')),'d2');assert.equal(plan(D('a')),'d3','A, B, A gives three versions: the revert is a genuine new version');
 assert.deepEqual(store.map(row=>row.run_key),['d1','d2','d3']);
 assert.equal(plan(D('a')),'d3','a resume or an identical replay reuses');assert.equal(plan(D('a')),'d3');assert.equal(store.length,3,'nothing is minted on resume or retry');
 // two parallel planners that read the same latest row: the same seq; exactly one insert wins; the loser re-reads and reuses (same digest) or mints the next
 const seen=latest();
 const p=R.mintDictionaryVersion({latest:seen,snapshotDigest:D('b')}),q=R.mintDictionaryVersion({latest:seen,snapshotDigest:D('b')});
 assert.deepEqual([p.seq,q.seq,p.run_key],[4,4,'d4']);assert.equal(insert(p),true);assert.equal(insert(q),false,'the loser fails its constraint');
 assert.equal(R.mintDictionaryVersion({latest:latest(),snapshotDigest:D('b')}).action,'reuse','the loser re-reads and reuses d4');
 const r=R.mintDictionaryVersion({latest:latest(),snapshotDigest:D('c')});assert.deepEqual([r.action,r.seq,r.prev_seq,r.run_key,r.supersedes],['mint',5,4,'d5','d4']);
 // the first row
 assert.deepEqual(R.mintDictionaryVersion({latest:null,snapshotDigest:D('a')}),{action:'mint',seq:1,prev_seq:0,run_key:'d1',snapshot_digest:D('a'),guard:{prev_seq:0,previous_exists:false},supersedes:null});
 assert.deepEqual(R.mintDictionaryVersion({latest:{seq:2,run_key:'d2',snapshot_digest:D('b')},snapshotDigest:D('a')}).guard,{prev_seq:2,previous_exists:true,previous_digest_differs:true});
 // refusals
 assert.equal(codeOf(()=>R.mintDictionaryVersion({latest:null,snapshotDigest:'short'})),'film_person_invalid');
 assert.equal(codeOf(()=>R.mintDictionaryVersion({latest:{seq:2,run_key:'d3',snapshot_digest:D('b')},snapshotDigest:D('a')})),'film_person_invalid','a label that is not d<seq>');
 assert.equal(codeOf(()=>R.mintDictionaryVersion({latest:{seq:0,run_key:'d0',snapshot_digest:D('b')},snapshotDigest:D('a')})),'film_person_invalid');
 assert.equal(codeOf(()=>R.mintDictionaryVersion({latest:{seq:1,run_key:'d1'},snapshotDigest:D('a')})),'film_person_invalid');
 assert.equal(codeOf(()=>R.mintDictionaryVersion()),'film_person_invalid');
}

// ---- 9. The owner-review guard ----
{
 const g=R.ownerReviewGuard;
 assert.deepEqual(g({read:'ok',entry:'absent',materialised:'no'}),{decision:'proceed',case:'no_entry'},'the absence of an owner record is normal, never a refusal');
 assert.deepEqual(g({read:'ok',entry:'absent',materialised:'yes'}),{decision:'proceed',case:'no_entry'});
 assert.deepEqual(g({read:'ok',entry:'present',materialised:'yes'}),{decision:'proceed',case:'materialised'});
 assert.deepEqual(g({read:'ok',entry:'present',materialised:'no'}),{decision:'refuse',class:CLASS.RECOVERABLE,code:'owner_review_inconsistent'});
 assert.deepEqual(g({read:'ok',entry:'unreadable',materialised:'yes'}),{decision:'refuse',class:CLASS.RECOVERABLE,code:'owner_review_inconsistent'},'an entry that is unreadable for that Film is a recoverable refusal');
 const stop={decision:'stop',class:CLASS.SYSTEMIC,code:'owner_review_check_failed'};
 assert.deepEqual(g({read:'failed',entry:'absent',materialised:'yes'}),stop,'a failing check stops the pass');
 assert.deepEqual(g({read:'failed',entry:'present',materialised:'yes'}),stop);
 assert.deepEqual(g({entry:'absent'}),stop,'fail closed');assert.deepEqual(g(),stop);assert.deepEqual(g({read:'ok',entry:'weird',materialised:'yes'}),stop);assert.deepEqual(g({read:'ok',entry:'present',materialised:'maybe'}),stop);
 assert.equal(R.classOfCode(g({read:'ok',entry:'present',materialised:'no'}).code),CLASS.RECOVERABLE);assert.equal(R.classOfCode(stop.code),CLASS.SYSTEMIC);
}

// ---- 10. The scenarios of the ADR S4-1 list, as pure decisions with injected snapshots ----
{
 const it=(id,revision)=>({id,revision});
 const entry={id:'d1',filmId:'film:1',tmdbId:null,original:'Heat',title:'Схватка',aliases:[],sources:[],status:'verified'};
 const plan1=await planDictionaryUnits({version:'d1',entries:[entry],at:AT});
 const unit={kind:'film_facts',id:'film:1',digest:await R.dictionaryUnitDigest(plan1.units[0])};
 const fpUnit=u=>({kind:u.kind,id:u.id,unitDigest:u.digest});
 const fingerprint=await R.planFingerprint({origin:'dictionary',event:plan1.event,units:[fpUnit(unit)]});
 // (a) dictionary snapshot unchanged: no_identity_row refused; the identity row is created; the same snapshot is eventually applied
 const snapshotNoIdentity=buildDictionaryInput({film:{contract_version:1,original_title:null,canonical_identity:null,updated_at:AT},dimensions:{identity:null,localization:null},trustedTmdb:[]},plan1.units[0],{at:AT});
 assert.ok(snapshotNoIdentity.conflicts.some(c=>c.reason==='no_identity_row'),'the planner names no_identity_row');
 const noIdentity=snapshotNoIdentity.conflicts.find(c=>c.reason==='no_identity_row').reason;
 assert.equal(R.classOfCode(noIdentity),CLASS.RECOVERABLE);
 const stamp0=await R.prereqStamp('no_identity_row',{film:it('film:1',4),identity:null});
 const row=R.resultRow({origin:'dictionary',runKey:'d1',passNo:1,fingerprint,unit,state:'refused_recoverable',code:noIdentity,prereqStamp:stamp0,at:AT});
 assert.equal(row.state,'refused_recoverable');
 // the snapshot is unchanged between runs: the same digest and the same fingerprint, no identity row yet: no apply, no attempt, only the schedule moves
 const replanned=await planDictionaryUnits({version:'d1',entries:[entry],at:'2026-11-13T00:00:00.000Z'});
 assert.equal(await R.planFingerprint({origin:'dictionary',event:replanned.event,units:[fpUnit({...unit,digest:await R.dictionaryUnitDigest(replanned.units[0])})]}),fingerprint);
 const still=R.retryDecision(row,{nowMs:NOW+3600000,currentUnitDigest:unit.digest,trigger:'reobserved',currentStamp:await R.prereqStamp('no_identity_row',{film:it('film:1',4),identity:null})});
 assert.equal(still.action,'defer');assert.equal(still.patch.attempts,undefined);
 // the identity writer creates the row: the unit digest and the fingerprint do NOT move; the stamp does
 const stamp1=await R.prereqStamp('no_identity_row',{film:it('film:1',5),identity:it('identity:film:1',1)});
 assert.notEqual(stamp1,stamp0);
 assert.equal(await R.dictionaryUnitDigest(plan1.units[0]),unit.digest);
 const changed=R.retryDecision(row,{nowMs:NOW+3600000,currentUnitDigest:unit.digest,trigger:'reobserved',currentStamp:stamp1});
 assert.equal(changed.action,'plan_and_apply','the same snapshot is planned and applied through the existing writers');
 // not settled before the write proof
 assert.equal(R.afterRetry(row,{kind:'not_proven'},{nowMs:NOW}).action,'none');
 const applied=R.afterRetry(row,{kind:'proof',proof:'applied_receipt'},{nowMs:NOW});
 assert.deepEqual([applied.patch.state,applied.patch.settled_by],['settled','prerequisite_resolved']);
 // the plan builds against the identity row that now exists, with the same snapshot
 const withIdentity=buildDictionaryInput({film:{contract_version:1,original_title:null,canonical_identity:null,updated_at:AT},dimensions:{identity:{status:'automatic',authority:'automatic',provenance_json:null},localization:null},trustedTmdb:[]},plan1.units[0],{at:AT});
 assert.equal(withIdentity.outcome,'proceed');assert.ok(!withIdentity.conflicts.some(c=>c.reason==='no_identity_row'));

 // (b) a missing Person: the credit unit is a recoverable refusal; the Person is created; the credit is applied
 const credits=planEpgPersonUnits({runId:'r1',at:AT,persons:[],credits:[{filmId:'film:1',credits:creditsOf(2)}]});
 const cunit={kind:'film_credits',id:'film:1',digest:await unitDigest('film_credits',credits.units[0].input)};
 const cfp=await R.planFingerprint({origin:'epg',event:credits.event,units:[fpUnit(cunit)]});
 assert.equal(R.classOfCode('film_person_reference'),CLASS.RECOVERABLE);
 const missing=await R.prereqStamp('film_person_reference',{film:it('film:1',3),persons:[it('person:1',null),it('person:2',null)]});
 const crow=R.resultRow({origin:'epg',runKey:'epg:r1',passNo:1,fingerprint:cfp,unit:cunit,state:'refused_recoverable',code:'film_person_reference',prereqStamp:missing,at:AT});
 const created=await R.prereqStamp('film_person_reference',{film:it('film:1',3),persons:[it('person:1',1),it('person:2',null)]});
 assert.equal(R.retryDecision(crow,{nowMs:NOW+1,currentUnitDigest:cunit.digest,trigger:'reobserved',currentStamp:missing}).action,'defer','while a Person is missing nothing is applied');
 assert.equal(R.retryDecision(crow,{nowMs:NOW+1,currentUnitDigest:cunit.digest,trigger:'reobserved',currentStamp:created}).action,'plan_and_apply','one Person created: plan again');
 const stillMissing=R.afterRetry(crow,{kind:'refused',error:{code:'film_person_reference'},stamp:created},{nowMs:NOW});assert.deepEqual([stillMissing.patch.state,stillMissing.patch.prereq_stamp],['refused_recoverable',created],'the second Person is still missing: refused again, new stamp');
 // the credit digest and the plan fingerprint did not move while the Persons were created (the Person list is not a credit-unit input)
 const credits2=planEpgPersonUnits({runId:'r1',at:'2026-11-14T00:00:00.000Z',persons:[{id:'person:1',state:{identity:{tmdbId:1,name:'A'}}}],credits:[{filmId:'film:1',credits:creditsOf(2)}]});
 const creditUnit2=credits2.units.find(unit=>unit.kind==='film_credits');
 assert.equal(await unitDigest('film_credits',creditUnit2.input),cunit.digest,'creating a Person does not move the credit digest');
 assert.equal(await R.planFingerprint({origin:'epg',event:credits2.event,units:[fpUnit({...cunit,digest:await unitDigest('film_credits',creditUnit2.input)})]}),cfp);
 const settled=R.afterRetry(crow,{kind:'proof',proof:'applied_receipt'},{nowMs:NOW});assert.equal(settled.patch.settled_by,'prerequisite_resolved');

 // (c) a list over 50 stays refused_permanent and visible, never truncated; the rest of the plan survives
 const big=creditsOf(CREDITS_PER_UNIT_MAX+1);
 assert.equal(codeOf(()=>planEpgPersonUnits({runId:'r1',at:AT,persons:[],credits:[{filmId:'film:1',credits:big}]})),'film_person_bounded','the default planner still refuses the whole plan');
 const plan=planEpgPersonUnitsWithRefusals({runId:'r1',at:AT,persons:people,credits:[{filmId:'film:1',credits:big},{filmId:'film:2',credits:creditsOf(2)}]});
 assert.deepEqual(plan.units.map(unit=>unit.kind+':'+unit.id),['person_state:person:1','person_state:person:2','film_credits:film:2'],'the rest of the plan survives');
 assert.equal(plan.refused.length,1);assert.deepEqual([plan.refused[0].kind,plan.refused[0].id,plan.refused[0].code],['film_credits','film:1','film_person_bounded']);
 assert.equal(plan.refused[0].source.length,CREDITS_PER_UNIT_MAX+1,'the incoming list is carried whole: never truncated');
 assert.deepEqual(planEpgPersonUnitsWithRefusals({runId:'r1',at:AT,persons:people,credits:[{filmId:'film:2',credits:creditsOf(2)}]}).refused,[],'no refusal when nothing is oversized');
 assert.equal(planEpgPersonUnits({runId:'r1',at:AT,persons:[],credits:[{filmId:'film:2',credits:creditsOf(2)}]}).refused,undefined,'the default result shape is unchanged');
 const bigDigest=await R.refusedUnitDigest(plan.refused[0]);
 assert.equal(bigDigest,await R.refusedUnitDigest({...plan.refused[0]}));assert.notEqual(bigDigest,await R.refusedUnitDigest({...plan.refused[0],source:big.slice(0,CREDITS_PER_UNIT_MAX)}),'the digest is the digest of the incoming list');
 const refusedStep=fail(fresh(),{kind:'film_credits',id:'film:1',digest:bigDigest},plan.refused[0].code);
 assert.deepEqual([refusedStep.action,refusedStep.result.state,refusedStep.run.cursor_id,refusedStep.run.strike_count],['refuse_permanent','refused_permanent','film:1',0],'durable at first observation, no strike');
 // ONE ordered plan covers the units AND the refused unit: its fingerprint is the real one of that plan
 const planUnits=await Promise.all(plan.units.map(async unit=>({kind:unit.kind,id:unit.id,unitDigest:await unitDigest(unit.kind,unit.input)})));
 const entries=await R.buildPlanEntries({units:planUnits,refused:plan.refused});
 const planFp=await R.planFingerprint({origin:'epg',event:plan.event,units:entries});
 const brow=R.resultRow({origin:'epg',runKey:'epg:r1',passNo:1,fingerprint:planFp,unit:{kind:'film_credits',id:'film:1',digest:bigDigest},state:'refused_permanent',code:'film_person_bounded',at:AT});
 for(const nowMs of [NOW+1,NOW+RETRY_POLICY.abandonAfterMs*3])assert.deepEqual(R.retryDecision(brow,{nowMs,currentUnitDigest:bigDigest,trigger:'due'}),{action:'none',reason:'permanent_never_retried'},'never retried, never abandoned, still live (visible)');
 assert.ok(R.LIVE_STATES.includes(brow.state),'it stays a live row: visible and blocking');
 const shrunk=R.retryDecision(brow,{nowMs:NOW,currentUnitDigest:await R.refusedUnitDigest({...plan.refused[0],source:big.slice(0,CREDITS_PER_UNIT_MAX)}),trigger:'reobserved'});
 assert.deepEqual([shrunk.action,shrunk.patch.settled_by],['supersede','source_changed'],'only a changed list clears it');
 // unranked_kept and credits_absent_from_source are NAMED kept outcomes: counted, no row, no retry
 for(const code of ['unranked_kept','credits_absent_from_source','owner_kept','reviewed_kept'])assert.equal(R.classifyProducerError(code).action,'keep');
 const unranked=buildDictionaryInput({film:{contract_version:1,original_title:'Heat (1995)',canonical_identity:null,updated_at:AT},dimensions:{identity:{status:'automatic',authority:'automatic',provenance_json:null},localization:null},trustedTmdb:[]},{id:'film:1',entry:{...entry,title:null}},{at:AT});
 assert.ok(unranked.conflicts.some(c=>c.reason==='unranked_kept'&&c.kind==='kept'),'a different title with no titleSource is unranked_kept');
 const equal=buildDictionaryInput({film:{contract_version:1,original_title:'Heat',canonical_identity:null,updated_at:AT},dimensions:{identity:{status:'automatic',authority:'automatic',provenance_json:null},localization:null},trustedTmdb:[]},{id:'film:1',entry:{...entry,title:null}},{at:AT});
 assert.equal(equal.outcome,'kept','an equal incoming title with no titleSource adopts no ownership');
 assert.ok(R.KIND_RANK.film_credits>R.KIND_RANK.person_state);
}

// ---- 10b. The planner wrappers: per-unit refusals, in both orders, and the ONE ordered plan ----
{
 const W=input=>planEpgPersonUnitsWithRefusals({runId:'r1',at:AT,persons:[],...input});
 const big=creditsOf(CREDITS_PER_UNIT_MAX+1),small=creditsOf(2);
 // an id already used by ANY other entry, refused or not, in either order, refuses the plan
 assert.equal(codeOf(()=>W({credits:[{filmId:'film:1',credits:big},{filmId:'film:1',credits:small}]})),'film_person_invalid','oversized then valid');
 assert.equal(codeOf(()=>W({credits:[{filmId:'film:1',credits:small},{filmId:'film:1',credits:big}]})),'film_person_invalid','valid then oversized');
 assert.equal(codeOf(()=>W({credits:[{filmId:'film:1',credits:big},{filmId:'film:1',credits:big}]})),'film_person_invalid','two oversized');
 assert.equal(codeOf(()=>W({credits:[{filmId:'film:1',credits:[]},{filmId:'film:1',credits:small}]})),'film_person_invalid','invalid then valid');
 assert.equal(codeOf(()=>W({credits:[{filmId:'film:1',credits:small},{filmId:'film:1',credits:'x'}]})),'film_person_invalid','valid then malformed');
 assert.equal(codeOf(()=>W({persons:[{id:'person:1',state:{}},{id:'person:1',state:people[0].state}]})),'film_person_invalid','an invalid Person then a valid one');
 assert.equal(codeOf(()=>W({persons:[{id:'person:1',state:people[1].state},{id:'person:1',state:{}}]})),'film_person_invalid','a valid Person then an invalid one');
 const survive=W({credits:[{filmId:'film:1',credits:big},{filmId:'film:2',credits:small}]});
 assert.deepEqual([survive.units.map(unit=>unit.id),survive.refused.map(unit=>unit.id)],[['film:2'],['film:1']],'an unrelated valid Film survives, never both lists for one id');
 // per-unit invalid units: a malformed state, an empty list, a non-array, a duplicated credit, an unknown role
 const bad=W({persons:[{id:'person:3',state:{}},{id:'person:1',state:people[1].state}],credits:[{filmId:'film:5',credits:[]},{filmId:'film:6',credits:'x'},{filmId:'film:7',credits:[{personId:'person:1',role:'actor'},{personId:'person:1',role:'actor'}]},{filmId:'film:8',credits:[{personId:'person:1',role:'cook'}]},{filmId:'film:9',credits:small}]});
 assert.deepEqual(bad.units.map(unit=>unit.kind+':'+unit.id),['person_state:person:1','film_credits:film:9']);
 assert.deepEqual(bad.refused.map(unit=>unit.kind+':'+unit.id+':'+unit.code),['person_state:person:3:film_person_invalid','film_credits:film:5:film_person_invalid','film_credits:film:6:film_person_invalid','film_credits:film:7:film_person_invalid','film_credits:film:8:film_person_invalid']);
 assert.equal(bad.refused[0].source.constructor,Object,'the incoming value is carried');
 // no usable id: the whole plan is refused (no key to record a result under); the default planners are unchanged
 assert.equal(codeOf(()=>W({credits:[{filmId:'x',credits:small}]})),'film_person_invalid');assert.equal(codeOf(()=>W({credits:[null]})),'film_person_invalid');assert.equal(codeOf(()=>W({persons:[{id:'x',state:{}}]})),'film_person_invalid');
 assert.equal(codeOf(()=>planEpgPersonUnits({runId:'r1',at:AT,persons:[],credits:[{filmId:'film:1',credits:[]}]})),'film_person_invalid','the default planner still refuses the whole plan');
 // Film facts
 const F=input=>planEpgUnitsWithRefusals({runId:'r1',at:AT,...input});
 const okFilm={id:'film:2',facts:factsOf()};
 const films=F({films:[{id:'film:1',facts:'nope'},okFilm,{id:'film:4'}],departed:['film:1','film:3']});
 assert.deepEqual(films.units.map(unit=>unit.id),['film:2','film:3']);assert.deepEqual(films.refused.map(unit=>unit.id+':'+unit.code),['film:1:film_person_invalid','film:4:film_person_invalid']);
 assert.equal(films.units.some(unit=>unit.id==='film:1'),false,'a refused observed Film is not released');
 assert.equal(codeOf(()=>F({films:[{id:'film:1',facts:'x'},{id:'film:1',facts:factsOf()}]})),'film_person_invalid');assert.equal(codeOf(()=>F({films:[okFilm,{id:'film:2',facts:'x'}]})),'film_person_invalid');
 assert.equal(codeOf(()=>F({films:[{id:'x',facts:{}}]})),'film_person_invalid');
 // the dictionary snapshot still refuses a malformed entry as a whole: per-unit refusal of the dictionary is a LATER delivery (S4-4, with the resolver), pinned here so it is changed knowingly
 assert.equal(await codeOfAsync(()=>planDictionaryUnits({version:'d1',entries:[{id:'x'}],at:AT})),'film_person_invalid');
 // THE ONE ORDERED PLAN. (a) only refused units: a non-empty plan whose fingerprint is not the empty plan's
 const only=W({credits:[{filmId:'film:1',credits:big}]});
 assert.equal(only.units.length,0);
 const e51=await R.buildPlanEntries({units:[],refused:only.refused});
 assert.deepEqual(e51.map(entry=>[entry.kind,entry.id,entry.refusal]),[['film_credits','film:1','film_person_bounded']]);
 const fp=entries=>R.planFingerprint({origin:'epg',event:only.event,units:entries});
 const empty=await fp([]),fp51=await fp(e51);
 assert.notEqual(fp51,empty,'a plan with only a refused unit is not the empty plan');
 // (c) 51 -> 52 credits under the same event: the unit digest and the fingerprint move
 const only52=W({credits:[{filmId:'film:1',credits:creditsOf(CREDITS_PER_UNIT_MAX+2)}]});
 const e52=await R.buildPlanEntries({units:[],refused:only52.refused});
 assert.equal(only52.event,only.event);assert.notEqual(e52[0].unitDigest,e51[0].unitDigest);assert.notEqual(await fp(e52),fp51,'a changed refused list moves the fingerprint');
 assert.equal(await fp(await R.buildPlanEntries({units:[],refused:W({credits:[{filmId:'film:1',credits:big}]}).refused})),fp51,'reproducible');
 // (b) mixed valid and refused entries come in cursor order, and resume is the first entry strictly after the cursor
 const mixedPlan=W({persons:[{id:'person:2',state:{}},...people.slice(1)],credits:[{filmId:'film:3',credits:big},{filmId:'film:1',credits:small}]});
 const digested=await Promise.all(mixedPlan.units.map(async unit=>({kind:unit.kind,id:unit.id,unitDigest:await unitDigest(unit.kind,unit.input)})));
 const mixed=await R.buildPlanEntries({units:digested,refused:mixedPlan.refused});
 assert.deepEqual(mixed.map(entry=>entry.kind+':'+entry.id+':'+(entry.refusal??'')),['person_state:person:1:','person_state:person:2:film_person_invalid','film_credits:film:1:','film_credits:film:3:film_person_bounded']);
 assert.equal(R.resumeIndex(mixed,{kind:'person_state',id:'person:1'}),1,'the refused entry is visited');
 assert.equal(R.resumeIndex(mixed,{kind:'person_state',id:'person:2'}),2);
 assert.equal(R.resumeIndex(mixed,{kind:'film_credits',id:'film:1'}),3,'the cursor reaches the refused entry before the end');
 assert.equal(R.sliceCursor(mixed,null,mixed.map(entry=>({kind:entry.kind,id:entry.id,outcome:entry.refusal?'result_written':'applied'}))).id,'film:3','the cursor passes a refused entry only once its result is written');
 assert.deepEqual(R.sliceCursor(mixed,null,mixed.map(entry=>({kind:entry.kind,id:entry.id,outcome:entry.refusal?'pending':'applied'}))),{kind:'person_state',id:'person:1'},'a refused entry whose result is not written stops the cursor');
 const fpMixed=await R.planFingerprint({origin:'epg',event:mixedPlan.event,units:mixed});
 assert.notEqual(fpMixed,await R.planFingerprint({origin:'epg',event:mixedPlan.event,units:mixed.map(entry=>({kind:entry.kind,id:entry.id,unitDigest:entry.unitDigest}))}),'the refusal code is part of the identity');
 assert.equal(await R.planFingerprint({origin:'epg',event:'e',units:planUnitsOnly()}),await R.planFingerprint({origin:'epg',event:'e',units:planUnitsOnly().map(entry=>({...entry}))}),'a plan with no refusal carries no refusal key (the ADR formula)');
 function planUnitsOnly(){return [{kind:'film_facts',id:'film:1',unitDigest:H('a')}];}
 assert.equal(await R.planFingerprint({origin:'epg',event:'e',units:planUnitsOnly()}),await digestOf({planVersion:R.PRODUCER_PLAN_VERSION,origin:'epg',event:'e',units:[{kind:'film_facts',id:'film:1',unitDigest:H('a')}]}));
 // (d) the refusal disappears when the list becomes valid: the entry is a normal one with another digest, and the live row is superseded
 const valid=W({credits:[{filmId:'film:1',credits:creditsOf(CREDITS_PER_UNIT_MAX)}]});
 assert.deepEqual([valid.refused.length,valid.units.length],[0,1]);
 const validEntries=await R.buildPlanEntries({units:[{kind:'film_credits',id:'film:1',unitDigest:await unitDigest('film_credits',valid.units[0].input)}],refused:[]});
 assert.equal(validEntries[0].refusal,undefined);assert.notEqual(await fp(validEntries),fp51);
 const liveRow=R.resultRow({origin:'epg',runKey:'epg:r1',passNo:1,fingerprint:fp51,unit:{kind:'film_credits',id:'film:1',digest:e51[0].unitDigest},state:'refused_permanent',code:'film_person_bounded',at:AT});
 const cleared=R.retryDecision(liveRow,{nowMs:NOW,currentUnitDigest:validEntries[0].unitDigest,trigger:'reobserved'});
 assert.deepEqual([cleared.action,cleared.patch.settled_by],['supersede','source_changed']);
 assert.equal(R.retryDecision(liveRow,{nowMs:NOW,currentUnitDigest:null,trigger:'reobserved'}).patch.settled_by,'left_plan');
 // building entries: nothing is dropped, a key in both lists or a non-refusal code refuses
 assert.equal(await codeOfAsync(()=>R.buildPlanEntries({units:[{kind:'film_credits',id:'film:1',unitDigest:H('a')}],refused:only.refused})),'film_person_invalid');
 assert.equal(await codeOfAsync(()=>R.buildPlanEntries({units:[],refused:[{kind:'film_credits',id:'film:1',code:'identity_collision',source:1}]})),'film_person_invalid');
 assert.equal(await codeOfAsync(()=>R.buildPlanEntries({units:[],refused:[{kind:'film_credits',id:'film:1',code:'film_person_unavailable',source:1}]})),'film_person_invalid');
 assert.equal(await codeOfAsync(()=>R.buildPlanEntries({units:[],refused:[...only.refused,...only.refused]})),'film_person_invalid');
 assert.equal(await codeOfAsync(()=>R.planFingerprint({origin:'epg',event:'e',units:[{kind:'film_credits',id:'film:1',unitDigest:H('a'),refusal:'owner_kept'}]})),'film_person_invalid');
 assert.equal((await R.buildPlanEntries({units:[],refused:[{kind:'film_credits',id:'film:1',code:'film_person_invalid',source:{n:1n}}]})).length,1,'an unserialisable source still gets a digest');
}

// ---- 10c. Result rows: the code class must fit the state; one retry owner ----
{
 const base={...PASS,attempts:1};
 const bad=(extra,message)=>assert.equal(codeOf(()=>R.resultRow({...base,...extra})),'film_person_invalid',message);
 bad({state:'open',code:'film_person_unavailable'},'a systemic code is never a unit result');
 bad({state:'open',code:'producer_cas_lost'},'a store error is never a unit result');
 bad({state:'open',code:'no_identity_row'},'a refusal code is not an execution failure');
 bad({state:'open',code:'owner_kept'},'a kept outcome has no row');
 bad({state:'open',code:'unclassified'},'unclassified stops the pass');
 bad({state:'open',code:'brand_new_code'},'an unknown code on a unit-owned row');
 bad({state:'refused_permanent',code:'no_identity_row'},'a permanent refusal cannot carry a recoverable code');
 bad({state:'refused_permanent',code:'identity_collision'},'nor an execution code');
 bad({state:'refused_recoverable',code:'film_person_bounded',prereqStamp:H('5')},'a recoverable refusal cannot carry a permanent code');
 bad({state:'refused_recoverable',code:'film_person_unavailable',prereqStamp:H('5')},'nor a systemic one');
 bad({state:'open',code:'film_person_unavailable',retryOwner:'receipt',requestId:'epg:x'},'a systemic code is not a receipt-owned unit result either');
 bad({state:'open',code:'film_person_bounded',retryOwner:'receipt',requestId:'epg:x'},'a permanent code is not an execution failure');
 // valid: execution code, a receipt error class the table does not know, refusals with their own class
 assert.equal(R.resultRow({...base,state:'open',code:'identity_collision'}).state,'open');
 assert.equal(R.resultRow({...base,state:'open',code:'atomic_mark_missing',retryOwner:'receipt',requestId:'epg:x'}).retry_owner,'receipt');
 // a patch that would produce a forbidden row cannot leave afterRetry
 const unitOpen=R.resultRow({...base,state:'open',code:'identity_collision'});
 const stop=R.afterRetry(unitOpen,{kind:'failed',error:{code:'film_person_unavailable'}},{nowMs:NOW});assert.deepEqual(stop,{action:'stop',code:'film_person_unavailable'});
 assert.equal(codeOf(()=>R.afterRetry(R.resultRow({...base,state:'open',code:'atomic_mark_missing',retryOwner:'receipt',requestId:'epg:x'}),{kind:'failed',error:{code:'identity_collision'}},{nowMs:NOW})),'film_person_invalid','a receipt-owned row is not retried by the unit');
 assert.equal(codeOf(()=>R.afterRetry(R.resultRow({...base,state:'open',code:'atomic_mark_missing',retryOwner:'receipt',requestId:'epg:x'}),{kind:'proof',proof:'applied_receipt'},{nowMs:NOW})),'film_person_invalid','the unit retry path never settles a receipt-owned row');
 // THE receipt-owned reclassification: a same-digest open receipt row is never turned into a recoverable refusal by a failure write
 const receiptRow=R.resultRow({...base,state:'open',code:'atomic_mark_missing',retryOwner:'receipt',requestId:'epg:x'});
 const toRecoverable={...base,state:'refused_recoverable',code:'no_identity_row',prereqStamp:H('5')};
 assert.deepEqual(R.failureWrite(receiptRow,toRecoverable),{none:'receipt_owned'},'refused until the receipt owner settles');
 assert.deepEqual(R.failureWrite(receiptRow,{...base,state:'open',code:'identity_collision'}),{none:'receipt_owned'});
 assert.deepEqual(R.failureWrite(receiptRow,{...base,state:'refused_permanent',code:'film_person_bounded'}),{none:'receipt_owned'});
 // a changed digest still supersedes a receipt-owned row (the source moved on)
 const moved=R.failureWrite(receiptRow,{...toRecoverable,unit:{...PASS.unit,digest:H('b')}});assert.equal(moved.supersede.patch.settled_by,'source_changed');assert.equal(moved.insert.retry_owner,'unit');
 // a valid unit-owned reclassification: open -> refused_recoverable keeps the owner, takes a schedule and a stamp
 const reclass=R.failureWrite(unitOpen,toRecoverable);
 const merged={...unitOpen,...reclass.update.patch};
 assert.deepEqual([merged.state,merged.retry_owner,merged.prereq_stamp,merged.next_attempt_at!==null,merged.request_id],['refused_recoverable','unit',H('5'),true,null]);
 assert.equal(R.assertResultRow(merged).code,'no_identity_row');
 // the owner of a row never changes
 assert.equal(codeOf(()=>R.failureWrite(unitOpen,{...base,state:'open',code:'identity_collision',retryOwner:'receipt',requestId:'epg:x'})),'film_person_invalid');
 // a live row that is itself malformed is refused
 assert.equal(codeOf(()=>R.failureWrite({...unitOpen,code:'film_person_unavailable'},{...base,state:'open',code:'identity_collision'})),'film_person_invalid');
}

// ---- 11. Dormancy ----
{
 const self='src/canonical-producer-run.js';
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name).replace(/\\/g,'/');if(entry.isDirectory()){if(entry.name!=='node_modules'&&entry.name!=='.git')walk(full);}else if(/\.(js|mjs)$/.test(entry.name)&&full!==self&&fs.readFileSync(full,'utf8').includes('canonical-producer-run'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,[],'nothing in src imports the pure producer-run module');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-producer-run'),file+' does not bundle it');
 assert.ok(!fs.readFileSync('src/worker.js','utf8').includes('canonical-producer-run'),'the Worker does not name it');
 const text=fs.readFileSync(self,'utf8');
 assert.deepEqual([...text.matchAll(/^import .* from '([^']+)'/gm)].map(match=>match[1]),['./canonical-receipts.js'],'its only import is the receipt module (pure helpers)');
 assert.ok(!/\b(SELECT|INSERT|UPDATE|DELETE)\s+(INTO|FROM|\w+\s+SET)\b/i.test(text.replace(/\/\/.*$/gm,'')),'no SQL statement');
 assert.ok(!/\b(fetch|prepare|batch|exec)\s*\(|process\.env|Date\.now|new Date\(\)|Math\.random|crypto\.randomUUID/.test(text.replace(/\/\/.*$/gm,'')),'no I/O, no environment, no clock, no randomness');
}
console.log('canonical-producer-run: ok');
