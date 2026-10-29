import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async()=>new Response('{}')});
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),live);
const variants=title=>vm.runInContext('candidateSearchVariants('+JSON.stringify(title)+')',live);
const reasons=(title,year)=>variants({title,year}).map(row=>row.reason+':'+row.query+':'+(row.year??''));
assert.equal(vm.runInContext("[candidateDiscoveryMode({}),candidateDiscoveryMode({CANDIDATE_DISCOVERY:'on'}),candidateDiscoveryMode({CANDIDATE_DISCOVERY:' on '}),candidateDiscoveryMode({CANDIDATE_DISCOVERY:' shadow '}),candidateDiscoveryMode({CANDIDATE_DISCOVERY:'ON'})].join()",live),'off,on,on,off,off','only the exact on enables the variant searches; the shadow preview is gone');
for(const year of ['null','undefined',"''"])assert.equal(vm.runInContext(`candidateSearchVariants({title:'Блейд',year:${year}}).some(row=>String(row.reason).startsWith('year_')||row.year===0||row.year===-1||row.year===1)`,live),false);
assert.ok(reasons('Блейд 1',1998).includes('part_suffix:Блейд:1998'));
assert.ok(reasons('Блейд 1',1998).includes('spelling_e:Блэйд:1998'));
assert.ok(reasons('11 друзей Оушена',2001).includes('numeral:одиннадцать друзей Оушена:2001'));
assert.ok(reasons('Ирония судьбы, или С легким паром',1975).includes('year_before:Ирония судьбы, или С легким паром:1974'));
assert.ok(reasons('Ирония судьбы, или С легким паром',1975).includes('year_after:Ирония судьбы, или С легким паром:1976'));
assert.ok(!reasons('1984',1984).some(row=>row.startsWith('part_suffix')||row.startsWith('numeral')));
assert.ok(!reasons('7500',2014).some(row=>row.startsWith('part_suffix')||row.startsWith('numeral')));
assert.ok(reasons('Гол 2',2008).includes('part_suffix:Гол:2008'));
assert.ok(reasons('Чужой против Хищника 1',2004).some(row=>row.startsWith('part_suffix:Чужой против Хищника:')));
assert.ok(!reasons('Бегущий человек',1987).some(row=>row.startsWith('part_suffix')||row.startsWith('numeral')));
assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/CANDIDATE_DISCOVERY/);

function harness(flags,response,date=Date){
 const records=new Map(),etags=new Map();let revision=0,calls=0;const urls=[];
 const env={TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 if(flags.scored)env.SCORED_RESOLUTION=flags.scored;
 if(flags.discovery)env.CANDIDATE_DISCOVERY=flags.discovery;
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async input=>{calls++;urls.push(String(input));return response(String(input),records);}});
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
// Without CANDIDATE_DISCOVERY the scored writer makes only its own searches: no variant, no proposal, no catalog row.
const blade=item('Блейд 1','блейд 1',1998,120);
const off=await resolve({},blade,empty);
assert.equal(off.decision.status,'no_confident_match');
assert.equal(off.preview.proposedCandidates,undefined);
assert.equal(off.result.tmdbCalls,off.calls());
assert.equal(off.catalog['tmdb_36647'],undefined);

const irony=item('Ирония судьбы, или С легким паром','ирония судьбы или с легким паром',1975,192);

const ocean=item('11 друзей Оушена','11 друзей оушена',2001,116);
const oceanRun=await resolve({discovery:'on'},ocean,url=>url.includes('/movie/161')?json(detail(161,'Одиннадцать друзей Оушена',"Ocean's Eleven",2001,116)):decodeURIComponent(url).includes('одиннадцать')?json({total_pages:1,results:[movie(161,'Одиннадцать друзей Оушена',"Ocean's Eleven",2001)]}):empty());
assert.equal(oceanRun.decision.status,'verified');assert.equal(oceanRun.decision.tmdbId,'161');assert.equal(oceanRun.decision.identitySource,'tmdb_detail');
assert.equal(oceanRun.preview.scoring.reason,'accepted_numeral');assert.equal(oceanRun.preview.outcome,'detail_verified');
assert.ok(oceanRun.preview.proposedCandidates.some(row=>row.tmdbId==='161'&&row.reason==='numeral'));
assert.equal(oceanRun.catalog['tmdb_161'].canonicalIdentity,'tmdb:161','a numeral form confirmed by the detail card is written');

