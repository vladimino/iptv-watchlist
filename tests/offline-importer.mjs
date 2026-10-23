import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {createEpgRepository} from '../src/epg-repository.js';
import {createPredictionRepository} from '../src/prediction-repository.js';
import {importBatch,inventory} from '../src/offline-importer.js';
import {manifestFor} from '../scripts/migration-export.mjs';

const source=fs.readFileSync('src/offline-importer.js','utf8');
assert.doesNotMatch(source,/d1_databases|\bBUCKET\b|\bfetch\b|\bwrangler\b|INSERT INTO film\s|INSERT INTO prediction_current|INSERT INTO fingerprint_payload/);
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/offline-importer/);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/offline-importer/);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-offline-import-'));
const database=path.join(root,'import.sqlite');
exec(database,fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const db=openSqlite(database);
const repositories={canonical:createCanonicalRepository(db),epg:createEpgRepository(db),prediction:createPredictionRepository(db)};
const at='2026-10-19T01:00:00.000Z';
const later='2026-10-21T01:00:00.000Z';
const partial=inventory({finishedAt:at,aggregateSha256:'sha-partial',keys:['watchlist.json','programme.json']});
assert.equal(partial.production,false);
assert.equal(partial.scope,'historical-snapshot');
assert.equal(partial.complete,false);
assert.equal(partial.families.discovery.status,'absent');
assert.equal(partial.families.prediction.status,'absent');
assert.equal(partial.absent.includes('discovery'),true);

const owner=film('film:zz-film','Original Title',at,dim('localization','reviewed',at,{value:'Owner Title',source:'owner',provenance:{authority:'owner'}}));
const weaker={...owner,localization:dim('localization','provisional',later,{value:'Other Title',source:'dictionary'})};
const units=[
 {family:'watchlist',kind:'person',sourceKey:'people.json',sourceSha256:'sha-people',targetTable:'person',targetId:'person:actor/zz-role',unportable:false,input:{person:person('person:actor/zz-role','actor/zz-role',at)}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-watchlist',targetTable:'film',targetId:'film:zz-film',unportable:false,input:{film:owner,watchlist:true}},
 {family:'watchlist',kind:'film',sourceKey:'titles.json',sourceSha256:'sha-weaker',targetTable:'film',targetId:'film:zz-film',unportable:false,input:{film:weaker,watchlist:true}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-broken',targetTable:'film',targetId:'film:zz-broken',unportable:false,input:{film:film('film:zz-broken','Broken Title',at),credits:[{personId:'person:missing',role:'actor',ordinal:0}]}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-other',targetTable:'film',targetId:'film:zz-other',unportable:false,input:{film:{...film('film:zz-other','Other Title',at),externalIds:[{scheme:'tmdb',value:'1656',trusted:true,conflicting:false}],canonicalIdentity:'tmdb:1656'}}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-clash',targetTable:'film',targetId:'film:zz-clash',unportable:false,input:{film:{...film('film:zz-clash','Clash Title',at),externalIds:[{scheme:'tmdb',value:'1656',trusted:true,conflicting:false}],canonicalIdentity:'tmdb:1656'}}},
 {family:'programme',kind:'generation',sourceKey:'programme.json',sourceSha256:'sha-programme',targetTable:'programme_generation',targetId:'run-a',unportable:false,input:{programmeRunId:'run-a',phase:'published',expectedProgrammeRunId:null,publishedAt:at,films:[{filmId:'film:zz-film',shows:[{channelId:'channel-a',channel:'Channel A',startMs:1000,endMs:2000,epgTitle:'Visible Title',basis:'title_duration',matchReason:'duration_conflict'}]}],candidates:[]}},
 {family:'programme',kind:'generation',sourceKey:'programme.json',sourceSha256:'sha-stale',targetTable:'programme_generation',targetId:'run-old',unportable:false,input:{programmeRunId:'run-old',phase:'published',expectedProgrammeRunId:'run-missing',publishedAt:'2026-10-18T01:00:00.000Z',films:[{filmId:'film:zz-film',shows:[]}],candidates:[]}},
 {family:'profile',kind:'profile',sourceKey:'enrichment/profile/versions/1.json',sourceSha256:'sha-profile',targetTable:'profile_version',targetId:'1',unportable:false,input:{version:1,profileHash:'profile-1',createdAt:at,r2Key:'enrichment/profile/versions/1.json',contentSha256:'sha-profile'}},
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-null',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'new-hash',generatedAt:null,invalidatedAt:null,r2Key:'enrichment/films/zz-null/fingerprint.json',contentSha256:'sha-null'}},
];
const stopped=await importBatch(db,repositories,{inventory:partial,importedAt:at,units,limit:1});
assert.equal(stopped.applied,1);
assert.equal(stopped.pending,units.length-1);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM import_receipt'),1);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film'),0);
const finished=await importBatch(db,repositories,{inventory:partial,importedAt:at,units});
assert.equal(finished.claimsFullParity,false);
assert.equal(finished.resumed,1);
assert.equal(finished.ledger.some(item=>item.reason==='reviewed_kept'),true);
assert.equal(finished.ledger.some(item=>item.reason==='reference_missing'),true);
assert.equal(finished.ledger.some(item=>item.reason==='identity_collision'),true);
assert.equal((await repositories.canonical.readFilm('film:zz-film')).dimensions.localization.value,'Owner Title');
assert.equal(await repositories.canonical.readFilm('film:zz-broken'),null);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM programme_generation WHERE programme_run_id='run-old'"),0);
assert.equal((await repositories.epg.readPublished()).programmeRunId,'run-a');
const again=await importBatch(db,repositories,{inventory:partial,importedAt:at,units});
assert.equal(again.applied,0);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film'),2);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM import_receipt'),finished.applied+stopped.applied);

