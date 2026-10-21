// Phase 2b of AIR-42. Recomputes lifecycle sidecars and a parity report from records the caller already loaded.
// A second call, including after a restart that still holds the previous sidecar bodies, returns the same report.
// This file does not read or write storage and does not apply sidecar bodies back onto the records.
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
function backfillLifecycle(store,now){
 const view=readLifecycle(store,now);
 const sidecarKeys=Object.keys(view.sidecars).sort((a,b)=>a.localeCompare(b,'en'));
 return {contractVersion:view.contractVersion,sidecars:view.sidecars,report:{films:view.parity,people:personParity(store,view.people),sidecarKeys}};
}
