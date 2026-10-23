import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createPredictionRepository} from '../src/prediction-repository.js';

const source=fs.readFileSync('src/prediction-repository.js','utf8');
assert.doesNotMatch(source,/d1_databases|\bBUCKET\b|\bfetch\b|\bwrangler\b|INSERT INTO film\s|INSERT INTO candidate|INSERT INTO score_result|INSERT INTO programme_generation|INSERT INTO film_dimension|INSERT INTO identity_assertion/);
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/prediction-repository/);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/prediction-repository/);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prediction-repo-'));
const database=path.join(root,'prediction.sqlite');
exec(database,'PRAGMA foreign_keys=ON;\n'+fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const db=openSqlite(database);
await db.run("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:zz-film',1,'Original Title','2026-10-19T01:00:00.000Z')");
const repo=createPredictionRepository(db);
const profile={version:1,profileHash:'profile-1',createdAt:'2026-10-19T01:00:00.000Z',r2Key:'r2/profile/1',contentSha256:'sha-profile-1'};
const fingerprint={filmId:'film:zz-film',schemaVersion:1,fingerprintHash:'print-1',generatedAt:'2026-10-19T02:00:00.000Z',invalidatedAt:null,r2Key:'r2/fingerprint/print-1',contentSha256:'sha-print-1'};
const rating={filmId:'film:zz-film',rating:4.5,source:'letterboxd',recordedAt:'2026-10-19T03:00:00.000Z'};
const predictionA={filmId:'film:zz-film',tasteProfileVersion:1,tasteProfileHash:'profile-1',fingerprintHash:'print-1',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:3.5,r2Key:'r2/prediction/a',contentSha256:'sha-prediction-a',updatedAt:'2026-10-20T01:00:00.000Z'};
const predictionB={...predictionA,tasteProfileVersion:2,tasteProfileHash:'profile-2',predictedRating:4,r2Key:'r2/prediction/b',contentSha256:'sha-prediction-b',updatedAt:'2026-10-21T01:00:00.000Z'};
const predictionC={...predictionB,predictedRating:4.5,r2Key:'r2/prediction/c',contentSha256:'sha-prediction-c',updatedAt:'2026-10-22T01:00:00.000Z'};

await repo.saveProfile(profile);
await repo.saveProfile(profile);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM profile_version'),1);
await assert.rejects(()=>repo.saveProfile({...profile,profileHash:'profile-other'}),/Profile version conflicts/);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM profile_version'),1);
const storedFingerprint=await repo.saveFingerprint(fingerprint);
await repo.saveFingerprint(fingerprint);
assert.equal(storedFingerprint.invalidatedAt,null);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM fingerprint_payload'),1);
await repo.saveActualRating(rating);
const first=await repo.savePrediction(predictionA);
assert.equal(first.history.length,0);
assert.equal(first.prediction.stale,false);
assert.equal(first.queue,null);
assert.equal(first.view.predictedRating,3.5);
assert.equal(first.view.actualRating,4.5);
assert.equal(first.actualRating.recordedAt,rating.recordedAt);

await assert.rejects(()=>repo.savePrediction(predictionB));
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM prediction_history'),0);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM prediction_current WHERE taste_profile_version=1"),1);
assert.equal((await repo.readFilm('film:zz-film')).actualRating.rating,4.5);
assert.equal((await repo.readFilm('film:zz-film')).fingerprint.invalidatedAt,null);

await repo.saveProfile({version:2,profileHash:'profile-2',createdAt:'2026-10-21T00:00:00.000Z',r2Key:'r2/profile/2',contentSha256:'sha-profile-2'});
const stale=await repo.readFilm('film:zz-film');
assert.equal(stale.fingerprint.invalidatedAt,null);
assert.equal(stale.fingerprint.fingerprintHash,'print-1');
assert.equal(stale.prediction.predictedRating,3.5);
assert.equal(stale.prediction.stale,true);
assert.equal(stale.view.stale,true);
assert.equal(stale.queue.requiredWork,'prediction_only');
assert.equal(stale.history.length,0);
assert.equal(stale.actualRating.rating,4.5);

const replaced=await repo.savePrediction(predictionB);
assert.equal(replaced.history.length,1);
assert.equal(replaced.history[0].replacedAt,predictionB.updatedAt);
assert.equal(replaced.history[0].payload.predictedRating,3.5);
assert.equal(replaced.history[0].r2Key,'r2/prediction/a');
assert.equal(replaced.prediction.predictedRating,4);
assert.equal(replaced.prediction.stale,false);
assert.equal(replaced.queue,null);
assert.equal(replaced.fingerprint.invalidatedAt,null);
assert.equal(replaced.actualRating.recordedAt,rating.recordedAt);
const repeated=await repo.savePrediction(predictionB);
assert.equal(JSON.stringify(repeated),JSON.stringify(replaced));
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM prediction_history'),1);
const next=await repo.savePrediction(predictionC);
assert.equal(next.history.length,2);
assert.equal(next.history[0].payload.predictedRating,3.5);
assert.equal(next.history[1].payload.predictedRating,4);
assert.equal(next.prediction.predictedRating,4.5);
assert.equal(next.actualRating.rating,4.5);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM fingerprint_payload'),1);

const reopened=createPredictionRepository(openSqlite(database));
assert.equal(JSON.stringify(await reopened.readFilm('film:zz-film')),JSON.stringify(next));
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film'),1);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM candidate'),0);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film_dimension'),0);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM identity_assertion'),0);

