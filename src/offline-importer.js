// Offline importer from a verified historical snapshot into a caller-supplied database.
// The Worker does not import this file. It does not read R2, call a model, or apply the schema to production.
// Identity follows the shared canonicalFilmId rule and evidence keys follow the resolver's candidateEvidence rule;
// both are supplied by the caller, so this module never carries a second copy of either rule.
import {catalogMetadata,creditRoster} from './enrichment-projection.js';
export {catalogMetadata,creditRoster};

// ADR 0034 bounded discovery ledger: the archive pointer, the write-once manifest versions and segment versions are a second source
// of candidates. The write-once copy of the source ledger kept by the split is a rollback copy and stays in R2.
const ARCHIVE_POINTER='epg/discovery-archive/v1/current.json';
const ARCHIVE_MANIFEST=/^epg\/discovery-archive\/v1\/manifests\/([^/]+)\.json$/;
const ARCHIVE_SEGMENT=/^epg\/discovery-archive\/v1\/segments\/(\d{3})\/([^/]+)\.json$/;
const ARCHIVE_SOURCE_COPY=/^epg\/discovery-archive\/v1\/sources\/[^/]+\/discovery-latest\.json$/;
export const archiveManifestKey=manifestId=>'epg/discovery-archive/v1/manifests/'+manifestId+'.json';
export function isArchiveKey(key){return key===ARCHIVE_POINTER||ARCHIVE_MANIFEST.test(key)||ARCHIVE_SEGMENT.test(key);}

// ADR-0035 section 2 (AIR-210): immutable fingerprint storage. A content body per distinct content, keyed by its hash, and a
// generation record per (hash, schema version, prompt version) holding the provenance; both create-only. fingerprint.json stays the
// current record and is the pointer: the body and the record whose identity equals it are its immutable form, mapped through it.
const FINGERPRINT_BODY=/^enrichment\/films\/([^/]+)\/fingerprints\/([0-9a-f]{64})\.json$/;
const FINGERPRINT_GENERATION=/^enrichment\/films\/([^/]+)\/fingerprint-generations\/([0-9a-f]{64})-s(0|[1-9]\d*)-p(0|[1-9]\d*)\.json$/;
// Only the Worker's own layout is a version key: the film segment must be exactly encodeURIComponent of the id it decodes to
// (filmKey), and the versions are integers without leading zeros (fingerprintGenerationKey). An alias spelling is unknown.
const canonicalFilmSegment=segment=>{try{return encodeURIComponent(decodeURIComponent(segment))===segment;}catch{return false;}};
export function isFingerprintVersionKey(key){const match=key.match(FINGERPRINT_BODY)||key.match(FINGERPRINT_GENERATION);return !!match&&canonicalFilmSegment(match[1]);}

const FAMILIES=[
 ['watchlist',key=>key==='watchlist.json'],
 ['programme',key=>key==='programme.json'||key==='epg/published-generation.json'],
 ['discovery',key=>key==='epg/discovery-latest.json'||key==='epg/discovery-resolution.json'||key==='epg/discovered-films.json'||isArchiveKey(key)],
 ['profile',key=>key==='enrichment/profile/current.json'||/^enrichment\/profile\/versions\/\d+\.json$/.test(key)],
 ['fingerprint',key=>/^enrichment\/films\/[^/]+\/fingerprint\.json$/.test(key)||isFingerprintVersionKey(key)],
 ['prediction',key=>/^enrichment\/films\/[^/]+\/predictions\.json$/.test(key)||VERSION_OBJECT.test(key)],
 ['actual',key=>/^enrichment\/films\/[^/]+\/actual\.json$/.test(key)],
];
const MANDATORY_FAMILIES=['prediction'];
// Immutable prediction version objects: the key names the film and the checksum of the body. Whether one is referenced is known only with its bundle.
const VERSION_OBJECT=/^enrichment\/films\/([^/]+)\/predictions\/versions\/([0-9a-f]{64})\.json$/;

