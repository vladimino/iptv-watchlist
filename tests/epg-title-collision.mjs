// AIR-488 / ADR 0150: scanEPG does not attach a known Film when two trusted identities share the title.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {slotEligibility,slotScanConfirmation} from '../src/domain/slot-evidence.js';

const H=3600000,now=Date.parse('2026-11-16T12:00:00Z');
const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,fetch,console});
vm.runInContext(fs.readFileSync('src/domain/scored-resolution.js','utf8')+'\nglobalThis.showMatchBasis=showMatchBasis;',context);
vm.runInContext(fs.readFileSync('src/sources.js','utf8')+';globalThis.scanEPG=scanEPG;',context);
const stamp=ms=>new Date(ms).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const programme=(title,offsetH,minutes,channel='one')=>`<programme channel="${channel}" start="${stamp(now+offsetH*H)}" stop="${stamp(now+offsetH*H+minutes*60000)}"><title>${title}</title></programme>`;
const scan=async(programmes,watchlist)=>{
 const xml='<tv><channel id="one"><display-name>Кино</display-name></channel><channel id="two"><display-name>Два</display-name></channel>'+programmes.join('')+'</tv>';
 context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;context.watchlist=watchlist;
 return vm.runInContext('scanEPG(stream,watchlist,now)',context);
};
const film=(id,tmdbId,title,year,runtime,extra={})=>({id,tmdbId,title,original:title,year,runtime,aliases:[title],canonicalIdentity:'tmdb:'+tmdbId,...extra});
const brothers=film('lb-8292','8292','Кровь за кровь',2005,109);
const transfusion=film('tmdb_842544','842544','Кровь за кровь',2023,106,{catalogOnly:true});
const observation=result=>result.discovery.find(item=>item.normalizedTitle==='кровь за кровь');
const attached=(result,id)=>result.films.find(item=>item.id===id)?.shows||[];

// No year, runtimes 3 minutes apart: the watchlist film is not attached. The slot stays a discovery observation.
const collision=await scan([programme('Кровь за кровь',2,108)],[brothers,transfusion]);
assert.equal(attached(collision,'lb-8292').length,0);
assert.equal(observation(collision).confirmedTmdbId,null);
assert.equal(observation(collision).shows.length,1);
assert.equal(collision.uncertain.some(item=>item.reason==='identity_collision'),true);
assert.equal(collision.stats.identityCollision,1);

// A year that matches one identity keeps that match. The other year is not a competitor.
const dated=await scan([programme('Кровь за кровь (2005)',2,108)],[brothers,transfusion]);
assert.equal(attached(dated,'lb-8292').length,1);
assert.equal(dated.films[0].shows[0].basis,'title_year');
assert.equal(dated.discovery.length,0);
assert.equal(dated.stats.identityCollision,0);

// The same title with the other year matches the catalog identity only as a confirmed observation, not as the watchlist film.
const otherYear=await scan([programme('Кровь за кровь 2023',2,106)],[brothers,transfusion]);
assert.equal(attached(otherYear,'lb-8292').length,0);
assert.equal(observation(otherYear).confirmedTmdbId,'842544');
assert.equal(otherYear.stats.identityCollision,0);

// A matching year with a runtime beyond the contradiction band assigns nothing.
const contradicted=await scan([programme('Кровь за кровь (2005)',2,180)],[brothers]);
assert.equal(attached(contradicted,'lb-8292').length,0);
assert.equal(contradicted.uncertain[0].reason,'contradictory_runtime');
assert.equal(observation(contradicted).confirmedTmdbId,null);

// A wrong year assigns nothing and does not confirm the other identity.
const wrongYear=await scan([programme('Кровь за кровь (1999)',2,109)],[brothers,transfusion]);
assert.equal(attached(wrongYear,'lb-8292').length,0);
assert.equal(observation(wrongYear).confirmedTmdbId,null);
assert.equal(wrongYear.uncertain[0].reason,'insufficient_year_or_duration');

