// ADR 0183: the D1-derived view index input of the operator tools (scripts/view-index-d1-export.mjs and --view-index-d1). SQLite D1 stand-in, no network, no production.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import * as PredictionD1 from '../src/prediction-d1.js';
import * as RatingsD1 from '../src/ratings-d1.js';
import {buildIndex} from '../src/letterboxd-match.js';
import {VIEW_INDEX_D1_SCHEMA,ExportError,deriveViewIndex,exportViewIndex,restQuery,writeExport,main} from '../scripts/view-index-d1-export.mjs';
import {loadCatalogDir,loadViewIndexInput,withViewIndexInput,ReconcileError} from '../scripts/letterboxd-reconcile.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-view-index-export-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";
let databases=0;
const features=hash=>({fingerprintHash:hash,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,invalidatedAt:null,plotMechanics:['a'],moodLabels:['b'],execution:{}});
function world(){
 const file=path.join(root,'e'+(databases++)+'.sqlite');
 const seen=[];
 const db=d1Standin(file,{onQuery:async text=>{seen.push(text);}});
 for(const name of names)db.sql(fs.readFileSync('migrations/'+name,'utf8'));
 db.sql("UPDATE prediction_domain_authority SET mode='d1' WHERE id=1;UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;");
 const pointers=['tmdb_101','tmdb_102','tmdb_103','Q7p1'],fingerprints=['tmdb_101','tmdb_102','tmdb_104'];
 db.sql('INSERT INTO prediction_pointer (film_id,r2_key,content_sha256,updated_at,display_json) VALUES '+pointers.map(id=>'('+[q(id),q('pv/'+id),q('s'+id),q('2026-11-01T00:00:00.000Z'),q('{"predictedRating":3.5}')].join(',')+')').join(',')+';');
 db.sql('INSERT INTO prediction_fingerprint (film_id,fingerprint_hash,schema_version,prompt_version,r2_key,content_sha256,features_json) VALUES '+fingerprints.map((id,n)=>'('+[q(id),q('fp-'+n),1,1,q('fpb/'+id),q('s'+id),q(JSON.stringify(features('fp-'+n)))].join(',')+')').join(',')+';');
 const ratings=[['tmdb_101',1,4,null,1],['Q7a1',1,4.5,null,1],['tmdb_105',1,null,null,1],['tmdb_106',null,null,1,0],['Q7w9',null,null,1,0]];
 db.sql('INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES '+ratings.map(([id,watched,rating,watchlist,known])=>'('+[q(id),q('f-'+id),watched??'NULL',rating??'NULL',watchlist??'NULL',known,q('2026-11-01T00:00:00.000Z')].join(',')+')').join(',')+';');
 const query=async(sql,params=[])=>(await db.prepare(sql).bind(...params).all()).results;
 return {db,query,seen,file};
}
const sha=text=>createHash('sha256').update(text).digest('hex');
const fixedNow=()=>new Date('2026-11-20T15:00:00.000Z');

