// AIR-605 (card C1; ADR 0211 as amended by ADR 0219). The PURE planner of the Catalog Enrichment Producer: no storage, no network, no clock but the `now` it is given.
// DORMANT: nothing in the Worker imports it yet. It decides, from what was read, WHICH fields and credits may be written, which must wait and why, and what is visible (conflicts, hints, gaps); the producer
// executes the answer through the existing fenced writers. Everything here is deterministic and tested offline (tests/catalog-enrichment-plan.mjs).

export const SOURCES=Object.freeze(['letterboxd','tmdb','wikidata']);
export const CORE_FIELDS=Object.freeze(['year','runtime','synopsis','poster','url','genres']);
// ADR 0211 decision 2: the fixed precedence of a blank core field. Genres are not compared across sources (different vocabularies).
export const CORE_ORDER=Object.freeze(['letterboxd','tmdb']);
export const FALLBACK_MS=72*3600*1000; // 0211-7 = B: unavailable through upstream transport for 72 h continuously
export const RUNTIME_TOLERANCE_MIN=5;
export const CHUNK_SIZE=50; // the existing credits unit cap, kept as the chunk size (ADR 0219 decision 8)
export const REPAIR_AFTER_FAILURES=6;
const MINUTE=60000,HOUR=3600000;
// SHA-256 of canonical JSON (object keys sorted, undefined dropped, no clocks): the planner imports nothing, so it stays outside the receipt modules' dormancy surface.
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':plain(value)?'{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value??null);
export const canonicalJson=canonical;
export async function digestOf(value){
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));
 return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const blank=value=>value===undefined||value===null||(typeof value==='string'&&value.trim()==='')||(Array.isArray(value)&&!value.length);

