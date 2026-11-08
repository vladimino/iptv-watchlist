// AIR-388 B2 (ADR 0105): bounded TMDB title search for the export films the live catalog does not know.
// Pure and offline-testable: no file, no storage, no environment and no clock of its own. The caller injects `search` (one request for
// one film), `sleep` and `now`. It is a script-side tool, not part of the Worker bundle.
//
// The rule is the one of ADR 0104 moved to the TMDB side: exactly one typed MOVIE result whose normalized original title equals the
// normalized export name and whose release year equals the export year is `inferred_new`. Everything else is a compact review reason and
// never admits a Film: a year one off, a name that matches only the localized title, several equal results, no result, no export year.
import {normTitle} from './letterboxd-match.js';

export const DEFAULT_MAX_REQUESTS=1500;
export const DEFAULT_RPS=4;
export const MAX_RPS=4;
export const SEARCH_BASIS='tmdb_search_original_title_exact_year_unique';
// `tmdb_linked_elsewhere` is never produced by a search: only a rebase onto a newer catalog read writes it (scripts/letterboxd-tmdb-search.mjs).
export const REVIEW_REASONS=Object.freeze(['missing_year','no_result','no_match','year_drift','alias_title_only','multiple_exact','tmdb_linked_elsewhere']);
const TMDB_ID=/^[1-9]\d{0,11}$/;
const yearOf=value=>{const match=/^(\d{4})-\d{2}-\d{2}$/.exec(String(value??''));return match?Number(match[1]):null;};

// One TMDB search/movie request for one export film: the query is the name, the year is judged locally on the results.
export function searchUrl(film){
 const url=new URL('https://api.themoviedb.org/3/search/movie');
 url.searchParams.set('query',String(film.name??''));
 url.searchParams.set('include_adult','false');
 url.searchParams.set('page','1');
 return url.toString();
}

// results: the `results` array of a search/movie answer. Returns one decision; the reason is one of REVIEW_REASONS.
export function selectFromSearch(film,results){
 const year=Number.isInteger(film?.year)?film.year:null;
 if(year===null)return {decision:'review',reason:'missing_year'};
 const list=(Array.isArray(results)?results:[]).filter(item=>item&&TMDB_ID.test(String(item.id))&&yearOf(item.release_date)!==null);
 if(!list.length)return {decision:'review',reason:'no_result'};
 const name=normTitle(film.name);
 if(!name)return {decision:'review',reason:'no_match'};
 const original=item=>normTitle(item.original_title)===name,localized=item=>normTitle(item.title)===name;
 const exact=[...new Map(list.filter(item=>original(item)&&yearOf(item.release_date)===year).map(item=>[String(item.id),item])).values()];
 if(exact.length===1){const [hit]=exact;return {decision:'inferred_new',tmdb:String(hit.id),title:String(hit.original_title),year,basis:SEARCH_BASIS};}
 if(exact.length>1)return {decision:'review',reason:'multiple_exact'};
 if(list.some(item=>original(item)&&Math.abs(yearOf(item.release_date)-year)===1))return {decision:'review',reason:'year_drift'};
 if(list.some(item=>localized(item)&&yearOf(item.release_date)===year))return {decision:'review',reason:'alias_title_only'};
 return {decision:'review',reason:'no_match'};
}

// Sequential, rate-limited, ONE attempt per film, ever. Every attempt is recorded in `state.results` whatever its outcome (a decision, a
// review reason, `error` for a failed request, `blocked` for the 403 or 429 that ended a run), so no resume asks the same code again; a
// retry is a separate, explicit decision outside this function. `state.requests` is the cumulative number of requests over every run on
// this state, and `maxRequests` caps that total, not one invocation. The first 403 or 429 ends the run with no retry; three failures in a
// row end it too. search(film) -> {status:number, results?:[]}; it may throw, which counts as a failed request.
export async function runSearches({films,search,state={results:{},requests:0},maxRequests=DEFAULT_MAX_REQUESTS,rps=DEFAULT_RPS,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}){
 if(!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>DEFAULT_MAX_REQUESTS)throw new Error('maxRequests must be an integer 1..'+DEFAULT_MAX_REQUESTS);
 if(!(rps>0)||rps>MAX_RPS)throw new Error('rps must be above 0 and at most '+MAX_RPS);
 const gap=Math.ceil(1000/rps),results=state.results;
 if(!Number.isInteger(state.requests)||state.requests<0)state.requests=0;
 const done=code=>Object.hasOwn(results,code);
 let requests=0,stopped=null,failures=0,last=null;
 for(const film of films){
  if(done(film.code))continue;
  if(state.requests>=maxRequests){stopped='budget_reached';break;}
  if(last!==null){const wait=gap-(now()-last);if(wait>0)await sleep(wait);}
  last=now();requests++;state.requests++;
  let answer;
  try{answer=await search(film);}catch{answer={status:0};}
  // A 401 says the credential was not applied: nothing was learned about this film, so it is NOT recorded (it can be asked again once the
  // credential works), the run ends at once, and the request still counts against the total budget.
  if(answer.status===401){stopped='unauthorized';break;}
  if(answer.status===403||answer.status===429){results[film.code]={decision:'blocked',reason:'http_'+answer.status};stopped=answer.status===429?'rate_limited':'forbidden';break;}
  if(answer.status!==200){failures++;results[film.code]={decision:'error',reason:'http_'+answer.status};if(failures>=3){stopped='repeated_failure';break;}continue;}
  failures=0;
  results[film.code]=selectFromSearch(film,answer.results);
 }
 const counts={};for(const row of Object.values(results)){const key=row.decision==='review'?'review:'+row.reason:row.decision;counts[key]=(counts[key]||0)+1;}
 return {requests,totalRequests:state.requests,stopped,remaining:films.filter(film=>!done(film.code)).length,counts,state};
}
