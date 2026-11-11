// AIR-374 P2a / ADR 0118 (Proposed, rules DRAFT-FOR-OWNER-REVIEW). Fenced canonical writers for the FILM-side producer GAPs of the producer adapters module:
// the identity overwrite (canonical_identity, original_title), film_metadata (set, merge, clear), film_sync_state (set, release), watchlist_film
// membership (set, clear), the film_dimension lifecycle rows (identity, metadata) and the EFFECTIVE localization row, which is materialised in the same
// batch as the automatic source write so the SQL of src/catalog-d1.js never sees a source with no effective value.
// DORMANT, like src/canonical-mutations.js: not bundled, imported only by the producer adapters module, and writeFilmFacts reaches the database only after
// assertWritable (marker d1/open). At r2/prepared (and held, legacy, unreadable) it refuses before any database statement but the marker read; the projector
// stays the only canonical writer. Nothing here reads R2, scores a Film or writes identity ids, aliases, credits, a fingerprint or a prediction.
// - planFilmFacts(snapshot,input) is PURE: it turns the stored rows of ONE Film and a caller's facts into statements and says what it skipped and why. The P6
//   differential harness runs it (and the projector) on one fixture. The same rows come out as the projector's writeFilm for the same inputs; where the
//   canonical rule is stricter (never blank, never overwrite reviewed/owner, trusted-source precedence) the difference is the documented rule.
// - writeFilmFacts(env,input) is the ONE fenced batch: the marker generation, the Film revision and the absence of a redirect are proven in the batch itself
//   (fenced.head / fenced.assertSql), the revision is bumped, and a lost fence or revision rolls it back whole (film_person_fence / film_person_revision_conflict).
// - Idempotency (owner decision 5): every call carries a stable requestId. Without a receipt table the replay is a no-op by CONTENT: if D1 already holds
//   exactly the rows the call would write (updated_at aside), no batch is opened. A durable per-request receipt for these writes would need a table beyond the
//   existing ones; that is documented in ADR 0118 and NOT added here (no migration in this change).
import {assertWritable,database,failed,many,one,readAuthority} from './film-person-authority.js';
import {fenced,MUTATION_STATEMENT_CAP} from './canonical-mutations.js';
import {resolveLocalization} from './localization-sources.js';

export const FILM_FACTS_SOURCE_CAP=10;
// Trusted sources of the identity overwrite, highest first. A value of an unlisted source can fill an empty field but never overwrite anything.
export const TITLE_SOURCE_ORDER=Object.freeze(['owner','dictionary','tmdb','letterboxd','watchlist','epg','discovery']);
const TMDB_IDENTITY=/^tmdb:[1-9]\d{0,11}$/;
const SOURCE=/^[a-z][a-z0-9_]{0,39}$/;
const RESERVED=new Set(['owner','dictionary','reviewed']);
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DIM_COLUMNS='dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at';
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const blank=value=>value===undefined||value===null||(typeof value==='string'&&value.trim()==='')||(Array.isArray(value)&&!value.length)||(plain(value)&&!Object.keys(value).length);
const json=value=>value==null?null:JSON.stringify(value);
const parse=text=>{if(text==null)return null;try{return JSON.parse(text);}catch{return null;}};
const instant=value=>{if(typeof value!=='string'||!ISO.test(value))return null;const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;};
const rank=source=>{const index=TITLE_SOURCE_ORDER.indexOf(source);return index<0?-1:TITLE_SOURCE_ORDER.length-index;};
const strong=row=>!!row&&(row.status==='reviewed'||row.authority==='owner');

