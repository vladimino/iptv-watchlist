// AIR-605: the pure planner of the Catalog Enrichment Producer (src/catalog-enrichment-plan.js; ADR 0211 as amended by ADR 0219). Offline, synthetic ids only. The SQL guards run on the real migrated schema.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as P from '../src/catalog-enrichment-plan.js';

const T0='2026-11-26T10:00:00.000Z';
const ago=hours=>new Date(Date.parse(T0)-hours*3600000).toISOString();
const ok=fields=>({status:'ok',fields});
const FULL_LB={year:1999,runtime:120,synopsis:'lb synopsis',poster:'lb.jpg',url:'https://letterboxd.com/film/x/',genres:['Драма']};
const FULL_TM={year:1999,runtime:121,synopsis:'tm synopsis',poster:'tm.jpg',url:'https://www.themoviedb.org/movie/1',genres:['Drama']};
const core=(over={})=>P.decideCore({applicable:['letterboxd','tmdb','wikidata'],hasLetterboxdAnchor:true,agreed:true,disagreement:false,stored:{},answers:{letterboxd:ok(FULL_LB),tmdb:ok(FULL_TM)},pendingSince:{},now:T0,...over});
const writtenFrom=plan=>Object.fromEntries(Object.entries(plan.writes).map(([field,item])=>[field,item.source]));

// ---- anchors ----
{
 const row=(scheme,value,extra={})=>({scheme,value,trusted:1,conflicting:0,otherOwner:false,retired:false,...extra});
 const both=P.computeAnchors([row('tmdb','10'),row('letterboxd','abc')]);
 assert.deepEqual([both.tmdb,both.letterboxd],[{scheme:'tmdb',value:'10'},{scheme:'letterboxd',value:'abc'}]);
 assert.deepEqual(P.applicableSources(both),['letterboxd','tmdb','wikidata']);
 assert.deepEqual(P.applicableSources(P.computeAnchors([row('letterboxd','abc')])),['letterboxd'],'a Letterboxd-only Film needs no TMDB claim');
 assert.deepEqual(P.applicableSources(P.computeAnchors([row('tmdb','10')])),['tmdb','wikidata'],'no Letterboxd anchor is invented');
 assert.deepEqual(P.applicableSources(P.computeAnchors([row('tmdb','10',{retired:true})])),[],'a retired id is no anchor');
 assert.equal(P.computeAnchors([row('tmdb','10',{otherOwner:true})]).tmdb,null,'another owner of the value: no anchor');
 assert.equal(P.computeAnchors([row('tmdb','10'),row('tmdb','11')]).tmdb,null,'two trusted values of one scheme: ambiguous, no anchor');
 assert.equal(P.computeAnchors([row('tmdb','10',{conflicting:1})]).tmdb,null,'a conflicting claim is no anchor');
 assert.equal(P.computeAnchors([{...row('tmdb','10'),trusted:0}]).tmdb,null,'an untrusted claim is no anchor');
 const d1=await P.anchorDigest(P.computeAnchors([row('tmdb','10')])),d2=await P.anchorDigest(P.computeAnchors([row('tmdb','10')])),d3=await P.anchorDigest(P.computeAnchors([row('tmdb','10',{otherOwner:true})])),d4=await P.anchorDigest(P.computeAnchors([row('tmdb','11')]));
 assert.equal(d1,d2,'deterministic');
 assert.notEqual(d1,d3,'a competing owner moves the digest (the `holds` bit)');
 assert.notEqual(d1,d4,'a corrected value moves the digest');
 assert.equal(await P.anchorDigest(P.computeAnchors([row('letterboxd','a'),row('tmdb','1')])),await P.anchorDigest(P.computeAnchors([row('tmdb','1'),row('letterboxd','a')])),'order of rows does not matter');
}

