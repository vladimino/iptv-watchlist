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
const scan=async(programmes,watchlist,policies,degraded=false)=>{
 const xml='<tv>'+channels.map(([id,name])=>`<channel id="${id}"><display-name>${name}</display-name></channel>`).join('')+programmes.join('')+'</tv>';
 context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;context.watchlist=watchlist;context.options={policies,degraded};
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
assert.deepEqual(plain(policy.channels),{total:5,discover:1,denyAll:1,knownOnly:3,new:1,unclassified:2,undeclared:0});
assert.deepEqual(plain(result.newChannels),[{channelId:'ch004',name:'Новый'}],'a channel absent from the snapshot is reported by id, never matched by name');

// ADR 0142 decision 1 on known_only: a skipped competing record still invalidates the slot, in both orders; an identical replay is still one owner
const slotKeys=r=>ids(r).films.filter(entry=>entry.endsWith('@ch003'));
const known=programme('Alpha Film 2001',9,'ch003'),unknown=programme('Unknown Zed 2012',9,'ch003');
for(const [label,order] of [['known first',[known,unknown]],['unknown first',[unknown,known]]]){
 const r=await scan(order,watchlist,policies);
 assert.equal(r.stats.duplicate_slot,1,label+': the two owners conflict');
 assert.deepEqual(slotKeys(r),[],label+': the known Film is discarded with the unknown record');
 assert.equal(ids(r).discovery.filter(entry=>entry.startsWith('unknown zed')).length,0,label+': the skipped record is never a candidate');
}
const replay=await scan([known,known,programme('Unknown Zed 2012',12,'ch003'),programme('Unknown Zed 2012',12,'ch003')],watchlist,policies);
assert.equal(replay.stats.duplicate_slot,0,'identical replays stay one owner');
assert.deepEqual(slotKeys(replay),['a@ch003']);
const unfiltered=await scan([known,unknown],watchlist,new Map([['ch003',{policy:'discover',basis:'override'}]]));
assert.equal(unfiltered.stats.duplicate_slot,1,'the same conflict as the discover path');

// declared channels are tracked apart from programme coverage
{const xml='<tv><channel id="ch001"><display-name>Кино</display-name></channel><channel id="ch007"><display-name>Без программы</display-name></channel><channel id="ch008"><display-name>DE: Feed</display-name></channel>'+programme('Alpha Film 2001',3,'ch001')+programme('Alpha Film 2001',3,'ch099')+'</tv>';
 context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;context.watchlist=watchlist;context.options={policies};
 const r=await vm.runInContext('scanEPG(stream,watchlist,now,options)',context);
 assert.deepEqual(plain(r.newChannels),[{channelId:'ch007',name:'Без программы'}],'a declared channel with no programme is reported; a country-prefixed label and an undeclared programme id are not');
 assert.equal(r.stats.policy.channels.undeclared,1,'the undeclared programme channel is counted, classified known_only and never registered');
 assert.equal(r.stats.policy.channels.total,3);}

// ===== 3. one Map lookup per programme, no per-programme database access =====
class CountingMap extends Map{get(key){CountingMap.reads++;return super.get(key);}}
CountingMap.reads=0;
const counted=new CountingMap(policies);
await scan(programmes,[...watchlist,...catalog],counted);
assert.equal(CountingMap.reads,programmes.length+channels.length,'one in-memory lookup per in-window programme, plus one per channel for the final counters');
assert.ok(!/epg_channel|EpgChannel|\.prepare\(/.test(fs.readFileSync('src/sources.js','utf8').slice(fs.readFileSync('src/sources.js','utf8').indexOf('async function scanEPG'),fs.readFileSync('src/sources.js','utf8').indexOf('async function loadPeopleNameIndex'))),'scanEPG reaches no database');

// ===== 3b. degraded: every channel known_only, no silent discover, no applied revision =====
{const r=await scan(programmes,[...watchlist,...catalog],new Map(),true);
 const out=ids(r);
 assert.equal(r.stats.policyMode,'degraded');assert.equal(r.stats.policy.mode,'degraded');
 assert.deepEqual(out.films,['a@ch001','a@ch002','a@ch003'],'known Films are admitted even from a channel the owner denied (accepted trade-off of graceful degradation)');
 assert.equal(out.discovery.filter(entry=>entry.startsWith('unknown')).length,0,'no unknown candidate is created');
 assert.ok(out.discovery.some(entry=>entry.startsWith('catalog film')),'a confirmed catalog Film still reaches Discovery');
 assert.equal(r.stats.policy.filteredDenyAll,0,'nothing is claimed as denied');
 assert.equal(r.stats.policy.discoveryEligible,0);
 assert.deepEqual(plain(r.stats.policy.channels),{total:5,discover:0,denyAll:0,knownOnly:5,new:0,unclassified:0,undeclared:0},'degraded claims no classification');
 assert.deepEqual(plain(r.newChannels),[],'degraded guesses no missing channel ids');
 assert.equal(r.stats.policy.revision,undefined);assert.equal(r.stats.policy.digest,undefined);
 const legacy=await scan(programmes,[...watchlist,...catalog]);assert.equal(legacy.stats.policyMode,'legacy');
 const filtered=await scan(programmes,[...watchlist,...catalog],policies);assert.equal(filtered.stats.policyMode,'filtered');}

// ===== 3c. the declaration boundary of the single pass: one best-effort batch before the first programme =====
{const boundary=async(xml,{policies:map=policies,degraded=false,chunk=0,onDeclarations}={})=>{
  const bytes=Buffer.from(xml),parts=chunk?Array.from({length:Math.ceil(bytes.length/chunk)},(_,i)=>bytes.subarray(i*chunk,(i+1)*chunk)):[bytes];
  const calls=[];let programmesSeen=null;
  context.stream=Readable.toWeb(Readable.from(parts));context.now=now;context.watchlist=watchlist;
  context.options={policies:map,degraded,onDeclarations:async payload=>{calls.push(plain(payload));if(onDeclarations)await onDeclarations(payload);}};
  let result,error=null;try{result=await vm.runInContext('scanEPG(stream,watchlist,now,options)',context);}catch(caught){error=caught;}
  return {calls,result,error};};
 const decl=(id,name)=>`<channel id="${id}"><display-name>${name}</display-name></channel>`;
 const body=decl('ch001','Кино')+decl('ch007','Без программы')+decl('ch008','DE: Feed')+decl('bad','Мусор')+programme('Alpha Film 2001',3,'ch001')+programme('Alpha Film 2001',3,'ch099');
 for(const chunk of [0,7,1]){
  const run=await boundary('<tv>'+body+'</tv>',{chunk});
  assert.equal(run.calls.length,1,'one batch, chunk size '+chunk);
  assert.deepEqual(run.calls[0].channels.map(c=>c.channelId).sort(),['bad','ch007'],'declared ids the snapshot lacks, including one with no programme; a country-prefixed label and an undeclared programme id are not offered (the writer rejects a malformed id)');
  assert.equal(run.result.stats.policy.channels.undeclared,1);
 }
 const late=await boundary('<tv>'+decl('ch001','Кино')+programme('Alpha Film 2001',3,'ch001')+decl('ch009','Поздний')+'</tv>');
 assert.deepEqual(late.calls[0].channels,[],'a declaration after the first programme is not in the batch');
 assert.equal(late.result.stats.policy.lateDeclared,1,'and is counted, not silently trusted');
 const throwing=await boundary('<tv>'+body+'</tv>',{onDeclarations:async()=>{throw new Error('d1 down');}});
 assert.equal(throwing.error,null,'a failing registration never fails the scan');assert.ok(throwing.result.films.length);
 const failedLater=await boundary('<tv>'+body);
 assert.equal(failedLater.calls.length,1,'registration ran at the boundary');assert.ok(failedLater.error,'and the scan then failed (no closing tag): the rows it wrote are not tied to publication');
 assert.equal((await boundary('<tv>'+body+'</tv>',{policies:new Map(),degraded:true})).calls.length,0,'degraded registers nothing: no reliable snapshot to compare against');
 context.stream=Readable.toWeb(Readable.from([Buffer.from('<tv>'+body+'</tv>')]));context.now=now;context.watchlist=watchlist;context.options={onDeclarations:async()=>{throw new Error('must not run');}};
 await vm.runInContext('scanEPG(stream,watchlist,now,options)',context);}

// ===== 4. continuity: same-mode comparison, no dynamic coefficient =====
const guard=(next,prev)=>vm.runInContext('assertEPGContinuity(next,prev,10,now)',Object.assign(context,{next,prev,now}));
const feed=(broadcasts,extra={})=>({stats:{scanned:20000,channels:200,broadcasts,epgEnd:now+48*H,retained:0,...extra},coverage:Array.from({length:200}),films:[{shows:Array.from({length:broadcasts})}]});
const prior=(mode,extra={})=>({watchlistCount:10,stats:{scanned:20000,channels:200,broadcasts:1000,epgEnd:now,...(mode?{policyMode:mode}:{}),...extra}});
const next=(mode,broadcasts,extra={})=>feed(broadcasts,{policyMode:mode,...extra});
for(const mode of ['legacy','filtered','degraded']){
 guard(next(mode,900),prior(mode));
 assert.throws(()=>guard(next(mode,300),prior(mode)),/too few matching broadcasts/,mode+' against '+mode+': the earlier floor holds');
}
assert.throws(()=>guard(feed(300),prior(null)),/too few matching broadcasts/,'a report without the field, and a result without it, are legacy against legacy');
assert.throws(()=>guard(next('legacy',300),prior(null)),/too few matching broadcasts/,'an old report is legacy');
for(const [from,to] of [['legacy','filtered'],['legacy','degraded'],['filtered','degraded'],['degraded','filtered'],['filtered','legacy']])guard(next(to,300),prior(from));
assert.throws(()=>guard(next('filtered',300),prior('filtered',{policy:{applied:true,revision:1}})),/too few matching broadcasts/,'a revision, category or override change inside one mode never exempts the check');
for(const [from,to] of [['legacy','filtered'],['filtered','degraded'],[null,'filtered']]){
 assert.throws(()=>guard(next(to,300,{scanned:9000}),prior(from)),/too few programmes/,'raw programme count still checked on a mode change');
 assert.throws(()=>guard({...next(to,300),coverage:Array.from({length:50})},prior(from)),/too few channels/,'channel coverage still checked on a mode change');
 assert.throws(()=>guard(next(to,300,{epgEnd:now}),prior(from)),/horizon is too short/,'horizon still checked on a mode change');
}
assert.ok(!/policyKeptShare|scale/.test(fs.readFileSync('src/sources.js','utf8').slice(fs.readFileSync('src/sources.js','utf8').indexOf('function assertEPGContinuity'))),'no dynamic coefficient');

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
// a lost reply on a batch of more than 50 ids: success only when EVERY id is stored; a missing later id is a conflict
{const many=Array.from({length:60},(_,i)=>({channelId:'ch'+String(300+i),name:'Bulk '+i}));
 const lost=async missing=>{const target=await imported();const real=target;
  const racer={prepare:sql=>real.prepare(sql),batch:async statements=>{await real.batch(statements);if(missing)await real.prepare("DELETE FROM epg_channel WHERE channel_id='ch359'").run();throw new Error('reply lost');}};
  return {target,outcome:await Channel.registerXmltvChannels(racer,{channels:many,now:T})};};
 const whole=await lost(false);
 assert.deepEqual(whole.outcome,{ok:true,registered:60,present:0,invalid:0,revision:2},'every id stored: the lost reply is ours');
 const partial=await lost(true);
 assert.deepEqual(partial.outcome,{ok:false,reason:'conflict'},'a missing id beyond the first 50 is not claimed');}
// an empty snapshot refuses registration and a failed batch claims nothing
assert.deepEqual(await Channel.registerXmltvChannels(fresh(),{channels:feedChannels,now:T}),{ok:false,reason:'empty'});
assert.equal((await Channel.registerXmltvChannels(db,{channels:'x',now:T})).ok,false);
// the owner override survives a registration revision and a fresh read sees both
assert.equal((await Channel.setOverride(db,{expectedRevision:2,channelId:'ch004',policy:'discover',note:'owner',now:T})).ok,true);
assert.equal((await Channel.materializePolicies(db)).map.get('ch004').policy,'discover');

// ===== 6. the Worker wiring and the activation flag =====
const worker=fs.readFileSync('src/worker.js','utf8');
const helpers=/async function loadEpgChannelPolicy\(env\)\{[\s\S]*?\n\}\n/.exec(worker)[0]+/function epgDeclarationRegistrar\(env,holder\)\{[\s\S]*?\n\}\n/.exec(worker)[0];
const load=(stub)=>vm.runInNewContext(helpers+';({loadEpgChannelPolicy,epgDeclarationRegistrar})',{EpgChannelD1:stub,Date,Error});
{const never={materializePolicies:async()=>{throw new Error('must not be read');}};
 // AIR-565: an absent, `off` or `on` binding changes nothing; the snapshot is always read and an unfiltered scan cannot be selected.
 for(const value of [undefined,'off','on','ON','true'])assert.notEqual((await load({materializePolicies:async()=>({ok:false,reason:'absent'})}).loadEpgChannelPolicy(value===undefined?{}:{EPG_CHANNEL_POLICY:value})).mode,'legacy','binding '+JSON.stringify(value)+' never yields legacy');
 for(const env of [undefined,null,{}])assert.equal((await load({materializePolicies:async()=>({ok:false,reason:'absent'})}).loadEpgChannelPolicy(env)).mode,'degraded','no env degrades, never legacy');
 const ok=await load({materializePolicies:async()=>({ok:true,revision:4,digest:'d'.repeat(64),map:new Map([['ch001',{policy:'discover',basis:'category'}]])})}).loadEpgChannelPolicy({});
 assert.equal(ok.mode,'filtered');assert.equal(ok.revision,4);assert.equal(ok.map.size,1);
 for(const reason of ['empty','absent','incomplete','unavailable'])assert.deepEqual(plain(await load({materializePolicies:async()=>({ok:false,reason})}).loadEpgChannelPolicy({})),{mode:'degraded',reason},reason+' degrades instead of refusing');
 assert.deepEqual(plain(await load({materializePolicies:async()=>{throw new Error('boom');}}).loadEpgChannelPolicy({})),{mode:'degraded',reason:'unavailable'},'a throwing reader degrades');
 // the registrar records detected vs registered, never throws
 const holder={value:null};
 await load({registerXmltvChannels:async(env,{channels})=>({ok:true,registered:channels.length-1,invalid:1})}).epgDeclarationRegistrar({},holder)({channels:[{channelId:'ch1'},{channelId:'ch2'}]});
 assert.deepEqual(plain(holder.value),{ok:true,detected:2,registered:1,invalid:1});
 await load({registerXmltvChannels:async()=>({ok:false,reason:'conflict'})}).epgDeclarationRegistrar({},holder)({channels:[{channelId:'ch1'}]});
 assert.deepEqual(plain(holder.value),{ok:false,detected:1,registered:0,reason:'conflict'});
 await load({registerXmltvChannels:async()=>{throw new Error('x');}}).epgDeclarationRegistrar({},holder)({channels:[{channelId:'ch1'}]});
 assert.deepEqual(plain(holder.value),{ok:false,detected:1,registered:0,reason:'unavailable'},'a throwing writer is a recorded failure');
 await load(never).epgDeclarationRegistrar({},holder)({channels:[]});
 assert.deepEqual(plain(holder.value),{ok:true,detected:0,registered:0},'nothing to register writes nothing');}
assert.ok(!/publication refused/.test(worker),'a Channel snapshot failure never refuses publication');
assert.ok(worker.indexOf('loadEpgChannelPolicy(env)')<worker.indexOf("tracedPhase(run.runId,'epg_input_scan'"),'the snapshot is read once, before the scan');
assert.ok(/onDeclarations:epgDeclarationRegistrar\(env,registration\)/.test(worker)&&!/registerEpgChannels/.test(worker),'registration is the declaration-boundary callback of the single scan pass, not a publish step');
const registry=fs.readFileSync('src/feature-flags.js','utf8');
assert.ok(/name:'EPG_CHANNEL_POLICY',modes:\[\],default:null,tokens:\['off','on'\],retired:true,effective:\(\)=>null/.test(registry),'AIR-565: the flag is registered as retired and inert');

// ===== 7. the event carries mode, counters and warnings; old events render unchanged =====
const policyEvent=/function epgPolicyEventFields\(report\)\{[\s\S]*?\n\}/.exec(worker)[0];
const eventFields=vm.runInNewContext(policyEvent+';epgPolicyEventFields');
const counts={total:5,discover:1,denyAll:1,knownOnly:3,new:1,unclassified:2};
const filteredReport={stats:{scanned:123,policy:{applied:true,mode:'filtered',filteredDenyAll:2,skippedKnownOnly:3,discoveryEligible:3,unclassified:3,channels:counts,revision:7,digest:'d'.repeat(64),registration:{ok:true,detected:1,registered:1}}}};
assert.deepEqual(plain(eventFields(filteredReport)),{channels:{...counts,registered:1},programmes:{unclassified:3,filteredDenyAll:2,skippedKnownOnly:3,discoveryEligible:3,raw:123},policy:{mode:'filtered',revision:7,digest:'d'.repeat(64),href:'/admin/channels'}});
const failedRegistration=plain(eventFields({stats:{scanned:1,policy:{...filteredReport.stats.policy,registration:{ok:false,detected:2,registered:0,reason:'conflict'}}}}));
assert.deepEqual(failedRegistration.warning,{code:'channel_registration_failed',reason:'conflict'});assert.equal(failedRegistration.channels.registered,0,'detected and registered are told apart');
const degradedEvent=plain(eventFields({stats:{scanned:9,policy:{applied:true,mode:'degraded',reason:'empty',filteredDenyAll:0,skippedKnownOnly:4,discoveryEligible:0,unclassified:0,channels:{total:5,discover:0,denyAll:0,knownOnly:5,new:0,unclassified:0,undeclared:0}}}}));
assert.deepEqual(degradedEvent.policy,{mode:'degraded',reason:'empty',href:'/admin/channels'},'a degraded event invents no revision or digest');
assert.deepEqual(degradedEvent.warning,{code:'channel_policy_degraded',reason:'empty'});assert.ok(!('registered' in degradedEvent.channels));
assert.deepEqual(plain(eventFields({stats:{scanned:1}})),{},'a legacy scan adds no field to the event');

// the events screen: an older event renders no block, a filtered one the counters, a degraded one a plain warning
{const app=fs.readFileSync('public/app.js','utf8'),source=/function epgPolicyDetails\(event\)\{[\s\S]*?\n\}\n/.exec(app)[0];
 const render=vm.runInNewContext('const escapeHTML=v=>String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");'+source+';epgPolicyDetails');
 assert.equal(render({type:'epg',films:1,archive:0,future:0,broadcasts:1}),'','an event written before the policy renders unchanged');
 const html=render({...plain(eventFields(filteredReport)),type:'epg'});
 assert.ok(html.includes('<a href="/admin/channels">Admin Channels</a>')&&html.includes('(ревизия 7)')&&html.includes('<dd>5</dd>')&&html.includes('зарегистрировано'));
 const warned=render({...degradedEvent,type:'epg'});
 assert.ok(/не применена/.test(warned)&&/degraded/.test(warned)&&/empty/.test(warned)&&!/ревизия/.test(warned)&&!/deny_all/.test(warned),'a degraded event says in words that the blacklist was not applied and shows no revision or deny counters');
 assert.ok(/регистрация новых каналов не удалась/.test(render({...failedRegistration,type:'epg'})));
 for(const href of ['https://evil.example/x','//evil.example','javascript:alert(1)','/a"b'])assert.ok(!render({channels:{total:1},policy:{href}}).includes('<a '),'only a same-origin path becomes a link: '+href);
 assert.ok(!/<script|onerror/i.test(render({channels:{total:1},warning:{code:'channel_policy_degraded',reason:'<script>x</script>'},policy:{mode:'degraded'}})),'the reason is escaped');
 assert.ok(!/\/admin/.test(app),'the public bundle names no admin path');}
console.log('EPG channel policy: legacy/filtered/degraded modes, deny_all/known_only/discover per slot, declaration-boundary registration in one pass, mode-based continuity without a coefficient, immutable event with warnings, flag-gated.');
