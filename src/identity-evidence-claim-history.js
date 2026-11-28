// AIR-641 / ADR 0215 (Accepted), card E3c: the family (c) extraction of the identity evidence reconstruction (Table 5, canonical claim history and retirement).
// DORMANT and PURE: nothing in the Worker imports this module, it is not bundled, it reads nothing and writes nothing. It maps rows that an AUTHORIZED READ already returned
// (`CLAIM_HISTORY_READS` lists the exact SELECTs; running them against production needs the owner's separate production read approval) to the `records` that the dry run of the
// import path (`planManifest` of `src/identity-evidence-import.js`, card ER) freezes into a manifest. It does not import that module: the dry run, the owner's import GO naming the
// manifest digest, the staging, the seal and the chunks stay the operators of card ER, run only under their own gates.
//
// The mapping (ADR 0215 Table 5, family c):
// - c1 trusted minting ids (`film:tmdb:<n>` holding tmdb `<n>`, `film:<lid>` and, under ADR 0217, `film:lb:<lid>` holding letterboxd `<lid>`): no row (decision 3), counted only.
// - c2 trusted `tmdb` on a Film not minted from it with NULL provenance: no row (method and route not recorded), reported by count and by Film. The same claims with non-null
//   provenance are reported separately (`nonNullProvenance`) and never mapped.
// - c3 trusted `letterboxd` on a Film not minted from it: no row (choice 0215-8b = C), each reported `bridge_root_unavailable`. The report separates the verified bridge shape
//   (`ratings_alias_bridge` provenance whose `tmdb` is the Film's own minting id) from claims of unknown origin; both stay report-only. A root is never derived from a receipt or a
//   matching `same_work` row. `causalRoots` (a reviewer's explicit finding) is only LISTED for review: it never yields a row here.
// - c4 `tmdb_retirement_decision`: a `retire` is `same_work(tmdb_movie, tmdb_tv)` (asserts, owner_action, owner_statement, root = request id, `source_order` = `seq`). `observed_at` is
//   `confirmation.at` only when that is a full instant; a date-only `at` keeps its date and precision in the report (the guard holds the whole `confirmation_json`) and the time stays
//   unknown, no midnight is invented. A `restore` is the scoped withdrawal (refutes) of the retire its `supersedes_seq` names, `scope_evidence_key` = that row's key; a restore whose
//   target is not a matching retire in this cohort is reported `restoreUnresolved` and yields no row.
// - c5 trusted `tmdb_tv` claims: `film_has_id(film, tmdb_tv)` only when the claim's provenance matches exactly ONE `retire` decision field by field (film, lid, TV id, provenance
//   `source` `letterboxd_tmdb_link`, link, letterboxd URL, link check time, confirmation); every compared field must be present on both sides (two missing values are no proof). The
//   application time and order are not recorded, so `observedAt` and `sourceOrder` stay null. Otherwise `unattributable`, no row. The untrusted retired `tmdb` rows give no row.
// - c6 slug, c7 receipts, c8 redirects: no row, counted only. c9 (the 0001 assertion tables) is retired by migration 0054 and is not read.
// Counts are the audit of ADR 0215 and are refreshed by the dry run; nothing here assumes them.
import {evidenceKeyOf,normalizeEvidence} from './identity-evidence.js';

