// Offline dry run of the EPG Channel policy over a LOCAL XMLTV file, in all three scan modes. It reads local files only, writes nothing, and opens no network, database,
// bucket or Worker. The registration callback is a recording no-op: no D1 writer exists here.
//
//   node scripts/epg-channel-policy-dry-run.mjs --xmltv feed.xml[.gz] --policies policies.json --watchlist watchlist.json [--catalog catalog.json]
//        --now 2026-11-21T12:00:00Z --feed-fetched-at 2026-11-21T11:55:00Z
//
// Inputs (all real; the harness refuses to substitute anything for a missing one):
//   --xmltv          the feed, plain or gzip. Its size and SHA-256 are recorded; the path and any URL are not.
//   --snapshot-rows  instead of --policies: the rows of the five read-only SELECTs of the Channel snapshot, {tables, marker, categories, channels} (the statements of readSnapshot in
//                    src/epg-channel-d1.js: the sqlite_master check, the marker, the categories, the channels, the marker again). The repository's own reader derives the effective
//                    policy of every channel, so the harness never re-implements the precedence.
//   --policies       the effective Channel policies: [["ch001",{"policy":"discover","basis":"category"}], ...] or {revision, digest, entries:[...]} (the Map
//                    `materializePolicies` returns, read-only). With a revision the digest is recomputed and compared when one is given.
//   --watchlist      the watchlist films array (or {films}), as `run.watchlist` in the Worker.
//   --catalog        the discovered-films cache (object or array); combined with the watchlist exactly as the Worker does (catalogOnly, no tmdbId overlap).
//   --now            the instant the scan treats as "now" (its window is relative to it). --feed-fetched-at: when the feed copy was taken (provenance).
// Output: one JSON document of NUMBERS and booleans only (no title, slot key, channel id or URL) and a verdict. Exit 0 PASS, 1 FAIL, 2 BLOCKED (a missing or unusable input).
// Keep a real run's output out of GitHub, Trello and logs beyond the counters the card asks for. This script is a harness, not evidence: its own tests use a small synthetic feed.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {materializePolicies} from '../src/epg-channel-d1.js';

const POLICIES=['deny_all','discover','known_only'];
const sha256=value=>createHash('sha256').update(value).digest('hex');
const CHANNEL_ID=/^ch\d{3,6}$/;

export class Blocked extends Error{constructor(message){super(message);this.name='Blocked';}}

// The Worker's combined known-Film input: the watchlist, then every catalog Film whose tmdbId the watchlist does not hold, marked catalogOnly.
export function combinedFilms(watchlist,catalog){
 const held=new Set(watchlist.map(film=>String(film.tmdbId)));
 return [...watchlist,...Object.values(catalog||{}).filter(film=>!held.has(String(film.tmdbId))).map(film=>({...film,catalogOnly:true}))];
}

export function mapDigest(revision,map){
 return sha256(JSON.stringify([revision,[...map.keys()].sort().map(id=>[id,map.get(id).policy,map.get(id).basis])]));
}

// -> {revision, digest, map, digestChecked}. Throws Blocked for an empty or malformed input.
export function parsePolicies(raw){
 const entries=Array.isArray(raw)?raw:raw&&Array.isArray(raw.entries)?raw.entries:null;
 if(!entries||!entries.length)throw new Blocked('policies: no entries; the effective Channel policies are required');
 const map=new Map();
 for(const entry of entries){
  if(!Array.isArray(entry)||typeof entry[0]!=='string'||!entry[1]||!POLICIES.includes(entry[1].policy)||typeof entry[1].basis!=='string')throw new Blocked('policies: an entry is not [id, {policy, basis}]');
  if(map.has(entry[0]))throw new Blocked('policies: a duplicate channel id');
  map.set(entry[0],Object.freeze({policy:entry[1].policy,basis:entry[1].basis}));
 }
 const revision=raw&&!Array.isArray(raw)&&Number.isInteger(raw.revision)?raw.revision:null;
 const digest=revision===null?null:mapDigest(revision,map);
 const stated=raw&&!Array.isArray(raw)&&typeof raw.digest==='string'?raw.digest:null;
 return {revision,digest,map,digestChecked:stated===null||digest===null?null:stated===digest};
}

