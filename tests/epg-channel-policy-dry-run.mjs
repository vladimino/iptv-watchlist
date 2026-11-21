// The offline dry-run harness of the EPG Channel policy (scripts/epg-channel-policy-dry-run.mjs). These tests prove the HARNESS on a small synthetic feed: its input contract, the three modes
// over one feed and one film input, the declaration boundary, the guard matrix with its controls, the verdict logic and that its output names no title, slot or channel. They are not
// evidence of a dry run on the real feed, which needs the real inputs the harness refuses to invent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {combinedFilms,dryRun,evaluate,guardMatrix,mapDigest,parsePolicies,policiesFromRows,runModes,Blocked} from '../scripts/epg-channel-policy-dry-run.mjs';

const root=path.resolve('.');
const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-dry-run-'));
process.on('exit',()=>{try{fs.rmSync(tmp,{recursive:true,force:true});}catch{/* best effort */}});
const H=3600000,now=Date.parse('2026-11-21T12:00:00Z'),fetchedAt=Date.parse('2026-11-21T11:55:00Z');
const stamp=ms=>new Date(ms).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const programme=(title,offsetH,channel,minutes=110)=>`<programme channel="${channel}" start="${stamp(now+offsetH*H)}" stop="${stamp(now+offsetH*H+minutes*60000)}"><title>${title}</title></programme>`;
const decl=(id,name)=>`<channel id="${id}"><display-name>${name}</display-name></channel>`;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

const declarations=decl('ch001','Alpha channel')+decl('ch002','Beta channel')+decl('ch003','Gamma channel')+decl('ch004','Delta channel')+decl('ch005','Epsilon without programmes');
const body=[
 programme('Alpha Film 2001',3,'ch001'),programme('Alpha Film 2001',3,'ch002'),programme('Alpha Film 2001',3,'ch003'),
 programme('Unknown Zed 2010',5,'ch001'),programme('Unknown Zed 2010',5,'ch002'),programme('Unknown Zed 2010',5,'ch003'),programme('Unknown Zed 2010',5,'ch004'),
 programme('Catalog Film 1999',7,'ch003'),programme('Alpha Film 2001',10,'ch001'),
].join('');
const feedPath=path.join(tmp,'feed.xml');
fs.writeFileSync(feedPath,'<tv>'+declarations+body+'</tv>');

const policyEntries=[['ch001',{policy:'discover',basis:'category'}],['ch002',{policy:'deny_all',basis:'category'}],['ch003',{policy:'known_only',basis:'override'}]];
const stated=mapDigest(4,new Map(policyEntries.map(([id,value])=>[id,value])));
const policies=parsePolicies({revision:4,digest:stated,entries:policyEntries});
const film=(id,title,year,extra={})=>({id,title,original:title,year,runtime:110,tmdbId:id,aliases:[title],...extra});
const watchlist=[film('a','Alpha Film',2001)];
const catalog={c:film('c','Catalog Film',1999,{movieTitles:['Catalog Film']}),a:film('a','Alpha Film Duplicate',2001)};
const input={root,xmltv:feedPath,policies,watchlist,catalog,now,feedFetchedAt:fetchedAt};

// ===== 1. input contract: nothing is invented =====
assert.deepEqual(combinedFilms(watchlist,catalog).map(f=>[f.id,!!f.catalogOnly]),[['a',false],['c',true]],'the combined input is the Worker one: catalogOnly, no tmdbId overlap');
assert.equal(parsePolicies([['ch001',{policy:'deny_all',basis:'category'}]]).revision,null,'a bare array has no revision');
assert.equal(parsePolicies({revision:4,digest:'0'.repeat(64),entries:policyEntries}).digestChecked,false,'a stated digest that does not match is reported');
assert.equal(policies.digestChecked,true);assert.equal(policies.digest,stated);
for(const bad of [[],{entries:[]},null,[['ch001',{policy:'allow',basis:'x'}]],[['ch001',{policy:'discover'}]],[['ch001',{policy:'discover',basis:'x'}],['ch001',{policy:'deny_all',basis:'x'}]]])assert.throws(()=>parsePolicies(bad),Blocked,'unusable policies are BLOCKED');
const blocked=async(overrides,pattern)=>assert.rejects(()=>dryRun({...input,...overrides}),error=>error instanceof Blocked&&pattern.test(error.message));
await blocked({xmltv:path.join(tmp,'missing.xml')},/real feed file is required/);
await blocked({xmltv:null},/real feed file is required/);
await blocked({now:NaN},/--now is required/);
await blocked({feedFetchedAt:NaN},/provenance/);
await blocked({watchlist:[]},/non-empty watchlist/);
await blocked({watchlist:null},/non-empty watchlist/);

