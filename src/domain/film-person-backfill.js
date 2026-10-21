// Phase 2b of AIR-42. Builds the phase 2a sidecars again and compares them with sidecars already stored.
// The result is a dry-run: create, update, unchanged, orphan, or conflict. Nothing here deletes or rewrites storage.
function embeddedPeople(store){
 const rows=[...peopleOn(store.programme),...(store.programme?.films||[]).flatMap(peopleOn),...(store.watchlist?.films||[]).flatMap(peopleOn),...listOf(store.metadata).flatMap(peopleOn),...listOf(store.discoveredFilms).flatMap(peopleOn)];
 const out=[],seen=new Set();
 for(const person of rows){if(!person?.id||seen.has(person.id))continue;seen.add(person.id);out.push(person);}
 return out;
}
function legacyPersonName(store,person){
 const override=store.personOverrides?.[person.id];
 if(override?.name)return override.name;
 const dictionary=(store.personNameIndex||{})[person.id];
 if(dictionary?.name)return dictionary.name;
 return person.name||null;
}
function lifecyclePersonName(person){
 if(person?.localization?.status!=='missing'&&person?.localization?.value)return person.localization.value;
 return person?.original||null;
}
function personParity(store,people){
 const context={...store,personNameIndex:store.personNameIndex||indexRecords(store.personNames,'id')};
 const legacyPeople=embeddedPeople(context);
 const ids=shadowParity(legacyPeople.map(person=>person.id),(people||[]).map(person=>person.roleId));
 const byRole=new Map((people||[]).map(person=>[person.roleId,person]));
 const mismatches=[];
 for(const person of legacyPeople){
  const view=byRole.get(person.id);
  if(!view)continue;
  const legacy=legacyPersonName(context,person),lifecycle=lifecyclePersonName(view);
  if(legacy!==lifecycle)mismatches.push({id:person.id,field:'name',legacy,lifecycle});
  const legacyReviewed=!!(context.personOverrides?.[person.id]?.name||context.personNameIndex?.[person.id]?.status==='verified');
  const lifecycleReviewed=view.localization?.status==='reviewed';
  if(legacyReviewed!==lifecycleReviewed)mismatches.push({id:person.id,field:'reviewed',legacy:legacyReviewed,lifecycle:lifecycleReviewed});
 }
 mismatches.sort((a,b)=>a.id.localeCompare(b.id,'en')||a.field.localeCompare(b.field,'en'));
 return {...ids,ok:ids.ok&&mismatches.length===0,mismatches};
}
function personBody(person){
 return {contractVersion:person.contractVersion,id:person.id,roleId:person.roleId,original:person.original||null,aliases:person.aliases||[],localization:{status:person.localization?.status||'missing',value:person.localization?.value??null,source:person.localization?.source??null,sourceVersion:person.localization?.sourceVersion??null,provenance:person.localization?.provenance??null}};
}
function withoutObservationTime(value){
 if(Array.isArray(value))return value.map(withoutObservationTime);
 if(!value||typeof value!=='object')return value;
 const stamp=Object.hasOwn(value,'from')&&Object.hasOwn(value,'to')&&Object.hasOwn(value,'at');
 const out={};
 for(const [key,item] of Object.entries(value)){
  if(key==='updatedAt'||(key==='at'&&stamp))continue;
  out[key]=withoutObservationTime(item);
 }
 return out;
}
function stableJson(value){
 return JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b,'en'))):item);
}
function hasHistory(value){
 if(!value||typeof value!=='object')return false;
 if(Array.isArray(value.predictionHistory)&&value.predictionHistory.length)return true;
 return Object.values(value).some(item=>item&&typeof item==='object'&&hasHistory(item));
}
function recordsOf(body){
 if(!body||typeof body!=='object'||Array.isArray(body))return [];
 if(body.localization||body.roleId||body.fingerprint)return [['.',body]];
 return Object.entries(body).filter(([,value])=>value&&typeof value==='object');
}
function reviewedConflict(body){return recordsOf(body).some(([,record])=>Array.isArray(record?.localizationConflicts)&&record.localizationConflicts.length>0);}
function sidecarConflict(previous,next){
 if(hasHistory(previous)||hasHistory(next))return 'history';
 if(reviewedConflict(previous)||reviewedConflict(next))return 'reviewed_conflict';
 const after=new Map(recordsOf(next));
 for(const [id,record] of recordsOf(previous)){
  const desired=after.get(id);
  if(!desired){if(record.localization?.status==='reviewed')return 'reviewed_removed';continue;}
  if(record.localization?.status==='reviewed'&&(desired.localization?.status!=='reviewed'||desired.localization.value!==record.localization.value))return 'reviewed_downgrade';
  if(record.id&&desired.id&&record.id!==desired.id&&!(desired.redirects||[]).some(redirect=>redirect.from===record.id&&redirect.to===desired.id))return 'identity_replaced';
 }
 return null;
}
function reconcileSidecars(desired,persisted){
 const previous=persisted&&typeof persisted==='object'?persisted:{};
 const plan={create:[],update:[],unchanged:[],orphan:[],conflict:[]};
 for(const key of Object.keys(desired||{}).sort((a,b)=>a.localeCompare(b,'en'))){
  if(!Object.hasOwn(previous,key)||previous[key]==null){plan.create.push(key);continue;}
  if(stableJson(withoutObservationTime(desired[key]))===stableJson(withoutObservationTime(previous[key]))){if(reviewedConflict(desired[key])||reviewedConflict(previous[key]))plan.conflict.push({key,reason:'reviewed_conflict'});else plan.unchanged.push(key);continue;}
  const reason=sidecarConflict(previous[key],desired[key]);
  if(reason)plan.conflict.push({key,reason});else plan.update.push(key);
 }
 for(const key of Object.keys(previous).sort((a,b)=>a.localeCompare(b,'en')))if(!Object.hasOwn(desired||{},key))plan.orphan.push(key);
 return plan;
}
function letterboxdOf(film){return (film?.externalIds||[]).find(item=>item.scheme==='letterboxd'&&item.value)?.value||null;}
function trustedTmdbOf(film){return (film?.externalIds||[]).find(item=>item.scheme==='tmdb'&&item.trusted&&!item.conflicting)?.value||null;}
function samePersistedFilm(persisted,desired){
 if(!persisted?.id||!desired?.id)return false;
 if(persisted.id===desired.id)return true;
 const leftLetterboxd=letterboxdOf(persisted),rightLetterboxd=letterboxdOf(desired);
 if(leftLetterboxd&&rightLetterboxd&&leftLetterboxd===rightLetterboxd)return true;
 const leftTmdb=trustedTmdbOf(persisted),rightTmdb=trustedTmdbOf(desired);
 return !!(leftTmdb&&rightTmdb&&leftTmdb===rightTmdb);
}
function filmRecords(sidecars){
 const out=[];
 for(const [key,body] of Object.entries(sidecars||{})){
  if(!body||typeof body!=='object'||Array.isArray(body))continue;
  if(String(body.id||'').startsWith('film:')&&body.externalIds){out.push({key,inner:null,body});continue;}
  if(body.localization||body.fingerprint||body.roleId)continue;
  for(const [inner,record] of Object.entries(body))if(record&&String(record.id||'').startsWith('film:')&&record.externalIds)out.push({key,inner,body:record});
 }
 return out;
}
function adoptedFilmBody(survivor,desired){
 return {...desired,id:survivor.id,canonicalIdentity:survivor.canonicalIdentity??null,externalIds:survivor.externalIds,redirects:survivor.redirects||[],aliases:survivor.aliases||[],localization:survivor.localization,localizationConflicts:survivor.localizationConflicts||[],identity:survivor.identity};
}
function filmByLocalId(sidecars,id){return filmRecords(sidecars).find(item=>item.body.id===id)?.body||null;}
function adoptPersistedIdentity(sidecars,persisted,now){
 const prior=filmRecords(persisted);
 if(!prior.length)return sidecars;
 const kept=new Map();
 for(const desired of filmRecords(sidecars)){
  const match=prior.find(item=>item.body.id===desired.body.id)||prior.find(item=>samePersistedFilm(item.body,desired.body));
  if(!match||match.body.id===desired.body.id)continue;
  const linked=linkFilms(match.body,desired.body,now);
  if(!linked.ok)continue;
  const body=adoptedFilmBody(linked.survivor,desired.body);
  if(desired.inner==null)sidecars[desired.key]=body;else sidecars[desired.key][desired.inner]=body;
  kept.set(desired.body.id,body.id);kept.set(match.body.id,body.id);
 }
 for(const [key,body] of Object.entries(sidecars))if(body&&!body.externalIds&&kept.has(body.id))sidecars[key]={...body,id:kept.get(body.id)};
 for(const [key,body] of Object.entries(persisted||{})){
  if(sidecars[key]||!body||!kept.has(body.id)||!String(key).endsWith('/fingerprint.lifecycle.json'))continue;
  const id=kept.get(body.id),film=filmByLocalId(sidecars,id);
  sidecars[key]={id,storedId:body.storedId??null,fingerprint:film?.fingerprint||{status:'missing'}};
 }
 return sidecars;
}
function backfillLifecycle(store,now){
 const view=readLifecycle(store,now);
 const sidecars=adoptPersistedIdentity({...view.sidecars,[sidecarKey('people.json')]:Object.fromEntries(view.people.map(person=>[person.roleId,personBody(person)]))},store.persistedSidecars,now);
 for(const key of Object.keys(sidecars))if(key==='people.json'||key==='programme.json'||FORBIDDEN_LIFECYCLE_KEYS.includes(key)||key.includes('predictions')||key.includes('discovery-latest'))throw new Error('lifecycle sidecar overwrites '+key);
 const reconciliation=reconcileSidecars(sidecars,store.persistedSidecars);
 const sidecarKeys=Object.keys(sidecars).sort((a,b)=>a.localeCompare(b,'en'));
 return {contractVersion:view.contractVersion,sidecars,reconciliation,report:{films:view.parity,people:personParity(store,view.people),sidecarKeys}};
}
