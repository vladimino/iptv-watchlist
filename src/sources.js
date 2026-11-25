const decode = s => String(s??'').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const cp=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):+n;return cp<=0x10ffff?String.fromCodePoint(cp):'';}).replace(/&(quot|apos|amp|lt|gt|nbsp);/g,(_,n)=>({quot:'"',apos:"'",amp:'&',lt:'<',gt:'>',nbsp:' '}[n]));
const plain = s => decode(String(s??'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const norm = s => plain(s).normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function sourceConfig(env={}){
 const letterboxdUsername=String(env.LETTERBOXD_USERNAME||'').trim();
 const epgUrl=String(env.EPG_XML_URL||'').trim();
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(letterboxdUsername))throw new Error('LETTERBOXD_USERNAME is not configured');
 if(!/^https:\/\//.test(epgUrl))throw new Error('EPG_XML_URL is not configured');
 return {letterboxdUsername,epg:epgUrl,watchlist:`https://letterboxd.com/${letterboxdUsername}/watchlist/`};
}
const attr=(tag,key)=>decode(tag.match(new RegExp('\\b'+key+'=(?:"([^"\\n]*)"|\x27([^\x27\\n]*)\x27)'))?.slice(1).find(x=>x!==undefined)||'');
const field=(xml,tag)=>plain(xml.match(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>'))?.[1]||'');
const extractYear=title=>Number(title.match(/\((19\d{2}|20\d{2})\)\s*$/)?.[1])||null;
const cleanTitle=title=>title.replace(/\s*\((?:19|20)\d{2}\)\s*$/,'').trim();
function epgTitleParts(raw){
 let title=plain(raw).replace(/^\s*(?:х\s*[.\/-]?\s*ф|к\s*[.\/-]?\s*ф|художественный\s+фильм|кинофильм|телефильм)\s*[:.\-–—]?\s*/iu,'').trim();
 const match=title.match(/(?:\s*\(((?:19|20)\d{2})\)|\s+((?:19|20)\d{2}))[.!?]?\s*$/u);
 let year=null;if(match){const base=title.slice(0,match.index).replace(/[\s:.,;!?–—-]+$/u,'').trim();if(norm(base).length>=2){title=base;year=Number(match[1]||match[2]);}}
 return {title:title||plain(raw),year,normalizedTitle:norm(title||raw)};
}
// Screening only removes high-confidence serialized forms. A bare "Episode 3", "Season 2" or "Show ..."
// can be part of a feature title (Star Wars: Episode 3, Open Season 2, Show Me the Picture), so it stays a candidate.
const NONFILM_EPISODE_CODE=/(?<![\p{L}\p{N}])s\d{1,2}\s*[.,]?\s*e(?:p\.?\s*)?\d{1,3}(?![\p{L}\p{N}])/iu;
const NONFILM_SEASON=/(?<![\p{L}])(?:season|series|сезон)\s*\d+|\d+\s*(?:-\s*)?(?:й\s+)?(?:сезон|с-н)(?![\p{L}])/iu;
const NONFILM_EPISODE=/(?<![\p{L}])(?:episode|ep\.?|серия|серии|серій|серія|эпизод)\s*\d+|\d+\s*(?:-\s*)?(?:я\s+)?(?:серия|серии|серий|серія|серії)(?![\p{L}])/iu;
// "N серия" alone keeps its long-standing exclusion; "N-я серия"/"N-серия" (multi-part films such as
// "Золотой телёнок (1968) 1-серия") and "Эпизод N" (Star Wars) are excluded only together with a season.
const NONFILM_RU_EPISODE=/(?<![\p{L}])(?:серия|серии|серія)\s*\d+|\d+\s*(?:серия|серии|серий|серія)(?![\p{L}])/iu;
// Ordinal season labels ("Сезон 4-й", "4-й сезон") and three-digit episode numbers do not occur in feature titles.
const NONFILM_ORDINAL_SEASON=/(?<![\p{L}])сезон\s*\d+\s*-\s*й(?![\p{L}])|\d+\s*-\s*й\s+сезон(?![\p{L}])/iu;
const NONFILM_LONG_EPISODE=/(?<![\p{L}])episode\s*\d{3,}(?![\p{N}])/iu;
function xmltvEpisodeReason(episodeNum){
 for(const [,attrs,text] of String(episodeNum||'').matchAll(/<episode-num\b([^>]*)>([^<]*)<\/episode-num>/g)){
  const system=attrs.match(/\bsystem=["']([^"']+)["']/)?.[1]||'';
  if(system==='xmltv_ns'&&/\d/.test(text.split('.')[1]||''))return 'xmltv_episode_num';
  if(system==='onscreen'&&(NONFILM_EPISODE_CODE.test(text)||NONFILM_SEASON.test(text)&&NONFILM_EPISODE.test(text)))return 'xmltv_episode_num';
 }
 return null;
}
function nonFilmEPGReason(title,programmeXml){
 const value=String(title||'');
 if(/^(?:tv\s*(?:series|show)|теле(?:шоу|передача)|передача|телепрограма|серіал)(?:\s|[.:,-])|^(?:series|show)\s*:/iu.test(value))return 'show_label';
 if(/^(?:т\/с|м\/с|телесериал|мультсериал|сериал)(?:\s|[.:,-])/iu.test(value))return 'series_label';
 if(NONFILM_EPISODE_CODE.test(value)||NONFILM_SEASON.test(value)&&NONFILM_EPISODE.test(value)||NONFILM_RU_EPISODE.test(value)||NONFILM_ORDINAL_SEASON.test(value)||NONFILM_LONG_EPISODE.test(value)||/[.,:;|]\s*ep\.?\s*\d+\s*(?:[.,:;|]|$)/iu.test(value))return 'episode_label';
 if(/\p{L}.*[-–]\s*\d{1,2}\s*[-–]\s*\d{1,3}(?:\s*(?:серия|серии|с))?\s*$/iu.test(value))return 'season_episode_suffix';
 if(/(?<![\p{L}])(?:спец)?выпуск\s*[№#]?\s*\d+|\d+\s*[-–]\s*\d+\s*серии/iu.test(value))return 'broadcast_episode';
 return xmltvEpisodeReason(programmeXml);
}
function xmltvCategories(programmeXml){
 const out=[];
 for(const [,text] of String(programmeXml||'').matchAll(/<category\b[^>]*>([^<]*)<\/category>/g)){
  const value=plain(text);if(value)out.push(value);
 }
 return [...new Set(out)].slice(0,8);
}
// A reliably matched watchlist/catalog identity or a verified decision outranks title screening.
function screenedNonfilmReason(candidate,decision){
 if(decision?.status==='verified'||candidate?.confirmedTmdbId)return null;
 return nonFilmEPGReason(candidate?.title);
}
// Serial-episode screen of the EPG scan only (not of the discovery cheap pass, so no stored decision depends on it). It adds four forms that carry
// a structure a feature title does not, each with the guard that the audit measured; it never reads the description or a duration to PERMIT a
// screen except in the same-scan repeat pass below, and a missing known-title index disables the ordinal form (fail safe).
//  - a season-pipe-episode pair ("<Title> 2|5 <Name>");
//  - an explicit trailing mini-series label ("<Title> (2026) мини-сериал", "<Title>: мини-сериал");
//  - an ordinal episode "N-я серия" (or a range) whose number or upper bound is at least SERIAL_ORDINAL_MIN, whose stem has no year and is not the
//    title of a known watchlist or catalog Film (the same index the scan matches against, keyed by the stem). Ordinals 1 to 6 stay candidates:
//    multi-part films are aired in parts;
//  - "<Title> S-EE" is decided after the stream by serialDashEpisodes: placeholder description, a valid duration of at most 80 minutes and the same
//    stem in at least two distinct programmes of the same scan. A programme whose whole title is a known Film title never enters that pass.
// A programme with one reliable watchlist or catalog Film match is never screened, and neither is one whose whole title is a known Film title that only the year or
// duration refused (the caller applies both before this rule).
const SERIAL_ORDINAL_MIN=7,SERIAL_DASH_MAX_MINUTES=80,SERIAL_DASH_REPEAT=2;
const SERIAL_ORDINAL=/^(.*?)[.,:;]?\s*(\d{1,4})\s*[-‑]?\s*(?:я|ая|й)?\s*(?:-|–|и)?\s*(?:(\d{1,4})\s*[-‑]?\s*(?:я|ая|й)?\s*)?сери(?:я|и|й)(?![\p{L}])/iu;
const SERIAL_PIPE=/^(.*?)(?:^|[\s(])\d{1,2}\|\d{1,3}(?:-\d{1,3})?(?:\)|\s|$)/u;
// The label is a trailing descriptor: it ends the title and follows a closing parenthesis, a colon or a dash, so an inflected word or a title that merely contains it is not matched.
const SERIAL_LABEL=/\p{L}[\s\S]*?(?:\)|[:–—-])\s*мини[\s\-–—]{0,2}сериал[\s.!?)»"]*$/iu;
const SERIAL_DASH=/^(.*?)\s(\d{1,2})\s*-\s*(\d{1,3})\s*$/u;
const SERIAL_YEAR=/(?:^|\s)(?:19|20)\d{2}(?:\s|$)/u;
function serialEpisodeReason(title,knownTitles){
 const value=String(title??'');
 const pipe=SERIAL_PIPE.exec(value);
 if(pipe&&/\p{L}{2}/u.test(pipe[1]))return 'season_pipe_episode';
 if(SERIAL_LABEL.test(value))return 'mini_series_label';
 const ordinal=SERIAL_ORDINAL.exec(value);
 if(ordinal&&knownTitles&&typeof knownTitles.has==='function'){
  const stem=norm(ordinal[1]),top=Math.max(Number(ordinal[2]),ordinal[3]?Number(ordinal[3]):0);
  if(top>=SERIAL_ORDINAL_MIN&&/\p{L}/u.test(stem)&&!SERIAL_YEAR.test(stem)&&!knownTitles.has(stem))return 'ordinal_episode';
 }
 return null;
}
// The stem of an "<Title> S-EE" programme, or null. The decision itself needs the whole scan (serialDashEpisodes).
function serialDashStem(title){
 const match=SERIAL_DASH.exec(String(title??''));
 const stem=match?norm(match[1]):'';
 return /\p{L}/u.test(stem)?stem:null;
}
// info: Map(observation key -> {stem,maxMinutes}); candidates: Map(observation key -> discovery candidate). Returns the keys to drop.
function serialDashEpisodes(info,candidates){
 const eligible=[],byStem=new Map();
 for(const [key,entry] of info){
  const candidate=candidates.get(key);if(!candidate)continue;
  const description=norm(candidate.description),placeholder=!description||description===norm(candidate.title)||(candidate.rawTitles||[]).some(raw=>description===norm(raw));
  const unconfirmed=!candidate.confirmedTmdbId&&!(candidate.confirmedSlots?.length);
  if(!placeholder||!unconfirmed||!Number.isFinite(entry.maxMinutes)||entry.maxMinutes<=0||entry.maxMinutes>SERIAL_DASH_MAX_MINUTES)continue;
  eligible.push(key);byStem.set(entry.stem,(byStem.get(entry.stem)||0)+1);
 }
 return eligible.filter(key=>byStem.get(info.get(key).stem)>=SERIAL_DASH_REPEAT);
}
function discoveryCandidateKey(item){
 const parts=epgTitleParts(item?.title),year=item?.year||parts.year||null;
 return parts.normalizedTitle+'|'+(year||'');
}
function canonicalDiscoveryCandidate(item){
 const parts=epgTitleParts(item.title),year=item.year||parts.year||null;
 return {...item,key:discoveryCandidateKey(item),title:parts.title,normalizedTitle:parts.normalizedTitle,year,rawTitles:[...new Set(item.rawTitles||[item.title])].slice(0,8),durations:[...new Set(item.durations||[item.duration])].filter(Number.isFinite).slice(0,12)};
}
function dedupeShows(shows){return [...new Map((shows||[]).filter(show=>show&&Number.isFinite(Number(show.start))).map(show=>[`${show.channelId}:${show.start}`,show])).values()];}
const EPG_GENERATION_KEY='epg/published-generation.json';
function epgGenerationKey(runId,name){return `epg/generations/${runId}/${name}`;}
function mergeDiscoveryCandidates(previous,latest,options={}){
 const replaceShows=options.replaceShows===true,latestKeys=new Set(),merged=new Map();
 const fold=(raw,fromLatest)=>{
  const item=canonicalDiscoveryCandidate(raw);if(fromLatest)latestKeys.add(item.key);
  const old=merged.get(item.key);
  if(!old){merged.set(item.key,replaceShows&&!fromLatest?{...item,shows:[]}:item);return;}
  const shows=replaceShows?fromLatest?dedupeShows(item.shows):old.shows||[]:dedupeShows([...(old.shows||[]),...(item.shows||[])]).filter(show=>show.start>=Date.now()-72*3600000);
  merged.set(item.key,{...old,...item,rawTitles:[...new Set([...old.rawTitles,...item.rawTitles])].slice(0,8),durations:[...new Set([...old.durations,...item.durations])].slice(0,12),firstAiring:Math.min(old.firstAiring,item.firstAiring),lastAiring:Math.max(old.lastAiring,item.lastAiring),airings:Math.max(old.airings,item.airings),description:item.description||old.description,shows});
 };
 for(const raw of previous||[])fold(raw,false);
 for(const raw of latest||[])fold(raw,true);
 if(replaceShows)for(const [key,item] of merged){
  const seen=latestKeys.has(key),starts=(item.shows||[]).map(show=>Number(show.start)).filter(Number.isFinite);
  merged.set(key,{...item,seenInLatestSnapshot:seen,lastSeenAt:seen&&starts.length?Math.max(...starts):item.lastSeenAt||item.lastAiring||null,lastSeenProgrammeRunId:seen&&options.programmeRunId?options.programmeRunId:item.lastSeenProgrammeRunId||null,shows:seen?item.shows||[]:[]});
 }
 return [...merged.values()];
}
// One stored candidate at a time. `chunks` yields strings (a byte stream already decoded, or one whole text).
// Exactly one top-level `items` array is visited per element; every other top-level field is returned parsed.
// A missing or non-array `items`, a second `items`, a truncated document, or trailing non-whitespace throws,
// so a commit never publishes a partial candidate list. Whitespace after the closing brace is allowed.
// AIR-519: with `field` null and `onEntry` given, no array is expected: every member of the top-level object is parsed on its own and handed to
// onEntry(key, value), and nothing is kept, so a large object map (the view index) is never held whole. The scan and its failures are the same.
async function forEachJsonObjectEntries(chunks,onEntry){return forEachJsonArrayItems(chunks,null,null,onEntry);}
async function forEachJsonArrayItems(chunks,field,onItem,onEntry=null){
 let buf='',pos=0,eof=false;
 const source=chunks[Symbol.asyncIterator]();
 const pull=async min=>{while(buf.length-pos<min&&!eof){const step=await source.next();if(step.done){eof=true;break;}if(step.value)buf+=step.value;}};
 const compact=()=>{if(pos>262144){buf=buf.slice(pos);pos=0;}};
 // Inline checks, not an awaited helper: an async `need(1)` per character allocated a promise per byte (AIR-460).
 const skipWs=async()=>{while(true){(buf.length-pos<1&&await pull(1));if(pos>=buf.length)return;const c=buf[pos];if(c!==' '&&c!=='\n'&&c!=='\r'&&c!=='\t')return;pos++;}};
 const fail=()=>{throw new Error('Discovery ledger JSON is incomplete');};
 const skipString=async()=>{if(buf[pos]!=='"')fail();pos++;while(true){(buf.length-pos<1&&await pull(1));if(pos>=buf.length)fail();const c=buf[pos++];if(c==='\\'){(buf.length-pos<1&&await pull(1));if(pos>=buf.length)fail();const e=buf[pos++];if(e==='u'){(buf.length-pos<4&&await pull(4));if(buf.length-pos<4)fail();pos+=4;}}else if(c==='"')return;}};
 const scanValue=async()=>{
  (buf.length-pos<1&&await pull(1));if(pos>=buf.length)fail();const c=buf[pos];
  if(c==='"'){await skipString();return;}
  if(c==='{'||c==='['){let depth=0;while(true){(buf.length-pos<1&&await pull(1));if(pos>=buf.length)fail();const ch=buf[pos++];if(ch==='"'){pos--;await skipString();continue;}if(ch==='{'||ch==='[')depth++;else if(ch==='}'||ch===']'){depth--;if(depth===0)return;}}}
  while(true){if(pos>=buf.length){if(eof)return;await pull(1);if(pos>=buf.length)return;}const ch=buf[pos];if(ch===','||ch===']'||ch==='}'||ch<=' ')return;pos++;}
 };
 await skipWs();(buf.length-pos<1&&await pull(1));if(pos>=buf.length||buf[pos]!=='{')fail();pos++;
 const wrapper={};let first=true,sawField=false;
 while(true){
  await skipWs();(buf.length-pos<1&&await pull(1));if(pos>=buf.length)fail();
  if(buf[pos]==='}'){pos++;break;}
  if(!first){if(buf[pos]!==',')fail();pos++;await skipWs();(buf.length-pos<1&&await pull(1));if(pos>=buf.length)fail();}
  first=false;
  if(buf[pos]!=='"')fail();
  const keyStart=pos;await skipString();const key=JSON.parse(buf.slice(keyStart,pos));
  await skipWs();(buf.length-pos<1&&await pull(1));if(pos>=buf.length||buf[pos]!==':')fail();pos++;await skipWs();(buf.length-pos<1&&await pull(1));if(pos>=buf.length)fail();
  if(key===field){
   if(sawField||buf[pos]!=='[')fail();
   sawField=true;
   pos++;let itemFirst=true;
   while(true){
    await skipWs();(buf.length-pos<1&&await pull(1));if(pos>=buf.length)fail();
    if(buf[pos]===']'){pos++;break;}
    if(!itemFirst){if(buf[pos]!==',')fail();pos++;await skipWs();(buf.length-pos<1&&await pull(1));if(pos>=buf.length)fail();}
    itemFirst=false;const start=pos;await scanValue();const slice=buf.slice(start,pos);compact();await onItem(JSON.parse(slice));
   }
  }else{const start=pos;await scanValue();const value=JSON.parse(buf.slice(start,pos));compact();if(onEntry)await onEntry(key,value);else wrapper[key]=value;}
 }
 if(!sawField&&field!==null)fail();
 await skipWs();
 if(pos<buf.length)fail();
 return wrapper;
}
function groupDiscoveryRaws(items){
 const groups=new Map(),order=[];
 for(const raw of items||[]){const key=discoveryCandidateKey(raw);let list=groups.get(key);if(!list){list=[];groups.set(key,list);order.push(key);}list.push(raw);}
 return {groups,order};
}
// Same candidate, in the same order, as mergeDiscoveryCandidates([...previous, ...reentry], latest, options),
// but previous rows are pushed one at a time and dropped. `duplicates` holds canonical keys that occur more
// than once in previous; those few rows stay buffered until `end`. Every other row is emitted immediately.
function openDiscoveryMerge(latest,reentry,options,duplicates){
 const latestGroups=groupDiscoveryRaws(latest),reentryGroups=groupDiscoveryRaws(reentry),emitted=new Set(),pending=new Map();
 latest=null;reentry=null;
 const take=(key)=>{const list=latestGroups.groups.get(key)||[];latestGroups.groups.delete(key);return list;};
 // Re-entry is previous input, after the stored rows of the same canonical key and before latest.
 const fold=(previousRaws,key)=>{
  const re=reentryGroups.groups.get(key)||[];reentryGroups.groups.delete(key);emitted.add(key);
  return mergeDiscoveryCandidates([...(previousRaws||[]),...re],take(key),options)[0]||null;
 };
 return {
  push(raw){
   const key=discoveryCandidateKey(raw);
   if(duplicates?.has(key)){let slot=pending.get(key);if(!slot){slot={raws:[]};pending.set(key,slot);}slot.raws.push(raw);return null;}
   return fold([raw],key);
  },
  end(){
   const deferred=[];
   for(const [key,slot] of pending){const item=fold(slot.raws,key);if(item)deferred.push({key,item});}
   pending.clear();
   const appended=[];
   for(const key of reentryGroups.order){if(emitted.has(key)||!reentryGroups.groups.has(key))continue;const item=fold([],key);if(item)appended.push(item);}
   for(const key of latestGroups.order){if(!latestGroups.groups.has(key))continue;const item=mergeDiscoveryCandidates([],take(key),options)[0];if(item)appended.push(item);}
   latestGroups.groups.clear();reentryGroups.groups.clear();
   return {deferred,appended};
  }
 };
}
// AIR-220 / ADR 0034: bounded discovery ledger. The active ledger holds the latest scan's candidates; candidates that left
// the EPG move losslessly into a write-once segmented archive behind one compare-and-swap pointer.
const LEDGER_ARCHIVE_PREFIX='epg/discovery-archive/v1/',LEDGER_ARCHIVE_POINTER=LEDGER_ARCHIVE_PREFIX+'current.json',LEDGER_ARCHIVE_SEGMENTS=64,LEDGER_ARCHIVE_CHAIN_LIMIT=8;
// AIR-429. In `bounded` mode the observations that left the scan on an earlier day (the backlog a `frozen` ledger accumulated) are
// archived at most this many a commit, in key order, so that the first bounded commit does not hold the whole backlog in memory. The
// observations that left the scan since the previous generation (the daily flow) are archived at once; they are what a steady bounded
// commit archives anyway. A function, so that a test can use a small cap.
const LEDGER_DRAIN_CAP=4000;
function ledgerDrainCap(){return LEDGER_DRAIN_CAP;}
// What the cap keeps in the active ledger: `held(key)` is true for a backlog observation (not seen in the previous generation's scan
// and not in this one) that this commit does not archive. `backlog` is how many of them stay after this commit.
function planLedgerDrain(backlogKeys,latestKeys,cap){
 const absent=[];
 for(const key of backlogKeys||[])if(!latestKeys.has(key))absent.push(key);
 absent.sort();
 const limit=Number.isSafeInteger(cap)&&cap>=0?cap:0,departing=new Set(absent.slice(0,limit)),held=new Set(absent.slice(limit));
 return {held:key=>held.has(key),backlog:held.size,archiving:departing.size,cap:limit};
}
// Production EPG seal is always bounded (ADR 0156). `full` and `frozen` remain only on an offline fixture that carries the
// `offlineLedgerFixture` marker (ADR 0160); the Worker has no such binding and a leftover DISCOVERY_LEDGER_MODE is ignored.
function discoveryLedgerMode(env){
 if(env?.offlineLedgerFixture){
  const value=env.DISCOVERY_LEDGER_MODE;
  return value==='frozen'||value==='full'||value==='bounded'?value:'bounded';
 }
 return 'bounded';
}
function fnv1a32(text){let hash=0x811c9dc5;for(const byte of new TextEncoder().encode(String(text))){hash^=byte;hash=Math.imul(hash,0x01000193)>>>0;}return hash>>>0;}
function ledgerArchiveSegment(key,count=LEDGER_ARCHIVE_SEGMENTS){return fnv1a32(key)%count;}
const ledgerArchiveSegmentKey=(segment,writeId)=>LEDGER_ARCHIVE_PREFIX+'segments/'+String(segment).padStart(3,'0')+'/'+writeId+'.json';
const ledgerArchiveManifestKey=manifestId=>LEDGER_ARCHIVE_PREFIX+'manifests/'+manifestId+'.json';
// Of two archived payloads of one key, the later observation wins: later lastSeenAt, then later lastSeenProgrammeRunId order.
function archivedPayloadNewer(next,current){
 if(!current)return true;
 const a=Number(next?.lastSeenAt??next?.lastAiring),b=Number(current?.lastSeenAt??current?.lastAiring);
 if(Number.isFinite(a)&&Number.isFinite(b)&&a!==b)return a>b;
 if(Number.isFinite(a)!==Number.isFinite(b))return Number.isFinite(a);
 return String(next?.lastSeenProgrammeRunId||'')>=String(current?.lastSeenProgrammeRunId||'');
}
const CATALOG_AVAILABILITY_FIELDS=['shows','availableUntil','showsProgrammeRunId','epgLastAiring','hotEnteredAt'];
function stripCatalogAvailability(film){
 if(!film||typeof film!=='object')return film;
 const next={...film};
 for(const field of CATALOG_AVAILABILITY_FIELDS)delete next[field];
 return next;
}
function catalogIdentityDigest(film){
 const body=stripCatalogAvailability(film);
 if(!body||typeof body!=='object')return JSON.stringify(body);
 const ordered={};
 for(const key of Object.keys(body).sort()){
  ordered[key]=(key==='aliases'||key==='movieTitles')&&Array.isArray(body[key])?[...body[key]].sort():body[key];
 }
 return JSON.stringify(ordered);
}
function mergeCatalogIdentity(incoming,live,programmeRunId,options={}){
 const writeAvailability=options.writeAvailability!==false;
 const next={...(incoming||{})};
 const liveKeys=new Set();
 for(const [key,film] of Object.entries(live||{})){
  if(!film||typeof film!=='object')continue;
  liveKeys.add(key);
  const staged=next[key];
  if(!staged){next[key]=writeAvailability?{...film,shows:[],showsProgrammeRunId:programmeRunId||film.showsProgrammeRunId||null}:film;continue;}
  const movieTitles=[...new Set([...(staged.movieTitles||[]),...(film.movieTitles||[])])];
  const merged={...staged,aliases:[...new Set([...(staged.aliases||[]),...(film.aliases||[])])],...(movieTitles.length?{movieTitles}:{}),fingerprint:staged.fingerprint||film.fingerprint,prediction:staged.prediction||film.prediction};
  if(writeAvailability===false){
   next[key]=catalogIdentityDigest(merged)===catalogIdentityDigest(film)?film:stripCatalogAvailability(merged);
   continue;
  }
  next[key]=merged;
 }
 if(writeAvailability===false)for(const [key,film] of Object.entries(next)){
  if(liveKeys.has(key)||!film||typeof film!=='object')continue;
  next[key]=stripCatalogAvailability(film);
 }
 return next;
}
// ADR 0142 decision 13: under D1 the catalog record is identity data. Availability (`shows`, `epgLastAiring`, `showsProgrammeRunId`) is not rewritten here; readers take it from the completed programme. R2 still stamps those fields (`writeAvailability` default true).
function replaceCatalogAvailability(catalog,discoveryItems,programmeRunId,options={}){
 if(options.writeAvailability===false)return {catalog:catalog||{},changed:false};
 const byTmdb=new Map();
 for(const item of discoveryItems||[]){if(!item?.confirmedTmdbId)continue;const id=String(item.confirmedTmdbId),list=byTmdb.get(id)||[];list.push(...(item.shows||[]));byTmdb.set(id,list);}
 const next={};let changed=false;
 for(const [key,film] of Object.entries(catalog||{})){
  if(!film?.tmdbId){next[key]=film;continue;}
  const shows=dedupeShows(byTmdb.get(String(film.tmdbId))||[]);
  const epgLastAiring=Math.max(Number(film.epgLastAiring)||0,...shows.map(show=>Number(show.start)||0));
  const same=JSON.stringify(film.shows||[])===JSON.stringify(shows)&&(Number(film.epgLastAiring)||0)===epgLastAiring&&film.showsProgrammeRunId===programmeRunId;
  if(same){next[key]=film;continue;}
  changed=true;next[key]={...film,shows,epgLastAiring,showsProgrammeRunId:programmeRunId||null};
 }
 return {catalog:next,changed};
}
function canonicalizeDiscoveryLedger(source,decisions){
 const groups=new Map();for(const raw of source.items||[]){const key=canonicalDiscoveryCandidate(raw).key,list=groups.get(key)||[];list.push(raw.key);groups.set(key,list);}
 const items=mergeDiscoveryCandidates(source.items,[]),next={};let carriedVerified=0,retried=0;
 for(const item of items){const keys=groups.get(item.key),states=keys.map(key=>decisions?.[key]).filter(Boolean),verified=states.filter(s=>s.status==='verified'),ids=new Set(verified.map(s=>s.tmdbId));
  if(ids.size>1)throw new Error('Conflicting verified TMDB identities for '+item.key);
  if(verified.length){next[item.key]=verified[0];carriedVerified++;continue;}
  const reason=screenedNonfilmReason(item);if(reason){next[item.key]={status:'excluded_nonfilm',reason,checkedAt:states[0]?.checkedAt||new Date().toISOString()};continue;}
  if(states.length)retried++;
 }
 return {items,decisions:next,duplicatesRemoved:(source.items||[]).length-items.length,carriedVerified,retried};
}
const GENRE_MAP={Action:'Боевик',Thriller:'Триллер',Crime:'Криминал','Science Fiction':'Фантастика',Horror:'Ужасы',Adventure:'Приключения',Comedy:'Комедия',Drama:'Драма',Fantasy:'Фэнтези',Animation:'Мультфильм',History:'Исторический',War:'Военный',Mystery:'Детектив',Romance:'Мелодрама',Family:'Семейный',Documentary:'Документальный',Western:'Вестерн',Music:'Музыкальный','TV Movie':'Телефильм'};
// AIR-604 (ADR 0211 decision 5): `coordination` is a coordinator or null (today's request). An enforced Letterboxd cooldown sends no request and throws a typed `upstream_cooldown`
// error (with `until`), which each caller maps to its own not-now path; it is never a failure of the page. The body is read exactly once: an ok answer by this function (and then handed
// to the shared classifier, so a challenge page behind a 200 is a blocked answer and never a page), a non-ok answer only as a bounded prefix and only while coordination is on.
async function getHTML(url,coordination=null){
 let r;
 try{r=await(coordination?coordination.guard(fetch):fetch)(url,{signal:AbortSignal.timeout(25000)});}
 catch(error){if(error?.code==='upstream_cooldown')throw Object.assign(new Error(`Upstream cooldown: ${new URL(url).pathname}`),{code:'upstream_cooldown',until:error.until});throw error;}
 let h=null,html='';
 if(r.ok){h=await r.text();html=h;}else if(coordination&&await coordination.active())html=await UpstreamCooldown.readBodyBounded(r,32768);
 const scope=coordination?UpstreamCooldown.scopeOfUrl(url):null;
 const signal=scope?await coordination.after(scope,{status:r.status,headers:r.headers,html}):null;
 if(!r.ok)throw new Error(`Source HTTP ${r.status}: ${new URL(url).pathname}`);
 if(signal&&signal.reason==='challenge')throw new Error(`Source HTTP 403: ${new URL(url).pathname}`);
 if(h.length>3000000)throw new Error('Unexpected page size');return h;
}
function parseWatchlist(html){
 const films=[];for(const m of html.matchAll(/<div\b[^>]*data-component-class="LazyPoster"[^>]*>/g)){const tag=m[0],display=attr(tag,'data-item-name'),path=attr(tag,'data-item-link');if(!/^\/film\/[a-z0-9-]+\/$/.test(path))continue;const identity=JSON.parse(attr(tag,'data-postered-identifier'));films.push({id:identity.lid,title:cleanTitle(display),original:cleanTitle(display),year:extractYear(display),url:'https://letterboxd.com'+path});}
 const total=Number(html.match(/js-watchlist-count[^>]*>([\d,]+)/)?.[1]?.replaceAll(',',''));const next=html.match(/<a\b[^>]*class="next"[^>]*href="([^"]+)"/)?.[1];return {films,total,next};
}
function parseSynopsis(html){
 const tag=html.match(/<meta\b[^>]*\bname="description"[^>]*>/i)?.[0]||html.match(/<meta\b[^>]*\bproperty="og:description"[^>]*>/i)?.[0];
 if(!tag)return null;
 const description=plain(attr(tag,'content'));
 if(!description||/^watch .+ on letterboxd/i.test(description)||description.length>2500)return null;
 return description;
}
function parseFilm(html,base){
 const raw=html.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1];if(!raw)throw new Error('Film metadata missing');const meta=JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g,''));if(!meta.name)throw new Error('Film name missing');
 const alt=html.match(/Alternative Titles<\/span><\/h3>\s*<div[^>]*>\s*<p>([\s\S]*?)<\/p>/)?.[1]||'';
 const d=meta.duration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);const runtime=d?(Number(d[1]||0)*60+Number(d[2]||0)):null;
 const people=(value,role)=>[...new Map((Array.isArray(value)?value:value?[value]:[]).filter(p=>p.name).map(p=>{const path=String(p.sameAs||p.url||'').match(new RegExp('/'+role+'/([a-z0-9-]+)/'));const name=decode(p.name);return [path?.[1]||name,{id:role+'/'+(path?.[1]||name),original:name,name}];})).values()];
 const directors=people(meta.director,'director'),actors=people(meta.actor,'actor').slice(0,10);
 // tmdbLink is evidence for an owner-confirmed retirement (ADR 0057), never an identity: tmdbId stays the attribute number.
 return {...base,directors,actors,peopleVersion:1,tmdbId:html.match(/data-tmdb-id="(\d+)"/)?.[1]||null,tmdbLink:letterboxdTmdbLink(html),original:decode(meta.name),aliases:[...new Set([base.title,decode(meta.name),...plain(alt).split(/,\s*/)].filter(Boolean))],genres:(Array.isArray(meta.genre)?meta.genre:meta.genre?[meta.genre]:[]).map(g=>GENRE_MAP[g]||g),poster:typeof meta.image==='string'&&meta.image.startsWith('https://')?meta.image:null,runtime,synopsis:parseSynopsis(html),synopsisFetchedAt:new Date().toISOString(),metadataAt:new Date().toISOString()};
}
// The rated-archive identity step runs in a later script. These consts are not globals; the step calls this.
function letterboxdPageTools(){return {parseFilm,attr,extractYear};}
function xmlTime(s){const m=s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})$/);if(!m)return NaN;return Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6])-(m[7]==='+'?1:-1)*(+m[8]*60 + +m[9])*60000;}
const EPG_HOT_FUTURE_MS=24*3600000,EPG_RETAIN_FUTURE_MS=7*24*3600000;
// ADR 0151: a shared normalized title is one identity only when year and runtime, together, leave a single trusted id.
// Year within one and runtime within max(8 minutes, 12%) support a match. Runtime beyond max(45 minutes, 40%) contradicts it.
// A second indexed identity that is not contradicted blocks assignment; the slot stays an ordinary discovery observation.
function knownSlotDecision(candidates,titleYear,duration){
 const groups=new Map();
 for(const film of candidates){
  if(!film)continue;
  const id=film.tmdbId?String(film.tmdbId):'id:'+film.id;
  const group=groups.get(id);
  if(group)group.films.push(film);else groups.set(id,{films:[film]});
 }
 const rows=[...groups.values()].map(group=>{
  const years=group.films.map(film=>Number(film.year)).filter(year=>Number.isFinite(year)&&year>0);
  const nearYear=titleYear?years.find(year=>Math.abs(year-titleYear)<=1):null;
  const yearRelation=!titleYear?'absent':nearYear?'near':years.length?'conflict':'unknown';
  const runtime=group.films.map(film=>Number(film.runtime)).find(value=>Number.isFinite(value)&&value>0)||null;
  let runtimeRelation='unknown';
  if(runtime&&runtime>=55&&Number.isFinite(duration)){
   const distance=Math.abs(duration-runtime);
   runtimeRelation=distance<=Math.max(8,runtime*.12)?'near':distance<=Math.max(45,runtime*.4)?'mid':'conflict';
  }
  return {group,yearRelation,runtimeRelation};
 });
 const pick=row=>{const watch=row.group.films.find(film=>!film.catalogOnly);return [watch||row.group.films[0]];};
 if(titleYear){
  const plausible=rows.filter(row=>row.yearRelation==='near'&&row.runtimeRelation!=='conflict');
  if(plausible.length===1)return {films:pick(plausible[0]),reason:null};
  if(plausible.length>1)return {films:[],reason:'identity_collision'};
  if(rows.some(row=>row.yearRelation==='near'&&row.runtimeRelation==='conflict'))return {films:[],reason:'contradictory_runtime'};
  return {films:[],reason:'insufficient_year_or_duration'};
 }
 const near=rows.filter(row=>row.runtimeRelation==='near');
 const open=rows.filter(row=>row.runtimeRelation!=='conflict');
 if(near.length===1&&open.length===1)return {films:pick(near[0]),reason:null};
 if(near.length>=1&&open.length>1)return {films:[],reason:'identity_collision'};
 return {films:[],reason:'insufficient_year_or_duration'};
}
// A catalog confirmation belongs to the slot that earned it. The observation carries that id only when every retained slot confirms the same one.
function applySlotConfirmation(candidate,metas){
 const ids=(metas||[]).map(meta=>meta?.confirmedTmdbId||null);
 candidate.confirmedTmdbId=ids.length&&ids.every(id=>id&&id===ids[0])?ids[0]:null;
 candidate.confirmedSlots=candidate.shows.flatMap((show,index)=>ids[index]?[{channelId:show.channelId,start:show.start,tmdbId:ids[index]}]:[]);
}
// AIR-503: a catalog-only Film is confirmed on a slot by the title of that slot only when the movie authority gave the Film that title
// (its title, its original title or `movieTitles`, which a TMDB detail read records). An alias without that provenance still counts as a
// competitor in `knownSlotDecision`, but it never confirms: the slot stays an ordinary discovery observation for the resolver.
function movieTitleKeys(film){return new Set([film?.title,film?.original,...(film?.movieTitles||[])].map(value=>value?epgTitleParts(value).normalizedTitle:'').filter(Boolean));}
// AIR-564 (ADR 0187 decision 5, ADR 0191): the scan has three modes. `legacy` (no `options.policies`, no `options.degraded`) is the earlier behaviour byte for byte.
// `filtered`: `options.policies` is the in-memory Map<channelId,{policy,basis}> a consumer materialized once from ONE Channel snapshot. `degraded`: `options.degraded`
// is true because that snapshot is unavailable, absent, empty or torn; every channel is then `known_only` (no unknown candidate, no silent discover, no applied revision).
// `options.onDeclarations({channels})` is awaited once, at the boundary between the `<channel>` declarations and the first `<programme>` of the same single pass (best effort,
// never fatal): the declared ids the pinned Map does not hold. Declarations after that boundary are only counted (`lateDeclared`). Each in-window programme does one Map lookup by its channel id, before Film matching
// and before the discovery build: `deny_all` ignores the slot even for a known Film; `known_only` keeps only a reliably identified Film (a single watchlist
// match, or a catalog Film the slot confirms by a movie title, ADR 0142/0158) and creates no unknown candidate, uncertain entry or TMDB lookup; `discover`
// is the unchanged pipeline. An id the Map does not hold is `known_only`. The policy of a channel never depends on the title, so the same Film on another
// allowed channel is untouched. `stats` keeps the raw input counters (`scanned`, `coverage`) and adds the post-filter policy counters.
async function scanEPG(stream,watchlist,now,options={}){
 const degraded=Boolean(options&&options.degraded);
 const policies=degraded?new Map():options&&options.policies instanceof Map?options.policies:null;
 const mode=degraded?'degraded':policies?'filtered':'legacy';
 let boundaryDone=false,boundaryDeclared=null;
 const UNKNOWN_POLICY={policy:'known_only',basis:'unknown'};
 const policyCounts={inWindow:0,filteredDenyAll:0,skippedKnownOnly:0,discoveryEligible:0,unclassified:0};
 const index=new Map();for(const film of watchlist){for(const title of new Set([...(film.catalogOnly?[film.title,film.original]:[]),...(film.aliases||[film.original]),...(film.movieTitles||[])].map(norm))){if(!title)continue;if(!index.has(title))index.set(title,[]);index.get(title).push(film);}}
 // The ordinal form is only allowed against a catalog: an empty or unavailable catalog would make every stem look unknown and must not permit a screen.
 const serialGuard=watchlist.some(film=>film?.catalogOnly)?index:null;
 const rawDiscovery=new Set(),filteredNonMovies=new Set(),serialFiltered=new Map(),dashInfo=new Map();const channels=new Map(),declared=new Map(),coverage=new Map(),matched=new Map(),uncertain=new Map(),discovery=new Map(),slotOwners=new Map(),conflictedSlots=new Map(),showMeta=new WeakMap();let scanned=0,min=Infinity,max=-Infinity,kept=0,identityCollision=0,buffer='',complete=false,bytes=0;
 const reader=stream.getReader(),decoder=new TextDecoder();
 // ADR 0142 decision 1: one owner per (channel, start). The same owner again is ignored; a second owner discards both records after the stream.
 const claimSlot=(channelId,startAt,owner,title,channel)=>{const slot=channelId+':'+startAt,held=slotOwners.get(slot);if(held===undefined){slotOwners.set(slot,owner);return 'new';}if(held===owner)return 'same';if(!conflictedSlots.has(slot))conflictedSlots.set(slot,{title,channel,start:startAt,reason:'duplicate_slot'});return 'conflict';};
 try{while(true){const {done,value}=await reader.read();if(done){buffer+=decoder.decode();break;}bytes+=value.length;if(bytes>400000000)throw new Error('EPG exceeds supported size');buffer+=decoder.decode(value,{stream:true});
 while(true){const start=buffer.search(/<(?:channel|programme)\s/);if(start<0){if(buffer.includes('</tv>'))complete=true;buffer=buffer.slice(-1000);break;}if(start>0)buffer=buffer.slice(start);const type=buffer.startsWith('<channel ')?'channel':'programme',end=buffer.indexOf('</'+type+'>');if(end<0){if(buffer.length>1000000)throw new Error('EPG record exceeds limit');break;}const xml=buffer.slice(0,end+type.length+3);buffer=buffer.slice(end+type.length+3);
 if(type==='channel'){channels.set(attr(xml,'id'),field(xml,'display-name'));declared.set(attr(xml,'id'),field(xml,'display-name'));continue;}
 if(!boundaryDone){boundaryDone=true;boundaryDeclared=new Set(declared.keys());if(policies&&!degraded&&typeof options.onDeclarations==='function'){const absent=[...declared].filter(([id,name])=>typeof id==='string'&&id&&!/^[A-Z]{2}:/.test(name||'')&&!policies.has(id)).map(([channelId,name])=>({channelId,name:name||channelId}));try{await options.onDeclarations({channels:absent});}catch{/* best effort: registration never fails the scan */}}}
 scanned++;const startAt=xmlTime(attr(xml,'start')),endAt=xmlTime(attr(xml,'stop'));if(!Number.isFinite(startAt)||!Number.isFinite(endAt)||endAt<=startAt)continue;min=Math.min(min,startAt);max=Math.max(max,startAt);const channelId=attr(xml,'channel'),channel=channels.get(channelId)||channelId;if(/^[A-Z]{2}:/.test(channel))continue;const c=coverage.get(channelId)||{name:channel,min:startAt,max:endAt};c.min=Math.min(c.min,startAt);c.max=Math.max(c.max,endAt);coverage.set(channelId,c);
 // Retention/display horizon (7 days) is separate from the hot processing horizon (24 hours): days 2-7 keep only shows that match a
 // reliable non-catalog watchlist film. Discovery, uncertain matches and the raw candidate counts never see them.
 if(startAt<now-72*3600000||startAt>=now+EPG_RETAIN_FUTURE_MS)continue;
 let channelPolicy='discover';
 if(policies){policyCounts.inWindow++;const found=policies.get(channelId)||UNKNOWN_POLICY;channelPolicy=found.policy;if(!degraded&&(found.basis==='unknown'||found.basis==='unclassified'))policyCounts.unclassified++;if(channelPolicy==='deny_all'){policyCounts.filteredDenyAll++;continue;}if(channelPolicy==='discover')policyCounts.discoveryEligible++;}
 const title=field(xml,'title'),parts=epgTitleParts(title),titleYear=parts.year,key=parts.normalizedTitle,candidates=index.get(key)||[];const duration=(endAt-startAt)/60000;
 let decision=knownSlotDecision(candidates,titleYear,duration);
 if(decision.films.length===1&&decision.films[0].catalogOnly&&!movieTitleKeys(decision.films[0]).has(key))decision={films:[],reason:'alias_without_movie_provenance'};
 const valid=decision.films;
 if(startAt>=now+EPG_HOT_FUTURE_MS&&(valid.length!==1||valid[0]?.catalogOnly))continue;
 // ADR 0142 decision 1 holds whatever the policy admits: a skipped record on a known_only channel still claims its slot for the owner the discover path would use (same non-film and shape rules),
 // so a competing known Film on the same (channel, start) conflicts and both are discarded after the stream. The record itself never becomes a candidate.
 if(channelPolicy==='known_only'&&valid.length!==1){policyCounts.skippedKnownOnly++;if(!nonFilmEPGReason(title,xml)&&(candidates.length||!serialEpisodeReason(title,serialGuard))&&duration>=55&&duration<=300&&key&&key.length>=3&&key.length<=160)claimSlot(channelId,startAt,'o:'+key+'|'+(titleYear||''),title,channel);continue;}
 kept++;
 // A single reliable watchlist/catalog match is a known Film and is never screened out by its title.
 if(startAt<now+EPG_HOT_FUTURE_MS&&duration>=55&&duration<=300)rawDiscovery.add(key+'|'+(titleYear||''));const screenReason=valid.length!==1?nonFilmEPGReason(title,xml):null,serialReason=valid.length!==1&&!screenReason&&!candidates.length?serialEpisodeReason(title,serialGuard):null;if(screenReason||serialReason){if(duration>=55&&duration<=300){filteredNonMovies.add(key+'|'+(titleYear||''));if(serialReason){if(!serialFiltered.has(serialReason))serialFiltered.set(serialReason,new Set());serialFiltered.get(serialReason).add(key+'|'+(titleYear||''));}}continue;}
 if(valid.length!==1||valid[0]?.catalogOnly){if(candidates.length){if(decision.reason==='identity_collision')identityCollision++;uncertain.set(`${channelId}:${startAt}`,{title,channel,start:startAt,reason:decision.reason||(valid.length>1?'ambiguous':'insufficient_year_or_duration')});}if(duration>=55&&duration<=300&&key&&key.length>=3&&key.length<=160){const discoveryKey=key+'|'+(titleYear||''),previous=discovery.get(discoveryKey),description=field(xml,'desc'),categories=xmltvCategories(xml);if(claimSlot(channelId,startAt,'o:'+discoveryKey,title,channel)!=='new')continue;const dashStem=candidates.length?null:serialDashStem(title);if(dashStem)dashInfo.set(discoveryKey,{stem:dashStem,maxMinutes:Math.max(dashInfo.get(discoveryKey)?.maxMinutes??0,duration)});const shown={channelId,channel,start:startAt,end:endAt,epgTitle:title};showMeta.set(shown,{title:parts.title,description:description&&description!=='Нет описания'?description.slice(0,700):null,confirmedTmdbId:valid.length===1&&valid[0].catalogOnly?String(valid[0].tmdbId):null,categories});if(previous){previous.shows.push(shown);previous.airings++;previous.lastAiring=Math.max(previous.lastAiring,startAt);if(!previous.description&&description&&description!=='Нет описания')previous.description=description.slice(0,700);if(title!==previous.title&&!previous.rawTitles.includes(title)&&previous.rawTitles.length<8)previous.rawTitles.push(title);if(categories.length)previous.categories=[...new Set([...(previous.categories||[]),...categories])].slice(0,8);}else discovery.set(discoveryKey,{key:discoveryKey,confirmedTmdbId:valid.length===1&&valid[0].catalogOnly?String(valid[0].tmdbId):null,title:parts.title,rawTitles:[title],normalizedTitle:key,year:titleYear,duration:Math.round(duration),description:description&&description!=='Нет описания'?description.slice(0,700):null,categories,firstAiring:startAt,lastAiring:startAt,airings:1,shows:[shown]});}continue;}
 const f=valid[0];if(claimSlot(channelId,startAt,'f:'+f.id,title,channel)!=='new')continue;if(!matched.has(f.id))matched.set(f.id,{...f,title:/[а-яё]/i.test(title)?cleanTitle(title):f.original,shows:[]});if(!/[а-яё]/i.test(matched.get(f.id).title)&&/[а-яё]/i.test(title))matched.get(f.id).title=cleanTitle(title);const hint=showMatchBasis(titleYear,{key,title:parts.title,normalizedTitle:key,year:titleYear,duration:Math.round(duration),durations:[Math.round(duration)]},candidates.filter(film=>film?.tmdbId).map(film=>({tmdbId:film.tmdbId,title:film.title,original:film.original,aliases:film.aliases,year:film.year,runtime:film.runtime,trusted:film.canonicalIdentity==='tmdb:'+film.tmdbId})));matched.get(f.id).shows.push({channelId,channel,start:startAt,end:endAt,epgTitle:title,basis:hint.basis,matchReason:hint.hint?hint.reason:null});
 }
 }
 }finally{reader.releaseLock();}
 complete=complete||buffer.includes('</tv>');if(!complete||scanned===0)throw new Error('EPG incomplete: closing tv tag or programmes missing');
 if(conflictedSlots.size){const contested=show=>conflictedSlots.has(show.channelId+':'+show.start);
  for(const [id,film] of matched){film.shows=film.shows.filter(show=>!contested(show));if(!film.shows.length)matched.delete(id);}
  for(const [key,candidate] of discovery){const before=candidate.shows.length;candidate.shows=candidate.shows.filter(show=>!contested(show));if(!candidate.shows.length){discovery.delete(key);continue;}if(candidate.shows.length===before)continue;
   // The identity evidence of the observation (duration, title forms, description, confirmed TMDB id) must come from slots that remain, in feed order, as when the candidate was first built.
   const [first]=candidate.shows,metas=candidate.shows.map(show=>showMeta.get(show));
   candidate.airings=candidate.shows.length;candidate.firstAiring=first.start;candidate.lastAiring=Math.max(...candidate.shows.map(show=>show.start));
   candidate.duration=Math.round((first.end-first.start)/60000);candidate.title=metas[0].title;candidate.rawTitles=[...new Set(candidate.shows.map(show=>show.epgTitle))].slice(0,8);
   candidate.description=metas.find(meta=>meta.description)?.description||null;applySlotConfirmation(candidate,metas);
   candidate.categories=[...new Set(metas.flatMap(meta=>meta.categories||[]))].slice(0,8);}
  }
 for(const candidate of discovery.values())applySlotConfirmation(candidate,candidate.shows.map(show=>showMeta.get(show)));
 // "<Title> S-EE": only a stem that repeats in this very scan, with a placeholder description and a short valid duration (serialDashEpisodes), leaves discovery.
 for(const key of serialDashEpisodes(dashInfo,discovery)){discovery.delete(key);filteredNonMovies.add(key);if(!serialFiltered.has('dash_season_episode'))serialFiltered.set('dash_season_episode',new Set());serialFiltered.get('dash_season_episode').add(key);}
 const policyChannels=policies?channelPolicyCounts(coverage,declared,policies,degraded,boundaryDeclared):{channels:null,newChannels:[],lateDeclared:0};
 return {films:[...matched.values()],coverage:[...coverage.values()],discovery:[...discovery.values()],stats:{scanned,retained:kept,epgStart:min,epgEnd:max,bytes,uncertain:uncertain.size,identityCollision,duplicate_slot:conflictedSlots.size,discoveryCandidates:discovery.size,rawCandidates:rawDiscovery.size,filteredNonMovies:filteredNonMovies.size,serialFiltered:Object.fromEntries([...serialFiltered].map(([reason,keys])=>[reason,keys.size])),policyMode:mode,...(policies?{policy:{applied:true,mode,...policyCounts,lateDeclared:policyChannels.lateDeclared,channels:policyChannels.channels}}:{})},newChannels:policyChannels.newChannels,uncertain:[...uncertain.values(),...conflictedSlots.values()].slice(0,100)};
}

