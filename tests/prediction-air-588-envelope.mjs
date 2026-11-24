// AIR-588 (C, ADR 0205): the compact ready envelope of a real synchronous batch_start (`answer: envelope`) over the SAME stored manifest and parts. Offline: the real Worker and MCP
// over a sqlite D1 stand-in and an in-memory R2. No production call, no Scheduled Task, no model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const world=async(films=20)=>{
 const w=await flowWorld({films});const r=await w.api('queue/reconcile',{});assert.equal(r.status,200);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.tool=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 return w;
};
const start=(w,taskId,extra={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:7,taskId,...extra});
const part=async(w,taskId,runId,name,filmId)=>{const r=await w.tool('prediction_batch_manifest',{taskId,runId,part:name,...(filmId?{filmId}:{})});assert.equal(r.isError,undefined,JSON.stringify(r).slice(0,300));return JSON.parse(r.content[0].text);};
// What a Task does with an envelope: read profile, contract and every film part, check each against the envelope's identity, assemble the manifest in envelope order.
const assemble=async(w,taskId,envelope)=>{
 const profile=await part(w,taskId,envelope.runId,'profile'),contract=await part(w,taskId,envelope.runId,'contract');
 const films=[];for(const p of envelope.parts.filter(p=>p.kind==='film')){const f=await part(w,taskId,envelope.runId,'film',p.filmId);assert.equal(f.manifestHash,envelope.manifestHash);assert.equal(f.film.filmId,p.filmId);films.push(f.film);}
 for(const p of [profile,contract]){assert.equal(p.runId,envelope.runId);assert.equal(p.manifestHash,envelope.manifestHash);}
 // requestId and delivery are the transport fields every HTTP answer of a run step carries (a full start answer too); they are not part of the stored manifest.
 const {kind,parts,answer,read,requestId,delivery,...rest}=envelope;void kind;void parts;void answer;void read;void requestId;void delivery;
 return {...rest,profile:profile.profile,contract:contract.contract,films};
};

// 1. A Task start asking for the envelope: compact, ready, identical identity; the full manifest reassembled from the parts equals the stored start answer, byte for byte.
{
 const w=await world();
 const r=await start(w,'task00',{answer:'envelope'});
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
 const e=r.data;
 assert.equal(e.kind,'envelope');assert.equal(e.answer,'envelope');assert.equal(e.status,'running');assert.equal(e.protocol,'batch_v2');
 assert.ok(e.runId&&Number.isInteger(e.lease?.epoch)&&e.manifestHash&&e.limits,'run id, lease epoch, hash and limits');
 assert.ok(!('films' in e)&&!('profile' in e)&&!('contract' in e),'no payload in the envelope');
 assert.deepEqual(e.parts.map(p=>p.kind),['profile','contract',...Array(7).fill('film')]);assert.equal(e.filmsSelected,7);
 assert.deepEqual(e.read,{tool:'prediction_batch_manifest',parts:['profile','contract','film']});
 const stored=w.records.get('enrichment/batch-manifest/'+e.runId+'.json');assert.ok(stored,'the manifest was stored before the envelope was answered');
 assert.equal(e.manifestHash,stored.manifestHash);
 const assembled=await assemble(w,'task00',e);
 assert.deepEqual(assembled,stored,'full manifest parity: the assembled parts are the stored start answer, field for field');
 // sizes: the envelope is a small fraction of the manifest; every part is bounded by the manifest
 const full=bytes(stored),env=bytes(e);
 assert.ok(env*3<full,'envelope '+env+' B vs manifest '+full+' B');
 for(const name of ['profile','contract'])assert.ok(bytes(await part(w,'task00',e.runId,name))<=full);
 console.log('S7 sizes (offline fixture): manifest',full,'B, envelope',env,'B, largest film part',Math.max(...await Promise.all(e.parts.filter(p=>p.kind==='film').map(async p=>bytes(await part(w,'task00',e.runId,'film',p.filmId))))),'B');
 // the timing line records the delivered size beside the manifest size
 const line=w.logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_step_timing'&&l.step==='batch_start').at(-1);
 assert.equal(line.notes.envelopeAnswer,1);assert.equal(line.notes.manifestBytes,full);assert.ok(line.notes.answerBytes<line.notes.manifestBytes);
 // 2. A repeat of the same Task: envelope again (same identity, no new run); full on request; the run, epoch and hash never change.
 const bare=d=>{const {requestId,delivery,...rest}=d;void requestId;void delivery;return rest;};
 const again=await start(w,'task00',{answer:'envelope'});assert.deepEqual(bare(again.data),bare(e),'the same envelope');
 const asFull=await start(w,'task00');assert.equal(asFull.data.runId,e.runId);assert.deepEqual(bare(asFull.data),stored,'a full repeat is the stored manifest');
 assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n,1,'one run');
 // 3. Submit after the assembly: the run accepts the parts' films under the same runId and epoch.
 const film=assembled.films[0];
 const sub=await w.api('batch/submit',{taskId:'task00',runId:e.runId,epoch:e.lease.epoch,items:[{filmId:film.filmId,...(film.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}]});
 assert.equal(sub.status,200,JSON.stringify(sub.data).slice(0,300));assert.deepEqual(sub.data.results.map(x=>x.status),['created']);
 // a foreign Task cannot read the parts
 const foreign=await w.tool('prediction_batch_manifest',{taskId:'task15',runId:e.runId,part:'profile'});assert.equal(foreign.isError,true);assert.match(JSON.stringify(foreign),/wrong_owner/);
}

