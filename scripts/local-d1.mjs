// AIR-576: the local D1 of `npm run dev`. The Worker reads the ratings, prediction, published EPG, Film/Person, owner review, Discovery, started-mark and
// EPG checkpoint domains from D1 only (ADR 0162, ADR 0183, ADR 0192), so the local stack needs a real D1 beside its R2 bucket. This module owns everything
// that touches that database: the migrations from `migrations/` replayed on a fresh local store, the authority markers moved through the same guarded
// transitions the production activations use, and the synthetic rows of the dummy catalog. It never opens a remote binding, never reads a credential and
// never writes anything but the selected local store (the caller opens the binding with remote bindings off).
//
// The database handle is any D1 binding: Miniflare's local D1 in `npm run dev`, or the sqlite3 stand-in of the tests.
import {createHash} from 'node:crypto';
import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {LOCAL_PEOPLE,LOCAL_TITLES} from './local-fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const MIGRATIONS_DIRECTORY=path.join(root,'migrations');
const LOCAL_AT='2026-01-01T00:00:00.000Z';
const FIXTURE_RUN='local-fixture';
const BATCH=40;

export class LocalD1Error extends Error{constructor(message){super(message);this.name='LocalD1Error';}}

// A migration file is a list of statements; a trigger body holds semicolons of its own and ends at a line `END;`. The splitter is checked against the sqlite3
// CLI (which reads the whole file) in tests/local-d1.mjs, so a new migration style that it cannot split fails there, not in a developer's dev server.
function triggerComplete(text){
 const bare=text.replace(/'(?:[^']|'')*'/g,"''").replace(/--[^\n]*/g,'');
 const count=word=>(bare.match(new RegExp('\\b'+word+'\\b','gi'))||[]).length;
 return /\bEND\s*;\s*$/i.test(bare)&&count('END')===count('CASE')+1;
}
export function splitStatements(text){
 const out=[];
 let current=[],trigger=false;
 for(const line of String(text).split(/\r?\n/)){
  if(!current.length&&(!line.trim()||/^\s*--/.test(line)))continue;
  current.push(line);
  if(!trigger&&/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(line))trigger=true;
  // A trigger is complete when its own END is the last token: every CASE in a body closes with an END of its own, so the ENDs outnumber the CASEs by one.
  const ended=trigger?/;\s*$/.test(line)&&triggerComplete(current.join('\n')):/;\s*(?:--.*)?$/.test(line);
  if(ended){out.push(current.join('\n').replace(/;\s*(?:--.*)?$/,''));current=[];trigger=false;}
 }
 if(current.join('').trim())throw new LocalD1Error('A migration ends inside a statement.');
 return out;
}
export async function migrationFiles(directory=MIGRATIONS_DIRECTORY){
 const names=(await readdir(directory)).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
 if(!names.length)throw new LocalD1Error('No migration files found in '+directory+'.');
 return Promise.all(names.map(async name=>({name,sql:await readFile(path.join(directory,name),'utf8')})));
}
// The migrations are part of the store identity: a store built from an older migration chain is imported again instead of served with a stale schema.
export async function migrationsIdentity(directory=MIGRATIONS_DIRECTORY){
 const hash=createHash('sha256');
 for(const file of await migrationFiles(directory))hash.update(file.name+'\0'+file.sql+'\0');
 return hash.digest('hex');
}

async function run(db,statements){
 for(let at=0;at<statements.length;at+=BATCH){
  const chunk=statements.slice(at,at+BATCH).map(item=>typeof item==='string'?db.prepare(item).bind():db.prepare(item.sql).bind(...(item.params||[])));
  await db.batch(chunk);
 }
}
async function first(db,sql,params=[]){return db.prepare(sql).bind(...params).first();}

