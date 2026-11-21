// AIR-558: test double for the ratings-domain view projection, for Letterboxd tests whose subject is NOT the D1 projection and that keep their facts in an
// in-memory R2 bucket. Production has no raw view-index object (projectRecords projects nothing unless RatingsD1 owns the projection); here a
// stand-in `RatingsD1` (facts keys stay plain R2 documents, projectView writes the same fields into the fixture `enrichment/view-index.json` through the test bucket,
// so injected bucket faults still hit the projection) and the view-index read seam are installed. The real ratings_view projection is tested in ratings-d1.mjs.
import vm from 'node:vm';
import {installViewIndexFixture} from './view-index-fixture.mjs';
const SOURCE=`globalThis.RatingsD1={
 ratingsMutableKey:()=>false,
 async routeRead(){return {handled:false};},async ratingsReady(){return false;},async viewItems(env,keys,facts){return facts;},
 async reverseView(env,reversals){
  const key='enrichment/view-index.json',field={rating:'actualRating',watched:'watched',watchlist:'watchlist'};
  for(let attempt=0;attempt<5;attempt++){
   const object=await env.BUCKET.get(key),index=object?await object.json():{};let changed=0;
   for(const {fact,links,before} of reversals)for(const id of LetterboxdFacts.projectionIds(links)){
    if(!index[id])continue;
    const item={...index[id]},prior=before?.[id]||{};
    if(Object.hasOwn(prior,field[fact]))item[field[fact]]=prior[field[fact]];else delete item[field[fact]];
    if(JSON.stringify(item)!==JSON.stringify(index[id])){index[id]=item;changed++;}
   }
   if(!changed)return {owned:true,changed:0};
   const stored=await env.BUCKET.put(key,JSON.stringify(index),object?{onlyIf:{etagMatches:object.etag}}:{onlyIf:{etagDoesNotMatch:'*'}});
   if(stored!==null)return {owned:true,changed};
  }
  throw new Error('write_contention');
 },
 async projectView(env,records){
  const key='enrichment/view-index.json';let changed=0;
  for(let attempt=0;attempt<5;attempt++){
   const object=await env.BUCKET.get(key),index=object?await object.json():{};changed=0;
   for(const record of records)for(const id of LetterboxdFacts.projectionIds(record.links)){
    const item={...(index[id]||{})};
    if(record.rating)item.actualRating=record.rating.value;
    if(record.watched)item.watched=record.watched.value;
    if(record.watchlist)item.watchlist=record.watchlist.value;
    if(JSON.stringify(item)!==JSON.stringify(index[id]||{})){index[id]=item;changed++;}
   }
   if(!changed)return {owned:true,changed:0};
   const stored=await env.BUCKET.put(key,JSON.stringify(index),object?{onlyIf:{etagMatches:object.etag}}:{onlyIf:{etagDoesNotMatch:'*'}});
   if(stored!==null)return {owned:true,changed};
  }
  throw new Error('write_contention');
 }};`;
export function installRawViewProjection(context){
 vm.runInContext(SOURCE,context);
 // facts-only contexts have no Worker: bind the two derivations the seam would otherwise replace on a Worker
 vm.runInContext(`globalThis.derivedViewIndex=async env=>{const o=await env.BUCKET.get('enrichment/view-index.json');return o?o.json():{};};globalThis.viewIndexD1Version=async env=>{const o=await env.BUCKET.get('enrichment/view-index.json');return 'fixture:'+(o?.etag??'none');};`,context);
 return context;
}
export {installViewIndexFixture};
