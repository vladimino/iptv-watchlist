// AIR-650 / ADR 0216 (Accepted), delivery graph step 6, decision 6a: the dormant multi-alias history reader and its cursor contract. ADR 0216 synthetic
// test 26 (complete multi-alias history across pages; cursor invalidation with alias_set_changed, coverage_changed, identity_moved or source_changed;
// Started and recovery keep their writer authorization), plus the GET audit and the dormancy of the module. Synthetic fixtures only, on the sqlite3-CLI D1
// stand-in over the full migration chain; the sources the activation card wires to the owning domains are in-memory readers here. Nothing touches the
// Worker bundle, R2, the network or production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {
 readFilmHistory,buildAliasHistory,parseHistoryPage,parseHistoryCursor,encodeHistoryCursor,historyCursorMismatch,historyEventId,
 FILM_HISTORY_AGGREGATE_CONTRACT,HISTORY_DEFAULT_LIMIT,HISTORY_MAX_LIMIT,HISTORY_CHANGED_REASONS,
} from '../src/film-history-aggregate.js';
import {readFilmAggregate} from '../src/film-aggregate.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-history-aggregate-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const AT='2026-11-25T10:00:00.000Z';
const q=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const sha256=text=>crypto.createHash('sha256').update(text).digest('hex');
const RUN='run-1';
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