// ---- anchors (decision 2) ----
// rows: every `film_external_id` row of the Film in the schemes tmdb and letterboxd, each {scheme, value, trusted, conflicting, otherOwner, retired}. `otherOwner`: another Film holds that (scheme, value) as a trusted claim.
// `retired`: an owner retirement of that TMDB movie id for this Film stands. A source has an anchor only when exactly ONE trusted, non-conflicting row of its scheme exists and it still holds its whole rule.
export function computeAnchors(rows){
 const list=(rows||[]).filter(row=>row&&(row.scheme==='tmdb'||row.scheme==='letterboxd')&&Number(row.trusted)===1);
 const holds=row=>Number(row.conflicting)===0&&!row.otherOwner&&!row.retired;
 const anchorOf=scheme=>{
  const candidates=list.filter(row=>row.scheme===scheme&&Number(row.conflicting)===0);
  return candidates.length===1&&holds(candidates[0])?{scheme,value:String(candidates[0].value)}:null;
 };
 const digestRows=list.map(row=>[row.scheme,String(row.value),1,Number(row.conflicting),row.retired?1:0,holds(row)?1:0]).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1);
 return {letterboxd:anchorOf('letterboxd'),tmdb:anchorOf('tmdb'),digestRows,plannedCount:list.filter(row=>Number(row.conflicting)===0).length};
}
// SHA-256 of the sorted anchors (scheme, value, trusted, conflicting, retired, holds): the `anchor_digest` of decision 3b.
export async function anchorDigest(anchors){return digestOf({anchors:anchors.digestRows});}
// The sources whose anchor holds. Wikidata rides on the TMDB anchor; a source without an anchor is `not_applicable` and is never fetched.
export function applicableSources(anchors){
 const out=[];
 if(anchors.letterboxd)out.push('letterboxd');
 if(anchors.tmdb)out.push('tmdb','wikidata');
 return out;
}
// The commit guard of a unit: ONE compound condition asserted in its own fenced batch (decision 3). Every anchor the plan used still holds by its exact (scheme, value): trusted, non-conflicting, singly owned, and for tmdb
// not retired; and NO other trusted non-conflicting letterboxd or tmdb row of the Film exists beyond the planned ones. -> {sql, params}.
export function anchorSetGuard(filmId,anchors){
 const planned=['letterboxd','tmdb'].map(scheme=>anchors[scheme]).filter(Boolean);
 const parts=[`(SELECT COUNT(*) FROM film_external_id WHERE film_id=? AND scheme IN ('letterboxd','tmdb') AND trusted=1 AND conflicting=0)=?`];
 const params=[filmId,anchors.plannedCount];
 for(const anchor of planned){
  parts.push(`EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme=? AND value=? AND trusted=1 AND conflicting=0)`,
   `NOT EXISTS (SELECT 1 FROM film_external_id WHERE scheme=? AND value=? AND trusted=1 AND film_id<>?)`);
  params.push(filmId,anchor.scheme,anchor.value,anchor.scheme,anchor.value,filmId);
  if(anchor.scheme==='tmdb'){
   parts.push(`NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision r WHERE r.film_id=? AND r.movie_id=? AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq))`);
   params.push(filmId,anchor.value);
  }
 }
 return {sql:parts.join(' AND '),params};
}
// The plan epoch guard: the unit's own state row and the Film row still carry the epochs the plan read.
export function epochGuard(filmId,{part,source,slot=0,refreshEpoch,planEpoch}){
 return {sql:`(SELECT COUNT(*) FROM catalog_enrichment_state WHERE film_id=? AND part='film' AND source='*' AND plan_epoch=?)=1 AND (SELECT COUNT(*) FROM catalog_enrichment_state WHERE film_id=? AND part=? AND source=? AND slot=? AND refresh_epoch=?)=1`,params:[filmId,planEpoch,filmId,part,source,slot,refreshEpoch]};
}
// The lease and control guards every batch of the producer asserts.
export function leaseGuard(leaseId,now){return {sql:`EXISTS (SELECT 1 FROM projection_run WHERE projection='catalog_enrichment' AND lease_id=? AND lease_until>?)`,params:[leaseId,now]};}
export function controlGuard(generation){return {sql:`EXISTS (SELECT 1 FROM catalog_enrichment_control WHERE id=1 AND state='active' AND generation=?)`,params:[generation]};}
// One per-field blank guard of the core batch: the stored value is still blank (fill-only, re-asserted in the batch).
const FIELD_COLUMN={year:'year',runtime:'runtime',synopsis:'synopsis',poster:'poster',url:'url',genres:'genres_json'};
export function blankFieldGuard(filmId,field){
 const column=FIELD_COLUMN[field];
 if(!column)throw new Error('unknown_core_field');
 const empty=field==='genres'?`(${column} IS NULL OR ${column} IN ('','[]'))`:`(${column} IS NULL OR ${column}='')`;
 return {sql:`NOT EXISTS (SELECT 1 FROM film_metadata WHERE film_id=? AND NOT ${empty})`,params:[filmId]};
}

