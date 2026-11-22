// AIR-566 read-only audit: classifies the unresolved Discovery candidates that still have showings on `discover` channels
// into proven non-film groups, review groups and "no proof", and replays one proposed stateless title predicate offline
// (docs/evidence/discovery/air-566-residual-nonfilm-audit-2026-11-22.md). Nothing here screens, writes or reads production.
// Usage: node scripts/air-566-residual-nonfilm-audit.mjs --cohort <file> --history <file> --verified <file> [--now <iso>] [--private-out <dir>]
//   --cohort   JSON rows {ok,t,y,st,tr,att,ra,dur,ds,dsh,xsh,ksh,win,sl,cs,oid,intent,evmis} (the cohort query; a D1 `[{results:[...]}]` envelope is accepted)
//   --history  JSON rows {ok,t,rs} of every observation whose title carries a serial word, any residence
//   --verified JSON rows {t[,ds,dur]} of every observation with a verified decision (the positive-control query)
// Cohort, history and verified controls are all required: a missing control must not silently inflate proof.
// stdout carries aggregates only. Titles and observation keys go only to --private-out, which must be outside the repository.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ATTEMPT_LIMIT=5; // DISCOVERY_ATTEMPT_LIMIT in src/discovery.js
export const GROUPS=Object.freeze({
 ordinal_episode_proven:'proven',pipe_season_episode:'proven',series_label_suffix:'proven',dash_season_episode_placeholder:'proven',season_abbrev_episode:'proven',
 trusted_identity_review:'review',ordinal_episode_review:'review',numeric_suffix_block_review:'review',season_marker_only:'review',show_family:'review',
 decorated_film_title:'likely_film',no_proof:'no_proof',
});
export const norm=value=>String(value??'').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const ORDINAL=/^(.*?)[.,:;]?\s*(\d{1,4})\s*[-‑]?\s*(?:я|ая|й)?\s*(?:-|–|и)?\s*(?:(\d{1,4})\s*[-‑]?\s*(?:я|ая|й)?\s*)?сери(?:я|и|й)(?![\p{L}])/iu;
const SEASON_ABBREV=/^(.*?)",?\s*(\d+)\s*сезон,?\s*(\d+)\s*с\./iu;
const SEASON_ONLY=/^(.*?)[.,:]?\s*(\d+)\s*сезон/iu;
const PIPE=/(?:^|[\s(])(\d{1,2})\|(\d{1,3})(?:-\d{1,3})?(?:\)|\s|$)/u;
const LABEL=/мини[\s\-–—]*сериал|(?<![\p{L}])телесериал(?![\p{L}])|(?<![\p{L}])сериал(?![\p{L}])|(?<![\p{L}])т\/с(?![\p{L}])/iu;
const DASH_CODE=/^(.*?)\s(\d{1,2})\s*-\s*(\d{1,3})\s*$/u;
const DECORATED=/\s(?:19|20)\d{2}\s+(?:драма|комедия|боевик|триллер|ужасы|фантастика|мелодрама|детектив|мультфильм|приключения|фэнтези|семейный)\s*$/iu;
const YEAR=/(?:^|\s)(?:19|20)\d{2}(?:\s|$)/u;
export const ORDINAL_PROOF=7,DASH_MAX_MINUTES=80,REPEAT_PROOF=2,FAMILY_SIZE=10;

export function parseSerial(title){
 const text=String(title??'');let m;
 if((m=ORDINAL.exec(text)))return {form:m[3]?'ordinal_range':'ordinal_single',stem:norm(m[1]),n:Number(m[2]),n2:m[3]?Number(m[3]):null};
 if((m=SEASON_ABBREV.exec(text)))return {form:'season_abbrev',stem:norm(m[1]),n:Number(m[3]),n2:null};
 if((m=SEASON_ONLY.exec(text)))return {form:'season_only',stem:norm(m[1]),n:Number(m[2]),n2:null};
 return null;
}
const isOrdinal=parsed=>parsed?.form==='ordinal_single'||parsed?.form==='ordinal_range';
const rows=file=>{const data=JSON.parse(fs.readFileSync(file,'utf8'));return Array.isArray(data)&&data[0]?.results?data[0].results:data;};
// A duration the guards can trust: a non-empty array of finite positive numbers. Anything else is missing or malformed.
export function durationsOf(row){
 try{const list=typeof row.dur==='string'?JSON.parse(row.dur):row.dur;return Array.isArray(list)&&list.length&&list.every(value=>Number.isFinite(value)&&value>0)?list:null;}catch{return null;}
}
const durationMax=row=>{const list=durationsOf(row);return list?Math.max(...list):null;};
const placeholderDescription=row=>!norm(row.ds)||norm(row.ds)===norm(row.t);
const colonPrefix=title=>{const i=String(title??'').indexOf(':');return i>2?norm(title.slice(0,i)):null;};
const obsKey=row=>row.ok??`${row.rs??'?'}|${row.t}`;
const add=(map,stem,key,value)=>{const entry=map.get(stem)||{keys:new Set(),ordinals:new Set()};entry.keys.add(key);if(value!=null)entry.ordinals.add(value);map.set(stem,entry);};

