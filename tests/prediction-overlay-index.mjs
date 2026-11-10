// AIR-417. overlayIndex reads the D1 prediction rows in keyset pages. Its cost follows the rows, not the number of view-index keys,
// so a view index above 5000 keys (the production state: 8704 films) is served, with a bounded number of queries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {activatePredictionDomain,importPredictionDomain,overlayIndex,PREDICTION_OVERLAY_PAGE,PREDICTION_OVERLAY_ROWS} from '../src/prediction-d1.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prediction-overlay-'));
let databases=0;
const migrated=()=>{
 const db=d1Standin(path.join(root,'overlay-'+(databases++)+'.sqlite'));
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";
const id=n=>'tmdb_'+(1000000+n*7);
const features=n=>({fingerprintHash:'fp-'+n,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,invalidatedAt:null,plotMechanics:['heist'],moodLabels:['tense','dark'],execution:{pace:'fast'}});
const display=n=>({predictedRating:3.5+(n%3)/2,generatedAt:'2026-11-0'+(1+n%8)+'T10:00:00.000Z',confidence:'medium'});
function fill(db,{fingerprints,pointers,from=0}){
 // film_id is the primary key; the rows are inserted in id-string order the way the table keeps them.
 const insert=(table,columns,rows)=>{for(let s=0;s<rows.length;s+=400)db.sql('INSERT INTO '+table+' ('+columns+') VALUES '+rows.slice(s,s+400).join(',')+';');};
 insert('prediction_fingerprint','film_id,fingerprint_hash,schema_version,prompt_version,r2_key,content_sha256,features_json',Array.from({length:fingerprints},(_,k)=>{const n=from+k;return '('+[q(id(n)),q('fp-'+n),1,1,q('enrichment/fp/'+n),q('sha'+n),q(JSON.stringify(features(n)))].join(',')+')';}));
 insert('prediction_pointer','film_id,r2_key,content_sha256,updated_at,display_json',Array.from({length:pointers},(_,k)=>{const n=from+k;return '('+[q(id(n)),q('enrichment/pr/'+n),q('sha'+n),q('2026-11-01T00:00:00.000Z'),q(JSON.stringify(display(n)))].join(',')+')';}));
}
const start=async()=>{
 const db=migrated(),bucket=new MemoryBucket();
 await importPredictionDomain(db,bucket,{queue:{schemaVersion:3,pending:[]}});
 await activatePredictionDomain(db,{generation:0,queueGeneration:0,profileGeneration:0});
 return {db,env:{DB:db,BUCKET:bucket}};
};
const moodFacet=(fingerprint,prediction)=>({m:fingerprint?.moodLabels?.length||0,p:!!prediction});
// Independent oracle: one film at a time, with the transformation written out again.
const expectedItem=(db,filmId,base)=>{
 const item={...base};for(const key of ['prediction','fingerprint','fingerprintHash','impactFeatures','moodFacet'])delete item[key];
 const f=db.sql('SELECT features_json AS j FROM prediction_fingerprint WHERE film_id='+q(filmId))[0],p=db.sql('SELECT display_json AS j FROM prediction_pointer WHERE film_id='+q(filmId))[0];
 if(f){const x=JSON.parse(f.j);item.fingerprintHash=x.fingerprintHash;item.fingerprint={plotMechanics:x.plotMechanics,moodLabels:x.moodLabels,execution:x.execution,fingerprintHash:x.fingerprintHash};item.impactFeatures={fingerprintHash:x.fingerprintHash,fingerprintSchemaVersion:x.fingerprintSchemaVersion??null,fingerprintPromptVersion:x.fingerprintPromptVersion??null,invalidatedAt:x.invalidatedAt||null,plotMechanics:x.plotMechanics,execution:x.execution};}
 if(p)item.prediction=JSON.parse(p.j);
 if(item.fingerprint||item.prediction)item.moodFacet=moodFacet(item.fingerprint,item.prediction);
 return item;
};

// 1. Parity with the per-film oracle on an index the old cap allowed, including keys without rows, rows without a key and stale index fields.
{
 const {db,env}=await start();
 fill(db,{fingerprints:620,pointers:600});          // rows for film 0..619; pointers for 0..599
 fill(db,{fingerprints:30,pointers:30,from:9000});  // rows of films that are not in the index
 const index={};
 for(let n=0;n<900;n++)index[id(n)]={watched:n%7===0,actualRating:n%5===0?4:undefined,prediction:{stale:true},fingerprint:{stale:true},moodFacet:'stale'};
 const out=await overlayIndex(env,index,moodFacet);
 assert.deepEqual(Object.keys(out),Object.keys(index));
 for(const filmId of Object.keys(index))assert.deepEqual(out[filmId],expectedItem(db,filmId,index[filmId]),filmId);
 assert.equal(out[id(0)].fingerprint.moodLabels.length,2);
 assert.equal(out[id(800)].fingerprint,undefined,'a key without a row loses the stale fields and gets none');
 assert.ok(!Object.hasOwn(out,id(9000)),'a row of a film outside the index adds nothing');
 assert.equal(index[id(0)].prediction.stale,true,'the input is not modified');
}

// 2. The production shape: 8704 index keys (above the old 5000 cap), 3254 fingerprints and 3255 pointers. Served, with few queries.
{
 const {db,env}=await start();
 fill(db,{fingerprints:3254,pointers:3255});
 const index={};for(let n=0;n<8704;n++)index[id(n)]={watched:false};
 const before=db.calls.queries,t0=performance.now();
 const out=await overlayIndex(env,index,moodFacet);
 const ms=performance.now()-t0,queries=db.calls.queries-before;
 const pages=Math.ceil(3255/PREDICTION_OVERLAY_PAGE)+Math.ceil(3254/PREDICTION_OVERLAY_PAGE);
 console.log('overlay: index keys',Object.keys(index).length,'fingerprint rows 3254 pointer rows 3255 queries',queries,'(old path:',2*Math.ceil(8704/80),') wall ms',ms.toFixed(0));
 assert.equal(Object.keys(out).length,8704);
 assert.ok(queries<=pages+6,'queries '+queries+' exceed '+(pages+6)+' (the pages plus the authority marker reads)');
 assert.ok(queries<2*Math.ceil(8704/80)/5,'far fewer queries than one per 80 index keys');
 let withPrediction=0;for(const item of Object.values(out))if(item.prediction)withPrediction++;
 assert.equal(withPrediction,3255);
 for(const n of [0,1,1626,3253,3254,3255,8703])assert.deepEqual(out[id(n)],expectedItem(db,id(n),index[id(n)]),'film '+n);
}

// 3. Exactly one page, a page boundary, and an empty table.
for(const [fingerprints,pointers] of [[0,0],[PREDICTION_OVERLAY_PAGE-1,PREDICTION_OVERLAY_PAGE],[PREDICTION_OVERLAY_PAGE,PREDICTION_OVERLAY_PAGE+1],[2*PREDICTION_OVERLAY_PAGE,2*PREDICTION_OVERLAY_PAGE]]){
 const {db,env}=await start();fill(db,{fingerprints,pointers});
 const index={};for(let n=0;n<fingerprints+pointers+5;n++)index[id(n)]={};
 const out=await overlayIndex(env,index,moodFacet);
 for(const filmId of Object.keys(index))assert.deepEqual(out[filmId],expectedItem(db,filmId,index[filmId]),fingerprints+'/'+pointers+' '+filmId);
}

// 4. The bound is the number of rows: a table beyond it is refused with a named guard and nothing is returned.
{
 const {db,env}=await start();
 fill(db,{fingerprints:PREDICTION_OVERLAY_ROWS+1,pointers:3});
 const logged=[];const warn=console.warn;console.warn=line=>logged.push(String(line));
 try{await assert.rejects(overlayIndex(env,{[id(0)]:{}},moodFacet),error=>error.code==='prediction_domain_budget'&&error.guard==='overlay_rows');}finally{console.warn=warn;}
 assert.ok(logged.some(line=>line==='{"event":"prediction_domain_budget","guard":"overlay_rows"}'));
 // Exactly at the bound is still served.
 const exact=await start();fill(exact.db,{fingerprints:PREDICTION_OVERLAY_ROWS,pointers:0});
 const out=await overlayIndex(exact.env,{[id(0)]:{}},moodFacet);
 assert.equal(out[id(0)].fingerprintHash,'fp-0');
}

// 5. A damaged row of an indexed film fails closed; a damaged row of a film outside the index is not read into the result.
{
 const {db,env}=await start();fill(db,{fingerprints:5,pointers:5});
 db.sql("UPDATE prediction_fingerprint SET features_json='{broken' WHERE film_id="+q(id(2)));
 await assert.rejects(overlayIndex(env,{[id(2)]:{}},moodFacet),error=>error.code==='prediction_domain_unavailable');
 const out=await overlayIndex(env,{[id(0)]:{}},moodFacet);
 assert.equal(out[id(0)].fingerprintHash,'fp-0');
}

// 6. Outside d1 mode the index is returned as it came.
{
 const db=migrated(),bucket=new MemoryBucket();
 const index={[id(1)]:{a:1}};
 assert.equal(await overlayIndex({DB:db,BUCKET:bucket},index,moodFacet),index);
}

console.log('prediction overlay index tests passed');
