import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createEpgRepository} from '../src/epg-repository.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-repo-'));
const database=path.join(root,'epg.sqlite');
const db=openSqlite(database);
exec(database, 'PRAGMA foreign_keys=ON;\n'+fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
await db.run("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:zz-film',1,'Original Title','2026-10-19T01:00:00.000Z')");
const repo=createEpgRepository(db);
const source=fs.readFileSync('src/epg-repository.js','utf8');
assert.doesNotMatch(source,/INSERT INTO film\s|INSERT INTO film_metadata|INSERT INTO person\s|INSERT INTO watchlist_film|d1_databases|\bBUCKET\b|\bfetch\b/);
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/epg-repository/);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/epg-repository/);

await assert.rejects(()=>repo.publishGeneration({programmeRunId:'run-bad',phase:'published',publishedAt:'2026-10-19T01:00:00.000Z',films:[{filmId:'film:missing',shows:[]}],candidates:[candidate({observationKey:'lost|1999',evidenceKey:'evidence-lost'})]}));
assert.equal(await repo.readPublished(),null);
assert.equal(await repo.readCandidate('lost|1999'),null);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM programme_generation WHERE programme_run_id='run-bad'"),0);

await repo.publishGeneration({programmeRunId:'run-a',phase:'published',publishedAt:'2026-10-19T01:00:00.000Z',films:[{filmId:'film:zz-film',shows:[show(1000,'title_duration','duration_conflict')]}],candidates:[candidate({observationKey:'heat|1995',evidenceKey:'evidence-a',durations:[170],confirmedTmdbId:'9001',lastSeenProgrammeRunId:'run-a'}),candidate({observationKey:'other|1990',title:'Other ZZ',normalizedTitle:'other',year:1990,rawTitles:['Other ZZ'],durations:[100],evidenceKey:'evidence-other',activity:'current',lastSeenProgrammeRunId:'run-a',shows:[show(1100,'title_year',null)]})]});
await repo.publishGeneration({programmeRunId:'run-a',phase:'published',publishedAt:'2026-10-19T01:00:00.000Z',films:[{filmId:'film:zz-film',shows:[show(1000,'title_duration','duration_conflict')]}],candidates:[candidate({observationKey:'heat|1995',evidenceKey:'evidence-a',durations:[170],confirmedTmdbId:'9001',lastSeenProgrammeRunId:'run-a'}),candidate({observationKey:'other|1990',title:'Other ZZ',normalizedTitle:'other',year:1990,rawTitles:['Other ZZ'],durations:[100],evidenceKey:'evidence-other',activity:'current',lastSeenProgrammeRunId:'run-a',shows:[show(1100,'title_year',null)]})]});
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film_show WHERE programme_run_id='run-a'"),1);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM candidate_generation WHERE programme_run_id='run-a'"),2);

await repo.publishGeneration({programmeRunId:'run-b',phase:'published',publishedAt:'2026-10-20T01:00:00.000Z',films:[{filmId:'film:zz-film',shows:[]}],candidates:[candidate({observationKey:'heat|1995',title:'Title ZZ Late',rawTitles:['Title ZZ','Title ZZ Late'],durations:[180],lastAiringMs:8000,airings:2,confirmedTmdbId:null,evidenceKey:'evidence-b',lastSeenProgrammeRunId:'run-b',shows:[show(8000,'title_unique',null)]}),candidate({observationKey:'other|1990',title:'Other ZZ',normalizedTitle:'other',year:1990,rawTitles:['Other ZZ'],durations:[100],evidenceKey:'evidence-other',activity:'historical',seenInLatest:false,lastSeenProgrammeRunId:'run-a',shows:[]})]});
const publishedB=await repo.readPublished();
assert.equal(publishedB.programmeRunId,'run-b');
const generationA=await repo.readGeneration('run-a');
const generationB=await repo.readGeneration('run-b');
assert.equal(generationA.candidates.find(item=>item.observationKey==='heat|1995').observation.durations[0],170);
assert.equal(generationA.candidates.find(item=>item.observationKey==='heat|1995').observation.confirmedTmdbId,'9001');
assert.equal(generationB.candidates.find(item=>item.observationKey==='heat|1995').observation.durations[0],180);
assert.equal(generationB.candidates.find(item=>item.observationKey==='heat|1995').observation.confirmedTmdbId,null);
assert.equal(generationB.films[0].shows.length,0);
assert.equal(generationA.films[0].shows.length,1);
assert.equal(generationA.candidates.find(item=>item.observationKey==='other|1990').shows.length,1);
assert.equal((await repo.readCandidate('other|1990')).activity,'historical');
assert.equal((await repo.readCandidate('other|1990')).seenInLatest,false);
assert.equal(await count(db,"SELECT airing_ms AS n FROM film_epg_last_airing WHERE film_id='film:zz-film'"),1000);

