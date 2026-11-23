import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const state=await mkdtemp(path.join(tmpdir(),'iptv-local-dev-'));
const configPath=path.join(state,'local-dev.json');
await writeFile(configPath,'{"snapshot":""}\n');
const port=await freePort();
let child;
try{
 const first=await boot('first');
 assert.match(first.logs,/Imported \d+ dummy objects/);
 assert.match(first.logs,/Local D1 at schema version \d+: \d+ migrations, \d+ synthetic rows, generation local-fixture published/);
 await assertFixtureSite(port);
 await stop(child);
 child=null;
 await waitForPortFree(port);
 const second=await boot('second');
 assert.match(second.logs,/Local R2 and D1 already have the dummy catalog/);
 assert.doesNotMatch(second.logs,/Imported \d+ dummy objects/);
 await assertFixtureSite(port);
 await stop(child);
 child=null;
 await waitForPortFree(port);
 // A store built from an older migration chain (the marker names another one) is imported again, not served.
 const markerFile=path.join(state,'stores/fixtures/iptv-snapshot.json');
 const marker=JSON.parse(await readFile(markerFile,'utf8'));
 assert.match(marker.migrations,/^[0-9a-f]{64}$/);
 await writeFile(markerFile,JSON.stringify({...marker,migrations:'an-older-chain'}));
 const third=await boot('third');
 assert.match(third.logs,/Imported \d+ dummy objects/);
 await assertFixtureSite(port);
 await stop(child);
 child=null;
 await waitForPortFree(port);
 // --refresh deletes the selected store (R2 and D1) and imports it again; the site is whole afterwards.
 const fourth=await boot('fourth',['--refresh']);
 assert.match(fourth.logs,/Imported \d+ dummy objects/);
 await assertFixtureSite(port);
}finally{
 if(child)await stop(child);
 await rm(state,{recursive:true,force:true});
}
console.log('Local dev smoke: Wrangler fixture GETs on a real local D1 and R2, a second start without import, a stale-migration import and --refresh passed');

