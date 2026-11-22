// AIR-560: four exact S7 candidate prompts after AIR-573 / ADR 0195.
// Offline only: never reads or edits the live Scheduled Task registry, Worker or production state.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const sha256=text=>createHash('sha256').update(text).digest('hex');
const slots=[
  {slot:'00',s5:'c5d5591ed2e016511b5d7872e8c396b2fc195d52059bf3da342aa1d24006c71d',s7:'083230101c1d7ff099b6fea0ed570d27979191dd680393450f1ef5a75b86b367'},
  {slot:'15',s5:'b839d290bf1e244a355a9c2ca6e2b0bed805e9bdcba746b5e0028a86ca451d90',s7:'436849f75b96132add381b1b36725e0c44f8c719f840e98da2970b8bc766d35a'},
  {slot:'30',s5:'9772859346f3c4ad93e85f2dcf2964dcc6d3b07b3e6ead8904447054417f19c6',s7:'f121878f8e8411b4342e6b503f5cddeebe0b753c00d35b433bcb44062c1efe80'},
  {slot:'45',s5:'fd72c3c1e28e90fbc50c476e2c8a99efe80ad09424f3a4483c865fcc526f02e2',s7:'374a45fdcad3eb5298a3db9d2c821dcb3b373ea29fb5a17f1597e8795b09cd3b'},
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
const candidates=[];
for(const {slot,s5,s7} of slots){
  const path=`docs/reference/scheduled-task-prompts/air-560-s7-taskid-${slot}-candidate.md`;
  const md=readFileSync(path,'utf8'),text=promptBlock(md);
  const s5Meta=md.match(/Live S5 executable prompt: (\d+) JavaScript characters, (\d+) UTF-8 bytes, SHA-256 \`([0-9a-f]{64})\`/);
  const s7Meta=md.match(/S7 executable text below:\*\* (\d+) JavaScript characters, (\d+) UTF-8 bytes, SHA-256 \`([0-9a-f]{64})\`/);
  assert.ok(s5Meta&&s7Meta,'both complete identity declarations');
  assert.deepEqual([Number(s5Meta[1]),Number(s5Meta[2]),s5Meta[3]],[47027,71016,s5],`task${slot} live S5 identity`);
  assert.deepEqual([Number(s7Meta[1]),Number(s7Meta[2]),s7Meta[3]],[47027,71016,s7],`task${slot} S7 candidate identity`);
  assert.equal(text.length,47027);
  assert.equal(Buffer.byteLength(text,'utf8'),71016);
  assert.equal(sha256(text),s7,`task${slot} S7 digest`);
  assert.equal(count(text,'manifestSize=7'),3,`task${slot}: three S7 positions`);
  assert.equal(count(text,'manifestSize=5'),0,`task${slot}: no residual S5 positions`);
  assert.equal(count(text,`taskId=task${slot}`),1,'correct fixed owner label');
  assert.equal((text.match(/taskId=task(?:00|15|30|45)/g)||[]).length,1,'no other fixed task label');
  assert.ok(text.includes("prediction_batch_start({trigger:'scheduled', manifestSize, taskId})"));
  for(const tool of ['prediction_batch_manifest','prediction_heartbeat','prediction_batch_hold','prediction_batch_submit','prediction_complete'])
    assert.ok(text.includes(`${tool}({taskId,runId`),`task${slot}: ${tool} retains owner scope`);
  for(const needle of ['start_pending','manifest_pending','wrong_owner','task_args_mismatch','generationSize=1','submitBatchSize=5','3в. RESEARCH AUDIT','3г. SOURCE SELECTION GATE','matchSignals — ТОЛЬКО обоснованные положительные'])
    assert.ok(text.includes(needle),`task${slot}: retain ${needle}`);
  const restoredS5=text.replaceAll('manifestSize=7','manifestSize=5');
  assert.equal(sha256(restoredS5),s5,`task${slot} differs from live S5 only by exactly 3 manifestSize edits`);
  candidates.push(text.replace(`taskId=task${slot}`,'taskId=taskNN'));
}
for(const text of candidates.slice(1))assert.equal(text,candidates[0],'the four S7 candidates differ only in taskId');
console.log('ok AIR-560: four ADR 0195 S7 candidate prompts, exact S5-only size delta, live baseline digests');
