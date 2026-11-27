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
const equalYear=(a,b)=>Number(a)===Number(b);
const equalRuntime=(a,b)=>Math.abs(Number(a)-Number(b))<=RUNTIME_TOLERANCE_MIN;
const COMPARE={year:equalYear,runtime:equalRuntime};
// state of one source for one field: value | absent | pending | failed | not_applicable
function fieldState(source,field,{applicable,answers}){
 if(!applicable.includes(source))return 'not_applicable';
 const answer=answers[source];
 if(!answer||answer.status==='stopped'||answer.status==='transport')return 'pending';
 if(answer.status==='failed')return 'failed';
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
    // Letterboxd's own value needs a recorded agreement whenever the Film holds a Letterboxd anchor; a value of the other source needs it too, unless every earlier source is only transport-unavailable for 72 h.
    if(hasLetterboxdAnchor&&!agreed&&!fallbackOver){out.waiting[field]={reason:'waiting_for_agreement',source};decided=true;break;}
    out.writes[field]={source,value:answers[source].fields[field]};
    if(fallbackOver){out.fallbackFill.push({field,source,waitedFor:fallbackOver});if(hasLetterboxdAnchor&&!agreed)out.unconfirmedAgreement.push(field);}
    decided=true;break;
   }
   if(state==='failed'){out.waiting[field]={reason:'failed_source',source,retryable:false};decided=true;break;}
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
  const title=typeof entry.data.title==='string'?entry.data.title.trim():'';
  if(title)ru.push({title,region:entry.iso_3166_1});
 }
 const distinct=[...new Set(ru.map(item=>item.title))];
 if(!distinct.length)return {status:'absent'};
 if(distinct.length===1)return {status:'value',value:distinct[0]};
 const regional=[...new Set(ru.filter(item=>item.region==='RU').map(item=>item.title))];
 return regional.length===1?{status:'value',value:regional[0]}:{status:'ambiguous'};
}

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
export const Plan=Object.freeze({SOURCES,CORE_FIELDS,blank,computeAnchors,anchorDigest,applicableSources,anchorSetGuard,epochGuard,leaseGuard,controlGuard,blankFieldGuard,afterOutcome,fallbackElapsed,decideCore,creditSource,expectedCredits,chunkCredits,expectedDigest,missingForChunk,creditsComplete,digestOf,transportDelayMs,repairDelayMs,classifyFailure});