// Replays the whole chain on an empty database. A database that already holds a schema is refused: the store is deleted and rebuilt, never migrated in place.
export async function applyMigrations(db,directory=MIGRATIONS_DIRECTORY){
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").first();
 if(tables)throw new LocalD1Error('The local D1 is not empty; the local store must be deleted and imported again.');
 const files=await migrationFiles(directory);
 for(const file of files){
  try{await run(db,splitStatements(file.sql));}
  catch(error){throw new LocalD1Error(`Migration ${file.name} failed: ${error.message}`);}
 }
 const contract=await first(db,'SELECT version FROM schema_contract WHERE id=1');
 const expected=Number(files.at(-1).name.slice(0,4));
 if(Number(contract?.version)!==expected)throw new LocalD1Error(`The local D1 is at schema version ${contract?.version??'unknown'} after the migrations; the chain ends at ${expected}.`);
 return {version:expected,files:files.length};
}

// The markers of the domains the Worker reads from D1, moved by the guarded transitions of the migrations (a trigger refuses any other path). Production holds
// each of these at mode d1; the local store mirrors that. Two domains stay as migrated: the watchlist authority at `epg` (its D1 tables are written by the EPG
// commit, not seeded) and the prediction auxiliary documents at `r2`, which local development keeps in the local bucket.
export function activationStatements({programmeRunId}={}){
 const statements=[
  "UPDATE film_person_baseline SET state='loading', reference='local-dev', updated_at='"+LOCAL_AT+"' WHERE id=1",
  "UPDATE film_person_baseline SET state='verified' WHERE id=1",
  "UPDATE film_person_authority SET mode='prepared', generation=1 WHERE id=1",
  "UPDATE film_person_authority SET mode='d1', generation=2 WHERE id=1",
  "UPDATE prediction_domain_authority SET mode='d1', generation=1, profile_generation=1 WHERE id=1",
  "UPDATE owner_review_authority SET mode='d1', generation=1 WHERE id=1",
  "UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=1 WHERE id=1",
  "UPDATE metadata_cache_authority SET mode='d1' WHERE id=1",
  "UPDATE filter_preset_authority SET mode='d1', generation=1 WHERE id=1",
  "UPDATE started_authority SET mode='d1', generation=1 WHERE id=1",
  "UPDATE epg_checkpoint_authority SET mode='d1', generation=1 WHERE id=1",
  "UPDATE published_epg_authority SET mode='d1', cutover='open' WHERE id=1",
 ];
 if(programmeRunId)statements.push({sql:"UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id=?, published_programme_run_id=? WHERE id=1",params:[programmeRunId,programmeRunId]});
 return statements;
}