// The rows of the snapshot's SELECTs -> {revision, digest, map, digestChecked:null}, through the repository's own reader (`materializePolicies`) over a read-only stand-in that
// answers each of its statements from the given rows. Anything the reader refuses (empty, torn, incomplete) is BLOCKED, never defaulted.
export async function policiesFromRows(rows){
 if(!rows||!Array.isArray(rows.categories)||!Array.isArray(rows.channels)||!rows.marker)throw new Blocked('snapshot-rows: {marker, categories, channels} are required');
 const tables=Array.isArray(rows.tables)?rows.tables:['epg_channel_revision','epg_channel_cas','epg_channel_category','epg_channel'];
 const answer=sql=>sql.includes('sqlite_master')?{all:tables.map(name=>({name}))}:sql.includes('FROM epg_channel_revision')?{first:rows.marker}:sql.includes('FROM epg_channel_category')?{all:rows.categories}:sql.includes('FROM epg_channel')?{all:rows.channels}:{};
 const db={prepare:sql=>({bind:()=>({first:async()=>answer(sql).first??null,all:async()=>({results:answer(sql).all||[]})})})};
 const result=await materializePolicies(db);
 if(!result.ok)throw new Blocked('snapshot-rows: the Channel snapshot reader refused them ('+result.reason+')');
 return {revision:result.revision,digest:result.digest,map:result.map,digestChecked:null};
}

function scanner(root){
 const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,fetch:()=>{throw new Error('no network in a dry run');},console});
 vm.runInContext(fs.readFileSync(path.join(root,'src/domain/scored-resolution.js'),'utf8')+'\nglobalThis.showMatchBasis=showMatchBasis;',context);
 vm.runInContext(fs.readFileSync(path.join(root,'src/sources.js'),'utf8')+';globalThis.scanEPG=scanEPG;globalThis.assertEPGContinuity=assertEPGContinuity;',context);
 return context;
}

const openFeed=file=>{const raw=fs.createReadStream(file);return Readable.toWeb(file.endsWith('.gz')?raw.pipe(zlib.createGunzip()):raw);};
const slotKeys=result=>{
 const keys=new Map();
 for(const film of result.films)for(const show of film.shows)keys.set('f|'+film.id+'|'+show.channelId+'|'+show.start,{channelId:show.channelId,kind:'film'});
 for(const item of result.discovery)for(const show of item.shows){
  const confirmed=(item.confirmedSlots||[]).some(slot=>slot.channelId===show.channelId&&slot.start===show.start);
  keys.set('c|'+item.key+'|'+show.channelId+'|'+show.start,{channelId:show.channelId,kind:'candidate',confirmed});
 }
 return keys;
};
const policyOf=(map,id)=>map.get(id)||{policy:'known_only',basis:'unknown'};
const count=(items,predicate)=>items.reduce((n,item)=>n+(predicate(item)?1:0),0);

// Runs the three modes over one feed, one combined film input and one `now`. -> the raw material `evaluate` judges.
export async function runModes({root,xmltv,policies,films,now}){
 const context=scanner(root),runs={};
 const before=mapDigest(policies.revision??0,policies.map);
 for(const [mode,options] of [['legacy',{}],['filtered',{policies:policies.map}],['degraded',{degraded:true}]]){
  const batches=[];
  context.stream=openFeed(xmltv);context.films=structuredClone(films);context.now=now;
  context.options={...options,onDeclarations:async payload=>{batches.push(payload.channels.map(channel=>channel.channelId));}};
  const result=await vm.runInContext('scanEPG(stream,films,now,options)',context);
  runs[mode]={result,batches,slots:slotKeys(result)};
 }
 return {context,runs,pinnedUnchanged:before===mapDigest(policies.revision??0,policies.map)};
}

function filmShowCount(result){return result.films.reduce((n,film)=>n+film.shows.length,0);}
function reportStats(result){return {...result.stats,broadcasts:filmShowCount(result),channels:result.coverage.length};}

export function guardMatrix(context,runs,now,watchlistCount){
 const attempt=(from,to,tweak)=>{
  const next={...runs[to].result,stats:{...runs[to].result.stats,...(tweak||{})}};
  const previous={watchlistCount,stats:reportStats(runs[from].result)};
  try{vm.runInContext('assertEPGContinuity(next,previous,watchlistCount,now)',Object.assign(context,{next,previous,watchlistCount,now}));return {ok:true};}
  catch(error){return {ok:false,message:String(error.message)};}
 };
 const modes=['legacy','filtered','degraded'],rows=[];
 for(const from of modes)for(const to of modes)rows.push({from,to,sameMode:from===to,...attempt(from,to)});
 const scanned=runs.legacy.result.stats.scanned;
 const controls={
  // The raw checks must still fire on a change of mode. The programme-count rule needs a previous run above 10 000 programmes; below that it is not applicable, not a failure.
  rawProgrammeCount:scanned>10000?attempt('legacy','filtered',{scanned:Math.floor(scanned*.5)}):{applicable:false},
  horizon:attempt('legacy','degraded',{epgEnd:now}),
 };
 return {rows,controls};
}

