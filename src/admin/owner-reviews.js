// One R2 document for owner-reviewed Film titles and Person names (AIR-53, AIR-54).
// The Film writer fills `films` and copies `people` unchanged. The Person writer does the opposite.
// This file does not read or write the bucket; the route owns the conditional put.
// Contract: ADR 0072 (docs/adr/0072-owner-reviewed-localization-overlay.md).
const OWNER_REVIEWS_KEY='admin/owner-reviews.json';
const ADMIN_OWNER_REVIEWS_KEY=OWNER_REVIEWS_KEY;
const OWNER_PERSON_NAME_ACTION='person_name_review';
function ownerReviewsEmpty(){return {contractVersion:1,films:{},people:{}};}
function ownerReviewsNormalize(body){
 if(body==null)return ownerReviewsEmpty();
 if(typeof body!=='object'||Array.isArray(body))return null;
 if(body.films!=null&&(typeof body.films!=='object'||Array.isArray(body.films)))return null;
 if(body.people!=null&&(typeof body.people!=='object'||Array.isArray(body.people)))return null;
 return {contractVersion:1,films:{...(body.films||{})},people:{...(body.people||{})}};
}
function ownerReviewsPlain(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function ownerReviewsReadable(body){
 return ownerReviewsPlain(body)&&body.contractVersion===1&&ownerReviewsPlain(body.films)&&ownerReviewsPlain(body.people);
}
function ownerReviewsPeople(body){return ownerReviewsReadable(body)?body.people:null;}
function ownerReviewsWithFilm(doc,storedId,slice){
 return {contractVersion:1,films:{...doc.films,[storedId]:slice},people:doc.people};
}
function ownerFilmSlice(film){
 return {
  filmId:film.id,
  localization:film.localization,
  aliases:(film.aliases||[]).filter(alias=>alias&&alias.value&&(alias.kind||'title')==='title'),
  titleReviews:film.titleReviews||[],
  localizationConflicts:film.localizationConflicts||[],
 };
}
function ownerReviewPersonFields(person){
 const localization=person?.localization;
 const owner=localization?.status==='reviewed'&&localization?.provenance?.authority==='owner'?localization:null;
 return {
  localization:owner,
  aliases:Array.isArray(person?.aliases)?person.aliases:[],
  nameReviews:Array.isArray(person?.nameReviews)?person.nameReviews:[],
  localizationConflicts:Array.isArray(person?.localizationConflicts)?person.localizationConflicts:[],
  roleLinks:Array.isArray(person?.roleLinks)?person.roleLinks:[],
 };
}
// Copy every field this writer does not own, including the films map, and replace the named people.
function ownerReviewsWithPeople(current,persons){
 const base=ownerReviewsReadable(current)?current:{contractVersion:1,films:{},people:{}};
 const people={...base.people};
 for(const person of persons||[])people[person.id]=ownerReviewPersonFields(person);
 return {...base,contractVersion:1,films:{...base.films},people};
}
