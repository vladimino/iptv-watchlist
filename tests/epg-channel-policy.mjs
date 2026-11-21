// AIR-564 (ADR 0187 decision 5): the Channel policy in the EPG scan. Offline only: a fixture XMLTV feed through the real scanEPG, the real migration chain on a sqlite D1
// stand-in for the snapshot reader and the XMLTV registration writer, and the real continuity guard. No production database, bucket, Worker or network is opened.
// Proves: deny_all/known_only/discover semantics per (channel, start), unknown -> known_only, the same Film on another allowed channel, raw vs post-filter counters,
// one in-memory map with no per-programme lookup, fail-closed snapshot states, idempotent XMLTV registration that never touches policy, continuity adaptation,
// the activation flag, and the unchanged behaviour without a policy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {Readable} from 'node:stream';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Channel from '../src/epg-channel-d1.js';

const plain=value=>JSON.parse(JSON.stringify(value));
const H=3600000,now=Date.parse('2026-11-21T12:00:00Z');
const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,fetch,console});
vm.runInContext(fs.readFileSync('src/domain/scored-resolution.js','utf8')+'\nglobalThis.showMatchBasis=showMatchBasis;',context);
vm.runInContext(fs.readFileSync('src/sources.js','utf8')+';globalThis.scanEPG=scanEPG;globalThis.assertEPGContinuity=assertEPGContinuity;',context);

const stamp=ms=>new Date(ms).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const channels=[['ch001','Кино'],['ch002','Новости'],['ch003','Знакомый'],['ch004','Новый'],['ch005','Без категории']];
const programme=(title,offsetH,channel,minutes=110)=>`<programme channel="${channel}" start="${stamp(now+offsetH*H)}" stop="${stamp(now+offsetH*H+minutes*60000)}"><title>${title}</title></programme>`;
const scan=async(programmes,watchlist,policies)=>{
 const xml='<tv>'+channels.map(([id,name])=>`<channel id="${id}"><display-name>${name}</display-name></channel>`).join('')+programmes.join('')+'</tv>';
 context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;context.watchlist=watchlist;context.options={policies};
 return vm.runInContext('scanEPG(stream,watchlist,now,options)',context);
};
const film=(id,title,year,extra={})=>({id,title,original:title,year,runtime:110,tmdbId:id,aliases:[title],...extra});
const watchlist=[film('a','Alpha Film',2001)];
const catalog=[film('c','Catalog Film',1999,{catalogOnly:true,movieTitles:['Catalog Film']})];
const policies=new Map([
 ['ch001',{policy:'discover',basis:'category'}],
 ['ch002',{policy:'deny_all',basis:'category'}],
 ['ch003',{policy:'known_only',basis:'override'}],
 ['ch005',{policy:'known_only',basis:'unclassified'}],
]);
const programmes=[
 // the same known Film on a denied, a discover and a known_only channel
 programme('Alpha Film 2001',3,'ch002'),programme('Alpha Film 2001',4,'ch001'),programme('Alpha Film 2001',5,'ch003'),
 // an unknown title on each policy, and on a channel the map does not hold (ch004)
 programme('Unknown Gamma 2010',6,'ch001'),programme('Unknown Gamma 2010',6,'ch002'),programme('Unknown Gamma 2010',6,'ch003'),programme('Unknown Gamma 2010',6,'ch004'),programme('Unknown Gamma 2010',6,'ch005'),
 // a catalog Film the slot confirms by its movie title, on known_only
 programme('Catalog Film 1999',7,'ch003'),
];

// ===== 1. no policy: the earlier behaviour, no policy fields =====
const bare=await scan(programmes,[...watchlist,...catalog]);
assert.equal(bare.stats.policy,undefined);assert.deepEqual(plain(bare.newChannels),[]);
const ids=result=>({films:plain(result.films.flatMap(f=>f.shows.map(s=>f.id+'@'+s.channelId))).sort(),discovery:plain(result.discovery.flatMap(d=>d.shows.map(s=>d.normalizedTitle+'@'+s.channelId))).sort()});
const open=ids(bare);
assert.deepEqual(open.films,['a@ch001','a@ch002','a@ch003'],'without a policy every channel feeds the pipeline');
assert.ok(open.discovery.some(entry=>entry.endsWith('@ch002'))&&open.discovery.some(entry=>entry.endsWith('@ch004')),'without a policy unknown titles on every channel become candidates');
const explicitNull=await scan(programmes,[...watchlist,...catalog],null);
assert.deepEqual(plain(explicitNull.stats),plain(bare.stats),'a null policy equals an absent one');

