// AIR-571 (C3): the root `watchlist.json` mirror at the authority boundary. One guarded writer on the EPG side (PublishedEpg.putWatchlistRoot): refuse a state known not to be writable before touching the object,
// read the object, check the marker AGAIN after the read, conditional put by etag with a FRESH in-object token. Offline only: the sqlite D1 stand-in and an in-memory bucket with content etags (so an etag CAN
// repeat if the bytes repeat), conditional puts and hooks between the steps of a writer.
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
// An in-memory bucket: CONTENT etags (the same bytes give the same etag again), conditional puts, and hooks between the steps of a writer.
function bucket(initial={}){
 const objects=new Map(Object.entries(initial).map(([key,text])=>[key,{text,etag:etagOf(text)}]));
 const log=[];
 const store={objects,log,afterGet:null,beforePut:null,failGetKey:null,
  async get(key){log.push('get '+key);if(store.failGetKey===key)throw new Error('R2 get failed');const o=objects.get(key)||null;const result=o?{etag:o.etag,text:async()=>o.text}:null;if(store.afterGet)await store.afterGet(key);return result;},
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
function open({marker='epg/open',upTo=null}={}){
 const file=path.join(root,'db-'+(copies++)+'.sqlite');
 sqlite(file,names.filter(name=>!upTo||name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 sqlite(file,"INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('"+RUN+"','published','2026-11-21T16:11:45.255Z','"+'a'.repeat(64)+"','2026-11-21T16:00:00.000Z');UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+RUN+"', generation=515, finalized_run_id='"+RUN+"' WHERE id=1;");
 sqlite(file,"INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('"+RUN+"','programme',0,'"+JSON.stringify({runId:RUN,updatedAt:'2026-11-21T16:11:45.255Z',films:[]})+"'),('"+RUN+"','watchlist',0,'"+JSON.stringify(A).replace(/'/g,"''")+"');");
 if(!upTo||upTo>='0031'){const [mode,writes]=marker.split('/');sqlite(file,"UPDATE watchlist_authority SET mode='"+mode+"', writes='"+writes+"', generation=1");}
 return {file,db:d1Standin(file)};
}
const setMarker=(file,marker)=>{const [mode,writes]=marker.split('/');sqlite(file,"UPDATE watchlist_authority SET mode='"+mode+"', writes='"+writes+"'");};
// An existing root as an earlier writer left it: the list without a token (the legacy bytes) or with one.
const legacyRoot=doc=>JSON.stringify(doc);
const rootDoc=store=>JSON.parse(store.objects.get('watchlist.json').text);
const rootEtag=store=>store.objects.get('watchlist.json')?.etag??null;
const same=(doc,expected)=>PublishedEpg.rootSemantic(doc)===PublishedEpg.rootSemantic(expected);
const rootText=store=>store.objects.get('watchlist.json').text;
const rows1=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});return JSON.parse(r.stdout)[0].version;};
// The operator's fence for a held generation (what `fence-root` writes): the same list, a fresh nonce, the generation.
const fence=(store,generation,expectedEtag=rootEtag(store))=>{
 const doc=rootDoc(store);const text=PublishedEpg.serializeRoot(doc,{fenceGeneration:generation});
 if(store.objects.get('watchlist.json').etag!==expectedEtag)return null;
 store.objects.set('watchlist.json',{text,etag:etagOf(text)});return etagOf(text);
};

// ===== 1. the normal path: epg/open, the legacy schema, no bucket =====
{
 const env=open(),store=bucket();const e={DB:env.db,BUCKET:store};
 const first=await PublishedEpg.putWatchlistRoot(e,A);
 assert.equal(first.blocked,false);assert.equal(first.etag,rootEtag(store),'an absent root is created');
 assert.equal(same(rootDoc(store),A),true);assert.match(rootText(store),/\n\n[ \t]{64}$/,'every root write carries a whitespace token no JSON reader sees');
 assert.deepEqual(rootDoc(store),A,'the parsed document is exactly the list');
 assert.equal(PublishedEpg.rootFence(rootText(store)),null,'a normal write is not a fence');
 // a semantically equal root is not rewritten (the token is ignored), so a steady state does not churn
 const equal=await PublishedEpg.putWatchlistRoot(e,A);assert.equal(equal.etag,first.etag);assert.equal(store.log.filter(l=>l==='put watchlist.json').length,1);
 const next=await PublishedEpg.putWatchlistRoot(e,B);assert.notEqual(next.etag,first.etag);assert.equal(same(rootDoc(store),B),true,'a different list is a compare-and-swap');
 // the same list written again after another list never repeats an earlier representation
 const seen=new Set([first.etag,next.etag]);
 const back=await PublishedEpg.putWatchlistRoot(e,A);assert.equal(seen.has(back.etag),false,'identical logical content, a new representation');
 // an existing legacy root (no token) with the same list is not rewritten; a different one is replaced
 const old=bucket({'watchlist.json':legacyRoot(A)});
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:old},A)).etag,etagOf(legacyRoot(A)));assert.equal(old.log.some(l=>l.startsWith('put')),false);
 // migrations below 0031: the marker table does not exist, positively verified, the EPG owns the root as before
 const legacy=open({upTo:'0030'}),lstore=bucket();
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:legacy.db,BUCKET:lstore},A)).blocked,false);assert.equal(await PublishedEpg.watchlistRootOwned({DB:legacy.db}),false);
 assert.deepEqual(await PublishedEpg.putWatchlistRoot({DB:env.db},A),{blocked:false,etag:null},'no bucket binding: nothing to guard, nothing written');
}

