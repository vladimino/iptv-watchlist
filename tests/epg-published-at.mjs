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

// AIR-518. A seal step failed after the pointer switch (rated_admission_incomplete in finalize_scan) and a retry of the same run reached
// `complete`; the error stays on sync.json. The published generation is this run, so its completion is the published date.
const OLD='2026-11-08T16:08:00.000Z';
const NEW_RUN='47663279-3e6b-423d-b696-b22edfcead91';
const NEW_SCAN='2026-11-16T15:00:00.000Z';
const NEW_DONE='2026-11-16T19:17:00.000Z';
now=Date.parse('2026-11-17T09:00:00Z');
const recovered={runId:NEW_RUN,stage:'complete',startedAt:'2026-11-16T15:00:00.000Z',updatedAt:NEW_DONE,completedAt:NEW_DONE,error:'rated_admission_incomplete',lastEpgPublishedAt:OLD};
function seedGeneration(runId){seed();records.set('programme.json',{...records.get('programme.json'),runId,updatedAt:NEW_SCAN});}
seedGeneration(NEW_RUN);
records.set('sync.json',structuredClone(recovered));
const recoveredProgramme=await programme();
const recoveredFooter=await footer();
assert.equal(recoveredProgramme.publishedAt,NEW_DONE,'a recovered error does not hide the publication of this run');
assert.equal(source(recoveredFooter,'epg').lastSuccessAt,NEW_DONE);
assert.equal(source(recoveredFooter,'epg').state,'healthy');
assert.equal(source(recoveredFooter,'epg').code,'ok');
assert.equal(source(recoveredFooter,'epg').lastFailureAt,null);
assert.equal(source(recoveredFooter,'epg').runId,NEW_RUN);
assert.deepEqual({...source(recoveredFooter,'epg').lastAttempt},{outcome:'recovered',code:'epg_failed'},'the earlier failed attempt stays visible as diagnostics');
assert.notEqual(recoveredFooter.integrations.aggregate,'failed');
const recoveredState=context.epgPublicationState(recovered,{runId:NEW_RUN});
assert.equal(recoveredState.binding,'run');
assert.equal(recoveredState.attempt.outcome,'recovered');
assert.equal(context.epgCarriedPublishedAt(recovered),NEW_DONE,'the next run carries the recovered completion as lastEpgPublishedAt (explicitly unbound helper)');
assert.equal(ux(recovered,null),OLD,'the UI contract never credits a record without the published programme');
assert.equal(records.get('sync.json').error,'rated_admission_incomplete','reads never rewrite sync.json');

// Freshness follows the published completion: 37 h later the same publication is stale, not failed.
now=Date.parse(NEW_DONE)+37*3600000;
const staleFooter=await footer();
assert.equal(source(staleFooter,'epg').state,'healthy','48 h integration threshold is not reached at 37 h');
now=Date.parse(NEW_DONE)+49*3600000;
assert.equal(source(await footer(),'epg').state,'stale');
now=Date.parse('2026-11-17T09:00:00Z');

// A failure before the pointer switch stays failed with the previous date.
records.set('programme.json',{...records.get('programme.json'),runId:RUN});
records.set('sync.json',{runId:NEW_RUN,stage:'seal',startedAt:'2026-11-16T15:00:00.000Z',updatedAt:'2026-11-16T16:00:00.000Z',error:'EPG generation changed during publish',lastEpgPublishedAt:OLD,seal:{phase:'publish'}});
let before=await footer();
assert.equal(source(before,'epg').state,'failed');
assert.equal(source(before,'epg').lastSuccessAt,OLD);
assert.equal(source(before,'epg').lastFailureAt,'2026-11-16T16:00:00.000Z');
assert.equal((await programme()).publishedAt,OLD);

// A seal in flight keeps the last proven date and reads as running, not as a new success.
records.set('sync.json',{runId:NEW_RUN,stage:'seal',startedAt:'2026-11-17T08:00:00.000Z',updatedAt:'2026-11-17T08:55:00.000Z',lastEpgPublishedAt:OLD,seal:{phase:'finalize'}});
assert.equal((await programme()).publishedAt,OLD);
assert.equal(source(await footer(),'epg').state,'running');

// The published generation (or a stale R2 mirror read as it) names another run: the complete record is not its receipt.
records.set('sync.json',structuredClone(recovered));
const mismatchProgramme=await programme();
const mismatchFooter=await footer();
assert.equal(mismatchProgramme.publishedAt,OLD,'only the last proven date is shown');
assert.equal(source(mismatchFooter,'epg').state,'unknown');
assert.equal(source(mismatchFooter,'epg').code,'epg_unproven');
assert.equal(source(mismatchFooter,'epg').runId,RUN);
records.set('sync.json',{...recovered,error:undefined});
assert.equal(source(await footer(),'epg').state,'unknown','a clean complete record of another run is not green either');

// No readable generation (a held or missing publication): a recovered record is not proven, and is not called failed.
records.delete('programme.json');
records.set('sync.json',structuredClone(recovered));
const heldFooter=await footer();
assert.equal(source(heldFooter,'epg').state,'unknown');
assert.equal(source(heldFooter,'epg').code,'epg_unproven');
assert.equal(source(heldFooter,'epg').lastSuccessAt,OLD);

