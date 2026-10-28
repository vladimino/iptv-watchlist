import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

function harness(mode,response){
 const records=new Map(),etags=new Map();let revision=0,calls=0;
 const env={TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 if(mode)env.SCORED_RESOLUTION=mode;
 const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async input=>{calls++;return response(String(input));}});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),live);
 live.env=env;live.records=records;live.calls=()=>calls;
 return live;
}
const now=Date.now();
const show={channelId:'n',channel:'N',start:now,end:now+3600000};
const candidate=(title,year)=>({key:title.toLowerCase()+'|'+(year??''),title,normalizedTitle:title.toLowerCase(),year,duration:137,durations:[137],seenInLatestSnapshot:true,shows:[show],lastAiring:now,airings:1});
const dune=(id,year,runtime)=>({id:'tmdb_'+id,tmdbId:id,title:'Дюна',original:'Dune',year,runtime,canonicalIdentity:'tmdb:'+id,aliases:[],shows:[]});
const empty=()=>new Response(JSON.stringify({total_pages:1,results:[]}));
function seed(records,item,films,run='run-1'){
 records.set('programme.json',{runId:run,films:[]});
 records.set('epg/discovery-latest.json',{programmeRunId:run,items:[item]});
 records.set('epg/discovered-films.json',films);
}
async function run(mode,item,films,response=empty){
 const live=harness(mode,response);
 seed(live.records,item,films);
 const result=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',live);
 return {result,records:live.records,calls:live.calls(),live};
}

const films={tmdb_11:dune('11',1984,137),tmdb_438631:dune('438631',2021,155)};
films.tmdb_11.titleStatus='reviewed';
// The scored gate is the only resolver. Without the retired SCORED_RESOLUTION variable, and whatever value a stale
// binding still carries, a known alias is scored, held for the detail read and never verified by the alias alone.
for(const mode of [null,'off','shadow','on','legacy']){
 const heldBack=await run(mode,candidate('Dune',1984),structuredClone(films));
 const held=heldBack.records.get('epg/discovery-resolution.json')['dune|1984'];
 assert.equal(held.status,'needs_verification',String(mode));
 assert.equal(held.reason,undefined);
 assert.notEqual(held.identitySource,'tmdb_detail');
 assert.equal(heldBack.records.get('epg/discovered-films.json').tmdb_11.title,'Дюна');
 assert.deepEqual(heldBack.records.get('epg/discovered-films.json').tmdb_11.shows,[]);
 assert.equal(heldBack.calls,1,'one detail read, which the empty mock does not answer');
 const preview=heldBack.records.get('epg/discovery-score-preview.json');
 assert.equal(preview.mode,'on');
 assert.equal(preview.items['dune|1984'].outcome,'needs_verification');
 assert.equal(preview.items['dune|1984'].scoring.acceptedTmdbId,'11');
 assert.equal(preview.items['dune|1984'].legacyStatus,undefined);
 assert.equal(preview.items['dune|1984'].comparison,undefined);
 const status=await vm.runInContext('discoveryPipelineStatus(env)',heldBack.live);
 assert.equal(status.scoringPreview.mode,'on');
 assert.equal(status.scoringPreview.cutover,'on');
 assert.equal(status.scoringPreview.needsConfirmation,1);
 assert.equal(status.scoringPreview.stale,false);
 assert.equal(status.scoringPreview.currentProgrammeRunId,'run-1');
 assert.equal(status.scoringPreview.outcomes.needs_verification,1);
 assert.equal(status.scoringPreview.comparison,undefined);
}
function detailOf(id,title,original,year,runtime){return new Response(JSON.stringify({id:Number(id),title,original_title:original,release_date:year+'-01-01',runtime,overview:'A synopsis',genres:[{name:'Drama'}],poster_path:'/poster.jpg',credits:{crew:[{id:1,name:'Director',job:'Director'}],cast:[{id:2,name:'Actor'}]},translations:{translations:[{iso_639_1:'ru',data:{title}}]},alternative_titles:{titles:[{iso_3166_1:'US',title:original}]}}));}
const gated=await run('on',candidate('Dune',1984),structuredClone(films),url=>url.includes('/movie/')?detailOf(11,'Дюна','Dune',1984,137):empty());
const verified=gated.records.get('epg/discovery-resolution.json')['dune|1984'];
assert.equal(verified.status,'verified');
assert.equal(verified.identitySource,'tmdb_detail');
assert.equal(verified.provenance.authority,'tmdb_detail');
assert.equal(verified.provenance.searchHit,false);
assert.equal(verified.provenance.priorAlias,false);
assert.equal(verified.provenance.ownerReviewed,false);
assert.equal(verified.tmdbId,'11');
assert.equal(gated.records.get('epg/discovered-films.json').tmdb_11.title,'Дюна');
assert.equal(gated.records.get('epg/discovered-films.json').tmdb_11.titleStatus,'reviewed');
assert.equal(gated.records.get('epg/discovered-films.json').tmdb_11.shows.length,1);
assert.equal(gated.records.get('epg/discovered-films.json').tmdb_438631.shows.length,0);
assert.equal(gated.records.get('epg/discovery-score-preview.json').items['dune|1984'].outcome,'detail_verified');
assert.equal(gated.calls,1);
const again=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',gated.live);
assert.equal(again.checked,0);
assert.equal(gated.calls,1);
const gatedStatus=await vm.runInContext('discoveryPipelineStatus(env)',gated.live);
assert.equal(gatedStatus.scoringPreview.cutover,'on');
assert.equal(gatedStatus.scoringPreview.stale,false);
assert.equal(gatedStatus.scoringPreview.needsConfirmation,0);