// ---- 1. The pure derivation, and the document.
{
 const {query,db}=world();
 const doc=await exportViewIndex({query,databaseId:'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',now:fixedNow});
 assert.equal(doc.schema,VIEW_INDEX_D1_SCHEMA);assert.equal(doc.source,'d1_derived');assert.equal(doc.readAt,'2026-11-20T15:00:00.000Z');
 assert.deepEqual(doc.counts,{pointer:4,fingerprint:3,ratings:5,keys:Object.keys(doc.index).length});
 assert.deepEqual(Object.keys(doc.index),[...Object.keys(doc.index)].sort(),'keys are sorted, so the file is reproducible');
 assert.deepEqual(Object.keys(doc.index),['Q7a1','Q7p1','Q7w9','tmdb_101','tmdb_102','tmdb_103','tmdb_104','tmdb_105','tmdb_106'],'the union of the three tables, spelled exactly as stored');
 assert.deepEqual(doc.index.tmdb_101,{watched:true,actualRating:4});
 assert.deepEqual(doc.index.Q7a1,{watched:true,actualRating:4.5});
 assert.ok(Object.hasOwn(doc.index.tmdb_105,'actualRating')&&doc.index.tmdb_105.actualRating===null,'an explicit null rating is an own null');
 assert.deepEqual(doc.index.tmdb_106,{watchlist:true},'an unknown rating stays absent');
 assert.deepEqual(doc.index.tmdb_103,{},'a prediction-only key is an empty entry');
 assert.deepEqual(doc.markers.before,doc.markers.after);assert.equal(doc.markers.before.schema>=28,true);assert.equal(doc.markers.before.prediction.mode,'d1');assert.equal(doc.markers.before.ratings.cutover,'open');
 assert.equal(JSON.stringify(doc).includes('predictedRating'),false,'no prediction payload leaves D1');

 // Parity with the Worker's own derived view: the same key set, and the same watched, rating and watchlist facts per key.
 const env={DB:db,BUCKET:{},PREDICTION_DB_REQUIRED:'on',RATINGS_DB_REQUIRED:'on'};
 const worker=await RatingsD1.overlayView(env,await PredictionD1.derivedIndex(env,null));
 assert.deepEqual(Object.keys(doc.index).sort(),Object.keys(worker).sort(),'the export has exactly the key set the Worker derives');
 for(const id of Object.keys(worker))for(const field of ['watched','actualRating','watchlist']){
  assert.equal(Object.hasOwn(doc.index[id],field),Object.hasOwn(worker[id],field),id+'.'+field+' presence');
  assert.equal(doc.index[id][field],worker[id][field],id+'.'+field+' value');
 }
 // deriveViewIndex alone is the same rule.
 assert.deepEqual(deriveViewIndex({pointerIds:['b','a'],fingerprintIds:['a'],ratingsRows:[{alias_id:'c',watched:0,rating_known:0,actual_rating:null,watchlist:null}]}),{a:{},b:{},c:{watched:false}});
}

