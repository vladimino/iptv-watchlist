// Owner-triggered poster hydration for catalog records stored without a poster: a permanent maintenance route with no switch of
// its own (the former CATALOG_POSTER_HYDRATION is retired, ADR 0048). The dry run is read-only; execution runs under the resolver lease, takes the poster from TMDB detail by the verified id only and
// writes nothing but the `poster` field of both catalog copies with a compare-and-swap.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,puts=[],fetches=[],tmdb={};
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key,customMetadata:{}})),truncated:false};}
};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 fetch:async input=>{
  const url=String(input instanceof Request?input.url:input);fetches.push(url);
  const match=url.match(/^https:\/\/api\.themoviedb\.org\/3\/movie\/(\d+)\?language=ru-RU$/);
  const reply=match?tmdb[match[1]]:null;
  if(typeof reply==='function')return reply();
  if(!reply)return new Response('unexpected',{status:599});
  return new Response(JSON.stringify(reply),{status:200});
 }});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker;
const baseEnv={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
const post=async(body,env={},headers={})=>{const response=await worker.fetch(new Request('https://iptv.example/api/enrichment/catalog/posters',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),{...baseEnv,...env},{waitUntil(){}});return {status:response.status,body:await response.json()};};

const G1='11111111-1111-4111-8111-111111111111',G2='22222222-2222-4222-8222-222222222222',hour=3600000,now=Date.now();
const LIVE='epg/discovered-films.json',COPY='epg/generations/'+G1+'/discovered-films.json',LEASE='epg/resolver-lease.json',POINTER='epg/published-generation.json';
const film=(id,tmdbId,extra={})=>({id,tmdbId:String(tmdbId),canonicalIdentity:'tmdb:'+tmdbId,title:'Film '+id,original:'Original '+id,year:2001,runtime:100,genres:['Драма'],poster:null,url:'https://www.themoviedb.org/movie/'+tmdbId,aliases:['Alias '+id],directors:[{id:'tmdb_director/1',name:'D',original:'D'}],actors:[],shows:[{channelId:'c1',channel:'One',start:now-hour,end:now+hour}],showsProgrammeRunId:G1,discoveredAt:'2026-10-01T00:00:00.000Z',...extra});
const POSTER='https://image.tmdb.org/t/p/w342';
function seed(){
 records.clear();etags.clear();puts=[];fetches=[];
 const catalog={
  tmdb_1:film('tmdb_1',1),                                                     // legacy record without a poster
  tmdb_2:film('tmdb_2',2,{poster:POSTER+'/kept.jpg'}),                          // already has a poster
  tmdb_3:film('tmdb_3',3),                                                     // TMDB has no poster_path
  tmdb_4:film('tmdb_4',4),                                                     // TMDB fails
  tmdb_5:film('tmdb_5',5,{canonicalIdentity:null}),                            // unverified identity
  tmdb_6:film('tmdb_6',6),                                                     // TMDB answers for another id
  heat:film('heat',7,{poster:'http://insecure.example/x.jpg'}),                // a non-https value counts as missing
 };
 for(const key of [LIVE,COPY]){records.set(key,structuredClone(catalog));etags.set(key,'seed-'+key);}
 records.set(POINTER,{programmeRunId:G1,phase:'published'});etags.set(POINTER,'p1');
 records.set('epg/discovery-resolution.json',{'film|2001':{status:'verified',filmId:'tmdb_1',tmdbId:'1'}});etags.set('epg/discovery-resolution.json','r1');
 tmdb={1:{id:1,poster_path:'/one.jpg'},3:{id:3,poster_path:null},4:()=>new Response('boom',{status:500}),5:{id:5,poster_path:'/five.jpg'},6:{id:66,poster_path:'/other.jpg'},7:{id:7,poster_path:'/heat.jpg'}};
}
const snapshot=()=>JSON.stringify([...records.entries()].filter(([key])=>key!==LEASE).sort());
const without=(record,key)=>{const copy={...record};delete copy[key];return copy;};
const outcomeOf=(response,id)=>response.body.outcomes.find(item=>item.id===id);

// 1. Dry run (the default) reads and counts only, with the flag off or on.
seed();let before=snapshot(),r=await post({});
assert.equal(r.status,200);assert.equal(r.body.dryRun,true);assert.equal(r.body.enabled,true,'enabled stays in the answer and is always true');
assert.equal(r.body.programmeRunId,G1);assert.equal(r.body.catalogRecords,7);assert.equal(r.body.missingPoster,6);assert.equal(r.body.verifiedMissing,5);assert.equal(r.body.unverifiedMissing,1);
assert.deepEqual(Array.from(r.body.ids),['heat','tmdb_1','tmdb_3','tmdb_4','tmdb_6']);
assert.equal(snapshot(),before);assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
for(const value of ['on','off','ON',true]){r=await post({dryRun:true},{CATALOG_POSTER_HYDRATION:value});assert.equal(r.status,200);assert.equal(r.body.enabled,true,String(value));assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);}
// A record missing its poster in only one copy still counts once.
seed();records.get(COPY).tmdb_2.poster=null;r=await post({});assert.equal(r.body.missingPoster,7);assert.equal(r.body.verifiedMissing,6);

