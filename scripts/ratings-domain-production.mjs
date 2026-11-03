#!/usr/bin/env node
// Production entry for the ratings cutover (ADR 0084). Default is read-only.
// --apply sends only migrations/0010_ratings_authority.sql, and only when the
// contract is a complete version 8 or 9 and the ratings tables are absent.
// The inserted marker stays mode r2, cutover open, and the version becomes 10.
// Owner reviews are not required. --load copies the mutable ratings objects
// and leaves mode r2. --activate holds mode d1 only with --producers-drained,
// re-reads R2, and opens the cutover when the bytes still match. A mismatch
// returns mode to r2 and does not write R2. A failed re-read leaves the hold.
// --revert --confirm r2 copies the D1 documents back to R2 and then sets mode r2.
// Each write needs its own --confirm and --target iptv. This script does not
// call Time Travel restore and does not start a ratings run.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {activateDocuments, importDocuments, listDocuments, ratingsMutableKey, releaseHeld, revertMarker, sealHeld} from '../src/ratings-d1.js';
import {createD1Adapter, D1Error, DEFAULT_ENDPOINT, renderSql} from './d1-backfill.mjs';
import {ExportError} from './migration-export.mjs';
import {createReadOnlyClient, readCredentials, rfc3986, signRequest} from './r2-snapshot-export.mjs';

export const PRODUCTION_ACCOUNT_ID='8d9331889a693d328ef306692adf9d24';
export const PRODUCTION_DATABASE_ID='3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb';
export const PRODUCTION_DATABASE_NAME='iptv';
export const RATINGS_TABLES=['ratings_domain_authority','ratings_domain_cas','ratings_document','ratings_view'];
const PREREQUISITE=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent','published_epg_authority','published_epg_cas','published_epg_generation','published_epg_document','published_epg_member','published_epg_show','published_epg_stage','published_epg_stage_chunk','published_epg_stage_row'];
const MIGRATION_PATH=path.join(path.dirname(fileURLToPath(import.meta.url)),'../migrations/0010_ratings_authority.sql');
const PRODUCTION_R2_ENDPOINT='https://'+PRODUCTION_ACCOUNT_ID+'.r2.cloudflarestorage.com';
const WRITER_WINDOW_MS=15*60*1000;

export class OperatorStop extends Error{constructor(reason,exitCode,detail){super(reason);this.reason=reason;this.exitCode=exitCode;this.detail=detail;}}

function migrationStatements(sql){
 const statements=[];
 let current='',quote='';
 for(const character of sql){
  if(quote){current+=character;if(character===quote)quote='';continue;}
  if(character==="'"||character==='"'){quote=character;current+=character;continue;}
  if(character===';'){
   const opens=(current.match(/\bBEGIN\b/gi)||[]).length;
   const closes=(current.match(/\bEND\b/gi)||[]).length;
   if(opens>closes){current+=character;continue;}
   const text=current.trim();
   if(text)statements.push(text);
   current='';
   continue;
  }
  current+=character;
 }
 const tail=current.trim();
 if(tail)statements.push(tail);
 return statements;
}
export function ratingsStatements(){
 const statements=migrationStatements(fs.readFileSync(MIGRATION_PATH,'utf8'));
 const refused=statements.some(sql=>/\bCOMMIT\b|\bINTO\s+film\b|\bINTO\s+candidate\b|\bwatchlist_film\b/i.test(sql)||(/\bBEGIN\b/i.test(sql)&&!/^CREATE TRIGGER\b/i.test(sql.trim())));
 if(!statements.length||refused)throw new OperatorStop('migration_refused',3);
 return statements;
}

export function applyDecision(snapshot){
 const present=RATINGS_TABLES.filter(name=>snapshot.ratings?.[name]);
 if(present.length&&present.length!==RATINGS_TABLES.length)return 'partial_schema';
 if(present.length===RATINGS_TABLES.length)return Number(snapshot.schemaVersion)>=10?'already_applied':'partial_schema';
 const version=Number(snapshot.schemaVersion);
 if(version!==8&&version!==9)return 'schema_unexpected';
 if(!snapshot.prerequisite)return 'published_prerequisite';
 return 'apply';
}

export function createRatingsBinding(adapter){
 return {
  prepare(sql){
   return {bind(...params){
    if(params.length>100)throw new OperatorStop('batch_too_large',3);
    const text=renderSql(sql,params);
    return {text,async first(){return (await adapter.get(sql,params))??null;},async all(){return {results:await adapter.all(sql,params)};},async run(){await adapter.run(sql,params);return {success:true};}};
   }};
  },
  async batch(statements){
   const texts=statements.map(item=>String(item?.text||''));
   if(!texts.length)return;
   await adapter.executeRendered(texts);
  },
 };
}