// The guard of a dimension upsert, the one of the projector's localization write: a reviewed row is replaced only by an owner write over an owner row, or
// by a reviewed dictionary/owner write over a reviewed one.
function dimensionUpsert(){
 return `INSERT INTO film_dimension (film_id,${DIM_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id,dimension) DO UPDATE SET status=excluded.status,source=excluded.source,source_version=excluded.source_version,provenance_json=excluded.provenance_json,value=excluded.value,authority=excluded.authority,last_error=excluded.last_error,failure_reason=excluded.failure_reason,retry_at=excluded.retry_at,attempts=excluded.attempts,next_action=excluded.next_action,updated_at=excluded.updated_at WHERE film_dimension.status<>'reviewed' OR (film_dimension.authority='owner' AND excluded.status='reviewed' AND excluded.authority='owner') OR (COALESCE(film_dimension.authority,'')<>'owner' AND excluded.status='reviewed' AND (excluded.authority IN ('dictionary','owner') OR excluded.source='dictionary'))`;
}
// The same parameters as the projector's dimensionParams, so the same state gives the same row.
function dimensionParams(id,state){
 if(!plain(state)||!state.status||!state.updatedAt||!state.dimension)throw failed('film_person_invalid');
 return [id,state.dimension,state.status,state.source??null,state.sourceVersion??null,json(state.provenance),state.value??null,state.provenance?.authority??null,state.lastError??null,state.failureReason??null,state.retryAt??null,state.attempts??0,state.nextAction??'none',state.updatedAt];
}
const sameDimension=(stored,params)=>!!stored&&DIM_COLUMNS.split(',').filter(name=>name!=='updated_at').every((name,index)=>(stored[name]??null)===(params[DIM_COLUMNS.split(',').indexOf(name)+1]??null));

const META_FIELDS=[['year','year'],['runtime','runtime'],['synopsis','synopsis'],['poster','poster'],['url','url'],['peopleVersion','people_version'],['r2Key','r2_key'],['contentSha256','content_sha256']];
// A merge, never a blank: a field the caller leaves null, undefined or empty keeps the stored value; genres and payload are replaced only by a non-empty value.
export function mergeMetadata(stored,incoming){
 const base=stored?{schemaVersion:stored.schema_version,year:stored.year,runtime:stored.runtime,synopsis:stored.synopsis,poster:stored.poster,url:stored.url,genres:parse(stored.genres_json)||[],peopleVersion:stored.people_version,payload:parse(stored.payload_json)||{},r2Key:stored.r2_key,contentSha256:stored.content_sha256}:{};
 const out={...base,schemaVersion:Number.isInteger(incoming.schemaVersion)?incoming.schemaVersion:(base.schemaVersion??1),updatedAt:incoming.updatedAt};
 for(const [name] of META_FIELDS)out[name]=blank(incoming[name])?(base[name]??null):incoming[name];
 out.genres=blank(incoming.genres)?(base.genres||[]):incoming.genres;
 out.payload=blank(incoming.payload)?(base.payload||{}):incoming.payload;
 return out;
}
// Same column order and defaults as the projector's metadataParams.
function metadataParams(id,m){return [id,m.schemaVersion??1,m.year??null,m.runtime??null,m.synopsis??null,m.poster??null,m.url??null,JSON.stringify(m.genres||[]),m.peopleVersion??null,JSON.stringify(m.payload??{}),m.r2Key??null,m.contentSha256??null,m.updatedAt];}
const METADATA_UPSERT='INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET schema_version=excluded.schema_version,year=excluded.year,runtime=excluded.runtime,synopsis=excluded.synopsis,poster=excluded.poster,url=excluded.url,genres_json=excluded.genres_json,people_version=excluded.people_version,payload_json=excluded.payload_json,r2_key=excluded.r2_key,content_sha256=excluded.content_sha256,updated_at=excluded.updated_at';
const SYNC_UPSERT='INSERT INTO film_sync_state (film_id,metadata_at,synopsis_fetched_at,people_names_version,people_localized_at) VALUES (?,?,?,?,?) ON CONFLICT(film_id) DO UPDATE SET metadata_at=excluded.metadata_at,synopsis_fetched_at=excluded.synopsis_fetched_at,people_names_version=excluded.people_names_version,people_localized_at=excluded.people_localized_at';
const SOURCE_UPSERT='INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(film_id,source) DO UPDATE SET value=excluded.value,source_version=excluded.source_version,provenance_json=excluded.provenance_json,request_id=excluded.request_id,observed_at=excluded.observed_at,updated_at=excluded.updated_at WHERE excluded.observed_at>film_localization_source.observed_at';