// the snapshot rows go through the repository's own reader: owner override > owner category > provider category > known_only
{const category=(key,policy,position)=>({category_key:key,name:key,policy,position,revision:1});
 const channel=(id,extra={})=>({channel_id:id,source_id:null,origin:'m3u',name:id,category_key:null,override_policy:null,override_note:null,override_at:null,owner_category_key:null,owner_category_note:null,owner_category_at:null,revision:1,last_seen_revision:1,...extra});
 const rows={marker:{revision:1,source_sha256:null,plan_sha256:null,import_revision:1,category_count:2,channel_count:5},
  categories:[category('movies','discover',0),category('news','deny_all',1)],
  channels:[channel('ch001',{category_key:'movies'}),channel('ch002',{category_key:'news'}),channel('ch003',{category_key:'news',override_policy:'discover',override_at:'2026-11-21T00:00:00Z'}),channel('ch004'),channel('ch005',{category_key:'news',owner_category_key:'movies'})]};
 const derived=await policiesFromRows(rows);
 assert.deepEqual([...derived.map].map(([id,v])=>[id,v.policy,v.basis]),[['ch001','discover','category'],['ch002','deny_all','category'],['ch003','discover','override'],['ch004','known_only','unclassified'],['ch005','discover','owner_category']]);
 assert.equal(derived.revision,1);assert.equal(derived.digest,mapDigest(1,derived.map),'the digest is the one materializePolicies reports');
 await assert.rejects(()=>policiesFromRows({...rows,marker:{...rows.marker,revision:0,import_revision:0,category_count:0,channel_count:0},categories:[],channels:[]}),Blocked,'an empty snapshot is BLOCKED');
 await assert.rejects(()=>policiesFromRows({...rows,marker:{...rows.marker,channel_count:9}}),Blocked,'a torn snapshot is BLOCKED');
 await assert.rejects(()=>policiesFromRows({...rows,tables:['epg_channel']}),Blocked,'an incomplete schema is BLOCKED');
 await assert.rejects(()=>policiesFromRows(null),Blocked);}

// ===== 2. the three modes over one feed =====
const report=await dryRun(input);
assert.equal(report.verdict,'PASS',JSON.stringify(report.checks.filter(c=>!c.pass)));
assert.deepEqual(report.checks.map(check=>check.id),['legacy_unchanged','filtered_no_deny_all_shows','filtered_no_unknown_candidates_from_known_only','filtered_slot_differences_explained','declaration_boundary','degraded_all_known_only','raw_counters_equal_across_modes','continuity_guard']);
const check=id=>report.checks.find(item=>item.id===id);
assert.equal(check('declaration_boundary').declaredBeforeFirstProgrammeAbsentFromSnapshot,2,'ch004 and the programme-less ch005 are declared and absent from the snapshot');
assert.equal(check('declaration_boundary').lateDeclared,0);assert.equal(check('declaration_boundary').batches,1);assert.equal(check('declaration_boundary').pinnedMapUnchanged,true);
assert.deepEqual(check('filtered_slot_differences_explained').gained,0);assert.equal(check('filtered_slot_differences_explained').lost.unexplained,0);
assert.ok(check('filtered_slot_differences_explained').lost.denyAll>0&&check('filtered_slot_differences_explained').lost.knownOnlyCandidate>0,'the differences are explained by policy');
assert.equal(check('degraded_all_known_only').registrarCalls,0);assert.ok(check('degraded_all_known_only').knownFilmSlotsOnDenyAllChannels>0,'a known Film on a denied channel is allowed in degraded mode and counted');
assert.equal(report.inputs.xmltvSha256,sha(fs.readFileSync(feedPath)));assert.equal(report.inputs.xmltvBytes,fs.statSync(feedPath).size);
assert.deepEqual([report.inputs.watchlistFilms,report.inputs.catalogFilms,report.inputs.combinedFilms,report.inputs.catalogOnlyFilms],[1,2,2,1]);
assert.equal(report.inputs.policiesRevision,4);assert.equal(report.inputs.feedFetchedAt,'2026-11-21T11:55:00.000Z');
const text=JSON.stringify(report);
for(const secret of ['Alpha','Unknown Zed','Catalog Film','ch001','ch004','feed.xml',tmp])assert.ok(!text.includes(secret),'the output names no title, channel, slot or path: '+secret);

