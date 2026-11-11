// AIR-374 P6 (offline) / ADR 0099, ADR 0117, ADR 0120: the differential natural-path harness. On the SAME fixture inputs and the sqlite3-CLI D1 stand-in it runs
//  (a) the projector path (src/canonical-repository.js: projectFilm, projectPerson, projectFilmSyncState, releaseFilm) at marker `prepared`, and
//  (b) the canonical writers (writeFilmFacts, recordPersonState, recordLocalizationConflicts, mutateFilm, mutatePerson, mergeFilms) at marker `open`,
// both from one identical starting database, and compares the resulting rows table by table (film, person, film_external_id, person_external_id, film_alias,
// person_alias, film_person_credit, film_dimension, person_dimension, watchlist_film, film_redirect, film_sync_state, film_metadata, localization_conflict;
// canonical_identity and original_title are columns of film). EVERY difference must be classified: a scenario that expects IDENTICAL fails on any difference, and
// a difference is accepted only as a NAMED exception (P6_DIFFERENTIAL_EXCEPTIONS of src/canonical-film-writers.js, or EXTRA_EXCEPTIONS of
// src/canonical-differential-registry.js) that the scenario declares and the exception's own predicate matches. Parity is never reported where an exception applies.
// The registry DIFFERENTIAL_COVERAGE (what handoffReadiness trusts) is checked here against the scenarios that really ran. No Worker, R2, TMDB or production access.
// DIFFERENTIAL_REGISTRY_SOURCE points the test at a mutant copy of the registry; DIFFERENTIAL_INJECT adds a deliberately unclassified difference
// (tests/canonical-differential-mutation.mjs).
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {mutateFilm,mutatePerson,mergeFilms} from '../src/canonical-mutations.js';
import {writeFilmFacts,P6_DIFFERENTIAL_EXCEPTIONS} from '../src/canonical-film-writers.js';
import {recordPersonState,recordLocalizationConflicts} from '../src/canonical-person-state.js';
import {readRevisions,writerRoute} from '../src/canonical-producers.js';
import {PROJECTOR_MARKER_CONDITION} from '../src/film-person-authority.js';
import fs from 'node:fs';
import {adapter,copyOf,diffDatabases,dumpTable,envOf,fresh,opened,root,rows,sqlite,TABLES} from './canonical-differential-helper.mjs';

const registry=await import(process.env.DIFFERENTIAL_REGISTRY_SOURCE?pathToFileURL(path.resolve(process.env.DIFFERENTIAL_REGISTRY_SOURCE)).href:'../src/canonical-differential-registry.js');
const {EXTRA_EXCEPTIONS,DIFFERENTIAL_COVERAGE}=registry;
const started=Date.now();

const T='2026-11-11T10:00:00.000Z',T2='2026-11-11T11:00:00.000Z';
const code=expected=>error=>error.code===expected;
const dim=(dimension,extra={})=>({dimension,status:'resolved',source:'discovery',sourceVersion:'tmdb:603',provenance:{tmdbId:'603'},nextAction:'stop',attempts:0,updatedAt:T,...extra});
const metaDim=(extra={})=>dim('metadata',{status:'fresh',source:'tmdb',sourceVersion:null,provenance:null,...extra});
const loc=(extra={})=>({dimension:'localization',status:'provisional',source:'tmdb',sourceVersion:'tmdb:2026-11',provenance:{query:'title'},value:'Матрица',nextAction:'none',attempts:0,updatedAt:T,...extra});
const META=(extra={})=>({schemaVersion:1,year:1999,runtime:136,synopsis:'A hacker learns the truth.',poster:'/p.jpg',url:'https://example.test/m',genres:['sci-fi','action'],peopleVersion:2,payload:{k:'v'},r2Key:'metadata/603.json',contentSha256:'a'.repeat(64),updatedAt:T,...extra});
const SYNC=(extra={})=>({metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T,...extra});
const ext=(scheme,value,extra={})=>({scheme,value,trusted:true,conflicting:false,provenance:null,...extra});

// One logical Film as an EPG/metadata refresh describes it. Both paths are driven from the same object.
const film=(over={})=>({id:'film:tmdb:603',canonicalIdentity:'tmdb:603',originalTitle:'The Matrix',externalIds:[ext('tmdb','603')],aliases:[{kind:'title',value:'Matrix',provenance:null}],
 identity:dim('identity'),metadata:metaDim(),localization:loc(),body:META(),sync:SYNC(),watchlist:true,credits:[{personId:'person:tmdb:1',role:'director',ordinal:0},{personId:'person:tmdb:2',role:'actor',ordinal:0}],localizationConflicts:[],...over});
const person=(id,over={})=>({id,roleId:'role-'+id.split(':').pop(),contractVersion:1,externalIds:[ext('tmdb',id.split(':').pop())],aliases:[],identity:dim('identity',{sourceVersion:null,provenance:null}),localization:loc({value:'Кто-то',updatedAt:T}),localizationConflicts:[],...over});
const PEOPLE=()=>[person('person:tmdb:1',{roleId:'director'}),person('person:tmdb:2')];

