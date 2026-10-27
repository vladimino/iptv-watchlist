// The owner's «Смотрел» mark on a Finds card (ADR-0032): POST /api/catalog/watched writes only the owner's `watched` fact for one
// verified film of the published catalog copy, named by its TMDB id; no title, year or Letterboxd id is read. Covers the ADR's
// specification cases on the server and the card button, undo and immediate hiding in the client. Synthetic data only.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,puts=[],raceOnce=null;
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(raceOnce&&raceOnce.key===key){const race=raceOnce;raceOnce=null;await race.run();}
  const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};
 },
 async delete(key){puts.push('delete:'+key);records.delete(key);},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key,customMetadata:{}})),truncated:false};}
};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 fetch:async()=>{throw new Error('unexpected fetch');}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8'),context);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker,constant=name=>vm.runInContext(name,context),Facts=constant('LetterboxdFacts');
const VIEW=constant('ENRICHMENT_KEY')+'view-index.json',ORIGIN='https://iptv.vladimino.workers.dev',G1='11111111-1111-4111-8111-111111111111',G2='22222222-2222-4222-8222-222222222222';
const ON={BUCKET:bucket,LETTERBOXD_FACTS:'on',FINDS_WATCHED_MARK:'on'};
const hour=3600000,now=Date.now();
const current={prediction:{predictedRating:4.5,probability4Plus:.9,confidence:'high',matchSignals:[],mainRisk:null,tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1},fingerprintHash:'f',fingerprint:{fingerprintHash:'f',plotMechanics:[],execution:{}}};
const film=(n,title,extra={})=>({id:'tmdb_'+n,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,title,original:title,year:2000,runtime:100,genres:[],poster:null,url:null,directors:[],actors:[],shows:[{channelId:'c1',channel:'One',start:now-hour,end:now+hour}],...extra});
const CATALOG={tmdb_10:film(10,'Ten'),tmdb_11:film(11,'Eleven'),tmdb_12:film(12,'Twelve'),tmdb_13:film(13,'Thirteen'),obs:{id:'heat|1995',title:'Heat',year:1995},tmdb_14:film(14,'Conflicted',{canonicalIdentity:'conflict:14'})};
function seed({generation=G1,catalog=CATALOG}={}){
 records.clear();etags.clear();puts=[];raceOnce=null;
 const put=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
 put('epg/published-generation.json',{phase:'published',programmeRunId:generation});
 put('epg/generations/'+generation+'/programme.json',{runId:generation,films:[]});
 put('epg/generations/'+generation+'/discovered-films.json',Object.fromEntries(Object.entries(catalog).map(([id,item])=>[id,{...item,showsProgrammeRunId:generation}])));
 put('watchlist.json',{films:[]});
 put(constant('profileKey'),{version:1,profileHash:'p1'});
 put(VIEW,Object.fromEntries(Object.keys(catalog).filter(id=>id.startsWith('tmdb_')).map(id=>[id,current])));
}
const mark=async(body,{env=ON,origin=ORIGIN,type='application/json',method='POST',raw=null}={})=>{
 const headers={};if(origin)headers.Origin=origin;if(type)headers['Content-Type']=type;
 const response=await worker.fetch(new Request(ORIGIN+'/api/catalog/watched',{method,headers,body:method==='GET'?undefined:raw??JSON.stringify(body)}),env,{waitUntil(){}});
 return {status:response.status,body:await response.json()};
};
const available=async(env=ON)=>(await (await worker.fetch(new Request(ORIGIN+'/api/catalog/available'),env,{waitUntil(){}})).json());
const ids=body=>body.films.map(item=>item.id).sort();
const record=key=>records.get('letterboxd/facts/films/'+key+'.json');
const links=()=>records.get('letterboxd/facts/links.json')||{};

