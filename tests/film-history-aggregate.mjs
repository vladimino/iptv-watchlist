// AIR-650 / ADR 0216 (Accepted), delivery graph step 6, decision 6a: the dormant multi-alias history reader and its cursor contract. ADR 0216 synthetic
// test 26 (complete multi-alias history across pages; cursor invalidation with alias_set_changed, coverage_changed, identity_moved or source_changed;
// Started and recovery keep their writer authorization), the regressions of the independent review at 951f896 (fact attribution from the shared G1
// evidence, mandatory tokens and E1 recheck, resource bounds, value-based current status), the GET audit and the dormancy of the module. Synthetic fixtures
// only, on the sqlite3-CLI D1 stand-in over the full migration chain: the fact records live in D1 (the one place they are read); the other sources the
// activation card wires to the owning domains are in-memory readers here. Nothing touches the Worker bundle, R2, the network or production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {
 readFilmHistory,buildAliasHistory,factsFromEvidence,parseHistoryPage,parseHistoryCursor,encodeHistoryCursor,historyCursorMismatch,historyEventId,
 FILM_HISTORY_AGGREGATE_CONTRACT,HISTORY_DEFAULT_LIMIT,HISTORY_MAX_LIMIT,HISTORY_CHANGED_REASONS,HISTORY_SOURCE_LIMITS,HISTORY_MAX_EVENTS,
} from '../src/film-history-aggregate.js';
import {readFilmAggregate} from '../src/film-aggregate.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-history-aggregate-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const AT='2026-11-25T10:00:00.000Z';
const q=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const sha256=text=>crypto.createHash('sha256').update(text).digest('hex');
const OPEN=[
 "UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",
 "UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1",
 "UPDATE prediction_domain_authority SET mode='d1' WHERE id=1",
].join(';\n');
const schema=path.join(root,'schema.sqlite');
sqlite(schema,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
sqlite(schema,OPEN);
let n=0;
const blank=()=>{const file=path.join(root,'f-'+(n++)+'.sqlite');fs.copyFileSync(schema,file);return file;};
const fileSha=file=>sha256(fs.readFileSync(file));

function film(file,id,claims=[]){
 sqlite(file,`INSERT INTO film (id,contract_version,updated_at) VALUES (${q(id)},1,${q(AT)});INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',${q(id)},1,${q(AT)});`
  +claims.map(([scheme,value,trusted=1,conflicting=0])=>`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES (${q(id)},${q(scheme)},${q(value)},${trusted},${conflicting});`).join(''));
}
const claim=(file,id,scheme,value)=>sqlite(file,`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES (${q(id)},${q(scheme)},${q(value)},1,0)`);
function putDocument(file,key,value){
 const text=JSON.stringify(value),etag=sha256(text);
 sqlite(file,`DELETE FROM ratings_document WHERE key=${q(key)};INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES (${q(key)},0,${q(text)},${q(etag)},${q(AT)});`);
}
const record=(factKey,links,extra={})=>({schemaVersion:1,factKey,links:{letterboxd:links.letterboxd??null,tmdb:links.tmdb??null},redirectTo:null,migrating:null,...extra});
const putRecord=(file,factKey,links,extra)=>putDocument(file,'letterboxd/facts/films/'+factKey+'.json',record(factKey,links,extra));
const putLinks=(file,index)=>putDocument(file,'letterboxd/facts/links.json',index);
const view=(file,alias,factKey)=>sqlite(file,`INSERT OR REPLACE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES (${q(alias)},${q(factKey)},1,4,NULL,1,${q(AT)})`);

const noR2=new Proxy({},{get(){throw new Error('R2 must not be touched');}});
const env=(file,options)=>{const DB=d1Standin(file,options);return {DB,BUCKET:noR2,R2:noR2,calls:DB.calls};};
globalThis.fetch=()=>{throw new Error('network must not be touched');};

// ---- the injected sources over a mutable in-memory state, under the source contract (token, bytes, scanned, limits, recheck) ----
const d=(day,h=10)=>'2026-09-'+String(day).padStart(2,'0')+'T'+String(h).padStart(2,'0')+':00:00.000Z';
const prediction=(day,rating,extra={})=>({predictedRating:rating,probability4Plus:.5,confidence:'high',generatedAt:d(day),matchSignals:['s'],mainRisk:'r',moodLabels:[],tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintPromptVersion:'f1',runId:'run'+day,...extra});
const rating=(kind,id,value,day,previous=null)=>({kind,recordedAt:d(day),value,observedAt:d(day),source:'owner',sourceRef:null,observationId:id,previous});
const diaryEntry=(lid,date,extra={})=>({key:'day:lid:'+lid+'|'+date,identity:{type:'letterboxd_lid',value:lid},keyBasis:'identity_date',watchedDate:date,viewings:1,viewingsCertain:true,rewatch:false,rewatchRows:0,rewatchUnknownRows:0,aliases:[],firstObservedAt:d(28),observedAt:d(28),page:1,changes:[],...extra});
const factExtra=(ratingValue,observationId,day)=>({rating:{value:ratingValue,observedAt:d(day),source:'owner',observationId},ratingHistory:[rating('first_observed',observationId,ratingValue,day)]});
function world({lids=['a1','a2'],links=null,facts=null}={}){
 const file=blank();
 film(file,'film:tmdb:5',[['tmdb','5'],...lids.map(l=>['letterboxd',l])]);
 putLinks(file,links??Object.fromEntries([['tmdb:5','tmdb-5'],...lids.map(l=>['letterboxd:'+l,'tmdb-5'])]));
 for(const [factKey,info] of Object.entries(facts??{'tmdb-5':{links:{letterboxd:lids[0],tmdb:'5'}}}))putRecord(file,factKey,info.links,info.extra);
 view(file,'tmdb_5','tmdb-5');for(const l of lids)view(file,l,'tmdb-5');
 return file;
}
function state(lids=['a1','a2']){
 return {
  bundles:Object.fromEntries([...lids,'tmdb_5'].map(id=>[id,{current:null,history:[]}])),
  links:Object.fromEntries([['tmdb:5','tmdb-5'],...lids.map(l=>['letterboxd:'+l,'tmdb-5'])]),
  legacy:[],profile:{version:1,profileHash:'p1'},diary:{schemaVersion:1,entries:{}},diaryState:{lastOutcome:'complete',coverage:{reachedEnd:true}},versionTokens:{},
 };
}
const tokenOf=value=>value==null?null:sha256(JSON.stringify(value));
function sourcesOf(s,{unreadable=[],invalid={},fail=null,versions=null,recheck,omit=[],tweak=null}={}){
 const wrap=(kind,whole,value,scanned)=>{
  if(unreadable.includes(kind))return {status:'unreadable',token:'u-'+kind,bytes:0,scanned:0};
  const forced=Object.hasOwn(invalid,kind)?invalid[kind]:undefined;
  if(whole==null&&forced===undefined)return {status:'missing',token:'absent:'+kind+':authority-g1',bytes:0,scanned:0};
  const text=JSON.stringify(forced!==undefined?forced:whole);
  // The token names the stored object (the real state), whatever shape the test makes the reader see.
  const out={status:'recorded',token:tokenOf(whole),bytes:text.length,scanned,value:forced!==undefined?forced:value};
  return tweak?tweak(kind,out):out;
 };
 const live=(kind,value)=>value==null?'absent:'+kind+':authority-g1':tokenOf(value);
 const current=item=>({predictions:()=>live('predictions',s.bundles[item.key]),legacyLog:()=>live('legacyLog',s.legacy),profile:()=>live('profile',s.profile),diaryHistory:()=>live('diaryHistory',s.diary),diaryState:()=>live('diaryState',s.diaryState)})[item.source]();
 // The token readback of the E1 recheck under its contract: the token and status of every item, within its limits.
 const readback=list=>({tokens:list.map(item=>item.status==='unreadable'?item:{source:item.source,key:item.key,status:item.status,token:item.source==='predictionVersion'?(s.versionTokens[item.key]??item.token):current(item)}),bytes:100,scanned:list.length});
 const out={
  async predictionBundle({storageId}){
   if(fail==='prediction'){const e=new Error('boom');e.code='prediction_domain_unreadable';throw e;}
   const whole=s.bundles[storageId];return wrap('predictions',whole,whole,whole?(whole.history?.length||0)+(whole.current?1:0):0);
  },
  async legacyLog({storageIds}){const all=(s.legacy||[]).map((e,i)=>({...e,ordinal:i}));return wrap('legacyLog',s.legacy,all.filter(e=>storageIds.includes(String(e.filmId))),all.length);},
  async profile(){return wrap('profile',s.profile,s.profile,1);},
  async diaryHistory({lids}){
   const entries=Object.entries(s.diary?.entries||{});
   return wrap('diaryHistory',s.diary,s.diary&&{...s.diary,entries:Object.fromEntries(entries.filter(([,e])=>lids.includes(e?.identity?.value)))},entries.length);
  },
  async diaryState(){return wrap('diaryState',s.diaryState,s.diaryState,1);},
  async recheck(list){return readback(list);},
  ...(versions?{predictionVersion:versions}:{}),
  put(){throw new Error('history must not write');},delete(){throw new Error('history must not delete');},
 };
 out.readback=readback;
 if(recheck!==undefined)out.recheck=recheck;
 for(const name of omit)delete out[name];
 return out;
}
const history=(file,id,s,options={})=>{const e=env(file,options.db);return readFilmHistory(e,id,{...options,sources:options.sources??sourcesOf(s,options.source)}).then(out=>({...out,calls:e.calls}));};
const allPages=async(file,id,s,limit,options={})=>{
 const pages=[];let cursor;
 for(let i=0;i<50;i++){
  const out=await history(file,id,s,{...options,limit,cursor});
  assert.equal(out.http,200,JSON.stringify(out.body).slice(0,300));
  pages.push(out.body.history);
  cursor=out.body.history.page.nextCursor;
  if(!cursor)return pages;
 }
 throw new Error('too many pages');
};

// A Film with two authorized lids (a1, a2) and tmdb 5, one shared fact key in D1, predictions under every alias, a Diary of both lids and of a stranger.
function fixture(){
 const file=world({facts:{'tmdb-5':{links:{letterboxd:'a1',tmdb:'5'},extra:{rating:{value:4.5,observedAt:d(22),source:'owner',observationId:'o2'},
  ratingHistory:[rating('first_observed','o1',4,6),rating('changed','o2',4.5,22,{value:4,observedAt:d(6),source:'owner',observationId:'o1'})]}}}}),s=state();
 s.bundles.a1={current:prediction(20,4),history:[prediction(1,3),prediction(5,3.5)]};
 s.bundles.a2={current:prediction(21,4.5),history:[prediction(2,2.5)]};
 s.bundles.tmdb_5={current:null,history:[prediction(3,3)]};
 s.legacy=[{filmId:'a1',observedAt:d(7),before:null,after:4,source:'scan'},{filmId:'a2',observedAt:d(8),before:4,after:4,source:'scan'},{filmId:'tmdb_5',observedAt:d(9),before:4,after:4.5,source:'scan'},{filmId:'stranger',observedAt:d(10),before:1,after:1,source:'scan'}];
 const entries=[diaryEntry('a1','2026-09-05'),diaryEntry('a2','2026-09-12'),diaryEntry('a2','2026-09-25',{viewings:2}),diaryEntry('stranger','2026-09-07')];
 s.diary={schemaVersion:1,entries:Object.fromEntries(entries.map(e=>[e.key,e]))};
 return {file,s};
}

// ---- parameters and the cursor grammar: refused before any read ----
{
 const {file,s}=fixture();
 for(const bad of [{limit:'0'},{limit:'101'},{limit:'x'},{limit:'1.5'},{cursor:'garbage'},{cursor:'0.'+'a'.repeat(16)},{cursor:'h1.0.'+'a'.repeat(12)},{cursor:'h1.1000000.'+Array(5).fill('a'.repeat(12)).join('.')}]){
  const out=await history(file,'tmdb_5',s,bad);
  assert.equal(out.http,400,JSON.stringify(bad));
  assert.equal(out.body.error,'invalid_request');
  assert.equal(out.calls.queries,0,'a malformed request reads nothing: '+JSON.stringify(bad));
 }
 assert.deepEqual(parseHistoryPage({}),{limit:HISTORY_DEFAULT_LIMIT,offset:0,cursor:null});
 assert.equal(parseHistoryPage({limit:String(HISTORY_MAX_LIMIT)}).limit,HISTORY_MAX_LIMIT);
 const tokens=Object.fromEntries(['survivor','aliases','identity','coverage','sources'].map((name,i)=>[name,'sha256:'+String(i).repeat(64)]));
 const cursor=encodeHistoryCursor(7,tokens);
 assert.match(cursor,/^h1\.7(\.[0-9a-f]{12}){5}$/);
 assert.equal(parseHistoryCursor(cursor).offset,7);
 assert.equal(historyCursorMismatch(parseHistoryCursor(cursor),tokens),null);
 for(const [name,reason] of [['survivor','identity_moved'],['aliases','alias_set_changed'],['identity','identity_moved'],['coverage','coverage_changed'],['sources','source_changed']])
  assert.equal(historyCursorMismatch(parseHistoryCursor(cursor),{...tokens,[name]:'sha256:'+'f'.repeat(64)}),reason,name);
 assert.deepEqual([...new Set(HISTORY_CHANGED_REASONS)].sort(),['alias_set_changed','coverage_changed','identity_moved','source_changed']);
}

// ---- Test 26a: complete multi-alias history across pages, stable order, deduplication, every typed id ----
{
 const {file,s}=fixture();
 const whole=await history(file,'tmdb_5',s,{limit:100});
 assert.equal(whole.http,200);
 assert.equal(whole.body.contract,FILM_HISTORY_AGGREGATE_CONTRACT);
 assert.equal(whole.body.identity.verdict,'found');
 const h=whole.body.history;
 assert.deepEqual([h.status,h.reason,h.coverage.status,h.partial],['present',undefined,'complete',false]);
 assert.deepEqual(h.aliases,{lids:['a1','a2'],movies:['5'],storageIds:['a1','a2','tmdb_5']});
 const ids=h.events.map(e=>e.identity);
 assert.equal(new Set(ids).size,ids.length,'every event identity is unique');
 for(const e of h.events)assert.match(e.identity,/^[A-Za-z0-9_:-]+\|/,'<storageId>|<sourceEventId>');
 assert.ok(ids.includes('a1|prediction|current|0')&&ids.includes('a2|prediction|history|0')&&ids.includes('tmdb_5|prediction|history|0'));
 // One ratings fact reachable through three aliases is counted once; the aliases that reached it are named.
 const ratingEvents=h.events.filter(e=>e.type==='rating');
 assert.deepEqual(ratingEvents.map(e=>[e.identity,e.value]),[['fact:tmdb-5|rating|a|o1|0',4],['fact:tmdb-5|rating|a|o2|0',4.5]]);
 for(const e of ratingEvents)assert.deepEqual(e.storageIds,['letterboxd:a1','letterboxd:a2','tmdb:5']);
 // Distinct events under distinct aliases stay distinct, each with its storage id.
 assert.equal(h.events.filter(e=>e.type==='prediction').length,6);
 assert.deepEqual(new Set(h.events.filter(e=>e.type==='prediction').map(e=>e.storageId)),new Set(['a1','a2','tmdb_5']));
 // The legacy log: an entry of an authorized storage id counts once; a stranger's entry never joins.
 assert.deepEqual(h.events.filter(e=>e.type==='legacy_rating').map(e=>e.storageIds[0]),['a1','a2','tmdb_5']);
 // Diary entries of every authorized lid; a stranger's never.
 assert.deepEqual(h.events.filter(e=>e.type==='diary_viewing').map(e=>e.identity),['a1|diary|day:lid:a1|2026-09-05','a2|diary|day:lid:a2|2026-09-12','a2|diary|day:lid:a2|2026-09-25']);
 assert.equal(h.page.total,h.events.length);
 assert.equal(h.page.nextCursor,null);
 const key=e=>e.at===null?'~':e.atPrecision==='day'?e.at+'T~':e.at;
 assert.deepEqual(h.events.map(key),[...h.events.map(key)].sort());
 // Current values (C2): the two current predictions have different values (4 vs 4.5): conflict with each value, storage id and provenance; no winner.
 assert.equal(h.current.prediction.status,'conflict');
 assert.deepEqual(h.current.prediction.values.map(v=>[v.storageId,v.value.predictedRating,v.provenance.generatedAt]),[['a1',4,d(20)],['a2',4.5,d(21)]]);
 assert.deepEqual([h.current.rating.status,h.current.rating.values.length,h.current.rating.values[0].value,h.current.rating.values[0].provenance.observationId],['present',1,4.5,'o2']);
 assert.deepEqual(h.current.rating.values[0].storageIds,['letterboxd:a1','letterboxd:a2','tmdb:5']);
 assert.ok(h.notes.includes('diary_absence_is_not_unwatched'));
 assert.ok(!h.notes.includes('coverage_incomplete')&&!h.notes.includes('diary_coverage_partial'));
 // Pages of any size concatenate to the same list; the cursor is the same for every typed id of the Film (it is bound to the survivor, not the spelling).
 for(const limit of [1,2,3,7]){
  const pages=await allPages(file,'tmdb_5',s,limit);
  assert.deepEqual(pages.flatMap(p=>p.events.map(e=>e.identity)),ids,'limit '+limit);
  assert.ok(pages.every(p=>p.status==='present'&&p.page.total===ids.length));
  assert.deepEqual(pages.map(p=>p.page.offset),pages.map((_,i)=>i*limit));
 }
 const first=await history(file,'tmdb_5',s,{limit:3});
 for(const other of ['a1','a2','film:tmdb:5']){
  const next=await history(file,other,s,{limit:3,cursor:first.body.history.page.nextCursor});
  assert.equal(next.http,200,other);
  assert.deepEqual(next.body.history.events.map(e=>e.identity),ids.slice(3,6),other);
 }
 assert.deepEqual((await history(file,'a1',s,{limit:100})).body.history.events.map(e=>e.identity),ids);
}

// ---- Test 26b: every cursor invalidation, with its reason ----
const cursorOf=async(file,s,limit=3)=>(await history(file,'tmdb_5',s,{limit})).body.history.page.nextCursor;
const changed=(out,reason)=>{assert.equal(out.http,409,JSON.stringify(out.body).slice(0,300));assert.equal(out.body.error,'history_changed');assert.equal(out.body.reason,reason);assert.equal(out.body.history,undefined,'no events with a 409');};
{
 // source_changed: a source object changed between pages (a new Diary entry).
 const {file,s}=fixture();
 const cursor=await cursorOf(file,s);
 const entry=diaryEntry('a1','2026-09-30');s.diary={...s.diary,entries:{...s.diary.entries,[entry.key]:entry}};
 changed(await history(file,'tmdb_5',s,{limit:3,cursor}),'source_changed');
 const pages=await allPages(file,'tmdb_5',s,3);
 assert.ok(pages.flatMap(p=>p.events.map(e=>e.identity)).includes('a1|diary|day:lid:a1|2026-09-30'),'the restart reads the new version in full');
}
{
 // source_changed for a prediction bundle and the legacy log.
 for(const mutate of [s=>{s.bundles.a2={...s.bundles.a2,history:[...s.bundles.a2.history,prediction(9,3)]};},s=>{s.legacy=[...s.legacy,{filmId:'a1',observedAt:d(11),before:4,after:4,source:'scan'}];}]){
  const {file,s}=fixture();
  const cursor=await cursorOf(file,s);
  mutate(s);
  changed(await history(file,'tmdb_5',s,{limit:3,cursor}),'source_changed');
 }
}
{
 // A ratings fact record is bound through the coverage token (its etag is in it), so a changed record is coverage_changed, never a silently mixed page.
 const {file,s}=fixture();
 const cursor=await cursorOf(file,s);
 putRecord(file,'tmdb-5',{letterboxd:'a1',tmdb:'5'},{rating:{value:5,observedAt:d(23),source:'owner',observationId:'o3'},ratingHistory:[rating('changed','o3',5,23)]});
 changed(await history(file,'tmdb_5',s,{limit:3,cursor}),'coverage_changed');
}
{
 // alias_set_changed: a third authorized lid appears between pages (a canonical claim, link entry and view row, so coverage stays complete).
 const {file,s}=fixture();
 const cursor=await cursorOf(file,s);
 claim(file,'film:tmdb:5','letterboxd','a3');
 putLinks(file,{...s.links,'letterboxd:a3':'tmdb-5'});view(file,'a3','tmdb-5');s.links['letterboxd:a3']='tmdb-5';s.bundles.a3={current:null,history:[]};
 changed(await history(file,'tmdb_5',s,{limit:3,cursor}),'alias_set_changed');
}
{
 // coverage_changed: the link document changed (its etag joins the coverage token) while identity, aliases and sources stay the same.
 const {file,s}=fixture();
 const cursor=await cursorOf(file,s);
 putLinks(file,{...s.links,'letterboxd:elsewhere':'other-fact'});
 changed(await history(file,'tmdb_5',s,{limit:3,cursor}),'coverage_changed');
 // And coverage degrading to incomplete (an unsettled candidate reaches the fact key) is the same reason.
 const {file:file2,s:s2}=fixture();
 const cursor2=await cursorOf(file2,s2);
 putLinks(file2,{...s2.links,'letterboxd:cand':'tmdb-5'});
 changed(await history(file2,'tmdb_5',s2,{limit:3,cursor:cursor2}),'coverage_changed');
}
{
 // identity_moved: the identity read-set changed (the survivor's canonical revision) while the alias set is the same.
 const {file,s}=fixture();
 const cursor=await cursorOf(file,s);
 sqlite(file,"UPDATE canonical_revision SET revision=2 WHERE kind='film' AND id='film:tmdb:5'");
 changed(await history(file,'tmdb_5',s,{limit:3,cursor}),'identity_moved');
}
{
 // identity_moved: another canonical survivor (the Film was merged into another; the cursor of the old survivor never applies).
 const {file,s}=fixture();
 const cursor=await cursorOf(file,s);
 film(file,'film:merged',[]);
 sqlite(file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:5','film:merged',${q(AT)})`);
 changed(await history(file,'tmdb_5',s,{limit:3,cursor}),'identity_moved');
}
{
 // A valid cursor still answers while nothing it is bound to moved, however many times it is used; an offset past the total is refused.
 const {file,s}=fixture();
 const cursor=await cursorOf(file,s);
 for(let i=0;i<2;i++)assert.equal((await history(file,'tmdb_5',s,{limit:3,cursor})).http,200);
 const tokens=(await history(file,'tmdb_5',s,{limit:3})).body.history.tokens;
 assert.equal((await history(file,'tmdb_5',s,{limit:3,cursor:encodeHistoryCursor(999,tokens)})).http,400);
}

// ---- Test 26c: incomplete coverage can never advertise `present` ----
{
 // An unsettled candidate alias reaches the fact key: partial, the events of the authorized aliases only, no single current value stated.
 const {file,s}=fixture();
 putLinks(file,{...s.links,'letterboxd:cand':'tmdb-5'});
 const out=await history(file,'tmdb_5',s,{limit:100});
 assert.equal(out.http,200);
 const h=out.body.history;
 assert.deepEqual([h.status,h.reason,h.partial],['partial','coverage_incomplete',true]);
 assert.deepEqual([h.coverage.status,h.coverage.reason],['incomplete','unresolved_candidate']);
 assert.ok(h.notes.includes('coverage_incomplete'));
 assert.deepEqual([h.current.rating.status,h.current.rating.values[0].value],['partial',4.5],'one value is never the single current value under incomplete coverage');
 assert.equal(h.current.prediction.status,'conflict','a known conflict is kept under incomplete coverage');
 assert.ok(h.events.every(e=>!JSON.stringify(e).includes('cand')),'the candidate alias is never read');
 assert.ok((await allPages(file,'tmdb_5',s,4)).every(p=>p.status==='partial'));
 // A seed absent from the link index is not proof of coverage, and its facts are unproven.
 const {file:file2,s:s2}=fixture();
 putLinks(file2,{'tmdb:5':'tmdb-5','letterboxd:a1':'tmdb-5'});
 const out2=await history(file2,'tmdb_5',s2,{limit:100});
 assert.deepEqual([out2.body.history.status,out2.body.history.coverage.reason],['partial','seed_absent_unproved']);
 // No current value at all: `unknown` with incomplete coverage, `absent` only with complete coverage.
 const none=()=>{const f=fixture();putRecord(f.file,'tmdb-5',{letterboxd:'a1',tmdb:'5'},{});return f;};
 const a=none();putLinks(a.file,{...a.s.links,'letterboxd:cand':'tmdb-5'});
 assert.equal((await history(a.file,'tmdb_5',a.s,{limit:100})).body.history.current.rating.status,'unknown');
 const b=none();
 assert.equal((await history(b.file,'tmdb_5',b.s,{limit:100})).body.history.current.rating.status,'absent');
}
{
 // The ratings domain held: no history at all, never an empty one that reads as "nothing recorded".
 const {file,s}=fixture();
 sqlite(file,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 const out=await history(file,'tmdb_5',s,{limit:100});
 assert.equal(out.http,200);
 assert.deepEqual([out.body.history.status,out.body.history.reason,out.body.history.events],['unavailable','ratings_held',undefined]);
}

// ---- Review P1-1: fact attribution is the shared G1 evidence, never an injected record ----
{
 // A source that tries to contribute a stranger's fact record has no channel to do so: the facts are the D1 records reached from the seeds.
 const {file,s}=fixture();
 const withExtra={...sourcesOf(s),async factRecords(){return [{alias:'letterboxd:stranger',factKey:'stranger-fact',status:'recorded',token:'x',value:{ratingHistory:[rating('changed','evil',1,1)],rating:{value:1,observedAt:d(1),source:'owner',observationId:'evil'}}}];}};
 const h=(await history(file,'tmdb_5',s,{limit:100,sources:withExtra})).body.history;
 assert.ok(!h.events.some(e=>JSON.stringify(e).includes('evil')));
 assert.equal(h.current.rating.values[0].value,4.5);
}
{
 // The proven path of each seed: a seed with no fact key (omitted from the index) leaves its facts unproven; extra index entries never join.
 const ev={seedRoots:{'letterboxd:a1':'k'},paths:{k:['k']},records:{k:{etag:'e',value:record('k',{letterboxd:'a1'}),hop:null,kind:null}}};
 assert.equal(factsFromEvidence(['letterboxd:a1'],ev).proven,true);
 assert.equal(factsFromEvidence(['letterboxd:a1','tmdb:5'],ev).proven,false,'an omitted seed is unproven');
 assert.deepEqual(factsFromEvidence(['letterboxd:a1'],{...ev,seedRoots:{...ev.seedRoots,'letterboxd:foreign':'k'}}).facts[0].aliases,['letterboxd:a1'],'only the authorized seeds name a fact');
 assert.equal(factsFromEvidence(['letterboxd:a1'],{...ev,records:{}}).proven,false,'a record the evidence does not hold');
 assert.equal(factsFromEvidence(['letterboxd:a1'],{...ev,records:{k:{...ev.records.k,value:{...ev.records.k.value,ratingHistory:'x'}}}}).proven,false,'a malformed history');
 assert.equal(factsFromEvidence(['letterboxd:a1'],null).proven,false);
}
{
 // One-hop redirect: the target record is the fact (as the legacy route reads it), stored under the target key; both seeds of one pair are one fact.
 const links={'tmdb:5':'old','letterboxd:a1':'old','letterboxd:a2':'tmdb-5'};
 const file=world({lids:['a1','a2'],links,facts:{old:{links:{letterboxd:'a1',tmdb:'5'},extra:{redirectTo:'tmdb-5'}},'tmdb-5':{links:{letterboxd:'a2',tmdb:'5'},extra:factExtra(3.5,'t1',4)}}});
 const h=(await history(file,'tmdb_5',state(),{limit:100})).body.history;
 assert.deepEqual(h.events.filter(e=>e.type==='rating').map(e=>[e.storageId,e.value]),[['fact:tmdb-5',3.5]],'the redirect target is read once');
 assert.deepEqual(h.events.find(e=>e.type==='rating').storageIds,['letterboxd:a1','letterboxd:a2','tmdb:5']);
 assert.equal(h.current.rating.values.length,1);
 // One-hop migration: the overlay of source and target (the legacy reader's union), under the target key, deduplicated by observation.
 const file2=world({lids:['a1'],links:{'tmdb:5':'src','letterboxd:a1':'src'},facts:{src:{links:{letterboxd:'a1',tmdb:'5'},extra:{migrating:{to:'tgt'},...factExtra(4,'m1',5)}},tgt:{links:{letterboxd:'a1',tmdb:'5'},extra:{ratingHistory:[rating('changed','m2',4.5,8)],rating:{value:4.5,observedAt:d(8),source:'owner',observationId:'m2'}}}}});
 const h2=(await history(file2,'tmdb_5',state(['a1']),{limit:100})).body.history;
 assert.deepEqual(h2.events.filter(e=>e.type==='rating').map(e=>[e.storageId,e.identity.split('|').slice(1,4).join('|')]),[['fact:tgt','rating|a|m1'],['fact:tgt','rating|a|m2']],'both sides count, once each');
 assert.equal(h2.current.rating.values[0].value,4.5);
 // A second hop is not proven: coverage is incomplete and no complete history is claimed.
 const file3=world({lids:['a1'],links:{'tmdb:5':'x','letterboxd:a1':'x'},facts:{x:{links:{letterboxd:'a1',tmdb:'5'},extra:{redirectTo:'y'}},y:{links:{letterboxd:'a1',tmdb:'5'},extra:{redirectTo:'z'}},z:{links:{letterboxd:'a1',tmdb:'5'},extra:{}}}});
 const h3=(await history(file3,'tmdb_5',state(['a1']),{limit:100})).body.history;
 assert.notEqual(h3.status,'present');assert.equal(h3.coverage.status,'incomplete');
 // Another alias of the same fact key that no authorized seed names stays an unresolved candidate: incomplete, never present.
 const extra=Object.fromEntries(Array.from({length:6},(_,i)=>['letterboxd:m'+i,'k0']));
 const file4=world({lids:['a1'],links:{'tmdb:5':'k0','letterboxd:a1':'k0',...extra},facts:{k0:{links:{letterboxd:'a1',tmdb:'5'},extra:{}}}});
 const h4=(await history(file4,'tmdb_5',state(['a1']),{limit:100})).body.history;
 assert.notEqual(h4.status,'present');assert.equal(h4.coverage.status,'incomplete');
 // A malformed record is evidence unavailable: its facts are never certified.
 const file5=world({lids:['a1'],facts:{'tmdb-5':{links:{letterboxd:'a1',tmdb:'5'}}}});
 putDocument(file5,'letterboxd/facts/films/tmdb-5.json',{schemaVersion:1,factKey:'tmdb-5',links:{}});
 const h5=(await history(file5,'tmdb_5',state(['a1']),{limit:100})).body.history;
 assert.deepEqual([h5.status,h5.coverage.reason],['partial','ratings_evidence_unavailable']);
 assert.equal(h5.current.rating.status,'unknown');
}
{
 // A fact record that moves in D1 while the history is read (here: during a source read) fences the whole answer: generation_moved.
 const {file,s}=fixture();
 const base=sourcesOf(s);
 const moving={...base,async diaryState(...args){putRecord(file,'tmdb-5',{letterboxd:'a1',tmdb:'5'},{rating:{value:1,observedAt:d(25),source:'owner',observationId:'zz'},ratingHistory:[rating('changed','zz',1,25)]});return base.diaryState(...args);}};
 const out=await history(file,'tmdb_5',s,{limit:100,sources:moving});
 assert.deepEqual([out.http,out.body.history.status,out.body.history.reason],[200,'unavailable','generation_moved']);
}

// ---- Review P1-2: mandatory tokens and recheck, version evidence inside the fence, bounds, budget, isolation ----
{
 const {file,s}=fixture();
 // A source without a usable token is refused, whatever its status.
 for(const tweak of [(kind,out)=>kind==='profile'?{...out,token:''}:out,(kind,out)=>kind==='diaryHistory'?{...out,token:undefined}:out,(kind,out)=>kind==='predictions'?{...out,token:null}:out]){
  const out=await history(file,'tmdb_5',s,{limit:100,source:{tweak}});
  assert.deepEqual([out.http,out.body.history.status,out.body.history.reason,out.body.history.events],[200,'unavailable','history_source_unavailable',undefined]);
 }
 // A missing source carries its absence predicate (a token) and is then "nothing recorded", not an error; the Diary is then not complete.
 const missing=await history(file,'tmdb_5',{...s,diary:null,diaryState:null},{limit:100});
 assert.equal(missing.body.history.status,'partial');
 assert.ok(missing.body.history.notes.includes('diary_history_missing'));
 // A recheck that is absent or not a function: no history, never a complete one.
 for(const source of [{omit:['recheck']},{recheck:null},{recheck:'yes'}]){
  const out=await history(file,'tmdb_5',s,{limit:100,source});
  assert.deepEqual([out.body.history.status,out.body.history.reason],['unavailable','source_recheck_missing']);
 }
 // The readback is a source read under the same contract: a malformed answer or a throw (other than a budget error) is a typed source failure, never a move.
 for(const recheck of [async()=>undefined,async()=>false,async()=>true,async()=>({}),async()=>({tokens:'x',bytes:0,scanned:0}),async()=>({tokens:[],bytes:-1,scanned:0}),async()=>{throw new Error('x');}]){
  const out=await history(file,'tmdb_5',s,{limit:100,source:{recheck}});
  assert.deepEqual([out.http,out.body.history.status,out.body.history.reason],[200,'unavailable','history_source_unavailable'],String(recheck));
 }
 // A readback that over-reports its work is over its cap.
 const base=sourcesOf(s);
 const heavy=await history(file,'tmdb_5',s,{limit:100,source:{recheck:async list=>({...base.readback(list),bytes:HISTORY_SOURCE_LIMITS.recheck.maxBytes+1})}});
 assert.equal(heavy.body.history.reason,'history_source_over_cap');
 const many=await history(file,'tmdb_5',s,{limit:100,source:{recheck:async list=>({...base.readback(list),scanned:HISTORY_SOURCE_LIMITS.recheck.maxScanned+1})}});
 assert.equal(many.body.history.reason,'history_source_over_cap');
 // A readback that differs from what was read, in token, status, missing or extra items, is a move.
 for(const alter of [list=>list.map((item,i)=>i===0?{...item,token:'other'}:item),list=>list.map((item,i)=>i===0?{...item,status:'missing'}:item),list=>list.slice(1),list=>[...list,{source:'predictions',key:'zz',status:'recorded',token:'t'}]]){
  const out=await history(file,'tmdb_5',s,{limit:100,source:{recheck:async list=>{const r=base.readback(list);return {...r,tokens:alter(r.tokens)};}}});
  assert.deepEqual([out.body.history.status,out.body.history.reason],['unavailable','generation_moved']);
 }
 // The readback receives the request's real budget object and its limits, and every consumed token: each prediction bundle, the legacy log, the profile and both Diary objects.
 let seen=null,ctxSeen=null;
 await history(file,'tmdb_5',s,{limit:100,source:{recheck:async(list,ctx)=>{seen=list;ctxSeen=ctx;return base.readback(list);}}});
 assert.deepEqual(seen.map(i=>i.source).sort(),['diaryHistory','diaryState','legacyLog','predictions','predictions','predictions','profile']);
 assert.ok(seen.every(i=>typeof i.token==='string'&&i.token.length&&typeof i.status==='string'));
 assert.equal(typeof ctxSeen.budget.take,'function');assert.deepEqual(ctxSeen.limits,HISTORY_SOURCE_LIMITS.recheck);
 // A missing source is read back with its absence predicate and status, so "still absent" is verified, not assumed.
 let missingSeen=null;
 const absent={...s,diary:null,diaryState:null};
 await history(file,'tmdb_5',absent,{limit:100,source:{recheck:async list=>{missingSeen=list.filter(i=>i.status==='missing');return sourcesOf(absent).readback(list);}}});
 assert.deepEqual(missingSeen.map(i=>[i.source,i.token.startsWith('absent:')]).sort(),[['diaryHistory',true],['diaryState',true]]);
}
{
 // Version evidence is inside the fence: a version reader that moves a source (or a ratings document) is caught; the version tokens are rechecked too.
 const {file,s}=fixture();
 const SHA='c'.repeat(64),KEY='enrichment/films/a1/predictions/versions/'+SHA+'.json';
 s.bundles.a1={current:{...prediction(20,4),r2Key:KEY,contentSha256:SHA},history:[]};
 const verify=async({record})=>({status:'linked',r2Key:record.r2Key,contentSha256:record.contentSha256,token:'obj-etag-1',bytes:100,scanned:1});
 const ok=await history(file,'tmdb_5',s,{limit:100,source:{versions:verify}});
 assert.deepEqual([ok.body.history.status,ok.body.history.events.find(e=>e.identity==='a1|prediction|current|0').version.status],['present','linked']);
 const movesSource=await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>{s.legacy=[...s.legacy,{filmId:'a1',observedAt:d(12),before:1,after:2,source:'scan'}];return verify(arg);}}});
 assert.deepEqual([movesSource.body.history.status,movesSource.body.history.reason],['unavailable','generation_moved'],'a source moved by the version read');
 s.legacy=s.legacy.slice(0,-1);
 const movesRatings=await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>{putLinks(file,{...s.links,'letterboxd:late':'other'});return verify(arg);}}});
 assert.deepEqual([movesRatings.body.history.status,movesRatings.body.history.reason],['unavailable','generation_moved'],'a ratings document moved by the version read');
 putLinks(file,s.links);
 const movesVersion=await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>{s.versionTokens[KEY]='obj-etag-2';return verify(arg);}}});
 assert.deepEqual([movesVersion.body.history.status,movesVersion.body.history.reason],['unavailable','generation_moved'],'the version object itself moved');
 s.versionTokens={};
 // A version result without a token or over its limit is a broken contract; a mismatch is page-local `partial`.
 const noToken=await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>({...await verify(arg),token:''})}});
 assert.equal(noToken.body.history.reason,'history_source_unavailable');
 const over=await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>({...await verify(arg),bytes:HISTORY_SOURCE_LIMITS.predictionVersion.maxBytes+1})}});
 assert.equal(over.body.history.reason,'history_source_over_cap');
 const mismatch=await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>({...await verify(arg),status:'mismatch'})}});
 assert.deepEqual([mismatch.body.history.status,mismatch.body.history.reason],['partial','version_unverified']);
 // Only `linked` certifies a pointer: every other recognized verdict is page-local partial, `over_cap` and an unrecognized verdict are typed failures, and a
 // `linked` that names another pointer or hash is invalid.
 for(const status of ['missing','invalid','unreadable','none']){
  const out=await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>({...await verify(arg),status})}});
  assert.deepEqual([out.body.history.status,out.body.history.reason],['partial','version_unverified'],status);
 }
 assert.equal((await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>({...await verify(arg),status:'over_cap'})}})).body.history.reason,'history_source_over_cap');
 for(const status of ['weird','LINKED','',42,null])assert.equal((await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>({...await verify(arg),status})}})).body.history.reason,'history_source_unavailable',String(status));
 for(const wrong of [{r2Key:'enrichment/films/other/predictions/versions/'+SHA+'.json'},{contentSha256:'d'.repeat(64)},{r2Key:undefined},{contentSha256:undefined}]){
  const out=await history(file,'tmdb_5',s,{limit:100,source:{versions:async arg=>({...await verify(arg),...wrong})}});
  assert.deepEqual([out.body.history.status,out.body.history.reason,out.body.history.events.find(e=>e.identity==='a1|prediction|current|0').version.status],['partial','version_unverified','invalid'],JSON.stringify(wrong));
 }
 // The maintained pointer rule (predictionVersionLinked) is applied BEFORE any body is requested: a key naming another film, a hash that differs from the one in
 // the key, a placeholder key, a key without a hash and a hash without a key are `invalid`, and the version reader is never called for them. `none` is only a
 // record with both pointer fields absent (nothing to verify).
 const other='enrichment/films/other/predictions/versions/'+SHA+'.json';
 for(const pointer of [{r2Key:other,contentSha256:SHA},{r2Key:KEY,contentSha256:'d'.repeat(64)},{r2Key:'enrichment/films/a1/versions/v.json',contentSha256:SHA},{r2Key:KEY},{contentSha256:SHA},{r2Key:KEY,contentSha256:null},{r2Key:'x',contentSha256:'y'},{r2Key:'enrichment/films/a1/predictions/versions/'+'C'.repeat(64)+'.json',contentSha256:'C'.repeat(64)}]){
  let called=0;
  const bad={...s,bundles:{...s.bundles,a1:{current:{...prediction(20,4),...pointer},history:[]}}};
  const out=await history(file,'tmdb_5',bad,{limit:100,source:{versions:async arg=>{called++;return verify(arg);}}});
  assert.equal(called,0,'no body is requested for '+JSON.stringify(pointer));
  const event=out.body.history.events.find(e=>e.identity==='a1|prediction|current|0');
  assert.deepEqual([out.body.history.status,out.body.history.reason,event.version.status],['partial','version_unverified','invalid'],JSON.stringify(pointer));
 }
 // A pointer to the holder's own version object is accepted for a tmdb_<n> holder too, and a record with no pointer at all is not checked.
 const KEY5='enrichment/films/tmdb_5/predictions/versions/'+SHA+'.json';
 const own5={...s,bundles:{...s.bundles,tmdb_5:{current:{...prediction(22,3),r2Key:KEY5,contentSha256:SHA},history:[]}}};
 const seen5=[];
 const ok5=await history(file,'tmdb_5',own5,{limit:100,source:{versions:async arg=>{seen5.push(arg.storageId);return verify(arg);}}});
 assert.deepEqual([ok5.body.history.status,seen5.sort()],['present',['a1','tmdb_5']]);
 const foreign=await history(file,'tmdb_5',{...own5,bundles:{...own5.bundles,tmdb_5:{current:{...prediction(22,3),r2Key:KEY,contentSha256:SHA},history:[]}}},{limit:100,source:{versions:verify}});
 assert.equal(foreign.body.history.events.find(e=>e.identity==='tmdb_5|prediction|current|0').version.status,'invalid','a key of another storage id is foreign even when it is valid for its own');
 // Without a version reader the pointer is `unchecked`, never `linked` or `none`; versions are read for the events of the page only.
 const unchecked=await history(file,'tmdb_5',s,{limit:100});
 assert.deepEqual([unchecked.body.history.status,unchecked.body.history.events.find(e=>e.identity==='a1|prediction|current|0').version.status],['partial','unchecked']);
 let checks=0;
 const firstPage=await history(file,'tmdb_5',s,{limit:1,source:{versions:async arg=>{checks++;return verify(arg);}}});
 assert.deepEqual([firstPage.body.history.events.length,checks],[1,0],'the first event has no pointer: nothing is verified for a page that does not show the pointer');
}
{
 // Resource bounds are enforced before anything is materialized: a source over its limits, or one that reports a count past them, is a typed failure.
 const {file,s}=fixture();
 const lim=HISTORY_SOURCE_LIMITS;
 for(const [kind,field,value] of [['legacyLog','scanned',lim.legacyLog.maxScanned+1],['diaryHistory','bytes',lim.diaryHistory.maxBytes+1],['predictions','scanned',lim.predictions.maxScanned+1],['profile','bytes',lim.profile.maxBytes+1],['diaryState','scanned',2]]){
  const out=await history(file,'tmdb_5',s,{limit:100,source:{tweak:(k,o)=>k===kind?{...o,[field]:value}:o}});
  assert.deepEqual([out.body.history.status,out.body.history.reason,out.body.history.events],['unavailable','history_source_over_cap',undefined],kind);
 }
 const overCap=await history(file,'tmdb_5',s,{limit:100,source:{tweak:(k,o)=>k==='diaryHistory'?{status:'over_cap',token:'t',bytes:0,scanned:0}:o}});
 assert.equal(overCap.body.history.reason,'history_source_over_cap');
 // Counts that are not counts are refused.
 for(const bad of [{bytes:-1},{scanned:1.5},{bytes:'3'}]){
  const out=await history(file,'tmdb_5',s,{limit:100,source:{tweak:(k,o)=>k==='legacyLog'?{...o,...bad}:o}});
  assert.equal(out.body.history.reason,'history_source_unavailable',JSON.stringify(bad));
 }
 // A large shared document whose entries are mostly unrelated: the reader filters at the source with the authorized ids, so only the related entries are
 // materialized and the history is complete; the same document scanned past its limit is the typed over-cap failure above.
 const big={...s,diary:{schemaVersion:1,entries:{...s.diary.entries,...Object.fromEntries(Array.from({length:4000},(_,i)=>['day:lid:u'+i+'|2026-01-01',diaryEntry('u'+i,'2026-01-01')]))}},
  legacy:[...s.legacy,...Array.from({length:3000},(_,i)=>({filmId:'u'+i,observedAt:d(1),before:1,after:1,source:'scan'}))]};
 let materialized=null;
 const out=await history(file,'tmdb_5',big,{limit:100,source:{tweak:(k,o)=>{if(k==='diaryHistory')materialized=Object.keys(o.value.entries).length;return o;}}});
 assert.deepEqual([out.body.history.status,out.body.history.page.total],['present',14]);
 assert.equal(materialized,3,'only the entries of the authorized lids were materialized');
 // The event cap is enforced while events are collected, not after everything was sorted.
 assert.throws(()=>buildAliasHistory({lids:['a'],bundles:{a:{current:null,history:Array.from({length:HISTORY_MAX_EVENTS+1},(_,i)=>prediction(1,3,{runId:'r'+i}))}}}),error=>error.code==='history_too_large');
 const spread=Array.from({length:3500},(_,i)=>prediction(1,3,{runId:'r'+i}));
 const tooMany=await history(file,'tmdb_5',{...s,bundles:{a1:{current:null,history:spread},a2:{current:null,history:spread},tmdb_5:{current:null,history:spread}}},{limit:100});
 assert.deepEqual([tooMany.body.history.status,tooMany.body.history.reason,tooMany.body.history.events],['unavailable','history_too_large',undefined]);
}
{
 // Budget: a source that exhausts the shared counted budget makes the history `unavailable` while the identity fence, reserved first, still runs: 200
 // with the typed section, never a 503 and never the resolver's generic sectionsUnavailable.
 const {file,s}=fixture();
 const base=sourcesOf(s);
 const greedy={...base,async legacyLog(args,ctx){while(ctx.budget.take(1));const e=new Error('budget');e.code='budget_exceeded';throw e;}};
 const out=await history(file,'tmdb_5',s,{limit:100,sources:greedy});
 assert.equal(out.http,200);
 assert.equal(out.body.sectionsUnavailable,undefined);
 assert.deepEqual([out.body.identity.verdict,out.body.history.status,out.body.history.reason],['found','unavailable','budget_exceeded']);
 // The recheck readback charges the same budget: exhausting it there is the typed budget_exceeded (not a move), with the identity fence still run.
 const greedyRecheck={...base,async recheck(list,ctx){while(ctx.budget.take(1));const e=new Error('budget');e.code='budget_exceeded';throw e;}};
 const outRecheck=await history(file,'tmdb_5',s,{limit:100,sources:greedyRecheck});
 assert.equal(outRecheck.http,200);
 assert.equal(outRecheck.body.sectionsUnavailable,undefined);
 assert.deepEqual([outRecheck.body.identity.verdict,outRecheck.body.history.status,outRecheck.body.history.reason],['found','unavailable','budget_exceeded']);
 // A fact document that changes during the readback is caught by the shared ratings fence, which runs after the readback.
 const changingRecheck={...base,async recheck(list,ctx){putRecord(file,'tmdb-5',{letterboxd:'a1',tmdb:'5'},{rating:{value:2,observedAt:d(26),source:'owner',observationId:'late'},ratingHistory:[rating('changed','late',2,26)]});return base.recheck(list,ctx);}};
 const outChanging=await history(file,'tmdb_5',s,{limit:100,sources:changingRecheck});
 assert.deepEqual([outChanging.http,outChanging.body.history.status,outChanging.body.history.reason],[200,'unavailable','generation_moved']);
 // The sources receive the request's real budget object and their limits.
 let ctxSeen=null;
 await history(file,'tmdb_5',s,{limit:100,sources:{...base,async profile(args,ctx){ctxSeen=ctx;return base.profile(args,ctx);}}});
 assert.deepEqual(Object.keys(ctxSeen).sort(),['budget','limits']);
 assert.equal(typeof ctxSeen.budget.take,'function');assert.deepEqual(ctxSeen.limits,HISTORY_SOURCE_LIMITS.profile);
 // A small request budget makes the history unavailable, never present.
 const tight=await readFilmHistory(env(file),'tmdb_5',{limit:100,sources:base,budgetLimit:5});
 assert.notEqual(tight.body.history?.status,'present');
}
{
 // An exception while assembling (here: a record whose field throws) is the typed history unavailable, not the generic sectionsUnavailable, and the
 // ratings fence reservation is consumed: the identity fence still passes and the statement count equals the success path.
 const {file,s}=fixture();
 const bomb={current:null,history:[{predictedRating:3,get generatedAt(){throw new Error('bomb');}}]};
 const tweak=(k,o)=>k==='predictions'&&o.value&&o.value.history.length===2?{...o,value:bomb}:o;
 const failed=await history(file,'tmdb_5',s,{limit:100,source:{tweak}});
 assert.equal(failed.http,200);assert.equal(failed.body.sectionsUnavailable,undefined);
 assert.deepEqual([failed.body.identity.verdict,failed.body.history.status,failed.body.history.reason],['found','unavailable','history_source_unavailable']);
 const normal=await history(file,'tmdb_5',s,{limit:100});
 assert.equal(failed.calls.queries,normal.calls.queries,'the reserved ratings fence statement is consumed, as on the success path');
}