// The projector path for one refresh: Persons first (credits reference them), then the Film, then its sync clock, exactly what the enrichment writer does.
async function projectorApply(file,state){
 const repo=createCanonicalRepository(adapter(file));
 for(const p of state.persons||[])await repo.projectPerson({person:p});
 for(const f of state.films||[]){
  const domain={id:f.id,contractVersion:1,canonicalIdentity:f.canonicalIdentity,originalTitle:f.originalTitle,externalIds:f.externalIds,aliases:f.aliases,localizationConflicts:f.localizationConflicts,identity:f.identity,metadata:f.metadata,localization:f.localization};
  const redirects=f.redirects||[];
  await repo.projectFilm({film:{...domain,redirects},metadata:f.body,credits:f.credits,watchlist:f.watchlist,redirects});
  for(const redirect of redirects)await repo.projectLink({survivor:domain,redirect,releasing:redirects.map(item=>item.from)});
  await repo.projectFilmSyncState({filmId:f.id,sync:f.sync});
 }
}
let requestN=0;
const rid=label=>label+'-'+(requestN++);
// The canonical path for the same refresh: Person ids and aliases (mutatePerson), Person state (recordPersonState), Film ids, aliases and credits (mutateFilm),
// then the Film facts (writeFilmFacts). Every call carries the revision it read, as the producers do.
async function canonicalApply(file,state,at=T){
 const env=envOf(file);
 const revision=async id=>(await readRevisions(env,[id]))[id];
 for(const p of state.persons||[]){
  await mutatePerson(env,{id:p.id,expectedRevision:await revision(p.id),at,person:{roleId:p.roleId,contractVersion:p.contractVersion,externalIds:p.externalIds,aliases:p.aliases}});
  await recordPersonState(env,{id:p.id,expectedRevision:await revision(p.id),at,requestId:rid('person'),person:{identity:p.identity,localization:p.localization,localizationConflicts:p.localizationConflicts.length?p.localizationConflicts:undefined}});
 }
 for(const f of state.films||[]){
  await mutateFilm(env,{id:f.id,expectedRevision:await revision(f.id),at,film:{contractVersion:1,externalIds:f.externalIds,aliases:f.aliases},credits:{upsert:f.credits}});
  await writeFilmFacts(env,{id:f.id,expectedRevision:await revision(f.id),at,requestId:rid('film'),updatedAt:f.localization.updatedAt,film:{contractVersion:1,canonicalIdentity:f.canonicalIdentity,originalTitle:f.originalTitle,source:'tmdb'},dimensions:{identity:f.identity,metadata:f.metadata},localization:{state:f.localization},metadata:f.body,sync:f.sync,watchlist:f.watchlist});
  if(f.localizationConflicts.length)await recordLocalizationConflicts(env,{kind:'film',id:f.id,expectedRevision:await revision(f.id),at,requestId:rid('conflict'),conflicts:f.localizationConflicts});
 }
}

