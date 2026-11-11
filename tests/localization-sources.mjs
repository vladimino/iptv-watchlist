// AIR-368 / ADR 0099: automatic localization sources and the owner > reviewed dictionary > automatic precedence. Migration 0014 (a file only),
// the pure resolver, the compare-only adapter and the fenced source writer, on the sqlite3-CLI D1 stand-in. No Worker, R2, TMDB or production
// access. Repeat in AIR-371 (producers call the writer), AIR-372 (bulk read model), AIR-373 (baseline/parity) and AIR-374 (activation).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {mutateFilm,mutatePerson,mergeFilms} from '../src/canonical-mutations.js';
import {resolveLocalization,loadLocalizationInputs,readLocalization,compareLocalization,recordLocalizationSources,AUTOMATIC_SOURCE_ORDER} from '../src/localization-sources.js';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-localization-sources-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>name.replace(/\.sql$/,''));
const NEW='0014_localization_source';
assert.ok(names.includes(NEW),'0014 exists');
const chain=names.filter(name=>name<NEW);
let n=0;
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const sql=name=>fs.readFileSync('migrations/'+name+'.sql','utf8');
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern);};
function database({upTo=chain.length,apply=true,open=false}={}){
 const file=path.join(root,'ls-'+(n++)+'.sqlite');
 const r=sqlite(file,chain.slice(0,upTo).map(sql).join('\n'));assert.equal(r.status,0,r.stderr);
 if(apply){const r2=sqlite(file,sql(NEW));assert.equal(r2.status,0,r2.stderr);}
 if(open)assert.equal(sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 return file;
}
const AT='2026-11-07T10:00:00.000Z';
const source=(over={})=>({source:'wikidata',value:'Название',sourceVersion:'wd:2026-11',provenance:{query:'label'},observedAt:'2026-11-07T09:00:00.000Z',...over});
const state=file=>({DB:d1Standin(file)});
async function seedFilm(env,id='film:tmdb:1'){return mutateFilm(env,{id,expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'Original',externalIds:[{scheme:'tmdb',value:id.split(':').pop(),trusted:true}]}});}
async function seedPerson(env,id='person:director/1'){return mutatePerson(env,{id,expectedRevision:0,at:AT,person:{roleId:'director/1',contractVersion:1}});}
const code=expected=>error=>error.code===expected;