// ---- core: precedence, both completion orders, waiting ----
{
 const lbFirst=core();
 assert.deepEqual(writtenFrom(lbFirst),{year:'letterboxd',runtime:'letterboxd',synopsis:'letterboxd',poster:'letterboxd',url:'letterboxd',genres:'letterboxd'},'Letterboxd fills every blank field first');
 assert.equal(lbFirst.complete,true);
 assert.deepEqual(lbFirst.conflicts,[],'runtime 120 vs 121 is within five minutes');
 const tmdbFirst=core({answers:{tmdb:ok(FULL_TM)}});
 assert.deepEqual(tmdbFirst.writes,{},'TMDB first: nothing is written, every field waits for precedence');
 assert.ok(CORE_ALL(tmdbFirst.waiting,'waiting_for_precedence'),'with the reason and the source waited for');
 assert.equal(tmdbFirst.waiting.year.source,'letterboxd');
 // Letterboxd later lacks the synopsis (absent in a successful response): TMDB fills only that one.
 const lbLacks=core({answers:{letterboxd:ok({...FULL_LB,synopsis:null}),tmdb:ok(FULL_TM)}});
 assert.equal(lbLacks.writes.synopsis.source,'tmdb','a confirmed absence lets the next source fill at once');
 assert.equal(lbLacks.writes.year.source,'letterboxd');
 // fill-only: stored values are never overwritten, a different answer is only listed
 const stored=core({stored:{year:2001,runtime:90}});
 assert.equal(stored.writes.year,undefined);assert.equal(stored.writes.runtime,undefined);
 assert.deepEqual(stored.storedDiffers.map(item=>item.field+':'+item.source).sort(),['runtime:letterboxd','runtime:tmdb','year:letterboxd','year:tmdb']);
 // value conflict between sources: precedence still decides, the conflict stays listed
 const conflict=core({answers:{letterboxd:ok({...FULL_LB,year:2000}),tmdb:ok(FULL_TM)}});
 assert.equal(conflict.writes.year.value,2000);
 assert.deepEqual(conflict.conflicts,[{field:'year',values:{letterboxd:2000,tmdb:1999}}]);
 assert.deepEqual(core({answers:{letterboxd:ok({...FULL_LB,runtime:130}),tmdb:ok(FULL_TM)}}).conflicts.map(item=>item.field),['runtime'],'runtime beyond five minutes conflicts');
 assert.deepEqual(core({answers:{letterboxd:ok({...FULL_LB,poster:'a',url:'a',genres:['x']}),tmdb:ok(FULL_TM)}}).conflicts,[],'poster, url and genres are not compared');
}
function CORE_ALL(waiting,reason){return P.CORE_FIELDS.every(field=>waiting[field]?.reason===reason);}

// ---- transport, the 72 h fallback, failures, disagreement ----
{
 const lbDown={letterboxd:{status:'transport'},tmdb:ok(FULL_TM)};
 const early=core({answers:lbDown,pendingSince:{letterboxd:ago(71)}});
 assert.deepEqual(early.writes,{},'Letterboxd unavailable for under 72 h: TMDB waits');
 const late=core({answers:lbDown,pendingSince:{letterboxd:ago(72)},agreed:true});
 assert.deepEqual(writtenFrom(late),{year:'tmdb',runtime:'tmdb',synopsis:'tmdb',poster:'tmdb',url:'tmdb',genres:'tmdb'},'after 72 h of upstream transport TMDB fills');
 assert.equal(late.fallbackFill.length,6);assert.deepEqual(late.fallbackFill[0],{field:'year',source:'tmdb',waitedFor:'letterboxd'});
 assert.deepEqual(late.unconfirmedAgreement,[],'agreement already recorded: not unconfirmed');
 const unconfirmed=core({answers:lbDown,pendingSince:{letterboxd:ago(100)},agreed:false});
 assert.equal(unconfirmed.unconfirmedAgreement.length,6,'without a confirmed agreement every fallback field is listed for review');
 assert.deepEqual(core({answers:{tmdb:ok(FULL_TM)},pendingSince:{letterboxd:ago(100)},agreed:false}).fallbackFill.length,6,'a source that was never reached but has an old transport pending_since is unavailable too');
 // no pending_since (this tick stopped, never reached): nothing counts toward 72 h
 assert.deepEqual(core({answers:{letterboxd:{status:'stopped'},tmdb:ok(FULL_TM)},pendingSince:{}}).writes,{},'a local stop grants no fallback');
 // failed / 404 / invalid: no fallback, however old
 const failed=core({answers:{letterboxd:{status:'failed'},tmdb:ok(FULL_TM)},pendingSince:{letterboxd:ago(500)}});
 assert.deepEqual(failed.writes,{},'a failed source grants no fallback');
 assert.equal(failed.waiting.year.reason,'failed_source');
 // no agreement and no fallback: waits for the agreement
 assert.equal(core({agreed:false}).waiting.year.reason,'waiting_for_agreement','a Film with a Letterboxd anchor needs the recorded agreement');
 assert.deepEqual(core({agreed:false,hasLetterboxdAnchor:false,applicable:['tmdb','wikidata'],answers:{tmdb:ok(FULL_TM)}}).writes.year,{source:'tmdb',value:1999},'no Letterboxd anchor: no agreement is needed');
 // a known disagreement blocks everything, before and after 72 h
 for(const pendingSince of [{},{letterboxd:ago(200)}]){
  const blocked=core({disagreement:true,answers:lbDown,pendingSince});
  assert.equal(blocked.blocked,'identity_disagreement');assert.deepEqual(blocked.writes,{});
 }
 // a Letterboxd-only Film is enriched from Letterboxd alone
 const only=core({applicable:['letterboxd'],answers:{letterboxd:ok(FULL_LB)}});
 assert.equal(Object.keys(only.writes).length,6);assert.equal(only.complete,true);
 // complete with gaps: every applicable source answered and none had the field
 const gaps=core({answers:{letterboxd:ok({...FULL_LB,runtime:null}),tmdb:ok({...FULL_TM,runtime:null})}});
 assert.deepEqual(gaps.gaps,['runtime']);assert.equal(gaps.complete,true);
 // a pending source keeps the part open
 assert.equal(core({answers:{letterboxd:ok({...FULL_LB,runtime:null}),tmdb:{status:'transport'}}}).complete,false);
 // both orders give the same writes
 const orderA=core({answers:{letterboxd:ok(FULL_LB),tmdb:ok(FULL_TM)}}).writes,orderB=core({answers:{tmdb:ok(FULL_TM),letterboxd:ok(FULL_LB)}}).writes;
 assert.deepEqual(orderA,orderB);
}