// ===== 2. with a policy =====
const result=await scan(programmes,[...watchlist,...catalog],policies);
const kept=ids(result);
assert.deepEqual(kept.films,['a@ch001','a@ch003'],'deny_all drops even a known Film; the same Film stays on the allowed channels');
assert.ok(!kept.discovery.some(entry=>/@ch00[2345]$/.test(entry)&&entry.startsWith('unknown gamma')),'deny_all, known_only, unknown and unclassified channels create no unknown candidate');
assert.equal(kept.discovery.filter(entry=>entry.startsWith('unknown gamma')).length,1,'only the discover channel keeps the unknown title');
assert.ok(kept.discovery.some(entry=>entry.startsWith('catalog film')&&entry.endsWith('@ch003')),'known_only keeps a catalog Film the slot confirms');
assert.equal(result.discovery.find(item=>item.normalizedTitle.startsWith('catalog film')).confirmedTmdbId,'c','and the observation carries the confirmed identity');
assert.equal(result.uncertain.filter(item=>/Unknown Gamma/.test(item.title)).length,0,'known_only creates no uncertain entry for an unknown title');

// counters: raw input stays raw, the policy counters are post-filter
const raw=bare.stats.scanned;
assert.equal(result.stats.scanned,raw,'scanned is the raw input counter, unchanged by the policy');
const policy=result.stats.policy;
assert.equal(policy.applied,true);
assert.equal(policy.inWindow,programmes.length);
assert.equal(policy.filteredDenyAll,2,'two ch002 programmes in the window');
assert.equal(policy.skippedKnownOnly,3,'unknown Gamma on ch003, ch004 and ch005');
assert.equal(policy.discoveryEligible,2,'ch001 programmes: Alpha, Gamma');
assert.equal(policy.unclassified,2,'the ch004 (unknown) and ch005 (unclassified) programmes only');
assert.deepEqual(plain(policy.channels),{total:5,discover:1,denyAll:1,knownOnly:3,new:1,unclassified:2});
assert.deepEqual(plain(result.newChannels),[{channelId:'ch004',name:'Новый'}],'a channel absent from the snapshot is reported by id, never matched by name');