function parseArgs(argv){
 const args=argv.slice(2);
 const commands=['--apply','--load','--activate','--revert','--release-hold','--seal-hold'].filter(flag=>args.includes(flag));
 if(commands.length>1)throw new OperatorStop('usage',2);
 const command=commands[0]||'status';
 const target=args.includes('--target')?args[args.indexOf('--target')+1]:undefined;
 const confirm=args.includes('--confirm')?args[args.indexOf('--confirm')+1]:undefined;
 if((args.includes('--target')&&!target)||(args.includes('--confirm')&&!confirm))throw new OperatorStop('usage',2);
 return {command,target,confirm,drained:args.includes('--producers-drained')};
}

async function snapshotOf(binding){
 const versionRow=await binding.prepare('SELECT version FROM schema_contract WHERE id=1').bind().first();
 const names=(await binding.prepare("SELECT name FROM sqlite_master WHERE type='table'").bind().all()).results.map(row=>row.name);
 const ratings=Object.fromEntries(RATINGS_TABLES.map(name=>[name,names.includes(name)]));
 const prerequisite=PREREQUISITE.every(name=>names.includes(name));
 let marker=null;
 if(ratings.ratings_domain_authority){
  const row=await binding.prepare('SELECT mode, cutover, generation FROM ratings_domain_authority WHERE id=1').bind().first();
  if(row)marker={mode:row.mode,cutover:row.cutover,generation:Number(row.generation)};
 }
 return {schemaVersion:Number(versionRow?.version),ratings,prerequisite,marker};
}

function wantedKey(key){return ratingsMutableKey(key);}
async function listWanted(client){
 const keys=[];
 let cursor=null;
 do{
  const page=await client.list(cursor);
  for(const object of page.objects)if(wantedKey(object.key))keys.push(object.key);
  cursor=page.truncated?page.nextCursor:null;
 }while(cursor);
 return keys;
}
async function readText(client,key){
 const head=await client.head(key);
 if(!head)return null;
 const got=await client.get(key,{ifMatch:head.etag});
 if(!got)return null;
 const text=Buffer.from(await new Response(got.body).arrayBuffer()).toString('utf8');
 return {key,text};
}
async function readDomain(client){
 const documents=[];
 for(const key of await listWanted(client)){
  const item=await readText(client,key);
  if(item)documents.push(item);
 }
 return documents;
}
async function putDocument(credentials,fetchImpl,key,text){
 if(!ratingsMutableKey(key))throw new OperatorStop('mirror_refused',3);
 if(credentials.endpoint!==PRODUCTION_R2_ENDPOINT||credentials.endpointOverride)throw new OperatorStop('endpoint_refused',3);
 const url=new URL(credentials.endpoint);
 url.pathname='/'+rfc3986(credentials.bucket)+'/'+key.split('/').map(rfc3986).join('/');
 const payloadHash=createHash('sha256').update(text).digest('hex');
 const headers=signRequest({method:'PUT',url,headers:{'content-type':'application/json'},payloadHash,credentials,now:new Date()});
 const response=await fetchImpl(url,{method:'PUT',headers,body:text,redirect:'error'});
 if(!response.ok){await response.body?.cancel();throw new OperatorStop('mirror_failed',3,{key});}
 await response.body?.cancel();
}

async function writerReport(client,binding,now){
 const sync=await readText(client,'sync.json');
 let syncState='absent';
 if(sync){
  const value=JSON.parse(sync.text);
  if(['metadata','epg'].includes(value.stage)){
   const updated=Date.parse(value.updatedAt);
   syncState=!Number.isFinite(updated)||now-updated<WRITER_WINDOW_MS?'active':'idle';
  }else syncState='idle';
 }
 const lease=await readText(client,'epg/resolver-lease.json');
 const resolverState=lease&&Number(JSON.parse(lease.text).expiresAt)>now?'active':'idle';
 const row=await binding.prepare("SELECT lease_until AS leaseUntil FROM projection_run WHERE projection=?").bind('enrichment').first();
 const projectionState=row?.leaseUntil&&Date.parse(row.leaseUntil)>now?'active':'idle';
 const run=await readText(client,'letterboxd/ratings/run.json');
 let ratingsState='absent';
 if(run){
  const value=JSON.parse(run.text);
  ratingsState=value?.state==='running'&&Date.parse(value?.lease?.expiresAt)>now?'active':'idle';
 }
 return {sync:syncState,resolver:resolverState,projection:projectionState,ratings:ratingsState};
}
function assertIdle(writers){
 if(Object.values(writers).includes('active'))throw new OperatorStop('writer_active',3,{writers});
}

function normalize(error){
 if(error instanceof OperatorStop)return error;
 if(error instanceof D1Error)return new OperatorStop(error.code==='write_uncertain'?'write_uncertain':'d1_'+error.code,error.code==='write_uncertain'?4:3);
 if(error instanceof ExportError)return new OperatorStop('source_'+error.code,3);
 if(error?.code==='ratings_domain_fence')return new OperatorStop('ratings_domain_fence',3);
 if(error?.code)return new OperatorStop(error.code,3);
 return new OperatorStop('unknown_state',3);
}