// 1. New TMDB-only record, owner observation, projection; the film leaves Finds; nothing else is written.
{
 seed();
 assert.equal((await available()).watchedMarkEnabled,true);
 const r=await mark({tmdbId:'10',watched:true});
 assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body,{outcome:'saved',watched:true},'response carries only outcome and watched');
 const rec=record('tmdb-10');
 assert.deepEqual(rec.links,{letterboxd:null,tmdb:'10'},'record with only the TMDB link');
 assert.equal(rec.watched.value,true);assert.equal(rec.watched.source,'owner');assert.ok(!rec.rating&&!rec.watchlist,'only watched is written');
 assert.equal(links()['tmdb:10'],'tmdb-10');assert.equal(Object.keys(links()).length,1);
 assert.equal(records.get(VIEW).tmdb_10.watched,true);assert.equal(records.get(VIEW).tmdb_10.actualRating,undefined,'no rating projected');
 assert.deepEqual([...new Set(puts)].sort(),['enrichment/view-index.json','letterboxd/facts/films/tmdb-10.json','letterboxd/facts/links.json']);
 assert.ok(!ids(await available()).includes('tmdb_10'),'marked film leaves Finds');
 // 2. Idempotent: the same value again (a repeat click or a retry) writes nothing.
 puts=[];const again=await mark({tmdbId:'10',watched:true});
 assert.deepEqual(again.body,{outcome:'unchanged',watched:true});assert.deepEqual(puts,[],'repeat writes nothing');
 // 3. Revoke: watched false replaces the earlier true; the film returns to Finds (no rating).
 const revoke=await mark({tmdbId:'10',watched:false});
 assert.deepEqual(revoke.body,{outcome:'saved',watched:false});
 assert.equal(record('tmdb-10').watched.value,false);assert.equal(record('tmdb-10').watched.replaced.value,true);
 assert.ok(ids(await available()).includes('tmdb_10'),'revoked film returns');
}
// 4. New generation without the film, then with it: the mark persists.
{
 seed();await mark({tmdbId:'10',watched:true});
 const put=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
 put('epg/published-generation.json',{phase:'published',programmeRunId:G2});
 put('epg/generations/'+G2+'/programme.json',{runId:G2,films:[]});
 put('epg/generations/'+G2+'/discovered-films.json',{tmdb_11:{...film(11,'Eleven'),showsProgrammeRunId:G2}});
 assert.equal((await mark({tmdbId:'10',watched:true})).status,409,'not in the new published catalog');
 put('epg/generations/'+G2+'/discovered-films.json',{tmdb_10:{...film(10,'Ten'),showsProgrammeRunId:G2},tmdb_11:{...film(11,'Eleven'),showsProgrammeRunId:G2}});
 assert.ok(!ids(await available()).includes('tmdb_10'),'mark persists when the film returns in a later generation');
 assert.equal(record('tmdb-10').watched.value,true);
}

// 5. A rated film: revoking watched keeps the rating and the film stays excluded.
{
 seed();
 const factKey=await Facts.linkFilm({BUCKET:bucket},{letterboxd:'eleven-lid',tmdb:'11'});
 const at=new Date(now-48*hour).toISOString();
 await Facts.recordObservations({BUCKET:bucket},factKey,{letterboxd:'eleven-lid',tmdb:'11'},[
  {fact:'watched',observation:await Facts.observation({factKey,fact:'watched',value:true,observedAt:at,source:'letterboxd_export'})},
  {fact:'rating',observation:await Facts.observation({factKey,fact:'rating',value:4,observedAt:at,source:'letterboxd_export'})}]);
 const r=await mark({tmdbId:'11',watched:false});
 assert.deepEqual(r.body,{outcome:'saved',watched:false},'owner observation is newer than the export');
 assert.equal(record('tmdb-11').rating.value,4,'rating kept');assert.equal(record('tmdb-11').watched.value,false);
 const view=records.get(VIEW);assert.equal(view.tmdb_11.watched,false);assert.equal(view['eleven-lid'].watched,false,'projected under both ids');
 assert.ok(!ids(await available()).includes('tmdb_11'),'a rated film stays excluded');
 // 6. A newer complete films list showing the linked film replaces the owner's revocation.
 const later=new Date(Date.now()+1000).toISOString();
 await Facts.applyFilmsListScan({BUCKET:bucket},{scanId:'scan-1',observedAt:later,films:{'eleven-lid':4}});
 assert.deepEqual((await mark({tmdbId:'11',watched:true})).body,{outcome:'unchanged',watched:true},'the scan summary is the newer effective value');
}
// 7. tmdb:<n> already links an lb-<lid> record: the observation goes there; a later lid without a record is added; a lid with its own record is an alias_conflict.
{
 seed();
 const k12=await Facts.linkFilm({BUCKET:bucket},{letterboxd:'twelve-lid',tmdb:'12'});
 await Facts.recordObservations({BUCKET:bucket},k12,{letterboxd:'twelve-lid',tmdb:'12'},[{fact:'watchlist',observation:await Facts.observation({factKey:k12,fact:'watchlist',value:false,observedAt:new Date(now-hour).toISOString(),source:'letterboxd_watchlist'})}]);
 const r=await mark({tmdbId:'12',watched:true});
 assert.equal(r.body.outcome,'saved');assert.equal(links()['tmdb:12'],'tmdb-12');assert.equal(record('tmdb-12').links.letterboxd,'twelve-lid');
 assert.equal(records.get(VIEW)['twelve-lid'].watched,true);
 await mark({tmdbId:'13',watched:true});
 assert.equal(await Facts.linkFilm({BUCKET:bucket},{letterboxd:'thirteen-lid',tmdb:'13'}),'tmdb-13','a later Letterboxd id joins the TMDB-only record');
 await Facts.linkFilm({BUCKET:bucket},{letterboxd:'other-lid'});
 await mark({tmdbId:'10',watched:true});
 await assert.rejects(Facts.linkFilm({BUCKET:bucket},{letterboxd:'other-lid',tmdb:'10'}),error=>error.code==='alias_conflict','never merged');
}
// 8. A films-list scan never writes a TMDB-only record, and absence from it changes nothing.
{
 seed();await mark({tmdbId:'10',watched:true});const before=JSON.stringify(record('tmdb-10'));
 await Facts.applyFilmsListScan({BUCKET:bucket},{scanId:'scan-2',observedAt:new Date(Date.now()+1000).toISOString(),films:{'someone-else':3}});
 assert.equal(JSON.stringify(record('tmdb-10')),before);
}
// 9. Concurrent marks: both compare-and-swap, the later observedAt is current, no lost write.
{
 seed();
 raceOnce={key:'letterboxd/facts/films/tmdb-10.json',run:async()=>{await new Promise(resolve=>setTimeout(resolve,5));await mark({tmdbId:'10',watched:false});}};
 // The first request (true) is overtaken by a later revoke that writes first; its CAS fails, it re-reads and the later value stands.
 const first=await mark({tmdbId:'10',watched:true});
 assert.equal(first.status,200);assert.equal(first.body.outcome,'older','the earlier request loses to the later one');
 const stored=record('tmdb-10').watched;assert.equal(stored.value,false,'the later observation stands');
 assert.equal(first.body.watched,stored.value,'the response reports the current value');
}

