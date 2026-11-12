// AIR-374 P2a / ADR 0120: the fenced canonical Film writers (identity overwrite, film_metadata, film_sync_state, watchlist membership, lifecycle rows and the
// effective localization) on the sqlite3-CLI D1 stand-in. No Worker, R2, TMDB or production access; the module stays dormant. One template database per marker
// stage is built once and copied per scenario. FILM_WRITERS_SOURCE points the test at a mutant copy (tests/canonical-film-writers-mutation.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {mutateFilm,mutatePerson} from '../src/canonical-mutations.js';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {fenced,MUTATION_STATEMENT_CAP} from '../src/canonical-mutations.js';
import {planFilmWrite,writerRoute,dispatch,readback,readRevisions,GAPS} from '../src/canonical-producers.js';

// AIR-374: FILM_WRITERS_SECTIONS=1,4,7b runs only those numbered sections (each builds its own scenario from the shared template); unset runs all. The mutation check runs a mutant against the section that kills it first and against the whole file before it calls it a survivor.
const ONLY=new Set((process.env.FILM_WRITERS_SECTIONS||'').split(',').filter(Boolean));
const section=name=>ONLY.size===0||ONLY.has(name);
const writers=await import(process.env.FILM_WRITERS_SOURCE?pathToFileURL(process.env.FILM_WRITERS_SOURCE).href:'../src/canonical-film-writers.js');
const {planFilmFacts,readFilmSnapshot,writeFilmFacts,FILM_FACTS_SOURCE_CAP,TITLE_SOURCE_ORDER,P6_DIFFERENTIAL_EXCEPTIONS}=writers;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-writers-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sql=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const templates={};
function template(stage){
 if(templates[stage])return templates[stage];
 const file=path.join(root,'tpl-'+stage+'.sqlite');
 const upTo=stage==='legacy'?chain.findIndex(name=>name.startsWith('0013_')):chain.length;
 assert.equal(sqlite(file,chain.slice(0,upTo).map(sql).join('\n')).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(['open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return templates[stage]=file;
}
let n=0;
function fresh(stage='open',options={}){
 const file=path.join(root,'w-'+(n++)+'.sqlite');
 fs.copyFileSync(template(stage),file);
 return {file,env:{DB:d1Standin(file,options)}};
}
const T='2026-11-11T10:00:00.000Z',T2='2026-11-11T11:00:00.000Z';
const code=expected=>error=>error.code===expected;
const dump=(file,tables,strip=false)=>JSON.stringify(tables.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2').map(row=>{if(strip&&table==='film_dimension'&&row.provenance_json){const p=JSON.parse(row.provenance_json);delete p.titleSource;return {...row,provenance_json:Object.keys(p).length?JSON.stringify(p):null};}return row;})]));
const OWNED=['film','film_metadata','film_sync_state','watchlist_film','film_dimension','film_external_id'];
const dim=(dimension,extra={})=>({dimension,status:'resolved',source:'discovery',sourceVersion:'tmdb:603',provenance:{tmdbId:'603'},nextAction:'stop',attempts:0,updatedAt:T,...extra});
const META={schemaVersion:1,year:1999,runtime:136,synopsis:'A hacker learns the truth.',poster:'/p.jpg',url:'https://example.test/m',genres:['sci-fi','action'],peopleVersion:2,payload:{k:'v'},r2Key:'metadata/603.json',contentSha256:'a'.repeat(64),updatedAt:T};
const LOC=(extra={})=>({dimension:'localization',status:'provisional',source:'tmdb',sourceVersion:'tmdb:2026-11',provenance:{query:'title'},value:'Матрица',nextAction:'none',attempts:0,updatedAt:T,...extra});
const ID='film:tmdb:603';
async function seed(env,id=ID,extra={}){return mutateFilm(env,{id,expectedRevision:0,at:T,film:{contractVersion:1,originalTitle:extra.originalTitle,externalIds:[{scheme:'tmdb',value:id.split(':').pop(),trusted:true}],aliases:extra.aliases||[]},credits:extra.credits});}
const facts=(over={})=>({id:ID,expectedRevision:1,at:T,requestId:'req-1',film:{contractVersion:1,canonicalIdentity:'tmdb:603',originalTitle:'The Matrix',source:'tmdb'},dimensions:{identity:dim('identity'),metadata:dim('metadata',{status:'fresh',source:'tmdb',sourceVersion:null,provenance:null})},localization:{state:LOC()},metadata:META,sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true,...over});

// 1. The marker gate: at r2, prepared, held and legacy the writer reaches the database only for the marker read, at open it writes.
if(section('1')){
 for(const [stage,expected] of [['r2','film_person_not_open'],['prepared','film_person_not_open'],['held','film_person_held'],['legacy','film_person_not_open']]){
  const {file,env}=fresh(stage);
  await assert.rejects(writeFilmFacts(env,facts()),error=>error.code===expected||(stage==='legacy'&&/film_person/.test(error.code)),stage);
  assert.equal(env.DB.calls.batches,0,stage+': no batch');
  if(stage!=='legacy')assert.equal(rows(file,'SELECT COUNT(*) c FROM film')[0].c,0,stage+': no row');
 }
 const {env,file}=fresh('open');
 await seed(env);
 const done=await writeFilmFacts(env,facts());
 assert.deepEqual([done.written,done.revision],[true,2]);
 assert.equal(rows(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id=?".replace('?',"'"+ID+"'"))[0].revision,2);
}

// 2. One batch writes every film-side row, the effective localization in the same batch as the source write; a replay opens no batch.
if(section('2')){
 const {file,env}=fresh();
 await seed(env);
 const before=env.DB.calls.batches;
 const first=await writeFilmFacts(env,facts());
 assert.equal(env.DB.calls.batches,before+1,'one batch');
 assert.ok(first.changes.includes('film')||first.changes.includes('metadata'));
 const film=rows(file,'SELECT canonical_identity,original_title FROM film')[0];
 assert.deepEqual(film,{canonical_identity:'tmdb:603',original_title:'The Matrix'});
 assert.equal(rows(file,'SELECT COUNT(*) c FROM film_metadata')[0].c,1);
 assert.equal(rows(file,'SELECT COUNT(*) c FROM watchlist_film')[0].c,1);
 assert.equal(rows(file,'SELECT metadata_at FROM film_sync_state')[0].metadata_at,T);
 assert.deepEqual(rows(file,"SELECT dimension,status FROM film_dimension ORDER BY dimension"),[{dimension:'identity',status:'resolved'},{dimension:'localization',status:'provisional'},{dimension:'metadata',status:'fresh'}]);
 const replay=await writeFilmFacts(env,facts());
 assert.equal(replay.written,false);assert.equal(env.DB.calls.batches,before+1,'replay opens no batch');
 const stale=await writeFilmFacts(env,facts({expectedRevision:0}));
 assert.equal(stale.written,false,'a replay of an older caller is a content no-op too');
 assert.equal(rows(file,"SELECT revision FROM canonical_revision WHERE kind='film'")[0].revision,2);
 // a changed value with a stale revision is a conflict, not a blind write
 await assert.rejects(writeFilmFacts(env,facts({requestId:'req-2',metadata:{...META,runtime:140,updatedAt:T2},expectedRevision:1})),code('film_person_revision_conflict'));
 assert.equal(rows(file,'SELECT runtime FROM film_metadata')[0].runtime,136);
}

// 3. The generation fence: a marker that moves between the read and the batch rolls the whole write back.
if(section('3')){
 let file;
 const again=fresh('open');file=again.file;
 await seed(again.env);
 let armed=false;
 const env={DB:{...again.env.DB,batch:async list=>{if(armed)sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1");return again.env.DB.batch(list);},prepare:again.env.DB.prepare}};
 armed=true;
 await assert.rejects(writeFilmFacts(env,facts()),code('film_person_fence'));
 assert.equal(rows(file,'SELECT COUNT(*) c FROM film_metadata')[0].c,0,'nothing written');
}

// 4. Unknown outcomes are settled by readback: applied-then-lost is content_present and the replay is a no-op; lost-before is not_applied and the replay applies.
if(section('4')){
 const {file,env}=fresh();
 await seed(env);
 const real=env.DB;
 const lost={DB:{prepare:real.prepare,calls:real.calls,batch:async list=>{await real.batch(list);throw new Error('network lost after commit');}}};
 const input=facts();
 await assert.rejects(writeFilmFacts(lost,input),code('film_person_unavailable'));
 const verdict=await readback(env,{fn:'writeFilmFacts',input});
 assert.equal(verdict.outcome,'content_present');assert.equal(verdict.moved,true);
 const batches=real.calls.batches;
 assert.equal((await writeFilmFacts(env,input)).written,false);assert.equal(real.calls.batches,batches);
 const second=fresh();await seed(second.env);
 const dropped={DB:{prepare:second.env.DB.prepare,batch:async()=>{throw new Error('network lost before send');}}};
 await assert.rejects(writeFilmFacts(dropped,input),code('film_person_unavailable'));
 const unsent=await readback(second.env,{fn:'writeFilmFacts',input});
 assert.equal(unsent.outcome,'not_applied');
 assert.equal((await writeFilmFacts(second.env,input)).written,true);
 assert.equal((await readback(second.env,{fn:'writeFilmFacts',input})).outcome,'content_present');
 void file;
}

// 5. The statement cap holds for the largest plan; the fenced commit refuses an oversized batch.
if(section('5')){
 const {env}=fresh();
 await seed(env);
 const sources=Array.from({length:FILM_FACTS_SOURCE_CAP},(_,i)=>({source:'s'+i,value:'v'+i,sourceVersion:'v1',provenance:{a:i},observedAt:T}));
 const snapshot=await readFilmSnapshot(env,ID);
 const plan=planFilmFacts(snapshot,facts({localization:{sources},dimensions:{identity:dim('identity'),metadata:dim('metadata')}}));
 assert.ok(plan.statements.length+4<=MUTATION_STATEMENT_CAP,'worst case '+(plan.statements.length+4));
 await assert.rejects(writeFilmFacts(env,facts({localization:{sources:[...sources,{source:'extra',value:'x',sourceVersion:'v',observedAt:T}]}})),code('film_person_invalid'));
 const gate={generation:2};
 await assert.rejects(fenced.commit(env,gate,Array.from({length:MUTATION_STATEMENT_CAP+1},()=>['SELECT 1',[]]),[]),code('film_person_bounded'));
}

// 6. Reviewed and owner values survive an automatic write; a blank never overwrites.
if(section('6')){
 const {file,env}=fresh();
 await seed(env);
 await writeFilmFacts(env,facts({localization:{state:LOC({status:'reviewed',source:'dictionary',value:'Матрица (словарь)',provenance:{authority:'dictionary'}})},dimensions:{identity:dim('identity',{status:'reviewed',source:'dictionary',provenance:{authority:'dictionary'}})}}));
 let revision=2;
 const autom=async(over)=>{const r=await writeFilmFacts(env,facts({requestId:'r'+revision,expectedRevision:revision,...over}));if(r.written)revision++;return r;};
 const r1=await autom({film:{contractVersion:1,originalTitle:'Matrix, The',source:'tmdb'},localization:{sources:[{source:'tmdb',value:'Матрица 2',sourceVersion:'v2',observedAt:T2}]},metadata:undefined,sync:undefined,watchlist:undefined,dimensions:undefined});
 assert.deepEqual(rows(file,'SELECT original_title FROM film')[0],{original_title:'The Matrix'},'a reviewed identity keeps its title');
 const r1b=await autom({dimensions:{identity:dim('identity')},film:{contractVersion:1},localization:undefined,metadata:undefined,sync:undefined,watchlist:undefined});
 assert.ok(r1b.skipped.some(item=>item.field==='dimension:identity'&&item.reason==='reviewed_kept'));
 assert.equal(rows(file,"SELECT status FROM film_dimension WHERE dimension='identity'")[0].status,'reviewed','an automatic lifecycle row does not replace a reviewed one');
 assert.ok(r1.skipped.some(item=>item.field==='originalTitle'&&item.reason==='reviewed_kept'));
 assert.ok(r1.skipped.some(item=>item.field==='localization'&&item.reason==='reviewed_kept'));
 assert.deepEqual(rows(file,"SELECT status,source,value FROM film_dimension WHERE dimension='localization'"),[{status:'reviewed',source:'dictionary',value:'Матрица (словарь)'}]);
 const r2=await autom({localization:{state:LOC({value:'Другое'})},metadata:undefined,sync:undefined,watchlist:undefined,dimensions:undefined});
 assert.equal(rows(file,"SELECT value FROM film_dimension WHERE dimension='localization'")[0].value,'Матрица (словарь)');
 assert.ok(r2.skipped.some(item=>item.field==='localization'));
 // an owner value is replaced only by the owner
 sqlite(file,"UPDATE film_dimension SET authority='owner',status='reviewed',value='Матрица (владелец)' WHERE dimension='localization'");
 await autom({localization:{state:LOC({status:'reviewed',source:'dictionary',value:'Словарь',provenance:{authority:'dictionary'}})},metadata:undefined,sync:undefined,watchlist:undefined,dimensions:undefined});
 assert.equal(rows(file,"SELECT value FROM film_dimension WHERE dimension='localization'")[0].value,'Матрица (владелец)');
 await autom({localization:{state:LOC({status:'reviewed',source:'owner',value:'Новое владельца',provenance:{authority:'owner'}})},metadata:undefined,sync:undefined,watchlist:undefined,dimensions:undefined});
 assert.equal(rows(file,"SELECT value FROM film_dimension WHERE dimension='localization'")[0].value,'Новое владельца');
 // blanks: title, localization, metadata fields and clocks never blank a stored value
 const before=dump(file,OWNED);
 const blanks=await autom({film:{contractVersion:1,canonicalIdentity:'  ',originalTitle:'',source:'tmdb'},localization:{state:LOC({status:'missing',value:null,source:null,provenance:null})},dimensions:undefined,metadata:{updatedAt:T2,year:null,runtime:'',synopsis:' ',poster:null,url:undefined,genres:[],payload:{}},sync:{metadataAt:null,synopsisFetchedAt:'',peopleNamesVersion:null},watchlist:undefined,updatedAt:T});
 assert.equal(blanks.written,false,'blanks change nothing');
 assert.equal(dump(file,OWNED),before);
 assert.ok(blanks.skipped.some(item=>item.field==='originalTitle'&&item.reason==='blank'));
 assert.ok(blanks.skipped.some(item=>item.field==='localization'&&item.reason==='blank'));
}

// 7. Identity overwrite rules: trusted-source precedence, a trusted tmdb id for canonical_identity, evidence for a change.
if(section('7')){
 const {file,env}=fresh();
 await seed(env,ID,{originalTitle:'Seed'});
 let revision=1;
 const write=async(film,over={})=>{const r=await writeFilmFacts(env,{id:ID,expectedRevision:revision,at:T,requestId:'q'+revision,film:{contractVersion:1,...film},dimensions:{identity:dim('identity')},...over});if(r.written)revision++;return r;};
 const title=()=>rows(file,'SELECT original_title t,canonical_identity c FROM film')[0];
 assert.equal((await write({originalTitle:'Seed',source:'discovery'})).written,true,'the identity row of the lowest source is written');
 assert.equal((await write({originalTitle:'From Epg',source:'epg'})).written,true,'a higher source overwrites');
 assert.equal(title().t,'From Epg');
 const lower=await write({originalTitle:'From Discovery',source:'discovery'});
 assert.equal(title().t,'From Epg');assert.ok(lower.skipped.some(item=>item.reason==='untrusted_source'||item.reason==='lower_precedence'));
 // the stored identity row says epg: a discovery write is lower, and it does not lower the recorded source either
 const lower2=await write({originalTitle:'Lower',source:'discovery'});
 assert.ok(lower2.skipped.some(item=>item.field==='originalTitle'&&item.reason==='lower_precedence'),JSON.stringify(lower2));
 const prov=()=>JSON.parse(rows(file,"SELECT provenance_json p FROM film_dimension WHERE dimension='identity'")[0].p);
 assert.equal(prov().titleSource.source,'epg','the recorded title source is not lowered');
 assert.equal(rows(file,"SELECT source FROM film_dimension WHERE dimension='identity'")[0].source,'discovery','identity.source is not overloaded');
 assert.equal(prov().tmdbId,'603','existing provenance keys survive');
 assert.equal((await write({originalTitle:'From Tmdb',source:'tmdb'})).written,true);
 assert.equal(title().t,'From Tmdb');
 const unknown=await write({originalTitle:'From Nowhere',source:'mystery'});
 assert.ok(unknown.skipped.some(item=>item.reason==='untrusted_source'));assert.equal(title().t,'From Tmdb');
 // canonical_identity: needs the trusted tmdb id, fills when empty, a change needs evidence
 const wrong=await write({canonicalIdentity:'tmdb:1',source:'tmdb'});
 assert.ok(wrong.skipped.some(item=>item.field==='canonicalIdentity'&&item.reason==='needs_trusted_tmdb_id'));assert.equal(title().c,null);
 assert.equal((await write({canonicalIdentity:'tmdb:603',source:'tmdb'})).written,true);assert.equal(title().c,'tmdb:603');
 sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+ID+"','tmdb','604',0,0);UPDATE film_external_id SET trusted=0 WHERE value='603';UPDATE film_external_id SET trusted=1 WHERE value='604'");
 await assert.rejects(write({canonicalIdentity:'tmdb:604',source:'tmdb'}),code('film_person_identity_conflict'));
 assert.equal(title().c,'tmdb:603');
 assert.equal((await write({canonicalIdentity:'tmdb:604',source:'tmdb'},{evidence:{verified:true}})).written,true);assert.equal(title().c,'tmdb:604');
 // a reviewed identity row blocks the title and the identity; only the owner replaces it
 sqlite(file,"UPDATE film_dimension SET status='reviewed',authority='owner' WHERE dimension='identity'");
 const kept=await write({originalTitle:'Auto',source:'tmdb'});
 assert.ok(kept.skipped.some(item=>item.reason==='owner_kept'));assert.equal(title().t,'From Tmdb');
 sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+ID+"','tmdb','605',1,0)");
 const keptId=await write({canonicalIdentity:'tmdb:605',source:'tmdb'},{evidence:{verified:true}});
 assert.ok(keptId.skipped.some(item=>item.field==='canonicalIdentity'&&item.reason==='owner_kept'));assert.equal(title().c,'tmdb:604');
 assert.equal((await write({originalTitle:'By Owner',source:'owner',authority:'owner'})).written,true);assert.equal(title().t,'By Owner');
 // a redirect is refused
 await seed(env,'film:tmdb:700');
 sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:700','"+ID+"','t')");
 await assert.rejects(writeFilmFacts(env,{id:'film:tmdb:700',expectedRevision:1,at:T,requestId:'x',film:{contractVersion:1}}),code('film_person_redirect'));
}

// 7b. Title ranking: every adjacent pair, equal rank, the owner over everything, unknown sources, and the provenance shape.
if(section('7b')){
 assert.deepEqual([...TITLE_SOURCE_ORDER],['owner','dictionary','tmdb','letterboxd','watchlist','epg','discovery']);
 for(let i=0;i<TITLE_SOURCE_ORDER.length-1;i++){
  const hi=TITLE_SOURCE_ORDER[i],lo=TITLE_SOURCE_ORDER[i+1];
  const {file,env}=fresh();
  await seed(env);
  let revision=1;
  const w=async(source,value)=>{const r=await writeFilmFacts(env,{id:ID,expectedRevision:revision,at:T,requestId:'p'+revision,film:{contractVersion:1,originalTitle:value,source,authority:source==='owner'?'owner':undefined},dimensions:{identity:dim('identity',{provenance:{tmdbId:'603',keep:'me'}})}});if(r.written)revision++;return r;};
  const state=()=>({t:rows(file,'SELECT original_title t FROM film')[0].t,p:JSON.parse(rows(file,"SELECT provenance_json p FROM film_dimension WHERE dimension='identity'")[0].p)});
  await w(lo,'lo');assert.equal(state().p.titleSource.source,lo);
  assert.equal((await w(hi,'hi')).written,true,hi+' over '+lo);assert.equal(state().t,'hi');assert.equal(state().p.titleSource.source,hi);
  const refused=await w(lo,'lo2');assert.equal(state().t,'hi',lo+' under '+hi);assert.ok(refused.skipped.some(item=>item.reason==='lower_precedence'));
  assert.equal(state().p.titleSource.source,hi,'a refused title leaves its provenance');
  assert.equal((await w(hi,'hi2')).written,true,'equal rank overwrites');assert.equal(state().t,'hi2');
  assert.deepEqual([state().p.tmdbId,state().p.keep],['603','me'],'other provenance keys survive');
  assert.deepEqual(Object.keys(state().p.titleSource).sort(),['at','source']);
 }
 const {file,env}=fresh();
 await seed(env);
 let revision=1;
 const w=async(film,extra={})=>{const r=await writeFilmFacts(env,{id:ID,expectedRevision:revision,at:T,requestId:'u'+revision,film:{contractVersion:1,...film},...extra});if(r.written)revision++;return r;};
 const t=()=>rows(file,'SELECT original_title t FROM film')[0].t;
 await w({originalTitle:'Fill',source:'mystery'},{dimensions:{identity:dim('identity')}});
 assert.equal(t(),'Fill','an unknown source may fill an empty field');
 assert.equal(JSON.parse(rows(file,"SELECT provenance_json p FROM film_dimension WHERE dimension='identity'")[0].p).titleSource,undefined,'but records no ranked source');
 assert.equal((await w({originalTitle:'Ranked',source:'discovery'})).written,true,'any trusted source replaces an unranked title');
 assert.ok((await w({originalTitle:'Nope',source:'mystery'})).skipped.some(item=>item.reason==='untrusted_source'));
 assert.ok((await w({originalTitle:'Nope',source:null})).skipped.some(item=>item.reason==='untrusted_source'));
 await w({originalTitle:'Owner',source:'owner',authority:'owner'});
 assert.equal(t(),'Owner','the owner wins over every source');
 assert.ok((await w({originalTitle:'Impostor',source:'owner'})).skipped.some(item=>item.reason==='untrusted_source'),'a bare owner name without owner authority is not the owner');
 for(const source of TITLE_SOURCE_ORDER.slice(1))await w({originalTitle:'X'+source,source});
 assert.equal(t(),'Owner','nothing below the owner replaces it');
 // the same title from a higher source upgrades only the provenance; a blank title changes nothing
 const other=fresh();await seed(other.env);
 let rev2=1;
 const w2=async(film,extra={})=>{const r=await writeFilmFacts(other.env,{id:ID,expectedRevision:rev2,at:T,requestId:'v'+rev2,film:{contractVersion:1,...film},dimensions:{identity:dim('identity')},...extra});if(r.written)rev2++;return r;};
 await w2({originalTitle:'Same',source:'discovery'});
 const up=await w2({originalTitle:'Same',source:'tmdb'});
 assert.equal(up.written,true);assert.equal(JSON.parse(rows(other.file,"SELECT provenance_json p FROM film_dimension WHERE dimension='identity'")[0].p).titleSource.source,'tmdb');
 assert.equal((await w2({originalTitle:'Same',source:'epg'})).written,false,'a lower source on the same title changes nothing');
 assert.equal((await w({originalTitle:'  ',source:'owner',authority:'owner'})).written,false);
}

// 8. Effective localization: the sources and the effective row move in one batch, the best source wins, catalog-d1's title SQL stays valid.
if(section('8')){
 const {file,env}=fresh();
 await seed(env,ID,{originalTitle:'The Matrix'});
 const batches=env.DB.calls.batches;
 const r=await writeFilmFacts(env,{id:ID,expectedRevision:1,at:T,requestId:'loc-1',film:{contractVersion:1},localization:{sources:[{source:'wikidata',value:'Матрица (WD)',sourceVersion:'wd:1',observedAt:T},{source:'tmdb',value:'Матрица (TMDB)',sourceVersion:'tmdb:1',observedAt:T}]}});
 assert.equal(env.DB.calls.batches,batches+1,'sources and effective row share one batch');
 assert.deepEqual(r.changes.filter(item=>item!=='film').sort(),['dimension:localization','source:tmdb','source:wikidata']);
 assert.equal(rows(file,"SELECT COUNT(*) c FROM film_localization_source")[0].c,2);
 assert.deepEqual(rows(file,"SELECT status,source,value FROM film_dimension WHERE dimension='localization'"),[{status:'provisional',source:'tmdb',value:'Матрица (TMDB)'}]);
 assert.equal(rows(file,"SELECT coalesce((select value from film_dimension d where d.film_id=f.id and d.dimension='localization' and d.status in ('reviewed','provisional')),f.original_title) t FROM film f")[0].t,'Матрица (TMDB)');
 // a replay and an older observation are no-ops
 assert.equal((await writeFilmFacts(env,{id:ID,expectedRevision:2,at:T,requestId:'loc-1',film:{contractVersion:1},localization:{sources:[{source:'tmdb',value:'Матрица (TMDB)',sourceVersion:'tmdb:1',observedAt:T}]}})).written,false);
 const old=await writeFilmFacts(env,{id:ID,expectedRevision:2,at:T2,requestId:'loc-2',film:{contractVersion:1},localization:{sources:[{source:'tmdb',value:'Старое',sourceVersion:'tmdb:0',observedAt:'2026-01-01T00:00:00.000Z'}]}});
 assert.equal(old.written,false);assert.ok(old.skipped.some(item=>item.reason==='stale'));
 // a reserved source and an inconsistent provenance never reach the table
 for(const bad of [{source:'owner'},{source:'dictionary'},{source:'tmdb',provenance:{authority:'owner'}},{source:'tmdb',value:' '}])await assert.rejects(writeFilmFacts(env,{id:ID,expectedRevision:2,at:T2,requestId:'bad',film:{contractVersion:1},localization:{sources:[{value:'x',sourceVersion:'v',observedAt:T2,...bad}]}}),code('film_person_invalid'));
 assert.equal(rows(file,"SELECT COUNT(*) c FROM film_localization_source")[0].c,2);
}

// 9. Metadata merge, clear, sync set and release, membership set and clear; identity, credits, aliases and ids are untouched.
if(section('9')){
 const {file,env}=fresh();
 await mutatePerson(env,{id:'person:director/1',expectedRevision:0,at:T,person:{roleId:'director/1',contractVersion:1}});
 await seed(env,ID,{aliases:[{kind:'title',value:'Matrix'}],credits:{upsert:[{personId:'person:director/1',role:'director'}]}});
 let revision=1;
 const w=async(over)=>{const r=await writeFilmFacts(env,{id:ID,expectedRevision:revision,at:T,requestId:'m'+revision,film:{contractVersion:1},...over});if(r.written)revision++;return r;};
 const untouched=()=>dump(file,['film_alias','film_person_credit','film_external_id','person','person_alias']);
 const base=untouched(),film0=rows(file,'SELECT canonical_identity,original_title FROM film')[0];
 await w({metadata:META,sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true});
 assert.equal(untouched(),base,'a metadata write touches no id, alias or credit');
 assert.deepEqual(rows(file,'SELECT canonical_identity,original_title FROM film')[0],film0);
 await w({metadata:{updatedAt:T2,runtime:140,synopsis:null,genres:[]}});
 assert.deepEqual(rows(file,'SELECT runtime,synopsis,genres_json,year FROM film_metadata')[0],{runtime:140,synopsis:META.synopsis,genres_json:JSON.stringify(META.genres),year:1999},'a merge keeps what the call leaves blank');
 await w({sync:{metadataAt:T2}});
 assert.deepEqual(rows(file,'SELECT metadata_at,synopsis_fetched_at,people_names_version FROM film_sync_state')[0],{metadata_at:T2,synopsis_fetched_at:T,people_names_version:2});
 // null and missing leave the stored clock; clearing one is explicit
 await w({sync:{metadataAt:T2,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T}});
 const idle=await w({sync:{metadataAt:null,synopsisFetchedAt:undefined,peopleNamesVersion:null,peopleLocalizedAt:''}});
 assert.equal(idle.written,false,'null, missing and blank clocks change nothing');
 assert.deepEqual(rows(file,'SELECT metadata_at,synopsis_fetched_at,people_names_version,people_localized_at FROM film_sync_state')[0],{metadata_at:T2,synopsis_fetched_at:T,people_names_version:2,people_localized_at:T});
 await w({sync:{clear:['synopsisFetchedAt','peopleNamesVersion']}});
 assert.deepEqual(rows(file,'SELECT metadata_at,synopsis_fetched_at,people_names_version,people_localized_at FROM film_sync_state')[0],{metadata_at:T2,synopsis_fetched_at:null,people_names_version:null,people_localized_at:T},'a named clock is cleared, the others stay');
 await assert.rejects(w({sync:{metadataAt:T,clear:['metadataAt']}}),code('film_person_invalid'));
 await assert.rejects(w({sync:{clear:['nope']}}),code('film_person_invalid'));
 await w({sync:null});assert.equal(rows(file,'SELECT COUNT(*) c FROM film_sync_state')[0].c,0);
 await w({metadata:null});assert.equal(rows(file,'SELECT COUNT(*) c FROM film_metadata')[0].c,0);
 assert.equal(rows(file,'SELECT COUNT(*) c FROM watchlist_film')[0].c,1);
 await w({watchlist:false});assert.equal(rows(file,'SELECT COUNT(*) c FROM watchlist_film')[0].c,0);
 assert.equal((await w({watchlist:false,metadata:null,sync:null})).written,false,'clearing what is absent is a no-op');
 assert.equal(untouched(),base);
 await assert.rejects(w({watchlist:'yes'}),code('film_person_invalid'));
 await assert.rejects(w({dimensions:{identity:{...dim('identity'),dimension:'fingerprint'}}}),code('film_person_invalid'));
}

// 10. Equivalence with the projector: the same inputs give the same rows in the projector's tables.
if(section('10')){
 const adapter=file=>{const db=d1Standin(file);return {run:async(text,params=[])=>{await db.prepare(text).bind(...params).run();},get:async(text,params=[])=>db.prepare(text).bind(...params).first(),all:async(text,params=[])=>(await db.prepare(text).bind(...params).all()).results};};
 const projected=fresh('prepared');
 const repo=createCanonicalRepository(adapter(projected.file));
 const film={id:ID,contractVersion:1,canonicalIdentity:'tmdb:603',originalTitle:'The Matrix',externalIds:[{scheme:'tmdb',value:'603',trusted:true,conflicting:false,provenance:null}],aliases:[],localizationConflicts:[],identity:dim('identity'),metadata:dim('metadata',{status:'fresh',source:'tmdb',sourceVersion:null,provenance:null}),localization:LOC()};
 await repo.projectFilm({film,metadata:META,watchlist:true});
 await repo.projectFilmSyncState({filmId:ID,sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T}});
 const canonical=fresh('open');
 await seed(canonical.env);
 await writeFilmFacts(canonical.env,facts());
 assert.equal(dump(canonical.file,OWNED,true),dump(projected.file,OWNED),'identical rows for identical inputs, apart from the named exception identity_provenance_title_source');
 assert.ok(JSON.parse(rows(canonical.file,"SELECT provenance_json p FROM film_dimension WHERE dimension='identity'")[0].p).titleSource,'the named exception is visible');
 assert.deepEqual(P6_DIFFERENTIAL_EXCEPTIONS.filter(item=>item.status==='accepted').map(item=>item.id).sort(),['identity_provenance_title_source','sync_null_clock_keeps_stored']);
 // clearing: the projector's releaseFilm / null sync / null metadata give the rows the canonical clear gives
 await repo.releaseFilm(ID);await repo.projectFilmSyncState({filmId:ID,sync:null});await repo.projectFilm({film,metadata:null,watchlist:null});
 await writeFilmFacts(canonical.env,{...facts({requestId:'clear',expectedRevision:2}),metadata:null,sync:null,watchlist:false});
 assert.equal(dump(canonical.file,OWNED,true),dump(projected.file,OWNED),'identical rows after the clear');
}

// 11. Producers: the planner, dispatch and readback registration; the route stays dormant below open; the module is imported only by the producers module.
if(section('11')){
 const plan=planFilmWrite({...facts(),revisions:{[ID]:1},epgGeneration:'g1'});
 assert.equal(plan.producer,'film_facts');assert.equal(plan.calls[0].fn,'writeFilmFacts');assert.equal(plan.calls[0].input.expectedRevision,1);assert.equal(plan.epgGeneration,'g1');
 assert.equal(planFilmWrite({id:'x'}).skipped[0].reason,'invalid_input');
 assert.equal(planFilmWrite({...facts(),requestId:''}).skipped[0].reason,'invalid_input');
 for(const stage of ['r2','prepared']){
  const {env,file}=fresh(stage);
  const out=await dispatch(env,plan);
  assert.equal(out.executed,false);assert.equal(out.reason,'projector_is_writer');assert.equal(env.DB.calls.batches,0);assert.equal(rows(file,'SELECT COUNT(*) c FROM film')[0].c,0);
  assert.equal((await writerRoute(env)).writer,'projector');
 }
 const {env,file}=fresh('open');
 await seed(env);
 const revisions=await readRevisions(env,[ID]);
 const out=await dispatch(env,planFilmWrite({...facts(),revisions}));
 assert.equal(out.executed,true);assert.equal(out.complete,true);assert.equal(out.results[0].status,'applied');
 assert.equal((await readback(env,{fn:'writeFilmFacts',input:plan.calls[0].input})).outcome,'content_present');
 const lost=await dispatch(env,planFilmWrite({...facts({requestId:'r9',metadata:{...META,runtime:99,updatedAt:T2}}),revisions}));
 assert.equal(lost.results[0].status,'conflict');
 assert.ok(GAPS.some(item=>/film_metadata/.test(item)),'GAPS are not removed by this change');
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('canonical-film-writers'))importers.push(full.replace(/\\/g,'/'));}};
 walk('src');
 assert.deepEqual(importers.sort(),['src/canonical-producer-adapters.js','src/canonical-producers.js'],'only the producers module and the dormant receipt adapter import the film writers');
 for(const f of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(f))assert.ok(!fs.readFileSync(f,'utf8').includes('canonical-film-writers'),f+' does not bundle it');
 const text=fs.readFileSync('src/canonical-film-writers.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\bR2\b|fetch\(|BUCKET/.test(text),'no R2 and no network');
 assert.ok(!/INSERT INTO (film_external_id|film_alias|film_person_credit|person)\b|candidate|fingerprint_payload|prediction_/.test(text),'no identity id, alias, credit, person, fingerprint or prediction write');
 void file;
}

console.log('canonical-film-writers: writes refuse below open and fence by generation and revision; one batch writes identity, metadata, clocks, membership, lifecycle and the effective localization; replays and settled unknown outcomes are no-ops; reviewed and owner values survive; blanks never overwrite; rows equal the projector\'s; the module is dormant');
