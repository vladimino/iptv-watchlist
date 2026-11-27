// AIR-605: the producer step (src/catalog-enrichment-producer.js; ADR 0211 as amended by ADR 0219) end to end on the real migrated schema: from an `admitted` signal to the receipted core, localization and credits units and
// the state rows, with injected fetches. Synthetic ids and pages only; no network, nothing applied anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as S from '../src/catalog-enrichment-store.js';
import * as PR from '../src/catalog-enrichment-producer.js';
import * as D from '../src/catalog-enrichment-discovery.js';
import {Plan} from '../src/catalog-enrichment-plan.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-enrich-producer-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
assert.equal(sqlite(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
const T='2026-11-26T10:00:00.000Z';
const at=s=>new Date(Date.parse(T)+s*1000).toISOString();
const FILM='film:tmdb:603';
let n=0;
async function world({lid='abc',tmdb='603',control=true,scope='rated'}={}){
 const file=path.join(root,'w-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 for(const text of [VERIFY,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",BASELINE])assert.equal(sqlite(file,text).status,0);
 assert.equal(sqlite(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${FILM}',2,NULL,'Kept','${T}');`+(tmdb?`INSERT INTO film_external_id VALUES ('${FILM}','tmdb','${tmdb}',1,0,NULL);`:'')+(lid?`INSERT INTO film_external_id VALUES ('${FILM}','letterboxd','${lid}',1,0,NULL);`:'')+"DELETE FROM enrichment_signal;").status,0);
 const env={DB:d1Standin(file)};
 let generation=0;
 if(control){
  assert.equal(sqlite(file,`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('${scope}',1,1,1,'${T}');INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:${tmdb||'0'}','${scope==='discovery'?'discovery':'rated'}','',1,'pending','${T}');`).status,0);
  generation=rows(file,'SELECT generation FROM catalog_enrichment_control')[0].generation;
 }
 const lease=await S.acquireLease(env,{leaseId:'lease-'+n+'-aaaaaaaa',now:T});
 if(control&&tmdb){const [signal]=await S.runnableSignals(env,{now:at(1)});assert.equal((await S.consumeSignal(env,{signal,generation,leaseId:lease.leaseId,now:at(1)})).consumed,true);}
 return {file,env,generation,leaseId:lease.leaseId};
}
// ---- injected pages and responses ----
const res=(status,body='',headers={})=>({status,ok:status>=200&&status<300,headers:{get:name=>headers[String(name).toLowerCase()]??null},text:async()=>body,body:null});
const attr=(tag,name)=>new RegExp(name+'="([^"]*)"').exec(tag)?.[1]??'';
const extractYear=text=>/\((\d{4})\)/.exec(String(text))?.[1]?Number(/\((\d{4})\)/.exec(String(text))[1]):null;
const parseFilm=html=>{const ld=/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);if(!ld)throw new Error('Film metadata missing');const meta=JSON.parse(ld[1]);const person=(list,role)=>(list||[]).map(item=>{const slug=/\/(?:actor|director)\/([a-z0-9-]+)\//.exec(item.url||'')?.[1];return {id:role+'/'+(slug||item.name),original:item.name,name:item.name};});return {creditsComplete:true,original:meta.name,aliases:[meta.name],tmdbId:/data-tmdb-id="(\d+)"/.exec(html)?.[1]||null,year:meta.year??null,runtime:meta.runtime??null,synopsis:meta.description??null,poster:meta.image??null,genres:meta.genre||[],directors:person(meta.director,'director'),actors:person(meta.actor,'actor')};};
const tools={parseFilm,attr,extractYear};
const lbPage=({tmdb=['603'],actors=[{name:'Neo',url:'/actor/neo/'},{name:'Trinity',url:'/actor/trinity/'}],year=1999,runtime=136,synopsis='lb synopsis'}={})=>`<html><head><link rel="shortlink" href="https://boxd.it/abc"><link rel="canonical" href="https://letterboxd.com/film/the-matrix/"><meta property="og:title" content="The Matrix (1999)"><script type="application/ld+json">${JSON.stringify({name:'The Matrix',year,runtime,description:synopsis,image:'https://img/lb.jpg',genre:['Sci-Fi'],director:[{name:'Lana',url:'/director/lana/'}],actor:actors})}</script></head><body>${tmdb.map(id=>`<div data-tmdb-id="${id}" data-tmdb-type="movie"></div>`).join('')}</body></html>`;
const movie=(over={})=>({id:603,release_date:'1999-03-30',runtime:136,overview:'top-level overview (never proof of a language)',poster_path:'/p.jpg',genres:[{id:28,name:'боевик'}],credits:{cast:[{id:11,name:'T Neo',order:0}],crew:[{id:12,name:'T Lana',job:'Director'}]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица',overview:'tm synopsis'}},{iso_639_1:'en',iso_3166_1:'US',data:{title:'The Matrix',overview:'english synopsis'}}]},images:{posters:[{iso_639_1:'en',file_path:'/en.jpg',width:900},{iso_639_1:'ru',file_path:'/ru.jpg',width:600}]},...over});
function upstream({lb='page',tm=movie(),wd=[]}={}){
 const calls=[];
 const impl=async url=>{
  url=String(url);calls.push(url);
  if(url.startsWith('https://boxd.it/')){if(lb==='transport')return res(503);if(lb==='404')return res(404);return res(301,'',{location:'https://letterboxd.com/film/the-matrix/'});}
  if(url.startsWith('https://letterboxd.com/film/'))return res(200,typeof lb==='string'&&lb!=='page'?lb:lbPage());
  if(url.startsWith('https://api.themoviedb.org/'))return tm instanceof Error?(()=>{throw tm;})():tm==='transport'?res(503):res(200,JSON.stringify(tm));
  if(url.startsWith('https://query.wikidata.org/'))return res(200,JSON.stringify({results:{bindings:wd.map(value=>({label:{value}}))}}));
  throw new Error('unexpected '+url);
 };
 impl.calls=calls;
 return impl;
}
const step=(w,fetchImpl,now=at(10),over={})=>PR.processFilm(w.env,{filmId:FILM,leaseId:w.leaseId,generation:w.generation,now,tools,fetchImpl,env:w.env,...over});
const states=file=>Object.fromEntries(rows(file,'SELECT part||\':\'||source||\':\'||slot AS k,status FROM catalog_enrichment_state').map(r=>[r.k,r.status]));
const meta=file=>rows(file,`SELECT year,runtime,synopsis,poster,url,genres_json FROM film_metadata WHERE film_id='${FILM}'`)[0]||null;
const credits=file=>rows(file,`SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id='${FILM}' ORDER BY role,ordinal`);
const loc=file=>rows(file,`SELECT source,value FROM film_localization_source WHERE film_id='${FILM}' ORDER BY source`);
const filmJson=file=>JSON.parse(rows(file,`SELECT film_json AS j FROM catalog_enrichment_state WHERE film_id='${FILM}' AND part='film'`)[0].j||'null');

// ---- the whole path: first the anchor check opens the plan, then one fetch round writes everything ----
{
 const w=await world();
 const up=upstream({});
 const first=await step(w,up);
 assert.equal(first.state,'replan','a new Film is first anchor-checked: the plan epoch is raised and the work replanned');
 assert.equal(up.calls.length,0,'no request before the anchors are checked');
 const second=await step(w,up,at(11));
 assert.equal(second.state,'done');
 assert.equal(up.calls.length,4,'boxd.it + the film page, TMDB, Wikidata: at most four requests for the acquisition');
 assert.deepEqual(meta(w.file),{year:1999,runtime:136,synopsis:'tm synopsis',poster:'https://image.tmdb.org/t/p/w500/ru.jpg',url:'https://letterboxd.com/film/the-matrix/',genres_json:'["Sci-Fi"]'},'Letterboxd fills every blank core field first (the fixed provider order), EXCEPT the synopsis and the poster: a verified Russian TMDB value outranks the assumed-English synopsis and the unlabelled poster of Letterboxd on a blank field (ADR 0224)');
 assert.deepEqual(loc(w.file),[{source:'tmdb',value:'Матрица'}],'the tmdb source writes its own row from its own response; wikidata has none, letterboxd has no Russian title');
 assert.deepEqual(credits(w.file).map(c=>c.person_id),['person:actor/neo','person:actor/trinity','person:director/lana'],'credits come from ONE namespace, the Letterboxd one; no TMDB persons are added');
 assert.equal(rows(file0(w),"SELECT COUNT(*) AS n FROM person WHERE id LIKE 'person:tmdb_%'")[0].n,0);
 const st=states(w.file);
 assert.equal(st['core:letterboxd:0'],'complete');assert.equal(st['core:tmdb:0'],'complete');
 assert.equal(st['localization:tmdb:0'],'complete');assert.equal(st['localization:wikidata:0'],'complete_with_gaps');assert.equal(st['localization:letterboxd:0'],'not_applicable','a source with no typed title coverage is neither a failure nor a verified absence');
 assert.equal(st['credits:letterboxd:0'],'complete');
 assert.equal(filmJson(w.file).agreedAnchorDigest,filmJson(w.file).anchorDigest,'the agreement is recorded for the exact anchors');
 assert.ok(rows(w.file,`SELECT metadata_at FROM film_sync_state WHERE film_id='${FILM}'`)[0].metadata_at,'metadata_at is set only when every core field is non-blank');
 const idle=await step(w,up,at(12));
 assert.equal(idle.state,'idle','completed parts are not fetched again on a schedule');
 assert.equal(up.calls.length,4);
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n,0,'the producer\'s own writes wake nothing (zero inbox changes)');
}
function file0(w){return w.file;}

// ---- AIR-631 (PV1, ADR 0214 decision 4): the real C1 path DECLARES each core field it fills, so the first declared write after activation is attributed (planning is unchanged) ----
{
 const w=await world();
 const up=upstream({});
 await step(w,up);
 // at mode `off` (the migration default) the declaration is ignored: today's rows, no field row
 assert.equal(rows(w.file,'SELECT mode FROM film_metadata_provenance_control')[0].mode,'off');
 sqlite(w.file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=2,updated_at='"+T+"',updated_by='test'");
 const done=await step(w,up,at(11));
 assert.equal(done.state,'done');
 const fieldRows=rows(w.file,`SELECT field,tier,source,origin,anchor_scheme,anchor_value,agreement,observed_at,language,language_basis FROM film_metadata_field WHERE film_id='${FILM}' ORDER BY field`);
 assert.deepEqual(fieldRows.map(row=>row.field),['genres','poster','runtime','synopsis','url','year'],'every field the core write filled is attributed');
 assert.ok(fieldRows.every(row=>row.tier==='automatic'&&row.origin==='catalog_enrichment'&&row.agreement==='confirmed'),'declared by the producer, agreement recorded');
 // ADR 0224 on the REAL writer: on a blank field the verified Russian TMDB synopsis and poster outrank the assumed-English synopsis and the unlabelled poster of Letterboxd, and are persisted with their verified tag
 assert.deepEqual(fieldRows.filter(row=>['synopsis','poster'].includes(row.field)).map(row=>[row.field,row.source,row.anchor_scheme,row.anchor_value,row.language,row.language_basis]),[['poster','tmdb','tmdb','603','ru','explicit'],['synopsis','tmdb','tmdb','603','ru','explicit']]);
 // every other field keeps the fixed provider order (Letterboxd under its anchor) and carries no language
 assert.deepEqual(fieldRows.filter(row=>!['synopsis','poster'].includes(row.field)).map(row=>[row.field,row.source,row.anchor_scheme,row.anchor_value,row.language,row.language_basis]),['genres','runtime','url','year'].map(field=>[field,'letterboxd','letterboxd','abc',null,null]));
 assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM film_metadata_history')[0].n,0,'a fill adds no history');
 {// Letterboxd is the only observation (TMDB unavailable): its synopsis is persisted as ASSUMED English by the real writer, never as an explicit tag, and no other field carries a language
  const lb=await world();
  await step(lb,upstream({tm:'transport'}));
  sqlite(lb.file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=2,updated_at='"+T+"',updated_by='test'");
  await step(lb,upstream({tm:'transport'}),at(11));
  const persisted=rows(lb.file,`SELECT field,source,language,language_basis FROM film_metadata_field WHERE film_id='${FILM}' ORDER BY field`);
  assert.deepEqual(persisted.find(row=>row.field==='synopsis'),{field:'synopsis',source:'letterboxd',language:'en',language_basis:'assumed'});
  assert.ok(persisted.filter(row=>row.field!=='synopsis').every(row=>row.language===null&&row.language_basis===null),'no other field carries a language');
 }
 {// provenance mode `off` and an absent schema: the declaration is ignored and today's values are written, no field row
  const off=await world();
  await step(off,upstream({}));await step(off,upstream({}),at(11));
  assert.equal(rows(off.file,'SELECT COUNT(*) AS n FROM film_metadata_field')[0].n,0);
  assert.equal(rows(off.file,`SELECT synopsis FROM film_metadata WHERE film_id='${FILM}'`)[0].synopsis,'tm synopsis','the flat values are the same at off');
 }
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n,0,'the producer\'s own provenance rows wake nothing');
}
{
 // the same path at `off`: the declaration is ignored and no provenance is written
 const w=await world();
 const up=upstream({});
 await step(w,up);await step(w,up,at(11));
 assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM film_metadata_field')[0].n,0,'`off` writes no field row');
 assert.equal(meta(w.file).year,1999);
}

// ---- paused or inactive: nothing happens before a request ----
{
 const w=await world();
 await step(w,upstream({}));
 await S.pauseControl(w.env,{expectedRevision:rows(w.file,'SELECT revision FROM catalog_enrichment_control')[0].revision,by:'owner',at:at(20)});
 const up=upstream({});
 assert.deepEqual(await step(w,up,at(21)),{state:'not_active'});assert.equal(up.calls.length,0,'no request after a pause');
 assert.equal(meta(w.file),null);
 const stale=await world();
 await step(stale,upstream({}));
 assert.equal((await step(stale,upstream({}),at(11),{generation:stale.generation-1})).state,'not_active','a stale generation does nothing');
 const none=await world({control:false});
 assert.equal((await step(none,upstream({}),at(11))).state,'not_active','no control row: dormant');
}

// ---- Letterboxd unavailable: TMDB waits for core and credits; its own localization row needs only its own anchor ----
{
 const w=await world();
 await step(w,upstream({lb:'transport'}));
 const up=upstream({lb:'transport'});
 const result=await step(w,up,at(11));
 assert.equal(result.state,'done');assert.deepEqual(result.report.transport.map(t=>t.source),['letterboxd']);
 assert.equal(meta(w.file),null,'TMDB core waits for the earlier source');
 assert.deepEqual(credits(w.file),[],'credits wait for the agreement');
 assert.deepEqual(loc(w.file),[{source:'tmdb',value:'Матрица'}],'a source\'s own localization row needs only that source\'s anchor');
 const lbRow=PR.rowView(rows(w.file,"SELECT * FROM catalog_enrichment_state WHERE part='core' AND source='letterboxd'")[0]);
 assert.equal(lbRow.status,'due');assert.equal(lbRow.pendingSince,at(11),'pending_since is set by the first upstream transport outcome');assert.equal(lbRow.transportStreak,1);assert.equal(lbRow.failures,0,'transport consumes no failure');
 assert.ok(lbRow.retryAt>at(11),'the backoff keeps its place and sets retry_at');
 // not asked again before its retry: this tick is a local skip, pending_since stays
 const early=upstream({lb:'transport'});
 await step(w,early,at(12));
 assert.ok(!early.calls.some(url=>url.startsWith('https://boxd.it/')),'no request to a source before its retry_at');
 // 72 h of upstream transport: TMDB fills what it waited for, listed and unconfirmed
 sqlite(w.file,`UPDATE catalog_enrichment_state SET pending_since='${at(-73*3600)}',retry_at='${at(-1)}' WHERE part='core' AND source='letterboxd'`);
 const late=await step(w,upstream({lb:'transport'}),at(100));
 assert.equal(late.state,'done');
 assert.equal(meta(w.file).year,1999);assert.equal(meta(w.file).synopsis,'tm synopsis','TMDB filled the fields through its own anchor');
 const j=filmJson(w.file);
 assert.equal(j.fallbackFill.length,6);assert.equal(j.fallbackFill[0].waitedFor,'letterboxd');
 assert.equal(j.unconfirmedAgreement.length,6,'no confirmed agreement: every field is listed for owner review');
 // a source that recovers later overwrites nothing
 const recovered=await step(w,upstream({}),at(200));
 assert.equal(meta(w.file).synopsis,'tm synopsis','fill-only: the later Letterboxd answer overwrites nothing');
 void recovered;
}

// ---- a 404 of Letterboxd grants no fallback, however old ----
{
 const w=await world();
 await step(w,upstream({lb:'404'}));
 await step(w,upstream({lb:'404'}),at(11));
 sqlite(w.file,`UPDATE catalog_enrichment_state SET pending_since='${at(-500*3600)}',retry_at=NULL WHERE part='core' AND source='letterboxd'`);
 await step(w,upstream({lb:'404'}),at(500));
 assert.equal(meta(w.file),null,'core waits for the owner: a failed source grants no fallback');
 const row=PR.rowView(rows(w.file,"SELECT * FROM catalog_enrichment_state WHERE part='core' AND source='letterboxd'")[0]);
 assert.ok(row.failures>=1&&row.failureClass==='repairable','a 404 is availability: a repairable failure, never a retirement');
 assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM tmdb_retirement_decision')[0].n,0);
}

// ---- a page disagreement stops every source and writes nothing ----
{
 const w=await world();
 await step(w,upstream({}));
 const up=upstream({lb:lbPage({tmdb:['999']})});
 const result=await step(w,up,at(11));
 assert.deepEqual([result.state,result.reason],['blocked','identity_disagreement']);
 assert.equal(meta(w.file),null);assert.deepEqual(credits(w.file),[]);assert.deepEqual(loc(w.file),[],'no source writes anything for that Film');
 assert.equal(rows(w.file,"SELECT status FROM catalog_enrichment_state WHERE part='film'")[0].status,'identity_disagreement');
 assert.equal(filmJson(w.file).disagreement.reasons[0],'tmdb_differs');
 const again=upstream({});
 assert.deepEqual([(await step(w,again,at(12))).state],['blocked']);assert.equal(again.calls.length,0,'blocked until an anchor changes or the owner retries: no request');
}

// ---- a Film with no Letterboxd anchor needs no agreement; none is invented ----
{
 const w=await world({lid:null});
 await step(w,upstream({}));
 const up=upstream({});
 const result=await step(w,up,at(11));
 assert.equal(result.state,'done');
 assert.ok(!up.calls.some(url=>/boxd\.it|letterboxd\.com/.test(url)),'no Letterboxd fetch without a trusted Letterboxd claim');
 assert.equal(meta(w.file).synopsis,'tm synopsis');
 assert.deepEqual(credits(w.file).map(c=>c.person_id),['person:tmdb_actor/11','person:tmdb_director/12'],'TMDB credits use TMDB person ids');
 assert.ok(credits(w.file).every(c=>/^person:tmdb_(actor|director)\//.test(c.person_id)));
 assert.equal(states(w.file)['core:letterboxd:0'],undefined,'a source without an anchor has no rows');
}

// ---- a Letterboxd-only Film (no TMDB claim) from Letterboxd alone; the TMDB id on the page is only a hint ----
{
 const w=await world({tmdb:null});
 sqlite(w.file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('c3b',1,1,1,'${T}') ON CONFLICT(scope) DO NOTHING;INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at) VALUES ('${FILM}','film','*',0,'active','${T}','${T}');`);
 const gen=rows(w.file,'SELECT generation FROM catalog_enrichment_control')[0].generation;
 const ctx={...w,generation:gen};
 await step(ctx,upstream({}));
 const up=upstream({});
 const result=await step(ctx,up,at(11));
 assert.equal(result.state,'done');
 assert.ok(!up.calls.some(url=>/themoviedb|wikidata/.test(url)),'nothing is fetched from a source without an anchor');
 assert.equal(meta(w.file).year,1999);
 assert.deepEqual(result.report.hints,[{kind:'page_tmdb_id',values:['603']}],'a TMDB id on the page is an identity hint, never a claim');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM film_external_id WHERE scheme='tmdb'")[0].n,0,'no claim was written');
}

// ---- a large cast: chunks of at most 50, every credit, Persons created first ----
{
 const w=await world({lid:null});
 await step(w,upstream({}));
 const cast=Array.from({length:140},(_,i)=>({id:1000+i,name:'N'+i,order:i}));
 const up=upstream({tm:movie({credits:{cast,crew:[{id:5,name:'D1',job:'Director'},{id:6,name:'D2',job:'Director'}]}})});
 const result=await step(w,up,at(11));
 assert.equal(result.report.creditsComplete,true);
 assert.equal(credits(w.file).length,142,'every supported credit: no 10/20/30 cap');
 const slots=rows(w.file,"SELECT slot,status FROM catalog_enrichment_state WHERE part='credits' ORDER BY slot");
 assert.deepEqual(slots,[{slot:0,status:'complete'},{slot:1,status:'complete'},{slot:2,status:'complete'}],'one state row per chunk of at most 50');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM person WHERE id LIKE 'person:tmdb_actor/%'")[0].n,140);
 assert.deepEqual(rows(w.file,"SELECT ordinal FROM film_person_credit WHERE role='actor' ORDER BY ordinal LIMIT 3"),[{ordinal:0},{ordinal:1},{ordinal:2}]);
}

// ---- fill-only and the metadata lock ----
{
 const w=await world({lid:null});
 sqlite(w.file,`INSERT INTO film_metadata (film_id,schema_version,year,genres_json,payload_json,updated_at) VALUES ('${FILM}',1,2005,'[]','{}','${T}');`);
 await step(w,upstream({}));
 await step(w,upstream({}),at(11));
 const m=meta(w.file);
 assert.equal(m.year,2005,'a stored value is never overwritten');assert.equal(m.synopsis,'tm synopsis','a blank one is filled');
 const locked=await world({lid:null});
 sqlite(locked.file,`INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES ('${FILM}','metadata','reviewed','owner',NULL,NULL,NULL,'owner',NULL,NULL,NULL,0,'none','${T}');`);
 await step(locked,upstream({}));
 const result=await step(locked,upstream({}),at(11));
 assert.equal(meta(locked.file),null,'an owner-locked metadata dimension is never written');
 assert.equal(result.state,'done');
}
// ---- unreadable sections back off; source recovery wakes the deferred repairable items of other Films ----
{
 const w=await world({lid:null});
 await step(w,upstream({}));
 const bad=upstream({tm:movie({translations:{}})});
 await step(w,bad,at(11));
 const row=PR.rowView(rows(w.file,"SELECT * FROM catalog_enrichment_state WHERE part='localization' AND source='tmdb'")[0]);
 assert.deepEqual([row.status,row.failures,row.failureClass,row.reason],['due',1,'repairable','unreadable_translations'],'a malformed translation section is a counted repairable failure');
 assert.ok(row.retryAt>at(11),'and it backs off: no immediate endless retry ('+row.retryAt+')');
 const again=upstream({});
 const quiet=await step(w,again,at(12));
 assert.ok(!again.calls.some(url=>url.includes('themoviedb')),'nothing is asked again before the retry: '+quiet.state);
 const noCredits=await world({lid:null});
 await step(noCredits,upstream({}));
 await step(noCredits,upstream({tm:movie({credits:undefined})}),at(11));
 const credits=PR.rowView(rows(noCredits.file,"SELECT * FROM catalog_enrichment_state WHERE part='credits' AND source='tmdb'")[0]);
 assert.deepEqual([credits.failures,credits.reason],[1,'unreadable_credits'],'an unreadable credits section is never read as an empty set');
 assert.ok(credits.retryAt>at(11));
 assert.deepEqual(credits.status,'due');assert.equal(rows(noCredits.file,'SELECT COUNT(*) AS n FROM film_person_credit')[0].n,0);
 // source recovery: per part, bounded. A valid section wakes only the deferred repairable items of THAT part and source in other Films, and only items whose last attempt is old enough.
 const rec=await world({lid:null});
 const OLD='2026-11-26T08:00:00.000Z',FAR='2099-01-01T00:00:00.000Z';
 sqlite(rec.file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:900',2,NULL,'O','${T}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,failure_class,failures,retry_at,due_since,updated_at) VALUES
  ('film:tmdb:900','core','tmdb',0,'deferred_repair','repairable',7,'${FAR}','${T}','${OLD}'),
  ('film:tmdb:900','localization','tmdb',0,'deferred_repair','repairable',7,'${FAR}','${T}','${OLD}'),
  ('film:tmdb:900','credits','tmdb',0,'deferred_repair','repairable',7,'${FAR}','${T}','${at(5)}'),
  ('film:tmdb:900','core','letterboxd',0,'deferred_repair','repairable',7,'${FAR}','${T}','${OLD}');`);
 await step(rec,upstream({}));
 // this Film's translations are UNREADABLE: its core and credits are valid, its localization is not
 // (a Russian entry without a string title: the title is malformed while the synopsis and the rest of the core observation are verified)
 await step(rec,upstream({tm:movie({translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{overview:'x'}}]}})}),at(11));
 const retry=part=>rows(rec.file,`SELECT retry_at FROM catalog_enrichment_state WHERE film_id='film:tmdb:900' AND source='tmdb' AND part='${part}'`)[0].retry_at;
 assert.equal(retry('core'),null,'a valid core section wakes the deferred core items of other Films');
 assert.equal(retry('localization'),FAR,'an UNRELATED section does not wake it: this response\'s translations were unreadable');
 assert.equal(retry('credits'),FAR,'the bound: an item attempted a moment ago is not woken, so repeated successes cannot hot-loop it');
 // a response whose translations section is missing leaves the core observation unverified: it wakes NO deferred core repair of another Film
 sqlite(rec.file,`UPDATE catalog_enrichment_state SET retry_at='${FAR}',updated_at='${OLD}' WHERE film_id='film:tmdb:900'`);
 await step(rec,upstream({tm:movie({translations:{}})}),at(12));
 assert.equal(retry('core'),FAR,'an incomplete core observation is not a source recovery: it wakes nothing');
 assert.equal(rows(rec.file,"SELECT retry_at FROM catalog_enrichment_state WHERE film_id='film:tmdb:900' AND source='letterboxd'")[0].retry_at,FAR,'another source is not woken');
 // repeated identical malformed responses reach quarantine, and a good response recovers the part
 const rep=await world({lid:null});
 await step(rep,upstream({}));
 for(let i=0;i<6;i++){
  sqlite(rep.file,"UPDATE catalog_enrichment_state SET retry_at=NULL WHERE part='localization' AND source='tmdb'");
  await step(rep,upstream({tm:movie({translations:{}})}),at(20+i));
 }
 const quarantined=PR.rowView(rows(rep.file,"SELECT * FROM catalog_enrichment_state WHERE part='localization' AND source='tmdb'")[0]);
 assert.deepEqual([quarantined.status,quarantined.failures,quarantined.failureClass],['deferred_repair',6,'repairable'],'six identical malformed translations reach quarantine, they do not stay at one failure');
 assert.ok(quarantined.retryAt>at(25),'with a backoff');
 assert.equal(quarantined.codeVersion,PR.CODE_VERSION,'the attempt records the running code version');
 sqlite(rep.file,"UPDATE catalog_enrichment_state SET retry_at=NULL WHERE part='localization' AND source='tmdb'");
 await step(rep,upstream({}),at(40));
 const recovered=PR.rowView(rows(rep.file,"SELECT * FROM catalog_enrichment_state WHERE part='localization' AND source='tmdb'")[0]);
 assert.deepEqual([recovered.status,recovered.failures],['complete',0],'a good response recovers the part and clears its counter');
 // the same for an unreadable credits section
 const cr=await world({lid:null});
 await step(cr,upstream({}));
 for(let i=0;i<6;i++){sqlite(cr.file,"UPDATE catalog_enrichment_state SET retry_at=NULL WHERE part='credits' AND source='tmdb'");await step(cr,upstream({tm:movie({credits:undefined})}),at(20+i));}
 assert.deepEqual(rows(cr.file,"SELECT status,failures FROM catalog_enrichment_state WHERE part='credits' AND source='tmdb'"),[{status:'deferred_repair',failures:6}]);
}
// ---- the persisted credits plan has an explicit completeness invariant ----
{
 const cast=n=>Array.from({length:n},(_,i)=>({id:5000+i,name:'N'+i,order:i}));
 const big=movie({credits:{cast:cast(140),crew:[{id:1,name:'D',job:'Director'}]}});
 const tmdbCalls=up=>up.calls.filter(url=>url.includes('themoviedb')).length;
 const plan=file=>rows(file,"SELECT slot,status,json_extract(expected_json,'$.total') AS total,json_extract(expected_json,'$.digest') AS digest FROM catalog_enrichment_state WHERE part='credits' AND source='tmdb' AND status<>'not_applicable' ORDER BY slot");
 // a plan is published atomically: after a budget stop inside chunk 0 EVERY chunk row exists with one digest and the total
 const w=await world({lid:null});
 await step(w,upstream({}));
 let units=0;
 const first=upstream({tm:big});
 const stopped=await step(w,first,at(11),{budget:{canStart:()=>++units<=3}});
 assert.equal(stopped.state,'partial');
 const published=plan(w.file);
 assert.deepEqual(published.map(row=>row.slot),[0,1,2],'the whole plan is published before the first Person unit');
 assert.ok(published.every(row=>row.total===3&&row.digest===published[0].digest),'one digest and the total on every slot');
 assert.ok(rows(w.file,'SELECT COUNT(*) AS n FROM film_person_credit')[0].n<141);
 // a PREFIX is not a plan: with slots 1 and 2 missing the part is never resumed from slot 0 alone and never reported complete; it is refetched and republished
 sqlite(w.file,"DELETE FROM catalog_enrichment_state WHERE part='credits' AND source='tmdb' AND slot>0");
 const before=tmdbCalls(first);
 const healed=await step(w,first,at(12));
 assert.ok(tmdbCalls(first)>before,'a partial prefix is not resumed: the source is fetched again');
 assert.equal(healed.report.creditsComplete,true);
 assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM film_person_credit')[0].n,141,'every credit, not the persisted prefix');
 assert.deepEqual(plan(w.file).map(row=>row.slot),[0,1,2]);
 // a source_changed re-arm during partial progress invalidates the old plan: it is refetched, never resumed
 const x=await world({lid:null});
 await step(x,upstream({}));
 let n2=0;
 const upX=upstream({tm:big});
 await step(x,upX,at(11),{budget:{canStart:()=>++n2<=3}});
 assert.equal(plan(x.file).length,3);
 const generation=rows(x.file,'SELECT generation FROM catalog_enrichment_control')[0].generation;
 sqlite(x.file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,cause_digest,armed_at) VALUES ('source_changed','${FILM}','tmdb','credits',1,'pending','${'9'.repeat(64)}','${at(12)}');`);
 const [signal]=(await S.runnableSignals(x.env,{now:at(13)})).filter(item=>item.kind==='source_changed');
 assert.equal((await S.consumeSignal(x.env,{signal,generation,leaseId:x.leaseId,now:at(13)})).consumed,true);
 assert.equal(rows(x.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE part='credits' AND expected_json IS NOT NULL").n??rows(x.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE part='credits' AND expected_json IS NOT NULL")[0].n,0,'the re-arm cleared every persisted plan of the part');
 const callsBefore=tmdbCalls(upX);
 const redone=await step(x,upX,at(14));
 assert.ok(tmdbCalls(upX)>callsBefore,'the changed source is fetched before anything resumes');
 assert.equal(redone.report.creditsComplete,true);
 // a plan of a different size replaces the old one: the old slots beyond the new total are superseded, never mixed in
 const y=await world({lid:null});
 await step(y,upstream({}));
 await step(y,upstream({tm:big}),at(11));
 assert.equal(plan(y.file).length,3);
 sqlite(y.file,"UPDATE catalog_enrichment_state SET status='due',expected_json=NULL WHERE part='credits'");
 await step(y,upstream({tm:movie({credits:{cast:cast(20),crew:[]}})}),at(12));
 assert.deepEqual(plan(y.file).map(row=>row.slot),[0],'a smaller plan replaces the old one');
 assert.equal(rows(y.file,"SELECT status FROM catalog_enrichment_state WHERE part='credits' AND slot=2")[0].status,'not_applicable','old slots of another plan are superseded');
 // more than 200 ACTUAL stored credits, end to end
 const z=await world({lid:null});
 await step(z,upstream({}));
 const huge=await step(z,upstream({tm:movie({credits:{cast:cast(230),crew:[{id:1,name:'D',job:'Director'}]}})}),at(11));
 assert.equal(huge.report.creditsComplete,true);
 assert.equal(rows(z.file,'SELECT COUNT(*) AS n FROM film_person_credit')[0].n,231,'231 credits stored for one Film: no 200-credit storage cap');
 assert.deepEqual(plan(z.file).map(row=>row.slot),[0,1,2,3,4],'five chunks of at most 50');
}

// ---- the state-row effects are fenced by the resolved identity and the plan epoch the plan was read at ----
{
 // an anchor change (the plan epoch of the Film moves) while the fetch is in flight: the stale plan writes no part row and applies no canonical unit
 const w=await world();
 await step(w,upstream({}));                       // the anchor check opens the plan
 const before=JSON.stringify(rows(w.file,'SELECT part,source,slot,status,refresh_epoch,plan_epoch FROM catalog_enrichment_state ORDER BY 1,2,3'));
 const appliedBefore=rows(w.file,"SELECT COUNT(*) AS n FROM canonical_write_receipt WHERE state='applied'")[0].n;
 const up=upstream({});
 const moving=async url=>{if(String(url).startsWith('https://api.themoviedb.org/'))sqlite(w.file,`UPDATE catalog_enrichment_state SET plan_epoch=plan_epoch+1 WHERE film_id='${FILM}' AND part='film'`);return up(url);};
 moving.calls=up.calls;
 const out=await step(w,moving,at(12));
 const after=rows(w.file,'SELECT part,source,slot,status,refresh_epoch,plan_epoch FROM catalog_enrichment_state ORDER BY 1,2,3');
 assert.equal(meta(w.file),null,'the stale plan wrote no metadata');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM canonical_write_receipt WHERE state='applied'")[0].n,appliedBefore,'and no canonical unit was applied (every unit answered stale; its reservation is abandoned)');
 assert.ok(out.report.units.length>=1&&out.report.units.every(unit=>unit.state==='stale'),'every unit is stale, none failed the Film');
 const partRows=after.filter(row=>row.part!=='film');
 assert.ok(partRows.length>0&&partRows.every(row=>row.status==='due'&&row.refresh_epoch===0),'the part rows created before the move stay due and untouched: nothing was settled by the stale plan: '+JSON.stringify(partRows.map(row=>row.status)));
 void before;
}
// a merged Film: the retired Film receives no state row at all
{
 const w=await world();
 await step(w,upstream({}));
 const up=upstream({});
 const merging=async url=>{if(String(url).startsWith('https://api.themoviedb.org/'))sqlite(w.file,"INSERT OR IGNORE INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:survivor',2,NULL,'S','"+at(1)+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+FILM+"','film:survivor','"+at(1)+"')");return up(url);};
 merging.calls=up.calls;
 const snapshot=JSON.stringify(rows(w.file,'SELECT part,source,slot,status,refresh_epoch FROM catalog_enrichment_state ORDER BY 1,2,3'));
 await step(w,merging,at(12));
 const settled=rows(w.file,"SELECT part,status FROM catalog_enrichment_state WHERE part<>'film' AND status NOT IN ('due')");
 assert.deepEqual(settled,[],'a Film that was merged during the plan has no part row settled by that plan');
 void snapshot;
 assert.equal(meta(w.file),null);
}

// ---- the ANCHOR SET fences the state publication: an anchor change commits while its inbox event is still pending ----
{
 const w=await world();
 await step(w,upstream({}));                       // the anchor check opens the plan
 const up=upstream({});
 // a competing identity writer adds a second trusted tmdb-independent anchor value change: the Film's trusted claims change while the plan is in flight
 const racing=async url=>{if(String(url).startsWith('https://api.themoviedb.org/'))sqlite(w.file,"UPDATE film_external_id SET value='604' WHERE film_id='"+FILM+"' AND scheme='tmdb'");return up(url);};
 racing.calls=up.calls;
 const out=await step(w,racing,at(12));
 const pending=rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE kind='anchor_changed' AND subject='"+FILM+"' AND state='pending'")[0].n;
 assert.ok(pending>=1,'the anchor change is still an unconsumed inbox event');
 assert.equal(meta(w.file),null,'the plan whose anchors changed wrote no metadata');
 const settled=rows(w.file,"SELECT part,status FROM catalog_enrichment_state WHERE part<>'film' AND status NOT IN ('due')");
 assert.deepEqual(settled,[],'and settled no part row as current: '+JSON.stringify(out.state));
 assert.ok((out.report?.units||[]).every(unit=>unit.state==='stale'),'every unit answered stale, none failed the Film');
}

// ---- AIR-684: the Discovery scope against the ACTUAL persisted state of the common producer ----
// The observer (the Discovery revalidation, ru-RU) and the producer (its own fetch) share ONE pure version projection: the per-part `source_version` the producer stored on completion equals what the observer computes
// from any response of the same movie, whatever the request language. Only VERIFIED sections have a version.
{
 const sv=file=>Object.fromEntries(rows(file,"SELECT part||':'||source||':'||slot AS k,source_version AS v,status FROM catalog_enrichment_state WHERE part<>'film'").map(r=>[r.k,{v:r.v,status:r.status}]));
 const tmOnly=over=>upstream({lb:'404',tm:movie(over),wd:[]});
 const done=async(w,up,from=10)=>{let out;for(let i=0;i<6;i++){out=await step(w,up,at(from+i));if(['idle','not_admitted'].includes(out.state))break;}return out;};
 const wakes=[];
 globalThis.CatalogEnrichmentRunner={hasRunnable:async()=>{wakes.push('has');return true;},kick:async()=>{wakes.push('kick');}};
 const planEpoch=w=>rows(w.file,`SELECT plan_epoch FROM catalog_enrichment_state WHERE film_id='${FILM}' AND part='film'`)[0].plan_epoch;
 const observe=async(w,m)=>{const out=await D.emitSourceChanged(w.env,{tmdbId:'603',movie:m,at:at(50)});return out;};
 const pending=(w,kind='source_changed')=>rows(w.file,`SELECT part,state,version FROM enrichment_signal WHERE kind='${kind}' AND subject='${FILM}' ORDER BY part`);
 const consumeAll=async(w,now=at(60))=>{const out=[];for(const signal of (await S.runnableSignals(w.env,{now})).filter(s=>s.kind==='source_changed')){out.push((await S.consumeSignal(w.env,{signal,generation:w.generation,leaseId:w.leaseId,now})).consumed);}return out;};

 // 1. admission -> consume (the world does it) -> the common producer completes core, credits and the typed Russian title; the persisted versions are the observer's
 const w=await world({lid:null,scope:'discovery'});
 assert.deepEqual(rows(w.file,`SELECT scope FROM catalog_enrichment_member WHERE film_id='${FILM}'`),[{scope:'discovery'}],'the discovery admitted signal created the retained discovery membership');
 const live=upstream({lb:'404'});
 await done(w,live);
 const after=sv(w.file);
 assert.equal(after['core:tmdb:0'].status,'complete');assert.equal(after['credits:tmdb:0'].status,'complete');assert.equal(after['localization:tmdb:0'].status,'complete');
 const observerRu=await D.tmdbPartVersions(movie({overview:'ru overview',poster_path:'/ru.jpg',genres:[{id:28,name:'Боевик'}]}),603);
 assert.equal(after['core:tmdb:0'].v,observerRu.core,'core: the producer stored exactly the version an observer computes, whatever the request language');
 assert.equal(after['localization:tmdb:0'].v,observerRu.localization,'localization');
 assert.equal(after['credits:tmdb:0'].v,observerRu.credits,'credits: persisted on completion of the expected set');
 assert.equal(rows(w.file,`SELECT COUNT(*) AS n FROM film_localization_source WHERE film_id='${FILM}'`)[0].n>=1,true);
 const calls0=live.calls.filter(url=>url.startsWith('https://api.themoviedb.org/')).length;

 // 2. an identical COMPLETE response of ANOTHER request language, from an enriched Film that has no prior observer row: nothing is written at all (no pending row, no wake, no plan epoch change), and nothing is refetched
 const epoch0=planEpoch(w);wakes.length=0;
 assert.deepEqual(await observe(w,movie({overview:'ru overview',poster_path:'/ru.jpg',genres:[{id:28,name:'Боевик'}]})),{state:'unchanged',parts:[]},'the applied state already says the same thing');
 assert.deepEqual(pending(w),[],'no signal row');assert.deepEqual(wakes,[],'no wake');assert.equal(planEpoch(w),epoch0,'no plan epoch change');
 assert.deepEqual(await consumeAll(w),[],'nothing to consume');
 const idle=await step(w,live,at(70));
 assert.equal(idle.state,'idle');assert.equal(live.calls.filter(url=>url.startsWith('https://api.themoviedb.org/')).length,calls0,'no refetch for an unchanged observation');

 // 3. changed credits: only the credits part reopens and the producer fetches again; core and localization stay complete
 const changedCredits=movie({credits:{cast:[{id:11,name:'T Neo',order:0},{id:99,name:'New',order:1}],crew:[{id:12,name:'T Lana',job:'Director'}]}});
 assert.deepEqual((await observe(w,changedCredits)),{state:'written',parts:['credits']},'a changed credit set while the part is complete at another version');
 assert.deepEqual(wakes,['has','kick'],'and it wakes the idle producer');
 assert.deepEqual(await consumeAll(w,at(80)),[true]);
 assert.equal(sv(w.file)['credits:tmdb:0'].status,'due');assert.equal(sv(w.file)['core:tmdb:0'].status,'complete');assert.equal(sv(w.file)['localization:tmdb:0'].status,'complete');
 const refetch=upstream({lb:'404',tm:changedCredits});
 await done(w,refetch,81);
 assert.equal(sv(w.file)['credits:tmdb:0'].status,'complete');
 assert.equal(sv(w.file)['credits:tmdb:0'].v,(await D.tmdbPartVersions(changedCredits,603)).credits,'the new credit set is the stored version');
 assert.ok(credits(w.file).some(c=>c.person_id==='person:tmdb_99'||/99/.test(c.person_id)),'the new credit was written');

 // 4. the first changed observation after completed enrichment (a runtime change) reopens core; the producer refetches and re-stores the version
 assert.deepEqual((await observe(w,movie({runtime:150,credits:changedCredits.credits}))).parts,['core']);
 await consumeAll(w,at(90));
 assert.equal(sv(w.file)['core:tmdb:0'].status,'due','a real change since the completed enrichment is not lost');
 await done(w,upstream({lb:'404',tm:movie({runtime:150,credits:changedCredits.credits})}),91);
 assert.equal(sv(w.file)['core:tmdb:0'].v,(await D.tmdbPartVersions(movie({runtime:150}),603)).core);
 assert.equal(meta(w.file).runtime,136,'a stored value is never overwritten by the refresh (fill-only)');

 // 5. an identical INCOMPLETE coverage still progresses and is never dropped: an equal version with an incomplete part is written, consumed and the part stays due
 sqlite(w.file,"UPDATE catalog_enrichment_state SET status='due' WHERE part='localization' AND source='tmdb'");
 assert.deepEqual(await observe(w,movie({runtime:150,credits:changedCredits.credits})),{state:'written',parts:['localization']});
 await consumeAll(w,at(100));
 assert.equal(sv(w.file)['localization:tmdb:0'].status,'due','an equal version with an incomplete part is not dropped');
 // credits with a superseded slot: the applied check looks at the ACTIVE chunk rows only, and a superseded (not_applicable) row is never reopened by a verified change
 sqlite(w.file,"INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,due_since,updated_at) VALUES ('"+FILM+"','credits','tmdb',7,'not_applicable','superseded_plan','"+T+"','"+T+"')");
 const cv=(await D.tmdbPartVersions(movie({credits:changedCredits.credits}),603)).credits;
 assert.equal((await observe(w,movie({credits:changedCredits.credits}))).parts.includes('credits'),false,'a superseded slot does not make an equal, complete credit set look stale');
 sqlite(w.file,`UPDATE enrichment_signal SET state='pending',version=version+1,cause_digest='${'d'.repeat(64)}' WHERE kind='source_changed' AND subject='${FILM}' AND part='credits'`);
 await consumeAll(w,at(101));
 assert.equal(rows(w.file,"SELECT status FROM catalog_enrichment_state WHERE film_id='"+FILM+"' AND part='credits' AND slot=7")[0].status,'not_applicable','a superseded slot is not resurrected');
 assert.equal(cv.length,64);
 // the shared Russian-first projection: a synopsis-only change, a poster-only change, the appearance of a Russian value, a genre id change and an unmapped id are observed; response order and the top-level overview are not
 const ru=(over={})=>movie({runtime:150,credits:changedCredits.credits,...over});
 const w2=await world({lid:null,scope:'discovery'});
 await done(w2,upstream({lb:'404',tm:ru()}));
 const base=rows(w2.file,"SELECT source_version AS v,status FROM catalog_enrichment_state WHERE part='core' AND source='tmdb'")[0];
 assert.equal(base.status,'complete');assert.equal(base.v,(await D.tmdbPartVersions(ru(),603)).core,'the producer stored the very version an observer computes');
 wakes.length=0;
 const same=ru({overview:'another top-level text',genres:[{id:28,name:'другое имя'}],images:{posters:[{iso_639_1:'ru',file_path:'/ru.jpg',width:600,vote_average:9.9},{iso_639_1:'en',file_path:'/en.jpg',width:900,vote_average:1}]}});
 assert.equal((await D.emitSourceChanged(w2.env,{tmdbId:'603',movie:same,at:at(50)})).state,'unchanged','the top-level overview, the genre names, the votes and the list order are not what is compared');
 assert.deepEqual(wakes,[]);
 const emit=async over=>(await D.emitSourceChanged(w2.env,{tmdbId:'603',movie:ru(over),at:at(51)})).parts;
 assert.deepEqual(await emit({translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица',overview:'revised synopsis'}},{iso_639_1:'en',iso_3166_1:'US',data:{title:'The Matrix',overview:'english synopsis'}}]}}),['core'],'a synopsis-only change');
 assert.deepEqual(await emit({images:{posters:[{iso_639_1:'ru',file_path:'/ru2.jpg',width:700},{iso_639_1:'en',file_path:'/en.jpg',width:900}]}}),['core'],'a poster-only change (the selected Russian poster)');
 assert.deepEqual(await emit({genres:[{id:28,name:'x'},{id:878,name:'y'}]}),['core'],'a genre id change');
 assert.deepEqual(await emit({genres:[{id:28,name:'x'},{id:424242,name:'new'}]}),['core'],'an unmapped id is part of the version');
 // English fallback, then the appearance of a previously absent Russian value
 const w3=await world({lid:null,scope:'discovery'});
 const noRuSynopsis=ru({translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица',overview:''}},{iso_639_1:'en',iso_3166_1:'US',data:{title:'The Matrix',overview:'english synopsis'}}]}});
 await done(w3,upstream({lb:'404',tm:noRuSynopsis}));
 assert.equal(meta(w3.file).synopsis,'english synopsis','Russian verified absent: the tagged English overview is the fallback');
 assert.equal((await D.emitSourceChanged(w3.env,{tmdbId:'603',movie:noRuSynopsis,at:at(50)})).state,'unchanged');
 assert.deepEqual((await D.emitSourceChanged(w3.env,{tmdbId:'603',movie:ru(),at:at(52)})).parts,['core'],'the appearance of a Russian synopsis reopens the part');
 await consumeAll(w3,at(60));
 assert.equal(rows(w3.file,"SELECT status FROM catalog_enrichment_state WHERE part='core' AND source='tmdb'")[0].status,'due');
 await done(w3,upstream({lb:'404',tm:ru()}),61);
 assert.equal(meta(w3.file).synopsis,'english synopsis','fill-only: the refresh finds nothing blank; the Russian upgrade of a stored English value is AIR-633 (enforce), not this part');
 assert.equal(rows(w3.file,"SELECT source_version AS v FROM catalog_enrichment_state WHERE part='core' AND source='tmdb'")[0].v,(await D.tmdbPartVersions(ru(),603)).core,'the part completed at the observed version and stopped');
 // an unmapped genre id completes the part WITH a visible gap and still has a version
 const w4=await world({lid:null,scope:'discovery'});
 await done(w4,upstream({lb:'404',tm:ru({genres:[{id:28,name:'x'},{id:424242,name:'new'}]})}));
 assert.equal(rows(w4.file,"SELECT status FROM catalog_enrichment_state WHERE part='core' AND source='tmdb'")[0].status,'complete_with_gaps');
 assert.match(rows(w4.file,"SELECT gaps_json FROM catalog_enrichment_state WHERE part='core' AND source='tmdb'")[0].gaps_json,/genres_unmapped/);
 assert.ok(rows(w4.file,"SELECT source_version AS v FROM catalog_enrichment_state WHERE part='core' AND source='tmdb'")[0].v,'a partial mapping still has a version: the table revision reopens it');
 assert.deepEqual(JSON.parse(meta(w4.file).genres_json),['Боевик'],'only mapped words are written, in the existing vocabulary');
}
{
 // 6. verified ABSENCE of a Russian title persists its own comparable version and is dropped without a fetch; a missing or malformed section emits nothing
 const w=await world({lid:null,scope:'discovery'});
 const noRu=movie({translations:{translations:[{iso_639_1:'de',iso_3166_1:'DE',data:{title:'Matrix'}}]}});
 const up=upstream({lb:'404',tm:noRu});
 for(let i=0;i<4;i++)await step(w,up,at(10+i));
 const row=rows(w.file,"SELECT status,source_version AS v FROM catalog_enrichment_state WHERE part='localization' AND source='tmdb'")[0];
 assert.equal(row.status,'complete_with_gaps');
 assert.equal(row.v,(await D.tmdbPartVersions(noRu,603)).localization,'the verified absence has a persisted comparable version');
 assert.deepEqual(await D.emitSourceChanged(w.env,{tmdbId:'603',movie:noRu,at:at(50)}),{state:'unchanged',parts:[]},'the same verified absence is the applied state: nothing is written');
 const calls=up.calls.length;
 assert.equal(rows(w.file,"SELECT status FROM catalog_enrichment_state WHERE part='localization' AND source='tmdb'")[0].status,'complete_with_gaps');
 // a Russian title that APPEARS later is a change of the verified coverage
 assert.deepEqual((await D.emitSourceChanged(w.env,{tmdbId:'603',movie:movie(),at:at(55)})).parts,['core','localization'],'a Russian title and a Russian synopsis that appear after a verified absence');
 // missing or malformed sections are not verified coverage: nothing is signalled for them
 const broken=movie({credits:undefined,translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:null}]},runtime:111});
 assert.deepEqual(await D.emitSourceChanged(w.env,{tmdbId:'603',movie:broken,at:at(70)}),{state:'unchanged',parts:[]},'an unreadable translations section leaves both the title and the comparable core unverified; a missing credits section is unverified too');
 const malformed=movie({credits:{cast:[{id:11,name:'A',order:0},{name:'no id'}],crew:[{id:12,name:'D',job:'Director'}]},runtime:112});
 assert.equal((await D.tmdbPartVersions(malformed,603)).credits,null,'a present supported-role entry without an id makes the section unreadable instead of being filtered out of a "complete" set');
 assert.equal((await D.tmdbPartVersions(movie({credits:{cast:[{id:11,name:'A',order:0}],crew:[{name:'D',job:'Director'}]}}),603)).credits,null,'a director without an id');
 assert.equal((await D.tmdbPartVersions(movie({credits:{cast:[{id:11,name:'A',order:0}],crew:[null]}}),603)).credits,null,'a crew entry that is not an object');
 assert.equal((await D.tmdbPartVersions(movie({credits:{cast:[{id:11,name:'A',order:0}],crew:[{id:5,job:'Editor'}]}}),603)).credits,null,'a crew list that names no recognized director is not a verified credit set');
 assert.ok((await D.tmdbPartVersions(movie({credits:{cast:[{id:11,name:'A',order:0}],crew:[{id:12,job:'Director'},{job:'Editor'}]}}),603)).credits,'another job beside a recognized director is not judged');
 // genre ids: a missing or malformed list is unverified coverage (no core version), a present empty list is a valid empty set
 assert.equal((await D.tmdbPartVersions(movie({genres:undefined}),603)).core,null,'a missing genre list');
 assert.equal((await D.tmdbPartVersions(movie({genres:[{id:28},{name:'no id'}]}),603)).core,null,'a malformed genre entry');
 const emptyGenres=await D.tmdbPartVersions(movie({genres:[]}),603);
 assert.ok(/^[0-9a-f]{64}$/.test(emptyGenres.core),'a valid empty genre list is verified coverage');
 assert.notEqual(emptyGenres.core,(await D.tmdbPartVersions(movie({genres:[{id:28,name:'A'}]}),603)).core);
 assert.deepEqual((await D.emitSourceChanged(w.env,{tmdbId:'603',movie:malformed,at:at(71)})).parts,['core','localization'].filter(part=>part==='core'||false),'only the verified sections of a response with a malformed credit entry are signalled');
 assert.equal(up.calls.length,calls);
}
// ---- AIR-684 (review): an INCOMPLETE core observation is never settled, never given a version, never clears a counter and never wakes a repair; valid independent fields still fill ----
{
 const core=file=>PR.rowView(rows(file,"SELECT * FROM catalog_enrichment_state WHERE part='core' AND source='tmdb'")[0]);
 const incomplete={'missing images':{images:undefined},'malformed translations':{translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{overview:{}}}]}},'ambiguous synopsis':{translations:{translations:[{iso_639_1:'ru',iso_3166_1:'UA',data:{title:'Т',overview:'Один'}},{iso_639_1:'ru',iso_3166_1:'BY',data:{title:'Т',overview:'Два'}}]}},
  'missing genres':{genres:undefined},'missing release date':{release_date:undefined},'missing runtime':{runtime:undefined},'unrecognized crew':{credits:{cast:[{id:11,name:'N',order:0}],crew:[{id:12,name:'W',job:'Writer'}]}}};
 for(const [name,over] of Object.entries(incomplete)){
  // a PARTIALLY BLANK Film: the valid sections of the response still fill their fields, the part is repairable and has no version
  const w=await world({lid:null});
  await step(w,upstream({lb:'404'}));
  const out=await step(w,upstream({lb:'404',tm:movie(over)}),at(11));
  const row=core(w.file);
  if(name==='unrecognized crew')continue; // that one concerns credits, not the core observation (below)
  assert.equal(out.state,'done',name);
  assert.notEqual(row.status,'complete',name+': the part is not settled on an incomplete observation');assert.notEqual(row.status,'complete_with_gaps',name);
  assert.equal(row.sourceVersion,null,name+': no version');
  assert.deepEqual([row.failures,row.failureClass,row.reason],[1,'repairable','incomplete_core_coverage'],name+': a counted repairable failure with the existing backoff');
  assert.ok(row.retryAt>at(11),name+': backed off');
  assert.equal(meta(w.file)?.url,'https://www.themoviedb.org/movie/603',name+': the independent url field still fills');
  if(!['missing release date','missing runtime'].includes(name))assert.equal(meta(w.file).year,1999,name+': a valid year still fills');
  assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n,0,name+': nothing is signalled or woken');
 }
 // a FULLY POPULATED Film (every core field stored): an incomplete observation is repairable too, never a silent completion
 const full=await world({lid:null});
 await step(full,upstream({lb:'404'}));
 sqlite(full.file,"UPDATE catalog_enrichment_state SET status='due',source_version=NULL,failures=0 WHERE part='core' AND source='tmdb'");
 await step(full,upstream({lb:'404',tm:movie({images:undefined})}),at(12));
 assert.deepEqual([core(full.file).status,core(full.file).sourceVersion,core(full.file).failures],['due',null,1],'a populated Film: still repairable, no version');
 // repeated: six identical incomplete responses reach the existing quarantine, then a valid response recovers (no new retry mechanism)
 const rep=await world({lid:null});
 await step(rep,upstream({lb:'404'}));
 for(let i=0;i<6;i++){
  sqlite(rep.file,"UPDATE catalog_enrichment_state SET retry_at=NULL WHERE part='core' AND source='tmdb'");
  await step(rep,upstream({lb:'404',tm:movie({images:undefined})}),at(20+i));
 }
 const quarantined=core(rep.file);
 assert.deepEqual([quarantined.status,quarantined.failures,quarantined.failureClass],['deferred_repair',6,'repairable'],'repeated incomplete observations reach the existing quarantine');
 sqlite(rep.file,"UPDATE catalog_enrichment_state SET retry_at=NULL WHERE part='core' AND source='tmdb'");
 await step(rep,upstream({lb:'404',tm:movie()}),at(40));
 const healed=core(rep.file);
 assert.deepEqual([healed.status,healed.failures],['complete',0],'a valid observation recovers the part and clears its counter');
 assert.equal(healed.sourceVersion,(await D.tmdbPartVersions(movie(),603)).core,'and it has the version of what was verified');
 // an incomplete response must not erase the VERSION of an already settled part, nor touch an unfetched source: mixed-source rows
 const mix=await world();
 await step(mix,upstream({}));await step(mix,upstream({}),at(11));
 const before=Object.fromEntries(rows(mix.file,"SELECT source,status,source_version AS v,failures FROM catalog_enrichment_state WHERE part='core'").map(r=>[r.source,r]));
 assert.ok(before.letterboxd.v&&before.tmdb.v,'both sources settled with a version');
 sqlite(mix.file,"UPDATE catalog_enrichment_state SET status='due' WHERE part='core' AND source='tmdb'");
 const calls=await step(mix,upstream({tm:movie({images:undefined})}),at(30));
 const after=Object.fromEntries(rows(mix.file,"SELECT source,status,source_version AS v,failures FROM catalog_enrichment_state WHERE part='core'").map(r=>[r.source,r]));
 assert.deepEqual(after.letterboxd,before.letterboxd,'the unfetched Letterboxd row keeps its version, status and counters');
 assert.equal(after.tmdb.v,before.tmdb.v,'the failed observation does not erase the settled version of its own source either');
 assert.equal(after.tmdb.failures,1);assert.equal(calls.report.fetched.includes('letterboxd'),false,'only the due source was fetched');
 // a field with an explicit absence is VERIFIED and settles (the empty-list and null cases are not malformed)
 const blank=await world({lid:null});
 await step(blank,upstream({lb:'404'}));
 await step(blank,upstream({lb:'404',tm:movie({release_date:'',runtime:0,genres:[],poster_path:null,images:{posters:[]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица',overview:''}}]}})}),at(11));
 assert.equal(core(blank.file).status,'complete_with_gaps','explicit absences settle the part with its gaps');assert.ok(core(blank.file).sourceVersion);
 // the approved unmapped-genre case stays distinct: a verified id list with a mapping gap settles WITH a version and the visible gap
 const gap=await world({lid:null});
 await step(gap,upstream({lb:'404'}));
 await step(gap,upstream({lb:'404',tm:movie({genres:[{id:28,name:'x'},{id:424242,name:'new'}]})}),at(11));
 assert.equal(core(gap.file).status,'complete_with_gaps');assert.ok(core(gap.file).sourceVersion);
 // the declarations the producer hands to the writer BEFORE it runs (`metadata.declared`, the shape the AIR-631 writer reads), each bound to the language and basis its observation carried
 const decl=await world({lid:null});
 await step(decl,upstream({lb:'404'}));
 const written=await step(decl,upstream({lb:'404'}),at(11));
 const declared=Object.fromEntries((written.report.declarations||[]).map(item=>[item.field,item]));
 assert.deepEqual([declared.synopsis?.language,declared.synopsis?.languageBasis,declared.synopsis?.source],['ru','explicit','tmdb'],'the synopsis is declared with its verified Russian tag');
 assert.deepEqual([declared.poster?.language,declared.poster?.languageBasis],['ru','explicit'],'the poster carries the tag of the selected image');
 for(const field of ['year','runtime','url','genres'])if(declared[field])assert.equal('language' in declared[field],false,field+': no language is declared for a field that carries none');
 assert.deepEqual([declared.year?.source,declared.year?.anchor,declared.year?.observedAt],['tmdb',{scheme:'tmdb',value:'603'},at(11)],'source, anchor and observation time are declared');
 // a Letterboxd synopsis is declared as ASSUMED English (the owner-approved default); a field with an unknown poster language declares none
 const lbOnly=await world();// TMDB is unavailable (transport): only the Letterboxd observation can fill
 await step(lbOnly,upstream({tm:'transport'}));
 const lbWrote=await step(lbOnly,upstream({tm:'transport'}),at(11));
 const lbDeclared=Object.fromEntries((lbWrote.report.declarations||[]).map(item=>[item.field,item]));
 assert.deepEqual([lbDeclared.synopsis?.source,lbDeclared.synopsis?.language,lbDeclared.synopsis?.languageBasis],['letterboxd','en','assumed'],'Letterboxd synopsis: assumed English, never an explicit tag');
 assert.equal('language' in (lbDeclared.poster||{}),false,'a Letterboxd poster carries no language');
 // the mixed-source blank-field case on the real producer: Russian TMDB wins the synopsis and the poster, Letterboxd keeps the other fields, and the agreement requirement still holds
 const mixed=await world();
 await step(mixed,upstream({}));const mixedWrote=await step(mixed,upstream({}),at(11));
 const md=Object.fromEntries((mixedWrote.report.declarations||[]).map(item=>[item.field,item.source]));
 assert.deepEqual([md.synopsis,md.poster,md.year,md.url],['tmdb','tmdb','letterboxd','letterboxd'],'the selected value and its declaration implement the language rule only for synopsis and poster');
 assert.equal(rows(mixed.file,`SELECT synopsis FROM film_metadata WHERE film_id='${FILM}'`)[0].synopsis,'tm synopsis');
}
// ---- AIR-684: the producer on a RECORDED TMDB response (603, `ru-RU`, captured once under the owner's approval): the whole path from the real response shape to the stored rows and the observer's versions ----
{
 const recorded=JSON.parse(fs.readFileSync('tests/fixtures/tmdb-recorded/603-ru.json','utf8'));
 const w=await world({lid:null,scope:'discovery'});
 const up=upstream({lb:'404',tm:recorded});
 for(let i=0;i<8;i++){const out=await step(w,up,at(10+i));if(['idle','not_admitted'].includes(out.state))break;}
 const st=Object.fromEntries(rows(w.file,"SELECT part||':'||source||':'||slot AS k,status,source_version AS v FROM catalog_enrichment_state WHERE part<>'film'").map(r=>[r.k,r]));
 assert.equal(st['core:tmdb:0'].status,'complete');assert.equal(st['localization:tmdb:0'].status,'complete');
 const m=meta(w.file);
 const ruOverview=recorded.translations.translations.find(entry=>entry.iso_639_1==='ru'&&entry.iso_3166_1==='RU').data.overview.trim();
 assert.deepEqual([m.year,m.runtime,m.synopsis],[1999,136,ruOverview],'the real response filled the blank fields: the tagged Russian synopsis');
 assert.deepEqual(JSON.parse(m.genres_json),['Боевик','Фантастика'],'genres through the id table, in the existing vocabulary');
 assert.ok(m.poster.startsWith('https://image.tmdb.org/t/p/w500/')&&m.poster.endsWith('/2GfsfNLkJo2oOGTS9VZ4cPNM6tu.jpg'),'the stable selector picked the widest Russian poster by path');
 assert.equal(rows(w.file,`SELECT COUNT(*) AS n FROM film_person_credit WHERE film_id='${FILM}'`)[0].n,recorded.credits.cast.length+2,'the whole recorded cast and both directors');
 assert.equal(st['core:tmdb:0'].v,(await D.tmdbPartVersions(recorded,603)).core,'observer and producer: the same core version from the recorded response');
 assert.equal(st['localization:tmdb:0'].v,(await D.tmdbPartVersions(recorded,603)).localization);
 // the same recorded response observed again: nothing is written, nothing wakes, no epoch change
 assert.deepEqual(await D.emitSourceChanged(w.env,{tmdbId:'603',movie:recorded,at:at(60)}),{state:'unchanged',parts:[]},'an identical complete observation of the recorded response is a no-op');
}
// ---- AIR-684 (review): a verified OTHER-language tag of the last-resort poster, end to end on the real writer ----
{
 const onlyFrench=movie({images:{posters:[{iso_639_1:'fr',file_path:'/p.jpg',width:100}]}});
 const unlisted=movie({images:{posters:[]}});
 // the observation keeps the tag and the digest tells it from the same path without one
 assert.notEqual((await D.tmdbPartVersions(onlyFrench,603)).core,(await D.tmdbPartVersions(unlisted,603)).core,'a verified tag and an unknown language are different observations of the identical path');
 const w=await world({lid:null,scope:'discovery'});
 await step(w,upstream({lb:'404'}));
 sqlite(w.file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=2,updated_at='"+T+"',updated_by='test'");
 const out=await step(w,upstream({lb:'404',tm:onlyFrench}),at(11));
 assert.equal(out.state,'done','the write is not failed by a tag the schema cannot hold');
 assert.equal(meta(w.file).poster,'https://image.tmdb.org/t/p/w500/p.jpg','the poster is still filled');
 const poster=rows(w.file,`SELECT source,language,language_basis FROM film_metadata_field WHERE film_id='${FILM}' AND field='poster'`)[0];
 assert.deepEqual(poster,{source:'tmdb',language:null,language_basis:null},'persisted with NO language until the additive schema support: never an invented ru or en');
 assert.deepEqual(out.report.languageNotDeclared,[{field:'poster',language:'fr',source:'tmdb'}],'the verified tag the writer cannot hold is reported, not lost silently');
 assert.equal(out.report.declarations.find(item=>item.field==='poster').language,undefined,'the declaration carries no language');
 assert.equal(rows(w.file,`SELECT COUNT(*) AS n FROM film_metadata_history WHERE film_id='${FILM}'`)[0].n,0,'a fill adds no history');
 assert.equal(core_version_present(w.file),true,'the part still settles with its version');
 function core_version_present(file){return !!rows(file,"SELECT source_version AS v FROM catalog_enrichment_state WHERE part='core' AND source='tmdb'")[0].v;}
}

// ---- AIR-633 (PV2, ADR 0214 decisions 5, 7, 10, 12, 13; ADR 0224): replacement planning, per-source completion, source-set reopen, the held language signal and the counts, through the REAL producer step, the real
// AIR-684 observation parser and the real inbox on the real migrated schema. TMDB answers are real JSON; Russian coverage is the tagged `translations` and `images` of the response.
const RU_SYNOPSIS='Русский синопсис';
const trs=(ru,en)=>({translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица',overview:ru??''}},...(en?[{iso_639_1:'en',iso_3166_1:'US',data:{title:'Matrix',overview:en}}]:[])]});
const ruMovie=(over={})=>movie({translations:trs(RU_SYNOPSIS),images:{posters:[{iso_639_1:'ru',file_path:'/ru.jpg',width:600}]},poster_path:'/ru.jpg',...over});
const noRuMovie=(over={})=>movie({translations:trs(''),images:{posters:[]},poster_path:null,...over}); // Russian verified ABSENT: no synopsis, no poster
const RU_POSTER='https://image.tmdb.org/t/p/w500/ru.jpg';
const setMode=(file,mode,revision)=>assert.equal(sqlite(file,`UPDATE film_metadata_provenance_control SET mode='${mode}',revision=${revision},updated_at='${T}',updated_by='test'`).status,0);
const fieldRow=(file,field)=>rows(file,`SELECT tier,source,language,language_basis,agreement FROM film_metadata_field WHERE film_id='${FILM}' AND field='${field}'`)[0]||null;
const coreStatus=file=>rows(file,`SELECT source,status FROM catalog_enrichment_state WHERE film_id='${FILM}' AND part='core' ORDER BY source`).map(r=>r.status);
const upgradeSignals=file=>rows(file,"SELECT subject,source,part,state FROM enrichment_signal WHERE kind='source_changed' AND cause_ref='language_upgrade'");
const hist=file=>rows(file,`SELECT field,reason FROM film_metadata_history WHERE film_id='${FILM}' ORDER BY id`).map(r=>r.field+':'+r.reason);
const reopenCore=file=>assert.equal(sqlite(file,"UPDATE catalog_enrichment_state SET status='due',refresh_epoch=refresh_epoch+1,retry_at=NULL WHERE part='core'").status,0);
// the runnable inbox of the real drainer: a language_upgrade signal is held until the mode is enforce, then consumed by the existing guarded effect (plan epoch, core part only)
const consumeUpgrades=async(w,now)=>{let n=0;for(const signal of await S.runnableSignals(w.env,{now,limit:50}))if(signal.digest&&signal.part==='core'&&signal.source===''){const r=await S.consumeSignal(w.env,{signal,generation:w.generation,leaseId:w.leaseId,now});if(r.consumed)n++;}return n;};
const enforceWorld=async(over={})=>{const w=await world(over);setMode(w.file,'enforce',2);return w;};
const pinSynopsisOrRuntime=async(w,field,when,id)=>{
 const {writeFilmFacts,readFilmSnapshot}=await import('../src/canonical-film-writers.js');
 await writeFilmFacts(w.env,{id:FILM,at:when,requestId:id,expectedRevision:(await readFilmSnapshot(w.env,FILM)).revision,film:{contractVersion:2},metadata:{updatedAt:when,ownerActions:[{action:'lock',field}]},metadataAuthority:{authority:'owner',origin:'owner_route'},requireExisting:true});
};

// the MANDATORY regression: core completes at `off` or `hold` having OBSERVED Russian while a nonblank English value is stored; once enforce permits it the upgrade becomes due and writes Russian with NO new observer signal
for(const middle of ['off','hold']){
 const w=await world();
 await step(w,upstream({tm:noRuMovie()}),at(10)); // the anchor check
 if(middle==='hold'){setMode(w.file,'enforce',2);setMode(w.file,'hold',3);}
 await step(w,upstream({tm:noRuMovie()}),at(11));
 assert.equal(meta(w.file).synopsis,'lb synopsis','Russian is verified absent, so the English (Letterboxd, assumed) synopsis is filled: '+middle);
 assert.equal(meta(w.file).poster,'https://img/lb.jpg');
 reopenCore(w.file); // a verified source change (the observer's causal reopen) brings the part back; Russian now exists
 const observed=await step(w,upstream({tm:ruMovie()}),at(12));
 assert.equal(observed.state,'done');
 assert.equal(meta(w.file).synopsis,'lb synopsis','neither off nor hold replaces a nonblank value: '+middle);
 assert.deepEqual(coreStatus(w.file),['complete','complete'],'core COMPLETES having observed Russian');
 assert.deepEqual(upgradeSignals(w.file).map(r=>[r.subject,r.state]),[[FILM,'pending']],'and ONE deferred inbox signal records the waiting Russian upgrade for the whole core part');
 assert.equal((await S.runnableSignals(w.env,{now:at(13),limit:50})).filter(x=>x.digest).length,0,'the signal is held while the mode is off or hold: no reopen, no scan');
 assert.equal((await step(w,upstream({tm:ruMovie()}),at(13))).state,'idle','a completed part is not fetched again');
 setMode(w.file,'enforce',middle==='hold'?4:2);
 assert.equal(await consumeUpgrades(w,at(14)),1,'once enforce permits it the signal is runnable and consumed by the existing guarded effect');
 assert.deepEqual(coreStatus(w.file),['due','due'],'the core rows are due again (plan epoch raised), with NO new observer signal');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n,0,'nothing else is armed: no extra queue');
 const done=await step(w,upstream({tm:ruMovie()}),at(15));
 assert.equal(done.state,'done');
 assert.equal(meta(w.file).synopsis,RU_SYNOPSIS,'the Russian synopsis replaces the English one: '+middle);
 assert.equal(meta(w.file).poster,RU_POSTER,'and the Russian poster replaces the English-source poster');
 assert.deepEqual(fieldRow(w.file,'synopsis'),{tier:'automatic',source:'tmdb',language:'ru',language_basis:'explicit',agreement:'confirmed'});
 assert.deepEqual(hist(w.file).sort(),['poster:replaced','synopsis:replaced'],'history keeps the replaced values');
 assert.equal(done.report.provenance.replacements,2);
 assert.deepEqual(upgradeSignals(w.file).map(r=>r.state),['consumed']);
 assert.equal((await step(w,upstream({tm:ruMovie()}),at(16))).state,'idle','an equal complete observation is a no-op and wakes nothing');
}
for(const scenario of ['unknown_observation','verified_ru','absence']){
 // P3-A: a genuinely unknown legacy value is kept against English or unknown-language observations, and replaced only by a confirmed Russian one; a verified absence preserves it
 const w=await world();
 assert.equal(sqlite(w.file,`INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES ('${FILM}',1,1999,136,'legacy text','https://img/legacy.jpg','https://letterboxd.com/film/the-matrix/','["Sci-Fi"]',0,'{}',NULL,NULL,'${T}')`).status,0);
 setMode(w.file,'enforce',2);
 const tm=scenario==='verified_ru'?ruMovie():noRuMovie();
 await step(w,upstream({tm}),at(10));
 const out=await step(w,upstream({tm}),at(11));
 if(scenario==='verified_ru'){assert.equal(meta(w.file).synopsis,RU_SYNOPSIS,'confirmed Russian replaces the unknown-language legacy value');assert.ok(hist(w.file).includes('synopsis:replaced'));}
 else{
  assert.equal(meta(w.file).synopsis,'legacy text','the unattributed legacy synopsis is preserved: '+scenario);assert.equal(meta(w.file).poster,'https://img/legacy.jpg');assert.deepEqual(hist(w.file),[],'no downgrade, no history');
  assert.ok(out.report.provenance.refusals.language_kept>=1,'the English observation was OFFERED and the writer refused and counted it (language_kept): '+JSON.stringify(out.report.provenance));
 }
}
{
 // no downgrade: a stored verified Russian value is never replaced by the English observation; an owner pin is never replaced and its refusal is counted
 const w=await enforceWorld();
 await step(w,upstream({tm:ruMovie()}),at(10));await step(w,upstream({tm:ruMovie()}),at(11));
 assert.equal(meta(w.file).synopsis,RU_SYNOPSIS,'enforce fills a blank synopsis with the Russian value directly (language before provider precedence)');
 assert.equal(fieldRow(w.file,'synopsis').language,'ru');
 reopenCore(w.file);
 const later=await step(w,upstream({tm:noRuMovie()}),at(12));
 assert.equal(meta(w.file).synopsis,RU_SYNOPSIS,'a verified Russian value is not downgraded by the English observation: '+later.state);
 assert.equal(hist(w.file).filter(item=>item.startsWith('synopsis')).length,0);
 await pinSynopsisOrRuntime(w,'synopsis',at(12),'owner-lock-1');
 assert.equal(fieldRow(w.file,'synopsis').tier,'owner');
 const before=rows(w.file,'SELECT COUNT(*) AS n FROM film_metadata_history')[0].n;
 reopenCore(w.file);
 const pinned=await step(w,upstream({tm:ruMovie({translations:trs('Другой русский синопсис')})}),at(13));
 assert.equal(meta(w.file).synopsis,RU_SYNOPSIS,'an owner-pinned field is never replaced by an automatic observation: '+pinned.state);
 assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM film_metadata_history')[0].n,before,'no history row for a pinned field');
 assert.ok(pinned.report.provenance.refusals.owner_kept>=1,'a refusal-only plan reports the refusal the writer counted');
 assert.ok(!pinned.report.written.includes('synopsis'),'and a refused offer is not "written"');
 assert.deepEqual(coreStatus(w.file),['complete','complete'],'a pin case settles');
 assert.equal((await step(w,upstream({tm:ruMovie()}),at(14))).state,'idle','and becomes idle');
}
{
 // pure planner table (ADR 0214 decision 5, ADR 0224): what the planner OFFERS the writer; the language is the typed observation's (`answer.language`)
 const answers=(lbSyn='lb',tmSyn='tm',tmLang=null)=>({letterboxd:{status:'ok',fields:{synopsis:lbSyn},language:{synopsis:'en'}},tmdb:{status:'ok',fields:{synopsis:tmSyn},language:{synopsis:tmLang}}});
 const plan=(provenance,stored,over={})=>Plan.planReplacements({provenance,applicable:['letterboxd','tmdb'],hasLetterboxdAnchor:true,agreed:true,stored:{synopsis:stored},answers:answers(...(over.args||[])),locked:false,fills:{},...over});
 const enforce=fields=>({mode:'enforce',fields:{synopsis:fields}});
 assert.equal(plan(enforce({name:'confirmed',language:'en'}),'old',{args:['lb','tm','ru']}).offers.synopsis.mode,'replace','ru over confirmed en is offered');
 assert.equal(plan(enforce({name:'confirmed',language:'ru'}),'old',{args:['lb','tm','ru']}).offers.synopsis.mode,'replace','a different Russian observation of a confirmed Russian value is OFFERED: the writer comparator decides, there is no second rank policy in the planner');
 assert.equal(plan(enforce({name:'confirmed',language:null}),'old',{args:['lb','tm']}).offers.synopsis.mode,'replace','a changed confirmed value is offered (owner refresh, changed source version)');
 assert.equal(plan(enforce({name:'unknown',language:null}),'old',{args:['lb','tm']}).offers.synopsis.language,'en','an English or unknown observation is offered too: the writer refuses it as language_kept and COUNTS the refusal');
 assert.equal(plan(enforce({name:'owner',language:'en'}),'old',{args:['lb','tm','ru']}).offers.synopsis.mode,'replace','an owner pin is offered so the writer counts owner_kept');
 assert.equal(plan(enforce({name:'unknown',language:null}),'old',{args:['lb','tm','ru'],agreed:false}).offers.synopsis,undefined,'an unconfirmed observation never replaces a nonblank value');
 assert.equal(plan(enforce({name:'unknown',language:null}),'old',{args:['lb','tm','ru'],locked:true}).offers.synopsis,undefined,'a locked metadata dimension plans nothing');
 assert.equal(plan({mode:'hold',fields:{synopsis:{name:'confirmed',language:'en'}}},'old',{args:['lb','tm','ru']}).pending[0].reason,'language_upgrade','hold records the pending upgrade, and offers nothing different');
 assert.equal(plan({mode:'off',fields:{}},'old',{args:['lb','tm','ru']}).pending[0].field,'synopsis','off records it too');
 assert.equal(plan({mode:'off',fields:{}},'old',{args:['lb','tm']}).pending.length,0,'no Russian observation, nothing pending');
 assert.equal(plan(enforce({name:'unknown',language:null}),'tm',{args:['lb','tm','ru']}).offers.synopsis.mode,'adopt','an equal Russian value is an adoption of its language evidence');
 const gone={letterboxd:{status:'ok',fields:{synopsis:null},language:{synopsis:null}},tmdb:{status:'ok',fields:{synopsis:null},language:{synopsis:null}}};
 const absentPlan=fields=>Plan.planReplacements({provenance:enforce(fields),applicable:['letterboxd','tmdb'],hasLetterboxdAnchor:true,agreed:true,stored:{synopsis:'old'},answers:gone,locked:false,fills:{}});
 assert.deepEqual(absentPlan({name:'superseded',language:null,source:'letterboxd'}).supersededKept,['synopsis'],'a superseded value with no observation is listed as superseded_kept');
 assert.equal(absentPlan({name:'confirmed',language:null,source:'tmdb'}).offers.synopsis.mode,'absent','the source that attributed the value and verifiably has none declares its absence (the writer counts source_absent and keeps the value)');
 assert.equal(absentPlan({name:'confirmed',language:null,source:null}).offers.synopsis,undefined,'an unattributed value is not declared absent');
}
{
 // a changed confirmed value (owner refresh or a changed source version) reaches the comparator; an equal one is a no-op; a lower-ranked source cannot replace
 const w=await enforceWorld();
 const base=()=>upstream({lb:lbPage({runtime:136}),tm:movie()});
 await step(w,base(),at(10));await step(w,base(),at(11));
 assert.equal(meta(w.file).runtime,136);
 assert.deepEqual(coreStatus(w.file),['complete','complete']);
 reopenCore(w.file);
 const same=await step(w,upstream({lb:lbPage({runtime:136}),tm:movie({runtime:90})}),at(12));
 assert.equal(meta(w.file).runtime,136,'an equal observation changes nothing and a lower-ranked source (tmdb 90) never replaces the confirmed Letterboxd value');
 assert.deepEqual(hist(w.file),[],'no history for an equal or refused observation');
 assert.deepEqual(coreStatus(w.file),['complete','complete'],'and the settled observation completes the parts: they do not stay due');
 assert.equal((await step(w,base(),at(13))).state,'idle','a successful no-change observation becomes idle');
 reopenCore(w.file);
 const changed=await step(w,upstream({lb:lbPage({runtime:140}),tm:movie()}),at(14));
 assert.equal(meta(w.file).runtime,140,'a changed confirmed Letterboxd value replaces the older confirmed one (same source, newer observation)');
 assert.deepEqual(hist(w.file),['runtime:replaced']);
 assert.ok(changed.report.provenance.replacements>=1&&changed.report.provenance.offered>=1,'attempted (offered) and committed (replacements) are distinct counts');
 assert.ok(changed.report.written.includes('runtime')&&!changed.report.written.includes('year'),'`written` names only what actually changed');
 assert.ok(same.report.provenance.offered>=1&&(same.report.provenance.replacements||0)===0,'an offered-but-equal observation commits nothing');
}
{
 // ru -> ru: a corrected Russian synopsis of the same source and confidence replaces the older one
 const w=await enforceWorld();
 await step(w,upstream({tm:ruMovie({translations:trs('Русский один')})}),at(10));await step(w,upstream({tm:ruMovie({translations:trs('Русский один')})}),at(11));
 assert.equal(meta(w.file).synopsis,'Русский один');
 reopenCore(w.file);
 await step(w,upstream({tm:ruMovie({translations:trs('Русский два')})}),at(12));
 assert.equal(meta(w.file).synopsis,'Русский два','a corrected Russian value of the same language replaces the older one');
 assert.ok(hist(w.file).includes('synopsis:replaced'));
}
{
 // ADR 0214 worked example 1: a 72 h fallback fills runtime 112 (unconfirmed); the earlier source recovers later and confirms 110 WITHOUT a manual reset
 const w=await enforceWorld();
 const down=upstream({lb:'transport',tm:movie({runtime:112})});
 await step(w,down,at(10));
 await step(w,down,at(11));
 assert.equal(meta(w.file),null,'inside the 72 h window nothing is filled: the earlier source is only pending');
 const later=at(11+73*3600);
 w.leaseId=(await S.acquireLease(w.env,{leaseId:'lease-fallback-aaaaaaaa',now:later})).leaseId; // the 5 minute lease of the first steps has expired by then
 await step(w,down,later);
 assert.equal(meta(w.file).runtime,112,'after 72 h of transport only, the next source fills through its own anchor');
 assert.equal(fieldRow(w.file,'runtime').agreement,'unconfirmed');
 const st=rows(w.file,"SELECT source,status,retry_at,pending_since FROM catalog_enrichment_state WHERE part='core' ORDER BY source");
 assert.deepEqual(st.map(r=>[r.source,r.status]),[['letterboxd','due'],['tmdb','complete']],'only the source that was observed settles; the Letterboxd core recovery stays durably runnable');
 assert.ok(st[0].retry_at&&st[0].pending_since,'with its retry and pending_since preserved');
 const recover=at(11+74*3600);
 w.leaseId=(await S.acquireLease(w.env,{leaseId:'lease-recover-aaaaaaaa',now:recover})).leaseId;
 await step(w,upstream({lb:lbPage({runtime:110}),tm:movie({runtime:112})}),recover);
 assert.equal(meta(w.file).runtime,110,'the recovered Letterboxd answer confirms 110 and replaces the unconfirmed 112');
 assert.equal(hist(w.file).filter(item=>item==='runtime:replaced').length,1);
 assert.equal(fieldRow(w.file,'runtime').agreement,'confirmed');
 assert.deepEqual(coreStatus(w.file),['complete','complete']);
}
{
 // a mixed response: Letterboxd answers, TMDB is transport-unavailable. Only the answered source settles; the other keeps its retry
 const w=await enforceWorld();
 await step(w,upstream({tm:movie()}),at(10));await step(w,upstream({tm:movie()}),at(11));
 reopenCore(w.file);
 await step(w,upstream({tm:'transport'}),at(12));
 const st=rows(w.file,"SELECT source,status,retry_at FROM catalog_enrichment_state WHERE part='core' ORDER BY source");
 assert.deepEqual(st.map(r=>[r.source,r.status]),[['letterboxd','complete'],['tmdb','due']],'the answered source settles, the transport-unavailable one stays due');
 assert.ok(st[1].retry_at,'with its backoff');
}
{
 // the source set changes (a source removed, then added again): the surviving core part reopens through the existing anchor-check plan epoch, and ONLY core (credits and localization stay settled)
 const w=await enforceWorld();
 const up=upstream({});
 await step(w,up,at(10));await step(w,up,at(11));
 const settledBefore=rows(w.file,"SELECT part||':'||source AS k,status FROM catalog_enrichment_state WHERE part IN ('credits','localization') AND source='letterboxd' ORDER BY k");
 assert.deepEqual(coreStatus(w.file),['complete','complete']);
 sqlite(w.file,"DELETE FROM film_external_id WHERE film_id='"+FILM+"' AND scheme='tmdb'");
 assert.equal((await step(w,up,at(12))).state,'replan');
 const afterRemove=rows(w.file,"SELECT source,status FROM catalog_enrichment_state WHERE part='core' ORDER BY source").map(r=>r.source+':'+r.status);
 assert.ok(afterRemove.includes('letterboxd:due'),'the surviving Letterboxd core part is due again after the source was removed: '+afterRemove);
 assert.equal((await step(w,up,at(13))).state,'done');
 assert.equal(rows(w.file,"SELECT status FROM catalog_enrichment_state WHERE part='core' AND source='letterboxd'")[0].status,'complete','and re-confirmed under the new anchors');
 assert.deepEqual(rows(w.file,"SELECT part||':'||source AS k,status FROM catalog_enrichment_state WHERE part IN ('credits','localization') AND source='letterboxd' ORDER BY k"),settledBefore,'independent settled parts of the surviving source are untouched');
 sqlite(w.file,"INSERT INTO film_external_id VALUES ('"+FILM+"','tmdb','603',1,0,NULL)");
 assert.equal((await step(w,up,at(14))).state,'replan');
 assert.equal(rows(w.file,"SELECT status FROM catalog_enrichment_state WHERE part='core' AND source='letterboxd'")[0].status,'due','adding a source reopens the surviving core part too');
}
{
 // an identity correction whose answer lacks the value: the old value is retained, listed (superseded_kept) and counted
 const w=await enforceWorld({lid:null});
 await step(w,upstream({tm:movie()}),at(10));await step(w,upstream({tm:movie()}),at(11));
 assert.equal(meta(w.file).runtime,136);
 sqlite(w.file,"UPDATE film_external_id SET value='604' WHERE film_id='"+FILM+"' AND scheme='tmdb'");
 assert.equal((await step(w,upstream({tm:movie({id:604,runtime:null})}),at(12))).state,'replan');
 const corrected=await step(w,upstream({tm:movie({id:604,runtime:null,release_date:'1987-01-01'})}),at(13));
 assert.equal(meta(w.file).runtime,136,'no confirmed runtime under the new identity: the old value stays');
 assert.equal(meta(w.file).year,1987,'a value the new identity does confirm replaces the superseded one');
 assert.ok(corrected.report.provenance.superseded_kept>=1,'the retained superseded value is counted');
 assert.ok(filmJson(w.file).supersededKept?.includes('runtime'),'and listed for the owner');
}
{
 // refusal-only and absence outcomes: an owner pin is refused and counted; a verified absence of the attributing source is counted as source_absent and never clears
 const w=await enforceWorld();
 await step(w,upstream({tm:movie()}),at(10));await step(w,upstream({tm:movie()}),at(11));
 assert.equal(fieldRow(w.file,'synopsis').source,'tmdb','the verified Russian synopsis is attributed to tmdb');
 reopenCore(w.file);
 const absent=await step(w,upstream({lb:lbPage({synopsis:''}),tm:noRuMovie()}),at(12));
 assert.equal(meta(w.file).synopsis,'tm synopsis','a verified absence never clears a stored value');
 assert.ok(absent.report.provenance.source_absent>=1,'the writer counted the verified absence: '+JSON.stringify(absent.report.provenance));
 await pinSynopsisOrRuntime(w,'runtime',at(13),'owner-lock-2');
 reopenCore(w.file);
 const pinned=await step(w,upstream({lb:lbPage({runtime:150}),tm:movie()}),at(14));
 assert.equal(meta(w.file).runtime,136,'the owner pin keeps its value');
 assert.ok(pinned.report.provenance.refusals.owner_kept>=1,'a refusal-only plan reports its refusals (the writer counted owner_kept)');
 assert.ok(!pinned.report.written.includes('runtime'),'and a refused offer is not "written"');
}
{
 // the held language signal: not runnable before enforce, held by a disabled scope and by a redirect, read through the existing indexed inbox index (no scan of the state table)
 const w=await world();
 await step(w,upstream({tm:noRuMovie()}),at(10));await step(w,upstream({tm:noRuMovie()}),at(11));
 reopenCore(w.file);
 await step(w,upstream({tm:ruMovie()}),at(12));
 assert.equal(upgradeSignals(w.file).length,1);
 assert.equal((await S.runnableSignals(w.env,{now:at(13),limit:50})).length,0,'not runnable at off');
 setMode(w.file,'enforce',2);
 sqlite(w.file,"UPDATE catalog_enrichment_scope SET enabled=0");
 assert.equal((await S.runnableSignals(w.env,{now:at(14),limit:50})).length,0,'held while the scope is disabled: the evidence is kept pending');
 assert.deepEqual(upgradeSignals(w.file).map(r=>r.state),['pending']);
 sqlite(w.file,"UPDATE catalog_enrichment_scope SET enabled=1");
 assert.equal((await S.runnableSignals(w.env,{now:at(15),limit:50})).length,1,'runnable once enforce and an enabled scope allow it');
 assert.equal(sqlite(w.file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',2,NULL,'O','"+T+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+FILM+"','film:other','"+T+"')").status,0);
 assert.equal((await S.runnableSignals(w.env,{now:at(16),limit:50})).length,0,'a redirected Film is not runnable');
 const plan=String(sqlite(w.file,"EXPLAIN QUERY PLAN SELECT s.kind FROM enrichment_signal s WHERE s.kind<>'admitted' AND s.state='pending' AND s.acked_version<s.version AND (s.retry_at IS NULL OR s.retry_at<='x') AND (s.cause_ref IS NOT 'language_upgrade' OR 1=1) ORDER BY s.armed_at LIMIT 50").stdout);
 assert.match(plan,/enrichment_signal_by_state/,'the inbox read uses its (state, armed_at) index: '+plan);
 assert.doesNotMatch(plan,/SCAN catalog_enrichment_state/,'and never scans the Film state table');
}

console.log('catalog enrichment producer: ok');
