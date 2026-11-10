import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map();
const env={BUCKET:{
 async get(key){return records.has(key)?{etag:'test',json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value){records.set(key,JSON.parse(value));return {etag:'test'};},
 async list(){return {objects:[],truncated:false};}
}};
let now=Date.parse('2026-11-10T17:40:00Z');
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const context=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:Clock,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
}

const SCAN='2026-11-10T16:00:00.000Z';
const DONE='2026-11-10T17:36:16.213Z';
const START='2026-11-10T16:00:00.000Z';
const RUN='6d9e3c36-bba2-4e4a-a92d-b2984abdc810';
const film=(id,tmdbId)=>({id,tmdbId:String(tmdbId),title:id,original:id,year:2020,genres:[],actors:[],directors:[],shows:[{start:now}]});
function seed(){
 records.clear();
 records.set('programme.json',{runId:RUN,updatedAt:SCAN,watchlistUpdatedAt:START,watchlistCount:1,films:[film('watch-a',1)],stats:{epgStart:now-72*3600000,epgEnd:now+24*3600000,channels:1,scanned:1,uniqueFilms:1,titleMissing:0,titleProvisional:0,metadataMissing:0}});
 records.set('watchlist.json',{updatedAt:SCAN,films:[film('watch-a',1)]});
 records.set('titles.json',{});
 records.set('sync.json',{runId:RUN,stage:'complete',startedAt:START,updatedAt:DONE,completedAt:DONE});
}
async function programme(){
 const response=await context.worker.fetch(new Request('https://site.example/api/programme'),env);
 assert.equal(response.status,200);
 return response.json();
}
async function footer(){
 const response=await context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env);
 assert.equal(response.status,200);
 return response.json();
}
const source=(body,id)=>body.integrations.sources.find(item=>item.id===id);
const ux=(sync,report)=>context.epgUxPublishedAt(sync,report);

seed();
const completeReport=await programme();
const completeFooter=await footer();
assert.equal(completeReport.updatedAt,SCAN,'scan clock still defines archive/future windows');
assert.equal(completeReport.publishedAt,DONE);
assert.equal(source(completeFooter,'epg').lastSuccessAt,DONE);
assert.equal(ux(records.get('sync.json'),records.get('programme.json')),DONE);
assert.equal(ux(records.get('sync.json'),records.get('programme.json')),source(completeFooter,'epg').lastSuccessAt);

const pending={id:RUN+'-epg',type:'epg',at:DONE,films:1,archive:0,future:0,broadcasts:1};
assert.equal(pending.at,completeReport.publishedAt,'events at matches programme publishedAt');
assert.equal(pending.at,source(completeFooter,'epg').lastSuccessAt);

records.set('sync.json',{runId:'next-run',stage:'seal',startedAt:'2026-11-11T16:00:00.000Z',updatedAt:'2026-11-11T16:20:00.000Z',lastEpgPublishedAt:DONE,seal:{phase:'ledger'}});
const sealing=await programme();
const sealingFooter=await footer();
assert.equal(sealing.publishedAt,DONE);
assert.equal(source(sealingFooter,'epg').lastSuccessAt,DONE);
assert.equal(source(sealingFooter,'epg').state,'running');
assert.notEqual(sealing.publishedAt,records.get('sync.json').startedAt);
assert.notEqual(sealing.publishedAt,records.get('programme.json').updatedAt);

records.set('sync.json',{runId:'next-run',stage:'epg',startedAt:'2026-11-11T16:00:00.000Z',updatedAt:'2026-11-11T16:05:00.000Z',lastEpgPublishedAt:DONE});
assert.equal((await programme()).publishedAt,DONE);
assert.equal(source(await footer(),'epg').lastSuccessAt,DONE);

records.set('sync.json',{runId:'next-run',stage:'epg',startedAt:'2026-11-11T16:00:00.000Z',updatedAt:'2026-11-11T16:10:00.000Z',error:'EPG HTTP 502',lastEpgPublishedAt:DONE});
const failed=await footer();
assert.equal(source(failed,'epg').state,'failed');
assert.equal(source(failed,'epg').lastSuccessAt,DONE);
assert.equal((await programme()).publishedAt,DONE);

records.set('sync.json',{runId:'next-run',stage:'complete',updatedAt:DONE,error:'publish_failed',lastEpgPublishedAt:DONE});
assert.equal(ux(records.get('sync.json'),records.get('programme.json')),DONE,'an unpublished complete record does not take updatedAt as success');

const first=await programme();
assert.equal(first.publishedAt,DONE);
const again=await programme();
assert.equal(again.publishedAt,first.publishedAt);

records.set('sync.json',{runId:RUN,stage:'complete',updatedAt:'not-a-time'});
assert.equal((await programme()).publishedAt,undefined);
assert.equal(source(await footer(),'epg').lastSuccessAt,null);

records.delete('sync.json');
assert.equal((await programme()).publishedAt,undefined);
assert.equal(source(await footer(),'epg').lastSuccessAt,null);

assert.equal(ux({stage:'complete',updatedAt:'2026-11-10T17:36:16.213Z',runId:RUN},{runId:RUN,updatedAt:SCAN}),DONE.replace('.213Z','.213Z'));
assert.equal(context.epgUxPublishedAt({stage:'complete',completedAt:DONE,updatedAt:SCAN,runId:RUN},{runId:RUN,updatedAt:SCAN}),DONE);

const ui=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,JSON,console,document:{querySelector(){return null;},querySelectorAll(){return [];},documentElement:{classList:{toggle(){}}}},window:{history:{state:null,pushState(){},replaceState(){}},location:{href:'https://iptv.example/'}}});
vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ui);
const stamp=iso=>ui.madridStamp(Date.parse(iso));
assert.equal(stamp(START),'10 нояб., 17:00');
assert.equal(stamp(DONE),'10 нояб., 18:36');
assert.notEqual(stamp(START),stamp(DONE));
const midnight=ui.madridStamp(Date.parse('2026-11-10T23:30:00.000Z'));
assert.match(midnight,/11 нояб/);
const previousTz=process.env.TZ;
process.env.TZ='America/New_York';
assert.equal(ui.madridStamp(Date.parse(DONE)),stamp(DONE),'display stays Europe/Madrid when the process zone is not Madrid');
if(previousTz===undefined)delete process.env.TZ;else process.env.TZ=previousTz;

const node={textContent:'',classList:{remove(){},add(){}}};
ui.document.querySelector=sel=>sel==='#snapshot-updated'?node:null;
vm.runInContext(`report={updatedAt:${JSON.stringify(SCAN)},publishedAt:${JSON.stringify(DONE)},window:{from:${now}-72*3600000,to:${now}+24*3600000},stats:{epgEnd:${now}+20*3600000}};programmeRefreshError=null;updateProgrammeStatus();`,ui);
assert.equal(node.textContent,'Обновлено '+stamp(DONE));
vm.runInContext('report={updatedAt:'+JSON.stringify(SCAN)+',window:report.window,stats:report.stats};updateProgrammeStatus();',ui);
assert.equal(node.textContent,'Обновлено — нет данных');

const footerUi=ui.footerStatusText({integrations:{sources:[{id:'epg',state:'healthy',code:'ok',lastSuccessAt:DONE}]},epgTmdb:{}});
assert.equal(footerUi.epgUpdated,stamp(DONE));
assert.equal(footerUi.epgSummary,stamp(DONE));

console.log('EPG publishedAt UX clock: header, footer and events share completion time; scan/start are not shown');