const stalePreview=harness('on',empty);
seed(stalePreview.records,candidate('Dune',1984),structuredClone(films),'run-2');
stalePreview.records.set('epg/published-generation.json',{programmeRunId:'run-2',phase:'published'});
stalePreview.records.set('epg/discovery-score-preview.json',{schemaVersion:1,mode:'shadow',programmeRunId:'run-1',items:{'dune|1984':{outcome:'needs_verification',reason:'accepted'}}});
const staleStatus=await vm.runInContext('discoveryPipelineStatus(env)',stalePreview);
assert.equal(staleStatus.scoringPreview.cutover,'on');
assert.equal(staleStatus.scoringPreview.stale,true);
assert.equal(staleStatus.scoringPreview.programmeRunId,'run-1');
assert.equal(staleStatus.scoringPreview.currentProgrammeRunId,'run-2');
assert.equal(staleStatus.scoringPreview.needsConfirmation,0);
assert.equal(staleStatus.scoringPreview.rows,0);

const collision=await run('on',candidate('Dune',null),structuredClone(films));
assert.equal(collision.records.get('epg/discovery-resolution.json')['dune|'].status,'ambiguous');
assert.equal(collision.records.get('epg/discovery-resolution.json')['dune|'].terminalReason,null);
assert.equal(collision.records.get('epg/discovered-films.json').tmdb_11.canonicalIdentity,'tmdb:11');
assert.equal(collision.calls,0);

const historical={...candidate('Dune',1984),seenInLatestSnapshot:false,shows:[],lastAiring:now-20*86400000};
const old=await run('on',historical,structuredClone(films));
assert.equal(old.result.checked,0);
assert.equal(old.records.get('epg/discovery-score-preview.json').items['dune|1984'],undefined);
assert.equal(old.calls,0);

const unrelated=harness('on',empty);
const shared=structuredClone(films);
seed(unrelated.records,candidate('Dune',1984),shared);
unrelated.records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[candidate('Dune',1984),{...candidate('Alien',1979),key:'alien|1979'}]});
unrelated.records.set('epg/discovery-resolution.json',{'alien|1979':{status:'verified',tmdbId:'11',observationKey:'alien|1979',checkedAt:new Date().toISOString()}});
await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',unrelated);
assert.equal(unrelated.records.get('epg/discovery-score-preview.json').items['dune|1984'].outcome,'needs_verification');
assert.equal(unrelated.records.get('epg/discovery-resolution.json')['dune|1984'].status,'needs_verification');
assert.equal(unrelated.records.get('epg/discovery-resolution.json')['alien|1979'].status,'verified');
assert.equal(vm.runInContext("verifiedConfirmation({status:'verified',tmdbId:'11',observationKey:'dune|1984'},'11').authority",unrelated),'verified_decision');
assert.equal(vm.runInContext("verifiedConfirmation({status:'verified',tmdbId:'11',observationKey:'alien|1979'},'99')",unrelated),null);