export async function runRatingsProduction({argv=process.argv,env=process.env,fetchImpl=fetch,now=Date.now()}={}){
 const args=parseArgs(argv);
 if(args.target!==undefined&&args.target!=='iptv')throw new OperatorStop('target_refused',2);
 if(args.command!=='status'&&args.target!=='iptv')throw new OperatorStop('target_refused',2);
 const confirms={ '--apply':'apply','--load':'load','--activate':'activate','--revert':'r2','--release-hold':'release-hold','--seal-hold':'seal-hold'};
 if(args.command!=='status'&&args.confirm!==confirms[args.command])throw new OperatorStop('confirm_required',2);
 if((args.command==='--activate'||args.command==='--seal-hold')&&!args.drained)throw new OperatorStop('producers_not_drained',2);
 const account=String(env.D1_BACKFILL_ACCOUNT_ID||'').trim();
 const token=String(env.D1_BACKFILL_API_TOKEN||'').trim();
 if(!account||!token)throw new OperatorStop('credentials_missing',2);
 if(account!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 const adapter=createD1Adapter({target:{accountId:account,apiToken:token,endpoint:DEFAULT_ENDPOINT},databaseId:PRODUCTION_DATABASE_ID,fetchImpl});
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('database_identity',3);
 const binding=createRatingsBinding(adapter);
 const snapshot=await snapshotOf(binding);
 if(args.command==='status')return {operation:'status',writes:false,schemaVersion:snapshot.schemaVersion,ratings:snapshot.ratings,marker:snapshot.marker};
 const credentials=readCredentials(env);
 if(credentials.accountId!==PRODUCTION_ACCOUNT_ID||credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
 if(credentials.endpoint!==PRODUCTION_R2_ENDPOINT||credentials.endpointOverride)throw new OperatorStop('endpoint_refused',3);
 const client=createReadOnlyClient({credentials,fetchImpl});
 const writers=await writerReport(client,binding,now);
 if(args.command!=='--release-hold')assertIdle(writers);
 if(args.command==='--apply'){
  const decision=applyDecision(snapshot);
  if(decision!=='apply')throw new OperatorStop(decision,3);
  await adapter.executeSql(ratingsStatements());
  const readback=await snapshotOf(binding);
  if(readback.schemaVersion!==10||readback.marker?.mode!=='r2'||readback.marker?.cutover!=='open'||readback.marker?.generation!==0)throw new OperatorStop('readback_mismatch',3);
  return {operation:'apply',writes:true,writeState:'committed',schemaVersion:10,mode:'r2',generation:0};
 }
 if(args.command==='--load'){
  const documents=await readDomain(client);
  const imported=await importDocuments(binding,documents,{confirm:'load'});
  return {operation:'load',writes:true,writeState:'committed',mode:imported.mode,generation:imported.generation,documents:imported.documents};
 }
 if(args.command==='--activate'){
  const documents=await readDomain(client);
  let held;
  try{held=await activateDocuments(binding,documents,{confirm:'activate'});}
  catch(error){throw normalize(error);}
  let fresh;
  try{fresh=await readDomain(client);}catch(error){throw new OperatorStop('hold_reread_failed',4,{generation:held.generation,cause:error?.reason||error?.code||'read_failed'});}
  const same=fresh.length===documents.length&&fresh.every(item=>documents.find(stored=>stored.key===item.key&&stored.text===item.text));
  if(!same){await releaseHeld(binding,{confirm:'release-hold'});throw new OperatorStop('cutover_race',3);}
  const sealed=await sealHeld(binding,{confirm:'seal-hold',generation:held.generation});
  return {operation:'activate',writes:true,writeState:'committed',mode:sealed.mode,cutover:sealed.cutover,generation:sealed.generation};
 }
 if(args.command==='--release-hold'){
  const released=await releaseHeld(binding,{confirm:'release-hold'});
  return {operation:'release-hold',writes:true,writeState:'committed',mode:released.mode,cutover:released.cutover,generation:released.generation};
 }
 if(args.command==='--seal-hold'){
  const documents=await readDomain(client);
  const stored=await listDocuments(binding);
  const same=stored.documents.length===documents.length&&stored.documents.every(item=>documents.find(fresh=>fresh.key===item.key&&fresh.text===item.text));
  if(!same)throw new OperatorStop('ratings_domain_fence',3);
  const sealed=await sealHeld(binding,{confirm:'seal-hold',generation:stored.generation});
  return {operation:'seal-hold',writes:true,writeState:'committed',mode:sealed.mode,cutover:sealed.cutover};
 }
 const stored=await listDocuments(binding);
 for(const item of stored.documents)await putDocument(credentials,fetchImpl,item.key,item.text);
 const reverted=await revertMarker(binding,{confirm:'r2'});
 return {operation:'revert',writes:true,writeState:'committed',mode:reverted.mode,cutover:reverted.cutover,documents:stored.documents.length};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 runRatingsProduction().then(result=>{process.stdout.write(JSON.stringify(result)+'\n');}).catch(error=>{
  const stop=error instanceof OperatorStop?error:normalize(error);
  process.stdout.write(JSON.stringify({reason:stop.reason,detail:stop.detail||null})+'\n');
  process.exitCode=stop.exitCode||1;
 });
}
