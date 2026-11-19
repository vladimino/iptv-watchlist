// AIR-537 slice 3: a minimal vm context for the canonical repository (src/canonical-repository.js) over a D1 binding. It replaces the
// retired enrichment projector's loader (tests/d1-enrichment-context.mjs) for the tests that only need the repository and a D1
// adapter. `d1Adapter` is the repository's database interface over a D1 binding as the projector used to build it: reads go out at
// once; writes inside transaction() are collected and sent as one db.batch, which D1 applies atomically. Test-only code.
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

export function d1Adapter(binding){
 let buffer=null;
 const statement=(sql,params)=>binding.prepare(sql).bind(...params);
 return {
  async get(sql,params=[]){const result=await statement(sql,params).all();return (result.results||[])[0]??null;},
  async all(sql,params=[]){const result=await statement(sql,params).all();return result.results||[];},
  async run(sql,params=[]){if(buffer){buffer.push(statement(sql,params));return;}await statement(sql,params).run();},
  async readBatch(list){const out=await binding.batch(list.map(item=>statement(item.sql,item.params)));return out.map(item=>item?.results||[]);},
  async writeBatch(list){await binding.batch(list.map(item=>statement(item.sql,item.params)));},
  async transaction(fn){
   if(buffer)return fn();
   buffer=[];let statements;
   try{await fn();statements=buffer;}finally{buffer=null;}
   if(statements.length)await binding.batch(statements);
  },
 };
}

export function repositoryContext({log=()=>{}}={}){
 const context=vm.createContext({Date,Map,Set,WeakMap,JSON,Object,URL,Math,Number,String,Array,Promise,TextEncoder,Uint8Array,encodeURIComponent,decodeURIComponent,crypto:webcrypto,console:{log}});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),context);
 vm.runInContext(scoped('src/canonical-repository.js','CanonicalRepository'),context);
 vm.runInContext('globalThis.repository={CanonicalRepository};',context);
 return {...context.repository,d1EnrichmentAdapter:d1Adapter};
}