// ===== 2. fail closed: only epg/open (or the positively absent schema) admits a root writer =====
for(const marker of ['epg/held','d1/open','d1/held']){
 const env=open({marker}),store=bucket({'watchlist.json':legacyRoot(A)});
 const out=await PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:store},B);
 assert.equal(out.blocked,true,marker);assert.equal(store.objects.get('watchlist.json').text,legacyRoot(A),marker+': the root is untouched');
 assert.deepEqual(store.log,[],marker+': a known not-owned state touches neither the object nor the store');
 assert.equal(await PublishedEpg.watchlistRootOwned({DB:env.db,BUCKET:store}),true,marker);
}
{
 const env=open(),store=bucket({'watchlist.json':legacyRoot(A)});
 const flaky=d1Standin(env.file,{onQuery:async()=>{throw new Error('D1 DB is overloaded');}});
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:flaky,BUCKET:store},B)).blocked,true,'an unreadable marker fails closed');
 assert.equal(await PublishedEpg.watchlistRootOwned({DB:env.db}),false,'epg/open: the EPG owns the root');
 // a missing singleton row in an installed schema, and a missing fence row, block
 const gone=open();sqlite(gone.file,'DELETE FROM watchlist_authority');
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:gone.db,BUCKET:bucket()},A)).blocked,true,'a missing marker row is not a legacy schema');
 const noCas=open();sqlite(noCas.file,'DROP TRIGGER watchlist_cas_required;DELETE FROM watchlist_cas');
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:noCas.db,BUCKET:bucket()},A)).blocked,true,'a missing fence row blocks');
 // the legacy case is the maintained contract of WatchlistD1.readAuthority: schema BELOW 31 with none of the tables. A partial table set, or an installed schema (v33) without the marker table or without any
 // Watchlist table, is closed and blocks
 const partial=open();sqlite(partial.file,'DROP TABLE watchlist_admission_pending');
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:partial.db,BUCKET:bucket()},A)).blocked,true,'a partial table set blocks');
 const noAuthority=open();sqlite(noAuthority.file,'DROP TRIGGER watchlist_cas_required;DROP TABLE watchlist_authority');
 assert.equal(Number(rows1(noAuthority.file,'SELECT version FROM schema_contract')),45);
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:noAuthority.db,BUCKET:bucket()},A)).blocked,true,'schema v33 with the authority table missing is not a legacy database');
 const noTables=open();sqlite(noTables.file,'PRAGMA foreign_keys=OFF;'+['watchlist_admission_pending','watchlist_effect','watchlist_change','watchlist_member','watchlist_snapshot','watchlist_staging','watchlist_current','watchlist_cas','watchlist_authority'].map(name=>'DROP TABLE '+name).join(';'));
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:noTables.db,BUCKET:bucket()},A)).blocked,true,'schema v33 with no Watchlist table at all is a contradiction, not a legacy database');
 // the genuine legacy database (schema v30, no Watchlist table) still admits the writer
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:open({upTo:'0030'}).db,BUCKET:bucket()},A)).blocked,false,'a genuine pre-0031 database stays writable');
}

