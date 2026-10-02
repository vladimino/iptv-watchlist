const SOURCES={epg:'https://example.invalid/epg.xml',watchlist:'https://letterboxd.com/demo-user/watchlist/'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const loadJSON=async(env,key)=>{const o=await env.BUCKET.get(key);return o?o.json():null;};
const saveJSON=(env,key,value)=>env.BUCKET.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'}});
async function beginSync(env){
 const current=await loadJSON(env,'sync.json');if(current&&['metadata','epg'].includes(current.stage)&&Date.now()-Date.parse(current.updatedAt)<15*60000)return {runId:current.runId,stage:current.stage,remaining:current.remaining};
 let url=SOURCES.watchlist,pages=0,total=null;const films=new Map();
 while(url){const p=parseWatchlist(await getHTML(url));pages++;if(pages>100)throw new Error('Watchlist pagination limit exceeded');if(!Number.isInteger(p.total))throw new Error('Watchlist total not found');if(total===null)total=p.total;if(total!==p.total)throw new Error('Watchlist changed during synchronization; retry');if(p.films.length===0&&total>0)throw new Error('Watchlist page has no films');for(const f of p.films){if(films.has(f.id))throw new Error('Duplicate film across pages; retry');films.set(f.id,f);}if(p.next&&!/^\/demo-user\/watchlist\/page\/\d+\/$/.test(p.next))throw new Error('Unexpected pagination URL');url=p.next?'https://letterboxd.com'+p.next:null;}
 if(films.size!==total)throw new Error(`Incomplete watchlist: ${films.size}/${total}`);
 const verify=parseWatchlist(await getHTML(SOURCES.watchlist));if(verify.total!==total||verify.films.some((f,i)=>f.id!==[...films.values()][i]?.id))throw new Error('Watchlist changed during synchronization; retry');
 const cache=await loadJSON(env,'metadata.json')||{};const all=[...films.values()].map(f=>cache[f.id]?{...cache[f.id],...f,aliases:cache[f.id].aliases}:f);const pending=all.filter(f=>!f.metadataAt||f.peopleVersion!==1||f.peopleNamesVersion!==2||Date.now()-Date.parse(f.metadataAt)>30*86400000).map(f=>f.id);
 const run={runId:crypto.randomUUID(),startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),stage:pending.length?'metadata':'epg',watchlist:all,pending,cursor:0,remaining:pending.length,pages,failures:[]};await saveJSON(env,'sync.json',run);return {runId:run.runId,stage:run.stage,watchlistCount:total,pages,remaining:run.remaining};
}
async function metadataSync(env,run){
 const cache=await loadJSON(env,'metadata.json')||{};const ids=run.pending.slice(run.cursor,run.cursor+12);
 for(let i=0;i<ids.length;i+=3)await Promise.all(ids.slice(i,i+3).map(async id=>{const idx=run.watchlist.findIndex(f=>f.id===id);try{if(run.watchlist[idx].peopleVersion===1&&run.watchlist[idx].metadataAt&&Date.now()-Date.parse(run.watchlist[idx].metadataAt)<30*86400000)return;const result=parseFilm(await getHTML(run.watchlist[idx].url),run.watchlist[idx]);cache[id]=result;run.watchlist[idx]=result;}catch(e){run.failures.push({id,error:e.message});}}));
 const people=await loadJSON(env,'people.json')||{};const batch=run.watchlist.filter(f=>ids.includes(f.id)&&f.peopleVersion===1);
 try{await localizePeople(batch,people);for(const f of batch){f.peopleLocalizedAt=new Date().toISOString();f.peopleNamesVersion=2;}}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 for(const f of batch)cache[f.id]=f;
 await saveJSON(env,'people.json',people);
 run.cursor+=ids.length;run.remaining=run.pending.length-run.cursor;run.stage=run.remaining?'metadata':'epg';run.updatedAt=new Date().toISOString();await saveJSON(env,'metadata.json',cache);await saveJSON(env,'sync.json',run);return {runId:run.runId,stage:run.stage,remaining:run.remaining,failedMetadata:run.failures.length,localizationErrors:run.localizationErrors||0,russianNames:Object.keys(people).length};
}
async function epgSync(env,run){
 const people=await loadJSON(env,'people.json')||{};
 try{await localizeByLetterboxd(run.watchlist,people);await saveJSON(env,'people.json',people);}catch(e){run.localizationErrors=(run.localizationErrors||0)+1;}
 for(const f of run.watchlist)for(const p of [...(f.directors||[]),...(f.actors||[])])if(people[p.id])p.name=people[p.id].name;
 const now=Date.now(),r=await fetch(SOURCES.epg,{signal:AbortSignal.timeout(110000)});if(!r.ok)throw new Error('EPG HTTP '+r.status);const result=await scanEPG(r.body,run.watchlist,now);if(result.stats.epgEnd<now-72*3600000)throw new Error('EPG does not cover the current window');
 const previous=await loadJSON(env,'programme.json');const fresh=new Map(result.films.map(f=>[f.id,f]));const currentFilms=new Map(run.watchlist.map(f=>[f.id,f]));const channelMin=new Map(result.coverage.map(c=>[c.name,c.min]));
 for(const old of previous?.films||[]){if(!currentFilms.has(old.id))continue;const historical=old.shows.filter(s=>s.start>=now-72*3600000&&s.start<now&&s.start<(channelMin.get(s.channel)??Infinity));if(!historical.length)continue;const target=fresh.get(old.id)||{...currentFilms.get(old.id),title:old.title,shows:[]};const keys=new Set(target.shows.map(s=>`${s.channelId}:${s.start}`));target.shows.push(...historical.filter(s=>!keys.has(`${s.channelId}:${s.start}`)));fresh.set(old.id,target);}
 const films=[...fresh.values()].map(f=>({...f,shows:f.shows.sort((a,b)=>a.start-b.start)}));const countShows=films.reduce((n,f)=>n+f.shows.length,0);
 const report={updatedAt:new Date(now).toISOString(),watchlistUpdatedAt:run.startedAt,cutoff:now,window:{from:now-72*3600000,to:now+24*3600000},watchlistCount:run.watchlist.length,watchlistPages:run.pages,films,people:peopleCatalog(run.watchlist),stats:{...result.stats,broadcasts:countShows,uniqueFilms:films.length,metadataMissing:run.watchlist.filter(f=>!f.metadataAt).length,peopleMissing:run.watchlist.filter(f=>f.peopleVersion!==1).length,peopleFilms:run.watchlist.filter(f=>f.peopleVersion===1).length,channels:result.coverage.length,futureFullChannels:result.coverage.filter(c=>c.max>=now+24*3600000).length},sources:SOURCES,archiveVerified:false};
 await saveJSON(env,'watchlist.json',{updatedAt:report.updatedAt,films:run.watchlist});await saveJSON(env,'programme.json',report);await saveJSON(env,'uncertain.json',{updatedAt:report.updatedAt,items:result.uncertain});run.stage='complete';run.updatedAt=new Date().toISOString();delete run.watchlist;delete run.pending;await saveJSON(env,'sync.json',run);return {runId:run.runId,stage:run.stage,updatedAt:report.updatedAt,watchlistCount:report.watchlistCount,...report.stats};
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 try{
 if(url.pathname.startsWith('/api/')){
  if(!env.BUCKET)return json({error:'Storage unavailable'},503);
  if(request.method==='POST'&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'Origin not allowed'},403);
  if(url.pathname==='/api/programme'&&request.method==='GET'){const data=await loadJSON(env,'programme.json');return data?json(data):json({error:'Первое обновление ещё выполняется'},503);}
  if(url.pathname==='/api/watchlist'&&request.method==='GET')return json(await loadJSON(env,'watchlist.json')||{films:[]});
  if(url.pathname==='/api/status'&&request.method==='GET'){const run=await loadJSON(env,'sync.json');return json(run?{runId:run.runId,stage:run.stage,updatedAt:run.updatedAt,remaining:run.remaining,failures:run.failures?.length,error:run.error}: {stage:'not_started'});}
  if(url.pathname==='/api/sync/start'&&request.method==='POST')return json(await beginSync(env));
  if(['/api/sync/metadata','/api/sync/epg'].includes(url.pathname)&&request.method==='POST'){
   const body=await request.json();const run=await loadJSON(env,'sync.json');if(!run||body.runId!==run.runId)return json({error:'Run id mismatch'},409);
   if(url.pathname.endsWith('metadata')){if(run.stage!=='metadata')return json({runId:run.runId,stage:run.stage,remaining:run.remaining});return json(await metadataSync(env,run));}
   if(run.stage==='complete')return json({runId:run.runId,stage:run.stage});if(run.stage!=='epg')return json({error:'Metadata stage is not complete'},409);
   try{return json(await epgSync(env,run));}catch(e){run.error=e.message;run.updatedAt=new Date().toISOString();await saveJSON(env,'sync.json',run);throw e;}
  }
  return json({error:'Not found'},404);
 }
 const asset=ASSETS[url.pathname];if(asset&&request.method==='GET')return new Response(asset.body,{headers:{'Content-Type':asset.type+'; charset=utf-8','Cache-Control':'no-cache'}});
 return json({error:'Not found'},404);
 }catch(e){return json({error:e.message},502);}
}};
