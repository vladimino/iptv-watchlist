import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {candidateShowIdentity,createEpgRepository,distinctCandidateShows} from '../src/epg-repository.js';
import {publishStaged} from '../src/generation-stage.js';
import {D1Error} from '../scripts/d1-backfill.mjs';
import {openSqlite} from '../scripts/offline-import.mjs';
import {verifyParity} from '../src/offline-importer.js';

// ADR-0025: a candidate show is the whole EPG entry (channel, start, end, title). Two entries for one slot with different titles
// are both stored; an exact repeat is stored once; the legacy and the staged path write the same rows.
const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
const files=name=>fs.readFileSync('migrations/'+name,'utf8');
const V2=files('0001_schema_v1.sql')+'\n'+files('0002_generation_stage.sql'),V3=V2+'\n'+files('0003_candidate_show_identity.sql');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-candidate-show-'));
const sqlite=(file,input,{json=false}={})=>spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input,encoding:'utf8'});
const ok=(file,input)=>{const result=sqlite(file,input);assert.equal(result.status,0,result.stderr);};
const fails=(file,input,pattern)=>{const result=sqlite(file,input);assert.notEqual(result.status,0);assert.match(result.stderr,pattern);};
const rows=(file,sql)=>{const result=sqlite(file,sql,{json:true});assert.equal(result.status,0,result.stderr);return result.stdout.trim()?JSON.parse(result.stdout):[];};
const database=(name,schema=V3)=>{const file=path.join(root,name+'.sqlite');ok(file,schema);return file;};
const FINAL=['programme_generation','published_generation','candidate','candidate_generation','candidate_show'];
const dump=file=>Object.fromEntries(FINAL.map(table=>[table,rows(file,'SELECT * FROM '+table+';').map(row=>JSON.stringify(row)).sort()]));

// The four production shapes (same channel, start and end, a different EPG title), an entry that differs only in its end, an
// exact repeat that differs only in the channel display name, and entries without an end or a title.
const S=1793000000000,H=3600000;
const shows=[
 {channelId:'ch1',channel:'One',startMs:S,endMs:S+H,epgTitle:'Invented Film'},
 {channelId:'ch1',channel:'One',startMs:S,endMs:S+H,epgTitle:'Invented Film (version 2)'},
 {channelId:'ch1',channel:'One',startMs:S,endMs:S+2*H,epgTitle:'Invented Film'},
 {channelId:'ch1',channel:'One HD',startMs:S,endMs:S+H,epgTitle:'Invented Film'},
 {channelId:'ch2',channel:'Two',startMs:S,endMs:null,epgTitle:null},
 {channelId:'ch2',channel:'Two',startMs:S,endMs:null,epgTitle:null},
 {channelId:'ch2',channel:'Two',startMs:S,endMs:null,epgTitle:'Invented Film'},
];
const candidate=(key,list)=>({observationKey:key,title:'Invented Film',normalizedTitle:'invented film',year:1999,rawTitles:['Invented Film'],durations:[60],evidenceKey:'evidence-'+key,activity:'current',seenInLatest:true,shows:list});
const generation=(run,list,expected=null)=>({programmeRunId:run,phase:'published',expectedProgrammeRunId:expected,publishedAt:'2026-10-27T00:00:00.000Z',films:[],candidates:[candidate('invented film|1999',list),candidate('other film|2001',shows.slice(0,2))]});

// 1. The helper: an exact repeat is kept once (its first by channel display name), every other entry stays, in any input order.
{
 const kept=distinctCandidateShows(shows);
 assert.equal(kept.length,5);
 assert.equal(kept.filter(show=>show.channelId==='ch1'&&show.endMs===S+H&&show.epgTitle==='Invented Film').length,1);
 assert.equal(kept.find(show=>show.channelId==='ch1'&&show.endMs===S+H&&show.epgTitle==='Invented Film').channel,'One','the lowest display name wins');
 assert.deepEqual(distinctCandidateShows([...shows].reverse()),kept,'deterministic in any input order');
 assert.notEqual(candidateShowIdentity({channelId:'c',startMs:1,endMs:null,epgTitle:null}),candidateShowIdentity({channelId:'c',startMs:1,endMs:null,epgTitle:'null'}));
}