// ---- failure classes, backoff, outcomes ----
{
 assert.deepEqual([1,2,3,6,7].map(n=>P.transportDelayMs(n)/60000),[15,30,60,480,480],'15 min · 2^min(streak − 1, 5), at most 8 h');
 for(const status of [403,429,500,503])assert.equal(P.classifyFailure({status}),'transport');
 for(const kind of ['cooldown','timeout','network','challenge'])assert.equal(P.classifyFailure({kind}),'transport');
 assert.equal(P.classifyFailure({status:404}),'repairable','a 404 is availability, never identity');
 assert.equal(P.classifyFailure({kind:'parse'}),'repairable');
 assert.equal(P.classifyFailure({kind:'identity_disagreement'}),'owner_required');
 assert.equal(P.classifyFailure({kind:'ambiguous_translation'}),'owner_required');
 assert.deepEqual([1,5,6,7,8,9,40].map(n=>P.repairDelayMs(n)/3600000),[0.25,4,1,6,24,24,24],'1 h, 6 h, then 24 h for ever; never a terminal state');
 const row={status:'due',failures:0,transportStreak:0,pendingSince:null};
 const t1=P.afterOutcome(row,{type:'transport'},T0);
 assert.deepEqual([t1.transportStreak,t1.pendingSince,t1.failures],[1,T0,0],'transport: streak and pending_since, no failure');
 const t2=P.afterOutcome({...t1},{type:'transport',cooldownUntil:new Date(Date.parse(T0)+3*3600000).toISOString()},ago(-1));
 assert.equal(t2.pendingSince,T0,'pending_since is kept by later transport outcomes');
 assert.ok(Date.parse(t2.retryAt)>=Date.parse(T0)+3*3600000,'retry_at is the later of the backoff and the shared cooldown');
 assert.deepEqual(P.afterOutcome(t2,{type:'local_stop'},T0),t2,'a handover, yield, pause or resource stop changes nothing: pending_since, streak and failures stay');
 const ok2=P.afterOutcome(t2,{type:'success'},T0);
 assert.deepEqual([ok2.pendingSince,ok2.transportStreak,ok2.retryAt],[null,0,null],'a successful valid response clears pending_since');
 let repair=row;for(let i=0;i<5;i++)repair=P.afterOutcome(repair,{type:'repairable',signature:'parse'},T0);
 assert.equal(repair.status,'due');
 repair=P.afterOutcome(repair,{type:'repairable',signature:'parse'},T0);
 assert.deepEqual([repair.status,repair.failures],['deferred_repair',6],'the sixth repairable failure defers it, it is not needs_attention');
 assert.equal(repair.pendingSince,null,'a definite failure clears pending_since and never leads to the fallback');
 assert.equal(P.afterOutcome(row,{type:'owner_required'},T0).status,'needs_attention');
 assert.equal(P.fallbackElapsed(null,T0),false);assert.equal(P.fallbackElapsed(ago(72),T0),true);assert.equal(P.fallbackElapsed(ago(71.9),T0),false);
}