// Reads the stored rows of ONE Film (read-only, no gate). The planner is pure over this snapshot.
export async function readFilmSnapshot(env,id){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const filmId=fenced.filmId(id);
 try{
  const [film,redirect,revision,dimensions,metadata,sync,member,tmdb,sources]=await Promise.all([
   one(db,'SELECT id,contract_version,canonical_identity,original_title,updated_at FROM film WHERE id=?',[filmId]),
   one(db,'SELECT to_film_id FROM film_redirect WHERE from_id=?',[filmId]),
   one(db,'SELECT revision FROM canonical_revision WHERE kind=? AND id=?',['film',filmId]),
   many(db,`SELECT ${DIM_COLUMNS} FROM film_dimension WHERE film_id=? AND dimension IN ('identity','metadata','localization')`,[filmId]),
   one(db,'SELECT schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at FROM film_metadata WHERE film_id=?',[filmId]),
   one(db,'SELECT metadata_at,synopsis_fetched_at,people_names_version,people_localized_at FROM film_sync_state WHERE film_id=?',[filmId]),
   one(db,'SELECT 1 AS present FROM watchlist_film WHERE film_id=?',[filmId]),
   many(db,"SELECT value FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND trusted=1 AND conflicting=0",[filmId]),
   many(db,"SELECT source,value,source_version,provenance_json,request_id,observed_at FROM film_localization_source WHERE film_id=?",[filmId]).catch(error=>{if(/no such table/i.test(String(error?.message||error)))return [];throw error;}),
  ]);
  return {id:filmId,film,redirect:redirect?redirect.to_film_id:null,revision:Number(revision?.revision??0),dimensions:Object.fromEntries(dimensions.map(row=>[row.dimension,row])),metadata,sync,member:!!member,trustedTmdb:tmdb.map(row=>String(row.value)),sources};
 }catch(error){if(error?.code)throw error;throw failed('film_person_unavailable',error);}
}

// The effective localization from the stored rows plus the sources of this write. owner/reviewed come from the dimension row, automatic from the source rows
// (a provisional legacy row of a source with no source row counts as that source's candidate, as loadLocalizationInputs does).
function effectiveLocalization(snapshot,written){
 const row=snapshot.dimensions.localization,input={owner:null,reviewed:null,automatic:[]};
 const bySource=new Map(snapshot.sources.map(item=>[item.source,{source:item.source,value:item.value,sourceVersion:item.source_version,provenance:parse(item.provenance_json),observedAt:item.observed_at}]));
 for(const item of written)bySource.set(item.source,{source:item.source,value:item.value,sourceVersion:item.sourceVersion,provenance:item.provenance,observedAt:item.observedAt});
 input.automatic=[...bySource.values()];
 if(row?.status==='reviewed'&&row.value){if(row.authority==='owner')input.owner={value:row.value,at:row.updated_at};else input.reviewed={value:row.value,source:row.source||'dictionary',at:row.updated_at};}
 else if(row?.status==='provisional'&&row.value&&row.source&&!RESERVED.has(row.source)&&!bySource.has(row.source))input.automatic.push({source:row.source,value:row.value,sourceVersion:row.source_version,provenance:parse(row.provenance_json),observedAt:row.updated_at});
 return resolveLocalization(input);
}

