// AIR-374 P3a (ADR 0127): the dormant DICTIONARY-STORE producer layer for canonical Film title and identity facts, on the sqlite3-CLI D1 stand-in. No Worker, R2, D1 or Cloudflare access. Covered: the snapshot digest and the pure plan,
// dormancy (one marker read below open, held throws), the pure builder with every named outcome (absent, redirected, identity_mismatch, kept, owner and reviewed rows kept, unranked and higher-precedence titles kept, lower-ranked values
// replaced and named), the applied path through the receipt adapter (one atomic batch with the receipt, no-op without a receipt, snapshot-bound request ids), a bounded resumable pass, own-origin reconcile bound to the snapshot, and the
// static dormancy checks. DICT_SRC points the file at a mutant copy of src/ (tests/canonical-dictionary-producer-mutation.mjs); DICT_TEMPLATE a prebuilt template database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.DICT_SRC?path.resolve(process.env.DICT_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const {readAuthority}=await load('film-person-authority.js');
const {PRODUCER_WIRING,PRODUCER_OPERATIONS}=await load('canonical-producers.js');
const {producerRequestId,filmFactsDigest,digestOf}=await load('canonical-producer-adapters.js');
const D=await load('canonical-dictionary-producer.js');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-dict-producer-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
if(process.env.DICT_TEMPLATE)fs.copyFileSync(process.env.DICT_TEMPLATE,template);
else{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
let n=0;
function database(stage='open'){
 const file=path.join(root,'e-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['r2','prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='open')assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const T='2026-11-11T10:00:00.000Z';
const iso=ms=>new Date(Date.parse(T)+ms).toISOString();
const ID=k=>'film:tmdb:'+k;
const receipts=file=>rows(file,'SELECT request_id,operation,origin,target_id,state,attempts,applied_revision,error_class FROM canonical_write_receipt ORDER BY target_id,created_at');
const revision=(file,id)=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+id+"'")??0);
const dump=file=>JSON.stringify(['film','film_metadata','film_sync_state','watchlist_film','film_dimension','canonical_revision','canonical_write_receipt'].map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2')]));
const U='2026-11-01T00:00:00.000Z';
const entry=(k,over={})=>({id:'D'+k,filmId:ID(k),tmdbId:String(k),original:'Orig '+k,title:'Рус '+k,aliases:[],sources:['https://example.test/'+k],status:'verified',...over});
const plan=(entries,over={})=>D.planDictionaryUnits({version:'v1',entries,at:T,...over});
const q=value=>value===null||value===undefined?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
// A stored Film: the film row, an optional trusted tmdb id, the identity dimension (with a titleSource) and the localization dimension.
function seed(file,k,{title=null,identity=null,trusted=String(k),source=undefined,authority=null,status='provisional',loc=null,dim=true}={}){
 const id=ID(k);
 let sql="INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ("+q(id)+",1,"+q(identity)+","+q(title)+","+q(U)+");";
 if(trusted)sql+="INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ("+q(id)+",'tmdb',"+q(trusted)+",1,0);";
 if(dim)sql+="INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,authority,attempts,next_action,updated_at) VALUES ("+q(id)+",'identity',"+q(status)+",NULL,"+q(source?JSON.stringify({titleSource:{source,at:U}}):null)+","+q(authority)+",0,'none',"+q(U)+");";
 if(loc)sql+="INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(id)+",'localization',"+q(loc.status)+","+q(loc.source)+",NULL,"+q(loc.authority?JSON.stringify({authority:loc.authority}):null)+","+q(loc.value)+","+q(loc.authority||null)+",0,'none',"+q(U)+");";
 assert.equal(sqlite(file,sql).status,0,sql);
}
const filmRow=(file,k)=>rows(file,"SELECT contract_version,canonical_identity,original_title,updated_at FROM film WHERE id='"+ID(k)+"'")[0];
const titleSource=(file,k)=>{const text=one(file,"SELECT provenance_json FROM film_dimension WHERE film_id='"+ID(k)+"' AND dimension='identity'");return text?JSON.parse(text).titleSource?.source??null:null;};
const locRow=(file,k)=>rows(file,"SELECT status,source,source_version,value,authority FROM film_dimension WHERE film_id='"+ID(k)+"' AND dimension='localization'")[0];
const filmCount=(file,id)=>one(file,"SELECT COUNT(*) FROM film WHERE id='"+id+"'");
const reasons=out=>out.conflicts.map(item=>item.field+':'+item.reason+':'+item.kind).sort();

