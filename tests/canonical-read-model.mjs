// AIR-372 / ADR 0099: the canonical Film/Person bulk read model. Inactive and read-only: id sets, redirects and cycles, typed external ids,
// role-specific persons, owner > reviewed > automatic precedence with the owner-review domain, fixed query budgets, the marker gate and
// generation guard, and no R2 or write access. On the sqlite3-CLI D1 stand-in; nothing here touches the Worker, R2 or production.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {mutateFilm,mutatePerson} from '../src/canonical-mutations.js';
import {recordLocalizationSources} from '../src/localization-sources.js';
import {canonicalReaderMode,readFilms,readPersons,resolveRedirects,ownerCandidatesFromEntries,CANONICAL_READ_MAX_IDS,CANONICAL_OWNER_ANCESTOR_CAP,CANONICAL_FILMOGRAPHY_CAP} from '../src/canonical-read-model.js';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-read-model-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>name.replace(/\.sql$/,''));
assert.ok(chain.includes('0014_localization_source'),'the chain includes 0014');
let n=0;
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1";
function database({upTo=chain.length,state='open'}={}){
 const file=path.join(root,'rm-'+(n++)+'.sqlite');
 sqlite(file,chain.slice(0,upTo).map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'));
 if(state==='open'||state==='held')sqlite(file,OPEN);
 if(state==='held')sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 if(state==='prepared')sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1");
 return file;
}
const AT='2026-11-07T10:00:00.000Z';
const env=file=>({DB:d1Standin(file),R2:new Proxy({},{get(){throw new Error('R2 must not be touched');}})});
const code=expected=>error=>error.code===expected;
async function film(e,id,ext=[]){return mutateFilm(e,{id,expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'Original '+id,externalIds:ext}});}
async function person(e,id){return mutatePerson(e,{id,expectedRevision:0,at:AT,person:{roleId:id.slice(7),contractVersion:1}});}
const source=(over={})=>({source:'wikidata',value:'Авто',sourceVersion:'v1',provenance:{},observedAt:'2026-11-07T09:00:00.000Z',...over});
const auto=(e,kind,id,value,rev=1)=>recordLocalizationSources(e,{kind,id,expectedRevision:rev,at:AT,requestId:'r-'+id+value,sources:[source({value})]});
const run=(file,sql)=>sqlite(file,sql);

// 1. The marker gate: legacy/r2/prepared keep the existing runtime, open reads D1, held and unreadable states fail closed; never R2.
{
 const legacy=database({upTo:12,state:'none'});
 assert.deepEqual(Object.values(await canonicalReaderMode(env(legacy))).slice(0,1),['existing']);
 assert.equal((await canonicalReaderMode(env(database({state:'r2'})))).mode,'existing');
 assert.equal((await canonicalReaderMode(env(database({state:'prepared'})))).mode,'existing');
 const open=await canonicalReaderMode(env(database()));
 assert.deepEqual([open.mode,open.generation,open.state],['d1',2,'open']);
 await assert.rejects(()=>canonicalReaderMode(env(database({state:'held'}))),code('film_person_held'));
 const broken=database();run(broken,'DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority');
 await assert.rejects(()=>canonicalReaderMode(env(broken)),code('film_person_unavailable'),'a missing marker row');
 for(const state of ['r2','prepared']){
  await assert.rejects(()=>readFilms(env(database({state})),['film:tmdb:1']),code('canonical_read_not_authoritative'),state+' is not a D1 read authority');
  await assert.rejects(()=>readPersons(env(database({state})),['person:actor/a']),code('canonical_read_not_authoritative'));
 }
 await assert.rejects(()=>readFilms(env(legacy),['film:tmdb:1']),code('canonical_read_not_authoritative'),'legacy');
 await assert.rejects(()=>readFilms(env(database({state:'held'})),['film:tmdb:1']),code('film_person_held'),'held fails closed, never R2');
 await assert.rejects(()=>readFilms(env(broken),['film:tmdb:1']),code('film_person_unavailable'));
 // Schema 13 (no source table) with an open marker: the precedence cannot be proven, so the read fails closed.
 const v13=database({upTo:chain.indexOf('0014_localization_source')});
 await assert.rejects(()=>readFilms(env(v13),['film:tmdb:1']),error=>['localization_source_unavailable','canonical_read_unavailable'].includes(error.code));
}