// 2. No switch: with no binding or a stale one of any value, execution runs the same way and writes the same catalog.
{
 const runs=[];
 for(const value of [undefined,'off','on','ON',' on',true,1]){
  seed();puts=[];fetches=[];r=await post({dryRun:false,limit:5},value===undefined?{}:{CATALOG_POSTER_HYDRATION:value});
  assert.equal(r.status,200,String(value));assert.notEqual(r.body.error,'Catalog poster hydration is off');assert.equal(r.body.hydrated,2,String(value));
  const {at:_at,...body}=r.body;runs.push(JSON.stringify([body,fetches.length,snapshot()]));
 }
 assert.equal(new Set(runs).size,1,'the binding changes nothing');
}
// 3. Input validation.
for(const body of [{dryRun:'false'},{dryRun:false,limit:0},{dryRun:false,limit:21},{dryRun:false,limit:1.5},{cursor:5}]){seed();r=await post(body,{});assert.equal(r.status,400,JSON.stringify(body));assert.deepEqual(puts,[]);}
// 4. Origin enforcement as for the sibling POST routes.
seed();r=await post({dryRun:false},{},{Origin:'https://evil.example'});assert.equal(r.status,403);assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
// 5. A live resolver lease refuses the run without TMDB calls or catalog writes.
seed();records.set(LEASE,{id:'discovery',expiresAt:Date.now()+60000});etags.set(LEASE,'l1');before=snapshot();
r=await post({dryRun:false,limit:5},{});
assert.equal(r.status,409);assert.equal(r.body.error,'Resolver is writing the catalog');assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);assert.equal(snapshot(),before);
// 6. No TMDB token, no run.
seed();r=await post({dryRun:false},{TMDB_API_READ_ACCESS_TOKEN:''});assert.equal(r.status,503);assert.deepEqual(puts,[]);