function normaliseSources(list,requestId,stored){
 if(!Array.isArray(list)||!list.length||list.length>FILM_FACTS_SOURCE_CAP)throw failed('film_person_invalid');
 const seen=new Set(),known=new Map(stored.map(row=>[row.source,row])),write=[],skipped=[];
 for(const item of list){
  if(!plain(item)||typeof item.source!=='string'||!SOURCE.test(item.source)||RESERVED.has(item.source)||seen.has(item.source)||typeof item.value!=='string'||!item.value.trim()||typeof item.sourceVersion!=='string'||!item.sourceVersion.trim())throw failed('film_person_invalid');
  const provenance=item.provenance??null;
  if(provenance!==null&&(!plain(provenance)||RESERVED.has(provenance.authority)||provenance.status==='reviewed'))throw failed('film_person_invalid');
  const observedAt=instant(item.observedAt);
  if(!observedAt)throw failed('film_person_invalid');
  seen.add(item.source);
  const value=item.value.trim(),row=known.get(item.source);
  if(row&&row.request_id===requestId&&row.value===value&&row.source_version===item.sourceVersion&&row.observed_at===observedAt){skipped.push({field:'source:'+item.source,reason:'replay'});continue;}
  if(row&&!(observedAt>row.observed_at)){skipped.push({field:'source:'+item.source,reason:'stale'});continue;}
  write.push({source:item.source,value,sourceVersion:item.sourceVersion,provenance,observedAt});
 }
 return {write,skipped};
}