// ---- Review P1-3: verified missing vs unreadable/invalid, value-based current status, Diary completeness ----
{
 const {file,s}=fixture();
 // A recorded object of the wrong shape (or a null body) is invalid, never an empty bundle: partial, the field unknown.
 for(const bad of [null,[],'text',{history:'x'},{history:[1]},{current:5},{},{history:[]}.history,{current:{},history:[]},{current:{predictedRating:'4'},history:[]},{current:{predictedRating:Number.NaN},history:[]},{current:null,history:[{predictedRating:3,probability4Plus:'x'}]},{current:{predictedRating:4,confidence:5},history:[]},{current:{predictedRating:4,generatedAt:20260901},history:[]}]){
  const h=(await history(file,'tmdb_5',s,{limit:100,source:{invalid:{predictions:bad}}})).body.history;
  assert.deepEqual([h.status,h.reason],['partial','source_unreadable'],JSON.stringify(bad));
  assert.equal(h.current.prediction.status,'unknown',JSON.stringify(bad)+': no current prediction is certified');
  assert.deepEqual(h.sources.predictions,['invalid','invalid','invalid']);
 }
 // An unreadable prediction source: unknown, never absent or present, even with complete coverage.
 const unreadable=await history(file,'tmdb_5',s,{limit:100,source:{unreadable:['predictions']}});
 assert.deepEqual([unreadable.body.history.status,unreadable.body.history.current.prediction.status,unreadable.body.history.coverage.status],['partial','unknown','complete']);
 // One readable current is not the single current value while another source is unreadable.
 const one=await history(file,'tmdb_5',s,{limit:100,source:{tweak:(k,o)=>k==='predictions'&&o.value&&o.value.current&&o.value.current.runId==='run21'?{status:'unreadable',token:'u',bytes:0,scanned:0}:o}});
 assert.equal(one.body.history.current.prediction.status,'partial');
 const invalidProfile=await history(file,'tmdb_5',s,{limit:100,source:{invalid:{profile:'x'}}});
 assert.deepEqual([invalidProfile.body.history.status,invalidProfile.body.history.reason],['partial','source_unreadable']);
 // Verified missing is "nothing recorded": with complete coverage and a complete Diary the current values are absent.
 const none=await history(world(),'tmdb_5',state(),{limit:100});
 assert.deepEqual([none.body.history.status,none.body.history.current.prediction.status,none.body.history.current.rating.status],['present','absent','absent']);
}
{
 // The recognized stored envelopes, not only primitive objects: a Diary history without entries, a Diary state without an outcome, a profile of the wrong
 // types and a legacy log whose entries carry no (or a repeated) original ordinal are invalid and never certify a complete history.
 const {file,s}=fixture();
 for(const [kind,bad] of [['diaryHistory',{}],['diaryHistory',{schemaVersion:1}],['diaryHistory',{entries:[]}],['diaryHistory',{entries:{k:1}}],['diaryState',{}],['diaryState',{coverage:{reachedEnd:true}}],['diaryState',{lastOutcome:7}],
  ['profile',{version:'1'}],['profile',{profileHash:5}],['legacyLog',[{filmId:'a1'}]],['legacyLog',[{filmId:'a1',ordinal:0},{filmId:'a2',ordinal:0}]],['legacyLog',[{filmId:'a1',ordinal:-1}]]]){
  const h=(await history(file,'tmdb_5',s,{limit:100,source:{invalid:{[kind]:bad}}})).body.history;
  assert.deepEqual([h.status,h.reason],['partial','source_unreadable'],kind+' '+JSON.stringify(bad));
 }
 // A Diary history of `{}` with a complete state does not certify present (it is not a recognized envelope); an empty `entries` object does.
 const emptyEntries=await history(file,'tmdb_5',{...s,diary:{entries:{}}},{limit:100});
 assert.equal(emptyEntries.body.history.status,'present');
 // Optional legacy fields stay optional: a bare stored prediction and a profile without a hash are valid.
 const bare={...s,bundles:{...s.bundles,a1:{current:{predictedRating:3.5},history:[{predictedRating:3}]}},profile:{}};
 assert.equal((await history(file,'tmdb_5',bare,{limit:100})).body.history.status,'present');
 // Known values stay visible with partial proof: an invalid bundle does not hide the conflict of the readable ones.
 const part=(await history(file,'tmdb_5',s,{limit:100,source:{tweak:(k,o)=>k==='predictions'&&o.value&&o.value.history.length===2?{...o,value:{current:{},history:[]},status:'recorded'}:o}})).body.history;
 assert.equal(part.status,'partial');
 assert.equal(part.current.prediction.status,'partial');
 assert.deepEqual(part.current.prediction.values.length,1,'the readable alias value is visible, not certified');
}
{
 // Fact records: a rating needs an explicit `value` member (a number, or null for a known unrated state); anything else is unproven.
 const ev=(rating_)=>({seedRoots:{'letterboxd:a1':'k'},paths:{k:['k']},records:{k:{etag:'e',value:record('k',{letterboxd:'a1'},{rating:rating_,ratingHistory:[]}),hop:null,kind:null}}});
 for(const bad of [{},{value:'bad'},{value:Number.NaN},{value:undefined},{observedAt:d(1)},[],'x',5,{value:0},{value:0.3},{value:5.5},{value:4.25},{value:-1},{value:Infinity},{value:'4'},{value:true}])assert.equal(factsFromEvidence(['letterboxd:a1'],ev(bad)).proven,false,JSON.stringify(bad));
 for(const good of [undefined,null,{value:null},{value:3.5,observedAt:d(1)},{value:0.5},{value:5},{value:1}])assert.equal(factsFromEvidence(['letterboxd:a1'],ev(good)).proven,true,JSON.stringify(good));
 assert.equal(factsFromEvidence(['letterboxd:a1'],{...ev(null),records:{k:{...ev(null).records.k,value:{...ev(null).records.k.value,ratingHistory:[1]}}}}).proven,false,'a history entry that is not an object');
 // Integration: a stored record whose rating has no value member is unproven; an explicit null value is a known unrated state, present with value null.
 const bad=world({lids:['a1'],facts:{'tmdb-5':{links:{letterboxd:'a1',tmdb:'5'},extra:{rating:{},ratingHistory:[]}}}});
 const hb=(await history(bad,'tmdb_5',state(['a1']),{limit:100})).body.history;
 assert.deepEqual([hb.status,hb.reason,hb.current.rating.status],['partial','ratings_facts_unproven','unknown']);
 const unrated=world({lids:['a1'],facts:{'tmdb-5':{links:{letterboxd:'a1',tmdb:'5'},extra:{rating:{value:null,observedAt:d(3),source:'owner',observationId:'u'},ratingHistory:[]}}}});
 const hu=(await history(unrated,'tmdb_5',state(['a1']),{limit:100})).body.history;
 assert.deepEqual([hu.status,hu.current.rating.status,hu.current.rating.values[0].value],['present','present',null]);
}
{
 // Two distinct migrating sources of one target: the union of both and the target, no silent loss; the same source reached twice changes nothing.
 const rec=(key,observation,value,day,extra={})=>({value:record(key,{letterboxd:'a1',tmdb:'5'},{ratingHistory:[rating('changed',observation,value,day)],rating:{value,observedAt:d(day),source:'owner',observationId:observation},...extra}),etag:key+'-e',hop:extra.migrating?.to??null,kind:extra.migrating?'migrating':null});
 const evidence={seedRoots:{'letterboxd:a1':'s1','letterboxd:a2':'s2','tmdb:5':'s1'},paths:{s1:['s1','t'],s2:['s2','t']},
  records:{s1:rec('s1','m1',3,2,{migrating:{to:'t'}}),s2:rec('s2','m2',4,3,{migrating:{to:'t'}}),t:rec('t','m3',4.5,5)}};
 const out=factsFromEvidence(['letterboxd:a1','letterboxd:a2','tmdb:5'],evidence);
 assert.equal(out.proven,true);
 assert.equal(out.facts.length,1);
 assert.deepEqual(out.facts[0].aliases,['letterboxd:a1','letterboxd:a2','tmdb:5']);
 const events=buildAliasHistory({lids:['a1','a2'],facts:out.facts,coverageComplete:true}).events.filter(e=>e.type==='rating').map(e=>e.identity.split('|').slice(1,4).join('|')).sort();
 assert.deepEqual(events,['rating|a|m1','rating|a|m2','rating|a|m3'],'both sources and the target');
 assert.equal(factsFromEvidence(['tmdb:5','letterboxd:a1'],evidence).facts[0].record.ratingHistory.length,2,'one source reached through two seeds is one overlay');
}
{
 // The legacy log keeps the ORIGINAL ordinal of an entry in the stored log: filtering upstream never renumbers, so an event does not change identity when
 // another alias precedes it.
 const built=buildAliasHistory({lids:['a2'],legacyLog:[{filmId:'a2',ordinal:7,observedAt:d(8),before:1,after:2,source:'scan'}],coverageComplete:true});
 assert.deepEqual(built.events.map(e=>e.identity),['legacy-log|legacy|7']);
 const {file,s}=fixture();
 const h=(await history(file,'tmdb_5',s,{limit:100})).body.history;
 assert.deepEqual(h.events.filter(e=>e.type==='legacy_rating').map(e=>[e.identity,e.storageIds[0]]),[['legacy-log|legacy|0','a1'],['legacy-log|legacy|1','a2'],['legacy-log|legacy|2','tmdb_5']]);
 // A Film that only knows tmdb_5 sees the same identity for the same entry.
 const only=world({lids:[],links:{'tmdb:5':'tmdb-5'},facts:{'tmdb-5':{links:{tmdb:'5'}}}});
 const so=state([]);so.legacy=s.legacy;
 const ho=(await history(only,'tmdb_5',so,{limit:100})).body.history;
 assert.deepEqual(ho.events.filter(e=>e.type==='legacy_rating').map(e=>e.identity),['legacy-log|legacy|2']);
}
{
 // Diary completeness: a partial state, a missing state or a missing history is never a complete history.
 const {file,s}=fixture();
 const partialState=await history(file,'tmdb_5',{...s,diaryState:{lastOutcome:'partial',coverage:{reachedEnd:false},resumePage:4}},{limit:100});
 assert.deepEqual([partialState.body.history.status,partialState.body.history.reason],['partial','diary_coverage_partial']);
 assert.ok(partialState.body.history.notes.includes('diary_coverage_partial'));
 const recent=await history(file,'tmdb_5',{...s,diaryState:{lastOutcome:'recent_window',coverage:{window:'recent',reachedEnd:false}}},{limit:100});
 assert.equal(recent.body.history.reason,'diary_coverage_partial');
 const noState=await history(file,'tmdb_5',{...s,diaryState:null},{limit:100});
 assert.deepEqual([noState.body.history.status,noState.body.history.reason],['partial','diary_coverage_partial']);
 const noDiary=await history(file,'tmdb_5',{...s,diary:null},{limit:100});
 assert.deepEqual([noDiary.body.history.status,noDiary.body.history.reason],['partial','diary_coverage_partial']);
 assert.ok(noDiary.body.history.notes.includes('diary_history_missing'));
 // A complete state with a history that has no entry of this Film: present, and still "absence is not unwatched".
 const empty=await history(file,'tmdb_5',{...s,diary:{schemaVersion:1,entries:{}}},{limit:100});
 assert.equal(empty.body.history.status,'present');
 assert.ok(empty.body.history.notes.includes('diary_absence_is_not_unwatched'));
}
{
 // C2 compares the values, not the events that carry them. Predictions: the value is predictedRating, probability4Plus and confidence.
 const mk=(a,b)=>buildAliasHistory({lids:['x','y'],bundles:{x:{current:a,history:[]},y:{current:b,history:[]}},coverageComplete:true});
 // Equal values with different timestamps, run ids and hashes agree: one value, every storage id, both provenances kept, no winner.
 const agree=mk(prediction(20,4,{contentSha256:'a'.repeat(64)}),prediction(21,4,{runId:'other',contentSha256:'b'.repeat(64)})).current.prediction;
 assert.equal(agree.status,'present');
 assert.deepEqual(agree.values.map(v=>[v.storageId,v.value.predictedRating,v.provenance.generatedAt,v.provenance.runId]),[['x',4,d(20),'run20'],['y',4,d(21),'other']]);
 // Different values with the same timestamp and no hash are a conflict.
 const same=prediction(20,4),conflict=mk(same,{...same,predictedRating:3}).current.prediction;
 assert.deepEqual([conflict.status,conflict.values.map(v=>v.value.predictedRating)],['conflict',[4,3]]);
 for(const field of ['probability4Plus','confidence'])assert.equal(mk(same,{...same,[field]:field==='confidence'?'low':.1}).current.prediction.status,'conflict',field);
 // Ratings: the same rating from two distinct facts agrees; different ratings conflict; the provenance is kept for each.
 const fact=(factKey,value,observationId)=>({factKey,aliases:['letterboxd:'+factKey],record:{rating:{value,observedAt:d(5),source:'owner',observationId},ratingHistory:[]}});
 const eq=buildAliasHistory({lids:['x'],facts:[fact('f1',4,'o1'),fact('f2',4,'o2')],coverageComplete:true}).current.rating;
 assert.deepEqual([eq.status,eq.values.map(v=>[v.factKey,v.value,v.provenance.observationId])],['present',[['f1',4,'o1'],['f2',4,'o2']]]);
 const neq=buildAliasHistory({lids:['x'],facts:[fact('f1',4,'o1'),fact('f2',2,'o1')],coverageComplete:true}).current.rating;
 assert.deepEqual([neq.status,neq.values.map(v=>v.value)],['conflict',[4,2]]);
 // Proof: without readable inputs a single value is partial and none is unknown; a known conflict stays.
 const noProof=buildAliasHistory({lids:['x'],facts:[fact('f1',4,'o1')],coverageComplete:true,proof:{predictions:false,ratings:false}});
 assert.deepEqual([noProof.current.rating.status,noProof.current.prediction.status],['partial','unknown']);
 assert.equal(buildAliasHistory({lids:['x'],facts:[fact('f1',4,'o1'),fact('f2',2,'o2')],coverageComplete:true,proof:{predictions:false,ratings:false}}).current.rating.status,'conflict');
}
{
 // The pure assembly: identical payloads under two aliases are two events; the same fact twice is one.
 const bundle={current:prediction(20,4),history:[]};
 const built=buildAliasHistory({lids:['x','y'],movies:[],bundles:{x:bundle,y:bundle},coverageComplete:true});
 assert.deepEqual(built.events.map(e=>e.identity),['x|prediction|current|0','y|prediction|current|0']);
 const fact=(rating_)=>({factKey:'k',aliases:['letterboxd:x'],record:{ratingHistory:[rating_]}});
 const once=buildAliasHistory({lids:['x'],facts:[fact(rating('changed','o',4,5)),{...fact(rating('changed','o',4,5)),aliases:['tmdb:1']}],coverageComplete:true});
 assert.equal(once.events.length,1);assert.deepEqual(once.events[0].storageIds,['letterboxd:x','tmdb:1']);
 assert.equal(historyEventId('a1','diary|k'),'a1|diary|k');
 assert.deepEqual(buildAliasHistory({lids:[],movies:[]}).events,[]);
}