await db.run("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:zz-race',1,'Race Title','2026-10-19T01:00:00.000Z')");
const raceA={...predictionA,filmId:'film:zz-race'};
const raceB={...predictionB,filmId:'film:zz-race'};
const raceC={...predictionC,filmId:'film:zz-race'};
await repo.savePrediction(raceA);
db.beforeTransaction(async()=>{await repo.savePrediction(raceC);});
const raced=await repo.savePrediction(raceB);
assert.equal(raced.prediction.predictedRating,4.5);
assert.equal(raced.prediction.r2Key,'r2/prediction/c');
assert.equal(raced.history.length,1);
assert.equal(raced.history[0].payload.predictedRating,3.5);
assert.equal(raced.history[0].replacedAt,raceC.updatedAt);
assert.equal(raced.history.some(item=>item.replacedAt===raceB.updatedAt),false);
const delayed=await repo.savePrediction(raceB);
assert.equal(JSON.stringify(delayed),JSON.stringify(raced));

await db.run("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:zz-print',1,'Print Title','2026-10-19T01:00:00.000Z')");
const newerPrint={filmId:'film:zz-print',schemaVersion:1,fingerprintHash:'print-2',generatedAt:'2026-10-23T02:00:00.000Z',invalidatedAt:null,r2Key:'r2/fingerprint/print-2',contentSha256:'sha-print-2'};
await repo.saveFingerprint(newerPrint);
await repo.savePrediction({...predictionC,filmId:'film:zz-print',fingerprintHash:'print-2',r2Key:'r2/prediction/print-2',contentSha256:'sha-prediction-print-2',updatedAt:'2026-10-23T03:00:00.000Z'});
const latePrint=await repo.saveFingerprint({...fingerprint,filmId:'film:zz-print'});
assert.equal(latePrint.fingerprintHash,'print-2');
assert.equal(latePrint.generatedAt,newerPrint.generatedAt);
assert.equal(latePrint.invalidatedAt,null);
const ready=await repo.readFilm('film:zz-print');
assert.equal(ready.fingerprint.fingerprintHash,'print-2');
assert.equal(ready.prediction.stale,false);
assert.equal(ready.queue,null);
const invalidated=await repo.saveFingerprint({...newerPrint,invalidatedAt:'2026-10-23T04:00:00.000Z'});
assert.equal(invalidated.fingerprintHash,'print-2');
assert.equal(invalidated.invalidatedAt,'2026-10-23T04:00:00.000Z');
const olderInvalid=await repo.saveFingerprint({...fingerprint,filmId:'film:zz-print',invalidatedAt:'2026-10-19T05:00:00.000Z'});
assert.equal(olderInvalid.fingerprintHash,'print-2');
assert.equal(olderInvalid.invalidatedAt,'2026-10-23T04:00:00.000Z');