// PURE. snapshot: readFilmSnapshot's result. input: {id, at, requestId, updatedAt?, film:{contractVersion, canonicalIdentity?, originalTitle?, source?, authority?},
// evidence?:{verified?}, dimensions?:{identity?, metadata?} (domain dimension states), localization?:{state} | {sources:[...]}, metadata?: object|null,
// sync?: {metadataAt?, synopsisFetchedAt?, peopleNamesVersion?, peopleLocalizedAt?}|null, watchlist?: boolean}
// Returns {statements, changes, skipped, noop}. `noop` is true when every row the call would write is already stored (updated_at aside).
export function planFilmFacts(snapshot,input){
 const id=fenced.filmId(input?.id),at=fenced.text(input.at);fenced.text(input.requestId);
 const filmIn=plain(input.film)?input.film:{};
 if(!Number.isInteger(filmIn.contractVersion))throw failed('film_person_invalid');
 if(input.localization!==undefined&&(!plain(input.localization)||(input.localization.state!==undefined&&input.localization.sources!==undefined)))throw failed('film_person_invalid');
 if(snapshot.redirect)throw failed('film_person_redirect');
 const updatedAt=input.updatedAt??at;
 const statements=[],changes=[],skipped=[];
 const stored=snapshot.film;
 // (a) identity overwrite rules
 const identityDim=snapshot.dimensions.identity;
 const incomingIdentity=input.dimensions?.identity;
 const source=filmIn.source??incomingIdentity?.source??null;
 const incomingOwner=filmIn.authority==='owner'&&source==='owner';
 let canonicalIdentity=stored?.canonical_identity??null,originalTitle=stored?.original_title??null;
 if(!blank(filmIn.canonicalIdentity)){
  const wanted=String(filmIn.canonicalIdentity).trim();
  if(!TMDB_IDENTITY.test(wanted)||!snapshot.trustedTmdb.includes(wanted.slice(5)))skipped.push({field:'canonicalIdentity',reason:'needs_trusted_tmdb_id'});
  else if(canonicalIdentity===wanted){/* unchanged */}
  else if(canonicalIdentity===null)canonicalIdentity=wanted;
  else if(strong(identityDim)&&!incomingOwner)skipped.push({field:'canonicalIdentity',reason:identityDim.authority==='owner'?'owner_kept':'reviewed_kept'});
  else if(input.evidence?.verified!==true)throw failed('film_person_identity_conflict');
  else canonicalIdentity=wanted;
 }else if(filmIn.canonicalIdentity!==undefined)skipped.push({field:'canonicalIdentity',reason:'blank'});
 if(!blank(filmIn.originalTitle)){
  const wanted=String(filmIn.originalTitle).trim();
  if(originalTitle===null||originalTitle==='')originalTitle=wanted;
  else if(originalTitle===wanted){/* unchanged */}
  else if(strong(identityDim)&&!incomingOwner)skipped.push({field:'originalTitle',reason:identityDim.authority==='owner'?'owner_kept':'reviewed_kept'});
  else if(rank(source)<0)skipped.push({field:'originalTitle',reason:'untrusted_source'});
  else if(rank(source)<rank(identityDim?.source))skipped.push({field:'originalTitle',reason:'lower_precedence'});
  else originalTitle=wanted;
 }else if(filmIn.originalTitle!==undefined)skipped.push({field:'originalTitle',reason:'blank'});
 const filmChanged=!stored||stored.contract_version!==filmIn.contractVersion||(stored.canonical_identity??null)!==canonicalIdentity||(stored.original_title??null)!==originalTitle;
 statements.push(['INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET contract_version=excluded.contract_version,canonical_identity=excluded.canonical_identity,original_title=excluded.original_title,updated_at=excluded.updated_at',[id,filmIn.contractVersion,canonicalIdentity,originalTitle,updatedAt]]);
 if(filmChanged)changes.push('film');
 if(canonicalIdentity!==null&&canonicalIdentity!==(stored?.canonical_identity??null))statements.push([fenced.assertSql("EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0)"),[id,canonicalIdentity.slice(5)]]);
 // (e) lifecycle rows: identity and metadata
 for(const name of ['identity','metadata']){
  const state=input.dimensions?.[name];
  if(state===undefined)continue;
  if(state.dimension!==name)throw failed('film_person_invalid');
  const params=dimensionParams(id,state),row=snapshot.dimensions[name];
  if(strong(row)&&!(row.authority==='owner'?(params[2]==='reviewed'&&params[7]==='owner'):(params[2]==='reviewed'&&(params[7]==='dictionary'||params[7]==='owner'||params[3]==='dictionary')))){skipped.push({field:'dimension:'+name,reason:row.authority==='owner'?'owner_kept':'reviewed_kept'});continue;}
  // The identity row's source is the recorded provenance of the title. A call whose title lost on precedence must not also lower that provenance.
  if(name==='identity'&&row&&skipped.some(item=>item.field==='originalTitle'&&(item.reason==='lower_precedence'||item.reason==='untrusted_source'))&&rank(state.source)<rank(row.source)){skipped.push({field:'dimension:identity',reason:'lower_precedence'});continue;}
  if(!sameDimension(row,params))changes.push('dimension:'+name);
  statements.push([dimensionUpsert(),params]);
 }
 // (e) effective localization, in the same batch as the source write
 if(input.localization?.state!==undefined){
  const state=input.localization.state;
  if(!plain(state)||state.dimension!=='localization')throw failed('film_person_invalid');
  const params=dimensionParams(id,state),row=snapshot.dimensions.localization;
  if(blank(state.value)&&state.status!=='reviewed'&&row&&!blank(row.value))skipped.push({field:'localization',reason:'blank'});
  else if(strong(row)&&!(row.authority==='owner'?(params[2]==='reviewed'&&params[7]==='owner'):(params[2]==='reviewed'&&(params[7]==='dictionary'||params[7]==='owner'||params[3]==='dictionary'))))skipped.push({field:'localization',reason:row.authority==='owner'?'owner_kept':'reviewed_kept'});
  else{if(!sameDimension(row,params))changes.push('dimension:localization');statements.push([dimensionUpsert(),params]);}
 }else if(input.localization?.sources!==undefined){
  const {write,skipped:notWritten}=normaliseSources(input.localization.sources,input.requestId,snapshot.sources);
  skipped.push(...notWritten);
  for(const item of write){statements.push([SOURCE_UPSERT,[id,item.source,item.value,item.sourceVersion,JSON.stringify(item.provenance??null),input.requestId,item.observedAt,at]]);changes.push('source:'+item.source);}
  const effective=effectiveLocalization(snapshot,write);
  if(effective.tier==='automatic'){
   const state={dimension:'localization',status:'provisional',source:effective.source,sourceVersion:effective.sourceVersion??null,provenance:effective.provenance??null,value:effective.value,updatedAt:effective.at||at,attempts:0,nextAction:'none'};
   const params=dimensionParams(id,state),row=snapshot.dimensions.localization;
   if(!sameDimension(row,params)){changes.push('dimension:localization');statements.push([dimensionUpsert(),params]);}
  }else if(effective.tier!=='none')skipped.push({field:'localization',reason:effective.tier==='owner'?'owner_kept':'reviewed_kept'});
 }
 // (b) film_metadata
 if(input.metadata===null){
  if(snapshot.metadata)changes.push('metadata:clear');
  statements.push(['DELETE FROM film_metadata WHERE film_id=?',[id]]);
 }else if(input.metadata!==undefined){
  if(!plain(input.metadata)||typeof input.metadata.updatedAt!=='string'||!input.metadata.updatedAt)throw failed('film_person_invalid');
  const merged=mergeMetadata(snapshot.metadata,input.metadata),params=metadataParams(id,merged),row=snapshot.metadata;
  const same=!!row&&['schema_version','year','runtime','synopsis','poster','url','genres_json','people_version','payload_json','r2_key','content_sha256'].every((name,index)=>(row[name]??null)===(params[index+1]??null));
  if(!same)changes.push('metadata');
  statements.push([METADATA_UPSERT,params]);
 }
 // (c) film_sync_state
 if(input.sync===null){
  if(snapshot.sync)changes.push('sync:release');
  statements.push(['DELETE FROM film_sync_state WHERE film_id=?',[id]]);
 }else if(input.sync!==undefined){
  if(!plain(input.sync))throw failed('film_person_invalid');
  const held=snapshot.sync||{};
  const pick=(next,old)=>blank(next)?(old??null):next;
  const final=[pick(input.sync.metadataAt,held.metadata_at),pick(input.sync.synopsisFetchedAt,held.synopsis_fetched_at),Number.isInteger(input.sync.peopleNamesVersion)?input.sync.peopleNamesVersion:(held.people_names_version??null),pick(input.sync.peopleLocalizedAt,held.people_localized_at)];
  const same=!!snapshot.sync&&final[0]===(held.metadata_at??null)&&final[1]===(held.synopsis_fetched_at??null)&&final[2]===(held.people_names_version??null)&&final[3]===(held.people_localized_at??null);
  if(!same)changes.push('sync');
  statements.push([SYNC_UPSERT,[id,...final]]);
 }
 // (d) watchlist membership
 if(input.watchlist===true){
  if(!snapshot.member)changes.push('membership:set');
  statements.push(['INSERT INTO watchlist_film (film_id,updated_at) VALUES (?,?) ON CONFLICT(film_id) DO UPDATE SET updated_at=excluded.updated_at',[id,updatedAt]]);
 }else if(input.watchlist===false){
  if(snapshot.member)changes.push('membership:clear');
  statements.push(['DELETE FROM watchlist_film WHERE film_id=?',[id]]);
 }else if(input.watchlist!==undefined)throw failed('film_person_invalid');
 if(statements.length+4>MUTATION_STATEMENT_CAP)throw failed('film_person_bounded');
 return {id,statements,changes,skipped,noop:changes.length===0};
}