export const CLAIM_HISTORY_FAMILY='c';
// The four decision-time fields a `retire` is attributed by (the TV claim's provenance is `{source,url,link,checkedAt,confirmation}`, `src/domain/tmdb-tv-identity.js`).
const DECISION_COLUMNS='seq,request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq';
// The exact read-only SELECTs of the dry run. Every statement is a plain SELECT; `counts` is one row of scalar subselects (a missing 0001 table is read as null by the caller, not
// repaired). Nothing here is run by a deploy, a route or a Task.
export const CLAIM_HISTORY_READS=Object.freeze({
 decisions:'SELECT '+DECISION_COLUMNS+' FROM tmdb_retirement_decision ORDER BY seq',
 tvClaims:"SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE scheme='tmdb_tv' ORDER BY film_id,value",
 retiredMovieClaims:"SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE scheme='tmdb' AND trusted=0 ORDER BY film_id,value",
 tmdbClaimsOnOtherFilms:"SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE scheme='tmdb' AND trusted=1 AND film_id<>'film:tmdb:'||value ORDER BY film_id,value",
 letterboxdClaimsOnOtherFilms:"SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE scheme='letterboxd' AND trusted=1 AND film_id<>'film:'||value AND film_id<>'film:lb:'||value ORDER BY film_id,value",
 counts:"SELECT (SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND trusted=1 AND film_id='film:tmdb:'||value) AS c1_tmdb,(SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd' AND trusted=1 AND (film_id='film:'||value OR film_id='film:lb:'||value)) AS c1_letterboxd,(SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd_slug') AS c6_slug,(SELECT COUNT(*) FROM canonical_write_receipt) AS c7_receipts,(SELECT COUNT(*) FROM film_redirect) AS c8_redirects"
});

