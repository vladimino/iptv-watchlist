// AIR-297 (ADR 0057): the runtime integration of the TMDB TV identity, end to end through the built Worker bundle. parseFilm
// keeps the typed Letterboxd TMDB link through the metadata refresh; the lifecycle reader applies the optional
// identity/tmdb-retirements.json; the ADR 0056 enrichment projector carries the corrected identity to D1 and holds, rather
// than writes, anything under review. Synthetic records, a memory bucket and a sqlite3 D1 stand-in only: no network, no R2,
// no production D1, and the retirements object is written only into the memory bucket.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {CONFIRMED_RETIREMENTS,RETIREMENTS_KEY,buildPlan,d1Holders,d1Readback,d1State,loadDomain,sqliteReader} from '../scripts/tmdb-tv-identity-plan.mjs';

assert.equal(spawnSync(process.execPath,['build.mjs'],{stdio:'ignore'}).status,0);
const logs=[],pages=new Map();
let fetched=[];
const context=vm.createContext({
 console:{log:line=>{try{logs.push(JSON.parse(line));}catch{logs.push(line);}},warn(){},error(){}},
 Response,Request,Headers,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,structuredClone,setTimeout,clearTimeout,atob,btoa,
 fetch:async url=>{
  const href=String(url);fetched.push(href);
  if(pages.has(href))return new Response(pages.get(href),{status:200});
  if(href.startsWith('https://letterboxd.com/'))return new Response('',{status:404});
  return new Response(JSON.stringify({results:{bindings:[]}}),{status:200,headers:{'content-type':'application/json'}});
 }
});
vm.runInContext(fs.readFileSync('dist/server/index.js','utf8').replace(/^export default \{/m,'globalThis.worker={').replace(/^export const /gm,'const ')+'\nglobalThis.api={parseFilm,metadataSync,runD1EnrichmentProjection,LifecycleReader,EnrichmentProjection,catalogReady,displayReady,TMDB_RETIREMENTS_KEY};',context);
const api=context.api;
assert.equal(api.TMDB_RETIREMENTS_KEY,RETIREMENTS_KEY);
const plain=value=>JSON.parse(JSON.stringify(value));
const NOW=Date.now(),OLD='2020-01-01T00:00:00.000Z',T='2026-10-30T00:00:00.000Z';

// Movie-only consumers read the records' tmdbId, which keeps the movie number Letterboxd shows; none of them learns tmdb_tv.
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js','src/letterboxd-facts.js','src/catalog-d1.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/tmdb_tv|TMDB_TV_SCHEME/,file);
assert.doesNotMatch(fs.readFileSync('src/d1-enrichment.js','utf8'),/\bBUCKET\.(put|delete|list)\b/,'the projector never writes or lists R2');

// 1. parseFilm keeps the typed link beside the unchanged attribute number; a record written before carries no field.
const SERIES=CONFIRMED_RETIREMENTS.map(item=>({...item,slug:new URL(item.letterboxdUrl).pathname.split('/')[2]}));
const credit=(role,key)=>({id:role+'/'+key,name:key,original:key});
const page=({name,tmdbType='movie',tmdbId,links,director,actor})=>`<html><head><meta name="description" content="Synopsis of ${name}.">
<script type="application/ld+json">/* <![CDATA[ */${JSON.stringify({name,director:[{name:director,sameAs:'/director/'+director+'/'}],actor:[{name:actor,sameAs:'/actor/'+actor+'/'}],genre:['Drama'],duration:'PT5H0M'})}/* ]]> */</script></head>
<body class="film" data-tmdb-type="${tmdbType}" data-tmdb-id="${tmdbId}">${links.map(link=>`<a href="https://www.themoviedb.org/${link}/" class="micro-button track-event">TMDB</a>`).join('')}</body></html>`;
const seriesPage=(item,patch={})=>page({name:'Series '+item.lid,tmdbId:item.movieId,links:['tv/'+item.tvId],director:'d-'+item.lid.toLowerCase(),actor:'a-'+item.lid.toLowerCase(),...patch});
{
 const parsed=api.parseFilm(seriesPage(SERIES[0]),{id:'1IUo',title:'Series 1IUo',url:SERIES[0].letterboxdUrl});
 assert.equal(parsed.tmdbId,'17266','the attribute number is still the record tmdbId');
 assert.deepEqual(plain(parsed.tmdbLink),{status:'review',reason:'link_disagrees_with_attributes',link:{type:'tv',id:'9687'},links:[{type:'tv',id:'9687'}],attributes:{types:['movie'],ids:['17266']}});
 assert.equal(api.parseFilm(page({name:'Heat',tmdbId:'949',links:['movie/949'],director:'michael-mann',actor:'al-pacino'}),{id:'heat'}).tmdbLink.status,'resolved');
}

