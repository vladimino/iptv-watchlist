const decode = s => String(s??'').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const cp=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):+n;return cp<=0x10ffff?String.fromCodePoint(cp):'';}).replace(/&(quot|apos|amp|lt|gt|nbsp);/g,(_,n)=>({quot:'"',apos:"'",amp:'&',lt:'<',gt:'>',nbsp:' '}[n]));
const plain = s => decode(String(s??'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const norm = s => plain(s).normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const attr=(tag,key)=>decode(tag.match(new RegExp('\\b'+key+'=(?:"([^"\\n]*)"|\x27([^\x27\\n]*)\x27)'))?.slice(1).find(x=>x!==undefined)||'');
const field=(xml,tag)=>plain(xml.match(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>'))?.[1]||'');
const extractYear=title=>Number(title.match(/\((19\d{2}|20\d{2})\)\s*$/)?.[1])||null;
const cleanTitle=title=>title.replace(/\s*\((?:19|20)\d{2}\)\s*$/,'').trim();
const GENRE_MAP={Action:'Боевик',Thriller:'Триллер',Crime:'Криминал','Science Fiction':'Фантастика',Horror:'Ужасы',Adventure:'Приключения',Comedy:'Комедия',Drama:'Драма',Fantasy:'Фэнтези',Animation:'Мультфильм',History:'Исторический',War:'Военный',Mystery:'Детектив',Romance:'Мелодрама',Family:'Семейный',Documentary:'Документальный',Western:'Вестерн',Music:'Музыкальный','TV Movie':'Телефильм'};
async function getHTML(url){const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw new Error(`Source HTTP ${r.status}: ${new URL(url).pathname}`);const h=await r.text();if(h.length>3000000)throw new Error('Unexpected page size');return h;}
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
 return {...base,directors,actors,peopleVersion:1,tmdbId:html.match(/data-tmdb-id="(\d+)"/)?.[1]||null,original:decode(meta.name),aliases:[...new Set([base.title,decode(meta.name),...plain(alt).split(/,\s*/)].filter(Boolean))],genres:(Array.isArray(meta.genre)?meta.genre:meta.genre?[meta.genre]:[]).map(g=>GENRE_MAP[g]||g),poster:typeof meta.image==='string'&&meta.image.startsWith('https://')?meta.image:null,runtime,synopsis:parseSynopsis(html),synopsisFetchedAt:new Date().toISOString(),metadataAt:new Date().toISOString()};
}
function xmlTime(s){const m=s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})$/);if(!m)return NaN;return Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6])-(m[7]==='+'?1:-1)*(+m[8]*60 + +m[9])*60000;}
async function scanEPG(stream,watchlist,now){
 const index=new Map();for(const film of watchlist){for(const title of new Set((film.aliases||[film.original]).map(norm))){if(!title)continue;if(!index.has(title))index.set(title,[]);index.get(title).push(film);}}
 const channels=new Map(),coverage=new Map(),matched=new Map(),uncertain=new Map(),discovery=new Map();let scanned=0,min=Infinity,max=-Infinity,kept=0,buffer='',complete=false,bytes=0;
 const reader=stream.getReader(),decoder=new TextDecoder();
 try{while(true){const {done,value}=await reader.read();if(done){buffer+=decoder.decode();break;}bytes+=value.length;if(bytes>400000000)throw new Error('EPG exceeds supported size');buffer+=decoder.decode(value,{stream:true});
 while(true){const start=buffer.search(/<(?:channel|programme)\s/);if(start<0){if(buffer.includes('</tv>'))complete=true;buffer=buffer.slice(-1000);break;}if(start>0)buffer=buffer.slice(start);const type=buffer.startsWith('<channel ')?'channel':'programme',end=buffer.indexOf('</'+type+'>');if(end<0){if(buffer.length>1000000)throw new Error('EPG record exceeds limit');break;}const xml=buffer.slice(0,end+type.length+3);buffer=buffer.slice(end+type.length+3);
 if(type==='channel'){channels.set(attr(xml,'id'),field(xml,'display-name'));continue;}
 scanned++;const startAt=xmlTime(attr(xml,'start')),endAt=xmlTime(attr(xml,'stop'));if(!Number.isFinite(startAt)||!Number.isFinite(endAt)||endAt<=startAt)continue;min=Math.min(min,startAt);max=Math.max(max,startAt);const channelId=attr(xml,'channel'),channel=channels.get(channelId)||channelId;if(/^[A-Z]{2}:/.test(channel))continue;const c=coverage.get(channelId)||{name:channel,min:startAt,max:endAt};c.min=Math.min(c.min,startAt);c.max=Math.max(c.max,endAt);coverage.set(channelId,c);
 if(startAt<now-72*3600000||startAt>=now+24*3600000)continue;kept++;
 const title=field(xml,'title'),titleYear=extractYear(title),key=norm(cleanTitle(title)),candidates=index.get(key)||[];const duration=(endAt-startAt)/60000;
 const valid=candidates.filter(f=>titleYear?f.year&&Math.abs(f.year-titleYear)<=1:f.runtime&&f.runtime>=55&&Math.abs(duration-f.runtime)<=Math.max(8,f.runtime*.12));
 if(valid.length!==1){if(candidates.length)uncertain.set(`${channelId}:${startAt}`,{title,channel,start:startAt,reason:valid.length>1?'ambiguous':'insufficient_year_or_duration'});if(duration>=55&&duration<=300&&key&&key.length>=3&&key.length<=160){const discoveryKey=key+'|'+(titleYear||''),previous=discovery.get(discoveryKey),description=field(xml,'desc');if(previous){previous.airings++;previous.lastAiring=Math.max(previous.lastAiring,startAt);if(!previous.description&&description&&description!=='Нет описания')previous.description=description.slice(0,700);}else discovery.set(discoveryKey,{key:discoveryKey,title:cleanTitle(title),normalizedTitle:key,year:titleYear,duration:Math.round(duration),description:description&&description!=='Нет описания'?description.slice(0,700):null,firstAiring:startAt,lastAiring:startAt,airings:1});}continue;}
 const f=valid[0];if(!matched.has(f.id))matched.set(f.id,{...f,title:/[а-яё]/i.test(title)?cleanTitle(title):f.original,shows:[]});if(!/[а-яё]/i.test(matched.get(f.id).title)&&/[а-яё]/i.test(title))matched.get(f.id).title=cleanTitle(title);matched.get(f.id).shows.push({channelId,channel,start:startAt,end:endAt,epgTitle:title,basis:titleYear?'title_year':'title_duration'});
 }
 }
 }finally{reader.releaseLock();}
 complete=complete||buffer.includes('</tv>');if(!complete||scanned===0)throw new Error('EPG incomplete: closing tv tag or programmes missing');
 return {films:[...matched.values()],coverage:[...coverage.values()],discovery:[...discovery.values()],stats:{scanned,retained:kept,epgStart:min,epgEnd:max,bytes,uncertain:uncertain.size,discoveryCandidates:discovery.size},uncertain:[...uncertain.values()].slice(0,100)};
}

