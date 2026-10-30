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

// 1. Order and edges of the post-commit tail with one diary page.
const a=harness();a.site.set(`https://letterboxd.com/${USER}/diary/`,page1);a.records.set('programme.json',report);
const outA=await a.ctx.completeWithRatings({...env(),BUCKET:{get:k=>a.records.has(k)?Promise.resolve({etag:'x',json:async()=>structuredClone(a.records.get(k))}):Promise.resolve(null),put:async(k,v)=>{a.records.set(k,JSON.parse(v));return {etag:'y'};},list:async()=>({objects:[],truncated:false})}},run(),report);
const seq=markers(a.lines).map(m=>m.phase+':'+m.edge);
assert.deepEqual(seq,['finish_sync:enter','queue_refresh:enter','queue_refresh:exit','finish_sync:exit',
 'diary_state_load:enter','diary_state_load:exit','diary_page_fetch:enter','diary_page_fetch:exit','diary_page_parse:enter','diary_page_parse:exit',
 'diary_history_merge:enter','diary_history_merge:exit','diary_facts_apply:enter','diary_facts_result:exit','diary_facts_apply:exit','diary_state_save:enter','diary_state_save:exit','removal:enter','removal:exit']);
const all=markers(a.lines);
assert.ok(all.every(m=>m.runId==='run-markers'&&typeof m.at==='string'));
assert.deepEqual([all.find(m=>m.phase==='diary_page_fetch'&&m.edge==='exit').status,all.find(m=>m.phase==='diary_page_fetch'&&m.edge==='exit').bytes],[200,page1.length]);
assert.equal(all.find(m=>m.phase==='diary_page_parse'&&m.edge==='exit').rows,20);
assert.equal(all.find(m=>m.phase==='diary_history_merge'&&m.edge==='exit').entries,20);
assert.ok(all.filter(m=>m.phase.startsWith('diary_')).every(m=>typeof m.attemptId==='string'&&(m.phase==='diary_facts_result'||typeof m.sinceDiaryMs==='number')));
assert.ok(all.filter(m=>m.edge==='exit'&&['finish_sync','queue_refresh','removal'].includes(m.phase)).every(m=>typeof m.elapsedMs==='number'));
// No titles, film ids, slugs, HTML or payload in any marker line.
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

// 3. A blocked page: the fetch exit carries the status, the state is still saved; the attempt ends as before.
const b=harness();b.site.set(`https://letterboxd.com/${USER}/diary/`,()=>({ok:false,status:403,headers:new Headers(),text:async()=>'<title>Just a moment...</title>'}));b.records.set('programme.json',report);
await b.ctx.completeWithRatings({...env(),BUCKET:{get:k=>b.records.has(k)?Promise.resolve({etag:'x',json:async()=>structuredClone(b.records.get(k))}):Promise.resolve(null),put:async(k,v)=>{b.records.set(k,JSON.parse(v));return {etag:'y'};},list:async()=>({objects:[],truncated:false})}},run(),report);
const bm=markers(b.lines);
assert.equal(bm.find(m=>m.phase==='diary_page_fetch'&&m.edge==='exit').status,403);
assert.ok(bm.some(m=>m.phase==='diary_state_save'&&m.edge==='exit'&&m.outcome==='blocked'));
assert.equal(bm.some(m=>m.phase==='diary_page_parse'),false);
assert.deepEqual([b.records.get('sync.json').ratingAttempt.state,b.records.get('sync.json').ratingAttempt.cause],['error','blocked']);

// 4. An error inside a traced phase logs `error` and rethrows unchanged.
const c=harness();
await assert.rejects(c.ctx.tracedPhase('run-x','generation_copy',async()=>{throw new Error('boom');}),/boom/);
assert.deepEqual(markers(c.lines).map(m=>m.phase+':'+m.edge),['generation_copy:enter','generation_copy:error']);

console.log('EPG phase markers (AIR-263): ordered enter/exit markers for finish sync, queue refresh, every diary sub-phase and removal, counts and sizes only (no titles, ids, slugs or HTML), a throwing trace changes nothing, blocked page and error edges passed');