const q=value=>value===undefined?null:value;
async function predictionModule(){return import(pathToFileURL(path.join(root,'src/prediction-d1.js')).href);}
// The canonical Film/Person rows (the authority the Admin pages, the catalog titles and the identity verdicts read at marker d1) from the documents a store holds:
// a Film per programme film with its metadata, TMDB claim and credits, a Person per credited name, and the localization rows behind the provisional titles and
// the cached names (`titles.json` / `people.json`, the frozen mirrors). Nothing is invented: a film, person, title or name the documents do not hold gets no row.
// They are written while the marker is still r2 (the guarded activation follows), the way a baseline load fills them.
export function canonicalStatements({films=[],titles={},people:names={}},{at=new Date().toISOString()}={}){
 const statements=[];
 const people=new Map();
 const seenFilms=new Set();
 const list=(Array.isArray(films)?films:[]).filter(film=>film&&film.id!=null&&String(film.id)&&!seenFilms.has(String(film.id))&&seenFilms.add(String(film.id)));
 for(const film of list)for(const role of ['director','actor'])for(const person of film[role+'s']||[])if(person?.id&&!people.has(String(person.id)))people.set(String(person.id),person);
 const localization=item=>item&&['provisional','reviewed'].includes(item.status||'provisional');
 for(const person of people.values())statements.push({sql:'INSERT INTO person (id, role_id, contract_version, updated_at) VALUES (?,?,1,?)',params:['person:'+person.id,String(person.id),at]});
 for(const [id,item] of Object.entries(names||{})){
  const name=typeof item?.name==='string'?item.name:'';
  if(!people.has(id)||!name||!localization(item))continue;
  statements.push({sql:"INSERT INTO person_dimension (person_id, dimension, status, source, value, attempts, updated_at) VALUES (?,'localization',?,'local-store',?,0,?)",params:['person:'+id,item.status||'provisional',name,at]});
 }
 const claimed=new Set();
 for(const film of list){
  const id='film:'+film.id;
  const tmdb=film.tmdbId==null||film.tmdbId===''?null:String(film.tmdbId);
  const trusted=tmdb&&!claimed.has(tmdb);
  if(trusted)claimed.add(tmdb);
  statements.push({sql:'INSERT INTO film (id, contract_version, canonical_identity, original_title, updated_at) VALUES (?,1,?,?,?)',params:[id,trusted?'tmdb:'+tmdb:null,q(film.original),at]});
  statements.push({sql:'INSERT INTO film_metadata (film_id, schema_version, year, runtime, synopsis, poster, url, genres_json, people_version, payload_json, updated_at) VALUES (?,1,?,?,?,NULL,NULL,?,1,?,?)',params:[id,q(film.year),q(film.runtime),q(film.synopsis),JSON.stringify(film.genres||[]),JSON.stringify({id:film.id,title:film.title}),at]});
  if(trusted)statements.push({sql:"INSERT INTO film_external_id (film_id, scheme, value, trusted, conflicting, provenance_json) VALUES (?,'tmdb',?,1,0,NULL)",params:[id,tmdb]});
  for(const role of ['director','actor']){
   const seen=new Set();
   (film[role+'s']||[]).filter(person=>person?.id&&!seen.has(String(person.id))&&seen.add(String(person.id))).forEach((person,ordinal)=>statements.push({sql:'INSERT INTO film_person_credit (film_id, person_id, role, ordinal) VALUES (?,?,?,?)',params:[id,'person:'+person.id,role,ordinal]}));
  }
  const title=titles?.[film.id];
  if(localization(title)&&typeof title.title==='string'&&title.title)statements.push({sql:"INSERT INTO film_dimension (film_id, dimension, status, source, provenance_json, value, attempts, updated_at) VALUES (?,'localization',?,'local-store',?,?,0,?)",params:[id,title.status||'provisional',JSON.stringify({sources:Array.isArray(title.sources)?title.sources:[]}),title.title,at]});
 }
 return statements;
}
// The same rows for a snapshot store, strictly from the documents its own R2 holds: the programme (and watchlist films the programme lacks), titles.json and people.json.
export async function canonicalRowsFromBucket(bucket,{at=new Date().toISOString()}={}){
 const read=async key=>{const object=await bucket.get(key);if(!object)return null;try{return await object.json();}catch{return null;}};
 const programme=await read('programme.json'),watchlist=await read('watchlist.json');
 if(!Array.isArray(programme?.films))throw new LocalD1Error('programme.json is not a programme.');
 const known=new Set(programme.films.map(film=>String(film?.id)));
 const films=[...programme.films,...(Array.isArray(watchlist?.films)?watchlist.films:[]).filter(film=>film&&!known.has(String(film.id)))];
 return canonicalStatements({films,titles:await read('titles.json')||{},people:await read('people.json')||{}},{at});
}