// The R2 records as the Worker keeps them. The four miniseries and Heat are on the watchlist; movie 9687 is an unrelated
// catalog Film whose number equals the TV id of film:1IUo. The records start without tmdbLink, as written before AIR-297.
const seriesRecord=item=>({id:item.lid,title:'Series '+item.lid,original:'Series '+item.lid,year:1990,tmdbId:item.movieId,url:item.letterboxdUrl,directors:[credit('director','d-'+item.lid.toLowerCase())],actors:[credit('actor','a-'+item.lid.toLowerCase())],peopleVersion:1,peopleNamesVersion:2,metadataAt:OLD,synopsis:'Synopsis',synopsisFetchedAt:OLD,runtime:300});
const HEAT={id:'heat',title:'Heat',original:'Heat',year:1995,tmdbId:'949',url:'https://letterboxd.com/film/heat/',directors:[credit('director','michael-mann')],actors:[credit('actor','al-pacino')],peopleVersion:1,peopleNamesVersion:2,metadataAt:OLD,synopsis:'Synopsis',synopsisFetchedAt:OLD,runtime:170};
const MOVIE_9687={id:'tmdb_9687',tmdbId:'9687',title:'Movie 9687',original:'Movie 9687',year:2001,discoveredAt:T,synopsis:'Overview',directors:[credit('tmdb_director','77')],actors:[credit('tmdb_actor','78')]};
function store(bucket,films,{catalog={tmdb_9687:MOVIE_9687},resolution={c9687:{status:'verified',tmdbId:'9687',filmId:'tmdb_9687'}}}={}){
 const put=(key,value)=>bucket.objects.set(key,{text:JSON.stringify(value),customMetadata:{}});
 put('watchlist.json',{updatedAt:T,films});
 put('epg/generations/run-1/programme.json',{updatedAt:T,runId:'run-1',films:films.map(film=>({...film,shows:[]}))});
 put('metadata.json',Object.fromEntries(films.map(film=>[film.id,film])));
 put('titles.json',{});put('people.json',{});
 put('epg/discovery-resolution.json',resolution);
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/discovered-films.json',catalog);
 bucket.objects.delete('sync.json');
 return bucket;
}
const records=()=>[...SERIES.map(seriesRecord),HEAT];
const bucket=store(new MemoryBucket(),records());
const counted={get:0,list:0,put:0,delete:0,keys:[]};
for(const method of ['get','list','put','delete']){const original=bucket[method].bind(bucket);bucket[method]=async(...args)=>{counted[method]++;if(method==='get')counted.keys.push(args[0]);return original(...args);};}
const r2Snapshot=()=>JSON.stringify([...bucket.objects].filter(([key])=>key!=='sync.json'&&key!=='metadata.json'&&key!=='titles.json'&&key!=='people.json').sort());

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-tmdb-tv-runtime-')),file=path.join(root,'d1.sqlite');
let failNext=null;
const db=d1Standin(file,{onBatch:statements=>{if(failNext&&statements.some(item=>item.text.includes(failNext))){failNext=null;throw new Error('D1_ERROR: synthetic crash');}}});
for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
// Every projector run only reads R2: no put, delete or listing, whatever the object holds.
const run=async(mode='on',env={})=>{
 const before=counted.put+counted.delete+counted.list;
 const summary=plain(await api.runD1EnrichmentProjection({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:mode,...env},{now:NOW}));
 assert.equal(counted.put+counted.delete+counted.list,before,'the projector writes and lists nothing in R2');
 return summary;
};
const reader=sqliteReader(file);
const ids=SERIES.map(item=>item.filmId);
const kept=()=>['film_person_credit','prediction_current','actual_rating','film_redirect','watchlist_film','person'].map(table=>[table,db.sql(`SELECT * FROM ${table} ORDER BY 1,2`).map(row=>JSON.stringify(row))]);
const identityRows=id=>db.sql(`SELECT scheme,value,trusted FROM film_external_id WHERE film_id='${id}' AND scheme IN ('tmdb','tmdb_tv') ORDER BY scheme`).map(row=>row.scheme+':'+row.value+':'+row.trusted);
const canonical=id=>db.sql(`SELECT canonical_identity c FROM film WHERE id='${id}'`)[0]?.c;
const view=(retirements)=>{
 const lean=api.EnrichmentProjection.enrichmentStore({watchlist:JSON.parse(bucket.objects.get('watchlist.json').text),programme:JSON.parse(bucket.objects.get('epg/generations/run-1/programme.json').text),metadata:JSON.parse(bucket.objects.get('metadata.json').text),titles:{},people:{},discoveredFilms:JSON.parse(bucket.objects.get('epg/generations/run-1/discovered-films.json').text),discoveryResolution:JSON.parse(bucket.objects.get('epg/discovery-resolution.json').text),tmdbRetirements:retirements});
 return {lean,view:api.LifecycleReader.readLifecycle(lean,NOW,{entitiesOnly:true})};
};
const keysOf=({lean,view})=>api.EnrichmentProjection.enrichmentInputs({view,store:lean}).films.map(entry=>entry.id+'='+api.EnrichmentProjection.filmChangeKey(entry,new Date(NOW).toISOString()));