// 1. The snapshot and the pure plan: the event carries the version AND the digest of the whole curated snapshot; sorted by Film id; duplicates, non-reviewed and malformed entries refused.
{
 const entries=[entry(3),entry(1),entry(2)];
 const p=await plan(entries);
 assert.deepEqual(p.units.map(unit=>unit.id),[ID(1),ID(2),ID(3)]);
 assert.match(p.event,/^dictionary:v1:[0-9a-f]{64}$/);
 assert.equal(p.event,'dictionary:'+p.snapshot.version+':'+p.snapshot.digest);
 assert.deepEqual([p.snapshot.version,p.snapshot.count,p.at],['v1',3,T]);
 assert.equal(JSON.stringify(await plan([...entries].reverse())),JSON.stringify(p),'input order does not matter');
 assert.equal((await plan(entries)).event,p.event,'the same snapshot is the same event');
 assert.notEqual((await plan(entries,{version:'v2'})).event,p.event,'another version label is another event');
 assert.notEqual((await plan([entry(3),entry(1),entry(2,{aliases:['x']})])).event,p.event,'an alias edit is another snapshot (aliases are dictionary content)');
 assert.notEqual((await plan([entry(3),entry(1),entry(2,{sources:[]})])).event,p.event);
 assert.notEqual((await plan([entry(3),entry(1),entry(2,{title:'Другое'})])).event,p.event);
 assert.equal((await D.dictionarySnapshot({version:'v1',entries})).digest,p.snapshot.digest);
 assert.equal(p.snapshot.digest,await digestOf({operation:'dictionary_snapshot',version:'v1',entries:p.units.map(unit=>unit.entry)}));
 assert.deepEqual(p.units[0].entry,{id:'D1',filmId:ID(1),tmdbId:'1',original:'Orig 1',title:'Рус 1',aliases:[],sources:['https://example.test/1'],status:'verified'});
 assert.deepEqual((await plan([entry(1,{tmdbId:7,original:'  Padded  ',title:null})])).units[0].entry,{id:'D1',filmId:ID(1),tmdbId:'7',original:'Padded',title:null,aliases:[],sources:['https://example.test/1'],status:'verified'});
 assert.equal((await plan([{id:'x',filmId:ID(9),original:'O',status:'verified'}])).units[0].entry.tmdbId,null);
 const bad=[[entry(1,{status:'provisional'})],[entry(1,{status:undefined})],[entry(1,{filmId:'tmdb:1'})],[entry(1,{filmId:undefined})],[entry(1,{id:''})],[entry(1,{id:'x'.repeat(65)})],[entry(1,{id:7})],[entry(1,{tmdbId:'0'})],[entry(1,{tmdbId:'12x'})],[entry(1,{original:'',title:' '})],[entry(1,{original:null,title:null})],[entry(1,{aliases:'x'})],[entry(1,{aliases:[3]})],[entry(1,{sources:['']})],[entry(1,{sources:Array(11).fill('s')})],[entry(1,{aliases:Array(51).fill('a')})],[null],['x'],[entry(1),entry(1)],[entry(1),entry(1,{id:'Dx'})],[entry(1),entry(2,{id:'D1'})]];
 for(const entries of bad)await assert.rejects(()=>plan(entries),code('film_person_invalid'),JSON.stringify(entries).slice(0,80));
 for(const over of [{version:''},{version:'a b'},{version:'x'.repeat(81)},{version:7},{at:''},{at:5},{entries:'x'}])await assert.rejects(()=>plan([entry(1)],over),code('film_person_invalid'),JSON.stringify(over));
 await assert.rejects(()=>D.planDictionaryUnits({at:T,entries:[]}),code('film_person_invalid'));
 assert.deepEqual((await plan([])).units,[]);
 assert.equal(D.dictionaryUnitCap(1000),D.DICTIONARY_UNIT_HARD_CAP);assert.equal(D.dictionaryUnitCap(0),1);assert.equal(D.dictionaryUnitCap(undefined),1);assert.equal(D.dictionaryUnitCap(-5),1);assert.equal(D.dictionaryUnitCap(7),7);
 assert.ok(D.DICTIONARY_UNIT_LIMIT_DEFAULT<=D.DICTIONARY_UNIT_HARD_CAP&&D.DICTIONARY_UNIT_HARD_CAP<=80);
 assert.deepEqual([D.DICTIONARY_ORIGIN,D.DICTIONARY_SOURCE,D.DICTIONARY_SOURCE_VERSION],['dictionary','dictionary','verified']);
}

// 2. Dormancy: below open a pass and an inline reconcile each cost exactly one marker read; held throws; a malformed call reads nothing.
for(const stage of ['r2','prepared']){
 const file=database(stage),before=dump(file);
 const probe=envOf(file);await readAuthority(probe);
 const markerQueries=probe.DB.calls.queries;
 const seen=[];
 const env=envOf(file,{onQuery:async statement=>{seen.push(statement);}});
 const p=await plan([entry(1)]);
 const done=await D.applyDictionaryUnits(env,{plan:p,now:()=>T});
 assert.deepEqual([done.skipped,done.reason,done.cursor,done.done],[true,'projector_is_writer',0,false],stage);
 assert.equal(env.DB.calls.queries,markerQueries,stage+': exactly one marker read');
 assert.ok(seen.every(statement=>/^\s*SELECT/i.test(statement)));assert.equal(env.DB.calls.batches,0);
 assert.equal((await D.reconcileDictionary(env,{plan:p})).skipped,true);
 assert.equal(env.DB.calls.queries,2*markerQueries);
 assert.equal(dump(file),before,stage+': nothing written');
}
{
 const env=envOf(database('held'));const p=await plan([entry(1)]);
 await assert.rejects(()=>D.applyDictionaryUnits(env,{plan:p}),code('film_person_held'));
 await assert.rejects(()=>D.reconcileDictionary(env,{plan:p}),code('film_person_held'));
 assert.equal(env.DB.calls.batches,0);
 const open=envOf(database('open')),good=await plan([entry(1)]);
 for(const bad of [{plan:null},{plan:{units:[]}},{plan:{units:'x',event:'e',at:T}},{plan:{units:[],event:'e'}},{plan:{units:[],at:T}},{plan:good,cursor:-1},{plan:good,cursor:1.5}])
  await assert.rejects(()=>D.applyDictionaryUnits(open,bad),code('film_person_invalid'),JSON.stringify(Object.keys(bad)));
 assert.equal(open.DB.calls.queries,0,'a malformed call reads nothing');
}

