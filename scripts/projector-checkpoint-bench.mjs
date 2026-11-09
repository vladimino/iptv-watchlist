// AIR-395 offline benchmark: what the checkpoint reconciliation of the D1 enrichment diff moves from D1 to the Worker, against reading every checkpoint. Not bundled, never run by CI or
// production. It runs the REAL d1EnrichmentCheckpoints (src/d1-enrichment.js, loaded as the Worker bundle carries it) and its real SQL on an in-memory SQLite holding a projection_state shaped like
// production (28,700 Persons and 3,400 Films, keys of the real format `1:<length>:<two 53-bit hashes in hex>`, ids of tmdb and slug form), for several shares of changed entities. It measures
// the mode chosen, the queries, the rows that would cross the D1 binding and the CPU of the JavaScript and SQLite work; it cannot measure D1 or network latency, which is read from the natural runs.
//   node scripts/projector-checkpoint-bench.mjs [--persons 28700] [--films 3400]
import {DatabaseSync} from 'node:sqlite';
import {projectorContext} from '../tests/d1-enrichment-context.mjs';

const arg=(name,fallback)=>{const at=process.argv.indexOf('--'+name);return at>0?Number(process.argv[at+1]):fallback;};
const PERSONS=arg('persons',28700),FILMS=arg('films',3400);
const projector=projectorContext({log:()=>{}});
const random=(()=>{let a=12345;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};})();
const hex=count=>Array.from({length:count},()=>'0123456789abcdef'[Math.floor(random()*16)]).join('');
const key=()=>'1:'+(200+Math.floor(random()*3000))+':'+hex(14)+hex(14);
const ids=[];
for(let i=0;i<PERSONS;i++)ids.push(['person',i%4===0?'person:actor/'+['robert','jean','maria','anna','john','luis'][i%6]+'-'+i.toString(36):'person:tmdb_actor/'+(1000+i*3)]);
for(let i=0;i<FILMS;i++)ids.push(['film',i%5===0?'film:w'+i.toString(36):'film:tmdb_'+(5000+i*7)]);

function scenario(changedShare,missingShare=0){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('CREATE TABLE projection_state (projection TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,change_key TEXT NOT NULL,projected_at TEXT NOT NULL,PRIMARY KEY (projection,kind,id)) STRICT');
 const insert=sqlite.prepare("INSERT INTO projection_state VALUES ('enrichment',?,?,?,'t')");
 const stored=new Map();
 sqlite.exec('BEGIN');
 for(const [kind,id] of ids){if(random()<missingShare)continue;const k=key();stored.set(kind+'\n'+id,k);insert.run(kind,id,k);}
 sqlite.exec('COMMIT');
 const inputs={people:[],films:[]},keys=new Map();
 for(const [kind,id] of ids){
  const entry={id};
  keys.set(entry,stored.has(kind+'\n'+id)&&random()>=changedShare?stored.get(kind+'\n'+id):key());
  (kind==='person'?inputs.people:inputs.films).push(entry);
 }
 const counters={queries:0,rows:0,digestRows:0};
 const db={
  async all(sql,params=[]){counters.queries++;const rows=sqlite.prepare(sql).all(...params);counters.rows+=rows.length;return rows;},
  async get(sql,params=[]){counters.queries++;return sqlite.prepare(sql).get(...params)??null;},
 };
 const phases={};
 const timer={phases,detail:{},async time(name,fn,{rows=null}={}){const at=process.hrtime.bigint();const value=await fn();const item=phases[name]||(phases[name]={ms:0,rows:0});item.ms+=Number(process.hrtime.bigint()-at)/1e6;if(rows)item.rows+=rows(value)||0;return value;},sync(name,fn){return fn();}};
 const summary={};
 return projector.d1EnrichmentCheckpoints(db,{inputs,keys,timer,storedPage:6000,bucketMin:5000,summary}).then(result=>({changedShare,missingShare,mode:result.mode,queries:counters.queries,rowsAcrossBinding:counters.rows,buckets:summary.checkpointBuckets||null,phases:Object.fromEntries(Object.entries(phases).map(([k,v])=>[k,{ms:+v.ms.toFixed(1),rows:v.rows}])),total:result.total}));
}
const out=[];
for(const share of [0,0.001,0.005,0.02,0.05,0.2,0.5])out.push(await scenario(share));
// the production backlog of 2026-11-09: the view has about a third more entities than the table has rows, and a few percent of the stored ones changed
out.push(await scenario(0.05,0.33));
const wholeRows=PERSONS+FILMS;
console.log(JSON.stringify({entities:wholeRows,wholeTable:{queries:'1 query, or 6 pages and a count',rowsAcrossBinding:wholeRows},scenarios:out},null,1));