// Judges the material. Every check is a boolean with its numbers; nothing identifies a title, a slot or a channel.
export function evaluate({runs,policies,pinnedUnchanged,matrix,now,watchlistCount}){
 const legacy=runs.legacy,filtered=runs.filtered,degraded=runs.degraded;
 const policy=id=>policyOf(policies.map,id);
 const checks=[];
 const add=(id,pass,detail)=>checks.push({id,pass:Boolean(pass),...detail});

 add('legacy_unchanged',legacy.batches.length===0&&legacy.result.stats.policy===undefined&&legacy.result.stats.policyMode==='legacy',{registrarCalls:legacy.batches.length});

 const denySurvivors=count([...filtered.slots.values()],slot=>policy(slot.channelId).policy==='deny_all');
 add('filtered_no_deny_all_shows',denySurvivors===0,{survivingDenyAllSlots:denySurvivors});

 const unknownCandidates=count([...filtered.slots.values()],slot=>slot.kind==='candidate'&&!slot.confirmed&&policy(slot.channelId).policy!=='discover');
 add('filtered_no_unknown_candidates_from_known_only',unknownCandidates===0,{unconfirmedCandidateSlotsOnNonDiscoverChannels:unknownCandidates});

 const lost={denyAll:0,knownOnlyCandidate:0,unexplained:0};let gained=0;
 for(const [key,slot] of legacy.slots){
  if(filtered.slots.has(key))continue;
  const p=policy(slot.channelId).policy;
  if(p==='deny_all')lost.denyAll++;else if(p==='known_only'&&slot.kind==='candidate')lost.knownOnlyCandidate++;else lost.unexplained++;
 }
 for(const key of filtered.slots.keys())if(!legacy.slots.has(key))gained++;
 add('filtered_slot_differences_explained',lost.unexplained===0&&gained===0,{legacySlots:legacy.slots.size,filteredSlots:filtered.slots.size,lost,gained});

 const batch=filtered.batches[0]||[],batchSet=new Set(batch),newSet=new Set(filtered.result.newChannels.map(channel=>channel.channelId));
 const pol=filtered.result.stats.policy;
 add('declaration_boundary',filtered.batches.length===1&&batchSet.size===batch.length&&batch.every(id=>newSet.has(id)&&!policies.map.has(id))&&pol.lateDeclared===0&&batch.length===pol.channels.new-pol.lateDeclared&&pinnedUnchanged,{
  batches:filtered.batches.length,declaredBeforeFirstProgrammeAbsentFromSnapshot:batch.length,validIdsInBatch:count(batch,id=>CHANNEL_ID.test(id)),malformedIdsInBatch:count(batch,id=>!CHANNEL_ID.test(id)),
  lateDeclared:pol.lateDeclared,undeclaredProgrammeChannels:pol.channels.undeclared,pinnedMapUnchanged:pinnedUnchanged,
 });

 const dpol=degraded.result.stats.policy;
 const degradedUnconfirmed=count([...degraded.slots.values()],slot=>slot.kind==='candidate'&&!slot.confirmed);
 add('degraded_all_known_only',degraded.result.stats.policyMode==='degraded'&&dpol.channels.knownOnly===dpol.channels.total&&dpol.channels.discover===0&&dpol.channels.denyAll===0&&degradedUnconfirmed===0&&degraded.batches.length===0&&dpol.revision===undefined&&dpol.digest===undefined,{
  channels:dpol.channels.total,unconfirmedCandidateSlots:degradedUnconfirmed,registrarCalls:degraded.batches.length,
  knownFilmSlotsOnDenyAllChannels:count([...degraded.slots.values()],slot=>slot.kind==='film'&&policy(slot.channelId).policy==='deny_all'),
 });

 const rawOf=run=>({scanned:run.result.stats.scanned,coverage:run.result.coverage.length,epgStart:run.result.stats.epgStart,epgEnd:run.result.stats.epgEnd});
 const raw=rawOf(legacy);
 add('raw_counters_equal_across_modes',['filtered','degraded'].every(mode=>JSON.stringify(rawOf(runs[mode]))===JSON.stringify(raw)),raw);

 const sameModeRows=matrix.rows.filter(row=>row.sameMode),changeRows=matrix.rows.filter(row=>!row.sameMode);
 const controlsOk=Object.values(matrix.controls).every(control=>control.applicable===false||control.ok===false);
 add('continuity_guard',sameModeRows.every(row=>row.ok)&&changeRows.every(row=>row.ok)&&controlsOk,{
  sameMode:sameModeRows.map(row=>({mode:row.from,ok:row.ok})),modeChanges:count(changeRows,row=>row.ok)+'/'+changeRows.length,
  rawProgrammeCountStillChecked:matrix.controls.rawProgrammeCount.applicable===false?'not_applicable_below_10000_programmes':matrix.controls.rawProgrammeCount.ok===false,horizonStillChecked:matrix.controls.horizon.ok===false,
 });

 const summary=mode=>{const r=runs[mode].result;return {
  scanned:r.stats.scanned,coverageChannels:r.coverage.length,retained:r.stats.retained,filmsWithShows:r.films.length,filmShows:filmShowCount(r),candidates:r.discovery.length,
  candidateShows:r.discovery.reduce((n,item)=>n+item.shows.length,0),uncertain:r.stats.uncertain,duplicateSlot:r.stats.duplicate_slot,policy:r.stats.policy||null,
 };};
 return {verdict:checks.every(check=>check.pass)?'PASS':'FAIL',checks,modes:{legacy:summary('legacy'),filtered:summary('filtered'),degraded:summary('degraded')},now:new Date(now).toISOString(),watchlistFilms:watchlistCount};
}