async function localizePeople(films,cache){
 for(const f of films)for(const p of [...f.directors,...f.actors])if(REVIEWED_PEOPLE[p.id]){applyReviewedPerson(p);cache[p.id]={...p};}
 const ids=[...new Set(films.map(f=>f.tmdbId).filter(id=>/^\d+$/.test(id)))];
 if(!ids.length)return;
 const query=`SELECT ?tmdb ?en ?ru WHERE { VALUES ?tmdb { ${ids.map(x=>JSON.stringify(x)).join(' ')} } ?film wdt:P4947 ?tmdb; (wdt:P161|wdt:P57|wdt:P725) ?person. ?person (rdfs:label|skos:altLabel) ?en; rdfs:label ?ru. FILTER(LANG(?en)="en" && LANG(?ru)="ru") }`;
 const url='https://query.wikidata.org/sparql?'+new URLSearchParams({query,format:'json'});
 const response=await fetch(url,{headers:{'Accept':'application/sparql-results+json','User-Agent':'WatchlistAirtime/1.0 (personal film programme)'},signal:AbortSignal.timeout(45000)});
 if(!response.ok)throw new Error('Russian names HTTP '+response.status);
 const data=await response.json();const index=new Map();
 for(const row of data.results.bindings){const key=row.tmdb.value+':'+norm(row.en.value);const names=index.get(key)||new Set();names.add(row.ru.value);index.set(key,names);}
 for(const f of films)for(const p of [...f.directors,...f.actors]){if(REVIEWED_PEOPLE[p.id]){applyReviewedPerson(p);continue;}const names=index.get(f.tmdbId+':'+norm(p.original));if(names?.size===1){const raw=[...names][0];const name=raw.includes(', ')?raw.split(', ').reverse().join(' '):raw;cache[p.id]={name,original:p.original};}if(cache[p.id])p.name=cache[p.id].name;}
}
function peopleCatalog(films){const collect=key=>[...new Map(films.flatMap(f=>f[key]||[]).map(p=>[p.id,p])).values()].sort((a,b)=>a.name.localeCompare(b.name,'ru'));return {directors:collect('directors'),actors:collect('actors')};}
async function localizeByLetterboxd(films,cache){
 const missing=[...new Map(films.flatMap(f=>[...(f.directors||[]),...(f.actors||[])]).filter(p=>!cache[p.id]&&!REVIEWED_PEOPLE[p.id]).map(p=>[p.id,p])).values()];
 for(let offset=0;offset<missing.length;offset+=80){
  const batch=missing.slice(offset,offset+80);const slugs=[...new Set(batch.map(p=>p.id.split('/')[1]).filter(s=>/^[a-z0-9-]+$/.test(s)))];if(!slugs.length)continue;
  const query=`SELECT ?slug ?ru WHERE { VALUES ?slug { ${slugs.map(s=>JSON.stringify(s)).join(' ')} } ?person (wdt:P6119|wdt:P12383) ?slug; rdfs:label ?ru. FILTER(LANG(?ru)="ru") }`;
  const response=await fetch('https://query.wikidata.org/sparql?'+new URLSearchParams({query,format:'json'}),{headers:{'Accept':'application/sparql-results+json','User-Agent':'WatchlistAirtime/1.0'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)continue;const data=await response.json();const labels=new Map();for(const r of data.results.bindings){const names=labels.get(r.slug.value)||new Set();names.add(r.ru.value);labels.set(r.slug.value,names);}
  for(const p of batch){const names=labels.get(p.id.split('/')[1]);if(names?.size===1){const raw=[...names][0];cache[p.id]={name:raw.includes(', ')?raw.split(', ').reverse().join(' '):raw,original:p.original};}}
 }
}

// Stable Letterboxd IDs take precedence over name-only or external matches.
const REVIEWED_PEOPLE=Object.fromEntries((typeof PERSON_NAME_DICTIONARY==='undefined'?[]:PERSON_NAME_DICTIONARY).map(p=>[p.id,{name:p.name,aliases:p.aliases,nameStatus:p.status,nameVerificationBasis:p.verification_basis,nameSource:p.source_url}]));
REVIEWED_PEOPLE['actor/chris-pratt']={name:'Крис Прэтт',aliases:['Крис Пратт'],nameStatus:'verified',nameSource:'https://ru.wikipedia.org/wiki/Прэтт,_Крис'};
function applyReviewedPerson(p){const match=REVIEWED_PEOPLE[p.id];if(!match)return p;const aliases=[...new Set([...(p.aliases||[]),...(match.aliases||[]),p.original,p.name].filter(n=>n&&n!==match.name))];Object.assign(p,match,{aliases});return p;}
function reviewedPeople(data){if(!data)return data;for(const film of data.films||[])applyReviewedTitle(film);for(const f of data.films||[])for(const key of ['actors','directors'])for(const p of f[key]||[])applyReviewedPerson(p);for(const key of ['actors','directors']){for(const p of data.people?.[key]||[])applyReviewedPerson(p);data.people?.[key]?.sort((a,b)=>a.name.localeCompare(b.name,'ru'));}return data;}

function availabilityDeadline(film){
 const starts=(film.shows||[]).map(show=>Number(show.start)).filter(Number.isFinite);
 return starts.length?new Date(Math.max(...starts)+72*3600000).toISOString():null;
}
function withAvailability(film){return {...film,availableUntil:availabilityDeadline(film)};}
function programmeWithWatchlist(report,watchlist){
 if(report.films.length===report.watchlistCount||!watchlist?.films){for(const film of report.films)film.availableUntil=availabilityDeadline(film);return report;}
 const scheduled=new Map(report.films.map(f=>[String(f.id),f]));
 const films=watchlist.films.map(f=>withAvailability({...f,...scheduled.get(String(f.id)),shows:scheduled.get(String(f.id))?.shows||[]}));
 return {...report,films,people:peopleCatalog(films)};
}

// Canonical titles are independent of EPG presence and language. Match stable IDs only.
const REVIEWED_TITLES=new Map((typeof FILM_TITLE_DICTIONARY==='undefined'?[]:FILM_TITLE_DICTIONARY).map(f=>[String(f.id),f]));
function reviewedTitle(film){const match=REVIEWED_TITLES.get(String(film.id));return match&&(!film.tmdbId||!match.tmdbId||String(film.tmdbId)===String(match.tmdbId))?match:null;}
function applyReviewedTitle(film){const match=reviewedTitle(film);if(!match)return film;film.aliases=[...new Set([...(film.aliases||[]),...(match.aliases||[]),film.title,film.original,match.title].filter(Boolean))];film.title=match.title;film.titleRu=match.title;film.titleStatus=match.status;film.titleSources=match.sources;return film;}

// Newly added films use an exact TMDB film identifier; reviewed titles always win.
async function localizeFilmTitles(films,cache){
 const pending=films.filter(f=>!reviewedTitle(f)&&f.tmdbId&&!((cache[f.id]?.tmdbId===f.tmdbId)&&cache[f.id]?.title));
 const ids=[...new Set(pending.map(f=>f.tmdbId).filter(id=>/^\d+$/.test(id)))];
 if(ids.length){
  const query=`SELECT ?tmdb ?film ?ru WHERE { VALUES ?tmdb { ${ids.map(x=>JSON.stringify(x)).join(' ')} } ?film wdt:P4947 ?tmdb; rdfs:label ?ru. FILTER(LANG(?ru)="ru") }`;
  const response=await fetch('https://query.wikidata.org/sparql?'+new URLSearchParams({query,format:'json'}),{headers:{'Accept':'application/sparql-results+json','User-Agent':'WatchlistAirtime/1.0 (personal film programme)'},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Russian film titles HTTP '+response.status);
  const data=await response.json(),byId=new Map();
  for(const row of data.results.bindings){const id=row.tmdb.value,ru=row.ru.value,source=row.film.value;if(!/[а-яё]/i.test(ru))continue;const labels=byId.get(id)||new Map();labels.set(ru,source);byId.set(id,labels);}
  for(const f of pending){const labels=byId.get(f.tmdbId);if(labels?.size===1){const [title,source]=[...labels][0];cache[f.id]={tmdbId:f.tmdbId,title,status:'provisional',sources:[source.replace('http:','https:').replace('/entity/','/wiki/')]};}}
 }
 for(const f of films){if(reviewedTitle(f)){applyReviewedTitle(f);continue;}const match=cache[f.id];if(match&&match.tmdbId===f.tmdbId&&match.title){f.aliases=[...new Set([...(f.aliases||[]),f.original,f.title,match.title].filter(Boolean))];f.title=match.title;f.titleRu=match.title;f.titleStatus=match.status;f.titleSources=match.sources;}}
}
function assertEPGContinuity(result,previous,watchlistCount,now){
 if(result.stats.epgEnd<now+8*3600000)throw new Error('EPG horizon is too short for the next update');
 if(!previous?.stats)return;
 const old=previous.stats,ratio=watchlistCount/(previous.watchlistCount||watchlistCount);
 if(old.scanned>10000&&result.stats.scanned<old.scanned*.65)throw new Error('EPG has too few programmes compared with the last good update');
 if(old.channels>100&&result.coverage.length<old.channels*.65)throw new Error('EPG has too few channels compared with the last good update');
 if(ratio>.8&&ratio<1.2&&old.broadcasts>100&&result.films.reduce((n,f)=>n+f.shows.length,0)<old.broadcasts*.35)throw new Error('EPG has too few matching broadcasts compared with the last good update');
}