const matrixRival=item('Матрица 1','матрица 1',1999,136);
const matrixRivalRun=await resolve({discovery:'on'},matrixRival,url=>url.includes('/movie/603')?json(detail(603,'Матрица','The Matrix',1999,136)):decodeURIComponent(url).includes('Матрица')?json({total_pages:1,results:[movie(603,'Матрица','The Matrix',1999)]}):empty(),{'epg/discovered-films.json':{tmdb_604:{id:'tmdb_604',tmdbId:'604',title:'Матрица',original:'The Matrix Reloaded',year:1999,runtime:138,canonicalIdentity:'tmdb:604',aliases:[],shows:[]}}});
assert.equal(matrixRivalRun.preview.scoring.acceptedTmdbId,'603');assert.equal(matrixRivalRun.preview.outcome,'candidate_decision');assert.equal(matrixRivalRun.preview.reason,'detail_competing_version');
assert.equal(matrixRivalRun.decision.status,'ambiguous','a competing edition on the detail check is an ambiguous decision, not a film');assert.equal(matrixRivalRun.catalog['tmdb_603'],undefined);

const bladeLater=await resolve({discovery:'on'},blade,url=>{const text=decodeURIComponent(url).replace(/\+/g,' ');if(text.includes('/movie/36647'))return json(detail(36647,'Блэйд','Blade',1998,120));if(text.includes('Блэйд'))return json({total_pages:1,results:[movie(36647,'Блэйд','Blade',1998)]});if(text.includes('Блейд'))return json({total_pages:1,results:[movie(36647,'Блейд: начало','Blade',1998)]});return empty();});
assert.equal(bladeLater.preview.scoring.reason,'accepted_spelling_e');assert.equal(bladeLater.preview.outcome,'detail_verified');
assert.equal(bladeLater.decision.status,'verified');assert.equal(bladeLater.decision.tmdbId,'36647');assert.equal(bladeLater.catalog['tmdb_36647'].canonicalIdentity,'tmdb:36647');

const shelterRow=item('Убежище','убежище',2022,88);
const shelterRun=await resolve({discovery:'on'},shelterRow,url=>{const text=decodeURIComponent(url).replace(/\+/g,' ');if(text.includes('/movie/801970'))return json(detail(801970,'Убежище','Refuge',2023,91));if(text.includes('year=2023'))return json({total_pages:1,results:[movie(801970,'Убежище','Refuge',2023)]});return empty();});
assert.equal(shelterRun.preview.scoring.acceptedTmdbId,'801970');assert.equal(shelterRun.preview.outcome,'needs_verification');assert.equal(shelterRun.preview.reason,'short_title_adjacent_year');
assert.equal(shelterRun.decision.status,'needs_verification','a short title one year away stays held');assert.equal(shelterRun.catalog['tmdb_801970'],undefined);

const cheburashkaRow=item('Чебурашка 2','чебурашка 2',2025,103);
const cheburashkaRun=await resolve({discovery:'on'},cheburashkaRow,url=>{const text=decodeURIComponent(url).replace(/\+/g,' ');if(text.includes('/movie/1228477'))return json(detail(1228477,'Чебурашка 2','Cheburashka',2026,103));if(text.includes('year=2026'))return json({total_pages:1,results:[movie(1228477,'Чебурашка 2','Cheburashka',2026)]});return empty();});
assert.equal(cheburashkaRun.preview.outcome,'detail_verified');assert.equal(cheburashkaRun.decision.status,'verified');assert.equal(cheburashkaRun.decision.tmdbId,'1228477');assert.ok(cheburashkaRun.catalog['tmdb_1228477']);