// ---- the injected sources, over a mutable in-memory state ----
const stamp=value=>({status:'recorded',etag:sha256(JSON.stringify(value)),value});
const d=(day,h=10)=>'2026-09-'+String(day).padStart(2,'0')+'T'+String(h).padStart(2,'0')+':00:00.000Z';
const prediction=(day,rating,extra={})=>({predictedRating:rating,generatedAt:d(day),matchSignals:['s'],mainRisk:'r',moodLabels:[],tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintPromptVersion:'f1',runId:'run'+day,...extra});
const rating=(kind,id,value,day,previous=null)=>({kind,recordedAt:d(day),value,observedAt:d(day),source:'owner',sourceRef:null,observationId:id,previous});
const diaryEntry=(lid,date,extra={})=>({key:'day:lid:'+lid+'|'+date,identity:{type:'letterboxd_lid',value:lid},keyBasis:'identity_date',watchedDate:date,viewings:1,viewingsCertain:true,rewatch:false,rewatchRows:0,rewatchUnknownRows:0,aliases:[],firstObservedAt:d(28),observedAt:d(28),page:1,changes:[],...extra});
function world({lids=['a1','a2'],links=null,facts=null}={}){
 const file=blank();
 film(file,'film:tmdb:5',[['tmdb','5'],...lids.map(l=>['letterboxd',l])]);
 const index=links??Object.fromEntries([['tmdb:5','tmdb-5'],...lids.map(l=>['letterboxd:'+l,'tmdb-5'])]);
 putLinks(file,index);
 const keys=facts??{'tmdb-5':{links:{letterboxd:lids[0],tmdb:'5'}}};
 for(const [factKey,info] of Object.entries(keys))putRecord(file,factKey,info.links);
 view(file,'tmdb_5','tmdb-5');for(const l of lids)view(file,l,'tmdb-5');
 return file;
}
// The state of the sources for one world. `facts` follows the link index the way the legacy route does.
function state(lids=['a1','a2']){
 return {
  bundles:Object.fromEntries([...lids,'tmdb_5'].map(id=>[id,{current:null,history:[]}])),
  links:Object.fromEntries([['tmdb:5','tmdb-5'],...lids.map(l=>['letterboxd:'+l,'tmdb-5'])]),
  facts:{'tmdb-5':{links:{letterboxd:lids[0],tmdb:'5'},ratingHistory:[],rating:null}},
  legacy:[],profile:{version:1,profileHash:'p1'},diary:{schemaVersion:1,entries:{}},diaryState:{lastOutcome:'complete',coverage:{reachedEnd:true}},
 };
}
function sourcesOf(s,{unreadable=[],fail=null,versions=null,recheck=null}={}){
 const get=(name,value)=>unreadable.includes(name)?{status:'unreadable',etag:'x-'+name,value:null}:value==null?{status:'missing',etag:null,value:null}:stamp(value);
 return {
  async predictionBundle(id){if(fail==='prediction'){const e=new Error('boom');e.code='prediction_domain_unreadable';throw e;}return get('predictions',s.bundles[id]);},
  async factRecords(seeds){
   const out=[];
   for(const alias of seeds){const factKey=s.links[alias];if(factKey)out.push({alias,factKey,...stamp(s.facts[factKey])});}
   return out;
  },
  async legacyLog(){return get('legacyLog',s.legacy);},
  async profile(){return get('profile',s.profile);},
  async diaryHistory(){return get('diaryHistory',s.diary);},
  async diaryState(){return get('diaryState',s.diaryState);},
  ...(versions?{predictionVersion:versions}:{}),
  ...(recheck?{recheck}:{}),
  put(){throw new Error('history must not write');},delete(){throw new Error('history must not delete');},
 };
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

// A Film with two authorized lids (a1, a2) and tmdb 5, one shared fact key, predictions under every alias, a Diary of both lids and of a stranger.
function fixture(){
 const file=world(),s=state();
 s.bundles.a1={current:prediction(20,4),history:[prediction(1,3),prediction(5,3.5)]};
 s.bundles.a2={current:prediction(21,4.5),history:[prediction(2,2.5)]};
 s.bundles.tmdb_5={current:null,history:[prediction(3,3)]};
 s.facts['tmdb-5'].ratingHistory=[rating('first_observed','o1',4,6),rating('changed','o2',4.5,22,{value:4,observedAt:d(6),source:'owner',observationId:'o1'})];
 s.facts['tmdb-5'].rating={value:4.5,observedAt:d(22),source:'owner',observationId:'o2'};
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
let reference;
{
 const {file,s}=fixture();
 const whole=await history(file,'tmdb_5',s,{limit:100});
 assert.equal(whole.http,200);
 assert.equal(whole.body.contract,FILM_HISTORY_AGGREGATE_CONTRACT);
 assert.equal(whole.body.identity.verdict,'found');
 const h=whole.body.history;
 assert.deepEqual([h.status,h.coverage.status,h.partial],['present','complete',false]);
 assert.deepEqual(h.aliases,{lids:['a1','a2'],movies:['5'],storageIds:['a1','a2','tmdb_5']});
 const ids=h.events.map(e=>e.identity);
 assert.equal(new Set(ids).size,ids.length,'every event identity is unique');
 for(const e of h.events)assert.match(e.identity,/^[A-Za-z0-9_:-]+\|/,'<storageId>|<sourceEventId>');
 assert.ok(ids.includes('a1|prediction|current|0')&&ids.includes('a2|prediction|history|0')&&ids.includes('tmdb_5|prediction|history|0'));
 // One ratings fact reachable through three aliases is counted once; the aliases that reached it are named.
 const ratingEvents=h.events.filter(e=>e.type==='rating');
 assert.deepEqual(ratingEvents.map(e=>e.identity),['fact:tmdb-5|rating|a|o1|0','fact:tmdb-5|rating|a|o2|0']);
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
 // Order: by time, ties by type then identity; day-only Diary dates after every instant of that UTC date.
 const key=e=>e.at===null?'~':e.atPrecision==='day'?e.at+'T~':e.at;
 assert.deepEqual(h.events.map(key),[...h.events.map(key)].sort());
 // Current values: the two current predictions differ, so conflict with each value and its storage id; no winner.
 assert.equal(h.current.prediction.status,'conflict');
 assert.deepEqual(h.current.prediction.values.map(v=>v.storageId),['a1','a2']);
 assert.deepEqual([h.current.rating.status,h.current.rating.values.length,h.current.rating.values[0].value],['present',1,4.5]);
 assert.ok(h.notes.includes('prediction_current_in_several_storage_ids'));
 assert.ok(h.notes.includes('diary_absence_is_not_unwatched'));
 assert.ok(!h.notes.includes('coverage_incomplete'));
 reference=ids;

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
 // The aggregate envelope: another typed id of the same Film gives the same history.
 const byLid=await history(file,'a1',s,{limit:100});
 assert.deepEqual(byLid.body.history.events.map(e=>e.identity),ids);
}

// ---- Test 26b: every cursor invalidation, with its reason ----
const cursorOf=async(file,s,limit=3)=>(await history(file,'tmdb_5',s,{limit})).body.history.page.nextCursor;
const changed=(out,reason)=>{assert.equal(out.http,409,JSON.stringify(out.body).slice(0,300));assert.equal(out.body.error,'history_changed');assert.equal(out.body.reason,reason);assert.equal(out.body.history,undefined,'no events with a 409');};
{
 // source_changed: a source object changed between pages (a new Diary entry; an etag moves).
 const {file,s}=fixture();
 const cursor=await cursorOf(file,s);
 const entry=diaryEntry('a1','2026-09-30');s.diary={...s.diary,entries:{...s.diary.entries,[entry.key]:entry}};
 changed(await history(file,'tmdb_5',s,{limit:3,cursor}),'source_changed');
 // The restart without a cursor reads the new version in full.
 const pages=await allPages(file,'tmdb_5',s,3);
 assert.ok(pages.flatMap(p=>p.events.map(e=>e.identity)).includes('a1|diary|day:lid:a1|2026-09-30'));
}
{
 // source_changed also for a prediction bundle, a fact record and the legacy log.
 for(const mutate of [s=>{s.bundles.a2={...s.bundles.a2,history:[...s.bundles.a2.history,prediction(9,3)]};},s=>{s.facts['tmdb-5']={...s.facts['tmdb-5'],ratingHistory:[...s.facts['tmdb-5'].ratingHistory,rating('changed','o3',5,23)]};},s=>{s.legacy=[...s.legacy,{filmId:'a1',observedAt:d(11),before:4,after:4,source:'scan'}];}]){
  const {file,s}=fixture();
  const cursor=await cursorOf(file,s);
  mutate(s);
  changed(await history(file,'tmdb_5',s,{limit:3,cursor}),'source_changed');
 }
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
 const out=await history(file,'tmdb_5',s,{limit:3,cursor});
 changed(out,'identity_moved');
}
{
 // A valid cursor still answers while nothing it is bound to moved, however many times it is used; an offset past the total is refused.
 const {file,s}=fixture();
 const cursor=await cursorOf(file,s);
 for(let i=0;i<2;i++)assert.equal((await history(file,'tmdb_5',s,{limit:3,cursor})).http,200);
 const tokens=(await history(file,'tmdb_5',s,{limit:3})).body.history.tokens;
 const past=encodeHistoryCursor(999,tokens);
 const out=await history(file,'tmdb_5',s,{limit:3,cursor:past});
 assert.equal(out.http,400);
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
 assert.equal(h.current.rating.status,'partial','one value is never the single current value under incomplete coverage');
 assert.equal(h.current.prediction.status,'conflict','a known conflict is kept under incomplete coverage');
 assert.ok(h.events.every(e=>!JSON.stringify(e).includes('cand')),'the candidate alias is never read');
 assert.ok(h.page.nextCursor===null);
 // The same Film with a paged read: every page is partial, none present.
 const pages=await allPages(file,'tmdb_5',s,4);
 assert.ok(pages.every(p=>p.status==='partial'));
 // A seed absent from the link index is not proof of coverage.
 const {file:file2,s:s2}=fixture();
 putLinks(file2,{'tmdb:5':'tmdb-5','letterboxd:a1':'tmdb-5'});
 const out2=await history(file2,'tmdb_5',s2,{limit:100});
 assert.deepEqual([out2.body.history.status,out2.body.history.coverage.reason],['partial','seed_absent_unproved']);
 // No current value at all: `unknown`, never `absent`, with incomplete coverage.
 const {file:file3,s:s3}=fixture();
 s3.facts['tmdb-5']={...s3.facts['tmdb-5'],rating:null,ratingHistory:[]};
 putLinks(file3,{...s3.links,'letterboxd:cand':'tmdb-5'});
 const out3=await history(file3,'tmdb_5',s3,{limit:100});
 assert.equal(out3.body.history.current.rating.status,'unknown');
 const ok3=fixture();ok3.s.facts['tmdb-5']={...ok3.s.facts['tmdb-5'],rating:null,ratingHistory:[]};
 assert.equal((await history(ok3.file,'tmdb_5',ok3.s,{limit:100})).body.history.current.rating.status,'absent','absent only with complete coverage');
}
{
 // The ratings domain held: no history at all, never an empty one that reads as "nothing recorded".
 const {file,s}=fixture();
 sqlite(file,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 const out=await history(file,'tmdb_5',s,{limit:100});
 assert.equal(out.http,200);
 assert.deepEqual([out.body.history.status,out.body.history.reason,out.body.history.events],['unavailable','ratings_held',undefined]);
}

// ---- conflicts, a stranger's Diary and the other aliases ----
{
 // Two fact keys with two different current ratings: conflict with each value, no winner; one value per distinct fact.
 const links={'tmdb:5':'f1','letterboxd:a1':'f1','letterboxd:a2':'f2'};
 const file=world({links,facts:{f1:{links:{letterboxd:'a1',tmdb:'5'}},f2:{links:{letterboxd:'a2',tmdb:null}}}});
 const s=state();s.links=links;
 s.facts={f1:{links:{letterboxd:'a1',tmdb:'5'},rating:{value:4,observedAt:d(5),source:'owner',observationId:'x1'},ratingHistory:[rating('first_observed','x1',4,5)]},f2:{links:{letterboxd:'a2',tmdb:null},rating:{value:2,observedAt:d(6),source:'owner',observationId:'x2'},ratingHistory:[rating('first_observed','x2',2,6)]}};
 const h=(await history(file,'tmdb_5',s,{limit:100})).body.history;
 assert.equal(h.current.rating.status,'conflict');
 assert.deepEqual(h.current.rating.values.map(v=>[v.factKey,v.value]).sort(),[['f1',4],['f2',2]]);
 assert.deepEqual(h.events.filter(e=>e.type==='rating').map(e=>e.storageId),['fact:f1','fact:f2']);
}
{
 // A fact record naming a lid that is not an authorized alias: its Diary entries stay out and the lid is named in the notes.
 const {file,s}=fixture();
 s.facts['tmdb-5']={...s.facts['tmdb-5'],links:{letterboxd:'stranger',tmdb:'5'}};
 const entry=diaryEntry('stranger','2026-09-30');s.diary={...s.diary,entries:{...s.diary.entries,[entry.key]:entry}};
 const h=(await history(file,'tmdb_5',s,{limit:100})).body.history;
 assert.ok(h.notes.includes('diary_lid_not_authorized:stranger'));
 assert.ok(h.events.every(e=>e.storageId!=='stranger'&&!e.identity.startsWith('stranger|')));
}
{
 // The pure assembly: identical payloads under two aliases are two events; the same fact twice is one; a diverging payload under one identity is flagged.
 const bundle={current:prediction(20,4),history:[]};
 const built=buildAliasHistory({lids:['x','y'],movies:[],bundles:{x:bundle,y:bundle},coverageComplete:true});
 assert.equal(built.events.length,2);
 assert.deepEqual(built.events.map(e=>e.identity),['x|prediction|current|0','y|prediction|current|0']);
 assert.equal(built.current.prediction.status,'present','equal current values agree (C2)');
 const fact=(rating_)=>({factKey:'k',aliases:['letterboxd:x'],record:{ratingHistory:[rating_]}});
 const once=buildAliasHistory({lids:['x'],facts:[fact(rating('changed','o',4,5)),{...fact(rating('changed','o',4,5)),aliases:['tmdb:1']}],coverageComplete:true});
 assert.equal(once.events.length,1);assert.deepEqual(once.events[0].storageIds,['letterboxd:x','tmdb:1']);
 // A fact key is one record: the same key reached through two aliases is merged, the first record read is the one used.
 const merged=buildAliasHistory({lids:['x'],facts:[fact(rating('changed','o',4,5)),{...fact(rating('changed','o',5,5)),aliases:['tmdb:1']}],coverageComplete:true});
 assert.deepEqual([merged.events.length,merged.events[0].value,merged.events[0].storageIds],[1,4,['letterboxd:x','tmdb:1']]);
 assert.equal(historyEventId('a1','diary|k'),'a1|diary|k');
 assert.deepEqual(buildAliasHistory({lids:[],movies:[]}).events,[]);
}

// ---- sources: failure isolation, tokens re-read, versions ----
{
 const {file,s}=fixture();
 // A prediction source that fails: unavailable with its own reason, never an empty history.
 const failing=await history(file,'tmdb_5',s,{limit:100,source:{fail:'prediction'}});
 assert.equal(failing.http,200);
 assert.deepEqual([failing.body.history.status,failing.body.history.reason,failing.body.history.events],['unavailable','prediction_unavailable',undefined]);
 // An unreadable source (a stored object that is not JSON): partial, never present.
 const bad=await history(file,'tmdb_5',s,{limit:100,source:{unreadable:['diaryHistory']}});
 assert.deepEqual([bad.body.history.status,bad.body.history.reason],['partial','source_unreadable']);
 // A missing source is "nothing recorded", not an error.
 const missing={...s,diary:null};
 assert.equal((await history(file,'tmdb_5',missing,{limit:100})).body.history.status,'present');
 // E1: a source token that moved during the reads is generation_moved, never a mixed answer.
 const moved=await history(file,'tmdb_5',s,{limit:100,source:{recheck:async()=>false}});
 assert.deepEqual([moved.body.history.status,moved.body.history.reason],['unavailable','generation_moved']);
 const held=await history(file,'tmdb_5',s,{limit:100,source:{recheck:async list=>{assert.ok(list.length>=8);return true;}}});
 assert.equal(held.body.history.status,'present');
 // Version checks of the immutable bodies run for the events on the page only.
 const checked=[];
 const ver=await history(file,'tmdb_5',s,{limit:100,source:{versions:async(storageId,record)=>{checked.push(storageId);return {status:'linked',r2Key:record.r2Key,contentSha256:record.contentSha256};}}});
 assert.deepEqual(checked,[],'records without a pointer are not checked');
 s.bundles.a1={current:{...prediction(20,4),r2Key:'enrichment/films/a1/versions/v.json',contentSha256:'c'.repeat(64)},history:[]};
 const linked=await history(file,'tmdb_5',s,{limit:100,source:{versions:async(storageId,record)=>{checked.push(storageId);return {status:'linked',r2Key:record.r2Key,contentSha256:record.contentSha256};}}});
 assert.deepEqual(checked,['a1']);
 assert.equal(linked.body.history.events.find(e=>e.identity==='a1|prediction|current|0').version.status,'linked');
 assert.equal(linked.body.history.status,'present');
 const mismatch=await history(file,'tmdb_5',s,{limit:100,source:{versions:async()=>({status:'mismatch',r2Key:null,contentSha256:null})}});
 assert.deepEqual([mismatch.body.history.status,mismatch.body.history.reason],['partial','version_unverified']);
 const unchecked=await history(file,'tmdb_5',s,{limit:100});
 assert.equal(unchecked.body.history.events.find(e=>e.identity==='a1|prediction|current|0').version.status,'unchecked');
 assert.equal(ver.http,200);
}
{
 // No authorized storage id (a TV-only Film): `unknown`, the TV number is never a storage key.
 const file=blank();film(file,'film:tv9',[['tmdb_tv','9']]);
 const out=await history(file,'tmdb_tv:9',state([]));
 assert.equal(out.http,200);
 assert.deepEqual([out.body.history.status,out.body.history.reason],['unknown','no_authorized_alias']);
}
{
 // Every identity verdict of the resolver answers without a history; a bad id is 400.
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
 assert.ok(e.calls.queries<=40*5,'statements stay inside the request budget per call');
 const source=fs.readFileSync('src/film-history-aggregate.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)\b/i.test(source),'the module holds no write SQL');
 assert.ok(!/\b(fetch|BUCKET|\.put\(|\.delete\()/.test(source),'no network, no R2 and no write call');
}

// ---- Dormant: the legacy contract is untouched and nothing serves this reader ----
{
 const build=fs.readFileSync('build.mjs','utf8');
 assert.ok(!build.includes('src/film-history-aggregate.js'),'the module stays out of the bundle');
 for(const name of fs.readdirSync('src').filter(f=>f.endsWith('.js')&&f!=='film-history-aggregate.js'))
  assert.ok(!/film-history-aggregate/.test(fs.readFileSync('src/'+name,'utf8')),name+' must not import the dormant history reader');
 const worker=fs.readFileSync('src/worker.js','utf8');
 assert.ok(!worker.includes('film-history-aggregate')&&!worker.includes(FILM_HISTORY_AGGREGATE_CONTRACT),'the Worker routes no multi-alias history');
 if(fs.existsSync('dist/server/index.js'))assert.ok(!fs.readFileSync('dist/server/index.js','utf8').includes(FILM_HISTORY_AGGREGATE_CONTRACT),'the built bundle does not serve the reader');
 // The aggregate's own `history` section is unchanged: still `limited`/`unavailable`, never `present` (decision 6a until the consumer migration is accepted).
 const one=world({lids:['l5']});
 const aggregate=await readFilmAggregate(env(one),'tmdb_5');
 assert.deepEqual([aggregate.body.history.status,aggregate.body.history.reason,aggregate.body.history.href],['limited','history_migration_pending','/api/enrichment/history?filmId=tmdb_5']);
 const two=world();
 const multi=await readFilmAggregate(env(two),'tmdb_5');
 assert.deepEqual([multi.body.history.status,multi.body.history.href],['unavailable',undefined]);
 // The legacy route keeps its strict single-lid bridge and its offset cursor; its writers (Started, recovery) are not touched by this module.
 const legacyRoute=fs.readFileSync('src/enrichment.js','utf8');
 assert.ok(legacyRoute.includes("filmHistoryPageRequest(url.searchParams)")&&legacyRoute.includes('catalogFilmIdentityBridge'),'the legacy route still bridges strictly');
 const contractText=fs.readFileSync('docs/reference/api/film-history.md','utf8');
 assert.match(contractText,/Multi-alias history \(AIR-650/,'the reference states the offline contract');
 assert.match(contractText,/not live/i,'the reference says it is not live before the consumer migration');
}

console.log('film-history-aggregate: multi-alias history over the AIR-646 resolver and the AIR-647 candidate coverage; stable <storageId>|<sourceEventId> identities with deduplication; cursor bound to survivor, alias set, identity read-set, coverage token and source tokens; typed 409 history_changed (identity_moved, alias_set_changed, coverage_changed, source_changed); incomplete coverage never present; pure read; dormant.');
