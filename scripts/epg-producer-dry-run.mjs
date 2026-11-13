// AIR-374 M2 (ADR 0128 staged plan): the OFFLINE, READ-ONLY dry-run harness of the EPG canonical producer plan. It plans the units of one run exactly as the dormant producer layers do (planEpgUnitsWithRefusals,
// planEpgPersonUnitsWithRefusals), then PRE-PLANS each unit against the stored canonical rows with the planners the apply functions use (prePlanFilmFacts, planPersonMutation and the person-state and credit
// plans), and reports COUNTS and TIMINGS only: units by kind, changed, no-op, absent, refused by code, failed by code, the `changedShare`, the per-unit latency and D1 read count, the cost of planning and of the plan
// fingerprint. It never applies a unit: it imports no apply function and no writer, the database binding it gives the planners is a statement-class guard (one read-only SELECT per statement; `batch`, `exec` and
// every non-SELECT statement are refused with `dry_run_write_refused`), and the output holds no id, title, name or payload.
// This file is the harness (M2). Running it on a verified safe copy is M2b and on a production snapshot needs its own exactly scoped read-only owner GO; nothing here is a GO and nothing here reads production.
import {planEpgUnitsWithRefusals} from '../src/canonical-epg-producer.js';
import {planEpgPersonUnitsWithRefusals} from '../src/canonical-epg-person-producer.js';
import {prePlanFilmFacts,resolveReleaseInput} from '../src/canonical-producer-adapters.js';
import {filmFactsDigest} from '../src/canonical-producer-adapters.js';
import {planPersonMutation,personMutationDigest,PERSON_MUTATION_OPERATION} from '../src/canonical-person-mutation-producer.js';
import {planUnit,unitDigest} from '../src/canonical-person-adapters.js';
import {buildPlanEntries,planFingerprint} from '../src/canonical-producer-run.js';
import {assertReadOnly} from './schema-preflight.mjs';

export class DryRunWriteRefused extends Error{constructor(why){super('dry_run_write_refused: '+why);this.code='dry_run_write_refused';}}

// A D1-like binding over `binding` that can only read. `counter.queries` counts the statements prepared.
export function readOnlyBinding(binding,counter={queries:0}){
 if(!binding||typeof binding.prepare!=='function')throw new DryRunWriteRefused('no database binding');
 return {
  counter,
  prepare(sql){
   try{assertReadOnly(sql);}catch{throw new DryRunWriteRefused('a statement that is not one read-only SELECT');}
   counter.queries++;
   return binding.prepare(sql);
  },
  batch(){throw new DryRunWriteRefused('batch');},
  exec(){throw new DryRunWriteRefused('exec');},
  dump(){throw new DryRunWriteRefused('dump');},
 };
}

const percentile=(sorted,q)=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(q*sorted.length)-1)]:null;
const summarize=values=>{
 const sorted=[...values].sort((a,b)=>a-b);
 return {n:sorted.length,total:Number(sorted.reduce((sum,value)=>sum+value,0).toFixed(3)),p50:percentile(sorted,0.5),p90:percentile(sorted,0.9),p99:percentile(sorted,0.99),max:sorted.length?sorted[sorted.length-1]:null};
};
const emptyKind=()=>({units:0,changed:0,noop:0,absent:0,refused:0,failed:0});