// Declared R2-only prefixes. Each family names the stage that must decide its disposition before the keys may be left behind.
// A key outside these families and outside every mapped family is unknown and fails closed.
const R2_ONLY=[
 {family:'derived_projection',decideBy:'read_cutover',decisionRequired:false,matches:key=>['enrichment/view-index.json','enrichment/prediction-queue.json','epg/discovery-score-preview.json','enrichment/diagnostics/moods.json','uncertain.json'].includes(key)||/^enrichment\/films\/[^/]+\/mood-facet\.json$/.test(key)},
 {family:'runtime_coordination',decideBy:'write_cutover',decisionRequired:false,matches:key=>['epg/resolver-lease.json','enrichment/writer-lease.json','enrichment/runner-lease.json','epg/resolver-continuation.json','epg/resolver-continuation-diagnostics.json','epg/discovery-status.json','epg/discovery-variant-pending.json','sync.json','watchlist-ingest.json','enrichment/ratings/status.json','enrichment/ratings/pending.json','enrichment/ratings/lease.json','enrichment/removal-rating-lookups.json'].includes(key)},
 {family:'run_record',decideBy:'legacy_retirement',decisionRequired:false,matches:key=>/^enrichment\/(?:runs|sources|run-diagnostics|diagnostics|stop-events|start-events|benchmarks|ratings\/generations|predictions-materialization)\//.test(key)||key==='enrichment/latest-run.json'||key==='enrichment/ratings/published.json'},
 {family:'user_state',decideBy:'read_cutover',decisionRequired:true,matches:key=>key.startsWith('started/')||key.startsWith('events/')||key.startsWith('letterboxd/facts/')||key.startsWith('letterboxd/imports/')||key==='ui/filter-presets.json'||key==='letterboxd/display-exclusion.json'},
 {family:'archive',decideBy:'none',decisionRequired:false,matches:key=>/^epg\/generations\/[^/]+\//.test(key)||ARCHIVE_SOURCE_COPY.test(key)||key==='epg/discovery-before-canonical.json'||key==='epg/discovery-resolution-before-canonical.json'},
];

const KNOWN_CONFLICTS=new Set([
 'identity_collision',
 'Fingerprint conflicts',
 'Prediction conflicts',
 'Profile version conflicts',
 'Generation payload conflicts with the committed run',
 'Decision is not in the published generation',
 'Redirected film already belongs to a generation',
 'Redirected film has EPG history',
 'Score record conflicts with the stored score',
]);
// Source-quality reasons: the record itself cannot be carried without inventing a value. Everything else is a mapped-domain gap.
const SOURCE_QUALITY=/_fields_missing$|^json_invalid$|^decision_without_candidate$/;
const CLASS_A_BLOCKERS={prediction_absent:'prediction_family_absent',prediction_unportable:'prediction_family_unportable'};
const SHA256=/^[0-9a-f]{64}$/;

// Excluded is one declared prefix: raw EPG dumps under epg/raw/ are archive by the publication ADR and are counted, never parsed.
// No current writer produces XML or an archive/ prefix, so any other XML-shaped or archive-shaped key is unknown and fails closed.
export function classifyObject(key){
 if(typeof key!=='string')return 'unmapped';
 if(key.startsWith('epg/raw/'))return 'excluded';
 if(isMappedKey(key))return 'mapped';
 if(r2OnlyFamily(key))return 'r2_only';
 return 'unmapped';
}
export function r2OnlyFamily(key){return R2_ONLY.find(item=>item.matches(key))||null;}

export function inventory({finishedAt=null,aggregateSha256=null,keys=[],production=false}={}){
 const families={};
 for(const [id,matches] of FAMILIES){
  const found=keys.filter(matches).sort();
  families[id]={status:found.length?'present':'absent',keys:found,mandatory:MANDATORY_FAMILIES.includes(id)};
 }
 const absent=Object.entries(families).filter(([,family])=>family.status==='absent').map(([id])=>id);
 const coverage={denominator:keys.length,mapped:[],r2_only:[],excluded:[],unmapped:[],r2OnlyFamilies:R2_ONLY.map(item=>({family:item.family,decideBy:item.decideBy,decisionRequired:item.decisionRequired,count:0}))};
 for(const key of [...keys].sort()){
  const kind=classifyObject(key);
  coverage[kind].push(key);
  if(kind==='r2_only')coverage.r2OnlyFamilies.find(item=>item.family===r2OnlyFamily(key).family).count++;
 }
 return {scope:production?'production-baseline':'historical-snapshot',production:!!production,finishedAt,aggregateSha256,objectCount:keys.length,families,absent,complete:absent.length===0,coverage};
}

// The caller supplies the shared canonicalFilmId rule and the stored Films (survivors with their redirects). Resolution never mints an id.
export function identityResolver({canonicalize,films=[]}={}){
 if(typeof canonicalize!=='function')throw new Error('The shared canonicalFilmId rule is required');
 const ids=new Set(),survivors=new Map(),holders=new Map(),conflicting=new Set();
 for(const film of films){
  if(!film?.id)continue;
  ids.add(film.id);
  for(const redirect of film.redirects||[]){
   if(!redirect?.from)continue;
   const list=survivors.get(redirect.from)||[];
   if(!list.includes(film.id))list.push(film.id);
   survivors.set(redirect.from,list);
  }
  for(const item of film.externalIds||[]){
   if(item?.scheme!=='tmdb'||item.value==null)continue;
   const value=String(item.value),list=holders.get(value)||[];
   if(!list.includes(film.id))list.push(film.id);
   holders.set(value,list);
   if(item.conflicting)conflicting.add(value);
  }
  const conflict=film.id.match(/^film:conflict:(.+)$/);
  if(conflict)for(const value of conflict[1].split('+'))conflicting.add(value);
 }
 // Conflicts are checked before either fast path: a canonical id that is stored while another Film or a conflict record also
 // claims its TMDB id, or that is itself the retired side of a redirect, is a conflict, never a silent direct hit.
 const resolve=storedId=>{
  const source=storedId==null?null:String(storedId);
  const canonical=canonicalize(storedId);
  if(!canonical)return {source,canonical:null,filmId:null,via:null,reason:'identity_unreadable'};
  const conflict={source,canonical,filmId:null,via:null,reason:'identity_conflict'};
  const tmdb=canonical.match(/^film:tmdb:(\d+)$/)?.[1]||null;
  const claimants=tmdb?(holders.get(tmdb)||[]):[];
  const targets=(survivors.get(canonical)||[]).filter(id=>id!==canonical);
  if(tmdb&&conflicting.has(tmdb))return conflict;
  if(ids.has(canonical)){
   if(targets.length||claimants.some(id=>id!==canonical))return conflict;
   return {source,canonical,filmId:canonical,via:'direct',reason:null};
  }
  if(targets.length>1)return conflict;
  if(targets.length===1&&ids.has(targets[0])){
   if(claimants.some(id=>id!==targets[0]))return conflict;
   return {source,canonical,filmId:targets[0],via:'redirect',reason:null};
  }
  if(claimants.length)return claimants.length>1?conflict:{source,canonical,filmId:null,via:null,reason:'identity_unlinked'};
  return {source,canonical,filmId:null,via:null,reason:'film_unresolved'};
 };
 return {canonical:storedId=>canonicalize(storedId),resolve};
}

// ADR-0027: an owner rating whose stored Letterboxd id resolves to no Film may resolve through the TMDB id of its own metadata.json
// record, and only to exactly one Film that holds that TMDB id trusted and without conflict, claims no other Letterboxd id, and gets
// no other rating. Everything else keeps the shared resolver's answer. Ratings only; no title matching and no new Film.
export function ratingIdentity({identity,films=[],metadata=null,metadataSha256=null,ratings=[]}={}){
 requireIdentity(identity);
 const holders=new Map(),conflicting=new Set(),letterboxdOf=new Map(),byTmdb=new Map();
 for(const film of films){
  if(!film?.id)continue;
  for(const item of film.externalIds||[]){
   if(item?.scheme==='letterboxd'&&item.value!=null){const list=letterboxdOf.get(film.id)||[];list.push(String(item.value));letterboxdOf.set(film.id,list);}
   if(item?.scheme!=='tmdb'||item.value==null)continue;
   const value=String(item.value),list=holders.get(value)||[];
   list.push({filmId:film.id,trusted:!!item.trusted&&!item.conflicting});holders.set(value,list);
   if(item.conflicting)conflicting.add(value);
  }
  const conflict=film.id.match(/^film:conflict:(.+)$/);
  if(conflict)for(const value of conflict[1].split('+'))conflicting.add(value);
 }
 const records=metadata&&typeof metadata==='object'&&!Array.isArray(metadata)?metadata:{};
 const tmdbOf=id=>{const record=records[id];if(!record||typeof record!=='object'||String(record.id)!==id)return null;const value=record.tmdbId==null?'':String(record.tmdbId).trim();return /^\d+$/.test(value)?value:null;};
 for(const id of Object.keys(records)){const value=tmdbOf(id);if(value){const list=byTmdb.get(value)||[];list.push(id);byTmdb.set(value,list);}}
 const direct=new Map(),proposed=new Map();
 for(const rating of ratings){
  const stored=enrichmentStoredId(rating.key),resolved=stored?identity.resolve(stored):{source:null,canonical:null,filmId:null,via:null,reason:'identity_unreadable'};
  direct.set(rating.key,resolved);
  if(resolved.filmId||resolved.reason!=='film_unresolved')continue;
  const tmdb=tmdbOf(stored);
  if(!tmdb)continue;
  const claims=holders.get(tmdb)||[],refuse=reason=>proposed.set(rating.key,{...resolved,reason,tmdbId:tmdb});
  if(!claims.length)continue;
  if(conflicting.has(tmdb)||new Set(claims.map(item=>item.filmId)).size>1||(byTmdb.get(tmdb)||[]).length>1){refuse('identity_conflict');continue;}
  if(!claims[0].trusted){refuse('identity_unlinked');continue;}
  if((letterboxdOf.get(claims[0].filmId)||[]).some(value=>value!==stored)){refuse('identity_conflict');continue;}
  proposed.set(rating.key,{source:resolved.source,canonical:resolved.canonical,filmId:claims[0].filmId,via:'metadata_tmdb',reason:null,tmdbId:tmdb,metadataSha256});
 }
 // A Film gets at most one rating: a mapped rating never joins or replaces another rating of the same Film, equal or not.
 const targets=new Map();
 for(const [key,resolved] of [...direct,...proposed])if(resolved.filmId){const list=targets.get(resolved.filmId)||[];list.push(key);targets.set(resolved.filmId,list);}
 for(const [key,resolved] of proposed)if(resolved.filmId&&targets.get(resolved.filmId).length>1)proposed.set(key,{...resolved,filmId:null,via:null,reason:'rating_conflict'});
 return {resolve:key=>proposed.get(key)||direct.get(key)||(()=>{const stored=enrichmentStoredId(key);return stored?identity.resolve(stored):{source:null,canonical:null,filmId:null,via:null,reason:'identity_unreadable'};})()};
}

// ADR-0029: a fingerprint or prediction bundle stored under a retired Film id, which a redirect maps to a survivor Film that holds its
// own strictly newer payload of the same family, is superseded by that canonical payload. No row is written from it, the object stays in
// R2, and the ledger keeps it with both checksums. Every other collision keeps the fail-closed path; this never creates a Film.
// entries are {key,sha256,body} for every fingerprint.json and predictions.json of the snapshot; the same result feeds the write list
// and the independent projection.
export function supersededPayloads({identity,entries=[],links=null}={}){
 requireIdentity(identity);
 const groups=new Map(),decisions=new Map();
 for(const item of entries){
  const family=/\/fingerprint\.json$/.test(String(item?.key))?'fingerprint':/\/predictions\.json$/.test(String(item?.key))?'prediction':null;
  const stored=family?enrichmentStoredId(item.key):null;
  if(!stored)continue;
  const resolved=identity.resolve(stored);
  if(!resolved.filmId)continue;
  const group=family+'\n'+resolved.filmId,list=groups.get(group)||[];
  list.push({...item,family,stored,resolved});
  groups.set(group,list);
 }
 for(const list of groups.values()){
  if(list.length<2)continue;
  const direct=list.filter(item=>item.resolved.via==='direct'),retired=list.filter(item=>item.resolved.via==='redirect');
  const refuse=(item,reason)=>decisions.set(item.key,{superseded:false,reason});
  if(direct.length!==1){for(const item of retired)refuse(item,direct.length?'canonical_ambiguous':'canonical_missing');continue;}
  const canonical=direct[0],canonicalAt=payloadAt(canonical,links);
  for(const item of retired){
   if(!SHA256.test(String(canonical.sha256??''))||!SHA256.test(String(item.sha256??''))){refuse(item,'checksum_missing');continue;}
   if(canonicalAt==null){refuse(item,'canonical_unportable');continue;}
   const sourceAt=payloadAt(item,links);
   if(sourceAt==null){refuse(item,'source_unportable');continue;}
   if(!(Date.parse(sourceAt)<Date.parse(canonicalAt))){refuse(item,'canonical_not_newer');continue;}
   decisions.set(item.key,{superseded:true,reason:'superseded_by_canonical',family:item.family,filmId:canonical.resolved.filmId,identity:provenanceOf(item.resolved),sourceAt,supersededBy:{key:canonical.key,sha256:canonical.sha256,at:canonicalAt},...(item.family==='prediction'?{records:payloadRecords(item.body).length}:{})});
  }
 }
 return {resolve:key=>decisions.get(key)||null,decisions:[...decisions].map(([key,value])=>({key,...value}))};
}
// The time a payload was produced, or null when the payload cannot be carried: a fingerprint needs its hash, schema version and
// generatedAt; a bundle needs a current record and every record must pass the version pointer and field checks of the write path.
function payloadAt(item,links){
 const body=item.body;
 if(item.family==='fingerprint'){
  if(!body?.fingerprintHash||!(body.fingerprintSchemaVersion!=null||body.schemaVersion!=null))return null;
  return validTime(body.generatedAt);
 }
 if(!body?.current||typeof body.current!=='object')return null;
 const entry={key:item.key,sha256:item.sha256};
 if(payloadRecords(body).some((record,index)=>versionUnit(entry,item.resolved.filmId,record,'prediction_history',String(index),item.resolved,links,item.stored).unportable))return null;
 return validTime(body.current.updatedAt||body.current.generatedAt);
}
function payloadRecords(body){return [...(Array.isArray(body?.history)?body.history:[]),body?.current];}
function validTime(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;}


// A batch is refused before any write when the snapshot has an unknown key or a stored decision disagrees with the derived evidence.
export function refusal(batch){
 const blockers=[];
 for(const key of batch?.inventory?.coverage?.unmapped||[])blockers.push({reason:'unknown_key',class:'C',sourceKey:key,sourceSha256:batch?.shas?.[key]??null,targetTable:null,targetId:key});
 for(const blocker of batch?.blockers||[])blockers.push({class:'C',...blocker});
 if(!blockers.length)return null;
 const coverage=batch?.inventory?.coverage||emptyCoverage();
 return {stopped:true,stopReasons:[...new Set(blockers.map(item=>item.reason))],blockers,applied:0,resumed:0,reconciled:0,explained:0,conflicts:0,unportable:0,unresolved:0,superseded:0,partial:0,uncheckpointed:0,pending:0,ledger:[],coverage,parity:{ok:false,missing:[],extra:[],mismatched:[],denominator:0,unprojected:[],records:[],reason:'import_stopped'},receipts:null,classes:acceptanceClasses({inventory:batch?.inventory,coverage,counts:{},ledger:[],stopped:true}),claimsFullParity:false};
}

export async function importBatch(db,repositories,batch){
 const importedAt=batch?.importedAt;
 if(!importedAt)throw new Error('importedAt is required');
 const refused=refusal(batch);
 if(refused)return refused;
 const units=batch.units||[];
 const limit=batch.limit??null;
 const ledgerRows=[];
 const ledger={push(row){ledgerRows.push(row);const reason=fatal(row);if(reason&&!stopInfo)stopInfo={reason,entry:row};return ledgerRows.length;},get length(){return ledgerRows.length;},filter:(...args)=>ledgerRows.filter(...args),some:(...args)=>ledgerRows.some(...args),find:(...args)=>ledgerRows.find(...args),map:(...args)=>ledgerRows.map(...args),[Symbol.iterator](){return ledgerRows[Symbol.iterator]();}};
 const counts={applied:0,resumed:0,reconciled:0,explained:0,conflicts:0,unportable:0,unresolved:0,superseded:0,partial:0,uncheckpointed:0,pending:0};
 const appliedByFamily={};
 // stopOn makes a run fail closed: a class A conflict or uncheckpointed unit, or any record outside the acknowledged class C list,
 // ends the run before the next unit is written. The acknowledged list names class C records only; class A is never acknowledgeable.
 const stopOn=batch.stopOn||null;
 const acknowledged=new Set((batch.acknowledged||[]).map(acknowledgementKey));
 let stopInfo=null,started=0;
 for(const unit of units){
  if(stopInfo){counts.pending++;continue;}
  if(limit!=null&&started>=limit){counts.pending++;continue;}
  if(unit.unresolved){
   counts.unresolved++;
   ledger.push(entry(unit,'unresolved',unit.reason||'film_unresolved'));
   continue;
  }
  // ADR-0029: a superseded payload writes nothing and takes no receipt; the canonical payload is imported by its own unit.
  if(unit.superseded){
   counts.superseded++;
   ledger.push(entry(unit,'superseded',unit.reason));
   continue;
  }
  if(await receiptExists(db,unit)){counts.resumed++;continue;}
  started++;
  if(unit.unportable){
   counts.unportable++;
   ledger.push(entry(unit,'unportable',unit.reason||'unportable'));
   continue;
  }
  if(await storedMatches(db,repositories,unit)){
   const receipt=await checkpoint(db,unit,importedAt);
   if(receipt.ok)counts.reconciled++;
   else{counts.uncheckpointed++;ledger.push(entry(unit,'uncheckpointed','receipt_failed'));}
   continue;
  }
  const gate=unit.kind==='film'?await creditGate(db,unit):{ready:true,unmatched:0};
  const working=gate.ready?withCredits(unit):{...unit,input:{...unit.input}};
  if(!gate.ready)delete working.input.credits;
  let outcome;
  try{outcome=await applyUnit(repositories,working);}
  catch(error){
   // A transport-level failure of the database adapter is not a data conflict: the run stops and the next run reconciles.
   if(error?.fatal===true)throw error;
   counts.conflicts++;
   ledger.push(entry(unit,'conflict',knownReason(error)));
   continue;
  }
  if(!gate.ready){
   counts.partial++;
   ledger.push({...entry(unit,'partial','credits_unmatched'),unmatched:gate.unmatched});
   continue;
  }
  if(outcome.outcome==='explained'){
   counts.explained++;
   ledger.push(entry(unit,'explained',outcome.reason));
   continue;
  }
  if(matchable(unit.kind)&&!(await storedMatches(db,repositories,unit))){
   counts.uncheckpointed++;
   ledger.push(entry(unit,'uncheckpointed','stored_mismatch'));
   continue;
  }
  const receipt=await checkpoint(db,unit,importedAt);
  if(!receipt.ok){counts.uncheckpointed++;ledger.push(entry(unit,'uncheckpointed','receipt_failed'));continue;}
  counts.applied++;
  appliedByFamily[unit.family]=(appliedByFamily[unit.family]||0)+1;
 }
 function fatal(row){
  if(!stopOn)return null;
  if(row.outcome==='superseded')return null;
  if(stopOn.conflicts!==false&&(row.outcome==='conflict'||row.outcome==='uncheckpointed'))return 'unexpected_conflict';
  if(stopOn.unacknowledged!==false&&row.outcome!=='applied'){
   if(row.class==='C'&&acknowledged.has(acknowledgementKey(row)))return null;
   return row.class==='C'?'unacknowledged_record':'class_a_blocker';
  }
  return null;
 }
 const parity=batch.expected?await verifyParity(db,batch.expected):{ok:false,missing:[],extra:[],mismatched:[],denominator:0,unprojected:[],records:[],reason:'no_source_projection'};
 const coverage=batch.inventory?.coverage||emptyCoverage();
 const receipts=batch.shas?await receiptAudit(db,batch.shas):null;
 const stopped=!!stopInfo;
 const classes=acceptanceClasses({inventory:batch.inventory,coverage,counts,ledger:ledgerRows,appliedByFamily,parity,receipts,stopped});
 const provenance=provenanceSummary(units);
 return {stopped,stopReasons:stopped?[stopInfo.reason]:[],blockers:stopped?[{reason:stopInfo.reason,...stopInfo.entry}]:[],...counts,ledger:ledgerRows,coverage,parity,receipts,provenance,classes,claimsFullParity:!stopped&&parityClaim({coverage,parity,counts,ledger:ledgerRows,inventory:batch.inventory,classes,receipts})};
}

// Receipts are keyed by source checksum and reconciled against this manifest, the baseline identity of the run.
// matching: the receipt names the manifest checksum. superseded: an older checksum of a source key whose same target also carries
// a receipt with the manifest checksum, so the revision landed and was read back. stale: an older checksum with no such receipt,
// so the revised object did not land (unportable, unresolved, conflicting or not yet run). foreign: a source key this manifest does not list.
// Stale and foreign receipts block acceptance: the database then carries rows this baseline cannot vouch for.
export async function receiptAudit(db,shas){
 const rows=await db.all('SELECT source_key,source_sha256,target_table,target_id FROM import_receipt ORDER BY source_key,target_table,target_id');
 const current=new Set(rows.filter(row=>shas[row.source_key]===row.source_sha256).map(row=>row.source_key+'\n'+row.target_table+'\n'+row.target_id));
 const audit={total:rows.length,matching:0,superseded:[],stale:[],foreign:[],blocking:false};
 for(const row of rows){
  const item={sourceKey:row.source_key,sourceSha256:row.source_sha256,targetTable:row.target_table,targetId:row.target_id};
  if(!Object.prototype.hasOwnProperty.call(shas,row.source_key)){audit.foreign.push(item);continue;}
  if(shas[row.source_key]===row.source_sha256){audit.matching++;continue;}
  const revised={...item,manifestSha256:shas[row.source_key]};
  if(current.has(row.source_key+'\n'+row.target_table+'\n'+row.target_id))audit.superseded.push(revised);
  else audit.stale.push(revised);
 }
 audit.blocking=audit.stale.length+audit.foreign.length>0;
 return audit;
}

// Three classes that are never merged into one verdict: A mapped-domain parity, B declared R2-only artifacts, C unresolved identity and source-quality records.
// S lists the payloads superseded by their canonical Film under ADR-0029: neither a class A gap nor a class C record to acknowledge.
export function acceptanceClasses({inventory,coverage,counts={},ledger=[],appliedByFamily={},parity=null,receipts=null,stopped=false}={}){
 const prediction=inventory?.families?.prediction||{status:'unknown',keys:[]};
 const predictionUnportable=ledger.filter(item=>item.family==='prediction'&&item.outcome==='unportable').length;
 const blockers=[];
 if(prediction.status==='absent')blockers.push(CLASS_A_BLOCKERS.prediction_absent);
 if(predictionUnportable>0)blockers.push(CLASS_A_BLOCKERS.prediction_unportable);
 if((receipts?.stale||[]).length)blockers.push('receipts_stale');
 if((receipts?.foreign||[]).length)blockers.push('receipts_foreign');
 if(stopped)blockers.push('import_stopped');
 const open=(counts.conflicts||0)+(counts.explained||0)+(counts.partial||0)+(counts.uncheckpointed||0)+ledger.filter(item=>item.class==='A'&&item.outcome==='unportable').length;
 const records=ledger.filter(item=>item.class==='C'),superseded=ledger.filter(item=>item.class==='S');
 return {
  A:{blocking:blockers.length>0||open>0||!(parity?.ok===true),blockers,open,mandatory:{prediction:{status:prediction.status,keys:prediction.keys.length,applied:appliedByFamily.prediction||0,unportable:predictionUnportable,portable:prediction.status==='present'&&predictionUnportable===0}}},
  B:{keys:(coverage?.r2_only||[]).length,families:(coverage?.r2OnlyFamilies||[]).filter(item=>item.count>0),decisionRequired:(coverage?.r2OnlyFamilies||[]).filter(item=>item.count>0&&item.decisionRequired).map(item=>item.family),unreferencedVersions:(parity?.records||[]).filter(record=>record.disposition==='unreferenced').map(record=>record.key)},
  C:{count:records.length,acknowledgementRequired:records.length>0,reasons:Object.fromEntries([...new Set(records.map(item=>item.reason))].sort().map(reason=>[reason,records.filter(item=>item.reason===reason).length])),records},
  S:{count:superseded.length,families:Object.fromEntries([...new Set(superseded.map(item=>item.family))].sort().map(family=>[family,superseded.filter(item=>item.family===family).length])),records:superseded},
 };
}

export async function verifyParity(db,spec){
 const missing=[],extra=[],mismatched=[];
 if(spec.films)await verifyFilms(db,spec.films,missing,extra,mismatched);
 if(spec.persons)await verifyPersons(db,spec.persons,missing,extra,mismatched);
 if(spec.redirects)await verifyRedirects(db,spec.redirects,missing,extra,mismatched);
 if(spec.fingerprints)await verifyFingerprints(db,spec.fingerprints,missing,extra,mismatched);
 if(spec.ratings)await verifyRatings(db,spec.ratings,missing,extra,mismatched);
 if(spec.predictions)await verifyPredictions(db,spec.predictions,missing,extra,mismatched);
 if(spec.profiles)await verifyProfiles(db,spec.profiles,missing,extra,mismatched);
 if(spec.generations)await verifyGenerations(db,spec.generations,missing,extra,mismatched);
 if(Object.prototype.hasOwnProperty.call(spec,'publishedPointer'))await verifyPointer(db,spec.publishedPointer,mismatched);
 if(spec.candidates)await verifyCandidates(db,spec.candidates,missing,extra,mismatched);
 if(spec.decisions)await verifyDecisions(db,spec.decisions,missing,extra,mismatched);
 const denominator=['films','persons','redirects','fingerprints','ratings','predictions','profiles','generations','candidates','decisions'].reduce((sum,key)=>sum+(spec[key]?.length||0),0);
 return {ok:missing.length+extra.length+mismatched.length===0,missing,extra,mismatched,denominator,unprojected:spec.unprojected||[],records:spec.records||[],r2Only:spec.r2Only||[]};
}

// The lossless claim. It is never true with a class C record, a stale or foreign receipt, or a class A blocker; an owner acknowledgement
// of the class C list is recorded elsewhere and does not change this verdict.
export function parityClaim({coverage,parity,counts,ledger,inventory,classes,receipts}={}){
 const uncovered=(coverage?.unmapped||[]).length>0;
 const incomplete=inventory?.complete!==true;
 const vacuous=!(parity?.denominator>0);
 const unprojected=(parity?.unprojected||[]).length>0;
 const openRecords=(parity?.records||[]).some(record=>record.disposition!=='mapped'&&record.disposition!=='unreferenced');
 const open=(counts?.pending||0)+(counts?.unportable||0)+(counts?.unresolved||0)+(counts?.superseded||0)+(counts?.conflicts||0)+(counts?.explained||0)+(counts?.partial||0)+(counts?.uncheckpointed||0);
 const blocked=classes?.A?.blocking===true;
 const unreconciled=(receipts?.stale||[]).length+(receipts?.foreign||[]).length>0;
 return !uncovered&&!incomplete&&!vacuous&&!unprojected&&!openRecords&&!blocked&&!unreconciled&&!!parity?.ok&&open===0&&(ledger||[]).length===0;
}

export function fingerprintUnit(entry,body,identity,superseded=null){
 const resolved=enrichmentIdentity(entry.key,identity);
 if(!resolved.filmId)return unresolved(entry,'fingerprint_payload',resolved.canonical||entry.key,resolved.reason,'fingerprint',resolved);
 const filmId=resolved.filmId;
 const replaced=superseded?.resolve(entry.key);
 if(replaced?.superseded)return supersededUnit(entry,'fingerprint_payload',filmId,'fingerprint',replaced);
 if(!body?.fingerprintHash||!(body.fingerprintSchemaVersion!=null||body.schemaVersion!=null))return unportable(entry,'fingerprint_payload',filmId,'fingerprint_fields_missing','fingerprint');
 return unit({family:'fingerprint',kind:'fingerprint',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:'fingerprint_payload',targetId:filmId,identity:provenanceOf(resolved),input:{filmId,schemaVersion:body.schemaVersion??body.fingerprintSchemaVersion,fingerprintHash:body.fingerprintHash,generatedAt:body.generatedAt??null,invalidatedAt:body.invalidatedAt??null,r2Key:entry.key,contentSha256:entry.sha256}});
}

// links (optional) checks a version pointer against the snapshot: linked(record,storedId) is the shared rule for a well-formed pointer,
// exists(key) and sha(key) come from the manifest, and bodyHash(record) is the SHA-256 of the exact bytes the shared rule derives from
// the bundle record. Record body hash, pointer checksum and manifest checksum of the object bytes must all be one value; otherwise the
// object does not hold this record. Without links only the shape of the pointer is checked.
export function predictionUnits(entry,body,identity,links=null,superseded=null){
 const resolved=enrichmentIdentity(entry.key,identity);
 if(!resolved.filmId)return [unresolved(entry,'prediction_current',resolved.canonical||entry.key,resolved.reason,'prediction',resolved)];
 const filmId=resolved.filmId,storedId=enrichmentStoredId(entry.key);
 const replaced=superseded?.resolve(entry.key);
 if(replaced?.superseded)return [supersededUnit(entry,'prediction_current',filmId,'prediction',replaced)];
 const units=[];
 const history=Array.isArray(body?.history)?body.history:[];
 history.forEach((item,index)=>units.push(versionUnit(entry,filmId,item,'prediction_history',filmId+'#'+index,resolved,links,storedId)));
 units.push(versionUnit(entry,filmId,body?.current,'prediction_current',filmId,resolved,links,storedId));
 return units;
}
// The reason a version pointer cannot be carried, or null when the pointer names an object the snapshot holds with the same checksum.
export function versionPointerProblem(item,bundleKey,storedId,links){
 if(!item?.r2Key||!item.contentSha256)return 'prediction_version_object_missing';
 if(item.r2Key===bundleKey)return 'mutable_bundle_is_not_a_version_object';
 const parsed=item.r2Key.match(VERSION_OBJECT);
 let keyFilm=null;try{keyFilm=parsed?decodeURIComponent(parsed[1]):null;}catch{keyFilm=null;}
 const wellFormed=links?.linked?links.linked(item,storedId):!!parsed&&parsed[2]===item.contentSha256&&(storedId==null||keyFilm===String(storedId));
 if(!wellFormed)return 'prediction_version_pointer_malformed';
 if(links?.exists&&!links.exists(item.r2Key))return 'prediction_version_object_absent';
 if(links?.sha){const sha=links.sha(item.r2Key);if(sha!=null&&sha!==item.contentSha256)return 'prediction_version_checksum_mismatch';}
 if(links?.bodyHash){const sha=links.bodyHash(item);if(sha!=null&&sha!==item.contentSha256)return 'prediction_version_body_mismatch';}
 return null;
}

export function actualUnit(entry,body,identity,ratings=null){
 const resolved=ratings?ratings.resolve(entry.key):enrichmentIdentity(entry.key,identity);
 if(!resolved.filmId)return unresolved(entry,'actual_rating',resolved.canonical||entry.key,resolved.reason,'actual',resolved);
 const filmId=resolved.filmId;
 const recordedAt=body?.recordedAt||body?.updatedAt||null;
 if(typeof body?.rating!=='number'||!body.source||!recordedAt)return unportable(entry,'actual_rating',filmId,'rating_fields_missing','actual');
 return unit({family:'actual',kind:'rating',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:'actual_rating',targetId:filmId,identity:provenanceOf(resolved),input:{filmId,rating:body.rating,source:body.source,recordedAt}});
}

export function profileUnit(entry,body){
 if(!/^enrichment\/profile\/versions\/\d+\.json$/.test(entry.key))return unportable(entry,'profile_version',String(body?.version??entry.key),'profile_version_object_missing','profile');
 if(typeof body?.version!=='number'||!body.profileHash||!(body.createdAt||body.updatedAt))return unportable(entry,'profile_version',String(body?.version??entry.key),'profile_fields_missing','profile');
 return unit({family:'profile',kind:'profile',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:'profile_version',targetId:String(body.version),input:{version:body.version,profileHash:body.profileHash,createdAt:body.createdAt||body.updatedAt,r2Key:entry.key,contentSha256:entry.sha256}});
}

export function generationUnit(pointer,programme,pointerSha,candidates=[],identity){
 requireIdentity(identity);
 const source={key:'programme.json',sha256:pointerSha};
 const programmeRunId=pointer?.programmeRunId||programme?.runId||null;
 if(!programmeRunId||!Array.isArray(programme?.films))return unportable(source,'programme_generation',programmeRunId||'programme.json','generation_fields_missing','programme');
 const films=[],unresolvedIds=[];
 for(const film of programme.films){
  if(!film||!Object.prototype.hasOwnProperty.call(film,'shows')||!Array.isArray(film.shows))return unportable(source,'programme_generation',programmeRunId,'show_fields_missing','programme');
  const shows=[];
  for(const show of film.shows){
   const startMs=show?.startMs??show?.start;
   if(!show?.channelId||typeof startMs!=='number')return unportable(source,'programme_generation',programmeRunId,'show_fields_missing','programme');
   shows.push({channelId:show.channelId,channel:show.channel??null,startMs,endMs:show.endMs??show.end??null,epgTitle:show.epgTitle??show.title??null,basis:show.basis??null,matchReason:show.matchReason??null});
  }
  const resolved=identity.resolve(film.filmId||film.id);
  if(!resolved.filmId){unresolvedIds.push(provenanceOf(resolved));continue;}
  films.push({filmId:resolved.filmId,shows});
 }
 if(unresolvedIds.length)return {...unresolved(source,'programme_generation',programmeRunId,unresolvedIds[0].reason,'programme',unresolvedIds[0]),unresolvedFilms:unresolvedIds};
 const phase=pointer?.phase==='withheld'?'withheld':'published';
 const input={programmeRunId,phase,publishedAt:pointer?.publishedAt??programme?.updatedAt??null,films,candidates};
 if(phase==='published')input.expectedProgrammeRunId=pointer?.expectedProgrammeRunId??null;
 return unit({family:'programme',kind:'generation',sourceKey:'programme.json',sourceSha256:pointerSha,targetTable:'programme_generation',targetId:programmeRunId,input});
}

// ADR 0034 section 4, the consistent read of a bounded ledger: the published active ledger, the manifest version it names
// (archive.manifestId) and exactly the segment versions that manifest names. current.json is the writers' compare-and-swap
// point and is never followed for history; it must reach the named manifest through parentManifestId, otherwise the snapshot
// mixes archive versions. Rule D: an active record wins over its archive copy, and the comparison is on the payload only.
// The writer's own counts (alsoArchived, uniqueArchivedItems, the manifest totals) must agree with what was read.
// Every problem is a blocker, so the import stops before the database is touched. A full-mode ledger is complete on its own;
// archive objects next to it are not read as history.
export async function readDiscoveryArchive({ledger,ledgerKey='epg/discovery-latest.json',generationKey=null,keys=[],shas={},read,segmentOf}={}){
 if(typeof read!=='function')throw new Error('A snapshot reader is required');
 if(typeof segmentOf!=='function')throw new Error('The shared ledgerArchiveSegment rule is required');
 const present=new Set(keys),archiveKeys=keys.filter(isArchiveKey).sort(),active=Array.isArray(ledger?.items)?ledger.items:[];
 const blockers=[],bodies={},manifests=archiveKeys.filter(key=>ARCHIVE_MANIFEST.test(key)),segments=archiveKeys.filter(key=>ARCHIVE_SEGMENT.test(key));
 const block=(reason,sourceKey,targetId,extra={})=>blockers.push({reason,sourceKey,sourceSha256:shas[sourceKey]??null,targetTable:'candidate',targetId,...extra});
 const named=ledger?.archive?.manifestId??null;
 const summary={mode:'full',manifestId:null,active:active.length,archived:0,alsoArchived:0,uniqueArchived:0,ledgerTotal:active.length,segments:0,referenced:{manifests:0,segments:0},unreferenced:{manifests:manifests.length,segments:segments.length},pointer:present.has(ARCHIVE_POINTER)?'present':'absent'};
 if(ledger?.ledgerMode!=='bounded'&&named==null)return {mode:'full',ledger,blockers,bodies,summary};
 summary.mode='bounded';summary.manifestId=named;
 if(!named){block('archive_manifest_unnamed',ledgerKey,ledgerKey);return {mode:'bounded',ledger:null,blockers,bodies,summary};}
 if(generationKey&&present.has(generationKey)&&shas[generationKey]!==shas[ledgerKey])block('discovery_ledger_copies_differ',ledgerKey,generationKey,{other:generationKey});
 const load=async key=>{if(key in bodies)return bodies[key];let body=null;try{body=await read(key);}catch{body=null;}bodies[key]=body;return body;};
 const manifestKey=archiveManifestKey(named);
 if(!present.has(manifestKey)){block('archive_manifest_missing',ledgerKey,manifestKey);return {mode:'bounded',ledger:null,blockers,bodies,summary};}
 const manifest=await load(manifestKey);
 const count=manifest?.segmentCount,table=Array.isArray(manifest?.segments)?manifest.segments:null;
 if(!manifest||manifest.schemaVersion!==1||manifest.manifestId!==named||manifest.hash!=='fnv1a32-utf8'||!Number.isInteger(count)||count<1||!table||table.length!==count||table.some((entry,index)=>entry?.segment!==index)){block('archive_manifest_invalid',manifestKey,manifestKey);return {mode:'bounded',ledger:null,blockers,bodies,summary};}
 const archived=new Map();let tableItems=0;
 for(const entry of table){
  tableItems+=Number(entry.items)||0;
  if(entry.object==null){if(entry.items!==0)block('archive_manifest_invalid',manifestKey,'segment/'+entry.segment);continue;}
  const match=String(entry.object).match(ARCHIVE_SEGMENT);
  if(!match||Number(match[1])!==entry.segment){block('archive_manifest_invalid',manifestKey,String(entry.object));continue;}
  if(!present.has(entry.object)){block('archive_segment_missing',manifestKey,entry.object);continue;}
  if(shas[entry.object]!==entry.sha256){block('archive_segment_sha256_mismatch',entry.object,entry.object,{expected:entry.sha256??null,stored:shas[entry.object]??null});continue;}
  const body=await load(entry.object),items=body?.items&&typeof body.items==='object'&&!Array.isArray(body.items)?body.items:null;
  if(!body||body.schemaVersion!==1||body.segment!==entry.segment||!items||Object.keys(items).length!==entry.items){block('archive_segment_invalid',entry.object,entry.object);continue;}
  summary.referenced.segments++;
  for(const [key,value] of Object.entries(items)){
   if(archived.has(key)){block('archive_duplicate_key',entry.object,key,{other:archived.get(key).sourceKey});continue;}
   if(!value?.payload||typeof value.payload!=='object'||value.payload.key!==key||segmentOf(key,count)!==entry.segment){block('archive_segment_invalid',entry.object,key);continue;}
   archived.set(key,{payload:value.payload,sourceKey:entry.object});
  }
 }
 if(tableItems!==manifest.totals?.items)block('archive_manifest_invalid',manifestKey,'totals');
 summary.referenced.manifests=1;summary.segments=summary.referenced.segments;
 // The pointer may be ahead of the published ledger (an archive swap whose publication did not happen) but never off its chain.
 if(!present.has(ARCHIVE_POINTER))block('archive_pointer_missing',ledgerKey,ARCHIVE_POINTER);
 else{
  const pointer=await load(ARCHIVE_POINTER);
  let at=pointer?.manifestId??null,reached=false;const seen=new Set();
  while(at&&!seen.has(at)&&seen.size<=manifests.length){
   seen.add(at);if(at===named){reached=true;break;}
   const key=archiveManifestKey(at);if(!present.has(key))break;
   at=(await load(key))?.parentManifestId??null;
  }
  if(!reached)block('archive_pointer_conflict',ARCHIVE_POINTER,ARCHIVE_POINTER,{pointer:pointer?.manifestId??null,named});
 }
 const activeKeys=new Set(active.map(item=>item?.key)),overlap=[...archived.keys()].filter(key=>activeKeys.has(key)).sort();
 const declared=Array.isArray(ledger.archive.alsoArchived)?[...ledger.archive.alsoArchived].sort():null;
 if(!declared||declared.length!==overlap.length||declared.some((key,index)=>key!==overlap[index]))block('archive_counts_mismatch',ledgerKey,'alsoArchived',{declared:declared?.length??null,read:overlap.length});
 if(ledger.archive.uniqueArchivedItems!==archived.size-overlap.length)block('archive_counts_mismatch',ledgerKey,'uniqueArchivedItems',{declared:ledger.archive.uniqueArchivedItems??null,read:archived.size-overlap.length});
 const items=[...active,...[...archived].filter(([key])=>!activeKeys.has(key)).map(([,value])=>value.payload)];
 Object.assign(summary,{archived:archived.size,alsoArchived:overlap.length,uniqueArchived:archived.size-overlap.length,ledgerTotal:items.length,unreferenced:{manifests:manifests.length-1,segments:segments.length-summary.referenced.segments}});
 return {mode:'bounded',ledger:blockers.length?null:{...ledger,items},blockers,bodies,summary};
}

// Items carry no evidence key of their own: the key is derived by the resolver's rule from the observation's fields.
// An item that does carry one must agree with the derived key; a disagreement is a blocker that stops the import.
// Reads the immutable fingerprint objects of a snapshot (ADR-0035 section 2, AIR-264). They add no row: fingerprint_payload already
// carries the current record. A body and a generation record whose identity is the film's current fingerprint.json are mapped through
// it, and the body must be that record's content byte for byte in canonical form. A valid object nothing current names (an older
// generation, or a body whose record write never followed) is unreferenced: it stays in R2 and is listed. Anything malformed, a body
// whose hash is not the hash of its content, a record that disagrees with its key or has no body, and a current record that
// disagrees with its own body, is a blocker before any write. contentSha256 is the Worker's own canonical content hash.
const FINGERPRINT_RECORD_KEYS=['filmId','fingerprintHash','fingerprintSchemaVersion','fingerprintPromptVersion','generatedAt','produced','fields','previous'];
const FINGERPRINT_PRODUCED=['generated','partial','restored'];
const FINGERPRINT_PROVENANCE=['generatedAt','invalidatedAt','fingerprintPromptVersion','produced','fields','previous'];
export function readFingerprintVersions({keys=[],bodies={},shas={},contentSha256}={}){
 const versionKeys=keys.filter(isFingerprintVersionKey).sort();
 const records=[],blockers=[],summary={bodies:0,generations:0,mapped:0,unreferenced:0,blocked:0};
 if(!versionKeys.length)return {records,blockers,summary};
 if(typeof contentSha256!=='function')throw new Error('The shared fingerprint content hash rule is required');
 const decode=segment=>{try{return decodeURIComponent(segment);}catch{return null;}};
 const films=new Map();
 for(const key of versionKeys){
  const body=key.match(FINGERPRINT_BODY),generation=key.match(FINGERPRINT_GENERATION),segment=(body||generation)[1];
  if(!films.has(segment))films.set(segment,{bodies:new Map(),generations:new Map()});
  if(body){films.get(segment).bodies.set(body[2],key);summary.bodies++;}
  else{films.get(segment).generations.set(generation[2]+'-s'+generation[3]+'-p'+generation[4],{key,hash:generation[2],schema:Number(generation[3]),prompt:Number(generation[4])});summary.generations++;}
 }
 const isPlain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
 for(const [segment,film] of films){
  const storedId=decode(segment),failed=new Set();
  const block=(key,reason)=>{failed.add(key);blockers.push({reason,sourceKey:key,sourceSha256:shas[key]??null,targetTable:'fingerprint_payload',targetId:storedId??segment});};
  for(const [hash,key] of film.bodies){
   const value=bodies[key];
   if(!isPlain(value)){block(key,'fingerprint_version_unreadable');continue;}
   if(value.fingerprintHash!==hash||storedId==null||value.filmId!==storedId){block(key,'fingerprint_body_identity_mismatch');continue;}
   const {fingerprintHash:_hash,...content}=value;
   if(contentSha256(content)!==hash)block(key,'fingerprint_body_hash_mismatch');
  }
  for(const [,generation] of film.generations){
   const value=bodies[generation.key];
   const valid=isPlain(value)&&Object.keys(value).every(name=>FINGERPRINT_RECORD_KEYS.includes(name))&&value.filmId===storedId&&value.fingerprintHash===generation.hash&&value.fingerprintSchemaVersion===generation.schema&&value.fingerprintPromptVersion===generation.prompt
    &&typeof value.generatedAt==='string'&&Number.isFinite(Date.parse(value.generatedAt))&&FINGERPRINT_PRODUCED.includes(value.produced)
    &&(value.fields===undefined||(Array.isArray(value.fields)&&value.fields.every(field=>typeof field==='string')))
    &&(value.previous===null||(isPlain(value.previous)&&typeof value.previous.fingerprintHash==='string'&&Number.isInteger(value.previous.fingerprintSchemaVersion)&&Number.isInteger(value.previous.fingerprintPromptVersion)));
   if(!valid){block(generation.key,'fingerprint_generation_invalid');continue;}
   if(!film.bodies.has(generation.hash))block(generation.key,'fingerprint_generation_body_missing');
  }
  const current=bodies['enrichment/films/'+segment+'/fingerprint.json'];
  const referenced=new Set();
  if(isPlain(current)&&typeof current.fingerprintHash==='string'){
   const identity=current.fingerprintHash+'-s'+current.fingerprintSchemaVersion+'-p'+(current.fingerprintPromptVersion??1);
   const generation=film.generations.get(identity),bodyKey=film.bodies.get(current.fingerprintHash);
   if(generation&&bodyKey&&!failed.has(generation.key)&&!failed.has(bodyKey)){
    const {fingerprintHash:_current,...content}=current;for(const name of FINGERPRINT_PROVENANCE)delete content[name];
    const {fingerprintHash:_hash,...stored}=bodies[bodyKey];
    if(contentSha256(content)!==contentSha256(stored))block(bodyKey,'fingerprint_current_body_mismatch');
    else{referenced.add(generation.key);referenced.add(bodyKey);}
   }
  }
  for(const key of [...film.bodies.values(),...[...film.generations.values()].map(item=>item.key)]){
   if(failed.has(key))continue;
   if(referenced.has(key)){records.push({key,disposition:'mapped',id:storedId,via:'fingerprint_pointer'});summary.mapped++;}
   else{records.push({key,disposition:'unreferenced',id:storedId,reason:'fingerprint_version_unreferenced'});summary.unreferenced++;}
  }
 }
 summary.blocked=blockers.length;
 return {records,blockers,summary};
}

export function readDiscovery(entry,body,{deriveEvidence}={}){
 requireEvidence(deriveEvidence);
 const items=Array.isArray(body?.items)?body.items:[];
 if(!items.length)return {candidates:[],units:[unportable(entry,'candidate',entry.key,'observation_fields_missing','discovery')],blockers:[]};
 const candidates=[],units=[],blockers=[];
 items.forEach((item,index)=>{
  const observationKey=item?.observationKey||item?.key||null;
  const targetId=observationKey||entry.key+'#'+index;
  if(!observationKey||!item?.title||!item?.normalizedTitle){units.push(unportable(entry,'candidate',targetId,'observation_fields_missing','discovery'));return;}
  const shows=[];
  for(const show of item.shows||[]){
   const startMs=show?.startMs??show?.start;
   if(!show?.channelId||typeof startMs!=='number'){units.push(unportable(entry,'candidate',targetId,'show_fields_missing','discovery'));return;}
   shows.push({channelId:show.channelId,channel:show.channel??null,startMs,endMs:show.endMs??show.end??null,epgTitle:show.epgTitle??show.title??null});
  }
  const evidence=evidenceFor(item,deriveEvidence);
  if(evidence.mismatch){blockers.push({reason:'evidence_mismatch',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:'candidate',targetId,stored:evidence.stored,derived:evidence.derived});return;}
  candidates.push({observationKey,title:item.title,normalizedTitle:item.normalizedTitle,year:item.year??null,rawTitles:item.rawTitles||[item.title],durations:item.durations||[],description:item.description??null,evidenceKey:evidence.key,evidenceProvenance:evidence.provenance,shows,activity:item.activity||'current',lastSeenProgrammeRunId:item.lastSeenProgrammeRunId??null,confirmedTmdbId:item.confirmedTmdbId??null});
 });
 return {candidates,units,blockers};
}

// A stored decision is imported only against the candidate it belongs to. A decision with no stored key takes the derived key; one
// whose stored key differs was taken against earlier airings and keeps that key with provenance stale_evidence, as the runtime does
// (a final status stays final, any other becomes actionable again). The provenance says which.
export function decisionUnits(entry,body,programmeRunId,{candidates=[],identity}={}){
 requireIdentity(identity);
 const byKey=new Map(candidates.map(candidate=>[candidate.observationKey,candidate]));
 const entries=Object.entries(body||{}).filter(([key,value])=>key!=='__canonicalizedAt'&&value&&typeof value==='object');
 if(!entries.length)return {units:[unportable(entry,'candidate_decision',entry.key,'observation_fields_missing','discovery')],blockers:[]};
 const units=[],blockers=[];
 for(const [key,value] of entries){
  if(!value.status||!value.checkedAt){units.push(unportable(entry,'candidate_decision',key,'observation_fields_missing','discovery'));continue;}
  const candidate=byKey.get(key);
  if(!candidate){units.push(unresolved(entry,'candidate_decision',key,'decision_without_candidate','discovery',null));continue;}
  const stored=value.evidenceKey||null;
  const evidenceProvenance=!stored?'derived':stored===candidate.evidenceKey?'stored':'stale_evidence';
  let filmId=null,identityProvenance=null;
  if(value.filmId!=null){
   const resolved=identity.resolve(value.filmId);
   if(!resolved.filmId){units.push(unresolved(entry,'candidate_decision',key,resolved.reason,'discovery',resolved));continue;}
   filmId=resolved.filmId;
   identityProvenance=provenanceOf(resolved);
  }
  const provenance={...(value.provenance&&typeof value.provenance==='object'?value.provenance:{}),importEvidence:evidenceProvenance,importIdentity:identityProvenance?.via??null};
  units.push({...unit({family:'discovery',kind:'decision',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:'candidate_decision',targetId:key,input:{observationKey:key,programmeRunId,status:value.status,reason:value.reason??null,evidenceKey:stored||candidate.evidenceKey,fenceEvidenceKey:candidate.evidenceKey,checkedAt:value.checkedAt,attempts:value.attempts??0,filmId,tmdbId:value.tmdbId??null,canonicalIdentity:value.canonicalIdentity??null,identitySource:value.identitySource??null,terminalReason:value.terminalReason??null,retryAt:value.retryAt??null,provenance}}),evidence:evidenceProvenance,identity:identityProvenance});
 }
 return {units,blockers};
}

function versionUnit(entry,filmId,item,table,targetId,resolved,links,storedId){
 if(!item||typeof item!=='object')return unportable(entry,table,targetId,'prediction_fields_missing','prediction');
 const problem=versionPointerProblem(item,entry.key,storedId,links);
 if(problem)return unportable(entry,table,targetId,problem,'prediction');
 const updatedAt=item.updatedAt||item.generatedAt||null;
 if(typeof item.tasteProfileVersion!=='number'||!item.tasteProfileHash||!item.fingerprintHash||typeof item.fingerprintSchemaVersion!=='number'||typeof item.predictionPromptVersion!=='number'||typeof item.predictedRating!=='number'||!updatedAt)return unportable(entry,table,targetId,'prediction_fields_missing','prediction');
 return unit({family:'prediction',kind:'prediction',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:table,targetId,identity:provenanceOf(resolved),input:{filmId,tasteProfileVersion:item.tasteProfileVersion,tasteProfileHash:item.tasteProfileHash,fingerprintHash:item.fingerprintHash,fingerprintSchemaVersion:item.fingerprintSchemaVersion,predictionPromptVersion:item.predictionPromptVersion,predictedRating:item.predictedRating,r2Key:item.r2Key,contentSha256:item.contentSha256,updatedAt}});
}

async function applyUnit(repositories,unit){
 if(unit.kind==='person')return applied(await repositories.canonical.savePerson(unit.input));
 if(unit.kind==='film'){
  const saved=await repositories.canonical.saveFilm(unit.input);
  const wanted=unit.input.film?.localization?.value??null;
  const stored=saved?.dimensions?.localization?.value??null;
  if(wanted!=null&&stored!==wanted)return {outcome:'explained',reason:'reviewed_kept'};
  return applied(saved);
 }
 if(unit.kind==='link')return applied(await repositories.canonical.applyLink(unit.input));
 if(unit.kind==='generation')return applied(await repositories.epg.publishGeneration(unit.input));
 if(unit.kind==='decision'){
  const saved=await repositories.epg.recordDecision(unit.input);
  const current=saved?.decision?.current;
  const same=!!current&&current.status===unit.input.status&&current.evidenceKey===unit.input.evidenceKey&&current.checkedAt===unit.input.checkedAt&&(current.terminalReason??null)===(unit.input.terminalReason??null);
  if(!saved?.applied||!same)return {outcome:'explained',reason:saved?.reason||'decision_rejected'};
  return applied(saved);
 }
 if(unit.kind==='score')return applied(await repositories.epg.recordScore(unit.input));
 if(unit.kind==='profile')return applied(await repositories.prediction.saveProfile(unit.input));
 if(unit.kind==='fingerprint'){
  const saved=await repositories.prediction.saveFingerprint(unit.input);
  if(saved.fingerprintHash!==unit.input.fingerprintHash||saved.generatedAt!==(unit.input.generatedAt??null))return {outcome:'explained',reason:'fingerprint_kept'};
  return applied(saved);
 }
 if(unit.kind==='prediction'){
  const saved=await repositories.prediction.savePrediction(unit.input);
  const current=saved?.prediction;
  if(!current||current.updatedAt!==unit.input.updatedAt||current.r2Key!==unit.input.r2Key)return {outcome:'explained',reason:'prediction_kept'};
  return applied(saved);
 }
 if(unit.kind==='rating'){
  const saved=await repositories.prediction.saveActualRating(unit.input);
  if(saved.recordedAt!==unit.input.recordedAt||saved.rating!==unit.input.rating)return {outcome:'explained',reason:'rating_kept'};
  return applied(saved);
 }
 throw new Error('Unknown import unit');
}

function applied(stored){return {outcome:'applied',stored};}
async function receiptExists(db,unit){return !!(await db.get('SELECT 1 AS ok FROM import_receipt WHERE source_key=? AND source_sha256=? AND target_table=? AND target_id=?',[unit.sourceKey,unit.sourceSha256,unit.targetTable,unit.targetId]));}
function knownReason(error){
 const message=String(error?.message||'');
 if(KNOWN_CONFLICTS.has(message))return message;
 if(/FOREIGN KEY/i.test(message))return 'reference_missing';
 return 'unapplied';
}
export function acknowledgementKey(row){return [row.sourceKey,row.targetTable,row.targetId,row.reason].map(part=>String(part??'')).join('\n');}
function classOf(unit,outcome,reason){
 if(outcome==='superseded')return 'S';
 if(outcome==='unresolved')return 'C';
 if(outcome==='unportable')return SOURCE_QUALITY.test(String(reason||''))?'C':'A';
 return 'A';
}
function entry(unit,outcome,reason){
 const row={family:unit.family,sourceKey:unit.sourceKey,sourceSha256:unit.sourceSha256??null,targetTable:unit.targetTable,targetId:unit.targetId,outcome,reason,class:classOf(unit,outcome,reason)};
 if(unit.identity)row.identity=unit.identity;
 if(unit.evidence)row.evidence=unit.evidence;
 if(unit.unresolvedFilms)row.unresolvedFilms=unit.unresolvedFilms;
 if(unit.supersededBy){row.sourceAt=unit.sourceAt;row.supersededBy=unit.supersededBy;if(unit.records!=null)row.records=unit.records;}
 return row;
}
function unit(fields){return {...fields,unportable:false,unresolved:false};}
function unportable(entry,targetTable,targetId,reason,family){return {family,kind:'unportable',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable,targetId,unportable:true,unresolved:false,reason};}
function supersededUnit(entry,targetTable,targetId,family,decision){return {family,kind:'superseded',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable,targetId,unportable:false,unresolved:false,superseded:true,reason:decision.reason,identity:decision.identity,sourceAt:decision.sourceAt,supersededBy:decision.supersededBy,...(decision.records!=null?{records:decision.records}:{})};}
// An unresolved unit names a source record the importer refuses to turn into a row. The object stays in the source and no id is minted.
function unresolved(entry,targetTable,targetId,reason,family,resolution){return {family,kind:'unresolved',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable,targetId,unportable:false,unresolved:true,reason,identity:resolution?provenanceOf(resolution):null};}
function provenanceOf(resolution){return resolution?{source:resolution.source??null,canonical:resolution.canonical??null,filmId:resolution.filmId??null,via:resolution.via??null,reason:resolution.reason??null,...(resolution.tmdbId?{tmdbId:resolution.tmdbId}:{}),...(resolution.metadataSha256?{metadataSha256:resolution.metadataSha256}:{})}:null;}
function requireIdentity(identity){if(typeof identity?.resolve!=='function')throw new Error('The shared identity resolver is required');}
function requireEvidence(derive){if(typeof derive!=='function')throw new Error('The shared candidateEvidence rule is required');}
function enrichmentStoredId(key){
 const match=String(key).match(/^enrichment\/films\/([^/]+)\/(?:fingerprint|predictions|actual)\.json$/);
 if(!match)return null;
 try{return decodeURIComponent(match[1]);}catch{return match[1];}
}
function enrichmentIdentity(key,identity){
 requireIdentity(identity);
 const stored=enrichmentStoredId(key);
 if(!stored)return {source:null,canonical:null,filmId:null,via:null,reason:'identity_unreadable'};
 return identity.resolve(stored);
}
function evidenceFor(item,deriveEvidence){
 const derived=deriveEvidence(item);
 const stored=item?.evidenceKey||null;
 if(stored&&stored!==derived)return {key:null,provenance:null,mismatch:true,stored,derived};
 return {key:derived,provenance:stored?'stored':'derived',mismatch:false,stored,derived};
}
function emptyCoverage(){return {denominator:0,mapped:[],r2_only:[],excluded:[],unmapped:[],r2OnlyFamilies:[]};}
function provenanceSummary(units){
 const summary={identity:{direct:0,redirect:0,metadata_tmdb:0},evidence:{stored:0,derived:0,stale_evidence:0},superseded:0};
 for(const unit of units){
  if(unit.superseded){summary.superseded++;continue;}
  if(unit.identity?.via&&summary.identity[unit.identity.via]!=null)summary.identity[unit.identity.via]++;
  if(unit.kind==='decision'&&unit.evidence&&summary.evidence[unit.evidence]!=null)summary.evidence[unit.evidence]++;
  if(unit.kind==='generation')for(const candidate of unit.input?.candidates||[])if(candidate.evidenceProvenance&&summary.evidence[candidate.evidenceProvenance]!=null)summary.evidence[candidate.evidenceProvenance]++;
 }
 return summary;
}
function isMappedKey(key){
 if(isArchiveKey(key))return true;
 if(['watchlist.json','programme.json','metadata.json','titles.json','people.json','epg/published-generation.json','epg/discovery-latest.json','epg/discovery-resolution.json','epg/discovered-films.json','enrichment/profile/current.json'].includes(key))return true;
 return /^enrichment\/profile\/versions\/\d+\.json$/.test(key)||/^enrichment\/films\/[^/]+\/(?:fingerprint|predictions|actual)\.json$/.test(key)||VERSION_OBJECT.test(key)||isFingerprintVersionKey(key);
}
function withCredits(unit){
 if(unit.kind!=='film'||!Array.isArray(unit.desiredCredits))return unit;
 return {...unit,input:{...unit.input,credits:unit.desiredCredits}};
}
async function creditGate(db,unit){
 if(!Array.isArray(unit.desiredCredits))return {ready:true,unmatched:0};
 const missing=[];
 for(const credit of unit.desiredCredits)if(!(await db.get('SELECT 1 AS ok FROM person WHERE id=?',[credit.personId])))missing.push(credit.personId);
 return {ready:missing.length+(unit.unmatchedCredits||0)===0,unmatched:missing.length+(unit.unmatchedCredits||0)};
}
async function checkpoint(db,unit,importedAt){
 try{
  if(typeof db.beforeReceipt==='function'){const hook=db.beforeReceipt;db.beforeReceipt=null;await hook();}
  await db.transaction(async()=>{await db.run('INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES (?,?,?,?,?) ON CONFLICT(source_key,source_sha256,target_table,target_id) DO NOTHING',[unit.sourceKey,unit.sourceSha256,unit.targetTable,unit.targetId,importedAt]);});
  return {ok:true};
 }catch(error){if(error?.message==='receipt_failed')return {ok:false};throw error;}
}
function matchable(kind){return kind==='film'||kind==='person'||kind==='fingerprint'||kind==='prediction'||kind==='rating'||kind==='decision'||kind==='profile';}
async function storedMatches(db,repositories,unit){
 if(unit.kind==='film')return filmStored(repositories,unit);
 if(unit.kind==='person')return personStored(repositories,unit);
 if(unit.kind==='fingerprint'){const row=await db.get('SELECT schema_version,fingerprint_hash,generated_at,invalidated_at,r2_key,content_sha256 FROM fingerprint_payload WHERE film_id=?',[unit.targetId]);return !!row&&row.schema_version===unit.input.schemaVersion&&row.fingerprint_hash===unit.input.fingerprintHash&&(row.generated_at??null)===(unit.input.generatedAt??null)&&(row.invalidated_at??null)===(unit.input.invalidatedAt??null)&&row.r2_key===unit.input.r2Key&&row.content_sha256===unit.input.contentSha256;}
 if(unit.kind==='prediction'){const row=await db.get('SELECT taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at FROM prediction_current WHERE film_id=?',[unit.input.filmId]);return !!row&&row.taste_profile_version===unit.input.tasteProfileVersion&&row.taste_profile_hash===unit.input.tasteProfileHash&&row.fingerprint_hash===unit.input.fingerprintHash&&row.fingerprint_schema_version===unit.input.fingerprintSchemaVersion&&row.prediction_prompt_version===unit.input.predictionPromptVersion&&row.predicted_rating===unit.input.predictedRating&&row.r2_key===unit.input.r2Key&&row.content_sha256===unit.input.contentSha256&&row.updated_at===unit.input.updatedAt;}
 if(unit.kind==='rating'){const row=await db.get('SELECT rating,source,recorded_at FROM actual_rating WHERE film_id=?',[unit.targetId]);return !!row&&row.rating===unit.input.rating&&row.source===unit.input.source&&row.recorded_at===unit.input.recordedAt;}
 if(unit.kind==='decision'){const row=await db.get('SELECT status,evidence_key,checked_at,terminal_reason,film_id FROM candidate_decision WHERE observation_key=?',[unit.targetId]);return !!row&&row.status===unit.input.status&&row.evidence_key===unit.input.evidenceKey&&row.checked_at===unit.input.checkedAt&&(row.terminal_reason??null)===(unit.input.terminalReason??null)&&(row.film_id??null)===(unit.input.filmId??null);}
 if(unit.kind==='profile'){const row=await db.get('SELECT profile_hash,created_at,r2_key,content_sha256 FROM profile_version WHERE version=?',[unit.input.version]);return !!row&&row.profile_hash===unit.input.profileHash&&row.created_at===unit.input.createdAt&&row.r2_key===unit.input.r2Key&&row.content_sha256===unit.input.contentSha256;}
 return false;
}
async function filmStored(repositories,unit){
 if((unit.unmatchedCredits||0)>0)return false;
 const saved=await repositories.canonical.readFilm(unit.targetId);
 if(!saved)return false;
 const film=unit.input.film||{};
 if((saved.originalTitle??null)!==(film.originalTitle??null))return false;
 if((saved.canonicalIdentity??null)!==(film.canonicalIdentity??null))return false;
 if(saved.contractVersion!==film.contractVersion)return false;
 if(typeof unit.input.watchlist==='boolean'&&saved.watchlist!==unit.input.watchlist)return false;
 if(!sameLocalization(saved.dimensions?.localization,film.localization))return false;
 if(identityText(saved.externalIds)!==identityText(film.externalIds))return false;
 if(aliasText(saved.aliases)!==aliasText(film.aliases))return false;
 const credits=Array.isArray(unit.desiredCredits)?unit.desiredCredits:Array.isArray(unit.input.credits)?unit.input.credits:null;
 if(credits&&creditText(saved.credits)!==creditText(credits))return false;
 if(unit.input.metadata&&metaText(saved.metadata)!==metaText(unit.input.metadata))return false;
 return true;
}
async function personStored(repositories,unit){
 const saved=await repositories.canonical.readPerson(unit.targetId);
 if(!saved)return false;
 const person=unit.input.person||{};
 if(saved.roleId!==person.roleId||saved.contractVersion!==person.contractVersion)return false;
 if(!sameLocalization(saved.dimensions?.localization,person.localization))return false;
 if(identityText(saved.externalIds)!==identityText(person.externalIds))return false;
 if(aliasText(saved.aliases)!==aliasText(person.aliases))return false;
 return true;
}

// The source projection is independent of the write list: every mapped object is projected to the rows it must produce,
// through the same identity and evidence rules, and the read-back is compared against that projection.
export function projectSource({keys=[],bodies={},films=[],people=[],rosters={},listed={},shas={},identity,deriveEvidence,links=null,ratings=null,superseded=null,fingerprintContentSha256=null}={}){
 requireIdentity(identity);
 const expected={films:[],persons:[],fingerprints:[],ratings:[],predictions:[],redirects:[],decisions:[],candidates:[],generations:[],profiles:[],records:[],unprojected:[],r2Only:[],blockers:[]};
 for(const film of films){
  const roster=rosters[film.id]||{credits:[],unmatched:0};
  expected.films.push({id:film.id,originalTitle:film.originalTitle??null,canonicalIdentity:film.canonicalIdentity??null,contractVersion:film.contractVersion,watchlist:!!listed[film.id],localization:film.localization?.value??null,localizationStatus:film.localization?.status??null,localizationAuthority:film.localization?.provenance?.authority??null,credits:roster.credits||[],externalIds:(film.externalIds||[]).map(identityView),aliases:(film.aliases||[]).map(aliasView),metadata:null});
  for(const redirect of film.redirects||[])if(redirect?.from&&redirect?.to&&redirect?.at)expected.redirects.push({id:redirect.from,toFilmId:redirect.to,at:redirect.at});
 }
 for(const person of people)expected.persons.push({id:person.id,roleId:person.roleId,contractVersion:person.contractVersion,localization:person.localization?.value??null,localizationStatus:person.localization?.status??null,externalIds:(person.externalIds||[]).map(identityView),aliases:(person.aliases||[]).map(aliasView)});
 const filmRow=id=>expected.films.find(film=>film.id===id);
 const accounted=new Set();
 const note=(key,disposition,id,extra)=>expected.records.push({key,disposition,id,...(extra||{})});
 const recordIdentity=(key,storedId)=>{
  const resolved=ratings&&key.endsWith('/actual.json')?ratings.resolve(key):identity.resolve(storedId);
  if(resolved.filmId)return resolved;
  note(key,'unresolved',resolved.canonical||String(storedId??key),{reason:resolved.reason,identity:provenanceOf(resolved)});
  return null;
 };
 for(const key of keys){
  const kind=classifyObject(key);
  if(kind==='excluded')continue;
  if(kind==='r2_only'){expected.r2Only.push(key);continue;}
  if(kind==='unmapped'){expected.unprojected.push(key);continue;}
  if(isFingerprintVersionKey(key))continue;
  accounted.add(key);
  const body=bodies[key];
  if(key==='watchlist.json'){for(const record of body?.films||[]){const resolved=recordIdentity(key,record?.id);if(resolved)note(key,'mapped',resolved.filmId,{identity:provenanceOf(resolved)});}continue;}
  if(key==='programme.json'||key==='epg/published-generation.json')continue;
  if(key==='metadata.json'){for(const [id,record] of Object.entries(body||{})){const resolved=recordIdentity(key,record?.id??id);if(!resolved)continue;const metadata=catalogMetadata(record,key,shas[key]||null);if(metadata){filmRow(resolved.filmId).metadata=metadataView(metadata);note(key,'mapped',resolved.filmId,{identity:provenanceOf(resolved)});}else note(key,'unportable',resolved.filmId,{reason:'metadata_fields_missing'});}continue;}
  if(key==='people.json'){for(const record of peopleRecords(body))note(key,expected.persons.some(person=>person.roleId===record?.id||person.id==='person:'+record?.id)?'mapped':'unportable',String(record?.id??key));continue;}
  if(key==='titles.json'){for(const [id,value] of Object.entries(body||{}))note(key,expected.films.some(film=>film.localization===value||film.aliases.some(alias=>alias.value===value))?'mapped':'unportable',id);continue;}
  if(key==='epg/discovered-films.json'){for(const record of Array.isArray(body)?body:Object.values(body||{})){const resolved=recordIdentity(key,record?.id);if(resolved)note(key,'mapped',resolved.filmId,{identity:provenanceOf(resolved)});}continue;}
  if(key==='epg/discovery-latest.json'||key==='epg/discovery-resolution.json'||isArchiveKey(key))continue;
  if(key==='enrichment/profile/current.json'){const version='enrichment/profile/versions/'+body?.version+'.json';note(key,keys.includes(version)?'mapped':'unportable',String(body?.version??key));continue;}
  if(/^enrichment\/profile\/versions\/\d+\.json$/.test(key)){if(typeof body?.version==='number'&&body.profileHash&&(body.createdAt||body.updatedAt)){expected.profiles.push({id:body.version,profileHash:body.profileHash,createdAt:body.createdAt||body.updatedAt,r2Key:key,contentSha256:shas[key]||null});note(key,'mapped',String(body.version));}else note(key,'unportable',String(body?.version??key));continue;}
  if(VERSION_OBJECT.test(key)){
   // A version object is mapped through the bundle that points at it. One nothing points at was written before a bundle write that never
   // followed: no row is derived from it, the Worker never deletes it, and it is listed as unreferenced rather than hidden or counted as parity.
   const parsed=key.match(VERSION_OBJECT);let stored=null;try{stored=decodeURIComponent(parsed[1]);}catch{stored=null;}
   const bundleKey=stored==null?null:'enrichment/films/'+parsed[1]+'/predictions.json';
   const bundle=bundleKey&&keys.includes(bundleKey)?bodies[bundleKey]:null;
   const referenced=!!bundle&&[bundle.current,...(Array.isArray(bundle.history)?bundle.history:[])].some(item=>item&&item.r2Key===key);
   if(referenced)note(key,'mapped',stored!=null?(identity.resolve(stored).filmId||identity.canonical(stored)||key):key,{via:'bundle_pointer'});
   else note(key,'unreferenced',stored!=null?(identity.canonical(stored)||key):key,{reason:'version_unreferenced'});
   continue;
  }
  if(/^enrichment\/films\/[^/]+\/(?:fingerprint|actual|predictions)\.json$/.test(key)){
   const resolved=recordIdentity(key,enrichmentStoredId(key));
   if(!resolved)continue;
   const filmId=resolved.filmId,provenance={identity:provenanceOf(resolved)};
   const replaced=superseded?.resolve(key);
   if(replaced?.superseded){note(key,'superseded',filmId,{...provenance,reason:replaced.reason,supersededBy:replaced.supersededBy});continue;}
   if(key.endsWith('/fingerprint.json')){if(body?.fingerprintHash){expected.fingerprints.push({id:filmId,fingerprintHash:body.fingerprintHash,schemaVersion:body.schemaVersion??body.fingerprintSchemaVersion,generatedAt:body.generatedAt??null,invalidatedAt:body.invalidatedAt??null,r2Key:key,contentSha256:shas[key]||null});note(key,'mapped',filmId,provenance);}else note(key,'unportable',filmId,{...provenance,reason:'fingerprint_fields_missing'});continue;}
   if(key.endsWith('/actual.json')){const recordedAt=body?.recordedAt||body?.updatedAt||null;if(typeof body?.rating==='number'&&body.source&&recordedAt){expected.ratings.push({id:filmId,rating:body.rating,source:body.source,recordedAt});note(key,'mapped',filmId,provenance);}else note(key,'unportable',filmId,{...provenance,reason:'rating_fields_missing'});continue;}
   const projection=predictionExpectation(key,filmId,body,enrichmentStoredId(key),links);
   if(projection.current){expected.predictions.push(projection.current);note(key,'mapped',filmId,provenance);}else note(key,'unportable',filmId,{...provenance,reason:projection.reason});
   continue;
  }
  note(key,'unportable',key);
 }
 const fingerprintVersions=readFingerprintVersions({keys,bodies,shas,contentSha256:fingerprintContentSha256});
 for(const record of fingerprintVersions.records)note(record.key,record.disposition,record.id,record.via?{via:record.via}:{reason:record.reason});
 expected.blockers.push(...fingerprintVersions.blockers);
 expected.fingerprintVersions=fingerprintVersions.summary;
 const programmeKey=keys.includes('programme.json')?'programme.json':null;
 const archive=archiveExpectation(keys.includes('epg/discovery-latest.json')?bodies['epg/discovery-latest.json']:null,bodies,shas,keys);
 for(const record of archive.records)note(record.key,record.disposition,record.id);
 expected.blockers.push(...archive.blockers);
 const discovery=keys.includes('epg/discovery-latest.json')?discoveryRecords({items:archive.items},deriveEvidence):{portable:true,items:[],blockers:[]};
 expected.blockers.push(...discovery.blockers.map(blocker=>({...blocker,sourceKey:'epg/discovery-latest.json',sourceSha256:shas['epg/discovery-latest.json']||null})));
 const discoveryPortable=discovery.portable&&discovery.blockers.length===0;
 if(programmeKey){
  const programme=bodies[programmeKey];
  const pointer=bodies['epg/published-generation.json']||{programmeRunId:programme?.runId||null,phase:'published'};
  const generation=discoveryPortable?generationExpectation(pointer,programme,identity):null;
  if(generation&&!generation.unresolved){expected.generations.push(generation);if(generation.phase==='published')expected.publishedPointer=generation.id;note(programmeKey,'mapped',generation.id);if(keys.includes('epg/published-generation.json'))note('epg/published-generation.json','mapped',generation.id);}
  else{const disposition=generation?.unresolved?'unresolved':'unportable';note(programmeKey,disposition,pointer?.programmeRunId||programmeKey,generation?.unresolved?{reason:generation.reason,unresolvedFilms:generation.unresolvedFilms}:undefined);if(keys.includes('epg/published-generation.json'))note('epg/published-generation.json',disposition,pointer?.programmeRunId||'epg/published-generation.json');}
 }
 if(keys.includes('epg/discovery-latest.json')){
  const runId=expected.generations[0]?.id||null;
  for(const item of discovery.items){
   if(!discoveryPortable||!runId)note('epg/discovery-latest.json','unportable',item.id);
   else{expected.candidates.push({id:item.id,programmeRunId:runId,evidenceKey:item.evidenceKey,title:item.title,normalizedTitle:item.normalizedTitle,...(item.shows?{shows:item.shows}:{})});note(archive.origin.get(item.id)||'epg/discovery-latest.json','mapped',item.id,{evidence:item.evidenceProvenance});}
  }
  if(!discovery.items.length)note('epg/discovery-latest.json','unportable','epg/discovery-latest.json');
 }
 if(keys.includes('epg/discovery-resolution.json')){
  const entries=Object.entries(bodies['epg/discovery-resolution.json']||{}).filter(([id,value])=>id!=='__canonicalizedAt'&&value&&typeof value==='object');
  const runId=expected.generations[0]?.id||null;
  const byKey=new Map(discovery.items.map(item=>[item.id,item]));
  if(!entries.length)note('epg/discovery-resolution.json','unportable','epg/discovery-resolution.json');
  for(const [id,value] of entries){
   const candidate=byKey.get(id);
   if(!runId||!value.status||!value.checkedAt){note('epg/discovery-resolution.json','unportable',id);continue;}
   if(!candidate){note('epg/discovery-resolution.json','unresolved',id,{reason:'decision_without_candidate'});continue;}
   let filmId=null;
   if(value.filmId!=null){const resolved=identity.resolve(value.filmId);if(!resolved.filmId){note('epg/discovery-resolution.json','unresolved',id,{reason:resolved.reason,identity:provenanceOf(resolved)});continue;}filmId=resolved.filmId;}
   expected.decisions.push({id,status:value.status,evidenceKey:value.evidenceKey||candidate.evidenceKey,terminalReason:value.terminalReason??null,filmId});
   note('epg/discovery-resolution.json','mapped',id,{evidence:!value.evidenceKey?'derived':value.evidenceKey===candidate.evidenceKey?'stored':'stale_evidence'});
  }
 }
 for(const key of keys)if(classifyObject(key)==='mapped'&&!accounted.has(key)&&!expected.records.some(record=>record.key===key))expected.unprojected.push(key);
 expected.denominator=['films','persons','redirects','fingerprints','ratings','predictions','profiles','generations','candidates','decisions'].reduce((sum,key)=>sum+expected[key].length,0);
 return expected;
}


async function verifyFilms(db,films,missing,extra,mismatched){
 const rows=await db.all('SELECT id,original_title,canonical_identity,contract_version FROM film ORDER BY id');
 const wanted=new Map(films.map(film=>[film.id,film]));
 for(const film of films)if(!rows.some(row=>row.id===film.id))missing.push({table:'film',id:film.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'film',id:row.id});
 for(const film of films){
  const row=rows.find(item=>item.id===film.id);
  if(!row)continue;
  if('originalTitle' in film&&(row.original_title??null)!==(film.originalTitle??null))mismatched.push({table:'film',id:film.id,field:'original_title'});
  if('canonicalIdentity' in film&&(row.canonical_identity??null)!==(film.canonicalIdentity??null))mismatched.push({table:'film',id:film.id,field:'canonical_identity'});
  if('contractVersion' in film&&row.contract_version!==film.contractVersion)mismatched.push({table:'film',id:film.id,field:'contract_version'});
  if('watchlist' in film){const listed=await db.get('SELECT 1 AS ok FROM watchlist_film WHERE film_id=?',[film.id]);if(!!listed!==!!film.watchlist)mismatched.push({table:'watchlist_film',id:film.id,field:'watchlist'});}
  if('localization' in film||'localizationStatus' in film){const stored=await db.get("SELECT value,status,authority FROM film_dimension WHERE film_id=? AND dimension='localization'",[film.id]);if('localization' in film&&(stored?.value??null)!==(film.localization??null))mismatched.push({table:'film_dimension',id:film.id,field:'localization'});if('localizationStatus' in film&&(stored?.status??null)!==(film.localizationStatus??null))mismatched.push({table:'film_dimension',id:film.id,field:'localization_status'});}
  if('credits' in film){const credits=await db.all('SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id=?',[film.id]);if(creditText(credits.map(item=>({personId:item.person_id,role:item.role,ordinal:item.ordinal})))!==creditText(film.credits||[]))mismatched.push({table:'film_person_credit',id:film.id,field:'credits'});}
  if('externalIds' in film){const ids=await db.all('SELECT scheme,value,trusted,conflicting FROM film_external_id WHERE film_id=?',[film.id]);if(identityText(ids.map(item=>({scheme:item.scheme,value:item.value,trusted:item.trusted===1,conflicting:item.conflicting===1})))!==identityText(film.externalIds))mismatched.push({table:'film_external_id',id:film.id,field:'external_id'});}
  if('aliases' in film){const aliases=await db.all('SELECT kind,value FROM film_alias WHERE film_id=?',[film.id]);if(aliasText(aliases)!==aliasText(film.aliases))mismatched.push({table:'film_alias',id:film.id,field:'alias'});}
  if('metadata' in film){const stored=await db.get('SELECT synopsis,year,runtime,people_version FROM film_metadata WHERE film_id=?',[film.id]);if(metaText(stored)!==metaText(film.metadata))mismatched.push({table:'film_metadata',id:film.id,field:'metadata'});}
 }
}
async function verifyPersons(db,persons,missing,extra,mismatched){
 const rows=await db.all('SELECT id,role_id,contract_version FROM person ORDER BY id');
 const wanted=new Map(persons.map(person=>[person.id,person]));
 for(const person of persons)if(!rows.some(row=>row.id===person.id))missing.push({table:'person',id:person.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'person',id:row.id});
 for(const person of persons){
  const row=rows.find(item=>item.id===person.id);
  if(!row)continue;
  if('roleId' in person&&row.role_id!==person.roleId)mismatched.push({table:'person',id:person.id,field:'role_id'});
  if('contractVersion' in person&&row.contract_version!==person.contractVersion)mismatched.push({table:'person',id:person.id,field:'contract_version'});
  if('localization' in person||'localizationStatus' in person){const stored=await db.get("SELECT value,status FROM person_dimension WHERE person_id=? AND dimension='localization'",[person.id]);if('localization' in person&&(stored?.value??null)!==(person.localization??null))mismatched.push({table:'person_dimension',id:person.id,field:'name'});if('localizationStatus' in person&&(stored?.status??null)!==(person.localizationStatus??null))mismatched.push({table:'person_dimension',id:person.id,field:'localization_status'});}
  if('externalIds' in person){const ids=await db.all('SELECT scheme,value,trusted,conflicting FROM person_external_id WHERE person_id=?',[person.id]);if(identityText(ids.map(item=>({scheme:item.scheme,value:item.value,trusted:item.trusted===1,conflicting:item.conflicting===1})))!==identityText(person.externalIds))mismatched.push({table:'person_external_id',id:person.id,field:'external_id'});}
  if('aliases' in person){const aliases=await db.all('SELECT kind,value FROM person_alias WHERE person_id=?',[person.id]);if(aliasText(aliases)!==aliasText(person.aliases))mismatched.push({table:'person_alias',id:person.id,field:'alias'});}
 }
}
async function verifyRedirects(db,redirects,missing,extra,mismatched){
 const rows=await db.all('SELECT from_id AS id,to_film_id,at FROM film_redirect ORDER BY from_id');
 const wanted=new Map(redirects.map(row=>[row.id,row]));
 for(const row of redirects)if(!rows.some(stored=>stored.id===row.id))missing.push({table:'film_redirect',id:row.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'film_redirect',id:row.id});
 for(const row of redirects){const stored=rows.find(item=>item.id===row.id);if(stored&&('toFilmId' in row&&stored.to_film_id!==row.toFilmId||'at' in row&&stored.at!==row.at))mismatched.push({table:'film_redirect',id:row.id,field:'redirect'});}
}
async function verifyFingerprints(db,fingerprints,missing,extra,mismatched){
 const rows=await db.all('SELECT film_id AS id,schema_version,fingerprint_hash,generated_at,invalidated_at,r2_key,content_sha256 FROM fingerprint_payload ORDER BY film_id');
 const wanted=new Map(fingerprints.map(row=>[row.id,row]));
 for(const row of fingerprints)if(!rows.some(stored=>stored.id===row.id))missing.push({table:'fingerprint_payload',id:row.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'fingerprint_payload',id:row.id});
 for(const row of fingerprints){
  const stored=rows.find(item=>item.id===row.id);
  if(!stored)continue;
  if(('fingerprintHash' in row&&stored.fingerprint_hash!==row.fingerprintHash)||('generatedAt' in row&&(stored.generated_at??null)!==(row.generatedAt??null))||('invalidatedAt' in row&&(stored.invalidated_at??null)!==(row.invalidatedAt??null))||('r2Key' in row&&stored.r2_key!==row.r2Key)||('contentSha256' in row&&row.contentSha256!=null&&stored.content_sha256!==row.contentSha256))mismatched.push({table:'fingerprint_payload',id:row.id,field:'fingerprint'});
 }
}
async function verifyRatings(db,ratings,missing,extra,mismatched){
 const rows=await db.all('SELECT film_id AS id,rating,source,recorded_at FROM actual_rating ORDER BY film_id');
 const wanted=new Map(ratings.map(row=>[row.id,row]));
 for(const row of ratings)if(!rows.some(stored=>stored.id===row.id))missing.push({table:'actual_rating',id:row.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'actual_rating',id:row.id});
 for(const row of ratings){const stored=rows.find(item=>item.id===row.id);if(stored&&(stored.rating!==row.rating||stored.source!==row.source||stored.recorded_at!==row.recordedAt))mismatched.push({table:'actual_rating',id:row.id,field:'rating'});}
}
async function verifyPredictions(db,predictions,missing,extra,mismatched){
 const rows=await db.all('SELECT film_id AS id,predicted_rating,updated_at,r2_key,fingerprint_hash,content_sha256 FROM prediction_current ORDER BY film_id');
 const wanted=new Map(predictions.map(row=>[row.id,row]));
 for(const row of predictions)if(!rows.some(stored=>stored.id===row.id))missing.push({table:'prediction_current',id:row.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'prediction_current',id:row.id});
 for(const row of predictions){
  const stored=rows.find(item=>item.id===row.id);
  if(stored&&(stored.predicted_rating!==row.predictedRating||stored.updated_at!==row.updatedAt||('r2Key' in row&&stored.r2_key!==row.r2Key)||('fingerprintHash' in row&&stored.fingerprint_hash!==row.fingerprintHash)||('contentSha256' in row&&stored.content_sha256!==row.contentSha256)))mismatched.push({table:'prediction_current',id:row.id,field:'prediction'});
  if('history' in row){const history=await db.all('SELECT predicted_rating,r2_key,content_sha256,payload_json FROM prediction_history WHERE film_id=? ORDER BY replaced_at',[row.id]);if(history.length!==row.history.length||row.history.some((item,index)=>!sameHistory(history[index],item,row.id)))mismatched.push({table:'prediction_history',id:row.id,field:'history'});}
 }
}
async function verifyProfiles(db,profiles,missing,extra,mismatched){
 const rows=await db.all('SELECT version AS id,profile_hash,created_at,r2_key,content_sha256 FROM profile_version ORDER BY version');
 const wanted=new Map(profiles.map(row=>[row.id,row]));
 for(const row of profiles)if(!rows.some(stored=>stored.id===row.id))missing.push({table:'profile_version',id:row.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'profile_version',id:row.id});
 for(const row of profiles){const stored=rows.find(item=>item.id===row.id);if(stored&&(stored.profile_hash!==row.profileHash||stored.created_at!==row.createdAt||stored.r2_key!==row.r2Key||('contentSha256' in row&&stored.content_sha256!==row.contentSha256)))mismatched.push({table:'profile_version',id:row.id,field:'profile'});}
}
async function verifyGenerations(db,generations,missing,extra,mismatched){
 const rows=await db.all('SELECT programme_run_id AS id,phase FROM programme_generation ORDER BY programme_run_id');
 const wanted=new Map(generations.map(row=>[row.id,row]));
 for(const row of generations)if(!rows.some(stored=>stored.id===row.id))missing.push({table:'programme_generation',id:row.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'programme_generation',id:row.id});
 const shows=await db.all('SELECT programme_run_id,film_id,channel_id,start_ms,epg_title FROM film_show ORDER BY programme_run_id,film_id,start_ms');
 for(const row of generations){
  const stored=rows.find(item=>item.id===row.id);
  if(stored&&'phase' in row&&stored.phase!==row.phase)mismatched.push({table:'programme_generation',id:row.id,field:'phase'});
  if('shows' in row){const got=shows.filter(show=>show.programme_run_id===row.id).map(show=>show.film_id+'/'+show.channel_id+'/'+show.start_ms+'/'+(show.epg_title??'')).sort().join(',');const want=[...row.shows].map(show=>show.filmId+'/'+show.channelId+'/'+show.startMs+'/'+(show.epgTitle??'')).sort().join(',');if(got!==want)mismatched.push({table:'film_show',id:row.id,field:'shows'});}
  if('films' in row){const members=await db.all('SELECT film_id FROM film_generation WHERE programme_run_id=? ORDER BY film_id',[row.id]);const got=members.map(item=>item.film_id).join(',');const want=row.films.map(film=>film.filmId).sort().join(',');if(got!==want)mismatched.push({table:'film_generation',id:row.id,field:'membership'});}
 }
}
async function verifyPointer(db,pointer,mismatched){
 const row=await db.get('SELECT programme_run_id FROM published_generation WHERE id=1');
 if((row?.programme_run_id??null)!==(pointer??null))mismatched.push({table:'published_generation',id:pointer??'none',field:'pointer'});
}
async function verifyCandidates(db,candidates,missing,extra,mismatched){
 const rows=await db.all('SELECT programme_run_id,observation_key AS id,evidence_key FROM candidate_generation ORDER BY observation_key');
 const titles=await db.all('SELECT observation_key AS id,title,normalized_title FROM candidate ORDER BY observation_key');
 const wanted=new Set(candidates.map(row=>row.programmeRunId+'/'+row.id));
 for(const row of candidates)if(!rows.some(stored=>stored.programme_run_id===row.programmeRunId&&stored.id===row.id))missing.push({table:'candidate_generation',id:row.id});
 for(const row of rows)if(!wanted.has(row.programme_run_id+'/'+row.id))extra.push({table:'candidate_generation',id:row.id});
 for(const row of candidates){
  const stored=rows.find(item=>item.programme_run_id===row.programmeRunId&&item.id===row.id);
  const title=titles.find(item=>item.id===row.id);
  if(stored&&(stored.evidence_key!==row.evidenceKey||title?.title!==row.title||title?.normalized_title!==row.normalizedTitle))mismatched.push({table:'candidate_generation',id:row.id,field:'candidate'});
 }
 // Every distinct EPG entry of a candidate is stored once: two entries for one slot with different titles are both kept.
 const shows=await db.all('SELECT programme_run_id,observation_key,channel_id,start_ms,end_ms,epg_title FROM candidate_show');
 const byCandidate=new Map();
 for(const show of shows){const key=show.programme_run_id+'/'+show.observation_key;if(!byCandidate.has(key))byCandidate.set(key,[]);byCandidate.get(key).push(JSON.stringify([show.channel_id,show.start_ms,show.end_ms,show.epg_title]));}
 for(const row of candidates){
  if(!('shows' in row)||!rows.some(stored=>stored.programme_run_id===row.programmeRunId&&stored.id===row.id))continue;
  const got=(byCandidate.get(row.programmeRunId+'/'+row.id)||[]).sort();
  if(JSON.stringify(got)!==JSON.stringify(row.shows))mismatched.push({table:'candidate_show',id:row.id,field:'shows'});
 }
}
async function verifyDecisions(db,decisions,missing,extra,mismatched){
 const rows=await db.all('SELECT observation_key AS id,status,evidence_key,terminal_reason,film_id FROM candidate_decision ORDER BY observation_key');
 const wanted=new Map(decisions.map(row=>[row.id,row]));
 for(const row of decisions)if(!rows.some(stored=>stored.id===row.id))missing.push({table:'candidate_decision',id:row.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'candidate_decision',id:row.id});
 for(const row of decisions){const stored=rows.find(item=>item.id===row.id);if(stored&&(stored.status!==row.status||stored.evidence_key!==row.evidenceKey||(stored.terminal_reason??null)!==(row.terminalReason??null)||('filmId' in row&&(stored.film_id??null)!==(row.filmId??null))))mismatched.push({table:'candidate_decision',id:row.id,field:'decision'});}
}
function generationExpectation(pointer,programme,identity){
 const programmeRunId=pointer?.programmeRunId||programme?.runId||null;
 if(!programmeRunId||!Array.isArray(programme?.films))return null;
 const films=[],unresolvedFilms=[];
 for(const film of programme.films){
  if(!film||!Array.isArray(film.shows))return null;
  const resolved=identity.resolve(film.filmId||film.id);
  if(!resolved.filmId){unresolvedFilms.push(provenanceOf(resolved));continue;}
  const filmId=resolved.filmId;
  const shows=[];
  for(const show of film.shows){
   const startMs=show?.startMs??show?.start;
   if(!show?.channelId||typeof startMs!=='number')return null;
   shows.push({filmId,channelId:show.channelId,startMs,epgTitle:show.epgTitle??show.title??null});
  }
  films.push({filmId,shows});
 }
 if(unresolvedFilms.length)return {id:programmeRunId,unresolved:true,reason:unresolvedFilms[0].reason,unresolvedFilms};
 return {id:programmeRunId,phase:pointer?.phase==='withheld'?'withheld':'published',films,shows:films.flatMap(film=>film.shows)};
}
// Parity's own reading of a candidate's shows, independent of the repository: every distinct EPG entry (channel, start, end,
// title) once, as sorted identity strings. A malformed show leaves the candidate unportable, so its shows are not compared.
function expectedCandidateShows(shows){
 const identities=new Set();
 for(const show of Array.isArray(shows)?shows:[]){
  const startMs=show?.startMs??show?.start;
  if(!show?.channelId||typeof startMs!=='number')return null;
  identities.add(JSON.stringify([show.channelId,startMs,show.endMs??show.end??null,show.epgTitle??show.title??null]));
 }
 return [...identities].sort();
}
// Parity's own reading of a bounded ledger, written apart from readDiscoveryArchive: the active rows, then the payloads of the
// segment objects that the named manifest lists, an active key winning. An archive object outside that read is unreferenced: it
// stays in R2 and is not history. A named object that is absent or differs from the manifest's checksum stops the expectation.
function archiveExpectation(ledger,bodies,shas,keys){
 const archiveKeys=keys.filter(isArchiveKey),records=[],blockers=[],origin=new Map(),items=Array.isArray(ledger?.items)?[...ledger.items]:[];
 const named=ledger?.archive?.manifestId??null;
 if(!ledger||(ledger.ledgerMode!=='bounded'&&named==null)){for(const key of archiveKeys)records.push({key,disposition:'unreferenced',id:key});return {items,records,blockers,origin};}
 const manifestKey=named?archiveManifestKey(named):null,manifest=manifestKey?bodies[manifestKey]:null,used=new Set([ARCHIVE_POINTER]);
 if(!manifest||!Array.isArray(manifest.segments))blockers.push({reason:'archive_manifest_missing',sourceKey:'epg/discovery-latest.json',targetTable:'candidate',targetId:manifestKey||'epg/discovery-latest.json'});
 else{
  used.add(manifestKey);
  const activeKeys=new Set(items.map(item=>item?.key));
  for(const entry of manifest.segments){
   if(!entry?.object)continue;
   used.add(entry.object);
   const body=bodies[entry.object];
   if(!body||shas[entry.object]!==entry.sha256){blockers.push({reason:'archive_segment_unreadable',sourceKey:manifestKey,targetTable:'candidate',targetId:entry.object});continue;}
   for(const [key,value] of Object.entries(body.items||{})){if(activeKeys.has(key)||origin.has(key))continue;origin.set(key,entry.object);items.push(value?.payload);}
  }
 }
 for(const key of archiveKeys)records.push({key,disposition:used.has(key)?'mapped':'unreferenced',id:key});
 return {items,records,blockers,origin};
}
function discoveryRecords(body,deriveEvidence){
 requireEvidence(deriveEvidence);
 const items=[],blockers=[];
 for(const item of Array.isArray(body?.items)?body.items:[]){
  const observationKey=item?.observationKey||item?.key||null;
  if(!observationKey||!item?.title||!item?.normalizedTitle)return {portable:false,items:[{id:observationKey||'discovery'}],blockers};
  const evidence=evidenceFor(item,deriveEvidence);
  if(evidence.mismatch){blockers.push({reason:'evidence_mismatch',targetTable:'candidate',targetId:observationKey,stored:evidence.stored,derived:evidence.derived});continue;}
  items.push({id:observationKey,evidenceKey:evidence.key,evidenceProvenance:evidence.provenance,title:item.title,normalizedTitle:item.normalizedTitle,shows:expectedCandidateShows(item.shows)});
 }
 return {portable:items.length>0,items,blockers};
}
function predictionExpectation(key,filmId,body,storedId,links){
 if(!filmId)return {current:null,reason:'film_unresolved'};
 const current=versionedPrediction(body?.current,key,storedId,links);
 if(current.reason)return {current:null,reason:current.reason};
 const history=[];
 for(const item of Array.isArray(body.history)?body.history:[]){
  const version=versionedPrediction(item,key,storedId,links);
  if(version.reason)return {current:null,reason:version.reason};
  history.push({filmId,...version.value});
 }
 return {current:{id:filmId,...current.value,history},reason:null};
}
function versionedPrediction(item,bundleKey,storedId,links){
 if(!item||typeof item!=='object')return {value:null,reason:'prediction_fields_missing'};
 const problem=versionPointerProblem(item,bundleKey,storedId,links);
 if(problem)return {value:null,reason:problem};
 const updatedAt=item.updatedAt||item.generatedAt||null;
 if(typeof item.tasteProfileVersion!=='number'||!item.tasteProfileHash||!item.fingerprintHash||typeof item.fingerprintSchemaVersion!=='number'||typeof item.predictionPromptVersion!=='number'||typeof item.predictedRating!=='number'||!updatedAt)return {value:null,reason:'prediction_fields_missing'};
 return {value:{predictedRating:item.predictedRating,updatedAt,r2Key:item.r2Key,contentSha256:item.contentSha256,fingerprintHash:item.fingerprintHash,tasteProfileVersion:item.tasteProfileVersion,tasteProfileHash:item.tasteProfileHash,fingerprintSchemaVersion:item.fingerprintSchemaVersion,predictionPromptVersion:item.predictionPromptVersion},reason:null};
}
function sameHistory(stored,item,filmId){
 if(!stored)return false;
 if(stored.predicted_rating!==item.predictedRating||stored.r2_key!==item.r2Key||stored.content_sha256!==item.contentSha256)return false;
 let body;
 try{body=JSON.parse(stored.payload_json);}catch{return false;}
 return body.filmId===(item.filmId||filmId)&&body.predictedRating===item.predictedRating&&body.r2Key===item.r2Key&&body.contentSha256===item.contentSha256&&body.updatedAt===item.updatedAt&&body.tasteProfileVersion===item.tasteProfileVersion&&body.tasteProfileHash===item.tasteProfileHash&&body.fingerprintHash===item.fingerprintHash&&body.fingerprintSchemaVersion===item.fingerprintSchemaVersion&&body.predictionPromptVersion===item.predictionPromptVersion;
}
function peopleRecords(body){if(Array.isArray(body))return body;if(Array.isArray(body?.people))return body.people;return Object.values(body||{});}
function identityView(item){return {scheme:item.scheme,value:String(item.value),trusted:!!(item.trusted&&!item.conflicting),conflicting:!!item.conflicting};}
function aliasView(item){return {kind:item.kind||'title',value:item.value};}
function metadataView(metadata){return metadata?{synopsis:metadata.synopsis??null,year:metadata.year??null,runtime:metadata.runtime??null,peopleVersion:metadata.peopleVersion??null}:null;}
function sameLocalization(stored,incoming){const left=stored||{},right=incoming||{};return (left.value??null)===(right.value??null)&&(left.status??null)===(right.status??null)&&(left.provenance?.authority??left.authority??null)===(right.provenance?.authority??null);}
function identityText(items){return [...(items||[])].map(item=>[item.scheme,String(item.value),item.trusted&&!item.conflicting?1:0,item.conflicting?1:0].join('/')).sort().join(',');}
function aliasText(items){return [...(items||[])].map(item=>(item.kind||'title')+'/'+item.value).sort().join(',');}
function creditText(items){return [...(items||[])].map(item=>item.personId+'/'+item.role+'/'+item.ordinal).sort().join(',');}
function metaText(metadata){if(!metadata)return 'null';return [metadata.synopsis??null,metadata.year??null,metadata.runtime??null,metadata.peopleVersion??metadata.people_version??null].join('|');}
