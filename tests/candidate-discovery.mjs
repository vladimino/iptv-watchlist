import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const source=fs.readFileSync('src/discovery.js','utf8');
assert.doesNotMatch(source,/candidateDiscoveryMode|candidateSearchVariants|collectVariantProposals|variantHit|variantAliasRank/);
assert.doesNotMatch(fs.readFileSync('src/feature-flags.js','utf8'),/CANDIDATE_DISCOVERY|candidateDiscoveryMode|onOff\(/);
assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/CANDIDATE_DISCOVERY/);
assert.match(source,/variantCalls:0,variantErrors:0,variantThrottled:0,variantSkipped:0/);

function harness(flags,response){
 const records=new Map(),etags=new Map();let revision=0,calls=0;const urls=[];
 const env={TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 if(flags.scored)env.SCORED_RESOLUTION=flags.scored;
 if(flags.discovery)env.CANDIDATE_DISCOVERY=flags.discovery;
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async input=>{calls++;urls.push(String(input));return response(String(input),records);}});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
 ctx.env=env;ctx.records=records;
 return {ctx,records,calls:()=>calls,urls};
}
const now=Date.now();
const show={channelId:'n',channel:'N',start:now,end:now+3600000};
function item(title,normalizedTitle,year,duration){return {key:normalizedTitle+'|'+(year??''),title,normalizedTitle,year,duration,durations:[duration],seenInLatestSnapshot:true,shows:[show],lastAiring:now,airings:1};}
function movie(id,title,original,year){return {id,title,original_title:original||title,release_date:year+'-01-01'};}
function detail(id,title,original,year,runtime,aliases=[]){return {id:Number(id),title,original_title:original,release_date:year+'-01-01',runtime,overview:'A synopsis',genres:[{name:'Drama'}],poster_path:null,credits:{crew:[],cast:[]},translations:{translations:[]},alternative_titles:{titles:aliases.map(name=>({iso_3166_1:'RU',title:name}))}};}
function seed(records,row){records.set('programme.json',{runId:'run-1',films:[]});records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[row]});records.set('epg/discovered-films.json',{});records.set('epg/published-generation.json',{programmeRunId:'run-1',phase:'published'});}
async function resolve(flags,row,response,extra){
 const box=harness(flags,response);seed(box.records,row);
 if(extra)for(const [key,value] of Object.entries(extra))box.records.set(key,value);
 const result=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',box.ctx);
 return {...box,result,decision:box.records.get('epg/discovery-resolution.json')?.[row.key],preview:box.records.get('epg/discovery-score-preview.json')?.items[row.key],catalog:box.records.get('epg/discovered-films.json')};
}
const empty=()=>new Response(JSON.stringify({total_pages:1,results:[]}));
const json=body=>new Response(JSON.stringify(body));
function textOf(url){return decodeURIComponent(url).replace(/\+/g,' ');}
function zeros(result,records){
 assert.deepEqual([result.variantCalls,result.variantErrors,result.variantThrottled,result.variantSkipped],[0,0,0,0]);
 const stored=records.get('epg/discovery-status.json');
 assert.deepEqual([stored.variantCalls,stored.variantErrors,stored.variantThrottled,stored.variantSkipped],[0,0,0,0]);
}
function variantUrl(urls){
 return urls.some(url=>{
  const text=textOf(url);
  return text.includes('одиннадцать')||text.includes('Блэйд')||/year=197[46]/.test(text)||/year=199[79]/.test(text)||/year=200[02]/.test(text)||/year=202[13]/.test(text)||/year=190[13]/.test(text);
 });
}

const blade=item('Блейд 1','блейд 1',1998,120);
for(const discovery of [undefined,'on',' on ','ON']){
 const off=await resolve(discovery?{discovery}:{},blade,empty);
 assert.equal(off.decision.status,'no_confident_match',String(discovery));
 assert.equal(off.preview.proposedCandidates,undefined);
 assert.equal(off.result.tmdbCalls,off.calls());
 assert.equal(off.catalog['tmdb_36647'],undefined);
 zeros(off.result,off.records);
 assert.equal(variantUrl(off.urls),false);
}

