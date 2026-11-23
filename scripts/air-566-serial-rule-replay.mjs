// AIR-566 offline replay of the EXACT production serial-episode screen (src/sources.js: serialEpisodeReason, serialDashStem, serialDashEpisodes)
// over the audit cohort, the verified-title controls and a catalog export. It writes nothing and calls no service.
// Usage: node scripts/air-566-serial-rule-replay.mjs --cohort <file> --history <file> --verified <file> --catalog <file> [--now <iso>] [--private-out <dir>]
//   --cohort/--history/--verified  as in scripts/air-566-residual-nonfilm-audit.mjs
//   --catalog  JSON rows {t,o,al,mt} of the current catalog Films (title, original, aliases as JSON text, movie titles as JSON text)
// The known-title index is built the way scanEPG builds it for a catalog-only Film. The same-scan repeat pass uses the cohort observations as
// the stand-in for one scan's discovery map. stdout carries aggregates only; titles and keys go only to --private-out, outside the repository.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {GROUPS,buildContext,classify,durationsOf,exposure,hasTrustedIdentity,norm} from './air-566-residual-nonfilm-audit.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function loadRule(){
 const context=vm.createContext({});
 vm.runInContext(fs.readFileSync(path.join(root,'src/sources.js'),'utf8'),context);
 return {reason:(title,known)=>vm.runInContext('serialEpisodeReason(__t,__k)',Object.assign(context,{__t:title,__k:known})),dashStem:title=>vm.runInContext('serialDashStem(__t)',Object.assign(context,{__t:title})),dash:(info,candidates)=>vm.runInContext('serialDashEpisodes(__i,__c)',Object.assign(context,{__i:info,__c:candidates})),norm:value=>vm.runInContext('norm(__t)',Object.assign(context,{__t:value})),titleKey:title=>vm.runInContext('epgTitleParts(__t).normalizedTitle',Object.assign(context,{__t:title}))};
}
const parse=text=>{try{const value=JSON.parse(text);return Array.isArray(value)?value:[];}catch{return [];}};
// scanEPG: a catalog-only Film is indexed by its title, original, aliases and movie titles, each normalized.
export function catalogIndex(catalog,rule){
 const index=new Map();
 for(const film of catalog)for(const title of new Set([film.t,film.o,...parse(film.al),...parse(film.mt)])){const key=title?rule.norm(title):'';if(key&&!index.has(key))index.set(key,[film]);}
 return index;
}
const asCandidate=row=>({title:row.t,rawTitles:[row.t],description:row.ds||null,confirmedTmdbId:null,confirmedSlots:row.cs>0?[{}]:[]});

export function replay({cohort,history,verified,catalog},rule,now=Date.now()){
 const index=catalogIndex(catalog,rule),context=buildContext({cohort,history,verified}),groups=new Map(cohort.map(row=>[row.ok,classify(row,context)]));
 const hit=new Map(),byReason={};
 const bump=(map,key)=>{map[key]=(map[key]||0)+1;};
 const decide=known=>{
  const out=new Map();
  // scanEPG applies the forms only to a programme whose whole title matches no known Film in the index.
  const wholeTitleKnown=row=>index.has(rule.titleKey(row.t));
  for(const row of cohort){if(wholeTitleKnown(row))continue;const reason=rule.reason(row.t,known);if(reason)out.set(row.ok,reason);}
  const info=new Map(),candidates=new Map(),keyOf=new Map();
  for(const row of cohort){const stem=rule.dashStem(row.t);if(!stem||out.has(row.ok)||wholeTitleKnown(row))continue;const maxMinutes=(durationsOf(row)||[]).reduce((a,b)=>Math.max(a,b),0)||null;info.set(row.ok,{stem,maxMinutes});candidates.set(row.ok,asCandidate(row));keyOf.set(row.ok,row);}
  for(const key of rule.dash(info,candidates))out.set(key,'dash_season_episode');
  return out;
 };
 const guarded=decide(index),unguarded=decide(new Set());
 const summarize=decision=>{
  const result={hits:decision.size,byReason:{},byClassifierGroup:{},outsideProven:0,trustedIdentityHits:0,mixedHits:0,exposure:{selectable_now:0,in_backoff:0,terminal:0,outside_window:0,attemptsUpperBound:0}};
  for(const row of cohort){const reason=decision.get(row.ok);if(!reason)continue;const group=groups.get(row.ok);bump(result.byReason,reason);bump(result.byClassifierGroup,group);if(GROUPS[group]!=='proven')result.outsideProven++;if(hasTrustedIdentity(row))result.trustedIdentityHits++;if(row.xsh>0||row.ksh>0)result.mixedHits++;const e=exposure(row,now);result.exposure[e.state]++;result.exposure.attemptsUpperBound+=e.attempts;}
  return result;
 };
 const proven=cohort.filter(row=>GROUPS[groups.get(row.ok)]==='proven');
 const verifiedHits={ordinal:0,pipe:0,label:0,dashStemPossible:0};
 for(const item of verified){const reason=rule.reason(item.t,index);if(reason==='ordinal_episode')verifiedHits.ordinal++;else if(reason==='season_pipe_episode')verifiedHits.pipe++;else if(reason==='mini_series_label')verifiedHits.label++;if(rule.dashStem(item.t))verifiedHits.dashStemPossible++;}
 return {total:cohort.length,catalogFilms:catalog.length,indexKeys:index.size,provenTotal:proven.length,
  withCatalogGuard:summarize(guarded),withoutGuard:summarize(unguarded),
  provenReachedWithGuard:proven.filter(row=>guarded.has(row.ok)).length,provenNotReachedWithGuard:proven.filter(row=>!guarded.has(row.ok)).length,
  collisionsKeptByGuard:[...unguarded.keys()].filter(key=>!guarded.has(key)).length,
  verifiedControls:{titles:verified.length,...verifiedHits,productionHitsWithGuard:verified.filter(item=>rule.reason(item.t,index)).length},
  decisions:guarded,reasonsUnguarded:unguarded};
}

const rows=file=>{const data=JSON.parse(fs.readFileSync(file,'utf8'));return Array.isArray(data)&&data[0]?.results?data[0].results:data;};
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
 for(const name of ['--cohort','--history','--verified','--catalog'])if(!arg(name))throw new Error('Usage: node scripts/air-566-serial-rule-replay.mjs --cohort <file> --history <file> --verified <file> --catalog <file> [--now <iso>] [--private-out <dir>]');
 const rule=loadRule(),result=replay({cohort:rows(arg('--cohort')),history:rows(arg('--history')),verified:rows(arg('--verified')),catalog:rows(arg('--catalog'))},rule,arg('--now')?Date.parse(arg('--now')):Date.now());
 const {decisions,reasonsUnguarded,...aggregates}=result;
 console.log(JSON.stringify(aggregates,null,1));
 const out=arg('--private-out');
 if(out){const resolved=path.resolve(out);if(resolved===root||resolved.startsWith(root+path.sep))throw new Error('--private-out must be outside the repository');fs.mkdirSync(resolved,{recursive:true});fs.writeFileSync(path.join(resolved,'air-566-serial-rule-hits.json'),JSON.stringify([...decisions]));}
}
