// AIR-263: the EPG commit tail logs compact `epg_phase` markers in order, without titles, film ids, HTML or payloads, and
// the markers change nothing: the same facts, state and requests with a trace that throws.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const USER='fixture';
function harness(){
 const records=new Map(),etags=new Map(),requests=[],lines=[];let revision=0;
 const bucket={
  async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
  async list({prefix=''}={}){return {objects:[...records.keys()].filter(key=>key.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
 };
 const site=new Map();
 const ctx=vm.createContext({Response,Request,Headers,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,setTimeout:fn=>fn(),
  console:{...console,log:line=>lines.push(String(line))},
  fetch:async url=>{url=String(url);requests.push(url);const page=site.get(url);if(typeof page==='function')return page();return page!=null?{ok:true,status:200,headers:new Headers(),text:async()=>page}:{ok:false,status:404,headers:new Headers(),text:async()=>''};}});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
 for(const file of ['src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
 return {ctx,records,requests,lines,site};
}
const row=(lid,date,stars)=>{const [y,m,d]=date.split('-');return `<tr class="diary-entry-row"><td><a href="/${USER}/diary/films/for/${y}/${m}/${d}/">${d}</a></td><td><div data-postered-identifier="{&quot;lid&quot;:&quot;${lid}&quot;}"></div><h3><a href="/${USER}/film/secret-title-${lid.toLowerCase()}/">Secret Title ${lid}</a></h3></td><td><span class="rating rated-${stars}"></span></td></tr>`;};
const day=n=>new Date(Date.UTC(2026,9,29)-n*86400000).toISOString().slice(0,10);
const page1='<html><head><title>Diary</title></head><table>'+Array.from({length:20},(_,i)=>row('Lid'+i,day(i),(i%10)+1)).join('')+'</table></html>';
const env=extra=>({LETTERBOXD_USERNAME:USER,EPG_XML_URL:'https://epg.test/guide.xml',LETTERBOXD_DIARY_HISTORY:'on',LETTERBOXD_FACTS:'on',...extra});
const report={runId:'run-markers',updatedAt:'2026-10-29T10:00:00.000Z',watchlistCount:1,films:[{id:'WatchLid',title:'Secret Watch Title',url:'https://letterboxd.com/film/secret-watch/',shows:[]}],stats:{}};
const run=()=>({runId:'run-markers',stage:'epg',events:[],ratingPending:['letterboxd-diary'],watchlist:report.films,pending:[]});
const markers=lines=>lines.map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(entry=>entry?.event==='epg_phase');

// 1. The post-commit tail publishes and does not read Diary (ADR 0073). Markers stay compact and carry no titles.
const a=harness();a.site.set(`https://letterboxd.com/${USER}/diary/`,page1);a.records.set('programme.json',report);
const outA=await a.ctx.completeWithRatings({...env(),BUCKET:{get:k=>a.records.has(k)?Promise.resolve({etag:'x',json:async()=>structuredClone(a.records.get(k))}):Promise.resolve(null),put:async(k,v)=>{a.records.set(k,JSON.parse(v));return {etag:'y'};},list:async()=>({objects:[],truncated:false})}},run(),report);
assert.equal(outA.ratingsPipeline,'blocked');
assert.equal(a.requests.some(url=>url.includes('/diary/')),false,'the commit does not fetch Diary');
const seq=markers(a.lines).map(m=>m.phase+':'+m.edge);
assert.deepEqual(seq,['finish_sync:enter','queue_refresh:enter','queue_refresh:exit','finish_sync:exit']);
const all=markers(a.lines);
assert.ok(all.every(m=>m.runId==='run-markers'&&typeof m.at==='string'));
assert.ok(all.filter(m=>m.edge==='exit').every(m=>typeof m.elapsedMs==='number'));
const text=a.lines.filter(line=>line.includes('"epg_phase"')).join('\n');
for(const secret of ['Secret','secret','Lid0','WatchLid','<tr','diary-entry-row','letterboxd.com'])assert.equal(text.includes(secret),false,secret);
assert.ok(text.length<6000,'compact: '+text.length);

// 2. The markers change nothing: a trace that throws gives the same history, facts, state and requests.
const plainRun=async(trace)=>{const h=harness();h.site.set(`https://letterboxd.com/${USER}/diary/`,page1);
 const bucket={async get(k){return h.records.has(k)?{etag:'e'+k,json:async()=>structuredClone(h.records.get(k))}:null;},async put(k,v){h.records.set(k,JSON.parse(v));return {etag:'e'};},async list(){return {objects:[],truncated:false};}};
 const out=await vm.runInContext('LetterboxdDiary',h.ctx).syncHistory({...env(),BUCKET:bucket},{now:Date.parse('2026-10-30T10:00:00.000Z'),trace});
 return {out:JSON.stringify({...out,lastAttemptAt:null,lastSuccessAt:null}),history:JSON.stringify(h.records.get('letterboxd/diary/history.json')),requests:h.requests.join(',')};};
const quiet=await plainRun(null),noisy=await plainRun(()=>{throw new Error('trace broke');});
assert.deepEqual(noisy,quiet);

// 3. A page that would answer 403 is not requested by the commit, and no ratings attempt is opened.
const b=harness();b.site.set(`https://letterboxd.com/${USER}/diary/`,()=>({ok:false,status:403,headers:new Headers(),text:async()=>'<title>Just a moment...</title>'}));b.records.set('programme.json',report);
await b.ctx.completeWithRatings({...env(),BUCKET:{get:k=>b.records.has(k)?Promise.resolve({etag:'x',json:async()=>structuredClone(b.records.get(k))}):Promise.resolve(null),put:async(k,v)=>{b.records.set(k,JSON.parse(v));return {etag:'y'};},list:async()=>({objects:[],truncated:false})}},run(),report);
assert.equal(b.requests.some(url=>url.includes('/diary/')),false);
assert.equal(markers(b.lines).some(m=>m.phase.startsWith('diary_')),false);
assert.equal(b.records.get('sync.json').ratingAttempt,undefined);
assert.equal(b.records.get('sync.json').ratingsPipeline,'blocked');

// 4. An error inside a traced phase logs `error` and rethrows unchanged.
const c=harness();
await assert.rejects(c.ctx.tracedPhase('run-x','generation_copy',async()=>{throw new Error('boom');}),/boom/);
assert.deepEqual(markers(c.lines).map(m=>m.phase+':'+m.edge),['generation_copy:enter','generation_copy:error']);

// 5. The EPG scan phase: an ordinary source failure logs `error` (no exit) and the commit fails as before.
const d=harness();d.records.set('sync.json',{runId:'run-src',stage:'epg'});
const failingBucket={get:async k=>d.records.has(k)?{etag:'x',json:async()=>structuredClone(d.records.get(k))}:null,put:async(k,v)=>{d.records.set(k,JSON.parse(v));return {etag:'y'};},list:async()=>({objects:[],truncated:false})};
d.ctx.fetch=async url=>({ok:false,status:500,headers:new Headers(),body:null,text:async()=>''});
await assert.rejects(d.ctx.epgSync({...env(),BUCKET:failingBucket},{runId:'run-src',stage:'epg',watchlist:[],pending:[]}),/EPG HTTP 500/);
assert.deepEqual(markers(d.lines).filter(m=>m.phase==='epg_input_scan').map(m=>m.edge),['enter','error']);

// 6. A logger that throws changes nothing: the traced work's result and error pass through.
const e=harness();e.ctx.console.log=()=>{throw new Error('log sink down');};
assert.equal(await e.ctx.tracedPhase('run-y','finish_sync',async()=>42),42);
await assert.rejects(e.ctx.tracedPhase('run-y','finish_sync',async()=>{throw new Error('real');}),/real/);

console.log('EPG phase markers (AIR-263): ordered enter/exit markers for finish sync and queue refresh on the commit, counts and sizes only (no titles, ids, slugs or HTML), a throwing trace changes nothing, blocked page and error edges, EPG source failure logged as error, throwing logger ignored passed');