// 1. The migration: it refuses anything but a complete v13, creates nothing then, and creates only two empty tables.
{
 for(const upTo of [12,11,9]){
  const file=database({upTo,apply:false});
  const before=one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type='table'");
  refused(file,sql(NEW));
  assert.equal(one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type='table'"),before,'a refused file creates nothing (v'+upTo+')');
 }
 const file=database();
 assert.equal(one(file,'SELECT version FROM schema_contract'),14);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_localization_source')+one(file,'SELECT COUNT(*) FROM person_localization_source'),0,'no row is written');
 assert.deepEqual(rows(file,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'r2',cutover:'open',generation:0}],'the marker is not moved');
 refused(database(),sql(NEW));
 refused(file,'UPDATE schema_contract SET version=13',/schema_contract_downgrade/);
 // The tables refuse an owner/reviewed/dictionary source, an empty value and malformed provenance, and need a real entity.
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:x',1,'t')");
 const insert=(extra)=>`INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ('film:x',${extra},'v1','{}','r','2026-11-07T00:00:00.000Z','t')`;
 assert.equal(sqlite(file,insert("'wikidata','Название'")).status,0);
 for(const bad of ["'owner','Название'","'dictionary','Название'","'reviewed','Название'","'Wiki','Название'","'wikidata',''"])refused(file,insert(bad));
 refused(file,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ('film:x','tmdb','v','v','{bad','r','2026-11-07T00:00:00.000Z','t')",/CHECK/);
 for(const bad of ['2026-11-07T12:00:00+02:00','2026-11-07T11:00:00Z','2026-11-07','t'])refused(file,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ('film:x','tmdb','v','v','{}','r','"+bad+"','t')",/CHECK/);
 refused(file,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ('film:none','tmdb','v','v','{}','r','2026-11-07T00:00:00.000Z','t')",/FOREIGN KEY/);
 refused(file,"INSERT INTO person_localization_source (person_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ('person:none','tmdb','v','v','{}','r','2026-11-07T00:00:00.000Z','t')",/FOREIGN KEY/);
}

// 2. The pure precedence contract: owner > reviewed dictionary > automatic, whatever the clocks say.
{
 const auto=[source({source:'wikidata',value:'Вики',observedAt:'2026-11-07T08:00:00.000Z'}),source({source:'letterboxd',value:'Леттербокс',observedAt:'2026-11-01T08:00:00.000Z'}),source({source:'tmdb',value:'ТМДБ',observedAt:'2026-11-07T12:00:00.000Z'})];
 let r=resolveLocalization({automatic:auto});
 assert.deepEqual([r.value,r.tier,r.source],['Леттербокс','automatic','letterboxd'],'the fixed source order decides before the clocks');
 assert.deepEqual(r.held.map(item=>item.source).sort(),['tmdb','wikidata']);
 assert.deepEqual(AUTOMATIC_SOURCE_ORDER.slice(0,3),['letterboxd','tmdb','wikidata']);
 r=resolveLocalization({reviewed:{value:'Словарь',source:'dictionary'},automatic:auto});
 assert.deepEqual([r.value,r.tier],['Словарь','reviewed'],'a reviewed value beats a later automatic one');
 assert.ok(r.held.every(item=>item.reason==='reviewed_kept'&&item.tier==='automatic'));
 r=resolveLocalization({owner:{value:'Владелец'},reviewed:{value:'Словарь'},automatic:auto});
 assert.deepEqual([r.value,r.tier,r.source],['Владелец','owner','owner']);
 assert.ok(r.held.some(item=>item.tier==='reviewed'&&item.reason==='owner_kept'),'the reviewed value is held, not lost');
 assert.equal(resolveLocalization({owner:{value:'Владелец'},automatic:[source({value:'Владелец'})]}).held.length,0,'an equal value is not a conflict');
 // Same source, same tier, later automatic observations do not matter against a higher tier; no owner/reviewed means none.
 assert.deepEqual([resolveLocalization({}).value,resolveLocalization({}).tier],[null,'none']);
 assert.equal(resolveLocalization({owner:{value:'   '},automatic:[source()]}).tier,'automatic','a blank owner value is not an owner value');
 // Inconsistent, malformed or reserved automatic candidates are rejected and never promoted.
 r=resolveLocalization({automatic:[source({provenance:{authority:'owner'}}),source({provenance:'{bad'}),source({source:'owner'}),source({value:''}),source({source:'Wiki'}),source({provenance:{status:'reviewed'}}),null]});
 assert.equal(r.tier,'none');
 assert.deepEqual(r.rejected.map(item=>item.reason),['inconsistent_provenance','malformed_provenance','invalid_source','empty_value','invalid_source','inconsistent_provenance','malformed']);
 // Deterministic: the order of the inputs does not change the result.
 assert.deepEqual(resolveLocalization({automatic:[...auto].reverse()}),resolveLocalization({automatic:auto}));
}

// 3. The compare-only adapter classifies what the existing R2 path produced; it writes nothing and promotes nothing.
{
 const resolved=resolveLocalization({owner:{value:'Владелец'},automatic:[source()]});
 const incoming=(over={})=>({status:'provisional',value:'Поздний',source:'wikidata',updatedAt:'2026-11-08T00:00:00.000Z',provenance:{},...over});
 assert.equal(compareLocalization(resolved,incoming()).outcome,'held_by_owner','a late metadataSync value stays below the owner');
 assert.equal(compareLocalization(resolved,incoming({value:'Владелец'})).outcome,'same');
 assert.equal(compareLocalization(resolveLocalization({reviewed:{value:'Словарь'}}),incoming()).outcome,'held_by_reviewed');
 assert.equal(compareLocalization(resolveLocalization({automatic:[source()]}),incoming()).outcome,'differs');
 assert.equal(compareLocalization(resolveLocalization({}),incoming()).outcome,'new');
 assert.equal(compareLocalization(resolveLocalization({}),incoming()).candidate.source,'wikidata');
 for(const reviewed of [incoming({status:'reviewed'}),incoming({source:'dictionary'}),incoming({provenance:{authority:'owner'}})])assert.equal(compareLocalization(resolved,reviewed).outcome,'not_automatic','a reviewed or owner value is never an automatic candidate');
 assert.equal(compareLocalization(resolved,incoming({value:null})).outcome,'no_value');
 assert.equal(compareLocalization(resolved,incoming({source:'Bad Source'})).outcome,'rejected');
}

// 4. The writer refuses before the database unless the marker is open: the projector stays the only writer in r2 and prepared (and legacy, held).
{
 const input={kind:'film',id:'film:tmdb:1',expectedRevision:1,at:AT,requestId:'req-1',sources:[source()]};
 const legacy=database({apply:false}); // schema 12: no marker, no table
 await assert.rejects(()=>recordLocalizationSources(state(legacy),input),code('film_person_not_open'));
 const r2=database();
 await assert.rejects(()=>recordLocalizationSources(state(r2),input),code('film_person_not_open'),'r2');
 sqlite(r2,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1");
 await assert.rejects(()=>recordLocalizationSources(state(r2),input),code('film_person_not_open'),'prepared');
 assert.equal(one(r2,'SELECT COUNT(*) FROM film_localization_source'),0);
 const held=database({open:true});
 sqlite(held,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 await assert.rejects(()=>recordLocalizationSources(state(held),input),code('film_person_held'),'held');
 await assert.rejects(()=>readLocalization(state(held),'film',['film:tmdb:1']),code('film_person_held'),'held readers fail closed, never R2');
 await assert.rejects(()=>readLocalization(state(r2),'film',['film:tmdb:1']),code('localization_not_authoritative'),'prepared is not a D1 read authority');
 // From schema 13 (table not applied yet) an open marker still cannot write: a clear unavailable, not a half write.
 const v13=database({upTo:chain.length,apply:false,open:true});
 await assert.rejects(()=>recordLocalizationSources(state(v13),input),code('localization_source_unavailable'));
}

// 5. The writer when open: validation, one batch, revision, fence, replay, staleness, redirects and CAS.
{
 const file=database({open:true});
 const env=state(file);
 await seedFilm(env);await seedPerson(env);
 for(const bad of [{sources:[]},{sources:[source({source:'owner'})]},{sources:[source({provenance:{authority:'dictionary'}})]},{sources:[source({sourceVersion:''})]},{sources:[source({observedAt:'not a date'})]},{sources:[source(),source()]},{id:'tmdb:1'},{kind:'other'},{requestId:''},{expectedRevision:-1},{sources:Array.from({length:11},(_,i)=>source({source:'s'+i}))}])
  await assert.rejects(()=>recordLocalizationSources(env,{kind:'film',id:'film:tmdb:1',expectedRevision:1,at:AT,requestId:'r',sources:[source()],...bad}),error=>/^(localization_invalid|film_person_invalid)$/.test(error.code));
 const base={kind:'film',id:'film:tmdb:1',expectedRevision:1,at:AT,requestId:'req-1',sources:[source(),source({source:'tmdb',value:'ТМДБ'})]};
 const batches=env.DB.calls.batches;
 const first=await recordLocalizationSources(env,base);
 assert.deepEqual([first.revision,first.written.sort()],[2,['tmdb','wikidata']]);
 assert.equal(env.DB.calls.batches,batches+1,'one batch');
 assert.equal(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:tmdb:1'"),2);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_localization_source'),2);
 // The effective dimension and the owner-review domain are untouched: the source tables are separate.
 assert.equal(one(file,'SELECT COUNT(*) FROM film_dimension'),0);
 // A replay (same request, same content) is a no-op without a batch, even though the caller still holds the old revision.
 const replay=await recordLocalizationSources(env,base);
 assert.deepEqual([replay.revision,replay.written,replay.skipped.map(item=>item.reason)],[1,[],['replay','replay']]);
 assert.equal(env.DB.calls.batches,batches+1,'a replay writes nothing');
 assert.equal(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:tmdb:1'"),2);
 await assert.rejects(()=>recordLocalizationSources(env,{...base,sources:[source({value:'Другое'})]}),code('localization_replay_mismatch'),'the same request id with other content');
 // A stale or equal observation is skipped; a newer one replaces the value and moves the revision.
 const stale=await recordLocalizationSources(env,{...base,expectedRevision:2,requestId:'req-2',sources:[source({observedAt:'2026-11-07T09:00:00.000Z',value:'Старое'}),source({source:'tmdb',observedAt:'2026-11-06T00:00:00.000Z',value:'Старое'})]});
 assert.deepEqual([stale.written,stale.skipped.map(item=>item.reason),stale.revision],[[],['stale','stale'],2]);
 assert.equal(one(file,"SELECT value FROM film_localization_source WHERE source='wikidata'"),'Название');
 const newer=await recordLocalizationSources(env,{...base,expectedRevision:2,requestId:'req-3',sources:[source({observedAt:'2026-11-07T11:00:00.000Z',value:'Новое',sourceVersion:'wd:2026-12'})]});
 assert.deepEqual([newer.revision,newer.written],[3,['wikidata']]);
 assert.deepEqual(rows(file,"SELECT value,source_version,request_id FROM film_localization_source WHERE source='wikidata'"),[{value:'Новое',source_version:'wd:2026-12',request_id:'req-3'}]);
 // A lost revision is a retryable conflict and writes nothing; a missing entity or a redirect refuses.
 await assert.rejects(()=>recordLocalizationSources(env,{...base,expectedRevision:2,requestId:'req-4',sources:[source({observedAt:'2026-11-08T00:00:00.000Z',value:'Позднее'})]}),code('film_person_revision_conflict'));
 assert.equal(one(file,"SELECT value FROM film_localization_source WHERE source='wikidata'"),'Новое');
 await assert.rejects(()=>recordLocalizationSources(env,{...base,id:'film:tmdb:404',expectedRevision:0,requestId:'req-5'}),code('film_person_precondition'),'an entity that does not exist');
 // A newer observation that lands between the read and the batch is not overwritten by the older one: the SQL guard holds on its own.
 const lateWriter={DB:d1Standin(file,{onBatch:async()=>{sqlite(file,"UPDATE film_localization_source SET value='Гонка',observed_at='2026-12-01T00:00:00.000Z' WHERE source='wikidata'");}})};
 await recordLocalizationSources(lateWriter,{...base,expectedRevision:3,requestId:'req-6',sources:[source({observedAt:'2026-11-20T00:00:00.000Z',value:'Проигравший'})]});
 assert.equal(one(file,"SELECT value FROM film_localization_source WHERE source='wikidata'"),'Гонка');
 // A person.
 const person=await recordLocalizationSources(env,{kind:'person',id:'person:director/1',expectedRevision:1,at:AT,requestId:'p-1',sources:[source({value:'Режиссёр'})]});
 assert.equal(person.revision,2);
 assert.equal(one(file,"SELECT value FROM person_localization_source WHERE person_id='person:director/1'"),'Режиссёр');
 // A write while the marker moved after the read fails the fence and writes nothing (all or nothing).
 const racing={DB:d1Standin(file,{onBatch:async()=>{sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}})};
 await assert.rejects(()=>recordLocalizationSources(racing,{kind:'person',id:'person:director/1',expectedRevision:2,at:AT,requestId:'p-2',sources:[source({observedAt:'2026-11-08T00:00:00.000Z',value:'Поздно'})]}),code('film_person_fence'));
 assert.equal(one(file,"SELECT value FROM person_localization_source WHERE person_id='person:director/1'"),'Режиссёр');
}

// 5b. One instant ordering for the writer and the merge: equivalent instants with other offsets, lexically greater but older, and lexically
// smaller but newer observations, with a concurrent update between the preflight and the batch.
{
 const file=database({open:true});
 const env=state(file);
 await seedFilm(env,'film:tmdb:1');await seedFilm(env,'film:tmdb:2');
 const put=(id,rev,request,observedAt,value)=>recordLocalizationSources(env,{kind:'film',id,expectedRevision:rev,at:AT,requestId:request,sources:[source({observedAt,value})]});
 const stored=id=>rows(file,"SELECT value,observed_at FROM film_localization_source WHERE film_id='"+id+"' AND source='wikidata'")[0];
 await put('film:tmdb:1',1,'o1','2026-11-07T11:00:00Z','Базовое');
 assert.equal(stored('film:tmdb:1').observed_at,'2026-11-07T11:00:00.000Z','stored as normalized UTC');
 // 12:00+02:00 is 10:00 UTC: older, though its text is lexically greater.
 const older=await put('film:tmdb:1',2,'o2','2026-11-07T12:00:00+02:00','Старше');
 assert.deepEqual([older.written,older.skipped.map(item=>item.reason)],[[],['stale']]);
 assert.equal(stored('film:tmdb:1').value,'Базовое');
 // 11:30-02:00 is 13:30 UTC: newer, though its text is lexically smaller than 12.
 const newer=await put('film:tmdb:1',2,'o3','2026-11-07T11:30:00-02:00','Новее');
 assert.deepEqual([newer.written,stored('film:tmdb:1')],[['wikidata'],{value:'Новее',observed_at:'2026-11-07T13:30:00.000Z'}]);
 // The same instant with another offset is not newer and replays as stale; equivalent text under the same request id is a replay.
 assert.deepEqual((await put('film:tmdb:1',3,'o4','2026-11-07T15:30:00+02:00','Тот же момент')).skipped.map(item=>item.reason),['stale']);
 assert.deepEqual((await put('film:tmdb:1',3,'o3','2026-11-07T15:30:00+02:00','Новее')).skipped.map(item=>item.reason),['replay'],'the same instant written with another offset is the same request');
 // A concurrent writer lands a newer instant (offset form already normalized by the CHECK) between the preflight and the batch: the older one loses in SQL.
 const racing={DB:d1Standin(file,{onBatch:async()=>{sqlite(file,"UPDATE film_localization_source SET value='Гонка',observed_at='2026-11-07T20:00:00.000Z' WHERE film_id='film:tmdb:1' AND source='wikidata'");}})};
 await recordLocalizationSources(racing,{kind:'film',id:'film:tmdb:1',expectedRevision:3,at:AT,requestId:'o5',sources:[source({observedAt:'2026-11-07T23:00:00+04:00',value:'Проигравший'})]});
 assert.equal(stored('film:tmdb:1').value,'Гонка','19:00 UTC loses to 20:00 UTC even though its text is lexically greater than 2026-11-07T20');
 // Input shapes that are not an ISO instant with an offset are refused.
 for(const bad of ['2026-11-07','2026-11-07T10:00:00','Nov 7 2026','2026-11-07 10:00:00Z',1,null])await assert.rejects(()=>put('film:tmdb:1',4,'bad',bad,'x'),error=>/^(localization_invalid|film_person_invalid)$/.test(error.code));
 // The merge uses the same ordering: the survivor keeps the later instant whichever way the offsets read.
 await put('film:tmdb:2',1,'m1','2026-11-07T10:00:00Z','Выжившего');
 const before=stored('film:tmdb:1');
 await mergeFilms(env,{from:'film:tmdb:1',to:'film:tmdb:2',expected:{from:4,to:2},at:AT,evidence:{verified:true}});
 assert.deepEqual(stored('film:tmdb:2'),{value:before.value,observed_at:before.observed_at},'20:00 UTC beats 10:00 UTC');
 const file2=database({open:true});const env2=state(file2);
 await seedFilm(env2,'film:tmdb:1');await seedFilm(env2,'film:tmdb:2');
 const put2=(id,request,observedAt,value)=>recordLocalizationSources(env2,{kind:'film',id,expectedRevision:1,at:AT,requestId:request,sources:[source({observedAt,value})]});
 await put2('film:tmdb:1','a','2026-11-07T12:00:00+02:00','Старше (10:00 UTC)');
 await put2('film:tmdb:2','b','2026-11-07T11:00:00Z','Новее (11:00 UTC)');
 await mergeFilms(env2,{from:'film:tmdb:1',to:'film:tmdb:2',expected:{from:2,to:2},at:AT,evidence:{verified:true}});
 assert.equal(one(file2,"SELECT value FROM film_localization_source WHERE film_id='film:tmdb:2'"),'Новее (11:00 UTC)','a lexically greater but older retired observation does not replace the survivor');
}

// 6. A redirected Film takes no source rows; a merge adopts the retired Film's sources (newer observation wins per source) and leaves none behind.
{
 const file=database({open:true});
 const env=state(file);
 await seedFilm(env,'film:tmdb:1');await seedFilm(env,'film:tmdb:2');
 await recordLocalizationSources(env,{kind:'film',id:'film:tmdb:1',expectedRevision:1,at:AT,requestId:'a',sources:[source({source:'tmdb',value:'Старый ТМДБ',observedAt:'2026-11-01T00:00:00.000Z'}),source({source:'wikidata',value:'Вики 1'})]});
 await recordLocalizationSources(env,{kind:'film',id:'film:tmdb:2',expectedRevision:1,at:AT,requestId:'b',sources:[source({source:'tmdb',value:'Новый ТМДБ',observedAt:'2026-11-05T00:00:00.000Z'}),source({source:'letterboxd',value:'ЛБ 2'})]});
 const merged=await mergeFilms(env,{from:'film:tmdb:1',to:'film:tmdb:2',expected:{from:2,to:2},at:AT,evidence:{verified:true}});
 assert.equal(merged.merged,true);
 assert.equal(one(file,"SELECT COUNT(*) FROM film_localization_source WHERE film_id='film:tmdb:1'"),0,'nothing is left on the retired id');
 assert.deepEqual(rows(file,"SELECT source,value FROM film_localization_source WHERE film_id='film:tmdb:2' ORDER BY source"),[{source:'letterboxd',value:'ЛБ 2'},{source:'tmdb',value:'Новый ТМДБ'},{source:'wikidata',value:'Вики 1'}],'the survivor keeps the newer observation of a shared source and adopts the others');
 await assert.rejects(()=>recordLocalizationSources(env,{kind:'film',id:'film:tmdb:1',expectedRevision:3,at:AT,requestId:'c',sources:[source()]}),code('film_person_precondition'),'a retired id takes no sources');
 // The older observation does not replace a newer survivor row the other way round.
 const file2=database({open:true});const env2=state(file2);
 await seedFilm(env2,'film:tmdb:1');await seedFilm(env2,'film:tmdb:2');
 await recordLocalizationSources(env2,{kind:'film',id:'film:tmdb:1',expectedRevision:1,at:AT,requestId:'a',sources:[source({source:'tmdb',value:'Свежий',observedAt:'2026-11-06T00:00:00.000Z'})]});
 await recordLocalizationSources(env2,{kind:'film',id:'film:tmdb:2',expectedRevision:1,at:AT,requestId:'b',sources:[source({source:'tmdb',value:'Древний',observedAt:'2026-11-01T00:00:00.000Z'})]});
 await mergeFilms(env2,{from:'film:tmdb:1',to:'film:tmdb:2',expected:{from:2,to:2},at:AT,evidence:{verified:true}});
 assert.equal(one(file2,"SELECT value FROM film_localization_source WHERE film_id='film:tmdb:2' AND source='tmdb'"),'Свежий');
 // Before schema 14 a merge behaves as in AIR-367 (no table to adopt).
 const v13=database({apply:false,open:true});const env3=state(v13);
 await seedFilm(env3,'film:tmdb:1');await seedFilm(env3,'film:tmdb:2');
 assert.equal((await mergeFilms(env3,{from:'film:tmdb:1',to:'film:tmdb:2',expected:{from:1,to:1},at:AT,evidence:{verified:true}})).merged,true);
}

// 7. Owner edit vs a late metadata/projector value: the loader and reader keep owner > reviewed > automatic, with the dimension rows as the stored tiers.
{
 const file=database({open:true});
 const env=state(file);
 await seedFilm(env,'film:tmdb:1');await seedFilm(env,'film:tmdb:2');await seedFilm(env,'film:tmdb:3');await seedFilm(env,'film:tmdb:4');await seedPerson(env);
 const dimension=(id,status,sourceName,authority,value,at='2026-11-07T00:00:00.000Z')=>`INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('${id}','localization','${status}','${sourceName}','{}','${value}',${authority?`'${authority}'`:'NULL'},0,'${at}')`;
 sqlite(file,[dimension('film:tmdb:1','reviewed','owner','owner','Владелец'),dimension('film:tmdb:2','reviewed','dictionary','dictionary','Словарь'),dimension('film:tmdb:3','provisional','wikidata',null,'Провизорный')].join(';\n'));
 const sources=id=>recordLocalizationSources(env,{kind:'film',id,expectedRevision:1,at:AT,requestId:'late-'+id,sources:[source({source:'tmdb',value:'Поздний TMDB',observedAt:'2099-01-01T00:00:00.000Z'})]});
 for(const id of ['film:tmdb:1','film:tmdb:2','film:tmdb:3'])await sources(id);
 const read=await readLocalization(env,'film',['film:tmdb:1','film:tmdb:2','film:tmdb:3','film:tmdb:4']);
 assert.deepEqual([...read.values()].map(item=>[item.tier,item.value]),[['owner','Владелец'],['reviewed','Словарь'],['automatic','Поздний TMDB'],['none',null]],'a source row from the future never beats an owner or reviewed value');
 assert.ok(read.get('film:tmdb:1').held.some(item=>item.value==='Поздний TMDB'&&item.reason==='owner_kept'));
 assert.ok(read.get('film:tmdb:3').held.some(item=>item.value==='Провизорный'),'the legacy provisional value is a lower-priority automatic candidate');
 // An owner value read from owner_review_entry wins over everything, even a dimension the dictionary wrote.
 const withOwner=await readLocalization(env,'film',['film:tmdb:2'],{ownerValues:{'film:tmdb:2':{value:'Из owner_review_entry'}}});
 assert.deepEqual([withOwner.get('film:tmdb:2').tier,withOwner.get('film:tmdb:2').value],['owner','Из owner_review_entry']);
 // Inconsistent stored provenance never promotes a candidate; the loader reports it as rejected.
 sqlite(file,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ('film:tmdb:4','letterboxd','Подмена','v','{\"authority\":\"owner\"}','x','2026-11-07T00:00:00.000Z','t')");
 const bad=(await readLocalization(env,'film',['film:tmdb:4'])).get('film:tmdb:4');
 assert.deepEqual([bad.tier,bad.rejected.map(item=>item.reason)],['none',['inconsistent_provenance']]);
 // Aliases and typed identity: a title or year is never a join key; only the stored entity id is read.
 assert.equal((await loadLocalizationInputs(env,'film',['film:tmdb:1'])).size,1);
 assert.equal((await loadLocalizationInputs(env,'film',['film:letterboxd:nope'])).get('film:letterboxd:nope').automatic.length,0);
 // Bounded reads: many ids use chunks of 80 and one query pair each.
 const ids=Array.from({length:170},(_,i)=>'film:bulk:'+i);
 const spy=state(file);const before=spy.DB.calls.queries;
 assert.equal((await loadLocalizationInputs(spy,'film',ids)).size,170);
 assert.equal(spy.DB.calls.queries-before,6,'three chunks, two reads each');
 await assert.rejects(()=>loadLocalizationInputs(env,'movie',['x']),code('localization_invalid'));
 // A person.
 sqlite(file,"INSERT INTO person_dimension (person_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('person:director/1','localization','reviewed','dictionary','{}','Режиссёр из словаря','dictionary',0,'2026-11-07T00:00:00.000Z')");
 await recordLocalizationSources(env,{kind:'person',id:'person:director/1',expectedRevision:1,at:AT,requestId:'p',sources:[source({value:'Автомат'})]});
 const people=await readLocalization(env,'person',['person:director/1']);
 assert.deepEqual([people.get('person:director/1').tier,people.get('person:director/1').value],['reviewed','Режиссёр из словаря']);
}

// 8. Missing or frozen R2 mirrors do not matter: the contract reads only D1 rows; no R2 binding is needed or touched.
{
 const file=database({open:true});
 const env={DB:d1Standin(file),R2:new Proxy({},{get(){throw new Error('R2 must not be touched');}})};
 await seedFilm(env);
 await recordLocalizationSources(env,{kind:'film',id:'film:tmdb:1',expectedRevision:1,at:AT,requestId:'m',sources:[source()]});
 assert.equal((await readLocalization(env,'film',['film:tmdb:1'])).get('film:tmdb:1').value,'Название');
}

// 9. Static: inactive. No Worker file imports the module, it is not bundled, no route, job or cron names it, and the existing R2 writer is unchanged.
{
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('localization-sources'))importers.push(full);}};
 walk('src');
 // The only importer is the equally inactive canonical read model (AIR-372), which tests/canonical-read-model.mjs proves is itself imported by nothing. The film writers (AIR-374 P2a) are imported by the producers module only, which tests/canonical-film-writers.mjs proves.
 assert.deepEqual(importers.filter(file=>!file.endsWith('localization-sources.js')&&!file.endsWith('canonical-read-model.js')&&!file.endsWith('canonical-producers.js')&&!file.endsWith('canonical-film-writers.js')),[],'no Worker source file imports localization-sources');
 for(const file of ['scripts/build.mjs','scripts/build-worker.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('localization-sources'),file+' does not bundle or name it');
 assert.ok(fs.readFileSync('migrations/README.md','utf8').includes(NEW),'migrations/README.md lists 0014');
 assert.ok(!/localization_source/.test(fs.readFileSync('src/canonical-repository.js','utf8')),'the projector path does not write the source tables');
}

console.log('localization-sources: migration 0014 refuses below v13 and creates two empty tables; owner > reviewed dictionary > automatic holds against late sources, clocks and inconsistent provenance; the writer refuses unless the marker is open, is fenced, revision-checked, replay-safe and monotonic; a merge adopts or drops sources without orphans; reads fail closed when held and need no R2; the module is inactive');
