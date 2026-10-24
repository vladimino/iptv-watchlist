const QUOTAS = [
 ['cheap_pass_stored',8],
 ['cheap_pass_pending',6],
 ['ready_now_yearless',8],
 ['ready_now_dated',8],
 ['retry_blocked',8],
 ['retry_due',6],
 ['ambiguous_current',6],
 ['nonfilm',5],
 ['duration_mismatch',5]
];
const FOCUS_KEYS = ['блейд 1|1998','11 друзей оушена|2001','чужой против хищника 1|2004','12 друзей оушена|2004','матрица 1|1999'];
const LOOKUP_KEYS = ['блейд','блэйд','блейд 1','одиннадцать друзей оушена','11 друзей оушена','двенадцать друзей оушена','12 друзей оушена','чужой против хищника','чужой против хищника 1','матрица','матрица 1'];
const CATALOG_CAP = 12;

const plain = s => String(s??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const norm = s => plain(s).normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function epgTitleParts(raw){
 let title=plain(raw).replace(/^\s*(?:х\s*[.\/-]?\s*ф|к\s*[.\/-]?\s*ф|художественный\s+фильм|кинофильм|телефильм)\s*[:.\-–—]?\s*/iu,'').trim();
 const match=title.match(/(?:\s*\(((?:19|20)\d{2})\)|\s+((?:19|20)\d{2}))[.!?]?\s*$/u);
 if(match){const base=title.slice(0,match.index).replace(/[\s:.,;!?–—-]+$/u,'').trim();if(norm(base).length>=2)title=base;}
 return norm(title||raw);
}
function nonFilmEPGReason(title){
 const value=String(title||'');
 if(/^(?:tv\s*(?:series|show)|series|show|теле(?:шоу|передача)|передача|телепрограма|серіал)(?:\s|[.:,-])/iu.test(value))return 'show_label';
 if(/^(?:т\/с|м\/с|телесериал|мультсериал|сериал)(?:\s|[.:,-])/i.test(value))return 'series_label';
 if(/(?:\bseason\s*\d+|\bepisode\s*\d+|сезон\s*\d+|\d+\s*серія|серія\s*\d+|\bep\.?\s*\d+|\bs\d{1,2}e\d{1,3}\b|сезон\s*\d+|\d+\s*(?:серия|серии|серий)|(?:серия|серии|эпизод)\s*\d+)/i.test(value))return 'episode_label';
 if(/[-–]\s*\d{1,2}\s*[-–]\s*\d{1,3}(?:\s*(?:серия|серии|с))?\s*$/i.test(value))return 'season_episode_suffix';
 if(/(?:выпуск\s*[№#]?\s*\d+|\d+\s*[-–]\s*\d+\s*серии)/i.test(value))return 'broadcast_episode';
 return null;
}
function activityOf(candidate,now){
 const from=now-72*3600000,to=now+24*3600000,shows=Array.isArray(candidate.shows)?candidate.shows:null,inWindow=!!shows?.some(show=>Number(show.start)>=from&&Number(show.start)<to);
 if(candidate.seenInLatestSnapshot===true)return inWindow?'current':'historical';
 if(candidate.seenInLatestSnapshot==null&&inWindow)return 'current';
 const last=Number(candidate.lastSeenAt??candidate.lastAiring);
 return Number.isFinite(last)&&last<from?'expired':'historical';
}
function evidenceOf(candidate){
 const shows=[...(candidate.shows||[])].map(show=>`${show.channelId||''}:${show.start}`).sort(),durations=[...(candidate.durations||[])].filter(Number.isFinite).sort((a,b)=>a-b);
 return [candidate.normalizedTitle||'',candidate.year||'',durations.join(','),shows.join(',')].join('|');
}
function filmCard(film){
 return {tmdbId:String(film.tmdbId),title:film.title||'',original:film.original||'',year:film.year??null,runtime:film.runtime??null,canonicalIdentity:film.canonicalIdentity||null};
}
function indexFilms(films){
 const index=new Map();
 for(const [id,film] of Object.entries(films||{})){
  const tmdbId=film?.tmdbId||String(id).replace(/^tmdb_/,'');
  if(!film||!tmdbId||tmdbId===id&&!film.tmdbId)continue;
  const card=filmCard({...film,tmdbId});
  const names=[film.title,film.original,...(film.aliases||[])].filter(name=>typeof name==='string');
  for(const name of names){
   const key=epgTitleParts(name);
   if(!key)continue;
   const list=index.get(key)||[];
   if(!list.some(item=>item.tmdbId===card.tmdbId))list.push(card);
   index.set(key,list);
  }
 }
 for(const list of index.values())list.sort((a,b)=>a.tmdbId.localeCompare(b.tmdbId));
 return index;
}
function tagsOf(candidate,decision,now){
 const tags=new Set(),reason=nonFilmEPGReason(candidate.title),yearless=candidate.year==null||candidate.year==='',act=activityOf(candidate,now);
 const nonfilm=!!reason||decision?.status==='excluded_nonfilm';
 if(nonfilm)tags.add('nonfilm');
 if(decision?.identitySource==='known_epg_alias')tags.add('cheap_pass_stored');
 if(decision?.identitySource==='tmdb_detail')tags.add('verified_detail');
 if(candidate.confirmedTmdbId&&!decision&&!reason)tags.add('cheap_pass_pending');
 if(decision?.status==='duration_mismatch')tags.add('duration_mismatch');
 if(yearless)tags.add('yearless');
 const verified=decision?.status==='verified';
 const terminal=!!(decision?.terminalReason&&(!decision.evidenceKey||decision.evidenceKey===evidenceOf(candidate)));
 if(!nonfilm&&!verified&&act==='expired')tags.add('expired');
 if(!nonfilm&&!verified&&act!=='current'&&act!=='expired')tags.add('historical');
 if(!nonfilm&&!verified&&act==='current'&&terminal)tags.add('terminal');
 const open=!nonfilm&&!verified&&act==='current'&&!terminal;
 if(open&&decision?.status==='ambiguous')tags.add('ambiguous_current');
 const future=!!(decision?.retryAt&&Date.parse(decision.retryAt)>now);
 if(open&&decision?.status!=='ambiguous'&&future)tags.add('retry_backoff');
 if(open&&decision?.status!=='ambiguous'&&!future)tags.add('ready_now');
 if(tags.has('ready_now')&&yearless)tags.add('ready_now_yearless');
 if(tags.has('ready_now')&&!yearless&&!decision?.retryAt)tags.add('ready_now_dated');
 if(tags.has('ready_now')&&decision?.retryAt&&!future)tags.add('retry_due');
 const same=!decision?.evidenceKey||decision.evidenceKey===evidenceOf(candidate);
 if(tags.has('retry_backoff')&&same)tags.add('retry_blocked');
 return tags;
}
function catalogSlice(index,key){
 const list=index.get(key)||[];
 return {count:list.length,truncated:list.length>CATALOG_CAP,films:list.slice(0,CATALOG_CAP)};
}
function rowView(candidate,decision,now,index){
 const evidenceSame=!decision?.evidenceKey||decision.evidenceKey===evidenceOf(candidate);
 return {
  key:candidate.key,title:candidate.title,normalizedTitle:candidate.normalizedTitle||'',year:candidate.year??null,
  durations:[...(candidate.durations||[])].filter(Number.isFinite),confirmedTmdbId:candidate.confirmedTmdbId??null,
  activity:activityOf(candidate,now),nonFilm:nonFilmEPGReason(candidate.title),tags:[...tagsOf(candidate,decision,now)].sort(),
  decision:decision?{status:decision.status||null,identitySource:decision.identitySource||null,tmdbId:decision.tmdbId??null,retryAt:decision.retryAt??null,attempts:decision.attempts??null,terminalReason:decision.terminalReason??null,evidenceSame}:null,
  catalog:catalogSlice(index,candidate.normalizedTitle||epgTitleParts(candidate.title))
 };
}
export function census(items,decisions,films,now=Date.now()){
 const index=indexFilms(films),counts={},pipeline={nonfilm:0,verified:0,expired:0,historical:0,terminal:0,ambiguous:0,retryBackoff:0,readyNow:0,currentUnresolved:0};
 const identitySource={},decisionStatus={},yearless={ledger:0,readyNow:0,verified:0,retryBackoff:0};
 const local={readyNowHit:0,readyNowMiss:0,yearlessHit:0,yearlessMiss:0,retryBackoffHit:0,retryBackoffMiss:0,ambiguousHit:0,ambiguousMiss:0,cheapStoredHit:0,cheapStoredMiss:0};
 const ledgerKeys=new Set(),tagged=[];
 for(const candidate of items||[]){
  if(!candidate?.key)continue;
  ledgerKeys.add(candidate.key);
  const decision=decisions?.[candidate.key]||null,tags=tagsOf(candidate,decision,now),localCount=(index.get(candidate.normalizedTitle||'')||[]).length,yearlessRow=tags.has('yearless');
  for(const tag of tags)counts[tag]=(counts[tag]||0)+1;
  if(tags.has('nonfilm'))pipeline.nonfilm++;
  else if(decision?.status==='verified')pipeline.verified++;
  else if(tags.has('expired'))pipeline.expired++;
  else if(tags.has('historical'))pipeline.historical++;
  else if(tags.has('terminal'))pipeline.terminal++;
  else{
   pipeline.currentUnresolved++;
   if(tags.has('ambiguous_current'))pipeline.ambiguous++;
   else if(tags.has('retry_backoff'))pipeline.retryBackoff++;
   else if(tags.has('ready_now'))pipeline.readyNow++;
  }
  if(decision?.status)decisionStatus[decision.status]=(decisionStatus[decision.status]||0)+1;
  else decisionStatus.none=(decisionStatus.none||0)+1;
  if(decision?.identitySource)identitySource[decision.identitySource]=(identitySource[decision.identitySource]||0)+1;
  if(yearlessRow){yearless.ledger++;if(tags.has('ready_now'))yearless.readyNow++;if(decision?.status==='verified')yearless.verified++;if(tags.has('retry_backoff'))yearless.retryBackoff++;}
  const mark=(hit,miss)=>localCount?local[hit]++:local[miss]++;
  if(tags.has('ready_now'))mark('readyNowHit','readyNowMiss');
  if(yearlessRow)mark('yearlessHit','yearlessMiss');
  if(tags.has('retry_backoff'))mark('retryBackoffHit','retryBackoffMiss');
  if(tags.has('ambiguous_current'))mark('ambiguousHit','ambiguousMiss');
  if(tags.has('cheap_pass_stored'))mark('cheapStoredHit','cheapStoredMiss');
  tagged.push({candidate,decision,tags});
 }
 let orphans=0;for(const key of Object.keys(decisions||{}))if(!key.startsWith('__')&&!ledgerKeys.has(key))orphans++;
 tagged.sort((a,b)=>a.candidate.key.localeCompare(b.candidate.key));
 const picked=new Set(),sample=[],quotas=[];
 for(const [name,quota] of QUOTAS){
  const population=counts[name]||0;let taken=0;
  for(const entry of tagged){
   if(taken>=quota||sample.length>=60)break;
   if(!entry.tags.has(name)||picked.has(entry.candidate.key))continue;
   picked.add(entry.candidate.key);taken++;
   sample.push({...rowView(entry.candidate,entry.decision,now,index),stratum:name});
  }
  quotas.push({stratum:name,quota,population,taken});
 }
 const byKey=new Map(tagged.map(entry=>[entry.candidate.key,entry]));
 const focus=FOCUS_KEYS.map(key=>{
  const entry=byKey.get(key);
  return entry?rowView(entry.candidate,entry.decision,now,index):{key,missing:true};
 });
 const lookups={};
 for(const key of LOOKUP_KEYS)lookups[key]=catalogSlice(index,key);
 return {now:new Date(now).toISOString(),ledger:(items||[]).length,decisions:Object.keys(decisions||{}).length,films:Object.keys(films||{}).length,orphans,counts,pipeline,identitySource,decisionStatus,yearless,local,quotas,sample,focus,lookups};
}
export {QUOTAS,FOCUS_KEYS,LOOKUP_KEYS};