// gzip input is the same feed
const gzPath=path.join(tmp,'feed.xml.gz');fs.writeFileSync(gzPath,zlib.gzipSync(fs.readFileSync(feedPath)));
const gz=await dryRun({...input,xmltv:gzPath});
assert.equal(gz.verdict,'PASS');assert.equal(JSON.stringify(gz.modes),JSON.stringify(report.modes),'a gzip feed gives the same results');assert.equal(gz.inputs.xmltvSha256,sha(fs.readFileSync(gzPath)),'the hash is of the file given');

// ===== 3. a declaration after the first programme is a FAIL with the number, not a silent miss =====
const latePath=path.join(tmp,'late.xml');
const firstProgramme=programme('Alpha Film 2001',3,'ch001');
assert.ok(body.startsWith(firstProgramme));
fs.writeFileSync(latePath,'<tv>'+declarations+firstProgramme+decl('ch006','Late declared')+body.slice(firstProgramme.length)+'</tv>');
const late=await dryRun({...input,xmltv:latePath});
assert.equal(late.verdict,'FAIL');assert.equal(late.checks.find(c=>c.id==='declaration_boundary').lateDeclared,1);assert.equal(late.checks.find(c=>c.id==='declaration_boundary').pass,false);

// ===== 4. the verdict logic catches doctored results =====
const material=await runModes({root,xmltv:feedPath,policies,films:combinedFilms(watchlist,catalog),now});
const matrix=guardMatrix(material.context,material.runs,now,watchlist.length);
const judge=(mutate,matrixOverride)=>{
 const runs=Object.fromEntries(Object.entries(material.runs).map(([mode,run])=>[mode,{...run,slots:new Map(run.slots),batches:run.batches.map(b=>[...b])}]));
 mutate(runs);
 return evaluate({runs,policies,pinnedUnchanged:true,matrix:matrixOverride||matrix,now,watchlistCount:watchlist.length});
};
const failing=(result,id)=>result.checks.filter(c=>!c.pass).map(c=>c.id).includes(id);
assert.equal(judge(()=>{}).verdict,'PASS');
assert.ok(failing(judge(runs=>runs.filtered.slots.set('f|a|ch002|1',{channelId:'ch002',kind:'film'})),'filtered_no_deny_all_shows'),'a surviving deny_all slot fails');
assert.ok(failing(judge(runs=>runs.filtered.slots.set('c|k|ch003|1',{channelId:'ch003',kind:'candidate',confirmed:false})),'filtered_no_unknown_candidates_from_known_only'),'an unconfirmed candidate on a known_only channel fails');
assert.ok(failing(judge(runs=>runs.filtered.slots.set('c|k|ch001|9',{channelId:'ch001',kind:'candidate',confirmed:false})),'filtered_slot_differences_explained'),'a gained slot fails');
assert.ok(failing(judge(runs=>{const [key]=[...runs.filtered.slots.keys()].filter(k=>k.startsWith('f|')&&runs.filtered.slots.get(k).channelId==='ch001');runs.filtered.slots.delete(key);}),'filtered_slot_differences_explained'),'an unexplained lost slot fails');
assert.ok(failing(judge(runs=>runs.filtered.batches.push(['ch004'])),'declaration_boundary'),'a second registration batch fails');
assert.ok(failing(judge(runs=>runs.degraded.batches.push(['ch004'])),'degraded_all_known_only'),'a registration in degraded fails');
assert.ok(failing(judge(runs=>runs.degraded.slots.set('c|k|ch001|9',{channelId:'ch001',kind:'candidate',confirmed:false})),'degraded_all_known_only'),'an unknown candidate in degraded fails');
assert.ok(failing(judge(runs=>{runs.filtered.result={...runs.filtered.result,stats:{...runs.filtered.result.stats,scanned:1}};}),'raw_counters_equal_across_modes'),'raw counters must be equal across modes');
assert.ok(failing(evaluate({runs:material.runs,policies,pinnedUnchanged:false,matrix,now,watchlistCount:1}),'declaration_boundary'),'a changed pinned map fails');