// 2. Absent object: off reads nothing; on projects the uncorrected identity with one GET of the key and no listing, and the
// view carries no retirement report.
{
 assert.deepEqual({...await run('off')},{mode:'off',skipped:'off'});
 assert.equal(counted.get,0);
 const first=await run();
 assert.equal(first.outcome,'complete');assert.equal(first.tmdbRetirements,undefined);
 assert.equal(counted.keys.filter(key=>key===RETIREMENTS_KEY).length,1);assert.equal(counted.list+counted.put+counted.delete,0);
 for(const item of SERIES){assert.equal(canonical(item.filmId),'tmdb:'+item.movieId);assert.deepEqual(identityRows(item.filmId),['tmdb:'+item.movieId+':1']);}
 assert.equal(canonical('film:tmdb:9687'),'tmdb:9687');
 assert.equal(Object.hasOwn(view(null).view,'tmdbRetirements'),false);
}
// D1-only rows the correction must leave alone: the AIR-286 TMDB credits, a prediction, a rating, a redirect.
db.sql(`INSERT INTO profile_version VALUES (1,'h','${T}','k','s');
INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:tmdb_actor/501','tmdb_actor/501',1,'${T}'),('person:tmdb_director/502','tmdb_director/502',1,'${T}');
${SERIES.map(item=>`INSERT INTO film_person_credit VALUES ('${item.filmId}','person:tmdb_actor/501','actor',1),('${item.filmId}','person:tmdb_director/502','director',1);
INSERT INTO prediction_current (film_id,taste_profile_version,predicted_rating,updated_at) VALUES ('${item.filmId}',1,4.0,'${T}');
INSERT INTO actual_rating VALUES ('${item.filmId}',4.5,'letterboxd','${T}');`).join('\n')}
INSERT INTO film_redirect VALUES ('film:old-1IUo','film:1IUo','${T}')`);
const preserved=kept();
// Unchanged R2 is a no-op.
{const batches=db.calls.batches,again=await run();assert.deepEqual([again.outcome,again.changedFilms,again.writtenFilms],['complete',0,0]);assert.equal(db.calls.batches,batches);}

