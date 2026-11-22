// AIR-541 (ADR 0177): the production bundle against an instrumented sqlite D1 and R2, with D1 failures injected at each stage. Only a typed TEMPORARY failure is answered
// from the mirrors, read-only and labelled; structural refusals, a fence and authoritative absence keep their status; a healthy D1 never reads a mirror; every write is
// refused for a degraded origin and no GET/HEAD writes. Local stand-ins only; nothing calls Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {loadBundle,buildScenario,root,SITE} from './get-write-audit-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import {MemoryBucket} from './memory-bucket.mjs';

const bundle=await loadBundle(),scenario=await buildScenario('d1');
const RUN='22222222-2222-4222-8222-222222222222';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
const link=id=>({status:'resolved',link:{type:'movie',id:Number(id)}});
const film=(id,tmdb,title,year=2020)=>({id,tmdbId:String(tmdb),title,original:title,year,runtime:100,genres:[],directors:[],actors:[],tmdbLink:link(tmdb),shows:[]});
const PAST='2026-11-19T10:00:00.000Z';
const mirrorProgramme=films=>({runId:RUN,updatedAt:PAST,watchlistCount:films.length,films,stats:{}});

class Bucket extends MemoryBucket{
 constructor(){super();this.writes=[];this.gets=[];this.lists=0;}
 async put(key,body,options){this.writes.push('put:'+key);return super.put(key,body,options);}
 async delete(key){this.writes.push('delete:'+key);return super.delete(key);}
 async get(key){this.gets.push(key);return super.get(key);}
 async list(options){this.lists++;return super.list(options);}
}
const MIRROR_KEYS=key=>key==='programme.json'||key==='watchlist.json'||key==='epg/published-generation.json'||/^epg\/generations\/[^/]+\/(programme|watchlist)\.json$/.test(key);
let counter=0;
// `fail(sql)` throws a D1-style error for a statement; `mirrors(bucket)` replaces what R2 holds; `prepare(db)` changes the database before the request.
async function call(pathname,{init={},fail=null,message='D1 DB is overloaded',mirrors=null,prepare=null,open=true}={}){
 const file=path.join(root,'m'+(counter++)+'.sqlite');fs.copyFileSync(scenario.dbFile,file);
 if(open)d1Standin(file).sql(OPEN);
 if(prepare)prepare(d1Standin(file));
 const bucket=new Bucket();
 // The scenario's own R2 side has current mirrors of its published generation; each case here states exactly which mirror objects exist, so they are not copied.
 for(const [key,item] of scenario.snapshot)if(!MIRROR_KEYS(key))bucket.objects.set(key,{text:item.text,customMetadata:{}});
 if(mirrors)mirrors(bucket);
 const writes=[];
 const db=d1Standin(file,{onQuery:async text=>{if(/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(text))writes.push(text.slice(0,60));if(fail&&fail(text))throw new Error(typeof message==='function'?message(text):message);}});
 const env={BUCKET:bucket,DB:db,TMDB_API_READ_ACCESS_TOKEN:'t',EPG_CHECKPOINT_DB_OPTIONAL:'standin'};
 const events=[];const log=console.log;console.log=(...args)=>{try{events.push(JSON.parse(args[0]));}catch{}};
 let response;try{response=await bundle.worker.fetch(new Request(SITE+pathname,init),env,{waitUntil(){}});}finally{console.log=log;}
 const text=await response.text();let body=null;try{body=JSON.parse(text);}catch{}
 return {status:response.status,body,headers:response.headers,bucket,writes,events};
}
const put=(bucket,key,value)=>bucket.objects.set(key,{text:typeof value==='string'?value:JSON.stringify(value),customMetadata:{}});
const seed=({programme=mirrorProgramme([film('tmdb_42',42,'Mirror film')]),watchlist={updatedAt:PAST,films:[film('tmdb_42',42,'Mirror film')]},rootToo=true}={})=>bucket=>{
 put(bucket,'epg/published-generation.json',{programmeRunId:RUN,phase:'published'});
 if(programme){put(bucket,'epg/generations/'+RUN+'/programme.json',programme);if(rootToo)put(bucket,'programme.json',programme);}
 if(watchlist){put(bucket,'epg/generations/'+RUN+'/watchlist.json',watchlist);if(rootToo)put(bucket,'watchlist.json',watchlist);}
};
const documentSelect=sql=>/FROM published_epg_document/.test(sql);