// 3. The pure builder over stored rows: every named outcome.
{
 const unit={id:ID(1),entry:entry(1)};
 const film=(over={})=>({id:ID(1),contract_version:3,canonical_identity:null,original_title:null,updated_at:U,...over});
 const snap=(over={})=>({id:ID(1),film:film(),redirect:null,dimensions:{identity:{status:'provisional',authority:null,provenance_json:null}},trustedTmdb:['1'],...over});
 const build=(snapshot,u=unit)=>D.buildDictionaryInput(snapshot,u,{at:T});
 const ts=source=>JSON.stringify({titleSource:{source,at:U}});
 assert.equal(build(snap({film:null})).outcome,'absent');assert.equal(build(snap({film:film({contract_version:null})})).outcome,'absent');
 assert.equal(build(snap({redirect:'film:x'})).outcome,'redirected');assert.equal(build(snap({redirect:'film:x',film:null})).outcome,'redirected');
 for(const over of [{trustedTmdb:['2']},{film:film({canonical_identity:'tmdb:2'})}]){
  const r=build(snap(over));assert.equal(r.outcome,'identity_mismatch',JSON.stringify(over));assert.deepEqual(reasons(r),['identity:identity_mismatch:kept']);assert.equal(r.input,undefined);
 }
 assert.equal(build(snap({trustedTmdb:['2','1']})).outcome,'proceed','a stored Film may hold several trusted ids; the entry matches one');
 // fill: every field of an empty Film
 const fill=build(snap());
 assert.equal(fill.outcome,'proceed');assert.deepEqual(fill.conflicts,[]);
 assert.deepEqual(fill.input.film,{contractVersion:3,canonicalIdentity:'tmdb:1',originalTitle:'Orig 1',source:'dictionary'},'the stored contract version is carried, never a constant');
 assert.equal(fill.input.updatedAt,T,'the Film row changes: the clock moves');assert.equal(fill.input.id,ID(1));assert.equal(fill.input.at,T);
 assert.deepEqual(fill.input.localization.state,{dimension:'localization',status:'reviewed',source:'dictionary',sourceVersion:'verified',provenance:{authority:'dictionary',sources:['https://example.test/1']},value:'Рус 1',updatedAt:T,attempts:0,nextAction:'keep_reviewed'});
 assert.equal(Object.keys(fill.input).sort().join(),'at,film,id,localization,updatedAt','membership, metadata and sync are never part of a dictionary unit');
 // identity not provable: no trusted id of that Film
 let r=build(snap({trustedTmdb:[]}));assert.equal(r.outcome,'proceed');assert.equal(r.input.film.canonicalIdentity,undefined);assert.deepEqual(reasons(r),['canonicalIdentity:needs_trusted_tmdb_id:kept']);
 assert.equal(r.input.film.originalTitle,'Orig 1');
 // identity already stored and equal: nothing to write for it; a Film without a tmdb id in the entry keeps its own
 r=build(snap({film:film({canonical_identity:'tmdb:1'})}));assert.equal(r.input.film.canonicalIdentity,undefined);
 r=build(snap({film:film({canonical_identity:'tmdb:9'}),trustedTmdb:[]}),{id:ID(1),entry:entry(1,{tmdbId:null})});assert.equal(r.outcome,'proceed');assert.equal(r.input.film.canonicalIdentity,undefined);
 // titles
 const withTitle=(title,source,identity={})=>snap({film:film({original_title:title,canonical_identity:'tmdb:1'}),dimensions:{identity:{status:'provisional',authority:null,provenance_json:source?ts(source):null,...identity}}});
 r=build(withTitle('Orig 1','tmdb'));assert.equal(r.input.film.originalTitle,'Orig 1');assert.equal(r.input.updatedAt,U,'a restated title leaves the Film row (and its clock) alone');assert.deepEqual(reasons(r),[]);
 assert.equal(build(snap({film:film({original_title:'Orig 1'}),dimensions:{}})).input.film.originalTitle,undefined,'the same title with no identity row: nothing to restate');
 r=build(snap({dimensions:{}}));assert.deepEqual(reasons(r),['originalTitle:no_identity_row:kept']);assert.equal(r.input.film.originalTitle,undefined);assert.equal(r.input.film.canonicalIdentity,'tmdb:1');
 r=build(withTitle('Old','tmdb'));assert.deepEqual(reasons(r),['originalTitle:replaced_lower:replaced']);assert.equal(r.conflicts[0].from,'tmdb');assert.equal(r.input.film.originalTitle,'Orig 1');
 for(const source of ['letterboxd','watchlist','epg','discovery','dictionary']){r=build(withTitle('Old',source));assert.deepEqual(reasons(r),['originalTitle:replaced_lower:replaced'],source);}
 assert.equal(build(withTitle('Old','dictionary')).conflicts[0].from,'dictionary');
 r=build(withTitle('Old','owner'));assert.deepEqual(reasons(r),['originalTitle:owner_kept:kept']);assert.equal(r.input.film.originalTitle,undefined);
 r=build(withTitle('Old',null));assert.deepEqual(reasons(r),['originalTitle:unranked_kept:kept']);assert.equal(r.input.film.originalTitle,undefined);
 r=build(withTitle('Old','tmdb',{status:'reviewed'}));assert.deepEqual(reasons(r),['originalTitle:reviewed_kept:kept']);
 r=build(withTitle('Old','tmdb',{authority:'owner'}));assert.deepEqual(reasons(r),['originalTitle:owner_kept:kept']);
 r=build(withTitle('Old','dictionary',{status:'reviewed',authority:'dictionary'}));assert.deepEqual(reasons(r),['originalTitle:reviewed_kept:kept']);
 r=build(withTitle('Old','mystery'));assert.deepEqual(reasons(r),['originalTitle:replaced_lower:replaced']);assert.equal(r.input.film.originalTitle,'Orig 1','an unlisted stored source ranks below every listed one');
 // localization
 const loc=(row,over={})=>snap({dimensions:{identity:{status:'provisional',authority:null,provenance_json:null},localization:row},...over});
 r=build(loc({status:'reviewed',authority:'owner',value:'Мое',source:'owner'}));assert.deepEqual(reasons(r),['localization:owner_kept:kept']);assert.equal(r.input.localization,undefined);
 r=build(loc({status:'provisional',authority:'owner',value:'Мое',source:'owner'}));assert.deepEqual(reasons(r),['localization:owner_kept:kept'],'owner authority alone protects the row');
 r=build(loc({status:'reviewed',authority:'dictionary',value:'Старое',source:'dictionary'}));assert.deepEqual(reasons(r),['localization:replaced_reviewed:replaced']);assert.equal(r.input.localization.state.value,'Рус 1');
 r=build(loc({status:'provisional',authority:null,value:'Старое',source:'wikidata'}));assert.deepEqual(reasons(r),['localization:replaced_automatic:replaced']);
 r=build(loc({status:'provisional',authority:null,value:'Рус 1',source:'wikidata'}));assert.deepEqual(reasons(r),[],'the same value is not a conflict');
 r=build(loc({status:'provisional',authority:null,value:null,source:'wikidata'}));assert.deepEqual(reasons(r),[],'a blank stored value is not a conflict');
 // nothing to hand the writer
 r=build(snap({trustedTmdb:[],dimensions:{}}),{id:ID(1),entry:entry(1,{title:null})});assert.equal(r.outcome,'kept');assert.deepEqual(reasons(r),['canonicalIdentity:needs_trusted_tmdb_id:kept','originalTitle:no_identity_row:kept']);
 r=build(loc({status:'reviewed',authority:'owner',value:'Мое',source:'owner'},{film:film({original_title:'Old',canonical_identity:'tmdb:1'}),dimensions:{identity:{status:'reviewed',authority:'owner',provenance_json:ts('owner')},localization:{status:'reviewed',authority:'owner',value:'Мое',source:'owner'}}}));
 assert.equal(r.outcome,'kept');assert.deepEqual(reasons(r),['localization:owner_kept:kept','originalTitle:owner_kept:kept']);
 // a title fill alone moves the Film clock; an identity fill alone does too; a title restate alone does not
 r=build(snap({film:film({canonical_identity:'tmdb:1'})}),{id:ID(1),entry:entry(1,{title:null})});assert.deepEqual([r.input.film.originalTitle,r.input.updatedAt,r.input.localization],['Orig 1',T,undefined]);
 r=build(snap({dimensions:{}}),{id:ID(1),entry:entry(1,{title:null})});assert.deepEqual([r.outcome,r.input.film.canonicalIdentity,r.input.film.originalTitle,r.input.updatedAt],['proceed','tmdb:1',undefined,T],'an identity fill alone is something to write');
 // an entry with only a localization or only an original title
 r=build(snap({trustedTmdb:[]}),{id:ID(1),entry:entry(1,{tmdbId:null,original:null})});assert.deepEqual([r.outcome,r.input.film.originalTitle,r.input.film.canonicalIdentity,!!r.input.localization],['proceed',undefined,undefined,true]);
 r=build(snap(),{id:ID(1),entry:entry(1,{tmdbId:null,title:null})});assert.deepEqual([r.outcome,r.input.film.originalTitle,!!r.input.localization],['proceed','Orig 1',false]);
 for(const badCall of [[null,unit],[snap(),null],[snap(),{}]])assert.throws(()=>D.buildDictionaryInput(badCall[0],badCall[1],{at:T}),code('film_person_invalid'));
 assert.throws(()=>D.buildDictionaryInput(snap(),unit,{}),code('film_person_invalid'));
}