// ---- retry and failure classes (decisions 3 and 7) ----
// Transport backoff, as ADR 0207 decision 4b: 15 min · 2^min(streak − 1, 5), at most 8 h. A transport outcome consumes no failure.
export const transportDelayMs=streak=>15*MINUTE*2**Math.min(Math.max(streak-1,0),5);
// Repairable failures: bounded retries with the same growth up to the sixth; after it the item is `deferred_repair` and is rechecked at 1 h, then 6 h, then 24 h forever, never permanently terminal.
export function repairDelayMs(failures){
 if(failures<REPAIR_AFTER_FAILURES)return transportDelayMs(failures);
 return [HOUR,6*HOUR,24*HOUR][Math.min(failures-REPAIR_AFTER_FAILURES,2)];
}
// An upstream answer to its class. transport: 403, a challenge, 429, 5xx, a timeout of a request that was sent, a network error, an active cooldown. owner: a VERIFIED identity disagreement or an ambiguous translation.
// repairable: everything else, a 404 of an anchored entity included (availability, never identity, never a retirement, no fallback).
export function classifyFailure({status=null,kind=null}={}){
 if(kind==='cooldown'||kind==='timeout'||kind==='network'||kind==='challenge')return 'transport';
 if(status===403||status===429||(Number.isInteger(status)&&status>=500&&status<=599))return 'transport';
 if(kind==='identity_disagreement'||kind==='ambiguous_translation'||kind==='owner_locked')return 'owner_required';
 return 'repairable';
}
// What one failure does to a state row. `local` stops (a handover, a yield, a pause, a lost lease, a resource stop) change nothing at all. -> the next fields of the row.
export function afterOutcome(row,outcome,now){
 const at=Date.parse(now);
 if(outcome.type==='local_stop')return {...row};
 if(outcome.type==='success')return {...row,failures:0,transportStreak:0,pendingSince:null,retryAt:null,failureClass:null};
 if(outcome.type==='transport'){
  const streak=(row.transportStreak||0)+1;
  return {...row,transportStreak:streak,pendingSince:row.pendingSince||now,retryAt:new Date(Math.max(at+transportDelayMs(streak),outcome.cooldownUntil?Date.parse(outcome.cooldownUntil):0)).toISOString(),failureClass:'transport'};
 }
 if(outcome.type==='owner_required')return {...row,status:'needs_attention',failureClass:'owner_required',pendingSince:null};
 const failures=(row.failures||0)+1;
 return {...row,failures,status:failures>=REPAIR_AFTER_FAILURES?'deferred_repair':row.status,failureClass:'repairable',failureSignature:outcome.signature||null,responseDigest:outcome.responseDigest||null,transportStreak:0,pendingSince:null,retryAt:new Date(at+repairDelayMs(failures)).toISOString()};
}
export const fallbackElapsed=(pendingSince,now)=>!!pendingSince&&Date.parse(now)-Date.parse(pendingSince)>=FALLBACK_MS;