// ---- classification -------------------------------------------------------------------------------------------------------------------------------------------
const titleSource=text=>{try{return JSON.parse(text)?.titleSource!==undefined;}catch{return false;}};
const withoutTitleSource=text=>{try{const value=JSON.parse(text);delete value.titleSource;return Object.keys(value).length?JSON.stringify(value):null;}catch{return text;}};
// Each predicate says whether ONE difference belongs to the named exception. An exception without a predicate here cannot classify anything.
const PREDICATES={
 identity_provenance_title_source:d=>d.table==='film_dimension'&&d.kind==='column'&&d.column==='provenance_json'&&/\|identity$/.test(d.key)&&titleSource(d.canonical)&&withoutTitleSource(d.canonical)===(d.projector??null),
 sync_null_clock_keeps_stored:d=>d.table==='film_sync_state'&&d.kind==='column'&&['metadata_at','synopsis_fetched_at','people_names_version','people_localized_at'].includes(d.column)&&d.projector===null&&d.canonical!==null,
 blank_never_overwrites:d=>{
  const blank=value=>value===null||value===''||value==='[]'||value==='{}';
  if(d.table==='film_metadata'&&d.kind==='column')return blank(d.projector)&&!blank(d.canonical);
  if(d.table==='film'&&d.kind==='column')return ['original_title','canonical_identity'].includes(d.column)&&blank(d.projector)&&!blank(d.canonical);
  if(d.table==='film_dimension'&&d.kind==='column'&&/\|localization$/.test(d.key))return d.projectorRow.value===null&&d.canonicalRow.value!==null;
  return false;
 },
 reviewed_owner_rows_protected:(d,ctx)=>{
  const held=filmId=>rows(ctx.right,"SELECT 1 AS x FROM film_dimension WHERE film_id='"+filmId+"' AND dimension='identity' AND (status='reviewed' OR authority='owner')").length>0;
  if(d.table==='film_dimension'&&d.kind==='column'&&/\|identity$/.test(d.key))return d.canonicalRow.status==='reviewed'||d.canonicalRow.authority==='owner';
  if(d.table==='film'&&d.kind==='column'&&['original_title','canonical_identity'].includes(d.column))return held(d.key);
  return false;
 },
 redirected_film_refused:d=>d.table==='(outcome)'&&d.kind==='outcome'&&/film_person_redirect/.test(String(d.canonical)),
 credits_not_pruned_by_the_planner:d=>d.table==='film_person_credit'&&d.kind==='only_canonical',
 external_ids_not_pruned_by_the_planner:d=>d.table==='film_external_id'&&d.kind==='only_canonical',
 updated_at_is_write_time:d=>['person','film','watchlist_film'].includes(d.table)&&d.kind==='column'&&d.column==='updated_at'&&String(d.canonical)>String(d.projector),
 held_localization_not_recorded:d=>['film_alias','person_alias','localization_conflict'].includes(d.table)&&d.kind==='only_projector',
 noop_write_keeps_updated_at:d=>['film_metadata','watchlist_film'].includes(d.table)&&d.kind==='column'&&d.column==='updated_at'&&String(d.projector)>String(d.canonical),
 canonical_identity_requires_trusted_tmdb:d=>d.table==='film'&&d.kind==='column'&&d.column==='canonical_identity'&&d.projector!==null&&d.canonical===null,
 credit_ordinals_kept:d=>d.table==='film_person_credit'&&d.kind==='column'&&d.column==='ordinal',
};
const KNOWN=new Map([...P6_DIFFERENTIAL_EXCEPTIONS,...EXTRA_EXCEPTIONS].map(item=>[item.id,item]));
assert.equal(KNOWN.size,P6_DIFFERENTIAL_EXCEPTIONS.length+EXTRA_EXCEPTIONS.length,'exception ids are unique across both lists');
for(const id of KNOWN.keys())assert.equal(typeof PREDICATES[id],'function',id+': a named exception has a predicate in the harness');
for(const id of Object.keys(PREDICATES))assert.ok(KNOWN.has(id),id+': a predicate belongs to a registered exception');

const results=[];
// A scenario: both paths start from one database (`setup` runs the projector path at prepared; the open copy is a copy of it), `projector` and `canonical` apply the
// step, and the diff must be IDENTICAL or fully classified. `accepts` lists the exceptions the scenario may meet; `expects` the ones it must meet (never over-broad).
async function scenario(id,{setup,projector,canonical,accepts=[],expects=accepts,outcome=false,check}){
 const base=fresh();
 if(setup)await setup(base);
 const left=copyOf(base,'left'),right=opened(base);
 const seen={projector:null,canonical:null};
 for(const [side,file,run] of [['projector',left,projector],['canonical',right,canonical]]){
  try{await run(file);seen[side]='ok';}catch(error){seen[side]=error.code||error.message;}
 }
 if(process.env.DIFFERENTIAL_DEBUG)console.log(id,JSON.stringify(seen));
 let diffs=diffDatabases(left,right);
 if(process.env.DIFFERENTIAL_INJECT===id)diffs.push({table:'film_metadata',key:'film:injected',kind:'only_canonical',row:{injected:true}});
 const klass=value=>value==='ok'?'ok':'refused';
 if(outcome&&klass(seen.projector)!==klass(seen.canonical))diffs.push({table:'(outcome)',key:id,kind:'outcome',projector:seen.projector,canonical:seen.canonical});
 else if(!outcome)assert.equal(seen.canonical,'ok',id+': the canonical path completed ('+seen.canonical+')');
 const unclassified=[],named=new Map();
 for(const diff of diffs){
  const matched=accepts.find(name=>PREDICATES[name](diff,{left,right}));
  if(!matched){unclassified.push(diff);continue;}
  named.set(matched,(named.get(matched)||0)+1);
 }
 if(unclassified.length)assert.fail(id+': UNCLASSIFIED difference(s) between the projector path and the canonical writers: '+JSON.stringify(unclassified.slice(0,process.env.DIFFERENTIAL_DEBUG?200:3).map(d=>({table:d.table,key:d.key,kind:d.kind,column:d.column,projector:d.projector,canonical:d.canonical,row:d.row})))+' (of '+unclassified.length+')');
 for(const name of expects)assert.ok(named.has(name),id+': the declared exception '+name+' was not met, so it must not be listed');
 if(check)await check({left,right,seen,diffs});
 const nonEmpty=Object.keys(TABLES).filter(table=>rows(left,'SELECT COUNT(*) c FROM '+table)[0].c>0||rows(right,'SELECT COUNT(*) c FROM '+table)[0].c>0);
 results.push({id,status:named.size?'EXCEPTIONS':'IDENTICAL',exceptions:[...named.keys()],differences:diffs.length,seen,nonEmpty});
 return {left,right,seen};
}
const fs_copy=(from,to)=>fs.copyFileSync(from,to);
const both=(state)=>({projector:file=>projectorApply(file,state),canonical:file=>canonicalApply(file,state)});
const seedProjector=state=>file=>projectorApply(file,state);