const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'||typeof value==='number'?String(value):null;
function parse(value){if(plain(value)||Array.isArray(value))return value;if(typeof value!=='string')return null;try{return JSON.parse(value);}catch{return null;}}
const stable=value=>JSON.stringify(value,(key,item)=>plain(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
// `confirmation.at` is a date (`2026-10-30`) or an instant. Only an instant becomes `observed_at`; a date keeps its original value and precision in the report, and the row's time
// stays unknown: no midnight is invented.
function instantOf(value){
 const at=text(value);
 if(at===null)return {observedAt:null,precision:'missing',original:null};
 if(/^\d{4}-\d{2}-\d{2}$/.test(at)&&Number.isFinite(Date.parse(at+'T00:00:00.000Z')))return {observedAt:null,precision:'date',original:at};
 const ms=/^\d{4}-\d{2}-\d{2}T/.test(at)?Date.parse(at):NaN;
 return Number.isFinite(ms)?{observedAt:new Date(ms).toISOString(),precision:'instant',original:at}:{observedAt:null,precision:'unparsed',original:at};
}
// The reconstruction placeholders only make the key computable; the key of a rooted row does not depend on them (ADR 0213 decision 4).
const keyOf=input=>evidenceKeyOf(normalizeEvidence({...input,origin:'reconstruction',reconstructionRun:'key-probe',reconstructedFrom:'key-probe'}));

function decisionOf(row){
 const evidence=parse(row.evidence_json),confirmation=parse(row.confirmation_json);
 return {seq:Number(row.seq),requestId:row.request_id,filmId:row.film_id,kind:row.kind,lid:text(row.lid),movieId:text(row.movie_id),tvId:text(row.tv_id),evidence:plain(evidence)?evidence:null,
  confirmation:plain(confirmation)?confirmation:null,supersedesSeq:row.supersedes_seq===null||row.supersedes_seq===undefined?null:Number(row.supersedes_seq),raw:row};
}
// The guard of a decision record: every field the mapping reads, so a later change of the stored decision fails the chunk as `source_moved`. `recorded_at` (the load time) is not read.
const decisionSource=row=>({kind:'d1_row',table:'tmdb_retirement_decision',key:{seq:Number(row.seq)},guard:{request_id:row.request_id,film_id:row.film_id,kind:row.kind,lid:row.lid??null,movie_id:row.movie_id??null,
 tv_id:row.tv_id??null,evidence_json:row.evidence_json??null,confirmation_json:row.confirmation_json??null,origin:row.origin??null,input_sha256:row.input_sha256??null,supersedes_seq:row.supersedes_seq??null}});
const claimSource=row=>({kind:'d1_row',table:'film_external_id',key:{film_id:row.film_id,scheme:row.scheme,value:String(row.value)},guard:{trusted:Number(row.trusted),conflicting:Number(row.conflicting),provenance_json:row.provenance_json??null}});

const retireProposition=decision=>({subject:{kind:'tmdb_movie',value:decision.movieId},relation:'same_work',object:{kind:'tmdb_tv',value:decision.tvId},route:'owner_action',method:'owner_statement',sourceRoot:decision.requestId});

// The provenance an applied retirement leaves on the trusted TV claim (the exact shape of `tmdbTvProvenance`, `src/domain/tmdb-tv-identity.js`): `{source:'letterboxd_tmdb_link',url,link,checkedAt,confirmation}`.
export const TMDB_TV_LINK_SOURCE='letterboxd_tmdb_link';
const present=value=>typeof value==='string'&&value!=='';
function attributes(decision,claim){
 const provenance=parse(claim.provenance_json);
 if(!plain(provenance)||!decision.evidence||!decision.confirmation||!plain(provenance.confirmation))return false;
 // Every compared field must exist on BOTH sides: two missing values are not a match.
 if(![provenance.source,provenance.link,provenance.url,provenance.checkedAt,decision.evidence.link,decision.evidence.letterboxdUrl,decision.evidence.linkCheckedAt].every(present))return false;
 return claim.film_id===decision.filmId&&decision.lid!==null&&decision.filmId==='film:'+decision.lid&&String(claim.value)===decision.tvId&&provenance.source===TMDB_TV_LINK_SOURCE
  &&provenance.link===decision.evidence.link&&provenance.url===decision.evidence.letterboxdUrl&&provenance.checkedAt===decision.evidence.linkCheckedAt&&stable(provenance.confirmation)===stable(decision.confirmation);
}

// Pure. `data` is what the reads of `CLAIM_HISTORY_READS` returned (rows as objects), `causalRoots` an optional reviewer's list of explicitly found causal records
// [{filmId,value,source}] for claims of c3 (listed for review, never mapped). Returns `{records, report}`: `records` feed `planManifest({family:'c',…})` as they are.
export async function extractClaimHistory({decisions=[],tvClaims=[],retiredMovieClaims=[],tmdbClaimsOnOtherFilms=[],letterboxdClaimsOnOtherFilms=[],counts={},causalRoots=[]}={}){
 const report={
  families:{c1:{tmdb:counts.c1_tmdb??null,letterboxd:counts.c1_letterboxd??null,rows:0},c2:{count:0,films:[],nonNullProvenance:0,nonNullFilms:[],rows:0},c3:{count:0,verifiedBridge:0,unknownOrigin:0,claims:[],rows:0,reason:'bridge_root_unavailable',reviewRequired:[]},
   c4:{decisions:0,retire:0,restore:0,restoreUnresolved:[],precision:[],rows:0},c5:{trustedTv:0,attributed:0,unattributable:[],rows:0},c6:{count:counts.c6_slug??null,rows:0},c7:{count:counts.c7_receipts??null,rows:0},
   c8:{count:counts.c8_redirects??null,rows:0},c9:{status:'retired_by_migration_0054',read:false,rows:0}},
  retiredMovieUntrusted:retiredMovieClaims.filter(row=>Number(row.trusted)===0).length,notEligible:[]
 };
 const records=[];
 const decided=decisions.map(decisionOf).sort((a,b)=>a.seq-b.seq);
 const bySeq=new Map(decided.map(decision=>[decision.seq,decision]));
 const retireKeys=new Map();
 for(const decision of decided){
  report.families.c4.decisions+=1;
  const usable=decision.movieId!==null&&decision.tvId!==null&&decision.confirmation!==null&&Number.isSafeInteger(decision.seq)&&decision.seq>=1;
  if(!usable){report.notEligible.push({seq:decision.seq,reason:'decision_incomplete'});continue;}
  const time=instantOf(decision.confirmation.at);
  report.families.c4.precision.push({seq:decision.seq,confirmationAt:time.original,precision:time.precision});
  if(decision.kind==='retire'){
   report.families.c4.retire+=1;
   const evidence={...retireProposition(decision),polarity:'asserts',observedAt:time.observedAt,sourceOrder:decision.seq};
   retireKeys.set(decision.seq,{key:await keyOf(evidence),decision});
   records.push({source:decisionSource(decision.raw),rows:[{filmId:decision.filmId,evidence}]});
  }else if(decision.kind==='restore'){
   report.families.c4.restore+=1;
   const target=retireKeys.get(decision.supersedesSeq)||(bySeq.get(decision.supersedesSeq)?.kind==='retire'?{decision:bySeq.get(decision.supersedesSeq),key:null}:null);
   if(!target||!target.key||target.decision.filmId!==decision.filmId||target.decision.movieId!==decision.movieId||target.decision.tvId!==decision.tvId){
    report.families.c4.restoreUnresolved.push({seq:decision.seq,supersedesSeq:decision.supersedesSeq,reason:'restore_target_not_a_matching_retire'});continue;
   }
   const evidence={...retireProposition(decision),sourceRoot:decision.requestId,polarity:'refutes',scopeEvidenceKey:target.key,observedAt:time.observedAt,sourceOrder:decision.seq};
   records.push({source:decisionSource(decision.raw),rows:[{filmId:decision.filmId,evidence}]});
  }else report.notEligible.push({seq:decision.seq,reason:'decision_kind'});
 }
 report.families.c4.rows=records.length;
 // c5: exactly one retire may attribute a trusted TV claim; two or none leave it unattributable.
 const retires=decided.filter(decision=>decision.kind==='retire');
 for(const claim of tvClaims){
  if(Number(claim.trusted)!==1||Number(claim.conflicting)!==0)continue;
  report.families.c5.trustedTv+=1;
  const matches=retires.filter(decision=>attributes(decision,claim));
  if(matches.length!==1){report.families.c5.unattributable.push({filmId:claim.film_id,tvId:String(claim.value),reason:matches.length?'ambiguous_decisions':'no_matching_decision'});continue;}
  const decision=matches[0];
  report.families.c5.attributed+=1;
  records.push({source:claimSource(claim),rows:[{filmId:claim.film_id,evidence:{subject:{kind:'film',value:claim.film_id},relation:'film_has_id',object:{kind:'tmdb_tv',value:String(claim.value)},polarity:'asserts',
   route:'owner_action',method:'owner_statement',sourceRoot:decision.requestId,observedAt:null,sourceOrder:null}}]});
 }
 report.families.c5.rows=report.families.c5.attributed;
 // c2 and c3: counted and listed, never mapped.
 for(const row of tmdbClaimsOnOtherFilms){
  if(Number(row.trusted)!==1)continue;
  if(row.provenance_json===null||row.provenance_json===undefined){report.families.c2.count+=1;report.families.c2.films.push({filmId:row.film_id,value:String(row.value)});}
  else{const given=parse(row.provenance_json);report.families.c2.nonNullProvenance+=1;report.families.c2.nonNullFilms.push({filmId:row.film_id,value:String(row.value),source:plain(given)&&typeof given.source==='string'?given.source:null});}
 }
 const roots=new Map((Array.isArray(causalRoots)?causalRoots:[]).filter(item=>plain(item)&&typeof item.filmId==='string').map(item=>[item.filmId+'|'+String(item.value),item]));
 for(const row of letterboxdClaimsOnOtherFilms){
  if(Number(row.trusted)!==1)continue;
  const provenance=parse(row.provenance_json);
  report.families.c3.count+=1;
  // The verified bridge shape: alias-bridge provenance whose `tmdb` is the minting id of the very Film that holds the claim. Anything else is of unknown origin. Both stay report-only.
  const bridge=plain(provenance)&&provenance.source==='ratings_alias_bridge'&&present(String(provenance.tmdb??''))&&row.film_id==='film:tmdb:'+provenance.tmdb;
  if(bridge)report.families.c3.verifiedBridge+=1;else report.families.c3.unknownOrigin+=1;
  report.families.c3.claims.push({filmId:row.film_id,value:String(row.value),source:plain(provenance)&&typeof provenance.source==='string'?provenance.source:null,shape:bridge?'verified_bridge':'unknown_origin',reason:'bridge_root_unavailable'});
  const found=roots.get(row.film_id+'|'+String(row.value));
  if(found)report.families.c3.reviewRequired.push({filmId:row.film_id,value:String(row.value),source:found.source??null,note:'a causal record was found by review: surfaced for explicit review, never imported by this run'});
 }
 return {records,report};
}
