// AIR-368 / ADR 0099 (Accepted), decision 5. Automatic localization SOURCE values for canonical Film/Person and the one precedence contract
// that resolves the effective title or name: owner > reviewed dictionary > automatic. Inactive: nothing in the Worker imports this module
// (it is not bundled and no route, job or cron calls it), schema 14 is a file only, and while the marker is r2 or prepared the enrichment
// projector stays the only canonical writer, so recordLocalizationSources refuses before it reaches the database.
// - film_localization_source / person_localization_source hold AUTOMATIC candidates only, one row per (entity, source), with the source
//   version, provenance and a replay key. They never hold an owner or a reviewed value and are never written into film_dimension /
//   person_dimension, whose single effective value and owner_review_entry stay the authority of their own domains.
// - resolveLocalization is pure. The loaders only read. compareLocalization classifies what the existing R2 path produced against the
//   resolved value (compare-only: it changes nothing and has no caller yet). AIR-372 consumes resolveLocalization/readLocalization.
import {assertWritable,database,failed,many,readAuthority,readSource} from './film-person-authority.js';
import {fenced} from './canonical-mutations.js';

export const LOCALIZATION_SOURCE_CAP=10;
export const LOCALIZATION_READ_CHUNK=80;
// Within the automatic tier, a fixed source order breaks a disagreement; then the newer observation; then the source name.
export const AUTOMATIC_SOURCE_ORDER=['letterboxd','tmdb','wikidata','epg','discovery'];
const RESERVED=new Set(['owner','dictionary','reviewed']);
const SOURCE=/^[a-z][a-z0-9_]{0,39}$/;
const TABLE={film:{table:'film_localization_source',column:'film_id',dimension:'film_dimension',entity:'film'},person:{table:'person_localization_source',column:'person_id',dimension:'person_dimension',entity:'person'}};

const parse=value=>{if(value==null)return null;if(typeof value==='object')return value;try{return JSON.parse(value);}catch{return undefined;}};
const clock=value=>{const ms=Date.parse(value);return Number.isFinite(ms)?ms:NaN;};
// observedAt is accepted as ISO 8601 with an explicit offset and stored as normalized UTC, so the text order in SQL is the chronological order.
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const instant=value=>{if(typeof value!=='string'||!ISO.test(value))return null;const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;};
const present=value=>typeof value==='string'&&value.trim().length>0;
const storedProvenance=text=>{if(text==null)return null;const value=parse(text);return value===undefined?'{bad':value;};
const stable=value=>JSON.stringify(value===undefined?null:value);

// An automatic candidate must carry a value, a source and an object provenance that does not claim a higher tier. The reason says why not.
function checkAutomatic(item){
 if(!item||typeof item!=='object')return 'malformed';
 if(!present(item.value))return 'empty_value';
 if(typeof item.source!=='string'||!SOURCE.test(item.source)||RESERVED.has(item.source))return 'invalid_source';
 const provenance=parse(item.provenance);
 if(provenance===undefined||(provenance!==null&&(typeof provenance!=='object'||Array.isArray(provenance))))return 'malformed_provenance';
 if(provenance&&(RESERVED.has(provenance.authority)||provenance.status==='reviewed'))return 'inconsistent_provenance';
 return null;
}

// Pure. owner: {value,at?,provenance?} from owner_review_entry (or a dimension the owner wrote); reviewed: {value,source?,at?} the dictionary;
// automatic: [{source,value,sourceVersion?,provenance?,observedAt?}]. Returns the effective value, its tier and source, the lower-tier values
// held back (alias candidates, never written here) and the automatic candidates that were rejected. A lower tier can never replace a higher one,
// whatever the clocks say, so a late metadataSync, projector or automatic localization cannot overwrite an owner or reviewed value.
export function resolveLocalization({owner=null,reviewed=null,automatic=[]}={}){
 const held=[],rejected=[];
 const candidates=[];
 for(const item of automatic||[]){
  const reason=checkAutomatic(item);
  if(reason){rejected.push({source:item?.source??null,value:item?.value??null,reason});continue;}
  candidates.push({source:item.source,value:item.value.trim(),sourceVersion:item.sourceVersion??null,provenance:parse(item.provenance),observedAt:item.observedAt??null});
 }
 const rank=source=>{const index=AUTOMATIC_SOURCE_ORDER.indexOf(source);return index<0?AUTOMATIC_SOURCE_ORDER.length:index;};
 candidates.sort((a,b)=>rank(a.source)-rank(b.source)||(clock(b.observedAt)||0)-(clock(a.observedAt)||0)||(a.source<b.source?-1:a.source>b.source?1:0));
 let effective=null;
 if(owner&&present(owner.value))effective={value:owner.value.trim(),tier:'owner',source:'owner',at:owner.at??null};
 else if(reviewed&&present(reviewed.value))effective={value:reviewed.value.trim(),tier:'reviewed',source:reviewed.source||'dictionary',at:reviewed.at??null};
 else if(candidates.length){const best=candidates[0];effective={value:best.value,tier:'automatic',source:best.source,sourceVersion:best.sourceVersion,provenance:best.provenance,at:best.observedAt};}
 if(!effective)return {value:null,tier:'none',source:null,held,rejected};
 if(effective.tier==='automatic'){
  for(const item of candidates.slice(1))if(item.value!==effective.value)held.push({value:item.value,source:item.source,tier:'automatic',reason:'automatic_lower_priority'});
 }else{
  if(effective.tier==='owner'&&reviewed&&present(reviewed.value)&&reviewed.value.trim()!==effective.value)held.push({value:reviewed.value.trim(),source:reviewed.source||'dictionary',tier:'reviewed',reason:'owner_kept'});
  const reason=effective.tier==='owner'?'owner_kept':'reviewed_kept';
  for(const item of candidates)if(item.value!==effective.value)held.push({value:item.value,source:item.source,tier:'automatic',reason});
 }
 return {...effective,held,rejected};
}