// One known film, no year, a fitting runtime still attaches.
const alone=await scan([programme('Кровь за кровь',2,109)],[brothers]);
assert.equal(attached(alone,'lb-8292').length,1);
assert.equal(alone.discovery.length,0);

// A missing runtime cannot separate two identities, and cannot by itself accept a yearless unique film.
const noRuntime=await scan([programme('Кровь за кровь',2,109)],[brothers,{...transfusion,runtime:null}]);
assert.equal(attached(noRuntime,'lb-8292').length,0);
assert.equal(noRuntime.uncertain[0].reason,'identity_collision');
const missingAlone=await scan([programme('Кровь за кровь',2,109)],[{...brothers,runtime:null}]);
assert.equal(attached(missingAlone,'lb-8292').length,0);
assert.equal(missingAlone.uncertain[0].reason,'insufficient_year_or_duration');

// An alias that normalizes to the same title collides. A different title does not.
const alias=await scan([programme('Кровь за кровь!',2,108)],[brothers,{...transfusion,aliases:['Кровь за кровь!']}]);
assert.equal(attached(alias,'lb-8292').length,0);
assert.equal(alias.stats.identityCollision,1);
const otherTitle=await scan([programme('Кровь за кровь',2,109)],[brothers,film('tmdb_1','1','Другая кровь',2023,109,{catalogOnly:true})]);
assert.equal(attached(otherTitle,'lb-8292').length,1);

// The same year on two identities stays unresolved. A far runtime on the rival leaves the near one.
const sameYear=await scan([programme('Кровь за кровь (2005)',2,108)],[brothers,film('tmdb_2','2','Кровь за кровь',2005,106,{catalogOnly:true})]);
assert.equal(attached(sameYear,'lb-8292').length,0);
assert.equal(sameYear.uncertain[0].reason,'identity_collision');
const separated=await scan([programme('Кровь за кровь',2,109)],[brothers,film('tmdb_3','3','Кровь за кровь',1990,220,{catalogOnly:true})]);
assert.equal(attached(separated,'lb-8292').length,1);

// Repeated slots of an unresolved title stay one discovery observation and are not film shows. The slot owner is the observation.
const repeated=await scan([programme('Кровь за кровь',2,108),programme('Кровь за кровь',5,107,'two')],[brothers,transfusion]);
assert.equal(attached(repeated,'lb-8292').length,0);
assert.equal(observation(repeated).shows.length,2);
assert.equal(observation(repeated).confirmedTmdbId,null);
assert.equal(repeated.stats.identityCollision,2);
const owners=new Set(repeated.discovery.flatMap(item=>item.shows.map(show=>show.channelId+':'+show.start)));
assert.equal(owners.size,2);

// A slot that uniquely confirms the catalog film must not lend that id to a later or earlier collision on the same title.
const watch=film('lb-short','100','Кровь за кровь',2005,100);
const catalog=film('tmdb_long','200','Кровь за кровь',2023,155,{catalogOnly:true});
const decision={status:'verified',tmdbId:'200',identitySource:'known_epg_alias',anchor:[]};
for(const first of [true,false]){
 const programmes=first?[programme('Кровь за кровь',2,155),programme('Кровь за кровь',5,105,'two')]:[programme('Кровь за кровь',5,105,'two'),programme('Кровь за кровь',2,155)];
 const mixed=await scan(programmes,[watch,catalog]);
 const item=observation(mixed);
 assert.equal(item.confirmedTmdbId,null);
 assert.equal(item.confirmedSlots.length,1);
 assert.equal(item.confirmedSlots[0].tmdbId,'200');
 assert.equal(item.confirmedSlots[0].start,now+2*H);
 const confirmed=item.shows.find(show=>show.start===now+2*H);
 const collided=item.shows.find(show=>show.start===now+5*H);
 assert.equal(slotEligibility(decision,confirmed,slotScanConfirmation(item,confirmed)).rule,'scan_confirmed');
 assert.equal(slotEligibility(decision,collided,slotScanConfirmation(item,collided)).eligible,false);
}

console.log('EPG title collision: unresolved identities stay observations');
