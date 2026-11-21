// EPG Channel authority (schema v32, src/epg-channel-d1.js, ADR 0187). Offline only: the real migration chain on a sqlite D1 stand-in. No production database,
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
const m32='0032_epg_channel_authority.sql';
assert.ok(names.at(-1)===m32&&names.at(-2)==='0031_watchlist_authority.sql','0032 follows 0031 and is the latest migration');
const upTo=number=>names.filter(name=>Number(name.slice(0,4))<=number);
const v31=path.join(root,'v31.sqlite');sqlite(v31,upTo(31).map(read).join('\n'));
const v30=path.join(root,'v30.sqlite');sqlite(v30,upTo(30).map(read).join('\n'));
const showSchema=file=>JSON.stringify(rows(file,"SELECT name, sql FROM sqlite_master WHERE name IN ('published_epg_show','discovery_observation_show','published_epg_show_by_generation') ORDER BY name"));
const before=showSchema(v31);
const base=path.join(root,'base.sqlite');fs.copyFileSync(v31,base);
const applied=run(base,read(m32));assert.equal(applied.status,0,'0032 applies on a complete schema 31: '+applied.stderr);
assert.equal(rows(base,'SELECT version FROM schema_contract WHERE id=1')[0].version,32);
assert.equal(rows(base,'SELECT COUNT(*) AS n FROM schema_contract')[0].n,1);
assert.equal(showSchema(base),before,'the published EPG show and Discovery observation show tables (and their keys) are unchanged');
assert.deepEqual(rows(base,'SELECT revision,source_sha256,category_count,channel_count FROM epg_channel_revision'),[{revision:0,source_sha256:null,category_count:0,channel_count:0}],'one empty revision row');
assert.equal(rows(base,'SELECT COUNT(*) AS n FROM epg_channel')[0].n+rows(base,'SELECT COUNT(*) AS n FROM epg_channel_category')[0].n,0,'no rows are created');
assert.equal(rows(base,"SELECT COUNT(*) AS n FROM pragma_foreign_key_list('epg_channel') WHERE \"table\" IN ('published_epg_show','discovery_observation_show')")[0].n,0,'no foreign key to the historical show tables');
assert.equal(rows(base,"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'epg_channel%' AND name NOT IN ('epg_channel','epg_channel_category','epg_channel_revision','epg_channel_cas')")[0].n,0);
// refusals before any table is created
for(const [label,file,setup] of [['schema 30',v30,''],['schema 31 without the Watchlist tables',v31,'DROP TABLE watchlist_current;']]){
 const copy=path.join(root,'g-'+label.replace(/\W+/g,'-')+'.sqlite');fs.copyFileSync(file,copy);
 if(setup)sqlite(copy,'PRAGMA foreign_keys=OFF;'+setup);
 assert.notEqual(run(copy,read(m32)).status,0,label+': refused');
 assert.equal(rows(copy,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='epg_channel'")[0].n,0,label+': no table created');
}
{const again31=path.join(root,'again.sqlite');fs.copyFileSync(base,again31);assert.notEqual(run(again31,read(m32)).status,0,'a second apply is refused');}
// constraints: values, uniqueness, override consistency, downgrade
let badCopies=0;
const bad=sql=>{const copy=path.join(root,'bad-'+(badCopies++)+'.sqlite');fs.copyFileSync(base,copy);assert.notEqual(run(copy,sql).status,0,sql);};
bad("INSERT INTO epg_channel_category VALUES ('a','A','allow',0,1)");
bad("INSERT INTO epg_channel_category VALUES ('a','A','discover',0,1);INSERT INTO epg_channel (channel_id,source_id,revision,override_policy) VALUES ('ch001','tvg_1',1,'discover')");
bad("INSERT INTO epg_channel_category VALUES ('a','A','discover',0,1);INSERT INTO epg_channel (channel_id,source_id,revision,category_key) VALUES ('ch001','tvg_1',1,'missing')");
bad("INSERT INTO epg_channel_category VALUES ('a','A','discover',0,1);INSERT INTO epg_channel (channel_id,source_id,revision) VALUES ('ch001','tvg_1',1),('ch002','tvg_1',1)");
bad("UPDATE schema_contract SET version=30 WHERE id=1");
bad("UPDATE epg_channel_cas SET ok=0 WHERE id=1");
bad("UPDATE epg_channel_revision SET import_revision=9 WHERE id=1");

// ===== 2. the scan path stays dormant: only the owner Channel admin (AIR-562) bundles the module =====
const holders=[];
for(const dir of ['src','src/admin','src/domain']){for(const name of fs.readdirSync(dir)){if(!name.endsWith('.js')||name==='epg-channel-d1.js')continue;const text=fs.readFileSync(path.join(dir,name),'utf8');if(/epg_channel|epg-channel-d1|EpgChannel/.test(text))holders.push(path.join(dir,name));}}
assert.deepEqual(holders.sort(),['src/admin/channels-client.js','src/admin/channels.js'],'only the owner-only Channel admin route (and its browser client, which names just the action header) mentions the Channel module and tables');
for(const scan of ['src/discovery.js','src/epg-orchestration.js','src/enrichment.js','src/published-epg.js','src/discovery-workflow.js','src/mcp.js','src/monitor.js','src/continuation.js'])assert.ok(!/epg_channel|EpgChannel/.test(fs.readFileSync(scan,'utf8')),scan+' never reads the Channel policy: it is staged, not active');
assert.ok(/scoped\('src\/epg-channel-d1\.js','EpgChannelD1'\)/.test(fs.readFileSync('build.mjs','utf8')),'the bundle includes the module for the admin route');
assert.ok(!/epg_channel|EpgChannel/.test(fs.readFileSync('src/worker.js','utf8')),'scanEPG and the Worker body never name the tables or the module (only the route name adminChannelsRoute)');

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

// ===== 5. the snapshot: precedence owner override > owner category > provider category > known_only, XMLTV-only channels, fallbacks, one bounded read =====
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
const big=Channel.planImport({groups:[{name:'G',policy:'discover'}],entries:Array.from({length:2103},(_,index)=>({sourceId:'tvg_'+(index+1),name:'n'+index,group:'G'})),xmltvChannels:[...Array.from({length:1340},(_,index)=>({channelId:'ch'+String(index+1).padStart(3,'0'),name:'x'+index})),...Array.from({length:15},(_,index)=>({channelId:'ch'+(5001+index),name:'only'+index}))]});
assert.equal((await Channel.commitImport(spy,{expectedRevision:0,sourceSha256:SHA('b'),plan:big,now:T})).ok,true,'2118 channels (2103 M3U plus 15 XMLTV-only, the audited baseline) commit in one batch');
seen=0;const bigSnap=await Channel.readSnapshot(spy);
assert.equal(bigSnap.channels.size,2118);
assert.equal([...bigSnap.channels.values()].filter(channel=>channel.origin==='xmltv').length,15);
assert.equal(seen,5,'one snapshot read is one table-existence query plus four data queries ('+seen+'), not one per channel');
seen=0;for(let index=1;index<=2103;index++)bigSnap.lookup.policyFor('ch'+String(index).padStart(3,'0'));bigSnap.lookup.policyFor('ch9999');
assert.equal(seen,0,'no per-channel D1 read in a scan loop');
assert.equal(spy.calls.batches,1);
assert.ok(spy.calls.statements<=200,'one bounded batch of '+spy.calls.statements+' statements for 2118 channels (14 per statement)');

// ===== 6. revision compare-and-swap and idempotence =====
const {file:f2,db:d2}=fresh();
assert.equal((await Channel.commitImport(d2,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T})).ok,true);
assert.deepEqual(await Channel.commitImport(d2,{expectedRevision:0,sourceSha256:SHA('c'),plan,now:T}),{ok:false,reason:'conflict'},'a stale import loses');
assert.deepEqual(await Channel.setOverride(d2,{expectedRevision:0,channelId:'ch001',policy:'discover',now:T}),{ok:false,reason:'invalid'},'an override cannot be written against the empty revision');
assert.deepEqual(await Channel.setOverride(d2,{expectedRevision:5,channelId:'ch001',policy:'discover',now:T}),{ok:false,reason:'conflict'});
const again=await Channel.commitImport(d2,{expectedRevision:1,sourceSha256:SHA('a'),plan,now:T});
assert.deepEqual(again,{ok:true,revision:1,unchanged:true},'the same import digest at the current revision writes nothing');
assert.equal(rows(f2,'SELECT revision FROM epg_channel_revision')[0].revision,1);
// the same provider files with a CHANGED category policy are not a no-op: the no-op key is the digest of the whole normalized plan, never the caller's source digest
{
 const {db:dp,file:fp}=fresh();
 await Channel.commitImport(dp,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});
 const flipped=Channel.planImport({groups:GROUPS.map(group=>group.name==='Movies'?{...group,policy:'deny_all'}:group),entries:ENTRIES});
 assert.deepEqual(await Channel.commitImport(dp,{expectedRevision:1,sourceSha256:SHA('a'),plan:flipped,now:T}),{ok:true,revision:2},'same source digest, changed policy: written');
 const after=await Channel.readSnapshot(dp);
 assert.deepEqual(after.lookup.policyFor('ch001'),{policy:'deny_all',basis:'category',degraded:false},'Movies discover to deny_all applies');
 assert.equal(rows(fp,'SELECT source_sha256 FROM epg_channel_revision')[0].source_sha256,SHA('a'),'the source digest stays provenance');
 assert.deepEqual(await Channel.commitImport(dp,{expectedRevision:2,sourceSha256:SHA('d'),plan:flipped,now:T}),{ok:true,revision:2,unchanged:true},'an identical whole plan is a no-op whatever the source digest');
}
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