// ---- scenarios ------------------------------------------------------------------------------------------------------------------------------------------------
// 1. A first write of a Film, its Persons, ids, aliases, credits, lifecycle, effective localization, metadata, clocks and membership: same identities, credits, aliases.
await scenario('first_write',{...both({persons:PEOPLE(),films:[film()]}),accepts:['identity_provenance_title_source'],check:({left})=>{assert.ok(rows(left,'SELECT COUNT(*) c FROM film_person_credit')[0].c===2);}});

// 2. A normal refresh: the stored state came from the projector; the next refresh changes metadata, clocks and the localization value but not ids, aliases or credits.
{
 const first={persons:PEOPLE(),films:[film()]};
 const next={persons:PEOPLE(),films:[film({body:META({runtime:140,updatedAt:T2}),sync:SYNC({metadataAt:T2}),localization:loc({value:'Матрица (обновлено)',updatedAt:T2}),identity:dim('identity',{updatedAt:T2}),metadata:metaDim({updatedAt:T2})})]};
 await scenario('normal_refresh',{setup:seedProjector(first),projector:file=>projectorApply(file,next),canonical:file=>canonicalApply(file,next,T2),accepts:['identity_provenance_title_source','updated_at_is_write_time'],
  check:({left,right})=>{for(const table of ['film_external_id','film_alias','film_person_credit','film_redirect'])assert.deepEqual(dumpTable(left,table),dumpTable(right,table),table+' is identical after a normal refresh');assert.equal(rows(left,'SELECT runtime FROM film_metadata')[0].runtime,140);}});
}

// 3. A rated-only Film (verified admission and retention, no membership, no metadata) survives a refresh of another Film on both paths, row for row.
{
 const rated="INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:900',1,NULL,NULL,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:900','tmdb','900',1,0,NULL);"
  +"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:900','900','abcd','"+'b'.repeat(64)+"','Rated',2001,'letterboxd/admissions/verified-films.json','tmdb_900','"+T+"','seed','"+T+"');"
  +"INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:tmdb:900','watchlist_fact',0,'{}','seed','"+T+"','"+T+"');";
 await scenario('rated_only_film_survives',{setup:async file=>{sqlite(file,rated);await projectorApply(file,{persons:PEOPLE(),films:[film()]});},...both({persons:PEOPLE(),films:[film({body:META({runtime:141,updatedAt:T2}),sync:SYNC({metadataAt:T2}),localization:loc({updatedAt:T2})})]}),accepts:['identity_provenance_title_source'],
  check:({left,right})=>{for(const file of [left,right]){assert.equal(rows(file,"SELECT COUNT(*) c FROM film WHERE id='film:tmdb:900'")[0].c,1,'the rated-only Film row survives');assert.equal(rows(file,'SELECT COUNT(*) c FROM film_rated_admission')[0].c+rows(file,'SELECT COUNT(*) c FROM film_retention')[0].c,2,'its admission and retention rows survive');assert.equal(rows(file,"SELECT COUNT(*) c FROM watchlist_film WHERE film_id='film:tmdb:900'")[0].c,0);}}});
}

// 4. A departed watchlist member survives: the membership is cleared, the Film row, its ids, credits, metadata, retention and admission stay.
{
 const kept="INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:tmdb:603','watchlist_fact',1,'{}','seed','"+T+"','"+T+"');";
 await scenario('departed_member_survives',{setup:async file=>{await projectorApply(file,{persons:PEOPLE(),films:[film()]});sqlite(file,kept);},
  projector:async file=>{const repo=createCanonicalRepository(adapter(file));await repo.releaseFilm('film:tmdb:603');},
  canonical:async file=>{const env=envOf(file);const revisions=await readRevisions(env,['film:tmdb:603']);await writeFilmFacts(env,{id:'film:tmdb:603',expectedRevision:revisions['film:tmdb:603'],at:T2,requestId:rid('depart'),film:{contractVersion:1},watchlist:false});},
  accepts:['updated_at_is_write_time'],
  check:({left,right})=>{for(const file of [left,right]){assert.equal(rows(file,'SELECT COUNT(*) c FROM watchlist_film')[0].c,0,'membership cleared');for(const table of ['film','film_external_id','film_person_credit','film_metadata','film_dimension','film_retention'])assert.ok(rows(file,'SELECT COUNT(*) c FROM '+table)[0].c>0,table+' survives the departure');}}});
}