// Read only. The stored inputs of resolveLocalization for entities of one kind: the owner/reviewed/provisional dimension row, the source rows.
// An owner value comes from `ownerValues` (id -> {value,at}) when the caller read it from owner_review_entry, else from a dimension the owner wrote.
export async function loadLocalizationInputs(env,kind,ids,{ownerValues=null}={}){
 const spec=TABLE[kind];
 if(!spec)throw failed('localization_invalid');
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const list=[...new Set(ids||[])];
 const out=new Map(list.map(id=>[id,{owner:null,reviewed:null,automatic:[]}]));
 for(let at=0;at<list.length;at+=LOCALIZATION_READ_CHUNK){
  const chunk=list.slice(at,at+LOCALIZATION_READ_CHUNK),marks=chunk.map(()=>'?').join(',');
  let dimensions,sources;
  try{
   [dimensions,sources]=await Promise.all([
    many(db,`SELECT ${spec.column} id,status,source,source_version,provenance_json,value,authority,updated_at FROM ${spec.dimension} WHERE dimension='localization' AND ${spec.column} IN (${marks})`,chunk),
    many(db,`SELECT ${spec.column} id,source,value,source_version,provenance_json,observed_at FROM ${spec.table} WHERE ${spec.column} IN (${marks})`,chunk),
   ]);
  }catch(error){throw failed('localization_source_unavailable',error);}
  const bySource=new Map();
  for(const row of sources){
   const input=out.get(row.id);
   input.automatic.push({source:row.source,value:row.value,sourceVersion:row.source_version,provenance:storedProvenance(row.provenance_json),observedAt:row.observed_at});
   bySource.set(row.id+'\u0000'+row.source,true);
  }
  for(const row of dimensions){
   const input=out.get(row.id);
   if(row.status==='reviewed'&&row.value){
    if(row.authority==='owner')input.owner={value:row.value,at:row.updated_at};
    else input.reviewed={value:row.value,source:row.source||'dictionary',at:row.updated_at};
   }else if(row.status==='provisional'&&row.value&&row.source&&!RESERVED.has(row.source)&&!bySource.has(row.id+'\u0000'+row.source)){
    // The legacy provisional dimension is an automatic candidate of its own source; a source row of the same source is the newer record.
    input.automatic.push({source:row.source,value:row.value,sourceVersion:row.source_version,provenance:storedProvenance(row.provenance_json),observedAt:row.updated_at});
   }
  }
 }
 if(ownerValues)for(const [id,value] of Object.entries(ownerValues instanceof Map?Object.fromEntries(ownerValues):ownerValues)){const input=out.get(id);if(input&&value&&present(value.value))input.owner={value:value.value,at:value.at??null};}
 return out;
}

// The D1 reader for AIR-372. D1 is the allowed source only while the marker is open: r2, prepared, legacy and unreadable states are not
// authoritative for this read, and held fails closed without ever naming R2.
export async function readLocalization(env,kind,ids,options={}){
 if(readSource(await readAuthority(env))!=='d1')throw failed('localization_not_authoritative');
 const inputs=await loadLocalizationInputs(env,kind,ids,options);
 return new Map([...inputs].map(([id,input])=>[id,resolveLocalization(input)]));
}

