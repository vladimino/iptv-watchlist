// POST /api/started (AIR-516): the Film of a mark is the canonical D1 Film (verified identity bridge, title, year, trusted TMDB claim), read through the real
// CanonicalCatalogReader over a sqlite D1 stand-in with the real migration chain. The R2 stand-in records every read and write: the frozen metadata.json and programme.json
// are never read for identity, and every refusal leaves zero R2 writes. The started marks and the events stay R2 objects (keys, customMetadata and write order unchanged).
import {webcrypto} from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-started-'));
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
const records=new Map(),objectMetadata=new Map();let puts=[],reads=[];
const bucket={
 get:async k=>{reads.push(k);return records.has(k)?{json:async()=>records.get(k)}:null;},
 put:async(k,v,options)=>{puts.push(k);records.set(k,JSON.parse(v));objectMetadata.set(k,options?.customMetadata);return {};},
 delete:async k=>{puts.push('delete:'+k);return records.delete(k);},
 list:async({prefix,cursor})=>{const keys=[...records.keys()].filter(k=>k.startsWith(prefix)).sort();const i=Number(cursor||0);return {objects:keys.slice(i,i+1).map(key=>({key,customMetadata:objectMetadata.get(key)})),truncated:i+1<keys.length,cursor:String(i+1)};}
};
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);
vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader','const {CREDIT_SELECTION_SQL,database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n'),ctx);
vm.runInContext(fs.readFileSync('src/sources.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),ctx);

let environment={BUCKET:bucket};
const call=(method,body,headers={},env=environment)=>ctx.worker.fetch(new Request('https://site.example/api/started',{method,headers:{'Content-Type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);
const events=async()=>{const out=[];for(const key of [...records.keys()].filter(k=>k.startsWith('events/items/')).sort())out.push(records.get(key));return out;};
const refused=async(body,status,expected,env=environment)=>{puts=[];const response=await call('POST',body,{},env);assert.equal(response.status,status,JSON.stringify(body));const data=await response.json();assert.equal(puts.length,0,'a refusal writes nothing to R2: '+JSON.stringify(body));if(expected)assert.equal(data.reason,expected);return data;};
const NEVER=['metadata.json','programme.json'];
// The frozen R2 documents hold films the canonical D1 does not (a ghost) and contradict the D1 title of a real one: neither may leak into an answer.
records.set('metadata.json',{one:{id:'one',title:'FROZEN one',year:1900},ghost:{id:'ghost',title:'Ghost'},tmdb_13:{id:'tmdb_13',title:'FROZEN 13'}});
records.set('programme.json',{films:[{id:'two',title:'FROZEN two',year:1901,shows:[]},{id:'ghost2',title:'Ghost 2',shows:[]}]});
const open=database('open');environment={BUCKET:bucket,DB:open.db};
const reachedFrozen=()=>reads.filter(k=>NEVER.includes(k));

// Reading marks: the started/ prefix only.
assert.deepEqual(await (await call('GET')).json(),{ids:[]});

// Success: a programme-style film (lid), a film the frozen programme contradicts, a retained Film outside the programme and the watchlist (tmdb_<n>), and a lid with no TMDB claim.
puts=[];reads=[];
await Promise.all([call('POST',{id:'one',started:true}),call('POST',{id:'two',started:true})]);
assert.deepEqual((await (await call('GET')).json()).ids.sort(),['one','two']);
assert.deepEqual(reachedFrozen(),[],'neither metadata.json nor programme.json is read for the identity');
let list=await events();
const byId=id=>list.find(event=>event.film?.id===id);
assert.deepEqual(byId('one'),{id:byId('one').id,type:'started',at:byId('one').at,film:{id:'one',title:'Один',year:1999,tmdb:'11'}},'title, year and the trusted TMDB claim come from D1, not from metadata.json');
assert.deepEqual(byId('two').film,{id:'two',title:'Original two',year:2001,tmdb:'12'},'a Film with no localization shows its original title; programme.json is not consulted');
assert.equal((await call('POST',{id:'tmdb_13',started:true})).status,200);
assert.deepEqual((await events()).find(event=>event.film?.id==='tmdb_13').film,{id:'tmdb_13',title:'Оставленный',year:2005,tmdb:'13'},'a retained Film outside programme and watchlist: the reviewed localization is used');
assert.equal((await call('POST',{id:'solo',started:true})).status,200);
{const solo=(await events()).find(event=>event.film?.id==='solo');assert.deepEqual(solo.film,{id:'solo',title:'Original solo',year:null},'a trusted Letterboxd id without a TMDB claim gets no TMDB link and no invented year');assert.equal('tmdb' in solo.film,false);}
assert.deepEqual(reachedFrozen(),[]);
// The mark keeps its R2 key, its body and its customMetadata; the event keeps its journal key.
assert.equal(objectMetadata.get('started/one.json').started,'true');
assert.deepEqual(Object.keys(records.get('started/one.json')).sort(),['id','lastEvent','started','startedAt']);
assert.equal(records.get('started/one.json').lastEvent.id,byId('one').id);
assert.ok([...records.keys()].some(k=>/^events\/items\/\d{13}-[0-9a-f-]{36}\.json$/.test(k)),'the event journal key is unchanged');

// Repeated started: with the Film/Person marker open the stored last event is delivered again under its own key, the mark itself and its event are not replaced.
// The D1 read comes first, so a replay is fenced like any other request (below, with the refusals).
{
 const before=JSON.stringify(records.get('started/one.json')),eventCount=(await events()).length;puts=[];
 assert.deepEqual(await (await call('POST',{id:'one',started:true})).json(),{id:'one',started:true});
 assert.equal(JSON.stringify(records.get('started/one.json')),before);assert.equal((await events()).length,eventCount,'the same event is written again under the same key, not duplicated');
 assert.ok(!puts.includes('started/one.json'),'the mark itself is not rewritten');
 assert.ok(puts.length>0&&puts.every(k=>k.startsWith('events/items/')),'an open-domain replay writes only the existing event key');
}

// Refusals: every one leaves zero R2 writes and never falls back to the frozen documents.
reads=[];
assert.equal((await refused({id:'unknown',started:true},404)).error,'Unknown film');
assert.equal((await refused({id:'ghost',started:true},404)).error,'Unknown film','a film only the frozen metadata.json names is unknown');
assert.equal((await refused({id:'ghost2',started:true},404)).error,'Unknown film','a film only the frozen programme.json names is unknown');
assert.equal((await refused({id:'tmdb_999',started:true},404)).error,'Unknown film');
assert.equal((await refused({id:'tmdb_14',started:true},409)).error,'Conflicting film identity');
assert.equal((await refused({id:'untrusted',started:true},409)).error,'Conflicting film identity','an untrusted alias is never a Film');
assert.equal((await refused({id:'tmdb_15',started:true},410)).error,'Film retired','a redirect source is retired');
assert.equal((await refused({id:'tmdb_16',started:true},410)).error,'Film retired','the owner retirement ledger retires the movie id');
assert.equal((await refused({id:'tmdb_17',started:true},409)).error,'Conflicting film identity','a canonical identity that disagrees with the trusted claim');
assert.deepEqual(reachedFrozen(),[],'no refusal reads the frozen documents');

// Held, not open, unreadable and a moved generation fail closed (503) before any R2 write, for started and for unstarted.
{
 const held=database('held');await refused({id:'tmdb_12',started:true},503,'film_person_held',{BUCKET:bucket,DB:held.db});
 await refused({id:'two',started:false},503,'film_person_held',{BUCKET:bucket,DB:held.db});
}
{const prepared=database('prepared');await refused({id:'tmdb_12',started:true},503,'film_person_unavailable',{BUCKET:bucket,DB:prepared.db});}
{const legacy=database(null);await refused({id:'tmdb_12',started:true},503,null,{BUCKET:bucket,DB:legacy.db});}
{
 const broken=d1Standin(open.file,{rewrite:sql=>/FROM film_external_id/.test(sql)?'SELECT * FROM missing_table':sql});
 await refused({id:'tmdb_12',started:true},503,'canonical_read_unavailable',{BUCKET:bucket,DB:broken});
}
{
 let moved=false;const drifting=database('open',SEED,{onQuery:async text=>{if(!moved&&/FROM film_external_id/.test(text)){moved=true;sqlite(drifting.file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}}});
 await refused({id:'tmdb_12',started:true},503,'film_person_generation_moved',{BUCKET:bucket,DB:drifting.db});
}
// A binding that is absent fails closed as well, and the frozen documents still do not answer.
await refused({id:'tmdb_12',started:true},503,null,{BUCKET:bucket});
{const unreadable=database('open',SEED);fs.writeFileSync(unreadable.file,'not a database');await refused({id:'tmdb_12',started:true},503,null,{BUCKET:bucket,DB:unreadable.db});}
assert.deepEqual(reachedFrozen(),[]);

// Same-state replay is fenced by D1 authority as well: held, not open, unreadable and a missing binding answer 503 with zero R2 writes (started and unstarted alike). The mark `one` is started, `two` is not.
{
 const held=database('held'),prepared=database('prepared'),legacy=database(null);
 const broken=d1Standin(open.file,{rewrite:sql=>/FROM film_external_id/.test(sql)?'SELECT * FROM missing_table':sql});
 for(const [name,env] of [['held',{BUCKET:bucket,DB:held.db}],['prepared',{BUCKET:bucket,DB:prepared.db}],['legacy',{BUCKET:bucket,DB:legacy.db}],['unreadable',{BUCKET:bucket,DB:broken}],['no binding',{BUCKET:bucket}]]){
  await refused({id:'one',started:true},503,null,env);
  await refused({id:'two',started:false},503,null,env);
 }
 await refused({id:'one',started:true},503,'film_person_held',{BUCKET:bucket,DB:held.db});
}

// unstarted: the mark's own last known event film is used when the identity no longer resolves, and the availability of D1 is still checked.
{
 const removed=database('open',SEED.replace(/INSERT INTO film[^;]*film:tmdb:11[^;]*;/g,'').replace(/INSERT INTO film_[a-z_]+ \([^)]*\) VALUES \('film:tmdb:11'[^;]*;/g,''),{});
 const last=records.get('started/one.json').lastEvent.film;
 puts=[];
 assert.deepEqual(await (await call('POST',{id:'one',started:false},{},{BUCKET:bucket,DB:removed.db})).json(),{id:'one',started:false});
 const after=records.get('started/one.json');
 assert.equal(after.started,false);assert.equal(after.startedAt,null);assert.equal(objectMetadata.get('started/one.json').started,'false');
 assert.deepEqual(after.lastEvent.film,last,'the unstarted event keeps the last known title and year when the Film no longer resolves');
 assert.equal(after.lastEvent.type,'unstarted');
}
{
 // A Film that still resolves is described from D1 at the time of the action, and `at` is the time of the new action.
 const before=Date.now();
 assert.equal((await call('POST',{id:'two',started:false})).status,200);
 const stored=records.get('started/two.json');assert.equal(stored.lastEvent.type,'unstarted');assert.deepEqual(stored.lastEvent.film,{id:'two',title:'Original two',year:2001,tmdb:'12'});
 assert.ok(Date.parse(stored.lastEvent.at)>=before-1000,'at is the actual time of the new action');
}
{
 // A repeated unstarted of `two` (already unstarted) is a replay: refused with zero writes while D1 is held, only the existing event key when open.
 const held=database('held');await refused({id:'two',started:false},503,'film_person_held',{BUCKET:bucket,DB:held.db});
 puts=[];assert.equal((await call('POST',{id:'two',started:false})).status,200);assert.ok(puts.length>0&&puts.every(k=>k.startsWith('events/items/')),'an open replay of unstarted writes only the existing event key');
}
{
 // unstarted does not create an identity: a conflicting alias still removes the mark with the film of its own last event.
 const held=database('held');puts=[];
 const response=await call('POST',{id:'solo',started:false},{},{BUCKET:bucket,DB:held.db});
 assert.equal(response.status,503);assert.equal(puts.length,0);assert.equal(records.get('started/solo.json').started,true,'a refused unstarted leaves the mark as it was');
}
assert.deepEqual((await (await call('GET')).json()).ids.sort(),['solo','tmdb_13'],'GET lists the remaining marks');

// A new started takes only D1 values: the Film `one` was unstarted above with the last event {Один, 1999, tmdb 11}; D1 now has neither a title nor a year for it. The new event must not
// inherit the old R2 values: a neutral placeholder and null, the D1 TMDB claim.
{
 const bare=database('open',film('film:tmdb:11',11,'')+claim('film:tmdb:11','tmdb','11')+claim('film:tmdb:11','letterboxd','one'));
 assert.equal(records.get('started/one.json').started,false);assert.deepEqual(records.get('started/one.json').lastEvent.film,{id:'one',title:'Один',year:1999,tmdb:'11'});
 assert.equal((await call('POST',{id:'one',started:true},{},{BUCKET:bucket,DB:bare.db})).status,200);
 assert.deepEqual(records.get('started/one.json').lastEvent.film,{id:'one',title:'Фильм',year:null,tmdb:'11'},'a new started never takes its title or year from the previous R2 event');
}
// An identity reassigned since the mark: the Letterboxd id `one` now has a different trusted TMDB claim (12, was 11). Cancelling the mark keeps the film of the mark's own event and never
// records the unstart for another movie; nothing is matched by title or year.
{
 const reassigned=database('open',film('film:tmdb:12',12,'Original two')+claim('film:tmdb:12','tmdb','12')+claim('film:tmdb:12','letterboxd','one')+meta('film:tmdb:12',2001));
 const stored=records.get('started/one.json').lastEvent.film;assert.equal(stored.tmdb,'11');
 assert.equal((await call('POST',{id:'one',started:false},{},{BUCKET:bucket,DB:reassigned.db})).status,200);
 const after=records.get('started/one.json');assert.equal(after.started,false);assert.equal(after.lastEvent.type,'unstarted');
 assert.deepEqual(after.lastEvent.film,stored,'unstarted keeps the original event film when the verified TMDB identity changed');
 // The same Film still resolving to the same trusted TMDB claim is described from D1 as before (the `two` case above).
}

// A re-started mark after unstarted is a new action with a new event; an old stored event stays readable through GET /api/events.
puts=[];assert.equal((await call('POST',{id:'one',started:true})).status,200);assert.equal(records.get('started/one.json').started,true);
{
 const all=[];let cursor=null;
 do{const response=await ctx.worker.fetch(new Request('https://site.example/api/events'+(cursor?'?cursor='+cursor:'')),environment);assert.equal(response.status,200);const page=await response.json();all.push(...page.events);cursor=page.cursor;}while(cursor);
 const marks=all.filter(event=>event.type==='started'||event.type==='unstarted');
 assert.ok(marks.length>=5);assert.ok(marks.every(event=>event.film&&typeof event.film.id==='string'),'every stored mark event stays readable');
 const one=marks.filter(event=>event.film.id==='one').sort((x,y)=>y.at.localeCompare(x.at))[0];assert.equal(one.type,'started');assert.deepEqual(one.film,{id:'one',title:'Один',year:1999,tmdb:'11'});
}
// GET /api/started and GET /api/events never write.
puts=[];await call('GET');await ctx.worker.fetch(new Request('https://site.example/api/events'),environment);assert.deepEqual(puts,[],'the read routes write nothing');

// Validation, origin and storage errors keep their answers.
assert.equal((await call('POST',{id:'../metadata',started:true})).status,400);assert.equal((await call('POST',{id:'one',started:'true'})).status,400);assert.equal((await call('POST',null)).status,400);
assert.equal((await call('POST',{id:'one',started:true},{Origin:'https://other.example'})).status,403);
bucket.put=async()=>{throw new Error('Unavailable')};assert.equal((await call('POST',{id:'tmdb_13',started:false})).status,502);assert.ok(records.get('started/tmdb_13.json').started!==false,'a failed put leaves the mark');
console.log('Started marks: canonical D1 Film identity (title, year, trusted TMDB only), retained Film outside programme and watchlist, no frozen metadata.json/programme.json read, deterministic refusals with zero R2 writes, held/unreadable/moved generation fail closed, idempotent repeat, unstarted last-known film, read routes write nothing, validation, origin and storage errors passed');
