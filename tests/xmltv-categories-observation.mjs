import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

// AIR-502: XMLTV <category> reaches the discovery candidate, the D1 observation
// payload, and the detail gate. A missing field and an empty array are the same
// missing-state: the scan does not invent a category. AIR-501 still refuses a
// concert recording whose title already carries a performance phrase.

function harness(){
 const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,TextDecoder,ReadableStream,Uint8Array,crypto:webcrypto,console,setTimeout});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js']){
  vm.runInContext(fs.readFileSync(file,'utf8'),live);
 }
 return live;
}

const live=harness();
const call=(expr)=>vm.runInContext(expr,live);
assert.equal(JSON.stringify(call("xmltvCategories('<programme><category>Концерт</category></programme>')")),JSON.stringify(['Концерт']));
assert.equal(JSON.stringify(call("xmltvCategories('<programme><category lang=\"en\">Music</category><category lang=\"ru\">Музыка</category></programme>')")),JSON.stringify(['Music','Музыка']));
assert.equal(JSON.stringify(call("xmltvCategories('<programme><category>Фильм</category><category>Фильм</category></programme>')")),JSON.stringify(['Фильм']));
assert.equal(JSON.stringify(call("xmltvCategories('<programme><category>  </category></programme>')")),JSON.stringify([]));
assert.equal(JSON.stringify(call("xmltvCategories('<programme></programme>')")),JSON.stringify([]));
assert.equal(JSON.stringify(call("xmltvCategories('')")),JSON.stringify([]));
const scanEPG=call('scanEPG');
const mergeDiscoveryCandidates=call('mergeDiscoveryCandidates');
const acceptScoredIdentity=call('acceptScoredIdentity');

const now=Date.now();
const stamp=ms=>{const d=new Date(ms);return d.toISOString().slice(0,19).replace(/[-T:]/g,'')+' +0000';};
const xml=`<tv><channel id="c1"><display-name>Кино</display-name></channel>
<programme start="${stamp(now)}" stop="${stamp(now+82*60000)}" channel="c1"><title>Robbie Williams: Live at the Apple Music Festival</title><category lang="ru">Концерт</category></programme>
<programme start="${stamp(now+3600000)}" stop="${stamp(now+3600000+96*60000)}" channel="c1"><title>Heat (1995)</title><category>Фильм</category></programme>
<programme start="${stamp(now+7200000)}" stop="${stamp(now+7200000+88*60000)}" channel="c1"><title>Stop Making Sense</title></programme>
<programme start="${stamp(now+10800000)}" stop="${stamp(now+10800000+100*60000)}" channel="c1"><title>Bare Title Without Category</title><category></category></programme>
</tv>`;
const scan=await scanEPG(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(xml));c.close();}}),[],now);
const byTitle=new Map(scan.discovery.map(item=>[item.title,item]));
const cats=item=>JSON.stringify(item.categories);
assert.equal(cats(byTitle.get('Robbie Williams: Live at the Apple Music Festival')),JSON.stringify(['Концерт']));
assert.equal(cats(byTitle.get('Heat')),JSON.stringify(['Фильм']));
assert.equal(cats(byTitle.get('Stop Making Sense')),JSON.stringify([]));
assert.equal(cats(byTitle.get('Bare Title Without Category')),JSON.stringify([]));

const previous=[{key:'heat|1995',title:'Heat',normalizedTitle:'heat',year:1995,duration:96,durations:[96],airings:1,firstAiring:now,lastAiring:now,shows:[]}];
const merged=mergeDiscoveryCandidates(previous,scan.discovery,{replaceShows:true,programmeRunId:'run-502'});
const heat=merged.find(item=>item.normalizedTitle==='heat');
assert.equal(JSON.stringify(heat.categories),JSON.stringify(['Фильм']));
const sense=merged.find(item=>item.normalizedTitle==='stop making sense');
assert.equal(JSON.stringify(sense.categories),JSON.stringify([]));

function movie(id,title,year,runtime,genres){
 return {authority:'tmdb_detail',tmdbId:String(id),evidence:{movie:{id:String(id),title,original:title,aliases:[],year,runtime,genres,genreIds:genres.map(g=>g.id)}}};
}
function observation(title,year,duration,categories){
 const parts=vm.runInContext('epgTitleParts('+JSON.stringify(title)+')',live);
 return {normalizedTitle:parts.normalizedTitle,year,durations:[duration],categories};
}
function bound(observation,detail,tmdbId,key){
 const score={status:'accepted',acceptedTmdbId:String(tmdbId),confidence:0.9,reason:'exact_title',observationKey:key};
 return acceptScoredIdentity({
  score,
  observationKey:key,
  pinnedProgrammeRunId:'run-502',
  observationProgrammeRunId:'run-502',
  discovery:{eligible:true,activity:'current',evidenceChanged:false},
  film:null,
  observation,
  competitors:[],
  tmdbDetail:detail,
  confirmation:null,
  appliedObservationKeys:[]
 });
}
const musicOnly=movie(1326142,'Robbie Williams: Live at the Apple Music Festival',2016,82,[{id:10402,name:'Музыка'}]);
const robbieObs=observation('Robbie Williams: Live at the Apple Music Festival',2016,82,['Концерт']);
assert.equal(bound(robbieObs,musicOnly,1326142,'robbie|2016').outcome,'candidate_decision');
assert.equal(bound(robbieObs,musicOnly,1326142,'robbie|2016').reason,'concert_recording');
assert.equal(bound(observation('Robbie Williams: Live at the Apple Music Festival',2016,82,[]),musicOnly,1326142,'robbie-empty|2016').reason,'concert_recording');
assert.equal(bound(observation('Robbie Williams: Live at the Apple Music Festival',2016,82,undefined),musicOnly,1326142,'robbie-absent|2016').reason,'concert_recording');
const fictionMusic=movie(88001,'Rhythm of the Road',2011,100,[{id:10402,name:'Music'}]);
assert.equal(bound(observation('Rhythm of the Road',2011,100,[]),fictionMusic,88001,'rhythm-empty|2011').outcome,'detail_verified');
assert.equal(bound(observation('Rhythm of the Road',2011,100,undefined),fictionMusic,88001,'rhythm-absent|2011').outcome,'detail_verified');
assert.equal(bound(observation('Heat',1995,96,['Фильм']),movie(949,'Heat',1995,96,[{id:18,name:'Drama'}]),949,'heat|1995').outcome,'detail_verified');

{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-air-502-'));
 const file=path.join(root,'d1.sqlite');
 const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
 const applied=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(applied.status!==0)throw new Error(applied.stderr||'migration failed');
 sqliteSync(['-bail',file],{input:"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1;",encoding:'utf8'});
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const lease=(await Authority.acquireLease(env,{programmeRunId:'run-502'})).lease;
 env.discoveryLease=lease;
 await Authority.ingestLedger(env,{programmeRunId:'run-502',handoff:true,lease,items:(async function*(){
  yield byTitle.get('Robbie Williams: Live at the Apple Music Festival');
  yield byTitle.get('Stop Making Sense');
 })()});
 const stored=(await Authority.routeRead(env,'epg/discovery-latest.json')).value.items;
 const concert=stored.find(item=>item.normalizedTitle==='robbie williams live at the apple music festival');
 const missing=stored.find(item=>item.normalizedTitle==='stop making sense');
 assert.equal(JSON.stringify(concert.categories),JSON.stringify(['Концерт']));
 assert.equal(JSON.stringify(missing.categories),JSON.stringify([]));
 await Authority.releaseLease(env,lease);
}

console.log('XMLTV categories observation: scan, merge, D1 payload and gate missing-state');
