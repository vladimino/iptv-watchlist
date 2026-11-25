// AIR-488 production regression: the Worker bundle called slotScanConfirmation from
// DiscoveryAuthority.assignObservationSlots without injecting the name from SlotEvidence.
// A direct ES import of the authority never loads that scope, so this test runs the
// slice the build writes into dist/server/index.js.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

execFileSync(process.execPath,['build.mjs'],{stdio:'inherit'});
const bundle=fs.readFileSync('dist/server/index.js','utf8');
const start=bundle.indexOf('const OrchestrationPolicy=');
const end=bundle.indexOf('const LocalizationSources=');
assert.ok(start>0&&end>start,'the built Worker contains the Discovery authority scope');
const slice=bundle.slice(start,end);
assert.match(slice,/slotScanConfirmation/);
const world=vm.createContext({
 console,
 crypto:webcrypto,
 TextEncoder,
 TextDecoder,
 Date,
 Map,
 Set,
 JSON,
 Math,
 Number,
 String,
 Array,
 Object,
 Promise,
});
vm.runInContext(slice+'\nglobalThis.DiscoveryAuthority=DiscoveryAuthority;\n',world);
const Authority=world.DiscoveryAuthority;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-bundle-slot-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
const migrated=()=>{
 const file=path.join(root,'a-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
};
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const RUN='run-bundle',MIN=60000,START=Date.parse('2026-11-15T12:00:00Z');
const shows=(...items)=>items.map(([channelId,hours,minutes])=>({channelId,channel:'Channel '+channelId,start:START+hours*3600000,end:START+hours*3600000+minutes*MIN}));
const obs=(key,extra={})=>({key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[90],shows:shows(['c',1,90]),seenInLatestSnapshot:true,lastAiring:START+3600000,...extra});

async function setup(item){
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){yield item;})()});
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-15T10:00:00Z','x','2026-11-15T10:00:00Z')`);
 sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${RUN}','programme',0,'member-1')`);
 sql(file,`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${RUN}','programme',0,'${JSON.stringify({runId:RUN,films:[{id:'member-1',tmdbId:'101',shows:[]}]})}')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 const decision={status:'verified',filmId:'member-1',tmdbId:'101',canonicalIdentity:'tmdb:101',identitySource:'known_epg_alias',evidenceKey:Authority.evidenceKey(item)};
 await Authority.writeDecisionDelta(env,{[item.key]:{previous:null,next:decision}});
 return {file,env,start:item.shows[0].start};
}
const showCount=file=>sql(file,"SELECT COUNT(*) AS n FROM published_epg_show")[0].n;

{
 const item=obs('matched');
 const {file,env,start}=await setup(item);
 const payload=JSON.stringify({confirmedSlots:[{channelId:'c',start,tmdbId:'101'}]});
 sql(file,`UPDATE discovery_observation SET payload_json='${payload.replaceAll("'","''")}', confirmed_tmdb_id=NULL WHERE observation_key='matched'`);
 const result=await Authority.assignObservationSlots(env,{observationKey:'matched'});
 assert.equal(result.outcomes.assigned,1,'a confirmed slot of the verified identity is assigned from the built bundle');
 assert.equal(showCount(file),1);
}
{
 const item=obs('mismatched');
 const {file,env,start}=await setup(item);
 const payload=JSON.stringify({confirmedSlots:[{channelId:'c',start,tmdbId:'999'}]});
 sql(file,`UPDATE discovery_observation SET payload_json='${payload.replaceAll("'","''")}', confirmed_tmdb_id='101' WHERE observation_key='mismatched'`);
 const result=await Authority.assignObservationSlots(env,{observationKey:'mismatched'});
 assert.equal(result.outcomes.assigned,0);
 assert.equal(result.outcomes.evidence_drift,1,'a per-slot id that is not the decision does not fall back to the observation id');
 assert.equal(showCount(file),0);
}
{
 const item=obs('legacy');
 const {file,env}=await setup(item);
 sql(file,"UPDATE discovery_observation SET confirmed_tmdb_id='101' WHERE observation_key='legacy'");
 const stored=sql(file,"SELECT payload_json FROM discovery_observation WHERE observation_key='legacy'")[0].payload_json;
 assert.equal(Array.isArray(JSON.parse(stored).confirmedSlots),false);
 const result=await Authority.assignObservationSlots(env,{observationKey:'legacy'});
 assert.equal(result.outcomes.assigned,1,'a legacy observation without per-slot ids keeps the observation id');
 assert.equal(showCount(file),1);
}

console.log('discovery bundle slot scan: built Worker assigns a confirmed slot and refuses a mismatched one');