const searching=harness('on',()=>new Response(JSON.stringify({total_pages:1,results:[{id:77,title:'Brand New Film',original_title:'Brand New Film',release_date:'1999-01-01'}]})));
seed(searching.records,candidate('Brand New Film',1999),{});
const first=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',searching);
assert.equal(first.checked,1);
assert.equal(searching.calls(),2);
assert.equal(searching.records.get('epg/discovery-resolution.json')['brand new film|1999'].status,'needs_verification');
assert.equal(searching.records.get('epg/discovered-films.json').tmdb_77,undefined);
searching.records.get('epg/discovery-status.json').retryAt=null;
const second=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',searching);
assert.equal(second.checked,0);
assert.equal(searching.calls(),2);
const opened=searching.records.get('epg/discovery-latest.json').items[0];
opened.shows=[{...opened.shows[0],start:opened.shows[0].start+1000}];
opened.lastAiring=opened.shows[0].start;
const reopened=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',searching);
assert.equal(reopened.checked,1);
assert.equal(searching.calls(),4);
assert.equal(searching.records.get('epg/discovery-resolution.json')['brand new film|1999'].attempts,1);

const limited=harness('on',()=>new Response('{}',{status:429,headers:{'Retry-After':'30'}}));
seed(limited.records,candidate('Brand New',1999),{});
const paused=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',limited);
assert.equal(paused.error,'TMDB HTTP 429');
assert.ok(paused.retryAt);
assert.equal(limited.records.get('epg/discovery-resolution.json'),undefined);

const stale=harness('on',empty);
stale.records.set('epg/published-generation.json',{programmeRunId:'run-a',phase:'published'});
seed(stale.records,candidate('Dune',1984),structuredClone(films),'run-b');
const refused=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-b",films:[]},4)',stale);
assert.equal(refused.checked,1);
assert.equal(stale.records.get('epg/discovery-resolution.json')['dune|1984'],undefined);
assert.equal(stale.records.get('epg/discovery-score-preview.json').items['dune|1984'].reason,'stale_generation');
assert.equal(stale.records.get('epg/discovered-films.json').tmdb_11.title,'Дюна');
assert.equal(stale.calls(),0);

const created=harness('on',url=>url.includes('/movie/')?detailOf(77,'Brand New Film','Brand New Film',1999,137):new Response(JSON.stringify({total_pages:1,results:[{id:77,title:'Brand New Film',original_title:'Brand New Film',release_date:'1999-01-01'}]})));
seed(created.records,candidate('Brand New Film',1999),{});
created.records.set('enrichment/profile/current.json',{version:1,profileHash:'hash'});
const createdResult=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',created);
assert.equal(createdResult.added,1);
assert.equal(created.calls(),2);
const createdFilm=created.records.get('epg/discovered-films.json').tmdb_77;
assert.equal(created.records.get('epg/discovery-resolution.json')['brand new film|1999'].status,'verified');
assert.equal(created.records.get('epg/discovery-resolution.json')['brand new film|1999'].identitySource,'tmdb_detail');
assert.equal(created.records.get('epg/discovery-resolution.json')['brand new film|1999'].provenance.searchHit,true);
assert.equal(createdFilm.canonicalIdentity,'tmdb:77');
assert.equal(createdFilm.runtime,137);
assert.equal(createdFilm.shows.length,1);
assert.equal(createdFilm.directors[0].name,'Director');
assert.ok(created.records.get('enrichment/prediction-queue.json').hotPending.includes('tmdb_77'));
const createdAgain=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',created);
assert.equal(createdAgain.checked,0);
assert.equal(created.calls(),2);

const aliasFilm={tmdb_11:{id:'tmdb_11',tmdbId:'11',title:'Дюна',original:'Дюна',year:1984,runtime:137,canonicalIdentity:'tmdb:11',aliases:['Дюна'],shows:[],titleStatus:'reviewed'}};
const alias=await run('on',candidate('Dune',1984),structuredClone(aliasFilm),url=>url.includes('/movie/')?detailOf(11,'Дюна','Dune',1984,137):new Response(JSON.stringify({total_pages:1,results:[{id:11,title:'Dune',original_title:'Dune',release_date:'1984-01-01'}]})));
assert.equal(alias.records.get('epg/discovery-resolution.json')['dune|1984'].status,'verified');
assert.equal(alias.records.get('epg/discovery-resolution.json')['dune|1984'].provenance.searchHit,true);
assert.equal(alias.records.get('epg/discovered-films.json').tmdb_11.title,'Дюна');
assert.equal(alias.records.get('epg/discovered-films.json').tmdb_11.titleStatus,'reviewed');
assert.ok(alias.records.get('epg/discovered-films.json').tmdb_11.aliases.includes('Dune'));
assert.equal(alias.records.get('epg/discovered-films.json').tmdb_11.shows.length,1);

