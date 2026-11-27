// AIR-605: the run outbox of the Catalog Enrichment Producer and its delivery to the Events Log (ADR 0211 decision 5 as amended by ADR 0219): the pure event of a terminal row (counts only, source-specific), the create-only
// delivery under a key that is a pure function of the run (a retry never duplicates; an existing key is delivery), the hourly retry schedule and the compare-and-swap on the attempt counter, started rows never delivered,
// no deletion (the per-source counts of a real run and the delivery from the Workflow and the reconcile are proved in tests/catalog-enrichment-workflow.mjs). Fake R2; synthetic ids; nothing leaves the process.
import assert from 'node:assert/strict';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import * as S from '../src/catalog-enrichment-store.js';

const HOUR=3600000;
const T='2026-11-26T10:00:00.000Z',Tms=Date.parse(T);
const iso=ms=>new Date(ms).toISOString();
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const bucket=({failPuts=0}={})=>{const objects=new Map();let fails=failPuts;return {objects,puts:0,async put(key,body,options){this.puts++;if(fails>0){fails--;throw new Error('R2 unavailable');}if(options?.onlyIf?.etagDoesNotMatch==='*'&&objects.has(key))throw new Error('precondition failed (412)');objects.set(key,body);}};};
const counts=over=>JSON.stringify({films:3,signals:3,units:12,steps:6,statements:420,failedStatements:1,committedLive:12,committedBackground:0,yields:0,deferred:1,errors:1,disagreements:0,stop:'idle',bySource:{tmdb:{requests:3,transport:0,failed:0,cooldownSkips:0},letterboxd:{requests:2,transport:1,failed:0,cooldownSkips:1},bogus:{requests:99}},...over});
const tickRow=(over={})=>({tick_id:'ce-00000001-0',started_at:iso(Tms),finished_at:iso(Tms+60000),state:'finished',counts_json:counts(),delivery_attempts:0,...over});

// ---- the pure event ----
{
 const event=S.tickEvent(tickRow());
 assert.deepEqual([event.id,event.type,event.outcome,event.stop,event.at,event.durationMs],['ce-00000001-0','catalog_enrichment','finished','idle',iso(Tms+60000),60000]);
 assert.deepEqual(event.counts,{films:3,signals:3,units:12,steps:6,statements:420,failedStatements:1,committedLive:12,committedBackground:0,yields:0,deferred:1,errors:1,disagreements:0});
 assert.deepEqual(event.bySource,{letterboxd:{requests:2,transport:1,failed:0,cooldownSkips:1},tmdb:{requests:3,transport:0,failed:0,cooldownSkips:0}},'source-specific counts; only the known sources, no free text');
 assert.equal(event.provenance,undefined,'a run without provenance counts adds no key (the event shape is unchanged)');
 const withProv=S.tickEvent(tickRow({counts_json:counts({provenance:{fills:2,replacements:1,history:1,refusals:{language_kept:3,evil:9},leak:'film:tmdb:1'},upgradesReopened:4})}));
 assert.deepEqual([withProv.provenance.fills,withProv.provenance.replacements,withProv.provenance.history,withProv.provenance.refusals.language_kept,withProv.counts.upgradesReopened],[2,1,1,3,4],'AIR-633: per-field outcome counts and the reopened upgrades ride the event');
 assert.ok(!JSON.stringify(withProv).match(/evil|leak|film:/),'only the known count keys, whole numbers');
 assert.equal(S.tickEvent(tickRow({state:'started'})),null,'a started row is not deliverable');
 assert.equal(S.tickEvent(tickRow({finished_at:null})),null);
 assert.equal(S.tickEvent(tickRow({counts_json:'not json'})),null);
 assert.equal(S.tickEvent(tickRow({tick_id:7})),null);
 assert.equal(S.tickEvent(tickRow({counts_json:counts({stop:'DROP TABLE x'})})).stop,null,'a stop reason that is not a code is dropped');
 assert.ok(!JSON.stringify(event).match(/film:|person:|tmdb:\d|title/),'counts only: no Film id, name or payload');
 assert.equal(S.tickEventKey(event),'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-ce-00000001-0.json','the key is a pure function of the run and its end time');
}

