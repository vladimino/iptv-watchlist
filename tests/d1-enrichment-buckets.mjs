// AIR-395: the checkpoint reconciliation by buckets of the D1 enrichment diff (src/d1-enrichment.js d1EnrichmentCheckpoints). Instead of reading every stored change key, D1 returns per
// bucket (kind and the last two characters of the id) the count and two sums of 32-bit slices of each key's hash part; the Worker computes the same from the fresh keys; only buckets that
// differ are read row by row. Covered: the SQL and the JavaScript compute identical bucket sums on realistic keys; the buckets run and the whole-table run give the same plan, writes and final D1
// state through first import (every bucket differs: the whole table is read), steady state (nothing is read), a change, a new Film, deletions (absent/release), restoration, a stored
// `absent` entity that is live again, a stale checkpoint no source lists, and a corrupt stored key; the rows read are only those of the differing buckets; a tight budget converges to the same
// state. A D1 stand-in over the sqlite3 CLI; a memory bucket for R2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-buckets-'));
let databases=0;
const migrated=()=>{
 const db=d1Standin(path.join(root,'d1-'+(databases++)+'.sqlite'));
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const film=(id,title,tmdbId,directors,actors)=>({id,title,original:title,year:1995,tmdbId,url:'https://letterboxd.com/film/'+id+'/',directors,actors});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis',synopsisFetchedAt:T,runtime:120});
const listed=(index,actors,title='Film '+index)=>film('w'+index,title,String(100+index),[person('director/d'+index,'Director '+index)],Array.from({length:actors},(_,k)=>person('actor/a'+index+'_'+k,'Actor '+index+'_'+k)));
function sources(films){
 const bucket=new MemoryBucket();const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{});
 return bucket;
}
const projector=projectorContext({log:()=>{}});
const dump=db=>JSON.stringify({films:db.sql('SELECT id FROM film ORDER BY id'),people:db.sql('SELECT id FROM person ORDER BY id'),credits:db.sql('SELECT film_id,person_id,role,ordinal FROM film_person_credit ORDER BY film_id,role,ordinal'),members:db.sql('SELECT film_id FROM watchlist_film ORDER BY film_id'),state:db.sql('SELECT kind,id,change_key FROM projection_state ORDER BY kind,id')});
const view=summary=>JSON.stringify([summary.outcome,summary.films,summary.people,summary.stored,summary.changedFilms,summary.changedPeople,summary.absent,summary.writtenFilms,summary.writtenPeople,summary.released,summary.remaining,summary.errorCount,summary.admittedFirst]);
const WHOLE=1e9,BUCKETS=0;                           // bucketMin: above every view the whole table is read; 0 uses buckets for any view
const run=(db,bucket,options={})=>projector.runD1EnrichmentProjection({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e12,...options});

// 1. The SQL and the JavaScript compute the same bucket sums, on keys of the real shape (version, text length, two 53-bit hashes in hex) and ids of every length.
{
 const db=migrated();
 const hex=count=>Array.from({length:count},()=>'0123456789abcdef'[Math.floor(Math.random()*16)]).join('');
 const rows=[];
 for(let index=0;index<400;index++){
  const kind=index%3===0?'film':'person';
  const id=(kind==='film'?'film:':'person:')+(index%50===0?'x':index%7===0?'tmdb_actor/'+(10000+index):'actor/name-'+index);
  const key='1:'+(100+index)+':'+hex(14)+hex(14);
  rows.push({kind,id:id+index,key});
 }
 db.sql("INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES "+rows.map(row=>"('enrichment','"+row.kind+"','"+row.id+"','"+row.key+"','t')").join(',')+",('enrichment','person','person:gone','absent','t')");
 const expected=new Map();
 for(const row of rows){const bucket=projector.d1EnrichmentBucketOf(row.kind,row.id),sums=projector.d1EnrichmentKeySums(row.key),item=expected.get(bucket)||[0,0,0];item[0]++;item[1]+=sums[0];item[2]+=sums[1];expected.set(bucket,item);}
 const sqlRows=db.sql(projector.D1_ENRICHMENT_BUCKET_SQL.replace('?',"'enrichment'"));
 assert.equal(sqlRows.length,expected.size,'the same buckets; the absent row is left out');
 for(const row of sqlRows)assert.equal(JSON.stringify([row.n,row.a,row.c]),JSON.stringify(expected.get(row.b)),'bucket '+row.b);
 assert.equal(projector.d1EnrichmentKeySums('absent'),null);assert.equal(projector.d1EnrichmentKeySums('1:5:abc'),null,'a key too short for the slices is not summed');
}