// The synthetic rows of the dummy catalog (fixtures/local-site/catalog.json): the ratings view, the active prediction profile, fingerprints and pointers, and the
// started marks. The Worker verifies each prediction row against its immutable R2 body by SHA-256, so the bodies are built here with the Worker's own hash
// function (`fingerprintContentHash`) and returned beside the rows; the caller writes them to the local bucket first. Every row has an owner table and the
// readers' own shape; nothing is invented for a film the catalog does not describe.
export async function fixtureRows(catalog,{at=new Date().toISOString(),profile={version:1,profileHash:'local-fixture'}}={}){
 const {fingerprintContentHash,fingerprintKey}=await predictionModule();
 const statements=[],objects=[];
 const films=catalog.films||[];
 const profileBody={version:profile.version,profileHash:profile.profileHash,createdAt:at};
 const profileKey='enrichment/profile/versions/'+profile.version+'.json';
 objects.push({key:profileKey,json:profileBody});
 statements.push({sql:'INSERT INTO prediction_profile (version, profile_hash, active, created_at, r2_key, content_sha256) VALUES (?,?,1,?,?,?)',params:[profile.version,profile.profileHash,at,profileKey,await fingerprintContentHash(profileBody)]});
 for(const film of films){
  let fingerprintHash=null;
  const moodLabels=film.moods||[];
  if(film.mechanics||film.moods||film.execution){
   const hashed={fingerprintSchemaVersion:1,plotMechanics:film.mechanics||[],moodLabels,execution:film.execution||{}};
   fingerprintHash=await fingerprintContentHash(hashed);
   const body={...hashed,fingerprintHash};
   const key=fingerprintKey(film.id,fingerprintHash);
   objects.push({key,json:body});
   const features={...body,fingerprintPromptVersion:1,invalidatedAt:null,generatedAt:at,produced:null,previous:null};
   statements.push({sql:'INSERT INTO prediction_fingerprint (film_id, fingerprint_hash, schema_version, prompt_version, generated_at, invalidated_at, r2_key, content_sha256, features_json) VALUES (?,?,?,?,?,NULL,?,?,?)',params:[film.id,fingerprintHash,1,1,at,key,await fingerprintContentHash(body),JSON.stringify(features)]});
  }
  if(film.prediction){
   const p=film.prediction;
   const display={predictedRating:p.predictedRating,probability4Plus:p.probability4Plus,confidence:p.confidence,matchSignals:p.matchSignals,mainRisk:p.mainRisk,moodLabels,fingerprintHash,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintSchemaVersion:1,predictionPromptVersion:1};
   const body={filmId:film.id,...display};
   const sha=await fingerprintContentHash(body);
   const key='enrichment/films/'+encodeURIComponent(film.id)+'/predictions/versions/'+sha+'.json';
   objects.push({key,json:body});
   statements.push({sql:'INSERT INTO prediction_pointer (film_id, taste_profile_version, taste_profile_hash, fingerprint_hash, fingerprint_schema_version, prediction_prompt_version, predicted_rating, r2_key, content_sha256, updated_at, display_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)',params:[film.id,profile.version,profile.profileHash,fingerprintHash,1,1,p.predictedRating,key,sha,at,JSON.stringify(display)]});
  }
  if(film.actualRating!==undefined){
   statements.push({sql:'INSERT INTO ratings_view (alias_id, fact_key, watched, actual_rating, watchlist, rating_known, updated_at) VALUES (?,?,1,?,NULL,1,?)',params:[film.id,'local-fixture:'+film.id,q(film.actualRating),at]});
  }
  if(film.started)statements.push({sql:'INSERT INTO started_mark (id, started, started_at, last_event_json, rev) VALUES (?,1,?,NULL,1)',params:[film.id,at]});
 }
 return {statements,objects};
}

// Publishes the programme and watchlist documents of the R2 objects through the Worker's own published-EPG writer (fenced, chunked, with its mirror); the
// authority row is d1 and open before this runs. `src/published-epg.js` is the same module the Worker bundles.
export async function publishFromBucket(env){
 const PublishedEpg=await import(pathToFileURL(path.join(root,'src/published-epg.js')).href);
 const read=async key=>{const object=await env.BUCKET.get(key);if(!object)throw new LocalD1Error('The local bucket has no '+key+' to publish.');return object.json();};
 const programme=await read('programme.json');
 const watchlist=await read('watchlist.json');
 if(!programme?.runId||!Array.isArray(programme.films))throw new LocalD1Error('programme.json is not a programme.');
 const published=await PublishedEpg.publishGeneration(env,{programmeRunId:programme.runId,phase:'published',expectedProgrammeRunId:null,programme,watchlist,publishedAt:programme.updatedAt});
 if(!published.pointed)throw new LocalD1Error('The programme generation was not published.');
 return programme.runId;
}

