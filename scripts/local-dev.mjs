import {spawn,spawnSync} from 'node:child_process';
import {mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadLocalCatalog} from './local-fixtures.mjs';
import {fixtureIdentity,importFixtures,importSnapshot,miniflareDirectory,persistDirectory,prepareLocalStore,snapshotIdentity,snapshotProgrammeUpdatedAt} from './local-store.mjs';
import {LOCAL_TIME_ZONE,shiftDaysToNow} from './local-timeshift.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const here=fileURLToPath(import.meta.url);

function wranglerEntrypoint(){
 const bin=(process.env.PATH||'').split(path.delimiter).find(item=>item.includes(`${path.sep}_npx${path.sep}`)&&item.endsWith(`${path.sep}node_modules${path.sep}.bin`));
 return bin?path.resolve(bin,'../wrangler/wrangler-dist/cli.js'):'';
}
if(!wranglerEntrypoint()){
 const child=spawn('npm',['exec','--yes','--package=wrangler@4.86.0','--','node',here,...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
 child.on('exit',code=>process.exit(code??1));
}else await start();

function hideCloudflareCredentials(){
 process.env.WRANGLER_SEND_METRICS='false';
 delete process.env.CLOUDFLARE_API_TOKEN;
 delete process.env.CLOUDFLARE_API_KEY;
 delete process.env.CLOUDFLARE_ACCOUNT_ID;
}
async function newestMtime(file){
 const info=await stat(file);
 if(!info.isDirectory())return info.mtimeMs;
 let latest=info.mtimeMs;
 for(const entry of await readdir(file,{withFileTypes:true}))latest=Math.max(latest,await newestMtime(path.join(file,entry.name)));
 return latest;
}
function runBuild(){
 const result=spawnSync(process.execPath,[path.join(root,'build.mjs')],{cwd:root,stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
async function ensureBundle(){
 const bundle=path.join(root,'dist/server/index.js');
 let built=0;
 try{built=(await stat(bundle)).mtimeMs;}catch{}
 let latest=await newestMtime(path.join(root,'build.mjs'));
 for(const name of ['src','public','data'])latest=Math.max(latest,await newestMtime(path.join(root,name)));
 if(latest<=built)return;
 console.log('Building the Worker.');
 runBuild();
}
function startWatch(){
 let timer;
 const schedule=()=>{
  clearTimeout(timer);
  timer=setTimeout(()=>{
   console.log('Rebuilding the Worker.');
   const result=spawnSync(process.execPath,[path.join(root,'build.mjs')],{cwd:root,stdio:'inherit'});
   if(result.status!==0)console.error('Rebuild failed.');
  },150);
 };
 const watchers=['src','public','data'].map(name=>watch(path.join(root,name),{recursive:true},schedule));
 watchers.push(watch(path.join(root,'build.mjs'),schedule));
 return watchers;
}
async function writeDevConfig(devConfig){
 await mkdir(path.dirname(devConfig),{recursive:true});
 await writeFile(devConfig,JSON.stringify({name:'iptv',main:path.join(root,'dist/server/index.js'),compatibility_date:'2026-05-03',workers_dev:true,vars:{PUBLISHED_EPG_DB_OPTIONAL:'standin'},r2_buckets:[{binding:'BUCKET',bucket_name:'iptv'}]},null,2));
}
async function openBucket(devConfig,persistDir){
 const {getPlatformProxy}=await import(pathToFileURL(wranglerEntrypoint()).href);
 return getPlatformProxy({configPath:devConfig,envFiles:[],persist:{path:miniflareDirectory(persistDir)},remoteBindings:false});
}
async function start(){
 hideCloudflareCredentials();
 const refresh=process.argv.includes('--refresh');
 const port=process.env.IPTV_DEV_PORT||'8787';
 if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535){console.error('IPTV_DEV_PORT must be a TCP port.');process.exit(1);}
 const configPath=path.resolve(process.env.IPTV_LOCAL_CONFIG||path.join(root,'.local-dev.json'));
 const stateRoot=path.resolve(process.env.IPTV_LOCAL_STATE||path.join(root,'.wrangler/state'));
 let snapshot='',shiftToNow=false;
 try{const config=JSON.parse(await readFile(configPath,'utf8'));snapshot=String(config.snapshot||'').trim();shiftToNow=config.shiftToNow===true;}catch{}
 let identity,shiftDays=0;
 try{
  identity=snapshot?await snapshotIdentity(snapshot):await fixtureIdentity(root);
  if(snapshot&&shiftToNow){shiftDays=shiftDaysToNow(await snapshotProgrammeUpdatedAt(snapshot));identity={...identity,shiftDays};}
 }catch(error){console.error(error.message);process.exit(1);}
 await ensureBundle();
 const devConfig=path.join(stateRoot,'dev.jsonc');
 await writeDevConfig(devConfig);
 const persistDir=persistDirectory(stateRoot,identity);
 let result;
 try{
  result=await prepareLocalStore({
   refresh,
   identity,
   persistDir,
   openBucket:()=>openBucket(devConfig,persistDir),
   importInto:async bucket=>snapshot?importSnapshot(bucket,snapshot,{shift:shiftDays?{days:shiftDays,timeZone:LOCAL_TIME_ZONE}:null}):importFixtures(bucket,await loadLocalCatalog()),
  });
 }catch(error){console.error(error.stack||error.message);process.exit(1);}
 console.log(result.action==='skip'?snapshot?`Local R2 already has this snapshot${shiftDays?` shifted forward by ${shiftDays} calendar days`:''}.`:'Local R2 already has the dummy catalog.':result.message);
 const watchers=process.argv.includes('--watch')?startWatch():[];
 const child=spawn('wrangler',['dev','--config',devConfig,'--local','--ip','127.0.0.1','--port',port,'--persist-to',persistDir,'--compatibility-date','2026-05-03','--show-interactive-dev-session','false'],{cwd:root,stdio:'inherit',env:process.env});
 child.on('exit',code=>{for(const watcher of watchers)watcher.close();process.exit(code??1);});
}
