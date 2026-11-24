// AIR-588 (ADR 0205): four prepared, NOT installed, S7 prompts that ask batch_start for the compact ready envelope. Offline only: never reads or edits the live Scheduled Task
// registry, the Worker or production state. Each candidate is its accepted S7 source with exactly two changes: the start call sends answer:'envelope', and step 2 gains an
// `envelope` answer bullet before the unchanged (relabelled) `running` bullet.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const sha256=text=>createHash('sha256').update(text).digest('hex');
const count=(text,needle)=>text.split(needle).length-1;
const block=md=>{const start='---BEGIN PROMPT---\n',end='\n---END PROMPT---';assert.equal(count(md,start),1);assert.equal(count(md,end),1);const a=md.indexOf(start)+start.length;return md.slice(a,md.indexOf(end,a));};
const CALL_OLD="prediction_batch_start({trigger:'scheduled', manifestSize, taskId})",CALL_NEW="prediction_batch_start({trigger:'scheduled', manifestSize, taskId, answer:'envelope'})";
const RUN_OLD=' - running: сохрани runId, lease.epoch, profile, contract (schema и правила), films[], manifestHash',RUN_NEW=' - running (полный манифест, если envelope не вернулся): сохрани runId, lease.epoch, profile, contract (schema и правила), films[], manifestHash';
const slots={'00':'e9cd15c50507e759fcfbb103e43cd0ea9ba3aa5705c519e2faf0889f4b202259','15':'482d7ea3c4641ef8e3439f092d32eda03fb89ada4cba107642944b247019f0f6','30':'47dd294fa69cf081c29fb0b9956fc1ea42808334bca2c0ca3c6968a2c067d032','45':'4d0b85b76a51b039df9b45bfec427ebd27bd50f8d0e40396e70624a700937e91'};
const bullets=[];
for(const [slot,digest] of Object.entries(slots)){
 const sourceMd=readFileSync(`docs/reference/scheduled-task-prompts/air-560-s7-taskid-${slot}-candidate.md`,'utf8'),source=block(sourceMd);
 const md=readFileSync(`docs/reference/scheduled-task-prompts/air-588-s7-envelope-taskid-${slot}-candidate.md`,'utf8'),text=block(md);
 assert.match(md,/\*\*Status:\*\* PREPARED ONLY\. Not installed\./,'never presented as installed');
 const meta=md.match(/Envelope executable text below:\*\* (\d+) JavaScript characters, (\d+) UTF-8 bytes, SHA-256 `([0-9a-f]{64})`/);
 assert.ok(meta);assert.deepEqual([Number(meta[1]),Number(meta[2]),meta[3]],[text.length,Buffer.byteLength(text,'utf8'),sha256(text)],'declared identity');
 assert.equal(sha256(text),digest,'task'+slot+' envelope digest');
 assert.ok(md.includes(sha256(source)),'the source S7 digest is named for the rollback');
 // exactly the two changes
 assert.equal(count(source,CALL_OLD),1);assert.equal(count(text,CALL_OLD),0);assert.equal(count(text,CALL_NEW),1);
 assert.equal(count(text,RUN_NEW),1);assert.equal(count(text,RUN_OLD),0);
 const at=text.indexOf(' - envelope (kind=envelope'),end=text.indexOf(RUN_NEW);
 assert.ok(at>0&&end>at,'the envelope bullet sits right before the running bullet');
 const bullet=text.slice(at,end);bullets.push(bullet);
 const rebuilt=text.replace(bullet,'').replace(CALL_NEW,CALL_OLD).replace(RUN_NEW,RUN_OLD);
 assert.equal(rebuilt,source,'nothing else differs from the accepted S7 text');
 // invariants kept
 assert.equal(count(text,'manifestSize=7'),3);assert.equal(count(text,`taskId=task${slot}`),1);assert.equal((text.match(/taskId=task(?:00|15|30|45)/g)||[]).length,1);
 for(const word of ['prediction_batch_manifest({taskId,runId,part:\'profile\'})','prediction_batch_manifest({taskId,runId,part:\'contract\'})','part:\'film\',filmId','manifestHash','шага 2а','до полной сборки','heartbeat'])assert.ok(bullet.includes(word),'the envelope bullet names '+word);
}
assert.equal(new Set(bullets).size,1,'the four candidates share one envelope bullet');
console.log('AIR-588 envelope candidates: four prepared prompts, each its S7 source plus the start answer and one envelope bullet; nothing else changed');