// an import never deletes a channel: an unlisted one is kept unclassified (known_only, or its override) and reads listed:false
const {file:f3,db:d3}=fresh();
await Channel.commitImport(d3,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});
await Channel.setOverride(d3,{expectedRevision:1,channelId:'ch002',policy:'discover',note:'keep me',now:T});
await Channel.setOverride(d3,{expectedRevision:2,channelId:'ch1259',policy:'known_only',now:T});
const next=Channel.planImport({groups:[{name:'Movies',policy:'deny_all'},{name:'Kids',policy:'discover'}],entries:[{sourceId:'tvg_1',name:'Film One',group:'movies'},{sourceId:'tvg_5',name:'Cartoons',group:'Kids'}]});
assert.deepEqual(await Channel.commitImport(d3,{expectedRevision:3,sourceSha256:SHA('e'),plan:next,now:T}),{ok:true,revision:4});
snap=await Channel.readSnapshot(d3);
assert.equal(snap.ok,true);assert.equal(snap.importRevision,4);
assert.deepEqual([...snap.channels.keys()].sort(),['ch001','ch002','ch005','ch009','ch1259'],'no channel is deleted for being missing from the new source');
assert.deepEqual([...snap.channels.values()].map(channel=>[channel.channelId,channel.listed]).sort(),[['ch001',true],['ch002',false],['ch005',true],['ch009',false],['ch1259',false]],'absence is exposed as listed:false');
assert.deepEqual(policyOf('ch009'),{policy:'known_only',basis:'unclassified',degraded:false},'an unlisted, unoverridden channel is unclassified known_only');
assert.equal(snap.channels.get('ch009').categoryKey,null);
assert.deepEqual(policyOf('ch002'),{policy:'discover',basis:'override',degraded:false},'the override survived an import that no longer lists the channel');
assert.equal(snap.channels.get('ch002').categoryKey,null);assert.equal(snap.channels.get('ch002').overrideNote,'keep me');
assert.deepEqual(policyOf('ch001'),{policy:'deny_all',basis:'category',degraded:false},'a changed category policy applies');
assert.deepEqual(policyOf('ch005'),{policy:'discover',basis:'category',degraded:false});
assert.deepEqual([...snap.categories.keys()],['movies','kids'],'categories the import no longer declares are removed (no channel references them)');
assert.equal(rows(f3,'SELECT channel_count FROM epg_channel_revision')[0].channel_count,5,'the stored count includes retained channels');
// a channel listed again is listed again
const back=Channel.planImport({groups:[{name:'Movies',policy:'deny_all'}],entries:[{sourceId:'tvg_9',name:'Loose',group:'Movies'},{sourceId:'tvg_1',name:'Film One',group:'Movies'}]});
assert.equal((await Channel.commitImport(d3,{expectedRevision:4,sourceSha256:SHA('f'),plan:back,now:T})).ok,true);
snap=await Channel.readSnapshot(d3);
assert.equal(snap.channels.get('ch009').listed,true);assert.deepEqual(policyOf('ch009'),{policy:'deny_all',basis:'category',degraded:false});
assert.equal(snap.channels.get('ch005').listed,false);