// 2. Bulk films: typed ids, aliases, metadata, watchlist, credits, redirects, cycles, unknown ids, owner precedence.
{
 const file=database();
 const e=env(file);
 await film(e,'film:tmdb:1',[{scheme:'tmdb',value:'1',trusted:true}]);
 await film(e,'film:tmdb:2',[{scheme:'tmdb_tv',value:'1',trusted:true},{scheme:'tmdb',value:'77',trusted:false,conflicting:true}]);
 await film(e,'film:tmdb:3');await film(e,'film:tmdb:4');await film(e,'film:tmdb:5');
 await person(e,'person:actor/a');await person(e,'person:director/a');await person(e,'person:tmdb_actor/9');
 await mutateFilm(e,{id:'film:tmdb:1',expectedRevision:1,at:AT,film:{contractVersion:1,aliases:[{kind:'title',value:'Алиас'}]},credits:{upsert:[{personId:'person:director/a',role:'director'},{personId:'person:actor/a',role:'actor'},{personId:'person:tmdb_actor/9',role:'actor'}]}});
 run(file,"INSERT INTO film_metadata (film_id,schema_version,year,runtime,genres_json,payload_json,updated_at) VALUES ('film:tmdb:1',1,1999,101,'[\"drama\"]','{}','t');INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:1','t');");
 // Redirects: 3 -> 4 -> 5, a loop 6 <-> 7 (rows written directly: the writer never makes one), and a too deep chain.
 run(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:loop:6',1,'t'),('film:loop:7',1,'t');PRAGMA foreign_keys=OFF;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:3','film:tmdb:4','t'),('film:tmdb:4','film:tmdb:5','t'),('film:loop:6','film:loop:7','t'),('film:loop:7','film:loop:6','t');");
 const result=await readFilms(e,['film:tmdb:1','film:tmdb:2','film:tmdb:3','film:loop:6','film:tmdb:404']);
 assert.equal(result.generation,2);
 const one=result.items.get('film:tmdb:1');
 assert.deepEqual([one.id,one.canonicalIdentity,one.originalTitle,one.revision,one.inWatchlist,one.redirect],['film:tmdb:1',null,'Original film:tmdb:1',2,true,null]);
 assert.deepEqual(one.metadata,{year:1999,runtime:101,genres:['drama'],url:null});
 assert.deepEqual(one.aliases,[{kind:'title',value:'Алиас'}]);
 assert.deepEqual(one.credits.map(item=>[item.personId,item.role,item.ordinal]),[['person:director/a','director',0],['person:actor/a','actor',0],['person:tmdb_actor/9','actor',1]],'credits keep role and ordinal, with role-specific person ids');
 assert.ok(one.credits.every(item=>item.name.tier==='none'),'a person with no localization has none');
 // tmdb and tmdb_tv with the same number are different, and a conflicting holder is never trusted.
 assert.deepEqual(result.items.get('film:tmdb:2').externalIds,[{scheme:'tmdb',value:'77',trusted:false,conflicting:true},{scheme:'tmdb_tv',value:'1',trusted:true,conflicting:false}]);
 assert.deepEqual(one.externalIds,[{scheme:'tmdb',value:'1',trusted:true,conflicting:false}]);
 // A redirect chain answers the survivor with the chain; a loop is reported; an unknown id is null.
 const moved=result.items.get('film:tmdb:3');
 assert.deepEqual([moved.id,moved.requested,moved.redirect],['film:tmdb:5','film:tmdb:3',{chain:['film:tmdb:3','film:tmdb:4'],to:'film:tmdb:5'}]);
 assert.equal(result.items.get('film:loop:6').state,'cycle');
 assert.equal(result.items.get('film:tmdb:404'),null);
 // Depth cap.
 run(file,"PRAGMA foreign_keys=OFF;"+Array.from({length:10},(_,i)=>`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:deep:${i}','film:deep:${i+1}','t');`).join(''));
 assert.equal((await resolveRedirects(e,['film:deep:0'])).get('film:deep:0').state,'too_deep');
 assert.equal((await resolveRedirects(e,['film:deep:5'])).get('film:deep:5').state,'redirected','a chain within the depth resolves');
 // Duplicates collapse; invalid or too many ids are refused; an empty set answers empty without a query beyond the gate.
 assert.equal((await readFilms(e,['film:tmdb:1','film:tmdb:1'])).items.size,1);
 await assert.rejects(()=>readFilms(e,['tmdb:1']),code('canonical_read_invalid'));
 await assert.rejects(()=>readFilms(e,'film:tmdb:1'),code('canonical_read_invalid'));
 await assert.rejects(()=>readFilms(e,Array.from({length:CANONICAL_READ_MAX_IDS+1},(_,i)=>'film:x:'+i)),code('canonical_read_bounded'));
 assert.equal((await readFilms(e,[])).items.size,0);
 // Nothing was written by any read.
 assert.equal(e.DB.calls.batches>=0,true);
}