// Evidence is counted per distinct observation and per form: a season number never counts as an episode ordinal, and the same
// observation that appears in the history and in the cohort counts once.
export function buildContext({cohort,history,verified}){
 if(!Array.isArray(history)||!Array.isArray(verified))throw new Error('history and verified controls are required');
 const ordinal=new Map(),abbrev=new Map(),dash=new Map(),families=new Map();
 for(const row of [...history,...cohort]){
  const parsed=parseSerial(row.t);if(!parsed)continue;const key=obsKey(row);
  if(isOrdinal(parsed)){add(ordinal,parsed.stem,key,parsed.n);if(parsed.n2)add(ordinal,parsed.stem,key,parsed.n2);}
  else if(parsed.form==='season_abbrev')add(abbrev,parsed.stem,key,parsed.n);
 }
 for(const row of cohort){
  const match=DASH_CODE.exec(row.t||'');if(match)add(dash,norm(match[1]),obsKey(row),null);
  const prefix=colonPrefix(row.t);if(prefix){const entry=families.get(prefix)||new Set();entry.add(obsKey(row));families.set(prefix,entry);}
 }
 return {ordinal,abbrev,dash,families,verifiedTitles:new Set(verified.map(item=>norm(item.t))),verifiedPrefixes:new Set(verified.map(item=>colonPrefix(item.t)).filter(Boolean))};
}

// Trusted identity evidence on any slot, an owner decision or an owner intent keeps the observation out of every proven group.
export const hasTrustedIdentity=row=>Number(row.cs)>0||Boolean(row.oid)||Boolean(row.intent);

// First matching group wins. "proven" needs a structural form that a film title does not carry plus a check against a film-like reading;
// everything else is review, likely film or no proof. A TMDB no_match never decides a group.
export function classify(row,context){
 const title=String(row.t??'');
 if(hasTrustedIdentity(row))return 'trusted_identity_review';
 if(PIPE.test(title))return 'pipe_season_episode';
 if(LABEL.test(title))return 'series_label_suffix';
 const parsed=parseSerial(title);
 if(parsed){
  if(parsed.form==='season_only')return 'season_marker_only';
  if(parsed.form==='season_abbrev')return (context.abbrev.get(parsed.stem)?.keys.size||0)>=REPEAT_PROOF?'season_abbrev_episode':'ordinal_episode_review';
  const reached=Math.max(0,...(context.ordinal.get(parsed.stem)?.ordinals||[])),filmLike=context.verifiedTitles.has(parsed.stem)||YEAR.test(parsed.stem);
  return reached>=ORDINAL_PROOF&&!filmLike?'ordinal_episode_proven':'ordinal_episode_review';
 }
 const dash=DASH_CODE.exec(title);
 if(dash){
  const longest=durationMax(row),repeats=context.dash.get(norm(dash[1]))?.keys.size||0;
  return placeholderDescription(row)&&longest!=null&&longest<=DASH_MAX_MINUTES&&repeats>=REPEAT_PROOF?'dash_season_episode_placeholder':'numeric_suffix_block_review';
 }
 if(DECORATED.test(title))return 'decorated_film_title';
 const prefix=colonPrefix(title);
 if(prefix&&(context.families.get(prefix)?.size||0)>=FAMILY_SIZE&&!context.verifiedPrefixes.has(prefix))return 'show_family';
 return 'no_proof';
}

// The proposed stateless predicate: only inputs a scan or the cheap pass holds for ONE programme (title, description, durations).
// No ledger history, no repeat count and no verified-title guard. `guarded` adds the guard against a known title as a separate switch.
export function proposedScreen(row,{knownTitles=null}={}){
 const title=String(row.t??'');
 if(PIPE.test(title))return 'pipe_season_episode';
 if(LABEL.test(title))return 'series_label_suffix';
 const parsed=parseSerial(title);
 if(isOrdinal(parsed)&&Math.max(parsed.n,parsed.n2||0)>=ORDINAL_PROOF)return knownTitles?.has(parsed.stem)?null:'ordinal_episode';
 if(parsed?.form==='season_abbrev')return 'season_abbrev_episode';
 const dash=DASH_CODE.exec(title),longest=durationMax(row);
 if(dash&&placeholderDescription(row)&&longest!=null&&longest<=DASH_MAX_MINUTES)return 'dash_season_episode_placeholder';
 return null;
}

