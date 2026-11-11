// AIR-374 P4b: mutation check of the marker gate and the bundled D1 title helper behind GET /api/programme and GET /api/watchlist (src/canonical-catalog-reader.js, tests by
// tests/canonical-catalog-titles.mjs; the route branches in src/worker.js). Each mutant is a copy of ONE file with ONE guard removed or inverted; the test, pointed at the mutant through an
// environment variable, must FAIL. A surviving mutant is a guard no test depends on; a mutant that does not load is BROKEN and fails this check. Mutants live outside the repository tree.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const READER=[
 ['the helper needs an open gate',"if(gate?.mode!=='d1')throw failed('canonical_read_not_authoritative');",''],
 ['the film count is capped',"if(byId.size>TITLE_READ_MAX_FILMS)throw failed('canonical_read_unavailable');",''],
 ['the tmdb spelling of an id is asked for',"if(tmdb!==own&&!wanted.has(tmdb))wanted.set(tmdb,id);","void tmdb;"],
 ['the id own spelling wins',"(out[id]&&row.film_id!=='film:'+id)","false"],
 ['only the localization dimension',"WHERE d.dimension='localization' AND d.status","WHERE d.status"],
 ['only provisional rows',"AND d.status='provisional'","AND d.status IN ('provisional','reviewed')"],
 ['the tmdb claim is trusted',"AND e.trusted=1 AND e.conflicting=0 ORDER","AND e.conflicting=0 ORDER"],
 ['the tmdb claim is not conflicting',"AND e.trusted=1 AND e.conflicting=0 ORDER","AND e.trusted=1 ORDER"],
 ['the tmdb id is typed like the document',"typeof byId.get(id).tmdbId==='number'?Number(row.tmdb):String(row.tmdb)","String(row.tmdb)"],
 ['the marker is re-read after the read',"await catalogReaderStill(env,gate);\n return out;","return out;"],
 ['the re-read compares the generation',"||again.generation!==gate.generation)throw failed('film_person_generation_moved');\n}\n\n// films:","){throw failed('film_person_generation_moved');}\n}\n\n// films:"],
 ['a failing read is typed and closed',"catch(error){throw failed('canonical_read_unavailable',error);}\n","catch(error){throw error;}\n"],
 ['an unreadable provenance is closed',"catch{throw failed('canonical_read_unavailable');}\n   const tmdb","catch{}\n   const tmdb"],
];
const WORKER=[
 ['/api/programme reads the marker first',"const gate=await titleReadGate(env);\n    const pinned=await pinEpg(env);\n    const data=","const gate=null;\n    const pinned=await pinEpg(env);\n    const data="],
 ['/api/watchlist reads the marker first',"const gate=await titleReadGate(env);\n    const pinned=await pinEpg(env);\n    let data=","const gate=null;\n    const pinned=await pinEpg(env);\n    let data="],
 ['open reads D1, not the frozen mirror',"if(gate.mode==='d1')return CanonicalCatalogReader.catalogTitlesFromD1(env,films,gate);",""],
 ['the R2 answer is re-checked against the marker',"await CanonicalCatalogReader.catalogReaderStill(env,gate);\n return titles;","return titles;"],
 ['the programme route asks for every film of both documents',"[...(data?.films||[]),...(watchlist?.films||[])]","[...(data?.films||[])]"],
 ['the watchlist route asks for its films',"localizedTitleStore(env,pinned,gate,data?.films||[])","localizedTitleStore(env,pinned,gate,[])"],
 ['a refusal is a 503',"TITLE_READ_REFUSALS.includes(error?.code)?json(","false?json("],
 ['held is refused',"const TITLE_READ_REFUSALS=['film_person_held',","const TITLE_READ_REFUSALS=["],
 ['an unreadable marker is refused',"'film_person_held','film_person_unavailable','film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'];\nconst titleReadGate","'film_person_held','film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'];\nconst titleReadGate"],
 ['a moved marker is refused',"'film_person_unavailable','film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'];\nconst titleReadGate","'film_person_unavailable','canonical_read_unavailable','canonical_read_not_authoritative'];\nconst titleReadGate"],
 ['a failed D1 title read is refused',"'film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'];\nconst titleReadGate","'film_person_generation_moved','canonical_read_not_authoritative'];\nconst titleReadGate"],
 ['the programme route maps the refusal',"const refused=titleReadRefusal(error);if(refused)return refused;throw error;}\n  }\n  if(url.pathname==='/api/watchlist'","throw error;}\n  }\n  if(url.pathname==='/api/watchlist'"],
 ['the watchlist route maps the refusal',"const refused=titleReadRefusal(error);if(refused)return refused;throw error;}\n  }\n  if(url.pathname==='/api/catalog/available'","throw error;}\n  }\n  if(url.pathname==='/api/catalog/available'"],
];
const TARGETS=[
 {source:'src/canonical-catalog-reader.js',variable:'CATALOG_TITLES_READER_FILE',mutants:READER},
 {source:'src/worker.js',variable:'CATALOG_TITLES_WORKER_FILE',mutants:WORKER},
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canonical-titles-mutants-'));
assert.ok(path.relative(process.cwd(),dir).startsWith('..'),'the mutants are written outside the repository tree');
const run=(variable,value)=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/canonical-catalog-titles.mjs'],{env:{...process.env,[variable]:value,CATALOG_TITLES_ONLY:'mutant',CANONICAL_CATALOG_BASE_DIR:dir},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 child.on('close',code=>resolve({code,broken:/SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export|ReferenceError/.test(err)?err.slice(0,300):null}));
});
try{
 const queue=[];
 for(const target of TARGETS){
  const original=fs.readFileSync(target.source,'utf8');
  for(const [name,from] of target.mutants)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+target.source);
  const base=path.basename(target.source,'.js'),put=(suffix,text)=>{const file=path.join(dir,base+'.'+suffix+'.js');fs.writeFileSync(file,text);return file;};
  queue.push({name:'control '+target.source,target,value:put('control',original),control:true});
  target.mutants.forEach(([name,from,to],index)=>queue.push({name,target,value:put('mutant'+index,original.replace(from,()=>to))}));
 }
 // The controls run first, one after the other: the first replays the migration chain into the shared fixture directory, every mutant then copies it.
 for(const item of queue.filter(entry=>entry.control)){const out=await run(item.target.variable,item.value);assert.equal(out.code,0,'the unmutated copy must pass: '+item.name+' '+(out.broken||''));}
 const work=queue.filter(entry=>!entry.control),survivors=[],broken=[];let killed=0;
 await Promise.all(Array.from({length:Math.max(2,Math.min(8,os.availableParallelism()))},async()=>{
  while(work.length){const item=work.shift(),out=await run(item.target.variable,item.value);if(out.broken)broken.push(item.name+': '+out.broken);else if(out.code===0)survivors.push(item.name);else killed++;}
 }));
 assert.deepEqual(broken,[],'broken mutants prove nothing');
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 assert.equal(killed,READER.length+WORKER.length);
 console.log('canonical-catalog-titles-mutation: ok ('+READER.length+' reader and '+WORKER.length+' worker mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
assert.ok(!fs.existsSync(dir));
