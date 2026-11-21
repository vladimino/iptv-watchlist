// AIR-571 (C3): the root `watchlist.json` mirror at the authority boundary. One guarded writer on the EPG side (PublishedEpg.putWatchlistRoot): read the object, check the marker AFTER the read,
// conditional put by etag. Offline only: the sqlite D1 stand-in and an in-memory bucket with strong etags, conditional puts and hooks between the steps of a writer.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import * as PublishedEpg from '../src/published-epg.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-wl-root-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const RUN='run-20261121';
const DOC=films=>({updatedAt:'2026-11-21T16:11:45.255Z',films:films.map(id=>({id,title:'Film '+id,year:2000,url:'https://letterboxd.com/film/'+id+'/'}))});
const A=DOC(['a','b','c']),B=DOC(['a','c','d']);
const etagOf=text=>createHash('md5').update(text).digest('hex');
// An in-memory bucket: strong content etags, conditional puts, and hooks between the steps of a writer.
function bucket(initial={}){
 const objects=new Map(Object.entries(initial).map(([key,text])=>[key,{text,etag:etagOf(text)}]));
 const log=[];
 const store={objects,log,afterGet:null,beforePut:null,
  async get(key){const o=objects.get(key)||null;log.push('get '+key);const result=o?{etag:o.etag,text:async()=>o.text}:null;if(store.afterGet)await store.afterGet(key);return result;},
  async put(key,text,options={}){
   if(store.beforePut)await store.beforePut(key);
   const o=objects.get(key);
   if(options.onlyIf?.etagMatches&&o?.etag!==options.onlyIf.etagMatches)return null;
   if(options.onlyIf?.etagDoesNotMatch==='*'&&o)return null;
   objects.set(key,{text,etag:etagOf(text)});log.push('put '+key);return {etag:etagOf(text)};
  }};
 return store;
}
let copies=0;
// A database with the published generation, the watchlist marker and the schema through 0033.
function open({marker='epg/open',upTo=null}={}){
 const file=path.join(root,'db-'+(copies++)+'.sqlite');
 sqlite(file,names.filter(name=>!upTo||name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 sqlite(file,"INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('"+RUN+"','published','2026-11-21T16:11:45.255Z','"+'a'.repeat(64)+"','2026-11-21T16:00:00.000Z');UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+RUN+"', generation=515, finalized_run_id='"+RUN+"' WHERE id=1;");
 if(!upTo||upTo>='0031'){const [mode,writes]=marker.split('/');sqlite(file,"UPDATE watchlist_authority SET mode='"+mode+"', writes='"+writes+"', generation=1");}
 return {file,db:d1Standin(file)};
}
const setMarker=(file,marker)=>{const [mode,writes]=marker.split('/');sqlite(file,"UPDATE watchlist_authority SET mode='"+mode+"', writes='"+writes+"'");};
// the operator's fence: the same content, re-serialized (one trailing newline), a different etag
const fence=(store,key='watchlist.json')=>{const o=store.objects.get(key);const text=o.text.endsWith('\n')?o.text.slice(0,-1):o.text+'\n';store.objects.set(key,{text,etag:etagOf(text)});};
const rootText=store=>store.objects.get('watchlist.json')?.text??null;

// ===== 1. the normal path, epg/open and no marker at all =====
{
 const env=open(),store=bucket();const e={DB:env.db,BUCKET:store};
 const first=await PublishedEpg.putWatchlistRoot(e,A);
 assert.equal(first.blocked,false);assert.equal(first.etag,etagOf(JSON.stringify(A)),'an absent root is created');
 const same=await PublishedEpg.putWatchlistRoot(e,A);assert.equal(same.blocked,false);assert.equal(same.etag,first.etag);assert.equal(store.log.filter(l=>l==='put watchlist.json').length,1,'an equal root is not rewritten');
 const next=await PublishedEpg.putWatchlistRoot(e,B);assert.equal(next.etag,etagOf(JSON.stringify(B)),'a different list is a compare-and-swap');assert.equal(rootText(store),JSON.stringify(B));
 // migrations below 0031: the marker does not exist, the EPG owns the root as before
 const legacy=open({upTo:'0030'}),lstore=bucket();
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:legacy.db,BUCKET:lstore},A)).blocked,false);
 // no bucket binding: nothing to guard, nothing written
 assert.deepEqual(await PublishedEpg.putWatchlistRoot({DB:env.db},A),{blocked:false,etag:null});
}

// ===== 2. no new root write while the marker is held, d1 or unreadable =====
for(const marker of ['epg/held','d1/open','d1/held']){
 const env=open({marker}),store=bucket({'watchlist.json':JSON.stringify(A)});
 const out=await PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:store},B);
 assert.equal(out.blocked,true,marker);assert.equal(rootText(store),JSON.stringify(A),marker+': the root is untouched');assert.equal(store.log.some(l=>l.startsWith('put')),false,marker+': no put at all');
 assert.equal(await PublishedEpg.watchlistRootOwned({DB:env.db,BUCKET:store}),true,marker);
}
{
 const env=open(),store=bucket({'watchlist.json':JSON.stringify(A)});
 const flaky=d1Standin(env.file,{onQuery:async()=>{throw new Error('D1 DB is overloaded');}});
 const out=await PublishedEpg.putWatchlistRoot({DB:flaky,BUCKET:store},B);
 assert.equal(out.blocked,true,'an unreadable marker fails closed');assert.equal(rootText(store),JSON.stringify(A));
 assert.equal(await PublishedEpg.watchlistRootOwned({DB:env.db}),false,'epg/open: the EPG owns the root');
}