// 4. open: the applied path. One unit, ONE atomic batch with the receipt (a pending insert and the writer batch), a title, its titleSource, the identity and the reviewed localization, all through writeFilmFacts. Absent Films are never created.
{
 const file=database('open');
 seed(file,1);seed(file,2,{title:'Orig 2',source:'tmdb',identity:'tmdb:2',loc:{status:'provisional',source:'wikidata',value:'Старое'}});
 const p=await plan([entry(1),entry(2),entry(3),entry(4,{tmdbId:null})]);
 assert.deepEqual(p.units.map(unit=>unit.id),[ID(1),ID(2),ID(3),ID(4)]);
 const env=envOf(file);
 const out=await D.applyDictionaryUnits(env,{plan:p,now:()=>T});
 assert.deepEqual([out.skipped,out.done,out.cursor,out.stoppedBy,out.failures.length],[false,true,4,null,0]);
 assert.deepEqual(out.counts,{applied:2,noop:0,already:0,unknown:0,failed:0,pending:0,absent:2,redirected:0,identity_mismatch:0,kept:0});
 assert.equal(env.DB.calls.batches,4,'two batches per changed Film: the pending receipt and the writer own batch');
 assert.deepEqual(filmRow(file,1),{contract_version:1,canonical_identity:'tmdb:1',original_title:'Orig 1',updated_at:T});
 assert.equal(titleSource(file,1),'dictionary');
 assert.deepEqual(locRow(file,1),{status:'reviewed',source:'dictionary',source_version:'verified',value:'Рус 1',authority:'dictionary'});
 assert.equal(filmCount(file,ID(3)),0,'a Film the store does not hold is never created');assert.equal(filmCount(file,ID(4)),0);
 assert.equal(revision(file,ID(3)),0);
 assert.equal(titleSource(file,2),'dictionary','the same title restated from a higher-ranked source moves the provenance');
 assert.deepEqual(filmRow(file,2),{contract_version:1,canonical_identity:'tmdb:2',original_title:'Orig 2',updated_at:U},'the Film row of a restated title is not rewritten');
 assert.deepEqual(locRow(file,2),{status:'reviewed',source:'dictionary',source_version:'verified',value:'Рус 2',authority:'dictionary'});
 assert.deepEqual(out.conflicts.map(item=>item.id+':'+item.reason),[ID(2)+':replaced_automatic']);
 const list=receipts(file);
 assert.equal(list.length,2);
 assert.ok(list.every(item=>item.origin==='dictionary'&&item.operation==='film_facts'&&item.state==='applied'&&item.applied_revision===1&&/^dictionary:film_facts:[0-9a-f]{64}$/.test(item.request_id)));
 assert.deepEqual([revision(file,ID(1)),revision(file,ID(2))],[1,1]);
 assert.equal(one(file,"SELECT COUNT(*) FROM watchlist_film"),0,'membership is never touched');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_metadata")+one(file,"SELECT COUNT(*) FROM film_sync_state"),0,'neither are metadata or sync clocks');
 // The same snapshot again, and a NEW version of identical content: every unit is a no-op before any receipt (E5): no batch, no row, no revision.
 const stable=dump(file);
 for(const version of ['v1','v2']){
  const again=envOf(file),repeat=await D.applyDictionaryUnits(again,{plan:await plan([entry(1),entry(2),entry(3),entry(4,{tmdbId:null})],{version}),now:()=>T});
  assert.deepEqual([repeat.counts.noop,repeat.counts.absent,repeat.counts.applied,again.DB.calls.batches],[2,2,0,0],version);
  assert.equal(dump(file),stable,version+': nothing moves');
 }
}