// ---- failure isolation and the other verdicts ----
{
 const {file,s}=fixture();
 const failing=await history(file,'tmdb_5',s,{limit:100,source:{fail:'prediction'}});
 assert.equal(failing.http,200);
 assert.deepEqual([failing.body.history.status,failing.body.history.reason,failing.body.history.events],['unavailable','prediction_unavailable',undefined]);
}
{
 // No authorized storage id (a TV-only Film): `unknown`, the TV number is never a storage key; a cursor never applies to it.
 const file=blank();film(file,'film:tv9',[['tmdb_tv','9']]);
 const out=await history(file,'tmdb_tv:9',state([]));
 assert.equal(out.http,200);
 assert.deepEqual([out.body.history.status,out.body.history.reason],['unknown','no_authorized_alias']);
 changed(await history(file,'tmdb_tv:9',state([]),{cursor:encodeHistoryCursor(0,Object.fromEntries(['survivor','aliases','identity','coverage','sources'].map(name=>[name,'sha256:'+'1'.repeat(64)])))}),'identity_moved');
}
{
 const {file,s}=fixture();
 for(const [id,http] of [['tmdb_6',404],['bad id',400],['tmdb_tv:1',404]]){
  const out=await history(file,id,s);
  assert.equal(out.http,http,id);assert.equal(out.body.history,undefined,id);assert.equal(out.body.contract,FILM_HISTORY_AGGREGATE_CONTRACT);
 }
}