// ---- the core decision (decision 2) ----
// the fields whose language quality ranks before the provider (ADR 0224); the language of a source's value comes from its typed observation (`answer.language[field]`: `ru`, `en` or null)
const LANGUAGE_FIELDS=Object.freeze(['synopsis','poster']);
const languageRank=(answer,field)=>({ru:2,en:1})[answer?.language?.[field]]||0;
const equalYear=(a,b)=>Number(a)===Number(b);
const equalRuntime=(a,b)=>Math.abs(Number(a)-Number(b))<=RUNTIME_TOLERANCE_MIN;
const COMPARE={year:equalYear,runtime:equalRuntime};
// state of one source for one field: value | absent | pending | failed | not_applicable
function fieldState(source,field,{applicable,answers}){
 if(!applicable.includes(source))return 'not_applicable';
 const answer=answers[source];
 if(!answer||answer.status==='stopped'||answer.status==='transport')return 'pending';
 if(answer.status==='failed')return 'failed';
 // a field whose coverage in an OK answer is unreadable or ambiguous is UNRESOLVED: it is neither a value nor an absence, so no lower-priority source may pass through it and the part cannot settle on it
 const coverage=answer.coverage?.[field];
 if(coverage==='unreadable'||coverage==='ambiguous')return 'unresolved';
 return blank(answer.fields?.[field])?'absent':'value';
}
// input: {applicable, hasLetterboxdAnchor, agreed, disagreement, stored:{field->value}, answers:{source->{status:'ok'|'transport'|'failed'|'stopped', fields}}, pendingSince:{source->iso|null}, now}
// -> {blocked, writes:{field->{source,value}}, waiting:{field->{reason,source,retryable}}, fallbackFill:[{field,source,waitedFor}], unconfirmedAgreement:[field], conflicts, storedDiffers, complete, gaps}
export function decideCore(input){
 const {applicable,hasLetterboxdAnchor,agreed,disagreement,stored,answers,pendingSince={},now}=input;
 const out={blocked:null,writes:{},waiting:{},fallbackFill:[],unconfirmedAgreement:[],conflicts:[],storedDiffers:[],complete:false,gaps:[]};
 // value conflicts and stored differences are visible whatever happens next; neither changes a claim.
 for(const field of CORE_FIELDS){
  if(!COMPARE[field])continue;
  const seen=CORE_ORDER.filter(source=>applicable.includes(source)&&answers[source]?.status==='ok'&&!blank(answers[source].fields?.[field])).map(source=>[source,answers[source].fields[field]]);
  for(let i=1;i<seen.length;i++)if(!COMPARE[field](seen[0][1],seen[i][1])){out.conflicts.push({field,values:Object.fromEntries(seen)});break;}
  if(!blank(stored[field]))for(const [source,value] of seen)if(!COMPARE[field](stored[field],value))out.storedDiffers.push({field,source,stored:stored[field],value});
 }
 if(disagreement){out.blocked='identity_disagreement';return out;}
 const blanks=CORE_FIELDS.filter(field=>blank(stored[field]));
 let nothingMissing=true;
 for(const field of blanks){
  let decided=false,fallbackOver=null;
  for(const source of CORE_ORDER){
   const state=fieldState(source,field,input);
   if(state==='not_applicable'||state==='absent')continue;
   if(state==='value'){
    // ADR 0224: for the synopsis and the poster ONLY, verified language quality ranks before provider preference at equal confirmed confidence (Russian above English above unknown). Among the sources that have a VALUE for this
    // blank field now, the best language wins and the fixed source order breaks a tie; nothing here waits for another source, widens a refresh or replaces a stored value (the field is blank).
    let chosen=source;
    if(LANGUAGE_FIELDS.includes(field))for(const later of CORE_ORDER.slice(CORE_ORDER.indexOf(source)+1))if(fieldState(later,field,input)==='value'&&languageRank(answers[later],field)>languageRank(answers[chosen],field))chosen=later;
    // Letterboxd's own value needs a recorded agreement whenever the Film holds a Letterboxd anchor; a value of the other source needs it too, unless every earlier source is only transport-unavailable for 72 h.
    if(hasLetterboxdAnchor&&!agreed&&!fallbackOver){out.waiting[field]={reason:'waiting_for_agreement',source:chosen};decided=true;break;}
    out.writes[field]={source:chosen,value:answers[chosen].fields[field]};
    if(fallbackOver){out.fallbackFill.push({field,source:chosen,waitedFor:fallbackOver});if(hasLetterboxdAnchor&&!agreed)out.unconfirmedAgreement.push(field);}
    decided=true;break;
   }
   if(state==='failed'){out.waiting[field]={reason:'failed_source',source,retryable:false};decided=true;break;}
   if(state==='unresolved'){out.waiting[field]={reason:'unverified_coverage',source,retryable:true};decided=true;break;}
   // pending: the transport-only fallback applies only after 72 h of upstream transport (pendingSince is set by a transport outcome alone), and never over a known disagreement or a failure.
   if(fallbackElapsed(pendingSince[source],now)){fallbackOver=fallbackOver||source;continue;}
   out.waiting[field]={reason:'waiting_for_precedence',source,retryable:true};decided=true;break;
  }
  if(!decided){nothingMissing=false;out.gaps.push(field);}
 }
 out.complete=blanks.every(field=>out.writes[field]||out.gaps.includes(field))&&!Object.keys(out.waiting).length;
 return out;
}

