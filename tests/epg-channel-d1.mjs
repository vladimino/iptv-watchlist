// EPG Channel authority (schema v31, src/epg-channel-d1.js, ADR 0187). Offline only: the real migration chain on a sqlite D1 stand-in. No production database,
// bucket or Worker is opened. Proves: the migration is guarded and inert, the policy precedence, the one-snapshot read, the revision compare-and-swap, the
// fail-safe states, the provider id normalization and that the existing show keys and the scan path are untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Channel from '../src/epg-channel-d1.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-epg-channel-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const run=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const sqlite=(file,text)=>{const r=run(file,text);if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const T='2026-11-21T08:00:00.000Z';
const SHA=char=>char.repeat(64);

// ===== 1. the migration: latest, guarded, additive, inert =====
const m31='0031_epg_channel_authority.sql';
assert.ok(names.at(-1)===m31&&names.at(-2)==='0030_epg_checkpoint_authority.sql','0031 follows 0030 and is the latest migration');
const upTo=number=>names.filter(name=>Number(name.slice(0,4))<=number);
const v30=path.join(root,'v30.sqlite');sqlite(v30,upTo(30).map(read).join('\n'));
const v29=path.join(root,'v29.sqlite');sqlite(v29,upTo(29).map(read).join('\n'));
const showSchema=file=>JSON.stringify(rows(file,"SELECT name, sql FROM sqlite_master WHERE name IN ('published_epg_show','discovery_observation_show','published_epg_show_by_generation') ORDER BY name"));
const before=showSchema(v30);
const base=path.join(root,'base.sqlite');fs.copyFileSync(v30,base);
const applied=run(base,read(m31));assert.equal(applied.status,0,'0031 applies on a complete schema 30: '+applied.stderr);
assert.equal(rows(base,'SELECT version FROM schema_contract WHERE id=1')[0].version,31);
assert.equal(rows(base,'SELECT COUNT(*) AS n FROM schema_contract')[0].n,1);
assert.equal(showSchema(base),before,'the published EPG show and Discovery observation show tables (and their keys) are unchanged');
assert.deepEqual(rows(base,'SELECT revision,source_sha256,category_count,channel_count FROM epg_channel_revision'),[{revision:0,source_sha256:null,category_count:0,channel_count:0}],'one empty revision row');
assert.equal(rows(base,'SELECT COUNT(*) AS n FROM epg_channel')[0].n+rows(base,'SELECT COUNT(*) AS n FROM epg_channel_category')[0].n,0,'no rows are created');
assert.equal(rows(base,"SELECT COUNT(*) AS n FROM pragma_foreign_key_list('epg_channel') WHERE \"table\" IN ('published_epg_show','discovery_observation_show')")[0].n,0,'no foreign key to the historical show tables');
assert.equal(rows(base,"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'epg_channel%' AND name NOT IN ('epg_channel','epg_channel_category','epg_channel_revision','epg_channel_cas')")[0].n,0);
// refusals before any table is created
for(const [label,file,setup] of [['schema 29',v29,''],['schema 30 without the checkpoint tables',v30,'DROP TABLE epg_checkpoint_run;']]){
 const copy=path.join(root,'g-'+label.replace(/\W+/g,'-')+'.sqlite');fs.copyFileSync(file,copy);
 if(setup)sqlite(copy,'PRAGMA foreign_keys=OFF;'+setup);
 assert.notEqual(run(copy,read(m31)).status,0,label+': refused');
 assert.equal(rows(copy,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='epg_channel'")[0].n,0,label+': no table created');
}
{const again31=path.join(root,'again.sqlite');fs.copyFileSync(base,again31);assert.notEqual(run(again31,read(m31)).status,0,'a second apply is refused');}
// constraints: values, uniqueness, override consistency, downgrade
let badCopies=0;
const bad=sql=>{const copy=path.join(root,'bad-'+(badCopies++)+'.sqlite');fs.copyFileSync(base,copy);assert.notEqual(run(copy,sql).status,0,sql);};
bad("INSERT INTO epg_channel_category VALUES ('a','A','allow',0,1)");
bad("INSERT INTO epg_channel_category VALUES ('a','A','discover',0,1);INSERT INTO epg_channel (channel_id,source_id,revision,override_policy) VALUES ('ch001','tvg_1',1,'discover')");
bad("INSERT INTO epg_channel_category VALUES ('a','A','discover',0,1);INSERT INTO epg_channel (channel_id,source_id,revision,category_key) VALUES ('ch001','tvg_1',1,'missing')");
bad("INSERT INTO epg_channel_category VALUES ('a','A','discover',0,1);INSERT INTO epg_channel (channel_id,source_id,revision) VALUES ('ch001','tvg_1',1),('ch002','tvg_1',1)");
bad("UPDATE schema_contract SET version=30 WHERE id=1");
bad("UPDATE epg_channel_cas SET ok=0 WHERE id=1");

// ===== 2. dormant: no source file, bundle step or route reaches the tables =====
const holders=[];
for(const dir of ['src','src/admin','src/domain']){for(const name of fs.readdirSync(dir)){if(!name.endsWith('.js')||name==='epg-channel-d1.js')continue;const text=fs.readFileSync(path.join(dir,name),'utf8');if(/epg_channel|epg-channel-d1|EpgChannel/.test(text))holders.push(path.join(dir,name));}}
assert.deepEqual(holders,[],'nothing in src reads or imports the Channel tables or module');
assert.ok(!/epg-channel/.test(fs.readFileSync('build.mjs','utf8')),'the bundle does not include the module');
assert.ok(!/epg_channel/.test(fs.readFileSync('src/worker.js','utf8')),'scanEPG and the Worker never name the tables');

// ===== 3. identity: tvg_1259 -> ch1259, tvg_1 -> ch001 =====
const norm=value=>Channel.normalizeProviderId(value);
assert.deepEqual(norm('tvg_1259'),{ok:true,channelId:'ch1259'});
assert.deepEqual(norm('tvg_1'),{ok:true,channelId:'ch001'});
assert.deepEqual(norm('tvg_12'),{ok:true,channelId:'ch012'});
assert.deepEqual(norm(' tvg_100 '),{ok:true,channelId:'ch100'});
for(const value of ['tvg_001','tvg_','tvg_x','ch1259','1259','tvg_1259a','TVG_1',null,undefined,12,'tvg_1234567'])assert.equal(norm(value).ok,false,String(value)+' is a source error');
assert.ok(Channel.isChannelId('ch001')&&Channel.isChannelId('ch1259')&&!Channel.isChannelId('tvg_1')&&!Channel.isChannelId('ch01'));

// ===== 4. the import plan: categories, duplicates and mismatches are source errors, names never match =====
const GROUPS=[{name:'Movies',policy:'discover'},{name:'News',policy:'deny_all'},{name:'Sport  HD',policy:'deny_all'}];
const ENTRIES=[
 {sourceId:'tvg_1',name:'Film One',group:'Movies'},
 {sourceId:'tvg_2',name:'Film One',group:'News'},
 {sourceId:'tvg_1259',name:'Sport',group:'sport hd'},
 {sourceId:'tvg_9',name:'Loose',group:''},
];
const plan=Channel.planImport({groups:GROUPS,entries:ENTRIES});
assert.equal(plan.ok,true);
assert.deepEqual(plan.channels.map(channel=>[channel.channelId,channel.categoryKey]),[['ch001','movies'],['ch002','news'],['ch1259','sport hd'],['ch009',null]],'same name, different ids: never merged by name; no group stays unclassified');
assert.deepEqual(plan.categories.map(category=>[category.categoryKey,category.name,category.policy,category.position]),[['movies','Movies','discover',0],['news','News','deny_all',1],['sport hd','Sport HD','deny_all',2]]);
const errorsOf=(groups,entries)=>{const r=Channel.planImport({groups,entries});assert.equal(r.ok,false);assert.ok(r.errors.length);return r.errors.map(error=>error.code);};
assert.deepEqual(errorsOf(GROUPS,[{sourceId:'tvg_1',group:'Movies'},{sourceId:'tvg_1',group:'News'}]),['duplicate_channel_id'],'a duplicate id is an error even in another group');
assert.deepEqual(errorsOf(GROUPS,[{sourceId:'tvg_1',group:'Movies'},{sourceId:'tvg_01x',group:'Movies'}]),['invalid_source_id']);
assert.deepEqual(errorsOf(GROUPS,[{sourceId:'tvg_3',group:'Missing'}]),['unknown_category'],'a group no declaration names is a mismatch');
assert.deepEqual(errorsOf([{name:'A',policy:'discover'},{name:' a ',policy:'deny_all'}],[]),['duplicate_category']);
assert.deepEqual(errorsOf([{name:'A',policy:'allow'}],[]),['invalid_policy']);
assert.deepEqual(errorsOf([{name:'',policy:'discover'}],[]),['invalid_category']);
assert.equal(Channel.planImport({groups:'x',entries:[]}).ok,false);
const manyErrors=Channel.planImport({groups:GROUPS,entries:Array.from({length:200},()=>({sourceId:'bad'}))});
assert.equal(manyErrors.errors.length,Channel.IMPORT_ERROR_CAP,'the error list is bounded');

// ===== 5. the snapshot: precedence override > category > known_only, fallbacks, one bounded read =====
let copies=0;
const fresh=(options={})=>{const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(base,file);return {file,db:d1Standin(file,options)};};
const {file:f1,db:d1}=fresh();
const empty=await Channel.readSnapshot(d1);
assert.equal(empty.ok,true);assert.equal(empty.empty,true);assert.equal(empty.revision,0);
assert.deepEqual(empty.lookup.policyFor('ch001'),{policy:'known_only',basis:'unknown',degraded:false},'an empty snapshot knows nothing: known_only, never discover');
const committed=await Channel.commitImport(d1,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});
assert.deepEqual(committed,{ok:true,revision:1});
let snap=await Channel.readSnapshot(d1);
assert.equal(snap.ok,true);assert.equal(snap.revision,1);assert.equal(snap.sourceSha256,SHA('a'));
const policyOf=id=>snap.lookup.policyFor(id);
assert.deepEqual(policyOf('ch001'),{policy:'discover',basis:'category',degraded:false});
assert.deepEqual(policyOf('ch002'),{policy:'deny_all',basis:'category',degraded:false});
assert.deepEqual(policyOf('ch1259'),{policy:'deny_all',basis:'category',degraded:false});
assert.deepEqual(policyOf('ch009'),{policy:'known_only',basis:'unclassified',degraded:false},'a channel with no category is known_only');
assert.deepEqual(policyOf('ch777'),{policy:'known_only',basis:'unknown',degraded:false},'an unknown id is known_only');
assert.deepEqual(policyOf(undefined),{policy:'known_only',basis:'unknown',degraded:false});
// owner override beats the category in both directions
assert.deepEqual(await Channel.setOverride(d1,{expectedRevision:1,channelId:'ch002',policy:'discover',note:'owner asked',now:T}),{ok:true,revision:2});
assert.deepEqual(await Channel.setOverride(d1,{expectedRevision:2,channelId:'ch001',policy:'deny_all',now:T}),{ok:true,revision:3});
assert.deepEqual(await Channel.setOverride(d1,{expectedRevision:3,channelId:'ch009',policy:'discover',now:T}),{ok:true,revision:4});
snap=await Channel.readSnapshot(d1);
assert.deepEqual(policyOf('ch002'),{policy:'discover',basis:'override',degraded:false});
assert.deepEqual(policyOf('ch001'),{policy:'deny_all',basis:'override',degraded:false});
assert.deepEqual(policyOf('ch009'),{policy:'discover',basis:'override',degraded:false},'an override also classifies an unclassified channel');
assert.equal(snap.channels.get('ch002').overrideNote,'owner asked');
assert.deepEqual(await Channel.setOverride(d1,{expectedRevision:4,channelId:'ch002',policy:null,now:T}),{ok:true,revision:5});
snap=await Channel.readSnapshot(d1);
assert.deepEqual(policyOf('ch002'),{policy:'deny_all',basis:'category',degraded:false},'clearing the override returns the category policy');
assert.equal(snap.channels.get('ch002').overrideNote,null);
// the read is four statements for any number of channels, and a lookup afterwards touches no database
const counting=fresh();let seen=0;const spy=d1Standin(counting.file,{onQuery:()=>{seen++;}});
const big=Channel.planImport({groups:[{name:'G',policy:'discover'}],entries:Array.from({length:600},(_,index)=>({sourceId:'tvg_'+(index+1),name:'n'+index,group:'G'}))});
assert.equal((await Channel.commitImport(spy,{expectedRevision:0,sourceSha256:SHA('b'),plan:big,now:T})).ok,true,'600 channels commit in one batch');
seen=0;const bigSnap=await Channel.readSnapshot(spy);
assert.equal(bigSnap.channels.size,600);
assert.ok(seen<=5,'one snapshot read is a bounded number of statements ('+seen+'), not one per channel');
seen=0;for(let index=1;index<=600;index++)bigSnap.lookup.policyFor('ch'+String(index).padStart(3,'0'));bigSnap.lookup.policyFor('ch9999');
assert.equal(seen,0,'no per-channel D1 read in a scan loop');
assert.equal(spy.calls.batches,1);

// ===== 6. revision compare-and-swap and idempotence =====
const {file:f2,db:d2}=fresh();
assert.equal((await Channel.commitImport(d2,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T})).ok,true);
assert.deepEqual(await Channel.commitImport(d2,{expectedRevision:0,sourceSha256:SHA('c'),plan,now:T}),{ok:false,reason:'conflict'},'a stale import loses');
assert.deepEqual(await Channel.setOverride(d2,{expectedRevision:0,channelId:'ch001',policy:'discover',now:T}),{ok:false,reason:'invalid'},'an override cannot be written against the empty revision');
assert.deepEqual(await Channel.setOverride(d2,{expectedRevision:5,channelId:'ch001',policy:'discover',now:T}),{ok:false,reason:'conflict'});
const again=await Channel.commitImport(d2,{expectedRevision:1,sourceSha256:SHA('a'),plan,now:T});
assert.deepEqual(again,{ok:true,revision:1,unchanged:true},'the same import digest at the current revision writes nothing');
assert.equal(rows(f2,'SELECT revision FROM epg_channel_revision')[0].revision,1);
// two writers on one revision: exactly one wins and the loser changes nothing
const results=await Promise.all([
 Channel.setOverride(d2,{expectedRevision:1,channelId:'ch001',policy:'deny_all',now:T}),
 Channel.setOverride(d2,{expectedRevision:1,channelId:'ch002',policy:'discover',now:T}),
]);
assert.equal(results.filter(result=>result.ok).length,1,'one of two writers wins');
assert.ok(results.some(result=>!result.ok&&result.reason==='conflict'));
assert.equal(rows(f2,'SELECT COUNT(*) AS n FROM epg_channel WHERE override_policy IS NOT NULL')[0].n,1,'the loser wrote no override');
assert.equal(rows(f2,'SELECT revision FROM epg_channel_revision')[0].revision,2);
assert.deepEqual(await Channel.setOverride(d2,{expectedRevision:2,channelId:'ch555',policy:'discover',now:T}),{ok:false,reason:'unknown_channel'},'an unknown channel is not created by an override');
for(const input of [{policy:'allow'},{channelId:'tvg_1'},{note:5}])assert.deepEqual(await Channel.setOverride(d2,{expectedRevision:2,channelId:'ch001',policy:'discover',now:T,...input}),{ok:false,reason:'invalid'});
assert.deepEqual(await Channel.commitImport(d2,{expectedRevision:2,sourceSha256:'short',plan,now:T}),{ok:false,reason:'invalid'});
assert.deepEqual(await Channel.commitImport(d2,{expectedRevision:2,sourceSha256:SHA('d'),plan:{ok:false},now:T}),{ok:false,reason:'invalid'},'a refused plan is never committed');

