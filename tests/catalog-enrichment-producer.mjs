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
async function world({lid='abc',tmdb='603',control=true}={}){
 const file=path.join(root,'w-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 for(const text of [VERIFY,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",BASELINE])assert.equal(sqlite(file,text).status,0);
 assert.equal(sqlite(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${FILM}',2,NULL,'Kept','${T}');`+(tmdb?`INSERT INTO film_external_id VALUES ('${FILM}','tmdb','${tmdb}',1,0,NULL);`:'')+(lid?`INSERT INTO film_external_id VALUES ('${FILM}','letterboxd','${lid}',1,0,NULL);`:'')+"DELETE FROM enrichment_signal;").status,0);
 const env={DB:d1Standin(file)};
 let generation=0;
 if(control){
  assert.equal(sqlite(file,`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'${T}');INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:${tmdb||'0'}','rated','',1,'pending','${T}');`).status,0);
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
const movie=(over={})=>({id:603,release_date:'1999-03-30',runtime:136,overview:'tm synopsis',poster_path:'/p.jpg',genres:[{name:'Action'}],credits:{cast:[{id:11,name:'T Neo',order:0}],crew:[{id:12,name:'T Lana',job:'Director'}]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица'}}]},...over});
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
 assert.deepEqual(meta(w.file),{year:1999,runtime:136,synopsis:'lb synopsis',poster:'https://img/lb.jpg',url:'https://letterboxd.com/film/the-matrix/',genres_json:'["Sci-Fi"]'},'Letterboxd fills every blank core field first (precedence)');
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
 await step(rec,upstream({tm:movie({translations:{}})}),at(11));
 const retry=part=>rows(rec.file,`SELECT retry_at FROM catalog_enrichment_state WHERE film_id='film:tmdb:900' AND source='tmdb' AND part='${part}'`)[0].retry_at;
 assert.equal(retry('core'),null,'a valid core section wakes the deferred core items of other Films');
 assert.equal(retry('localization'),FAR,'an UNRELATED section does not wake it: this response\'s translations were unreadable');
 assert.equal(retry('credits'),FAR,'the bound: an item attempted a moment ago is not woken, so repeated successes cannot hot-loop it');
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
console.log('catalog enrichment producer: ok');
