// AIR-94 read-only audit: compares the pre-AIR-94 non-film screening rules with the current
// nonFilmEPGReason() on a local R2 snapshot (scripts/r2-snapshot-export.mjs layout).
// Usage: node scripts/air-94-screening-audit.mjs <snapshot-dir> [--private-out <dir>]
// stdout carries aggregates only. Titles go only to --private-out, which must be outside the repository.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Frozen copy of the rules before AIR-94, kept only for this comparison.
function legacyNonFilmEPGReason(title){
 const value=String(title||'');
 if(/^(?:tv\s*(?:series|show)|series|show|теле(?:шоу|передача)|передача|телепрограма|серіал)(?:\s|[.:,-])/iu.test(value))return 'show_label';
 if(/^(?:т\/с|м\/с|телесериал|мультсериал|сериал)(?:\s|[.:,-])/i.test(value))return 'series_label';
 if(/(?:\bseason\s*\d+|\bepisode\s*\d+|сезон\s*\d+|\d+\s*серія|серія\s*\d+|\bep\.?\s*\d+|\bs\d{1,2}e\d{1,3}\b|сезон\s*\d+|\d+\s*(?:серия|серии|серий)|(?:серия|серии|эпизод)\s*\d+)/i.test(value))return 'episode_label';
 if(/[-–]\s*\d{1,2}\s*[-–]\s*\d{1,3}(?:\s*(?:серия|серии|с))?\s*$/i.test(value))return 'season_episode_suffix';
 if(/(?:выпуск\s*[№#]?\s*\d+|\d+\s*[-–]\s*\d+\s*серии)/i.test(value))return 'broadcast_episode';
 return null;
}
const EPISODE_CODE=/(?<![\p{L}\p{N}])s\d{1,2}\s*[.,]?\s*e(?:p\.?\s*)?\d{1,3}(?![\p{L}\p{N}])/iu;

export function loadSnapshot(dir){
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),files=new Map(manifest.objects.map(o=>[o.key,o.file]));
 const get=key=>files.has(key)?JSON.parse(fs.readFileSync(path.join(dir,files.get(key)),'utf8')):null;
 const pointer=get('epg/published-generation.json'),runId=pointer?.programmeRunId;
 return {
  programme:(runId&&get(`epg/generations/${runId}/programme.json`))||get('programme.json'),
  source:(runId&&get(`epg/generations/${runId}/discovery-latest.json`))||get('epg/discovery-latest.json'),
  decisions:get('epg/discovery-resolution.json')||{},
  catalog:(runId&&get(`epg/generations/${runId}/discovered-films.json`))||get('epg/discovered-films.json')||{},
  rawFeed:[...files.keys()].some(key=>/\.xml$/i.test(key)),
 };
}
function currentRules(){
 const context=vm.createContext({});
 vm.runInContext(fs.readFileSync(new URL('../src/sources.js',import.meta.url),'utf8'),context);
 return {reason:title=>context.nonFilmEPGReason(title),screened:(candidate,decision)=>context.screenedNonfilmReason(candidate,decision)};
}
const bump=(map,key)=>{map[key]=(map[key]||0)+1;};
export function audit(snapshot,now=Date.parse(snapshot.source?.updatedAt)||Date.now()){
 const rules=currentRules(),privateRows=[];
 const inWindow=c=>(c.shows||[]).some(s=>Number(s.start)>=now-72*3600000&&Number(s.start)<now+24*3600000);
 const current=c=>c.seenInLatestSnapshot===false?false:inWindow(c);
 // Control set: titles and aliases of known Films (watchlist programme films and the verified catalog).
 const control={titles:0,legacy:{},fixed:{}},seen=new Set();
 for(const film of [...(snapshot.programme?.films||[]),...Object.values(snapshot.catalog||{})]){
  for(const title of [film.title,film.original,film.titleRu,...(film.aliases||[])]){
   if(!title||seen.has(title))continue;seen.add(title);control.titles++;
   const a=legacyNonFilmEPGReason(title),b=rules.reason(title);
   if(a)bump(control.legacy,a);if(b)bump(control.fixed,b);
   if(a||b)privateRows.push({set:'control',title,legacy:a,fixed:b,tmdbId:film.tmdbId||null});
  }
 }
 // Ledger: every discovery candidate, judged on its stored title exactly as the resolver does.
 const items=snapshot.source?.items||[],ledger={candidates:items.length,current:0,legacy:{},fixed:{},prevented:{},added:{},storedExcluded:{},staleExcluded:{},staleExcludedCurrent:0,addedCurrentActionable:0};
 const sxe={rawTitles:0,rawTitlesWithCode:0,candidatesWithCode:0,codeCandidatesActionableLegacy:0,codeCandidatesActionableFixed:0};
 for(const c of items){
  const d=snapshot.decisions[c.key],a=legacyNonFilmEPGReason(c.title),b=rules.screened(c,d),live=current(c);if(live)ledger.current++;
  if(a)bump(ledger.legacy,a);if(b)bump(ledger.fixed,b);
  if(a&&!b){bump(ledger.prevented,a);privateRows.push({set:'prevented',title:c.title,legacy:a,fixed:null,decision:d?.status||null});}
  if(!a&&b){bump(ledger.added,b);privateRows.push({set:'added',title:c.title,legacy:null,fixed:b,decision:d?.status||null});if(live&&(!d||!['verified','excluded_nonfilm'].includes(d.status)))ledger.addedCurrentActionable++;}
  if(d?.status==='excluded_nonfilm'){bump(ledger.storedExcluded,d.reason||'unknown');if(!b){bump(ledger.staleExcluded,d.reason||'unknown');if(live)ledger.staleExcludedCurrent++;privateRows.push({set:'stale_excluded',title:c.title,stored:d.reason||null,fixed:null,current:live});}}
  for(const raw of c.rawTitles||[]){sxe.rawTitles++;if(EPISODE_CODE.test(raw))sxe.rawTitlesWithCode++;}
  if(EPISODE_CODE.test(c.title)){sxe.candidatesWithCode++;if(live&&!a&&!['verified','excluded_nonfilm'].includes(d?.status))sxe.codeCandidatesActionableLegacy++;if(live&&!b&&d?.status!=='verified')sxe.codeCandidatesActionableFixed++;}
 }
 return {
  report:{programmeRunId:snapshot.source?.programmeRunId||null,rawFeedInSnapshot:snapshot.rawFeed,aggregateFilteredNonMovies:snapshot.source?.filteredNonMovies??null,aggregateRawCandidates:snapshot.source?.rawCandidates??null,control,ledger,episodeCode:sxe},
  privateRows,
 };
}
if(import.meta.url===`file://${process.argv[1]}`){
 const [dir,...rest]=process.argv.slice(2);if(!dir)throw new Error('Usage: node scripts/air-94-screening-audit.mjs <snapshot-dir> [--private-out <dir>]');
 const outIndex=rest.indexOf('--private-out'),out=outIndex>=0?rest[outIndex+1]:null;
 const {report,privateRows}=audit(loadSnapshot(dir));
 if(out){
  if(path.resolve(out).startsWith(path.resolve(new URL('..',import.meta.url).pathname)))throw new Error('Private output must be outside the repository');
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'air-94-titles.json'),JSON.stringify(privateRows,null,1));
 }
 console.log(JSON.stringify(report,null,1));
}