const kombat=item('Мортал Комбат','мортал комбат',1995,101);
const kombatRun=await resolve({discovery:'on'},kombat,url=>url.includes('/movie/9312')?json(detail(9312,'Смертельная битва','Mortal Kombat',1995,101,['Мортал Комбат'])):url.includes('/movie/1?')?json(detail(1,'Совсем другое','Other Film',1995,40,['Другое'])):json({total_pages:1,results:[movie(1,'Совсем другое','Other Film',1995),movie(9312,'Смертельная битва','Mortal Kombat',1995)]}));
assert.equal(kombatRun.decision.status,'no_confident_match');
assert.equal(kombatRun.preview.scoring.status,'no_confident_match');
assert.equal(kombatRun.preview.scoring.acceptedTmdbId,null);
assert.deepEqual(kombatRun.preview.proposedCandidates.map(row=>row.tmdbId),['9312']);
assert.equal(kombatRun.preview.proposedCandidates[0].reason,'tmdb_alias');
assert.ok(kombatRun.urls.some(url=>url.includes('/movie/9312')));
assert.equal(kombatRun.catalog['tmdb_9312'],undefined);

const wonder=item('Чудо-женщина','чудо женщина',2020,151);
const wonderRun=await resolve({discovery:'on'},wonder,url=>url.includes('year=2019')?json({total_pages:1,results:[movie(464052,'Чудо-женщина: 1984','Wonder Woman 1984',2020)]}):empty());
assert.equal(wonderRun.decision.status,'no_confident_match');
assert.equal(wonderRun.preview.scoring.acceptedTmdbId,null);
assert.ok(wonderRun.preview.proposedCandidates.some(row=>row.tmdbId==='464052'));
assert.equal(wonderRun.catalog['tmdb_464052'],undefined);

const runner=item('Бегущий человек','бегущий человек',1987,101);
const runnerResult=await resolve({discovery:'on'},runner,url=>url.includes('year=1988')?json({total_pages:1,results:[movie(798645,'Бегущий человек','The Running Man',2025)]}):empty());
assert.equal(runnerResult.decision.status,'no_confident_match');
assert.equal(runnerResult.preview.scoring.acceptedTmdbId,null);
assert.equal(runnerResult.preview.proposedCandidates,undefined);
assert.equal(runnerResult.catalog['tmdb_798645'],undefined);

const limited=await resolve({discovery:'on'},blade,url=>{if(url.includes('search/movie')&&!url.includes('year=1998'))return new Response('',{status:429,headers:{'Retry-After':'30'}});return empty();});
assert.equal(limited.result.error,null);
assert.equal(limited.decision.status,'no_confident_match');
assert.equal(limited.catalog['tmdb_36647'],undefined);
assert.equal(limited.result.variantThrottled,1);
assert.equal(limited.urls.filter(url=>url.includes('search/movie')&&!url.includes('year=1998')).length,1);
assert.ok(limited.result.variantSkipped>=1);
assert.equal(limited.result.tmdbCalls,2);
assert.equal(limited.records.get('epg/discovery-status.json').variantThrottled,limited.result.variantThrottled);
const skipped=await vm.runInContext("(async()=>{const stats={calls:0,errors:0,throttled:0,skipped:0};await collectVariantProposals(env,{title:'Блейд 1',normalizedTitle:'блейд 1',year:1998,duration:120,durations:[120]},Date.now(),stats);return stats;})()",off.ctx);
assert.equal(skipped.calls,0);
assert.ok(skipped.skipped>=1);
const capped=await vm.runInContext("(async()=>{const stats={calls:8,errors:0,throttled:0,skipped:0};await collectVariantProposals(env,{title:'Блейд 1',normalizedTitle:'блейд 1',year:1998,duration:120,durations:[120]},Date.now()+60000,stats);return stats;})()",off.ctx);
assert.equal(capped.calls,8);
assert.ok(capped.skipped>=1);

