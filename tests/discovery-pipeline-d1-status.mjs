// Pipeline and footer status on a D1 ledger larger than READ_CAP. The whole-document
// read stays paged with items null; status walks LEDGER_PAGE rows and reports the
// same counts as an in-memory ledgerCounts. Each page lookup binds at most BIND_CAP
// parameters (Cloudflare D1). Held stays on R2. Loading and a torn version-11 marker
// fail closed. READ_CAP is not raised.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {d1Standin} from './d1-standin.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-pipeline-status-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
const file=path.join(root,'status.sqlite');
const applied=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
if(applied.status!==0)throw new Error(applied.stderr||'migration failed');
const db=d1Standin(file,{maxBinds:Authority.BIND_CAP});
db.sql("UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='run-status', published_programme_run_id='run-status', generation=1 WHERE id=1");
db.sql("UPDATE discovery_transfer SET state='committed', programme_run_id='run-status', batches=1 WHERE id=1");

const now=Date.now(),H=3600000,D=86400000,RUN='run-status';
const show=start=>({channelId:'c',channel:'C',start,end:start+2*H});
const items=[],decisions={},catalog={};
for(let index=0;index<80;index++){
 const offset=[0,-48*H,-10*D,-100*D][index%4];
 const title=(index%20===0?'т/с Сериал ':'Фильм ')+index;
 const item={key:title.toLowerCase()+'|'+(1950+index%70),title,normalizedTitle:title.toLowerCase(),year:1950+index%70,durations:[100],shows:[show(now+offset)],lastAiring:now+offset,lastSeenAt:now+offset,seenInLatestSnapshot:index%4!==3,...(index%10===0?{confirmedTmdbId:String(900000+index)}:{})};
 items.push(item);
 const kind=index%7;
 if(kind===0){decisions[item.key]={status:'verified',tmdbId:String(100000+index)};catalog['tmdb_'+(100000+index)]={id:'tmdb_'+(100000+index),tmdbId:String(100000+index),title,canonicalIdentity:'tmdb:'+(100000+index),shows:[show(now)]};}
 else if(kind===1)decisions[item.key]={status:'verified',tmdbId:null};
 else if(kind===2)decisions[item.key]={status:'ambiguous'};
 else if(kind===3)decisions[item.key]={status:'no_confident_match',retryAt:new Date(now+D).toISOString()};
 else if(kind===4)decisions[item.key]={status:'no_confident_match',terminalReason:'repeated_uncertain_match',attempts:5,evidenceKey:[item.normalizedTitle,item.year,item.durations.join(','),`${item.shows[0].channelId}:${item.shows[0].start}`].join('|')};
}
const extras=36999-items.length;
for(let index=0;index<extras;index++){
 items.push({key:'wide-'+String(index).padStart(5,'0'),title:'Wide '+index,normalizedTitle:'wide '+index,year:1990,durations:[90],shows:[],seenInLatestSnapshot:false,lastSeenAt:1,lastAiring:1});
}

