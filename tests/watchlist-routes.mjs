// ADR 0186 (AIR-569), review of PR 845: the Watchlist read routes through the PRODUCTION BUNDLE against an instrumented sqlite D1 and R2 (the harness of AIR-412/AIR-541). Offline: no Cloudflare,
// Letterboxd, TMDB or production. Covered: the joined shows of a new trusted member survive GET /api/programme with `availableUntil`; a blocked identity claim attaches nothing; a held authority is a
// typed 503 and never degrades into the programme or an EPG copy; a transient D1 fault answers only from a validated standalone Watchlist mirror; the marker move after the read is a retryable 409.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {loadBundle,buildScenario,root,SITE} from './get-write-audit-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import * as PublishedEpg from '../src/published-epg.js';
import * as Watchlist from '../src/watchlist-d1.js';

const bundle=await loadBundle(),scenario=await buildScenario('d1');
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
const NOW=Date.now(),PAST=new Date(NOW-3600000).toISOString();
const RUN2='33333333-3333-4333-8333-333333333333';
const w1={id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,genres:[],directors:[],actors:[],shows:[]};
const SHOW={channel:'Ch 1',start:NOW+3600000,end:NOW+3600000+7200000};
const member=(lid,title)=>({id:lid,title,year:2021,url:'https://letterboxd.com/film/'+lid+'/'});
let counter=0;
const put=(bucket,key,value)=>bucket.objects.set(key,{text:typeof value==='string'?value:JSON.stringify(value),customMetadata:{}});
class Bucket extends MemoryBucket{
 constructor(){super();this.writes=[];this.gets=[];}
 async put(key,body,options){this.writes.push('put:'+key);return super.put(key,body,options);}
 async delete(key){this.writes.push('delete:'+key);return super.delete(key);}
 async get(key){this.gets.push(key);return super.get(key);}
}
const MIRROR=key=>key==='programme.json'||key==='watchlist.json'||/^epg\/(generations\/[^/]+\/(programme|watchlist)|published-generation)\.json$/.test(key);
// One database per case: Film/Person open, a second published generation whose programme carries a Discovery-assigned catalog row with a stored confirmed show for TMDB 90,
// a Watchlist snapshot [w1, new1], and (optionally) a canonical Film that owns TMDB 90 and the Letterboxd id `new1`.
async function arrange({canonical='trusted',snapshot=true,marker="UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;",mirrors=null}={}){
 const file=path.join(root,'w'+(counter++)+'.sqlite');fs.copyFileSync(scenario.dbFile,file);
 const db=d1Standin(file);db.sql(OPEN);
 const bucket=new Bucket();
 for(const [key,item] of scenario.snapshot)if(!MIRROR(key))bucket.objects.set(key,{text:item.text,customMetadata:{}});
 const programme={runId:RUN2,updatedAt:PAST,watchlistCount:1,films:[w1],catalogFilms:[{id:'tmdb_90',tmdbId:'90',shows:[SHOW]}],stats:{}};
 const published=await PublishedEpg.publishGeneration({DB:db,BUCKET:bucket},{programmeRunId:RUN2,phase:'published',expectedProgrammeRunId:'22222222-2222-4222-8222-222222222222',programme,watchlist:{updatedAt:PAST,films:[w1]}},{now:NOW});
 assert.ok(published.pointed,'the second generation is published');
 if(canonical){
  db.sql("INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:90',1,'"+PAST+"')");
  db.sql("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:90','tmdb','90',1,0,NULL),('film:tmdb:90','letterboxd','new1',1,"+(canonical==='blocked'?1:0)+",NULL)");
 }
 db.sql("UPDATE watchlist_authority SET mode='d1',generation=1,writes='open' WHERE id=1;");
 if(snapshot){
  const out=await Watchlist.publishSnapshot(db,[member('w1','Hot Film'),member('new1','New Film')],{scanId:'s1',observedAt:PAST,completedAt:PAST},{now:NOW-1000});
  assert.equal(out.ok,true,JSON.stringify(out));
 }
 db.sql("UPDATE watchlist_authority SET mode='epg',generation=0,writes='open' WHERE id=1;");
 if(marker)db.sql(marker);
 if(mirrors)mirrors(bucket);
 return {file,db,bucket};
}
async function call(pathname,made,{fail=null,failBatch=null,message='D1 DB is overloaded',after=null}={}){
 const writes=[];
 const db=d1Standin(made.file,{onBatch:async statements=>{if(failBatch&&failBatch(statements.map(item=>item.text).join(' ; ')))throw new Error(message);},onQuery:async text=>{if(/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(text))writes.push(text.slice(0,60));if(fail&&fail(text))throw new Error(message);if(after)await after(text);}});
 const env={BUCKET:made.bucket,DB:db,TMDB_API_READ_ACCESS_TOKEN:'t'};
 const log=console.log;console.log=()=>{};
 let response;try{response=await bundle.worker.fetch(new Request(SITE+pathname),env,{waitUntil(){}});}finally{console.log=log;}
 const text=await response.text();let body=null;try{body=JSON.parse(text);}catch{}
 return {status:response.status,body,headers:response.headers,writes,bucket:made.bucket};
}