// Installs the schema and the domains of one local store, then seeds the synthetic rows when a catalog is given. A snapshot store passes `statements` instead
// (see `readSnapshotSql`): its rows are the operator's own local input.
export async function installLocalD1(env,{catalog=null,statements=[],canonical=[],at=new Date().toISOString()}={}){
 const db=env.DB;
 if(!db)throw new LocalD1Error('The local stack has no D1 binding.');
 const migrated=await applyMigrations(db);
 let rows=[...canonical,...statements];
 if(catalog){
  const built=await fixtureRows(catalog,{at});
  for(const item of built.objects)await env.BUCKET.put(item.key,JSON.stringify(item.json),{httpMetadata:{contentType:'application/json'}});
  rows=[...canonicalStatements({films:catalog.films,titles:LOCAL_TITLES,people:LOCAL_PEOPLE},{at}),...built.statements];
 }
 // Rows first, markers after: the guarded transitions of the migrations are the only path to d1, and a marker at d1 refuses the plain writes of a load.
 await run(db,rows);
 await run(db,activationStatements({}));
 const programmeRunId=await publishFromBucket(env);
 await run(db,[{sql:"UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id=?, published_programme_run_id=? WHERE id=1",params:[programmeRunId,programmeRunId]}]);
 return {schemaVersion:migrated.version,migrations:migrated.files,rows:rows.length,programmeRunId};
}

// A readiness check for a store that is about to be reused: the schema is complete and every domain the stack reads is still at its marker. A partial or
// older database is reported as not ready, so the caller imports the store again instead of serving it.
export async function readLocalD1Ready(env,{directory=MIGRATIONS_DIRECTORY}={}){
 const db=env?.DB;
 if(!db)return false;
 try{
  const files=await migrationFiles(directory);
  const contract=await first(db,'SELECT version FROM schema_contract WHERE id=1');
  if(Number(contract?.version)!==Number(files.at(-1).name.slice(0,4)))return false;
  const checks=[
   ['film_person_authority',"mode='d1' AND cutover='open'"],['prediction_domain_authority',"mode='d1'"],['owner_review_authority',"mode='d1'"],['ratings_domain_authority',"mode='d1' AND cutover='open'"],
   ['metadata_cache_authority',"mode='d1'"],['filter_preset_authority',"mode='d1'"],['started_authority',"mode='d1'"],['epg_checkpoint_authority',"mode='d1'"],
   ['published_epg_authority',"mode='d1' AND cutover='open' AND programme_run_id IS NOT NULL"],['discovery_authority',"mode='d1' AND cutover='open' AND programme_run_id IS NOT NULL"],
  ];
  for(const [table,where] of checks)if(!await first(db,`SELECT 1 AS ok FROM ${table} WHERE id=1 AND ${where}`))return false;
  const pointer=await first(db,'SELECT programme_run_id FROM published_epg_authority WHERE id=1');
  if(!await first(db,'SELECT 1 AS ok FROM published_epg_generation WHERE programme_run_id=? AND phase=?',[pointer.programme_run_id,'published']))return false;
  return await bodiesConsistent(env);
 }catch{return false;}
}

// Started marks of a snapshot store come from its own `started/<id>.json` objects (R2 owned them before the started authority moved to D1).
export async function startedRowsFromBucket(bucket){
 const rows=[];
 let cursor;
 do{
  const page=await bucket.list({prefix:'started/',limit:1000,...(cursor?{cursor}:{})});
  for(const object of page.objects){
   const id=decodeURIComponent(object.key.slice('started/'.length).replace(/\.json$/,''));
   if(!id||id.length>80)continue;
   const body=await bucket.get(object.key);
   let started=true,startedAt=null;
   try{const json=await body.json();started=json?.started!==false;startedAt=typeof json?.startedAt==='string'?json.startedAt:null;}catch{}
   rows.push({sql:'INSERT INTO started_mark (id, started, started_at, last_event_json, rev) VALUES (?,?,?,NULL,1)',params:[id,started?1:0,startedAt]});
  }
  cursor=page.truncated?page.cursor:undefined;
 }while(cursor);
 return rows;
}