// 5. Owned facts are preserved: an owner identity row and an owner localization row, or an owner title source, are never overwritten; the outcome is named and no receipt, batch or revision exists.
{
 const file=database('open');
 seed(file,1,{title:'Mine',source:'owner',identity:'tmdb:1',status:'reviewed',authority:'owner',loc:{status:'reviewed',source:'owner',authority:'owner',value:'Моё'}});
 seed(file,2,{title:'Mine',source:'owner',identity:'tmdb:2',loc:{status:'provisional',source:'wikidata',value:'Старое'}});
 seed(file,3,{title:'Rev',source:'dictionary',identity:'tmdb:3',status:'reviewed',authority:'dictionary',loc:{status:'reviewed',source:'owner',authority:'owner',value:'Моё 3'}});
 const before=dump(file),env=envOf(file);
 const out=await D.applyDictionaryUnits(env,{plan:await plan([entry(1),entry(2,{title:'Рус 2'}),entry(3)]),now:()=>T});
 assert.deepEqual(out.counts,{applied:1,noop:0,already:0,unknown:0,failed:0,pending:0,absent:0,redirected:0,identity_mismatch:0,kept:2});
 assert.deepEqual(out.conflicts.map(item=>item.id+':'+item.field+':'+item.reason+':'+item.kind),[ID(1)+':originalTitle:owner_kept:kept',ID(1)+':localization:owner_kept:kept',ID(2)+':originalTitle:owner_kept:kept',ID(2)+':localization:replaced_automatic:replaced',ID(3)+':originalTitle:reviewed_kept:kept',ID(3)+':localization:owner_kept:kept']);
 assert.deepEqual([filmRow(file,1).original_title,locRow(file,1).value,titleSource(file,1)],['Mine','Моё','owner']);
 assert.deepEqual([filmRow(file,2).original_title,titleSource(file,2),locRow(file,2).value],['Mine','owner','Рус 2'],'an owner title source keeps the title while the lower localization is replaced');
 assert.deepEqual([filmRow(file,3).original_title,locRow(file,3).value],['Rev','Моё 3']);
 assert.equal(receipts(file).length,1,'only the one unit that writes has a receipt');
 assert.equal(revision(file,ID(1)),0);assert.equal(revision(file,ID(3)),0);assert.equal(revision(file,ID(2)),1);
 // kept units are stable too: nothing more is written by a second pass.
 const second=envOf(file);
 const again=await D.applyDictionaryUnits(second,{plan:await plan([entry(1),entry(2,{title:'Рус 2'}),entry(3)]),now:()=>T});
 assert.deepEqual([again.counts.kept,again.counts.noop,second.DB.calls.batches],[2,1,0]);
 assert.ok(dump(file)!==before);
}

