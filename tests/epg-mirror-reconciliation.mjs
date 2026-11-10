// ADR 0108: GET never repairs published-EPG R2 mirrors; the existing hourly EpgOrchestration.ensure does.
// Offline only: D1 stand-in, MemoryBucket, no Cloudflare, no production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {publishGeneration,repairMirrors,writeMirrors,currentGeneration} from '../src/published-epg.js';
import {d1Standin} from './d1-standin.mjs';
import {MemoryBucket} from './memory-bucket.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-mirror-reconciliation-'));
const chain=fs.readdirSync('migrations').filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort();
let databases=0;
function open(){
 const db=d1Standin(path.join(root,'m'+(databases++)+'.sqlite'));
 for(const name of chain)db.sql(fs.readFileSync('migrations/'+name,'utf8'));
 db.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
 return db;
}
const film={id:'film:heat',title:'Heat',original:'Heat',year:1995,tmdbId:'949',shows:[]};
const programme={runId:'run-m',updatedAt:'2026-11-01T12:00:00.000Z',watchlistCount:1,films:[film]};
const watchlist={updatedAt:'2026-11-01T12:00:00.000Z',films:[film]};
async function published(db,bucket){
 const r=await publishGeneration({DB:db,BUCKET:bucket},{programmeRunId:'run-m',phase:'published',expectedProgrammeRunId:null,programme,watchlist},{now:0});
 assert.equal(r.pointed,true);
 assert.equal(await writeMirrors({DB:db,BUCKET:bucket},{programmeRunId:'run-m',programme,watchlist,phase:'published'}),true);
}
function tracking(bucket){
 const puts=[];
 return {puts,bucket:{
  async get(key){return bucket.get(key);},
  async put(key,value,options){puts.push(key);return bucket.put(key,value,options);},
 }};
}
function loadOrchestration(PublishedEpg){
 const context=vm.createContext({console,Date,Math,JSON,Promise,Intl,URL,crypto:webcrypto,PublishedEpg});
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy'),context);
 context.loadJSON=async()=>null;
 context.postSync=async()=>({status:200,json:async()=>({})});
 vm.runInContext(fs.readFileSync('src/epg-orchestration.js','utf8'),context);
 return vm.runInContext('EpgOrchestration',context);
}