// ===== 3. one Map lookup per programme, no per-programme database access =====
class CountingMap extends Map{get(key){CountingMap.reads++;return super.get(key);}}
CountingMap.reads=0;
const counted=new CountingMap(policies);
await scan(programmes,[...watchlist,...catalog],counted);
assert.equal(CountingMap.reads,programmes.length+channels.length,'one in-memory lookup per in-window programme, plus one per channel for the final counters');
assert.ok(!/epg_channel|EpgChannel|\.prepare\(/.test(fs.readFileSync('src/sources.js','utf8').slice(fs.readFileSync('src/sources.js','utf8').indexOf('async function scanEPG'),fs.readFileSync('src/sources.js','utf8').indexOf('async function loadPeopleNameIndex'))),'scanEPG reaches no database');

// ===== 4. continuity: the expected shrinkage of a filtered first generation passes, a real collapse does not =====
const guard=(next,prev,wl=10)=>vm.runInContext('assertEPGContinuity(next,prev,10,now)',Object.assign(context,{next,prev,now}));
const feed=(broadcasts,extra={})=>({stats:{scanned:20000,channels:200,broadcasts,epgEnd:now+48*H,retained:0,...extra},coverage:Array.from({length:200}),films:[{shows:Array.from({length:broadcasts})}]});
const previous={watchlistCount:10,stats:{scanned:20000,channels:200,broadcasts:1000,epgEnd:now}};
guard(feed(900),previous);
assert.throws(()=>guard(feed(300),previous),/too few matching broadcasts/,'without a policy the floor is unchanged');
const filtered=broadcasts=>feed(broadcasts,{policy:{applied:true,inWindow:10000,filteredDenyAll:6300,discoveryEligible:1,skippedKnownOnly:0}});
guard(filtered(300),previous);
assert.throws(()=>guard(filtered(80),previous),/too few matching broadcasts/,'a further collapse of a filtered generation still fails');
const previousFiltered={watchlistCount:10,stats:{scanned:20000,channels:200,broadcasts:350,epgEnd:now,policy:{applied:true,inWindow:10000,filteredDenyAll:6300}}};
guard(filtered(300),previousFiltered);
assert.throws(()=>guard(filtered(100),previousFiltered),/too few matching broadcasts/,'filtered against filtered compares like with like');
assert.throws(()=>guard(feed(900,{scanned:9000}),previous),/too few programmes/,'raw counters are still compared raw to raw');

// ===== 5. the snapshot reader and the XMLTV registration writer on the real migration chain =====
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-epg-policy-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().filter(name=>Number(name.slice(0,4))<=32);
const base=path.join(root,'base.sqlite');
{const r=sqliteSync(['-bail',base],{input:'PRAGMA foreign_keys=ON;\n'+names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);}
let copies=0;
const fresh=()=>{const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(base,file);return d1Standin(file);};
const T='2026-11-21T09:00:00.000Z';
const imported=async()=>{
 const db=fresh();
 const planned=Channel.planImport({groups:[{name:'Movies',policy:'discover'},{name:'News',policy:'deny_all'}],entries:[{sourceId:'tvg_1',name:'Кино',group:'Movies'},{sourceId:'tvg_2',name:'Новости',group:'News'},{sourceId:'tvg_3',name:'Знакомый',group:''}]});
 assert.deepEqual(await Channel.commitImport(db,{expectedRevision:0,sourceSha256:'a'.repeat(64),plan:planned,now:T}),{ok:true,revision:1});
 return db;
};

// an empty or absent snapshot is refused, never silently discover
assert.deepEqual(await Channel.materializePolicies(fresh()),{ok:false,reason:'empty'});
assert.deepEqual(await Channel.materializePolicies(null),{ok:false,reason:'unavailable'});
{const missing=path.join(root,'none.sqlite');sqliteSync(['-bail',missing],{input:'CREATE TABLE x(a);',encoding:'utf8'});assert.deepEqual(await Channel.materializePolicies(d1Standin(missing)),{ok:false,reason:'absent'});}

const db=await imported();
const pinned=await Channel.materializePolicies(db);
assert.equal(pinned.ok,true);assert.equal(pinned.revision,1);assert.equal(pinned.size,3);assert.match(pinned.digest,/^[0-9a-f]{64}$/);
assert.deepEqual(plain([...pinned.map]),[['ch001',{policy:'discover',basis:'category'}],['ch002',{policy:'deny_all',basis:'category'}],['ch003',{policy:'known_only',basis:'unclassified'}]]);
assert.equal((await Channel.materializePolicies(db)).digest,pinned.digest,'the digest is reproducible for one revision');

// registration: XMLTV-only, idempotent, no duplicates, existing M3U channel never re-created, no policy touched
const feedChannels=[{channelId:'ch001',name:'Другое имя'},{channelId:'ch004',name:'Новый'},{channelId:'ch005',name:'Ещё'},{channelId:'ch004',name:'Дубль'},{channelId:'bad',name:'x'}];
const first=await Channel.registerXmltvChannels(db,{channels:feedChannels,now:T});
assert.deepEqual(first,{ok:true,registered:2,present:1,invalid:1,revision:2});
const after=await Channel.readSnapshot(db);
assert.equal(after.channels.size,5);
for(const id of ['ch004','ch005']){const row=after.channels.get(id);assert.equal(row.origin,'xmltv');assert.equal(row.sourceId,null);assert.equal(row.categoryKey,null);assert.equal(row.ownerCategoryKey,null);assert.equal(row.overridePolicy,null);assert.deepEqual(after.lookup.policyFor(id),{policy:'known_only',basis:'unclassified',degraded:false});}
assert.equal(after.channels.get('ch001').name,'Кино','an id already in the M3U snapshot is not re-created or renamed');
assert.equal(after.channels.get('ch001').origin,'m3u');
assert.deepEqual(plain([...after.channels.keys()]).sort(),['ch001','ch002','ch003','ch004','ch005'],'no duplicate ids');
assert.deepEqual(await Channel.registerXmltvChannels(db,{channels:feedChannels,now:T}),{ok:true,registered:0,present:3,invalid:1,revision:2},'a repeat registers nothing and adds no revision');
assert.equal((await Channel.readSnapshot(db)).revision,2);
assert.deepEqual(plain([...(await Channel.materializePolicies(db)).map].filter(([id])=>id<='ch003')),plain([...pinned.map]),'existing classification is preserved');
// an earlier pinned map is a value: registration cannot change what a running scan uses
assert.equal(pinned.map.has('ch004'),false);
// an empty snapshot refuses registration and a failed batch claims nothing
assert.deepEqual(await Channel.registerXmltvChannels(fresh(),{channels:feedChannels,now:T}),{ok:false,reason:'empty'});
assert.equal((await Channel.registerXmltvChannels(db,{channels:'x',now:T})).ok,false);
// the owner override survives a registration revision and a fresh read sees both
assert.equal((await Channel.setOverride(db,{expectedRevision:2,channelId:'ch004',policy:'discover',note:'owner',now:T})).ok,true);
assert.equal((await Channel.materializePolicies(db)).map.get('ch004').policy,'discover');

// ===== 6. the Worker wiring and the activation flag =====
const worker=fs.readFileSync('src/worker.js','utf8');
assert.ok(/if\(env\?\.EPG_CHANNEL_POLICY!=='on'\)return null;/.test(worker),'off (the default) loads no snapshot');
assert.ok(/policy snapshot unavailable \('\+policy\.reason\+'\): publication refused/.test(worker),'an unavailable snapshot refuses publication');
assert.ok(worker.indexOf('loadEpgChannelPolicy(env)')<worker.indexOf("tracedPhase(run.runId,'epg_input_scan'"),'the snapshot is read once, before the scan');
assert.ok(worker.indexOf('registerEpgChannels(env,run,channelPolicy,result.newChannels)')>worker.indexOf('assertEPGContinuity(result,previous'),'registration is a publish-phase step after the scan and the guards');
const flags=await import('../src/feature-flags.js').catch(()=>null);
const registry=fs.readFileSync('src/feature-flags.js','utf8');
assert.ok(/name:'EPG_CHANNEL_POLICY',modes:\['off','on'\],default:'off'/.test(registry),'the flag is registered, default off');
void flags;

// ===== 7. the event carries the counters; old events render unchanged =====
const policyEvent=/function epgPolicyEventFields\(report\)\{[\s\S]*?\n\}/.exec(worker)[0];
const eventFields=vm.runInNewContext(policyEvent+';epgPolicyEventFields');
const report={stats:{scanned:123,policy:{applied:true,filteredDenyAll:2,skippedKnownOnly:3,discoveryEligible:3,unclassified:3,channels:{total:5,discover:1,denyAll:1,knownOnly:3,new:1,unclassified:2},revision:7,digest:'d'.repeat(64)}}};
assert.deepEqual(plain(eventFields(report)),{channels:{total:5,discover:1,denyAll:1,knownOnly:3,new:1,unclassified:2},programmes:{unclassified:3,filteredDenyAll:2,skippedKnownOnly:3,discoveryEligible:3,raw:123},policy:{revision:7,digest:'d'.repeat(64),href:'/admin/channels'}});
assert.deepEqual(plain(eventFields({stats:{scanned:1}})),{},'a scan without a policy adds no field to the event');

// the events screen: an older event renders no block, a new one renders the counters and links only a same-origin path
{const app=fs.readFileSync('public/app.js','utf8'),source=/function epgPolicyDetails\(event\)\{[\s\S]*?\n\}\n/.exec(app)[0];
 const render=vm.runInNewContext('const escapeHTML=v=>String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");'+source+';epgPolicyDetails');
 assert.equal(render({type:'epg',films:1,archive:0,future:0,broadcasts:1}),'','an event written before the policy renders unchanged');
 const html=render({channels:{total:5,discover:1,denyAll:1,knownOnly:3,new:1,unclassified:2},programmes:{filteredDenyAll:2,skippedKnownOnly:3,discoveryEligible:2,unclassified:2},policy:{revision:7,href:'/admin/channels'}});
 assert.ok(html.includes('<a href="/admin/channels">Admin Channels</a>')&&html.includes('(ревизия 7)')&&html.includes('<dd>5</dd>'));
 for(const href of ['https://evil.example/x','//evil.example','javascript:alert(1)','/a"b'])assert.ok(!render({channels:{total:1},policy:{href}}).includes('<a '),'only a same-origin path becomes a link: '+href);
 assert.ok(!/\/admin/.test(app),'the public bundle names no admin path');}
console.log('EPG channel policy: deny_all/known_only/discover per slot, unknown -> known_only, raw vs filtered counters, one map and no per-programme lookup, idempotent XMLTV registration, continuity adaptation, flag-gated and fail-closed.');