// 5. An owner-reviewed Film localization survives (a) a refresh and (b) an automatic write; the held value is recorded as alias and conflict where the projector does.
{
 const owner=loc({status:'reviewed',source:'owner',sourceVersion:'owner',provenance:{authority:'owner'},value:'Матрица (владелец)',updatedAt:T});
 const first={persons:PEOPLE(),films:[film({localization:owner})]};
 const refresh={persons:PEOPLE(),films:[film({localization:loc({value:'Автоматическое',updatedAt:T2})})]};
 const cases=await scenario('owner_localization_survives_refresh',{setup:seedProjector(first),projector:file=>projectorApply(file,refresh),canonical:file=>canonicalApply(file,refresh,T2),accepts:['identity_provenance_title_source','updated_at_is_write_time','held_localization_not_recorded'],expects:['updated_at_is_write_time','held_localization_not_recorded'],
  check:({left,right})=>{for(const file of [left,right]){const row=rows(file,"SELECT value,status,authority FROM film_dimension WHERE dimension='localization'")[0];assert.deepEqual(row,{value:'Матрица (владелец)',status:'reviewed',authority:'owner'},'the owner value survives');}}});
 void cases;
}

// 6. Person localization: an owner-reviewed Person name survives a refresh on both paths.
{
 const owner=loc({status:'reviewed',source:'owner',sourceVersion:'owner',provenance:{authority:'owner'},value:'Имя владельца',updatedAt:T});
 const first={persons:[person('person:tmdb:1',{roleId:'director',localization:owner}),person('person:tmdb:2')],films:[]};
 const refresh={persons:[person('person:tmdb:1',{roleId:'director',localization:loc({value:'Авто',updatedAt:T2})}),person('person:tmdb:2')],films:[]};
 await scenario('owner_person_name_survives_refresh',{setup:seedProjector(first),projector:file=>projectorApply(file,refresh),canonical:file=>canonicalApply(file,refresh,T2),accepts:['updated_at_is_write_time','held_localization_not_recorded'],expects:[],
  check:({left,right})=>{for(const file of [left,right])assert.equal(rows(file,"SELECT value FROM person_dimension WHERE person_id='person:tmdb:1' AND dimension='localization'")[0].value,'Имя владельца');}});
}

// 7. Standalone localization conflicts of one Film: the projector writes them with the Film, the canonical writer on its own; the same rows.
{
 const conflicts=[{value:'Другое',source:'tmdb',provenance:{query:'x'},reason:'automatic_differs',at:T2}];
 await scenario('localization_conflict_rows',{setup:seedProjector({persons:PEOPLE(),films:[film()]}),projector:file=>projectorApply(file,{persons:PEOPLE(),films:[film({localizationConflicts:conflicts})]}),canonical:async file=>{const env=envOf(file);const rev=(await readRevisions(env,['film:tmdb:603']))['film:tmdb:603'];await recordLocalizationConflicts(env,{kind:'film',id:'film:tmdb:603',expectedRevision:rev,at:T2,requestId:rid('lc'),conflicts});},
  check:({left,right})=>{assert.equal(rows(left,'SELECT COUNT(*) c FROM localization_conflict')[0].c,1);assert.deepEqual(dumpTable(left,'localization_conflict'),dumpTable(right,'localization_conflict'));}});
}

// 8. Trusted TMDB identity checks: a second Film asking for the same trusted TMDB id is refused on both paths; an untrusted claim is accepted on both; rows stay equal.
{
 const other=film({id:'film:tmdb:700',canonicalIdentity:'tmdb:700',externalIds:[ext('tmdb','603')],credits:[],aliases:[]});
 await scenario('trusted_tmdb_collision_refused',{setup:seedProjector({persons:PEOPLE(),films:[film()]}),projector:file=>projectorApply(file,{persons:[],films:[other]}),canonical:file=>canonicalApply(file,{persons:[],films:[other]}),outcome:true,accepts:[],
  check:({left,right,seen})=>{assert.notEqual(seen.projector,'ok');assert.notEqual(seen.canonical,'ok');assert.equal(rows(left,"SELECT COUNT(*) c FROM film WHERE id='film:tmdb:700'")[0].c,0);assert.equal(rows(right,"SELECT COUNT(*) c FROM film WHERE id='film:tmdb:700'")[0].c,0);assert.equal(rows(right,'SELECT COUNT(*) c FROM film_external_id')[0].c,rows(left,'SELECT COUNT(*) c FROM film_external_id')[0].c);}});
 const untrusted=film({id:'film:tmdb:701',canonicalIdentity:undefined,externalIds:[ext('tmdb','603',{trusted:false}),ext('imdb','tt1',{trusted:true})],credits:[],aliases:[]});
 await scenario('untrusted_claim_accepted',{setup:seedProjector({persons:PEOPLE(),films:[film()]}),projector:file=>projectorApply(file,{persons:[],films:[untrusted]}),canonical:file=>canonicalApply(file,{persons:[],films:[untrusted]}),accepts:['identity_provenance_title_source']});
}