// 3. The metadata refresh re-parses the stale pages: the typed link reaches metadata.json, the run's watchlist and so the
// watchlist and programme records; the Film change keys do not move for it, so an inert deploy writes nothing for the field.
const keysBefore=keysOf(view(null));
async function refresh(pagesFor){
 pages.clear();for(const item of SERIES)pages.set(item.letterboxdUrl,pagesFor(item));
 pages.set(HEAT.url,page({name:'Heat',tmdbId:'949',links:['movie/949'],director:'michael-mann',actor:'al-pacino'}));
 const watchlist=JSON.parse(bucket.objects.get('watchlist.json').text).films.map(film=>({...film,metadataAt:OLD}));
 const syncRun={runId:'sync-1',watchlist,pending:watchlist.map(film=>film.id),cursor:0,remaining:watchlist.length,failures:[],events:[]};
 fetched=[];
 const step=await api.metadataSync({BUCKET:bucket},syncRun);
 assert.equal(step.failedMetadata,0);
 assert.ok(fetched.every(href=>href.startsWith('https://letterboxd.com/')||!href.includes('themoviedb')),'no TMDB request');
 // finishSync writes the run's films to watchlist.json without their shows; the EPG commit carries them into the programme.
 const films=syncRun.watchlist.map(({shows,...film})=>film);
 const put=(key,value)=>bucket.objects.set(key,{text:JSON.stringify(value),customMetadata:{}});
 put('watchlist.json',{updatedAt:new Date().toISOString(),films});
 put('epg/generations/run-1/programme.json',{updatedAt:new Date().toISOString(),runId:'run-1',films:films.map(film=>({...film,shows:[]}))});
 return {syncRun,films};
}
{
 const {syncRun}=await refresh(item=>seriesPage(item));
 const metadata=JSON.parse(bucket.objects.get('metadata.json').text);
 for(const item of SERIES){
  assert.deepEqual(plain(metadata[item.lid].tmdbLink.links),[{type:'tv',id:item.tvId}]);assert.equal(metadata[item.lid].tmdbId,item.movieId);
  assert.deepEqual(plain(syncRun.watchlist.find(film=>film.id===item.lid).tmdbLink.attributes.ids),[item.movieId]);
 }
 assert.ok(JSON.parse(bucket.objects.get('epg/generations/run-1/programme.json').text).films.every(film=>film.tmdbLink));
 // The refresh left sync.json in its EPG stage: the projector waits for the writer.
 {const result=await run();assert.deepEqual([result.outcome,result.reason],['deferred','writer_active']);}
 bucket.objects.delete('sync.json');
 const stripped=view(null);
 for(const film of [...stripped.lean.watchlist.films,...stripped.lean.programme.films,...Object.values(stripped.lean.metadata)])delete film.tmdbLink;
 assert.deepEqual(plain(keysOf(view(null))),plain(keysOf({lean:stripped.lean,view:api.LifecycleReader.readLifecycle(stripped.lean,NOW,{entitiesOnly:true})})),'tmdbLink never moves a change key');
 assert.notDeepEqual(plain(keysOf(view(null))),plain(keysBefore),'the refreshed metadata does');
 const refreshed=await run();
 assert.equal(refreshed.outcome,'complete');
 for(const item of SERIES)assert.equal(canonical(item.filmId),'tmdb:'+item.movieId,'without the object the refresh changes no identity');
}
const preservedAfterRefresh=kept();

// 4. The planner's R2 body, from the D1 state and an AIR-286-shaped artifact. Before the object exists D1 is pending.
const artifact=path.join(root,'air286');fs.mkdirSync(path.join(artifact,'tmdb'),{recursive:true});
for(const item of SERIES){
 fs.writeFileSync(path.join(artifact,'tmdb',item.movieId+'.json'),JSON.stringify({tmdbId:item.movieId,kind:'movie',fetchedAt:'2026-10-30T09:44:00.000Z',status:404,letterboxd:{url:item.letterboxdUrl,checkedAt:'2026-10-30T10:33:00.000Z',status:200,links:['tv/'+item.tvId]}}));
 fs.writeFileSync(path.join(artifact,'tmdb','tv-'+item.tvId+'.json'),JSON.stringify({tmdbId:item.tvId,kind:'tv',fetchedAt:'2026-10-30T10:15:00.000Z',response:{id:Number(item.tvId),original_name:'Series '+item.lid}}));
}
const domain=loadDomain();
const planOnce=async()=>{const state=await d1State(reader,ids);return buildPlan({domain,artifactDir:artifact,films:state.films,holders:await d1Holders(reader,SERIES.flatMap(item=>[item.movieId,item.tvId])),preserved:state.preserved,at:T});};
const plan=await planOnce();
assert.deepEqual(plan.totals,{films:4,ready:4,unchanged:0,ownerReview:0,refused:0});
assert.deepEqual((await d1Readback(reader,plan)).map(item=>item.state),['pending','pending','pending','pending']);
const BODY=plan.r2Retirements.body;
const putRetirements=body=>bucket.objects.set(RETIREMENTS_KEY,{text:typeof body==='string'?body:JSON.stringify(body),customMetadata:{}});

// 5. dry with the object: the diff is computed and reported, nothing is written.
putRetirements(BODY);
{
 const batches=db.calls.batches,dry=await run('dry');
 assert.deepEqual([dry.outcome,dry.changedFilms,plain(dry.tmdbRetirements)],['dry',4,{valid:true,applied:4,held:[],reasons:[]}]);
 assert.equal(db.calls.batches,batches);
}