const esc=value=>"'"+String(value).replaceAll("'","''")+"'";
const observationSql=item=>`(${esc('active')},${esc(item.key)},${esc('active')},${esc(RUN)},${esc(item.normalizedTitle)},${esc(item.title)},${item.year},${esc('')},${item.seenInLatestSnapshot?1:0},${esc(String(item.lastSeenAt||1))},${Number.isFinite(item.lastAiring)?item.lastAiring:'NULL'},${item.confirmedTmdbId?esc(item.confirmedTmdbId):'NULL'},${esc(JSON.stringify(item))})`;
for(let index=0;index<items.length;index+=200){
 db.sql('INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES '+items.slice(index,index+200).map(observationSql).join(','));
}
for(const item of items){
 if(!item.shows?.length)continue;
 db.sql('INSERT INTO discovery_observation_show (source_key, observation_key, ordinal, channel_id, channel, start_ms, end_ms) VALUES '+item.shows.map((row,ordinal)=>`(${esc('active')},${esc(item.key)},${ordinal},${esc(row.channelId)},${esc(row.channel)},${row.start},${row.end})`).join(','));
}
let revision=1;
for(const [key,decision] of Object.entries(decisions)){
 const text=JSON.stringify(decision);
 db.sql(`INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES (${esc(key)},${esc(RUN)},1,${esc(decision.status||'')},${Number.isInteger(decision.attempts)?decision.attempts:'NULL'},${decision.evidenceKey?esc(decision.evidenceKey):'NULL'},${decision.terminalReason?esc(decision.terminalReason):'NULL'},${decision.retryAt?esc(decision.retryAt):'NULL'},${decision.tmdbId==null?'NULL':esc(String(decision.tmdbId))},NULL,NULL,${esc('hash-'+revision)},${esc(text)})`);
 revision++;
}
for(const film of Object.values(catalog)){
 db.sql(`INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES (${esc(film.id)},${esc(String(film.tmdbId))},${esc('movie')},${esc(film.canonicalIdentity)},NULL,${esc(RUN)},1,'current',${esc(JSON.stringify(film))})`);
}
db.sql(`INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES (${esc('archive:old')},${esc('archived-only')},${esc('archive')},${esc(RUN)},'a','A',1990,'',0,1,NULL,NULL,'{}')`);
db.sql(`INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES (${esc('active')},${esc('wide-00000-foreign')},${esc('archive')},${esc(RUN)},'f','F',1990,'',0,1,NULL,NULL,'{}')`);
db.sql(`INSERT INTO discovery_observation_show (source_key, observation_key, ordinal, channel_id, channel, start_ms, end_ms) VALUES (${esc('active')},${esc('wide-00000-foreign')},0,'c','C',1,2)`);
db.sql(`INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES (${esc('wide-00000-foreign')},${esc(RUN)},1,'verified',NULL,NULL,NULL,NULL,'1',NULL,NULL,'hash-foreign','{"status":"verified","tmdbId":"1"}')`);

const bucket=new MemoryBucket();
bucket.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:RUN}));
bucket.put('programme.json',JSON.stringify({runId:RUN,films:[]}));
bucket.put('epg/discovery-latest.json',JSON.stringify({programmeRunId:'r2-stale',items:[]}));
bucket.put('epg/discovery-resolution.json',JSON.stringify({}));
bucket.put('epg/discovered-films.json',JSON.stringify({}));
const env={DB:db,BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test'};
const live=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,ReadableStream,Uint8Array,crypto:webcrypto,console:{log(){},error(){},warn(){}},setTimeout,structuredClone,fetch:async()=>{throw new Error('status makes no request');},DiscoveryAuthority:Authority});
for(const name of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(name,'utf8').replace('export default','globalThis.worker='),live);
}