// ---- healthy D1: the normal answer, no mirror read at all, no write, shape unchanged ----
for(const route of ['/api/programme','/api/watchlist']){
 const healthy=await call(route,{mirrors:seed()});
 assert.equal(healthy.status,200,route);assert.equal(healthy.body.source,undefined,route+' healthy body has no degraded field');assert.equal(healthy.body.readOnly,undefined);
 assert.equal(healthy.headers.get('X-Data-Origin'),null);
 assert.deepEqual(healthy.bucket.gets.filter(MIRROR_KEYS),[],route+': no mirror object is read on a healthy D1');assert.equal(healthy.bucket.lists,0,'no R2 list');
 assert.deepEqual(healthy.bucket.writes,[],route+' no R2 write');assert.deepEqual(healthy.writes,[],route+' no D1 write');
}
{
 const film42=await call('/api/catalog/film/42',{mirrors:seed()});
 assert.ok(film42.status===404||film42.status===200||film42.status===503);
 assert.deepEqual(film42.bucket.gets.filter(MIRROR_KEYS),[],'a healthy film read does not touch the mirrors');
}

// ---- marker read succeeds, a LATER SELECT fails transiently: answered from the mirrors ----
{
 const r=await call('/api/programme',{mirrors:seed(),fail:documentSelect});
 assert.equal(r.status,200);assert.equal(r.body.source,'mirror');assert.equal(r.body.readOnly,true);assert.equal(r.body.runId,RUN);assert.equal(r.body.asOf,PAST);
 assert.equal(r.body.joined,'best_effort');assert.equal(r.body.availability,'unverified');assert.equal(r.body.reason,'published_epg_unavailable');
 assert.equal(r.body.films[0].title,'Mirror film');assert.equal(r.headers.get('X-Data-Origin'),'mirror');
 assert.deepEqual(r.bucket.writes,[],'a degraded GET writes no R2 object');assert.deepEqual(r.writes,[],'and no D1 row');
 const kinds=r.events.map(event=>event.event);assert.ok(kinds.includes('mirror_fallback_activated'),'the activation is an event');
 assert.ok(!JSON.stringify(r.events).includes('Mirror film'),'events carry no film data');
}
{
 const r=await call('/api/watchlist',{mirrors:seed(),fail:documentSelect});
 assert.equal(r.status,200);assert.equal(r.body.source,'mirror');assert.equal(r.body.films[0].id,'tmdb_42');assert.equal(r.body.readOnly,true);assert.deepEqual(r.bucket.writes,[]);
}
// The marker itself failing transiently is the same.
{
 const r=await call('/api/programme',{mirrors:seed(),fail:sql=>/FROM published_epg_authority/.test(sql)});
 assert.equal(r.status,200);assert.equal(r.body.source,'mirror');
}
// ---- partial availability: only a programme, only a watchlist, one corrupt object, pointer behind the root ----
{
 const onlyProgramme=await call('/api/programme',{mirrors:seed({watchlist:null}),fail:documentSelect});
 assert.equal(onlyProgramme.status,200);assert.equal(onlyProgramme.body.joined,'none');assert.equal(onlyProgramme.body.films.length,1);
 const onlyWatchlist=await call('/api/programme',{mirrors:seed({programme:null}),fail:documentSelect});
 assert.equal(onlyWatchlist.status,200);assert.equal(onlyWatchlist.body.scheduleUnavailable,true);assert.equal(onlyWatchlist.body.runId,null);assert.equal(onlyWatchlist.body.films[0].shows.length,0);
 const corrupt=await call('/api/programme',{mirrors:bucket=>{seed()(bucket);put(bucket,'epg/generations/'+RUN+'/programme.json','{"runId":"'+RUN+'","films":[');},fail:documentSelect});
 assert.equal(corrupt.status,200,'a corrupt generation copy falls to the valid root programme');assert.equal(corrupt.body.source,'mirror');
 assert.ok(corrupt.events.some(event=>event.event==='mirror_validation_failed'&&event.reason==='invalid_json'));
 const lagging=await call('/api/programme',{mirrors:bucket=>{seed({rootToo:true})(bucket);put(bucket,'epg/published-generation.json',{programmeRunId:'11111111-1111-4111-8111-111111111111',phase:'published'});bucket.objects.delete('epg/generations/'+RUN+'/programme.json');bucket.objects.delete('epg/generations/'+RUN+'/watchlist.json');},fail:documentSelect});
 assert.equal(lagging.status,200,'a root programme valid by its own runId is used although the pointer is behind');assert.equal(lagging.body.runId,RUN);assert.equal(lagging.body.joined,'none');
 const nothing=await call('/api/programme',{mirrors:bucket=>{put(bucket,'programme.json','not json');},fail:documentSelect});
 assert.ok(nothing.status===502||nothing.status===503,'no usable mirror object keeps today\'s refusal, never an invented programme');assert.equal(nothing.body?.films,undefined);assert.ok(nothing.events.some(event=>event.event==='mirror_fallback_unusable'));
}
// ---- structural / authority refusals never reach the mirrors ----
{
 const structural=[
  ['a marker that is not d1/open (ADR 0162)',{prepare:db=>db.sql("UPDATE published_epg_authority SET cutover='held'")}],
  ['a missing table',{fail:documentSelect,message:'D1_ERROR: no such table: published_epg_document: SQLITE_ERROR'}],
  ['a missing column',{fail:documentSelect,message:'D1_ERROR: no such column: payload_json at offset 7: SQLITE_ERROR'}],
  ['a syntax error',{fail:documentSelect,message:'D1_ERROR: near "SELEC": syntax error at offset 0: SQLITE_ERROR'}],
 ];
 for(const [name,options] of structural){
  const r=await call('/api/programme',{mirrors:seed(),...options});
  assert.notEqual(r.status,200,name+': not answered from a mirror');assert.equal(r.body?.source,undefined,name);assert.ok(![...r.bucket.gets].some(MIRROR_KEYS),name+': the mirrors were not read');
 }
}
// A fence keeps its 409 retry; it is not answered from a mirror on first sight.
{
 const r=await call('/api/programme',{mirrors:seed(),fail:documentSelect,message:()=>'CHECK constraint failed: published_epg_fence'});
 assert.notEqual(r.body?.source,'mirror');
}

