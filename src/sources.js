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
function parseFilm(html,base){
 const raw=html.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1];if(!raw)throw new Error('Film metadata missing');const meta=JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g,''));if(!meta.name)throw new Error('Film name missing');
 const alt=html.match(/Alternative Titles<\/span><\/h3>\s*<div[^>]*>\s*<p>([\s\S]*?)<\/p>/)?.[1]||'';
 const d=meta.duration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);const runtime=d?(Number(d[1]||0)*60+Number(d[2]||0)):null;
 return {...base,original:decode(meta.name),aliases:[...new Set([base.title,decode(meta.name),...plain(alt).split(/,\s*/)].filter(Boolean))],genres:(Array.isArray(meta.genre)?meta.genre:meta.genre?[meta.genre]:[]).map(g=>GENRE_MAP[g]||g),poster:typeof meta.image==='string'&&meta.image.startsWith('https://')?meta.image:null,runtime,metadataAt:new Date().toISOString()};
}
function xmlTime(s){const m=s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})$/);if(!m)return NaN;return Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6])-(m[7]==='+'?1:-1)*(+m[8]*60 + +m[9])*60000;}
async function scanEPG(stream,watchlist,now){
 const index=new Map();for(const film of watchlist){for(const title of new Set((film.aliases||[film.original]).map(norm))){if(!title)continue;if(!index.has(title))index.set(title,[]);index.get(title).push(film);}}
 const channels=new Map(),coverage=new Map(),matched=new Map(),uncertain=new Map();let scanned=0,min=Infinity,max=-Infinity,kept=0,buffer='',complete=false,bytes=0;
 const reader=stream.getReader(),decoder=new TextDecoder();
 try{while(true){const {done,value}=await reader.read();if(done){buffer+=decoder.decode();break;}bytes+=value.length;if(bytes>400000000)throw new Error('EPG exceeds supported size');buffer+=decoder.decode(value,{stream:true});
 while(true){const start=buffer.search(/<(?:channel|programme)\s/);if(start<0){if(buffer.includes('</tv>'))complete=true;buffer=buffer.slice(-1000);break;}if(start>0)buffer=buffer.slice(start);const type=buffer.startsWith('<channel ')?'channel':'programme',end=buffer.indexOf('</'+type+'>');if(end<0){if(buffer.length>1000000)throw new Error('EPG record exceeds limit');break;}const xml=buffer.slice(0,end+type.length+3);buffer=buffer.slice(end+type.length+3);
 if(type==='channel'){channels.set(attr(xml,'id'),field(xml,'display-name'));continue;}
 scanned++;const startAt=xmlTime(attr(xml,'start')),endAt=xmlTime(attr(xml,'stop'));if(!Number.isFinite(startAt)||!Number.isFinite(endAt)||endAt<=startAt)continue;min=Math.min(min,startAt);max=Math.max(max,startAt);const channelId=attr(xml,'channel'),channel=channels.get(channelId)||channelId;if(/^[A-Z]{2}:/.test(channel))continue;const c=coverage.get(channelId)||{name:channel,min:startAt,max:endAt};c.min=Math.min(c.min,startAt);c.max=Math.max(c.max,endAt);coverage.set(channelId,c);
 if(startAt<now-72*3600000||startAt>=now+24*3600000)continue;kept++;
 const title=field(xml,'title'),titleYear=extractYear(title),key=norm(cleanTitle(title)),candidates=index.get(key)||[];const duration=(endAt-startAt)/60000;
 const valid=candidates.filter(f=>titleYear?f.year&&Math.abs(f.year-titleYear)<=1:f.runtime&&f.runtime>=55&&Math.abs(duration-f.runtime)<=Math.max(8,f.runtime*.12));
 if(valid.length!==1){if(candidates.length)uncertain.set(`${channelId}:${startAt}`,{title,channel,start:startAt,reason:valid.length>1?'ambiguous':'insufficient_year_or_duration'});continue;}
 const f=valid[0];if(!matched.has(f.id))matched.set(f.id,{...f,title:/[а-яё]/i.test(title)?cleanTitle(title):f.original,shows:[]});if(!/[а-яё]/i.test(matched.get(f.id).title)&&/[а-яё]/i.test(title))matched.get(f.id).title=cleanTitle(title);matched.get(f.id).shows.push({channelId,channel,start:startAt,end:endAt,epgTitle:title,basis:titleYear?'title_year':'title_duration'});
 }
 }
 }finally{reader.releaseLock();}
 complete=complete||buffer.includes('</tv>');if(!complete||scanned===0)throw new Error('EPG incomplete: closing tv tag or programmes missing');
 return {films:[...matched.values()],coverage:[...coverage.values()],stats:{scanned,retained:kept,epgStart:min,epgEnd:max,bytes,uncertain:uncertain.size},uncertain:[...uncertain.values()].slice(0,100)};
}
