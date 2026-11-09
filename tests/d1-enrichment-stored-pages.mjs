// AIR-395 (interim): the checkpoint read of the D1 enrichment diff goes out as pages (src/d1-enrichment.js d1EnrichmentStoredRows) and must give exactly the same Map as the
// single query: same plans, same writes, same final D1 state, through first import, steady state, change, deletion, restore and a tight budget. The pages are accepted only when
// they add up (count and no duplicate), otherwise the table is read whole: shown with a lying count and an overlapping page. At most six page queries are in flight.
// A D1 stand-in over the sqlite3 CLI with a statement wrapper; a memory bucket for R2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-pages-'));
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
// The D1 binding the projector sees: statements keep their text for batch(); page queries are counted and held for a moment so that concurrency shows.
function binding(db,{lieAboutCount=false,overlap=false}={}){
 const stats={pageQueries:0,countQueries:0,wholeQueries:0,maxInflight:0,inflight:0};
 const wrap=(sql,statement)=>({...statement,
  async all(){
   const isPage=/LIMIT/.test(sql),isWhole=/FROM projection_state WHERE projection=\?$/.test(sql);
   let mine=0;
   if(isPage){mine=++stats.pageQueries;stats.inflight++;stats.maxInflight=Math.max(stats.maxInflight,stats.inflight);await new Promise(resolve=>setTimeout(resolve,3));}
   if(isWhole)stats.wholeQueries++;
   try{
    const result=await statement.all();
    if(isPage&&overlap&&result.results.length&&mine===2)result.results.push(result.results[0]);
    return result;
   }finally{if(isPage)stats.inflight--;}
  },
  async first(){
   const row=await statement.first();
   if(/SELECT COUNT\(\*\) AS n FROM projection_state/.test(sql)){stats.countQueries++;if(lieAboutCount)return {n:Number(row.n)+1};}
   return row;
  }});
 return {stats,prepare:sql=>({bind:(...params)=>wrap(sql,db.prepare(sql).bind(...params))}),batch:statements=>db.batch(statements)};
}
const dump=db=>JSON.stringify({films:db.sql('SELECT id FROM film ORDER BY id'),people:db.sql('SELECT id FROM person ORDER BY id'),credits:db.sql('SELECT film_id,person_id,role,ordinal FROM film_person_credit ORDER BY film_id,role,ordinal'),members:db.sql('SELECT film_id FROM watchlist_film ORDER BY film_id'),state:db.sql('SELECT kind,id,change_key FROM projection_state ORDER BY kind,id')});
const view=summary=>JSON.stringify([summary.outcome,summary.films,summary.people,summary.stored,summary.changedFilms,summary.changedPeople,summary.absent,summary.writtenFilms,summary.writtenPeople,summary.released,summary.remaining,summary.errorCount,summary.admittedFirst]);
const BIG=0,PAGE=25; // storedPage 0 is the original single query
const run=(bind,bucket,options={})=>projector.runD1EnrichmentProjection({DB:bind,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e12,...options});

// 1. The same plan and the same writes at every step, whole-table read against pages of 25 (with six at a time).
{
 const single=migrated(),paged=migrated(),a=binding(single),b=binding(paged);
 const base=Array.from({length:30},(_,index)=>listed(index,7));
 const steps=[
  ['first import',base],
  ['steady state',base],
  ['a title and a roster change, one new Film',[...base.slice(0,5),listed(5,7,'Renamed 5'),...base.slice(6,29),listed(29,9),listed(30,7)]],
  ['two Films deleted',base.filter(item=>!['w3','w4'].includes(item.id))],
  ['the two Films restored',base],
 ];
 for(const [name,films] of steps){
  const sa=await run(a,sources(films),{storedPage:BIG}),sb=await run(b,sources(films),{storedPage:PAGE});
  assert.equal(view(sa),view(sb),name+': same plan and writes\n'+view(sa)+'\n'+view(sb));
  assert.equal(dump(single),dump(paged),name+': same D1 state');
 }
 assert.ok(a.stats.pageQueries===0&&a.stats.wholeQueries>0,'the whole-table read is one query: '+JSON.stringify(a.stats));
 assert.ok(b.stats.pageQueries>0&&b.stats.countQueries>0,'the paged read used pages and a count: '+JSON.stringify(b.stats));
 assert.ok(b.stats.maxInflight>=2&&b.stats.maxInflight<=6,'pages go out together but never more than six: '+b.stats.maxInflight);
 assert.equal(b.stats.wholeQueries,0,'no fallback when the pages add up');
 // the phase timing names the paged read as one phase with the whole row count
 const timed=await run(b,sources(base),{storedPage:PAGE});
 assert.equal(timed.phases['diff.storedRead'].rows,timed.stored,'one phase, the whole table');
 assert.equal(timed.phases['diff.storedRead'].n,1);
}

// 2. A tight budget: the runs converge to exactly what one unconstrained run writes, with pages as with the whole-table read.
{
 const films=Array.from({length:30},(_,index)=>listed(index,7));
 const reference=migrated();await run(binding(reference),sources(films),{storedPage:BIG});
 for(const page of [BIG,PAGE]){
  const db=migrated(),bind=binding(db);let last,runs=0;
  do{last=await run(bind,sources(films),{storedPage:page,queryBudget:70});runs++;}while(last.outcome==='budget'&&runs<80);
  assert.equal(last.outcome,'complete');assert.ok(runs>=4,'the budget was tight');
  assert.equal(dump(db),dump(reference),'converges to the unconstrained state with page '+page);
 }
}

// 3. Pages that do not add up are thrown away and the table is read whole: a lying count, and an overlapping page. The plan and the state stay those of the whole read.
for(const [name,faults] of [['a count that is one too high',{lieAboutCount:true}],['a page that comes back with a duplicate row',{overlap:true}]]){
 const reference=migrated(),db=migrated();
 const films=Array.from({length:30},(_,index)=>listed(index,7));
 await run(binding(reference),sources(films),{storedPage:BIG});await run(binding(db),sources(films),{storedPage:BIG});
 const changed=[...films.slice(0,10),listed(10,7,'Renamed 10'),...films.slice(11)];
 const bind=binding(db,faults);
 const sa=await run(binding(reference),sources(changed),{storedPage:BIG}),sb=await run(bind,sources(changed),{storedPage:PAGE});
 assert.equal(view(sa),view(sb),name+': same plan');
 assert.equal(dump(reference),dump(db),name+': same D1 state');
 assert.ok(bind.stats.wholeQueries>=1,name+': the table was read whole after the pages disagreed: '+JSON.stringify(bind.stats));
}

// 4. The page size and concurrency are fixed constants, not data-driven; no table, key or id enters the SQL text.
const source=fs.readFileSync('src/d1-enrichment.js','utf8');
assert.match(source,/const D1_ENRICHMENT_STORED_PAGE=6000,D1_ENRICHMENT_STORED_CONCURRENCY=6;/);
assert.match(source,/ORDER BY kind,id LIMIT \? OFFSET \?/);
console.log('D1 enrichment checkpoint pages (AIR-395 interim): the paged read gives the same plan, writes and D1 state as the single query through first import, steady state, change, deletion, restore and a tight budget; pages go out together but never more than six; a lying count or an overlapping page falls back to the whole-table read with the same result');
