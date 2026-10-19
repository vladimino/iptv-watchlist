import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
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
 await assertFixtureSite(port);
 await stop(child);
 child=null;
 await waitForPortFree(port);
 const second=await boot('second');
 assert.match(second.logs,/Local R2 already has the dummy catalog/);
 assert.doesNotMatch(second.logs,/Imported \d+ dummy objects/);
 await assertFixtureSite(port);
}finally{
 if(child)await stop(child);
 await rm(state,{recursive:true,force:true});
}
console.log('Local dev smoke: Wrangler fixture GETs and a second start without import passed');

function boot(label){
 return new Promise((resolve,reject)=>{
  const logs={text:''};
  child=spawn(process.execPath,[path.join(root,'scripts/local-dev.mjs')],{
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
    while(Date.now()-startedAt<5000&&!/Imported \d+ dummy objects|Local R2 already has the dummy catalog/.test(logs.text))await new Promise(resolve=>setTimeout(resolve,50));
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
 const started=await getJson(currentPort,'/api/started');
 assert.deepEqual(started.ids,['movie-1']);
 const view=await getJson(currentPort,'/api/enrichment/view');
 assert.equal(view.films['movie-1'].actualRating,4.5);
 assert.deepEqual(view.films['movie-1'].moodIds,['tense']);
 assert.equal(view.films['movie-2'].prediction.predictedRating,4);
 assert.equal(view.films['movie-2'].prediction.stale,false);
 assert.deepEqual(view.films['movie-2'].moodIds,['light']);
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
