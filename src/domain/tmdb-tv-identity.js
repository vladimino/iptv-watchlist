// AIR-290: a TMDB TV entry is a typed `tmdb_tv` identity of a Film, and a confirmed retired TMDB movie id leaves the Film's
// trusted identity without being deleted. Pure functions over Film views; loaded beside film-person.js (transition,
// letterboxdSlugFromUrl). This file is not in the Worker bundle: the runtime integration is a separate delivery.
// TMDB movie and TV ids are separate namespaces that reuse the same numbers. A `tmdb` value and a `tmdb_tv` value are
// never compared with each other, and an equal number in the two schemes is not evidence that two records are one Film.
const TMDB_MOVIE_SCHEME='tmdb';
const TMDB_TV_SCHEME='tmdb_tv';
const TMDB_RETIRED_STATUS='retired';
const TMDB_TV_LINK_SOURCE='letterboxd_tmdb_link';
const TMDB_RETIREMENT_REASON='tmdb_movie_404';

const tmdbNumber=value=>/^[1-9]\d{0,9}$/.test(String(value??''))?String(value):null;
// The one visible TMDB link of a Letterboxd film page, typed. Letterboxd's data-tmdb-type/data-tmdb-id attributes can keep
// a retired movie id while the link it shows names the live entry, so the link is read and the attributes are compared
// with it, never trusted alone. Only a page whose single link agrees with exactly one attribute pair resolves; one link
// that disagrees, several links or contradictory attributes go to review, and no link stays unresolved.
// Nothing here corrects a Film: a disagreement is evidence for an owner-confirmed retirement, not a fix.
function letterboxdTmdbLink(html){
 const text=String(html??'');
 // Only the href of an anchor counts: a link the page shows, not a URL in text, a <link> or another attribute.
 const links=[...new Map([...text.matchAll(/<a\b[^>]*?\shref="https:\/\/(?:www\.)?themoviedb\.org\/(movie|tv)\/(\d+)(?:[/?#][^"]*)?"/g)].map(m=>[m[1]+'/'+m[2],{type:m[1],id:m[2]}])).values()];
 const types=[...new Set([...text.matchAll(/data-tmdb-type="([a-z]+)"/g)].map(m=>m[1]))].sort();
 const ids=[...new Set([...text.matchAll(/data-tmdb-id="(\d+)"/g)].map(m=>m[1]))].sort();
 const attributes={types,ids};
 if(!links.length)return {status:'unresolved',reason:'no_tmdb_link',link:null,links:[],attributes};
 if(links.length>1)return {status:'review',reason:'multiple_tmdb_links',link:null,links,attributes};
 const link=links[0];
 if(types.length>1||ids.length>1)return {status:'review',reason:'contradictory_attributes',link,links,attributes};
 if(!types.length||!ids.length)return {status:'review',reason:'attributes_missing',link,links,attributes};
 if(types[0]!==link.type||ids[0]!==link.id)return {status:'review',reason:'link_disagrees_with_attributes',link,links,attributes};
 return {status:'resolved',reason:null,link,links,attributes};
}

// A retirement is the owner-confirmed statement that one Film's TMDB movie id is retired and its TV entry is the live one.
// Every field is checked; a retirement never names a second Film, a title or a person, and is never inferred.
function tmdbRetirement(entry){
 const reasons=[];
 const lid=String(entry?.lid??'');
 if(!/^[A-Za-z0-9]{1,16}$/.test(lid))reasons.push('lid');
 if(entry?.filmId!=='film:'+lid)reasons.push('film_id');
 const movieId=tmdbNumber(entry?.movieId),tvId=tmdbNumber(entry?.tvId);
 if(!movieId)reasons.push('movie_id');
 if(!tvId)reasons.push('tv_id');
 const evidence=entry?.evidence||{};
 if(evidence.movieStatus!==404||!evidence.movieCheckedAt)reasons.push('movie_404');
 if(typeof letterboxdSlugFromUrl!=='function'||!letterboxdSlugFromUrl(evidence.letterboxdUrl))reasons.push('letterboxd_url');
 if(evidence.link!=='tv/'+tvId||!evidence.linkCheckedAt)reasons.push('letterboxd_link');
 if(String(evidence.tvResponseId??'')!==tvId||!evidence.tvCheckedAt)reasons.push('tv_entry');
 const confirmation=entry?.confirmation||{};
 if(confirmation.by!=='owner'||!confirmation.at||!confirmation.source)reasons.push('owner_confirmation');
 if(reasons.length)return {ok:false,reasons};
 return {ok:true,retirement:{filmId:entry.filmId,lid,movieId,tvId,evidence:{...evidence},confirmation:{...confirmation}}};
}

const idsOf=(film,scheme)=>(film?.externalIds||[]).filter(item=>item.scheme===scheme);
const lidOf=film=>idsOf(film,'letterboxd').find(item=>item.trusted&&!item.conflicting)?.value??null;
// Key order does not decide equality: provenance read back from storage may list its keys in another order.
const stableJson=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const sameJson=(a,b)=>stableJson(a)===stableJson(b);
// The three pieces a retirement writes. They depend on the retirement and the replaced provenance only, never on the time of
// the run, so a correction made by any writer reads back as exactly this.
function retiredProvenance(retirement,previous){return {status:TMDB_RETIRED_STATUS,reason:TMDB_RETIREMENT_REASON,replacement:{scheme:TMDB_TV_SCHEME,value:retirement.tvId},evidence:retirement.evidence,confirmation:retirement.confirmation,previous:previous??null};}
function tmdbTvProvenance(retirement){return {source:TMDB_TV_LINK_SOURCE,url:retirement.evidence.letterboxdUrl,link:retirement.evidence.link,checkedAt:retirement.evidence.linkCheckedAt,confirmation:retirement.confirmation};}
function retiredIdentityProvenance(prior,retirement){return {...(prior||{}),tmdbTvId:retirement.tvId,retiredTmdbId:retirement.movieId};}
// The Film already carries exactly this retirement: the retired movie entry and the TV entry with their full provenance,
// the canonical identity and the identity dimension. Anything less is not a completed correction.
function carriesRetirement(film,retirement){
 const movie=idsOf(film,TMDB_MOVIE_SCHEME),tv=idsOf(film,TMDB_TV_SCHEME);
 if(movie.length!==1||tv.length!==1)return false;
 const [old]=movie,[typed]=tv;
 if(old.value!==retirement.movieId||old.trusted||old.conflicting||!old.provenance||!Object.hasOwn(old.provenance,'previous'))return false;
 if(!sameJson(old.provenance,retiredProvenance(retirement,old.provenance.previous)))return false;
 if(typed.value!==retirement.tvId||!typed.trusted||typed.conflicting||!sameJson(typed.provenance,tmdbTvProvenance(retirement)))return false;
 if(film.canonicalIdentity!==TMDB_TV_SCHEME+':'+retirement.tvId)return false;
 const identity=film.identity;
 return identity?.status==='resolved'&&identity.sourceVersion===TMDB_TV_SCHEME+':'+retirement.tvId&&identity.provenance?.tmdbTvId===retirement.tvId&&identity.provenance?.retiredTmdbId===retirement.movieId;
}
// Applies one retirement to its own Film. The retired movie id stays as an untrusted `tmdb` entry whose provenance keeps
// the evidence, the confirmation and the entry it replaced; the TV entry becomes the trusted `tmdb_tv` identity and the
// canonical identity. The Film id, lid, aliases, localization, fingerprint, prediction, history and redirects are kept as
// they are. A Film carrying exactly this result is returned unchanged. Any trace of a correction that is not exactly this
// one (a TV entry, a retired movie entry, a TV canonical identity) is refused as partial, and every other unexpected state
// is refused too: nothing is repaired.
function applyTmdbRetirement(film,retirement,at){
 if(!film||film.id!==retirement.filmId)return {ok:false,reason:'film_mismatch',film:film??null};
 if(lidOf(film)!==retirement.lid)return {ok:false,reason:'lid_mismatch',film};
 if(film.identity?.status!=='resolved')return {ok:false,reason:'identity_not_resolved',film};
 const movie=idsOf(film,TMDB_MOVIE_SCHEME),tv=idsOf(film,TMDB_TV_SCHEME);
 if(movie.some(item=>item.conflicting))return {ok:false,reason:'conflicting_tmdb',film};
 if(movie.length!==1||movie[0].value!==retirement.movieId)return {ok:false,reason:'movie_id_mismatch',film};
 if(tv.some(item=>item.value!==retirement.tvId))return {ok:false,reason:'tv_id_mismatch',film};
 if(carriesRetirement(film,retirement))return {ok:true,changed:false,film};
 if(tv.length||movie[0].provenance?.status===TMDB_RETIRED_STATUS||String(film.canonicalIdentity||'').startsWith(TMDB_TV_SCHEME+':'))return {ok:false,reason:'partial_correction',film};
 if(!movie[0].trusted||film.canonicalIdentity!==TMDB_MOVIE_SCHEME+':'+retirement.movieId)return {ok:false,reason:'movie_not_trusted_identity',film};
 const retired={...movie[0],trusted:false,conflicting:false,provenance:retiredProvenance(retirement,movie[0].provenance)};
 const typed={scheme:TMDB_TV_SCHEME,value:retirement.tvId,trusted:true,conflicting:false,provenance:tmdbTvProvenance(retirement)};
 const externalIds=[];
 for(const item of film.externalIds){externalIds.push(item.scheme===TMDB_MOVIE_SCHEME?retired:item);if(item.scheme===TMDB_MOVIE_SCHEME)externalIds.push(typed);}
 const moved=transition(film.identity,'resolved',{updatedAt:at,sourceVersion:TMDB_TV_SCHEME+':'+retirement.tvId,provenance:retiredIdentityProvenance(film.identity.provenance,retirement)});
 if(!moved.ok)return {ok:false,reason:'identity_transition',film};
 const next={...film,externalIds,canonicalIdentity:TMDB_TV_SCHEME+':'+retirement.tvId,identity:moved.state};
 return {ok:true,changed:true,film:next,changes:{canonicalIdentity:{from:film.canonicalIdentity,to:next.canonicalIdentity},retired:{scheme:TMDB_MOVIE_SCHEME,value:retirement.movieId},added:{scheme:TMDB_TV_SCHEME,value:retirement.tvId}}};
}

// Trusted `tmdb_tv` held by two Films is a collision for owner review, never a merge. The same number as a movie id on
// another Film is reported as a numeric overlap only: the namespaces differ, so it neither links nor blocks.
function tmdbTvCollisions(films){
 const owners=new Map(),movieOwners=new Map();
 for(const film of films||[])for(const item of film?.externalIds||[]){
  if(item.scheme===TMDB_TV_SCHEME&&item.trusted&&!item.conflicting){const set=owners.get(item.value)||new Set();set.add(film.id);owners.set(item.value,set);}
  if(item.scheme===TMDB_MOVIE_SCHEME&&!item.conflicting){const set=movieOwners.get(item.value)||new Set();set.add(film.id);movieOwners.set(item.value,set);}
 }
 const collisions=[...owners].filter(([,ids])=>ids.size>1).map(([value,ids])=>({scheme:TMDB_TV_SCHEME,value,films:[...ids].sort()}));
 const numericOverlaps=[...owners].filter(([value])=>movieOwners.has(value)).map(([value,ids])=>({value,tvFilms:[...ids].sort(),movieFilms:[...movieOwners.get(value)].sort()}));
 return {collisions,numericOverlaps};
}
