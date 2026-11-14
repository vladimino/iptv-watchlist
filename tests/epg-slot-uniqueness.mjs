// AIR-480 stage 1 (ADR 0142 decision 1, M6): one owner per (channel, start) in scanEPG. Fixture feed, no network.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';

const plain=v=>JSON.parse(JSON.stringify(v));
const H=3600000,now=Date.parse('2026-11-05T12:00:00Z');
const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,fetch,console});
vm.runInContext(fs.readFileSync('src/domain/scored-resolution.js','utf8')+'\nglobalThis.showMatchBasis=showMatchBasis;',context);
vm.runInContext(fs.readFileSync('src/sources.js','utf8')+';globalThis.scanEPG=scanEPG;',context);

const stamp=ms=>new Date(ms).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const programme=(title,offsetH,channel='one',minutes=110)=>`<programme channel="${channel}" start="${stamp(now+offsetH*H)}" stop="${stamp(now+offsetH*H+minutes*60000)}"><title>${title}</title></programme>`;
const scan=async(programmes,watchlist=[])=>{
 const xml='<tv><channel id="one"><display-name>Кино</display-name></channel><channel id="two"><display-name>Два</display-name></channel>'+programmes.join('')+'</tv>';
 context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;context.watchlist=watchlist;
 return vm.runInContext('scanEPG(stream,watchlist,now)',context);
};
const film=(id,title,year,extra={})=>({id,title,original:title,year,runtime:110,tmdbId:id,aliases:[title],...extra});
const watchlist=[film('a','Alpha Film',2001),film('b','Beta Film',2002)];
const starts=shows=>plain(shows.map(show=>(show.start-now)/H));

// The same owner repeated on one slot is ignored: one show, no conflict.
const same=await scan([programme('Alpha Film 2001',3),programme('Alpha Film 2001',3),programme('Alpha Film 2001',6)],watchlist);
assert.equal(same.stats.duplicate_slot,0);
assert.deepEqual(starts(same.films.find(item=>item.id==='a').shows),[3,6]);

// An unknown title repeated on one slot is one airing.
const unknownSame=await scan([programme('Gamma Unknown Title',5),programme('Gamma Unknown Title',5),programme('Gamma Unknown Title',8)]);
assert.equal(unknownSame.stats.duplicate_slot,0);
assert.equal(unknownSame.discovery.length,1);
assert.equal(unknownSame.discovery[0].airings,2);
assert.deepEqual(starts(unknownSame.discovery[0].shows),[5,8]);

// Two different owners on one slot: both records are discarded, the first is not kept (no first-wins), neighbours stay.
const conflict=await scan([
 programme('Alpha Film 2001',3),programme('Gamma Unknown Title',3),
 programme('Alpha Film 2001',6),programme('Gamma Unknown Title',9),
],watchlist);
assert.equal(conflict.stats.duplicate_slot,1);
assert.deepEqual(starts(conflict.films.find(item=>item.id==='a').shows),[6],'the contested slot is removed from the Film');
const gamma=conflict.discovery.find(item=>item.title==='Gamma Unknown Title');
assert.deepEqual(starts(gamma.shows),[9],'the contested slot is removed from the observation');
assert.equal(gamma.airings,1);
assert.equal(gamma.firstAiring,now+9*H);assert.equal(gamma.lastAiring,now+9*H);
assert.equal(conflict.uncertain.filter(item=>item.reason==='duplicate_slot').length,1);

// A contested slot leaves no identity evidence on a surviving observation (180 minutes contested, 90 minutes retained), in both feed orders.
const evidence=async(contestedFirst)=>{
 const contested=`<programme channel="one" start="${stamp(now+3*H)}" stop="${stamp(now+3*H+180*60000)}"><title>GAMMA UNKNOWN TITLE</title><desc>Contested description</desc></programme>`;
 const rival=programme('Alpha Film 2001',3);
 const kept=`<programme channel="one" start="${stamp(now+6*H)}" stop="${stamp(now+6*H+90*60000)}"><title>Gamma Unknown Title</title></programme>`;
 return scan(contestedFirst?[contested,rival,kept]:[kept,rival,contested],watchlist);
};
for(const contestedFirst of [true,false]){
 const result=await evidence(contestedFirst);
 const candidate=result.discovery.find(item=>item.normalizedTitle==='gamma unknown title');
 assert.equal(result.stats.duplicate_slot,1);
 assert.deepEqual(starts(candidate.shows),[6]);
 assert.equal(candidate.duration,90,'the representative duration comes from the retained slot');
 assert.deepEqual(plain(candidate.rawTitles),['Gamma Unknown Title'],'the title form of the removed slot is gone');
 assert.equal(candidate.description,null,'the description of the removed slot is gone');
 assert.equal(candidate.firstAiring,now+6*H);assert.equal(candidate.lastAiring,now+6*H);assert.equal(candidate.airings,1);
}

// An observation that keeps several slots takes its evidence from the first retained one.
const several=await scan([
 `<programme channel="one" start="${stamp(now+2*H)}" stop="${stamp(now+2*H+180*60000)}"><title>Gamma Unknown Title</title></programme>`,
 programme('Alpha Film 2001',2),
 `<programme channel="one" start="${stamp(now+5*H)}" stop="${stamp(now+5*H+95*60000)}"><title>Gamma Unknown Title</title><desc>Kept description</desc></programme>`,
 `<programme channel="one" start="${stamp(now+8*H)}" stop="${stamp(now+8*H+90*60000)}"><title>Gamma Unknown Title</title></programme>`,
],watchlist);
const retained=several.discovery.find(item=>item.normalizedTitle==='gamma unknown title');
assert.equal(retained.duration,95);assert.equal(retained.description,'Kept description');assert.equal(retained.airings,2);assert.equal(retained.firstAiring,now+5*H);

// The same start on another channel is another slot.
const channels=await scan([programme('Alpha Film 2001',3,'one'),programme('Gamma Unknown Title',3,'two')],watchlist);
assert.equal(channels.stats.duplicate_slot,0);
assert.deepEqual(starts(channels.films.find(item=>item.id==='a').shows),[3]);
assert.equal(channels.discovery.length,1);

// An owner whose only slot is contested disappears; the Film and the candidate are not retained.
const lonely=await scan([programme('Alpha Film 2001',4),programme('Gamma Unknown Title',4)],watchlist);
assert.equal(lonely.stats.duplicate_slot,1);
assert.equal(lonely.films.length,0);
assert.equal(lonely.discovery.length,0);
assert.equal(lonely.stats.discoveryCandidates,0);

// The count is complete while the diagnostic list stays capped at 100.
const many=[];for(let index=0;index<130;index++){const offset=1+index*0.15;many.push(programme('Alpha Film 2001',offset),programme('Gamma Unknown Title',offset));}
const flood=await scan(many,watchlist);
assert.equal(flood.stats.duplicate_slot,130,'duplicate_slot counts every discarded slot');
assert.equal(flood.uncertain.length,100,'the uncertain list is a sample capped at 100');
assert.equal(flood.films.length,0);

console.log('epg slot uniqueness ok');