// Compare-only (inactive): what a localization produced by the existing R2 path (metadataSync/localize*) would be next to the resolved value.
// `incoming` is that entity's localization state {status,value,source,provenance}. Nothing is written, nothing is promoted.
export function compareLocalization(resolved,incoming){
 const value=present(incoming?.value)?incoming.value.trim():null;
 const authority=incoming?.provenance?.authority;
 if(incoming?.status==='reviewed'||RESERVED.has(incoming?.source)||RESERVED.has(authority))return {outcome:'not_automatic',candidate:null,effective:resolved.value,tier:resolved.tier};
 if(!value)return {outcome:'no_value',candidate:null,effective:resolved.value,tier:resolved.tier};
 const candidate={source:incoming.source,value,sourceVersion:incoming.sourceVersion??null,provenance:incoming.provenance??null,observedAt:incoming.updatedAt??null};
 if(checkAutomatic(candidate))return {outcome:'rejected',reason:checkAutomatic(candidate),candidate:null,effective:resolved.value,tier:resolved.tier};
 if(resolved.tier==='none')return {outcome:'new',candidate,effective:null,tier:'none'};
 if(resolved.value===value)return {outcome:'same',candidate,effective:resolved.value,tier:resolved.tier};
 if(resolved.tier==='owner'||resolved.tier==='reviewed')return {outcome:'held_by_'+resolved.tier,candidate,effective:resolved.value,tier:resolved.tier};
 return {outcome:'differs',candidate,effective:resolved.value,tier:resolved.tier};
}

// The fenced write of automatic source values for ONE entity (a later card calls it; nothing does today). One batch proves the marker
// generation and the entity revision, requires the entity to exist and (for a Film) not to be a redirect, upserts each source only when
// the observation is newer than the stored one, and bumps the revision. A replay (the same request id, the same content) is a no-op that
// returns without a batch; the same request id with other content is refused. Owner, reviewed or dictionary values cannot be written here.
// input: {kind:'film'|'person', id, expectedRevision, at, requestId, sources:[{source,value,sourceVersion,provenance?,observedAt}]}
export async function recordLocalizationSources(env,input){
 const spec=TABLE[input?.kind];
 if(!spec)throw failed('localization_invalid');
 const id=spec.entity==='film'?fenced.filmId(input.id):fenced.personId(input.id);
 const expected=fenced.revisionOf(input.expectedRevision),at=fenced.text(input.at),requestId=fenced.text(input.requestId);
 const tail=fenced.receiptTail(input.receiptMark,{kind:spec.entity,id});
 const list=Array.isArray(input.sources)?input.sources:[];
 if(!list.length||list.length>LOCALIZATION_SOURCE_CAP)throw failed('localization_invalid');
 const seen=new Set();
 for(const item of list){
  if(checkAutomatic(item)||!present(item.sourceVersion)||instant(item.observedAt)===null||seen.has(item.source))throw failed('localization_invalid');
  seen.add(item.source);
 }
 const gate=assertWritable(await readAuthority(env));
 const db=database(env);
 let stored;
 try{stored=await many(db,`SELECT source,value,source_version,provenance_json,request_id,observed_at FROM ${spec.table} WHERE ${spec.column}=?`,[id]);}
 catch(error){throw failed('localization_source_unavailable',error);}
 const known=new Map(stored.map(row=>[row.source,row]));
 const write=[],skipped=[];
 for(const item of list){
  const row=known.get(item.source),value=item.value.trim(),provenance=stable(parse(item.provenance)),observed=instant(item.observedAt);
  if(row&&row.request_id===requestId){
   if(row.value!==value||row.source_version!==item.sourceVersion||stable(parse(row.provenance_json))!==provenance||row.observed_at!==observed)throw failed('localization_replay_mismatch');
   skipped.push({source:item.source,reason:'replay'});continue;
  }
  if(row&&!(observed>row.observed_at)){skipped.push({source:item.source,reason:'stale'});continue;}
  write.push({...item,value,provenance,observedAt:observed});
 }
 if(!write.length)return {id,revision:expected,written:[],skipped};
 const exists=spec.entity==='film'?'EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)':'EXISTS (SELECT 1 FROM person WHERE id=?)';
 const entities=[{kind:spec.entity,id,expected}];
 const statements=fenced.head(gate,entities);
 statements.push([fenced.assertSql(exists),spec.entity==='film'?[id,id]:[id]]);
 for(const item of write){
  statements.push([`INSERT INTO ${spec.table} (${spec.column},source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(${spec.column},source) DO UPDATE SET value=excluded.value,source_version=excluded.source_version,provenance_json=excluded.provenance_json,request_id=excluded.request_id,observed_at=excluded.observed_at,updated_at=excluded.updated_at WHERE excluded.observed_at>${spec.table}.observed_at`,[id,item.source,item.value,item.sourceVersion,item.provenance,requestId,item.observedAt,at]]);
 }
 statements.push([fenced.BUMP,[spec.entity,id,at]]);
 await fenced.commit(env,gate,statements,entities,tail);
 return {id,revision:expected+1,written:write.map(item=>item.source),skipped};
}