// ---- credits ----
{
 const lb=n=>Array.from({length:n},(_,i)=>({role:'actor',key:'slug'+i,name:'A'+i}));
 assert.deepEqual(P.creditSource([],['letterboxd','tmdb','wikidata']),{source:'letterboxd',gap:null},'no credits: Letterboxd if anchored');
 assert.deepEqual(P.creditSource([],['tmdb','wikidata']),{source:'tmdb',gap:null});
 assert.deepEqual(P.creditSource(['person:actor/a'],['letterboxd','tmdb']),{source:'letterboxd',gap:null},'the namespace of the existing credits decides');
 assert.deepEqual(P.creditSource(['person:tmdb_actor/1'],['letterboxd','tmdb']),{source:'tmdb',gap:null});
 assert.deepEqual(P.creditSource(['person:tmdb_actor/1'],['letterboxd']),{source:null,gap:null},'that source is not applicable: nothing is written');
 assert.deepEqual(P.creditSource(['person:actor/a','person:tmdb_director/2'],['letterboxd','tmdb']),{source:null,gap:'credits_other_namespace'},'both namespaces: nothing written, gap visible');
 const exp=P.expectedCredits('letterboxd',[...lb(3),{role:'director',key:'dir',name:'D'},{role:'actor',key:null,name:'Name Only',nameOnly:true},{role:'actor',key:'slug0'},{role:'producer',key:'p'}]);
 assert.deepEqual(exp.items.map(item=>item.personId+'|'+item.role),['person:actor/slug0|actor','person:actor/slug1|actor','person:actor/slug2|actor','person:director/dir|director']);
 assert.deepEqual(exp.gaps,[{gap:'name_only_credit',name:'Name Only'}],'a name-only credit is a gap, never written; duplicates and other roles dropped');
 assert.equal(P.expectedCredits('tmdb',[{role:'actor',key:'5'}]).items[0].personId,'person:tmdb_actor/5');
 // a large cast: no 10/20/30 cap, stable chunks of at most 50
 const big=P.expectedCredits('tmdb',[...lb(140),{role:'director',key:'d1'},{role:'director',key:'d2'}]);
 assert.equal(big.items.length,142);
 const chunks=P.chunkCredits(big.items);
 assert.deepEqual(chunks.map(chunk=>[chunk.slot,chunk.items.length]),[[0,50],[1,50],[2,42]]);
 assert.deepEqual(P.chunkCredits(big.items).map(chunk=>chunk.items[0].personId),chunks.map(chunk=>chunk.items[0].personId),'stable on replay');
 assert.equal(P.chunkCredits(P.expectedCredits('tmdb',lb(10)).items).length,1,'a small cast is one chunk');
 assert.equal(await P.expectedDigest(big.items),await P.expectedDigest(P.expectedCredits('tmdb',[...lb(140),{role:'director',key:'d1'},{role:'director',key:'d2'}]).items));
 assert.notEqual(await P.expectedDigest(big.items),await P.expectedDigest(big.items.slice(1)),'a changed expected set changes the digest');
 // legacy partial coverage is never complete
 const have=new Set(big.items.slice(0,10).map(item=>item.personId+'|'+item.role));
 assert.equal(P.creditsComplete(chunks,have),false,'ten exist, 142 expected: not complete');
 const missing=P.missingForChunk(chunks[0],{have,people:new Set(big.items.slice(0,20).map(item=>item.personId))});
 assert.equal(missing.credits.length,40);assert.equal(missing.persons.length,30,'persons that do not exist yet are created first; no per-Film cap');
 assert.equal(P.creditsComplete(chunks,new Set(big.items.map(item=>item.personId+'|'+item.role))),true);
}