// Per-channel counters by effective policy over the channels the feed DECLARES (<channel>) plus any channel it schedules without a declaration. `new` = a declared id the pinned
// snapshot does not hold (registered after the scan, by id, never by name); `undeclared` = a scheduled id no <channel> declares: it is classified like any unknown id (`known_only`) but is
// not trusted for registration. `unclassified` = no category and no override. A declared channel whose display name is a country-prefixed feed label (`XX:`) is skipped, as its programmes are.
function channelPolicyCounts(coverage,declared,policies,degraded,boundaryDeclared){
 const counts={channels:{total:0,discover:0,denyAll:0,knownOnly:0,new:0,unclassified:0,undeclared:0},newChannels:[],lateDeclared:0};
 const ids=new Map();
 for(const [channelId,name] of declared){if(typeof channelId!=='string'||!channelId||/^[A-Z]{2}:/.test(name||''))continue;ids.set(channelId,{name:name||channelId,declared:true});}
 for(const [channelId,item] of coverage)if(!ids.has(channelId))ids.set(channelId,{name:item.name,declared:false});
 let lateDeclared=0;
 for(const [channelId,item] of ids){const found=policies.get(channelId)||{policy:'known_only',basis:'unknown'};if(degraded){counts.channels.total++;counts.channels.knownOnly++;if(!item.declared)counts.channels.undeclared++;continue;}counts.channels.total++;if(found.policy==='discover')counts.channels.discover++;else if(found.policy==='deny_all')counts.channels.denyAll++;else counts.channels.knownOnly++;if(!item.declared)counts.channels.undeclared++;if(found.basis==='unknown'&&item.declared){counts.channels.new++;counts.newChannels.push({channelId,name:item.name});if(boundaryDeclared&&!boundaryDeclared.has(channelId))lateDeclared++;}if(found.basis==='unknown'||found.basis==='unclassified')counts.channels.unclassified++;}
 counts.lateDeclared=lateDeclared;
 return counts;
}
// AIR-604: the shared upstream cooldown coordinator of one caller run, or null where the cooldown module is not in scope (a test that loads a single file). Null is today's behaviour.
function upstreamCoordinator(env,caller){return typeof UpstreamCooldown==='undefined'?null:UpstreamCooldown.createCoordinator(env,{caller});}
// AIR-604 (ADR 0211 decision 5): one Wikidata request through the shared cooldown. `coordination` is a coordinator or null; null (and the `off` mode) sends exactly the request of today.
// An enforced cooldown skips the request: the answer is null, and the caller stops asking Wikidata in its step without counting an error (the skip is `coordination.stats.skipped`).
// The run's evidence of the shared cooldown (ADR 0211 decision 5, UC2): the four bounded counters of the coordinators the run used, added to `run.upstreamCooldown`. Nothing when all are zero.
function recordUpstreamEvidence(run,...coordinators){
 const total={skipped:0,wouldSkip:0,written:0,writeFailed:0};
 for(const c of coordinators)if(c){const s=c.snapshot();for(const k of Object.keys(total))total[k]+=s[k];}
 if(!Object.values(total).some(Boolean))return;
 const old=run.upstreamCooldown||{};for(const k of Object.keys(total))total[k]+=Number.isInteger(old[k])?old[k]:0;
 run.upstreamCooldown=total;
}
async function wikidataRequest(coordination,url,init){
 if(!coordination)return fetch(url,init);
 try{return await coordination.fetch(fetch,url,init,{scope:'wikidata'});}catch(error){if(error?.code==='upstream_cooldown')return null;throw error;}
}
async function loadPeopleNameIndex(films,coordination=null){
 const ids=[...new Set(films.map(f=>f.tmdbId).filter(id=>/^\d+$/.test(id)))];
 if(!ids.length)return null;
 const query=`SELECT ?tmdb ?en ?ru WHERE { VALUES ?tmdb { ${ids.map(x=>JSON.stringify(x)).join(' ')} } ?film wdt:P4947 ?tmdb; (wdt:P161|wdt:P57|wdt:P725) ?person. ?person (rdfs:label|skos:altLabel) ?en; rdfs:label ?ru. FILTER(LANG(?en)="en" && LANG(?ru)="ru") }`;
 const response=await wikidataRequest(coordination,'https://query.wikidata.org/sparql?'+new URLSearchParams({query,format:'json'}),{headers:{'Accept':'application/sparql-results+json','User-Agent':'WatchlistAirtime/1.0 (personal film programme)'},signal:AbortSignal.timeout(45000)});
 if(!response)return null;
 if(!response.ok)throw new Error('Russian names HTTP '+response.status);
 const data=await response.json();const index=new Map();
 for(const row of data.results.bindings){const key=row.tmdb.value+':'+norm(row.en.value);const names=index.get(key)||new Set();names.add(row.ru.value);index.set(key,names);}
 return index;
}
function applyPeopleNames(films,cache,index,mode){for(const f of films)for(const p of [...f.directors,...f.actors]){if(REVIEWED_PEOPLE[p.id]){applyReviewedPerson(p,mode==='on'?'on':'off');cache[p.id]={...p};continue;}if(index){const names=index.get(f.tmdbId+':'+norm(p.original));if(names?.size===1){const raw=[...names][0];const name=raw.includes(', ')?raw.split(', ').reverse().join(' '):raw;cache[p.id]={name,original:p.original};}}if(!cache[p.id])continue;if(mode==='on')applyCachedPersonName(p,cache[p.id],'on');else p.name=cache[p.id].name;}}
async function localizePeople(films,cache,mode,coordination=null){
 if(mode==='on'||mode==='shadow'){const index=await loadPeopleNameIndex(films,coordination);return branchState(films,cache,mode,(list,store)=>applyPeopleNames(list,store,index,'off'),(list,store)=>applyPeopleNames(list,store,index,'on'));}
 for(const f of films)for(const p of [...f.directors,...f.actors])if(REVIEWED_PEOPLE[p.id]){applyReviewedPerson(p);cache[p.id]={...p};}
 const index=await loadPeopleNameIndex(films,coordination);
 if(!index)return {compared:0,mismatched:0};
 for(const f of films)for(const p of [...f.directors,...f.actors]){if(REVIEWED_PEOPLE[p.id]){applyReviewedPerson(p);continue;}const names=index.get(f.tmdbId+':'+norm(p.original));if(names?.size===1){const raw=[...names][0];const name=raw.includes(', ')?raw.split(', ').reverse().join(' '):raw;cache[p.id]={name,original:p.original};}if(cache[p.id])p.name=cache[p.id].name;}
 return {compared:0,mismatched:0};
}
function peopleCatalog(films){const collect=key=>[...new Map(films.flatMap(f=>f[key]||[]).map(p=>[p.id,p])).values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'));return {directors:collect('directors'),actors:collect('actors')};}
async function localizeByLetterboxd(films,cache,coordination=null){
 const missing=[...new Map(films.flatMap(f=>[...(f.directors||[]),...(f.actors||[])]).filter(p=>!cache[p.id]&&!REVIEWED_PEOPLE[p.id]).map(p=>[p.id,p])).values()];
 for(let offset=0;offset<missing.length;offset+=80){
  const batch=missing.slice(offset,offset+80);const slugs=[...new Set(batch.map(p=>p.id.split('/')[1]).filter(s=>/^[a-z0-9-]+$/.test(s)))];if(!slugs.length)continue;
  const query=`SELECT ?slug ?ru WHERE { VALUES ?slug { ${slugs.map(s=>JSON.stringify(s)).join(' ')} } ?person (wdt:P6119|wdt:P12383) ?slug; rdfs:label ?ru. FILTER(LANG(?ru)="ru") }`;
  const response=await wikidataRequest(coordination,'https://query.wikidata.org/sparql?'+new URLSearchParams({query,format:'json'}),{headers:{'Accept':'application/sparql-results+json','User-Agent':'WatchlistAirtime/1.0'},signal:AbortSignal.timeout(15000)});
  if(!response)break;
  if(!response.ok)continue;const data=await response.json();const labels=new Map();for(const r of data.results.bindings){const names=labels.get(r.slug.value)||new Set();names.add(r.ru.value);labels.set(r.slug.value,names);}
  for(const p of batch){const names=labels.get(p.id.split('/')[1]);if(names?.size===1){const raw=[...names][0];cache[p.id]={name:raw.includes(', ')?raw.split(', ').reverse().join(' '):raw,original:p.original};}}
 }
}

// Stable Letterboxd IDs take precedence over name-only or external matches.
const REVIEWED_PEOPLE=Object.fromEntries((typeof PERSON_NAME_DICTIONARY==='undefined'?[]:PERSON_NAME_DICTIONARY).map(p=>[p.id,{name:p.name,aliases:p.aliases,nameStatus:p.status,nameVerificationBasis:p.verification_basis,nameSource:p.source_url}]));
REVIEWED_PEOPLE['actor/chris-pratt']={name:'Крис Прэтт',aliases:['Крис Пратт'],nameStatus:'verified',nameSource:'https://ru.wikipedia.org/wiki/Прэтт,_Крис'};
function legacyLocalizationStatus(status){if(status==='verified'||status==='reviewed')return 'reviewed';if(status==='provisional')return 'provisional';return 'missing';}
function localizationEntity(status,value,source){const kind=legacyLocalizationStatus(status);return {localization:dimensionState('localization',{status:kind,updatedAt:null,source:kind==='missing'?null:source,value:kind==='missing'?null:value||null,nextAction:kind==='reviewed'?'keep_reviewed':kind==='provisional'?'keep_provisional':'none'}),aliases:[]};}
function titleEntity(film){return localizationEntity(film.titleStatus,film.titleRu||film.title,film.titleStatus==='verified'?'dictionary':'wikidata');}
function personEntity(person){return localizationEntity(person.nameStatus,person.name,person.nameStatus?'dictionary':'wikidata');}
function aliasValues(entity){return (entity?.aliases||[]).map(item=>item&&item.value).filter(Boolean);}
function uniqueStrings(values){return [...new Set(values.filter(Boolean))];}
function rememberLocalizationConflict(list,entry){const conflicts=list||[];if(conflicts.some(item=>item.value===entry.value&&item.reason===entry.reason))return conflicts;return [...conflicts,entry];}
// LIFECYCLE_LOCALIZATION gates the metadata sync alone and is default-off there: on:metadata selects the domain
// localization, shadow:metadata runs it beside the legacy one for the comparison counts, the last of the two wins.
// Every other token is ignored, including the retired on:epg, on:programme and on:watchlist: the EPG commit and the
// programme and watchlist reads always run the domain localization (presentLocalized, applyEpgLocalization).
function metadataLocalizationMode(env){const raw=typeof env?.LIFECYCLE_LOCALIZATION==='string'?env.LIFECYCLE_LOCALIZATION:'';let selected='off';for(const token of raw.split(',')){const [kind,which]=token.trim().split(':');if((kind==='on'||kind==='shadow')&&which==='metadata')selected=kind;}return selected;}
function restoreObject(target,source){for(const key of Object.keys(target))if(!Object.hasOwn(source,key))delete target[key];Object.assign(target,structuredClone(source));}
function restoreFilms(live,snapshot){for(let i=0;i<snapshot.length;i++)restoreObject(live[i],snapshot[i]);}
function restoreCache(cache,snapshot){for(const key of Object.keys(cache))delete cache[key];Object.assign(cache,structuredClone(snapshot));}
function sameJson(left,right){return JSON.stringify(left??null)===JSON.stringify(right??null);}
function peopleOn(film){return [...(film?.directors||[]),...(film?.actors||[])];}
function filmWithoutPeople(film){if(!film)return null;const {actors,directors,...rest}=film;return rest;}
function displayedTitle(film){return film?.titleRu||film?.title||null;}
function displayedName(person){return person?.name||null;}
function zeroCounts(){return {films:{compared:0,mismatched:0,displayed:0},people:{compared:0,mismatched:0,displayed:0},cache:{compared:0,mismatched:0}};}
function comparePeople(left,right){const n=Math.max(left.length,right.length);let mismatched=0,displayed=0;for(let i=0;i<n;i++){if(!sameJson(left[i],right[i]))mismatched++;if(displayedName(left[i])!==displayedName(right[i]))displayed++;}return {compared:n,mismatched,displayed};}
function compareFilms(left,right){const films={compared:Math.max(left?.length||0,right?.length||0),mismatched:0,displayed:0};const people={compared:0,mismatched:0,displayed:0};for(let i=0;i<films.compared;i++){if(!sameJson(filmWithoutPeople(left?.[i]),filmWithoutPeople(right?.[i])))films.mismatched++;if(displayedTitle(left?.[i])!==displayedTitle(right?.[i]))films.displayed++;const names=comparePeople(peopleOn(left?.[i]),peopleOn(right?.[i]));people.compared+=names.compared;people.mismatched+=names.mismatched;people.displayed+=names.displayed;}return {films,people};}
function compareCache(left,right){const keys=new Set([...Object.keys(left||{}),...Object.keys(right||{})]);let mismatched=0;for(const key of keys)if(!sameJson(left?.[key],right?.[key]))mismatched++;return {compared:keys.size,mismatched};}
function localizationCounts(legacyFilms,domainFilms,legacyCache,domainCache,legacyPeople=[],domainPeople=[]){const counted=compareFilms(legacyFilms,domainFilms);const extra=comparePeople(legacyPeople,domainPeople);counted.people.compared+=extra.compared;counted.people.mismatched+=extra.mismatched;counted.people.displayed+=extra.displayed;return {films:counted.films,people:counted.people,cache:compareCache(legacyCache,domainCache)};}
function visitedCounts(films,cache){const counts=zeroCounts();counts.films.compared=(films||[]).length;for(const film of films||[])counts.people.compared+=peopleOn(film).length;counts.cache.compared=Object.keys(cache||{}).length;return counts;}
function branchState(films,cache,mode,legacy,domain){if(mode!=='on'&&mode!=='shadow'){legacy(films,cache);return zeroCounts();}if(mode==='on'){domain(films,cache);return visitedCounts(films,cache);}const legacyFilms=structuredClone(films),domainFilms=structuredClone(films),legacyCache=structuredClone(cache),domainCache=structuredClone(cache);legacy(legacyFilms,legacyCache);domain(domainFilms,domainCache);const counts=localizationCounts(legacyFilms,domainFilms,legacyCache,domainCache);restoreFilms(films,legacyFilms);restoreCache(cache,legacyCache);return counts;}
function titleProvenance(film,match){const value=legacyLocalizationStatus(film.titleStatus)==='reviewed'?(film.titleRu||film.title||null):null;if(!value||value===match.title)return 'apply';if(film.titleAuthority==='owner')return 'owner';if(film.titleAuthority==='dictionary')return 'dictionary';if(Array.isArray(film.titleSources)&&film.titleSources.length&&sameJson(film.titleSources,match.sources))return 'dictionary';return 'unknown';}
function personProvenance(person,match){if(legacyLocalizationStatus(person.nameStatus)!=='reviewed'||!person.name||person.name===match.name)return 'apply';if(person.nameAuthority==='owner')return 'owner';if(person.nameAuthority==='dictionary')return 'dictionary';const basis=match.nameVerificationBasis||match.verification_basis||null,source=match.nameSource??match.source??null;if((person.nameVerificationBasis||person.nameSource)&&(person.nameVerificationBasis??null)===(basis??null)&&(person.nameSource??null)===(source??null))return 'dictionary';return 'unknown';}
function applyReviewedPersonLegacy(p){const match=REVIEWED_PEOPLE[p.id];if(!match)return p;const aliases=uniqueStrings([...(p.aliases||[]),...(match.aliases||[]),p.original,p.name].filter(n=>n!==match.name));Object.assign(p,match,{aliases});return p;}
function applyReviewedPersonDomain(p){const match=REVIEWED_PEOPLE[p.id];if(!match)return p;const reviewed=match.nameStatus==='verified'||match.status==='verified';const provenance=reviewed?personProvenance(p,match):'apply';if(provenance==='owner'||provenance==='unknown'){p.aliases=uniqueStrings([...(p.aliases||[]),...(match.aliases||[]),p.original,p.name,match.name].filter(n=>n!==p.name));p.nameConflicts=rememberLocalizationConflict(p.nameConflicts,{value:match.name,source:'dictionary',reason:provenance==='owner'?'owner_kept':'unresolved',authority:provenance==='owner'?'owner':'unknown'});return p;}const incoming={authority:'dictionary',status:reviewed?'reviewed':'provisional',value:match.name,source:match.nameSource||match.source||'dictionary',sourceVersion:match.nameVerificationBasis||match.verification_basis||(reviewed?'verified':'provisional'),provenance:{sources:match.nameSource?[match.nameSource]:match.sources||null}};const entity=reviewed?applyReviewedLocalization(personEntity(p),incoming,null,'name'):applyAutomaticLocalization(personEntity(p),incoming,null,'name');if(entity.localization.status==='reviewed'&&!reviewed){p.aliases=uniqueStrings([...(p.aliases||[]),...aliasValues(entity)]);return p;}if(reviewed&&entity.localization.status!=='reviewed')return p;const aliases=uniqueStrings([...(p.aliases||[]),...(match.aliases||[]),...aliasValues(entity),p.original,p.name].filter(n=>n!==match.name));Object.assign(p,match,{aliases,name:entity.localization.value||match.name});return p;}
function applyReviewedPerson(p,mode){return mode==='on'?applyReviewedPersonDomain(p):applyReviewedPersonLegacy(p);}
function applyCachedPersonNameLegacy(person,cached){if(cached?.name)person.name=cached.name;return person;}
function applyCachedPersonNameDomain(person,cached){if(!cached?.name)return person;const entity=applyAutomaticLocalization(personEntity(person),{status:'provisional',value:cached.name,source:'wikidata',sourceVersion:'provisional',provenance:{value:cached.name}},null,'name');if(legacyLocalizationStatus(person.nameStatus)==='reviewed'||entity.localization.status==='reviewed'||!entity.localization.value){const extra=uniqueStrings([...aliasValues(entity),cached.name].filter(value=>value!==person.name));if(extra.length)person.aliases=uniqueStrings([...(person.aliases||[]),...extra]);return person;}const previous=person.name&&person.name!==entity.localization.value?[person.name]:[];person.aliases=uniqueStrings([...(person.aliases||[]),...aliasValues(entity),...previous]);person.name=entity.localization.value;person.nameStatus='provisional';person.nameSource='wikidata';return person;}
function applyCachedPersonName(person,cached,mode){return mode==='on'?applyCachedPersonNameDomain(person,cached):applyCachedPersonNameLegacy(person,cached);}
function reviewedPeople(data,mode){if(!data)return data;const selected=mode==='on'?'on':'off';for(const film of data.films||[])applyReviewedTitle(film,selected);for(const f of data.films||[])for(const key of ['actors','directors'])for(const p of f[key]||[])applyReviewedPerson(p,selected);for(const key of ['actors','directors']){for(const p of data.people?.[key]||[])applyReviewedPerson(p,selected);data.people?.[key]?.sort((a,b)=>a.name.localeCompare(b.name,'ru'));}return data;}

function availabilityDeadline(film){
 const starts=(film.shows||[]).map(show=>Number(show.start)).filter(Number.isFinite);
 return starts.length?new Date(Math.max(...starts)+72*3600000).toISOString():null;
}
function withAvailability(film){return {...film,availableUntil:availabilityDeadline(film)};}
function programmeWithWatchlist(report,watchlist){
 // ADR 0186 (AIR-569): a composed document carries its snapshot; equal lengths are then never equal membership (a 1-for-1 replacement keeps the count).
 if(!watchlist?.snapshot&&report.films.length===report.watchlistCount||!watchlist?.films){for(const film of report.films)film.availableUntil=availabilityDeadline(film);return withholdPolicyExcludedProgrammeFilms(report);}
 const scheduled=new Map(report.films.map(f=>[String(f.id),f]));
 // ADR 0186 review: a composed member that is new to the programme keeps the shows its composition joined from a stored confirmed slot; they are not overwritten by an empty list.
 const films=watchlist.films.map(f=>withAvailability({...f,...scheduled.get(String(f.id)),shows:scheduled.get(String(f.id))?.shows||f.shows||[]}));
 return withholdPolicyExcludedProgrammeFilms({...report,films,people:peopleCatalog(films)});
}
function withholdPolicyExcludedProgrammeFilms(report){
 if(!report||typeof policyExcludedPresentedFilm!=='function')return report;
 const films=(report.films||[]).filter(film=>!policyExcludedPresentedFilm(film));
 if(films.length===(report.films||[]).length)return report;
 const next={...report,films};
 if(report.people)next.people=peopleCatalog(films);
 return next;
}

// ADR 0142 decision 11 (presentation). `report.catalogFilms` are identity-only entries of the completed read. Film data comes from the current catalog record of the same TMDB id; an
// entry without such a record is not presented as a Film and is counted. A catalog that could not be read (`catalog` null) never touches `films`: the part is stated as unavailable.
function presentCatalogFilms(report,catalog){
 const entries=Array.isArray(report?.catalogFilms)?report.catalogFilms:[];
 if(!entries.length){const {catalogFilms,...rest}=report||{};return rest;}
 if(!catalog||typeof catalog!=='object'||Array.isArray(catalog))return {...report,catalogFilms:[],catalogPart:{state:'unavailable',entries:entries.length}};
 const records=new Map(Object.values(catalog).filter(item=>item&&typeof item==='object'&&item.tmdbId!=null&&item.canonicalIdentity==='tmdb:'+item.tmdbId).map(item=>[String(item.tmdbId),item]));
 const films=[];let unpresented=0;
 for(const entry of entries){
  const record=entry.tmdbId==null?null:records.get(String(entry.tmdbId));
  if(!record||entry.canonicalIdentity!=='tmdb:'+record.tmdbId){unpresented++;continue;}
  const data={...record};for(const field of CATALOG_AVAILABILITY_FIELDS)delete data[field];
  if(typeof policyExcludedPresentedFilm==='function'&&policyExcludedPresentedFilm(data)){unpresented++;continue;}
  const shows=entry.shows||[];
  films.push({...data,id:entry.id,tmdbId:String(record.tmdbId),canonicalIdentity:entry.canonicalIdentity,shows,availableUntil:shows.length?availabilityDeadline({shows}):null,onWatchlist:false});
 }
 return {...report,catalogFilms:films,catalogPart:{state:'ok',entries:entries.length,presented:films.length,unpresented}};
}

// Canonical titles are independent of EPG presence and language. Match stable IDs only.
const REVIEWED_TITLES=new Map((typeof FILM_TITLE_DICTIONARY==='undefined'?[]:FILM_TITLE_DICTIONARY).map(f=>[String(f.id),f]));
function reviewedTitle(film){const match=REVIEWED_TITLES.get(String(film.id));return match&&(!film.tmdbId||!match.tmdbId||String(film.tmdbId)===String(match.tmdbId))?match:null;}
function applyReviewedTitleLegacy(film){const match=reviewedTitle(film);if(!match)return film;film.aliases=uniqueStrings([...(film.aliases||[]),...(match.aliases||[]),film.title,film.original,match.title]);film.title=match.title;film.titleRu=match.title;film.titleStatus=match.status;film.titleSources=match.sources;return film;}
function applyReviewedTitleDomain(film){const match=reviewedTitle(film);if(!match)return film;if(film.titleAuthority==='owner'&&legacyLocalizationStatus(film.titleStatus)==='reviewed'&&(film.titleRu||film.title)){if((film.titleRu||film.title)!==match.title){film.aliases=uniqueStrings([...(film.aliases||[]),...(match.aliases||[]),film.title,film.original,match.title]);film.titleConflicts=rememberLocalizationConflict(film.titleConflicts,{value:match.title,source:'dictionary',reason:'owner_kept',authority:'owner'});}return film;}const provenance=titleProvenance(film,match);if(provenance==='owner'||provenance==='unknown'){film.aliases=uniqueStrings([...(film.aliases||[]),...(match.aliases||[]),film.title,film.original,match.title]);film.titleConflicts=rememberLocalizationConflict(film.titleConflicts,{value:match.title,source:'dictionary',reason:provenance==='owner'?'owner_kept':'unresolved',authority:provenance==='owner'?'owner':'unknown'});return film;}const entity=applyReviewedLocalization(titleEntity(film),{authority:'dictionary',value:match.title,source:(match.sources&&match.sources[0])||'dictionary',provenance:{sources:match.sources||[]}},null,'title');if(entity.localization.status!=='reviewed'||!entity.localization.value)return film;film.aliases=uniqueStrings([...(film.aliases||[]),...(match.aliases||[]),...aliasValues(entity),film.title,film.original,match.title]);film.title=entity.localization.value;film.titleRu=entity.localization.value;film.titleStatus=match.status;film.titleSources=match.sources;return film;}
function applyReviewedTitle(film,mode){return mode==='on'?applyReviewedTitleDomain(film):applyReviewedTitleLegacy(film);}
function applyCachedTitleLegacy(film,cached){if(!cached?.title||!cached.tmdbId||cached.tmdbId!==film.tmdbId)return film;film.aliases=uniqueStrings([...(film.aliases||[]),film.original,film.title,cached.title]);film.title=cached.title;film.titleRu=cached.title;film.titleStatus=cached.status;film.titleSources=cached.sources;return film;}
function applyCachedTitleDomain(film,cached){if(!cached?.title||!cached.tmdbId||cached.tmdbId!==film.tmdbId)return film;const entity=applyAutomaticLocalization(titleEntity(film),{status:'provisional',value:cached.title,source:'wikidata',sourceVersion:'provisional',provenance:{sources:cached.sources||null}},null,'title');if(entity.localization.status==='reviewed'||entity.localization.status!=='provisional'||!entity.localization.value){const extra=uniqueStrings([...aliasValues(entity),cached.title].filter(value=>value!==film.title&&value!==film.titleRu));if(extra.length)film.aliases=uniqueStrings([...(film.aliases||[]),...extra]);return film;}film.aliases=uniqueStrings([...(film.aliases||[]),...aliasValues(entity),film.original,film.title,cached.title]);film.title=entity.localization.value;film.titleRu=entity.localization.value;film.titleStatus='provisional';film.titleSources=cached.sources;return film;}
function applyCachedTitle(film,cached,mode){return mode==='on'?applyCachedTitleDomain(film,cached):applyCachedTitleLegacy(film,cached);}
// The programme and watchlist reads: the domain localization rule, always. A cached automatic title is applied through
// the guarded transition (a reviewed title is never downgraded), reviewed titles and names win and keep their conflicts.
function applyOwnerReviewedTitles(data,reviews){const films=reviews&&typeof reviews==='object'&&!Array.isArray(reviews)?reviews.films:null;if(!films||typeof films!=='object'||Array.isArray(films))return data;for(const film of data?.films||[]){const entry=films[String(film.id)];if(!entry)continue;const localization=entry.localization;const value=localization&&localization.status==='reviewed'&&localization.provenance&&localization.provenance.authority==='owner'?localization.value:null;const extra=(entry.aliases||[]).map(alias=>alias&&alias.value).filter(Boolean);if(value){const kept=extra.filter(alias=>alias!==value);film.aliases=uniqueStrings([...(film.aliases||[]),film.title,film.titleRu,film.original,...kept].filter(alias=>alias&&alias!==value));film.title=value;film.titleRu=value;film.titleStatus='reviewed';film.titleAuthority='owner';film.titleSources=['owner'];}else if(extra.length){film.aliases=uniqueStrings([...(film.aliases||[]),...extra]);}}return data;}
function ownerPersonNameMap(store){if(!store||store.contractVersion!==1||!store.people||typeof store.people!=='object'||Array.isArray(store.people))return null;return store.people;}
function ownerReviewedPerson(store,roleId){const map=ownerPersonNameMap(store);if(!map||typeof roleId!=='string')return null;const record=map['person:'+roleId]||null;if(record?.localization?.status==='reviewed'&&record.localization.provenance?.authority==='owner'&&record.localization.value)return record;return null;}
function applyOwnerReviewedPerson(person,store){const record=ownerReviewedPerson(store,person?.id);if(!record)return person;const name=record.localization.value;const previous=[person.name,person.original,...(person.aliases||[]),...(record.aliases||[]).map(alias=>alias?.value)].filter(value=>value&&value!==name);person.name=name;person.nameStatus='reviewed';person.nameAuthority='owner';person.nameSource='owner';person.aliases=uniqueStrings(previous);return person;}
function applyOwnerPersonAliases(person,store){if(!person||ownerReviewedPerson(store,person.id))return person;const map=ownerPersonNameMap(store);const record=map&&map['person:'+person.id];if(!record)return person;const extra=(record.aliases||[]).map(alias=>alias&&alias.value).filter(value=>value&&value!==person.name);if(!extra.length)return person;person.aliases=uniqueStrings([...(person.aliases||[]),...extra]);return person;}
function overlayOwnerPersonNames(data,store){if(!ownerPersonNameMap(store))return data;const visit=person=>{applyOwnerReviewedPerson(person,store);applyOwnerPersonAliases(person,store);};for(const film of data?.films||[])for(const person of [...(film.directors||[]),...(film.actors||[])])visit(person);for(const key of ['actors','directors'])for(const person of data?.people?.[key]||[])visit(person);for(const key of ['actors','directors'])data?.people?.[key]?.sort((a,b)=>(a.name||'').localeCompare(b.name||'','ru'));return data;}
function presentLocalized(data,titles,reviews=null){applyOwnerReviewedTitles(data,reviews);for(const film of data?.films||[]){const cached=titles?.[film.id];if(!reviewedTitle(film)&&cached)applyCachedTitleDomain(film,cached);}reviewedPeople(data,'on');return overlayOwnerPersonNames(data,reviews);}
// The EPG commit's write localization of the in-memory watchlist: the same domain rule, always.
function applyEpgLocalization(films,people){for(const film of films){for(const person of [...(film.directors||[]),...(film.actors||[])]){if(REVIEWED_PEOPLE[person.id])applyReviewedPerson(person,'on');else if(people[person.id])applyCachedPersonName(person,people[person.id],'on');}applyReviewedTitle(film,'on');}return films;}

// Newly added films use an exact TMDB film identifier; reviewed titles always win.
async function localizeFilmTitles(films,cache,mode,coordination=null){
 const pending=films.filter(f=>!reviewedTitle(f)&&f.tmdbId&&!((cache[f.id]?.tmdbId===f.tmdbId)&&cache[f.id]?.title));
 const ids=[...new Set(pending.map(f=>f.tmdbId).filter(id=>/^\d+$/.test(id)))];
 if(ids.length){
  const query=`SELECT ?tmdb ?film ?ru WHERE { VALUES ?tmdb { ${ids.map(x=>JSON.stringify(x)).join(' ')} } ?film wdt:P4947 ?tmdb; rdfs:label ?ru. FILTER(LANG(?ru)="ru") }`;
  const response=await wikidataRequest(coordination,'https://query.wikidata.org/sparql?'+new URLSearchParams({query,format:'json'}),{headers:{'Accept':'application/sparql-results+json','User-Agent':'WatchlistAirtime/1.0 (personal film programme)'},signal:AbortSignal.timeout(30000)});
  if(response&&!response.ok)throw new Error('Russian film titles HTTP '+response.status);
  const data=response?await response.json():null,byId=new Map();
  for(const row of data?.results.bindings||[]){const id=row.tmdb.value,ru=row.ru.value,source=row.film.value;if(!/[а-яё]/i.test(ru))continue;const labels=byId.get(id)||new Map();labels.set(ru,source);byId.set(id,labels);}
  for(const f of pending){const labels=byId.get(f.tmdbId);if(labels?.size===1){const [title,source]=[...labels][0];cache[f.id]={tmdbId:f.tmdbId,title,status:'provisional',sources:[source.replace('http:','https:').replace('/entity/','/wiki/')]};}}
 }
 const legacy=(list,store)=>{for(const f of list){if(reviewedTitle(f)){applyReviewedTitle(f);continue;}const match=store[f.id];if(match&&match.tmdbId===f.tmdbId&&match.title){f.aliases=uniqueStrings([...(f.aliases||[]),f.original,f.title,match.title]);f.title=match.title;f.titleRu=match.title;f.titleStatus=match.status;f.titleSources=match.sources;}}};
 const domain=(list,store)=>{for(const f of list){if(reviewedTitle(f))applyReviewedTitle(f,'on');else if(store[f.id])applyCachedTitle(f,store[f.id],'on');}};
 if(mode!=='on'&&mode!=='shadow'){legacy(films,cache);return {compared:0,mismatched:0};}
 return branchState(films,cache,mode,legacy,domain);
}
function assertEPGContinuity(result,previous,watchlistCount,now){
 if(result.stats.epgEnd<now+8*3600000)throw new Error('EPG horizon is too short for the next update');
 if(!previous?.stats)return;
 const old=previous.stats,ratio=watchlistCount/(previous.watchlistCount||watchlistCount);
 if(old.scanned>10000&&result.stats.scanned<old.scanned*.65)throw new Error('EPG has too few programmes compared with the last good update');
 if(old.channels>100&&result.coverage.length<old.channels*.65)throw new Error('EPG has too few channels compared with the last good update');
 // ADR 0191: every raw and horizon check above and below runs in every mode. The minimum-broadcasts check compares only generations of the SAME mode (legacy, filtered or
 // degraded; a report without the field is legacy), so the expected shrinkage after a mode change is not a feed fault; a revision, category or override change inside one mode
 // never exempts it, and there is no dynamic coefficient. The baseline is the last PUBLISHED generation, never a failed attempt.
 const sameMode=(result.stats.policyMode||'legacy')===(old.policyMode||'legacy');
 if(sameMode&&ratio>.8&&ratio<1.2&&old.broadcasts>100&&result.films.reduce((n,f)=>n+f.shows.length,0)<old.broadcasts*.35)throw new Error('EPG has too few matching broadcasts compared with the last good update');
}
