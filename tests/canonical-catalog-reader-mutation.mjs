// AIR-374 P4: mutation check of the marker-gate logic of the fail-closed Film/Person readers: src/canonical-catalog-reader.js (the gate and the D1 admission fallback),
// the /api/d1/* gate in src/catalog-d1.js (both tested by tests/canonical-catalog-reader.mjs) and the marker branch of catalogArchiveFallback in src/worker.js (tested by
// tests/catalog-film.mjs). Each mutant is a copy of ONE file with ONE guard removed or inverted; the file's test, pointed at the mutant through an environment variable, must FAIL.
// A surviving mutant is a guard no test depends on; a mutant that does not load is BROKEN and fails this check. Mutants are written outside the repository tree and removed afterwards.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const FIND="return {state:'found',film:";
const READER=[
 ['gate names d1 only for an open source',"mode:source==='d1'?'d1':'existing'","mode:'existing'"],
 ['gate consults readSource (held/unknown refuse)',"const source=readSource(gate);\n return {mode","const source=gate.state==='open'?'d1':'r2';\n return {mode"],
 ['readAdmissions needs the d1 source',"if(readSource(await readAuthority(env))!=='d1')throw failed('admission_not_authoritative');",''],
 ['fallback needs an open marker',"if(gate.state!=='open'){readSource(gate);throw failed('canonical_read_not_authoritative');}",''],
 ['held refusal carries its own code',"{readSource(gate);throw failed('canonical_read_not_authoritative');}","{throw failed('canonical_read_not_authoritative');}"],
 ['typed movie id only',"if(typeof tmdbId!=='string'||!MOVIE_ID.test(tmdbId))throw failed('canonical_read_invalid');",''],
 ['retirement ledger decides',"if(retired)result={state:'retired'};","if(false)result={state:'retired'};"],
 ['a restore lifts a retire',"AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq)",''],
 ['only retire decisions retire',"r.movie_id=? AND r.kind='retire' AND NOT","r.movie_id=? AND NOT"],
 ['a foreign claim holds the identity',"if(rows.some(row=>!(isOwn(row)&&row.film_id===owner)))result={state:'conflict'};","if(false)result={state:'conflict'};"],
 ['a trusted claim is the owner',"Number(row.trusted)===1&&Number(row.conflicting)===0","Number(row.conflicting)===0"],
 ['a non-conflicting claim is the owner',"Number(row.trusted)===1&&Number(row.conflicting)===0","Number(row.trusted)===1"],
 ['a redirect source is retired',"else if(await one(db,'SELECT 1 AS hit FROM film_redirect WHERE from_id=? LIMIT 1',[owner]))result={state:'retired'};",''],
 ['no admission row, no Film',"if(!admission)result={state:'absent'};","if(!admission)result={state:'found',film:{id:'tmdb_'+tmdbId,tmdbId,canonicalIdentity:'tmdb:'+tmdbId,title:null,original:null,year:null,runtime:null,genres:[],url:null,directors:[],actors:[],shows:[]}};"],
 ['the admission names the typed id',"else if(String(admission.tmdb)!==tmdbId)throw failed('canonical_read_unavailable');",''],
 ['the marker is re-read after the reads',"if(again.state!=='open'||again.generation!==gate.generation)throw failed('film_person_generation_moved');",''],
 ['the generation is compared',"||again.generation!==gate.generation)",")"],
 ['a typed read error keeps its code',"if(error?.code)throw error;",''],
 ['an untyped read error fails closed',"throw failed('canonical_read_unavailable',error);\n }\n const again","throw error;\n }\n const again"],
];
const CATALOG_D1=[
 ['only GET is gated, and GET is gated',"if(request.method==='GET'){","if(false){"],
 ['authoritative only for d1',".mode==='d1';",".mode==='d1'||true;"],
 ['authoritative is not constant false',"authoritative=(await CanonicalCatalogReader.catalogReaderGate(env)).mode==='d1';","authoritative=(await CanonicalCatalogReader.catalogReaderGate(env)).mode==='never';"],
 ['held is a 503',"if(code==='film_person_held'||code==='film_person_unavailable')return json({error:'storage_unavailable',reason:code},503);","if(code==='film_person_held')return json({error:'storage_unavailable',reason:code},503);"],
 ['unknown is a 503',"if(code==='film_person_held'||code==='film_person_unavailable')return json({error:'storage_unavailable',reason:code},503);","if(code==='film_person_unavailable')return json({error:'storage_unavailable',reason:code},503);"],
 ['status carries the flag',"json(await d1Status(env.DB,env,authoritative))","json(await d1Status(env.DB,env))"],
 ['identity carries the flag',"d1PersonIdentity(env.DB,'person:'+key,authoritative)","d1PersonIdentity(env.DB,'person:'+key)"],
 ['bounded identity carries the flag',"limitations,true,authoritative)","limitations,true)"],
 ['unbounded identity carries the flag',"limitations,false,authoritative)","limitations,false)"],
 ['the gate runs before any read',"const response=await catalogD1Dispatch(request,env,url,authoritative);","const response=await catalogD1Dispatch(request,env,url,false);"],
];
const WORKER=[
 ['open reads D1, not R2',"if(gate.state==='open')return CanonicalCatalogReader.catalogAdmittedFilmFromD1(env,tmdbId);",''],
 ['held and unknown never reach R2',"if(!gate.r2Allowed){const error","if(false){const error"],
 ['the new refusal codes are a 503',"'film_person_generation_moved','canonical_read_unavailable','admission_unavailable','canonical_read_not_authoritative']","]"],
];
const TARGETS=[
 {source:'src/canonical-catalog-reader.js',test:'tests/canonical-catalog-reader.mjs',variable:'CANONICAL_CATALOG_READER_MODULE',url:true,mutants:READER},
 {source:'src/catalog-d1.js',test:'tests/canonical-catalog-reader.mjs',variable:'CATALOG_D1_MODULE',url:true,mutants:CATALOG_D1},
 {source:'src/worker.js',test:'tests/catalog-film.mjs',variable:'CATALOG_WORKER_FILE',url:false,mutants:WORKER},
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canonical-catalog-mutants-'));
assert.ok(path.relative(process.cwd(),dir).startsWith('..'),'the mutants are written outside the repository tree');
const absolute=(text,from)=>text.replace(/(from\s*|import\()'(\.\.?\/[^']+)'/g,(_match,head,specifier)=>head+JSON.stringify(pathToFileURL(path.resolve(path.dirname(from),specifier)).href));
const run=(test,variable,value)=>new Promise(resolve=>{
 const child=spawn(process.execPath,[test],{env:{...process.env,[variable]:value},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 child.on('close',code=>resolve({code,broken:/SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export/.test(err)?err.slice(0,300):null}));
});
void FIND;
try{
 const queue=[];
 for(const target of TARGETS){
  const original=fs.readFileSync(target.source,'utf8');
  for(const [name,from] of target.mutants)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+target.source);
  const base=path.basename(target.source,path.extname(target.source));
  const put=(suffix,text)=>{const file=path.join(dir,base+'.'+suffix+'.mjs');fs.writeFileSync(file,absolute(text,target.source));return target.url?pathToFileURL(file).href:file;};
  queue.push({name:'control '+target.source,target,value:put('control',original),control:true});
  target.mutants.forEach(([name,from,to],index)=>queue.push({name,target,value:put('mutant'+index,original.replace(from,()=>to))}));
 }
 const survivors=[],broken=[];let killed=0;
 const workers=Array.from({length:Math.max(2,Math.min(8,os.availableParallelism()))},async()=>{
  while(queue.length){
   const item=queue.shift();
   const out=await run(item.target.test,item.target.variable,item.value);
   if(item.control){assert.equal(out.code,0,'the unmutated copy must pass: '+item.name+' '+(out.broken||''));continue;}
   if(out.broken)broken.push(item.name+': '+out.broken);else if(out.code===0)survivors.push(item.name);else killed++;
  }
 });
 await Promise.all(workers);
 assert.deepEqual(broken,[],'broken mutants prove nothing');
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 assert.equal(killed,READER.length+CATALOG_D1.length+WORKER.length);
 console.log('canonical-catalog-reader-mutation: ok ('+READER.length+' reader, '+CATALOG_D1.length+' /api/d1 gate and '+WORKER.length+' worker mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
assert.ok(!fs.existsSync(dir));