// 6. A crash in one Film's batch writes nothing for it; the next run finishes it. Then all four are corrected.
{
 failNext="'film:3tCe'";
 const partial=await run();
 assert.equal(partial.outcome,'partial');assert.equal(partial.writtenFilms,3);assert.deepEqual(partial.errors.map(item=>item.id),['film:3tCe']);
 assert.equal(canonical('film:3tCe'),'tmdb:101915','the failed batch rolled back whole');
 const retry=await run();
 assert.deepEqual([retry.outcome,retry.writtenFilms,retry.changedFilms],['complete',1,1]);
 assert.deepEqual((await d1Readback(reader,plan)).map(item=>item.state),['corrected','corrected','corrected','corrected']);
 for(const item of SERIES){
  assert.equal(canonical(item.filmId),'tmdb_tv:'+item.tvId);
  assert.deepEqual(identityRows(item.filmId),['tmdb:'+item.movieId+':0','tmdb_tv:'+item.tvId+':1']);
 }
 // The lid, the Film id, the slug alias, credits (both sources), prediction, rating and redirect are untouched.
 assert.deepEqual(kept(),preservedAfterRefresh);
 assert.deepEqual(db.sql(`SELECT scheme,value FROM film_external_id WHERE film_id='film:1IUo' AND scheme LIKE 'letterboxd%' ORDER BY scheme`).map(row=>row.scheme+':'+row.value),['letterboxd:1IUo','letterboxd_slug:the-odyssey']);
 // Movie 9687 keeps its own identity and credits, and none of them reach the miniseries.
 assert.deepEqual([canonical('film:tmdb:9687'),identityRows('film:tmdb:9687')],['tmdb:9687',['tmdb:9687:1']]);
 assert.equal(db.sql(`SELECT COUNT(*) n FROM film_person_credit WHERE film_id='film:1IUo' AND person_id IN ('person:tmdb_director/77','person:tmdb_actor/78')`)[0].n,0);
}
const corrected=kept();

// 7. Repeats are no-ops: an unchanged R2 writes nothing, and a new plan finds every Film already done.
{
 const batches=db.calls.batches,again=await run();
 assert.deepEqual([again.outcome,again.changedFilms,again.writtenFilms,again.tmdbRetirements.applied],['complete',0,0,4]);
 assert.equal(db.calls.batches,batches);
 const replan=await planOnce();
 assert.deepEqual(replan.totals,{films:4,ready:4,unchanged:4,ownerReview:0,refused:0});
 assert.deepEqual(plain(replan.films.map(item=>item.d1Expected)),plain(plan.films.map(item=>item.d1Expected)));
}

// 8. The view: the corrected Film keeps its Letterboxd identity and readiness, never trusts a TMDB movie id, does not pull
// the catalog record of movie 9687 into its credits, and reports the numeric overlap without acting on it.
{
 const {lean,view:corrected}=view(BODY);
 const odyssey=corrected.films.find(film=>film.id==='film:1IUo');
 assert.equal(odyssey.canonicalIdentity,'tmdb_tv:9687');
 assert.equal(odyssey.externalIds.some(item=>item.scheme==='tmdb'&&item.trusted),false);
 assert.equal(api.catalogReady(odyssey),true);assert.equal(api.displayReady(odyssey),true);
 assert.deepEqual(plain(api.EnrichmentProjection.recordsFor(lean,odyssey).map(record=>String(record.id)).sort()),['1IUo','1IUo','1IUo']);
 assert.deepEqual(plain(corrected.tmdbRetirements.numericOverlaps),[{value:'9687',tvFilms:['film:1IUo'],movieFilms:['film:tmdb:9687']}]);
 assert.deepEqual(plain(corrected.tmdbRetirements.applied),ids);
}

// 9. A metadata refresh after the correction keeps it: the records still say movie 17266, and the projection still retires it.
{
 await refresh(item=>seriesPage(item));
 bucket.objects.delete('sync.json');
 const after=await run();
 assert.equal(after.outcome,'complete');assert.equal(after.tmdbRetirements.applied,4);
 assert.deepEqual((await d1Readback(reader,plan)).map(item=>item.state),['corrected','corrected','corrected','corrected']);
 assert.deepEqual(kept(),corrected);
}

