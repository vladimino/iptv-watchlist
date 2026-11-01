// One R2 document for owner-reviewed Film titles and Person names (AIR-53, AIR-54).
// The Film writer fills `films` and copies `people` unchanged. The Person writer does the opposite.
// This file does not read or write the bucket; the route owns the conditional put.
const OWNER_REVIEWS_KEY='admin/owner-reviews.json';
function ownerReviewsEmpty(){return {contractVersion:1,films:{},people:{}};}
function ownerReviewsNormalize(body){
 if(body==null)return ownerReviewsEmpty();
 if(typeof body!=='object'||Array.isArray(body))return null;
 if(body.films!=null&&(typeof body.films!=='object'||Array.isArray(body.films)))return null;
 if(body.people!=null&&(typeof body.people!=='object'||Array.isArray(body.people)))return null;
 return {contractVersion:1,films:{...(body.films||{})},people:{...(body.people||{})}};
}
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