const remake=await run('on',candidate('Dune',1984),structuredClone(films),url=>url.includes('/movie/')?detailOf(11,'Дюна','Dune',1984,137):empty());
assert.equal(remake.records.get('epg/discovery-resolution.json')['dune|1984'].tmdbId,'11');
assert.equal(remake.records.get('epg/discovered-films.json').tmdb_438631.canonicalIdentity,'tmdb:438631');
assert.equal(remake.records.get('epg/discovered-films.json').tmdb_438631.shows.length,0);
const yearless=await run('on',candidate('Dune',null),structuredClone(films));
assert.equal(yearless.records.get('epg/discovery-resolution.json')['dune|'].status,'ambiguous');
assert.equal(yearless.calls,0);

const contradicted=harness('on',url=>url.includes('/movie/')?detailOf(77,'Brand New Film','Brand New Film',1999,40):new Response(JSON.stringify({total_pages:1,results:[{id:77,title:'Brand New Film',original_title:'Brand New Film',release_date:'1999-01-01'}]})));
seed(contradicted.records,candidate('Brand New Film',1999),{});
await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',contradicted);
assert.equal(contradicted.records.get('epg/discovery-resolution.json')['brand new film|1999'].status,'duration_mismatch');
assert.equal(contradicted.records.get('epg/discovered-films.json').tmdb_77,undefined);
assert.equal(contradicted.calls(),2);

const collidedFilms=structuredClone(films);
collidedFilms.tmdb_11.conflictingTmdbIds=['999'];
const collided=await run('on',candidate('Dune',1984),collidedFilms,url=>{throw new Error('detail should not be requested');});
assert.equal(collided.records.get('epg/discovery-resolution.json')?.['dune|1984'],undefined);
assert.deepEqual(collided.records.get('epg/discovered-films.json').tmdb_11.conflictingTmdbIds,['999']);
assert.deepEqual(collided.records.get('epg/discovered-films.json').tmdb_11.shows,[]);
assert.equal(collided.records.get('epg/discovery-score-preview.json').items['dune|1984'].reason,'identity_collision');
assert.equal(collided.calls,0);

const detailError=harness('on',url=>url.includes('/movie/')?new Response('{}',{status:429,headers:{'Retry-After':'30'}}):new Response(JSON.stringify({total_pages:1,results:[{id:77,title:'Brand New Film',original_title:'Brand New Film',release_date:'1999-01-01'}]})));
seed(detailError.records,candidate('Brand New Film',1999),{});
const detailPaused=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',detailError);
assert.equal(detailPaused.error,'TMDB HTTP 429');
assert.equal(detailError.records.get('epg/discovery-resolution.json'),undefined);
assert.equal(detailError.records.get('epg/discovered-films.json').tmdb_77,undefined);

const listed={id:'lb1',tmdbId:'11',title:'Дюна',titleStatus:'reviewed',original:'Дюна',year:1984,runtime:137,shows:[]};
const watchlist=harness('on',url=>url.includes('/movie/')?detailOf(11,'Дюна','Dune',1984,137):new Response(JSON.stringify({total_pages:1,results:[{id:11,title:'Dune',original_title:'Dune',release_date:'1984-01-01'}]})));
seed(watchlist.records,candidate('Dune',1984),{});
watchlist.listed=structuredClone(listed);
watchlist.records.set('programme.json',{runId:'run-1',films:[structuredClone(listed)]});
await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[listed]},4)',watchlist);
const shown=watchlist.records.get('programme.json').films[0];
assert.equal(watchlist.records.get('epg/discovery-resolution.json')['dune|1984'].filmId,'lb1');
assert.equal(watchlist.records.get('epg/discovery-resolution.json')['dune|1984'].identitySource,'tmdb_detail');
assert.equal(watchlist.records.get('epg/discovered-films.json').tmdb_11,undefined);
assert.equal(shown.title,'Дюна');
assert.equal(shown.titleStatus,'reviewed');
assert.equal(shown.shows.length,1);
assert.equal(shown.shows[0].channelId,'n');
assert.equal(shown.canonicalIdentity,undefined);