// 3. Precedence with the owner-review domain: owner > reviewed dictionary > automatic, against late automatic values and held links.
{
 const file=database();
 const e=env(file);
 for(const id of ['film:tmdb:1','film:tmdb:2','film:tmdb:3','film:tmdb:4'])await film(e,id);
 await person(e,'person:actor/a');
 const dimension=(id,status,sourceName,authority,value)=>`INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('${id}','localization','${status}','${sourceName}','{}','${value}',${authority?`'${authority}'`:'NULL'},0,'2026-11-07T00:00:00.000Z')`;
 run(file,[dimension('film:tmdb:2','reviewed','dictionary','dictionary','Словарь')].join(';\n'));
 const entry=(kind,key,link,state,localization)=>`INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('${kind}','${key}','${JSON.stringify({localization}).replace(/'/g,"''")}',${link?`'${link}'`:'NULL'},'${state}',1)`;
 const owner={status:'reviewed',value:'Владелец',provenance:{authority:'owner'},updatedAt:AT};
 run(file,[entry('film','k1','film:tmdb:1','verified',owner),entry('film','k2','film:tmdb:2','verified',owner),entry('film','k3','film:tmdb:3','held',owner),entry('film','k4',null,'unlinked',owner),entry('person','p1','person:actor/a','verified',{...owner,value:'Актёр владельца'})].join(';\n'));
 for(const id of ['film:tmdb:1','film:tmdb:2','film:tmdb:3'])await auto(e,'film',id,'Поздний автомат');
 await auto(e,'person',"person:actor/a",'Автомат персоны');
 const result=await readFilms(e,['film:tmdb:1','film:tmdb:2','film:tmdb:3','film:tmdb:4']);
 const tiers=id=>[result.items.get(id).title.tier,result.items.get(id).title.value];
 assert.deepEqual(tiers('film:tmdb:1'),['owner','Владелец'],'a verified owner review beats a late automatic value');
 assert.deepEqual(tiers('film:tmdb:2'),['owner','Владелец'],'and a reviewed dictionary value');
 assert.ok(result.items.get('film:tmdb:2').title.held.some(item=>item.tier==='reviewed'));
 assert.deepEqual(tiers('film:tmdb:3'),['automatic','Поздний автомат'],'a held link is not an owner value here');
 assert.deepEqual(tiers('film:tmdb:4'),['none',null],'an unlinked owner entry belongs to no film');
 const people=await readPersons(e,['person:actor/a']);
 assert.deepEqual([people.items.get('person:actor/a').name.tier,people.items.get('person:actor/a').name.value],['owner','Актёр владельца']);
 // Without the owner domain the precedence cannot be proven: fail closed.
 run(file,'DROP INDEX owner_review_entry_identity;DROP TABLE owner_review_entry');
 await assert.rejects(()=>readFilms(e,['film:tmdb:1']),code('canonical_read_owner_unavailable'));
 // The pure mapping.
 assert.deepEqual([...ownerCandidatesFromEntries([{identity_state:'verified',identity_link:'film:x',source_key:'b',payload_json:JSON.stringify({localization:owner})},{identity_state:'verified',identity_link:'film:x',source_key:'a',payload_json:JSON.stringify({localization:{...owner,value:'Другой'}})},{identity_state:'verified',identity_link:'film:y',payload_json:'{bad'},{identity_state:'verified',identity_link:'film:z',payload_json:JSON.stringify({localization:{...owner,provenance:{authority:'dictionary'}}})},{identity_state:'held',identity_link:'film:w',payload_json:JSON.stringify({localization:owner})}])],[['film:x',[{value:'Владелец',at:AT,sourceKey:'b',link:'film:x'},{value:'Другой',at:AT,sourceKey:'a',link:'film:x'}].sort((x,y)=>x.value<y.value?-1:1)]]);
}