// 2. The same plan, writes and D1 state at every step, whole-table read against buckets; and what the buckets run reads.
{
 const whole=migrated(),buckets=migrated();
 const base=Array.from({length:60},(_,index)=>listed(index,7));
 const steps=[
  ['first import (nothing stored: a backlog, the whole table is read)',base,s=>{assert.equal(s.checkpointMode,'full');assert.equal(s.checkpointBuckets.skipped,'backlog');}],
  ['steady state',base,s=>{assert.equal(s.checkpointMode,'buckets');assert.equal(s.checkpointBuckets.differing,0);assert.ok(!s.phases['diff.checkpointRows']||s.phases['diff.checkpointRows'].rows===0,'nothing is read row by row');assert.equal(s.changedFilms+s.changedPeople+s.absent,0);}],
  ['one title changed',[...base.slice(0,5),listed(5,7,'Renamed 5'),...base.slice(6)],s=>{assert.equal(s.checkpointMode,'buckets');assert.ok(s.checkpointBuckets.differing>=1&&s.checkpointBuckets.differing<=3,JSON.stringify(s.checkpointBuckets));assert.equal(s.changedFilms,1);}],
  ['a new Film and a roster change',[...base.slice(0,5),listed(5,7,'Renamed 5'),...base.slice(6,20),listed(20,9),...base.slice(21),listed(60,7)],s=>{assert.equal(s.checkpointMode,'buckets');assert.ok(s.changedFilms>=2);}],
  ['two Films deleted',base.filter(item=>!['w3','w4'].includes(item.id)),s=>{assert.equal(s.checkpointMode,'buckets');}],
  ['the two Films restored',base,s=>{assert.equal(s.checkpointMode,'buckets');}],
 ];
 for(const [name,films,check] of steps){
  const sa=await run(whole,sources(films),{bucketMin:WHOLE}),sb=await run(buckets,sources(films),{bucketMin:BUCKETS});
  assert.equal(view(sa),view(sb),name+': same plan and writes\n'+view(sa)+'\n'+view(sb));
  assert.equal(dump(whole),dump(buckets),name+': same D1 state');
  check(sb);
 }
 // a stored `absent` entity that is live again, a stale checkpoint no source lists, a corrupt stored key
 for(const [name,mutate] of [
  ['a live entity stored as absent',db=>db.sql("UPDATE projection_state SET change_key='absent' WHERE kind='person' AND id='person:actor/a7_3'")],
  ['a stale checkpoint no source lists',db=>db.sql("INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','person','person:ghost/zz','1:5:00000000000000aaaaaaaaaaaaaa','t')")],
  ['a stale film checkpoint',db=>db.sql("INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','film','film:ghost-film','1:5:00000000000000aaaaaaaaaaaaaa','t')")],
  ['a corrupt stored key',db=>db.sql("UPDATE projection_state SET change_key='junk' WHERE kind='film' AND id='film:w10'")],
  ['a stored key of the right shape but another value',db=>db.sql("UPDATE projection_state SET change_key='1:99:ffffffffffffffffffffffffffff' WHERE kind='person' AND id='person:actor/a12_2'")],
 ]){
  mutate(whole);mutate(buckets);
  const sa=await run(whole,sources(base),{bucketMin:WHOLE}),sb=await run(buckets,sources(base),{bucketMin:BUCKETS});
  assert.equal(view(sa),view(sb),name+': same plan and writes\n'+view(sa)+'\n'+view(sb));
  assert.equal(dump(whole),dump(buckets),name+': same D1 state');
  assert.equal(sb.checkpointMode,'buckets',name);
  assert.ok(sa.changedFilms+sa.changedPeople+sa.absent>=1,name+': the mutation is seen by the whole-table run');
 }
}

// 3. A change that touches few buckets reads only their rows; the digest is one query and the rows a few more.
{
 const db=migrated(),films=Array.from({length:60},(_,index)=>listed(index,7));
 await run(db,sources(films),{bucketMin:BUCKETS});
 const changed=[...films.slice(0,5),listed(5,7,'Renamed 5'),...films.slice(6)];
 const summary=await run(db,sources(changed),{bucketMin:BUCKETS});
 const total=db.sql("SELECT COUNT(*) AS n FROM projection_state")[0].n;
 assert.equal(summary.checkpointMode,'buckets');
 assert.ok(summary.phases['diff.checkpointRows'].rows<total/4,'only the differing buckets are read: '+summary.phases['diff.checkpointRows'].rows+' of '+total);
 assert.equal(summary.phases['diff.checkpointDigest'].q,1);
 assert.ok(summary.phases['diff.checkpointDigest'].rows<=summary.films+summary.people,'the digest has one row per bucket at most');
 assert.equal(summary.phases['diff.storedRead'],undefined,'no whole-table read in the buckets mode');
 assert.equal(summary.stored,total,'the stored count is the table count');
}

// 4. A tight budget in the buckets mode converges to the same state as one unconstrained run.
{
 const films=Array.from({length:30},(_,index)=>listed(index,7));
 const reference=migrated();await run(reference,sources(films),{bucketMin:WHOLE});
 const db=migrated();let last,runs=0;
 do{last=await run(db,sources(films),{bucketMin:BUCKETS,queryBudget:70});runs++;}while(last.outcome==='budget'&&runs<80);
 assert.equal(last.outcome,'complete');assert.ok(runs>=4);
 assert.equal(dump(db),dump(reference));
}

// 5. The constants are fixed, no id or key enters the SQL text, and the full table read stays the answer for a small view.
const source=fs.readFileSync('src/d1-enrichment.js','utf8');
assert.match(source,/const D1_ENRICHMENT_BUCKET_MIN_ENTITIES=5000,D1_ENRICHMENT_BUCKET_PARAMS=90,D1_ENRICHMENT_BUCKET_MAX_SHARE=0\.4,D1_ENRICHMENT_BUCKET_MAX_MISSING=0\.25/);
{
 const db=migrated(),films=Array.from({length:10},(_,index)=>listed(index,3));
 const summary=await run(db,sources(films));
 assert.equal(summary.checkpointMode,'full','below the default threshold of 5,000 entities the whole table is read');
}
console.log('D1 enrichment checkpoint buckets (AIR-395): SQL and JavaScript compute the same bucket sums; the buckets run gives the same plan, writes and D1 state as the whole-table run through first import, steady state, change, new Film, deletion, restore, a stored absent entity, stale and corrupt checkpoints; only differing buckets are read; a tight budget converges; a small view reads the whole table');
