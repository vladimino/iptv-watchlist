// AIR-579: the rows an observation key holds in the published run are read at its own slot coordinates, not by walking the run.
// Local sqlite only. Nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-held-slot-'));
const file=path.join(root,'a.sqlite');
const run=(args,input)=>{const result=sqliteSync(args,{input,encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);return result.stdout;};
const rows=text=>{const out=run(['-json','-bail',file],text+';').trim();return out?JSON.parse(out):[];};
// The production table and its only index come from the real migration (0008), so a plan here is the plan of the deployed schema.
const migration=fs.readFileSync('migrations/0008_published_epg_authority.sql','utf8');
const show=migration.match(/CREATE TABLE published_epg_show \([\s\S]*?\) STRICT;/)[0]+'\n'+migration.match(/CREATE INDEX published_epg_show_by_generation[^;]*;/)[0];
run(['-bail',file],show);

const RUN='run-held',MIN=60000,START=Date.parse('2026-11-22T12:00:00Z');
const inserts=[];
// A run of 20,000 rows: 3,000 keys on 400 channels, every start time distinct, so the old statement had to walk all of them.
for(let i=0;i<20000;i++)inserts.push(`('${RUN}','film${i%3000}','ch${i%400}',${START+i*MIN},0,'c',NULL,'discovery','obs${i%3000}')`);
// Adversarial rows at the very coordinates of key obs5: another run, another basis, another key on the same start time, another film for the same key.
const own=[...Array(7).keys()].map(n=>5+n*3000);                       // the seven rows key obs5 really holds
const at=index=>({channelId:'ch'+(index%400),startMs:START+index*MIN});
inserts.push(`('other-run','film5','ch5',${START+5*MIN},0,'c',NULL,'discovery','obs5')`);
inserts.push(`('${RUN}','filmP','chZ',${START+5*MIN},0,'c',NULL,'programme','obs5')`);
inserts.push(`('${RUN}','filmQ','chZ',${START+5*MIN},0,'c',NULL,'discovery','obs-other')`);
inserts.push(`('${RUN}','film5-alt','chY',${START+3005*MIN},0,'c',NULL,'discovery','obs5')`);
for(let at0=0;at0<inserts.length;at0+=500)run(['-bail',file],'INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason) VALUES '+inserts.slice(at0,at0+500).join(',')+';');

const FORMER="SELECT channel_id, start_ms, film_id FROM published_epg_show WHERE programme_run_id='"+RUN+"' AND basis='discovery' AND match_reason='obs5'";
const former=slots=>{
 const map=new Map(rows(FORMER).map(item=>[item.channel_id+':'+item.start_ms,item.film_id]));
 return new Map(slots.map(slot=>slot.channelId+':'+slot.startMs).filter(key=>map.has(key)).map(key=>[key,map.get(key)]));
};
const statements=[];
const db=d1Standin(file,{maxBinds:100,onQuery:async text=>{statements.push(text);}});

// Parity: the new read returns, for the slots a caller looks up, exactly what the former statement returned.
const slots=[...own.map(at),{channelId:'ch9',startMs:START+9*MIN},{channelId:'chZ',startMs:START+5*MIN},{channelId:'chY',startMs:START+3005*MIN}];
const held=await Authority.heldSlotRows(db,RUN,'obs5',slots);
for(const slot of slots){
 const key=slot.channelId+':'+slot.startMs;
 assert.equal(held.get(key),former(slots).get(key),'the same holder as the former statement at '+key);
}
assert.equal(held.get('ch5:'+(START+5*MIN)),'film5');
assert.equal(held.get('chY:'+(START+3005*MIN)),'film5-alt','a different film that holds the key is still reported (the caller compares it)');
assert.equal(held.has('chZ:'+(START+5*MIN)),false,'another basis or another key on the same start time is never reported');
assert.equal(held.has('ch9:'+(START+9*MIN)),false,'a slot nobody holds is absent');
assert.equal(statements.length,1,'one statement for the slots of the observation');
assert.match(statements[0],/start_ms IN \(/);
assert.doesNotMatch(statements[0],/match_reason='obs5'\s*$/,'the unbounded former shape must not come back');

// The statement is bounded by the bind cap: 250 distinct start times need three statements, none above 100 binds (the stand-in refuses more).
statements.length=0;
const many=[...Array(250).keys()].map(index=>at(index*7));
const manyHeld=await Authority.heldSlotRows(db,RUN,'obs5',many);
assert.equal(statements.length,3);
assert.ok([...manyHeld.keys()].every(key=>manyHeld.get(key)==='film5'||manyHeld.get(key)==='film5-alt'));

// No slots, no round trip.
statements.length=0;
assert.equal((await Authority.heldSlotRows(db,RUN,'obs5',[])).size,0);
assert.equal(statements.length,0);

// Plan and cost on the deployed schema: the existing index is searched by run and start time; the former statement could only search by run.
const plan=text=>run(['-bail',file],'EXPLAIN QUERY PLAN '+text+';').replace(/\s+/g,' ');
assert.match(plan("SELECT channel_id, start_ms, film_id FROM published_epg_show WHERE programme_run_id='"+RUN+"' AND basis='discovery' AND match_reason='obs5' AND start_ms IN (1,2,3)"),/published_epg_show_by_generation \(programme_run_id=\? AND start_ms=\?\)/);
assert.match(plan(FORMER),/published_epg_show_by_generation \(programme_run_id=\?\)(?! AND)/);
const steps=text=>{const result=sqliteSync([file],{input:'.stats vmstep\n'+text+';\n',encoding:'utf8',maxBuffer:1<<28});return Number(/VM-steps: (\d+)/.exec(String(result.stdout)+String(result.stderr))?.[1]);};
const newText="SELECT channel_id, start_ms, film_id FROM published_epg_show WHERE programme_run_id='"+RUN+"' AND basis='discovery' AND match_reason='obs5' AND start_ms IN ("+own.map(index=>START+index*MIN).join(',')+")";
const formerSteps=steps(FORMER),newSteps=steps(newText);
console.log(JSON.stringify({run_rows:20000,slots:own.length,formerVmSteps:formerSteps,newVmSteps:newSteps}));
assert.ok(Number.isFinite(formerSteps)&&Number.isFinite(newSteps));
assert.ok(newSteps*100<formerSteps,'the coordinate read is at least 100 times cheaper in VM steps ('+newSteps+' against '+formerSteps+')');
fs.rmSync(root,{recursive:true,force:true});
console.log('discovery held slot read ok');