// 4. Backward compatibility: no `answer` (every installed prompt) and `answer: full` are the whole manifest, unchanged.
{
 const w=await world();const r=await start(w,'task00');
 assert.equal(r.data.status,'running');assert.ok(Array.isArray(r.data.films)&&r.data.profile&&r.data.contract,'the full manifest');assert.ok(!('answer' in r.data)&&!('kind' in r.data));
 const w2=await world();const r2=await start(w2,'task00',{answer:'full'});assert.deepEqual(Object.keys(r2.data),Object.keys(r.data),'answer full is the default shape');
}

// 5. Validation: an unknown answer; the envelope with a dry run (nothing stored) or a deferred start (a receipt): refused before anything is written.
{
 const w=await world();
 for(const [extra,code] of [[{answer:'parts'},'invalid_answer'],[{answer:'envelope',dryRun:true},'envelope_needs_stored_manifest'],[{answer:'envelope',deferred:true,invocationKey:'dk1.'+'a'.repeat(32)},'envelope_needs_stored_manifest']]){
  const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:7,...extra});
  assert.equal(r.status,400,JSON.stringify(extra));assert.equal(r.data.code,code);
 }
 assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_run')[0].n,0);assert.equal(sql(w.file,"SELECT count(*) AS n FROM prediction_lease WHERE name='runner' AND expires_at>"+Date.now())[0].n,0,'no lease');
}

// 6. The envelope does not grow with the films' payload: the same S7 start on a catalog with ten times the metadata per film keeps an envelope of the same size.
{
 const big=await flowWorld({films:20,extra:n=>({synopsis:'x'.repeat(4000),actors:Array.from({length:30},(_,i)=>({id:'a'+n+'_'+i,name:'Actor '+i}))})});assert.equal((await big.api('queue/reconcile',{})).status,200);
 const small=await world();
 const a=(await start(small,'task00',{answer:'envelope'})).data,b=(await big.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:7,taskId:'task00',answer:'envelope'})).data;
 const stored=big.records.get('enrichment/batch-manifest/'+b.runId+'.json');
 assert.ok(Math.abs(bytes(a)-bytes(b))<200,'envelope '+bytes(a)+' vs '+bytes(b)+' B');assert.ok(bytes(stored)>bytes(a)*5,'while the manifest grew: '+bytes(stored)+' B');
}

// 7. Through the MCP tool: `answer` is forwarded, the envelope is one text copy (no structuredContent), and an invalid value is refused by the schema check of the Worker.
{
 const w=await world();
 const r=await w.tool('prediction_batch_start',{trigger:'scheduled',taskId:'task30',manifestSize:7,answer:'envelope'});
 assert.equal(r.isError,undefined,JSON.stringify(r).slice(0,300));assert.ok(!('structuredContent' in r),'one copy');
 const e=JSON.parse(r.content[0].text);assert.equal(e.kind,'envelope');assert.equal(e.answer,'envelope');assert.equal(e.parts.length,9);
 const bad=await w.tool('prediction_batch_start',{trigger:'scheduled',taskId:'task30',manifestSize:7,answer:'envelope',dryRun:true});assert.equal(bad.isError,true);assert.match(JSON.stringify(bad),/envelope_needs_stored_manifest/);
}
console.log('AIR-588 C: compact ready envelope over the stored manifest; parity, submit, repeat, compatibility, validation, size and MCP checked');
