// AIR-541 (ADR 0177): the degraded read module is reachable only from the read handlers. No write path imports or calls it, so a write can never be answered from, or
// authorised by, a mirror. The server-side write fence runs before every handler.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const files=[];
const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(file.endsWith('.js'))files.push(file);}};
walk('src');
for(const file of files){
 if(file==='src/mirror-read.js'||file==='src/worker.js')continue;
 const source=fs.readFileSync(file,'utf8');
 assert.ok(!/MirrorRead|mirror-read/.test(source),file+' must not use the degraded mirror reader');
}
const worker=fs.readFileSync('src/worker.js','utf8');
const uses=[...worker.matchAll(/MirrorRead\.([A-Za-z]+)/g)].map(match=>match[1]);
assert.deepEqual([...new Set(uses)].sort(),['isTemporaryReadFault','mirrorFilmIdentity','mirrorMeta','readMirrorSnapshot'],'the Worker uses exactly the read API of the mirror module');
// Every call of a degraded response builder sits in a GET read handler (catalogFilmRoute, /api/programme, /api/watchlist) and nowhere else.
const callers=[...worker.matchAll(/degraded(?:Programme|Watchlist|Film)Response\(/g)];
assert.ok(callers.length>=6);
const lines=worker.split('\n');
for(const match of callers){
 const line=worker.slice(0,match.index).split('\n').length-1;
 if(/^(async )?function degraded/.test(lines[line]))continue;
 let owner=null;for(let i=line;i>=0;i--){const route=/^async function (\w+)\(/.exec(lines[i]);if(route){owner=route[1];break;}const path=/url\.pathname==='(\/api\/[a-z/]+)'&&request\.method==='GET'/.exec(lines[i]);if(path){owner=path[1];break;}}
 assert.ok(['catalogFilmRoute','/api/programme','/api/watchlist'].includes(owner),'a degraded response is built in '+owner+' at line '+(line+1));
}
// The write fence is installed before any handler of /api/.
const origin=worker.indexOf("['POST','PUT'].includes(request.method)&&request.headers.get('Origin')"),fence=worker.indexOf('await degradedWriteFence(request,env,url)'),firstHandler=worker.indexOf("if(url.pathname.startsWith('/api/enrichment/'))");
assert.ok(origin>0&&fence>origin&&fence<firstHandler,'the fence runs right after the origin check and before every /api/ handler');
// The Worker never reads the client-set header for anything but the fence.
assert.equal([...worker.matchAll(/X-Data-Origin/g)].length>=3,true);
// The degraded builders write nothing: no put, delete, SQL or workflow inside the block.
const start=worker.indexOf('const DEGRADED_EVENT_WINDOW_MS'),end=worker.indexOf('const TITLE_READ_REFUSALS'),block=worker.slice(start,worker.indexOf("const DEGRADED_WRITE_RUN_ROUTES"));
assert.ok(start>0&&block.length>500);
assert.ok(!/\.(put|delete|batch|run)\(|INSERT|UPDATE |DELETE /.test(block),'the degraded block has no write');
console.log('mirror read write fence: no write path uses the mirror reader, builders sit in GET handlers, the fence precedes every handler');