// ---- 2. Fail closed: nothing is returned for a state that is not the production authorities, and a moved marker is inconclusive.
{
 const held=world();held.db.sql("UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 await assert.rejects(exportViewIndex({query:held.query}),error=>error instanceof ExportError&&error.exitCode===3&&/ratings domain is not d1 and open/.test(error.message));
 const notD1=world();notD1.db.sql("UPDATE prediction_domain_authority SET mode='r2' WHERE id=1");
 await assert.rejects(exportViewIndex({query:notD1.query}),error=>error instanceof ExportError&&error.exitCode===3&&/prediction domain is not d1/.test(error.message));
 // A commit during the read moves a generation: the cut is inconclusive and is not retried.
 const moving=world();let reads=0;
 const query=async(sql,params)=>{const rows=await moving.query(sql,params);if(/FROM ratings_view/.test(sql)&&reads++===0)moving.db.sql('UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1');return rows;};
 await assert.rejects(exportViewIndex({query}),error=>error instanceof ExportError&&error.exitCode===3&&/inconclusive/.test(error.message));
 assert.equal(reads,1,'one pass, no retry');
 // Only a single SELECT is ever sent.
 const sent=[];const spy=world();
 await exportViewIndex({query:async(sql,params)=>{sent.push(sql);return spy.query(sql,params);}});
 assert.ok(sent.length>0&&sent.every(sql=>/^\s*SELECT\b/i.test(sql)&&!/;\s*\S/.test(sql)),'every statement is a single SELECT');
 // A table above the cap refuses.
 const big=world();
 big.db.sql('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<20001) INSERT INTO prediction_pointer (film_id,r2_key,content_sha256,updated_at,display_json) SELECT \'tmdb_\'||(5000000+x),\'pv/\'||x,\'s\'||x,\'2026-11-01T00:00:00.000Z\',\'{}\' FROM c;');
 await assert.rejects(exportViewIndex({query:big.query}),error=>error instanceof ExportError&&/row cap/.test(error.message));
}

// ---- 3. The REST layer: a single SELECT, and an answer that reports a write stops the run; the credential is never echoed.
{
 const calls=[];
 const fakeFetch=async(url,init)=>{calls.push({url:String(url),method:init.method,body:JSON.parse(init.body)});return new Response(JSON.stringify({success:true,result:[{results:[],meta:{changed_db:true,rows_written:1}}]}),{status:200});};
 const query=restQuery({accountId:'a'.repeat(32),apiToken:'SECRET-TOKEN',databaseId:'d'.repeat(8)+'-0000-0000-0000-'+'e'.repeat(12),fetchImpl:fakeFetch});
 await assert.rejects(query('SELECT 1'),error=>error instanceof ExportError&&!String(error.message).includes('SECRET-TOKEN')&&/reported a write/.test(error.message));
 assert.equal(calls.length,1);assert.equal(calls[0].method,'POST');assert.ok(calls[0].url.endsWith('/query'));
}

// ---- 4. Writing the file: absolute, outside the repository, never overwritten, private.
{
 const {query}=world();
 const doc=await exportViewIndex({query,now:fixedNow});
 await assert.rejects(writeExport(doc,'relative.json'),/absolute/);
 await assert.rejects(writeExport(doc,path.resolve('tmp-inside-repository.json')),/outside the repository/);
 const target=path.join(root,'out','view-index.d1.json');
 const written=await writeExport(doc,target);
 assert.equal(written.file,target);assert.equal(fs.statSync(target).mode&0o777,0o600);
 assert.equal(written.sha256,sha(fs.readFileSync(target,'utf8')));
 await assert.rejects(writeExport(doc,target),/never overwritten/);
}

// ---- 5. The CLI: credentials from the environment, an id-free summary, exit codes.
{
 const w=world();
 const errors=[];const logs=[];const realLog=console.log,realError=console.error;console.log=(...a)=>logs.push(a.join(' '));console.error=(...a)=>errors.push(a.join(' '));
 const saved=process.exitCode;
 try{
  const restFetch=async(url,init)=>{const {sql,params}=JSON.parse(init.body);const results=await w.query(sql,params);return new Response(JSON.stringify({success:true,result:[{results,meta:{changed_db:false,rows_written:0}}]}),{status:200});};
  const env={D1_BACKFILL_ACCOUNT_ID:'a'.repeat(32),D1_BACKFILL_API_TOKEN:'SECRET-TOKEN',D1_BACKFILL_DATABASE_ID:'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb'};
  const target=path.join(root,'cli','view-index.d1.json');
  const summary=await main(['--output',target],{env,fetchImpl:restFetch,now:fixedNow});
  assert.equal(summary.counts.keys,9);assert.equal(fs.existsSync(target),true);
  const printed=logs.join('\n');
  for(const secret of ['SECRET-TOKEN','tmdb_101','Q7a1','predictedRating'])assert.equal(printed.includes(secret),false,'the summary prints no '+secret);
  assert.equal(JSON.parse(logs[0]).sha256,sha(fs.readFileSync(target,'utf8')));
  // Missing credentials, a bad invocation and an existing output each fail with a code and no write.
  process.exitCode=0;await main(['--output',path.join(root,'cli','second.json')],{env:{},fetchImpl:restFetch});assert.equal(process.exitCode,2);assert.equal(fs.existsSync(path.join(root,'cli','second.json')),false);
  process.exitCode=0;await main([],{env,fetchImpl:restFetch});assert.equal(process.exitCode,2);
  process.exitCode=0;await main(['--output',target],{env,fetchImpl:restFetch});assert.equal(process.exitCode,2);assert.ok(errors.some(text=>/never overwritten/.test(text)));
  assert.equal(errors.join('\n').includes('SECRET-TOKEN'),false);
 }finally{console.log=realLog;console.error=realError;process.exitCode=saved;}
}

// ---- 6. The operator tools: --view-index-d1 replaces the raw object, bound by digest, validated, never merged.
{
 const {query}=world();
 const doc=await exportViewIndex({query,databaseId:'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',now:fixedNow});
 const dir=path.join(root,'catalog');fs.mkdirSync(dir,{recursive:true});
 const write=(name,value)=>fs.writeFileSync(path.join(dir,name),JSON.stringify(value));
 write('provenance.json',{source:'live_catalog_read',readAt:'2026-11-20T14:00:00.000Z'});
 write('catalog.json',{tmdb_101:{id:'tmdb_101',tmdbId:'101',canonicalIdentity:'tmdb:101',title:'A',original:'A',year:2001}});
 write('links.json',{});
 write('view-index.json',{Q7a1:{actualRating:1},stale_raw_only:{actualRating:5}});
 const file=path.join(root,'view-index.d1.json');fs.writeFileSync(file,JSON.stringify(doc)+'\n');
 // AIR-558: without the option the call is refused (ReconcileError, exit 2): the raw object is never the input any more.
 await assert.rejects(loadCatalogDir(dir),error=>error instanceof ReconcileError&&error.exitCode===2&&/--view-index-d1/.test(error.message));
 const loaded=await loadCatalogDir(dir,{viewIndexFile:file});
 assert.deepEqual(loaded.objects.viewIndex,doc.index,'the D1 export replaces the raw object entirely: nothing is merged');
 assert.equal(Object.hasOwn(loaded.objects.viewIndex,'stale_raw_only'),false);
 assert.equal(loaded.baselineIdentity.viewIndex.source,'d1_derived');
 assert.equal(loaded.baselineIdentity.viewIndex.sha256,sha(fs.readFileSync(file,'utf8')),'the plan identity carries the input digest');
 assert.equal(loaded.baselineIdentity.viewIndex.keys,9);assert.equal(loaded.baselineIdentity.catalogFilms,1,'the rest of the identity is kept');
 // The tools' own consumer: lid keys become view_index targets and the rating evidence survives, exactly as from a raw object of the same content.
 const fromD1=buildIndex(loaded.objects),fromRaw=buildIndex({...loaded.objects,viewIndex:JSON.parse(JSON.stringify(doc.index))});
 assert.deepEqual(fromD1.summary,fromRaw.summary);
 assert.ok(fromD1.summary.lidsBySource.view_index>=1,'lid-shaped keys are registered as view_index targets');
 const target=fromD1.targets.get('lid:Q7a1');
 assert.ok(target&&target.sources.has('view_index')&&target.ratings.has(4.5),'the rating of a lid alias is preserved as evidence under its own spelling');
 assert.equal(fromD1.targets.has('lid:Q7p1'),true,'a prediction-only lid key is still a view_index target, as from the raw object');
 // Validation: every defect is refused, never half-read.
 const bad=async(value,pattern)=>{const f=path.join(root,'bad-'+databases++ +'.json');fs.writeFileSync(f,typeof value==='string'?value:JSON.stringify(value));await assert.rejects(loadViewIndexInput(f),error=>error instanceof ReconcileError&&pattern.test(error.message));};
 await bad('not json',/not JSON/);
 await bad({...doc,schema:'other'},/not a view-index-d1-export@1 export/);
 await bad({...doc,source:'r2'},/not a view-index-d1-export@1 export/);
 await bad({...doc,index:[]},/object of entry objects/);
 await bad({...doc,index:{a:'x'}},/object of entry objects/);
 await bad({...doc,counts:{...doc.counts,keys:1}},/key count does not match/);
 await assert.rejects(loadViewIndexInput(path.join(root,'absent.json')),/could not be read/);
 // withViewIndexInput drops the missing-key note of the raw object.
 const merged=withViewIndexInput({objects:{},missing:['view-index.json','metadata.json'],baselineIdentity:null},await loadViewIndexInput(file));
 assert.deepEqual(merged.missing,['metadata.json']);
}

fs.rmSync(root,{recursive:true,force:true});
console.log('View index D1 export: derived key set equals the Worker view, fail-closed cuts, read-only REST, private output, and the operator tools take it in place of the raw object passed');
