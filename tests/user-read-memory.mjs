// AIR-586: GET /api/programme, /api/enrichment/view, /api/catalog/available and /api/enrichment/footer/status each held the whole Discovery catalog (every
// admitted payload, parsed, beside its raw text), and the page asked the four of them at once: in one Worker isolate their memory added up past the limit and
// all four failed with 503 `exceededMemory` (docs/evidence/user-read-oom-rca-2026-11-23.md). The routes now keep only what they use, and the page reads them
// one after the other (tests/live-refresh.mjs). These checks prove that the projections change no answer:
//  1. on the GENERATED bundle (dist/server/index.js), a catalog with every case the readers distinguish (duplicate and mismatched identities, policy-excluded
//     documentaries and concerts, a Letterboxd id bridged to a TMDB id, title-exclusion namesakes, records without shows or from another run): the programme
//     presentation, the view's film map and the Finds answer (completed-only and record shows) are the same on the projected catalog as on the whole one;
//  2. the D1 catalog read applies a projection row by row, leaves out a film the projection answers `undefined` for, and is unchanged without one;
//  3. (non-functional) the production-sized reproduction (12,255 catalog films) answers the four routes one after the other within a heap the old reads exceeded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {nonFunctional} from './suite-gate.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-user-read-memory-'));
const plain=value=>JSON.parse(JSON.stringify(value));
const clone=value=>structuredClone(value);

// ---- 1. the projections on the generated bundle ----
const built=spawnSync(process.execPath,['build.mjs'],{encoding:'utf8'});
assert.equal(built.status,0,built.stderr);
const copy=path.join(root,'bundle.mjs');
fs.writeFileSync(copy,fs.readFileSync('dist/server/index.js','utf8')+'\nexport const __air586={observeUserRead,presentCatalogFilms,programmeCatalogProjection,projectCatalogObject,availableCatalogProjection,catalogAvailable,allEnrichmentFilms,projectGenreCatalog,GENRE_CATALOG_PROJECTION};\n');
const quiet=console.log;console.log=()=>{};
const {__air586:B}=await import(pathToFileURL(copy).href);
console.log=quiet;