// ---- credits (decisions 2 and 8) ----
// A person id is person:<role>/<key>. Letterboxd persons are actor/<slug>, director/<slug>; TMDB persons tmdb_actor/<id>, tmdb_director/<id>. One namespace per Film.
export function namespaceOf(personId){
 const match=/^person:(actor|director|tmdb_actor|tmdb_director)\//.exec(String(personId||''));
 if(!match)return null;
 return match[1].startsWith('tmdb_')?'tmdb':'letterboxd';
}
// existing: the person ids of the Film's credits; applicable: the applicable sources. -> {source|null, gap|null}
// The credit source is fixed when `credits` is first planned and never reopened. Both namespaces present: nothing is written and the gap is visible. One namespace: that source, only when it is applicable. None: letterboxd if anchored, else tmdb.
export function creditSource(existing,applicable){
 const spaces=new Set((existing||[]).map(namespaceOf).filter(Boolean));
 if(spaces.size>1)return {source:null,gap:'credits_other_namespace'};
 if(spaces.size===1){const only=[...spaces][0];return applicable.includes(only)?{source:only,gap:null}:{source:null,gap:null};}
 if(applicable.includes('letterboxd'))return {source:'letterboxd',gap:null};
 if(applicable.includes('tmdb'))return {source:'tmdb',gap:null};
 return {source:null,gap:null};
}
// The expected set of a source's COMPLETE response: every supported credit (actor, director), deduplicated by (person, role), in source order. A Letterboxd credit whose id would be the display name is a gap
// (`name_only_credit`), never written. credits: [{role, key|null, name?}]. -> {items:[{personId, role, roleId}], gaps:[...]}
export function expectedCredits(source,credits){
 const seen=new Set(),items=[],gaps=[];
 for(const credit of credits||[]){
  if(credit.role!=='actor'&&credit.role!=='director')continue;
  if(blank(credit.key)||(source==='letterboxd'&&credit.nameOnly)){if(source==='letterboxd')gaps.push({gap:'name_only_credit',name:credit.name??null});continue;}
  const roleId=(source==='tmdb'?'tmdb_'+credit.role:credit.role)+'/'+String(credit.key);
  const personId='person:'+roleId,key=personId+'|'+credit.role;
  if(seen.has(key))continue;
  seen.add(key);items.push({personId,role:credit.role,roleId});
 }
 return {items,gaps};
}
// Stable chunks of at most CHUNK_SIZE in the deterministic order of the expected set; a chunk names the slot n.
export function chunkCredits(items,size=CHUNK_SIZE){
 const chunks=[];
 for(let i=0;i<items.length;i+=size)chunks.push({slot:i/size,items:items.slice(i,i+size)});
 return chunks;
}
export async function expectedDigest(items){return digestOf({expected:items.map(item=>[item.personId,item.role])});}
// What a chunk still lacks, judged by PERSON IDENTITY (not ordinal): persons to create first, then credits to add. have: Set of `personId|role`, people: Set of existing person ids.
export function missingForChunk(chunk,{have,people}){
 const credits=chunk.items.filter(item=>!have.has(item.personId+'|'+item.role));
 return {credits,persons:[...new Set(credits.filter(item=>!people.has(item.personId)).map(item=>item.personId))]};
}
// A part is complete only when EVERY expected credit exists: never because "ten exist".
export const creditsComplete=(chunks,have)=>chunks.every(chunk=>chunk.items.every(item=>have.has(item.personId+'|'+item.role)));

// ---- 2A: the Russian title from the TMDB response's own translations (decision 4) ----
// -> {status:'value', value} | {status:'absent'} (a legitimate absence) | {status:'ambiguous'} (owner) | {status:'unreadable'} (a missing or malformed section: a repairable failure)
export function selectRussianTitle(translations){
 if(!plain(translations)||!Array.isArray(translations.translations))return {status:'unreadable'};
 const ru=[];
 for(const entry of translations.translations){
  if(!plain(entry))return {status:'unreadable'};
  if(entry.iso_639_1!=='ru')continue;
  if(!plain(entry.data))return {status:'unreadable'};
  // a Russian entry without a string `title` is malformed, never a blank: absence is not inferred from a shape that cannot be read
  if(typeof entry.data.title!=='string')return {status:'unreadable'};
  const title=entry.data.title.trim();
  if(title)ru.push({title,region:entry.iso_3166_1});
 }
 const distinct=[...new Set(ru.map(item=>item.title))];
 if(!distinct.length)return {status:'absent'};
 if(distinct.length===1)return {status:'value',value:distinct[0]};
 const regional=[...new Set(ru.filter(item=>item.region==='RU').map(item=>item.title))];
 return regional.length===1?{status:'value',value:regional[0]}:{status:'ambiguous'};
}