const moved=await resolve({discovery:'on'},irony,async(url,records)=>{if(url.includes('year=1976')){records.set('epg/published-generation.json',{programmeRunId:'run-2',phase:'published'});return json({total_pages:1,results:[movie(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976)]});}return empty();});
assert.notEqual(moved.decision?.status,'verified');assert.equal(moved.catalog['tmdb_43430'],undefined,'a generation that moved under the variant search gets no film');

// A stale SCORED_RESOLUTION binding is ignored: the scored writer and its variant search run as if the variable were absent.
const staleBinding=await resolve({scored:'off',discovery:'on'},blade,url=>url.includes(encodeURIComponent('Блэйд'))?json({total_pages:1,results:[movie(36647,'Блэйд','Blade',1998)]}):empty());
assert.ok(staleBinding.result.variantCalls>=1);assert.notEqual(staleBinding.decision.status,'verified');assert.equal(staleBinding.catalog['tmdb_36647'],undefined);

const scoredWithout=await resolve({},irony,url=>url.includes('/movie/43430')?json(detail(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976,184)):url.includes('year=1976')?json({total_pages:1,results:[movie(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976)]}):empty());
assert.equal(scoredWithout.decision.status,'no_confident_match');
assert.equal(scoredWithout.result.variantCalls,0);
assert.ok(!scoredWithout.urls.some(url=>url.includes('year=1976')));
const scoredWith=await resolve({discovery:'on'},irony,url=>url.includes('/movie/43430')?json(detail(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976,184)):url.includes('year=1976')?json({total_pages:1,results:[movie(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976)]}):empty());
assert.equal(scoredWith.decision.status,'verified');
assert.equal(scoredWith.decision.identitySource,'tmdb_detail');
assert.equal(scoredWith.decision.tmdbId,'43430');
assert.ok(scoredWith.result.variantCalls>=1);
assert.equal(scoredWith.result.tmdbCalls<scoredWith.calls(),true);
const bladeWriter=await resolve({discovery:'on'},blade,url=>url.includes(encodeURIComponent('Блэйд'))?json({total_pages:1,results:[movie(36647,'Блэйд','Blade',1998)]}):empty());
assert.notEqual(bladeWriter.decision.status,'verified');
assert.equal(bladeWriter.catalog['tmdb_36647'],undefined);
assert.ok(bladeWriter.preview.proposedCandidates.some(row=>row.tmdbId==='36647'));


const clockStart=1700000000000,clockShow={channelId:'n',channel:'N',start:clockStart,end:clockStart+3600000};
const clockRow=(title,year,duration)=>{const normalized=title.toLowerCase();return {key:normalized+'|'+year,title,normalizedTitle:normalized,year,duration,durations:[duration],seenInLatestSnapshot:true,shows:[clockShow],lastAiring:clockStart,airings:1};};
function phasedHarness(flags,advance,response){
 let now=1700000000000;
 const Real=Date;
 function Clock(...args){if(!new.target)return Real(...args);return args.length?new Real(...args):new Real(now);}
 Clock.now=()=>now;Clock.parse=Real.parse;Clock.UTC=Real.UTC;Clock.prototype=Real.prototype;
 const records=new Map(),etags=new Map();let revision=0;const urls=[];
 const env={CANDIDATE_DISCOVERY:flags.discovery,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:Clock,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async input=>{const url=String(input);urls.push(url);now+=advance(url);return response(url);}});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
 ctx.env=env;
 return {ctx,records,urls};
}
function seedPhased(box,row){box.records.set('programme.json',{runId:'run-1',films:[]});box.records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[row]});box.records.set('epg/discovered-films.json',{});box.records.set('epg/published-generation.json',{programmeRunId:'run-1',phase:'published'});}
const ironyRow=clockRow('Ирония судьбы, или С легким паром','1975',192);ironyRow.year=1975;ironyRow.key='ирония судьбы или с легким паром|1975';ironyRow.normalizedTitle='ирония судьбы или с легким паром';
const ironyBody=url=>{const text=decodeURIComponent(url).replace(/\+/g,' ');if(text.includes('/movie/43430'))return json(detail(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976,184));if(text.includes('year=1976')||text.includes('year=1974'))return json({total_pages:1,results:[movie(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976)]});return empty();};
let writerJump=true;
const writerLate=phasedHarness({discovery:'on'},url=>writerJump&&url.includes('year=1975')?20000:0,ironyBody);
seedPhased(writerLate,ironyRow);
const writerFirst=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',writerLate.ctx);
assert.equal(writerFirst.variantCalls,0);
assert.equal(writerLate.records.get('epg/discovery-resolution.json')[ironyRow.key],undefined);
assert.equal(writerLate.records.get('epg/discovery-variant-pending.json'),undefined);
writerJump=false;
const writerSecond=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',writerLate.ctx);
assert.equal(writerLate.records.get('epg/discovery-resolution.json')[ironyRow.key].status,'verified');
assert.equal(writerLate.records.get('epg/discovery-resolution.json')[ironyRow.key].identitySource,'tmdb_detail');
assert.equal(writerLate.records.get('epg/discovery-resolution.json')[ironyRow.key].tmdbId,'43430');
assert.ok(writerLate.records.get('epg/discovered-films.json')['tmdb_43430']);
assert.ok(writerSecond.variantCalls>0);