// ===== 1. P1: the joined shows of a new trusted member survive /api/programme =====
{
 const r=await call('/api/programme',await arrange());
 assert.equal(r.status,200,JSON.stringify(r.body).slice(0,300));
 assert.deepEqual(r.body.films.map(film=>film.id),['w1','new1'],'membership and order from the snapshot');
 const fresh=r.body.films[1];
 assert.equal(fresh.shows.length,1,'a trusted new member with a stored confirmed catalog show keeps it through programmeWithWatchlist');
 assert.equal(fresh.shows[0].channel,'Ch 1');
 assert.equal(fresh.availableUntil,new Date(SHOW.start+72*3600000).toISOString(),'availableUntil comes from the joined show');
 assert.equal(fresh.scheduleKnown,undefined);
 assert.deepEqual(r.writes,[],'a read writes nothing');assert.deepEqual(r.bucket.writes,[]);
 const w=await call('/api/watchlist',await arrange());
 assert.equal(w.status,200);assert.deepEqual(w.body.films.map(film=>film.id),['w1','new1']);assert.equal(w.body.films[1].shows.length,1);
 assert.equal(w.body.snapshot.version,1);assert.equal(w.body.snapshot.stale,false);
}

// ===== 2. P1: a blocked (conflicting) Letterboxd claim is not an identity =====
{
 const r=await call('/api/programme',await arrange({canonical:'blocked'}));
 assert.equal(r.status,200);
 assert.deepEqual(r.body.films.map(film=>film.id),['w1','new1']);
 assert.deepEqual(r.body.films[1].shows,[],'the blocked claim attaches no stored show');
 assert.equal(r.body.films[1].scheduleKnown,false,'unknown, not an empty-availability fact');
 const none=await call('/api/programme',await arrange({canonical:null}));
 assert.deepEqual(none.body.films[1].shows,[],'no canonical Film: no shows');
}

