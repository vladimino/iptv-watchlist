// AIR-549 stage 1: Filter presets in D1 (schema v28, src/filter-presets-d1.js, the D1 branch of src/filter-presets.js).
// Offline only: a sqlite stand-in with the real migrations. No production database or R2 bucket is opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as Presets from '../src/filter-presets-d1.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-filter-presets-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
const run=(file,text)=>sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<26});
const rowsOf=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const m28='0028_filter_preset_authority.sql';
assert.ok(files.includes(m28));

// ===== 1. the migration =====
const v27=path.join(root,'v27.sqlite');
assert.equal(run(v27,files.filter(name=>name<m28).map(read).join('\n')).status,0);
assert.equal(rowsOf(v27,'SELECT version FROM schema_contract WHERE id=1')[0].version,27);
const refused=path.join(root,'v26.sqlite');
assert.equal(run(refused,files.filter(name=>name<'0027').map(read).join('\n')).status,0);
const refusal=run(refused,read(m28));
assert.notEqual(refusal.status,0,'0028 refuses a version 26 database');
assert.equal(rowsOf(refused,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'filter_preset%'")[0].n,0,'a refusal creates nothing');
const template=path.join(root,'v28.sqlite');
fs.copyFileSync(v27,template);
assert.equal(run(template,read(m28)).status,0);
assert.equal(rowsOf(template,'SELECT version FROM schema_contract WHERE id=1')[0].version,28);
assert.deepEqual(rowsOf(template,'SELECT mode,generation,writes FROM filter_preset_authority'),[{mode:'r2',generation:0,writes:'open'}],'the inserted marker is r2, generation 0, writes open');
assert.equal(rowsOf(template,'SELECT COUNT(*) AS n FROM filter_preset')[0].n,0,'applying copies nothing');
assert.notEqual(run(template,read(m28)).status,0,'a second apply is refused');
assert.notEqual(run(template,"UPDATE schema_contract SET version=27 WHERE id=1").status,0,'the version never goes down');
assert.notEqual(run(template,"UPDATE filter_preset_authority SET mode='x'").status,0,'mode is constrained');
let n=0;
const database=(source=template)=>{const file=path.join(root,'db-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return {file,db:d1Standin(file)};};
const marker=file=>rowsOf(file,'SELECT mode,generation,writes FROM filter_preset_authority')[0];

// ===== 2. the harness: the real Worker route, with and without the D1 module =====
// R2 ETags are derived from the object's bytes: identical bytes give the identical ETag (the mock models that with MD5 of the raw body; it does not count revisions).
const records=new Map(),etags=new Map(),raws=new Map();let puts=[],gets=0;
const bucket={
 async get(key){gets++;if(!records.has(key))return null;const etag=etags.get(key);return {etag,httpEtag:`"${etag}"`,json:async()=>JSON.parse(raws.get(key)),text:async()=>raws.get(key)};},
 async put(key,value,options={}){const condition=options.onlyIf||{},current=etags.get(key);if(condition.etagDoesNotMatch==='*'&&records.has(key)||condition.etagMatches&&condition.etagMatches!==current)return null;const raw=String(value);records.set(key,JSON.parse(raw));raws.set(key,raw);const etag=createHash('md5').update(raw).digest('hex');etags.set(key,etag);puts.push(key);return {etag,httpEtag:`"${etag}"`};},
 async delete(){},async list(){return {objects:[],truncated:false};},
};
function load(withD1){
 const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},fetch:async()=>{throw new Error('unexpected fetch');}});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
 if(withD1)vm.runInContext(scoped('src/filter-presets-d1.js','FilterPresetsD1'),context);
 for(const file of ['src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
 return context;
}
const withD1=load(true),without=load(false);
const execution={waitUntil(){},exports:{}};
async function call(context,env,method,pathname,etag,body){
 const headers={};
 if(etag)headers['If-Match']=etag;
 if(body)headers['Content-Type']='application/json';
 const response=await context.worker.fetch(new Request('https://iptv.example'+pathname,{method,headers,body:body?JSON.stringify(body):undefined}),env,execution);
 return {status:response.status,etag:response.headers.get('ETag'),body:await response.json()};
}
const URLP='/api/ui/filter-presets';
const resetR2=()=>{records.clear();etags.clear();raws.clear();puts=[];gets=0;};
const uuid=index=>`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
const preset=(index,name='Пресет '+index,query='viewing=new')=>({id:uuid(index),name,schemaVersion:1,query,createdAt:'2026-11-01T10:00:00.000Z',updatedAt:'2026-11-01T10:00:00.000Z'});

// ===== 3. dormant: no schema, no binding, marker r2: R2 keeps serving and the D1 module changes nothing =====
resetR2();
{
 const noSchema=database(v27);
 for(const env of [{BUCKET:bucket,FILTER_PRESETS_DB_OPTIONAL:'standin'},{BUCKET:bucket,DB:noSchema.db}]){
  resetR2();
  const empty=await call(withD1,env,'GET',URLP);
  assert.equal(empty.status,200);assert.equal(empty.etag,'"none"');
  const created=await call(withD1,env,'POST',URLP,'"none"',{name:'Старый',query:'started=1'});
  assert.equal(created.status,201);assert.deepEqual(puts,['ui/filter-presets.json'],'before the schema exists R2 is the authority');
  assert.equal((await call(withD1,env,'GET',URLP)).body.presets[0].name,'Старый');
 }
 assert.equal(rowsOf(noSchema.file,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'filter_preset%'")[0].n,0,'the route never creates the schema');
 assert.deepEqual((await Presets.readAuthority({FILTER_PRESETS_DB_OPTIONAL:'standin'})),{state:'legacy'},'only the explicit stand-in may run without a binding');
 assert.deepEqual((await Presets.readAuthority({})),{state:'closed'},'a missing binding is closed');
 assert.deepEqual((await Presets.readAuthority({DB:noSchema.db})),{state:'legacy'},'a database that proves it is pre-migration (version below 28)');
}
resetR2();
{
 const {file,db}=database();
 const env={BUCKET:bucket,DB:db};
 const created=await call(withD1,env,'POST',URLP,'"none"',{name:'R2 пока авторитет',query:'viewing=rewatch'});
 assert.equal(created.status,201);assert.equal(puts.length,1);
 assert.deepEqual(marker(file),{mode:'r2',generation:0,writes:'open'});
 assert.equal(rowsOf(file,'SELECT COUNT(*) AS n FROM filter_preset')[0].n,0,'mode r2 writes no D1 row');
 // writes held in mode r2: the import fence. Reads still come from R2; writes are refused and nothing is written.
 run(file,"UPDATE filter_preset_authority SET writes='held'");
 const before=puts.length;
 const listed=await call(withD1,env,'GET',URLP);
 assert.equal(listed.status,200);assert.equal(listed.etag,created.etag);
 const held=await call(withD1,env,'POST',URLP,listed.etag,{name:'Нельзя',query:''});
 assert.equal(held.status,503);assert.equal(puts.length,before);
 run(file,"UPDATE filter_preset_authority SET writes='open'");
}
// A marker that cannot be trusted never falls back to R2.
for(const [label,sql] of [['no marker row','DELETE FROM filter_preset_authority'],['marker with an unknown state',"PRAGMA ignore_check_constraints=ON;UPDATE filter_preset_authority SET mode='zz'"]]){
 resetR2();
 const {file,db}=database();
 run(file,sql);
 const env={BUCKET:bucket,DB:db};
 assert.equal((await call(withD1,env,'GET',URLP)).status,503,label+': GET closed');
 assert.equal((await call(withD1,env,'POST',URLP,'"none"',{name:'x',query:''})).status,503,label+': POST closed');
 assert.equal(gets+puts.length,0,label+': R2 is not touched');
}
{
 resetR2();
 const {db}=database();
 const broken={BUCKET:bucket,DB:{prepare(){throw new Error('D1_ERROR: network connection lost');},batch(){throw new Error('x');}}};
 assert.equal((await call(withD1,broken,'GET',URLP)).status,503,'a storage error is a 503, never R2');
 assert.equal(gets+puts.length,0);
 void db;
}

// ===== 4. import and activation =====
resetR2();
const cutover=database();
const env4={BUCKET:bucket,DB:cutover.db};
const c1=await call(withD1,env4,'POST',URLP,'"none"',{name:'Пересмотр 4.0+',query:'viewing=rewatch&prediction=4'});
const c2=await call(withD1,env4,'POST',URLP,c1.etag,{name:'Недавние',query:'started=1&token=secret'});
assert.equal(c2.status,201);
const r2Document=records.get('ui/filter-presets.json');
const r2Presets=r2Document.presets;
assert.equal(r2Presets.length,2);
const importOpen=await Presets.importPresets(cutover.db,{presets:r2Presets});
assert.deepEqual(importOpen,{ok:false,reason:'writes_not_held'},'an import refuses while writers are not held');
assert.equal(rowsOf(cutover.file,'SELECT COUNT(*) AS n FROM filter_preset')[0].n,0);
run(cutover.file,"UPDATE filter_preset_authority SET writes='held'");
assert.deepEqual(await Presets.importPresets(cutover.db,{presets:Array.from({length:31},(_,i)=>preset(i+1))}),{ok:false,reason:'too_many'});
const imported=await Presets.importPresets(cutover.db,{presets:r2Presets});
assert.deepEqual(imported,{ok:true,generation:1,already:false});
assert.deepEqual(marker(cutover.file),{mode:'r2',generation:1,writes:'held'},'an import loads rows but does not switch');
assert.deepEqual(await Presets.importPresets(cutover.db,{presets:r2Presets}),{ok:true,generation:1,already:true},'a retry is idempotent');
assert.deepEqual(await Presets.importPresets(cutover.db,{presets:[r2Presets[0]]}),{ok:false,reason:'conflict'},'a different document never overwrites an import');
assert.deepEqual(await Presets.importPresets(cutover.db,{presets:[r2Presets[1],r2Presets[0]]}),{ok:false,reason:'conflict'},'order is part of the document');
assert.equal(rowsOf(cutover.file,'SELECT COUNT(*) AS n FROM filter_preset')[0].n,2);
const stillR2=await call(withD1,env4,'GET',URLP);
assert.equal(stillR2.etag,c2.etag,'between import and activation R2 still serves');
assert.deepEqual(await Presets.activatePresets(cutover.db,{presets:[r2Presets[0]]}),{ok:false,reason:'parity'},'activation needs a parity proof');
assert.deepEqual(await Presets.activatePresets(cutover.db,{presets:[{...r2Presets[0]},{...r2Presets[1],name:'Другое'}]}),{ok:false,reason:'parity'});
assert.equal(marker(cutover.file).mode,'r2');
const putsBefore=puts.length,getsBefore=gets;
assert.deepEqual(await Presets.activatePresets(cutover.db,{presets:r2Presets}),{ok:true,generation:1});
assert.deepEqual(marker(cutover.file),{mode:'d1',generation:1,writes:'open'});
assert.deepEqual(await Presets.importPresets(cutover.db,{presets:r2Presets}),{ok:false,reason:'already_active'},'no import after activation');
assert.deepEqual(await Presets.activatePresets(cutover.db,{presets:r2Presets}),{ok:false,reason:'not_ready'},'activation is not repeatable');
// switch/read parity
const afterSwitch=await call(withD1,env4,'GET',URLP);
assert.equal(afterSwitch.status,200);assert.equal(afterSwitch.etag,'"d1:1"');
assert.deepEqual(afterSwitch.body,{schemaVersion:1,presets:[r2Presets[0],r2Presets[1]].map(item=>({...item}))},'the document is the same, field for field, in the same order');
assert.equal(gets,getsBefore+0,'D1 mode never reads R2');
// the old R2 token is not a D1 token: refresh, never update
const staleR2=await call(withD1,env4,'PATCH',URLP+'/'+r2Presets[0].id,c2.etag,{name:'Через старый токен'});
assert.equal(staleR2.status,412);assert.equal(staleR2.body.presets.length,2);assert.equal(staleR2.etag,'"d1:1"');
assert.equal((await call(withD1,env4,'POST',URLP,'"none"',{name:'none после cutover',query:''})).status,412,'"none" is stale after a non-empty import');

// ===== 5. D1 mode: the API contract =====
const reads=()=>rowsOf(cutover.file,'SELECT id,name,query,position,generation FROM filter_preset ORDER BY position');
const batchesBefore=cutover.db.calls.batches;
const g1=await call(withD1,env4,'GET',URLP);const g2=await call(withD1,env4,'GET',URLP);
assert.equal(g1.etag,g2.etag);assert.equal(cutover.db.calls.batches,batchesBefore,'repeated GET writes nothing');
assert.equal((await call(withD1,env4,'POST',URLP,null,{name:'x',query:''})).status,428,'no If-Match');
const created5=await call(withD1,env4,'POST',URLP,'"d1:1"',{name:'  Третий  ',query:'viewing=new&prediction=4&execution=pace:unknown&token=secret'});
assert.equal(created5.status,201);assert.equal(created5.etag,'"d1:2"');
assert.equal(created5.body.presets.length,3);assert.equal(created5.body.presets[2].name,'Третий');assert.equal(created5.body.presets[2].query,'viewing=new&prediction=4');
assert.equal(marker(cutover.file).generation,2);assert.ok(reads().every(row=>row.generation===2),'every row carries the committed generation');
const third=created5.body.presets[2].id;
const renamed=await call(withD1,env4,'PATCH',URLP+'/'+third,'"d1:2"',{name:'Короткое'});
assert.equal(renamed.status,200);assert.equal(renamed.etag,'"d1:3"');assert.equal(renamed.body.presets[2].name,'Короткое');assert.equal(renamed.body.presets[2].query,'viewing=new&prediction=4');
const requeried=await call(withD1,env4,'PATCH',URLP+'/'+third,'"d1:3"',{query:'started=1&bad=1'});
assert.equal(requeried.body.presets[2].query,'started=1');assert.equal(requeried.body.presets[2].name,'Короткое');
// failed validation never writes
const generation=marker(cutover.file).generation,snapshot=JSON.stringify(reads());
for(const [method,suffix,body] of [['POST','',{name:'',query:''}],['POST','',{name:'x'.repeat(81),query:''}],['POST','',{name:'ok',query:'q='.padEnd(5000,'a')}],['PATCH','/'+third,{}],['PATCH','/'+third,{name:' '}],['PATCH','/'+third,{query:'a'.repeat(4001)}],['PATCH','/'+uuid(999),{name:'x'}]]){
 const result=await call(withD1,env4,method,URLP+suffix,requeried.etag,body);
 assert.ok([400,404].includes(result.status),method+suffix+' '+result.status);
}
assert.equal((await call(withD1,env4,'DELETE',URLP+'/not-a-uuid',requeried.etag)).status,404);
assert.equal(marker(cutover.file).generation,generation,'failed validation does not advance the revision');assert.equal(JSON.stringify(reads()),snapshot,'failed validation writes no row');
// stale token and two concurrent writers: exactly one wins, no update is lost
const token=requeried.etag;
const racers=await Promise.all([
 call(withD1,env4,'PATCH',URLP+'/'+r2Presets[0].id,token,{name:'Гонка А'}),
 call(withD1,env4,'PATCH',URLP+'/'+r2Presets[1].id,token,{name:'Гонка Б'}),
 call(withD1,env4,'POST',URLP,token,{name:'Гонка В',query:''}),
]);
const winners=racers.filter(item=>item.status===200||item.status===201),losers=racers.filter(item=>item.status===412);
assert.equal(winners.length,1,JSON.stringify(racers.map(item=>item.status)));assert.equal(losers.length,2);
assert.ok(losers.every(item=>item.etag===winners[0].etag&&Array.isArray(item.body.presets)),'a loser gets the winner state and ETag');
assert.equal(marker(cutover.file).generation,generation+1,'one commit, one revision');
const after=await call(withD1,env4,'GET',URLP);
assert.equal(after.etag,winners[0].etag);assert.deepEqual(after.body.presets,winners[0].body.presets);
// delete, then the empty state keeps a D1 ETag
let current=after;
for(const item of [...current.body.presets]){const removed=await call(withD1,env4,'DELETE',URLP+'/'+item.id,current.etag);assert.equal(removed.status,200);current=removed;}
assert.deepEqual(current.body.presets,[]);assert.match(current.etag,/^"d1:\d+"$/);
assert.equal((await call(withD1,env4,'POST',URLP,'"none"',{name:'x',query:''})).status,412);
// the maximum
for(let i=0;i<30;i++){const added=await call(withD1,env4,'POST',URLP,current.etag,{name:'Пресет '+i,query:'viewing=new'});assert.equal(added.status,201,'preset '+i);current=added;}
assert.equal(current.body.presets.length,30);
const over=await call(withD1,env4,'POST',URLP,current.etag,{name:'31-й',query:''});
assert.equal(over.status,400);assert.equal((await call(withD1,env4,'GET',URLP)).etag,current.etag,'the 31st preset wrote nothing');
assert.deepEqual(reads().map(row=>row.position),Array.from({length:30},(_,i)=>i),'positions stay 0..29');
assert.equal(puts.length,putsBefore,'no R2 write in D1 mode');assert.equal(gets,getsBefore,'no R2 read in D1 mode');

// ===== 6. held writes, unreadable rows, legacy query sanitization, lost reply, module-level CAS =====
run(cutover.file,"UPDATE filter_preset_authority SET writes='held'");
const heldD1=await call(withD1,env4,'PATCH',URLP+'/'+current.body.presets[0].id,current.etag,{name:'Нельзя'});
assert.equal(heldD1.status,503);assert.equal((await call(withD1,env4,'GET',URLP)).status,200,'reads are served while writes are held');
assert.deepEqual(await Presets.commitPresets(cutover.db,{expectedGeneration:marker(cutover.file).generation,presets:[]}),{ok:false,reason:'writes_held'});
run(cutover.file,"UPDATE filter_preset_authority SET writes='open'");
{
 const {file,db}=database();
 run(file,"UPDATE filter_preset_authority SET mode='d1',generation=1;INSERT INTO filter_preset VALUES ('"+uuid(1)+"',0,'Старый','viewing=rewatch&token=secret&execution=pace:unknown','2026-11-01T10:00:00.000Z','2026-11-01T10:00:00.000Z',1)");
 const env={BUCKET:bucket,DB:db};
 const legacy=await call(withD1,env,'GET',URLP);
 assert.equal(legacy.body.presets[0].query,'viewing=rewatch','a legacy query is sanitized on read');
 run(file,"INSERT INTO filter_preset VALUES ('not-a-uuid',1,'Плохой','','2026-11-01T10:00:00.000Z','2026-11-01T10:00:00.000Z',1)");
 const corrupt=await call(withD1,env,'GET',URLP);
 assert.equal(corrupt.status,500);assert.equal(corrupt.body.error,'Stored filter presets are unreadable');
 run(file,"DELETE FROM filter_preset WHERE id='not-a-uuid';INSERT INTO filter_preset VALUES ('"+uuid(2)+"',1,'Чужое поколение','',  '2026-11-01T10:00:00.000Z','2026-11-01T10:00:00.000Z',7)");
 assert.equal((await call(withD1,env,'GET',URLP)).status,503,'rows of another generation are never served');
}
{
 const {file,db}=database();
 run(file,"UPDATE filter_preset_authority SET mode='d1',generation=4");
 // lost reply: the batch commits, the answer is lost
 const lossy={prepare:db.prepare.bind(db),async batch(list){await db.batch(list);throw new Error('D1_ERROR: network connection lost');}};
 assert.deepEqual(await Presets.commitPresets(lossy,{expectedGeneration:4,presets:[preset(1)]}),{ok:true,generation:5},'a lost reply after a commit is a success');
 assert.equal(marker(file).generation,5);
 // a lost reply when nothing committed is unavailable and writes nothing
 const dead={prepare:db.prepare.bind(db),async batch(){throw new Error('D1_ERROR: network connection lost');}};
 assert.deepEqual(await Presets.commitPresets(dead,{expectedGeneration:5,presets:[preset(2)]}),{ok:false,reason:'unavailable'});
 assert.equal(marker(file).generation,5);
 // the module-level compare-and-swap: two commits from one generation, one wins
 const both=await Promise.all([Presets.commitPresets(db,{expectedGeneration:5,presets:[preset(3)]}),Presets.commitPresets(db,{expectedGeneration:5,presets:[preset(4)]})]);
 assert.equal(both.filter(item=>item.ok).length,1,JSON.stringify(both));assert.ok(both.some(item=>item.reason==='conflict'));
 assert.equal(marker(file).generation,6);assert.equal(rowsOf(file,'SELECT COUNT(*) AS n FROM filter_preset')[0].n,1,'the loser left no row');
 assert.deepEqual(await Presets.commitPresets(db,{expectedGeneration:5,presets:[]}),{ok:false,reason:'conflict'},'a stale generation is a conflict');
 assert.deepEqual(await Presets.commitPresets(db,{expectedGeneration:6,presets:Array.from({length:31},(_,i)=>preset(i+1))}),{ok:false,reason:'too_many'});
 // the fence itself: an UPDATE that changes nothing aborts the batch and every later statement
 assert.notEqual(run(file,"BEGIN;UPDATE filter_preset_authority SET generation=9 WHERE id=1 AND generation=0;UPDATE filter_preset_cas SET ok=changes() WHERE id=1;COMMIT;").status,0);
 assert.equal(marker(file).generation,6);
}
assert.equal(Presets.filterPresetEtag(0),'"none"');assert.equal(Presets.filterPresetEtag(7),'"d1:7"');
assert.equal(Presets.filterPresetGeneration('"d1:7"'),7);assert.equal(Presets.filterPresetGeneration('W/"d1:7"'),7);assert.equal(Presets.filterPresetGeneration('"none"'),0);
for(const bad of ['"7"','"d1:0"','"d1:x"','"abc123"','']){assert.equal(Presets.filterPresetGeneration(bad),null,bad);}
// ===== 7. the offline SQL generator (scripts/filter-presets-d1-sql.mjs): same guarded steps as the module, no database opened =====
{
 const {spawnSync}=await import('node:child_process');
 const tool=(...args)=>spawnSync(process.execPath,['scripts/filter-presets-d1-sql.mjs',...args],{encoding:'utf8'});
 const exportFile=path.join(root,'r2-export.json');
 const source={schemaVersion:1,presets:[preset(1,"Д'Артаньян",'viewing=rewatch&token=secret'),preset(2,'Второй','started=1')]};
 fs.writeFileSync(exportFile,JSON.stringify(source));
 const {file}=database();
 const apply=text=>run(file,text);
 assert.notEqual(apply(tool('import',exportFile).stdout).status,0,'an import before the hold is refused by its fence');
 assert.equal(marker(file).generation,0,'an import without the hold changes nothing');
 assert.equal(rowsOf(file,'SELECT COUNT(*) AS n FROM filter_preset')[0].n,0);
 assert.equal(apply(tool('hold').stdout).status,0);assert.equal(marker(file).writes,'held');
 assert.notEqual(apply(tool('hold').stdout).status,0,'a second hold is refused');
 assert.notEqual(apply(tool('activate',exportFile).stdout).status,0,'activation before an import is refused');
 assert.equal(marker(file).mode,'r2','activation without rows never switches');
 const imported=tool('import',exportFile);assert.equal(imported.status,0);
 assert.equal(apply(imported.stdout).status,0);
 assert.deepEqual(marker(file),{mode:'r2',generation:1,writes:'held'});
 assert.equal(rowsOf(file,'SELECT query FROM filter_preset WHERE position=0')[0].query,'viewing=rewatch','the import stores the served (normalized) query');
 assert.equal(rowsOf(file,'SELECT name FROM filter_preset WHERE position=0')[0].name,"Д'Артаньян",'quotes survive');
 assert.notEqual(apply(imported.stdout).status,0,'a repeated import is refused by its own fence and leaves the rows');
 assert.equal(rowsOf(file,'SELECT COUNT(*) AS n FROM filter_preset')[0].n,2);
 // the module and the SQL agree on the document
 const served=await Presets.importPresets(d1Standin(file),{presets:source.presets.map((item,i)=>i===0?{...item,query:'viewing=rewatch'}:item)});
 assert.deepEqual(served,{ok:true,generation:1,already:true},'the SQL import equals the module import');
 const tampered=path.join(root,'tampered.json');fs.writeFileSync(tampered,JSON.stringify({schemaVersion:1,presets:[source.presets[0],{...source.presets[1],name:'Подменён'}]}));
 assert.notEqual(apply(tool('activate',tampered).stdout).status,0,'a document that differs from the rows cannot activate');
 assert.equal(marker(file).mode,'r2');
 assert.equal(apply(tool('activate',exportFile).stdout).status,0);
 assert.deepEqual(marker(file),{mode:'d1',generation:1,writes:'open'});
 assert.equal(JSON.parse(tool('digest',exportFile).stdout).count,2);
 // a source the Worker cannot read is a blocker, never an empty import
 for(const [label,body] of [['not JSON','{'],['no presets array',JSON.stringify({schemaVersion:1})],['one unreadable record',JSON.stringify({schemaVersion:1,presets:[source.presets[0],{id:'x'}]})],['31 presets',JSON.stringify({schemaVersion:1,presets:Array.from({length:31},(_,i)=>preset(i+1))})],['an array',JSON.stringify([])]]){
  const bad=path.join(root,'bad.json');fs.writeFileSync(bad,body);
  const result=tool('import',bad);
  assert.equal(result.status,2,label);assert.equal(result.stdout,'',label+': no SQL is printed');
 }
 const emptyFile=path.join(root,'empty.json');fs.writeFileSync(emptyFile,JSON.stringify({schemaVersion:1,presets:[]}));
 const emptyDb=database();
 assert.equal(run(emptyDb.file,tool('hold').stdout+tool('import',emptyFile).stdout+tool('activate',emptyFile).stdout).status,0);
 assert.deepEqual(marker(emptyDb.file),{mode:'d1',generation:1,writes:'open'},'a real empty R2 document imports as an empty D1 document with a D1 ETag');
 assert.equal((await call(withD1,{BUCKET:bucket,DB:emptyDb.db},'GET',URLP)).etag,'"d1:1"');
 const releaseDb=database();run(releaseDb.file,tool('hold').stdout);run(releaseDb.file,tool('release').stdout);
 assert.deepEqual(marker(releaseDb.file),{mode:'r2',generation:0,writes:'open'},'release restores the pre-hold marker');
}

// ===== 8. review findings (P1 x3, P2) =====
{
 // P1 fail-closed: after activation a missing binding or a wrong/empty database never serves R2
 resetR2();
 const active=database();
 run(active.file,"UPDATE filter_preset_authority SET mode='d1',generation=1");
 const empty=path.join(root,'wrong-empty.sqlite');run(empty,'CREATE TABLE unrelated(x)');
 const wrongV28=path.join(root,'wrong-v28.sqlite');run(wrongV28,"CREATE TABLE schema_contract(id INTEGER PRIMARY KEY, version INTEGER, note TEXT);INSERT INTO schema_contract VALUES(1,28,'x')");
 for(const [label,env] of [['no binding',{BUCKET:bucket}],['an empty database',{BUCKET:bucket,DB:d1Standin(empty)}],['version 28 without the tables',{BUCKET:bucket,DB:d1Standin(wrongV28)}]]){
  assert.equal((await call(withD1,env,'GET',URLP)).status,503,label+': GET');
  assert.equal((await call(withD1,env,'POST',URLP,'"none"',{name:'x',query:''})).status,503,label+': POST');
 }
 assert.equal(gets+puts.length,0,'a wrong database never reaches R2');
 assert.equal((await call(withD1,{BUCKET:bucket,DB:active.db},'GET',URLP)).status,200,'the real database still serves');
}
{
 // P1 lost reply: a competitor from the same generation committed and our batch never reached D1
 const {file,db}=database();
 run(file,"UPDATE filter_preset_authority SET mode='d1',generation=4");
 const racing={prepare:db.prepare.bind(db),async batch(){await Presets.commitPresets(db,{expectedGeneration:4,presets:[preset(7,'Победитель')]});throw new Error('D1_ERROR: network connection lost');}};
 const lost=await Presets.commitPresets(racing,{expectedGeneration:4,presets:[preset(8,'Проигравший')]});
 assert.deepEqual(lost,{ok:false,reason:'conflict'},'the competitor won: our request is not a success');
 assert.deepEqual(rowsOf(file,'SELECT id,name FROM filter_preset'),[{id:uuid(7),name:'Победитель'}]);
 // the same through the route: 412 with the winner's state, never 200 with the loser's body
 const route=database();
 run(route.file,"UPDATE filter_preset_authority SET mode='d1',generation=1");
 const r2=route.db;
 let armed=true;
 const flaky={prepare:r2.prepare.bind(r2),async batch(list){if(armed){armed=false;await Presets.commitPresets(r2,{expectedGeneration:1,presets:[preset(9,'Победитель')]});throw new Error('D1_ERROR: network connection lost');}return r2.batch(list);}};
 const answer=await call(withD1,{BUCKET:bucket,DB:flaky},'POST',URLP,'"d1:1"',{name:'Проигравший',query:''});
 assert.equal(answer.status,412,JSON.stringify(answer.body));assert.equal(answer.body.presets[0].name,'Победитель');assert.equal(answer.etag,'"d1:2"');
}
{
 // P1 hold versus an in-flight R2 writer. The writer is admitted at r2/open, is suspended while the operator holds and fences the R2 object, then resumes.
 resetR2();
 const {file,db}=database();
 const env={BUCKET:bucket,DB:db};
 const seeded=await call(withD1,env,'POST',URLP,'"none"',{name:'Исходный',query:'started=1'});
 assert.equal(seeded.status,201);
 const fence=async()=>{ // the runbook's fence write: the stored raw bytes plus one trailing newline (valid JSON whitespace), conditional on the ETag just read, and the ETag must change
  const object=await bucket.get('ui/filter-presets.json');
  const saved=await bucket.put('ui/filter-presets.json',(await object.text())+'\n',{onlyIf:{etagMatches:object.etag}});
  assert.ok(saved,'the fence write lands');assert.notEqual(saved.etag,object.etag,'the fence write rotated the ETag');
 };
 {
  // content-addressed ETags: rewriting the identical bytes keeps the ETag, so it is NOT a fence, and a suspended writer then still lands (the defect the review found)
  const object=await bucket.get('ui/filter-presets.json');
  const same=await bucket.put('ui/filter-presets.json',await object.text(),{onlyIf:{etagMatches:object.etag}});
  assert.equal(same.etag,object.etag,'identical bytes keep the identical ETag');
  const unfenced=await bucket.put('ui/filter-presets.json',JSON.stringify({schemaVersion:1,presets:[]}),{onlyIf:{etagMatches:object.etag}});
  assert.ok(unfenced,'with an identical-bytes rewrite a pre-existing conditional PUT still succeeds');
  records.clear();raws.clear();etags.clear();
  const again=await call(withD1,env,'POST',URLP,'"none"',{name:'Исходный',query:'started=1'});assert.equal(again.status,201);seeded.body=again.body;seeded.etag=again.etag;
 }
 {
  // the byte-distinct fence: a writer holding the pre-fence ETag fails, and the fenced object still reads
  const object=await bucket.get('ui/filter-presets.json');
  await fence();
  const stale=await bucket.put('ui/filter-presets.json',JSON.stringify({schemaVersion:1,presets:[]}),{onlyIf:{etagMatches:object.etag}});
  assert.equal(stale,null,'a suspended writer with the old ETag fails after the byte-distinct fence');
  const read=await call(withD1,env,'GET',URLP);assert.equal(read.status,200);assert.equal(read.body.presets.length,1,'the fenced object reads as the same preset list');
  seeded.etag=read.etag;
 }
 // (a) suspended after the R2 read, hold + fence happen, then the PUT with the old ETag
 let stage=0;const realGet=bucket.get;
 bucket.get=async function(key){const object=await realGet.call(bucket,key);if(stage===1){stage=2;run(file,"UPDATE filter_preset_authority SET writes='held'");await fence();}return object;};
 stage=1;
 const delayed=await call(withD1,env,'PATCH',URLP+'/'+seeded.body.presets[0].id,seeded.etag,{name:'Запоздавший'});
 bucket.get=realGet;
 assert.ok([412,503].includes(delayed.status),'a writer admitted before the hold cannot write after it: '+delayed.status);
 assert.equal(records.get('ui/filter-presets.json').presets[0].name,'Исходный','the delayed edit did not land in R2');
 run(file,"UPDATE filter_preset_authority SET writes='open'");
 // (b) suspended after the marker recheck would pass: the fence changes the ETag, the conditional PUT fails
 const current=await call(withD1,env,'GET',URLP);
 const realPut=bucket.put;let fenced=false;
 bucket.put=async function(key,value,options){if(!fenced){fenced=true;await fence();}return realPut.call(bucket,key,value,options);};
 const late=await call(withD1,env,'PATCH',URLP+'/'+seeded.body.presets[0].id,current.etag,{name:'После fence'});
 bucket.put=realPut;
 assert.equal(late.status,412,'a PUT carrying the pre-fence ETag fails on the R2 condition');
 assert.equal(records.get('ui/filter-presets.json').presets[0].name,'Исходный');
 // (b2) admitted at r2/open, stalled BEFORE its R2 read; hold and fence happen; it then reads the post-fence ETag. Only the marker re-read before the PUT stops it.
 {
  const fresh=await call(withD1,env,'GET',URLP);
  let go=true;const get0=bucket.get;
  bucket.get=async function(key){if(go){go=false;run(file,"UPDATE filter_preset_authority SET writes='held'");await fence();}return get0.call(bucket,key);};
  const before=JSON.stringify(records.get('ui/filter-presets.json'));
  const stalled=await call(withD1,env,'PATCH',URLP+'/'+seeded.body.presets[0].id,fresh.etag,{name:'Читал после fence'});
  bucket.get=get0;
  assert.equal(stalled.status,503,'a writer that reads R2 after the fence is stopped by the marker re-read');
  assert.equal(JSON.stringify(records.get('ui/filter-presets.json')),before);
  run(file,"UPDATE filter_preset_authority SET writes='open'");
 }
 // (c) hold, fence, activation: a writer that resumes after activation is refused
 run(file,"UPDATE filter_preset_authority SET writes='held'");
 const exported=records.get('ui/filter-presets.json').presets;
 assert.equal((await Presets.importPresets(db,{presets:exported})).ok,true);
 assert.equal((await Presets.activatePresets(db,{presets:exported})).ok,true);
 const afterSwitch=await call(withD1,env,'PATCH',URLP+'/'+exported[0].id,'"d1:1"',{name:'Через D1'});
 assert.equal(afterSwitch.status,200);assert.equal(records.get('ui/filter-presets.json').presets[0].name,'Исходный','R2 stays untouched after activation');
}
{
 // P2 activation size: 30 near-limit presets keep every generated statement under D1's 100,000-byte limit
 const {spawnSync}=await import('node:child_process');
 const longQuery=index=>Array.from({length:30},(_,i)=>'channel='+('К'+index+'_'+i+'_').padEnd(120,'к')).join('&');
 const big=Array.from({length:30},(_,i)=>({id:uuid(i+1),name:('Имя '+i).padEnd(80,'и'),schemaVersion:1,query:longQuery(i),createdAt:'2026-11-01T10:00:00.000Z',updatedAt:'2026-11-01T10:00:00.000Z'}));
 const file=path.join(root,'big.json');fs.writeFileSync(file,JSON.stringify({schemaVersion:1,presets:big}));
 const tool=(...args)=>spawnSync(process.execPath,['scripts/filter-presets-d1-sql.mjs',...args],{encoding:'utf8',maxBuffer:1<<26});
 const imported=tool('import',file),activate=tool('activate',file);
 assert.equal(imported.status,0,imported.stderr);assert.equal(activate.status,0,activate.stderr);
 const bytes=text=>text.trim().split('\n').map(line=>Buffer.byteLength(line));
 assert.ok(Math.min(...bytes(activate.stdout))>0);
 const total=Buffer.byteLength(activate.stdout);assert.ok(total>100000,'the fixture is large enough that one statement would not fit ('+total+')');
 for(const text of [imported.stdout,activate.stdout,tool('hold').stdout,tool('release').stdout])assert.ok(Math.max(...bytes(text))<100000,'every statement stays under 100000 bytes: '+Math.max(...bytes(text)));
 assert.ok(Math.max(...bytes(activate.stdout))<60000,'one preset per statement (a percent-encoded normalized query is at most about 12 bytes per input character)');
 const {file:dbFile}=database();
 assert.equal(run(dbFile,tool('hold').stdout+imported.stdout+activate.stdout).status,0);
 assert.deepEqual(marker(dbFile),{mode:'d1',generation:1,writes:'open'});
 // one wrong row aborts before the switch
 const other=database();
 const tampered=path.join(root,'big-tampered.json');fs.writeFileSync(tampered,JSON.stringify({schemaVersion:1,presets:big.map((item,i)=>i===29?{...item,name:'Другое'}:item)}));
 run(other.file,tool('hold').stdout+imported.stdout);
 assert.notEqual(run(other.file,tool('activate',tampered).stdout).status,0);
 assert.equal(marker(other.file).mode,'r2','a parity mismatch in the last preset stops the file before the switch');
}

// the bundle wraps the module under its own name and the Worker route names it
assert.match(fs.readFileSync('build.mjs','utf8'),/scoped\('src\/filter-presets-d1\.js','FilterPresetsD1'\)/);
console.log('filter-presets-d1: ok');