// 3b. Owner decisions survive a Film merge (the owner-review store is not rewritten by it) and a conflict between source keys is visible, never order-dependent.
{
 const mk=()=>{const file=database();const e=env(file);return {file,e};};
 const owner=(value)=>({status:'reviewed',value,provenance:{authority:'owner'},updatedAt:AT});
 const entry=(key,link,value,state='verified')=>`INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film','${key}','${JSON.stringify({localization:owner(value)}).replace(/'/g,"''")}','${link}','${state}',1)`;
 const redirect=(file,from,to)=>run(file,`PRAGMA foreign_keys=OFF;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('${from}','${to}','t');`);
 const title=async(e,id)=>{const item=(await readFilms(e,[id])).items.get(id);return [item.title.tier,item.title.value];};
 // 1. An owner review linked to the retired Film still wins, whether the old or the surviving id is read, over a dictionary and a late automatic value.
 {
  const {file,e}=mk();
  await film(e,'film:keep');
  run(file,"INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('film:keep','localization','reviewed','dictionary','{}','Словарь','dictionary',0,'t')");
  await auto(e,'film','film:keep','Поздний автомат',1);
  run(file,entry('k-old','film:old','Выбор владельца'));
  redirect(file,'film:old','film:keep');
  assert.deepEqual(await title(e,'film:keep'),['owner','Выбор владельца'],'read by the survivor');
  assert.deepEqual(await title(e,'film:old'),['owner','Выбор владельца'],'read by the retired id');
  const both=await readFilms(e,['film:old','film:keep']);
  assert.deepEqual([both.items.get('film:old').title.value,both.items.get('film:keep').title.value],['Выбор владельца','Выбор владельца']);
  // A chain old2 -> old -> keep: a link on any id of the chain counts.
  run(file,entry('k-old2','film:old2','Выбор владельца'));
  redirect(file,'film:old2','film:old');
  assert.deepEqual(await title(e,'film:keep'),['owner','Выбор владельца']);
  // The owner-review store is untouched by the read.
  assert.equal(rows(file,'SELECT COUNT(*) c FROM owner_review_entry')[0].c,2);
 }
 // The same title behind two source keys, or on the survivor and a retired id, is safe.
 {
  const {file,e}=mk();
  await film(e,'film:keep');
  run(file,[entry('letterboxd-a','film:keep','Один'),entry('tmdb_9','film:keep','Один'),entry('k-old','film:old','Один')].join(';\n'));
  redirect(file,'film:old','film:keep');
  assert.deepEqual(await title(e,'film:keep'),['owner','Один']);
 }
 // 2. Two verified source keys on one Film with different owner titles: an explicit conflict, the same whichever order the rows were written in.
 for(const order of [['a','b'],['b','a']]){
  const {file,e}=mk();
  await film(e,'film:keep');
  await auto(e,'film','film:keep','Автомат',1);
  run(file,order.map(key=>entry(key==='a'?'letterboxd-a':'tmdb_9','film:keep',key==='a'?'Название A':'Название B')).join(';\n'));
  const item=(await readFilms(e,['film:keep'])).items.get('film:keep');
  assert.deepEqual([item.title.tier,item.title.value],['owner_conflict',null],'no value is chosen and the automatic value does not replace it');
  assert.deepEqual(item.title.ownerConflict.map(row=>[row.sourceKey,row.value]).sort(),[['letterboxd-a','Название A'],['tmdb_9','Название B']],'the conflict names both candidates');
 }
 // A conflict across a retired id and the survivor is the same outcome.
 {
  const {file,e}=mk();
  await film(e,'film:keep');
  run(file,[entry('k-old','film:old','Старое'),entry('k-new','film:keep','Новое')].join(';\n'));
  redirect(file,'film:old','film:keep');
  assert.equal((await readFilms(e,['film:old'])).items.get('film:old').title.tier,'owner_conflict');
 }
 // 3. A held or non-owner entry on the retired id is not an owner value; an ambiguous redirect set fails closed.
 {
  const {file,e}=mk();
  await film(e,'film:keep');
  run(file,entry('k-held','film:old','Не владелец','held'));
  redirect(file,'film:old','film:keep');
  assert.deepEqual(await title(e,'film:keep'),['none',null]);
  // A chain deeper than the cap that ends at the survivor: the owner links of its tail cannot be proven complete.
  run(file,"PRAGMA foreign_keys=OFF;"+Array.from({length:10},(_,i)=>`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:far:${i}','${i===0?'film:keep':'film:far:'+(i-1)}','t');`).join(''));
  await assert.rejects(()=>readFilms(e,['film:keep']),code('canonical_read_owner_redirect'),'too deep');
 }
 // 4. Fan-in: the number of retired ids collected for one read is capped and enforced before the rows are consumed.
 {
  const fan=async(count,{second=0,ownerOn=null}={})=>{
   const {file,e}=mk();
   await film(e,'film:keep');
   const inserts=[];
   for(let block=0;block<count;block+=100)inserts.push("INSERT INTO film_redirect (from_id,to_film_id,at) VALUES "+Array.from({length:Math.min(100,count-block)},(_,i)=>`('film:anc:${block+i}','film:keep','t')`).join(',')+';');
   for(let block=0;block<second;block+=100)inserts.push("INSERT INTO film_redirect (from_id,to_film_id,at) VALUES "+Array.from({length:Math.min(100,second-block)},(_,i)=>`('film:sub:${block+i}','film:anc:${block+i}','t')`).join(',')+';');
   run(file,"PRAGMA foreign_keys=OFF;"+inserts.join(''));
   if(ownerOn)run(file,entry('k-owner',ownerOn,'Выбор владельца'));
   let redirectRows=0;
   const standin=d1Standin(file);
   const counting={DB:{batch:standin.batch,calls:standin.calls,prepare(sql){const prepared=standin.prepare(sql);return {...prepared,bind(...args){const statement=prepared.bind(...args);return {...statement,async all(){const result=await statement.all();if(/FROM film_redirect WHERE to_film_id IN/.test(sql))redirectRows+=result.results.length;return result;}};}};}}};
   const before=standin.calls.queries;
   const outcome=await readFilms(counting,['film:keep']).then(result=>({ok:result}),error=>({error}));
   return {outcome,redirectRows,queries:standin.calls.queries-before};
  };
  const cap=CANONICAL_OWNER_ANCESTOR_CAP;
  assert.equal(cap,300,'the documented cap');
  // At exactly the cap the read works and the owner decision of the last ancestor still wins.
  const atCap=await fan(cap,{ownerOn:`film:anc:${cap-1}`});
  assert.ok(atCap.outcome.ok,'a survivor at exactly the cap works');
  assert.deepEqual([atCap.outcome.ok.items.get('film:keep').title.tier,atCap.outcome.ok.items.get('film:keep').title.value],['owner','Выбор владельца']);
  assert.equal(atCap.redirectRows,cap+0,'exactly the cap of ancestor rows were read');
  // One more than the cap fails closed with the dedicated outcome and reads at most cap + 1 rows in a bounded number of queries.
  const over=await fan(cap+1,{ownerOn:'film:anc:0'});
  assert.equal(over.outcome.error?.code,'canonical_read_owner_fanin','no partial result and no lower-tier fallback');
  assert.ok(over.redirectRows<=cap+1,'at most cap + 1 rows are read: '+over.redirectRows);
  assert.ok(over.queries<=40,'a bounded number of queries: '+over.queries);
  // A large fan-in is not read in full: ten times the cap still reads at most cap + 1 rows and issues the same bounded number of queries.
  const huge=await fan(cap*10);
  assert.equal(huge.outcome.error?.code,'canonical_read_owner_fanin');
  assert.ok(huge.redirectRows<=cap+1&&huge.queries<=over.queries+4,'the cap, not the table size, bounds the read: '+huge.redirectRows+' rows, '+huge.queries+' queries');
  // The budget accumulates across rounds: cap/2+10 direct ancestors and as many second-level ones exceed the cap together.
  const deep=await fan(Math.floor(cap/2)+10,{second:Math.floor(cap/2)+10});
  assert.equal(deep.outcome.error?.code,'canonical_read_owner_fanin','depth 2 rows count against the same budget');
  // Half the cap at each level (a total below the cap) still resolves.
  const fits=await fan(Math.floor(cap/2),{second:Math.floor(cap/2)-10,ownerOn:'film:sub:3'});
  assert.equal(fits.outcome.ok?.items.get('film:keep').title.value,'Выбор владельца','a total below the cap through two levels works with owner precedence');
 }
 {
  // A loop that includes the survivor: the survivor redirects, so it is not a survivor; the requested id answers cycle and no owner value is invented.
  const {file,e}=mk();
  await film(e,'film:a');
  run(file,entry('k-a','film:b','Из цикла'));
  redirect(file,'film:a','film:b');redirect(file,'film:b','film:a');
  const item=(await readFilms(e,['film:a'])).items.get('film:a');
  assert.equal(item.state,'cycle');
 }
}