// an import keeps overrides, drops unlisted unoverridden channels and unclassifies unlisted overridden ones
const {file:f3,db:d3}=fresh();
await Channel.commitImport(d3,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});
await Channel.setOverride(d3,{expectedRevision:1,channelId:'ch002',policy:'discover',note:'keep me',now:T});
await Channel.setOverride(d3,{expectedRevision:2,channelId:'ch1259',policy:'known_only',now:T});
const next=Channel.planImport({groups:[{name:'Movies',policy:'deny_all'},{name:'Kids',policy:'discover'}],entries:[{sourceId:'tvg_1',name:'Film One',group:'movies'},{sourceId:'tvg_5',name:'Cartoons',group:'Kids'}]});
assert.deepEqual(await Channel.commitImport(d3,{expectedRevision:3,sourceSha256:SHA('e'),plan:next,now:T}),{ok:true,revision:4});
snap=await Channel.readSnapshot(d3);
assert.deepEqual([...snap.channels.keys()].sort(),['ch001','ch002','ch005','ch1259'],'ch009 had no override and is gone; ch002 and ch1259 keep theirs');
assert.deepEqual(policyOf('ch001'),{policy:'deny_all',basis:'category',degraded:false},'a changed category policy applies');
assert.deepEqual(policyOf('ch002'),{policy:'discover',basis:'override',degraded:false},'the override survived an import that no longer lists the channel');
assert.equal(snap.channels.get('ch002').categoryKey,null);assert.equal(snap.channels.get('ch002').overrideNote,'keep me');
assert.deepEqual(policyOf('ch005'),{policy:'discover',basis:'category',degraded:false});
assert.deepEqual([...snap.categories.keys()],['movies','kids'],'categories the import no longer declares are removed');

