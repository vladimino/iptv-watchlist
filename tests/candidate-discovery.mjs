import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async()=>new Response('{}')});
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),live);
const variants=title=>vm.runInContext('candidateSearchVariants('+JSON.stringify(title)+')',live);
const reasons=(title,year)=>variants({title,year}).map(row=>row.reason+':'+row.query+':'+(row.year??''));
assert.equal(vm.runInContext("[candidateDiscoveryMode({}),candidateDiscoveryMode({CANDIDATE_DISCOVERY:'on'}),candidateDiscoveryMode({CANDIDATE_DISCOVERY:' shadow '})].join()",live),'off,off,shadow');
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

function harness(flags,response){
 const records=new Map(),etags=new Map();let revision=0,calls=0;const urls=[];
 const env={TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 if(flags.scored)env.SCORED_RESOLUTION=flags.scored;
 if(flags.discovery)env.CANDIDATE_DISCOVERY=flags.discovery;
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async input=>{calls++;urls.push(String(input));return response(String(input),records);}});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
 ctx.env=env;ctx.records=records;
 return {ctx,records,calls:()=>calls,urls};
}
const now=Date.now();
const show={channelId:'n',channel:'N',start:now,end:now+3600000};
function item(title,normalizedTitle,year,duration){return {key:normalizedTitle+'|'+(year??''),title,normalizedTitle,year,duration,durations:[duration],seenInLatestSnapshot:true,shows:[show],lastAiring:now,airings:1};}
function movie(id,title,original,year){return {id,title,original_title:original||title,release_date:year+'-01-01'};}
function detail(id,title,original,year,runtime,aliases=[]){return {id:Number(id),title,original_title:original,release_date:year+'-01-01',runtime,overview:'A synopsis',genres:[{name:'Drama'}],poster_path:null,credits:{crew:[],cast:[]},translations:{translations:[]},alternative_titles:{titles:aliases.map(name=>({iso_3166_1:'RU',title:name}))}};}
function seed(records,row){records.set('programme.json',{runId:'run-1',films:[]});records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[row]});records.set('epg/discovered-films.json',{});records.set('epg/published-generation.json',{programmeRunId:'run-1',phase:'published'});}
async function resolve(flags,row,response){
 const box=harness(flags,response);seed(box.records,row);
 const result=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',box.ctx);
 return {...box,result,decision:box.records.get('epg/discovery-resolution.json')[row.key],preview:box.records.get('epg/discovery-score-preview.json')?.items[row.key],catalog:box.records.get('epg/discovered-films.json')};
}
const empty=()=>new Response(JSON.stringify({total_pages:1,results:[]}));
const json=body=>new Response(JSON.stringify(body));
const blade=item('Блейд 1','блейд 1',1998,120);
const off=await resolve({scored:'shadow'},blade,empty);
assert.equal(off.decision.status,'no_confident_match');
assert.equal(off.preview.proposedCandidates,undefined);
assert.equal(off.result.tmdbCalls,off.calls());
assert.equal(off.catalog['tmdb_36647'],undefined);

const bladeOn=await resolve({scored:'shadow',discovery:'shadow'},blade,url=>url.includes(encodeURIComponent('Блэйд'))?json({total_pages:1,results:[movie(36647,'Блэйд','Blade',1998)]}):empty());
assert.equal(bladeOn.decision.status,'no_confident_match');
assert.equal(bladeOn.decision.identitySource,undefined);
assert.equal(bladeOn.catalog['tmdb_36647'],undefined);
assert.equal(bladeOn.preview.scoring.status,'no_confident_match');
assert.ok(bladeOn.preview.proposedCandidates.some(row=>row.tmdbId==='36647'&&row.reason==='spelling_e'));
assert.equal(bladeOn.result.tmdbCalls,2);
assert.ok(bladeOn.calls()>bladeOn.result.tmdbCalls);
assert.equal(bladeOn.result.error,null);

const irony=item('Ирония судьбы, или С легким паром','ирония судьбы или с легким паром',1975,192);
const ironyRun=await resolve({scored:'shadow',discovery:'shadow'},irony,url=>url.includes('/movie/43430')?json(detail(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976,184)):url.includes('year=1976')?json({total_pages:1,results:[movie(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976)]}):empty());
assert.equal(ironyRun.decision.status,'no_confident_match');
assert.equal(ironyRun.catalog['tmdb_43430'],undefined);
assert.ok(ironyRun.preview.proposedCandidates.some(row=>row.tmdbId==='43430'&&row.reason==='year_after'));
assert.equal(ironyRun.preview.scoring.acceptedTmdbId,'43430');
assert.equal(ironyRun.preview.outcome,'detail_verified');
assert.equal(ironyRun.preview.comparison,'scored_only');