// 10. Identity and request guards: nothing is written on any refusal.
{
 seed();const snapshot=()=>JSON.stringify([...records.entries()].sort());const before=snapshot();
 const refused=[
  [{tmdbId:'99',watched:true},{},409,'film_not_in_catalog'],
  [{tmdbId:'14',watched:true},{},409,'film_not_in_catalog'],
  [{tmdbId:'10',watched:true,title:'Ten'},{},400,'invalid_request'],
  [{tmdbId:'10',watched:true,year:2000},{},400,'invalid_request'],
  [{tmdbId:'10',watched:true,letterboxd:'ten'},{},400,'invalid_request'],
  [{tmdbId:10,watched:true},{},400,'invalid_request'],
  [{tmdbId:'tmdb_10',watched:true},{},400,'invalid_request'],
  [{tmdbId:'10',watched:'yes'},{},400,'invalid_request'],
  [[{tmdbId:'10',watched:true}],{},400,'invalid_request'],
  [null,{raw:'{"tmdbId":'},400,null],
  [{tmdbId:'10',watched:true},{raw:JSON.stringify({tmdbId:'10',watched:true,pad:'x'.repeat(600)})},400,null],
  [{tmdbId:'10',watched:true},{origin:null},403,null],
  [{tmdbId:'10',watched:true},{origin:'https://evil.example'},403,null],
  [{tmdbId:'10',watched:true},{type:'text/plain'},415,null],
  [{tmdbId:'10',watched:true},{type:null},415,null],
  [{tmdbId:'10',watched:true},{method:'PUT'},405,null],
  [{tmdbId:'10',watched:true},{method:'GET'},405,null],
  [{tmdbId:'10',watched:true},{env:{BUCKET:bucket,LETTERBOXD_FACTS:'on'}},409,'mark_disabled'],
  [{tmdbId:'10',watched:true},{env:{BUCKET:bucket,LETTERBOXD_FACTS:'on',FINDS_WATCHED_MARK:'On'}},409,'mark_disabled'],
  [{tmdbId:'10',watched:true},{env:{BUCKET:bucket,FINDS_WATCHED_MARK:'on'}},409,'facts_disabled'],
 ];
 for(const [body,options,status,code] of refused){
  const r=await mark(body,options);assert.equal(r.status,status,JSON.stringify([body,options.origin,options.type,options.method,r.body]));
  if(code)assert.equal(r.body.code,code);
 }
 assert.equal(snapshot(),before,'no refusal writes anything');
 // Without a published generation nothing is written.
 records.delete('epg/published-generation.json');
 assert.equal((await mark({tmdbId:'10',watched:true})).body.code,'film_not_in_catalog');
 assert.equal((await available({BUCKET:bucket,LETTERBOXD_FACTS:'on'})).watchedMarkEnabled,undefined);
}
// The Finds response says whether the mark is available: only with both switches.
{
 seed();
 assert.equal((await available({BUCKET:bucket,LETTERBOXD_FACTS:'on'})).watchedMarkEnabled,false);
 assert.equal((await available({BUCKET:bucket,FINDS_WATCHED_MARK:'on'})).watchedMarkEnabled,false);
 assert.equal((await available()).watchedMarkEnabled,true);
}
// The route is not an MCP tool and not part of the GET side-effect surface.
assert.doesNotMatch(fs.readFileSync('src/mcp.js','utf8'),/catalog\/watched|recordOwnerWatchedMark/);