const keptFilm=clockRow('Тест фильм',2001,100),sideFilm=clockRow('Боковой план',1902,90);
const sideEvidence=vm.runInContext('candidateEvidence('+JSON.stringify(sideFilm)+')',writerLate.ctx);
const sidePlan={schemaVersion:1,programmeRunId:'run-1',jobs:[{key:sideFilm.key,title:sideFilm.title,normalizedTitle:sideFilm.normalizedTitle,year:1902,duration:90,durations:[90],evidenceKey:sideEvidence,priorDecision:null,hadPriorDecision:false,legacyStatus:'no_confident_match',offset:0,pendingAliasIds:[],proposals:[],hits:[]}]};
const isolated=phasedHarness({discovery:'on'},()=>0,url=>{const text=decodeURIComponent(url).replace(/\+/g,' ');if(text.includes('year=1901')||text.includes('year=1903'))return json({total_pages:1,results:[movie(1,'Боковой план','Side',1901)]});if(text.includes('/movie/77'))return json(detail(77,'Тест фильм','Тест фильм',2001,100));if(text.includes('Тест фильм'))return json({total_pages:1,results:[movie(77,'Тест фильм','Тест фильм',2001)]});return empty();});
isolated.records.set('programme.json',{runId:'run-1',films:[]});
isolated.records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[keptFilm,sideFilm]});
isolated.records.set('epg/discovered-films.json',{});
isolated.records.set('epg/published-generation.json',{programmeRunId:'run-1',phase:'published'});
isolated.records.set('epg/discovery-resolution.json',{[sideFilm.key]:{status:'no_confident_match',attempts:1,evidenceKey:sideEvidence,retryAt:new Date(clockStart+86400000).toISOString(),checkedAt:new Date(clockStart).toISOString(),lastAttemptAt:new Date(clockStart).toISOString()}});
isolated.records.set('epg/discovery-variant-pending.json',sidePlan);
const sideBefore=JSON.stringify(isolated.records.get('epg/discovery-variant-pending.json'));
await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',isolated.ctx);
assert.equal(isolated.urls.some(url=>url.includes('year=1901')||url.includes('year=1903')),false);
assert.equal(JSON.stringify(isolated.records.get('epg/discovery-variant-pending.json')),sideBefore);
assert.equal(isolated.records.get('epg/discovery-resolution.json')[keptFilm.key].status,'verified');
assert.equal(isolated.records.get('epg/discovery-resolution.json')[keptFilm.key].tmdbId,'77');
console.log('Candidate discovery: title and year variants feed the scored writer, proposals stay proposals, and the shadow plan file is ignored.');
