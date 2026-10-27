// Shared offline harness of the discovery ledger tools (AIR-220 benchmark, AIR-221 split rehearsal). It loads the Worker's
// own source files into a `vm` context with no network, and provides an R2-like store whose reads come from a read-only base
// and whose writes go to a private overlay directory. Nothing here reaches R2, D1 or the network.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SOURCES=['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/continuation.js','src/worker.js'];

export function loadWorker(){
 const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,ASSETS:{},console:{...console,log:()=>{}},fetch:async()=>new Response('unavailable',{status:599})});
 vm.runInContext(fs.readFileSync(path.join(REPO,'src/domain/film-person.js'),'utf8'),context);
 for(const file of SOURCES)vm.runInContext(fs.readFileSync(path.join(REPO,file),'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
 return context;
}

// A directory of objects named by encodeURIComponent(key), as a store base.
export function directoryBase(dir){
 const file=key=>path.join(dir,encodeURIComponent(key));
 return {
  locate:key=>fs.existsSync(file(key))?{file:file(key),etag:null}:null,
  keys:()=>fs.existsSync(dir)?fs.readdirSync(dir).map(name=>decodeURIComponent(name)):[]
 };
}
// A verified snapshot (scripts/r2-snapshot-export.mjs layout) as a store base. The listed R2 ETag is kept, so a store over it
// sees the production ETags of the cut.
export function snapshotBase(dir,manifest){
 const entries=new Map(manifest.objects.map(entry=>[entry.key,entry]));
 return {
  locate:key=>{const entry=entries.get(key);return entry?{file:path.join(dir,entry.file),etag:String(entry.metadata?.etag||'').replace(/^"(.*)"$/,'$1')||null}:null;},
  keys:()=>[...entries.keys()]
 };
}

// Copy-on-write store with R2 binding semantics (get, put with onlyIf, list, delete). `base` may be null. Every put is
// recorded in `writes` and every get in `reads`, so a caller can prove which keys a step changed or read.
export function overlayStore(base,overlayDir){
 const file=key=>path.join(overlayDir,encodeURIComponent(key));
 fs.mkdirSync(overlayDir,{recursive:true});
 const meta=new Map(),deleted=new Set(),writes=[],reads=[];let revision=0;
 const locate=key=>{
  if(fs.existsSync(file(key)))return {file:file(key),etag:null};
  if(deleted.has(key))return null;
  return base?.locate(key)||null;
 };
 const etagOf=key=>{
  if(!meta.has(key)){const where=locate(key);if(!where)return null;meta.set(key,where.etag||'b'+fs.statSync(where.file).size+'-'+(++revision));}
  return meta.get(key);
 };
 return {
  writes,reads,
  async get(key){reads.push(key);const where=locate(key);if(!where)return null;const etag=etagOf(key),read=()=>fs.readFileSync(where.file);return {etag,size:fs.statSync(where.file).size,json:async()=>JSON.parse(new TextDecoder().decode(read())),text:async()=>new TextDecoder().decode(read()),arrayBuffer:async()=>{const bytes=read();return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length);}};},
  async head(key){const where=locate(key);return where?{etag:etagOf(key),size:fs.statSync(where.file).size}:null;},
  async put(key,value,options={}){
   const c=options.onlyIf,exists=!!locate(key);
   if(c?.etagDoesNotMatch==='*'&&exists||c?.etagMatches&&c.etagMatches!==etagOf(key))return null;
   fs.writeFileSync(file(key),typeof value==='string'||Buffer.isBuffer(value)?value:String(value));deleted.delete(key);meta.set(key,'o'+(++revision));writes.push(key);
   return {etag:meta.get(key)};
  },
  async list({prefix=''}={}){
   const keys=new Set((base?base.keys():[]).filter(key=>!deleted.has(key)));for(const name of fs.readdirSync(overlayDir))keys.add(decodeURIComponent(name));
   return {objects:[...keys].filter(key=>key.startsWith(prefix)).sort().map(key=>({key})),truncated:false};
  },
  async delete(key){fs.rmSync(file(key),{force:true});deleted.add(key);meta.delete(key);}
 };
}
// An overlay directory read on top of another base: what a store over `base` looked like after writing into `dir`.
export function layeredBase(dir,base){
 const file=key=>path.join(dir,encodeURIComponent(key));
 return {
  locate:key=>fs.existsSync(file(key))?{file:file(key),etag:null}:base?.locate(key)||null,
  keys:()=>[...new Set([...(base?base.keys():[]),...fs.readdirSync(dir).map(name=>decodeURIComponent(name))])]
 };
}
