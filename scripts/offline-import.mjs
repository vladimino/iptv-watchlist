// Import one verified historical snapshot into a local SQLite file.
// The snapshot and the database stay outside this repository. This command does not read production R2.
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {createEpgRepository} from '../src/epg-repository.js';
import {createPredictionRepository} from '../src/prediction-repository.js';
import {actualUnit,catalogMetadata,classifyObject,isArchiveKey,readDiscoveryArchive,creditRoster,decisionUnits,fingerprintUnit,generationUnit,identityResolver,importBatch,inventory,predictionUnits,ratingIdentity,profileUnit,projectSource,readDiscovery,refusal,supersededPayloads} from '../src/offline-importer.js';
import {ExportError} from './migration-export.mjs';
import {loadLifecycleSnapshot,SnapshotError} from './snapshot-store.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const note='Historical snapshot. Absent families and records that cannot be carried are listed and are not counted as matches. Class A is mapped-domain parity, class B the declared R2-only keys, class C unresolved identity and source-quality records kept in the source, S payloads of retired Film ids superseded by their canonical Film (ADR-0029). This command does not write production R2 or a production D1 database.';

export async function prepareImport(directory,{limit=null}={}){
 const rules=loadDomainRules();
 const loaded=await loadLifecycleSnapshot(directory);
 const absolute=path.resolve(directory);
 const manifest=JSON.parse(await readFile(path.join(absolute,'manifest.json'),'utf8'));
 const byKey=new Map(manifest.objects.map(entry=>[entry.key,entry]));
 const bodies=new Map();
 const units=[];
 for(const entry of manifest.objects){
  // Archive manifest and segment versions are read below, only those the published ledger names: unreferenced versions are not parsed.
  if(classifyObject(entry.key)!=='mapped'||isArchiveKey(entry.key))continue;
  try{bodies.set(entry.key,JSON.parse(await readFile(path.join(absolute,entry.file),'utf8')));}
  catch{units.push(unportable(entry.key,entry.sha256,'object',entry.key,'json_invalid','watchlist'));}
 }
 const keys=[...byKey.keys()];
 const snapshotInventory=inventory({finishedAt:manifest.finishedAt||null,aggregateSha256:manifest.totals?.aggregateSha256||null,keys,production:loaded.production===true});
 const shas=Object.fromEntries([...byKey].map(([key,entry])=>[key,entry.sha256]));
 // ADR 0034: a bounded ledger is complete only with the manifest it names and that manifest's segments (rule D, active wins).
 const published=bodies.get('epg/published-generation.json');
 const archive=byKey.has('epg/discovery-latest.json')?await readDiscoveryArchive({ledger:bodies.get('epg/discovery-latest.json'),generationKey:published?.phase==='published'&&published.programmeRunId?'epg/generations/'+published.programmeRunId+'/discovery-latest.json':null,keys,shas,segmentOf:rules.ledgerArchiveSegment,read:async key=>{const entry=byKey.get(key);try{return JSON.parse(await readFile(path.join(absolute,entry.file),'utf8'));}catch{return null;}}}):{mode:'full',ledger:null,blockers:[],bodies:{},summary:null};
 const ledgerBody=archive.ledger||bodies.get('epg/discovery-latest.json');
 const store=scopedStore(loaded.store,byKey);
 if(store.discoveryLatest&&archive.ledger)store.discoveryLatest=archive.ledger;
 const view=readLifecycle(store,Date.parse(manifest.finishedAt));
 const identity=identityResolver({canonicalize:rules.canonicalFilmId,films:view.films});
 const ratings=ratingIdentity({identity,films:view.films,metadata:bodies.get('metadata.json')??null,metadataSha256:byKey.get('metadata.json')?.sha256??null,ratings:manifest.objects.filter(entry=>/^enrichment\/films\/[^/]+\/actual\.json$/.test(entry.key)).map(entry=>({key:entry.key}))});
 const links={linked:(record,storedId)=>rules.predictionVersionLinked(record,storedId),exists:key=>byKey.has(key),sha:key=>byKey.get(key)?.sha256??null,bodyHash:record=>{const text=rules.predictionVersionText(record);return text==null?null:createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');}};
 const superseded=supersededPayloads({identity,links,entries:manifest.objects.filter(entry=>/^enrichment\/films\/[^/]+\/(?:fingerprint|predictions)\.json$/.test(entry.key)&&bodies.has(entry.key)).map(entry=>({key:entry.key,sha256:entry.sha256,body:bodies.get(entry.key)}))});
 const blockers=[];
 const sha=key=>byKey.get(key)?.sha256||'';
 const rosters={},listedIds={};
 const peopleKey=byKey.has('people.json')?'people.json':byKey.has('programme.json')?'programme.json':'watchlist.json';
 for(const person of view.people)units.push(record('watchlist','person',peopleKey,sha(peopleKey),'person',person.id,{person}));
 for(const film of view.films){
  const sourceKey=byKey.has('watchlist.json')?'watchlist.json':byKey.has('epg/discovered-films.json')?'epg/discovered-films.json':'programme.json';
  const letterboxd=(film.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value||null;
  const listed=!!letterboxd&&(store.watchlist?.films||[]).some(item=>String(item.id)===letterboxd);
  const filmUnit=record('watchlist','film',sourceKey,sha(sourceKey),'film',film.id,{film,watchlist:listed});
  const roster=creditRoster(recordsFor(store,film));
  filmUnit.desiredCredits=roster.credits;
  filmUnit.unmatchedCredits=roster.unmatched.length;
  const metadata=catalogMetadata(metadataRecord(bodies.get('metadata.json'),film),'metadata.json',sha('metadata.json'));
  if(metadata)filmUnit.input.metadata=metadata;
  rosters[film.id]={credits:roster.credits,unmatched:roster.unmatched.length};
  listedIds[film.id]=listed;
  units.push(filmUnit);
  for(const redirect of film.redirects||[]){
   if(!redirect?.from||!redirect?.to||!redirect?.at)units.push(unportable(sourceKey,sha(sourceKey),'film_redirect',redirect?.from||film.id,'redirect_fields_missing','watchlist'));
   else units.push(record('watchlist','link',sourceKey,sha(sourceKey),'film_redirect',redirect.from,{survivor:film,redirect}));
  }
 }
 // Dependency order: profile versions before the predictions that reference them, fingerprints before predictions, ratings last.
 for(const entry of manifest.objects){
  if(/^enrichment\/profile\/versions\/\d+\.json$/.test(entry.key))units.push(profileUnit(entry,bodies.get(entry.key)));
  if(entry.key==='enrichment/profile/current.json'&&!byKey.has('enrichment/profile/versions/'+bodies.get(entry.key)?.version+'.json'))units.push(profileUnit(entry,bodies.get(entry.key)));
 }
 for(const entry of manifest.objects)if(/^enrichment\/films\/[^/]+\/fingerprint\.json$/.test(entry.key))units.push(fingerprintUnit(entry,bodies.get(entry.key),identity,superseded));
 for(const entry of manifest.objects)if(/^enrichment\/films\/[^/]+\/predictions\.json$/.test(entry.key))units.push(...predictionUnits(entry,bodies.get(entry.key),identity,links,superseded));
 for(const entry of manifest.objects)if(/^enrichment\/films\/[^/]+\/actual\.json$/.test(entry.key))units.push(actualUnit(entry,bodies.get(entry.key),identity,ratings));
 blockers.push(...archive.blockers);
 const discovery=byKey.has('epg/discovery-latest.json')?readDiscovery(byKey.get('epg/discovery-latest.json'),ledgerBody,{deriveEvidence:rules.candidateEvidence}):{candidates:[],units:[],blockers:[]};
 units.push(...discovery.units);
 blockers.push(...discovery.blockers);
 if(byKey.has('programme.json')){
  const pointer=bodies.get('epg/published-generation.json')||{programmeRunId:bodies.get('programme.json')?.runId||null,phase:'published'};
  const portableDiscovery=discovery.units.length===0;
  if(byKey.has('epg/discovery-latest.json')&&!portableDiscovery)units.push(unportable('programme.json',sha('programme.json'),'programme_generation',pointer.programmeRunId||'programme.json','observation_fields_missing','programme'));
  else{
   const generation=generationUnit(pointer,bodies.get('programme.json'),sha('programme.json'),portableDiscovery?discovery.candidates.map(candidate=>({...candidate,lastSeenProgrammeRunId:candidate.lastSeenProgrammeRunId||pointer.programmeRunId,seenInLatest:true})) : [],identity);
   units.push(generation);
   if(!generation.unportable&&!generation.unresolved&&byKey.has('epg/discovery-resolution.json')){
    const decisions=decisionUnits(byKey.get('epg/discovery-resolution.json'),bodies.get('epg/discovery-resolution.json'),pointer.programmeRunId,{candidates:discovery.candidates,identity});
    units.push(...decisions.units);
    blockers.push(...decisions.blockers);
   }
   if((generation.unportable||generation.unresolved)&&byKey.has('epg/discovery-resolution.json'))units.push(unportable('epg/discovery-resolution.json',sha('epg/discovery-resolution.json'),'candidate_decision','epg/discovery-resolution.json','generation_not_imported','discovery'));
  }
 }
 const expected=projectSource({keys,bodies:{...Object.fromEntries(bodies),...archive.bodies},films:view.films,people:view.people,rosters,listed:listedIds,shas,identity,deriveEvidence:rules.candidateEvidence,links,ratings,superseded});
 for(const blocker of expected.blockers||[])if(!blockers.some(item=>item.reason===blocker.reason&&item.targetTable===blocker.targetTable&&item.targetId===blocker.targetId))blockers.push(blocker);
 return {inventory:snapshotInventory,discoveryArchive:archive.summary,finishedAt:manifest.finishedAt,units,expected,blockers,shas,limit,production:loaded.production===true,source:loaded.source,baselineIdentity:loaded.baselineIdentity,aggregateSha256:manifest.totals?.aggregateSha256??null};
}

// The shared rules come from the production sources themselves: canonicalFilmId from the domain model and candidateEvidence from the resolver.
// They are evaluated in a bare context with no network, storage or Worker bindings, so the importer carries no second copy of either rule.
export function loadDomainRules(){
 const domain=fs.readFileSync(path.join(root,'src/domain/film-person.js'),'utf8');
 const versions=fs.readFileSync(path.join(root,'src/domain/prediction-versions.js'),'utf8');
 const resolver=fs.readFileSync(path.join(root,'src/discovery.js'),'utf8');
 const context=vm.createContext({Date,Map,Set,JSON,Object,Number,String,Array,Math,encodeURIComponent,decodeURIComponent});
 vm.runInContext(domain+'\nglobalThis.domainApi={canonicalFilmId};',context);
 vm.runInContext(versions+'\nglobalThis.versionApi={predictionVersionLinked,parsePredictionVersionKey,predictionVersionKey,predictionVersionText,predictionVersionBody,predictionMaterializationPlan};',context);
 vm.runInContext(resolver+'\nglobalThis.resolverApi={candidateEvidence};',context);
 const ledgerContext=vm.createContext({Date,Map,Set,JSON,Object,Number,String,Array,Math,TextEncoder,encodeURIComponent,decodeURIComponent,URL,URLSearchParams});
 vm.runInContext(fs.readFileSync(path.join(root,'src/sources.js'),'utf8')+'\nglobalThis.ledgerApi={ledgerArchiveSegment};',ledgerContext);
 const {ledgerArchiveSegment}=ledgerContext.ledgerApi;
 const {canonicalFilmId}=context.domainApi,{candidateEvidence}=context.resolverApi,versionApi=context.versionApi;
 return {canonicalFilmId:id=>canonicalFilmId(id),candidateEvidence:candidate=>candidateEvidence(candidate),predictionVersionLinked:(record,filmId)=>versionApi.predictionVersionLinked(record,filmId),parsePredictionVersionKey:key=>versionApi.parsePredictionVersionKey(key),predictionVersionKey:(filmId,sha)=>versionApi.predictionVersionKey(filmId,sha),predictionVersionText:record=>versionApi.predictionVersionText(record),predictionVersionBody:record=>versionApi.predictionVersionBody(record),predictionMaterializationPlan:(filmId,bundle)=>versionApi.predictionMaterializationPlan(filmId,bundle),ledgerArchiveSegment:(key,count)=>ledgerArchiveSegment(key,count)};
}

function scopedStore(store,byKey){
 const next={filmTitles:store.filmTitles,personNames:store.personNames,personOverrides:store.personOverrides,titles:byKey.has('titles.json')?store.titles:{},people:byKey.has('people.json')?store.people:{},sync:byKey.has('sync.json')?store.sync:{failures:[]},persistedSidecars:{},fingerprints:{},predictions:{}};
 if(byKey.has('watchlist.json'))next.watchlist=store.watchlist;
 if(byKey.has('programme.json'))next.programme=store.programme;
 if(byKey.has('metadata.json'))next.metadata=store.metadata;
 if(byKey.has('epg/discovered-films.json'))next.discoveredFilms=store.discoveredFilms;
 if(byKey.has('epg/discovery-resolution.json'))next.discoveryResolution=store.discoveryResolution;
 if(byKey.has('epg/discovery-latest.json'))next.discoveryLatest=store.discoveryLatest;
 if(byKey.has('enrichment/profile/current.json'))next.profile=store.profile;
 for(const [id,body] of Object.entries(store.fingerprints||{})){
  if(byKey.has('enrichment/films/'+id+'/fingerprint.json')||byKey.has('enrichment/films/'+encodeURIComponent(id)+'/fingerprint.json'))next.fingerprints[id]=body;
 }
 return next;
}
function recordsFor(store,film){
 const ids=new Set([film.id.replace(/^film:/,'')]);
 const letterboxd=(film.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value;
 if(letterboxd)ids.add(letterboxd);
 return [...(store.watchlist?.films||[]),...(store.programme?.films||[]),...Object.values(store.metadata||{}),...Object.values(store.discoveredFilms||{})].filter(record=>record&&ids.has(String(record.id)));
}
function metadataRecord(body,film){
 if(!body||typeof body!=='object')return null;
 const ids=new Set([film.id.replace(/^film:/,'')]);
 const letterboxd=(film.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value;
 if(letterboxd)ids.add(String(letterboxd));
 for(const [key,value] of Object.entries(body))if(ids.has(key)||ids.has(String(value?.id)))return value;
 return null;
}
function readLifecycle(store,now){
 const domain=fs.readFileSync(path.join(root,'src/domain/film-person.js'),'utf8');
 const reader=fs.readFileSync(path.join(root,'src/domain/film-person-reader.js'),'utf8');
 const context=vm.createContext({Date,Map,Set,JSON,Object,encodeURIComponent});
 vm.runInContext(domain+'\n'+reader+'\nglobalThis.api={readLifecycle};',context);
 return context.api.readLifecycle(store,now);
}
function record(family,kind,sourceKey,sourceSha256,targetTable,targetId,input){return {family,kind,sourceKey,sourceSha256,targetTable,targetId,unportable:false,input};}
function unportable(sourceKey,sourceSha256,targetTable,targetId,reason,family){return {family,kind:'unportable',sourceKey,sourceSha256,targetTable,targetId,unportable:true,reason};}

export function openSqlite(file){
 const state={buffer:null};
 return {run(sql,params=[]){const statement=render(sql,params)+';';if(state.buffer)state.buffer.push(statement);else exec(file,statement);return Promise.resolve();},get(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return query(file,sql,params).then(rows=>rows[0]??null);},all(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return query(file,sql,params);},async transaction(fn){if(state.buffer)return fn();state.buffer=[];try{await fn();exec(file,'BEGIN;\n'+state.buffer.join('\n')+'\nCOMMIT;\n');}finally{state.buffer=null;}}};
}
function exec(file,sql){const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||'sqlite failed');}
// sqlite3 -json prints every row. spawnSync stops at 1MB of output, which is smaller than this archive's person table.
// The stream has no byte cap: each chunk is kept until the process exits, then parsed. A larger table still returns every row.
function query(file,sql,params){
 return new Promise((resolve,reject)=>{
  const child=spawn('sqlite3',['-json','-bail',file],{stdio:['pipe','pipe','pipe']});
  const stdout=[];
  const stderr=[];
  child.stdout.on('data',chunk=>stdout.push(chunk));
  child.stderr.on('data',chunk=>stderr.push(chunk));
  child.on('error',reject);
  child.on('close',code=>{
   if(code!==0){reject(new Error(Buffer.concat(stderr).toString('utf8')||'sqlite failed'));return;}
   const text=Buffer.concat(stdout).toString('utf8').trim();
   try{resolve(text?JSON.parse(text):[]);}catch(error){reject(error);}
  });
  child.stdin.end('PRAGMA foreign_keys=ON;\n'+render(sql,params)+';');
 });
}
function render(sql,params=[]){let index=0;const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('Missing SQL parameter');return literal(params[index++]);});if(index!==params.length)throw new Error('Unused SQL parameter');return text;}
function literal(value){if(value==null)return 'NULL';if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Bad SQL number');return String(value);}if(typeof value==='boolean')return value?'1':'0';return "'"+String(value).replaceAll("'","''")+"'";}

async function main(){
 const snapshotAt=process.argv.indexOf('--snapshot');
 const databaseAt=process.argv.indexOf('--database');
 const limitAt=process.argv.indexOf('--limit');
 const snapshot=snapshotAt>=0?process.argv[snapshotAt+1]:'';
 const database=databaseAt>=0?process.argv[databaseAt+1]:'';
 const limit=limitAt>=0?Number(process.argv[limitAt+1]):null;
 if(!snapshot||!database||(limit!=null&&!(Number.isInteger(limit)&&limit>0))){console.error('Usage: node scripts/offline-import.mjs --snapshot /absolute/private/snapshot-directory --database /absolute/private/import.sqlite [--limit <units>]');process.exit(2);}
 const databasePath=path.resolve(database);
 if(databasePath===root||databasePath.startsWith(root+path.sep)){console.error('Database path must be outside the Git repository');process.exit(2);}
 let batch;
 try{batch=await prepareImport(snapshot,{limit});}
 catch(error){console.error(error instanceof ExportError||error instanceof SnapshotError?error.message:'Snapshot could not be checked');process.exit(error.exitCode||1);}
 // Fail closed: an unknown key or a stored decision that disagrees with the derived evidence stops the run before the database is touched.
 const refused=refusal(batch);
 if(refused){console.log(JSON.stringify({...batch.inventory,discoveryArchive:batch.discoveryArchive,...refused,note}));process.exit(3);}
 if(!fs.existsSync(databasePath)){fs.mkdirSync(path.dirname(databasePath),{recursive:true});exec(databasePath,['0001_schema_v1.sql','0002_generation_stage.sql','0003_candidate_show_identity.sql'].map(file=>fs.readFileSync(path.join(root,'migrations',file),'utf8')).join('\n'));}
 const db=openSqlite(databasePath);
 const repositories={canonical:createCanonicalRepository(db),epg:createEpgRepository(db),prediction:createPredictionRepository(db)};
 const result=await importBatch(db,repositories,{...batch,importedAt:batch.finishedAt});
 console.log(JSON.stringify({...batch.inventory,discoveryArchive:batch.discoveryArchive,...result,note}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(error=>{console.error(error instanceof SnapshotError?error.message:'Import stopped');process.exit(1);});
}
