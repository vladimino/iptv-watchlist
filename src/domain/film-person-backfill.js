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
function sidecarConflict(previous,next){
 if(hasHistory(previous)||hasHistory(next))return 'history';
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
  if(stableJson(desired[key])===stableJson(previous[key])){plan.unchanged.push(key);continue;}
  const reason=sidecarConflict(previous[key],desired[key]);
  if(reason)plan.conflict.push({key,reason});else plan.update.push(key);
 }
 for(const key of Object.keys(previous).sort((a,b)=>a.localeCompare(b,'en')))if(!Object.hasOwn(desired||{},key))plan.orphan.push(key);
 return plan;
}
function backfillLifecycle(store,now){
 const view=readLifecycle(store,now);
 const sidecars={...view.sidecars,[sidecarKey('people.json')]:Object.fromEntries(view.people.map(person=>[person.roleId,personBody(person)]))};
 for(const key of Object.keys(sidecars))if(key==='people.json'||key==='programme.json'||FORBIDDEN_LIFECYCLE_KEYS.includes(key)||key.includes('predictions')||key.includes('discovery-latest'))throw new Error('lifecycle sidecar overwrites '+key);
 const reconciliation=reconcileSidecars(sidecars,store.persistedSidecars);
 const sidecarKeys=Object.keys(sidecars).sort((a,b)=>a.localeCompare(b,'en'));
 return {contractVersion:view.contractVersion,sidecars,reconciliation,report:{films:view.parity,people:personParity(store,view.people),sidecarKeys}};
}
