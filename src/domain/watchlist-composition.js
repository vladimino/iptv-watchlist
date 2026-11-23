// ADR 0186 decisions 6 and O3 (AIR-569). The read-time composition of the Watchlist document: the MEMBERSHIP and ORDER come from the current Watchlist snapshot, the show rows and every stored film field come
// from the pinned programme generation. Pure: no storage, no clock, no write; a GET that calls it never writes or repairs (ADR 0107). The Worker bundle wraps it as `WatchlistComposition`.
//
// Rules (each is a contract test):
//  - Membership is compared by Letterboxd id, never by count. A 1-for-1 replacement changes the composed list although the length is the same.
//  - A film that is in the snapshot AND in the generation keeps its stored record (shows, ids, metadata) and takes its place in the snapshot order.
//  - A film new in the snapshot joins with its stored shows IMMEDIATELY only when its identity is trusted AND a stored confirmed show row for that identity exists in the generation. Otherwise it
//    appears with no shows and `scheduleKnown:false` (an unknown, not an empty availability fact) until the next EPG scan.
//  - Trusted identity: the caller supplies a verified TMDB id per Letterboxd id (a canonical Film fact, never the list page). A TMDB id claimed by more than one Letterboxd id in the composed list is a
//    collision and trusts neither (T5, trusted TMDB collisions).
//  - A film removed from the snapshot leaves the membership only. Its stored record, shows and rating stay in the generation; it is returned in `removed` with `catalogOnly:true` and is never deleted,
//    never marked watched or rated, and no reason is inferred (owner decision O3, T28).

const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const confirmedShows=film=>Array.isArray(film?.shows)?film.shows.filter(show=>isObject(show)&&Number.isFinite(Number(show.start))&&Number.isFinite(Number(show.end))):[];

// snapshot: {version,snapshotId,lastSuccessAt,stale,ageMs,films:[{lid,title,year,url}]}.
// generation: {watchlist: doc|null (the pinned generation's `watchlist` part), programme: doc|null (films and catalogFilms with stored shows)}.
// identityByLid: Map|object lid -> verified tmdbId (string|number), only for ids the caller verified.
// -> {doc:{updatedAt,films,snapshot,removed}, joined:[lid], unknown:[lid]}
export function composeWatchlist({snapshot,generation={},identityByLid={}}){
 const lookup=lid=>identityByLid instanceof Map?identityByLid.get(lid):identityByLid?.[lid];
 const stored=new Map((generation.watchlist?.films||[]).filter(film=>film&&film.id!=null).map(film=>[String(film.id),film]));
 // Stored shows by TMDB id: the programme films and, as the second source, the catalog (Discovery-assigned) entries.
 const showsByTmdb=new Map();
 for(const film of [...(generation.programme?.films||[]),...(generation.programme?.catalogFilms||[])]){
  if(!isObject(film)||film.tmdbId==null)continue;
  const shows=confirmedShows(film);
  if(shows.length&&!showsByTmdb.has(String(film.tmdbId)))showsByTmdb.set(String(film.tmdbId),shows);
 }
 const members=snapshot.films;
 const memberIds=new Set(members.map(film=>film.lid));
 // A TMDB id claimed by more than one member (by the stored record or by the verified identity) is a collision.
 const claims=new Map();
 const claim=(lid,tmdbId)=>{if(tmdbId==null||tmdbId==='')return;const key=String(tmdbId);if(!claims.has(key))claims.set(key,new Set());claims.get(key).add(lid);};
 for(const film of members){claim(film.lid,lookup(film.lid));claim(film.lid,stored.get(film.lid)?.tmdbId);}
 const trusted=lid=>{const tmdbId=lookup(lid);if(tmdbId==null||tmdbId==='')return null;const owners=claims.get(String(tmdbId));return owners&&owners.size===1&&owners.has(lid)?String(tmdbId):null;};
 const joined=[],unknown=[];
 const films=members.map(member=>{
  const known=stored.get(member.lid);
  if(known)return known;
  const tmdbId=trusted(member.lid);
  const shows=tmdbId?showsByTmdb.get(tmdbId):null;
  const base={id:member.lid,title:member.title,...(member.year==null?{}:{year:member.year}),url:member.url};
  if(shows){joined.push(member.lid);return {...base,tmdbId:Number.isSafeInteger(Number(tmdbId))?Number(tmdbId):tmdbId,shows:shows.map(show=>({...show}))};}
  unknown.push(member.lid);
  return {...base,shows:[],scheduleKnown:false};
 });
 const removed=[...stored.values()].filter(film=>!memberIds.has(String(film.id))).map(film=>({...film,catalogOnly:true}));
 return {
  doc:{updatedAt:generation.watchlist?.updatedAt??null,films,snapshot:{version:snapshot.version,snapshotId:snapshot.snapshotId,lastSuccessAt:snapshot.lastSuccessAt,stale:!!snapshot.stale},removed},
  joined,unknown,
 };
}