assert.throws(
 ()=>db.prepare('SELECT 1 WHERE id IN ('+Array.from({length:Authority.BIND_CAP+1},()=>'?').join(',')+')').bind(...Array.from({length:Authority.BIND_CAP+1},()=>1)),
 error=>/too many SQL variables/.test(String(error.message))
);
assert.match(fs.readFileSync('src/discovery-authority.js','utf8'),/const READ_CAP=20000/);
assert.equal(Authority.LEDGER_PAGE,500);
assert.equal(Authority.BIND_CAP,100);
assert.doesNotMatch(fs.readFileSync('src/discovery-authority.js','utf8'),/observation_key IN \(\$\{/);
const paged=await Authority.routeRead(env,'epg/discovery-latest.json');
assert.equal(paged.value.paged,true);
assert.equal(paged.value.itemCount,36999);
assert.equal(paged.value.items,null);
assert.deepEqual(paged.value.archive,{source:'d1',d1:{archiveOnlyRows:2,unreferencedRows:0,segmentRows:0}});
assert.equal(paged.value.ledgerMode,'unknown','D1 does not store the mode of a generation');

const expected=vm.runInContext('ledgerCounts({programmeRunId:args.run,ledgerMode:"unknown",archive:args.archive,items:args.items},args.decisions,args.now)',Object.assign(live,{args:{run:RUN,archive:paged.value.archive,items,decisions,now}}));
const statuses={},confirmed=new Set();
for(const item of items){const decision=decisions[item.key];if(decision){statuses[decision.status]=(statuses[decision.status]||0)+1;if(decision.status==='verified')confirmed.add(String(decision.tmdbId));}}

const origin='https://iptv.vladimino.workers.dev';
const pipeline=await (await live.worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),env,{waitUntil(){}})).json();
assert.equal(pipeline.ledgerTotal,expected.ledgerTotal);
// AIR-427: no completed seal names this generation, so nothing proves its mode or its R2 archive. The two D1 archive rows are
// reported as D1 rows and are not added to the total as if they were the archive.
assert.equal(pipeline.candidates,36999);
assert.equal(pipeline.ledgerTotal,36999);
assert.equal(pipeline.ledgerTotalScope,'active_only');
assert.deepEqual(pipeline.archive,{ledgerMode:'unknown',ledgerModeSource:'unavailable',ledgerModeReason:'seal_record_unavailable',activeItems:36999,activeSource:'d1',uniqueArchivedItems:null,manifestId:null,segments:null,items:null,bytes:null,archiveSource:'unavailable',d1:{archiveOnlyRows:2,unreferencedRows:0,segmentRows:0}});
assert.equal(pipeline.currentUnresolved,expected.currentUnresolved);
assert.equal(pipeline.readyNow,expected.readyNow);
assert.equal(pipeline.rejectedNonfilm,expected.rejectedNonfilm);
assert.equal(pipeline.historicalUnresolved,expected.historicalUnresolved);
assert.equal(pipeline.expiredInactive,expected.expiredInactive);
assert.equal(pipeline.verifiedFilms,Object.keys(catalog).length);
assert.equal(pipeline.confirmedFilms,confirmed.size);
assert.deepEqual(pipeline.statuses,statuses);
assert.notEqual(pipeline.ledgerTotal,0);
assert.ok(db.calls.queries<=1000,`status used ${db.calls.queries} D1 reads`);
const walked=new Set();
const walk=await Authority.streamActiveLedger(env,(item)=>{
 assert.notEqual(item.key,'wide-00000-foreign');
 assert.equal(walked.has(item.key),false);
 walked.add(item.key);
});
assert.equal(walk.handled,true);
assert.equal(walk.itemCount,36999);
assert.equal(walked.size,36999);

const footer=await (await live.worker.fetch(new Request(origin+'/api/enrichment/footer/status'),env,{waitUntil(){}})).json();
assert.equal(footer.epgTmdb.ledgerTotal,expected.ledgerTotal);
assert.equal(footer.epgTmdb.pendingRecognition,expected.currentUnresolved);

db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");
const held=await (await live.worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),env,{waitUntil(){}})).json();
assert.equal(held.candidates,0);
assert.equal(held.ledgerTotal,0);
assert.equal(held.programmeRunId,'r2-stale');

db.sql("UPDATE discovery_authority SET cutover='open' WHERE id=1");
db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
const loading=await live.worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),env,{waitUntil(){}});
assert.equal(loading.status,502);
assert.equal((await loading.json()).error,'discovery_incomplete');

db.sql("UPDATE discovery_transfer SET state='committed' WHERE id=1");
db.sql("DROP TABLE discovery_score");
await assert.rejects(()=>Authority.readAuthority(env),error=>error.code==='discovery_unavailable');
const torn=await live.worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),env,{waitUntil(){}});
assert.equal(torn.status,502);
assert.equal((await torn.json()).error,'discovery_unavailable');