// ===== 3. the fence order: the marker is read AFTER the object, and the put is conditional on that read =====
{
 // a hold between the read and the second marker check stops the writer
 const env=open(),store=bucket({'watchlist.json':legacyRoot(A)});
 store.afterGet=async()=>{setMarker(env.file,'epg/held');store.afterGet=null;};
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:store},B)).blocked,true,'a hold between the read and the marker check is seen');
 assert.equal(store.objects.get('watchlist.json').text,legacyRoot(A));
 // the stale writer: it read the object and found the marker epg/open; the cutover then holds the marker and fences the root before the writer's put
 const env2=open(),store2=bucket({'watchlist.json':legacyRoot(A)});
 store2.beforePut=async key=>{if(key==='watchlist.json'){setMarker(env2.file,'epg/held');fence(store2,1);store2.beforePut=null;}};
 const stale=await PublishedEpg.putWatchlistRoot({DB:env2.db,BUCKET:store2},B);
 assert.equal(stale.blocked,false);assert.equal(stale.etag,null,'the put lost the compare-and-swap');assert.equal(same(rootDoc(store2),A),true,'the stale list was not written');assert.equal(PublishedEpg.rootFence(rootText(store2)).generation,1);
 // after the d1 flip a late writer is blocked without touching the object
 setMarker(env2.file,'d1/open');store2.log.length=0;
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:env2.db,BUCKET:store2},B)).blocked,true);assert.deepEqual(store2.log,[]);
 // a marker change alone cannot stop a put that already passed both checks: the etag fence is required
 const env3=open(),store3=bucket({'watchlist.json':legacyRoot(A)});
 store3.beforePut=async key=>{if(key==='watchlist.json'){setMarker(env3.file,'epg/held');store3.beforePut=null;}};
 assert.equal((await PublishedEpg.putWatchlistRoot({DB:env3.db,BUCKET:store3},B)).blocked,false);assert.equal(same(rootDoc(store3),B),true,'without the fence the put goes through');
}

// ===== 4. the ABA: a stale writer survives no sequence of fences and writes =====
{
 const env=open(),store=bucket({'watchlist.json':legacyRoot(A)});
 const x=rootEtag(store);
 // W read the legacy bytes (etag x) and passed the marker check; it is now suspended before its put
 let release;const gate=new Promise(resolve=>{release=resolve;});
 store.beforePut=async key=>{if(key==='watchlist.json'&&!store.suspended){store.suspended=true;await gate;}};
 const writer=PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:store},B);
 await new Promise(resolve=>setTimeout(resolve,20));
 // hold, a first fence, a second fence (the first one's etag), activate, release, a rollback, and normal writes with IDENTICAL logical content
 setMarker(env.file,'epg/held');
 const y=fence(store,1);assert.notEqual(y,x);
 const z=fence(store,1,y);assert.notEqual(z,x);assert.notEqual(z,y,'a second fence is a new representation too');
 setMarker(env.file,'d1/held');setMarker(env.file,'d1/open');
 setMarker(env.file,'d1/held');setMarker(env.file,'epg/held');setMarker(env.file,'epg/open');
 const same1=await PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:store},A);
 assert.equal(same1.etag,z,'identical logical content over a fenced root is not rewritten, and never restores the legacy bytes');
 // a normal write of other content and back again still never produces the first representation
 await PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:store},A) ;
 release();
 const lost=await writer;
 assert.equal(lost.etag,null,'the suspended writer loses its compare-and-swap after two fences, a flip, a rollback and identical content');
 assert.equal(same(rootDoc(store),A),true,'its list was not written');
 // later representations of the same logical list are all different from x
 const w2=await PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:store},DOC(['q']));const w3=await PublishedEpg.putWatchlistRoot({DB:env.db,BUCKET:store},A);
 assert.notEqual(w3.etag,x,'the legacy representation never comes back');assert.notEqual(w3.etag,w2.etag);
}