// 9. Redirects: a Film that replaces a retired one (the retired Film holds the trusted TMDB id the survivor carries). The projector writes the survivor with the link; the
// canonical path creates the survivor shell, merges (mergeFilms) and then writes the survivor's facts. Same ids, aliases, credits and redirect row.
const RETIRED='film:legacy:604',SURVIVOR='film:tmdb:603';
const retired=film({id:RETIRED,canonicalIdentity:'tmdb:603',externalIds:[ext('tmdb','603')],aliases:[{kind:'title',value:'Matrix Alt',provenance:null}],credits:[{personId:'person:tmdb:1',role:'director',ordinal:0}],watchlist:false,sync:null,body:null});
const survivor=film({id:SURVIVOR,credits:[{personId:'person:tmdb:1',role:'director',ordinal:0},{personId:'person:tmdb:2',role:'actor',ordinal:0}]});
const merged=await scenario('redirect_merge_retired_into_survivor',{setup:seedProjector({persons:PEOPLE(),films:[retired]}),
 projector:file=>projectorApply(file,{persons:[],films:[{...survivor,redirects:[{from:RETIRED,to:SURVIVOR,at:T2}]}]}),
 canonical:async file=>{
  const env=envOf(file);
  await mutateFilm(env,{id:SURVIVOR,expectedRevision:0,at:T2,film:{contractVersion:1}});
  const revisions=await readRevisions(env,[RETIRED,SURVIVOR]);
  await mergeFilms(env,{from:RETIRED,to:SURVIVOR,expected:{from:revisions[RETIRED],to:revisions[SURVIVOR]},at:T2,evidence:{verified:true}});
  await canonicalApply(file,{persons:[],films:[survivor]},T2);
 },
 accepts:['identity_provenance_title_source','updated_at_is_write_time','credit_ordinals_kept'],expects:[],
 check:({left,right})=>{for(const file of [left,right]){assert.equal(rows(file,"SELECT to_film_id t FROM film_redirect WHERE from_id='"+RETIRED+"'")[0].t,SURVIVOR);assert.equal(rows(file,"SELECT COUNT(*) c FROM film WHERE id='"+RETIRED+"'")[0].c,0,'the retired Film row is gone');assert.ok(rows(file,"SELECT COUNT(*) c FROM film_alias WHERE film_id='"+SURVIVOR+"' AND value='Matrix Alt'")[0].c===1,'its alias moved');}}});

// 10. Redirect refusal: a redirected id is refused by both paths on a refresh; clearing its membership is refused by the canonical writer and silently skipped by the projector
// (the named exception redirected_film_refused). Both start from the merged database of scenario 9.
{
 const redirectedBase=merged.left;
 const refresh={persons:[],films:[film({id:RETIRED})]};
 await scenario('redirect_refresh_refused',{setup:file=>{fs_copy(redirectedBase,file);},projector:file=>projectorApply(file,refresh),canonical:file=>canonicalApply(file,refresh),outcome:true,
  check:({seen})=>{assert.notEqual(seen.projector,'ok');assert.equal(seen.canonical,'film_person_redirect');}});
 await scenario('redirect_release_skipped_vs_refused',{setup:file=>{fs_copy(redirectedBase,file);},
  projector:async file=>{await createCanonicalRepository(adapter(file)).releaseFilm(RETIRED);},
  canonical:async file=>{const env=envOf(file);await writeFilmFacts(env,{id:RETIRED,expectedRevision:0,at:T2,requestId:rid('rel'),film:{contractVersion:1},watchlist:false});},
  outcome:true,accepts:['redirected_film_refused'],check:({seen})=>{assert.equal(seen.projector,'ok');assert.equal(seen.canonical,'film_person_redirect');}});
}

// 11. Departed identity data: the source drops an id and a credit. The projector rewrites the whole set; the canonical planner (planEpgIdentity) only upserts. The stale
// credit and id remain until an explicit removal: reported as the named exceptions, never as parity.
{
 const first={persons:PEOPLE(),films:[film({externalIds:[ext('tmdb','603'),ext('imdb','tt0133093')]})]};
 const next={persons:PEOPLE(),films:[film({externalIds:[ext('tmdb','603')],credits:[{personId:'person:tmdb:1',role:'director',ordinal:0}]})]};
 await scenario('source_drops_ids_and_credits',{setup:seedProjector(first),projector:file=>projectorApply(file,next),canonical:file=>canonicalApply(file,next,T2),accepts:['identity_provenance_title_source','updated_at_is_write_time','credits_not_pruned_by_the_planner','external_ids_not_pruned_by_the_planner'],expects:['credits_not_pruned_by_the_planner','external_ids_not_pruned_by_the_planner']});
}

// 13. A source clock that is missing in this refresh (null): the projector writes null, the canonical writer keeps the stored clock (clearing needs sync.clear).
{
 const first={persons:PEOPLE(),films:[film()]};
 const next={persons:PEOPLE(),films:[film({sync:SYNC({metadataAt:T2,synopsisFetchedAt:null,peopleLocalizedAt:null,peopleNamesVersion:null})})]};
 await scenario('sync_clock_missing_in_source',{setup:seedProjector(first),projector:file=>projectorApply(file,next),canonical:file=>canonicalApply(file,next,T2),accepts:['identity_provenance_title_source','updated_at_is_write_time','sync_null_clock_keeps_stored'],expects:['sync_null_clock_keeps_stored'],
  check:({left,right})=>{assert.equal(rows(left,'SELECT synopsis_fetched_at s FROM film_sync_state')[0].s,null);assert.equal(rows(right,'SELECT synopsis_fetched_at s FROM film_sync_state')[0].s,T);}});
}

