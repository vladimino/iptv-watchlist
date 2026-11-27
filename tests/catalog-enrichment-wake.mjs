// AIR-605 / ADR 0219: the causal postcommit wake. A canonical commit that touched a trigger-bearing table kicks the producer AFTER the batch, only when work is runnable;
// a rolled-back batch, an unrelated write, an absent runner or a failing wake changes nothing. Dormant by construction: no runner global means no call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {mutateFilm} from '../src/canonical-mutations.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-enrichment-wake-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const base=path.join(root,'tpl.sqlite');
const run=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);};
run(base,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
run(base,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
let n=0;
const fresh=()=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(base,file);return {file,env:{DB:d1Standin(file)}};};
const T='2026-11-11T10:00:00.000Z';
const film=(id,tmdb)=>({id,expectedRevision:0,at:T,film:{contractVersion:1,externalIds:[{scheme:'tmdb',value:tmdb,trusted:true}],aliases:[]}});
const calls=[];
const install=(runnable,{kickThrows=false}={})=>{globalThis.CatalogEnrichmentRunner={hasRunnable:async()=>{calls.push('has');return runnable;},kick:async()=>{calls.push('kick');if(kickThrows)throw new Error('boom');return {kicked:true};}};};

// 1. dormant: no runner global, the writer commits and nothing is called
{delete globalThis.CatalogEnrichmentRunner;const {env}=fresh();await mutateFilm(env,film('film:tmdb:1','1'));assert.deepEqual(calls,[]);}
// 2. runnable work after an identity commit starts the producer exactly once, after the commit
{install(true);calls.length=0;const {file,env}=fresh();await mutateFilm(env,film('film:tmdb:2','2'));assert.deepEqual(calls,['has','kick']);
 const r=sqliteSync(['-json',file],{input:"SELECT COUNT(*) AS c FROM film WHERE id='film:tmdb:2';",encoding:'utf8'});assert.equal(JSON.parse(r.stdout)[0].c,1);}
// 3. nothing runnable: no kick
{install(false);calls.length=0;const {env}=fresh();await mutateFilm(env,film('film:tmdb:3','3'));assert.deepEqual(calls,['has']);}
// 4. a failing wake never fails the committed write
{install(true,{kickThrows:true});calls.length=0;const {file,env}=fresh();await mutateFilm(env,film('film:tmdb:4','4'));assert.deepEqual(calls,['has','kick']);
 const r=sqliteSync(['-json',file],{input:"SELECT COUNT(*) AS c FROM film WHERE id='film:tmdb:4';",encoding:'utf8'});assert.equal(JSON.parse(r.stdout)[0].c,1);}
// 5. a rolled-back batch (stale expected revision) never wakes
{install(true);calls.length=0;const {env}=fresh();await mutateFilm(env,film('film:tmdb:5','5'));calls.length=0;
 await assert.rejects(mutateFilm(env,film('film:tmdb:5','5')));assert.deepEqual(calls,[]);}
delete globalThis.CatalogEnrichmentRunner;
console.log('catalog-enrichment-wake ok');
