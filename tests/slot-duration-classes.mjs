// AIR-503: duration classes of one EPG title. A known Film owns only the slots whose own duration fits it.
// The assertions read the outcome of scanEPG (films[].shows, discovery observations, confirmed ids), not only the warning.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {slotEligibility,slotScanConfirmation} from '../src/domain/slot-evidence.js';

const H=3600000,now=Date.parse('2026-11-16T12:00:00Z');
const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,fetch,console});
vm.runInContext(fs.readFileSync('src/domain/scored-resolution.js','utf8')+'\nglobalThis.showMatchBasis=showMatchBasis;globalThis.scoreFilmResolution=scoreFilmResolution;',context);
vm.runInContext(fs.readFileSync('src/sources.js','utf8')+';globalThis.scanEPG=scanEPG;',context);
const stamp=ms=>new Date(ms).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const programme=(title,offsetH,minutes,channel='one')=>`<programme channel="${channel}" start="${stamp(now+offsetH*H)}" stop="${stamp(now+offsetH*H+minutes*60000)}"><title>${title}</title></programme>`;
const scan=async(programmes,watchlist)=>{
 const xml='<tv><channel id="one"><display-name>Кино</display-name></channel><channel id="two"><display-name>Два</display-name></channel>'+programmes.join('')+'</tv>';
 context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;context.watchlist=watchlist;
 return vm.runInContext('scanEPG(stream,watchlist,now)',context);
};
const film=(id,tmdbId,title,year,runtime,extra={})=>({id,tmdbId,title,original:title,year,runtime,aliases:[title],canonicalIdentity:'tmdb:'+tmdbId,...extra});
const minutes=show=>Math.round((show.end-show.start)/60000);
const attachedMinutes=(result,id)=>Array.from(result.films.find(item=>item.id===id)?.shows||[],minutes).sort((a,b)=>a-b);
const observation=(result,title)=>result.discovery.find(item=>item.normalizedTitle===title);
const observedMinutes=item=>Array.from(item.shows,minutes).sort((a,b)=>a-b);
const reasons=result=>Array.from(result.uncertain,item=>item.reason);

// 1. One key, unequal durations (Avatar 2009, 162 min). 178/170/162 fit, the 60-minute slot does not. Only the fitting slots become shows.
const avatar=film('tmdb_19995','19995','Аватар',2009,162);
let result=await scan([programme('Аватар (2009)',2,178),programme('Аватар (2009)',6,60),programme('Аватар (2009)',10,170),programme('Аватар (2009)',14,162,'two')],[avatar]);
assert.deepEqual(attachedMinutes(result,'tmdb_19995'),[162,170,178]);
assert.deepEqual(observedMinutes(observation(result,'аватар')),[60]);
assert.equal(observation(result,'аватар').confirmedTmdbId,null);
assert.deepEqual(reasons(result),['contradictory_runtime']);

// 2. Short 55/60-minute slots of a yearless title (The Sixth Sense, 107 min). The short slot is not attached; the full airings are.
const sixth=film('tmdb_745','745','Шестое чувство',1999,107);
result=await scan([programme('Шестое чувство',2,55),programme('Шестое чувство',6,105),programme('Шестое чувство',10,107,'two'),programme('Шестое чувство',12,60,'two')],[sixth]);
assert.deepEqual(attachedMinutes(result,'tmdb_745'),[105,107]);
assert.deepEqual(observedMinutes(observation(result,'шестое чувство')),[55,60]);
assert.deepEqual(reasons(result),['insufficient_year_or_duration','insufficient_year_or_duration']);

// 3. Long slots (167/240/270) never attach a 95-minute film, with or without a title year. The 87-minute slot is the only one inside the band.
const sponge=film('tmdb_400160','400160','Губка Боб в бегах',2020,95,{aliases:['Губка Боб в бегах','Губка Боб квадратные штаны']});
result=await scan([programme('Губка Боб квадратные штаны',2,240),programme('Губка Боб квадратные штаны',8,270),programme('Губка Боб квадратные штаны',14,60),programme('Губка Боб квадратные штаны',18,115)],[sponge]);
assert.deepEqual(attachedMinutes(result,'tmdb_400160'),[],'marathon, fragment and long slots do not fit 95 minutes');
assert.deepEqual(observedMinutes(observation(result,'губка боб квадратные штаны')),[60,115,240,270]);
const solaris2002=film('tmdb_2103','2103','Солярис',2002,99);
result=await scan([programme('Солярис (2002)',2,167),programme('Солярис',6,185),programme('Солярис (2002)',10,99)],[solaris2002]);
assert.deepEqual(attachedMinutes(result,'tmdb_2103'),[99],'the 167 and 185 minute slots are not the 99 minute film');
assert.equal(reasons(result).includes('contradictory_runtime'),true);
assert.equal(reasons(result).includes('insufficient_year_or_duration'),true);
assert.equal(observation(result,'солярис').confirmedTmdbId,null,'no replacement id is invented when the other adaptation is not in the index');

