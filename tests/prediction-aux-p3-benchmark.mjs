// The identity guard of the scratch-only P3 benchmark harness (scripts/prediction-aux-p3-benchmark.mjs): it can never be pointed at production. Offline, no network.
import assert from 'node:assert/strict';
import {scratchTarget,summary,recordingFetch,NAME_PREFIX} from '../scripts/prediction-aux-p3-benchmark.mjs';
const env={D1_BACKFILL_ACCOUNT_ID:'0123456789abcdef0123456789abcdef',D1_BACKFILL_API_TOKEN:'token-value',D1_BACKFILL_DATABASE_ID:'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',D1_BACKFILL_ENDPOINT:'https://example.invalid'};
const ID='82c01d85-494d-4262-b700-335f721a78ec',NAME=NAME_PREFIX+'20261123';
const ok=scratchTarget(env,{databaseId:ID,databaseName:NAME});
assert.equal(ok.endpoint,'https://api.cloudflare.com/client/v4','the endpoint override and the production database id of the environment are ignored');
for(const [label,args] of [
 ['the production id',{databaseId:'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',databaseName:NAME}],
 ['the production name',{databaseId:ID,databaseName:'iptv'}],
 ['a name outside the prefix',{databaseId:ID,databaseName:'iptv-other-20261123'}],
 ['a malformed id',{databaseId:'not-a-uuid',databaseName:NAME}],
 ['a missing id',{databaseName:NAME}],
])assert.throws(()=>scratchTarget(env,args),Error,label);
assert.throws(()=>scratchTarget({},{databaseId:ID,databaseName:NAME}),/required/,'no credential, no target');
assert.deepEqual(summary([3,1,2,10,5,4]),{n:6,min:1,median:3,p95:10,max:10,sum:25});
// the recording fetch passes the response through untouched and records size, status and D1's own meta
const log=[];
const fake=async()=>new Response(JSON.stringify({success:true,result:[{success:true,meta:{duration:2.5,rows_read:3,rows_written:4,changes:1,size_after:99,served_by_region:'WEUR',served_by_primary:true}}]}),{status:200});
const response=await recordingFetch(fake,log,()=>'p')('https://x/query',{method:'POST',body:JSON.stringify({batch:[{sql:'SELECT 1;'}]})});
assert.equal((await response.json()).success,true);
assert.equal(log.length,1);assert.equal(log[0].phase,'p');assert.equal(log[0].statements,1);assert.equal(log[0].rowsWritten,4);assert.equal(log[0].d1DurationMs,2.5);assert.equal(log[0].allSuccess,true);
console.log('prediction aux P3 benchmark guard: ok');
