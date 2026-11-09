// Offline cost of the per-row work in DiscoveryAuthority's read of the shared decisions (`epg/discovery-resolution.json`, readDecisions in src/discovery-authority.js):
// for every row of discovery_decision: utf8 length, JSON.parse, canonicalJson, one `await crypto.subtle.digest('SHA-256')` and a hex conversion (decisionHash, exported).
// Not bundled, never run by CI or by any production path: it reads no R2, no D1, no network and no production payload; the rows are deterministic synthetic objects of the
// size a read-only D1 aggregate reported (row count and mean payload bytes). It uses the REAL decisionHash of src/discovery-authority.js and replicates only the loop around it.
// What it measures: wall time (process.hrtime) and CPU time (process.cpuUsage) of the current loop and of its parts (parse, canonicalJson, digest awaits, hex), and of one
// variant that issues a page of digests together. What it does NOT measure: Cloudflare Worker CPU or crypto.subtle latency inside a Worker, D1 latency, the event loop of a busy
// isolate. A time here says what this code costs on this machine; it does not say what the Worker spent.
//   node --expose-gc scripts/discovery-decisions-read-bench.mjs [--rows 26263] [--page 1000] [--repeats 5]
import {decisionHash} from '../src/discovery-authority.js';

const arg=(name,fallback)=>{const at=process.argv.indexOf('--'+name);return at>0?Number(process.argv[at+1]):fallback;};
const ROWS=arg('rows',26263),PAGE=arg('page',1000),REPEATS=arg('repeats',5);
const encoder=new TextEncoder();
const decision=index=>({status:['verified','no_confident_match','ambiguous','excluded_nonfilm'][index%4],tmdbId:String(100000+index),filmId:'tmdb_'+(100000+index),attempts:index%3,discovery:{title:'Title '+index,evidence:'x'.repeat(50),candidates:[{id:index,score:0.5,year:1990+(index%30)}]},retryAt:null,terminalReason:null,mediaKind:'movie'});
const payloads=Array.from({length:ROWS},(_,index)=>JSON.stringify(decision(index)));
const mean=payloads.reduce((total,text)=>total+encoder.encode(text).length,0)/ROWS;
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value??null);
const hex=buffer=>[...new Uint8Array(buffer)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function measure(name,fn){
 const walls=[],cpus=[];
 for(let repeat=0;repeat<=REPEATS;repeat++){
  if(global.gc)global.gc();
  const cpu=process.cpuUsage(),at=process.hrtime.bigint();await fn();
  const wall=Number(process.hrtime.bigint()-at)/1e6,used=process.cpuUsage(cpu);
  if(repeat>0){walls.push(wall);cpus.push((used.user+used.system)/1000);}   // the first run is a warm-up
 }
 console.log(name.padEnd(52),'wall',median(walls).toFixed(0).padStart(6),'ms   cpu',median(cpus).toFixed(0).padStart(6),'ms');
}
console.log('rows',ROWS,'mean payload bytes',mean.toFixed(0),'repeats',REPEATS,'(median, warm-up dropped)');
const parsed=payloads.map(text=>JSON.parse(text)),texts=parsed.map(canonical);
const buffers=await Promise.all(texts.map(text=>crypto.subtle.digest('SHA-256',encoder.encode(text))));
await measure('current loop: utf8 + parse + await decisionHash per row',async()=>{let bytes=0;for(const text of payloads){bytes+=encoder.encode(text).length;await decisionHash(JSON.parse(text));}});
await measure('  part: JSON.parse only',async()=>{for(const text of payloads)JSON.parse(text);});
await measure('  part: canonicalJson only (synchronous)',async()=>{for(const value of parsed)canonical(value);});
await measure('  part: crypto.subtle.digest, one await per row',async()=>{for(const text of texts)await crypto.subtle.digest('SHA-256',encoder.encode(text));});
await measure('  part: hex conversion only',async()=>{for(const buffer of buffers)hex(buffer);});
await measure('variant: a page of decisionHash together (Promise.all)',async()=>{for(let from=0;from<ROWS;from+=PAGE)await Promise.all(payloads.slice(from,from+PAGE).map(text=>decisionHash(JSON.parse(text))));});
console.log('digest awaits per read of the current loop:',ROWS);