// input: {env (a binding holder {DB}), runId, at, films, departed, persons, credits, personRows, clock?}. The planners get a read-only binding built here: pass the REAL binding as `env.DB`.
export async function dryRun({env,runId='dry-run',at,films=[],departed=[],persons=[],credits=[],personRows=[],clock=()=>performance.now()}={}){
 if(typeof at!=='string'||!at)throw new DryRunWriteRefused('a write clock is required');
 const counter={queries:0};
 const guarded={DB:readOnlyBinding(env?.DB??env,counter)};
 const plannedAt=clock();
 const filmPlan=planEpgUnitsWithRefusals({runId,at,films,departed});
 const personPlan=planEpgPersonUnitsWithRefusals({runId,at,persons,credits,personRows});
 const planMs=clock()-plannedAt;
 const units=[...filmPlan.units.map(unit=>({kind:'film_facts',id:unit.id,release:unit.release===true,input:unit.input})),...personPlan.units.map(unit=>({kind:unit.kind,id:unit.id,release:false,input:unit.input}))];
 const refusedPlanner=[...filmPlan.refused,...personPlan.refused];
 const byKind={},refusedByCode={},failedByCode={},latency=[],reads=[];
 const bucket=kind=>byKind[kind]||(byKind[kind]=emptyKind());
 const entries=[];
 for(const unit of units){
  const row=bucket(unit.kind);row.units++;
  const q0=counter.queries,t0=clock();
  try{
   let plan,digestInput=unit.input;
   if(unit.kind==='film_facts'){
    if(unit.release){
     digestInput=await resolveReleaseInput(guarded,unit.input);
     plan=digestInput?await prePlanFilmFacts(guarded,{input:digestInput,requestId:'dry-run'}):{absent:true};
    }else plan=await prePlanFilmFacts(guarded,{input:unit.input,requestId:'dry-run'});
   }else if(unit.kind===PERSON_MUTATION_OPERATION)plan=await planPersonMutation(guarded,unit.input);
   else plan=await planUnit(unit.kind,guarded,unit.input);
   if(plan.absent)row.absent++;else if(plan.noop)row.noop++;else row.changed++;
   // the unit digest the fingerprint covers (a release unit that resolved to no stored Film has none)
   if(digestInput){
    try{entries.push({kind:unit.kind,id:unit.id,unitDigest:unit.kind==='film_facts'?await filmFactsDigest(digestInput):unit.kind===PERSON_MUTATION_OPERATION?await personMutationDigest(unit.input):await unitDigest(unit.kind,unit.input)});}catch{/* undigestable: counted by the planner as refused or failed elsewhere */}
   }
  }catch(error){
   const code=typeof error?.code==='string'?error.code:'unclassified';
   if(code==='dry_run_write_refused')throw error;
   if(/^(film_person_(invalid|redirect|reference|bounded)|identity_collision|person_role_collision|film_person_identity_conflict)$/.test(code)){row.refused++;refusedByCode[code]=(refusedByCode[code]||0)+1;}
   else{row.failed++;failedByCode[code]=(failedByCode[code]||0)+1;}
  }
  latency.push(Number((clock()-t0).toFixed(3)));
  reads.push(counter.queries-q0);
 }
 for(const item of refusedPlanner){bucket(item.kind).refused++;refusedByCode[item.code]=(refusedByCode[item.code]||0)+1;}
 // the cost of the plan fingerprint over the digests of the planned units (the planner refusals are entries too)
 let fingerprintMs=null,fingerprintEntries=0;
 try{
  const f0=clock();
  const ordered=await buildPlanEntries({units:entries.filter(entry=>/^[0-9a-f]{64}$/.test(entry.unitDigest)),refused:[]});
  await planFingerprint({origin:'epg',event:'epg:'+runId,units:ordered});
  fingerprintMs=Number((clock()-f0).toFixed(3));fingerprintEntries=ordered.length;
 }catch{fingerprintMs=null;}
 const total=units.length;
 const changed=Object.values(byKind).reduce((sum,row)=>sum+row.changed,0);
 return {
  planned:{units:total,refusedByPlanner:refusedPlanner.length,filmUnits:filmPlan.units.length,personAndCreditUnits:personPlan.units.length},
  byKind,refusedByCode,failedByCode,
  changed,changedShare:total?Number((changed/total).toFixed(4)):null,
  latencyMs:summarize(latency),d1ReadsPerUnit:summarize(reads),
  planMs:Number(planMs.toFixed(3)),fingerprint:{entries:fingerprintEntries,ms:fingerprintMs},
  writes:0,
 };
}