// ===== 3. P1: a held authority is a typed 503; it never degrades into a programme or an EPG copy =====
{
 const mirrors=bucket=>{
  put(bucket,'epg/published-generation.json',{programmeRunId:RUN2,phase:'published'});
  put(bucket,'epg/generations/'+RUN2+'/programme.json',{runId:RUN2,updatedAt:PAST,watchlistCount:1,films:[w1],stats:{}});
  put(bucket,'epg/generations/'+RUN2+'/watchlist.json',{updatedAt:PAST,films:[w1]});
  put(bucket,'programme.json',{runId:RUN2,updatedAt:PAST,watchlistCount:1,films:[w1],stats:{}});
  put(bucket,'watchlist.json',{updatedAt:PAST,films:[w1]});
 };
 const held="UPDATE watchlist_authority SET mode='d1',generation=2,writes='held' WHERE id=1;";
 for(const route of ['/api/watchlist','/api/programme']){
  const r=await call(route,await arrange({marker:held,mirrors}));
  assert.equal(r.status,503,route);assert.equal(r.body.reason,'watchlist_writes_held',route);assert.equal(r.body.source,undefined,route+' is not a mirror answer');
  assert.equal(r.body.films,undefined,route+' builds no membership');
  assert.deepEqual(r.bucket.gets.filter(MIRROR),[],route+': no mirror object was read for a structural refusal');
 }
 const finds=await call('/api/catalog/available',await arrange({marker:held,mirrors}));
 assert.equal(finds.status,503,'/api/catalog/available: held is a typed 503');assert.equal(finds.body.reason,'watchlist_writes_held');assert.equal(finds.body.films,undefined);
 // the same for a contradicting marker (a deleted fence row)
 const closed=await arrange({marker:"UPDATE watchlist_authority SET mode='d1',generation=1;DROP TRIGGER watchlist_cas_required;DELETE FROM watchlist_cas;",snapshot:false,mirrors});
 const c=await call('/api/watchlist',closed);
 assert.equal(c.status,503);assert.equal(c.body.reason,'watchlist_authority_closed');assert.equal(c.body.films,undefined);
 // marker d1 with no snapshot at all: refused, never the EPG list
 const absent=await call('/api/watchlist',await arrange({snapshot:false,mirrors}));
 assert.equal(absent.status,503);assert.equal(absent.body.reason,'watchlist_snapshot_absent');assert.equal(absent.body.films,undefined);
}

// ===== 4. P1: a transient D1 fault answers only from a validated STANDALONE Watchlist mirror =====
{
 const transient=text=>/FROM watchlist_member/.test(text)&&/FROM watchlist_current/.test(text);
 const epgOnly=bucket=>{
  put(bucket,'epg/published-generation.json',{programmeRunId:RUN2,phase:'published'});
  put(bucket,'epg/generations/'+RUN2+'/programme.json',{runId:RUN2,updatedAt:PAST,watchlistCount:1,films:[w1],stats:{}});
  put(bucket,'programme.json',{runId:RUN2,updatedAt:PAST,watchlistCount:1,films:[w1],stats:{}});
  put(bucket,'watchlist.json',{updatedAt:PAST,films:[w1]});
 };
 const noStandalone=await call('/api/watchlist',await arrange({mirrors:epgOnly}),{failBatch:transient});
 assert.equal(noStandalone.status,503,'no eligible standalone mirror: the typed refusal, not a generic 502');assert.equal(noStandalone.body.error,'storage_unavailable');assert.equal(noStandalone.body.reason,'watchlist_unavailable');assert.equal(noStandalone.body.source,undefined);assert.equal(noStandalone.body.films,undefined);
 const missing=await call('/api/watchlist',await arrange({mirrors:bucket=>{put(bucket,'programme.json',{runId:RUN2,updatedAt:PAST,watchlistCount:1,films:[w1],stats:{}});}}),{failBatch:transient});
 assert.equal(missing.status,503,'only a programme exists: membership is never synthesized from it, the typed refusal answers');assert.equal(missing.body.reason,'watchlist_unavailable');assert.equal(missing.body.films,undefined);
 const standalone={updatedAt:PAST,source:'watchlist_authority',snapshotId:'snap',snapshotVersion:4,lastSuccessAt:PAST,films:[member('w1','Hot Film'),member('new1','New Film')]};
 const ok=await call('/api/watchlist',await arrange({mirrors:bucket=>{epgOnly(bucket);put(bucket,'watchlist.json',standalone);}}),{failBatch:transient});
 assert.equal(ok.status,200);assert.equal(ok.body.source,'mirror');assert.equal(ok.body.snapshotVersion,4,'labelled with its snapshot version');assert.equal(ok.body.lastSuccessAt,PAST);
 assert.deepEqual(ok.body.films.map(film=>film.id),['w1','new1']);assert.deepEqual(ok.bucket.writes,[],'a degraded read writes nothing');
 // a degraded /api/programme never joins the root watchlist, and a watchlist-only mirror never becomes a programme
 const prog=await call('/api/programme',await arrange({mirrors:bucket=>{epgOnly(bucket);put(bucket,'watchlist.json',standalone);}}),{failBatch:transient});
 assert.equal(prog.status,200);assert.equal(prog.body.source,'mirror');assert.equal(prog.body.joined,'none','the standalone root mirror is not a same-run pair');assert.deepEqual(prog.body.films.map(film=>film.id),['w1']);
 const only=await call('/api/programme',await arrange({mirrors:bucket=>{put(bucket,'watchlist.json',standalone);}}),{failBatch:transient});
 assert.equal(only.status,503);assert.equal(only.body.reason,'watchlist_unavailable');assert.equal(only.body.scheduleUnavailable,undefined);
 // the temporary fault with no eligible mirror on the other reader routes: exact typed status too
 const finds=await call('/api/catalog/available',await arrange(),{failBatch:transient});
 assert.equal(finds.status,503,'GET /api/catalog/available keeps the typed refusal');assert.equal(finds.body.reason,'watchlist_unavailable');
}