// 7. Execution: only the poster field of verified records without a poster changes, in both copies, under the lease.
seed();const original={live:structuredClone(records.get(LIVE)),copy:structuredClone(records.get(COPY))};
r=await post({dryRun:false,limit:5},{});
assert.equal(r.status,200,JSON.stringify(r.body));
const outcome=id=>r.body.outcomes.find(item=>item.id===id);
assert.equal(outcome('tmdb_1').outcome,'hydrated');assert.equal(outcome('tmdb_1').poster,POSTER+'/one.jpg');
assert.equal(outcome('heat').outcome,'hydrated','a non-https stored value is replaced by the TMDB asset');
assert.equal(outcome('tmdb_3').outcome,'no_poster_on_tmdb');
assert.equal(outcome('tmdb_4').outcome,'tmdb_failed');assert.match(outcome('tmdb_4').error,/TMDB HTTP 500/);
assert.equal(outcome('tmdb_6').outcome,'tmdb_id_mismatch');
assert.equal(outcome('tmdb_2'),undefined,'a record with a poster is not requested');
assert.equal(outcome('tmdb_5'),undefined,'an unverified identity is never requested');
assert.equal(fetches.filter(url=>url.includes('/movie/4?')).length,2,'one bounded retry for a failing request');
assert.equal(fetches.some(url=>url.includes('/movie/2?')||url.includes('/movie/5?')),false);
assert.equal(fetches.every(url=>url.startsWith('https://api.themoviedb.org/3/movie/')),true);
assert.equal(r.body.hydrated,2);assert.equal(r.body.processed,5);assert.equal(r.body.generationChanged,false);
assert.equal(r.body.done,false,'a transient TMDB failure keeps the sweep open');assert.deepEqual(Array.from(r.body.retryable),['tmdb_4']);
assert.equal(r.body.nextCursor,'tmdb_3','the cursor stops before the retryable record');assert.equal(r.body.remainingAfterCursor,2);
assert.deepEqual(Array.from(r.body.writes.map(write=>[write.key,write.written,write.records])),[[COPY,true,2],[LIVE,true,2]]);
for(const [key,before] of [[LIVE,original.live],[COPY,original.copy]]){
 const after=records.get(key);
 assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort());
 assert.equal(after.tmdb_1.poster,POSTER+'/one.jpg');assert.equal(after.heat.poster,POSTER+'/heat.jpg');
 for(const id of Object.keys(before)){
  assert.deepEqual(without(after[id],'poster'),without(before[id],'poster'),key+' '+id+' changes only its poster');
  if(!['tmdb_1','heat'].includes(id))assert.deepEqual(after[id],before[id],key+' '+id+' is untouched');
 }
}
assert.deepEqual([...new Set(puts)].sort(),[COPY,LEASE,LIVE].sort(),'only the two catalog copies and the lease are written');
assert.deepEqual(records.get(POINTER),{programmeRunId:G1,phase:'published'});
assert.deepEqual(records.get('epg/discovery-resolution.json'),{'film|2001':{status:'verified',filmId:'tmdb_1',tmdbId:'1'}});
assert.equal(records.get(LEASE).expiresAt,0,'the lease is released');
// A second run finds nothing new to hydrate for the hydrated records and writes no catalog copy.
puts=[];fetches=[];r=await post({dryRun:false,limit:5},{});
assert.equal(r.body.hydrated,0);assert.equal(fetches.some(url=>url.includes('/movie/1?')),false);assert.deepEqual(puts.filter(key=>key!==LEASE),[]);
// The read-only catalog route now serves the stored poster.
r=await post({});assert.equal(r.body.verifiedMissing,3);

// 8. Bounded batches with a cursor.
seed();r=await post({dryRun:false,limit:1},{});
assert.deepEqual(Array.from(r.body.outcomes.map(item=>item.id)),['heat']);assert.equal(r.body.nextCursor,'heat');assert.equal(r.body.remainingAfterCursor,4);
r=await post({dryRun:false,limit:2,cursor:'heat'},{});
assert.deepEqual(Array.from(r.body.outcomes.map(item=>item.id)),['tmdb_1','tmdb_3']);assert.equal(r.body.nextCursor,'tmdb_3');assert.equal(r.body.remainingAfterCursor,2);

// 9. A rate limit stops the batch before the limited record; the cursor does not skip it.
seed();tmdb[3]=()=>new Response('slow down',{status:429,headers:{'Retry-After':'120'}});
r=await post({dryRun:false,limit:5},{});
assert.deepEqual(Array.from(r.body.outcomes.map(item=>[item.id,item.outcome])),[['heat','hydrated'],['tmdb_1','hydrated'],['tmdb_3','rate_limited'],['tmdb_4','not_attempted'],['tmdb_6','not_attempted']]);
assert.equal(typeof r.body.retryAt,'string');assert.equal(r.body.nextCursor,'tmdb_1');assert.equal(r.body.remainingAfterCursor,3);
assert.equal(fetches.filter(url=>url.includes('/movie/3?')).length,1,'a rate limit is not retried');