export async function dryRun({root,xmltv,policies,watchlist,catalog,now,feedFetchedAt}){
 if(!xmltv||!fs.existsSync(xmltv))throw new Blocked('xmltv: the real feed file is required (no URL is fetched here)');
 if(!Number.isFinite(now))throw new Blocked('now: --now is required: the scan window is relative to it');
 if(!Number.isFinite(feedFetchedAt))throw new Blocked('feed-fetched-at: when the feed copy was taken is required (provenance)');
 if(!Array.isArray(watchlist)||!watchlist.length)throw new Blocked('watchlist: a non-empty watchlist is required; an empty one would silently skip the broadcast check');
 const films=combinedFilms(watchlist,catalog);
 const bytes=fs.readFileSync(xmltv);
 const runs=await runModes({root,xmltv,policies,films,now});
 const matrix=guardMatrix(runs.context,runs.runs,now,watchlist.length);
 const report=evaluate({runs:runs.runs,policies,pinnedUnchanged:runs.pinnedUnchanged,matrix,now,watchlistCount:watchlist.length});
 return {...report,inputs:{
  xmltvBytes:bytes.length,xmltvSha256:sha256(bytes),feedFetchedAt:new Date(feedFetchedAt).toISOString(),
  policiesRevision:policies.revision,policiesDigest:policies.digest,policiesDigestMatchesStated:policies.digestChecked,policiesChannels:policies.map.size,
  watchlistFilms:watchlist.length,catalogFilms:Object.keys(catalog||{}).length,combinedFilms:films.length,catalogOnlyFilms:films.filter(film=>film.catalogOnly).length,
 }};
}

function parseArgs(argv){
 const args={};
 for(let i=0;i<argv.length;i++){if(argv[i].startsWith('--')){const next=argv[i+1];args[argv[i].slice(2)]=next&&!next.startsWith('--')?next:true;}}
 return args;
}
const readJson=(file,label)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Blocked(label+': the file is missing or not JSON');}};

async function main(){
 const args=parseArgs(process.argv.slice(2));
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 try{
  if((!args.policies&&!args['snapshot-rows'])||!args.watchlist)throw new Blocked('usage: --xmltv <file> (--policies <json> | --snapshot-rows <json>) --watchlist <json> [--catalog <json>] --now <iso> --feed-fetched-at <iso>');
  const policies=args['snapshot-rows']?await policiesFromRows(readJson(args['snapshot-rows'],'snapshot-rows')):parsePolicies(readJson(args.policies,'policies'));
  const watchRaw=readJson(args.watchlist,'watchlist'),watchlist=Array.isArray(watchRaw)?watchRaw:watchRaw.films;
  const catalog=args.catalog?readJson(args.catalog,'catalog'):{};
  const report=await dryRun({root,xmltv:args.xmltv,policies,watchlist,catalog,now:Date.parse(args.now),feedFetchedAt:Date.parse(args['feed-fetched-at'])});
  console.log(JSON.stringify(report,null,1));
  process.exitCode=report.verdict==='PASS'?0:1;
 }catch(error){
  if(error instanceof Blocked){console.log(JSON.stringify({verdict:'BLOCKED',reason:error.message},null,1));process.exitCode=2;return;}
  throw error;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
