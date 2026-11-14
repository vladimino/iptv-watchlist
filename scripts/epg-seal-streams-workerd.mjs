// AIR-460 follow-up: OFFLINE workerd measurement of the three allocation sites the 14 Nov 2026 production OOMs stopped at.
// A local Miniflare/workerd instance with LOCAL R2 only; no Cloudflare account, no production, no network.
//
//   npm run build
//   node scripts/epg-seal-streams-workerd.mjs [--items 36999] [--item-bytes 1270] [--payload-mb 16.5]
//
// It runs the REAL, unchanged `copyEpgGeneration`, `readSealedItems` and `sealPayload` of the built bundle (dist/server/index.js, copied to a scratch directory with extra routes
// appended to the COPY) and samples the RSS of the workerd child process from /proc. Host-process RSS is not the 128 MiB isolate bound and a local workerd does not enforce that
// limit: the numbers rank the sites, they do not reproduce the production kill. Each scenario runs in a fresh workerd process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const SELF=fileURLToPath(import.meta.url),REPO=path.resolve(path.dirname(SELF),'..');
const MIB=1024*1024,mib=n=>Math.round(n/MIB*10)/10;
const RUN='00000000-0000-4000-8000-000000000460';

const ROUTE=`
async function __measureCopy(request,env){
 const started=Date.now();await copyEpgGeneration(env,${JSON.stringify(RUN)});
 return new Response(JSON.stringify({ms:Date.now()-started}));
}
async function __measureRead(request,env){
 const url=new URL(request.url),delay=Number(url.searchParams.get('delay')||220),flush=Number(url.searchParams.get('flush')||400),limit=Number(url.searchParams.get('limit')||1e9);
 const key='epg/generations/'+${JSON.stringify(RUN)}+'/discovery-latest.json';
 const head=await env.BUCKET.head(key);
 let n=0;const started=Date.now();
 await readSealedItems(env,{sourceKey:key,etag:head.etag},Number(url.searchParams.get('offset')||0),async()=>{n++;if(n%flush===0)await new Promise(r=>setTimeout(r,delay));return n<limit;});
 const mem=typeof process!=='undefined'&&process.memoryUsage?process.memoryUsage():null;return new Response(JSON.stringify({items:n,ms:Date.now()-started,mem}));
}
async function __measureDrain(request,env){
 const key='epg/generations/'+${JSON.stringify(RUN)}+'/discovery-latest.json';
 const delay=Number(new URL(request.url).searchParams.get('delay')||0);
 const object=await env.BUCKET.get(key),reader=object.body.getReader();let bytes=0,n=0;
 for(;;){const step=await reader.read();if(step.done)break;bytes+=step.value.byteLength;if(delay&&++n%4===0)await new Promise(r=>setTimeout(r,delay));}
 return new Response(JSON.stringify({bytes}));
}
async function __measureParse(request,env){
 const started=Date.now();const payload=await sealPayload(env,{runId:${JSON.stringify(RUN)}});
 return new Response(JSON.stringify({keys:Object.keys(payload),ms:Date.now()-started}));
}
`;

function harnessScript(){
 const bundle=path.join(REPO,'dist/server/index.js');
 assert.ok(fs.existsSync(bundle),'run `npm run build` first');
 const text=fs.readFileSync(bundle,'utf8');
 assert.ok(text.includes('\nexport default {'),'the bundle has the expected default export');
 const renamed=text.replace('\nexport default {','\nconst __workerDefault={');
 const entry=`\nexport default {\n async fetch(request,env,execution){const path=new URL(request.url).pathname;if(path==='/__ping')return new Response('ok');if(path==='/__copy')return __measureCopy(request,env);if(path==='/__read')return __measureRead(request,env);if(path==='/__drain')return __measureDrain(request,env);if(path==='/__parse')return __measureParse(request,env);return __workerDefault.fetch(request,env,execution);},\n};\n`;
 return renamed+ROUTE+entry;
}

const rssOf=pid=>{try{const status=fs.readFileSync('/proc/'+pid+'/status','utf8');return Number((status.match(/VmRSS:\s+(\d+) kB/)||[])[1]||0)*1024;}catch{return 0;}};
const workerdPids=()=>{const r=spawnSync('pgrep',['-P',String(process.pid)],{encoding:'utf8'});const direct=r.stdout.split('\n').filter(Boolean);const all=[...direct];for(const pid of direct){const c=spawnSync('pgrep',['-P',pid],{encoding:'utf8'});all.push(...c.stdout.split('\n').filter(Boolean));}return all.filter(pid=>{try{return /workerd/.test(fs.readFileSync('/proc/'+pid+'/cmdline','utf8'));}catch{return false;}});};

