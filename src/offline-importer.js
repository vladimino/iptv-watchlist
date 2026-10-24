// AIR-73. Offline importer from a verified historical snapshot into a caller-supplied database.
// The Worker does not import this file. It does not read R2, call a model, or apply the schema to production.

const FAMILIES=[
 ['watchlist',key=>key==='watchlist.json'],
 ['programme',key=>key==='programme.json'||key==='epg/published-generation.json'],
 ['discovery',key=>key==='epg/discovery-latest.json'||key==='epg/discovery-resolution.json'||key==='epg/discovered-films.json'],
 ['profile',key=>key==='enrichment/profile/current.json'||/^enrichment\/profile\/versions\/\d+\.json$/.test(key)],
 ['fingerprint',key=>/^enrichment\/films\/[^/]+\/fingerprint\.json$/.test(key)],
 ['prediction',key=>/^enrichment\/films\/[^/]+\/predictions\.json$/.test(key)],
 ['actual',key=>/^enrichment\/films\/[^/]+\/actual\.json$/.test(key)],
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

export function classifyObject(key){
 if(typeof key!=='string')return 'unmapped';
 if(/\.xml($|\.)/.test(key)||key.startsWith('epg/raw/')||key.startsWith('archive/'))return 'excluded';
 if(isMappedKey(key))return 'mapped';
 return 'unmapped';
}

export function inventory({finishedAt=null,aggregateSha256=null,keys=[]}={}){
 const families={};
 for(const [id,matches] of FAMILIES){
  const found=keys.filter(matches).sort();
  families[id]={status:found.length?'present':'absent',keys:found};
 }
 const absent=Object.entries(families).filter(([,family])=>family.status==='absent').map(([id])=>id);
 const coverage={denominator:keys.length,mapped:[],excluded:[],unmapped:[]};
 for(const key of [...keys].sort())coverage[classifyObject(key)].push(key);
 return {scope:'historical-snapshot',production:false,finishedAt,aggregateSha256,objectCount:keys.length,families,absent,complete:absent.length===0,coverage};
}

export function creditRoster(records){
 const credits=[],unmatched=[];
 const seen=new Set();
 const add=(people,role)=>{
  for(const person of people||[]){
   const personId=personIdFor(person?.id);
   if(!personId){unmatched.push(String(person?.id??''));continue;}
   const key=personId+'/'+role;
   if(seen.has(key))continue;
   seen.add(key);
   credits.push({personId,role,ordinal:credits.filter(item=>item.role===role).length});
  }
 };
 for(const record of records||[]){
  add(record?.directors,'director');
  add(record?.people?.directors,'director');
  add(record?.actors,'actor');
  add(record?.people?.actors,'actor');
 }
 return {credits,unmatched};
}

export async function importBatch(db,repositories,batch){
 const importedAt=batch?.importedAt;
 if(!importedAt)throw new Error('importedAt is required');
 const units=batch.units||[];
 const limit=batch.limit??null;
 const ledger=[];
 const counts={applied:0,resumed:0,reconciled:0,explained:0,conflicts:0,unportable:0,partial:0,uncheckpointed:0,pending:0};
 let started=0;
 for(const unit of units){
  if(limit!=null&&started>=limit){counts.pending++;continue;}
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
 }
 const parity=batch.expected?await verifyParity(db,batch.expected):{ok:false,missing:[],extra:[],mismatched:[],denominator:0,unprojected:[],records:[],reason:'no_source_projection'};
 const coverage=batch.inventory?.coverage||{denominator:0,mapped:[],excluded:[],unmapped:[]};
 return {...counts,ledger,coverage,parity,claimsFullParity:parityClaim({coverage,parity,counts,ledger,inventory:batch.inventory})};
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
 return {ok:missing.length+extra.length+mismatched.length===0,missing,extra,mismatched,denominator,unprojected:spec.unprojected||[],records:spec.records||[]};
}

export function parityClaim({coverage,parity,counts,ledger,inventory}={}){
 const uncovered=(coverage?.unmapped||[]).length>0;
 const incomplete=inventory?.complete!==true;
 const vacuous=!(parity?.denominator>0);
 const unprojected=(parity?.unprojected||[]).length>0;
 const openRecords=(parity?.records||[]).some(record=>record.disposition!=='mapped');
 const open=(counts?.pending||0)+(counts?.unportable||0)+(counts?.conflicts||0)+(counts?.explained||0)+(counts?.partial||0)+(counts?.uncheckpointed||0);
 return !uncovered&&!incomplete&&!vacuous&&!unprojected&&!openRecords&&!!parity?.ok&&open===0&&(ledger||[]).length===0;
}

export function fingerprintUnit(entry,body){
 const filmId=filmIdFromEnrichmentKey(entry.key);
 if(!filmId||!body?.fingerprintHash||!(body.fingerprintSchemaVersion!=null||body.schemaVersion!=null))return unportable(entry,'fingerprint_payload',filmId||entry.key,'fingerprint_fields_missing','fingerprint');
 return unit({family:'fingerprint',kind:'fingerprint',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:'fingerprint_payload',targetId:filmId,input:{filmId,schemaVersion:body.schemaVersion??body.fingerprintSchemaVersion,fingerprintHash:body.fingerprintHash,generatedAt:body.generatedAt??null,invalidatedAt:body.invalidatedAt??null,r2Key:entry.key,contentSha256:entry.sha256}});
}

export function predictionUnits(entry,body){
 const filmId=filmIdFromEnrichmentKey(entry.key);
 const units=[];
 const history=Array.isArray(body?.history)?body.history:[];
 history.forEach((item,index)=>units.push(versionUnit(entry,filmId,item,'prediction_history',filmId?filmId+'#'+index:entry.key+'#'+index)));
 units.push(versionUnit(entry,filmId,body?.current,'prediction_current',filmId||entry.key));
 return units;
}

export function actualUnit(entry,body){
 const filmId=filmIdFromEnrichmentKey(entry.key);
 const recordedAt=body?.recordedAt||body?.updatedAt||null;
 if(!filmId||typeof body?.rating!=='number'||!body.source||!recordedAt)return unportable(entry,'actual_rating',filmId||entry.key,'rating_fields_missing','actual');
 return unit({family:'actual',kind:'rating',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:'actual_rating',targetId:filmId,input:{filmId,rating:body.rating,source:body.source,recordedAt}});
}

export function profileUnit(entry,body){
 if(!/^enrichment\/profile\/versions\/\d+\.json$/.test(entry.key))return unportable(entry,'profile_version',String(body?.version??entry.key),'profile_version_object_missing','profile');
 if(typeof body?.version!=='number'||!body.profileHash||!(body.createdAt||body.updatedAt))return unportable(entry,'profile_version',String(body?.version??entry.key),'profile_fields_missing','profile');
 return unit({family:'profile',kind:'profile',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:'profile_version',targetId:String(body.version),input:{version:body.version,profileHash:body.profileHash,createdAt:body.createdAt||body.updatedAt,r2Key:entry.key,contentSha256:entry.sha256}});
}

export function generationUnit(pointer,programme,pointerSha,candidates=[]){
 const programmeRunId=pointer?.programmeRunId||programme?.runId||null;
 if(!programmeRunId||!Array.isArray(programme?.films))return unportable({key:'programme.json',sha256:pointerSha},'programme_generation',programmeRunId||'programme.json','generation_fields_missing','programme');
 const films=[];
 for(const film of programme.films){
  if(!film||!Object.prototype.hasOwnProperty.call(film,'shows')||!Array.isArray(film.shows))return unportable({key:'programme.json',sha256:pointerSha},'programme_generation',programmeRunId,'show_fields_missing','programme');
  const shows=[];
  for(const show of film.shows){
   const startMs=show?.startMs??show?.start;
   if(!show?.channelId||typeof startMs!=='number')return unportable({key:'programme.json',sha256:pointerSha},'programme_generation',programmeRunId,'show_fields_missing','programme');
   shows.push({channelId:show.channelId,channel:show.channel??null,startMs,endMs:show.endMs??show.end??null,epgTitle:show.epgTitle??show.title??null,basis:show.basis??null,matchReason:show.matchReason??null});
  }
  const filmId=String(film.filmId||(String(film.id).startsWith('film:')?film.id:'film:'+film.id));
  films.push({filmId,shows});
 }
 const phase=pointer?.phase==='withheld'?'withheld':'published';
 const input={programmeRunId,phase,publishedAt:pointer?.publishedAt??programme?.updatedAt??null,films,candidates};
 if(phase==='published')input.expectedProgrammeRunId=pointer?.expectedProgrammeRunId??null;
 return unit({family:'programme',kind:'generation',sourceKey:'programme.json',sourceSha256:pointerSha,targetTable:'programme_generation',targetId:programmeRunId,input});
}

export function readDiscovery(entry,body){
 const items=Array.isArray(body?.items)?body.items:[];
 if(!items.length)return {candidates:[],units:[unportable(entry,'candidate',entry.key,'observation_fields_missing','discovery')]};
 const candidates=[],units=[];
 items.forEach((item,index)=>{
  const observationKey=item?.observationKey||item?.key||null;
  const targetId=observationKey||entry.key+'#'+index;
  if(!observationKey||!item?.evidenceKey||!item?.title||!item?.normalizedTitle){units.push(unportable(entry,'candidate',targetId,'observation_fields_missing','discovery'));return;}
  const shows=[];
  for(const show of item.shows||[]){
   const startMs=show?.startMs??show?.start;
   if(!show?.channelId||typeof startMs!=='number'){units.push(unportable(entry,'candidate',targetId,'show_fields_missing','discovery'));return;}
   shows.push({channelId:show.channelId,channel:show.channel??null,startMs,endMs:show.endMs??show.end??null,epgTitle:show.epgTitle??show.title??null});
  }
  candidates.push({observationKey,title:item.title,normalizedTitle:item.normalizedTitle,year:item.year??null,rawTitles:item.rawTitles||[item.title],durations:item.durations||[],description:item.description??null,evidenceKey:item.evidenceKey,shows,activity:item.activity||'current',lastSeenProgrammeRunId:item.lastSeenProgrammeRunId??null,confirmedTmdbId:item.confirmedTmdbId??null});
 });
 return {candidates,units};
}

function versionUnit(entry,filmId,item,table,targetId){
 if(!filmId||!item||typeof item!=='object')return unportable(entry,table,targetId,'prediction_fields_missing','prediction');
 if(!item.r2Key||!item.contentSha256)return unportable(entry,table,targetId,'prediction_version_object_missing','prediction');
 if(item.r2Key===entry.key)return unportable(entry,table,targetId,'mutable_bundle_is_not_a_version_object','prediction');
 const updatedAt=item.updatedAt||item.generatedAt||null;
 if(typeof item.tasteProfileVersion!=='number'||!item.tasteProfileHash||!item.fingerprintHash||typeof item.fingerprintSchemaVersion!=='number'||typeof item.predictionPromptVersion!=='number'||typeof item.predictedRating!=='number'||!updatedAt)return unportable(entry,table,targetId,'prediction_fields_missing','prediction');
 return unit({family:'prediction',kind:'prediction',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable:table,targetId,input:{filmId,tasteProfileVersion:item.tasteProfileVersion,tasteProfileHash:item.tasteProfileHash,fingerprintHash:item.fingerprintHash,fingerprintSchemaVersion:item.fingerprintSchemaVersion,predictionPromptVersion:item.predictionPromptVersion,predictedRating:item.predictedRating,r2Key:item.r2Key,contentSha256:item.contentSha256,updatedAt}});
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
function entry(unit,outcome,reason){return {family:unit.family,sourceKey:unit.sourceKey,targetTable:unit.targetTable,targetId:unit.targetId,outcome,reason};}
function unit(fields){return {...fields,unportable:false};}
function unportable(entry,targetTable,targetId,reason,family){return {family,kind:'unportable',sourceKey:entry.key,sourceSha256:entry.sha256,targetTable,targetId,unportable:true,reason};}
function filmIdFromEnrichmentKey(key){
 const match=String(key).match(/^enrichment\/films\/([^/]+)\/(?:fingerprint|predictions|actual)\.json$/);
 if(!match)return null;
 const id=decodeURIComponent(match[1]);
 return id.startsWith('film:')?id:'film:'+id;
}
function isMappedKey(key){
 if(['watchlist.json','programme.json','metadata.json','titles.json','people.json','sync.json','epg/published-generation.json','epg/discovery-latest.json','epg/discovery-resolution.json','epg/discovered-films.json','enrichment/profile/current.json'].includes(key))return true;
 return /^enrichment\/profile\/versions\/\d+\.json$/.test(key)||/^enrichment\/films\/[^/]+\/(?:fingerprint|predictions|actual)\.json$/.test(key);
}
function personIdFor(roleId){return typeof roleId==='string'&&/^(actor|director|role|tmdb_actor|tmdb_director)\//.test(roleId)?'person:'+roleId:null;}
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

export function projectSource({keys=[],bodies={},films=[],people=[],rosters={},listed={},shas={}}={}){
 const expected={films:[],persons:[],fingerprints:[],ratings:[],predictions:[],redirects:[],decisions:[],candidates:[],generations:[],profiles:[],records:[],unprojected:[]};
 const filmByLetterboxd=new Map();
 for(const film of films){
  const roster=rosters[film.id]||{credits:[],unmatched:0};
  const letterboxd=(film.externalIds||[]).find(item=>item.scheme==='letterboxd')?.value||film.id.replace(/^film:/,'');
  filmByLetterboxd.set(String(letterboxd),film.id);
  expected.films.push({id:film.id,originalTitle:film.originalTitle??null,canonicalIdentity:film.canonicalIdentity??null,contractVersion:film.contractVersion,watchlist:!!listed[film.id],localization:film.localization?.value??null,localizationStatus:film.localization?.status??null,localizationAuthority:film.localization?.provenance?.authority??null,credits:roster.credits||[],externalIds:(film.externalIds||[]).map(identityView),aliases:(film.aliases||[]).map(aliasView),metadata:null});
  for(const redirect of film.redirects||[])if(redirect?.from&&redirect?.to&&redirect?.at)expected.redirects.push({id:redirect.from,toFilmId:redirect.to,at:redirect.at});
 }
 for(const person of people)expected.persons.push({id:person.id,roleId:person.roleId,contractVersion:person.contractVersion,localization:person.localization?.value??null,localizationStatus:person.localization?.status??null,externalIds:(person.externalIds||[]).map(identityView),aliases:(person.aliases||[]).map(aliasView)});
 const filmRow=id=>expected.films.find(film=>film.id===id);
 const accounted=new Set();
 const note=(key,disposition,id)=>expected.records.push({key,disposition,id});
 for(const key of keys){
  const kind=classifyObject(key);
  if(kind==='excluded')continue;
  if(kind==='unmapped'){expected.unprojected.push(key);continue;}
  accounted.add(key);
  const body=bodies[key];
  if(key==='watchlist.json'){for(const record of body?.films||[])note(key,filmByLetterboxd.has(String(record?.id))?'mapped':'unportable',String(record?.id??key));continue;}
  if(key==='programme.json'||key==='epg/published-generation.json')continue;
  if(key==='metadata.json'){for(const [id,record] of Object.entries(body||{})){const filmId=filmByLetterboxd.get(id)||filmByLetterboxd.get(String(record?.id));const metadata=filmId?catalogMetadata(record,key,shas[key]||null):null;if(filmId&&metadata){filmRow(filmId).metadata=metadataView(metadata);note(key,'mapped',filmId);}else note(key,'unportable',filmId||id);}continue;}
  if(key==='people.json'){for(const record of peopleRecords(body))note(key,expected.persons.some(person=>person.roleId===record?.id||person.id==='person:'+record?.id)?'mapped':'unportable',String(record?.id??key));continue;}
  if(key==='titles.json'){for(const [id,value] of Object.entries(body||{}))note(key,expected.films.some(film=>film.localization===value||film.aliases.some(alias=>alias.value===value))?'mapped':'unportable',id);continue;}
  if(key==='sync.json'){note(key,'unportable',key);continue;}
  if(key==='epg/discovered-films.json'){for(const record of Array.isArray(body)?body:Object.values(body||{}))note(key,filmByLetterboxd.has(String(record?.id))?'mapped':'unportable',String(record?.id??key));continue;}
  if(key==='epg/discovery-latest.json'||key==='epg/discovery-resolution.json')continue;
  if(key==='enrichment/profile/current.json'){const version='enrichment/profile/versions/'+body?.version+'.json';note(key,keys.includes(version)?'mapped':'unportable',String(body?.version??key));continue;}
  if(/^enrichment\/profile\/versions\/\d+\.json$/.test(key)){if(typeof body?.version==='number'&&body.profileHash&&(body.createdAt||body.updatedAt)){expected.profiles.push({id:body.version,profileHash:body.profileHash,createdAt:body.createdAt||body.updatedAt,r2Key:key,contentSha256:shas[key]||null});note(key,'mapped',String(body.version));}else note(key,'unportable',String(body?.version??key));continue;}
  if(/^enrichment\/films\/[^/]+\/fingerprint\.json$/.test(key)){const filmId=filmIdFromEnrichmentKey(key);if(filmId&&body?.fingerprintHash){expected.fingerprints.push({id:filmId,fingerprintHash:body.fingerprintHash,schemaVersion:body.schemaVersion??body.fingerprintSchemaVersion,generatedAt:body.generatedAt??null,invalidatedAt:body.invalidatedAt??null,r2Key:key,contentSha256:shas[key]||null});note(key,'mapped',filmId);}else note(key,'unportable',filmId||key);continue;}
  if(/^enrichment\/films\/[^/]+\/actual\.json$/.test(key)){const filmId=filmIdFromEnrichmentKey(key);const recordedAt=body?.recordedAt||body?.updatedAt||null;if(filmId&&typeof body?.rating==='number'&&body.source&&recordedAt){expected.ratings.push({id:filmId,rating:body.rating,source:body.source,recordedAt});note(key,'mapped',filmId);}else note(key,'unportable',filmId||key);continue;}
  if(/^enrichment\/films\/[^/]+\/predictions\.json$/.test(key)){const filmId=filmIdFromEnrichmentKey(key);const current=predictionExpectation(key,filmId,body);if(current){expected.predictions.push(current);note(key,'mapped',filmId);}else note(key,'unportable',filmId||key);continue;}
  note(key,'unportable',key);
 }
 const programmeKey=keys.includes('programme.json')?'programme.json':null;
 const discoveryPortable=!keys.includes('epg/discovery-latest.json')||discoveryRecords(bodies['epg/discovery-latest.json']).portable;
 if(programmeKey){
  const programme=bodies[programmeKey];
  const pointer=bodies['epg/published-generation.json']||{programmeRunId:programme?.runId||null,phase:'published'};
  const generation=discoveryPortable?generationExpectation(pointer,programme):null;
  if(generation){expected.generations.push(generation);if(generation.phase==='published')expected.publishedPointer=generation.id;note(programmeKey,'mapped',generation.id);if(keys.includes('epg/published-generation.json'))note('epg/published-generation.json','mapped',generation.id);}
  else{note(programmeKey,'unportable',pointer?.programmeRunId||programmeKey);if(keys.includes('epg/published-generation.json'))note('epg/published-generation.json','unportable',pointer?.programmeRunId||'epg/published-generation.json');}
 }
 if(keys.includes('epg/discovery-latest.json')){
  const discovery=discoveryRecords(bodies['epg/discovery-latest.json']);
  const runId=expected.generations[0]?.id||null;
  for(const item of discovery.items){
   if(!discoveryPortable||!runId)note('epg/discovery-latest.json','unportable',item.id);
   else{expected.candidates.push({id:item.id,programmeRunId:runId,evidenceKey:item.evidenceKey,title:item.title,normalizedTitle:item.normalizedTitle});note('epg/discovery-latest.json','mapped',item.id);}
  }
  if(!discovery.items.length)note('epg/discovery-latest.json','unportable','epg/discovery-latest.json');
 }
 if(keys.includes('epg/discovery-resolution.json')){
  const entries=Object.entries(bodies['epg/discovery-resolution.json']||{}).filter(([id,value])=>id!=='__canonicalizedAt'&&value&&typeof value==='object');
  const runId=expected.generations[0]?.id||null;
  if(!entries.length)note('epg/discovery-resolution.json','unportable','epg/discovery-resolution.json');
  for(const [id,value] of entries){
   if(!runId||!value.evidenceKey||!value.status||!value.checkedAt)note('epg/discovery-resolution.json','unportable',id);
   else{expected.decisions.push({id,status:value.status,evidenceKey:value.evidenceKey,terminalReason:value.terminalReason??null,filmId:value.filmId??null});note('epg/discovery-resolution.json','mapped',id);}
  }
 }
 for(const key of keys)if(classifyObject(key)==='mapped'&&!accounted.has(key)&&!expected.records.some(record=>record.key===key))expected.unprojected.push(key);
 expected.denominator=['films','persons','redirects','fingerprints','ratings','predictions','profiles','generations','candidates','decisions'].reduce((sum,key)=>sum+expected[key].length,0);
 return expected;
}

export function catalogMetadata(record,key,sha){
 if(!record||typeof record!=='object')return null;
 const updatedAt=record.metadataAt||record.updatedAt||record.synopsisFetchedAt||null;
 if(!updatedAt)return null;
 return {schemaVersion:1,year:record.year??null,runtime:record.runtime??null,synopsis:record.synopsis??null,poster:record.poster??null,url:record.url??null,genres:Array.isArray(record.genres)?record.genres:[],peopleVersion:record.peopleVersion??null,payload:{},r2Key:key,contentSha256:sha,updatedAt};
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
}
async function verifyDecisions(db,decisions,missing,extra,mismatched){
 const rows=await db.all('SELECT observation_key AS id,status,evidence_key,terminal_reason,film_id FROM candidate_decision ORDER BY observation_key');
 const wanted=new Map(decisions.map(row=>[row.id,row]));
 for(const row of decisions)if(!rows.some(stored=>stored.id===row.id))missing.push({table:'candidate_decision',id:row.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table:'candidate_decision',id:row.id});
 for(const row of decisions){const stored=rows.find(item=>item.id===row.id);if(stored&&(stored.status!==row.status||stored.evidence_key!==row.evidenceKey||(stored.terminal_reason??null)!==(row.terminalReason??null)||('filmId' in row&&(stored.film_id??null)!==(row.filmId??null))))mismatched.push({table:'candidate_decision',id:row.id,field:'decision'});}
}
function generationExpectation(pointer,programme){
 const programmeRunId=pointer?.programmeRunId||programme?.runId||null;
 if(!programmeRunId||!Array.isArray(programme?.films))return null;
 const films=[];
 for(const film of programme.films){
  if(!film||!Array.isArray(film.shows))return null;
  const filmId=String(film.filmId||(String(film.id).startsWith('film:')?film.id:'film:'+film.id));
  const shows=[];
  for(const show of film.shows){
   const startMs=show?.startMs??show?.start;
   if(!show?.channelId||typeof startMs!=='number')return null;
   shows.push({filmId,channelId:show.channelId,startMs,epgTitle:show.epgTitle??show.title??null});
  }
  films.push({filmId,shows});
 }
 return {id:programmeRunId,phase:pointer?.phase==='withheld'?'withheld':'published',films,shows:films.flatMap(film=>film.shows)};
}
function discoveryRecords(body){
 const items=[];
 for(const item of Array.isArray(body?.items)?body.items:[]){
  const observationKey=item?.observationKey||item?.key||null;
  if(!observationKey||!item?.evidenceKey||!item?.title||!item?.normalizedTitle)return {portable:false,items:[{id:observationKey||'discovery'}]};
  items.push({id:observationKey,evidenceKey:item.evidenceKey,title:item.title,normalizedTitle:item.normalizedTitle});
 }
 return {portable:items.length>0,items};
}
function predictionExpectation(key,filmId,body){
 const current=versionedPrediction(body?.current,key);
 if(!filmId||!current)return null;
 const history=[];
 for(const item of Array.isArray(body.history)?body.history:[]){
  const version=versionedPrediction(item,key);
  if(!version)return null;
  history.push({filmId,...version});
 }
 return {id:filmId,...current,history};
}
function versionedPrediction(item,bundleKey){
 if(!item?.r2Key||!item.contentSha256||item.r2Key===bundleKey)return null;
 const updatedAt=item.updatedAt||item.generatedAt||null;
 if(typeof item.tasteProfileVersion!=='number'||!item.tasteProfileHash||!item.fingerprintHash||typeof item.fingerprintSchemaVersion!=='number'||typeof item.predictionPromptVersion!=='number'||typeof item.predictedRating!=='number'||!updatedAt)return null;
 return {predictedRating:item.predictedRating,updatedAt,r2Key:item.r2Key,contentSha256:item.contentSha256,fingerprintHash:item.fingerprintHash,tasteProfileVersion:item.tasteProfileVersion,tasteProfileHash:item.tasteProfileHash,fingerprintSchemaVersion:item.fingerprintSchemaVersion,predictionPromptVersion:item.predictionPromptVersion};
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
