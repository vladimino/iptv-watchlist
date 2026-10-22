import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

function harness(mode,response){
 const records=new Map(),etags=new Map();let revision=0,calls=0;
 const env={TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 if(mode)env.SCORED_RESOLUTION=mode;
 const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async()=>{calls++;return response();}});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),live);
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
const off=await run(null,candidate('Dune',1984),structuredClone(films));
const shadow=await run('shadow',candidate('Dune',1984),structuredClone(films));
assert.equal(off.records.get('epg/discovery-score-preview.json'),undefined);
assert.equal(off.records.get('epg/discovery-resolution.json')['dune|1984'].status,'verified');
assert.equal(shadow.records.get('epg/discovery-resolution.json')['dune|1984'].status,'verified');
assert.equal(shadow.records.get('epg/discovered-films.json').tmdb_11.canonicalIdentity,'tmdb:11');
assert.equal(shadow.records.get('epg/discovered-films.json').tmdb_11.title,'Дюна');
const preview=shadow.records.get('epg/discovery-score-preview.json').items['dune|1984'];
assert.equal(preview.legacyStatus,'verified');
assert.equal(preview.outcome,'needs_verification');
assert.equal(preview.scoring.acceptedTmdbId,'11');
const status=await vm.runInContext('discoveryPipelineStatus(env)',shadow.live);
assert.equal(status.scoringPreview.mode,'shadow');
assert.equal(status.scoringPreview.needsConfirmation,1);
assert.equal(status.scoringPreview.cutover,'off');
assert.equal(status.scoringPreview.outcomes.needs_verification,1);
assert.equal(off.calls,0);
assert.equal(shadow.calls,0);

const gated=await run('on',candidate('Dune',1984),structuredClone(films));
const held=gated.records.get('epg/discovery-resolution.json')['dune|1984'];
assert.equal(held.status,'needs_verification');
assert.notEqual(held.status,'verified');
assert.equal(held.attempts,1);
assert.ok(held.retryAt);
assert.equal(held.scoring.status,'accepted');
assert.equal(gated.records.get('epg/discovered-films.json').tmdb_11.title,'Дюна');
assert.deepEqual(gated.records.get('epg/discovered-films.json').tmdb_11.shows,[]);
assert.equal(gated.records.get('epg/discovery-score-preview.json').items['dune|1984'].outcome,'needs_verification');
assert.equal(gated.calls,0);

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
assert.equal(searching.calls(),1);
assert.equal(searching.records.get('epg/discovery-resolution.json')['brand new film|1999'].status,'needs_verification');
searching.records.get('epg/discovery-status.json').retryAt=null;
const second=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',searching);
assert.equal(second.checked,0);
assert.equal(searching.calls(),1);
const opened=searching.records.get('epg/discovery-latest.json').items[0];
opened.shows=[{...opened.shows[0],start:opened.shows[0].start+1000}];
opened.lastAiring=opened.shows[0].start;
const reopened=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',searching);
assert.equal(reopened.checked,1);
assert.equal(searching.calls(),2);
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
console.log('Scored discovery: default path, shadow preview, gated writes, history and stale generation passed');
