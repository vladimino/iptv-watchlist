// AIR-398: the checkpoint buckets of the D1 enrichment diff (src/d1-enrichment.js, AIR-395) must put an id in the SAME bucket in SQL and in JavaScript for every id, not only ASCII
// ones. The first version cut the last four CHARACTERS: SQLite's substr()/unicode() count code points, JavaScript's charCodeAt() counts UTF-16 units, so an id ending in an emoji or
// another non-BMP character (or holding a lone surrogate, which D1 stores as U+FFFD) landed in different buckets, and a stored row whose id is shorter than four characters had a NULL
// bucket. The mapping is now over the last four UTF-8 BYTES of '0000'+id on both sides, the digest asks the database for nothing it cannot compute the same way, fresh ids that are not
// well-formed UTF-16 send the run to the whole-table read, and a digest or row that disagrees with the JavaScript mapping does too (a visible `skipped` reason, never a silent miss).
// Covered: SQL and JavaScript agree on ids of every class (ASCII, Cyrillic, composed and decomposed accents, CJK, emoji, non-BMP letters, short stored-only ids); the buckets run and the
// whole-table run give the same plan, writes and final D1 state through first import, steady state (no false difference), change, new Film, delete, restore, stored-only rows, a stored
// `absent` entity that is live again and a corrupt key, all on non-ASCII ids; an ill-formed fresh id; an injected SQL/JS mismatch and an injected NULL bucket fall back to the whole table.
// A D1 stand-in over the sqlite3 CLI; a memory bucket for R2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-bucket-unicode-'));
let databases=0;
const migrated=(opts={})=>{
 const db=d1Standin(path.join(root,'d1-'+(databases++)+'.sqlite'),opts);
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const film=(id,title,tmdbId,directors,actors)=>({id,title,original:title,year:1995,tmdbId,url:'https://letterboxd.com/film/'+id+'/',directors,actors});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis',synopsisFetchedAt:T,runtime:120});
// the person role ids: one of every id class a Person can carry (the id is `person:` + the role id)
const UNICODE_ROLES=['actor/иван-петров','actor/josé','actor/josé','actor/日本語','actor/😀','actor/a😀b','actor/x𝒳y','actor/ñandú-🦙','actor/é','actor/ab\u{1F9D1}‍\u{1F4BB}','director/Æsir','director/최민식'];
const listed=(index,roles,title='Film '+index)=>film('w'+index,title,String(100+index),[person('director/d'+index,'Director '+index)],roles.map((role,k)=>person(role,'Actor '+index+'_'+k)));
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
const dump=db=>JSON.stringify({films:db.sql('SELECT id FROM film ORDER BY id'),people:db.sql('SELECT id FROM person ORDER BY id'),credits:db.sql('SELECT film_id,person_id,role,ordinal FROM film_person_credit ORDER BY film_id,role,ordinal'),watch:db.sql('SELECT film_id FROM watchlist_film ORDER BY film_id'),state:db.sql("SELECT kind,id,change_key FROM projection_state WHERE projection='enrichment' ORDER BY kind,id")});
const view=summary=>JSON.stringify([summary.outcome,summary.films,summary.people,summary.stored,summary.changedFilms,summary.changedPeople,summary.absent,summary.writtenFilms,summary.writtenPeople,summary.released,summary.remaining,summary.errorCount,summary.members,summary.membershipRemoved]);
const WHOLE=1e9,BUCKETS=0;
const run=(db,bucket,options={})=>projector.runD1EnrichmentProjection({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e12,...options});
const literal=text=>"'"+text.replace(/'/g,"''")+"'";
const key=seed=>'1:'+(100+seed)+':'+(seed.toString(16).padStart(14,'0'))+((seed*2654435761)%0xffffffffffff).toString(16).padStart(14,'0');

// 1. SQL and JavaScript give the same bucket for every id class, and the same sums; a short stored-only id has a bucket, not NULL.
const IDS=['film:w1','film:tmdb_5','person:actor/иван-петров','person:actor/josé','person:actor/josé','person:actor/日本語','person:actor/😀','person:actor/a😀b','person:actor/x𝒳y','person:actor/ñandú-🦙','person:actor/é','person:actor/👩‍💻','x','ab','abc','abcd','é','😀','😀😀','a😀'];
{
 const db=migrated();
 const rows=IDS.map((id,index)=>({kind:index%2?'film':'person',id,key:key(index+1)}));
 db.sql('INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES '+rows.map(row=>"('enrichment','"+row.kind+"',"+literal(row.id)+",'"+row.key+"','t')").join(','));
 const expected=new Map();
 for(const row of rows){const bucket=projector.d1EnrichmentBucketOf(row.kind,row.id),sums=projector.d1EnrichmentKeySums(row.key),item=expected.get(bucket)||[0,0,0];item[0]++;item[1]+=sums[0];item[2]+=sums[1];expected.set(bucket,item);}
 const sqlRows=db.sql(projector.D1_ENRICHMENT_BUCKET_SQL.replace('?',"'enrichment'"));
 assert.ok(sqlRows.every(row=>typeof row.b==='string'&&/^(film|person):\d{1,4}$/.test(row.b)),'every stored id has a bucket, none is NULL: '+JSON.stringify(sqlRows.map(row=>row.b)));
 assert.equal(sqlRows.length,expected.size);
 for(const row of sqlRows)assert.equal(JSON.stringify([row.n,row.a,row.c]),JSON.stringify(expected.get(row.b)),'bucket '+row.b);
 // each id alone: the bucket the database computes for the row equals the JavaScript one
 for(const row of rows){
  db.sql('DELETE FROM projection_state');
  db.sql("INSERT INTO projection_state VALUES ('enrichment','"+row.kind+"',"+literal(row.id)+",'"+row.key+"','t')");
  assert.equal(db.sql(projector.D1_ENRICHMENT_BUCKET_SQL.replace('?',"'enrichment'"))[0].b,projector.d1EnrichmentBucketOf(row.kind,row.id),JSON.stringify(row.id));
 }
 // the byte mapping on ids whose last four characters differ from their last four bytes
 assert.notEqual(projector.d1EnrichmentBucketOf('person','person:actor/😀'),projector.d1EnrichmentBucketOf('person','person:actor/😁'));
 assert.equal(projector.d1EnrichmentBucketOf('person','person:actor/x'),projector.d1EnrichmentBucketOf('person','person:actor/x'),'deterministic');
}

// 2. The same plan, writes and D1 state at every step, whole-table read against buckets, on non-ASCII ids; and no false difference.
{
 const whole=migrated(),buckets=migrated();
 const base=Array.from({length:40},(_,index)=>listed(index,[UNICODE_ROLES[index%UNICODE_ROLES.length],UNICODE_ROLES[(index+5)%UNICODE_ROLES.length],'actor/plain-'+index,'actor/plain-b'+index]));
 const steps=[
  ['first import (nothing stored: a backlog, the whole table is read)',base,s=>{assert.equal(s.checkpointMode,'full');assert.equal(s.checkpointBuckets.skipped,'backlog');}],
  ['steady state: no false difference on any id class',base,s=>{assert.equal(s.checkpointMode,'buckets');assert.equal(s.checkpointBuckets.differing,0,JSON.stringify(s.checkpointBuckets));assert.equal(s.changedFilms+s.changedPeople+s.absent,0);}],
  ['a Film roster changes: a non-BMP Person leaves and another joins',base.map((item,index)=>index===4?{...item,actors:[...item.actors.slice(1),person('actor/🧑\u200D🚀-new','Astronaut')]}:item),s=>{assert.equal(s.checkpointMode,'buckets');assert.ok(s.changedFilms>=1&&s.changedPeople>=1&&s.checkpointBuckets.differing>=1,JSON.stringify([s.changedFilms,s.changedPeople,s.checkpointBuckets]));}],
  ['a new Film with a non-BMP Person',[...base.slice(0,10),listed(40,['actor/🦙-new','actor/𝒳𝒴']),...base.slice(10)],s=>{assert.equal(s.checkpointMode,'buckets');assert.ok(s.changedFilms>=1);}],
  ['two Films deleted (their Persons become absent)',base.filter(item=>!['w3','w4'].includes(item.id)),s=>{assert.equal(s.checkpointMode,'buckets');}],
  ['the two Films restored',base,s=>{assert.equal(s.checkpointMode,'buckets');}],
 ];
 for(const [name,films,check] of steps){
  const sa=await run(whole,sources(films),{bucketMin:WHOLE}),sb=await run(buckets,sources(films),{bucketMin:BUCKETS});
  assert.equal(view(sa),view(sb),name+': same plan and writes\n'+view(sa)+'\n'+view(sb));
  assert.equal(dump(whole),dump(buckets),name+': same D1 state');
  check(sb);
 }
 // stored-only rows and corrupt rows, on ids of every class: a short id, an emoji id, a stored `absent` entity that is live again, a corrupt key
 for(const [name,mutate] of [
  ['a stale stored-only row with a one-character id',db=>db.sql("INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','person','x','1:5:00000000000000aaaaaaaaaaaaaa','t')")],
  ['a stale stored-only row with a two-character non-BMP id',db=>db.sql("INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','person','😀😀','1:5:00000000000000aaaaaaaaaaaaaa','t')")],
  ['a stale stored-only Person ending in an emoji',db=>db.sql("INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','person','person:ghost/👻','1:5:00000000000000aaaaaaaaaaaaaa','t')")],
  ['a stale stored-only Film with a Cyrillic id',db=>db.sql("INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','film','film:призрак','1:5:00000000000000aaaaaaaaaaaaaa','t')")],
  ['a live non-BMP Person stored as absent',db=>db.sql("UPDATE projection_state SET change_key='absent' WHERE kind='person' AND id='person:actor/😀'")],
  ['a corrupt stored key on a Person with a non-BMP id',db=>db.sql("UPDATE projection_state SET change_key='junk' WHERE kind='person' AND id='person:actor/x𝒳y'")],
 ]){
  mutate(whole);mutate(buckets);
  const sa=await run(whole,sources(base),{bucketMin:WHOLE}),sb=await run(buckets,sources(base),{bucketMin:BUCKETS});
  assert.equal(view(sa),view(sb),name+': same plan and writes\n'+view(sa)+'\n'+view(sb));
  assert.equal(dump(whole),dump(buckets),name+': same D1 state');
  assert.equal(sb.checkpointMode,'buckets',name+': '+JSON.stringify(sb.checkpointBuckets));
 }
}

// 3. A fresh id that is not well-formed UTF-16 (a lone surrogate, which the database would store as U+FFFD) sends the run to the whole table before any digest is asked for.
{
 const db=migrated();
 const calls={all:0,get:0,sql:[]};
 const adapter={async all(sql){calls.all++;calls.sql.push(sql);return [];},async get(sql){calls.get++;calls.sql.push(sql);return {n:0};}};
 const timer={phases:{},detail:{},async time(name,fn){return fn();},sync(name,fn){return fn();}};
 const keys=new Map(),inputs={people:[],films:[]};
 for(let index=0;index<10;index++){const entry={id:'person:actor/'+(index===3?'bad\uD83D':'ok'+index)};keys.set(entry,key(index+1));inputs.people.push(entry);}
 const summary={};
 const result=await projector.d1EnrichmentCheckpoints(adapter,{inputs,keys,timer,storedPage:6000,bucketMin:0,summary});
 assert.equal(result.mode,'full');assert.equal(summary.checkpointBuckets.skipped,'unsafe_id');
 assert.ok(!calls.sql.some(sql=>/GROUP BY/.test(sql)),'no digest was asked for');
 // the same inputs without the ill-formed id take the bucket path
 const good={people:inputs.people.map((entry,index)=>index===3?{id:'person:actor/fine'}:entry),films:[]};
 const keys2=new Map();good.people.forEach((entry,index)=>keys2.set(entry,key(index+1)));
 const summary2={};
 // a database whose digest agrees with the inputs (every entity stored with its fresh key): nothing differs and nothing is read row by row
 const digest=new Map();
 for(const entry of good.people){const bucket=projector.d1EnrichmentBucketOf('person',entry.id),sums=projector.d1EnrichmentKeySums(keys2.get(entry)),item=digest.get(bucket)||{b:bucket,n:0,a:0,c:0};item.n++;item.a+=sums[0];item.c+=sums[1];digest.set(bucket,item);}
 const result2=await projector.d1EnrichmentCheckpoints({async all(sql){return sql.includes('GROUP BY')?[...digest.values()]:[];},async get(){return {n:10};}},{inputs:good,keys:keys2,timer,storedPage:6000,bucketMin:0,summary:summary2});
 assert.equal(result2.mode,'buckets');assert.equal(summary2.checkpointBuckets.skipped,undefined);assert.equal(summary2.checkpointBuckets.differing,0);
 void db;
}

// 4. An injected disagreement between the database and the Worker never changes the plan: a NULL bucket is detected and falls back to the whole table, and a code-point mapping (the first
// version) only makes more buckets differ (a visible cost, never a missed change), because a misplaced entity leaves BOTH of its buckets with a count that does not match.
{
 const OLD_EXPR="((unicode(substr(id,-1,1))*1664525+unicode(substr(id,-2,1))*22695477+unicode(substr(id,-3,1))*48271+unicode(substr(id,-4,1))*69069)%4096)";
 const exotic=index=>['actor/😀'+index,'actor/x𝒳'+index];
 // a few exotic Persons among many ASCII ones: the bucket path stays in use, so the injected mapping is really exercised
 const few=Array.from({length:60},(_,index)=>listed(index,index%10===5?[...exotic(index),'actor/ok'+index]:['actor/ok'+index,'actor/ok-b'+index,'actor/ok-c'+index]));
 const edited=[...few.slice(0,5),listed(5,[...exotic(5),'actor/ok5'],'Renamed 5'),...few.slice(6)];
 const results={};
 for(const [name,rewrite] of [['correct',null],['the database counts code points where the Worker counts bytes',sql=>sql.split(projector.D1_ENRICHMENT_BUCKET_EXPR).join(OLD_EXPR)],['the database answers NULL for a bucket',sql=>sql.split(projector.D1_ENRICHMENT_BUCKET_EXPR).join('NULL')]]){
  const reference=migrated(),injected=migrated(rewrite?{rewrite}:{});
  await run(reference,sources(few),{bucketMin:WHOLE});await run(injected,sources(few),{bucketMin:BUCKETS});
  const steady=await run(injected,sources(few),{bucketMin:BUCKETS});
  const sa=await run(reference,sources(edited),{bucketMin:WHOLE}),sb=await run(injected,sources(edited),{bucketMin:BUCKETS});
  assert.equal(view(sa),view(sb),name+': same plan and writes\n'+view(sa)+'\n'+view(sb));
  assert.equal(dump(reference),dump(injected),name+': same D1 state');
  assert.equal(sb.changedFilms,1,name+': the change is not missed');
  results[name]={steady:steady.checkpointBuckets,changed:sb.checkpointBuckets,mode:sb.checkpointMode};
 }
 assert.equal(results.correct.steady.differing,0,'no false difference with the byte mapping');
 assert.equal(results.correct.mode,'buckets');
 const old=results['the database counts code points where the Worker counts bytes'];
 assert.ok(old.steady.differing>0||old.steady.skipped,'the injected mapping is visible as false differences or a fallback: '+JSON.stringify(old.steady));
 const nulls=results['the database answers NULL for a bucket'];
 assert.equal(nulls.mode,'full');assert.equal(nulls.changed.skipped,'bucket_mismatch','a NULL bucket is detected: '+JSON.stringify(nulls.changed));
 // every exotic id disagreeing at once: so many buckets differ that the whole table is read
 const heavy=Array.from({length:30},(_,index)=>listed(index,['actor/😀'+index,'actor/x𝒳'+index,'actor/ok'+index,'actor/ok-b'+index]));
 const reference=migrated(),injected=migrated({rewrite:sql=>sql.split(projector.D1_ENRICHMENT_BUCKET_EXPR).join(OLD_EXPR)});
 await run(reference,sources(heavy),{bucketMin:WHOLE});await run(injected,sources(heavy),{bucketMin:BUCKETS});
 const sa=await run(reference,sources(heavy),{bucketMin:WHOLE}),sb=await run(injected,sources(heavy),{bucketMin:BUCKETS});
 assert.equal(view(sa),view(sb));assert.equal(dump(reference),dump(injected));assert.equal(sb.checkpointMode,'full','too many differing buckets: the whole table is read');
}

// 5. The mapping is one function of the last four UTF-8 bytes on both sides, and the SQL text carries no id.
{
 const source=fs.readFileSync('src/d1-enrichment.js','utf8');
 assert.doesNotMatch(source,/charCodeAt\(at-4\)/,'no UTF-16 unit mapping is left');
 assert.doesNotMatch(projector.D1_ENRICHMENT_BUCKET_EXPR,/unicode\(/,'no code point function in the SQL');
 assert.match(projector.D1_ENRICHMENT_BUCKET_EXPR,/CAST\('0000'\|\|id AS BLOB\)/);
 assert.doesNotMatch(projector.D1_ENRICHMENT_BUCKET_SQL,/[^\x00-\x7f]/,'the statement is ASCII');
}
console.log('D1 enrichment checkpoint buckets on non-ASCII ids (AIR-398): SQL and JavaScript agree on ids of every class including emoji, non-BMP letters, combining marks and short stored-only ids; the buckets run gives the same plan, writes and D1 state as the whole table on those ids through import, steady state without false differences, change, new Film, delete, restore, stored-only, absent and corrupt rows; an ill-formed fresh id, an injected NULL bucket falls back to the whole table and an injected code-point mapping only adds false differences, never a missed change');
