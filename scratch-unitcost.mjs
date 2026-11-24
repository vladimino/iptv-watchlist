import fs from 'node:fs';import os from 'os';import path from 'node:path';import assert from 'node:assert/strict';
import {d1Standin} from './tests/d1-standin.mjs';import {sqliteSync} from './tests/sqlite-session.mjs';
import {acquireSealedSnapshot} from './src/canonical-producer-workflow.js';
import {runEpgProducerPass} from './src/canonical-producer-driver.js';
import {applyEpgUnits} from './src/canonical-epg-producer.js';import {applyEpgPersonUnits} from './src/canonical-epg-person-producer.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'uc-'));const file=path.join(root,'u.sqlite');
const sqlite=(f,t)=>sqliteSync(['-bail',f],{input:'PRAGMA foreign_keys=ON;\n'+t,encoding:'utf8',maxBuffer:1<<28});
assert.equal(sqlite(file,fs.readdirSync('migrations').filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort().map(n=>fs.readFileSync('migrations/'+n,'utf8')).join('\n')).status,0);
const AT='2026-11-16T10:00:00.000Z',empty='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const films=[];for(let i=1;i<=60;i++){const n=[0,1,3,8,20,40][i%6];films.push({id:'tmdb_'+i,title:'F'+i,year:2000,directors:Array.from({length:1+(i%3)},(_,d)=>({id:'director/d'+i+'_'+d,name:'D'})),actors:Array.from({length:n},(_,c)=>({id:'actor/a'+(i*100+c),name:'A'}))});}
const doc=JSON.stringify({films}).replace(/'/g,"''");
assert.equal(sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='run-p',generation=10 WHERE id=1;INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+AT+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+empty+"','"+empty+"','"+AT+"');INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-p','published','"+AT+"','"+'5'.repeat(64)+"','"+AT+"');INSERT INTO published_epg_document (programme_run_id,kind,ordinal,payload_json) VALUES ('run-p','programme',0,'{\"films\":[]}'),('run-p','watchlist',0,'"+doc+"');INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES "+films.map((f,i)=>"('run-p','watchlist',"+i+",'"+f.id+"')").join(',')).status,0);
const meter={st:0};const base={DB:d1Standin(file)};
const env=new Proxy(base,{get(t,p){if(p!=='DB')return Reflect.get(t,p,t);const d=t.DB;return new Proxy(d,{get(o,q){if(q==='prepare')return s=>{meter.st++;return o.prepare(s);};const v=Reflect.get(o,q,o);return typeof v==='function'?v.bind(o):v;}});}});
const snap=await acquireSealedSnapshot(env,'run-p');
const stats={};
const wrap=(kind,fn)=>async(e,args)=>{const b=meter.st;const r=await fn(e,args);const u=args.plan.units[0];const k=u.kind||kind;const size=JSON.stringify(u.input||{}).length;(stats[k]??=[]).push([meter.st-b,size, u.input?.credits?.length??u.input?.cast?.length??null]);return r;};
for(let pass=0;pass<2;pass++){
const r=await runEpgProducerPass(env,{runId:snap.label+(pass?'b':''),sourceGeneration:snap.label,at:AT,films:snap.films,departed:snap.departed,persons:snap.persons,credits:snap.credits,personRows:snap.personRows,sliceSize:50,maxSlicesPerRun:20,sliceDeadlineMs:270000,prerequisites:async()=>({}),generationOrder:()=>-1,inputProvenance:{complete:true,committed:true,sealed:true,publishedGeneration:snap.label},appliers:{film:wrap('film_facts',applyEpgUnits),person:wrap('person',applyEpgPersonUnits)}});
console.log('pass',pass,r.state,r.reason||r.code,r.counts);
for(const [k,v] of Object.entries(stats)){v.sort((a,b)=>b[0]-a[0]);console.log(pass,k,'n',v.length,'max',v[0],'min',v.at(-1)[0],'top5',v.slice(0,5).map(x=>x[0]+'@'+x[1]).join(' '));}
for(const k in stats)delete stats[k];
}