// 2. Migration 0003 on a schema v2 database keeps every row and widens the identity; an exact repeat is still refused.
{
 const file=database('migrate',V2);
 ok(file,"INSERT INTO programme_generation (programme_run_id,phase,published_at) VALUES ('run-0','published','2026-10-27T00:00:00.000Z');INSERT INTO candidate (observation_key,title,normalized_title,raw_titles_json,durations_json,observation_schema_version,observation_json,seen_in_latest,attempts,evidence_key) VALUES ('k','T','t','[]','[]',1,'{}',1,0,'e');INSERT INTO candidate_generation (programme_run_id,observation_key,observation_schema_version,observation_json,evidence_key) VALUES ('run-0','k',1,'{}','e');INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,start_ms,end_ms,epg_title) VALUES ('run-0','k','c',1,2,'A');");
 fails(file,"INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,start_ms,end_ms,epg_title) VALUES ('run-0','k','c',1,2,'B');",/UNIQUE constraint failed/);
 ok(file,files('0003_candidate_show_identity.sql'));
 assert.equal(rows(file,'SELECT version FROM schema_contract')[0].version,3);
 assert.deepEqual(rows(file,'SELECT channel_id,start_ms,end_ms,epg_title FROM candidate_show'),[{channel_id:'c',start_ms:1,end_ms:2,epg_title:'A'}]);
 ok(file,"INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,start_ms,end_ms,epg_title) VALUES ('run-0','k','c',1,2,'B'),('run-0','k','c',1,3,'A'),('run-0','k','c',1,NULL,NULL),('run-0','k','c',1,NULL,'A');");
 fails(file,"INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,start_ms,end_ms,epg_title) VALUES ('run-0','k','c',1,2,'B');",/UNIQUE constraint failed/);
 fails(file,"INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,start_ms,end_ms,epg_title) VALUES ('run-0','k','c',1,NULL,NULL);",/UNIQUE constraint failed/);
 fails(file,"INSERT INTO candidate_show (programme_run_id,observation_key,channel_id,start_ms,end_ms,epg_title) VALUES ('run-0','missing','c',1,2,'A');",/FOREIGN KEY constraint failed/);
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('candidate_show_v3','stage_candidate_show_v3')")[0].n,0);
}

// 3. The legacy path stores every distinct entry once and reads them back in a stable order; a replay in another order is a replay.
const legacy=database('legacy'),legacyRepo=createEpgRepository(openSqlite(legacy));
await legacyRepo.publishGeneration(generation('run-1',shows));
assert.equal(rows(legacy,"SELECT COUNT(*) AS n FROM candidate_show WHERE observation_key='invented film|1999'")[0].n,5);
assert.equal(rows(legacy,"SELECT COUNT(*) AS n FROM candidate_show WHERE observation_key='invented film|1999' AND channel_id='ch1' AND start_ms="+S+" AND end_ms="+(S+H))[0].n,2,'both titles of one slot are kept');
const read=await legacyRepo.readGeneration('run-1');
assert.equal(read.candidates.find(item=>item.observationKey==='invented film|1999').shows.length,5);
assert.equal((await legacyRepo.publishGeneration(generation('run-1',[...shows].reverse()))).replay,true);

// 4. The staged path writes the same final rows, also after a lost response in the middle and a resumed run.
function adapter(file,lostAt=null){
 const base=openSqlite(file);let buffer=null,writes=0;
 return {
  run(sql,params=[]){if(buffer){buffer.push([sql,params]);return Promise.resolve();}return base.run(sql,params);},
  get:(sql,params)=>base.get(sql,params),all:(sql,params)=>base.all(sql,params),
  async transaction(fn){
   if(buffer)return fn();
   buffer=[];let statements;try{await fn();statements=buffer;}finally{buffer=null;}
   const index=writes++;
   if(index===lostAt)throw new D1Error('write_uncertain','injected lost response');
   await base.transaction(async()=>{for(const [sql,params] of statements)await base.run(sql,params);});
  },
 };
}
const context={owner:'owner-a',baseline:'baseline-a',sha256,nonce:'nonce-1',now:()=>'2026-10-27T01:00:00.000Z',maxStatements:4,maxBytes:100000};
const staged=database('staged');
await publishStaged(adapter(staged),generation('run-1',shows),context);
assert.deepEqual(dump(staged),dump(legacy),'staged and legacy write the same final rows');
const resumed=database('resumed');
await assert.rejects(publishStaged(adapter(resumed,3),generation('run-1',shows),context),error=>error instanceof D1Error);
await publishStaged(adapter(resumed),generation('run-1',shows),{...context,nonce:'nonce-2',now:()=>'2026-10-27T03:00:00.000Z'});
assert.deepEqual(dump(resumed),dump(legacy),'a resumed staged import writes the same final rows');

// 5. Parity reads candidate shows independently: every distinct source entry must be stored once.
const identities=list=>[...new Set(list.map(show=>JSON.stringify([show.channelId,show.startMs,show.endMs??null,show.epgTitle??null])))].sort();
const spec={candidates:[{id:'invented film|1999',programmeRunId:'run-1',evidenceKey:'evidence-invented film|1999',title:'Invented Film',normalizedTitle:'invented film',shows:identities(shows)}]};
assert.equal((await verifyParity(openSqlite(legacy),spec)).mismatched.length,0);
ok(legacy,"DELETE FROM candidate_show WHERE observation_key='invented film|1999' AND epg_title='Invented Film (version 2)';");
assert.deepEqual((await verifyParity(openSqlite(legacy),spec)).mismatched.map(item=>[item.table,item.field]),[['candidate_show','shows']]);

fs.rmSync(root,{recursive:true,force:true});
console.log('Candidate show identity: helper keeps every distinct entry and one of each exact repeat, migration 0003 keeps rows and widens the unique identity, legacy and staged paths (incl. resume) write the same rows, replay in any order, independent show parity passed');