// ---- source versions (ADR 0219 decision 2) ----
// ONE pure projection of what a verified response says about a part, used by BOTH the producer (it stores the result as the part's `source_version` when the part is complete) and every observer of the same source
// (the Discovery revalidation), so the two cannot disagree about what a part is. A part whose section is not VERIFIED (an unreadable or unsupported section, a failed response) has no version (null): it is never
// signalled, never compared and never read as "no data". `anchor` is the identity the response was fetched for.
// ---- the Russian-first TMDB observation (ADR 0224) ----
// ONE typed observation of a source's core fields, built by the source's parser (`parseTmdb`, `fetchLetterboxd`) from these pure selectors, written from by the producer and compared by every observer. Each field is
// `{value, language, languageBasis, coverage}`: coverage `verified`, `absent` (a verified, explicit absence), `unreadable` (missing or malformed: never an absence) or `ambiguous`; `language` is `ru`, `en` or null (unknown or any
// other language: never attributed to ru or en); `languageBasis` is `explicit` (a provider tag), `assumed` (the owner-approved assumption for a Letterboxd synopsis only, P4-B) or null. Language and basis are null together.
// The value written is the value that carries the tag: the observation binds them.
export const PROJECTION_VERSION=3;
export const GENRE_MAPPING_REVISION=1;
// The reviewed TMDB genre id -> existing vocabulary (the Russian words of `GENRE_MAP` in `src/sources.js`, keyed there by the English names kept here). No other taxonomy. An id with no entry is a coverage GAP, never an invented label.
export const TMDB_GENRES=Object.freeze({28:['Action','Боевик'],12:['Adventure','Приключения'],16:['Animation','Мультфильм'],35:['Comedy','Комедия'],80:['Crime','Криминал'],99:['Documentary','Документальный'],18:['Drama','Драма'],10751:['Family','Семейный'],14:['Fantasy','Фэнтези'],36:['History','Исторический'],27:['Horror','Ужасы'],10402:['Music','Музыкальный'],9648:['Mystery','Детектив'],10749:['Romance','Мелодрама'],878:['Science Fiction','Фантастика'],10770:['TV Movie','Телефильм'],53:['Thriller','Триллер'],10752:['War','Военный'],37:['Western','Вестерн']});
const isId=value=>typeof value==='number'?Number.isInteger(value):typeof value==='string'&&/^\d+$/.test(value);
const field=(value,coverage,language=null,languageBasis=null)=>({value,language,languageBasis,coverage});
const unreadable=()=>field(null,'unreadable');
// year: a present date string. An EMPTY string is TMDB's explicit "no date"; a missing key or any other shape is unreadable.
export function readYear(releaseDate){
 if(releaseDate==='')return field(null,'absent');
 const match=typeof releaseDate==='string'?/^(\d{4})(-\d{2}-\d{2})?$/.exec(releaseDate):null;
 return match?field(Number(match[1]),'verified'):unreadable();
}
// runtime: a positive integer is a value; null or 0 is TMDB's explicit "unknown"; a missing key, a fraction or a negative is unreadable.
export function readRuntime(runtime){
 if(runtime===null||runtime===0)return field(null,'absent');
 return Number.isInteger(runtime)&&runtime>0?field(runtime,'verified'):unreadable();
}
// -> {coverage, value:[labels], ids:[sorted numeric strings], unmapped:[ids]}. A missing or malformed list is unreadable; a present empty list is a valid empty set.
export function mapGenres(genres){
 if(!Array.isArray(genres)||!genres.every(item=>plain(item)&&isId(item.id)))return {coverage:'unreadable',value:[],ids:[],unmapped:[]};
 const ids=[...new Set(genres.map(item=>String(item.id)))].sort((a,b)=>Number(a)-Number(b));
 return {coverage:'verified',value:ids.filter(id=>TMDB_GENRES[id]).map(id=>TMDB_GENRES[id][1]),ids,unmapped:ids.filter(id=>!TMDB_GENRES[id])};
}
// The `translations` section as the selectors need it: every entry a plain object with string language and region tags and a plain `data`; an entry of Russian or English must carry a string `overview` (an explicit empty string is a
// verified blank; a missing or non-string one is malformed, never a blank). Anything else is unreadable: absence is never inferred from a shape that cannot be read.
function readTranslations(translations){
 if(!plain(translations)||!Array.isArray(translations.translations))return null;
 for(const entry of translations.translations){
  if(!plain(entry)||typeof entry.iso_639_1!=='string'||typeof entry.iso_3166_1!=='string'||!plain(entry.data))return null;
  if((entry.iso_639_1==='ru'||entry.iso_639_1==='en')&&typeof entry.data.overview!=='string')return null;
 }
 return translations.translations;
}
// The synopsis: a nonblank overview of an explicitly tagged Russian `translations` entry (several distinct: the RU region decides, otherwise ambiguous); only when Russian is VERIFIED absent, an explicitly tagged English one (US on a
// tie, otherwise one distinct value). The top-level `overview` is never proof of language. A missing, malformed or ambiguous section is not an absence.
export function selectSynopsis(translations){
 const entries=readTranslations(translations);
 if(!entries)return unreadable();
 const pick=(language,region)=>{
  const found=entries.filter(entry=>entry.iso_639_1===language&&entry.data.overview.trim());
  if(!found.length)return {status:'none'};
  const distinct=list=>[...new Set(list.map(entry=>entry.data.overview.trim()))];
  const all=distinct(found);
  if(all.length===1)return {status:'value',value:all[0]};
  const regional=distinct(found.filter(entry=>entry.iso_3166_1===region));
  return regional.length===1?{status:'value',value:regional[0]}:{status:'ambiguous'};
 };
 const ru=pick('ru','RU');
 if(ru.status==='value')return field(ru.value,'verified','ru','explicit');
 if(ru.status==='ambiguous')return field(null,'ambiguous');
 const en=pick('en','US');
 if(en.status==='value')return field(en.value,'verified','en','explicit');
 if(en.status==='ambiguous')return field(null,'ambiguous');
 return field(null,'absent');
}
// The poster: a verified Russian-language image of `images.posters[]`, else an English one, else (P1-A) a language-neutral one (`iso_639_1 = null`), else the top-level `poster_path`, whose language is known only when the same file
// is listed in `images` (its verified tag is kept, whatever the language; no listing is unknown, never attributed). Within a tier the greater width, then the lexically smaller `file_path` (P2-A): votes and list order never decide. A missing or
// malformed images section is unreadable (the value is then the top-level path with no language, for writing only). A top-level `poster_path` that is null is TMDB's explicit "no poster"; a missing key or a bad shape is unreadable.
// -> {value: path, language, languageBasis, coverage}
export function selectPoster(images,topLevel){
 const top=typeof topLevel==='string'&&topLevel.startsWith('/')?topLevel:null;
 const posters=plain(images)&&Array.isArray(images.posters)?images.posters:null;
 if(!posters||!posters.every(item=>plain(item)&&typeof item.file_path==='string'&&item.file_path.startsWith('/')&&Number.isFinite(item.width)&&(item.iso_639_1===null||typeof item.iso_639_1==='string')))return field(top,'unreadable');
 const order=(a,b)=>b.width-a.width||(a.file_path<b.file_path?-1:a.file_path>b.file_path?1:0);
 for(const language of ['ru','en',null]){
  const tier=posters.filter(item=>item.iso_639_1===language).sort(order);
  if(tier.length)return field(tier[0].file_path,'verified',language,language?'explicit':null);
 }
 if(top){
  // the top-level path keeps the VERIFIED tag of the image that lists it (any two-letter language tag, never a guess); a path the images do not list is unknown. Another language ranks below Russian and English in the planner.
  const listed=posters.find(item=>item.file_path===top);
  const language=listed&&typeof listed.iso_639_1==='string'&&/^[a-z]{2}$/.test(listed.iso_639_1)?listed.iso_639_1:null;
  return field(top,'verified',language,language?'explicit':null);
 }
 return topLevel===null?field(null,'absent'):unreadable();
}
// The typed writer declaration of ONE selected field: the single, explicit conversion from the observation to what a provenance writer is told (AIR-631): the source, the anchor, the value that carries the tag, and its language and basis
// (a normalized two-letter tag with `explicit`, the assumed English of a Letterboxd synopsis, or both null). Never a language the observation did not carry.
export function declarationOf(name,source,anchor,item){
 if(!item||item.coverage!=='verified')return null;
 return {field:name,source,anchor:anchor?{scheme:anchor.scheme,value:String(anchor.value)}:null,value:item.value,language:item.language??null,languageBasis:item.languageBasis??null};
}
const comparableCoverage=value=>value==='verified'||value==='absent';
const FIELDS=Object.freeze(['year','runtime','url','synopsis','poster','genres']);
// Which fields of an observation are not verified coverage. -> [field names]
export const unresolvedFields=observation=>FIELDS.filter(name=>{const item=observation?.[name];return !item||!comparableCoverage(item.coverage);});
// The genre field with a verified id list but unmapped ids is still comparable (the gap is recorded and versioned); only an unreadable list is not.
// core: ONE digest for both sources, over the whole typed observation: all six selected fields with their value, language, basis and coverage, the genre ids and the unmapped ids, the genre mapping revision and the projection
// version; never timestamps, votes or the image list. It exists only when EVERY field is verified coverage (a verified absence included); otherwise null: an incomplete observation is never a version.
export function coreVersion(source,anchor,observation){
 if(!observation||unresolvedFields(observation).length)return null;
 const shape=item=>({value:item.value??null,language:item.language??null,basis:item.languageBasis??null,coverage:item.coverage});
 return digestOf({source,anchor,part:'core',projectionVersion:PROJECTION_VERSION,genreMappingRevision:GENRE_MAPPING_REVISION,
  fields:{year:shape(observation.year),runtime:shape(observation.runtime),url:shape(observation.url),synopsis:shape(observation.synopsis),poster:shape(observation.poster),genres:{...shape(observation.genres),ids:observation.genres.ids??[],unmapped:observation.genres.unmapped??[]}}});
}
// localization: the selected typed title, or its verified absence. Ambiguous, unreadable and unsupported coverage has none.
export const localizationVersion=(source,anchor,title)=>title?.status==='value'?digestOf({source,anchor,title:title.value}):title?.status==='absent'?digestOf({source,anchor,title:null,status:'absent'}):null;
// credits: the ordered provider credits of a readable section (a present, empty list is a valid empty set).
export const creditsVersion=(source,anchor,credits)=>credits?.status==='ok'&&Array.isArray(credits.items)?digestOf({source,anchor,part:'credits',items:credits.items.map(item=>[item.role,item.key??null,item.key==null?(item.name??null):null])}):null;