// 10. An ETag change between read and write: a concurrent catalog write is re-read and kept, never overwritten.
seed();let raced=0;
const concurrent=async key=>{raced++;const current=structuredClone(records.get(key));current.tmdb_9=film('tmdb_9',9,{poster:POSTER+'/new.jpg'});current.tmdb_1={...current.tmdb_1,aliases:[...current.tmdb_1.aliases,'Concurrent alias']};records.set(key,current);etags.set(key,'concurrent-'+key);};
r=await post({dryRun:false,limit:5},{beforeCatalogPosterWrite:concurrent});
assert.equal(raced,1);
assert.equal(records.get(COPY).tmdb_9.poster,POSTER+'/new.jpg','the concurrent record survives');
assert.deepEqual(Array.from(records.get(COPY).tmdb_1.aliases),['Alias tmdb_1','Concurrent alias'],'the concurrent change to the same record survives');
assert.equal(records.get(COPY).tmdb_1.poster,POSTER+'/one.jpg','the poster is applied on the fresh read');
// A concurrent writer that already stored a poster for the record wins: hydration does not overwrite it.
seed();const claim=async key=>{const current=structuredClone(records.get(key));current.tmdb_1={...current.tmdb_1,poster:POSTER+'/discovery.jpg'};current.heat={...current.heat,poster:POSTER+'/discovery-heat.jpg'};records.set(key,current);etags.set(key,'claimed-'+key);};
r=await post({dryRun:false,limit:5},{beforeCatalogPosterWrite:claim});
assert.equal(records.get(COPY).tmdb_1.poster,POSTER+'/discovery.jpg');assert.equal(records.get(COPY).heat.poster,POSTER+'/discovery-heat.jpg');
assert.equal(r.body.writes.find(write=>write.key===COPY).written,false);assert.equal(r.body.writes.find(write=>write.key===COPY).reason,'nothing_to_apply');
assert.equal(records.get(LIVE).tmdb_1.poster,POSTER+'/one.jpg','the untouched live copy is still hydrated');
// A writer that keeps winning every compare-and-swap leaves the copy unwritten after the bounded retry.
seed();let storms=0;const stormEnv={};
const originalPut=bucket.put;bucket.put=async(key,value,options)=>{if(key===COPY&&options?.onlyIf?.etagMatches){storms++;etags.set(COPY,'storm-'+storms);}return originalPut(key,value,options);};
r=await post({dryRun:false,limit:5},stormEnv);bucket.put=originalPut;
assert.equal(storms,2);assert.equal(r.body.writes.find(write=>write.key===COPY).reason,'catalog_changed');assert.equal(records.get(COPY).tmdb_1.poster,null,'no overwrite after two lost races');

// 11. A generation published during the call: nothing is written to either copy.
seed();tmdb[1]=()=>{records.set(POINTER,{programmeRunId:G2,phase:'published'});etags.set(POINTER,'p2');return new Response(JSON.stringify({id:1,poster_path:'/one.jpg'}),{status:200});};
const beforeGeneration={live:JSON.stringify(records.get(LIVE)),copy:JSON.stringify(records.get(COPY))};
r=await post({dryRun:false,limit:5},{});
assert.equal(r.status,200);assert.equal(r.body.generationChanged,true);
assert.equal(JSON.stringify(records.get(COPY)),beforeGeneration.copy,'the old generation copy is untouched');
assert.equal(JSON.stringify(records.get(LIVE)),beforeGeneration.live,'the live catalog is untouched');
assert.equal(records.has('epg/generations/'+G2+'/discovered-films.json'),false,'no copy of the new generation is created');
assert.equal(r.body.outcomes.filter(item=>item.outcome==='generation_changed').length,2);
assert.equal(r.body.done,false);assert.equal(r.body.nextCursor,'','the sweep restarts from the first record, and null stays reserved for completion');assert.equal(r.body.remainingAfterCursor,5,'the batch is repeated on the next call');
assert.deepEqual(Array.from(r.body.writes.map(write=>[write.key,write.written,write.reason])),[[COPY,false,'generation_changed'],[LIVE,false,'generation_changed']]);
assert.deepEqual(puts.filter(key=>key!==LEASE),[]);

// 11b. The generation flips between the two writes: the generation copy is already written, the live catalog is not, and the
// response says so per copy and per record. The written poster is a correct asset of the verified id; the next call completes.
seed();let flipped=0;
const flip=async key=>{if(key!==COPY)return;flipped++;const originalPutFlip=bucket.put;bucket.put=async(k,v,o)=>{const saved=await originalPutFlip(k,v,o);if(k===COPY&&saved){records.set(POINTER,{programmeRunId:G2,phase:'published'});etags.set(POINTER,'p2');bucket.put=originalPutFlip;}return saved;};};
r=await post({dryRun:false,limit:5},{beforeCatalogPosterWrite:flip});
assert.equal(flipped,1);assert.equal(r.status,200);assert.equal(r.body.generationChanged,true);
assert.deepEqual(Array.from(r.body.writes.map(write=>[write.key,write.written,write.reason,write.records])),[[COPY,true,null,2],[LIVE,false,'generation_changed',0]]);
assert.equal(records.get(COPY).tmdb_1.poster,POSTER+'/one.jpg','the first copy keeps the written poster');
assert.equal(records.get(LIVE).tmdb_1.poster,null,'the live catalog is not written after the generation changed');
assert.equal(outcomeOf(r,'tmdb_1').outcome,'generation_changed');assert.deepEqual(Array.from(outcomeOf(r,'tmdb_1').writtenTo),[COPY]);
assert.equal(r.body.done,false);assert.equal(r.body.nextCursor,'');assert.equal(r.body.retryable.includes('tmdb_1'),true);
// Recovery: the next call (on the new generation) re-reads the live catalog and completes the missing copy.
records.set('epg/generations/'+G2+'/discovered-films.json',structuredClone(records.get(LIVE)));etags.set('epg/generations/'+G2+'/discovered-films.json','g2');
r=await post({dryRun:false,limit:5},{});
assert.equal(r.body.programmeRunId,G2);assert.equal(outcomeOf(r,'tmdb_1').outcome,'hydrated');assert.equal(records.get(LIVE).tmdb_1.poster,POSTER+'/one.jpg');

