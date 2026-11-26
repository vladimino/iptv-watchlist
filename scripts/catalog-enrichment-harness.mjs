// AIR-605: the OFFLINE COST HARNESS of the Catalog Enrichment Producer (ADR 0219 decision 6 and its acceptance paragraph). It runs the real drainer on the real migrated schema (sqlite3 CLI as the D1 stand-in) over a
// synthetic mixed catalog with injected upstreams, and prints one JSON report: D1 statements per Film and per unit, upstream requests per Film, runs and handovers at the default budget, the Films drained per run, and
// the per-class split. It measures a FIXTURE: no production capacity is claimed from it. It makes no network request and writes only a scratch database in the OS temp directory.
//   node scripts/catalog-enrichment-harness.mjs [films=60] [castSize=12]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from '../tests/d1-standin.mjs';
import {sqliteSync} from '../tests/sqlite-session.mjs';
import * as D from '../src/catalog-enrichment-drain.js';

const films=Number(process.argv[2]||60),cast=Number(process.argv[3]||12);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-enrich-harness-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<28});
const file=path.join(root,'harness.sqlite');
assert.equal(sqlite(file,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
const T='2026-11-26T10:00:00.000Z';
for(const text of [VERIFY,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",BASELINE])assert.equal(sqlite(file,text).status,0);
const ids=Array.from({length:films},(_,i)=>1000+i);
assert.equal(sqlite(file,ids.map(id=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',2,NULL,'K${id}','${T}');INSERT INTO film_external_id VALUES ('film:tmdb:${id}','tmdb','${id}',1,0,NULL);`).join('')+'DELETE FROM enrichment_signal;').status,0);
assert.equal(sqlite(file,`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','harness');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'${T}');`+ids.map(id=>`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:${id}','rated','',1,'pending','${T}');`).join('')).status,0);
const env={DB:d1Standin(file)};
const res=(status,body='')=>({status,ok:status>=200&&status<300,headers:{get:()=>null},text:async()=>body,body:null});
const requests={tmdb:0,wikidata:0};
const fetchImpl=async url=>{
 url=String(url);
 if(url.startsWith('https://api.themoviedb.org/')){requests.tmdb++;const id=Number(/movie\/(\d+)/.exec(url)[1]);return res(200,JSON.stringify({id,release_date:'1999-01-01',runtime:100,overview:'s',poster_path:'/p.jpg',genres:[{name:'G'}],credits:{cast:Array.from({length:cast},(_,i)=>({id:id*100+i,name:'N',order:i})),crew:[{id:id*100+90,name:'D',job:'Director'}]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'T'+id}}]}}));}
 if(url.startsWith('https://query.wikidata.org/')){requests.wikidata++;return res(200,JSON.stringify({results:{bindings:[]}}));}
 throw new Error('unexpected '+url);
};
let tick=0;
const clock=()=>new Date(Date.parse(T)+(tick++)*1000).toISOString();
const runs=[];
for(let i=0;i<200;i++){
 const result=await D.drain(env,{runId:'harness-'+i,clock,tools:{},fetchImpl});
 runs.push({stop:result.stop,films:result.counts.films,units:result.counts.units,signals:result.counts.signals,statements:result.counts.statements,steps:result.counts.steps});
 if(result.stop!=='handover')break;
}
const total=runs.reduce((sum,run)=>({films:sum.films+run.films,units:sum.units+run.units,statements:sum.statements+run.statements,signals:sum.signals+run.signals,steps:sum.steps+run.steps}),{films:0,units:0,statements:0,signals:0,steps:0});
const count=text=>JSON.parse(String(sqliteSync(['-json',file],{input:text+';',encoding:'utf8'}).stdout))[0].n;
const report={fixture:{films,castPerFilm:cast+1,anchors:'tmdb only (rated scope)'},budget:D.BUDGET,runs:runs.length,stops:Object.fromEntries([...new Set(runs.map(run=>run.stop))].map(stop=>[stop,runs.filter(run=>run.stop===stop).length])),
 filmsPerRun:{min:Math.min(...runs.map(run=>run.films)),max:Math.max(...runs.map(run=>run.films))},drained:{films:count('SELECT COUNT(*) AS n FROM film_metadata'),credits:count('SELECT COUNT(*) AS n FROM film_person_credit'),persons:count('SELECT COUNT(*) AS n FROM person'),localization:count("SELECT COUNT(*) AS n FROM film_localization_source")},
 statementsPerFilm:Math.round(total.statements/films*10)/10,unitsPerFilm:Math.round(total.units/films*10)/10,statementsPerUnit:Math.round(total.statements/Math.max(total.units,1)*10)/10,
 upstreamRequestsPerFilm:{tmdb:requests.tmdb/films,wikidata:requests.wikidata/films},totals:total,receiptsApplied:count("SELECT COUNT(*) AS n FROM canonical_write_receipt WHERE state='applied'"),pendingSignals:count("SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")};
assert.equal(report.drained.films,films,'every Film was drained');
console.log(JSON.stringify(report,null,1));
