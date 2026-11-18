// AIR-532 offline benchmark (sqlite3-CLI D1 stand-in, no production access): D1 round trips of one daily watchlist retention scan.
// Counts every D1 call (prepare().first/all/run and batch) per slice and per scan for N unchanged films, then +1/-1. Prints a table; asserts nothing about speed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from '../tests/d1-standin.mjs';
import {sqliteSync} from '../tests/sqlite-session.mjs';
const SRC=path.resolve('src');
const M=await import(pathToFileURL(path.join(SRC,'canonical-rated-admission-producer.js')).href);
const N=Number(process.argv[2]||400);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-bench-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);};
const file=path.join(root,'b.sqlite');
sqlite(file,fs.readdirSync('migrations').filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort().map(n=>fs.readFileSync('migrations/'+n,'utf8')).join('\n'));
sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
sqlite(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');");
const T0='2026-11-17T15:00:00.000Z';
const seed=[];
for(let i=1;i<=N+5;i++)seed.push(`INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:${i}',1,'${T0}');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:${i}','tmdb','${i}',1,0,NULL),('film:tmdb:${i}','letterboxd','lid${i}',1,0,NULL);`);
sqlite(file,seed.join('\n'));
const db=d1Standin(file);
const env={DB:db};
const total=()=>db.calls.queries+db.calls.batches;
async function scan(label,listed,departed,observedAt,scanId){
 const queue=M.watchlistRetentionWork({listed,departed,observedAt,scanId});
 let cursor=0,slices=0,intent=[];const per=[];const before=total(),b0=db.calls.batches,s0=db.calls.statements;const t0=Date.now();
 const sum={applied:0,noop:0,absent:0,failed:0};
 while(cursor<queue.length){
  const room=Math.max(0,M.UNIT_CAP-intent.length),slice=queue.slice(cursor,cursor+room),c0=total();
  const out=await M.applyRatedAdmissionRetention(env,{event:'watchlist:'+scanId+':'+cursor,retentions:slice,intent,limit:M.UNIT_CAP});
  intent=M.carryRatedAdmissionIntent(out);
  if(M.ratedAdmissionSliceSettled(out))cursor+=slice.length;
  for(const k of Object.keys(sum))sum[k]+=Number(out[k]||0);
  per.push(total()-c0);slices++;
 }
 console.log(JSON.stringify({label,queue:queue.length,slices,roundTrips:total()-before,perSliceRoundTrips:Math.round((total()-before)/slices),writeBatches:db.calls.batches-b0,writeStatements:db.calls.statements-s0,...sum,wallMs:Date.now()-t0}));
}
const listed=n=>Array.from({length:n},(_,i)=>({lid:'lid'+(i+1),tmdbId:i+1}));
await scan('day1 first observation',listed(N),[],'2026-11-17T15:00:00.000Z','run1');
await scan('day2 unchanged',listed(N),[],'2026-11-18T15:00:00.000Z','run2');
await scan('day3 +1 -1',listed(N).slice(1).concat([{lid:'lid'+(N+1),tmdbId:N+1}]),['lid1'],'2026-11-19T15:00:00.000Z','run3');