// Conditional exposure on UNCHANGED evidence: the resolver selects a row only inside the show window, seen in the latest snapshot, and either
// not terminal and due, or with a changed evidence_key. It is an upper bound for attempts, not a prediction of how many will run.
export function exposure(row,now){
 const terminal=Boolean(row.tr)||row.st==='excluded_nonfilm',due=!row.ra||Date.parse(row.ra)<=now,inWindow=Number(row.win)>0&&row.sl===1,bypass=Boolean(row.evmis);
 if(!inWindow)return {state:'outside_window',attempts:0};
 if(terminal&&!bypass)return {state:'terminal',attempts:0};
 const attempts=Math.max(0,ATTEMPT_LIMIT-(bypass&&terminal?0:(row.att||0)));
 return {state:due||bypass?'selectable_now':'in_backoff',attempts};
}
const bump=(map,key,by=1)=>{map[key]=(map[key]||0)+by;};
const newExposure=()=>({selectable_now:0,in_backoff:0,terminal:0,outside_window:0,attemptsUpperBound:0});
function addExposure(target,row,now){const e=exposure(row,now);target[e.state]++;target.attemptsUpperBound+=e.attempts;}

export function audit({cohort,history,verified},now=Date.now()){
 for(const row of cohort)for(const field of ['cs','oid','intent','win','sl'])if(row[field]===undefined)throw new Error(`cohort row lacks ${field}`);
 const context=buildContext({cohort,history,verified}),privateRows=[];
 const report={total:cohort.length,groups:{},controls:{verifiedTitles:verified.length,structuralMatches:{}},proposed:null};
 const groupOf=new Map();
 for(const row of cohort){
  const group=classify(row,context);groupOf.set(row.ok,group);
  const g=report.groups[group]||(report.groups[group]={class:GROUPS[group],observations:0,discoverOnly:0,mixed:0,status:{},placeholderDescription:0,exposure:newExposure()});
  g.observations++;if(row.xsh>0||row.ksh>0)g.mixed++;else g.discoverOnly++;
  bump(g.status,`${row.st||'none'}${row.tr?'/'+row.tr:''}`);
  if(placeholderDescription(row))g.placeholderDescription++;
  addExposure(g.exposure,row,now);
  privateRows.push({ok:row.ok,title:row.t,group});
 }
 const structural={pipe:t=>PIPE.test(t),label:t=>LABEL.test(t),ordinal:t=>isOrdinal(parseSerial(t)),seasonAbbrev:t=>parseSerial(t)?.form==='season_abbrev',seasonOnly:t=>parseSerial(t)?.form==='season_only',dashCode:t=>DASH_CODE.test(t),decorated:t=>DECORATED.test(t)};
 for(const [name,test] of Object.entries(structural))report.controls.structuralMatches[name]=verified.filter(item=>test(String(item.t??''))).length;
 // The proposed predicate on the controls, with the description and duration where the export carries them.
 const control={hits:0,unknownDescription:0};
 for(const item of verified){const reason=proposedScreen({t:item.t,ds:item.ds,dur:item.dur});if(reason){control.hits++;}else if(DASH_CODE.test(String(item.t??''))&&item.ds===undefined)control.unknownDescription++;}
 report.controls.proposedPredicate=control;
 const run=known=>{
  const out={hits:0,byReason:{},byClassifierGroup:{},outsideProven:0,trustedIdentityHits:0,exposure:newExposure()};
  for(const row of cohort){
   const reason=proposedScreen(row,{knownTitles:known});if(!reason)continue;
   const group=groupOf.get(row.ok);out.hits++;bump(out.byReason,reason);bump(out.byClassifierGroup,group);
   if(GROUPS[group]!=='proven')out.outsideProven++;if(hasTrustedIdentity(row))out.trustedIdentityHits++;
   addExposure(out.exposure,row,now);
  }
  return out;
 };
 report.proposed={unguarded:run(null),withKnownTitleGuard:run(context.verifiedTitles)};
 const provenRows=cohort.filter(row=>GROUPS[groupOf.get(row.ok)]==='proven');
 report.proposed.provenNotReached=provenRows.filter(row=>!proposedScreen(row,{knownTitles:null})).length;
 report.proposed.provenTotal=provenRows.length;
 return {report,privateRows};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
 for(const name of ['--cohort','--history','--verified'])if(!arg(name))throw new Error('Usage: node scripts/air-566-residual-nonfilm-audit.mjs --cohort <file> --history <file> --verified <file> [--now <iso>] [--private-out <dir>]');
 const {report,privateRows}=audit({cohort:rows(arg('--cohort')),history:rows(arg('--history')),verified:rows(arg('--verified'))},arg('--now')?Date.parse(arg('--now')):Date.now());
 console.log(JSON.stringify(report,null,1));
 const out=arg('--private-out');
 if(out){
  const resolved=path.resolve(out),repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  if(resolved===repo||resolved.startsWith(repo+path.sep))throw new Error('--private-out must be outside the repository');
  fs.mkdirSync(resolved,{recursive:true});fs.writeFileSync(path.join(resolved,'air-566-private-groups.json'),JSON.stringify(privateRows));
 }
}