// ===== 5. the guard matrix and its controls =====
assert.equal(matrix.rows.length,9);assert.ok(matrix.rows.every(row=>row.ok),'on this feed every pair passes');
assert.equal(matrix.controls.rawProgrammeCount.applicable,false,'the programme-count control is not applicable below 10 000 programmes');
assert.equal(matrix.controls.horizon.ok,false,'the horizon check still fires on a change of mode');
{const big=material;
 const runs=Object.fromEntries(Object.entries(big.runs).map(([mode,run])=>[mode,{...run,result:{...run.result,stats:{...run.result.stats,scanned:20000}}}]));
 const large=guardMatrix(big.context,runs,now,1);
 assert.equal(large.controls.rawProgrammeCount.ok,false,'with enough programmes the raw programme count still fires on a change of mode');
 assert.match(large.controls.rawProgrammeCount.message,/too few programmes/);}
const brokenControls={rows:matrix.rows,controls:{rawProgrammeCount:{ok:true},horizon:matrix.controls.horizon}};
assert.ok(failing(judge(()=>{},brokenControls),'continuity_guard'),'a control that does not fire fails the check');
const brokenRow={rows:matrix.rows.map((row,i)=>i===0?{...row,ok:false}:row),controls:matrix.controls};
assert.ok(failing(judge(()=>{},brokenRow),'continuity_guard'),'a failing pair fails the check');

// ===== 6. the command line: exit codes and JSON only =====
const write=(name,value)=>{const file=path.join(tmp,name);fs.writeFileSync(file,JSON.stringify(value));return file;};
const polFile=write('policies.json',{revision:4,digest:stated,entries:policyEntries}),watchFile=write('watchlist.json',watchlist),catFile=write('catalog.json',catalog);
const rowsFile=write('rows.json',{marker:{revision:4,source_sha256:null,plan_sha256:null,import_revision:4,category_count:2,channel_count:3},categories:[{category_key:'movies',name:'m',policy:'discover',position:0,revision:1},{category_key:'news',name:'n',policy:'deny_all',position:1,revision:1}],channels:[{channel_id:'ch001',source_id:null,origin:'m3u',name:'a',category_key:'movies',override_policy:null,override_note:null,override_at:null,owner_category_key:null,owner_category_note:null,owner_category_at:null,revision:1,last_seen_revision:1},{channel_id:'ch002',source_id:null,origin:'m3u',name:'b',category_key:'news',override_policy:null,override_note:null,override_at:null,owner_category_key:null,owner_category_note:null,owner_category_at:null,revision:1,last_seen_revision:1},{channel_id:'ch003',source_id:null,origin:'m3u',name:'c',category_key:null,override_policy:'known_only',override_note:'n',override_at:'2026-11-21T00:00:00Z',owner_category_key:null,owner_category_note:null,owner_category_at:null,revision:1,last_seen_revision:1}]});
const cli=args=>spawnSync(process.execPath,['scripts/epg-channel-policy-dry-run.mjs',...args],{encoding:'utf8'});
const full=['--xmltv',feedPath,'--policies',polFile,'--watchlist',watchFile,'--catalog',catFile,'--now','2026-11-21T12:00:00Z','--feed-fetched-at','2026-11-21T11:55:00Z'];
const ok=cli(full);assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).verdict,'PASS');
const viaRows=cli(full.map((v,i)=>v==='--policies'?'--snapshot-rows':full[i-1]==='--policies'?rowsFile:v));assert.equal(viaRows.status,0,viaRows.stderr);assert.equal(JSON.parse(viaRows.stdout).inputs.policiesRevision,4,'--snapshot-rows works from the SELECT rows');
const lateRun=cli(full.map(value=>value===feedPath?latePath:value));assert.equal(lateRun.status,1);assert.equal(JSON.parse(lateRun.stdout).verdict,'FAIL');
for(const [label,args] of [
 ['no feed',full.filter((v,i)=>!(v==='--xmltv'||full[i-1]==='--xmltv'))],
 ['no now',full.filter((v,i)=>!(v==='--now'||full[i-1]==='--now'))],
 ['no provenance',full.filter((v,i)=>!(v==='--feed-fetched-at'||full[i-1]==='--feed-fetched-at'))],
 ['no policies',full.filter((v,i)=>!(v==='--policies'||full[i-1]==='--policies'))],
 ['empty watchlist',full.map(v=>v===watchFile?write('empty.json',[]):v)],
]){const run=cli(args);assert.equal(run.status,2,label+': '+run.stderr);assert.equal(JSON.parse(run.stdout).verdict,'BLOCKED',label);}

console.log('EPG channel policy dry-run harness: BLOCKED on a missing input, three modes over one feed, declaration boundary, guard matrix with controls, explained slot differences, a verdict that fails on doctored results, numbers-only output.');