await db.run("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:zz-rate',1,'Rate Title','2026-10-19T01:00:00.000Z')");
await repo.saveActualRating({filmId:'film:zz-rate',rating:3.5,source:'letterboxd',recordedAt:'2026-10-19T11:00:00.000Z'});
await repo.saveActualRating({filmId:'film:zz-rate',rating:4.5,source:'letterboxd',recordedAt:'2026-10-19T12:00:00.000Z'});
const keptRating=await repo.saveActualRating({filmId:'film:zz-rate',rating:3.5,source:'letterboxd',recordedAt:'2026-10-19T11:00:00.000Z'});
assert.equal(keptRating.rating,4.5);
assert.equal(keptRating.recordedAt,'2026-10-19T12:00:00.000Z');
const reopenedRating=createPredictionRepository(openSqlite(database));
assert.equal((await reopenedRating.readFilm('film:zz-rate')).actualRating.rating,4.5);
assert.equal((await reopenedRating.readFilm('film:zz-rate')).actualRating.recordedAt,'2026-10-19T12:00:00.000Z');
const newerRating=await repo.saveActualRating({filmId:'film:zz-rate',rating:5,source:'letterboxd',recordedAt:'2026-10-19T13:00:00.000Z'});
assert.equal(newerRating.rating,5);
assert.equal(newerRating.recordedAt,'2026-10-19T13:00:00.000Z');

await db.run("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:zz-null',1,'Null Title','2026-10-19T01:00:00.000Z')");
const undated={filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'new-hash',generatedAt:null,invalidatedAt:null,r2Key:'r2/fingerprint/new-hash',contentSha256:'sha-new-hash'};
const staleUndated={...undated,fingerprintHash:'stale-hash',r2Key:'r2/fingerprint/stale-hash',contentSha256:'sha-stale-hash'};
const keptUndated=await repo.saveFingerprint(undated);
assert.equal(keptUndated.fingerprintHash,'new-hash');
assert.equal(keptUndated.generatedAt,null);
const repeatedUndated=await repo.saveFingerprint(undated);
assert.equal(repeatedUndated.fingerprintHash,'new-hash');
assert.equal(repeatedUndated.invalidatedAt,null);
await assert.rejects(()=>repo.saveFingerprint(staleUndated),/Fingerprint conflicts/);
assert.equal((await repo.readFilm('film:zz-null')).fingerprint.fingerprintHash,'new-hash');
const datedPrint=await repo.saveFingerprint({...undated,fingerprintHash:'dated-hash',generatedAt:'2026-10-23T02:00:00.000Z',r2Key:'r2/fingerprint/dated-hash',contentSha256:'sha-dated-hash'});
assert.equal(datedPrint.fingerprintHash,'dated-hash');
assert.equal(datedPrint.generatedAt,'2026-10-23T02:00:00.000Z');
const undatedAfterDated=await repo.saveFingerprint(staleUndated);
assert.equal(undatedAfterDated.fingerprintHash,'dated-hash');
assert.equal(undatedAfterDated.generatedAt,'2026-10-23T02:00:00.000Z');
const delayedUndated=await repo.saveFingerprint(staleUndated);
assert.equal(JSON.stringify(delayedUndated),JSON.stringify(undatedAfterDated));
await db.run("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:zz-void',1,'Void Title','2026-10-19T01:00:00.000Z')");
const voidPrint={filmId:'film:zz-void',schemaVersion:1,fingerprintHash:'void-hash',generatedAt:null,invalidatedAt:null,r2Key:'r2/fingerprint/void-hash',contentSha256:'sha-void-hash'};
await repo.saveFingerprint(voidPrint);
const voidInvalid=await repo.saveFingerprint({...voidPrint,invalidatedAt:'2026-10-23T04:00:00.000Z'});
assert.equal(voidInvalid.fingerprintHash,'void-hash');
assert.equal(voidInvalid.generatedAt,null);
assert.equal(voidInvalid.invalidatedAt,'2026-10-23T04:00:00.000Z');