// The D1 input of a private snapshot store: a local SQL file of INSERT statements the operator provides (`d1Sql` in .local-dev.json, an absolute path). Only the
// tables a snapshot cannot supply are accepted, only INSERT, and nothing here can touch a marker, a schema or another table. The input must hold an active
// prediction profile and ratings rows, so an empty or missing domain is refused instead of being served as healthy.
export const OPERATOR_TABLES=['ratings_view','ratings_document','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage'];
const REQUIRED_TABLES=['prediction_profile','ratings_view'];
function splitDataStatements(text){
 const out=[];
 let current='',quote=false;
 for(let at=0;at<text.length;at++){
  const char=text[at];
  if(char==="'"){current+=char;if(quote&&text[at+1]==="'"){current+="'";at++;}else quote=!quote;continue;}
  if(!quote&&char==='-'&&text[at+1]==='-'){while(at<text.length&&text[at]!=='\n')at++;continue;}
  if(!quote&&char===';'){if(current.trim())out.push(current.trim());current='';continue;}
  current+=char;
 }
 if(quote)throw new LocalD1Error('The D1 input ends inside a string literal.');
 if(current.trim())out.push(current.trim());
 return out;
}
export async function readOperatorRows(file){
 const required='the snapshot store needs `d1Sql` in .local-dev.json: an absolute path to a local SQL file of INSERT statements for '+REQUIRED_TABLES.join(' and ')+' (optionally '+OPERATOR_TABLES.filter(name=>!REQUIRED_TABLES.includes(name)).join(', ')+'); see docs/runbooks/local-setup.md';
 if(!file)throw new LocalD1Error('No D1 input: '+required+'.');
 if(!path.isAbsolute(file))throw new LocalD1Error('d1Sql in .local-dev.json must be an absolute path.');
 let text;
 try{text=await readFile(file,'utf8');}catch{throw new LocalD1Error('The d1Sql file cannot be read: '+required+'.');}
 const statements=splitDataStatements(text),seen=new Set();
 for(const statement of statements){
  const match=statement.match(/^INSERT\s+INTO\s+"?([a-z_]+)"?\s*[(\s]/i);
  if(!match||!OPERATOR_TABLES.includes(match[1]))throw new LocalD1Error('The d1Sql file may only INSERT into '+OPERATOR_TABLES.join(', ')+'.');
  seen.add(match[1]);
 }
 const missing=REQUIRED_TABLES.filter(name=>!seen.has(name));
 if(missing.length)throw new LocalD1Error('The d1Sql file has no rows for '+missing.join(', ')+': '+required+'.');
 return {statements};
}
export async function operatorRowsIdentity(file){
 if(!file)return null;
 try{const info=await stat(file);return `${file}:${info.size}:${info.mtimeMs}`;}catch{return null;}
}

// The immutable R2 bodies the D1 prediction rows name must be present and hash-consistent, or the Worker refuses the view at the first read. The active profile is
// always checked; the fingerprint and pointer rows are checked up to BODY_CHECK_ROWS each (ordered by film id), so a store of thousands of films is not read in
// full at every start.
export const BODY_CHECK_ROWS=500;
export async function bodiesConsistent(env){
 const {fingerprintContentHash}=await predictionModule();
 const check=async row=>{
  const object=await env.BUCKET.get(row.r2_key);
  if(!object)return false;
  try{return await fingerprintContentHash(await object.json())===row.content_sha256;}catch{return false;}
 };
 const profile=await first(env.DB,'SELECT r2_key, content_sha256 FROM prediction_profile WHERE active=1');
 if(!profile||!await check(profile))return false;
 for(const table of ['prediction_fingerprint','prediction_pointer']){
  const result=await env.DB.prepare(`SELECT r2_key, content_sha256 FROM ${table} ORDER BY film_id LIMIT ?`).bind(BODY_CHECK_ROWS).all();
  for(const row of result.results||[])if(!await check(row))return false;
 }
 return true;
}
