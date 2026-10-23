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
  const receipt=await checkpoint(db,unit,importedAt);
  if(!receipt.ok){counts.uncheckpointed++;ledger.push(entry(unit,'uncheckpointed','receipt_failed'));continue;}
  counts.applied++;
 }
 const parity=batch.expected?await verifyParity(db,batch.expected):{ok:false,missing:[],extra:[],mismatched:[],reason:'no_source_projection'};
 const coverage=batch.inventory?.coverage||{denominator:0,mapped:[],excluded:[],unmapped:[]};
 return {...counts,ledger,coverage,parity,claimsFullParity:parityClaim({coverage,parity,counts,ledger})};
}

export async function verifyParity(db,spec){
 const missing=[],extra=[],mismatched=[];
 const films=await db.all('SELECT id FROM film ORDER BY id');
 const expectedFilms=new Map((spec.films||[]).map(film=>[film.id,film]));
 for(const film of spec.films||[])if(!films.some(row=>row.id===film.id))missing.push({table:'film',id:film.id});
 for(const row of films)if(!expectedFilms.has(row.id))extra.push({table:'film',id:row.id});
 for(const film of spec.films||[]){
  const localization=await db.get("SELECT value FROM film_dimension WHERE film_id=? AND dimension='localization'",[film.id]);
  if((localization?.value??null)!==(film.localization??null))mismatched.push({table:'film_dimension',id:film.id,field:'localization'});
  const credits=await db.all('SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id=? ORDER BY role,ordinal,person_id',[film.id]);
  const got=credits.map(row=>row.person_id+'/'+row.role+'/'+row.ordinal);
  const want=[...(film.credits||[])].sort((a,b)=>a.role.localeCompare(b.role)||a.ordinal-b.ordinal||a.personId.localeCompare(b.personId)).map(row=>row.personId+'/'+row.role+'/'+row.ordinal);
  if(got.join(',')!==want.join(','))mismatched.push({table:'film_person_credit',id:film.id,field:'credits'});
 }
 await compareRows(db,spec.redirects||[],'film_redirect','from_id',extra,missing);
 await compareRows(db,spec.fingerprints||[],'fingerprint_payload','film_id',extra,missing);
 await compareRows(db,spec.ratings||[],'actual_rating','film_id',extra,missing);
 await compareRows(db,spec.predictions||[],'prediction_current','film_id',extra,missing);
 for(const row of spec.predictions||[]){
  const stored=await db.get('SELECT predicted_rating,updated_at FROM prediction_current WHERE film_id=?',[row.id]);
  if(stored&&(stored.predicted_rating!==row.predictedRating||stored.updated_at!==row.updatedAt))mismatched.push({table:'prediction_current',id:row.id,field:'prediction'});
  const history=await db.get('SELECT COUNT(*) AS n FROM prediction_history WHERE film_id=?',[row.id]);
  if((history?.n??0)!==(row.history??0))mismatched.push({table:'prediction_history',id:row.id,field:'history'});
 }
 for(const row of spec.decisions||[]){
  const stored=await db.get('SELECT status,evidence_key,terminal_reason FROM candidate_decision WHERE observation_key=?',[row.id]);
  if(!stored)missing.push({table:'candidate_decision',id:row.id});
  else if(stored.status!==row.status||stored.evidence_key!==row.evidenceKey||(stored.terminal_reason??null)!==(row.terminalReason??null))mismatched.push({table:'candidate_decision',id:row.id,field:'decision'});
 }
 for(const row of spec.candidates||[]){
  const stored=await db.get('SELECT evidence_key FROM candidate_generation WHERE programme_run_id=? AND observation_key=?',[row.programmeRunId,row.id]);
  if(!stored)missing.push({table:'candidate_generation',id:row.id});
  else if(stored.evidence_key!==row.evidenceKey)mismatched.push({table:'candidate_generation',id:row.id,field:'evidence'});
 }
 return {ok:missing.length+extra.length+mismatched.length===0,missing,extra,mismatched};
}

export function parityClaim({coverage,parity,counts,ledger}){
 const uncovered=(coverage?.unmapped||[]).length>0;
 const open=(counts?.pending||0)+(counts?.unportable||0)+(counts?.conflicts||0)+(counts?.explained||0)+(counts?.partial||0)+(counts?.uncheckpointed||0);
 return !uncovered&&!!parity?.ok&&open===0&&(ledger||[]).length===0;
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
async function storedMatches(db,repositories,unit){
 if(unit.kind==='film'){
  if((unit.unmatchedCredits||0)>0)return false;
  const saved=await repositories.canonical.readFilm(unit.targetId);
  if(!saved)return false;
  const wanted=unit.input.film?.localization?.value??null;
  if(wanted!=null&&(saved.dimensions?.localization?.value??null)!==wanted)return false;
  if(Array.isArray(unit.desiredCredits)){
   const got=saved.credits.map(row=>row.personId+'/'+row.role+'/'+row.ordinal).sort().join(',');
   const want=unit.desiredCredits.map(row=>row.personId+'/'+row.role+'/'+row.ordinal).sort().join(',');
   if(got!==want)return false;
  }
  return true;
 }
 if(unit.kind==='person')return !!(await repositories.canonical.readPerson(unit.targetId));
 if(unit.kind==='fingerprint'){const row=await db.get('SELECT fingerprint_hash,generated_at FROM fingerprint_payload WHERE film_id=?',[unit.targetId]);return !!row&&row.fingerprint_hash===unit.input.fingerprintHash&&(row.generated_at??null)===(unit.input.generatedAt??null);}
 if(unit.kind==='prediction'){const row=await db.get('SELECT updated_at,r2_key FROM prediction_current WHERE film_id=?',[unit.input.filmId]);return !!row&&row.updated_at===unit.input.updatedAt&&row.r2_key===unit.input.r2Key;}
 if(unit.kind==='rating'){const row=await db.get('SELECT rating,recorded_at FROM actual_rating WHERE film_id=?',[unit.targetId]);return !!row&&row.rating===unit.input.rating&&row.recorded_at===unit.input.recordedAt;}
 if(unit.kind==='decision'){const row=await db.get('SELECT status,evidence_key,checked_at,terminal_reason FROM candidate_decision WHERE observation_key=?',[unit.targetId]);return !!row&&row.status===unit.input.status&&row.evidence_key===unit.input.evidenceKey&&row.checked_at===unit.input.checkedAt&&(row.terminal_reason??null)===(unit.input.terminalReason??null);}
 return false;
}
async function compareRows(db,expected,table,column,extra,missing){
 const rows=await db.all('SELECT '+column+' AS id FROM '+table+' ORDER BY '+column);
 const wanted=new Set(expected.map(row=>row.id));
 for(const row of expected)if(!rows.some(stored=>stored.id===row.id))missing.push({table,id:row.id});
 for(const row of rows)if(!wanted.has(row.id))extra.push({table,id:row.id});
}