// 11c. The guard runs again after a lost compare-and-swap: a generation published during the race stops the retry.
seed();const raceFlip=async key=>{if(key!==COPY)return;const current=structuredClone(records.get(COPY));current.tmdb_9=film('tmdb_9',9);records.set(COPY,current);etags.set(COPY,'raced');records.set(POINTER,{programmeRunId:G2,phase:'published'});etags.set(POINTER,'p2');};
r=await post({dryRun:false,limit:5},{beforeCatalogPosterWrite:raceFlip});
assert.deepEqual(Array.from(r.body.writes.map(write=>[write.key,write.written,write.reason])),[[COPY,false,'generation_changed'],[LIVE,false,'generation_changed']]);
assert.equal(records.get(COPY).tmdb_1.poster,null);assert.equal(records.get(LIVE).tmdb_1.poster,null);

// 12. A lease lost before the write refuses the write.
seed();tmdb[1]=()=>{records.set(LEASE,{id:'stolen',expiresAt:Date.now()+60000});etags.set(LEASE,'stolen');return new Response(JSON.stringify({id:1,poster_path:'/one.jpg'}),{status:200});};
r=await post({dryRun:false,limit:5},{});
assert.equal(r.status,409);assert.equal(r.body.leaseLost,true);assert.match(r.body.error,/lease lost/);assert.deepEqual(puts.filter(key=>key!==LEASE),[]);
assert.deepEqual(Array.from(r.body.writes.map(write=>[write.key,write.written,write.reason])),[[COPY,false,'lease_lost'],[LIVE,false,'lease_lost']]);
assert.equal(records.get(LEASE).id,'stolen','the other holder keeps its lease');
// A lease lost between the two writes leaves the first copy written and reports it.
seed();const steal=async key=>{if(key!==COPY)return;const originalPutSteal=bucket.put;bucket.put=async(k,v,o)=>{const saved=await originalPutSteal(k,v,o);if(k===COPY&&saved){records.set(LEASE,{id:'stolen',expiresAt:Date.now()+60000});etags.set(LEASE,'stolen');bucket.put=originalPutSteal;}return saved;};};
r=await post({dryRun:false,limit:5},{beforeCatalogPosterWrite:steal});
assert.equal(r.status,409);assert.deepEqual(Array.from(r.body.writes.map(write=>[write.key,write.written,write.reason])),[[COPY,true,null],[LIVE,false,'lease_lost']]);
assert.equal(outcomeOf(r,'tmdb_1').outcome,'lease_lost');assert.deepEqual(Array.from(outcomeOf(r,'tmdb_1').writtenTo),[COPY]);
assert.equal(records.get(LIVE).tmdb_1.poster,null);

