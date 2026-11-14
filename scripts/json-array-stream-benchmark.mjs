// AIR-460: allocation and CPU of forEachJsonArrayItems on a ledger-sized document, current tree against a reference revision.
//
//   node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 scripts/json-array-stream-benchmark.mjs [--ref origin/main] [--items 36999] [--item-bytes 1270] [--chunk 65536]
//
// "allocated" sums the positive heapUsed steps sampled every 20 items; with a 256 MiB young generation scavenges are rare, so it approximates bytes allocated, not retained.
// "retainedAfterGc" is heapUsed after a forced GC minus the heap before the run. Numbers are Node/V8, not the workerd 128 MiB isolate. Offline only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const ref=arg('--ref','origin/main'),items=Number(arg('--items',36999)),itemBytes=Number(arg('--item-bytes',1270)),chunk=Number(arg('--chunk',65536));
assert.equal(typeof global.gc,'function','run with --expose-gc');
const extract=text=>{const a=text.indexOf('async function forEachJsonArrayItems'),b=text.indexOf('function groupDiscoveryRaws');assert.ok(a>0&&b>a);return new Function(text.slice(a,b)+'\nreturn forEachJsonArrayItems;')();};
const git=spawnSync('git',['show',ref+':src/sources.js'],{encoding:'utf8',maxBuffer:1<<26});assert.equal(git.status,0,git.stderr);
const variants={[ref]:extract(git.stdout),'working tree':extract(fs.readFileSync(new URL('../src/sources.js',import.meta.url),'utf8'))};

const pad='x'.repeat(Math.max(0,itemBytes-90)),rows=[];
for(let i=0;i<items;i++)rows.push(JSON.stringify({key:'k'+String(i).padStart(8,'0'),title:'t\u00e9'+i,seenInLatestSnapshot:true,pad}));
const bytes=new TextEncoder().encode('{"items":['+rows.join(',')+']}');rows.length=0;
async function* chunks(){const decoder=new TextDecoder();for(let i=0;i<bytes.length;i+=chunk)yield decoder.decode(bytes.subarray(i,i+chunk),{stream:true});}
const MIB=1048576,mib=n=>Math.round(n/MIB*10)/10;
const encoder=new TextEncoder();
const out={documentMiB:mib(bytes.length),items,chunk,results:{}};
for(const [name,fn] of Object.entries(variants)){
 const runs=[];
 for(let rep=0;rep<3;rep++){
  global.gc();const before=process.memoryUsage().heapUsed;let last=before,allocated=0,n=0,peak=0;const cpu=process.cpuUsage(),wall=Date.now();
  await fn(chunks(),'items',item=>{encoder.encode(JSON.stringify(item)).byteLength;if(++n%20===0){const h=process.memoryUsage().heapUsed;if(h>last)allocated+=h-last;peak=Math.max(peak,h-before);last=h;}});
  const used=process.cpuUsage(cpu);global.gc();
  assert.equal(n,items);
  runs.push({allocatedMiB:Math.round(allocated/MIB),cpuMs:Math.round((used.user+used.system)/1000),wallMs:Date.now()-wall,retainedAfterGcMiB:mib(process.memoryUsage().heapUsed-before)});
 }
 out.results[name]=runs;
}
console.log(JSON.stringify(out,null,1));