// 4. Two adaptations with one title. A slot goes to the adaptation whose runtime it fits; the catalog adaptation is confirmed on that slot only.
const solaris1972=film('tmdb_593','593','Солярис',1972,167,{catalogOnly:true});
result=await scan([programme('Солярис',2,167),programme('Солярис',6,99),programme('Солярис (1972)',10,167,'two'),programme('Солярис (2002)',14,99,'two')],[solaris2002,solaris1972]);
assert.deepEqual(attachedMinutes(result,'tmdb_2103'),[99,99],'only the 99 minute slots belong to the 2002 film');
const solarisObservations=result.discovery.filter(item=>item.normalizedTitle==='солярис');
assert.equal(solarisObservations.length,2);
for(const item of solarisObservations){
 assert.deepEqual(observedMinutes(item),[167]);
 assert.equal(item.confirmedTmdbId,'593');
 assert.equal(item.confirmedSlots.length,1);
}

// 5. A film that the feed splits into parts. A part is not a full airing: it is not attached, and the complete airing is.
const dawns=film('tmdb_49106','49106','А зори здесь тихие',1972,180);
result=await scan([programme('А зори здесь тихие (1972)',2,94),programme('А зори здесь тихие (1972)',6,86),programme('А зори здесь тихие (1972)',10,187)],[dawns]);
assert.deepEqual(attachedMinutes(result,'tmdb_49106'),[187]);
assert.deepEqual(observedMinutes(observation(result,'а зори здесь тихие')),[86,94]);
assert.deepEqual(reasons(result),['contradictory_runtime','contradictory_runtime']);

// 6. A correct full airing keeps its year basis. Several airings with the same minutes stay one Film.
const intern=film('tmdb_257211','257211','Стажер',2015,121);
result=await scan([programme('Стажер (2015)',2,121),programme('Стажер (2015)',8,121,'two')],[intern]);
assert.deepEqual(attachedMinutes(result,'tmdb_257211'),[121,121]);
assert.equal(result.films[0].shows[0].basis,'title_year');
assert.equal(result.discovery.length,0);

// 7. The audit metric. `observation.duration` is the first slot of the key. The scorer reads every stored duration, so a first 60-minute slot is not a conflict
// when another slot fits, and a key whose only slot is 60 minutes is a conflict.
const observe=(durations,extra={})=>({key:'k|2009',title:'Аватар',normalizedTitle:'аватар',year:2009,duration:durations[0],durations,...extra});
const score=input=>{context.input=input;return vm.runInContext('scoreFilmResolution(input)',context);};
const candidates=[{tmdbId:'19995',title:'Аватар',original:'Avatar',year:2009,runtime:162,trusted:true}];
const mixed=score({observation:observe([60,178,162]),candidates});
assert.equal(mixed.considered[0].runtime.relation,'runtime_near');
assert.equal(mixed.status,'accepted');
assert.deepEqual({...score({observation:observe([162]),candidates}),observationKey:null,confidence:0,score:0,considered:null},{...mixed,observationKey:null,confidence:0,score:0,considered:null},'a leading fragment does not change the decision');
const onlyShort=score({observation:observe([60]),candidates});
assert.equal(onlyShort.status,'contradicted');
assert.equal(onlyShort.reason,'contradicted_runtime');

// 8. Slot eligibility of a stored decision. A decision that carries no per-slot evidence publishes no slot; a confirmed or anchored slot is published.
const slot=(channelId,start,min)=>({channelId,start,end:start+min*60000});
const staleAlias={status:'verified',tmdbId:'400160',identitySource:'known_epg_alias'};
assert.equal(slotEligibility(staleAlias,slot('a',1000,87),null).eligible,false,'an alias decision without a confirmed slot owns nothing');
const legacy={confirmedTmdbId:'400160'};
assert.equal(slotScanConfirmation({...legacy,confirmedSlots:[]},slot('a',1000,87)),null,'a per-slot list does not lend the observation id');
assert.equal(slotScanConfirmation({...legacy,confirmedSlots:[{channelId:'a',start:1000,tmdbId:'400160'}]},slot('a',1000,87)),'400160');
assert.equal(slotEligibility(staleAlias,slot('a',1000,87),'400160').rule,'scan_confirmed');
const detail={status:'verified',tmdbId:'19995',identitySource:'tmdb_detail',anchor:[162]};
assert.equal(slotEligibility(detail,slot('a',1000,60),null).eligible,false);
assert.equal(slotEligibility(detail,slot('a',1000,162),null).rule,'anchor');
assert.equal(slotEligibility(detail,slot('a',1000,240),null).eligible,false);
console.log('slot duration classes ok');