// 14. Blank incoming values (no synopsis, poster, genres, localization value, original title): the projector overwrites, the canonical writer keeps what is stored.
{
 const first={persons:PEOPLE(),films:[film()]};
 const next={persons:PEOPLE(),films:[film({originalTitle:null,body:META({synopsis:null,poster:null,genres:[],payload:{},updatedAt:T2}),localization:loc({value:null,updatedAt:T2})})]};
 await scenario('blank_incoming_values',{setup:seedProjector(first),projector:file=>projectorApply(file,next),canonical:file=>canonicalApply(file,next,T2),accepts:['identity_provenance_title_source','updated_at_is_write_time','blank_never_overwrites','noop_write_keeps_updated_at'],expects:['blank_never_overwrites','noop_write_keeps_updated_at'],
  check:({left,right})=>{assert.equal(rows(left,'SELECT synopsis s FROM film_metadata')[0].s,null);assert.equal(rows(right,'SELECT synopsis s FROM film_metadata')[0].s,'A hacker learns the truth.');assert.equal(rows(right,'SELECT original_title t FROM film')[0].t,'The Matrix');}});
}

// 15. A reviewed (owner) identity row and title are never replaced by an automatic refresh on the canonical path; the projector guards only the localization.
{
 const owner=dim('identity',{status:'reviewed',source:'owner',sourceVersion:'owner',provenance:{authority:'owner'}});
 const first={persons:PEOPLE(),films:[film({identity:owner,originalTitle:'Owner Title'})]};
 const next={persons:PEOPLE(),films:[film({originalTitle:'Automatic Title',identity:dim('identity',{updatedAt:T2})})]};
 await scenario('reviewed_identity_protected',{setup:seedProjector(first),projector:file=>projectorApply(file,next),canonical:file=>canonicalApply(file,next,T2),accepts:['identity_provenance_title_source','updated_at_is_write_time','reviewed_owner_rows_protected'],expects:['reviewed_owner_rows_protected'],
  check:({left,right})=>{assert.equal(rows(left,'SELECT original_title t FROM film')[0].t,'Automatic Title');assert.equal(rows(right,'SELECT original_title t FROM film')[0].t,'Owner Title');assert.equal(rows(right,"SELECT status s FROM film_dimension WHERE dimension='identity'")[0].s,'reviewed');}});
}

// 16. The source reorders the cast: the projector renumbers the ordinals, the canonical writers keep the existing ones (a credit that exists is kept as it is).
{
 const people=()=>[...PEOPLE(),person('person:tmdb:3')];
 const first={persons:people(),films:[film({credits:[{personId:'person:tmdb:2',role:'actor',ordinal:0},{personId:'person:tmdb:3',role:'actor',ordinal:1}]})]};
 const next={persons:people(),films:[film({credits:[{personId:'person:tmdb:3',role:'actor',ordinal:0},{personId:'person:tmdb:2',role:'actor',ordinal:1}]})]};
 await scenario('cast_reordered',{setup:seedProjector(first),projector:file=>projectorApply(file,next),canonical:file=>canonicalApply(file,next,T2),accepts:['identity_provenance_title_source','updated_at_is_write_time','credit_ordinals_kept'],expects:['credit_ordinals_kept']});
}

// 17. Trusted TMDB identity: a canonical identity claimed over an UNTRUSTED TMDB id. The canonical writer skips it (needs a trusted id); the projector repository writes it.
{
 const claim=film({id:'film:tmdb:810',canonicalIdentity:'tmdb:810',externalIds:[ext('tmdb','810',{trusted:false})],credits:[],aliases:[]});
 await scenario('canonical_identity_needs_trusted_tmdb',{projector:file=>projectorApply(file,{persons:[],films:[claim]}),canonical:file=>canonicalApply(file,{persons:[],films:[claim]}),accepts:['identity_provenance_title_source','canonical_identity_requires_trusted_tmdb'],expects:['canonical_identity_requires_trusted_tmdb'],
  check:({left,right})=>{assert.equal(rows(left,'SELECT canonical_identity c FROM film')[0].c,'tmdb:810');assert.equal(rows(right,'SELECT canonical_identity c FROM film')[0].c,null);}});
}