const H=3600000,RUN='run-586',NOW=Date.parse('2026-11-23T18:00:00Z');
const show=(hours,channel='c')=>({channelId:channel,channel:channel.toUpperCase(),start:NOW+hours*H,end:NOW+hours*H+90*60000});
const person=(kind,n)=>({id:'tmdb_'+kind+'/'+n,name:kind+' '+n,original:kind+' '+n});
function record(i,extra={}){
 const tmdb=String(1000+i);
 const genres=i%10===3?['Documentary']:i%10===4?['Music']:i%10===6?['Drama','Comedy']:['Drama'];
 const synopsis=i%10===4?'A concert performance filmed live at the arena':i%10===7?'Ordinary story of a family':'A story of '+i;
 return {discoveredAt:'2026-11-01T00:00:00Z',id:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,url:'https://www.themoviedb.org/movie/'+tmdb,title:'Фильм '+i,original:'Original '+i,
  aliases:['Alias '+i],movieTitles:['Original '+i,'Фильм '+i],year:1990+i%20,genres,...(i%9===0?{genreIds:[18]}:{}),synopsis,runtime:80+i,poster:i%6===0?null:'https://image.tmdb.org/t/p/w342/p'+i+'.jpg',
  directors:[person('director',i)],actors:[person('actor',i),person('actor',i+1)],shows:i%4===0?[]:[show(i%30-12,'c'+i%3),show(i%30-6,'c'+(i+1)%3)],showsProgrammeRunId:i%5===0?'other-run':RUN,
  epgLastAiring:NOW,hotEnteredAt:null,...extra};
}
const catalog={};
for(let i=0;i<48;i++){const film=record(i);catalog[film.id]=film;}
// A second id of the same TMDB film (a Letterboxd lid admitted as a catalog record), a record whose stored identity disagrees with its TMDB id, and namesakes
// for the display title exclusion: two TMDB films with one original title in different years, an alias-only namesake, and a unique original title.
catalog['some-lid']=record(5,{id:'some-lid'});
catalog.tmdb_2000=record(20,{id:'tmdb_2000',tmdbId:'2000',canonicalIdentity:'tmdb:1'});
catalog.tmdb_3001=record(31,{id:'tmdb_3001',tmdbId:'3001',canonicalIdentity:'tmdb:3001',original:'Namesake',title:'Тёзка',year:2001});
catalog.tmdb_3002=record(33,{id:'tmdb_3002',tmdbId:'3002',canonicalIdentity:'tmdb:3002',original:'Namesake',title:'Тёзка 2',year:2010});
catalog.tmdb_3003=record(35,{id:'tmdb_3003',tmdbId:'3003',canonicalIdentity:'tmdb:3003',original:'Unique Title',title:'Уникальное',year:1999});
catalog.tmdb_3004=record(37,{id:'tmdb_3004',tmdbId:'3004',canonicalIdentity:'tmdb:3004',original:'Other',aliases:['Unique Title'],year:1999});
catalog.tmdb_3005=record(39,{id:'tmdb_3005',tmdbId:'3005',canonicalIdentity:'tmdb:3005',original:'Alone Here',title:'Один',year:2005});
// The completed programme: one member and catalog entries (some of a TMDB id the catalog does not hold, one whose identity the record contradicts).
const entry=(tmdb,hours)=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,shows:[show(hours,'k')]});
const catalogFilms=[];
for(let i=1;i<48;i+=2)catalogFilms.push(entry(1000+i,i%30-15));
catalogFilms.push(entry(3001,3),entry(3002,4),entry(3003,5),entry(3005,6),entry(9999,2),entry(2000,1),{...entry(1007,2),canonicalIdentity:'tmdb:7'});
const programme={runId:RUN,updatedAt:'2026-11-23T10:00:00Z',watchlistCount:1,films:[{id:'member-1',tmdbId:'1011',title:'Member',original:'Member',year:2000,genres:['Drama'],shows:[show(2,'m')]},{id:'wl-lid',tmdbId:'1013',title:'Lid',original:'Lid',year:2001,genres:['Drama'],shows:[]}],catalogFilms};
const watchlist={films:[{id:'member-1',tmdbId:'1011'},{id:'wl-lid',tmdbId:'1013',url:'https://letterboxd.com/film/lid/'}]};
const facet=n=>({fingerprintHash:'h'+n,fingerprint:{fingerprintHash:'h'+n,plotMechanics:['m'+n],moodLabels:[],execution:{pacing:'slow'}},prediction:{predictedRating:3+n%3/2,probability4Plus:.4,confidence:'medium',matchSignals:['s'],mainRisk:'r'}});
const index=Object.fromEntries(Object.keys(catalog).map((id,n)=>[id,facet(n)]));
index['some-lid']={watched:true};index.tmdb_1009={...index.tmdb_1009,actualRating:4};index['wl-lid']={watchlist:true};
const metadata={'wl-lid':{id:'wl-lid',tmdbId:'1013',url:'https://letterboxd.com/film/lid/',poster:'https://p.example/lid.jpg'},'other-lid':{id:'other-lid',tmdbId:'1015',url:'https://letterboxd.com/film/other/'}};
// A freshness rule that reads the film's genres, so a projection that lost them would change the answer.
const freshness={indexed:(item,film)=>!!item?.prediction&&(film?.genres||[]).includes('Drama')};

