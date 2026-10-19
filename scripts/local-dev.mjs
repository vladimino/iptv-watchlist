import {spawn} from 'node:child_process';
import {access,mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildLocalFixtures,loadLocalCatalog} from './local-fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const here=fileURLToPath(import.meta.url);
const general=['plot_engine','pace','stakes','decision_logic','protagonist_competence','opposition_competence','problem_solving','plan_counterplan_strength','multi_party_goals','chemistry','payoff','ending_quality','technical_plausibility'];
const dropped=new Set(['unknown','not_applicable']);

function wranglerEntrypoint(){
 const bin=(process.env.PATH||'').split(path.delimiter).find(item=>item.includes(`${path.sep}_npx${path.sep}`)&&item.endsWith(`${path.sep}node_modules${path.sep}.bin`));
 return bin?path.resolve(bin,'../wrangler/wrangler-dist/cli.js'):'';
}
if(!wranglerEntrypoint()){
 const child=spawn('npm',['exec','--yes','--package=wrangler@4.86.0','--','node',here,...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
 child.on('exit',code=>process.exit(code??1));
}else await start();

async function start(){
 const refresh=process.argv.includes('--refresh');
 const configPath=path.join(root,'.local-dev.json');
 let snapshot='';
 try{snapshot=String(JSON.parse(await readFile(configPath,'utf8')).snapshot||'').trim();}catch{}
 const markerPath=path.join(root,'.wrangler/state/iptv-snapshot.json');
 const identity=snapshot?await snapshotIdentity(snapshot):await fixtureIdentity();
 let current=null;try{current=JSON.parse(await readFile(markerPath,'utf8'));}catch{}
 const same=current&&current.snapshot===identity.snapshot&&current.manifestBytes===identity.manifestBytes&&current.manifestMtimeMs===identity.manifestMtimeMs;
 if(refresh||!same)await (snapshot?importSnapshot(snapshot,identity,markerPath):importFixtures(identity,markerPath));
 else console.log(snapshot?'Local R2 already has this snapshot.':'Local R2 already has the dummy catalog.');
 await access(path.join(root,'dist/server/index.js')).catch(()=>{console.error('Build the Worker first: npm run build');process.exit(1);});
 const devConfig=path.join(root,'.wrangler/dev.jsonc');
 await mkdir(path.dirname(devConfig),{recursive:true});
 await writeFile(devConfig,JSON.stringify({name:'iptv',main:path.join(root,'dist/server/index.js'),compatibility_date:'2026-05-03',workers_dev:true,r2_buckets:[{binding:'BUCKET',bucket_name:'iptv'}]},null,2));
 const env={...process.env,WRANGLER_SEND_METRICS:'false'};
 delete env.CLOUDFLARE_API_TOKEN;delete env.CLOUDFLARE_API_KEY;delete env.CLOUDFLARE_ACCOUNT_ID;
 const child=spawn('wrangler',['dev','--config',devConfig,'--local','--ip','127.0.0.1','--port','8787','--persist-to',path.join(root,'.wrangler/state'),'--compatibility-date','2026-05-03','--show-interactive-dev-session','false'],{cwd:root,stdio:'inherit',env});
 child.on('exit',code=>process.exit(code??1));
}
async function fixtureIdentity(){const file=path.join(root,'fixtures/local-site/catalog.json');const info=await stat(file);return {snapshot:'fixtures',manifestBytes:info.size,manifestMtimeMs:info.mtimeMs};}
async function snapshotIdentity(snapshot){
 if(!path.isAbsolute(snapshot)){console.error('snapshot in .local-dev.json must be an absolute path.');process.exit(1);}
 try{await access(path.join(snapshot,'manifest.json'));await access(path.join(snapshot,'entries'));await access(path.join(snapshot,'objects'));}
 catch{console.error('The snapshot directory is missing manifest.json, entries/, or objects/.');process.exit(1);}
 const manifest=await stat(path.join(snapshot,'manifest.json'));
 return {snapshot,manifestBytes:manifest.size,manifestMtimeMs:manifest.mtimeMs};
}
async function openBucket(){
 const {getPlatformProxy}=await import(pathToFileURL(wranglerEntrypoint()).href);
 const devConfig=path.join(root,'.wrangler/dev.jsonc');
 await mkdir(path.dirname(devConfig),{recursive:true});
 await writeFile(devConfig,JSON.stringify({name:'iptv',main:path.join(root,'dist/server/index.js'),compatibility_date:'2026-05-03',workers_dev:true,r2_buckets:[{binding:'BUCKET',bucket_name:'iptv'}]},null,2));
 return getPlatformProxy({configPath:devConfig,envFiles:[],persist:{path:path.join(root,'.wrangler/state/v3')},remoteBindings:false});
}
async function remember(markerPath,identity,extra){await mkdir(path.dirname(markerPath),{recursive:true});await writeFile(markerPath,JSON.stringify({...identity,...extra}));}
async function importFixtures(identity,markerPath){
 const proxy=await openBucket();
 const objects=buildLocalFixtures(await loadLocalCatalog());
 for(const item of objects)await proxy.env.BUCKET.put(item.key,JSON.stringify(item.json),{httpMetadata:{contentType:'application/json'},...(item.customMetadata?{customMetadata:item.customMetadata}:{})});
 await proxy.dispose();
 await remember(markerPath,identity,{objects:objects.length});
 console.log(`Imported ${objects.length} dummy objects from fixtures/local-site/catalog.json.`);
}
async function importSnapshot(snapshot,identity,markerPath){
 const proxy=await openBucket();
 const names=await readdir(path.join(snapshot,'entries'));
 const executions=new Map();let written=0,fingerprints=0,patched=0,viewIndex=null;
 for(const name of names){
  const entry=JSON.parse(await readFile(path.join(snapshot,'entries',name),'utf8'));
  const bytes=await readFile(path.join(snapshot,entry.file));
  const film=String(entry.key||'').match(/^enrichment\/films\/([^/]+)\/fingerprint\.json$/);
  if(film){fingerprints++;try{executions.set(decodeURIComponent(film[1]),executionOf(JSON.parse(bytes.toString('utf8')).execution));}catch{executions.set(decodeURIComponent(film[1]),{});}}
  if(entry.key==='enrichment/view-index.json'){viewIndex=bytes;continue;}
  await proxy.env.BUCKET.put(entry.key,new Uint8Array(bytes),{httpMetadata:httpMetadata(entry.metadata),customMetadata:customMetadata(entry.metadata)});
  if(++written%1000===0)console.log(`Imported ${written} objects`);
 }
 if(!viewIndex){await proxy.dispose();throw new Error('Snapshot has no view index');}
 const index=JSON.parse(viewIndex.toString('utf8'));
 for(const [id,item] of Object.entries(index)){if(!item?.fingerprint||Object.hasOwn(item.fingerprint,'execution')||!executions.has(id))continue;item.fingerprint.execution=executions.get(id);patched++;}
 await proxy.env.BUCKET.put('enrichment/view-index.json',JSON.stringify(index),{httpMetadata:{contentType:'application/json'}});
 await proxy.dispose();
 await remember(markerPath,identity,{objects:names.length,patched});
 console.log(`Imported ${names.length} objects. Execution values attached for ${patched} of ${fingerprints} fingerprints.`);
}
function executionOf(value){const out={};if(!value||typeof value!=='object')return out;for(const key of general){const item=value[key];if(typeof item==='string'&&item&&!dropped.has(item))out[key]=item;}return out;}
function httpMetadata(metadata){const http=metadata?.httpMetadata||{},out={};for(const field of ['contentType','contentLanguage','contentDisposition','contentEncoding','cacheControl'])if(http[field])out[field]=String(http[field]);if(http.cacheExpiry){const time=Date.parse(http.cacheExpiry);if(!Number.isNaN(time))out.cacheExpiry=new Date(time);}return out;}
function customMetadata(metadata){return Object.fromEntries(Object.entries(metadata?.customMetadata||{}).filter(([,value])=>value!==undefined&&value!==null).map(([key,value])=>[key,String(value)]));}