function boot(label,args=[]){
 return new Promise((resolve,reject)=>{
  const logs={text:''};
  child=spawn(process.execPath,[path.join(root,'scripts/local-dev.mjs'),...args],{
   cwd:root,
   detached:true,
   stdio:['ignore','pipe','pipe'],
   env:{...process.env,IPTV_DEV_PORT:String(port),IPTV_LOCAL_STATE:state,IPTV_LOCAL_CONFIG:configPath,WRANGLER_SEND_METRICS:'false'},
  });
  const current=child;
  const timer=setTimeout(()=>{finish(new Error(`${label} start timed out\n${tail(logs.text)}`));},180000);
  const onData=chunk=>{logs.text+=chunk;if(logs.text.length>200000)logs.text=logs.text.slice(-100000);};
  current.stdout.on('data',onData);
  current.stderr.on('data',onData);
  current.on('exit',code=>{if(code)finish(new Error(`${label} dev server exited ${code}\n${tail(logs.text)}`));});
  (async()=>{
   try{
    await waitForProgramme(port);
    const startedAt=Date.now();
    while(Date.now()-startedAt<5000&&!/Imported \d+ dummy objects|Local R2 and D1 already have the dummy catalog/.test(logs.text))await new Promise(resolve=>setTimeout(resolve,50));
    finish(null,logs.text);
   }catch(error){finish(error);}
  })();
  function finish(error,logsText){
   clearTimeout(timer);
   if(error)reject(error);
   else resolve({logs:logsText});
  }
 });
}
async function assertFixtureSite(currentPort){
 const programme=await getJson(currentPort,'/api/programme');
 assert.deepEqual(programme.films.map(film=>film.title),['Movie1','Movie2','Movie3']);
 assert.deepEqual((await getJson(currentPort,'/api/watchlist')).films.map(film=>film.title),['Movie1','Movie2','Movie3']);
 const started=await getJson(currentPort,'/api/started');
 assert.deepEqual(started.ids,['movie-1']);
 // AIR-576: the view, Finds, footer and the admin reads are answered from the local D1 (no 502/503, no raw object).
 const view=await getJson(currentPort,'/api/enrichment/view');
 assert.equal(view.profile.version,1);
 assert.deepEqual(Object.keys(view.films).sort(),['movie-1','movie-2']);
 assert.equal(view.films['movie-1'].actualRating,4.5);
 assert.equal(view.films['movie-1'].fingerprint.execution.pace,'fast');
 assert.equal(view.films['movie-2'].prediction.predictedRating,4);
 assert.equal(view.films['movie-2'].prediction.stale,false);
 const available=await getJson(currentPort,'/api/catalog/available');
 assert.equal(available.programmeRunId,'local-fixture');
 assert.equal(available.pinned,true);
 const footer=await getJson(currentPort,'/api/enrichment/footer/status');
 assert.deepEqual([footer.profile.version,footer.collection.state,footer.collection.total,footer.collection.watched,footer.collection.rated],[1,'ok',3,1,1]);
 const events=await getJson(currentPort,'/api/events');
 assert.deepEqual(events.events.map(event=>event.type).sort(),['epg','started','unstarted','watchlist']);
 const overview=await getJson(currentPort,'/api/admin/overview');
 assert.equal(overview.snapshot.programmeRunId,'local-fixture');
 assert.deepEqual(overview.counts,{films:3,people:3});
 assert.equal(overview.queues.find(item=>item.kind==='film'&&item.code==='localization-provisional').count,1);
 const films=await getJson(currentPort,'/api/admin/films?q=movie');
 assert.deepEqual(films.items.map(item=>[item.id,item.identity.status]),[['film:movie-1','resolved'],['film:movie-2','unresolved'],['film:movie-3','unresolved']]);
 assert.equal((await getJson(currentPort,'/api/admin/people?q=actor')).items.length,2);
 assert.equal((await getJson(currentPort,'/api/admin/health')).snapshot.programmeRunId,'local-fixture');
 await getJson(currentPort,'/api/admin/limbo');
 assert.deepEqual((await getJson(currentPort,'/api/ui/filter-presets')).presets,[]);
}
async function getJson(currentPort,pathname){
 const response=await fetch(`http://127.0.0.1:${currentPort}${pathname}`);
 assert.equal(response.status,200,pathname);
 return response.json();
}
async function waitForProgramme(currentPort){
 const started=Date.now();
 let last='';
 while(Date.now()-started<170000){
  try{
   const response=await fetch(`http://127.0.0.1:${currentPort}/api/programme`);
   if(response.ok)return;
   last=`HTTP ${response.status}`;
  }catch(error){last=error.message;}
  await new Promise(resolve=>setTimeout(resolve,300));
 }
 throw new Error(`Timed out waiting for /api/programme: ${last}`);
}
function stop(current){
 return new Promise(resolve=>{
  const timer=setTimeout(()=>{try{process.kill(-current.pid,'SIGKILL');}catch{}},5000);
  current.once('exit',()=>{clearTimeout(timer);resolve();});
  try{process.kill(-current.pid,'SIGTERM');}catch{clearTimeout(timer);resolve();}
 });
}
function waitForPortFree(currentPort){
 const started=Date.now();
 return new Promise((resolve,reject)=>{
  const attempt=()=>{
   const server=createServer();
   server.once('error',()=>{
    if(Date.now()-started>10000)reject(new Error(`Port ${currentPort} stayed busy`));
    else setTimeout(attempt,100);
   });
   server.listen(currentPort,'127.0.0.1',()=>server.close(resolve));
  };
  attempt();
 });
}
function freePort(){
 return new Promise((resolve,reject)=>{
  const server=createServer();
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{
   const {port:value}=server.address();
   server.close(()=>resolve(value));
  });
 });
}
function tail(text){return text.slice(-4000);}