// 1a. the programme presentation
{
 const projection=B.programmeCatalogProjection(programme.catalogFilms);
 const kept=B.projectCatalogObject(clone(catalog),projection);
 assert.ok(Object.keys(kept).length<Object.keys(catalog).length,'the programme keeps only the films of its own entries');
 assert.ok(Object.values(kept).every(film=>programme.catalogFilms.some(item=>String(item.tmdbId)===String(film.tmdbId))));
 const whole=plain(B.presentCatalogFilms(clone(programme),clone(catalog))),projected=plain(B.presentCatalogFilms(clone(programme),kept));
 assert.ok(whole.catalogPart.presented>10&&whole.catalogPart.unpresented>0,'the fixture presents and refuses entries: '+JSON.stringify(whole.catalogPart));
 assert.deepEqual(projected,whole,'the programme presentation is unchanged');
 assert.deepEqual(plain(B.presentCatalogFilms(clone(programme),B.projectCatalogObject(null,projection))),plain(B.presentCatalogFilms(clone(programme),null)),'an unreadable catalog stays unavailable');
}
// 1b. the view's film map (the genres the freshness rule reads, the policy verdict, the identity dedupe)
{
 const projected=B.projectGenreCatalog(clone(catalog));
 assert.ok(Object.values(projected).every(film=>Object.keys(film).every(key=>['id','tmdbId','genres','genreIds'].includes(key))),'only id, TMDB id and genres are kept');
 assert.ok(Object.keys(projected).length<Object.keys(catalog).length,'policy-excluded films are left out');
 const map=films=>films.map(film=>[String(film.id),film.tmdbId??null,film.genres??null]);
 const whole=map(B.allEnrichmentFilms(clone(programme),clone(catalog))),kept=map(B.allEnrichmentFilms(clone(programme),projected));
 assert.ok(whole.length>20&&!whole.some(([id])=>id==='tmdb_1003'||id==='tmdb_1004'),'a documentary and a concert are excluded by the policy');
 assert.deepEqual(kept,whole,'the view keeps the same films with the same genres');
 assert.deepEqual(plain(B.projectGenreCatalog(projected)),plain(projected),'the projection is stable on its own output');
 assert.equal(B.GENRE_CATALOG_PROJECTION.project(catalog.tmdb_1004),undefined);
}
// 1c. Finds, completed-only (D1 published run) and record shows, with and without the title exclusion (both rule tags)
for(const completedOnly of [true,false])for(const exclusion of [{state:'unavailable',keys:null},{state:'applied',rule:'strict_original_exact_year',keys:new Set(['namesake\u00002001','unique title\u00001999','alone here\u00002005'])},{state:'applied',rule:'strict_original_exact_year_v2',keys:new Set(['namesake\u00002001','unique title\u00001999','alone here\u00002005'])}]){
 const input=films=>({catalog:films,programme:clone(programme),watchlist:clone(watchlist),index:clone(index),profile:{version:1},metadata:clone(metadata),programmeRunId:RUN,pinned:true,completedOnly,now:NOW,titleExclusion:exclusion,freshness,watchedMarkEnabled:true});
 const projection=B.availableCatalogProjection(programme,RUN,completedOnly);
 const kept=B.projectCatalogObject(clone(catalog),projection);
 assert.equal(Object.keys(kept).length,Object.keys(catalog).length,'every film stays for the identity bridge and the title exclusion');
 assert.ok(Object.values(kept).some(film=>!Object.hasOwn(film,'synopsis')),'a film that cannot be offered is kept as its skeleton');
 const whole=plain(B.catalogAvailable(input(clone(catalog)))),projected=plain(B.catalogAvailable(input(kept)));
 assert.ok(whole.films.length>3,'the fixture offers films: '+whole.films.length);
 if(exclusion.state==='applied')assert.ok(whole.displayExclusion.excluded>0,'the title exclusion hides a film');
 assert.deepEqual(projected,whole,'Finds is unchanged (completedOnly '+completedOnly+', exclusion '+(exclusion.rule||exclusion.state)+')');
}
// A programme of another run gives no completed shows: nothing airs, every film is a skeleton, and the answer is still the same (nothing offered).
{
 const other={...clone(programme),runId:'another'};
 const kept=B.projectCatalogObject(clone(catalog),B.availableCatalogProjection(other,RUN,true));
 assert.ok(Object.values(kept).every(film=>!Object.hasOwn(film,'shows')));
 const input=films=>({catalog:films,programme:clone(other),watchlist:clone(watchlist),index:clone(index),profile:{version:1},metadata:clone(metadata),programmeRunId:RUN,pinned:true,completedOnly:true,now:NOW,titleExclusion:{state:'unavailable',keys:null},freshness});
 assert.deepEqual(plain(B.catalogAvailable(input(kept))),plain(B.catalogAvailable(input(clone(catalog)))));
}

// 1d. a 503 the Worker answers itself on a user read names its refusal codes in one line, never a text, an id or a payload, and the answer is unchanged
{
 const lines=[],log=console.log;console.log=line=>lines.push(line);
 try{
  const refused=await B.observeUserRead(new Request('https://iptv.example/api/catalog/available'),new Response(JSON.stringify({error:'The catalog is not readable right now',code:'discovery_fence'}),{status:503,headers:{'Retry-After':'1'}}));
  assert.deepEqual(await refused.json(),{error:'The catalog is not readable right now',code:'discovery_fence'},'the answer is returned unchanged');
  await B.observeUserRead(new Request('https://iptv.example/api/enrichment/footer/status'),new Response(JSON.stringify({error:'identity_unavailable',reason:'tmdb_123 Секретный фильм'}),{status:503}));
  await B.observeUserRead(new Request('https://iptv.example/api/programme'),new Response(JSON.stringify({error:'Первое обновление ещё выполняется'}),{status:503}));
  await B.observeUserRead(new Request('https://iptv.example/api/enrichment/view'),new Response('not json',{status:503}));
  await B.observeUserRead(new Request('https://iptv.example/api/catalog/available'),new Response('{}',{status:200}));
  await B.observeUserRead(new Request('https://iptv.example/api/events'),new Response('{}',{status:503}));
  await B.observeUserRead(new Request('https://iptv.example/api/programme',{method:'POST'}),new Response('{}',{status:503}));
 }finally{console.log=log;}
 assert.deepEqual(lines.map(line=>JSON.parse(line)),[
  {event:'user_read_refused',path:'/api/catalog/available',status:503,code:'discovery_fence',reason:null,error:null,notReady:false,retryAfter:true},
  {event:'user_read_refused',path:'/api/enrichment/footer/status',status:503,code:null,reason:null,error:'identity_unavailable',notReady:false,retryAfter:false},
  {event:'user_read_refused',path:'/api/programme',status:503,code:null,reason:null,error:null,notReady:true,retryAfter:false},
  {event:'user_read_refused',path:'/api/enrichment/view',status:503,code:null,reason:null,error:null,notReady:false,retryAfter:false}
 ],'one line per refused user read; a reason that is not a code (an id, a title) is never logged; other statuses, paths and methods log nothing');
 assert.ok(!lines.join('\n').includes('tmdb_123')&&!lines.join('\n').includes('Секретный'));
}