// ---- 2A: translations ----
{
 const tr=(...entries)=>({translations:entries.map(([iso,region,title])=>({iso_639_1:iso,iso_3166_1:region,data:{title}}))});
 assert.deepEqual(P.selectRussianTitle(tr(['ru','RU','Матрица'],['de','DE','Matrix'])),{status:'value',value:'Матрица'});
 assert.deepEqual(P.selectRussianTitle(tr(['ru','RU','Матрица'],['ru','UA','Матрица'])),{status:'value',value:'Матрица'},'the same distinct title twice is one value');
 assert.deepEqual(P.selectRussianTitle(tr(['ru','RU','Матрица'],['ru','UA','Нео'])),{status:'value',value:'Матрица'},'several entries are decided by RU');
 assert.deepEqual(P.selectRussianTitle(tr(['ru','BY','А'],['ru','UA','Б'])),{status:'ambiguous'});
 assert.deepEqual(P.selectRussianTitle(tr(['de','DE','x'])),{status:'absent'});
 assert.deepEqual(P.selectRussianTitle(tr(['ru','RU','  '])),{status:'absent'},'a blank title is an absence');
 assert.deepEqual(P.selectRussianTitle(undefined),{status:'unreadable'});
 assert.deepEqual(P.selectRussianTitle({translations:'x'}),{status:'unreadable'});
 assert.deepEqual(P.selectRussianTitle({translations:[{iso_639_1:'ru',iso_3166_1:'RU'}]}),{status:'unreadable'},'a malformed entry is unreadable, never complete');
}

// ---- priority ----
{
 const set=(...v)=>new Set(v);
 assert.equal(P.priorityClass({cohorts:set('live')}),'live','unknown is not false');
 assert.equal(P.priorityClass({cohorts:set('live'),personal:false,available:false}),'background','a known absence of both');
 assert.equal(P.priorityClass({cohorts:set('live'),personal:false,available:null}),'live');
 assert.equal(P.priorityClass({cohorts:set('history')}),'background','history-only with unknown facts');
 assert.equal(P.priorityClass({cohorts:set('history'),personal:true}),'live','a positive fact promotes any cohort');
 assert.equal(P.priorityClass({cohorts:set('history','live'),personal:false,available:false}),'background');
 assert.equal(P.nextClass({hasLive:false,hasBackground:false}),null);
 assert.equal(P.nextClass({hasLive:false,hasBackground:true}),'background');
 assert.equal(P.nextClass({hasLive:true,hasBackground:false}),'live');
 let live=0,bg=0;for(let i=0;i<80;i++){const next=P.nextClass({hasLive:true,hasBackground:true,committedLive:live,committedBackground:bg});if(next==='live')live++;else bg++;}
 assert.deepEqual([live,bg],[70,10],'about one committed unit in eight is background under sustained live load, measured in committed units');
 // a permanently failing head leaves the window by retry_at, so a runnable row behind it is reached
 const rows=Array.from({length:200},(_,i)=>({id:i,dueSince:i,retryAt:i<60?'2099-01-01T00:00:00.000Z':null}));
 assert.equal(P.examineWindow(rows,T0,50)[0].id,60,'60 failing rows ahead never block the first runnable one');
 assert.equal(P.examineWindow(rows,T0,50).length,50,'examined work is bounded by k');
}

