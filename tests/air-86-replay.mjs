import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {loadProduction,runReplay} from '../scripts/air-86-replay.mjs';

function plan(title,year){
 const box=loadProduction();
 box.__args=[{title,year}];
 return vm.runInContext('candidateSearchVariants(...__args)',box);
}
const real=JSON.parse(fs.readFileSync('docs/evidence/scored-resolver/air-86-replay-manifest.json','utf8'));
assert.equal(real.items.length,38);
assert.equal(real.plannedSearches,87);
assert.equal(real.tmdbCalls,0);
for(const item of real.items)assert.equal(JSON.stringify(plan(item.title,item.year)),JSON.stringify(item.variants),item.key);
const reasons=(title,year)=>plan(title,year).map(row=>row.reason+':'+row.query+':'+(row.year??''));
const generator=loadProduction();
for(const year of ['null','undefined',"''"])assert.equal(vm.runInContext(`candidateSearchVariants({title:'Блейд',year:${year}}).some(row=>String(row.reason).startsWith('year_')||row.year===0||row.year===-1||row.year===1)`,generator),false);
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
assert.doesNotMatch(fs.readFileSync('src/discovery.js','utf8'),/candidateSearchVariants|variantHit|variantAliasRank/);

const now=Date.parse(real.capturedAt);
const title='Северный тест',year=2001,key='северный тест|2001';
const variantPlan=plan(title,year);
const filler=(index)=>({order:index+2,group:'blocked_year',key:`пусто ${index}|2001`,title:`Пусто ${index}`,year:2001,legacyStatus:'no_confident_match',evidenceState:'same',durations:[100],searches:2,variants:plan(`Пусто ${index}`,2001)});
const manifest={plannedSearches:1,items:[{order:1,group:'blocked_year',key,title,year,legacyStatus:'no_confident_match',evidenceState:'same',durations:[100],searches:variantPlan.length,variants:variantPlan},...Array.from({length:37},(_,index)=>filler(index))]};
const movie={id:77,title,original_title:title,release_date:'2001-01-01',runtime:100};
const context={
 requireLedger:true,
 candidates:{[key]:{found:true,normalizedTitle:'северный тест',duration:100,durations:[100],seenInLatestSnapshot:true,shows:[{channelId:'ch1',start:now}]}},
 priors:{},
 decisions:{[key]:{status:'no_confident_match',retryAt:'2026-10-23T23:47:33.597Z',evidenceKey:'северный тест|2001|100|ch1:'+now,terminalReason:null}}
};
const exact=await runReplay({manifest,context,now,request:async path=>{
 if(path.startsWith('search/'))return {status:200,json:{results:[movie]}};
 assert.match(path,/append_to_response=credits/);
 return {status:200,json:{id:77,title,original_title:title,release_date:'2001-01-01',runtime:100,translations:{translations:[]},alternative_titles:{titles:[]}}};
}});
assert.equal(exact.rows[0].stop,'exact_title');
assert.equal(exact.rows[0].searchCalls,1);
assert.equal(exact.http.search,1);
assert.equal(exact.rows[0].detail.checked,true);
assert.equal(exact.rows[0].recognitionGate.outcome,'detail_verified');
assert.equal(exact.rows[0].liveGate.outcome,'refused');
assert.equal(exact.rows[0].liveGate.reason,'not_actionable');
assert.equal(exact.rows[0].aliases.length,0);
assert.equal(exact.rows[0].evaluation,'evaluated');
assert.equal(exact.rows[1].evaluation,'not_evaluated');

let calls=0;
const halted=await runReplay({manifest,context,now,request:async()=>{calls++;return {status:429,json:{}};}});
assert.equal(calls,1);
assert.equal(halted.http.halted,true);
assert.equal(halted.rows[0].evaluation,'partially_evaluated');
assert.equal(halted.rows[1].evaluation,'not_evaluated');
assert.equal(halted.http.detail,0);

const paths=[];
const full=await runReplay({manifest,context,now,cap:3,request:async path=>{paths.push(path);return {status:200,json:{results:[]}};}});
assert.equal(full.http.search,2);
assert.equal(paths.some(path=>path.startsWith('movie/')),false);
assert.equal(full.rows[0].stop,'searched');
assert.equal(full.rows[0].score.status!=='accepted',true);
console.log('AIR-86 replay planner passed');
