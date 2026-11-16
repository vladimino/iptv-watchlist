#!/usr/bin/env node
// AIR-499. Operator CLI for the Film/Person prepared → open handoff. Default is dry-run (readiness only).
// `--apply --confirm-go` is required together for any write. A merge of this file is not a production GO.
// The flip is a single UPDATE (binding.run), not a REST {batch} pair that depends on changes().
import {activateOpen,parseOpenHandoffArgs,proveOperatorTarget,OPERATOR_D1_TARGET,transactionalStatements} from '../src/film-person-open-handoff.js';
import {createD1Adapter,readTarget,renderSql} from './d1-backfill.mjs';

export {transactionalStatements};

export function bindingOfAdapter(adapter){
 const bound=(sql,params)=>({
  text:renderSql(sql,params),
  first:()=>adapter.get(sql,params),
  all:async()=>({results:await adapter.all(sql,params)}),
  run:()=>adapter.run(sql,params),
 });
 return {
  prepare(sql){return {bind:(...params)=>bound(sql,params),...bound(sql,[])};},
  async batch(statements){
   await adapter.executeSql(transactionalStatements(statements.map(item=>item.text)));
   return statements.map(()=>({success:true}));
  },
 };
}

export async function main(argv=process.argv.slice(2),env=process.env,io=console){
 const args=parseOpenHandoffArgs(argv);
 if(args.help){
  io.log('Usage: node scripts/film-person-open-handoff.mjs [--expected-generation=N] [--expected-reference=HEX] [--apply --confirm-go]');
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
   io.error(JSON.stringify({outcome:'stop',reason:'target_mismatch',target:{endpoint:target.endpoint,databaseId:target.databaseId,databaseName:target.databaseName,endpointOverride:target.endpointOverride}}));
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
 const result=await activateOpen({DB:bindingOfAdapter(adapter)},{
  apply:args.apply,
  confirmGo:args.confirmGo,
  expectedGeneration:args.expectedGeneration,
  expectedReference:args.expectedReference,
 });
 io.log(JSON.stringify(result,(_k,v)=>v instanceof Error?{message:v.message,code:v.code}:v,2));
 return result.outcome==='activated'||result.outcome==='dry_run'?0:3;
}

const entry=process.argv[1]&&/film-person-open-handoff\.mjs$/.test(process.argv[1].replaceAll('\\','/'));
if(entry)main().then(code=>process.exit(code),error=>{console.error(error);process.exit(1);});