await repo.publishGeneration({programmeRunId:'run-a2',phase:'published',publishedAt:'2026-10-21T01:00:00.000Z',films:[{filmId:'film:zz-film',shows:[show(9000,'title_year',null)]}],candidates:[candidate({observationKey:'heat|1995',durations:[175],evidenceKey:'evidence-c',lastAiringMs:9000,lastSeenProgrammeRunId:'run-a2',shows:[show(9000,'title_year',null)]}),candidate({observationKey:'title-zz|1994',title:'Title ZZ',normalizedTitle:'title-zz',year:1994,rawTitles:['Title ZZ'],durations:[90],evidenceKey:'evidence-remake',activity:'current',lastSeenProgrammeRunId:'run-a2',shows:[show(9100,'title_duration','duration_conflict')]}),candidate({observationKey:'title-zz|1995',title:'Title ZZ',normalizedTitle:'title-zz',year:1995,rawTitles:['Title ZZ'],durations:[170],evidenceKey:'evidence-original',activity:'current',confirmedTmdbId:'9001',lastSeenProgrammeRunId:'run-a2',shows:[show(9200,'title_year',null)]})]});
assert.equal((await repo.readPublished()).programmeRunId,'run-a2');
assert.equal((await repo.readGeneration('run-a')).candidates.length,2);
assert.equal((await repo.readGeneration('run-b')).films[0].shows.length,0);
assert.deepEqual((await repo.readPublishedShows()).map(item=>item.programmeRunId),['run-a2']);
assert.equal(await count(db,"SELECT airing_ms AS n FROM film_epg_last_airing WHERE film_id='film:zz-film'"),9000);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film'),1);

await repo.publishGeneration({programmeRunId:'run-w',phase:'withheld',publishedAt:null,films:[{filmId:'film:zz-film',shows:[show(9300,'title_duration','duration_conflict')]}],candidates:[]});
assert.equal((await repo.readPublished()).programmeRunId,'run-a2');
assert.equal((await repo.readPublishedShows()).some(show=>show.programmeRunId==='run-w'),false);
assert.equal((await repo.readGeneration('run-w')).films[0].shows.length,1);

const terminal=await repo.recordDecision({observationKey:'title-zz|1994',status:'ambiguous',reason:'ambiguous',checkedAt:'2026-10-21T02:00:00.000Z',evidenceKey:'evidence-remake',attempts:5,terminalReason:'repeated_uncertain_match',provenance:{reason:'ambiguous'}});
assert.equal(terminal.applied,true);
const blocked=await repo.recordDecision({observationKey:'title-zz|1994',status:'verified',filmId:'film:zz-film',tmdbId:'9001',checkedAt:'2026-10-21T03:00:00.000Z',evidenceKey:'evidence-remake',identitySource:'tmdb_detail'});
assert.equal(blocked.applied,false);
assert.equal(blocked.reason,'terminal_evidence_unchanged');
assert.equal(blocked.decision.current.status,'ambiguous');
assert.equal(blocked.decision.history.length,0);
const replay=await repo.recordDecision({observationKey:'title-zz|1994',status:'ambiguous',reason:'ambiguous',checkedAt:'2026-10-21T02:00:00.000Z',evidenceKey:'evidence-remake',attempts:5,terminalReason:'repeated_uncertain_match',provenance:{reason:'ambiguous'}});
assert.equal(replay.applied,true);
assert.equal(replay.decision.history.length,0);
const reopened=await repo.recordDecision({observationKey:'title-zz|1994',status:'unresolved',checkedAt:'2026-10-22T01:00:00.000Z',evidenceKey:'evidence-remake-changed',attempts:1,terminalReason:null,provenance:{reason:'evidence_changed'}});
assert.equal(reopened.applied,true);
assert.equal(reopened.decision.current.status,'unresolved');
assert.equal(reopened.decision.history[0].status,'ambiguous');
assert.equal(reopened.decision.history[0].terminalReason,'repeated_uncertain_match');