// ---- 2. the D1 catalog read with a projection ----
{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().slice(0,11);
 const file=path.join(root,'discovery.sqlite');
 const migrated=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+"\nUPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1;",encoding:'utf8'});
 assert.equal(migrated.status,0,migrated.stderr);
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 const item={key:'obs-a',title:'Film a',normalizedTitle:'film a',year:2001,durations:[90],confirmedTmdbId:null,shows:[show(1)],seenInLatestSnapshot:true,lastAiring:NOW+H};
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){yield item;})()});
 const stored={tmdb_1001:record(1),tmdb_1002:record(2),tmdb_1003:record(3)};
 await Authority.upsertAdmissions(env,clone(stored),{lease:env.discoveryLease});
 const read=async options=>{const routed=await Authority.routeRead(env,'epg/discovered-films.json',options);assert.equal(routed.handled,true);return plain(routed.value);};
 const whole=await read(null);
 assert.deepEqual(Object.keys(whole).sort(),['tmdb_1001','tmdb_1002','tmdb_1003']);
 assert.equal(whole.tmdb_1002.synopsis,stored.tmdb_1002.synopsis,'without a projection the stored payloads, as before');
 const some=await read({project:film=>film.tmdbId==='1002'?undefined:{id:film.id,title:film.title}});
 assert.deepEqual(some,{tmdb_1001:{id:'tmdb_1001',title:'Фильм 1'},tmdb_1003:{id:'tmdb_1003',title:'Фильм 3'}},'a projection answering undefined leaves the film out');
 const genres=await read(B.GENRE_CATALOG_PROJECTION);
 assert.deepEqual(genres,plain(B.projectGenreCatalog(whole)),'the D1 projection equals the projection of the whole object');
 assert.deepEqual(Object.keys(genres).sort(),['tmdb_1001','tmdb_1002'],'the documentary is left out of the view catalog');
}

// ---- 3. production-sized reproduction (environment-dependent: nightly only) ----
// Production on 23 Nov 2026: 12,255 admitted catalog films. On the fixtures the four routes at once needed 125 MB of old space before AIR-586 (and failed in
// production, where the isolate limit of 128 MB also counts what is not old space); two rounds one after the other needed 96 MB. After AIR-586 they need 113 MB
// at once and 85 MB one after the other, as the page now asks them. 92 MB fails the old reads in either order and leaves the new ones about 7 MB of room.
nonFunctional('user-reads-memory-production-size',()=>{
 const script=path.resolve('scripts/footer-memory-profile.mjs'),fixtures=path.join(root,'fixtures');
 const build=spawnSync(process.execPath,['--no-warnings',script,'--build','--fixtures',fixtures],{encoding:'utf8',maxBuffer:1<<24,env:{...process.env,CATALOG:'12255'}});
 assert.equal(build.status,0,build.stderr);
 const paths='/api/programme,/api/enrichment/view,/api/catalog/available,/api/enrichment/footer/status';
 const run=spawnSync(process.execPath,['--no-warnings','--max-semi-space-size=1','--max-old-space-size=92',script,'--fixtures',fixtures,'--paths',paths,'--sequential','--requests','2','--freeze'],{encoding:'utf8',maxBuffer:1<<24,timeout:240000});
 assert.equal(run.status,0,run.stderr);
 const result=JSON.parse(run.stdout.trim().split('\n').at(-1));
 assert.deepEqual(result.statuses,Array(8).fill(200));
 assert.equal(result.writes,0);
});

fs.rmSync(root,{recursive:true,force:true});
console.log('User read memory: the programme, view and Finds answers are unchanged on the projected catalog, the D1 read leaves out what a projection drops, no writes passed');
