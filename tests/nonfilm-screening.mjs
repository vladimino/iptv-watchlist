import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// AIR-94: EPG non-film screening keeps feature films and removes only high-confidence serialized forms.
function harness(response){
 const records=new Map(),etags=new Map(),urls=[];let revision=0;
 const env={TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,TextDecoder,ReadableStream,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async input=>{urls.push(String(input));return response(String(input));}});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),live);
 live.env=env;live.records=records;live.urls=urls;
 return live;
}
const live=harness(()=>new Response(JSON.stringify({total_pages:1,results:[]})));
const reason=title=>vm.runInContext(`nonFilmEPGReason(${JSON.stringify(title)})`,live);

// Feature films, including concert and documentary films, are never screened out by a bare number word.
for(const title of [
 'Star Wars: Episode 3 - Revenge of the Sith','Star Wars: Episode III - Revenge of the Sith','Star Wars: Episode 3','Star Wars: Episode 9',
 'Звёздные войны: Эпизод 3 – Месть ситхов','Звёздные войны Эпизод 2 - Атака клонов','Сезон охоты 2','Open Season 2',
 'Show Boat','Series 7: The Contenders','12-05-08','10-10-10',
 'Pink Floyd: Live at Pompeii','Stop Making Sense','Концерт для симфонического оркестра','Документальный фильм о войне',
 'Интервью с вампиром','Шоу Трумана','Голый пистолет 2 1-2 Запах страха 1991','Схватка (1995)',
 'Example Film Ep 12 Remastered','Пример (1968) 1-серия','Пример фильма 2-я серия',
])assert.equal(reason(title),null,title);

// Reliable serialized forms keep their reason codes.
for(const [title,code] of [
 ['Breaking Bad S01E01','episode_label'],['Breaking Bad S1E1','episode_label'],['Breaking Bad S01 E01','episode_label'],['Breaking Bad S1.E1','episode_label'],
 ['Example Show | S01E08','episode_label'],['Example Show (Part One). S1,Ep1','episode_label'],['Пример 2022 10 эпизодов s01ep04 Название','episode_label'],
 ['Пример - сезон 2, серия 10','episode_label'],['Пример - 3 сезон, 6 серия.','episode_label'],['Пример. Сезон 4-й 17-я серия. Название','episode_label'],
 ['Пример Сезон 2 Серия 2','episode_label'],['Example Show. Season 1. Ep. 7. Title','episode_label'],
 ['Example Show (Series 13): Title (Episode 6)','episode_label'],['Пример серия 6','episode_label'],['Пример 2 серия','episode_label'],
 ['Example News New. Episode 204','episode_label'],['Пример. Сезон 4-й. Название','episode_label'],['Пример. Сезон 13-й','episode_label'],['Example 101. Ep 1','episode_label'],
 ['т/с Ганнибал: Второе блюдо','series_label'],['мультсериал Пример','series_label'],['TV series Example','show_label'],['Телепередача Пример','show_label'],
 ['Пример-1-5','season_episode_suffix'],['При-мер-7-1-10','season_episode_suffix'],
 ['«Пример». Выпуск 319','broadcast_episode'],['Пример (Спецвыпуск 1)','broadcast_episode'],['Пример (2026) 9-13 серии из 13','episode_label'],
])assert.equal(reason(title),code,title);

// XMLTV episode-num is used when the feed provides it; a plain programme is still judged by its title.
assert.equal(vm.runInContext(`nonFilmEPGReason('Plain Title','<programme><episode-num system="xmltv_ns">0.4.</episode-num></programme>')`,live),'xmltv_episode_num');
assert.equal(vm.runInContext(`nonFilmEPGReason('Plain Title','<programme><episode-num system="onscreen">S02E05</episode-num></programme>')`,live),'xmltv_episode_num');
assert.equal(vm.runInContext(`nonFilmEPGReason('Plain Title','<programme><episode-num system="xmltv_ns">..</episode-num></programme>')`,live),null);
assert.equal(vm.runInContext(`nonFilmEPGReason('Plain Title','<programme><title>Plain Title</title></programme>')`,live),null);