// 12b. A transient TMDB failure for one id, with records after it: nothing is reported done while it is outstanding, and the
// retry on the next call hydrates it. Terminal outcomes after it are not lost either.
seed();let flaky=0;tmdb[4]=()=>{flaky++;return flaky<=2?new Response('busy',{status:503}):new Response(JSON.stringify({id:4,poster_path:'/four.jpg'}),{status:200});};
tmdb[6]={id:6,poster_path:'/six.jpg'};
r=await post({dryRun:false,limit:20},{});
assert.equal(outcomeOf(r,'tmdb_4').outcome,'tmdb_failed');assert.equal(outcomeOf(r,'tmdb_6').outcome,'hydrated','a record after the failure is still handled');
assert.equal(r.body.done,false);assert.equal(r.body.nextCursor,'tmdb_3');assert.deepEqual(Array.from(r.body.retryable),['tmdb_4']);
r=await post({dryRun:false,limit:20,cursor:r.body.nextCursor},{});
assert.equal(outcomeOf(r,'tmdb_4').outcome,'hydrated','the retry hydrates the failed record');assert.equal(records.get(LIVE).tmdb_4.poster,POSTER+'/four.jpg');
assert.equal(r.body.done,true);assert.equal(r.body.nextCursor,null);assert.deepEqual(Array.from(r.body.retryable),[]);
// A fresh sweep after completion only meets terminal records, and reports done again.
r=await post({dryRun:false,limit:20},{});
assert.equal(r.body.hydrated,0);assert.equal(r.body.done,true);assert.deepEqual(Array.from(r.body.outcomes.map(item=>item.outcome)),['no_poster_on_tmdb']);
// A record that keeps failing never lets the sweep report done, however often it is called.
seed();tmdb[4]=()=>new Response('down',{status:503});tmdb[6]={id:6,poster_path:'/six.jpg'};
let cursorChain=null;for(let call=0;call<3;call++){r=await post({dryRun:false,limit:20,...(cursorChain===null?{}:{cursor:cursorChain})},{});assert.equal(r.body.done,false);assert.equal(r.body.nextCursor,'tmdb_3');cursorChain=r.body.nextCursor;}
assert.deepEqual(Array.from(r.body.retryable),['tmdb_4']);

// 13. Without a published pointer only the live catalog is read and written.
seed();records.delete(POINTER);records.delete(COPY);r=await post({},{});assert.equal(r.body.programmeRunId,null);assert.equal(r.body.catalogRecords,7);
r=await post({dryRun:false,limit:5},{});
assert.deepEqual(Array.from(r.body.writes.map(write=>write.key)),[LIVE]);assert.equal(records.get(LIVE).tmdb_1.poster,POSTER+'/one.jpg');

// 15. The expected-generation fence: a call bound to G1 is refused once G2 is published, before any TMDB request and any write.
for(const value of ['',5,null,'x'.repeat(201),{id:G1}]){seed();r=await post({dryRun:false,limit:5,expectedProgrammeRunId:value},{});assert.equal(r.status,400,JSON.stringify(value));assert.equal(r.body.error,'Invalid expectedProgrammeRunId');assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);}
const COPY2='epg/generations/'+G2+'/discovered-films.json';
const publishG2=()=>{records.set(COPY2,structuredClone(records.get(LIVE)));etags.set(COPY2,'g2-copy');records.set(POINTER,{programmeRunId:G2,phase:'published'});etags.set(POINTER,'p2');};
// A matching fence changes nothing about the call.
seed();r=await post({dryRun:false,limit:1,expectedProgrammeRunId:G1},{});
assert.equal(r.status,200);assert.equal(r.body.programmeRunId,G1);assert.deepEqual(Array.from(r.body.outcomes.map(item=>[item.id,item.outcome])),[['heat','hydrated']]);
// G1 → G2 between two calls: the second call, still bound to G1, makes no TMDB request, takes no lease and writes nothing.
publishG2();puts=[];fetches=[];before=snapshot();
const g2Before=JSON.stringify(records.get(COPY2));
r=await post({dryRun:false,limit:1,cursor:'heat',expectedProgrammeRunId:G1},{});
assert.equal(r.status,409);assert.equal(r.body.error,'Programme generation changed');assert.equal(r.body.generationChanged,true);assert.equal(r.body.leaseLost,false);
assert.equal(r.body.expectedProgrammeRunId,G1);assert.equal(r.body.programmeRunId,G2);assert.equal(r.body.outcomes,undefined);
assert.deepEqual(fetches,[],'no TMDB request for the rejected call');assert.deepEqual(puts,[],'no write at all, not even the lease');
assert.equal(snapshot(),before);assert.equal(JSON.stringify(records.get(COPY2)),g2Before,'the G2 copy is untouched');
// The dry run honours the same fence.
r=await post({dryRun:true,expectedProgrammeRunId:G1},{});assert.equal(r.status,409);assert.equal(r.body.dryRun,true);assert.equal(r.body.generationChanged,true);assert.deepEqual(puts,[]);
// No published generation is a mismatch too.
seed();records.delete(POINTER);puts=[];fetches=[];r=await post({dryRun:false,limit:5,expectedProgrammeRunId:G1},{});
assert.equal(r.status,409);assert.equal(r.body.programmeRunId,null);assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
// G2 published while the lease is taken: the fence is checked again under the lease, before TMDB; only the lease is touched.
seed();{
 const originalPutLease=bucket.put;
 bucket.put=async(key,value,options)=>{const saved=await originalPutLease(key,value,options);if(key===LEASE&&JSON.parse(value).expiresAt>0&&records.get(POINTER).programmeRunId===G1){publishG2();}return saved;};
 r=await post({dryRun:false,limit:5,expectedProgrammeRunId:G1},{});bucket.put=originalPutLease;
}
assert.equal(r.status,409);assert.equal(r.body.generationChanged,true);assert.equal(r.body.programmeRunId,G2);
assert.deepEqual(fetches,[],'no TMDB request after the generation changed under the lease');
assert.deepEqual([...new Set(puts)],[LEASE],'only the lease is acquired and released');assert.equal(records.get(LEASE).expiresAt,0,'the lease is released');
assert.equal(records.get(COPY2).tmdb_1.poster,null);assert.equal(records.get(COPY).tmdb_1.poster,null);assert.equal(records.get(LIVE).tmdb_1.poster,null);
// The page's sweep carries the fence on every call, the first included, and stops on the refusal with nothing sent to G2.
{
 const {runPosterSweep}=await import('../src/admin/posters-run.js');
 seed();const bodies=[],calls=[];
 const call=async body=>{bodies.push(structuredClone(body));const mark={fetches:fetches.length,puts:puts.length};const answer=await post(body,{});calls.push({fetches:fetches.slice(mark.fetches),puts:puts.slice(mark.puts)});if(bodies.length===1)publishG2();return {ok:answer.status===200,status:answer.status,body:answer.body};};
 const receipt=await runPosterSweep({confirmation:{programmeRunId:G1,cursor:null,limit:1,calls:5},call,now:()=>Date.now()});
 assert.equal(receipt.stop,'generation_changed');assert.equal(receipt.calls.length,2);
 assert.deepEqual(bodies.map(body=>body.expectedProgrammeRunId),[G1,G1],'every call carries the confirmed generation');
 assert.equal(calls[0].fetches.length,1);assert.deepEqual(calls[1].fetches,[],'the refused call made no TMDB request');assert.deepEqual(calls[1].puts,[],'the refused call wrote nothing');
 assert.equal(etags.get(COPY2),'g2-copy','nothing reached the G2 copy');assert.equal(records.get(COPY2).tmdb_1.poster,null);
}

