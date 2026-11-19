// AIR-541 (ADR 0177): a caught storage error is a TEMPORARY outage only by its own cause. The same classifier is kept in four modules; they must agree, and a structural
// SQL error (a missing table or column, a syntax or constraint error) must never be classed as temporary even when it arises inside a wrapped SELECT.
import assert from 'node:assert/strict';
import * as PublishedEpg from '../src/published-epg.js';
import * as FilmPerson from '../src/film-person-authority.js';
import * as MirrorRead from '../src/mirror-read.js';
import fs from 'node:fs';

const classifiers={published:PublishedEpg.transientStorageCause,filmPerson:FilmPerson.transientStorageCause};
for(const [file,name] of [['src/discovery-authority.js','discovery'],['src/owner-review-d1.js','ownerReview']]){
 const source=fs.readFileSync(file,'utf8');
 const match=/const STRUCTURAL_STORAGE_ERROR=(\/.*\/i);\nconst TRANSIENT_STORAGE_ERROR=(\/.*\/i);/.exec(source);
 assert.ok(match,file+' carries the classifier');
 const own=fs.readFileSync('src/film-person-authority.js','utf8');
 const reference=/const STRUCTURAL_STORAGE_ERROR=(\/.*\/i);\nconst TRANSIENT_STORAGE_ERROR=(\/.*\/i);/.exec(own);
 assert.equal(match[1],reference[1],file+' structural pattern equals the reference');
 assert.equal(match[2],reference[2],file+' transient pattern equals the reference');
}
const TEMPORARY=['D1 DB is overloaded','D1_ERROR: Network connection lost','D1 DB storage operation exceeded timeout which caused object to be reset','Too many requests, try again later','The operation timed out','D1_ERROR: SQLITE_BUSY: database is locked','Durable Object reset because its code was updated.','internal error; reference = abc'];
const STRUCTURAL=['D1_ERROR: no such table: published_epg_document: SQLITE_ERROR','D1_ERROR: no such column: mirror_etag at offset 7: SQLITE_ERROR','D1_ERROR: near "FORM": syntax error at offset 9: SQLITE_ERROR','UNIQUE constraint failed: x.y','CHECK constraint failed: published_epg_fence','FOREIGN KEY constraint failed','D1_ERROR: database disk image is malformed: SQLITE_CORRUPT','not authorized','something unrecognised','',undefined];
for(const [name,classify] of Object.entries(classifiers)){
 for(const text of TEMPORARY)assert.equal(classify(new Error(text)),true,name+' temporary: '+text);
 for(const text of STRUCTURAL)assert.equal(classify(text===undefined?undefined:new Error(text)),false,name+' structural: '+text);
 // A structural word beats a transient one in the same text: a missing table reported with a timeout phrase is still structural.
 assert.equal(classify(new Error('no such table: x (timeout while reading)')),false,name+' structural wins');
}

// failed() marks `temporary` from the cause only: a code alone, a structural cause or no cause is never temporary.
{
 const failed=FilmPerson.failed;
 assert.equal(failed('film_person_unavailable').temporary,undefined,'no cause is not temporary');
 assert.equal(failed('film_person_unavailable',new Error('no such table: x')).temporary,undefined,'structural cause is not temporary');
 assert.equal(failed('film_person_unavailable',new Error('D1 DB is overloaded')).temporary,true,'a transport cause is temporary');
}

// The published-epg readAuthority throws a marked error at each stage: a transient binding failure after the marker read is temporary, a wrong marker or a missing table is not.
const binding=(handler)=>({prepare(sql){return {bind(){return {async first(){return handler(sql,'first');},async all(){return handler(sql,'all');}};}};}});
const healthy=(sql,kind)=>{
 if(/sqlite_master/.test(sql))return {results:['published_epg_authority','published_epg_cas','published_epg_generation','published_epg_document','published_epg_member','published_epg_show','published_epg_stage','published_epg_stage_chunk','published_epg_stage_row'].map(name=>({name}))};
 if(/schema_contract/.test(sql))return {version:30};
 return {mode:'d1',cutover:'open',programmeRunId:'r1',generation:1,mirrorProgrammeRunId:null,mirrorEtag:null,watchlistGeneration:1,mirrorWatchlistEtag:null};
};
const run=async handler=>{try{await PublishedEpg.readAuthority({DB:binding(handler)});return null;}catch(error){return error;}};
{
 const marker=await run((sql,kind)=>{ if(/published_epg_authority/.test(sql)&&!/sqlite_master/.test(sql))throw new Error('D1 DB is overloaded'); const out=healthy(sql,kind); return kind==='all'?out:out; });
 assert.equal(marker?.code,'published_epg_unavailable');assert.equal(marker?.temporary,true,'the marker SELECT failing transiently is temporary');
 const noTable=await run((sql,kind)=>{ if(/schema_contract/.test(sql))throw new Error('D1_ERROR: no such table: schema_contract: SQLITE_ERROR'); return healthy(sql,kind); });
 assert.equal(noTable?.code,'published_epg_unavailable');assert.notEqual(noTable?.temporary,true,'a missing table is structural');
 const wrongMode=await run((sql,kind)=>{ const out=healthy(sql,kind); if(/published_epg_authority/.test(sql)&&!/sqlite_master/.test(sql))return {...out,mode:'r2'}; return out; });
 assert.equal(wrongMode?.code,'published_epg_unavailable');assert.notEqual(wrongMode?.temporary,true,'a marker that is not d1/open is a refusal (ADR 0162)');
 const oldSchema=await run((sql,kind)=>{ const out=healthy(sql,kind); if(/schema_contract/.test(sql))return {version:3}; return out; });
 assert.notEqual(oldSchema?.temporary,true,'a schema version below 8 is structural');
}

// isTemporaryReadFault: the marked error, or a state that is transient by definition; never a bare top-level code.
for(const code of ['published_epg_unavailable','canonical_read_unavailable','discovery_unavailable','film_person_unavailable','film_person_held','discovery_not_authoritative','film_person_not_open_read','canonical_read_not_authoritative','admission_unavailable'])
 assert.equal(MirrorRead.isTemporaryReadFault(Object.assign(new Error(code),{code})),false,code+' alone is not temporary');
for(const code of ['discovery_fence','discovery_incomplete','film_person_generation_moved'])assert.equal(MirrorRead.isTemporaryReadFault({code}),true,code+' is transient by definition');
assert.equal(MirrorRead.isTemporaryReadFault(Object.assign(new Error('x'),{code:'canonical_read_unavailable',temporary:true})),true);
assert.equal(MirrorRead.isTemporaryReadFault(null),false);assert.equal(MirrorRead.isTemporaryReadFault('text'),false);
assert.equal(MirrorRead.isTemporaryReadFault({code:'published_epg_fence'}),false,'a fence is never answered from a mirror on first sight');
console.log('mirror fault classifier: temporary vs structural by cause, four copies agree, no top-level code is enough');