// ===== 5. P1: the marker moves after the read and before the response =====
{
 const made=await arrange();
 let moved=false;
 // the last reads of the route are the owner reviews: flip the marker once the route got past the composition
 const r=await call('/api/watchlist',made,{after:async text=>{if(!moved&&/owner_review/i.test(text)){moved=true;d1Standin(made.file).sql("UPDATE watchlist_authority SET writes='held',generation=2");}}});
 assert.equal(moved,true,'the flip happened after the composition');
 assert.equal(r.status,409);assert.equal(r.body.error,'watchlist_authority_moved');assert.equal(r.body.retry,true);assert.equal(r.body.films,undefined,'the old state is not answered');
 const epgMade=await arrange({marker:'',snapshot:false});let flipped=false;
 const p=await call('/api/programme',epgMade,{after:async text=>{if(!flipped&&/owner_review/i.test(text)){flipped=true;d1Standin(epgMade.file).sql("UPDATE watchlist_authority SET mode='d1',generation=1");}}});
 assert.equal(flipped,true);assert.equal(p.status,409,'epg -> d1 during the request is never answered from the EPG list');
}

// ===== 6. review: the EPG never overwrites the standalone root watchlist.json mirror in d1 mode =====
{
 const standalone={updatedAt:PAST,source:'watchlist_authority',snapshotId:'snap',snapshotVersion:9,lastSuccessAt:PAST,films:[member('w1','Hot Film'),member('new1','New Film')]};
 const programme={runId:RUN2,updatedAt:PAST,watchlistCount:1,films:[w1],stats:{}};
 const epgCopy={updatedAt:PAST,films:[w1]};
 const rootOf=bucket=>JSON.parse(bucket.objects.get('watchlist.json').text);
 const generationKey='epg/generations/'+RUN2+'/watchlist.json';
 // d1: the root mirror is left alone, the generation-addressed copy is written, the call still succeeds, and a repair finds nothing to write
 const made=await arrange();
 put(made.bucket,'watchlist.json',standalone);
 const env={DB:made.db,BUCKET:made.bucket};
 assert.equal(await PublishedEpg.writeMirrors(env,{programmeRunId:RUN2,programme,watchlist:epgCopy,phase:'published'}),true);
 assert.equal(rootOf(made.bucket).source,'watchlist_authority','the EPG did not overwrite the independent root mirror');assert.equal(rootOf(made.bucket).snapshotVersion,9);
 assert.ok(made.bucket.objects.has(generationKey),'the generation-addressed copy stays EPG-owned');
 assert.deepEqual(JSON.parse(made.bucket.objects.get(generationKey).text),epgCopy);
 const repaired=await PublishedEpg.repairMirrors(env);
 assert.equal(rootOf(made.bucket).snapshotVersion,9,'the hourly repair does not touch it either');assert.equal(typeof repaired.mirrored,'boolean');
 // an unreadable marker fails closed: the root write is skipped
 const flaky=d1Standin(made.file,{onQuery:async text=>{if(/FROM watchlist_authority/.test(text))throw new Error('D1 DB is overloaded');}});
 await PublishedEpg.writeMirrors({DB:flaky,BUCKET:made.bucket},{programmeRunId:RUN2,programme,watchlist:epgCopy,phase:'published'});
 assert.equal(rootOf(made.bucket).snapshotVersion,9,'a storage error never lets the EPG write the root mirror');
 // marker epg (and the tables absent): today's behavior, the EPG writes the root mirror
 const legacy=await arrange({marker:'',snapshot:false});
 put(legacy.bucket,'watchlist.json',standalone);
 assert.equal(await PublishedEpg.writeMirrors({DB:legacy.db,BUCKET:legacy.bucket},{programmeRunId:RUN2,programme,watchlist:epgCopy,phase:'published'}),true);
 assert.deepEqual(rootOf(legacy.bucket),epgCopy,'marker epg: the EPG owns the root mirror, unchanged');
 const noTables=path.join(root,'w-notables.sqlite');fs.copyFileSync(scenario.dbFile,noTables);
 const old=d1Standin(noTables);old.sql("DROP TABLE watchlist_admission_pending;DROP TABLE watchlist_effect;DROP TABLE watchlist_change;DROP TABLE watchlist_member;DROP TABLE watchlist_snapshot;DROP TABLE watchlist_staging;DROP TABLE watchlist_current;DROP TABLE watchlist_cas;DROP TABLE watchlist_authority;");
 // a database BELOW the Watchlist migration (schema 30, none of its tables): the maintained authority contract's legacy case. The same tables at schema 33 would be a contradiction and closed.
 old.sql("DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=30");
 const bare=new Bucket();
 await PublishedEpg.publishGeneration({DB:old,BUCKET:bare},{programmeRunId:RUN2,phase:'published',expectedProgrammeRunId:'22222222-2222-4222-8222-222222222222',programme,watchlist:epgCopy},{now:NOW});
 assert.equal(await PublishedEpg.writeMirrors({DB:old,BUCKET:bare},{programmeRunId:RUN2,programme,watchlist:epgCopy,phase:'published'}),true);
 assert.deepEqual(rootOf(bare),epgCopy,'tables absent: the EPG owns the root mirror, unchanged');
}