{
 const worker=fs.readFileSync('src/worker.js','utf8');
 const admin=fs.readFileSync('src/admin/read.js','utf8');
 const orch=fs.readFileSync('src/epg-orchestration.js','utf8');
 assert.doesNotMatch(worker,/PublishedEpg\.repairMirrors\(/);
 assert.doesNotMatch(admin,/PublishedEpg\.repairMirrors\(/);
 assert.match(orch,/async function reconcileMirrors/);
 assert.match(orch,/PublishedEpg\.repairMirrors\(env\)/);
 assert.match(worker,/EpgOrchestration\.ensure\(env,/);
}

{
 const db=open();
 const inner=new MemoryBucket();
 await published(db,inner);
 const live=await currentGeneration({DB:db,BUCKET:inner});
 assert.equal(live.mirrors.aligned,true);
 assert.ok(live.mirrorWatchlistEtag);
 const {puts,bucket}=tracking(inner);
 const aligned=await repairMirrors({DB:db,BUCKET:bucket});
 assert.equal(aligned.aligned,true);
 assert.equal(aligned.wrote,false);
 assert.deepEqual(puts,[]);
}

{
 const db=open();
 const inner=new MemoryBucket();
 await published(db,inner);
 inner.objects.delete('programme.json');
 inner.objects.delete('watchlist.json');
 inner.objects.delete('epg/published-generation.json');
 const {puts,bucket}=tracking(inner);
 const first=await repairMirrors({DB:db,BUCKET:bucket});
 assert.equal(first.mirrored,true);
 assert.equal(first.wrote,true);
 assert.ok(puts.includes('programme.json'));
 assert.ok(puts.includes('watchlist.json'));
 const secondPuts=[];
 const secondBucket={async get(key){return inner.get(key);},async put(key,value,options){secondPuts.push(key);return inner.put(key,value,options);}};
 const second=await repairMirrors({DB:db,BUCKET:secondBucket});
 assert.equal(second.aligned,true);
 assert.equal(second.wrote,false);
 assert.deepEqual(secondPuts,[]);
}

{
 const db=open();
 const inner=new MemoryBucket();
 await published(db,inner);
 db.sql("UPDATE published_epg_authority SET cutover='held' WHERE id=1");
 const {puts,bucket}=tracking(inner);
 const held=await repairMirrors({DB:db,BUCKET:bucket});
 assert.equal(held.mirrored,false);
 assert.equal(held.reason,'held');
 assert.deepEqual(puts,[]);
}

{
 const db=open();
 const inner=new MemoryBucket();
 await published(db,inner);
 inner.objects.delete('programme.json');
 const generation=Number(Object.values(db.sql('SELECT generation FROM published_epg_authority WHERE id=1')[0])[0]);
 const raced={
  async get(key){return inner.get(key);},
  async put(key,value,options){
   if(key==='programme.json')db.sql('UPDATE published_epg_authority SET generation=generation+1');
   return inner.put(key,value,options);
  },
 };
 const fenced=await repairMirrors({DB:db,BUCKET:raced});
 assert.equal(fenced.mirrored,false);
 const after=Number(Object.values(db.sql('SELECT generation FROM published_epg_authority WHERE id=1')[0])[0]);
 assert.equal(after,generation+1);
}

{
 const db=open();
 const inner=new MemoryBucket();
 await published(db,inner);
 inner.objects.delete('watchlist.json');
 const PublishedEpg=await import('../src/published-epg.js');
 const epg=loadOrchestration(PublishedEpg);
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','"+JSON.stringify({schemaVersion:1,mode:'cloudflare',from:'external',target:null,epoch:1,drain:'verified'})+"',1,'x')");
 const {puts,bucket}=tracking(inner);
 const env={DB:db,BUCKET:bucket,EPG_WORKFLOW:{async create(){},async get(){return {status:async()=>({status:'complete'})};}}};
 const notDue=Date.parse('2026-11-07T15:00:00.000Z');
 const result=await epg.ensure(env,{now:notDue});
 assert.equal(result.started,false);
 assert.equal(result.reason,'not_due');
 assert.equal(result.mirrors.wrote,true);
 assert.ok(puts.includes('watchlist.json'));
 const alignedPuts=[];
 env.BUCKET={async get(key){return inner.get(key);},async put(key,value,options){alignedPuts.push(key);return inner.put(key,value,options);}};
 const again=await epg.ensure(env,{now:notDue});
 assert.equal(again.mirrors.aligned,true);
 assert.equal(again.mirrors.wrote,false);
 assert.deepEqual(alignedPuts,[]);
}

{
 const db=open();
 const inner=new MemoryBucket();
 await published(db,inner);
 inner.objects.delete('programme.json');
 const PublishedEpg=await import('../src/published-epg.js');
 const epg=loadOrchestration(PublishedEpg);
 const now=Date.parse('2026-11-07T15:00:00.000Z');
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','"+JSON.stringify({schemaVersion:1,mode:'cloudflare',from:'external',target:null,epoch:1,drain:'verified'})+"',1,'x')");
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder:'step-1',kind:'epg',modeRevision:1,acquiredAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),released:false})+"',1,'x')");
 const {puts,bucket}=tracking(inner);
 const skipped=await epg.reconcileMirrors({DB:db,BUCKET:bucket},{now});
 assert.equal(skipped.reason,'step_lease_live');
 assert.deepEqual(puts,[]);
}

{
 const db=open();
 const inner=new MemoryBucket();
 await published(db,inner);
 inner.objects.delete('programme.json');
 const PublishedEpg=await import('../src/published-epg.js');
 const epg=loadOrchestration(PublishedEpg);
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','"+JSON.stringify({schemaVersion:1,mode:'switching',from:'external',target:'cloudflare',epoch:1,drain:null})+"',1,'x')");
 const {puts,bucket}=tracking(inner);
 const skipped=await epg.reconcileMirrors({DB:db,BUCKET:bucket},{now:Date.parse('2026-11-07T15:00:00.000Z')});
 assert.equal(skipped.reason,'switch_in_progress');
 assert.deepEqual(puts,[]);
}

console.log('epg-mirror-reconciliation: ok');
