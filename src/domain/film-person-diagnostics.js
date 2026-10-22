function countBy(items,pick){
 const counts={};
 for(const item of items){
  const status=pick(item);
  if(!status)continue;
  counts[status]=(counts[status]||0)+1;
 }
 return counts;
}
function withoutHistory(film){
 const entity={};
 for(const key of Object.keys(film))if(key!=='predictionHistory')entity[key]=film[key];
 return entity;
}
function catalogId(lifecycleId){return lifecycleId.startsWith('film:tmdb:')?'tmdb_'+lifecycleId.slice('film:tmdb:'.length):lifecycleId.startsWith('film:')?lifecycleId.slice('film:'.length):lifecycleId;}
function filmMatch(film,id){return film.id===id||storedFilmId(film)===id||film.id==='film:'+id||catalogId(film.id)===id;}
function redirectMatch(film,id){return (film.redirects||[]).some(redirect=>redirect.from===id||redirect.from==='film:'+id||catalogId(redirect.from)===id);}
function personMatch(person,id){return person.id===id||person.roleId===id||person.id==='person:'+id;}
function diagnoseFilm(store,id,now){
 const key=id==null?'':String(id),films=readLifecycle(store,now).films,film=films.find(item=>filmMatch(item,key))||films.find(item=>redirectMatch(item,key));
 return film?{found:true,kind:'film',id:film.id,entity:withoutHistory(film)}:{found:false,kind:'film',id:key};
}
function diagnosePerson(store,id,now){
 const key=id==null?'':String(id),person=readLifecycle(store,now).people.find(item=>personMatch(item,key));
 return person?{found:true,kind:'person',id:person.id,entity:person}:{found:false,kind:'person',id:key};
}
function lifecycleCounts(store,now){
 const view=readLifecycle(store,now),films=view.films,people=view.people;
 return {
  films:{
   total:films.length,
   displayReady:films.filter(displayReady).length,
   catalogReady:films.filter(catalogReady).length,
   predictionReady:films.filter(predictionReady).length,
   hot:films.filter(film=>film.availability&&film.availability.hot).length,
   identity:countBy(films,film=>film.identity&&film.identity.status),
   metadata:countBy(films,film=>film.metadata&&film.metadata.status),
   localization:countBy(films,film=>film.localization&&film.localization.status),
   fingerprint:countBy(films,film=>film.fingerprint&&film.fingerprint.status),
   prediction:countBy(films,film=>film.prediction&&film.prediction.status)
  },
  people:{total:people.length,localization:countBy(people,person=>person.localization&&person.localization.status)},
  candidates:{total:view.candidates.length,excluded:view.candidates.filter(candidate=>candidate.excluded).length},
  conflicts:view.conflicts.length,
  parity:{ok:!!view.parity.ok,mismatches:view.parity.mismatches.length,missing:view.parity.missing.length,extra:view.parity.extra.length}
 };
}
