// AIR-188: the 7-day retention/display horizon is separate from the 24-hour hot processing horizon. Fixture feed, no network.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';

const plain=v=>JSON.parse(JSON.stringify(v));
const H=3600000,now=Date.parse('2026-11-05T12:00:00Z');
const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,fetch,console});
vm.runInContext(fs.readFileSync('src/domain/scored-resolution.js','utf8')+'\nglobalThis.showMatchBasis=showMatchBasis;',context);
vm.runInContext(fs.readFileSync('src/sources.js','utf8')+';globalThis.scanEPG=scanEPG;globalThis.HOT=EPG_HOT_FUTURE_MS;globalThis.RETAIN=EPG_RETAIN_FUTURE_MS;',context);
assert.equal(context.HOT,24*H);assert.equal(context.RETAIN,168*H);

const stamp=ms=>new Date(ms).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const programme=(title,offsetH,channel='one',minutes=110)=>`<programme channel="${channel}" start="${stamp(now+offsetH*H)}" stop="${stamp(now+offsetH*H+minutes*60000)}"><title>${title}</title></programme>`;
const scan=async(programmes,watchlist)=>{
 const xml='<tv><channel id="one"><display-name>Кино</display-name></channel><channel id="two"><display-name>Два</display-name></channel>'+programmes.join('')+'</tv>';
 context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;context.watchlist=watchlist;
 return vm.runInContext('scanEPG(stream,watchlist,now)',context);
};
const film=(id,title,year,extra={})=>({id,title,original:title,year,runtime:110,tmdbId:id,aliases:[title],...extra});
const watchlist=[film('wk','Weekly Film',2001),film('cat','Catalog Only',2002,{catalogOnly:true}),film('arch','Archive Film',2003)];

// Watchlist film: archive within 72 h, hot day, days 2-7, and the 168 h boundary.
const result=await scan([
 programme('Archive Film',-80),programme('Archive Film',-60),
 programme('Weekly Film',2),programme('Weekly Film',30),programme('Weekly Film',100,'two'),programme('Weekly Film',167),programme('Weekly Film',168),programme('Weekly Film',200),
],watchlist);
const weekly=result.films.find(item=>item.id==='wk');
assert.deepEqual(plain(weekly.shows.map(show=>(show.start-now)/H)),[2,30,100,167],'watchlist shows are kept to 168 h exclusive, not truncated at 24 h');
assert.deepEqual(plain(result.films.find(item=>item.id==='arch').shows.map(show=>(show.start-now)/H)),[-60],'the 72 h catch-up edge is unchanged');

// No hot processing of days 2-7: catalog-only and unknown titles beyond 24 h never enter discovery, uncertain or the raw counts.
const cold=await scan([
 programme('Catalog Only',10),programme('Catalog Only',40),
 programme('Unknown Film One',12),programme('Unknown Film Two',30),programme('Unknown Film Three',120),
 programme('Weekly Film',50),
],watchlist);
const discovered=cold.discovery.map(item=>item.title);
assert.ok(discovered.includes('Unknown Film One'),'hot-day unknown title is still a discovery candidate');
assert.ok(!discovered.some(title=>/Two|Three/.test(title)),'days 2-7 unknown titles are not discovery candidates: '+discovered);
assert.ok(!cold.discovery.some(item=>(item.shows||[]).some(show=>show.start>=now+24*H)),'no discovery observation carries a show beyond 24 h');
assert.ok(!cold.films.some(item=>item.id==='cat'&&item.shows.some(show=>show.start>=now+24*H)),'a catalog-only film keeps no show beyond 24 h');
assert.equal(cold.stats.rawCandidates,2,'raw candidate count covers only the hot window (one catalog-only title, one unknown title)');
assert.ok(cold.uncertain.every(item=>item.start<now+24*H),'uncertain matches are hot only');
// The year-less watchlist match on a later day is a reliable match and is kept.
assert.equal(cold.films.find(item=>item.id==='wk').shows.length,1);

// Retained count is the hot window plus reliable watchlist shows; the hot-only work does not grow with the week.
const hotOnly=await scan(Array.from({length:50},(_,i)=>programme('Filler '+i+'',1+i/10)),watchlist);
const withWeek=await scan([...Array.from({length:50},(_,i)=>programme('Filler '+i+'',1+i/10)),...Array.from({length:600},(_,i)=>programme('Later Filler '+i+'',30+i/4,i%2?'one':'two'))],watchlist);
assert.equal(withWeek.stats.discoveryCandidates,hotOnly.stats.discoveryCandidates,'six extra days of unmatched programmes add no discovery work');
assert.equal(withWeek.stats.retained,hotOnly.stats.retained,'and are not retained');
// Two generations: a cancelled airing disappears and a rescheduled one moves; nothing of generation 1 is merged into generation 2.
{
 const gen1=await scan([programme('Weekly Film',5),programme('Weekly Film',30),programme('Weekly Film',100)],watchlist);
 assert.deepEqual(plain(gen1.films.find(item=>item.id==='wk').shows.map(show=>(show.start-now)/H)),[5,30,100]);
 const later=now+24*H;
 // Generation 2, a day later: the +5 h airing has aired (still inside the archive), the +30 h one is cancelled, the +100 h one moved to +110 h, a new one at +60 h.
 const scan2=async()=>{
  const xml='<tv><channel id="one"><display-name>Кино</display-name></channel>'+[programme('Weekly Film',5),programme('Weekly Film',110),programme('Weekly Film',60)].join('')+'</tv>';
  context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=later;context.watchlist=watchlist;
  return vm.runInContext('scanEPG(stream,watchlist,now)',context);
 };
 const gen2=await scan2();
 assert.deepEqual(plain(gen2.films.find(item=>item.id==='wk').shows.map(show=>(show.start-now)/H)).sort((a,b)=>a-b),[5,60,110],'only generation 2 shows: cancelled +30 h gone, +100 h moved to +110 h, +60 h new');
 const commit=fs.readFileSync('src/worker.js','utf8');
 assert.match(commit,/withAvailability\(\{\.\.\.f,\.\.\.byId\.get\(String\(f\.id\)\),shows:byId\.get\(String\(f\.id\)\)\?\.shows\|\|\[\]\}\)/,'the commit builds every show list from the new scan only, never from the previous generation');
}
console.log('AIR-188 scan: 168 h retention for reliable watchlist shows, 24 h hot horizon for discovery and catalog-only, unchanged 72 h archive edge passed');