// ===== 6b. XMLTV-only channels, the owner category and the four-step precedence =====
{
 const xplan=Channel.planImport({groups:GROUPS,entries:ENTRIES,xmltvChannels:[{channelId:'ch001',name:'x'},{channelId:'ch5000',name:'Only XMLTV'},{channelId:'ch5001'}]});
 assert.equal(xplan.ok,true);
 assert.deepEqual(xplan.channels.map(channel=>[channel.channelId,channel.sourceId,channel.origin]).filter(row=>['ch001','ch5000','ch5001'].includes(row[0])),[['ch001','tvg_1','m3u'],['ch5000',null,'xmltv'],['ch5001',null,'xmltv']],'an XMLTV id an M3U entry normalizes to is the same channel; the others have no provider id');
 assert.equal(xplan.channels.find(channel=>channel.channelId==='ch001').name,'Film One','the M3U name wins for a matched channel');
 const codes=(xmltvChannels)=>{const r=Channel.planImport({groups:GROUPS,entries:ENTRIES,xmltvChannels});assert.equal(r.ok,false);return r.errors.map(error=>error.code);};
 assert.deepEqual(codes([{channelId:'tvg_5000'}]),['invalid_channel_id']);
 assert.deepEqual(codes([{channelId:'ch5000'},{channelId:'ch5000'}]),['duplicate_channel_id'],'a duplicate XMLTV id is a source error');
 assert.equal(Channel.planImport({groups:GROUPS,entries:ENTRIES,xmltvChannels:'x'}).ok,false);
 const {file:fx,db:dx}=fresh();
 assert.deepEqual(await Channel.commitImport(dx,{expectedRevision:0,sourceSha256:SHA('a'),plan:xplan,now:T}),{ok:true,revision:1});
 let sx=await Channel.readSnapshot(dx);
 assert.equal(sx.ok,true);
 const only=sx.channels.get('ch5000');
 assert.deepEqual([only.sourceId,only.origin,only.categoryKey,only.listed],[null,'xmltv',null,true],'persisted without a provider id, unclassified, listed');
 assert.deepEqual(sx.lookup.policyFor('ch5000'),{policy:'known_only',basis:'unclassified',degraded:false},'XMLTV-only is known_only until classified');
 assert.notEqual(rows(fx,"SELECT origin FROM epg_channel WHERE channel_id='ch001'")[0].origin,'xmltv');
 // owner category on an XMLTV-only channel, and on an M3U one (provider category stays untouched)
 assert.deepEqual(await Channel.setOwnerCategory(dx,{expectedRevision:1,channelId:'ch5000',categoryKey:'movies',note:'owner',now:T}),{ok:true,revision:2});
 assert.deepEqual(await Channel.setOwnerCategory(dx,{expectedRevision:2,channelId:'ch002',categoryKey:'movies',now:T}),{ok:true,revision:3});
 sx=await Channel.readSnapshot(dx);
 assert.deepEqual(sx.lookup.policyFor('ch5000'),{policy:'discover',basis:'owner_category',degraded:false},'owner category policy applies to an XMLTV-only channel');
 assert.deepEqual(sx.lookup.policyFor('ch002'),{policy:'discover',basis:'owner_category',degraded:false},'owner category beats the provider category (news, deny_all)');
 assert.equal(sx.channels.get('ch002').categoryKey,'news','the provider category is a separate field and is untouched');
 assert.equal(sx.channels.get('ch5000').ownerCategoryNote,'owner');
 // precedence: owner policy override > owner category > provider category > known_only
 assert.deepEqual(await Channel.setOverride(dx,{expectedRevision:3,channelId:'ch002',policy:'deny_all',now:T}),{ok:true,revision:4});
 sx=await Channel.readSnapshot(dx);
 assert.deepEqual(sx.lookup.policyFor('ch002'),{policy:'deny_all',basis:'override',degraded:false},'an owner policy override beats the owner category');
 // an import never resets the owner category, and keeps the category it points at even when the import stops declaring it
 const shrunk=Channel.planImport({groups:[{name:'News',policy:'deny_all'}],entries:[{sourceId:'tvg_2',name:'Film One',group:'News'}],xmltvChannels:[{channelId:'ch5000'}]});
 assert.deepEqual(await Channel.commitImport(dx,{expectedRevision:4,sourceSha256:SHA('b'),plan:shrunk,now:T}),{ok:true,revision:5});
 sx=await Channel.readSnapshot(dx);
 assert.equal(sx.ok,true);
 assert.equal(sx.channels.get('ch5000').ownerCategoryKey,'movies','the import did not reset the owner category');
 assert.deepEqual(sx.lookup.policyFor('ch5000'),{policy:'discover',basis:'owner_category',degraded:false},'its category (Movies) is retained although the import no longer declares it');
 assert.ok(sx.categories.has('movies')&&sx.categories.has('news'));
 assert.equal(sx.channels.get('ch001').listed,false);assert.deepEqual(sx.lookup.policyFor('ch001'),{policy:'known_only',basis:'unclassified',degraded:false});
 // a channel first registered from XMLTV that M3U lists later gets its provider id and keeps its registration origin
 const later=Channel.planImport({groups:GROUPS,entries:[{sourceId:'tvg_5000',name:'Now in M3U',group:'News'}],xmltvChannels:[{channelId:'ch5000'}]});
 assert.deepEqual(await Channel.commitImport(dx,{expectedRevision:5,sourceSha256:SHA('c'),plan:later,now:T}),{ok:true,revision:6});
 sx=await Channel.readSnapshot(dx);
 assert.deepEqual([sx.channels.get('ch5000').sourceId,sx.channels.get('ch5000').origin,sx.channels.get('ch5000').categoryKey],['tvg_5000','xmltv','news'],'provider id and category arrive, the registration origin stays');
 assert.deepEqual(sx.lookup.policyFor('ch5000'),{policy:'discover',basis:'owner_category',degraded:false});
 // clearing, refusals and CAS
 assert.deepEqual(await Channel.setOwnerCategory(dx,{expectedRevision:6,channelId:'ch5000',categoryKey:null,now:T}),{ok:true,revision:7});
 sx=await Channel.readSnapshot(dx);
 assert.deepEqual(sx.lookup.policyFor('ch5000'),{policy:'deny_all',basis:'category',degraded:false},'clearing returns the provider category policy');
 assert.deepEqual(await Channel.setOwnerCategory(dx,{expectedRevision:7,channelId:'ch5000',categoryKey:'ghost',now:T}),{ok:false,reason:'unknown_category'});
 assert.deepEqual(await Channel.setOwnerCategory(dx,{expectedRevision:7,channelId:'ch9999',categoryKey:'news',now:T}),{ok:false,reason:'unknown_channel'});
 assert.deepEqual(await Channel.setOwnerCategory(dx,{expectedRevision:3,channelId:'ch5000',categoryKey:'news',now:T}),{ok:false,reason:'conflict'});
 assert.deepEqual(await Channel.setOwnerCategory(dx,{expectedRevision:7,channelId:'tvg_1',categoryKey:'news',now:T}),{ok:false,reason:'invalid'});
 // the plan digest covers the XMLTV registration: the same M3U with one more XMLTV-only channel is not a no-op
 const {db:dd}=fresh();await Channel.commitImport(dd,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});
 assert.deepEqual(await Channel.commitImport(dd,{expectedRevision:1,sourceSha256:SHA('a'),plan:Channel.planImport({groups:GROUPS,entries:ENTRIES,xmltvChannels:[{channelId:'ch5000'}]}),now:T}),{ok:true,revision:2});
 // lost reply: another writer assigned the same category with a different note
 const dual=fresh();await Channel.commitImport(dual.db,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});
 const racer={prepare:sql=>dual.db.prepare(sql),batch:async()=>{await Channel.setOwnerCategory(dual.db,{expectedRevision:1,channelId:'ch001',categoryKey:'news',note:'theirs',now:T});throw new Error('reply lost');}};
 assert.deepEqual(await Channel.setOwnerCategory(racer,{expectedRevision:1,channelId:'ch001',categoryKey:'news',note:'mine',now:T}),{ok:false,reason:'conflict'},'same category, different note: not acknowledged');
 // constraints of the new columns
 const badx=sql=>{const copy=path.join(root,'badx-'+(badCopies++)+'.sqlite');fs.copyFileSync(base,copy);assert.notEqual(run(copy,sql).status,0,sql);};
 badx("INSERT INTO epg_channel (channel_id,source_id,origin,revision,last_seen_revision) VALUES ('ch001',NULL,'m3u',1,1)");
 badx("INSERT INTO epg_channel (channel_id,source_id,origin,revision,last_seen_revision) VALUES ('ch001',NULL,'other',1,1)");
 badx("INSERT INTO epg_channel_category VALUES ('a','A','discover',0,1);INSERT INTO epg_channel (channel_id,origin,revision,last_seen_revision,owner_category_key) VALUES ('ch001','xmltv',1,1,'a')");
 badx("INSERT INTO epg_channel (channel_id,origin,revision,last_seen_revision,owner_category_key,owner_category_at) VALUES ('ch001','xmltv',1,1,'missing','t')");
 const okx=path.join(root,'okx.sqlite');fs.copyFileSync(base,okx);
 assert.equal(run(okx,"INSERT INTO epg_channel (channel_id,origin,revision,last_seen_revision) VALUES ('ch001','xmltv',1,1),('ch002','xmltv',1,1)").status,0,'several channels without a provider id coexist (NULL source_id is not unique-constrained)');
}

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
 ['rows with revision 0 marker','UPDATE epg_channel_revision SET revision=0, import_revision=0;'],
 ['a channel naming a missing category','PRAGMA foreign_keys=OFF;UPDATE epg_channel SET category_key=\'ghost\' WHERE channel_id=\'ch001\';'],
 ['a channel last seen in a future import','UPDATE epg_channel SET last_seen_revision=99 WHERE channel_id=\'ch001\';'],
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
// the competitor wrote the SAME policy for the SAME channel with another note: that is not our request, so no success is claimed
{
 const twin=fresh();await Channel.commitImport(twin.db,{expectedRevision:0,sourceSha256:SHA('a'),plan,now:T});
 const racer={prepare:sql=>twin.db.prepare(sql),batch:async()=>{await Channel.setOverride(twin.db,{expectedRevision:1,channelId:'ch001',policy:'deny_all',note:'someone else',now:T});throw new Error('reply lost');}};
 assert.deepEqual(await Channel.setOverride(racer,{expectedRevision:1,channelId:'ch001',policy:'deny_all',note:'mine',now:T}),{ok:false,reason:'conflict'},'same policy, different note: not acknowledged');
 assert.equal(rows(twin.file,"SELECT override_note FROM epg_channel WHERE channel_id='ch001'")[0].override_note,'someone else');
 const racerAt={prepare:sql=>twin.db.prepare(sql),batch:async()=>{await Channel.setOverride(twin.db,{expectedRevision:2,channelId:'ch001',policy:'deny_all',note:'mine',now:'2026-11-21T09:00:00.000Z'});throw new Error('reply lost');}};
 assert.equal((await Channel.setOverride(racerAt,{expectedRevision:2,channelId:'ch001',policy:'deny_all',note:'mine',now:T})).ok,false,'same policy and note, different time: not acknowledged');
}

console.log('EPG Channel authority: guarded inert migration v32, show keys untouched, provider id normalization, XMLTV-only channels, owner policy override > owner category > provider category > known_only, one bounded snapshot and no per-channel reads, revision CAS, fail-safe known_only states, lost-reply classification, nothing in src reaches the tables.');