// 10. A page that changes is review, not a fix. The Film is held: D1 keeps it as it is, and it is neither written nor released.
const held=async(pagesFor,expected)=>{
 await refresh(pagesFor);bucket.objects.delete('sync.json');
 const result=await run();
 assert.equal(result.outcome,'complete',JSON.stringify(result));
 assert.deepEqual(plain(result.tmdbRetirements.held),expected);
 assert.deepEqual((await d1Readback(reader,plan)).map(item=>item.state),['corrected','corrected','corrected','corrected']);
 assert.equal(db.sql(`SELECT change_key k FROM projection_state WHERE kind='film' AND id='film:3tCe'`)[0].k==='absent',false);
 return result;
};
await held(item=>item.lid==='3tCe'?seriesPage(item,{links:['tv/9999']}):seriesPage(item),[{filmId:'film:3tCe',reason:'link_changed'}]);
await held(item=>item.lid==='3tCe'?seriesPage(item,{links:['tv/8042','movie/101915']}):seriesPage(item),[{filmId:'film:3tCe',reason:'link_changed'}]);
await held(item=>item.lid==='3tCe'?seriesPage(item,{tmdbId:'555'}):seriesPage(item),[{filmId:'film:3tCe',reason:'attributes_changed'}]);
// Letterboxd fixing its attributes to the TV entry makes the record's tmdbId the TV number: held, and that number never
// reaches D1 as a trusted movie id.
await held(item=>item.lid==='3tCe'?seriesPage(item,{tmdbType:'tv',tmdbId:'8042'}):seriesPage(item),[{filmId:'film:3tCe',reason:'attributes_changed'}]);
assert.equal(db.sql(`SELECT COUNT(*) n FROM film_external_id WHERE scheme='tmdb' AND value='8042'`)[0].n,0);
await refresh(item=>seriesPage(item));bucket.objects.delete('sync.json');
assert.equal((await run()).tmdbRetirements.held.length,0);

// 11. A second Film still trusting a retired movie id holds both, and an entry naming another movie id is refused.
{
 const catalog={tmdb_9687:MOVIE_9687,tmdb_101915:{...MOVIE_9687,id:'tmdb_101915',tmdbId:'101915',title:'Movie 101915',original:'Movie 101915'}};
 const resolution={c9687:{status:'verified',tmdbId:'9687',filmId:'tmdb_9687'},c101915:{status:'verified',tmdbId:'101915',filmId:'tmdb_101915'}};
 bucket.objects.set('epg/generations/run-1/discovered-films.json',{text:JSON.stringify(catalog),customMetadata:{}});
 bucket.objects.set('epg/discovery-resolution.json',{text:JSON.stringify(resolution),customMetadata:{}});
 const {view:both}=view(BODY);
 assert.deepEqual(plain(both.tmdbRetirements.held),[{filmId:'film:3tCe',reason:'retired_movie_on_other_film'},{filmId:'film:tmdb:101915',reason:'retired_movie_on_other_film'}]);
 assert.equal(both.films.find(film=>film.id==='film:3tCe').canonicalIdentity,'tmdb:101915','the held Film is left as the records build it');
 const result=await run();
 assert.equal(result.outcome,'complete');
 assert.equal(canonical('film:tmdb:101915'),undefined,'the held catalog Film is not written either');
 assert.equal(canonical('film:3tCe'),'tmdb_tv:8042');
 bucket.objects.set('epg/generations/run-1/discovered-films.json',{text:JSON.stringify({tmdb_9687:MOVIE_9687}),customMetadata:{}});
 bucket.objects.set('epg/discovery-resolution.json',{text:JSON.stringify({c9687:{status:'verified',tmdbId:'9687',filmId:'tmdb_9687'}}),customMetadata:{}});
 // The page evidence is checked first: the records saw movie 378779, not the entry's. Without that evidence (records
 // written before AIR-297) the Film itself refuses the entry.
 const other={...BODY,retirements:BODY.retirements.map(entry=>entry.filmId==='film:daU4'?{...entry,movieId:'378780'}:entry)};
 assert.deepEqual(plain(view(other).view.tmdbRetirements.held),[{filmId:'film:daU4',reason:'attributes_changed'}]);
 {const {lean}=view(null);for(const film of [...lean.watchlist.films,...lean.programme.films,...Object.values(lean.metadata)])delete film.tmdbLink;
  assert.deepEqual(plain(api.LifecycleReader.readLifecycle({...lean,tmdbRetirements:other},NOW,{entitiesOnly:true}).tmdbRetirements.held),[{filmId:'film:daU4',reason:'movie_id_mismatch'}]);
  const old=api.LifecycleReader.readLifecycle({...lean,tmdbRetirements:BODY},NOW,{entitiesOnly:true});
  assert.deepEqual([plain(old.tmdbRetirements.applied),old.films.find(film=>film.id==='film:1IUo').canonicalIdentity],[ids,'tmdb_tv:9687'],'records without tmdbLink are corrected too');}
 const missing={...BODY,retirements:[...BODY.retirements,{...BODY.retirements[0],filmId:'film:Zz9',lid:'Zz9',movieId:'1',tvId:'2',evidence:{...BODY.retirements[0].evidence,link:'tv/2',tvResponseId:'2'}}]};
 assert.deepEqual(plain(view(missing).view.tmdbRetirements.held),[{filmId:'film:Zz9',reason:'film_missing'}]);
 assert.equal((await run()).changedFilms,0);
}