// ---- GET audit (ADR 0107): a pure read, byte-identical database, SELECT statements only, no R2, no network ----
{
 const {file,s}=fixture();
 const before=fileSha(file),executed=[],stats={read:0,written:0};
 const e=env(file,{onQuery:t=>executed.push(t),rowStats:stats});
 for(const id of ['tmdb_5','a1','film:tmdb:5','tmdb_6','bad id']){
  const out=await readFilmHistory(e,id,{limit:3,sources:sourcesOf(s)});
  assert.ok([200,400,404].includes(out.http));
 }
 assert.equal(stats.written,0);assert.equal(fileSha(file),before,'the database is byte-identical');assert.equal(e.calls.batches,0);
 const writes=executed.filter(t=>!/^\s*(WITH\b[\s\S]*?\)\s*)?SELECT\b/i.test(t)||/\b(INSERT|UPDATE|DELETE|REPLACE)\s/i.test(t.replace(/'[^']*'/g,'')));
 assert.deepEqual(writes,[],'only SELECT statements ran');
 const source=fs.readFileSync('src/film-history-aggregate.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)\b/i.test(source),'the module holds no write SQL');
 assert.ok(!/\b(fetch|BUCKET|\.put\(|\.delete\()/.test(source),'no network, no R2 and no write call');
 const single=await history(file,'tmdb_5',s,{limit:3});
 assert.ok(single.calls.queries<=40,'statements '+single.calls.queries);
}

// ---- Dormant: the legacy contract is untouched and nothing serves this reader ----
{
 const build=fs.readFileSync('build.mjs','utf8');
 assert.ok(!build.includes('src/film-history-aggregate.js'),'the module stays out of the bundle');
 for(const name of fs.readdirSync('src').filter(f=>f.endsWith('.js')&&f!=='film-history-aggregate.js'))
  assert.ok(!/film-history-aggregate/.test(fs.readFileSync('src/'+name,'utf8')),name+' must not import the dormant history reader');
 const worker=fs.readFileSync('src/worker.js','utf8');
 assert.ok(!worker.includes('film-history-aggregate')&&!worker.includes(FILM_HISTORY_AGGREGATE_CONTRACT),'the Worker routes no multi-alias history');
 // AIR-648 scopes the reader into the bundle (build.mjs, scopedFilmAggregate) without calling it: the contract string occurs only inside that scope, never in a router.
 if(fs.existsSync('dist/server/index.js')){const count=text=>text.split(FILM_HISTORY_AGGREGATE_CONTRACT).length-1;assert.equal(count(fs.readFileSync('dist/server/index.js','utf8')),count(fs.readFileSync('src/film-history-aggregate.js','utf8')),'the built bundle holds the reader only as an unrouted scope');}
 // The aggregate's own `history` section is unchanged: still `limited`/`unavailable`, never `present` (decision 6a until the consumer migration is accepted).
 const aggregate=await readFilmAggregate(env(world({lids:['l5']})),'tmdb_5');
 assert.deepEqual([aggregate.body.history.status,aggregate.body.history.reason,aggregate.body.history.href],['limited','history_migration_pending','/api/enrichment/history?filmId=tmdb_5']);
 const multi=await readFilmAggregate(env(world()),'tmdb_5');
 assert.deepEqual([multi.body.history.status,multi.body.history.href],['unavailable',undefined]);
 // The legacy route keeps its strict single-lid bridge and its offset cursor; its writers (Started, recovery) are not touched by this module.
 const legacyRoute=fs.readFileSync('src/enrichment.js','utf8');
 assert.ok(legacyRoute.includes('filmHistoryPageRequest(url.searchParams)')&&legacyRoute.includes('catalogFilmIdentityBridge'),'the legacy route still bridges strictly');
 const contractText=fs.readFileSync('docs/reference/api/film-history.md','utf8');
 assert.match(contractText,/Multi-alias history \(AIR-650/,'the reference states the offline contract');
 assert.match(contractText,/not live/i,'the reference says it is not live before the consumer migration');
}

console.log('film-history-aggregate: multi-alias history over the AIR-646 resolver and the AIR-647 candidate coverage; fact records are the shared G1 evidence; stable <storageId>|<sourceEventId> identities with deduplication; cursor bound to survivor, alias set, identity read-set, coverage token and source tokens; typed 409 history_changed (identity_moved, alias_set_changed, coverage_changed, source_changed); mandatory source tokens and E1 recheck incl. version evidence; bounded sources; value-based current status; incomplete coverage or Diary never present; pure read; dormant.');