// 6. Conflicts and precedence through the writer: a lower-ranked title is replaced and the provenance follows it; an unranked or missing provenance is kept; a mismatching Film gets nothing; a redirect is refused.
{
 const file=database('open');
 seed(file,1,{title:'Old',source:'tmdb',identity:'tmdb:1'});
 seed(file,2,{title:'Old',identity:'tmdb:2'});
 seed(file,3,{title:'Old',source:'discovery',identity:null,trusted:null,dim:false});
 seed(file,4,{title:null,identity:null,trusted:'999'});
 seed(file,5,{title:'Old',source:'epg'});
 seed(file,6,{title:null});
 assert.equal(sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+ID(6)+"','"+ID(5)+"','"+U+"')").status,0);
 const env=envOf(file);
 const out=await D.applyDictionaryUnits(env,{plan:await plan([entry(1),entry(2),entry(3),entry(4),entry(5),entry(6)]),now:()=>T});
 assert.deepEqual(out.counts,{applied:4,noop:0,already:0,unknown:0,failed:0,pending:0,absent:0,redirected:1,identity_mismatch:1,kept:0});
 assert.deepEqual([filmRow(file,1).original_title,titleSource(file,1)],['Orig 1','dictionary'],'a tmdb title is replaced by the dictionary and the provenance follows it');
 assert.equal(JSON.parse(one(file,"SELECT provenance_json FROM film_dimension WHERE film_id='"+ID(1)+"' AND dimension='identity'")).titleSource.at,T);
 assert.deepEqual([filmRow(file,2).original_title,titleSource(file,2)],['Old',null],'a stored title with no provenance is kept (unranked)');
 assert.deepEqual([locRow(file,2).value,locRow(file,2).authority],['Рус 2','dictionary'],'its localization still applies');
 assert.deepEqual([filmRow(file,3).original_title,filmRow(file,3).canonical_identity,locRow(file,3).value],['Old',null,'Рус 3'],'no identity row: the title is kept; no trusted id: the identity is not claimed');
 assert.deepEqual(filmRow(file,4),{contract_version:1,canonical_identity:null,original_title:null,updated_at:U},'a Film of another tmdb id is untouched');
 assert.equal(locRow(file,4),undefined);
 assert.deepEqual([filmRow(file,5).original_title,titleSource(file,5)],['Orig 5','dictionary']);
 assert.deepEqual(filmRow(file,6),{contract_version:1,canonical_identity:null,original_title:null,updated_at:U},'a redirected Film is refused');
 assert.equal(revision(file,ID(4)),0);assert.equal(revision(file,ID(6)),0);
 assert.deepEqual(out.conflicts.map(item=>item.id.slice(-1)+':'+item.reason).sort(),['1:replaced_lower','2:unranked_kept','3:needs_trusted_tmdb_id','3:no_identity_row','4:identity_mismatch','5:replaced_lower']);
 assert.equal(receipts(file).length,4);
}

// 7. Snapshot-bound request ids (the request id also binds the PLANNED CONTENT: what is handed to the writer, so a stored-state change that changes it is another request, never a replay of stale content): a dictionary edit under another version, A to B to A, is three requests (a content-only id would flip back to the first and read applied); the same snapshot is the same request.
{
 const file=database('open');
 seed(file,1);
 const mk=(version,title)=>plan([entry(1,{title})],{version});
 const A1=await mk('v1','Один'),B=await mk('v2','Два'),A2=await mk('v3','Один');
 for(const p of [A1,B,A2]){const out=await D.applyDictionaryUnits(envOf(file),{plan:p,now:()=>iso(0)});assert.equal(out.counts.applied,1,p.event);}
 assert.deepEqual(locRow(file,1).value,'Один');
 const list=receipts(file);
 assert.equal(list.length,3);assert.equal(new Set(list.map(item=>item.request_id)).size,3);assert.deepEqual(list.map(item=>item.applied_revision).sort(),[1,2,3]);
 const same=await D.applyDictionaryUnits(envOf(file),{plan:A1,now:()=>iso(0)});
 assert.equal(same.counts.noop,1,'the first snapshot again: the facts are stored, nothing is written');assert.equal(receipts(file).length,3);
 assert.notEqual(A1.event,A2.event);
 // The same request after another actor moved the Film: counted `already`, not rewritten.
 const file2=database('open');seed(file2,1);
 const P=await plan([entry(1,{tmdbId:null})]);
 assert.equal((await D.applyDictionaryUnits(envOf(file2),{plan:P,now:()=>iso(0)})).counts.applied,1);
 assert.equal(sqlite(file2,"UPDATE film_dimension SET value='Другое' WHERE film_id='"+ID(1)+"' AND dimension='localization'").status,0);
 const replayed=envOf(file2),again=await D.applyDictionaryUnits(replayed,{plan:P,now:()=>iso(0)});
 assert.deepEqual([again.counts.already,again.counts.applied,replayed.DB.calls.batches,locRow(file2,1).value],[1,0,0,'Другое']);
 assert.notEqual(A1.event,A2.event);
}