// ===== 7. fail-safe states: never discover =====
const degraded=(result,reason)=>{assert.equal(result.ok,false);assert.equal(result.reason,reason);assert.equal(result.lookup.degraded,true);assert.deepEqual(result.lookup.policyFor('ch001'),{policy:'known_only',basis:'unavailable',degraded:true});};
degraded(await Channel.readSnapshot(undefined),'unavailable');
degraded(await Channel.readSnapshot({}),'unavailable');
degraded(await Channel.readSnapshot({prepare(){throw new Error('D1 down');}}),'unavailable');
const pre=path.join(root,'pre.sqlite');fs.copyFileSync(v30,pre);
degraded(await Channel.readSnapshot(d1Standin(pre)),'absent');
const partial=fresh();sqlite(partial.file,'DROP TABLE epg_channel_cas;');
degraded(await Channel.readSnapshot(partial.db),'incomplete');
for(const [label,sql] of [
 ['a channel row lost','DELETE FROM epg_channel WHERE channel_id=\'ch001\';'],
 ['a category row lost','PRAGMA foreign_keys=OFF;DELETE FROM epg_channel_category WHERE category_key=\'movies\';'],
 ['a row from a future revision','UPDATE epg_channel SET revision=99 WHERE channel_id=\'ch001\';'],
 ['rows with revision 0 marker','UPDATE epg_channel_revision SET revision=0;'],
 ['a channel naming a missing category','PRAGMA foreign_keys=OFF;UPDATE epg_channel SET category_key=\'ghost\' WHERE channel_id=\'ch001\';'],
 ['the marker row deleted','DELETE FROM epg_channel_revision;'],
]){
 const torn=fresh();await Channel.commitImport(torn.db,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});sqlite(torn.file,sql);
 degraded(await Channel.readSnapshot(torn.db),'incomplete');
}
// a revision that moves during the read retries once; two moves fail closed
let moves=0;const racing=fresh({onQuery:text=>{if(/^SELECT category_key/.test(text)&&moves<2){moves++;sqlite(racing.file,'UPDATE epg_channel_revision SET revision=revision+1;');}}});
await Channel.commitImport(racing.db,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});
degraded(await Channel.readSnapshot(racing.db),'unavailable');
// write refusals with no database or a database that cannot batch
assert.deepEqual(await Channel.commitImport(undefined,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T}),{ok:false,reason:'unavailable'});
assert.deepEqual(await Channel.setOverride({prepare:d1.prepare},{expectedRevision:5,channelId:'ch001',policy:'discover',now:T}).then(result=>result.reason),'unavailable');