function ledgerText(items,itemBytes){
 const pad='x'.repeat(Math.max(0,itemBytes-90));
 const rows=[];for(let i=0;i<items;i++)rows.push(JSON.stringify({key:'k'+String(i).padStart(8,'0'),title:'t'+i,seenInLatestSnapshot:true,pad}));
 return '{"programmeRunId":"'+RUN+'","items":['+rows.join(',')+']}';
}
function ledger0(){return '{"programmeRunId":"'+RUN+'","items":[';}
function payloadText(bytes){
 const catalog={};const entry={title:'t',pad:'y'.repeat(300)};const count=Math.floor(bytes*0.77/340);
 for(let i=0;i<count;i++)catalog['f'+i]={...entry,id:i};
 return JSON.stringify({runId:RUN,report:{runId:RUN,pad:'z'.repeat(Math.floor(bytes*0.13))},catalog,watchlist:{films:[]},uncertain:[],fence:null,expectedProgrammeRunId:null});
}

async function scenario(name,route,seed){
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-streams-'));
 const script=path.join(work,'harness.mjs');fs.writeFileSync(script,harnessScript());
 const mf=new Miniflare(Object.assign(convertV4MiniflareOptions({
  modules:true,scriptPath:script,modulesRoot:work,compatibilityDate:'2026-10-18',compatibilityFlags:['nodejs_compat'],
  d1Databases:{DB:'db'},r2Buckets:{BUCKET:'bucket'},bindings:{DISCOVERY_LEDGER_MODE:'bounded'},
 }),{resourcePersistencePath:path.join(work,'persist')}));
 try{
  const bucket=await mf.getR2Bucket('BUCKET');
  await seed(bucket);
  await (await mf.dispatchFetch('http://localhost/__ping')).text();
  const pids=workerdPids();
  const sum=()=>pids.map(rssOf).reduce((a,b)=>a+b,0);
  const idle=sum();let peak=idle;
  const timer=setInterval(()=>{peak=Math.max(peak,sum());},10);
  const response=await mf.dispatchFetch('http://localhost'+route);
  const body=await response.text();
  clearInterval(timer);
  return {name,status:response.status,answer:response.status===200?JSON.parse(body):body.slice(0,300),rssMiB:{idle:mib(idle),peak:mib(peak),increase:mib(peak-idle)}};
 }finally{await mf.dispose();fs.rmSync(work,{recursive:true,force:true});}
}

export async function main(argv){
 const flag=(name,fallback)=>{const i=argv.indexOf(name);return i<0?fallback:argv[i+1];};
 const items=Number(flag('--items',36999)),itemBytes=Number(flag('--item-bytes',1270)),payloadMb=Number(flag('--payload-mb',16.5));
 const ledger=ledgerText(items,itemBytes),offset=Buffer.byteLength(ledger0(items,itemBytes)),payload=payloadText(Math.floor(payloadMb*MIB));
 const ledgerKey='epg/generations/'+RUN+'/discovery-latest.json',payloadKey='epg/seal/'+RUN+'/payload.json';
 const seedLedger=async bucket=>{await bucket.put(ledgerKey,ledger);await bucket.put('epg/generations/'+RUN+'/discovered-films.json','{}');await bucket.put('epg/generations/'+RUN+'/programme.json','{}');};
 const results=[];
 results.push(await scenario('copy_generation (seal_publish_copy)','/__copy',seedLedger));
 results.push(await scenario('paced_ledger_read, 220 ms per 400 items (seal_ledger)','/__read?offset='+offset+'&delay=220&flush=400',seedLedger));
 results.push(await scenario('paced_ledger_read, no delay (control)','/__read?offset='+offset+'&delay=0&flush=400',seedLedger));
 results.push(await scenario('raw_body_drain, no parsing, 50 ms per 4 chunks (control)','/__drain?delay=50',seedLedger));
 results.push(await scenario('payload_parse (seal_publish entry)','/__parse',async bucket=>{await bucket.put(payloadKey,payload);}));
 console.log(JSON.stringify({ledgerMiB:mib(Buffer.byteLength(ledger)),payloadMiB:mib(Buffer.byteLength(payload)),results},null,1));
 return results.some(r=>r.status!==200)?1:0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===SELF)main(process.argv.slice(2)).then(code=>process.exit(code)).catch(error=>{console.error(error);process.exit(1);});