// ===== 3. the fence order: the marker is read AFTER the object, and the put is conditional on that read =====
{
 // a hold between the read and the marker check stops the writer
 const env=open(),store=bucket({'watchlist.json':JSON.stringify(A)});
 store.afterGet=async()=>{setMarker(env.file,'epg/held');store.afterGet=null;};
 const out=await PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:store},B);
 assert.equal(out.blocked,true,'a hold between the read and the marker check is seen');assert.equal(rootText(store),JSON.stringify(A));
 // the stale writer: it read the object and found the marker epg/open; the cutover then holds the marker and fences the root (a new etag) before the writer's put
 const env2=open(),store2=bucket({'watchlist.json':JSON.stringify(A)});
 store2.beforePut=async key=>{if(key==='watchlist.json'){setMarker(env2.file,'epg/held');fence(store2);store2.beforePut=null;}};
 const stale=await PublishedEpg.putWatchlistRoot({DB:env2.db,BUCKET:store2},B);
 assert.equal(stale.blocked,false);assert.equal(stale.etag,null,'the put lost the compare-and-swap');
 assert.equal(rootText(store2),JSON.stringify(A)+'\n','the fence content stands, the stale list was not written');
 // after the d1 flip a late writer reads the fence, finds the marker d1 and writes nothing
 setMarker(env2.file,'d1/open');
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:env2.db,BUCKET:store2},B)).blocked,true);assert.equal(rootText(store2),JSON.stringify(A)+'\n');
 // the same writer WITHOUT the fence write would have succeeded: the fence is what drains it
 const env3=open(),store3=bucket({'watchlist.json':JSON.stringify(A)});
 store3.beforePut=async key=>{if(key==='watchlist.json'){setMarker(env3.file,'epg/held');store3.beforePut=null;}};
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:env3.db,BUCKET:store3},B)).etag,etagOf(JSON.stringify(B)),'a marker change alone cannot stop a put that already passed the check: the etag fence is required');
}

// ===== 4. every EPG-side writer goes through it; the generation-addressed copies and the programme stay independent =====
{
 const input=held=>{const env=open({marker:held});return {env,store:bucket({'watchlist.json':JSON.stringify(A)})};};
 for(const marker of ['epg/open','epg/held','d1/open']){
  const {env,store}=input(marker);
  const ok=await PublishedEpg.writeMirrors({DB:env.db,BUCKET:store},{programmeRunId:RUN,programme:{runId:RUN,films:[]},watchlist:B,phase:'published'});
  assert.equal(ok,true,marker+': the mirror write completes');
  assert.equal(store.objects.has('epg/generations/'+RUN+'/watchlist.json'),true,marker+': the generation-addressed copy is written');
  assert.equal(store.objects.has('epg/generations/'+RUN+'/programme.json'),true,marker+': the programme copy is written');
  assert.equal(store.objects.has('programme.json'),true,marker+': the programme root is written');
  assert.equal(rootText(store),marker==='epg/open'?JSON.stringify(B):JSON.stringify(A),marker+': the root watchlist moves only in epg/open');
 }
}

// ===== 5. inventory: no other writer of the root key =====
{
 const read=file=>fs.readFileSync(file,'utf8');
 const published=read('src/published-epg.js'),worker=read('src/worker.js');
 // inside published-epg.js the root key is put only by putWatchlistRoot
 assert.equal(/putStable\((?:env\.BUCKET|bucket),WATCHLIST_KEY/.test(published),false,'no unguarded putStable of the root key');
 assert.equal((published.match(/bucket\.put\(WATCHLIST_KEY/g)||[]).length,2,'the two puts of the root key are the ones inside putWatchlistRoot');
 // the Worker's fallback tails reach the guarded writer through saveJSON
 assert.match(worker,/key==='watchlist\.json'&&typeof PublishedEpg!=='undefined'&&typeof PublishedEpg\.putWatchlistRoot==='function'/,'saveJSON routes the root key through the guarded writer');
 assert.equal([...worker.matchAll(/saveJSON\(env,'watchlist\.json'/g)].length,3,'the three fallback sites are the inventory');
 for(const file of fs.readdirSync('src').filter(name=>name.endsWith('.js')&&name!=='published-epg.js'&&name!=='worker.js')){
  const text=read('src/'+file);
  assert.equal(/(?:saveJSON|put|putStoredJson|putStable)\([^)]*['"]watchlist\.json['"]/.test(text),false,file+' writes the root watchlist mirror');
 }
}
console.log('watchlist root fence: ok');
