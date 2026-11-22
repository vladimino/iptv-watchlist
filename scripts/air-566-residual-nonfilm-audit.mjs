// AIR-566 read-only audit: classifies the unresolved Discovery candidates that still have showings on `discover` channels
// into proven non-film groups, review groups and "no proof" (docs/evidence/discovery/air-566-residual-nonfilm-audit-2026-11-22.md).
// Usage: node scripts/air-566-residual-nonfilm-audit.mjs --cohort <file> [--history <file>] [--verified <file>] [--now <iso>] [--private-out <dir>]
//   --cohort   JSON rows {ok,t,y,st,tr,att,ra,dur,ds,dsh,xsh,ksh} (the cohort query of the report; a D1 `[{results:[...]}]` envelope is accepted)
//   --history  JSON rows {t,rs} of every observation whose title carries a serial word, any residence (the history query)
//   --verified JSON rows {t} of every observation with a verified decision (the positive-control query)
// stdout carries aggregates only. Titles and observation keys go only to --private-out, which must be outside the repository.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ATTEMPT_LIMIT=5; // DISCOVERY_ATTEMPT_LIMIT in src/discovery.js
export const GROUPS=Object.freeze({
 ordinal_episode_proven:'proven',pipe_season_episode:'proven',series_label_suffix:'proven',dash_season_episode_placeholder:'proven',season_abbrev_episode:'proven',
 ordinal_episode_review:'review',numeric_suffix_block_review:'review',season_marker_only:'review',show_family:'review',
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

export function parseSerial(title){
 const text=String(title??'');let m;
 if((m=ORDINAL.exec(text)))return {form:m[3]?'ordinal_range':'ordinal_single',stem:norm(m[1]),n:Number(m[2]),n2:m[3]?Number(m[3]):null};
 if((m=SEASON_ABBREV.exec(text)))return {form:'season_abbrev',stem:norm(m[1]),n:Number(m[3]),n2:null};
 if((m=SEASON_ONLY.exec(text)))return {form:'season_only',stem:norm(m[1]),n:Number(m[2]),n2:null};
 return null;
}
const rows=file=>{if(!file)return [];const data=JSON.parse(fs.readFileSync(file,'utf8'));return Array.isArray(data)&&data[0]?.results?data[0].results:data;};
const durations=row=>{try{return JSON.parse(row.dur||'[]').filter(Number.isFinite);}catch{return [];}};
const durationMax=row=>{const d=durations(row);return d.length?Math.max(...d):null;};
const colonPrefix=title=>{const i=String(title??'').indexOf(':');return i>2?norm(title.slice(0,i)):null;};

// Context shared by every row: the ordinals each serial stem reaches anywhere in the ledger, the verified titles and stems, family sizes.
export function buildContext({cohort,history=[],verified=[]}){
 const ordinals=new Map(),stemCount=new Map(),dashStems=new Map(),families=new Map();
 for(const row of [...history,...cohort]){
  const parsed=parseSerial(row.t);if(!parsed)continue;
  const entry=ordinals.get(parsed.stem)||new Set();entry.add(parsed.n);if(parsed.n2)entry.add(parsed.n2);ordinals.set(parsed.stem,entry);
  stemCount.set(parsed.stem,(stemCount.get(parsed.stem)||0)+1);
 }
 for(const row of cohort){
  const dash=DASH_CODE.exec(row.t||'');if(dash){const stem=norm(dash[1]);dashStems.set(stem,(dashStems.get(stem)||0)+1);}
  const prefix=colonPrefix(row.t);if(prefix)families.set(prefix,(families.get(prefix)||0)+1);
 }
 const verifiedTitles=new Set(verified.map(row=>norm(row.t))),verifiedPrefixes=new Set(verified.map(row=>colonPrefix(row.t)).filter(Boolean));
 return {ordinals,stemCount,dashStems,families,verifiedTitles,verifiedPrefixes};
}

// First matching group wins. "proven" needs a structural form that a film title does not carry plus a check against a film-like reading;
// everything else is review, likely film or no proof. A TMDB no_match never decides a group.
export function classify(row,context){
 const title=String(row.t??'');
 if(PIPE.test(title))return 'pipe_season_episode';
 if(LABEL.test(title))return 'series_label_suffix';
 const parsed=parseSerial(title);
 if(parsed){
  const reached=context.ordinals.get(parsed.stem)||new Set(),max=Math.max(0,...reached);
  if(parsed.form==='season_only')return 'season_marker_only';
  if(parsed.form==='season_abbrev')return (context.stemCount.get(parsed.stem)||0)>=2?'season_abbrev_episode':'ordinal_episode_review';
  const filmLike=context.verifiedTitles.has(parsed.stem)||YEAR.test(parsed.stem);
  return max>=7&&!filmLike?'ordinal_episode_proven':'ordinal_episode_review';
 }
 const dash=DASH_CODE.exec(title);
 if(dash){
  const stem=norm(dash[1]),placeholder=!norm(row.ds)||norm(row.ds)===norm(title),long=durationMax(row);
  return placeholder&&(long==null||long<=80)&&(context.dashStems.get(stem)||0)>=2?'dash_season_episode_placeholder':'numeric_suffix_block_review';
 }
 if(DECORATED.test(title))return 'decorated_film_title';
 const prefix=colonPrefix(title);
 if(prefix&&(context.families.get(prefix)||0)>=10&&!context.verifiedPrefixes.has(prefix))return 'show_family';
 return 'no_proof';
}

const bump=(map,key,by=1)=>{map[key]=(map[key]||0)+by;};
export function audit({cohort,history,verified},now=Date.now()){
 const context=buildContext({cohort,history,verified}),report={total:cohort.length,groups:{},controls:{verifiedTitles:verified.length,structuralMatches:{}}},privateRows=[];
 for(const row of cohort){
  const group=classify(row,context),g=report.groups[group]||(report.groups[group]={class:GROUPS[group],observations:0,discoverOnly:0,mixed:0,status:{},placeholderDescription:0,remainingAttempts:0,actionableNow:0,terminal:0,inBackoff:0,durationMin:null,durationMax:null});
  g.observations++;if(row.xsh>0||row.ksh>0)g.mixed++;else g.discoverOnly++;
  bump(g.status,`${row.st||'none'}${row.tr?'/'+row.tr:''}`);
  if(!norm(row.ds)||norm(row.ds)===norm(row.t))g.placeholderDescription++;
  const terminal=Boolean(row.tr)||row.st==='excluded_nonfilm',due=!row.ra||Date.parse(row.ra)<=now;
  if(terminal)g.terminal++;else{g.remainingAttempts+=Math.max(0,ATTEMPT_LIMIT-(row.att||0));if(due)g.actionableNow++;else g.inBackoff++;}
  const dmax=durationMax(row);if(dmax!=null){g.durationMax=Math.max(g.durationMax??0,dmax);g.durationMin=Math.min(g.durationMin??Infinity,Math.min(...durations(row)));}
  privateRows.push({ok:row.ok,title:row.t,group});
 }
 const structural={pipe:t=>PIPE.test(t),label:t=>LABEL.test(t),ordinal:t=>{const p=parseSerial(t);return Boolean(p)&&p.form!=='season_only'&&p.form!=='season_abbrev';},seasonOnly:t=>parseSerial(t)?.form==='season_only',dashCode:t=>DASH_CODE.test(t),decorated:t=>DECORATED.test(t)};
 for(const [name,test] of Object.entries(structural))report.controls.structuralMatches[name]=verified.filter(row=>test(String(row.t??''))).length;
 return {report,privateRows};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
 if(!arg('--cohort'))throw new Error('Usage: node scripts/air-566-residual-nonfilm-audit.mjs --cohort <file> [--history <file>] [--verified <file>] [--now <iso>] [--private-out <dir>]');
 const {report,privateRows}=audit({cohort:rows(arg('--cohort')),history:rows(arg('--history')),verified:rows(arg('--verified'))},arg('--now')?Date.parse(arg('--now')):Date.now());
 console.log(JSON.stringify(report,null,1));
 const out=arg('--private-out');
 if(out){
  const resolved=path.resolve(out),repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  if(resolved===repo||resolved.startsWith(repo+path.sep))throw new Error('--private-out must be outside the repository');
  fs.mkdirSync(resolved,{recursive:true});fs.writeFileSync(path.join(resolved,'air-566-private-groups.json'),JSON.stringify(privateRows));
 }
}