// Review of PR #730: the binding is mandatory. A clean complete record without the published programme, a record without
// sync.runId, a programme without runId, and a malformed completedAt beside a valid updatedAt are never a success.
records.set('sync.json',{runId:NEW_RUN,stage:'complete',updatedAt:NEW_DONE,completedAt:NEW_DONE,lastEpgPublishedAt:OLD});
const cleanNoProgramme=await footer();
assert.equal(source(cleanNoProgramme,'epg').state,'unknown','generation unavailable, no error: not healthy');
assert.equal(source(cleanNoProgramme,'epg').code,'epg_unproven');
assert.equal(source(cleanNoProgramme,'epg').lastSuccessAt,OLD);
assert.equal(context.epgPublicationState({runId:'run-a',stage:'complete',completedAt:NEW_DONE},null).binding,'none');
seedGeneration(NEW_RUN);
records.set('sync.json',{stage:'complete',updatedAt:NEW_DONE,completedAt:NEW_DONE,lastEpgPublishedAt:OLD});
assert.equal((await programme()).publishedAt,OLD,'no sync.runId: the published run is not credited');
assert.equal(source(await footer(),'epg').state,'unknown');
assert.equal(context.epgPublicationState({stage:'complete',completedAt:NEW_DONE},{runId:'run-b'}).binding,'none');
records.set('programme.json',{...records.get('programme.json'),runId:undefined});
records.set('sync.json',{runId:NEW_RUN,stage:'complete',updatedAt:NEW_DONE,completedAt:NEW_DONE,lastEpgPublishedAt:OLD});
assert.equal((await programme()).publishedAt,OLD,'a published programme without runId proves nothing');
assert.equal(source(await footer(),'epg').state,'unknown');
seedGeneration(NEW_RUN);
records.set('sync.json',{runId:NEW_RUN,stage:'complete',updatedAt:NEW_DONE,completedAt:'invalid',lastEpgPublishedAt:OLD});
assert.equal((await programme()).publishedAt,OLD,'a malformed completedAt is not replaced by a valid updatedAt');
assert.equal(source(await footer(),'epg').state,'unknown');
assert.equal(context.epgCarriedPublishedAt({runId:NEW_RUN,stage:'complete',updatedAt:NEW_DONE,completedAt:'invalid',lastEpgPublishedAt:OLD}),OLD);
// A record written before AIR-390 (no completedAt field) bound to the published run still reads its complete updatedAt.
records.set('sync.json',{runId:NEW_RUN,stage:'complete',updatedAt:NEW_DONE});
assert.equal((await programme()).publishedAt,NEW_DONE);
assert.equal(source(await footer(),'epg').state,'healthy');
records.delete('programme.json');

// A record with an error and no completion receipt (written before AIR-390) proves nothing new.
assert.equal(ux({runId:NEW_RUN,stage:'complete',updatedAt:NEW_DONE,error:'rated_admission_incomplete',lastEpgPublishedAt:OLD},{runId:NEW_RUN}),OLD);
assert.equal(ux({runId:NEW_RUN,stage:'complete',updatedAt:NEW_DONE,completedAt:'garbage',error:'x',lastEpgPublishedAt:OLD},{runId:NEW_RUN}),OLD);
assert.equal(context.epgPublicationState({runId:NEW_RUN,stage:'complete',completedAt:'garbage',updatedAt:'garbage'},{runId:NEW_RUN}).binding,'none');
now=Date.parse('2026-11-10T17:40:00Z');

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

// AIR-518 header: age comes from the published completion, the window from the clock and the feed's real shows; they are separate states.
const H=3600000,clock=Date.parse('2026-11-17T09:00:00Z');
const headerStatus=(publishedAt,epgEnd)=>{vm.runInContext(`report={updatedAt:${JSON.stringify(NEW_SCAN)},publishedAt:${JSON.stringify(publishedAt)},window:{from:${clock-72*H},to:${clock+24*H}},stats:{epgEnd:${epgEnd}}};`,ui);return ui.programmeStatus(ui.effectiveWindow(ui.report??vm.runInContext('report',ui),clock));};
assert.equal(headerStatus(new Date(clock-35*H).toISOString(),clock+20*H).badge,'Программа актуальна');
assert.equal(headerStatus(new Date(clock-37*H).toISOString(),clock+20*H).badge,'Данные устарели','36 h threshold from the published completion');
assert.equal(headerStatus(NEW_DONE,clock+20*H).badge,'Программа актуальна','recovered publication of 16.11 is fresh on 17.11');
assert.equal(headerStatus(OLD,clock+20*H).badge,'Данные устарели');
assert.equal(headerStatus(NEW_DONE,clock-H).badge,'Будущей программы нет','an ended feed is not an old snapshot');
assert.doesNotMatch(headerStatus(NEW_DONE,clock-H).coverage,/устарел/);
// DST: 25 Oct 2026 Madrid falls back at 03:00 CEST → 02:00 CET.
assert.equal(ui.madridStamp(Date.parse('2026-10-24T22:30:00Z')),'25 окт., 00:30');
assert.equal(ui.madridStamp(Date.parse('2026-10-25T02:30:00Z')),'25 окт., 03:30');
const recoveredUi=ui.footerStatusText({integrations:{sources:[{id:'epg',state:'healthy',code:'ok',lastSuccessAt:NEW_DONE,lastFailureAt:null,lastAttempt:{outcome:'recovered',code:'epg_failed'}}]},epgTmdb:{}});
assert.equal(recoveredUi.epgSummary,ui.madridStamp(Date.parse(NEW_DONE)));
assert.equal(ui.madridStamp(Date.parse(NEW_DONE)),'16 нояб., 20:17','16.11 publication in Madrid time');
const unprovenUi=ui.footerStatusText({integrations:{sources:[{id:'epg',state:'unknown',code:'epg_unproven',lastSuccessAt:OLD}]},epgTmdb:{}});
assert.match(unprovenUi.integrations.epg,/не подтверждена/);

console.log('EPG publishedAt UX clock: header, footer and events share completion time; scan/start are not shown');