// 12. Fail closed: every canonical writer refuses before any row changes at r2, prepared, held, legacy and an unreadable marker, and writes at open; the projector's marker
// condition holds only at prepared/r2 with its own generation, so the two writers never both pass.
{
 const states={r2:file=>sqlite(file,"DROP TRIGGER film_person_authority_transition;UPDATE film_person_authority SET mode='r2',generation=0 WHERE id=1"),prepared:()=>{},held:file=>sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1"),
  legacy:file=>sqlite(file,'DROP TRIGGER schema_contract_no_downgrade;UPDATE schema_contract SET version=12 WHERE id=1'),unknown:file=>sqlite(file,'DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority')};
 const calls={
  writeFilmFacts:env=>writeFilmFacts(env,{id:SURVIVOR,expectedRevision:0,at:T,requestId:'f',film:{contractVersion:1,originalTitle:'X',source:'tmdb'},watchlist:true}),
  mutateFilm:env=>mutateFilm(env,{id:SURVIVOR,expectedRevision:0,at:T,film:{contractVersion:1}}),
  mutatePerson:env=>mutatePerson(env,{id:'person:tmdb:1',expectedRevision:0,at:T,person:{roleId:'actor',contractVersion:1}}),
  recordPersonState:env=>recordPersonState(env,{id:'person:tmdb:1',expectedRevision:0,at:T,requestId:'p',person:{identity:dim('identity',{sourceVersion:null,provenance:null})}}),
  recordLocalizationConflicts:env=>recordLocalizationConflicts(env,{kind:'film',id:SURVIVOR,expectedRevision:0,at:T,requestId:'c',conflicts:[{value:'v',source:'tmdb',provenance:null,reason:'automatic_differs',at:T}]}),
  mergeFilms:env=>mergeFilms(env,{from:'film:tmdb:1',to:'film:tmdb:2',expected:{from:0,to:0},at:T}),
 };
 for(const [state,move] of Object.entries(states)){
  const file=fresh();move(file);
  const before=JSON.stringify(Object.keys(TABLES).map(table=>dumpTable(file,table)));
  const env=envOf(file);
  for(const [name,call] of Object.entries(calls))await assert.rejects(()=>call(env),error=>/^film_person_/.test(String(error.code)),name+' refuses at '+state);
  assert.equal(JSON.stringify(Object.keys(TABLES).map(table=>dumpTable(file,table))),before,state+': no row changed');
  if(state==='held'||state==='unknown')await assert.rejects(()=>writerRoute(env),error=>/^film_person_/.test(String(error.code)),state+': no writer is named');
  else assert.equal((await writerRoute(env)).writer,'projector',state+': the projector is the only writer');
 }
 const prepared=fresh(),open=opened(prepared);
 const holds=(file,mode,generation)=>rows(file,'SELECT '+PROJECTOR_MARKER_CONDITION.replace('?',"'"+mode+"'").replace('?',String(generation))+' AS ok')[0].ok;
 assert.equal(holds(prepared,'prepared',1),1,'the projector fence passes at prepared');
 assert.equal(holds(prepared,'prepared',0),0,'a stale generation fails the projector fence');
 assert.equal(holds(open,'prepared',1),0,'the projector fence fails at open');
 assert.equal((await writerRoute(envOf(open))).writer,'canonical','canonical is the only writer at open');
 results.push({id:'fail_closed_markers',status:'IDENTICAL',exceptions:[],differences:0,seen:{projector:'prepared only',canonical:'open only'},nonEmpty:[]});
}

// ---- coverage and summary ---------------------------------------------------------------------------------------------------------------------------------------
const byId=new Map(results.map(item=>[item.id,item]));
const used=new Set(results.flatMap(item=>item.exceptions));
for(const id of KNOWN.keys())if(!used.has(id))assert.fail('the exception '+id+' is registered but no scenario meets it: an exception nothing exercises is an unproven claim');
const {GAPS}=await import('../src/canonical-producers.js');
assert.deepEqual(DIFFERENTIAL_COVERAGE.map(item=>item.gap),[...GAPS],'the coverage registry names exactly the former producer gaps, in order');
for(const item of DIFFERENTIAL_COVERAGE){
 assert.ok(item.scenarios.length&&item.tables.length&&item.writers.length,item.gap+': scenarios, tables and writers are named');
 for(const table of item.tables)assert.ok(table in TABLES,item.gap+': '+table+' is a compared table');
 for(const scenarioId of item.scenarios){
  const ran=byId.get(scenarioId);
  assert.ok(ran&&['IDENTICAL','EXCEPTIONS'].includes(ran.status),item.gap+': scenario '+scenarioId+' ran and every difference is classified');
 }
 for(const table of item.tables)assert.ok(item.scenarios.some(scenarioId=>byId.get(scenarioId).nonEmpty.includes(table)),item.gap+': '+table+' holds rows in a covering scenario (the comparison is not vacuous)');
}
const lines=[...results.map(item=>'  '+item.status.padEnd(10)+' '+item.id+(item.exceptions.length?'  ['+item.exceptions.join(', ')+']':'')),'  named exceptions met: '+[...used].sort().join(', '),'  draft (owner acceptance pending): '+[...KNOWN.values()].filter(item=>item.status!=='accepted').map(item=>item.id).sort().join(', ')];
console.log('canonical-differential: '+results.length+' scenarios, '+results.filter(item=>item.status==='IDENTICAL').length+' IDENTICAL, '+results.filter(item=>item.status==='EXCEPTIONS').length+' with named exceptions, 0 unclassified; projector path vs canonical writers compared on '+Object.keys(TABLES).length+' tables; coverage registry verified ('+(Date.now()-started)+' ms)\n'+lines.join('\n'));