// ---- delivery: once, idempotent, retried hourly, never starving, never deleting ----
{
 const file=migrated();
 const env=()=>({DB:d1Standin(file),BUCKET:null});
 const put=(id,over={})=>{const row=tickRow({tick_id:id,...over});sql(file,`INSERT INTO catalog_enrichment_tick (tick_id,started_at,finished_at,state,counts_json,delivery_attempts) VALUES ('${row.tick_id}','${row.started_at}',${row.finished_at?`'${row.finished_at}'`:'NULL'},'${row.state}','${row.counts_json.replace(/'/g,"''")}',${row.delivery_attempts});`);};
 put('a-1');put('b-2',{finished_at:iso(Tms+120000)});put('s-3',{state:'started',finished_at:null,counts_json:'{}'});
 const r2=bucket();const withBucket=()=>({DB:d1Standin(file),BUCKET:r2});
 assert.deepEqual(await S.deliverTicks({DB:d1Standin(file)},{nowMs:Tms+HOUR}),{taken:0,delivered:0,failed:0,conflicts:0,skipped:'bucket_unavailable'},'no bucket: nothing is attempted');
 const first=await S.deliverTicks(withBucket(),{nowMs:Tms+HOUR});
 assert.deepEqual(first,{taken:2,delivered:2,failed:0,conflicts:0});
 assert.equal(r2.objects.size,2);
 assert.deepEqual(rows(file,"SELECT tick_id,delivery_attempts,delivered_at IS NOT NULL AS d FROM catalog_enrichment_tick ORDER BY tick_id"),[{tick_id:'a-1',delivery_attempts:1,d:1},{tick_id:'b-2',delivery_attempts:1,d:1},{tick_id:'s-3',delivery_attempts:0,d:0}],'a started row is never delivered');
 assert.deepEqual(await S.deliverTicks(withBucket(),{nowMs:Tms+2*HOUR}),{taken:0,delivered:0,failed:0,conflicts:0},'a delivered row is not delivered again');
 // an existing key is delivery: a put that finds the event counts as delivered, never a duplicate
 put('c-4');
 const key=S.tickEventKey(S.tickEvent(tickRow({tick_id:'c-4'})));
 r2.objects.set(key,'{"already":true}');
 const dup=await S.deliverTicks(withBucket(),{nowMs:Tms+3*HOUR});
 assert.equal(dup.delivered,1);assert.equal(r2.objects.get(key),'{"already":true}','the existing event was not overwritten');
 // a failed put moves the row one hour back; a row that keeps failing cannot starve another
 put('d-5',{finished_at:iso(Tms+10*60000)});put('e-6',{finished_at:iso(Tms+20*60000)});
 const flaky=bucket({failPuts:2});
 const fail=await S.deliverTicks({DB:d1Standin(file),BUCKET:flaky},{nowMs:Tms+4*HOUR});
 assert.deepEqual([fail.taken,fail.failed,fail.delivered],[2,1,1],'one row failed (two tries) and the other was still delivered');
 assert.equal(rows(file,"SELECT delivery_attempts FROM catalog_enrichment_tick WHERE tick_id='d-5'")[0].delivery_attempts,1);
 const early=await S.deliverTicks(withBucket(),{nowMs:Tms+10*60000+HOUR-1});
 assert.equal(early.taken,0,'not due before one hour after its end per failed attempt');
 const retry=await S.deliverTicks(withBucket(),{nowMs:Tms+10*60000+2*HOUR});
 assert.equal(retry.delivered,1);assert.equal(rows(file,"SELECT delivered_at IS NOT NULL AS d FROM catalog_enrichment_tick WHERE tick_id='d-5'")[0].d,1);
 // the compare-and-swap: a concurrent tick that moved the counter first is a conflict, the event is still never duplicated
 put('f-7');
 const racing={DB:d1Standin(file),BUCKET:{...bucket(),async put(k,b,o){sql(file,"UPDATE catalog_enrichment_tick SET delivery_attempts=delivery_attempts+1 WHERE tick_id='f-7'");return r2.put(k,b,o);}}};
 const race=await S.deliverTicks(racing,{nowMs:Tms+9*HOUR});
 assert.equal(race.conflicts,1,'another tick moved the row first');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_tick')[0].n,7,'no row is ever deleted');
 // a missing schema is neutral
 assert.equal((await S.deliverTicks({DB:d1Standin(migrated(46)),BUCKET:r2},{nowMs:Tms})).skipped,'schema_missing');
}

console.log('catalog enrichment events: ok');