const ocean=item('11 друзей Оушена','11 друзей оушена',2001,116);
const oceanRun=await resolve({discovery:'on'},ocean,url=>textOf(url).includes('одиннадцать')?json({total_pages:1,results:[movie(161,'Одиннадцать друзей Оушена',"Ocean's Eleven",2001)]}):empty());
assert.equal(oceanRun.decision.status,'no_confident_match');
assert.equal(oceanRun.preview.proposedCandidates,undefined);
assert.equal(oceanRun.catalog['tmdb_161'],undefined);
zeros(oceanRun.result,oceanRun.records);
assert.equal(oceanRun.urls.some(url=>textOf(url).includes('одиннадцать')),false);

const spelling=await resolve({scored:'off',discovery:'on'},blade,url=>textOf(url).includes('Блэйд')?json({total_pages:1,results:[movie(36647,'Блэйд','Blade',1998)]}):empty());
assert.equal(spelling.decision.status,'no_confident_match');
assert.equal(spelling.preview.proposedCandidates,undefined);
assert.equal(spelling.catalog['tmdb_36647'],undefined);
zeros(spelling.result,spelling.records);
assert.equal(spelling.urls.some(url=>textOf(url).includes('Блэйд')),false);

const exact=item('Северный тест','северный тест',2001,100);
const exactRun=await resolve({},exact,url=>url.includes('/movie/77')?json(detail(77,'Северный тест','Северный тест',2001,100)):textOf(url).includes('Северный тест')?json({total_pages:1,results:[movie(77,'Северный тест','Северный тест',2001)]}):empty());
assert.equal(exactRun.decision.status,'verified');
assert.equal(exactRun.decision.identitySource,'tmdb_detail');
assert.equal(exactRun.decision.tmdbId,'77');
assert.equal(exactRun.preview.outcome,'detail_verified');
assert.equal(exactRun.preview.proposedCandidates,undefined);
assert.equal(exactRun.catalog['tmdb_77'].canonicalIdentity,'tmdb:77');
assert.equal(exactRun.result.tmdbCalls,exactRun.calls());
zeros(exactRun.result,exactRun.records);
assert.equal(variantUrl(exactRun.urls),false);

const exactOn=await resolve({discovery:'on'},exact,url=>url.includes('/movie/77')?json(detail(77,'Северный тест','Северный тест',2001,100)):textOf(url).includes('Северный тест')?json({total_pages:1,results:[movie(77,'Северный тест','Северный тест',2001)]}):empty());
assert.equal(exactOn.decision.status,'verified');
assert.equal(exactOn.decision.tmdbId,'77');
zeros(exactOn.result,exactOn.records);

const matrix=item('Матрица','матрица',1999,136);
const matrixRun=await resolve({discovery:'on'},matrix,url=>url.includes('/movie/603')?json(detail(603,'Матрица','The Matrix',1999,136)):textOf(url).includes('Матрица')?json({total_pages:1,results:[movie(603,'Матрица','The Matrix',1999)]}):empty(),{'epg/discovered-films.json':{tmdb_604:{id:'tmdb_604',tmdbId:'604',title:'Матрица',original:'The Matrix Reloaded',year:1999,runtime:138,canonicalIdentity:'tmdb:604',aliases:[],shows:[]}}});
assert.notEqual(matrixRun.decision?.status,'verified');
assert.equal(matrixRun.catalog['tmdb_603'],undefined,'a competing edition is not written');
assert.equal(matrixRun.preview.proposedCandidates,undefined);
zeros(matrixRun.result,matrixRun.records);

const shelter=item('Убежище','убежище',2022,88);
const shelterRun=await resolve({discovery:'on'},shelter,url=>{
 const text=textOf(url);
 if(text.includes('/movie/801970'))return json(detail(801970,'Убежище','Refuge',2023,91));
 if(text.includes('Убежище'))return json({total_pages:1,results:[movie(801970,'Убежище','Refuge',2023)]});
 return empty();
});
assert.equal(shelterRun.preview.reason,'short_title_adjacent_year');
assert.equal(shelterRun.decision.status,'needs_verification');
assert.equal(shelterRun.catalog['tmdb_801970'],undefined);
assert.equal(shelterRun.urls.some(url=>textOf(url).includes('year=2023')),false);
zeros(shelterRun.result,shelterRun.records);

const moved=await resolve({discovery:'on'},exact,async(url,records)=>{
 if(url.includes('/movie/77')){records.set('epg/published-generation.json',{programmeRunId:'run-2',phase:'published'});return json(detail(77,'Северный тест','Северный тест',2001,100));}
 if(textOf(url).includes('Северный тест'))return json({total_pages:1,results:[movie(77,'Северный тест','Северный тест',2001)]});
 return empty();
});
assert.notEqual(moved.decision?.status,'verified');
assert.equal(moved.catalog['tmdb_77'],undefined,'a generation that moved during the detail read gets no film');
assert.equal(moved.result.stage,'programme_changed');