// ---- priority and fairness (decision 5) ----
// facts: {cohorts:Set of 'live'|'history', personal:true|false|null, available:true|false|null}; null is UNKNOWN. A positive live fact makes the Film live whatever its cohort; a history-only Film is background (unknown
// facts do not promote it); a member of a live cohort is live unless BOTH facts are known false.
export function priorityClass({cohorts,personal=null,available=null}){
 if(personal===true||available===true)return 'live';
 if(!cohorts.has('live'))return 'background';
 return personal===false&&available===false?'background':'live';
}
// The share of background work is accounted in COMMITTED units, not starts: about one unit in eight. -> 'live' | 'background' | null
export function nextClass({hasLive,hasBackground,committedLive=0,committedBackground=0}){
 if(!hasLive&&!hasBackground)return null;
 if(!hasLive)return 'background';
 if(!hasBackground)return 'live';
 return committedBackground*7<committedLive?'background':'live';
}
// The indexed head of one cohort: at most `k` rows are examined; an item that failed or was backed off has its retry_at in the future and leaves the window. rows: [{retryAt, dueSince}] already ordered by the index.
export function examineWindow(rows,now,k=50){
 return rows.filter(row=>!row.retryAt||row.retryAt<=now).slice(0,k);
}

// One namespace for the modules that use the planner as a whole (the Worker bundle strips named imports, so the producer takes `Plan` from the scope).
export const Plan=Object.freeze({declarationOf,unresolvedFields,coreVersion,localizationVersion,creditsVersion,SOURCES,CORE_FIELDS,blank,computeAnchors,anchorDigest,applicableSources,anchorSetGuard,epochGuard,leaseGuard,controlGuard,blankFieldGuard,afterOutcome,fallbackElapsed,decideCore,creditSource,expectedCredits,chunkCredits,expectedDigest,missingForChunk,creditsComplete,digestOf,transportDelayMs,repairDelayMs,classifyFailure});