// The fenced write of the film-side producer facts of ONE Film. Refuses before the database unless the marker is open. A call whose rows are all
// stored already (a replay, or a settled unknown outcome) opens no batch. input: see planFilmFacts, plus expectedRevision.
export async function writeFilmFacts(env,input){
 const id=fenced.filmId(input?.id),expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at);
 fenced.text(input.requestId);
 const gate=assertWritable(await readAuthority(env));
 const snapshot=await readFilmSnapshot(env,id);
 const plan=planFilmFacts(snapshot,input);
 if(plan.noop)return {id,revision:snapshot.revision,written:false,reason:'unchanged',skipped:plan.skipped};
 const entities=[{kind:'film',id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql('NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)'),[id]]);
 statements.push(...plan.statements);
 statements.push([fenced.BUMP,['film',id,at]]);
 await fenced.commit(env,gate,statements,entities);
 return {id,revision:expected+1,written:true,changes:plan.changes,skipped:plan.skipped};
}

// Read-only. Does D1 already hold every row the call would write? Used by producers.readback to settle an unknown outcome by CONTENT.
export async function filmFactsPresent(db,input){
 try{
  const snapshot=await readFilmSnapshot(db,input.id);
  return !snapshot.redirect&&planFilmFacts(snapshot,input).noop;
 }catch{return false;}
}