const throttled=await resolve({discovery:'on'},exact,()=>new Response('',{status:429,headers:{'Retry-After':'30'}}));
assert.equal(throttled.result.variantThrottled,0);
assert.equal(throttled.result.variantCalls,0);
assert.equal(throttled.catalog['tmdb_77'],undefined);
assert.ok(throttled.result.error||throttled.result.retryAt);

const clockStart=1700000000000,clockShow={channelId:'n',channel:'N',start:clockStart,end:clockStart+3600000};
function clockRow(title,year,duration){const normalized=title.toLowerCase();return {key:normalized+'|'+year,title,normalizedTitle:normalized,year,duration,durations:[duration],seenInLatestSnapshot:true,shows:[clockShow],lastAiring:clockStart,airings:1};}
function phasedHarness(flags,response){
 const Real=Date;
 function Clock(...args){if(!new.target)return Real(...args);return args.length?new Real(...args):new Real(clockStart);}
 Clock.now=()=>clockStart;Clock.parse=Real.parse;Clock.UTC=Real.UTC;Clock.prototype=Real.prototype;
 const records=new Map(),etags=new Map();let revision=0;const urls=[];
 const env={CANDIDATE_DISCOVERY:flags.discovery,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:Clock,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async input=>{const url=String(input);urls.push(url);return response(url);}});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
 ctx.env=env;
 return {ctx,records,urls};
}
const keptFilm=clockRow('Тест фильм',2001,100),sideFilm=clockRow('Боковой план',1902,90);
const sideEvidence=vm.runInContext('candidateEvidence('+JSON.stringify(sideFilm)+')',phasedHarness({}).ctx);
const sidePlan={schemaVersion:1,programmeRunId:'run-1',jobs:[{key:sideFilm.key,title:sideFilm.title,normalizedTitle:sideFilm.normalizedTitle,year:1902,duration:90,durations:[90],evidenceKey:sideEvidence,priorDecision:null,hadPriorDecision:false,legacyStatus:'no_confident_match',offset:0,pendingAliasIds:[],proposals:[],hits:[]}]};
const isolated=phasedHarness({discovery:'on'},url=>{const text=textOf(url);if(text.includes('year=1901')||text.includes('year=1903'))return json({total_pages:1,results:[movie(1,'Боковой план','Side',1901)]});if(text.includes('/movie/77'))return json(detail(77,'Тест фильм','Тест фильм',2001,100));if(text.includes('Тест фильм'))return json({total_pages:1,results:[movie(77,'Тест фильм','Тест фильм',2001)]});return empty();});
isolated.records.set('programme.json',{runId:'run-1',films:[]});
isolated.records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[keptFilm,sideFilm]});
isolated.records.set('epg/discovered-films.json',{});
isolated.records.set('epg/published-generation.json',{programmeRunId:'run-1',phase:'published'});
isolated.records.set('epg/discovery-resolution.json',{[sideFilm.key]:{status:'no_confident_match',attempts:1,evidenceKey:sideEvidence,retryAt:new Date(clockStart+86400000).toISOString(),checkedAt:new Date(clockStart).toISOString(),lastAttemptAt:new Date(clockStart).toISOString()}});
isolated.records.set('epg/discovery-variant-pending.json',sidePlan);
const sideBefore=JSON.stringify(isolated.records.get('epg/discovery-variant-pending.json'));
const isolatedResult=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',isolated.ctx);
assert.equal(variantUrl(isolated.urls),false);
assert.equal(JSON.stringify(isolated.records.get('epg/discovery-variant-pending.json')),sideBefore,'a leftover variant plan is not read');
assert.equal(isolated.records.get('epg/discovery-resolution.json')[keptFilm.key].status,'verified');
assert.equal(isolated.records.get('epg/discovery-resolution.json')[keptFilm.key].tmdbId,'77');
assert.equal(isolated.records.get('epg/discovery-resolution.json')[sideFilm.key].status,'no_confident_match');
zeros(isolatedResult,isolated.records);

console.log('Candidate discovery: the retired search adds no requests, and the scored path still verifies, holds and fences.');