// ---- Film/Person title SELECT fails AFTER the marker and the published documents were read: temporary, so the mirrors answer; the same code from a structural cause does not ----
{
 const titleSelect=sql=>/SELECT d\.film_id AS film_id,d\.value AS value/.test(sql);
 const temporary=await call('/api/programme',{mirrors:seed(),fail:titleSelect});
 assert.equal(temporary.status,200);assert.equal(temporary.body.source,'mirror');assert.equal(temporary.body.reason,'canonical_read_unavailable');assert.deepEqual(temporary.bucket.writes,[]);
 const watchlist=await call('/api/watchlist',{mirrors:seed(),fail:titleSelect});
 assert.equal(watchlist.status,200);assert.equal(watchlist.body.source,'mirror');
 const structural=await call('/api/programme',{mirrors:seed(),fail:titleSelect,message:'D1_ERROR: no such column: provenance_json at offset 7: SQLITE_ERROR'});
 assert.equal(structural.status,503);assert.equal(structural.body.reason,'canonical_read_unavailable');assert.equal(structural.body.source,undefined);assert.ok(![...structural.bucket.gets].some(MIRROR_KEYS),'a structural cause never reads a mirror');
}

// ---- the film page (C1) ----
{
 const down=sql=>/FROM discovery_admission/.test(sql);
 const found=await call('/api/catalog/film/42',{mirrors:seed(),fail:down})
 assert.equal(found.status,200,'a film proven by the mirrors is shown, not an error page');assert.equal(found.body.status,'found');assert.equal(found.body.source,'mirror');assert.equal(found.body.readOnly,true);
 assert.equal(found.body.film.tmdbId,'42');assert.equal(found.body.film.canonicalIdentity,'tmdb:42');assert.equal(found.body.film.title,'Mirror film');
 assert.ok(found.body.degraded.includes('predictions'));assert.equal(found.body.availability,'unverified');assert.deepEqual(found.bucket.writes,[]);
 // Two valid copies with different titles: one identity, a deterministic candidate, no shell.
 const varied=await call('/api/catalog/film/42',{mirrors:bucket=>{seed({programme:mirrorProgramme([film('tmdb_42',42,'Programme name',2021)]),watchlist:{updatedAt:PAST,films:[film('tmdb_42',42,'Watchlist name',2020)]}})(bucket);},fail:down});
 assert.equal(varied.status,200);assert.equal(varied.body.film.title,'Programme name');assert.deepEqual(varied.body.disputedAttributes,['title','year']);
 // A Discovery-only film (in no mirror): the typed 503, never 404/410/409.
 const only=await call('/api/catalog/film/777',{mirrors:seed(),fail:down});
 assert.equal(only.status,503);assert.equal(only.body.status,'unavailable');assert.equal(only.body.source,undefined);
 // A contradictory identity key: unproven, still the honest 503.
 const clash=await call('/api/catalog/film/5',{mirrors:bucket=>{seed({programme:mirrorProgramme([film('w1',5,'A'),film('w2',5,'B')]),watchlist:null})(bucket);},fail:down});
 assert.equal(clash.status,503);
 // A held Discovery or Film/Person marker is a structural refusal: no mirror.
 const held=await call('/api/catalog/film/42',{mirrors:seed(),prepare:db=>db.sql("UPDATE discovery_authority SET cutover='held'")});
 assert.equal(held.body?.source,undefined);assert.ok([503,500].includes(held.status));
 // Authoritative absence stays 404 on a healthy D1 even when a mirror holds a film of that id.
 const absent=await call('/api/catalog/film/42',{mirrors:seed()});
 assert.notEqual(absent.body?.source,'mirror');
}