// ---- the SQL guards on the real migrated schema ----
{
 const file=migrated();
 const run=text=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r;};
 const holds=({sql,params})=>{const bound=sql.replace(/\?/g,()=>{const v=params.shift();return typeof v==='number'?String(v):"'"+String(v).replace(/'/g,"''")+"'";});const r=sqliteSync(['-bail',file],{input:'SELECT CASE WHEN '+bound+' THEN 1 ELSE 0 END;',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return String(r.stdout).trim()==='1';};
 const rowsOf=filmId=>JSON.parse(String(sqliteSync(['-json',file],{input:`SELECT scheme,value,trusted,conflicting FROM film_external_id WHERE film_id='${filmId}' AND scheme IN ('tmdb','letterboxd')`,encoding:'utf8'}).stdout||'[]')).map(r=>({...r,otherOwner:false,retired:false}));
 run(`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:a',2,NULL,'A','${T0}'),('film:b',2,NULL,'B','${T0}');INSERT INTO film_external_id VALUES ('film:a','tmdb','10',1,0,NULL),('film:a','letterboxd','abc',1,0,NULL);`);
 const anchors=P.computeAnchors(rowsOf('film:a'));
 assert.equal(holds(P.anchorSetGuard('film:a',anchors)),true,'the plan holds');
 run("INSERT INTO film_external_id VALUES ('film:a','tmdb','11',1,0,NULL);");
 assert.equal(holds(P.anchorSetGuard('film:a',anchors)),false,'an anchor added while an old plan runs fails the old plan');
 run("DELETE FROM film_external_id WHERE film_id='film:a' AND value='11';INSERT INTO film_external_id VALUES ('film:b','tmdb','10',1,1,NULL);");
 assert.equal(holds(P.anchorSetGuard('film:a',anchors)),false,'another Film taking the same value (trusted, even conflicting) fails it');
 run("DELETE FROM film_external_id WHERE film_id='film:b';");
 assert.equal(holds(P.anchorSetGuard('film:a',anchors)),true,'releasing it restores the guard');
 run("INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) VALUES ('r1','film:a','retire','abc','10','11','{}','{\"by\":\"owner\",\"at\":\"x\",\"source\":\"y\"}','owner_request',NULL,NULL,'{}','"+T0+"');");
 assert.equal(holds(P.anchorSetGuard('film:a',anchors)),false,'a retirement fails it');
 run("INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) VALUES ('r2','film:a','restore','abc','10','11','{}','{\"by\":\"owner\",\"at\":\"x\",\"source\":\"y\"}','owner_request',NULL,1,'{}','"+T0+"');");
 assert.equal(holds(P.anchorSetGuard('film:a',anchors)),true,'a restore lifts it');
 // field, epoch, lease and control guards
 assert.equal(holds(P.blankFieldGuard('film:a','year')),true,'no metadata row: blank');
 run(`INSERT INTO film_metadata (film_id,schema_version,year,genres_json,payload_json,updated_at) VALUES ('film:a',1,1999,'[]','{}','${T0}');`);
 assert.equal(holds(P.blankFieldGuard('film:a','year')),false,'a stored year makes the fill-only guard fail');
 assert.equal(holds(P.blankFieldGuard('film:a','genres')),true,'empty genres are blank');
 assert.throws(()=>P.blankFieldGuard('film:a','bogus'));
 run(`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,plan_epoch,due_since,updated_at) VALUES ('film:a','film','*',0,'active',3,'${T0}','${T0}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,refresh_epoch,due_since,updated_at) VALUES ('film:a','core','tmdb',0,'due',2,'${T0}','${T0}');`);
 assert.equal(holds(P.epochGuard('film:a',{part:'core',source:'tmdb',refreshEpoch:2,planEpoch:3})),true);
 assert.equal(holds(P.epochGuard('film:a',{part:'core',source:'tmdb',refreshEpoch:2,planEpoch:2})),false,'a raised plan epoch (retry, resume, anchor check) fails an older plan');
 assert.equal(holds(P.epochGuard('film:a',{part:'core',source:'tmdb',refreshEpoch:1,planEpoch:3})),false,'so does a raised refresh epoch');
 run(`INSERT INTO projection_run (projection,lease_id,lease_until) VALUES ('catalog_enrichment','L1','2026-11-26T11:00:00.000Z');`);
 assert.equal(holds(P.leaseGuard('L1',T0)),true);assert.equal(holds(P.leaseGuard('L2',T0)),false,'another lease id');assert.equal(holds(P.leaseGuard('L1','2026-11-26T12:00:00.000Z')),false,'an expired lease');
 assert.equal(holds(P.controlGuard(1)),false,'no control row: not active');
 run(`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T0}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;`);
 assert.equal(holds(P.controlGuard(1)),true);
 run("UPDATE catalog_enrichment_control SET state='paused',generation=2,revision=3;");
 assert.equal(holds(P.controlGuard(1)),false,'a pause fails every in-flight batch');
 run("UPDATE catalog_enrichment_control SET state='active',generation=3,revision=4;");
 assert.equal(holds(P.controlGuard(1)),false,'a resume raises the generation too: the stale plan stays refused');
 assert.equal(holds(P.controlGuard(3)),true);
}
assert.ok(fs.existsSync('src/catalog-enrichment-plan.js'));
console.log('catalog enrichment plan: ok');