const shifted=harness('on',async url=>{if(String(url).includes('/movie/')){shifted.records.set('epg/published-generation.json',{programmeRunId:'other',phase:'published'});return detailOf(11,'Дюна','Dune',1984,137);}return new Response(JSON.stringify({total_pages:1,results:[{id:11,title:'Dune',original_title:'Dune',release_date:'1984-01-01'}]}));});
seed(shifted.records,candidate('Dune',1984),{});
shifted.listed=structuredClone(listed);
shifted.records.set('programme.json',{runId:'run-1',films:[structuredClone(listed)]});
shifted.records.set('epg/published-generation.json',{programmeRunId:'run-1',phase:'published'});
const shiftedResult=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[listed]},4)',shifted);
assert.equal(shiftedResult.stage,'programme_changed');
assert.equal(shifted.records.get('epg/discovery-resolution.json')?.['dune|1984'],undefined);
assert.deepEqual(shifted.records.get('programme.json').films[0].shows,[]);
assert.equal(shifted.records.get('programme.json').films[0].title,'Дюна');
assert.equal(shifted.records.get('epg/discovered-films.json').tmdb_11,undefined);

const raced=harness('on',url=>url.includes('/movie/')?detailOf(11,'Дюна','Dune',1984,137):new Response(JSON.stringify({total_pages:1,results:[{id:11,title:'Dune',original_title:'Dune',release_date:'1984-01-01'}]})));
seed(raced.records,candidate('Dune',1984),{});
raced.listed=structuredClone(listed);
raced.records.set('programme.json',{runId:'run-1',films:[structuredClone(listed)]});
raced.records.set('epg/published-generation.json',{programmeRunId:'run-1',phase:'published'});
const racedPut=raced.env.BUCKET.put.bind(raced.env.BUCKET);
raced.env.BUCKET.put=async(key,value,options)=>{const saved=await racedPut(key,value,options);if(key==='epg/generations/run-1/programme.json'){raced.records.set('epg/published-generation.json',{programmeRunId:'run-new',phase:'published'});raced.records.set('programme.json',{runId:'run-new',films:[{id:'lb1',title:'Новая программа',titleStatus:'reviewed',shows:[{channelId:'fresh',start:1}]}]});}return saved;};
const racedResult=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[listed]},4)',raced);
assert.equal(racedResult.stage,'programme_changed');
assert.equal(raced.records.get('epg/discovery-resolution.json')?.['dune|1984'],undefined);
assert.equal(raced.records.get('programme.json').films[0].title,'Новая программа');
assert.equal(raced.records.get('programme.json').films[0].shows[0].channelId,'fresh');

const afterCheck=harness('on',url=>url.includes('/movie/')?detailOf(11,'Дюна','Dune',1984,137):new Response(JSON.stringify({total_pages:1,results:[{id:11,title:'Dune',original_title:'Dune',release_date:'1984-01-01'}]})));
seed(afterCheck.records,candidate('Dune',1984),{});
afterCheck.listed=structuredClone(listed);
afterCheck.records.set('programme.json',{runId:'run-1',films:[structuredClone(listed)]});
afterCheck.records.set('epg/published-generation.json',{programmeRunId:'run-1',phase:'published'});
let stagedProgramme=false,publicWrites=0;
const afterGet=afterCheck.env.BUCKET.get.bind(afterCheck.env.BUCKET),afterPut=afterCheck.env.BUCKET.put.bind(afterCheck.env.BUCKET);
afterCheck.env.BUCKET.put=async(key,value,options)=>{if(key==='programme.json')publicWrites++;if(key==='epg/generations/run-1/programme.json')stagedProgramme=true;return afterPut(key,value,options);};
afterCheck.env.BUCKET.get=async key=>{const object=await afterGet(key);if(key==='epg/published-generation.json'&&stagedProgramme){const seen=await object.json();afterCheck.records.set('epg/published-generation.json',{programmeRunId:'run-new',phase:'published'});afterCheck.records.set('programme.json',{runId:'run-new',films:[{id:'lb1',title:'Новая программа',titleStatus:'reviewed',shows:[{channelId:'fresh',start:1}]}]});return {etag:object.etag,json:async()=>seen};}return object;};
const afterResult=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[listed]},4)',afterCheck);
assert.equal(afterResult.stage,'programme_changed');
assert.equal(publicWrites,0);
assert.equal(afterCheck.records.get('epg/discovery-resolution.json')?.['dune|1984'],undefined);
assert.equal(afterCheck.records.get('programme.json').films[0].title,'Новая программа');
assert.equal(afterCheck.records.get('programme.json').films[0].shows[0].channelId,'fresh');
assert.equal(afterCheck.records.get('epg/generations/run-1/programme.json').films[0].shows[0].channelId,'n');