// 8. A bounded, resumable pass: two units per call, the cursor, the ceiling, a refusal of one unit isolated, a held marker stopping the pass on its unit.
{
 const file=database('open');
 for(const k of [1,2,3,4,5])seed(file,k);
 const p=await plan([1,2,3,4,5].map(k=>entry(k)));
 const env=envOf(file);
 const first=await D.applyDictionaryUnits(env,{plan:p,limit:2,now:()=>T});
 assert.deepEqual([first.cursor,first.done,first.counts.applied],[2,false,2]);
 assert.equal(filmRow(file,3).original_title,null,'the third Film is not visited yet');
 const second=await D.applyDictionaryUnits(env,{plan:p,cursor:first.cursor,limit:2,now:()=>T});
 assert.deepEqual([second.cursor,second.done,second.counts.applied,second.counts.noop],[4,false,2,0],'a resumed pass starts at the cursor: nothing is revisited');
 const third=await D.applyDictionaryUnits(env,{plan:p,cursor:4,limit:1000,now:()=>T});
 assert.deepEqual([third.cursor,third.done,third.counts.applied],[5,true,1]);
 const none=await D.applyDictionaryUnits(env,{plan:p,cursor:5,now:()=>T});assert.deepEqual([none.cursor,none.done],[5,true]);
 // the ceiling: more units than the hard cap, a huge limit visits exactly the cap
 const many=await plan(Array.from({length:D.DICTIONARY_UNIT_HARD_CAP+5},(_,i)=>entry(100+i)));
 const wide=await D.applyDictionaryUnits(envOf(database('open')),{plan:many,limit:100000,now:()=>T});
 assert.deepEqual([wide.cursor,wide.done,wide.counts.absent],[D.DICTIONARY_UNIT_HARD_CAP,false,D.DICTIONARY_UNIT_HARD_CAP]);
 const dflt=await D.applyDictionaryUnits(envOf(database('open')),{plan:many,now:()=>T});assert.equal(dflt.cursor,D.DICTIONARY_UNIT_LIMIT_DEFAULT);
 // a refusal isolates one unit: a malformed stored row (contract 'x'): a failing read for it, the others apply
 const file2=database('open');
 for(const k of [1,2,3])seed(file2,k);
 const bad=await plan([entry(1),entry(2),entry(3)]);
 bad.units[1]={id:'film:',entry:bad.units[1].entry};
 const refused=await D.applyDictionaryUnits(envOf(file2),{plan:bad,now:()=>T});
 assert.deepEqual([refused.done,refused.counts.applied,refused.counts.failed,refused.failures.length,refused.failures[0].code],[true,2,1,1,'film_person_invalid']);
 // held mid-pass: the marker moves after the first Film; the pass stops ON the unit that met it, cursor kept, the unit is not counted
 const file3=database('open');
 for(const k of [1,2])seed(file3,k);
 let flipped=false,held=null;
 held=envOf(file3,{onQuery:async statement=>{if(!flipped&&held.DB.calls.batches>=2&&/film_person_authority/.test(statement)){flipped=true;assert.equal(sqlite(file3,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);}}});
 const stopped=await D.applyDictionaryUnits(held,{plan:await plan([entry(1),entry(2)]),now:()=>T});
 assert.deepEqual([stopped.cursor,stopped.done,stopped.counts.applied,stopped.counts.failed,stopped.stoppedBy],[1,false,1,0,'film_person_held']);
 assert.equal(filmRow(file3,2).original_title,null);
 // an unreadable marker mid-pass stops the pass the same way
 const file4=database('open');
 for(const k of [1,2])seed(file4,k);
 let dead=null;
 dead=envOf(file4,{rewrite:sql=>dead&&dead.DB.calls.batches>=2&&/film_person_authority/.test(sql)?sql.replace(/film_person_authority/g,'film_person_missing'):sql});
 const unreadable=await D.applyDictionaryUnits(dead,{plan:await plan([entry(1),entry(2)]),now:()=>T});
 assert.deepEqual([unreadable.cursor,unreadable.done,unreadable.stoppedBy,unreadable.counts.applied],[1,false,'film_person_unavailable',1]);
}

// 9. E5: identical content landing between the builder's read and the adapter's own read: counted unknown, 2 batches, no marking batch. Mirrors the EPG layer.
{
 const file=database('open');seed(file,1);
 const p=await plan([entry(1)]);
 let hit=0;
 const env=envOf(file,{onBatch:async()=>{hit++;if(hit===1)assert.equal(sqlite(file,"UPDATE film SET original_title='Orig 1',canonical_identity='tmdb:1' WHERE id='"+ID(1)+"';UPDATE film_dimension SET provenance_json='{\"titleSource\":{\"source\":\"dictionary\",\"at\":\""+T+"\"}}' WHERE film_id='"+ID(1)+"' AND dimension='identity';INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ('"+ID(1)+"','localization','reviewed','dictionary','verified','{\"authority\":\"dictionary\",\"sources\":[\"https://example.test/1\"]}','Рус 1','dictionary',0,'keep_reviewed','"+T+"')").status,0);}});
 const out=await D.applyDictionaryUnits(env,{plan:p,now:()=>T});
 assert.deepEqual([out.counts.unknown,out.counts.applied,env.DB.calls.batches],[1,0,2]);
 assert.equal(receipts(file)[0].state,'unknown');
}

// 10. Reconcile (E2): own origin only; a receipt is re-planned from the snapshot that wrote it, never from another; another origin's receipt is untouched.
{
 const file=database('open');seed(file,1);seed(file,2);
 const mk=version=>plan([entry(1),entry(2)],{version});
 const A=await mk('vA'),B=await mk('vB');
 let seen=0;
 const flaky=envOf(file,{onBatch:async()=>{seen++;if(seen===2)throw new Error('transient');}});
 const first=await D.applyDictionaryUnits(flaky,{plan:A,now:()=>T});
 assert.deepEqual([first.counts.applied,first.stoppedBy,first.cursor],[0,'film_person_unavailable',0],'an unreadable store stops the pass on its unit');
 const failedRows=receipts(file).filter(item=>item.state!=='applied');
 assert.equal(failedRows.length,1);
 const request=failedRows[0].request_id;
 const unmoved=filmRow(file,1).original_title;
 const fromB=await D.reconcileDictionary(envOf(file),{plan:B,now:()=>iso(3600000)});
 assert.equal(fromB.considered,1);
 const afterB=receipts(file).find(item=>item.request_id===request);
 assert.notEqual(afterB.state,'applied','snapshot B does not settle snapshot A\'s request');assert.equal(afterB.request_id,request);assert.notEqual(afterB.state,'abandoned');
 assert.equal(filmRow(file,1).original_title,unmoved);
 const fromA=await D.reconcileDictionary(envOf(file),{plan:A,now:()=>iso(2*3600000+1)});
 assert.equal(fromA.considered,1);
 const afterA=receipts(file).find(item=>item.request_id===request);
 assert.deepEqual([afterA.state,afterA.applied_revision],['applied',1],'the same snapshot replays it under the SAME request id: '+JSON.stringify(afterA));
 assert.equal(filmRow(file,1).original_title,'Orig 1');assert.equal(filmRow(file,2).original_title,null,'the reconcile touches only its own receipts');
 // another origin's due receipt (an EPG run that failed transiently) is not considered, retried or abandoned by the dictionary reconcile
 const {planEpgUnits,applyEpgUnits}=await load('canonical-epg-producer.js');
 assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('"+ID(50)+"',1,'"+U+"')").status,0);
 let hits=0;
 await applyEpgUnits(envOf(file,{onBatch:async()=>{hits++;if(hits===2)throw new Error('transient');}}),{plan:planEpgUnits({runId:'r',at:T,films:[{id:ID(50),facts:{film:{contractVersion:1,originalTitle:'E',source:'epg'},watchlist:true}}]}),now:()=>T});
 const epgBefore=receipts(file).filter(item=>item.origin==='epg');
 assert.equal(epgBefore.length,1);assert.notEqual(epgBefore[0].state,'applied');
 const other=await D.reconcileDictionary(envOf(file),{plan:A,limit:5,now:()=>iso(9*3600000)});
 assert.deepEqual([other.considered,other.origin],[0,'dictionary']);
 assert.deepEqual(receipts(file).filter(item=>item.origin==='epg'),epgBefore,'the EPG receipt is untouched');
 // the re-plan itself, positively: the receipt of THIS snapshot for Film 2 re-plans Film 2 (and only with the store)
 {
  const probe=database('open');seed(probe,1);seed(probe,2);
  const built=D.buildDictionaryInput(await (await load('canonical-producer-adapters.js')).readFilmSnapshot(envOf(probe),ID(2)),A.units[1],{at:T});
  const receipt={target:{kind:'film',id:ID(2)},contentDigest:await filmFactsDigest(built.input)};
  receipt.requestId=await producerRequestId({origin:'dictionary',event:A.event,target:receipt.target,digest:receipt.contentDigest});
  const planned=await D.dictionaryReplan(A,envOf(probe))(receipt);
  assert.equal(planned.id,ID(2));assert.equal(planned.film.originalTitle,'Orig 2');
  assert.equal(await D.dictionaryReplan(A)(receipt),null,'no store, no re-plan');
  assert.equal(await D.dictionaryReplan(B,envOf(probe))(receipt),null,'another snapshot never re-plans it');
  assert.equal(sqlite(probe,"DELETE FROM film_dimension WHERE film_id='"+ID(2)+"';DELETE FROM film_external_id WHERE film_id='"+ID(2)+"';DELETE FROM film WHERE id='"+ID(2)+"'").status,0);
  assert.equal(await D.dictionaryReplan(A,envOf(probe))(receipt),null,'a Film that is gone is not re-planned (never created)');
 }
 // the inline bound: two due receipts, a limit of one considers one
 {
  const two=database('open');seed(two,1);seed(two,2);
  const P=await mk('vL');
  let hit=0;
  const flakyTwo=envOf(two,{onBatch:async()=>{hit++;if(hit===2||hit===5)throw new Error('transient');}});
  await D.applyDictionaryUnits(flakyTwo,{plan:P,now:()=>T});await D.applyDictionaryUnits(flakyTwo,{plan:P,cursor:1,now:()=>T});
  assert.equal(receipts(two).filter(item=>item.state!=='applied').length,2);
  assert.equal((await D.reconcileDictionary(envOf(two),{plan:P,limit:1,now:()=>iso(3600000)})).considered,1);
  assert.equal((await D.reconcileDictionary(envOf(two),{plan:P,now:()=>iso(5*3600000)})).considered,1,'the rest');
  assert.deepEqual(receipts(two).map(item=>item.state),['applied','applied']);
 }
 const replan=D.dictionaryReplan(A,envOf(file));
 const own=async k=>({target:{kind:'film',id:ID(k)},contentDigest:'a'.repeat(64),requestId:'x'});
 assert.equal(await replan(await own(1)),null,'a receipt that is not this snapshot\'s');assert.equal(await replan({}),null);assert.equal(await D.dictionaryReplan(null,envOf(file))({target:{id:ID(1)}}),null);assert.equal(await D.dictionaryReplan(A)({target:{id:ID(1)}}),null);
}

// 11. Static: dormant. Nothing in src imports it, build.mjs and the Worker do not name it, it imports exactly the adapter (with its digest and Film snapshot) and the authority helpers, names no network, timer, cron or R2 API and holds
// no SQL of its own (the fenced writer is the only writer); readiness stays truthful: no receipt operation is registered.
{
 const self='src/canonical-dictionary-producer.js';
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&full!==self&&fs.readFileSync(full,'utf8').includes('canonical-dictionary-producer'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,[],'nothing in src imports it');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-dictionary-producer'),file+' does not bundle it');
 const text=fs.readFileSync(path.join(SRC,'canonical-dictionary-producer.js'),'utf8');
 const code_=text.replace(/\/\/.*$/gm,'');
 assert.deepEqual([...text.matchAll(/from '(\.\/[^']+)'/g)].map(match=>match[1]).sort(),['./canonical-producer-adapters.js','./film-person-authority.js']);
 assert.ok(!/\b(fetch|setTimeout|setInterval|scheduled|R2|BUCKET|waitUntil|DB\b)/.test(code_),'no network, timer, cron, R2 or database handle');
 assert.ok(!/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?\s*\w/.test(code_),'the module holds no SQL of its own');
 assert.ok(!/\b(writeFilmFacts|planFilmFacts|fenced|receiptedWrite)\b/.test(code_),'the writer is reached only through the receipt adapter');
 assert.ok(!fs.readFileSync('src/worker.js','utf8').includes('canonical-dictionary-producer'),'the Worker does not name it');
 assert.equal(PRODUCER_OPERATIONS.size,0,'no receipt operation is registered by this change');
 assert.ok(PRODUCER_WIRING.find(item=>item.name==='epg_commit').requires.some(kind=>!PRODUCER_OPERATIONS.has(kind)),'epg_commit stays unwired');
}
console.log('canonical-dictionary-producer: ok');
