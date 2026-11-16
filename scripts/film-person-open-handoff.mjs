#!/usr/bin/env node
// AIR-499. Operator CLI. Default is dry-run (REST SELECTs only). `--apply` is refused on this REST
// transport: grant and recordBaseline need Worker D1Database.batch() rollback, which /query does not
// document, and explicit BEGIN/COMMIT is unsupported on D1.
import {activateOpen,parseOpenHandoffArgs,proveOperatorTarget,OPERATOR_D1_TARGET} from '../src/film-person-open-handoff.js';
import {createD1Adapter,readTarget,renderSql} from './d1-backfill.mjs';

export function bindingOfAdapter(adapter){
 const bound=(sql,params)=>({
  text:renderSql(sql,params),
  first:()=>adapter.get(sql,params),
  all:async()=>({results:await adapter.all(sql,params)}),
  run:()=>adapter.run(sql,params),
 });
 return {
  prepare(sql){return {bind:(...params)=>bound(sql,params),...bound(sql,[])};},
  async batch(){
   const error=new Error('transport_not_worker_batch');
   error.code='transport_not_worker_batch';
   throw error;
  },
 };
}

export async function main(argv=process.argv.slice(2),env=process.env,io=console){
 const args=parseOpenHandoffArgs(argv);
 if(args.help){
  io.log('Usage: node scripts/film-person-open-handoff.mjs [--expected-generation=N] [--expected-reference=HEX]  (dry-run). --apply is refused on the REST D1 adapter.');
  return 0;
 }
 if(args.apply&&args.confirmGo!==true){
  io.error('refused: --apply requires --confirm-go');
  return 2;
 }
 if(args.apply&&(!Number.isInteger(args.expectedGeneration)||!args.expectedReference)){
  io.error('refused: --apply requires --expected-generation and --expected-reference');
  return 2;
 }
 const target=readTarget(env);
 if(args.apply){
  if(target.endpointOverride||target.endpoint!==OPERATOR_D1_TARGET.endpoint||target.databaseId!==OPERATOR_D1_TARGET.databaseId||target.databaseName!==OPERATOR_D1_TARGET.databaseName){
   io.error(JSON.stringify({outcome:'stop',reason:'target_mismatch'}));
   return 2;
  }
 }
 const adapter=createD1Adapter({target,databaseId:target.databaseId});
 if(args.apply){
  const described=await adapter.describe();
  const proved=proveOperatorTarget({target,described});
  if(!proved.ok){
   io.error(JSON.stringify({outcome:'stop',reason:'target_mismatch',reasons:proved.reasons}));
   return 2;
  }
 }
 const result=await activateOpen({DB:bindingOfAdapter(adapter),d1Transport:'rest'},{
  apply:args.apply,
  confirmGo:args.confirmGo,
  expectedGeneration:args.expectedGeneration,
  expectedReference:args.expectedReference,
 });
 io.log(JSON.stringify(result,(_k,v)=>v instanceof Error?{message:v.message,code:v.code}:v,2));
 return result.outcome==='activated'||result.outcome==='dry_run'?0:3;
}

const entry=process.argv[1]&&/scripts\/film-person-open-handoff\.mjs$/.test(process.argv[1].replaceAll('\\','/'));
if(entry)main().then(code=>process.exit(code),error=>{console.error(error);process.exit(1);});
