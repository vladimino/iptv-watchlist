const SOURCES={epg:'https://example.invalid/epg.xml',watchlist:'https://letterboxd.com/demo-user/watchlist/'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const loadJSON=async(env,key)=>{const o=await env.BUCKET.get(key);return o?o.json():null;};
const saveJSON=(env,key,value)=>env.BUCKET.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'}});
const eventFilm=(film,titles=new Map())=>({id:String(film.id),title:reviewedTitle(film)?.title||titles.get(String(film.id))||film.title||film.original,year:film.year});
const eventTitles=report=>new Map((report?.films||[]).map(f=>[String(f.id),f.title]));
function epgEvent(report,id){const cutoff=Date.parse(report.updatedAt);const archive=f=>f.shows.some(s=>s.start>=cutoff-72*3600000&&s.start<cutoff),future=f=>f.shows.some(s=>s.start>=cutoff&&s.start<cutoff+24*3600000);return {id,type:'epg',at:report.updatedAt,films:report.stats.uniqueFilms??report.films.filter(f=>f.shows?.length).length,archive:report.films.filter(archive).length,future:report.films.filter(future).length,broadcasts:report.films.reduce((n,f)=>n+f.shows.length,0)};}
function watchlistEvent(before,after,oldReport,report,id){const oldIds=new Set((before?.films||[]).map(f=>String(f.id))),newIds=new Set(after.films.map(f=>String(f.id)));return {id,type:'watchlist',at:after.updatedAt,total:after.films.length,baseline:!before,added:before?after.films.filter(f=>!oldIds.has(String(f.id))).map(f=>eventFilm(f,eventTitles(report))):[],removed:before?before.films.filter(f=>!newIds.has(String(f.id))).map(f=>eventFilm(f,eventTitles(oldReport))):[]};}
async function writeEvent(env,event){const reverse=String(9999999999999-Date.parse(event.at)).padStart(13,'0');await saveJSON(env,'events/items/'+reverse+'-'+event.id+'.json',event);}
async function eventPage(env,cursor){const page=await env.BUCKET.list({prefix:'events/items/',limit:20,...(cursor?{cursor}:{})});const events=await Promise.all(page.objects.map(o=>loadJSON(env,o.key)));for(const event of events.filter(Boolean)){if(event.film)event.film=eventFilm(event.film);for(const key of ['added','removed'])if(event[key])event[key]=event[key].map(f=>eventFilm(f));}return {events:events.filter(Boolean),cursor:page.truncated?page.cursor:null};}
async function bootstrapEvents(env){if(await loadJSON(env,'events/bootstrap.json'))return;const report=await loadJSON(env,'programme.json'),list=await loadJSON(env,'watchlist.json');if(report)await writeEvent(env,epgEvent(report,'baseline-epg'));if(list)await writeEvent(env,watchlistEvent(null,list,null,report,'baseline-watchlist'));let cursor;do{const page=await env.BUCKET.list({prefix:'started/',...(cursor?{cursor}:{})});for(const o of page.objects){const mark=await loadJSON(env,o.key);if(mark?.lastEvent){await writeEvent(env,mark.lastEvent);continue;}if(mark&&mark.started!==false&&mark.startedAt){const film=report?.films.find(f=>String(f.id)===mark.id)||list?.films.find(f=>String(f.id)===mark.id);if(film)await writeEvent(env,{id:'baseline-started-'+mark.id,type:'started',at:mark.startedAt,film:eventFilm(film,eventTitles(report))});}}cursor=page.truncated?page.cursor:undefined;}while(cursor);await saveJSON(env,'events/bootstrap.json',{at:new Date().toISOString()});}
async function startedFilms(env){let cursor;const ids=[];do{const page=await env.BUCKET.list({prefix:'started/',include:['customMetadata'],...(cursor?{cursor}:{})});for(const object of page.objects){const match=object.key.match(/^started\/([a-zA-Z0-9_-]+)\.json$/);if(match&&object.customMetadata?.started!=='false')ids.push(match[1]);}cursor=page.truncated?page.cursor:undefined;}while(cursor);return ids;}
async function setStarted(env,body){
 if(typeof body.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(body.id)||typeof body.started!=='boolean')return json({error:'Invalid film or state'},400);
 const key='started/'+body.id+'.json',previous=await loadJSON(env,key),wasStarted=!!previous&&previous.started!==false;
 if(wasStarted===body.started){if(previous?.lastEvent)await writeEvent(env,previous.lastEvent);return json({id:body.id,started:body.started});}
 const metadata=await loadJSON(env,'metadata.json')||{},report=await loadJSON(env,'programme.json');const film=metadata[body.id]||report?.films.find(f=>String(f.id)===body.id);if(body.started&&!film)return json({error:'Unknown film'},404);
 const at=new Date().toISOString(),event={id:crypto.randomUUID(),type:body.started?'started':'unstarted',at,film:film?eventFilm(film,eventTitles(report)):previous?.lastEvent?.film||{id:body.id,title:'Фильм',year:null}};
 await env.BUCKET.put(key,JSON.stringify({id:body.id,started:body.started,startedAt:body.started?at:null,lastEvent:event}),{httpMetadata:{contentType:'application/json'},customMetadata:{started:String(body.started)}});
 await writeEvent(env,event);return json({id:body.id,started:body.started});
}
async function beginSync(env){
 const current=await loadJSON(env,'sync.json');if(current&&['metadata','epg'].includes(current.stage)&&Date.now()-Date.parse(current.updatedAt)<15*60000)return {runId:current.runId,stage:current.stage,remaining:current.remaining};
 let url=SOURCES.watchlist,pages=0,total=null;const films=new Map();
 while(url){const p=parseWatchlist(await getHTML(url));pages++;if(pages>100)throw new Error('Watchlist pagination limit exceeded');if(!Number.isInteger(p.total))throw new Error('Watchlist total not found');if(total===null)total=p.total;if(total!==p.total)throw new Error('Watchlist changed during synchronization; retry');if(p.films.length===0&&total>0)throw new Error('Watchlist page has no films');for(const f of p.films){if(films.has(f.id))throw new Error('Duplicate film across pages; retry');films.set(f.id,f);}if(p.next&&!/^\/demo-user\/watchlist\/page\/\d+\/$/.test(p.next))throw new Error('Unexpected pagination URL');url=p.next?'https://letterboxd.com'+p.next:null;}
 if(films.size!==total)throw new Error(`Incomplete watchlist: ${films.size}/${total}`);
 const verify=parseWatchlist(await getHTML(SOURCES.watchlist));if(verify.total!==total||verify.films.some((f,i)=>f.id!==[...films.values()][i]?.id))throw new Error('Watchlist changed during synchronization; retry');
 const cache=await loadJSON(env,'metadata.json')||{};const all=[...films.values()].map(f=>cache[f.id]?{...cache[f.id],...f,aliases:cache[f.id].aliases}:f);const pending=all.filter(f=>!f.metadataAt||f.peopleVersion!==1||f.peopleNamesVersion!==2||!f.synopsisFetchedAt||Date.now()-Date.parse(f.metadataAt)>30*86400000).map(f=>f.id);
 const priorList=await loadJSON(env,'watchlist.json'),priorRun=await loadJSON(env,'sync.json'),ratingIndex=await loadJSON(env,'enrichment/view-index.json')||{},priorIds=new Set((priorList?.films||[]).map(f=>String(f.id)));const ratedIds=Object.entries(ratingIndex).filter(([,value])=>value.actualRating!==null&&value.actualRating!==undefined).map(([id])=>id);const ratingPending=[...new Set([...all.filter(f=>!priorIds.has(String(f.id))).map(f=>String(f.id)),...ratedIds,...(priorRun?.ratingRetry||[])])].filter(id=>all.some(f=>String(f.id)===id));
 const run={runId:crypto.randomUUID(),startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),stage:pending.length?'metadata':'epg',watchlist:all,pending,ratingPending,cursor:0,remaining:pending.length,pages,failures:[]};await saveJSON(env,'sync.json',run);return {runId:run.runId,stage:run.stage,watchlistCount:total,pages,remaining:run.remaining};
}
async function metadataSync(env,run){
 const cache=await loadJSON(env,'metadata.json')||{};const creditsChanged=new Set();const next=run.pending.slice(run.cursor,run.cursor+24);const onlyNames=next.every(id=>cache[id]?.peopleVersion===1&&Date.now()-Date.parse(cache[id].metadataAt)<30*86400000);const ids=next.slice(0,onlyNames?24:12);
 for(let i=0;i<ids.length;i+=3)await Promise.all(ids.slice(i,i+3).map(async id=>{const idx=run.watchlist.findIndex(f=>f.id===id);try{const film=run.watchlist[idx],fresh=film.peopleVersion===1&&film.metadataAt&&Date.now()-Date.parse(film.metadataAt)<30*86400000;if(fresh&&film.synopsisFetchedAt){if(film.peopleNamesVersion!==2)creditsChanged.add(id);return;}const html=await getHTML(film.url);if(fresh){film.synopsis=parseSynopsis(html);film.synopsisFetchedAt=new Date().toISOString();cache[id]={...cache[id],synopsis:film.synopsis,synopsisFetchedAt:film.synopsisFetchedAt};if(film.peopleNamesVersion!==2)creditsChanged.add(id);return;}const result=parseFilm(html,film);cache[id]=result;run.watchlist[idx]=result;creditsChanged.add(id);}catch(e){run.failures.push({id,error:e.message});}}));
 const titles=await loadJSON(env,'titles.json')||{};const titleBatch=run.watchlist.filter(f=>ids.includes(f.id));
 try{await localizeFilmTitles(titleBatch,titles);}catch(e){run.titleLocalizationErrors=(run.titleLocalizationErrors||0)+1;}
 await saveJSON(env,'titles.json',titles);
 const people=await loadJSON(env,'people.json')||{};const batch=run.watchlist.filter(f=>creditsChanged.has(f.id)&&f.peopleVersion===1);
 try{if(batch.length)await localizePeople(batch,people);for(const f of batch){f.peopleLocalizedAt=new Date().toISOString();f.peopleNamesVersion=2;}}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 for(const f of batch)cache[f.id]=f;
 await saveJSON(env,'people.json',people);
 run.cursor+=ids.length;run.remaining=run.pending.length-run.cursor;run.stage=run.remaining?'metadata':'epg';run.updatedAt=new Date().toISOString();await saveJSON(env,'metadata.json',cache);await saveJSON(env,'sync.json',run);return {runId:run.runId,stage:run.stage,remaining:run.remaining,failedMetadata:run.failures.length,localizationErrors:run.localizationErrors||0,russianNames:Object.keys(people).length};
}
async function finishSync(env,run,report){const list=await loadJSON(env,'watchlist.json');if(report.films?.length===report.watchlistCount&&list?.updatedAt!==report.updatedAt)await saveJSON(env,'watchlist.json',{updatedAt:report.updatedAt,films:report.films.map(({shows,...f})=>f)});for(const event of run.events)await writeEvent(env,event);run.stage='complete';run.updatedAt=new Date().toISOString();delete run.watchlist;delete run.pending;await saveJSON(env,'sync.json',run);return {runId:run.runId,stage:run.stage,updatedAt:report.updatedAt,watchlistCount:report.watchlistCount,...report.stats};}
async function completeWithRatings(env,run,report){
 const result=await finishSync(env,run,report);if(!run.ratingPending?.length)return result;
 const films=new Map((report.films||[]).map(f=>[String(f.id),f])),retry=[];let saved=0;
 for(const id of run.ratingPending){const film=films.get(id);if(!film)continue;try{const response=await refreshPersonalRating(env,film);if(response.status==='saved')saved++;}catch{retry.push(id);}}
 run.ratingRetry=retry;delete run.ratingPending;await saveJSON(env,'sync.json',run);return {...result,personalRatingsSaved:saved,personalRatingRetry:retry.length};
}
async function epgSync(env,run){
 if(run.events){const committed=await loadJSON(env,'programme.json');if(committed?.runId===run.runId)return completeWithRatings(env,run,committed);}
 const titles=await loadJSON(env,'titles.json')||{};
 try{await localizeFilmTitles(run.watchlist,titles);await saveJSON(env,'titles.json',titles);}catch(e){run.titleLocalizationErrors=(run.titleLocalizationErrors||0)+1;}
 const people=await loadJSON(env,'people.json')||{};
 try{await localizeByLetterboxd(run.watchlist,people);await saveJSON(env,'people.json',people);}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 for(const f of run.watchlist)for(const p of [...(f.directors||[]),...(f.actors||[])])if(people[p.id])p.name=people[p.id].name;
 for(const film of run.watchlist)applyReviewedTitle(film);
 const now=Date.now(),r=await fetch(SOURCES.epg,{signal:AbortSignal.timeout(110000)});if(!r.ok)throw new Error('EPG HTTP '+r.status);const result=await scanEPG(r.body,run.watchlist,now);if(result.stats.epgEnd<now-72*3600000)throw new Error('EPG does not cover the current window');
 const previous=await loadJSON(env,'programme.json');assertEPGContinuity(result,previous,run.watchlist.length,now);const fresh=new Map(result.films.map(f=>[f.id,f]));const currentFilms=new Map(run.watchlist.map(f=>[f.id,f]));const channelMin=new Map(result.coverage.map(c=>[c.name,c.min]));
 for(const old of previous?.films||[]){if(!currentFilms.has(old.id))continue;const historical=old.shows.filter(s=>s.start>=now-72*3600000&&s.start<now&&s.start<(channelMin.get(s.channel)??Infinity));if(!historical.length)continue;const target=fresh.get(old.id)||{...currentFilms.get(old.id),title:old.title,shows:[]};const keys=new Set(target.shows.map(s=>`${s.channelId}:${s.start}`));target.shows.push(...historical.filter(s=>!keys.has(`${s.channelId}:${s.start}`)));fresh.set(old.id,target);}
 const matched=[...fresh.values()].map(f=>({...f,shows:f.shows.sort((a,b)=>a.start-b.start)}));const currentById=new Map(matched.map(f=>[String(f.id),f]));const films=run.watchlist.map(f=>withAvailability({...f,...currentById.get(String(f.id)),shows:currentById.get(String(f.id))?.shows||[]}));const countShows=matched.reduce((n,f)=>n+f.shows.length,0);
 const report={runId:run.runId,updatedAt:new Date(now).toISOString(),watchlistUpdatedAt:run.startedAt,cutoff:now,window:{from:now-72*3600000,to:now+24*3600000},watchlistCount:run.watchlist.length,watchlistPages:run.pages,films,people:peopleCatalog(run.watchlist),stats:{...result.stats,broadcasts:countShows,uniqueFilms:matched.length,metadataMissing:run.watchlist.filter(f=>!f.metadataAt).length,titleMissing:run.watchlist.filter(f=>!f.titleRu).length,titleProvisional:run.watchlist.filter(f=>f.titleStatus==='provisional').length,titleLocalizationErrors:run.titleLocalizationErrors||0,synopsisAvailable:run.watchlist.filter(f=>!!f.synopsis).length,synopsisMissing:run.watchlist.filter(f=>!f.synopsis).length,peopleMissing:run.watchlist.filter(f=>f.peopleVersion!==1).length,peopleFilms:run.watchlist.filter(f=>f.peopleVersion===1).length,channels:result.coverage.length,futureFullChannels:result.coverage.filter(c=>c.max>=now+24*3600000).length},sources:SOURCES,archiveVerified:false};
 const nextWatchlist={updatedAt:report.updatedAt,films:run.watchlist};
 if(!run.events){const before=await loadJSON(env,'watchlist.json');run.events=[watchlistEvent(before,nextWatchlist,previous,report,run.runId+'-watchlist'),epgEvent(report,run.runId+'-epg')];await saveJSON(env,'sync.json',run);}
 await saveJSON(env,'programme.json',report);await saveJSON(env,'watchlist.json',{updatedAt:report.updatedAt,films:run.watchlist});await saveJSON(env,'uncertain.json',{updatedAt:report.updatedAt,items:result.uncertain});return completeWithRatings(env,run,report);
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 try{
 if(url.pathname.startsWith('/api/')){
  if(!env.BUCKET)return json({error:'Storage unavailable'},503);
  if(['POST','PUT'].includes(request.method)&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'Origin not allowed'},403);
  if(url.pathname.startsWith('/api/enrichment/'))return await enrichmentRoute(request,env,url);
  if(url.pathname==='/api/events'&&request.method==='GET'){const cursor=url.searchParams.get('cursor');if(cursor&&cursor.length>4000)return json({error:'Invalid cursor'},400);return json(await eventPage(env,cursor));}
  if(url.pathname==='/api/events/bootstrap'&&request.method==='POST'){await bootstrapEvents(env);return json({ok:true});}
  if(url.pathname==='/api/started'&&request.method==='GET')return json({ids:await startedFilms(env)});
  if(url.pathname==='/api/started'&&request.method==='POST'){let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}if(!body||typeof body!=='object')return json({error:'Invalid request'},400);return await setStarted(env,body);}
  if(url.pathname==='/api/programme'&&request.method==='GET'){const data=await loadJSON(env,'programme.json');if(!data)return json({error:'Первое обновление ещё выполняется'},503);const watchlist=await loadJSON(env,'watchlist.json');const titles=await loadJSON(env,'titles.json')||{};const merged=programmeWithWatchlist(data,watchlist);for(const f of merged.films){const t=titles[f.id];if(!reviewedTitle(f)&&t?.tmdbId===f.tmdbId&&t.title){f.title=t.title;f.titleRu=t.title;f.titleStatus=t.status;f.titleSources=t.sources;}}return json(reviewedPeople(merged));}
  if(url.pathname==='/api/watchlist'&&request.method==='GET'){let data=await loadJSON(env,'watchlist.json');const report=await loadJSON(env,'programme.json');if(report?.films?.length===report.watchlistCount&&data?.updatedAt!==report.updatedAt)data={updatedAt:report.updatedAt,films:report.films};if(!data)return json({films:[]});const titles=await loadJSON(env,'titles.json')||{};for(const f of data.films){const t=titles[f.id];if(!reviewedTitle(f)&&t?.tmdbId===f.tmdbId&&t.title){f.title=t.title;f.titleRu=t.title;f.titleStatus=t.status;f.titleSources=t.sources;}}return json(reviewedPeople(data));}
  if(url.pathname==='/api/status'&&request.method==='GET'){const run=await loadJSON(env,'sync.json');return json(run?{runId:run.runId,stage:run.stage,updatedAt:run.updatedAt,remaining:run.remaining,failures:run.failures?.length,error:run.error}: {stage:'not_started'});}
  if(url.pathname==='/api/sync/start'&&request.method==='POST')return json(await beginSync(env));
  if(['/api/sync/metadata','/api/sync/epg'].includes(url.pathname)&&request.method==='POST'){
   const body=await request.json();const run=await loadJSON(env,'sync.json');if(!run||body.runId!==run.runId)return json({error:'Run id mismatch'},409);
   if(url.pathname.endsWith('metadata')){if(run.stage!=='metadata')return json({runId:run.runId,stage:run.stage,remaining:run.remaining});return json(await metadataSync(env,run));}
   if(run.stage==='complete'){if(run.ratingPending?.length){const report=await loadJSON(env,'programme.json');if(report?.runId===run.runId)return json(await completeWithRatings(env,run,report));}return json({runId:run.runId,stage:run.stage});}if(run.stage!=='epg')return json({error:'Metadata stage is not complete'},409);
   try{return json(await epgSync(env,run));}catch(e){run.error=e.message;run.updatedAt=new Date().toISOString();await saveJSON(env,'sync.json',run);throw e;}
  }
  return json({error:'Not found'},404);
 }
 const asset=ASSETS[url.pathname];if(asset&&request.method==='GET')return new Response(asset.body,{headers:{'Content-Type':asset.type+'; charset=utf-8','Cache-Control':'no-cache'}});
 return json({error:'Not found'},404);
 }catch(e){return json({error:e.message},502);}
}};