// 12. An invalid object fails closed: the run stops before any D1 write and names the key. A changed object defers the run.
{
 const invalid=[
  ['not json','{'],['an array',[]],['schema version',{...BODY,schemaVersion:2}],['no list',{schemaVersion:1}],
  ['confirmation',{...BODY,retirements:BODY.retirements.map((entry,index)=>index?entry:{...entry,confirmation:{...entry.confirmation,by:'agent'}})}],
  ['evidence link',{...BODY,retirements:BODY.retirements.map((entry,index)=>index?entry:{...entry,evidence:{...entry.evidence,link:'tv/1'}})}],
  ['duplicate film',{...BODY,retirements:[...BODY.retirements,BODY.retirements[0]]}],
  ['two Films, one TV id',{...BODY,retirements:[BODY.retirements[0],{...BODY.retirements[1],tvId:'9687',evidence:{...BODY.retirements[1].evidence,link:'tv/9687',tvResponseId:'9687'}}]}],
  ['lid mismatch',{...BODY,retirements:BODY.retirements.map((entry,index)=>index?entry:{...entry,lid:'1IUp'})}]
 ];
 for(const [label,body] of invalid){
  putRetirements(body);
  const batches=db.calls.batches,result=await run();
  assert.deepEqual([result.outcome,result.reason,result.inputKey],['failed','input_invalid',RETIREMENTS_KEY],label);
  assert.equal(db.calls.batches,batches,label);
  assert.deepEqual(kept(),corrected,label);
 }
 putRetirements(BODY);
 const get=bucket.get;
 bucket.get=async key=>{const object=await get(key);if(key===RETIREMENTS_KEY)putRetirements({...BODY,retirements:BODY.retirements.slice(1)});return object;};
 {const batches=db.calls.batches,result=await run();assert.deepEqual([result.outcome,result.reason,result.inputKey],['deferred','input_changed',RETIREMENTS_KEY]);assert.equal(db.calls.batches,batches);}
 bucket.get=get;putRetirements(BODY);
}

// 13. Rollback: removing the object puts the records' identity back on the next run, and the other D1 rows stay.
{
 bucket.objects.delete(RETIREMENTS_KEY);
 const back=await run();
 assert.deepEqual([back.outcome,back.writtenFilms,back.tmdbRetirements],['complete',4,undefined]);
 assert.deepEqual((await d1Readback(reader,plan)).map(item=>item.state),['pending','pending','pending','pending']);
 assert.deepEqual(kept(),corrected);
 // An object that appears during a run defers it.
 const get=bucket.get;
 bucket.get=async key=>{const object=await get(key);if(key===RETIREMENTS_KEY)putRetirements(BODY);return object;};
 {const batches=db.calls.batches,result=await run();assert.deepEqual([result.outcome,result.reason,result.inputKey],['deferred','input_changed',RETIREMENTS_KEY]);assert.equal(db.calls.batches,batches);}
 bucket.get=get;
}
assert.deepEqual(preserved.filter(([table])=>table!=='film_person_credit'&&table!=='person'),corrected.filter(([table])=>table!=='film_person_credit'&&table!=='person'));
fs.rmSync(root,{recursive:true,force:true});
console.log('tmdb-tv-runtime: ok');