// A film that only an OLDER generation copy still lists is shown with the provenance of that run; a film in no recent copy keeps the typed 503.
{
 const down=sql=>/FROM discovery_admission/.test(sql);
 const OLD='33333333-3333-4333-8333-333333333333';
 const older=programme=>bucket=>{seed()(bucket);put(bucket,'epg/generations/'+OLD+'/programme.json',{...mirrorProgramme([film('tmdb_88',88,'Only in the older run')]),runId:OLD,updatedAt:'2026-11-15T10:00:00.000Z'});};
 const r=await call('/api/catalog/film/88',{mirrors:older(),fail:down});
 assert.equal(r.status,200);assert.equal(r.body.source,'mirror');assert.equal(r.body.film.title,'Only in the older run');assert.equal(r.body.provenance.runId,OLD);assert.equal(r.body.runId,OLD);
 assert.deepEqual(r.bucket.writes,[]);
 const none=await call('/api/catalog/film/89',{mirrors:older(),fail:down});assert.equal(none.status,503);
}

// ---- the write fence ----
{
 const post=(body,headers={})=>({init:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}});
 for(const [route,body] of [['/api/started',{id:'w1',started:true}],['/api/catalog/watched',{tmdbId:'42',watched:true}],['/api/ui/filter-presets',{name:'x',query:'q'}],['/api/events/bootstrap',{}]]){
  const refused=await call(route,{...post(body,{'X-Data-Origin':'mirror'}),mirrors:seed()});
  assert.equal(refused.status,409,route+': a degraded-origin write is refused even though D1 is healthy');assert.equal(refused.body.code,'degraded_origin_write_refused');
  assert.deepEqual(refused.bucket.writes,[],route+' no R2 write');assert.deepEqual(refused.writes,[],route+' no D1 write');
  const bad=await call(route,{...post(body,{'X-Data-Origin':'anything-else'}),mirrors:seed()});assert.equal(bad.status,409,route+' an unknown origin label is refused too');
 }
 // PATCH and DELETE are fenced as well.
 for(const method of ['PATCH','DELETE','PUT']){
  const refused=await call('/api/ui/filter-presets/p1',{init:{method,headers:{'X-Data-Origin':'mirror','Content-Type':'application/json'},body:method==='DELETE'?undefined:'{}'}});
  assert.equal(refused.status,409,method);
 }
 // GET/HEAD are never fenced: a degraded page may read.
 assert.equal((await call('/api/started',{init:{headers:{'X-Data-Origin':'mirror'}}})).status,200);
 // Expected run: a mismatch is a 409, a match proceeds to the handler, an unreadable pin is a 503, a malformed value a 400.
 const stale=await call('/api/started',{...post({id:'w1',started:true},{'X-Expected-Run':'11111111-1111-4111-8111-111111111111'}),mirrors:seed()});
 assert.equal(stale.status,409);assert.equal(stale.body.code,'published_generation_changed');assert.deepEqual(stale.bucket.writes,[]);
 const malformed=await call('/api/started',{...post({id:'w1',started:true},{'X-Expected-Run':'bad value!'})});assert.equal(malformed.status,400);
 const unreadable=await call('/api/started',{...post({id:'w1',started:true},{'X-Expected-Run':RUN}),fail:sql=>/FROM published_epg_authority/.test(sql)});
 assert.equal(unreadable.status,503);assert.equal(unreadable.body.code,'published_epg_unavailable');
 const same=await call('/api/started',{...post({id:'bad id!',started:true},{'X-Expected-Run':RUN})});
 assert.equal(same.status,400,'a matching run reaches the handler (which refuses the invalid id)');
 // Normal mode (no header) is untouched: the handler's own validation answers.
 const normal=await call('/api/started',post({id:'bad id!',started:true}));assert.equal(normal.status,400);
 const authoritative=await call('/api/started',post({id:'bad id!',started:true},{'X-Data-Origin':'authoritative'}));assert.equal(authoritative.status,400);
 // With D1 down a direct POST is the existing typed refusal with no R2 write and no mirror read (the write path has no mirror fallback).
 const down=await call('/api/catalog/watched',{...post({tmdbId:'42',watched:true}),fail:()=>true,mirrors:seed()});
 assert.notEqual(down.status,200);assert.deepEqual(down.bucket.writes,[],'no PUT while D1 is down');assert.deepEqual(down.bucket.gets.filter(MIRROR_KEYS),[],'a write never reads a mirror');
}
// ---- recovery: after a degraded answer the next authoritative read is normal and emits ONE recovery event (one per window and route, so it is not spam) ----
{
 const first=await call('/api/watchlist',{mirrors:seed(),fail:documentSelect});assert.equal(first.body.source,'mirror');
 const second=await call('/api/watchlist',{mirrors:seed()});
 assert.equal(second.body.source,undefined);assert.ok(second.events.some(event=>event.event==='mirror_fallback_recovered'&&event.route==='watchlist'),'one recovery event');
 const third=await call('/api/watchlist',{mirrors:seed()});assert.ok(!third.events.some(event=>event.event==='mirror_fallback_recovered'),'and no more');
 // Repeated degraded answers inside the window log the activation once.
 const a=await call('/api/watchlist',{mirrors:seed(),fail:documentSelect}),b=await call('/api/watchlist',{mirrors:seed(),fail:documentSelect});
 assert.ok(!a.events.some(event=>event.event==='mirror_fallback_activated'),'the first watchlist activation of this window was already logged above');assert.ok(!b.events.some(event=>event.event==='mirror_fallback_activated'),'activation events are rate limited');
}
console.log('mirror fallback routes: healthy D1 reads no mirror, temporary faults degrade read-only, structural refusals do not, partial mirrors render, the write fence holds, recovery is clean');
process.exit(0);
