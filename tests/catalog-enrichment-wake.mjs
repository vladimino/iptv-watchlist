// AIR-605 / ADR 0219: the causal postcommit wake. A canonical commit that touched a trigger-bearing table kicks the producer AFTER the batch, only when work is runnable;
// a rolled-back batch, an unrelated write, an absent runner or a failing wake changes nothing. Dormant by construction: no runner global means no call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {mutateFilm,mergeFilms} from '../src/canonical-mutations.js';
import {admitRatedFilm} from '../src/film-admission.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-enrichment-wake-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const base=path.join(root,'tpl.sqlite');
const run=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);};
run(base,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
run(base,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
run(base,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');");
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

// 6. the REAL rated-admission writer (film_rated_admission through admitRatedFilm) wakes the producer, with a preexisting anchor
{install(true);calls.length=0;const {file,env}=fresh();
 await mutateFilm(env,film('film:tmdb:604','604'));calls.length=0;
 const out=await admitRatedFilm(env,{receiptKey:'tmdb_604',receipt:{tmdb:'604',sourceCode:'sc604',archiveSha256:'a'.repeat(64),title:'Film 604',year:2001,verifiedAt:T},expectedRevision:1,at:T,requestId:'req-rated'});
 assert.equal(out.admitted,true);
 assert.deepEqual(calls,['has','kick'],'the real admission writer reaches the wake');
 const r=sqliteSync(['-json',file],{input:"SELECT COUNT(*) AS c FROM film_rated_admission WHERE tmdb='604';",encoding:'utf8'});assert.equal(JSON.parse(r.stdout)[0].c,1);}
// 7. a merge transfers the retained membership to the survivor in the same batch (both tables reference the Film), and wakes
{install(true);calls.length=0;const {file,env}=fresh();
 await mutateFilm(env,film('film:tmdb:701','701'));await mutateFilm(env,film('film:tmdb:702','702'));
 run(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'${T}');INSERT INTO catalog_enrichment_member VALUES ('film:tmdb:701','rated','${T}','k701');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,due_since,updated_at,plan_epoch) VALUES ('film:tmdb:701','film','*',0,'active','check_anchors','${T}','${T}',0),('film:tmdb:701','core','tmdb',0,'due',NULL,'${T}','${T}',0);`);
 calls.length=0;
 await mergeFilms(env,{from:'film:tmdb:701',to:'film:tmdb:702',expected:{from:1,to:1},at:T,evidence:{verified:true}});
 const q=text=>JSON.parse(sqliteSync(['-json',file],{input:text+';',encoding:'utf8'}).stdout);
 assert.deepEqual(q("SELECT film_id,scope FROM catalog_enrichment_member"),[{film_id:'film:tmdb:702',scope:'rated'}],'the membership moved to the survivor');
 assert.deepEqual(q("SELECT film_id,part FROM catalog_enrichment_state ORDER BY 1,2"),[{film_id:'film:tmdb:702',part:'film'}],'the retired Film\'s state rows are gone and the survivor starts at check_anchors');
 assert.equal(q("SELECT COUNT(*) AS c FROM film WHERE id='film:tmdb:701'")[0].c,0,'the merge committed');
 assert.deepEqual(calls,['has','kick'],'the merge wakes the producer');}
// 8. an UNCERTAIN outcome (committed, answer lost) still wakes; the caller sees the failure
{install(true);calls.length=0;const {file,env}=fresh();
 const real=env.DB;
 const lossy={...env,DB:new Proxy(real,{get(target,prop){if(prop==='batch')return async(...args)=>{await target.batch(...args);throw new Error('network connection lost');};return target[prop];}})};
 await assert.rejects(mutateFilm(lossy,film('film:tmdb:801','801')),error=>error.code==='film_person_unavailable');
 assert.deepEqual(calls,['has','kick'],'the uncertain outcome wakes the producer');
 const r=sqliteSync(['-json',file],{input:"SELECT COUNT(*) AS c FROM film WHERE id='film:tmdb:801';",encoding:'utf8'});assert.equal(JSON.parse(r.stdout)[0].c,1,'the write did land');}
delete globalThis.CatalogEnrichmentRunner;
console.log('catalog-enrichment-wake ok');