// ===== 8. lost reply: success only when the stored state is exactly this request =====
const lost=fresh();
const lossy={prepare:sql=>lost.db.prepare(sql),batch:async statements=>{await lost.db.batch(statements);throw new Error('network lost the reply');}};
assert.deepEqual(await Channel.commitImport(lossy,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T}),{ok:true,revision:1},'an applied batch whose reply was lost is success');
assert.deepEqual(await Channel.setOverride(lossy,{expectedRevision:1,channelId:'ch001',policy:'deny_all',now:T}),{ok:true,revision:2});
const failing={prepare:sql=>lost.db.prepare(sql),batch:async()=>{throw new Error('network down');}};
assert.deepEqual(await Channel.setOverride(failing,{expectedRevision:2,channelId:'ch001',policy:'discover',now:T}),{ok:false,reason:'unavailable'},'a batch that did not apply is not success');
assert.equal(rows(lost.file,'SELECT override_policy FROM epg_channel WHERE channel_id=\'ch001\'')[0].override_policy,'deny_all');
// a competitor committed the next revision with different content: the lost-reply check does not claim success
const rival=fresh();await Channel.commitImport(rival.db,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});
const sneaky={prepare:sql=>rival.db.prepare(sql),batch:async()=>{await Channel.setOverride(rival.db,{expectedRevision:1,channelId:'ch002',policy:'discover',now:T});throw new Error('reply lost');}};
assert.equal((await Channel.setOverride(sneaky,{expectedRevision:1,channelId:'ch001',policy:'deny_all',now:T})).ok,false,'another writer won that revision');

console.log('EPG Channel authority: guarded inert migration v31, show keys untouched, provider id normalization, override > category > known_only, one bounded snapshot and no per-channel reads, revision CAS, fail-safe known_only states, lost-reply classification, nothing in src reaches the tables.');
