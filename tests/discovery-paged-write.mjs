// D1 discovery writers for the paged chunk: decision delta (CAS, history, fence) and admission batches.
// Local sqlite stand-ins only. Nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-paged-write-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
export const migrated=()=>{
 const file=path.join(root,'w-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
};
export const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const RUN='run-write';
const obs=(key,extra={})=>({key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[100],shows:[{channelId:'c',channel:'C',start:Date.now()+3600000,end:Date.now()+3700000}],seenInLatestSnapshot:true,lastAiring:Date.now()+3600000,...extra});
const film=(tmdb,extra={})=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Film '+tmdb,...extra});

async function setup(keys=['obs-a','obs-b','obs-c']){
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){for(const key of keys)yield obs(key);})()});
 return {file,env,lease:taken.lease};
}
const decisionRow=(file,key)=>sql(file,`SELECT status, attempts, decision_hash, generation FROM discovery_decision WHERE observation_key='${key}'`)[0]||null;
const historyCount=(file,key)=>Number(sql(file,`SELECT COUNT(*) AS n FROM discovery_decision_history WHERE observation_key='${key}'`)[0].n);
const generation=file=>Number(sql(file,'SELECT generation FROM discovery_authority')[0].generation);
const uncertain=(extra={})=>({status:'no_confident_match',attempts:1,retryAt:'2026-12-01T00:00:00.000Z',...extra});

// 1. A decision delta writes only the named keys, with history, one generation step per key.
{
 const {file,env}=await setup();
 const g0=generation(file);
 const first=await Authority.writeDecisionDelta(env,{'obs-a':{previous:null,next:uncertain()}});
 assert.deepEqual(first,{written:['obs-a'],skipped:[]});
 assert.equal(decisionRow(file,'obs-a').status,'no_confident_match');
 assert.equal(historyCount(file,'obs-a'),1);
 assert.equal(generation(file),g0+1);
 assert.equal(decisionRow(file,'obs-b'),null,'a key that was not named is not written');
 const second=await Authority.writeDecisionDelta(env,{'obs-a':{previous:uncertain(),next:uncertain({attempts:2})},'obs-b':{previous:null,next:uncertain()}});
 assert.deepEqual(second.written,['obs-a','obs-b']);
 assert.equal(historyCount(file,'obs-a'),2);
 assert.equal(decisionRow(file,'obs-a').attempts,2);
 assert.equal(generation(file),g0+3);
 // The whole map is what a reader sees, and it still hashes.
 assert.equal(Object.keys((await Authority.routeRead(env,'epg/discovery-resolution.json')).value).length,2);
}

// 2. A decision changed since the chunk read it wins: the chunk skips that key and overwrites nothing.
{
 const {file,env}=await setup();
 await Authority.writeDecisionDelta(env,{'obs-a':{previous:null,next:uncertain()}});
 const owner={status:'verified',filmId:'tmdb_5',tmdbId:'5',identitySource:'owner'};
 sql(file,`UPDATE discovery_decision SET status='verified', decision_hash='owner-hash', payload_json='${JSON.stringify(owner)}' WHERE observation_key='obs-a'`);
 const before=historyCount(file,'obs-a'),g=generation(file);
 const result=await Authority.writeDecisionDelta(env,{'obs-a':{previous:uncertain(),next:uncertain({attempts:2})}});
 assert.deepEqual(result,{written:[],skipped:[{key:'obs-a',reason:'conflict'}]});
 assert.equal(decisionRow(file,'obs-a').decision_hash,'owner-hash');
 assert.equal(historyCount(file,'obs-a'),before,'a skipped key leaves no history');
 assert.equal(generation(file),g,'and no generation step');
 // A new key that somebody else already wrote is also a conflict.
 const taken=await Authority.writeDecisionDelta(env,{'obs-a':{previous:null,next:uncertain({attempts:3})}});
 assert.equal(taken.skipped[0].reason,'conflict');
}

// 3. Unchanged, vanished and evidence-changed keys are skipped; a write that landed and lost its answer counts as written.
{
 const {file,env}=await setup();
 await Authority.writeDecisionDelta(env,{'obs-a':{previous:null,next:uncertain()}});
 const same=await Authority.writeDecisionDelta(env,{'obs-a':{previous:uncertain(),next:uncertain()}});
 assert.deepEqual(same.skipped,[{key:'obs-a',reason:'unchanged'}]);
 const gone=await Authority.writeDecisionDelta(env,{'obs-missing':{previous:null,next:uncertain()}});
 assert.deepEqual(gone.skipped,[{key:'obs-missing',reason:'observation_gone'}]);
 const evidence=await Authority.writeDecisionDelta(env,{'obs-b':{previous:null,next:uncertain({evidenceKey:'not-this-evidence'})}});
 assert.deepEqual(evidence.skipped,[{key:'obs-b',reason:'evidence_changed'}]);
 assert.equal(decisionRow(file,'obs-b'),null);
 // The same write again with the old `previous` (a retry after a lost response): the row already holds it.
 const landed=await Authority.writeDecisionDelta(env,{'obs-c':{previous:null,next:uncertain()}});
 assert.deepEqual(landed.written,['obs-c']);
 const again=await Authority.writeDecisionDelta(env,{'obs-c':{previous:null,next:uncertain()}});
 assert.deepEqual(again,{written:['obs-c'],skipped:[]});
 assert.equal(historyCount(file,'obs-c'),1,'the retry adds no second history row');
}

