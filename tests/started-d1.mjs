// AIR-549 stage 2: Started marks in D1 (schema v29, src/started-d1.js, the D1 branch of src/worker.js, scripts/started-d1-sql.mjs). Offline only: a sqlite D1 stand-in with the real migration chain
// and a recording R2 stand-in. No production database or bucket is opened. (Harness of tests/started.mjs, AIR-516.)
// POST /api/started (AIR-516): the Film of a mark is the canonical D1 Film (verified identity bridge, title, year, trusted TMDB claim), read through the real
// CanonicalCatalogReader over a sqlite D1 stand-in with the real migration chain. The R2 stand-in records every read and write: the frozen metadata.json and programme.json
// are never read for identity, and every refusal leaves zero R2 writes. The started marks and the events stay R2 objects (keys, customMetadata and write order unchanged).
import {webcrypto} from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-started-d1-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const base=path.join(root,'base.sqlite');sqlite(base,names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const MARKER={prepared:VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;"};
MARKER.open=MARKER.prepared+"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";MARKER.held=MARKER.open+"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;";
const T='2026-11-01T00:00:00.000Z';
const film=(id,tmdb,original)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${id}',1,${tmdb?`'tmdb:${tmdb}'`:'NULL'},'${original}','${T}');`;
const claim=(filmId,scheme,value,trusted=1,conflicting=0)=>`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('${filmId}','${scheme}','${value}',${trusted},${conflicting});`;
const title=(filmId,value,status='provisional')=>`INSERT INTO film_dimension (film_id,dimension,status,value,updated_at) VALUES ('${filmId}','localization','${status}','${value}','${T}');`;
const meta=(filmId,year)=>`INSERT INTO film_metadata (film_id,schema_version,year,genres_json,payload_json,updated_at) VALUES ('${filmId}',1,${year},'[]','{}','${T}');`;
const SEED=
 // `one` (lid) = tmdb 11, localized and with a year; `two` = tmdb 12, no localization (the original title is shown); `tmdb_13` is a retained Film that no programme or watchlist names.
 film('film:tmdb:11',11,'Original one')+claim('film:tmdb:11','tmdb','11')+claim('film:tmdb:11','letterboxd','one')+title('film:tmdb:11','Один')+meta('film:tmdb:11',1999)
 +film('film:tmdb:12',12,'Original two')+claim('film:tmdb:12','tmdb','12')+claim('film:tmdb:12','letterboxd','two')+meta('film:tmdb:12',2001)
 +film('film:tmdb:13',13,'Original retained')+claim('film:tmdb:13','tmdb','13')+title('film:tmdb:13','Оставленный','reviewed')+meta('film:tmdb:13',2005)
 // `solo`: a trusted Letterboxd id and no TMDB claim at all.
 +film('film:solo',null,'Original solo')+claim('film:solo','letterboxd','solo')
 // tmdb 14 is claimed by two Films (conflict); `untrusted` is an untrusted alias; tmdb 15 is a redirect source; tmdb 16 is retired by the owner ledger.
 +film('film:tmdb:14',14,'Original 14')+film('film:other14',null,'Other 14')+claim('film:tmdb:14','tmdb','14')+claim('film:other14','tmdb','14',0,0)
 +film('film:untrusted',null,'Original untrusted')+claim('film:untrusted','letterboxd','untrusted',0,0)
 +film('film:tmdb:15',15,'Original 15')+film('film:tmdb:151',151,'Original 151')+claim('film:tmdb:15','tmdb','15')+`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:15','film:tmdb:151','${T}');`
 +film('film:tmdb:16',16,'Original 16')+claim('film:tmdb:16','tmdb','16')
 +`INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('r16','film:tmdb:16','retire','lid16','16','99','{}','{"by":"owner","at":"${T}","source":"t"}','owner_request','{}','${T}');`
 // a Film whose canonical identity names another TMDB id than its trusted claim.
 +film('film:tmdb:17',99,'Original 17')+claim('film:tmdb:17','tmdb','17');
let copies=0;
const database=(marker,seed=SEED,options={})=>{const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(base,file);sqlite(file,seed+(MARKER[marker]||''));return {file,db:d1Standin(file,options)};};

// ---- the Worker: the real reader and authority module over the stand-in, no other D1 domain ----
const records=new Map(),objectMetadata=new Map();let puts=[],reads=[];const prefixes=[];
const bucket={
 get:async k=>{reads.push(k);return records.has(k)?{json:async()=>records.get(k)}:null;},
 put:async(k,v,options)=>{puts.push(k);records.set(k,JSON.parse(v));objectMetadata.set(k,options?.customMetadata);return {};},
 delete:async k=>{puts.push('delete:'+k);return records.delete(k);},
 list:async({prefix,cursor})=>{prefixes.push(prefix);const keys=[...records.keys()].filter(k=>k.startsWith(prefix)).sort();const i=Number(cursor||0);return {objects:keys.slice(i,i+1).map(key=>({key,customMetadata:objectMetadata.get(key)})),truncated:i+1<keys.length,cursor:String(i+1)};}
};
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);
vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader','const {CREDIT_SELECTION_SQL,database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n'),ctx);
vm.runInContext(fs.readFileSync('src/sources.js','utf8'),ctx);vm.runInContext(scoped('src/started-d1.js','StartedD1'),ctx);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),ctx);
import {spawnSync} from 'node:child_process';
import * as StartedD1 from '../src/started-d1.js';