const moved=harness('on',url=>url.includes('/movie/')?detailOf(77,'Brand New Film','Brand New Film',1999,137):new Response(JSON.stringify({total_pages:1,results:[{id:77,title:'Brand New Film',original_title:'Brand New Film',release_date:'1999-01-01'}]})));
seed(moved.records,candidate('Brand New Film',1999),{});
moved.env.beforeCatalogWrite=async()=>{moved.records.set('epg/published-generation.json',{programmeRunId:'other',phase:'published'});};
const movedResult=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',moved);
assert.equal(movedResult.stage,'programme_changed');
assert.equal(moved.records.get('epg/discovery-resolution.json')?.['brand new film|1999'],undefined);
assert.equal(moved.records.get('epg/discovered-films.json').tmdb_77,undefined);
// Two near editions that both miss the runtime: ambiguous from the alias index alone, no TMDB call.
const nearFilms={tmdb_11:{...dune('11',1984,200),aliases:['Dune']},tmdb_12:{...dune('12',1985,200),aliases:['Dune']}};
const near=await run(null,candidate('Dune',1984),nearFilms,()=>{throw new Error('no TMDB call for an ambiguous alias index');});
assert.equal(near.records.get('epg/discovery-resolution.json')['dune|1984'].status,'ambiguous');
assert.equal(near.records.get('epg/discovery-score-preview.json').items['dune|1984'].outcome,'candidate_decision');
assert.equal(near.calls,0);

// A long unique title without a year is verified once the detail card agrees.
const uniqueSearch=()=>new Response(JSON.stringify({total_pages:1,results:[{id:21283,title:'The Straight Story',original_title:'The Straight Story',release_date:'1999-01-01'}]}));
const unique=await run(null,{...candidate('The Straight Story',null),duration:111,durations:[111]},{},url=>url.includes('/movie/')?detailOf(21283,'The Straight Story','The Straight Story',1999,111):uniqueSearch());
assert.equal(unique.records.get('epg/discovery-resolution.json')['the straight story|'].status,'verified');
assert.equal(unique.records.get('epg/discovery-resolution.json')['the straight story|'].identitySource,'tmdb_detail');
assert.equal(unique.records.get('epg/discovered-films.json').tmdb_21283.canonicalIdentity,'tmdb:21283');
assert.equal(unique.calls,2);

// A 429 on the detail read of a known alias pauses the chunk: retryAt is set, no decision is written, and a call
// before retryAt is a backoff without another TMDB request.
const aaa={...candidate('Aaa',1984),key:'aaa|1984',title:'Aaa',normalizedTitle:'aaa'};
const queued=harness(null,url=>{queued.urls.push(String(url));return new Response('{}',{status:429,headers:{'Retry-After':'30'}});});
queued.urls=[];
seed(queued.records,aaa,{tmdb_11:{id:'tmdb_11',tmdbId:'11',title:'Aaa',original:'Aaa',year:1984,runtime:137,canonicalIdentity:'tmdb:11',aliases:['Aaa'],shows:[]}});
const queuedResult=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',queued);
assert.equal(queuedResult.error,'TMDB HTTP 429');
assert.ok(queuedResult.retryAt);
assert.equal(queuedResult.tmdbCalls,1);
assert.ok(queued.urls[0].includes('/movie/11'),'a known alias goes straight to the detail read');
assert.equal(queued.records.get('epg/discovery-resolution.json'),undefined);
const backoff=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',queued);
assert.equal(backoff.stage,'backoff');
assert.equal(queued.urls.length,1,'a call before retryAt makes no TMDB request');
console.log('Scored discovery: the single scored path, detail verification, ambiguity, backoff, history and stale generation passed');