// 16. Every outcome carries the record's display fields from the catalog already read: bounded title text and an integer year.
seed();records.get(LIVE).tmdb_6.title='x'.repeat(500);records.get(LIVE).tmdb_3.title={html:'<b>'};records.get(LIVE).tmdb_3.year='2001';
fetches=[];r=await post({dryRun:false,limit:5},{});
assert.deepEqual(Array.from(r.body.outcomes.map(item=>[item.id,item.outcome,item.title===null?null:item.title.length,item.year])),[['heat','hydrated',9,2001],['tmdb_1','hydrated',11,2001],['tmdb_3','no_poster_on_tmdb',null,null],['tmdb_4','tmdb_failed',11,2001],['tmdb_6','tmdb_id_mismatch',200,2001]]);
assert.equal(outcomeOf(r,'tmdb_1').title,'Film tmdb_1');
assert.equal(fetches.every(url=>url.startsWith('https://api.themoviedb.org/3/movie/')),true,'no extra request for the display fields');
seed();tmdb[3]=()=>new Response('slow down',{status:429,headers:{'Retry-After':'120'}});
r=await post({dryRun:false,limit:5},{});
assert.deepEqual(Array.from(r.body.outcomes.filter(item=>item.outcome!=='hydrated').map(item=>[item.outcome,item.title])),[['rate_limited','Film tmdb_3'],['not_attempted','Film tmdb_4'],['not_attempted','Film tmdb_6']]);

// 14. Route inventory: the hydration is a POST only; GET is not a route.
const get=await worker.fetch(new Request('https://iptv.example/api/enrichment/catalog/posters'),{...baseEnv},{waitUntil(){}});
assert.equal(get.status,404);

console.log('Catalog posters: read-only dry run, no switch (stale bindings inert), origin and input checks, resolver lease, verified ids only, poster-only writes in both copies, bounded retry and rate limit, a cursor that never passes a retryable record and a truthful done, ETag races without overwrite, generation and lease re-checked at every write with partial writes reported, and an expected-generation fence that refuses a G1-bound call on G2 before TMDB and before any write');