const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const run=(file,text)=>sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<26});
const marks=file=>rows(file,'SELECT id,started,started_at,last_event_json,rev FROM started_mark ORDER BY id');
const authority=file=>rows(file,'SELECT mode,generation,writes FROM started_authority')[0];
const call=(method,body,env,path='/api/started')=>ctx.worker.fetch(new Request('https://site.example'+path,{method,headers:{'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);
const journal=()=>[...records.keys()].filter(k=>k.startsWith('events/items/')).sort().map(k=>records.get(k));
const reset=()=>{for(const k of [...records.keys()])records.delete(k);objectMetadata.clear();puts=[];reads=[];prefixes.length=0;};
const d1Db=(film='open',options={})=>{const made=database(film,SEED,options);sqlite(made.file,"UPDATE started_authority SET mode='d1',generation=1 WHERE id=1;");return made;};

// ===== 1. the migration =====
const m29='0029_started_authority.sql';
assert.ok(names.includes(m29),'0029 exists');
const v28=path.join(root,'v28.sqlite');sqlite(v28,names.filter(name=>name<m29).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
assert.equal(rows(v28,'SELECT version FROM schema_contract WHERE id=1')[0].version,28);
{
 const v27=path.join(root,'v27.sqlite');sqlite(v27,names.filter(name=>name<'0028').map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 const refusal=run(v27,fs.readFileSync('migrations/'+m29,'utf8'));
 assert.notEqual(refusal.status,0,'0029 refuses a version 27 database');
 assert.equal(rows(v27,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'started_%'")[0].n,0,'a refusal creates nothing');
}
const v29=path.join(root,'v29.sqlite');fs.copyFileSync(v28,v29);assert.equal(run(v29,fs.readFileSync('migrations/'+m29,'utf8')).status,0);
assert.equal(rows(v29,'SELECT version FROM schema_contract WHERE id=1')[0].version,29);
assert.deepEqual(rows(v29,'SELECT mode,generation,writes FROM started_authority'),[{mode:'r2',generation:0,writes:'open'}],'the inserted marker is r2, generation 0, writes open');
assert.equal(rows(v29,'SELECT COUNT(*) AS n FROM started_mark')[0].n,0,'applying copies nothing');
assert.notEqual(run(v29,fs.readFileSync('migrations/'+m29,'utf8')).status,0,'a second apply is refused');
assert.notEqual(run(v29,'UPDATE schema_contract SET version=28 WHERE id=1').status,0,'the version never goes down');
assert.notEqual(run(v29,"UPDATE started_authority SET mode='x'").status,0,'mode is constrained');
assert.notEqual(run(v29,"INSERT INTO started_mark (id,started,rev) VALUES ('a',2,1)").status,0,'started is 0 or 1');
assert.notEqual(run(v29,"INSERT INTO started_mark (id,started,rev) VALUES ('a',1,0)").status,0,'rev starts at 1');
assert.notEqual(run(v29,"INSERT INTO started_mark (id,started,last_event_json,rev) VALUES ('a',1,'{not json',1)").status,0,'last_event_json is JSON');
assert.notEqual(run(v29,"INSERT INTO started_mark (id,started,rev) VALUES ('"+'x'.repeat(81)+"',1,1)").status,0,'an id is at most 80 characters');
assert.notEqual(run(v29,"UPDATE started_cas SET ok=0").status,0,'the fence row refuses 0');

// ===== 2. dormant: until the marker says d1 the R2 objects serve exactly as before =====
{
 reset();
 // schema 28 (tables absent, version below 29) is the pre-migration state: R2 serves and a mark is written to R2 as before 0029.
 const legacy=database(null);fs.copyFileSync(v28,legacy.file);sqlite(legacy.file,SEED+MARKER.open);const legacyDb=d1Standin(legacy.file);
 records.set('started/old.json',{id:'old',started:true,startedAt:'2026-01-01T00:00:00.000Z'});objectMetadata.set('started/old.json',{started:'true'});
 assert.deepEqual(await (await call('GET',undefined,{BUCKET:bucket,DB:legacyDb})).json(),{ids:['old']},'schema 28: R2 lists the marks');
 assert.equal((await call('POST',{id:'one',started:true},{BUCKET:bucket,DB:legacyDb})).status,200);
 assert.ok(records.has('started/one.json')&&puts.includes('started/one.json'),'schema 28: the mark is an R2 object');
 // marker r2 (0029 applied, not activated): R2 serves, D1 rows are never read or written.
 reset();records.set('started/old.json',{id:'old',started:true});objectMetadata.set('started/old.json',{started:'true'});
 const r2=database('open');
 assert.deepEqual(await (await call('GET',undefined,{BUCKET:bucket,DB:r2.db})).json(),{ids:['old']});
 assert.equal((await call('POST',{id:'one',started:true},{BUCKET:bucket,DB:r2.db})).status,200);
 assert.ok(puts.includes('started/one.json'),'marker r2: the mark goes to R2');assert.equal(marks(r2.file).length,0,'marker r2: no D1 mark row is written');
 // held: reads still come from R2, every write is refused with zero R2 writes (a replay included)
 sqlite(r2.file,"UPDATE started_authority SET writes='held' WHERE id=1");puts=[];
 assert.deepEqual((await (await call('GET',undefined,{BUCKET:bucket,DB:r2.db})).json()).ids.sort(),['old','one']);
 for(const body of [{id:'two',started:true},{id:'one',started:true},{id:'one',started:false}]){const response=await call('POST',body,{BUCKET:bucket,DB:r2.db});assert.equal(response.status,503,JSON.stringify(body));assert.equal((await response.json()).error,'Started marks are temporarily read-only');}
 assert.deepEqual(puts,[],'held: nothing is written to R2');
 // closed states: a wrong database, version 29 without the tables, a missing binding, a deleted marker row. 503, never R2.
 const fresh=()=>{const made=database(null);return made;};
 const noSchema=database(null);fs.writeFileSync(noSchema.file,'');sqlite(noSchema.file,'CREATE TABLE unrelated(x)');
 const noTables=fresh();sqlite(noTables.file,'DROP TABLE started_mark;DROP TABLE started_authority;DROP TABLE started_cas');
 const noMarker=fresh();sqlite(noMarker.file,'DELETE FROM started_authority');
 const half=fresh();sqlite(half.file,'DROP TABLE started_cas');
 for(const [name,env] of [['wrong database (no schema_contract)',{BUCKET:bucket,DB:noSchema.db}],['version 29 without the tables',{BUCKET:bucket,DB:noTables.db}],['marker row deleted',{BUCKET:bucket,DB:noMarker.db}],['one table missing',{BUCKET:bucket,DB:half.db}],['no binding',{BUCKET:bucket}]]){
  puts=[];prefixes.length=0;
  assert.equal((await call('GET',undefined,env)).status,503,name+': GET');
  assert.equal((await call('POST',{id:'one',started:true},env)).status,503,name+': POST');
  assert.equal((await call('POST',undefined,env,'/api/events/bootstrap')).status,503,name+': bootstrap');
  assert.ok(!prefixes.includes('started/'),name+': the R2 started/ prefix is never listed (no fallback)');assert.deepEqual(puts,[],name+': nothing is written');
 }
 // the explicit local stand-in (never set in production) serves R2 without a binding
 assert.equal((await call('GET',undefined,{BUCKET:bucket,STARTED_DB_OPTIONAL:'standin'})).status,200);
}

// ===== 3. the d1 branch =====
{
 reset();
 const db=d1Db();const env={BUCKET:bucket,DB:db.db};
 assert.deepEqual(await (await call('GET',undefined,env)).json(),{ids:[]});
 puts=[];prefixes.length=0;
 assert.equal((await call('POST',{id:'one',started:true},env)).status,200);
 assert.deepEqual(marks(db.file).map(m=>[m.id,m.started,m.rev]),[['one',1,1]]);
 const stored=JSON.parse(marks(db.file)[0].last_event_json);
 assert.deepEqual(journal().map(e=>e.id),[stored.id],'the event journal holds exactly the event stored with the mark');
 assert.equal(stored.type,'started');assert.deepEqual(stored.film,{id:'one',title:'Один',year:1999,tmdb:'11'});
 assert.deepEqual(puts.filter(k=>k.startsWith('started/')),[],'no R2 started/ object is written');assert.ok(!prefixes.includes('started/'));
 assert.equal(marks(db.file)[0].started_at,stored.at);
 // GET lists from D1 only
 prefixes.length=0;assert.deepEqual(await (await call('GET',undefined,env)).json(),{ids:['one']});assert.deepEqual(prefixes,[],'GET lists no R2 prefix');
 // repeat: the same event, no second mark write, no new event id
 const before=JSON.stringify(marks(db.file));
 assert.equal((await call('POST',{id:'one',started:true},env)).status,200);
 assert.equal(JSON.stringify(marks(db.file)),before,'a repeat does not rewrite the row');assert.equal(journal().length,1,'a repeat delivers the same event, not a second one');
 // unstart: tombstone, startedAt null, new event
 assert.equal((await call('POST',{id:'one',started:false},env)).status,200);
 {const row=marks(db.file)[0];assert.deepEqual([row.started,row.started_at,row.rev],[0,null,2]);assert.equal(JSON.parse(row.last_event_json).type,'unstarted');}
 assert.deepEqual(await (await call('GET',undefined,env)).json(),{ids:[]},'a tombstone is not listed');
 assert.equal(marks(db.file).length,1,'the tombstone row is kept');
 assert.equal((await call('POST',{id:'one',started:false},env)).status,200);assert.equal(marks(db.file)[0].rev,2);assert.equal(journal().length,2,'repeated unstart: the stored event again');
 assert.equal((await call('POST',{id:'one',started:true},env)).status,200);assert.equal(marks(db.file)[0].rev,3);
 // unstart of a mark that never existed writes nothing and creates no row (as before)
 puts=[];assert.equal((await call('POST',{id:'two',started:false},env)).status,200);assert.equal(marks(db.file).length,1);assert.deepEqual(puts,[]);
 // key order of the listing equals the R2 key order: a-b.json sorts before a.json
 sqlite(db.file,"INSERT INTO started_mark (id,started,rev) VALUES ('a',1,1),('a-b',1,1),('a_b',1,1),('A',1,1)");
 assert.deepEqual((await (await call('GET',undefined,env)).json()).ids,['A','a-b','a','a_b','one'].sort((x,y)=>(x+'.json')<(y+'.json')?-1:1));
}

// refusals: identity statuses, held/not open/unreadable/moved Film generation, with zero writes anywhere
{
 reset();const db=d1Db();const env={BUCKET:bucket,DB:db.db};
 const refuse=async(body,status,environment=env)=>{puts=[];const response=await call('POST',body,environment);assert.equal(response.status,status,JSON.stringify(body));const data=await response.json();assert.deepEqual(puts,[],'zero R2 writes: '+JSON.stringify(body));assert.equal(marks(db.file).length,0,'zero D1 mark writes');return data;};
 assert.equal((await refuse({id:'unknown',started:true},404)).error,'Unknown film');
 assert.equal((await refuse({id:'tmdb_14',started:true},409)).error,'Conflicting film identity');
 assert.equal((await refuse({id:'tmdb_15',started:true},410)).error,'Film retired');
 assert.equal((await refuse({id:'tmdb_16',started:true},410)).error,'Film retired');
 assert.equal((await refuse({id:'tmdb_17',started:true},409)).error,'Conflicting film identity');
 const heldFilm=d1Db('held');await refuse({id:'one',started:true},503,{BUCKET:bucket,DB:heldFilm.db});
 const prepared=database('prepared');sqlite(prepared.file,"UPDATE started_authority SET mode='d1',generation=1 WHERE id=1");await refuse({id:'one',started:true},503,{BUCKET:bucket,DB:prepared.db});
 let moved=false;const drifting=d1Db('open',{onQuery:async text=>{if(!moved&&/FROM film_external_id/.test(text)){moved=true;sqlite(drifting.file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}}});
 await refuse({id:'one',started:true},503,{BUCKET:bucket,DB:drifting.db});
 // writes held in d1 mode: reads still serve, every write (replay included) is refused
 sqlite(db.file,"INSERT INTO started_mark (id,started,rev,last_event_json) VALUES ('two',1,1,'{\"id\":\"e2\",\"type\":\"started\",\"at\":\"t\",\"film\":{\"id\":\"two\",\"title\":\"x\",\"year\":null}}');UPDATE started_authority SET writes='held'");
 assert.deepEqual(await (await call('GET',undefined,env)).json(),{ids:['two']});
 for(const body of [{id:'one',started:true},{id:'two',started:true},{id:'two',started:false}]){puts=[];assert.equal((await call('POST',body,env)).status,503);assert.deepEqual(puts,[]);}
 assert.equal(marks(db.file).length,1);
 // an unreadable marker row after the cutover is 503 on every route and never R2
 sqlite(db.file,'DELETE FROM started_authority');prefixes.length=0;
 assert.equal((await call('GET',undefined,env)).status,503);assert.equal((await call('POST',{id:'one',started:true},env)).status,503);assert.equal((await call('POST',undefined,env,'/api/events/bootstrap')).status,503);
 assert.ok(!prefixes.includes('started/'));
}

// last-known film identity survives a reassignment or disappearance when a mark is cancelled
{
 reset();const db=d1Db();const env={BUCKET:bucket,DB:db.db};
 assert.equal((await call('POST',{id:'one',started:true},env)).status,200);
 sqlite(db.file,"DELETE FROM film_external_id WHERE scheme='letterboxd' AND value='one'");
 assert.equal((await call('POST',{id:'one',started:false},env)).status,200);
 assert.deepEqual(JSON.parse(marks(db.file)[0].last_event_json).film,{id:'one',title:'Один',year:1999,tmdb:'11'},'the unstart keeps the film of the mark when the identity no longer resolves');
 }
{
 // reassigned to another verified movie: the film of the mark is kept, never the new one
 reset();const db=d1Db();const env={BUCKET:bucket,DB:db.db};
 assert.equal((await call('POST',{id:'one',started:true},env)).status,200);
 sqlite(db.file,"UPDATE film_external_id SET film_id='film:tmdb:12' WHERE scheme='letterboxd' AND value='one'");
 assert.equal((await call('POST',{id:'one',started:false},env)).status,200);
 assert.deepEqual(JSON.parse(marks(db.file)[0].last_event_json).film,{id:'one',title:'Один',year:1999,tmdb:'11'},'cancelling never records the mark for a different movie');
}

// event delivery: a request that dies between the mark commit and the event write is repaired by the same-state repeat with the SAME event id
{
 reset();const db=d1Db();const env={BUCKET:bucket,DB:db.db};
 const realPut=bucket.put;let failNext=true;
 bucket.put=async(k,v,o)=>{if(failNext&&k.startsWith('events/items/')){failNext=false;throw new Error('simulated crash before the event write');}return realPut(k,v,o);};
 const crashed=await call('POST',{id:'one',started:true},env).catch(error=>error);
 bucket.put=realPut;
 assert.ok(crashed instanceof Error||crashed.status>=500,'the request failed after the mark commit');
 assert.deepEqual(marks(db.file).map(m=>[m.id,m.started,m.rev]),[['one',1,1]],'the mark committed');assert.equal(journal().length,0,'the event was not written');
 const stored=JSON.parse(marks(db.file)[0].last_event_json);
 assert.equal((await call('POST',{id:'one',started:true},env)).status,200);
 assert.deepEqual(journal().map(e=>e.id),[stored.id],'the repeat delivers the stored event under its own id');assert.equal(marks(db.file)[0].rev,1);
 assert.equal((await call('POST',{id:'one',started:true},env)).status,200);assert.equal(journal().length,1,'no duplicate');
}

// P1 (review): a committed transition whose event write failed is delivered BEFORE a later transition overwrites it; both distinct event ids land exactly once
{
 reset();const db=d1Db();const env={BUCKET:bucket,DB:db.db};
 const realPut=bucket.put;let failNext=true;
 bucket.put=async(k,v,o)=>{if(failNext&&k.startsWith('events/items/')){failNext=false;throw new Error('simulated crash before the event write');}return realPut(k,v,o);};
 await call('POST',{id:'one',started:true},env).catch(()=>null);bucket.put=realPut;
 const eventA=JSON.parse(marks(db.file)[0].last_event_json);assert.equal(journal().length,0,'A committed in D1 but is not in the journal');
 // the opposite transition arrives before any same-state retry
 assert.equal((await call('POST',{id:'one',started:false},env)).status,200);
 const eventB=JSON.parse(marks(db.file)[0].last_event_json);assert.notEqual(eventA.id,eventB.id);assert.equal(marks(db.file)[0].rev,2);
 assert.deepEqual(journal().map(e=>e.id).sort(),[eventA.id,eventB.id].sort(),'both transitions are in the journal, A was delivered before B replaced it');
 for(let i=0;i<2;i++){assert.equal((await call('POST',{id:'one',started:false},env)).status,200);assert.equal(journal().length,2,'repeats add nothing: each event exactly once');}
 // when the delivery of the earlier event fails again, the later transition is refused and nothing is overwritten
 reset();const db2=d1Db();const env2={BUCKET:bucket,DB:db2.db};
 failNext=true;bucket.put=async(k,v,o)=>{if(failNext&&k.startsWith('events/items/')){failNext=false;throw new Error('crash');}return realPut(k,v,o);};
 await call('POST',{id:'one',started:true},env2).catch(()=>null);
 const stuck=JSON.parse(marks(db2.file)[0].last_event_json);failNext=true;
 const refused=await call('POST',{id:'one',started:false},env2).catch(error=>error);
 bucket.put=realPut;
 assert.ok(refused instanceof Error||refused.status>=500,'the transition is refused while the earlier event cannot be delivered');
 assert.deepEqual(marks(db2.file).map(m=>[m.started,m.rev,JSON.parse(m.last_event_json).id]),[[1,1,stuck.id]],'nothing was overwritten');
 assert.equal((await call('POST',{id:'one',started:false},env2)).status,200);
 assert.equal(journal().length,2,'after the retry both events are journaled once');
}

// concurrency: one row, one winner; the loser decides again on the state the winner left
{
 reset();const db=d1Db();const env={BUCKET:bucket,DB:db.db};
 const results=await Promise.all([call('POST',{id:'one',started:true},env),call('POST',{id:'one',started:true},env),call('POST',{id:'one',started:true},env)]);
 assert.deepEqual(results.map(r=>r.status),[200,200,200]);
 assert.equal(marks(db.file).length,1);assert.equal(marks(db.file)[0].rev,1,'three simultaneous identical requests commit once');
 assert.equal(journal().length,1,'and produce exactly one event');
 const stored=JSON.parse(marks(db.file)[0].last_event_json);assert.equal(journal()[0].id,stored.id);
 // opposite requests: every response is 200 and the final row is consistent with its stored event
 const mixed=await Promise.all([call('POST',{id:'one',started:false},env),call('POST',{id:'one',started:true},env),call('POST',{id:'one',started:false},env)]);
 assert.ok(mixed.every(r=>r.status===200));
 const row=marks(db.file)[0],event=JSON.parse(row.last_event_json);
 assert.equal(event.type,row.started?'started':'unstarted','the stored event agrees with the stored state');assert.equal(row.started_at,row.started?event.at:null);
 assert.ok(journal().some(e=>e.id===event.id),'the stored event is in the journal');
 // different ids never contend
 const other=await Promise.all([call('POST',{id:'two',started:true},env),call('POST',{id:'tmdb_13',started:true},env)]);
 assert.deepEqual(other.map(r=>r.status),[200,200]);
 // a lost reply after the commit is a success only for the request's own event; a competitor's commit is a conflict
 const mine={id:'z',started:true,startedAt:'t',lastEvent:{id:'mine',type:'started',at:'t',film:{id:'z'}}};
 const lost=d1Standin(db.file,{onBatch:async()=>{sqlite(db.file,"INSERT INTO started_mark (id,started,started_at,last_event_json,rev) VALUES ('z',1,'t','{\"id\":\"mine\",\"type\":\"started\",\"at\":\"t\",\"film\":{\"id\":\"z\"}}',1)");throw new Error('network lost the reply');}});
 assert.deepEqual(await StartedD1.commitMark(lost,{expectedRev:0,mark:mine}),{ok:true,rev:1},'the stored row is exactly this request: success');
 const rival=d1Standin(db.file,{onBatch:async()=>{sqlite(db.file,"UPDATE started_mark SET started=0,started_at=NULL,last_event_json='{\"id\":\"other\",\"type\":\"unstarted\",\"at\":\"t\",\"film\":{\"id\":\"z\"}}',rev=2 WHERE id='z'");throw new Error('lost');}});
 assert.deepEqual(await StartedD1.commitMark(rival,{expectedRev:1,mark:{...mine,lastEvent:{...mine.lastEvent,id:'mine2'}}}),{ok:false,reason:'conflict'},'a competitor reached the next revision: not our write');
}

// the commit is guarded inside its own batch: a stale revision never overwrites, and a marker that moved between the gate and the batch writes nothing
{
 reset();const db=d1Db();
 const first={id:'one',started:true,startedAt:'t1',lastEvent:{id:'ev1',type:'started',at:'t1',film:{id:'one'}}};
 assert.deepEqual(await StartedD1.commitMark(db.db,{expectedRev:0,mark:first}),{ok:true,rev:1});
 assert.deepEqual(await StartedD1.commitMark(db.db,{expectedRev:0,mark:{...first,lastEvent:{...first.lastEvent,id:'ev-dup'}}}),{ok:false,reason:'conflict'},'a second insert of one id is a conflict');
 const unstart={id:'one',started:false,startedAt:null,lastEvent:{id:'ev2',type:'unstarted',at:'t2',film:{id:'one'}}};
 assert.deepEqual(await StartedD1.commitMark(db.db,{expectedRev:1,mark:unstart}),{ok:true,rev:2});
 assert.deepEqual(await StartedD1.commitMark(db.db,{expectedRev:1,mark:{...first,lastEvent:{...first.lastEvent,id:'ev-stale'}}}),{ok:false,reason:'conflict'},'a decision made on revision 1 cannot overwrite revision 2');
 assert.deepEqual(marks(db.file).map(m=>[m.started,m.rev,JSON.parse(m.last_event_json).id]),[[0,2,'ev2']],'the stale write changed nothing');
 const moving=d1Db('open',{onBatch:async()=>{sqlite(moving.file,"UPDATE started_authority SET writes='held' WHERE id=1");}});
 const blocked=await StartedD1.commitMark(moving.db,{expectedRev:0,mark:first});
 assert.equal(blocked.ok,false);assert.equal(marks(moving.file).length,0,'a hold that lands between the gate and the batch writes no row');
 const flipped=d1Db('open',{onBatch:async()=>{sqlite(flipped.file,"UPDATE started_authority SET mode='r2' WHERE id=1");}});
 assert.equal((await StartedD1.commitMark(flipped.db,{expectedRev:0,mark:first})).ok,false);assert.equal(marks(flipped.file).length,0,'a marker that left d1 between the gate and the batch writes no row');
 // through the Worker: two simultaneous unstarts from one revision write one event and one revision
 reset();const pair=d1Db();const env={BUCKET:bucket,DB:pair.db};
 assert.equal((await call('POST',{id:'one',started:true},env)).status,200);
 const before=journal().length;
 const both=await Promise.all([call('POST',{id:'one',started:false},env),call('POST',{id:'one',started:false},env)]);
 assert.deepEqual(both.map(r=>r.status),[200,200]);assert.equal(marks(pair.file)[0].rev,2,'one revision for two identical simultaneous unstarts');assert.equal(journal().length,before+1,'and exactly one new event');
}

// Events bootstrap and the started filter read the D1 authority; old R2 marks are not revived
{
 reset();const db=d1Db();const env={BUCKET:bucket,DB:db.db};
 records.set('started/ghost.json',{id:'ghost',started:true,startedAt:'2026-01-01T00:00:00.000Z',lastEvent:{id:'old-r2',type:'started',at:'2026-01-01T00:00:00.000Z',film:{id:'ghost',title:'Ghost',year:null}}});objectMetadata.set('started/ghost.json',{started:'true'});
 sqlite(db.file,`INSERT INTO started_mark (id,started,started_at,last_event_json,rev) VALUES ('one',1,'2026-02-01T00:00:00.000Z','{"id":"e-one","type":"started","at":"2026-02-01T00:00:00.000Z","film":{"id":"one","title":"Один","year":1999}}',1),('two',0,NULL,'{"id":"e-two","type":"unstarted","at":"2026-02-02T00:00:00.000Z","film":{"id":"two","title":"x","year":null}}',2),('legacy',1,'2026-01-15T00:00:00.000Z',NULL,1)`);
 puts=[];prefixes.length=0;
 assert.equal((await call('POST',undefined,env,'/api/events/bootstrap')).status,200);
 assert.ok(!prefixes.includes('started/'),'the bootstrap reads D1 marks, not the R2 prefix');
 const ids=journal().map(e=>e.id).sort();
 assert.ok(ids.includes('e-one')&&ids.includes('e-two'),'the stored events of the D1 marks are written under their own ids');
 assert.ok(!ids.some(id=>id.startsWith('baseline-started-')),'a legacy mark without an event and without a programme film writes no event, as in R2');
 assert.ok(!ids.includes('old-r2'),'the stale R2 mark is not revived');
 assert.deepEqual(await (await call('GET',undefined,env)).json(),{ids:['legacy','one']},'GET reads D1; the R2 ghost is not listed');
 // GET /api/started and GET /api/events write nothing
 puts=[];await call('GET',undefined,env);await call('GET',undefined,env,'/api/events');assert.deepEqual(puts,[],'read routes write nothing');
}

// the R2 branch re-reads the marker right before its PUT: an admission before a hold or the activation cannot write
{
 for(const [name,flip,expected] of [['hold',"UPDATE started_authority SET writes='held' WHERE id=1",'Started marks are temporarily read-only'],['activation',"UPDATE started_authority SET mode='d1',generation=1 WHERE id=1",'Started marks storage unavailable']]){
  reset();const db=database('open');let flipped=false;
  const realGet=bucket.get;
  bucket.get=async k=>{const out=await realGet(k);if(k==='started/one.json'&&!flipped){flipped=true;sqlite(db.file,flip);}return out;};
  const response=await call('POST',{id:'one',started:true},{BUCKET:bucket,DB:db.db});bucket.get=realGet;
  assert.equal(response.status,503,name);assert.equal((await response.json()).error,expected);assert.ok(!puts.includes('started/one.json'),name+': no R2 mark write after the marker moved');
 }
}

// ===== 4. the offline SQL generator =====
const generator=(...args)=>spawnSync(process.execPath,['scripts/started-d1-sql.mjs',...args],{encoding:'utf8'});
const exportFile=path.join(root,'export.json');
const obj=(id,body,started=body.started!==false,extra={})=>({key:'started/'+id+'.json',etag:'etag-'+id,customMetadata:{started:String(started)},body:JSON.stringify({id,...body}),...extra});
const event=(id,type,at,film)=>({id,type,at,film});
const EXPORT=[
 obj('one',{started:true,startedAt:'2026-02-01T00:00:00.000Z',lastEvent:event('e1','started','2026-02-01T00:00:00.000Z',{id:'one',title:"O'Brien",year:1999,tmdb:'11'})}),
 obj('two',{started:false,startedAt:null,lastEvent:event('e2','unstarted','2026-02-02T00:00:00.000Z',{id:'two',title:'Два',year:null})}),
 obj('legacy',{startedAt:'2026-01-15T00:00:00.000Z'},true),
 obj('a',{started:true,startedAt:'2026-03-01T00:00:00.000Z',lastEvent:event('ea','started','2026-03-01T00:00:00.000Z',{id:'a',title:'A',year:2000})}),
 obj('a-b',{started:true,startedAt:'2026-03-02T00:00:00.000Z',lastEvent:event('eab','started','2026-03-02T00:00:00.000Z',{id:'a-b',title:'AB',year:2001})}),
 obj('tmdb_13',{started:true,startedAt:'2026-03-03T00:00:00.000Z',lastEvent:event('e13','started','2026-03-03T00:00:00.000Z',{id:'tmdb_13',title:'T13',year:2005,tmdb:'13'})}),
];
fs.writeFileSync(exportFile,JSON.stringify(EXPORT));
{
 const digest=JSON.parse(generator('digest',exportFile).stdout);
 assert.deepEqual([digest.count,digest.started],[6,5],'tombstones and the legacy mark are counted');
 const shuffled=path.join(root,'shuffled.json');fs.writeFileSync(shuffled,JSON.stringify([...EXPORT].reverse()));
 assert.deepEqual(JSON.parse(generator('digest',shuffled).stdout),digest,'the digest does not depend on the order of the export');
 // blockers: exit 2 and no SQL
 const bad=(name,data)=>{const file=path.join(root,'bad-'+name+'.json');fs.writeFileSync(file,typeof data==='string'?data:JSON.stringify(data));for(const command of ['import','activate','digest']){const result=generator(command,file);assert.equal(result.status,2,name+' '+command);assert.equal(result.stdout,'',name+' prints no SQL');assert.match(result.stderr,/BLOCKER/);}};
 bad('not-json','{nope');bad('object',{});bad('foreign-key',[obj('one',{started:true}),{...obj('x',{started:true}),key:'events/items/x.json'}]);
 bad('duplicate',[obj('one',{started:true}),obj('one',{started:true})]);bad('id-mismatch',[{...obj('one',{started:true}),body:JSON.stringify({id:'other',started:true})}]);
 bad('flag',[{...obj('one',{started:true}),customMetadata:{started:'false'}}]);bad('startedAt',[obj('one',{started:true,startedAt:5})]);
 bad('lastEvent',[obj('one',{started:true,lastEvent:'x'})]);bad('lastEvent-id',[obj('one',{started:true,lastEvent:{type:'started'}})]);bad('body-array',[{...obj('one',{}),body:'[]'}]);bad('no-body',[{key:'started/one.json'}]);
 bad('bad-id',[{key:'started/a b.json',body:'{"id":"a b"}'}]);
 // the review fixture: body.started false with no custom metadata is listed as started by GET and unstarted by POST: ambiguous
 bad('absent-flag-false',[{key:'started/x.json',etag:'e',body:'{"id":"x","started":false}',customMetadata:{}}]);
 bad('no-metadata-false',[{key:'started/x.json',etag:'e',body:'{"id":"x","started":false}'}]);
 bad('odd-flag-false',[{key:'started/x.json',etag:'e',body:'{"id":"x","started":false}',customMetadata:{started:'x'}}]);
 bad('flag-false-body-true',[{key:'started/x.json',etag:'e',body:'{"id":"x","started":true}',customMetadata:{started:'false'}}]);
 // an object without a strong ETag cannot be tied to the accepted inventory
 bad('no-etag',[{key:'started/x.json',body:'{"id":"x","started":true}',customMetadata:{started:'true'}}]);
 bad('empty-etag',[{key:'started/x.json',etag:'',body:'{"id":"x","started":true}',customMetadata:{started:'true'}}]);
 bad('weak-etag',[{key:'started/x.json',etag:'W/"abc"',body:'{"id":"x","started":true}',customMetadata:{started:'true'}}]);
 // consistent states stay importable: absent flag with started true, absent flag with no started field
 {const ok=path.join(root,'consistent.json');fs.writeFileSync(ok,JSON.stringify([{key:'started/p.json',etag:'e1',body:'{"id":"p","started":true}'},{key:'started/q.json',etag:'e2',body:'{"id":"q"}',customMetadata:{}}]));assert.equal(generator('digest',ok).status,0);assert.equal(JSON.parse(generator('digest',ok).stdout).started,2);}
 // the generated SQL is one statement per line and every statement is well under the D1 limit
 const big=[obj('big',{started:true,lastEvent:event('eb','started','t',{id:'big',title:'x'.repeat(30000),year:1})})];const bigFile=path.join(root,'big.json');fs.writeFileSync(bigFile,JSON.stringify(big));
 assert.ok(Math.max(...generator('import',bigFile).stdout.split('\n').map(line=>Buffer.byteLength(line)))<100000);
 const huge=path.join(root,'huge.json');fs.writeFileSync(huge,JSON.stringify([obj('huge',{started:true,lastEvent:event('eh','started','t',{id:'huge',title:'x'.repeat(95000),year:1})})]));
 assert.equal(generator('import',huge).status,2,'a statement over the limit is a blocker');
}
{
 // the full cutover on a database: hold -> import -> parity -> activate; each guard refuses a wrong state before it changes anything
 const sqlOf=(...args)=>{const result=generator(...args);assert.equal(result.status,0,result.stderr);return result.stdout;};
 const made=database('open');const file=made.file;
 assert.notEqual(run(file,sqlOf('import',exportFile)).status,0,'import before hold is refused');assert.equal(marks(file).length,0);assert.deepEqual(authority(file),{mode:'r2',generation:0,writes:'open'});
 assert.equal(run(file,sqlOf('hold')).status,0);assert.deepEqual(authority(file),{mode:'r2',generation:0,writes:'held'});
 assert.notEqual(run(file,sqlOf('hold')).status,0,'a second hold is refused (it is not generation 0 open)');
 assert.equal(run(file,sqlOf('import',exportFile)).status,0);
 assert.deepEqual(authority(file),{mode:'r2',generation:1,writes:'held'},'the marker stays r2: nothing is served from D1 yet');
 assert.equal(marks(file).length,6);assert.ok(marks(file).every(m=>m.rev===1));
 const byId=Object.fromEntries(marks(file).map(m=>[m.id,m]));
 assert.deepEqual([byId.two.started,byId.two.started_at],[0,null],'the tombstone is imported');assert.equal(byId.legacy.last_event_json,null,'a legacy mark keeps no event');
 assert.equal(JSON.parse(byId.one.last_event_json).film.title,"O'Brien",'quotes survive');assert.equal(JSON.parse(byId.one.last_event_json).id,'e1','the original event id is kept');
 assert.notEqual(run(file,sqlOf('import',exportFile)).status,0,'a repeat or a crash retry is refused by its own guard');assert.equal(marks(file).length,6,'no duplicate row');
 // parity against the export, in R2 key order
 const keyOrder=EXPORT.map(e=>e.key.slice(8,-5)).sort((x,y)=>(x+'.json')<(y+'.json')?-1:1);
 // activation refuses a row that differs from the export
 const tampered=database('open');run(tampered.file,sqlOf('hold'));run(tampered.file,sqlOf('import',exportFile));sqlite(tampered.file,"UPDATE started_mark SET started_at='2000-01-01T00:00:00.000Z' WHERE id='one'");
 assert.notEqual(run(tampered.file,sqlOf('activate',exportFile)).status,0,'a row that differs aborts the activation');assert.deepEqual(authority(tampered.file),{mode:'r2',generation:1,writes:'held'});
 const extra=database('open');run(extra.file,sqlOf('hold'));run(extra.file,sqlOf('import',exportFile));sqlite(extra.file,"INSERT INTO started_mark (id,started,rev) VALUES ('stray',1,1)");
 assert.notEqual(run(extra.file,sqlOf('activate',exportFile)).status,0,'an extra row aborts the activation');
 // release before activation restores writes and R2 keeps serving
 const released=database('open');run(released.file,sqlOf('hold'));run(released.file,sqlOf('import',exportFile));assert.equal(run(released.file,sqlOf('release')).status,0);assert.deepEqual(authority(released.file),{mode:'r2',generation:1,writes:'open'});
 // activate and serve through the Worker: the D1 listing equals the started ids of the export, in R2 key order
 assert.equal(run(file,sqlOf('activate',exportFile)).status,0);assert.deepEqual(authority(file),{mode:'d1',generation:1,writes:'open'});
 reset();
 const served=await (await call('GET',undefined,{BUCKET:bucket,DB:d1Standin(file)})).json();
 assert.deepEqual(served.ids,keyOrder.filter(id=>id!=='two'),'GET equals the export: same ids, same R2 key order');
 assert.notEqual(run(file,sqlOf('activate',exportFile)).status,0,'activation cannot be repeated');
 assert.notEqual(run(file,sqlOf('release')).status,0,'release is refused after the activation');
 // after the activation a write works, with the existing event identity preserved on repeat
 const env={BUCKET:bucket,DB:d1Standin(file)};
 assert.equal((await call('POST',{id:'one',started:true},env)).status,200);assert.equal(journal().map(e=>e.id).join(),'e1','the repeat delivers the imported event under its original id');
 assert.equal((await call('POST',{id:'one',started:false},env)).status,200);assert.equal(marks(file).find(m=>m.id==='one').rev,2);
}
console.log('Started marks in D1: schema v29 migration, dormant r2/legacy serving, closed states 503 without R2 fallback, d1 set/unset/repeat/tombstone, key-order listing, identity refusals with zero writes, event identity and redelivery after a crash, row-level compare-and-swap under concurrency, lost-reply handling, Events bootstrap from D1, marker re-read before R2 writes, and the guarded offline import and activation generator passed');