const nullFilm=film('film:zz-null','Null Title',at);
await repositories.canonical.saveFilm({film:nullFilm});
const dated=await importBatch(db,repositories,{inventory:partial,importedAt:at,units:[
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-null',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'new-hash',generatedAt:null,invalidatedAt:null,r2Key:'enrichment/films/zz-null/fingerprint.json',contentSha256:'sha-null'}},
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-stale-null',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'stale-hash',generatedAt:null,invalidatedAt:null,r2Key:'enrichment/films/zz-null/stale.json',contentSha256:'sha-stale-null'}},
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-dated',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'dated-hash',generatedAt:later,invalidatedAt:null,r2Key:'enrichment/films/zz-null/dated.json',contentSha256:'sha-dated'}},
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-stale-null',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'stale-hash',generatedAt:null,invalidatedAt:null,r2Key:'enrichment/films/zz-null/stale.json',contentSha256:'sha-stale-null'}},
 {family:'prediction',kind:'prediction',sourceKey:'enrichment/films/zz-null/predictions.json',sourceSha256:'sha-prediction-new',targetTable:'prediction_current',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',tasteProfileVersion:1,tasteProfileHash:'profile-1',fingerprintHash:'dated-hash',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4.5,r2Key:'r2/prediction/new',contentSha256:'sha-prediction-new',updatedAt:later}},
 {family:'prediction',kind:'prediction',sourceKey:'enrichment/films/zz-null/predictions.json',sourceSha256:'sha-prediction-old',targetTable:'prediction_current',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',tasteProfileVersion:1,tasteProfileHash:'profile-1',fingerprintHash:'dated-hash',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:3.5,r2Key:'r2/prediction/old',contentSha256:'sha-prediction-old',updatedAt:at}},
 {family:'actual',kind:'rating',sourceKey:'enrichment/films/zz-null/actual.json',sourceSha256:'sha-rate-new',targetTable:'actual_rating',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',rating:4.5,source:'letterboxd',recordedAt:later}},
 {family:'actual',kind:'rating',sourceKey:'enrichment/films/zz-null/actual.json',sourceSha256:'sha-rate-old',targetTable:'actual_rating',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',rating:3.5,source:'letterboxd',recordedAt:at}},
]});
assert.equal(dated.ledger.some(item=>item.reason==='Fingerprint conflicts'),true);
assert.equal(dated.ledger.some(item=>item.reason==='fingerprint_kept'),true);
assert.equal(dated.ledger.some(item=>item.reason==='prediction_kept'),true);
assert.equal(dated.ledger.some(item=>item.reason==='rating_kept'),true);
const kept=await repositories.prediction.readFilm('film:zz-null');
assert.equal(kept.fingerprint.fingerprintHash,'dated-hash');
assert.equal(kept.prediction.predictedRating,4.5);
assert.equal(kept.prediction.updatedAt,later);
assert.equal(kept.history.length,0);
assert.equal(kept.actualRating.rating,4.5);
assert.equal(kept.actualRating.recordedAt,later);
const repeated=await importBatch(db,repositories,{inventory:partial,importedAt:at,units:[
 {family:'prediction',kind:'prediction',sourceKey:'enrichment/films/zz-null/predictions.json',sourceSha256:'sha-prediction-old',targetTable:'prediction_current',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',tasteProfileVersion:1,tasteProfileHash:'profile-1',fingerprintHash:'dated-hash',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:3.5,r2Key:'r2/prediction/old',contentSha256:'sha-prediction-old',updatedAt:at}},
 {family:'actual',kind:'rating',sourceKey:'enrichment/films/zz-null/actual.json',sourceSha256:'sha-rate-old',targetTable:'actual_rating',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',rating:3.5,source:'letterboxd',recordedAt:at}},
]});
assert.equal(repeated.ledger.filter(item=>item.reason==='prediction_kept').length,1);
assert.equal((await repositories.prediction.readFilm('film:zz-null')).history.length,0);
assert.equal((await repositories.prediction.readFilm('film:zz-null')).actualRating.rating,4.5);

const snapshot=path.join(root,'snapshot');
const canary='CANARY-TITLE';
const secret='history-secret';
writeSnapshot(snapshot,{
 'watchlist.json':{films:[{id:'zz-film',title:canary,original:'Original Title'}]},
 'programme.json':{films:[{id:'zz-film',title:canary,original:'Original Title',actors:[{id:'actor/zz-role',name:'Stored Name',original:'Stored Name'}],directors:[]}]},
 'metadata.json':{'zz-film':{id:'zz-film',original:'Original Title',metadataAt:at,peopleVersion:1,peopleNamesVersion:2,synopsis:'Text',synopsisFetchedAt:at,directors:[],actors:[{id:'actor/zz-role',name:'Stored Name',original:'Stored Name'}]}},
 'enrichment/profile/current.json':{version:1,profileHash:'profile-a',updatedAt:at},
 ['enrichment/films/zz-film/fingerprint.json']:{fingerprintSchemaVersion:1,fingerprintHash:'print-a',generatedAt:at,invalidatedAt:null},
 ['enrichment/films/zz-film/predictions.json']:{current:{tasteProfileVersion:1,tasteProfileHash:'profile-a',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4},history:[{note:secret}]},
 ['enrichment/films/zz-film/actual.json']:{rating:4,source:'letterboxd',updatedAt:at},
});
const first=runImport(snapshot,path.join(root,'cli.sqlite'));
assert.equal(first.production,false);
assert.equal(first.scope,'historical-snapshot');
assert.equal(first.finishedAt,'2026-10-19T01:00:00.000Z');
assert.equal(typeof first.aggregateSha256,'string');
assert.equal(first.claimsFullParity,false);
assert.equal(first.families.discovery.status,'absent');
assert.equal(first.families.profile.status,'present');
assert.equal(first.unportable>0,true);
assert.equal(first.ledger.some(item=>item.reason==='credits_not_carried'),true);
assert.equal(first.ledger.some(item=>item.reason==='profile_version_object_missing'),true);
assert.equal(first.ledger.some(item=>item.reason==='mutable_bundle_is_not_a_version_object'||item.reason==='prediction_version_object_missing'||item.reason==='prediction_fields_missing'),true);
assert.equal(JSON.stringify(first).includes(canary),false);
assert.equal(JSON.stringify(first).includes(secret),false);
const second=runImport(snapshot,path.join(root,'cli.sqlite'));
assert.equal(second.applied,0);
assert.equal(second.resumed,first.applied);
assert.equal(second.claimsFullParity,false);
assert.equal(second.unportable,first.unportable);

function dim(dimension,status,updatedAt,extra={}){return {dimension,status,updatedAt,source:extra.source||'letterboxd',sourceVersion:null,provenance:extra.provenance||null,value:extra.value??null,nextAction:'none',attempts:0};}
function film(id,title,updatedAt,localization){return {contractVersion:1,id,canonicalIdentity:null,originalTitle:title,externalIds:[{scheme:'letterboxd',value:id.slice('film:'.length),trusted:true,conflicting:false}],aliases:[],identity:dim('identity','resolved',updatedAt),metadata:dim('metadata','fresh',updatedAt),localization:localization||dim('localization','missing',updatedAt),fingerprint:dim('fingerprint','missing',updatedAt),prediction:dim('prediction','missing',updatedAt)};}
function person(id,roleId,updatedAt){return {contractVersion:1,id,roleId,externalIds:[{scheme:'letterboxd-role',value:roleId,trusted:true,conflicting:false}],aliases:[],identity:dim('identity','resolved',updatedAt),localization:dim('localization','missing',updatedAt)};}
function writeSnapshot(directory,bodies){
 fs.rmSync(directory,{recursive:true,force:true});
 fs.mkdirSync(path.join(directory,'objects'),{recursive:true});
 const entries=Object.entries(bodies).map(([key,value])=>{
  const bytes=Buffer.from(JSON.stringify(value),'utf8');
  const name=createHash('sha256').update(Buffer.from(key,'utf8')).digest('hex')+'.bin';
  fs.writeFileSync(path.join(directory,'objects',name),bytes);
  return {key,file:'objects/'+name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),metadata:{size:bytes.length}};
 });
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifestFor(entries,1,'2026-10-19T00:00:00.000Z','2026-10-19T01:00:00.000Z',[])));
}
function runImport(directory,file){
 const result=spawnSync(process.execPath,['scripts/offline-import.mjs','--snapshot',directory,'--database',file],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 return JSON.parse(result.stdout);
}
async function count(databaseHandle,sql){return (await databaseHandle.get(sql)).n;}
function openSqlite(file){
 const state={buffer:null};
 return {run(sql,params=[]){const statement=render(sql,params)+';';if(state.buffer)state.buffer.push(statement);else exec(file,statement);return Promise.resolve();},get(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return Promise.resolve(query(file,sql,params)[0]??null);},all(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return Promise.resolve(query(file,sql,params));},async transaction(fn){if(state.buffer)return fn();state.buffer=[];try{await fn();exec(file,'BEGIN;\n'+state.buffer.join('\n')+'\nCOMMIT;\n');}finally{state.buffer=null;}}};
}
function exec(file,sql){const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||'sqlite failed');}
function query(file,sql,params){const result=spawnSync('sqlite3',['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+render(sql,params)+';',encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||'sqlite failed');const text=result.stdout.trim();return text?JSON.parse(text):[];}
function render(sql,params=[]){let index=0;const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('Missing SQL parameter');return literal(params[index++]);});if(index!==params.length)throw new Error('Unused SQL parameter');return text;}
function literal(value){if(value==null)return 'NULL';if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Bad SQL number');return String(value);}if(typeof value==='boolean')return value?'1':'0';return "'"+String(value).replaceAll("'","''")+"'";}