// ===== 5. every EPG-side writer goes through it; the generation copies and the programme stay independent, also when the root fails =====
{
 const root=state=>({env:open({marker:state}),store:bucket({'watchlist.json':legacyRoot(A)})});
 for(const marker of ['epg/open','epg/held','d1/open']){
  const {env,store}=root(marker);
  const ok=await PublishedEpg.writeMirrors({DB:env.db,BUCKET:store},{programmeRunId:RUN,programme:{runId:RUN,films:[]},watchlist:B,phase:'published'});
  assert.equal(ok,true,marker+': the mirror write completes');
  assert.equal(store.objects.has('epg/generations/'+RUN+'/watchlist.json'),true,marker+': the generation-addressed copy is written');
  assert.equal(store.objects.has('epg/generations/'+RUN+'/programme.json'),true,marker+': the programme copy is written');
  assert.equal(store.objects.has('programme.json'),true,marker+': the programme root is written');
  assert.equal(same(rootDoc(store),marker==='epg/open'?B:A),true,marker+': the root watchlist moves only in epg/open');
 }
 // a root-specific failure of the object store does not stop the independent mirrors in a state the EPG does not own
 for(const marker of ['d1/open','d1/held','epg/held']){
  const {env,store}=root(marker);store.failGetKey='watchlist.json';
  const ok=await PublishedEpg.writeMirrors({DB:env.db,BUCKET:store},{programmeRunId:RUN,programme:{runId:RUN,films:[]},watchlist:B,phase:'published'});
  assert.equal(ok,true,marker+': a failing root does not abort the mirror write');
  assert.equal(store.objects.has('epg/generations/'+RUN+'/watchlist.json'),true,marker);assert.equal(store.log.includes('get watchlist.json'),false,marker+': the root is never read');
  const repaired=await PublishedEpg.repairMirrors({DB:env.db,BUCKET:store});
  assert.equal(repaired.mirrored,true,marker+': the repair proceeds with a failing root');
 }
 // in epg/open the root IS the EPG's: a failing root is a failed mirror, never a false success
 {
  const {env,store}=root('epg/open');store.failGetKey='watchlist.json';
  assert.equal(await PublishedEpg.writeMirrors({DB:env.db,BUCKET:store},{programmeRunId:RUN,programme:{runId:RUN,films:[]},watchlist:B,phase:'published'}),false,'epg/open: a failing root is a failed mirror');
 }
 // the repair does not rewrite an equal root (the token is not part of the comparison)
 {
  const {env,store}=root('epg/open');
  const input={programmeRunId:RUN,programme:{runId:RUN,films:[]},watchlist:A,phase:'published'};
  await PublishedEpg.writeMirrors({DB:env.db,BUCKET:store},input);
  const before=rootEtag(store);const puts=store.log.filter(l=>l==='put watchlist.json').length;
  await PublishedEpg.writeMirrors({DB:env.db,BUCKET:store},input);
  assert.equal(rootEtag(store),before);assert.equal(store.log.filter(l=>l==='put watchlist.json').length,puts,'a second mirror write of the same list does not rewrite the root');
 }
}

// ===== 6. inventory: no other writer of the root key =====
{
 const read=file=>fs.readFileSync(file,'utf8');
 const published=read('src/published-epg.js'),worker=read('src/worker.js');
 assert.equal(/putStable\((?:env\.BUCKET|bucket),WATCHLIST_KEY/.test(published),false,'no unguarded putStable of the root key');
 assert.equal((published.match(/bucket\.put\(WATCHLIST_KEY/g)||[]).length,3,'the three puts of the root key: two inside putWatchlistRoot (EPG side) and one inside putStandaloneWatchlistRoot (Watchlist side, AIR-571 M1)');
 assert.match(worker,/if\(key==='watchlist\.json'\)\{[^}]*saveWatchlistRoot\(env,value\)/,'saveJSON routes the root key through the guarded writer');
 assert.match(worker,/async function saveWatchlistRoot\(env,value\)\{[^}]*PublishedEpg\.putWatchlistRoot\(env,value\)/,'the router calls the one guarded writer');
 assert.equal([...worker.matchAll(/saveJSON\(env,'watchlist\.json'/g)].length,3,'the three fallback sites are the inventory');
 for(const file of fs.readdirSync('src').filter(name=>name.endsWith('.js')&&name!=='published-epg.js'&&name!=='worker.js')){
  const text=read('src/'+file);
  assert.equal(/(?:saveJSON|put|putStoredJson|putStable)\([^)]*['"]watchlist\.json['"]/.test(text),false,file+' writes the root watchlist mirror');
 }
}
// ===== 7. the legacy predicate is the maintained Watchlist authority contract =====
{
 const WatchlistD1=await import('../src/watchlist-d1.js');
 assert.equal(PublishedEpg.WATCHLIST_ROOT_SCHEMA_VERSION,WatchlistD1.SCHEMA_VERSION,'the same schema threshold as WatchlistD1.readAuthority');
 const source=fs.readFileSync('src/watchlist-d1.js','utf8');
 const declared=JSON.parse(/const TABLES=(\[[^\]]*\]);/.exec(source)[1].replace(/'/g,'"'));
 assert.deepEqual([...PublishedEpg.WATCHLIST_ROOT_TABLES],declared,'the same table set as WatchlistD1');
 // and the same answer on the cases the two must agree on
 for(const [label,prepare] of [['epg/open',e=>e],['epg/held',e=>{setMarker(e.file,'epg/held');return e;}],['d1/open',e=>{setMarker(e.file,'d1/open');return e;}],['no marker row',e=>{sqlite(e.file,'DELETE FROM watchlist_authority');return e;}],['partial',e=>{sqlite(e.file,'DROP TABLE watchlist_effect');return e;}]]){
  const e=prepare(open());
  const authority=await WatchlistD1.readAuthority(e.db);
  const writable=!(await PublishedEpg.watchlistRootOwned({DB:e.db}));
  assert.equal(writable,authority.state==='epg'&&authority.writes==='open'||authority.state==='legacy',label+': the root predicate agrees with the Watchlist authority contract');
 }
}
console.log('watchlist root fence: ok');