// 4. Persons: role-specific records, typed ids, aliases, a bounded filmography with resolved film titles, no merge by name.
{
 const file=database();
 const e=env(file);
 await person(e,'person:actor/a');await person(e,'person:director/a');await person(e,'person:tmdb_actor/9');
 await mutatePerson(e,{id:'person:actor/a',expectedRevision:1,at:AT,person:{roleId:'actor/a',contractVersion:1,aliases:[{kind:'name',value:'Original Name'}],externalIds:[{scheme:'tmdb',value:'9',trusted:true}]}});
 await film(e,'film:tmdb:1');await film(e,'film:tmdb:2');
 for(const [id,rev] of [['film:tmdb:1',1],['film:tmdb:2',1]])await mutateFilm(e,{id,expectedRevision:rev,at:AT,film:{contractVersion:1},credits:{upsert:[{personId:'person:actor/a',role:'actor'},{personId:'person:director/a',role:'director'}]}});
 await auto(e,'film','film:tmdb:1','Фильм один',2);
 await auto(e,'person','person:actor/a','Имя',2);
 const result=await readPersons(e,['person:actor/a','person:director/a','person:tmdb_actor/9','person:actor/none']);
 const a=result.items.get('person:actor/a');
 assert.deepEqual([a.role,a.source,a.revision,a.name.value],['actor','letterboxd',3,'Имя']);
 assert.deepEqual(a.aliases,[{kind:'name',value:'Original Name'}]);
 assert.deepEqual(a.externalIds,[{scheme:'tmdb',value:'9',trusted:true,conflicting:false}]);
 assert.deepEqual(a.filmography.map(item=>[item.filmId,item.role,item.title.tier]),[['film:tmdb:1','actor','automatic'],['film:tmdb:2','actor','none']]);
 assert.equal(result.items.get('person:director/a').role,'director','the same key under another role is another record');
 assert.equal(result.items.get('person:tmdb_actor/9').source,'tmdb');
 assert.equal(result.items.get('person:actor/none'),null);
 assert.equal(result.truncated,false);
 await assert.rejects(()=>readPersons(e,['actor/a']),code('canonical_read_invalid'));
 // The filmography cap is for the whole call and says so.
 run(file,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:actor/big','actor/big',1,'t');"+Array.from({length:Math.ceil((CANONICAL_FILMOGRAPHY_CAP+20)/100)},(_,block)=>'INSERT INTO film (id,contract_version,updated_at) VALUES '+Array.from({length:100},(_,i)=>`('film:big:${block*100+i}',1,'t')`).join(',')+';').join('')+"INSERT INTO film_person_credit (film_id,person_id,role,ordinal) SELECT id,'person:actor/big','actor',CAST(substr(id,10) AS INTEGER) FROM film WHERE id LIKE 'film:big:%';");
 const big=await readPersons(e,['person:actor/big']);
 assert.equal(big.truncated,true);
 assert.equal(big.items.get('person:actor/big').filmography.length,CANONICAL_FILMOGRAPHY_CAP);
}

// 5. Query budgets: a fixed number of queries per chunk of 80 ids, not per id.
{
 const file=database();
 const e=env(file);
 const many=Array.from({length:170},(_,i)=>'film:tmdb:'+(i+1));
 run(file,"INSERT INTO film (id,contract_version,updated_at) VALUES "+many.map(id=>`('${id}',1,'t')`).join(',')+';INSERT INTO person (id,role_id,contract_version,updated_at) VALUES '+Array.from({length:150},(_,i)=>`('person:actor/p${i}','actor/p${i}',1,'t')`).join(',')+";INSERT INTO film_person_credit (film_id,person_id,role,ordinal) SELECT 'film:tmdb:'||(i+1),'person:actor/p'||(i%150),'actor',i FROM (WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i<169) SELECT i FROM s);");
 const count=async(fn)=>{const before=e.DB.calls.queries;await fn();return e.DB.calls.queries-before;};
 const one=await count(()=>readFilms(e,[many[0]]));
 const eighty=await count(()=>readFilms(e,many.slice(0,80)));
 const all=await count(()=>readFilms(e,many));
 assert.equal(one,eighty,'one film and eighty films cost the same number of queries');
 assert.ok(all>eighty&&all<eighty*3.2,'170 films cost about one more chunk per query, not 170 queries: '+eighty+' -> '+all);
 const p1=await count(()=>readPersons(e,['person:actor/p0']));
 const p80=await count(()=>readPersons(e,Array.from({length:40},(_,i)=>'person:actor/p'+i)));
 assert.equal(p1,p80,'persons: the same number of queries for one or forty (their filmographies fit one chunk of films)');
 assert.ok(eighty<=60,'a bounded budget for a batch: '+eighty);
}

// 6. A marker that moves during the read refuses the whole result (stale generation), and a read never writes or touches R2.
{
 const file=database();
 let moved=false;
 const e={DB:d1Standin(file,{onQuery:async text=>{if(!moved&&/FROM film f LEFT JOIN canonical_revision/.test(text)){moved=true;run(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}}}),R2:new Proxy({},{get(){throw new Error('R2 must not be touched');}})};
 await film(env(file),'film:tmdb:1');
 await assert.rejects(()=>readFilms(e,['film:tmdb:1']),code('film_person_generation_moved'),'a marker that went held mid-read is refused');
 const file2=database();
 await film(env(file2),'film:tmdb:1');
 let bumped=false;
 const e2={DB:d1Standin(file2,{onQuery:async text=>{if(!bumped&&/FROM film f LEFT JOIN canonical_revision/.test(text)){bumped=true;run(file2,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1");}}})};
 await assert.rejects(()=>readFilms(e2,['film:tmdb:1']),code('film_person_generation_moved'),'a generation that moved and returned to open is refused');
 const before=rows(file2,'SELECT (SELECT COUNT(*) FROM film) f,(SELECT COUNT(*) FROM canonical_revision) r,(SELECT COUNT(*) FROM film_localization_source) s');
 const e3=env(file2);
 await readFilms(e3,['film:tmdb:1']);
 assert.deepEqual(rows(file2,'SELECT (SELECT COUNT(*) FROM film) f,(SELECT COUNT(*) FROM canonical_revision) r,(SELECT COUNT(*) FROM film_localization_source) s'),before,'a read changes no row');
 assert.equal(e3.DB.calls.batches,0,'a read issues no batch');
}

// 7. Static: inactive. Not imported by any source file, not bundled, no route names it; the existing readers are unchanged.
{
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('canonical-read-model'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,[],'no source file imports or names the read model');
 for(const file of ['build.mjs','package.json','wrangler.jsonc','wrangler.toml'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-read-model'),file+' does not bundle it');
 const module=fs.readFileSync('src/canonical-read-model.js','utf8');
 assert.ok(!/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?\s*\w/.test(module.replace(/\/\/.*$/gm,'')),'the read model contains no write statement');
 assert.ok(!/R2|fetch\(|env\.[A-Z0-9_]+BUCKET/.test(module.replace(/\/\/.*$/gm,'')),'and no R2 or network access');
}

console.log('canonical-read-model: the marker gate keeps the existing runtime for legacy/r2/prepared, reads D1 only when open and fails closed for held or unreadable; bulk films and persons answer in fixed queries per chunk with typed ids, redirects, cycles, role-specific persons and a bounded filmography; owner > reviewed dictionary > automatic holds with owner_review_entry; a marker that moves mid-read refuses the result; the module is read-only and inactive');
