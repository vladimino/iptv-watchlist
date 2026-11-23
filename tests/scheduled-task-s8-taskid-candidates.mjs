// AIR-560: four exact S8 candidate prompts derived from the merged S7 (PR #898) and S10 (PR #940) candidates.
// Offline only: never reads or edits the live Scheduled Task registry, Worker or production state.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const sha256=text=>createHash('sha256').update(text).digest('hex');
const slots=[
  {slot:'00',s7:'083230101c1d7ff099b6fea0ed570d27979191dd680393450f1ef5a75b86b367',s10:'38a4aa720361f5128a9a1dc4c7619cbbae0a3624a12f6e99241cd73bfa5e3f7f',s8:'503835a7e3aebd4384f3a989a034889337fdbe45292564bd58727152a8535eba'},
  {slot:'15',s7:'436849f75b96132add381b1b36725e0c44f8c719f840e98da2970b8bc766d35a',s10:'8e4f7052ff5369774a40be2f0d7f5119f8febbfc8f93c152a33ec82968dd1976',s8:'c8ede60548d40173d2a3050559bd2a293de8e5d0158ebb24282a8acc89649944'},
  {slot:'30',s7:'f121878f8e8411b4342e6b503f5cddeebe0b753c00d35b433bcb44062c1efe80',s10:'4fa2d44c0032f7567281f597a17cb2e2774fbbb4d86f2633ec90432d6838762a',s8:'7731e484bde689354ea2660bf391c021d52de3cd6ab10bc8f6fc66fd25f16543'},
  {slot:'45',s7:'374a45fdcad3eb5298a3db9d2c821dcb3b373ea29fb5a17f1597e8795b09cd3b',s10:'ef399ec9021691eeacc2bbcf5451e77ec6d0cddd87c4a5bc77aa98369a2b318f',s8:'6c868e181320d4adc9ba9688c0782560e789b053ba3f88cf1111f26025588e52'},
];
const count=(text,needle)=>text.split(needle).length-1;
const promptBlock=md=>{
  const start='---BEGIN PROMPT---\n',end='\n---END PROMPT---';
  assert.equal(count(md,start),1,'exactly one start marker');
  assert.equal(count(md,end),1,'exactly one end marker');
  const a=md.indexOf(start)+start.length,b=md.indexOf(end,a);
  assert.ok(b>a,'a complete executable prompt is present');
  return md.slice(a,b);
};
const dir='docs/reference/scheduled-task-prompts';
const read=(n,slot)=>readFileSync(`${dir}/air-560-${n}-taskid-${slot}-candidate.md`,'utf8');
const candidates=[];
for(const {slot,s7,s10,s8} of slots){
  const base7=promptBlock(read('s7',slot)),base10=promptBlock(read('s10',slot));
  assert.equal(sha256(base7),s7,`task${slot} S7 source digest`);
  assert.equal(sha256(base10),s10,`task${slot} S10 source digest`);
  const md=read('s8',slot),text=promptBlock(md);
  const m=re=>{const r=md.match(re);assert.ok(r,`task${slot}: declaration ${re}`);return [Number(r[1]),Number(r[2]),r[3]];};
  assert.deepEqual(m(/S7 baseline, .*?: (\d+) JavaScript characters, (\d+) UTF-8 bytes, SHA-256 `([0-9a-f]{64})`/),[47027,71016,s7],`task${slot} S7 declared`);
  assert.deepEqual(m(/S10 baseline, .*?: (\d+) JavaScript characters, (\d+) UTF-8 bytes, SHA-256 `([0-9a-f]{64})`/),[47030,71019,s10],`task${slot} S10 declared`);
  assert.deepEqual(m(/S8 executable text below:\*\* (\d+) JavaScript characters, (\d+) UTF-8 bytes, SHA-256 `([0-9a-f]{64})`/),[47027,71016,s8],`task${slot} S8 declared`);
  assert.equal(text.length,47027);
  assert.equal(Buffer.byteLength(text,'utf8'),71016);
  assert.equal(sha256(text),s8,`task${slot} S8 digest`);
  assert.equal(count(base7,'manifestSize=7'),3);
  assert.equal(count(base10,'manifestSize=10'),3);
  assert.equal(count(text,'manifestSize=8'),3,`task${slot}: three S8 positions`);
  for(const n of ['5','7','10'])assert.equal(count(text,`manifestSize=${n}`),0,`task${slot}: no residual manifestSize=${n}`);
  assert.equal(text.replaceAll('manifestSize=8','manifestSize=7'),base7,`task${slot} differs from S7 only by exactly 3 manifestSize edits`);
  assert.equal(text.replaceAll('manifestSize=8','manifestSize=10'),base10,`task${slot} differs from S10 only by exactly 3 manifestSize edits`);
  assert.equal(count(text,`taskId=task${slot}`),1,'correct fixed owner label');
  assert.equal((text.match(/taskId=task(?:00|15|30|45)/g)||[]).length,1,'no other fixed task label');
  assert.ok(text.includes("prediction_batch_start({trigger:'scheduled', manifestSize, taskId})"));
  for(const tool of ['prediction_batch_manifest','prediction_heartbeat','prediction_batch_hold','prediction_batch_submit','prediction_complete'])
    assert.ok(text.includes(`${tool}({taskId,runId`),`task${slot}: ${tool} retains owner scope`);
  for(const needle of ['start_pending','manifest_pending','wrong_owner','task_args_mismatch','generationSize=1','submitBatchSize=5','3в. RESEARCH AUDIT','3г. SOURCE SELECTION GATE','matchSignals — ТОЛЬКО обоснованные положительные'])
    assert.ok(text.includes(needle),`task${slot}: retain ${needle}`);
  candidates.push(text.replace(`taskId=task${slot}`,'taskId=taskNN'));
}
for(const text of candidates.slice(1))assert.equal(text,candidates[0],'the four S8 candidates differ only in taskId');
assert.equal(new Set(slots.map(s=>s.s8)).size,4,'four distinct digests');
console.log('ok AIR-560: four S8 candidate prompts, exact S7 and S10 three-edit deltas, verified source digests');