// ===== 7. review 2: an in-flight pre-switch EPG run never writes its list over the standalone root =====
{
 const standalone={updatedAt:PAST,source:'watchlist_authority',snapshotId:'snap',snapshotVersion:9,lastSuccessAt:PAST,films:[member('w1','Hot Film')]};
 const worker=fs.readFileSync('src/worker.js','utf8');
 // every direct EPG write of the root key is behind the current-authority fence (no start-time pin alone)
 const sites=[...worker.matchAll(/saveJSON\(env,'watchlist\.json'/g)];
 assert.equal(sites.length,3);
 for(const site of sites){
  const line=worker.slice(worker.lastIndexOf('\n',site.index)+1,worker.indexOf('\n',site.index));
  assert.match(line,/epgMayWriteWatchlistRoot|PublishedEpg\.saveWatchlist|if\(!saved\)/,'a root watchlist write without the current-authority fence: '+line.slice(0,120));
 }
 // behavior of the fence itself on one binding: an OLD run (no pin) after epg -> d1, and a storage error
 const made=await arrange({marker:'',snapshot:false});
 const owned=await PublishedEpg.watchlistRootOwned({DB:made.db,BUCKET:made.bucket});
 assert.equal(owned,false,'marker epg: the EPG owns the root');
 d1Standin(made.file).sql("UPDATE watchlist_authority SET mode='d1',generation=1");
 assert.equal(await PublishedEpg.watchlistRootOwned({DB:d1Standin(made.file),BUCKET:made.bucket}),true,'epg -> d1 on the same database: the old run no longer owns it');
 const flaky=d1Standin(made.file,{onQuery:async()=>{throw new Error('D1 DB is overloaded');}});
 assert.equal(await PublishedEpg.watchlistRootOwned({DB:flaky,BUCKET:made.bucket}),true,'a storage error fails closed');
}
console.log('watchlist-routes: ok');