// 11. Client: the button appears only when enabled, a mark hides the card at once, the notice offers an undo, errors stay on the card.
{
 const doc={nodes:new Map(),querySelector(sel){if(!this.nodes.has(sel))this.nodes.set(sel,{hidden:false,innerHTML:'',textContent:'',addEventListener(){},focus(){}});return this.nodes.get(sel);},querySelectorAll(){return [];}};
 const calls=[];let reply=async()=>({ok:true,json:async()=>({outcome:'saved',watched:true})});
 const ctx=vm.createContext({Date,Intl,Set,Map,JSON,Promise,setTimeout,document:doc,fetch:async(url,init)=>{calls.push({url,init});if(url==='/api/catalog/available')return {ok:true,json:async()=>catalogAnswer};return reply(url,init);}});
 let catalogAnswer=null;
 vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
 const run=code=>vm.runInContext(code,ctx);
 const clientFilm=n=>({...film(n,'Film '+n),prediction:{predictedRating:4.5,probability4Plus:.9,confidence:'high',moodIds:[]},fingerprint:null});
 ctx.answer={programmeRunId:'run-1',watchedMarkEnabled:true,films:[clientFilm(10),clientFilm(11)]};
 run('report={runId:"run-1"};films=[];enrichment={films:{}};');
 catalogAnswer=ctx.answer;await run('loadCatalog()');
 let cards=doc.querySelector('#finds-cards').innerHTML;
 assert.match(cards,/data-finds-watched="10"/);assert.match(cards,/>Смотрел</);assert.match(cards,/aria-label="Отметить «Film 10» как просмотренный"/);
 // Mark: one POST with the TMDB id only; the card disappears before any refresh.
 catalogAnswer={...ctx.answer};
 let pending;reply=()=>new Promise(resolve=>{pending=resolve;});
 const marking=run('markFindWatched("10")');
 assert.match(doc.querySelector('#finds-cards').innerHTML,/Сохраняю…/,'loading state');assert.match(doc.querySelector('#finds-cards').innerHTML,/disabled aria-busy="true"/);
 pending({ok:true,json:async()=>({outcome:'saved',watched:true})});await marking;
 const post=calls.find(call=>call.url==='/api/catalog/watched');
 assert.equal(post.init.method,'POST');assert.equal(post.init.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(post.init.body),{tmdbId:'10',watched:true});
 cards=doc.querySelector('#finds-cards').innerHTML;
 assert.doesNotMatch(cards,/data-finds-watched="10"/,'marked card hidden at once');assert.match(cards,/data-finds-watched="11"/);
 assert.match(doc.querySelector('#finds-notice').innerHTML,/«Film 10» отмечен как просмотренный/);assert.match(doc.querySelector('#finds-notice').innerHTML,/data-finds-undo="10"/);
 // Undo posts watched:false and brings the card back.
 reply=async()=>({ok:true,json:async()=>({outcome:'saved',watched:false})});
 await run('undoFindWatched("10")');
 assert.deepEqual(JSON.parse(calls.filter(call=>call.url==='/api/catalog/watched').pop().init.body),{tmdbId:'10',watched:false});
 assert.match(doc.querySelector('#finds-cards').innerHTML,/data-finds-watched="10"/,'undone film returns');
 assert.match(doc.querySelector('#finds-notice').innerHTML,/снова в «Находках»/);
 // Error: the card stays with an alert and the button can be pressed again.
 reply=async()=>({ok:false,json:async()=>({code:'write_contention'})});
 await run('markFindWatched("11")');
 cards=doc.querySelector('#finds-cards').innerHTML;
 assert.match(cards,/data-finds-watched="11"/);assert.match(cards,/role="alert">Не удалось сохранить, попробуй ещё раз/);assert.doesNotMatch(cards,/data-finds-watched="11" disabled/);
 // Disabled on the server: no button.
 catalogAnswer={...ctx.answer,watchedMarkEnabled:false};await run('loadCatalog()');
 assert.doesNotMatch(doc.querySelector('#finds-cards').innerHTML,/data-finds-watched/);
}

console.log('Finds watched mark: TMDB-only owner fact, idempotency, revoke, rating kept, scans, linking, concurrency, guards, generation persistence and client mark/undo passed');