await db.run("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:zz-part',1,'Partial Title','2026-10-19T01:00:00.000Z')");
await db.run("INSERT INTO prediction_current (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at) VALUES ('film:zz-part',1,NULL,'print-1',1,1,3.5,'r2/prediction/partial','sha-prediction-partial','2026-10-20T01:00:00.000Z')");
const partialNext={filmId:'film:zz-part',tasteProfileVersion:1,tasteProfileHash:'profile-1',fingerprintHash:'print-1',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:3.5,r2Key:'r2/prediction/partial',contentSha256:'sha-prediction-partial',updatedAt:'2026-10-21T01:00:00.000Z'};
const archivedPartial=await repo.savePrediction(partialNext);
assert.equal(archivedPartial.history.length,1);
assert.equal(archivedPartial.history[0].payload.tasteProfileHash,null);
assert.equal(archivedPartial.history[0].payload.predictedRating,3.5);
assert.equal(archivedPartial.history[0].r2Key,'r2/prediction/partial');
assert.equal(archivedPartial.prediction.tasteProfileHash,'profile-1');
assert.equal(archivedPartial.prediction.updatedAt,partialNext.updatedAt);
const repeatedPartial=await repo.savePrediction(partialNext);
assert.equal(repeatedPartial.history.length,1);
const reopenedPartial=createPredictionRepository(openSqlite(database));
assert.equal(JSON.stringify(await reopenedPartial.readFilm('film:zz-part')),JSON.stringify(repeatedPartial));

async function count(databaseHandle,sql){return (await databaseHandle.get(sql)).n;}
function openSqlite(file){
 const state={buffer:null};
 return {
  run(sql,params=[]){const statement=render(sql,params)+';';if(state.buffer)state.buffer.push(statement);else exec(file,statement);return Promise.resolve();},
  get(sql,params=[]){if(state.buffer)throw new Error('Read inside the prediction transaction');return Promise.resolve(query(file,sql,params)[0]??null);},
  all(sql,params=[]){if(state.buffer)throw new Error('Read inside the prediction transaction');return Promise.resolve(query(file,sql,params));},
  beforeTransaction(fn){state.beforeTransaction=fn;},
  async transaction(fn){
   if(state.buffer)return fn();
   if(state.beforeTransaction){const hook=state.beforeTransaction;state.beforeTransaction=null;await hook();}
   state.buffer=[];
   try{await fn();exec(file,'BEGIN;\n'+state.buffer.join('\n')+'\nCOMMIT;\n');}
   finally{state.buffer=null;}
  },
 };
}
function exec(file,sql){
 const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'sqlite failed');
}
function query(file,sql,params){
 const result=spawnSync('sqlite3',['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+render(sql,params)+';',encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'sqlite failed');
 const text=result.stdout.trim();
 return text?JSON.parse(text):[];
}
function render(sql,params=[]){
 let index=0;
 const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('Missing SQL parameter');return literal(params[index++]);});
 if(index!==params.length)throw new Error('Unused SQL parameter');
 return text;
}
function literal(value){
 if(value==null)return 'NULL';
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Bad SQL number');return String(value);}
 if(typeof value==='boolean')return value?'1':'0';
 return "'"+String(value).replaceAll("'","''")+"'";
}