const ocean=item('11 друзей Оушена','11 друзей оушена',2001,116);
const oceanRun=await resolve({scored:'shadow',discovery:'shadow'},ocean,url=>decodeURIComponent(url).includes('одиннадцать')?json({total_pages:1,results:[movie(161,'Одиннадцать друзей Оушена',"Ocean's Eleven",2001)]}):empty());
assert.equal(oceanRun.decision.status,'no_confident_match');
assert.equal(oceanRun.preview.scoring.acceptedTmdbId,null);
assert.ok(oceanRun.preview.proposedCandidates.some(row=>row.tmdbId==='161'&&row.reason==='numeral'));
assert.equal(oceanRun.catalog['tmdb_161'],undefined);

const kombat=item('Мортал Комбат','мортал комбат',1995,101);
const kombatRun=await resolve({scored:'shadow',discovery:'shadow'},kombat,url=>url.includes('/movie/9312')?json(detail(9312,'Смертельная битва','Mortal Kombat',1995,101,['Мортал Комбат'])):json({total_pages:1,results:[movie(9312,'Смертельная битва','Mortal Kombat',1995)]}));
assert.equal(kombatRun.decision.status,'no_confident_match');
assert.equal(kombatRun.preview.scoring.status,'no_confident_match');
assert.equal(kombatRun.preview.scoring.acceptedTmdbId,null);
assert.ok(kombatRun.preview.proposedCandidates.some(row=>row.tmdbId==='9312'&&row.reason==='tmdb_alias'));
assert.equal(kombatRun.catalog['tmdb_9312'],undefined);

const wonder=item('Чудо-женщина','чудо женщина',2020,151);
const wonderRun=await resolve({scored:'shadow',discovery:'shadow'},wonder,url=>url.includes('year=2019')?json({total_pages:1,results:[movie(464052,'Чудо-женщина: 1984','Wonder Woman 1984',2020)]}):empty());
assert.equal(wonderRun.decision.status,'no_confident_match');
assert.equal(wonderRun.preview.scoring.acceptedTmdbId,null);
assert.ok(wonderRun.preview.proposedCandidates.some(row=>row.tmdbId==='464052'));
assert.equal(wonderRun.catalog['tmdb_464052'],undefined);

const runner=item('Бегущий человек','бегущий человек',1987,101);
const runnerResult=await resolve({scored:'shadow',discovery:'shadow'},runner,url=>url.includes('year=1988')?json({total_pages:1,results:[movie(798645,'Бегущий человек','The Running Man',2025)]}):empty());
assert.equal(runnerResult.decision.status,'no_confident_match');
assert.equal(runnerResult.preview.scoring.acceptedTmdbId,null);
assert.equal(runnerResult.preview.proposedCandidates,undefined);
assert.equal(runnerResult.catalog['tmdb_798645'],undefined);

const limited=await resolve({scored:'shadow',discovery:'shadow'},blade,url=>{if(url.includes('search/movie')&&!url.includes('year=1998'))return new Response('',{status:429,headers:{'Retry-After':'30'}});return empty();});
assert.equal(limited.result.error,null);
assert.equal(limited.decision.status,'no_confident_match');
assert.equal(limited.catalog['tmdb_36647'],undefined);

const moved=await resolve({scored:'shadow',discovery:'shadow'},irony,async(url,records)=>{if(url.includes('year=1976')){records.set('epg/published-generation.json',{programmeRunId:'run-2',phase:'published'});return json({total_pages:1,results:[movie(43430,'Ирония судьбы, или С легким паром!','Ирония судьбы, или С легким паром!',1976)]});}return empty();});
assert.equal(moved.decision.status,'no_confident_match');
assert.equal(moved.catalog['tmdb_43430'],undefined);
assert.notEqual(moved.preview?.outcome,'detail_verified');

const dune=item('Dune','dune',1984,137);
const known={tmdb_11:{id:'tmdb_11',tmdbId:'11',title:'Дюна',original:'Dune',year:1984,runtime:137,canonicalIdentity:'tmdb:11',aliases:['Dune'],shows:[]}};
const duneBox=harness({scored:'shadow',discovery:'shadow'},empty);
duneBox.records.set('programme.json',{runId:'run-1',films:[]});
duneBox.records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[dune]});
duneBox.records.set('epg/discovered-films.json',known);
const duneResult=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:[]},4)',duneBox.ctx);
assert.equal(duneBox.records.get('epg/discovery-resolution.json')['dune|1984'].status,'verified');
assert.equal(duneBox.records.get('epg/discovery-resolution.json')['dune|1984'].identitySource,'known_alias_year_runtime');
assert.equal(duneResult.tmdbCalls,0);
assert.equal(duneBox.calls(),1);
console.log('Candidate discovery: title and year variants stay off the legacy decision.');
