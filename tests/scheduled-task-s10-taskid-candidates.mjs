// AIR-560: four exact S10 candidate prompts derived from the merged S7 candidates (PR #898).
// Offline only: never reads or edits the live Scheduled Task registry, Worker or production state.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const sha256=text=>createHash('sha256').update(text).digest('hex');
const slots=[
  {slot:'00',s7:'083230101c1d7ff099b6fea0ed570d27979191dd680393450f1ef5a75b86b367',s10:'38a4aa720361f5128a9a1dc4c7619cbbae0a3624a12f6e99241cd73bfa5e3f7f'},
  {slot:'15',s7:'436849f75b96132add381b1b36725e0c44f8c719f840e98da2970b8bc766d35a',s10:'8e4f7052ff5369774a40be2f0d7f5119f8febbfc8f93c152a33ec82968dd1976'},
  {slot:'30',s7:'f121878f8e8411b4342e6b503f5cddeebe0b753c00d35b433bcb44062c1efe80',s10:'4fa2d44c0032f7567281f597a17cb2e2774fbbb4d86f2633ec90432d6838762a'},
  {slot:'45',s7:'374a45fdcad3eb5298a3db9d2c821dcb3b373ea29fb5a17f1597e8795b09cd3b',s10:'ef399ec9021691eeacc2bbcf5451e77ec6d0cddd87c4a5bc77aa98369a2b318f'},
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
const candidates=[];
for(const {slot,s7,s10} of slots){
  const base=promptBlock(readFileSync(`${dir}/air-560-s7-taskid-${slot}-candidate.md`,'utf8'));
  assert.equal(sha256(base),s7,`task${slot} S7 source digest`);
  const md=readFileSync(`${dir}/air-560-s10-taskid-${slot}-candidate.md`,'utf8'),text=promptBlock(md);
  const s7Meta=md.match(/Verified S7 baseline:\*\*.*?: (\d+) JavaScript characters, (\d+) UTF-8 bytes, SHA-256 `([0-9a-f]{64})`/);
  const s10Meta=md.match(/S10 executable text below:\*\* (\d+) JavaScript characters, (\d+) UTF-8 bytes, SHA-256 `([0-9a-f]{64})`/);
  assert.ok(s7Meta&&s10Meta,'both complete identity declarations');
  assert.deepEqual([Number(s7Meta[1]),Number(s7Meta[2]),s7Meta[3]],[47027,71016,s7],`task${slot} S7 declared identity`);
  assert.deepEqual([Number(s10Meta[1]),Number(s10Meta[2]),s10Meta[3]],[47030,71019,s10],`task${slot} S10 declared identity`);
  assert.equal(text.length,47030);
  assert.equal(Buffer.byteLength(text,'utf8'),71019);
  assert.equal(sha256(text),s10,`task${slot} S10 digest`);
  assert.equal(count(base,'manifestSize=7'),3);
  assert.equal(count(text,'manifestSize=10'),3,`task${slot}: three S10 positions`);
  assert.equal(count(text,'manifestSize=7'),0,`task${slot}: no residual S7 positions`);
  assert.equal(count(text,'manifestSize=5'),0,`task${slot}: no residual S5 positions`);
  assert.equal(text.replaceAll('manifestSize=10','manifestSize=7'),base,`task${slot} differs from verified S7 only by exactly 3 manifestSize edits`);
  assert.equal(count(text,`taskId=task${slot}`),1,'correct fixed owner label');
  assert.equal((text.match(/taskId=task(?:00|15|30|45)/g)||[]).length,1,'no other fixed task label');
  assert.ok(text.includes("prediction_batch_start({trigger:'scheduled', manifestSize, taskId})"));
  for(const tool of ['prediction_batch_manifest','prediction_heartbeat','prediction_batch_hold','prediction_batch_submit','prediction_complete'])
    assert.ok(text.includes(`${tool}({taskId,runId`),`task${slot}: ${tool} retains owner scope`);
  for(const needle of ['start_pending','manifest_pending','wrong_owner','task_args_mismatch','generationSize=1','submitBatchSize=5','3в. RESEARCH AUDIT','3г. SOURCE SELECTION GATE','matchSignals — ТОЛЬКО обоснованные положительные'])
    assert.ok(text.includes(needle),`task${slot}: retain ${needle}`);
  candidates.push(text.replace(`taskId=task${slot}`,'taskId=taskNN'));
}
for(const text of candidates.slice(1))assert.equal(text,candidates[0],'the four S10 candidates differ only in taskId');
assert.equal(new Set(slots.map(s=>s.s10)).size,4,'four distinct digests');
console.log('ok AIR-560: four S10 candidate prompts, exact S7-only size delta, verified S7 source digests');