// EPG scan: an ambiguous film title reaches discovery, true episodes are filtered before discovery,
// and a reliable watchlist identity outranks title screening.
const now=Date.UTC(2026,9,27,12);
const stamp=ms=>{const d=new Date(ms);return d.toISOString().slice(0,19).replace(/[-T:]/g,'')+' +0000';};
const programme=(title,minutes,extra='')=>`<programme start="${stamp(now)}" stop="${stamp(now+minutes*60000)}" channel="c1"><title>${title}</title>${extra}</programme>`;
const xml=`<tv><channel id="c1"><display-name>Кино</display-name></channel>${[
 programme('Star Wars: Episode 3 - Revenge of the Sith',140),
 programme('Сезон охоты 2',76),
 programme('Breaking Bad S01E01',58),
 programme('Пример - сезон 2, серия 10',60),
 programme('Plain Episode',60,'<episode-num system="xmltv_ns">1.4.</episode-num>'),
 programme('Open Season 2 (2008)',76),
 programme('Война и мир. 1 серия (1965)',147),
].join('')}</tv>`;
live.xml=xml;live.now=now;
live.watchlist=[{id:'lb-open2',title:'Open Season 2',original:'Open Season 2',aliases:['Open Season 2'],year:2008,runtime:76,tmdbId:'900001'},{id:'lb-war1',title:'Война и мир. 1 серия',original:'Война и мир. 1 серия',aliases:['Война и мир. 1 серия'],year:1965,runtime:147,tmdbId:'1'}];
const scan=await vm.runInContext('scanEPG(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(xml));c.close();}}),watchlist,now)',live);
const discovered=new Set(scan.discovery.map(item=>item.title));
assert(discovered.has('Star Wars: Episode 3 - Revenge of the Sith'));assert(discovered.has('Сезон охоты 2'));
assert(!discovered.has('Breaking Bad S01E01'));assert(!discovered.has('Пример - сезон 2, серия 10'));assert(!discovered.has('Plain Episode'));
assert.equal(scan.stats.filteredNonMovies,3);
assert.equal(scan.films.map(film=>film.id).sort().join(','),'lb-open2,lb-war1');
assert.equal(reason('Война и мир. 1 серия (1965)'),'episode_label');

// Stored decisions: a stale exclusion is re-checked, a still-matching one stays excluded, verified identities win.
const show={channelId:'c1',channel:'Кино',start:Date.now(),end:Date.now()+3600000};
const candidate=(title,year,extra={})=>{const normalizedTitle=vm.runInContext(`epgTitleParts(${JSON.stringify(title)}).normalizedTitle`,live);return {key:normalizedTitle+'|'+(year??''),title,normalizedTitle,year,duration:140,durations:[140],seenInLatestSnapshot:true,shows:[show],lastAiring:show.start,airings:1,...extra};};
live.film=candidate('Звёздные войны: Эпизод 3 – Месть ситхов',2005);live.episode=candidate('Пример Сезон 2 Серия 2',null);
assert.equal(vm.runInContext("resolutionActionability(film,{status:'excluded_nonfilm',reason:'episode_label'})",live),true);
assert.equal(vm.runInContext("resolutionActionability(episode,{status:'excluded_nonfilm',reason:'episode_label'})",live),false);
assert.equal(vm.runInContext("resolutionActionability(episode,null)",live),false);
assert.equal(vm.runInContext("screenedNonfilmReason(episode,{status:'verified',tmdbId:'1'})",live),null);
assert.equal(vm.runInContext("screenedNonfilmReason({...episode,confirmedTmdbId:'1'},null)",live),null);
const counts=vm.runInContext("discoveryCounts([film,episode],{[film.key]:{status:'excluded_nonfilm',reason:'episode_label'},[episode.key]:{status:'excluded_nonfilm',reason:'episode_label'}})",live);
assert.equal(counts.rejectedNonfilm,1);assert.equal(counts.readyNow,1);

// Discovery chunk: the wrongly excluded film is recovered by the normal cycle, the true episode never reaches TMDB,
// and a verified identity is not overwritten by screening.
const movie={id:1895,title:'Звёздные войны: Эпизод 3 – Месть ситхов',original_title:'Star Wars: Episode III - Revenge of the Sith',release_date:'2005-05-17',runtime:140,overview:'',genres:[],credits:{crew:[],cast:[]}};
const tmdb=harness(url=>new Response(JSON.stringify(url.includes('/search/movie?')?{total_pages:1,results:[movie]}:movie)));
const verifiedEpisode=candidate('Другой пример Сезон 1 Серия 3',null);
tmdb.records.set('programme.json',{runId:'run-1',films:[]});
tmdb.records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[live.film,live.episode,verifiedEpisode]});
tmdb.records.set('epg/discovered-films.json',{tmdb_77:{id:'tmdb_77',tmdbId:'77',title:'Другой пример',original:'Another Example',year:1971,canonicalIdentity:'tmdb:77',aliases:[],shows:[]}});
tmdb.records.set('epg/discovery-resolution.json',{[live.film.key]:{status:'excluded_nonfilm',reason:'episode_label',checkedAt:'2026-10-20T00:00:00.000Z'},[live.episode.key]:{status:'excluded_nonfilm',reason:'episode_label',checkedAt:'2026-10-20T00:00:00.000Z'},[verifiedEpisode.key]:{status:'verified',tmdbId:'77',filmId:'tmdb_77'}});
await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',tmdb);
const decisions=tmdb.records.get('epg/discovery-resolution.json');
assert.equal(decisions[live.film.key].status,'verified');assert.equal(decisions[live.film.key].tmdbId,'1895');
assert.equal(decisions[live.episode.key].status,'excluded_nonfilm');
assert.equal(decisions[verifiedEpisode.key].status,'verified');assert.equal(decisions[verifiedEpisode.key].tmdbId,'77');
assert(tmdb.urls.length>0);assert(!tmdb.urls.some(url=>/пример/i.test(decodeURIComponent(url))));
assert(tmdb.records.get('epg/discovered-films.json').tmdb_1895);

console.log('Non-film screening: feature-film negatives, serialized positives, XMLTV episode-num, EPG scan precedence, stale exclusion recovery and verified identity precedence passed');