// 4. A lease that is gone, expired or taken writes nothing, and the error says so; a held authority fails closed.
{
 const {file,env}=await setup();
 sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
 const g=generation(file);
 await assert.rejects(()=>Authority.writeDecisionDelta(env,{'obs-a':{previous:null,next:uncertain()}}),error=>error.code==='discovery_fence');
 assert.equal(decisionRow(file,'obs-a'),null);
 assert.equal(generation(file),g);
 await assert.rejects(()=>Authority.upsertAdmissions(env,{tmdb_1:film(1)}),error=>error.code==='discovery_fence');
 assert.equal(Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_admission')[0].n),0);
 sql(file,"UPDATE discovery_lease SET lease_id='other', expires_at="+(Date.now()+80000)+' WHERE id=1');
 await assert.rejects(()=>Authority.writeDecisionDelta(env,{'obs-a':{previous:null,next:uncertain()}}),error=>error.code==='discovery_fence');
 sql(file,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await assert.rejects(()=>Authority.writeDecisionDelta(env,{'obs-a':{previous:null,next:uncertain()}}),error=>error.code==='discovery_fence');
 const noLease=await setup();
 noLease.env.discoveryLease=null;
 await assert.rejects(()=>Authority.writeDecisionDelta(noLease.env,{'obs-a':{previous:null,next:uncertain()}}),error=>error.code==='discovery_lease');
 await assert.rejects(()=>Authority.writeDecisionDelta(noLease.env,{x:{previous:null,next:null}},{lease:noLease.lease}),error=>error.code==='discovery_conflict');
}

// 5. Admissions are upserted in batches; a film's identity belongs to one film id and is never merged.
{
 const {file,env}=await setup();
 const g=generation(file);
 const films={};
 for(let id=1;id<=45;id++)films['tmdb_'+id]=film(id);
 const result=await Authority.upsertAdmissions(env,films);
 assert.equal(result.written.length,45);
 assert.deepEqual(result.refused,[]);
 assert.equal(generation(file),g+1,'45 films are one packed batch: one round trip and one generation step');
 assert.equal(result.batches,1);assert.equal(result.reads,1);assert.deepEqual(result.carried,{generation:g+1,programmeRunId:result.carried.programmeRunId});
 assert.equal(Object.keys((await Authority.routeRead(env,'epg/discovered-films.json')).value).length,45);
 // An update to one film keeps the others.
 await Authority.upsertAdmissions(env,{tmdb_7:film(7,{title:'Renamed'})});
 const catalog=(await Authority.routeRead(env,'epg/discovered-films.json')).value;
 assert.equal(catalog.tmdb_7.title,'Renamed');
 assert.equal(Object.keys(catalog).length,45);
 // The same TMDB id under another film id is refused and the rest of its batch still lands.
 const mixed=await Authority.upsertAdmissions(env,{tmdb_100:film(100),dup_of_3:{...film(3),id:'dup_of_3'},tmdb_101:film(101)});
 assert.deepEqual(mixed.refused,[{filmId:'dup_of_3',reason:'identity_conflict'}]);
 assert.deepEqual(mixed.written.sort(),['tmdb_100','tmdb_101']);
 assert.equal(Object.keys((await Authority.routeRead(env,'epg/discovered-films.json')).value).length,47);
 // tv and movie ids are different identities.
 const tv=await Authority.upsertAdmissions(env,{tmdb_tv_3:{id:'tmdb_tv_3',tmdbId:'3',canonicalIdentity:'tmdb_tv:3',title:'Show 3',mediaType:'tv'}});
 assert.deepEqual(tv.written,['tmdb_tv_3']);
 // A film that is not a valid catalog record is a conflict before any write.
 await assert.rejects(()=>Authority.upsertAdmissions(env,{tmdb_9:{...film(9),canonicalIdentity:'tmdb:10'}}),error=>error.code==='discovery_conflict');
}
console.log('discovery paged write ok');