const verified=await repo.recordDecision({observationKey:'title-zz|1995',status:'verified',catalogFilmId:'tmdb_9001',filmId:'film:zz-film',tmdbId:'9001',canonicalIdentity:'tmdb:9001',identitySource:'known_epg_alias',checkedAt:'2026-10-21T02:00:00.000Z',evidenceKey:'evidence-original',provenance:{authority:'known_epg_alias'}});
assert.equal(verified.applied,true);
const scores=await repo.recordScore({id:'score-remake',observationKey:'title-zz|1994',programmeRunId:'run-a2',scorerVersion:'1',status:'accepted',reason:'accepted',confidence:0.9,score:0.9,acceptedTmdbId:'9001',gateOutcome:'needs_verification',gateReason:'needs_verification',createdAt:'2026-10-21T04:00:00.000Z',considered:[{ordinal:1,tmdbId:'9001',trusted:false,year:1994,runtime:90}],detail:{movieId:'9001',runtime:90,releaseYear:1994,matchedTitle:'Title ZZ',fetchedAt:'2026-10-21T04:00:00.000Z',r2Key:'archive/tmdb/9001',contentSha256:'abc123'}});
assert.equal(scores[0].status,'accepted');
assert.equal(scores[0].acceptedTmdbId,'9001');
assert.equal(scores[0].detail.movieId,'9001');
assert.equal((await repo.readDecision('title-zz|1994')).current.status,'unresolved');
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film'),1);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM candidate_decision WHERE observation_key='heat|1995'"),0);
await assert.rejects(async()=>{await repo.publishGeneration({programmeRunId:'run-key',phase:'published',films:[],candidates:[candidate({observationKey:'film:zz-film'})]});});
await assert.rejects(async()=>{await repo.recordDecision({observationKey:'title-zz|1995',status:'verified',filmId:'film:missing',tmdbId:'9002',checkedAt:'2026-10-22T02:00:00.000Z',evidenceKey:'evidence-missing'});});
assert.equal((await repo.readDecision('title-zz|1995')).current.filmId,'film:zz-film');
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film'),1);

fs.rmSync(root,{recursive:true});
console.log('EPG repository passed.');

function candidate(overrides){
 return {observationKey:'heat|1995',title:'Title ZZ',normalizedTitle:'heat',year:1995,rawTitles:['Title ZZ'],durations:[170],description:'A description',firstAiringMs:1000,lastAiringMs:2000,airings:1,confirmedTmdbId:null,activity:'current',seenInLatest:true,attempts:1,evidenceKey:'evidence-a',shows:[],...overrides};
}
function show(startMs,basis,matchReason){
 return {channelId:'channel-a',channel:'Channel A',startMs,endMs:startMs+1000,epgTitle:'Visible Title',basis,matchReason};
}
async function count(databaseHandle,sql){
 const row=await databaseHandle.get(sql);
 return row.n;
}
function openSqlite(file){
 const state={buffer:null};
 return {
  run(sql,params=[]){const statement=render(sql,params)+';';if(state.buffer)state.buffer.push(statement);else exec(file,statement);return Promise.resolve();},
  get(sql,params=[]){if(state.buffer)throw new Error('Read inside the EPG transaction');return Promise.resolve(query(file,sql,params)[0]??null);},
  all(sql,params=[]){if(state.buffer)throw new Error('Read inside the EPG transaction');return Promise.resolve(query(file,sql,params));},
  async transaction(fn){
   if(state.buffer)return fn();
   state.buffer=[];
   try{await fn();exec(file,'BEGIN;\n'+state.buffer.join('\n')+'\nCOMMIT;\n');}
   finally{state.buffer=null;}
  },
 };
}
function exec(file,sql){
 const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'sqlite failed');
}
function query(file,sql,params){
 const result=spawnSync('sqlite3',['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+render(sql,params)+';',encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'sqlite failed');
 const text=result.stdout.trim();
 return text?JSON.parse(text):[];
}
function render(sql,params=[]){
 let index=0;
 const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('Missing SQL parameter');return literal(params[index++]);});
 if(index!==params.length)throw new Error('Unused SQL parameter');
 return text;
}
function literal(value){
 if(value==null)return 'NULL';
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Bad SQL number');return String(value);}
 if(typeof value==='boolean')return value?'1':'0';
 return "'"+String(value).replaceAll("'","''")+"'";
}
