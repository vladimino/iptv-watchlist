// AIR-391 offline spike, part 2: a discrete-event simulation of the projector's windows over 24 hours with a continuously refilled backlog
// (Films 4,730 changed at the start, +55 an hour; Persons 12,641, +300 an hour: the 2026-11-09 recorded values). Not bundled, not run by CI.
//   node scripts/projector-spike-sim.mjs [--films 5000] [--pool 8000] [--seeds 40]
// What is measured and what is assumed:
//  - Per-unit D1 cost (round trips, statements) comes from the real runs of scripts/projector-spike-bench.mjs (a Film group of 10 with its Persons,
//    a Person group of 25, and the current path's per-Film and per-Person cost). Their latency uses (rtt, stmt) drawn per window from the calibrated
//    box rtt 35 to 50 ms, stmt 1 to 2 ms.
//  - The per-window fixed cost before the first write is NOT modeled: it is the empirical set of what the 2026-11-09 runs spent between the grant and
//    the first write (hold minus the writes they made, "overhead"), bootstrap-sampled, together with the recorded window waits. Its cause in the slow
//    mode (50 to 60 s) is not established.
//  - The lane scheduler is the real rule (Films 3, Persons 2; cost in statements; the lane with the lowest spent/weight goes next).
//  - Request-to-release accounting follows ADR 0103: the deadline starts at the request, so wait, overhead, reserve and the writes all spend it.
import {measure,wallMs} from './projector-spike-bench.mjs';

const arg=(name,fallback)=>{const at=process.argv.indexOf('--'+name);return at>0?Number(process.argv[at+1]):fallback;};
// Recorded 2026-11-09 (UTC) window waits in seconds, and the overhead (hold minus the estimated writes, 0.7 s a Film and 0.052 s a Person) of each productive run.
const WAITS=[11.9,40.5,0.8,12.0,31.4,15.0,2.8,13.4,2.0,2.0,3.1,12.2];
const FAST=[3.1,5.9,8.3,8.9];   // the fast-mode overheads only, for the what-if of a fixed slow load
const OVERHEAD=[53.5,55.7,3.1,8.3,58.0,8.9,60.5,49.8,51.3,55.4,58.4];   // fast runs 3.1 to 8.9 s (3 of 11), slow runs 49.8 to 60.5 s (8 of 11)
function rng(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const poisson=(random,mean)=>{if(mean<=0)return 0;const limit=Math.exp(-Math.min(mean,50));let k=0,p=1;do{k++;p*=random();}while(p>limit);return k-1;};
const pick=(random,list)=>list[Math.floor(random()*list.length)];
const percentile=(values,p)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))];};

// unit costs: a "unit" is what one scheduler step writes
function units(measured){
 const a0=measured.a0,films=measured.films;
 const person={rt:1+1/25,st:9+0.04};                                   // the current path: one read per Person plus a batch of 25
 const filmOnlyRt=a0.calls.reads/films+a0.calls.batches/films-4*person.rt,filmOnlySt=a0.calls.batchStatements/films-4*9;
 return {
  current:{film:{rt:filmOnlyRt+3*person.rt,st:filmOnlySt+3*9,films:1,people:3},people:{rt:25*person.rt,st:25*9,films:0,people:25}},
  bulk:{film:{rt:measured.unit.filmGroup.roundTrips,st:measured.unit.filmGroup.statements,films:measured.unit.filmGroup.films,people:3*measured.unit.filmGroup.films},people:{rt:measured.unit.personGroup.roundTrips,st:measured.unit.personGroup.statements,films:0,people:25}},
 };
}
function simulate(cfg,cost,seed){
 const random=rng(seed);
 const state={films:4730,people:12641},totals={films:0,people:0,hold:0,windows:0,productive:0,refused:0};
 const perWindow=[],hourly=[];let drainedAt=null,hourFilms=0;
 const hours=24;
 for(let hour=0;hour<hours;hour++){
  for(let slot=0;slot<cfg.perHour;slot++){
   // inflow for the slice (Discovery runs between windows)
   state.films+=poisson(random,55/cfg.perHour);state.people+=poisson(random,300/cfg.perHour);
   const wait=pick(random,WAITS),overhead=pick(random,cfg.fast?FAST:OVERHEAD),rtt=35+random()*15,stmt=1+random();
   const model={rtt,stmt};
   let write,hold;
   if(cfg.budgetFromGrantS){write=Math.max(0,cfg.budgetFromGrantS-overhead);hold=wait+Math.max(overhead,cfg.budgetFromGrantS);if(wait+Math.max(overhead,cfg.budgetFromGrantS)>300){write=Math.max(0,300-wait-overhead);hold=300;}}
   else{
    const left=cfg.deadlineS-wait;
    if(left<cfg.minRunS){totals.refused++;totals.hold+=Math.min(cfg.deadlineS,wait);totals.windows++;perWindow.push({films:0,people:0});continue;}
    write=Math.max(0,left-overhead-cfg.reserveS);hold=wait+overhead+write+cfg.reserveS;
   }
   totals.windows++;
   const spent={film:0,people:0},used={films:0,people:0};
   let clock=0;
   while(true){
    const available=[];if(state.films>0)available.push('film');if(state.people>0)available.push('people');
    if(!available.length)break;
    let lane=available[0],best=Infinity;
    for(const name of available){const score=(spent[name]+1)/(name==='film'?3:2);if(score<best){best=score;lane=name;}}
    const unit=cost[lane];
    const latency=wallMs({reads:0,singleWrites:0,batches:unit.rt,batchStatements:unit.st},model)/1000;
    if(clock+latency>write)break;
    clock+=latency;spent[lane]+=unit.st;
    const films=Math.min(unit.films,state.films),people=Math.min(unit.people+(lane==='film'?0:0),state.people);
    state.films-=films;state.people-=people;used.films+=films;used.people+=people;
   }
   totals.films+=used.films;totals.people+=used.people;totals.hold+=Math.min(300,hold);
   if(used.films+used.people>0)totals.productive++;
   perWindow.push(used);hourFilms+=used.films;
   if(!cfg.perHour||slot===cfg.perHour-1){hourly.push(hourFilms);hourFilms=0;}
   if(drainedAt===null&&state.films<=20)drainedAt=hour+(slot+1)/cfg.perHour;
  }
 }
 return {filmsPerHour:totals.films/hours,peoplePerHour:totals.people/hours,holdFraction:totals.hold/(hours*3600),windows:totals.windows,refused:totals.refused,perWindowFilms:perWindow.slice(0,3*cfg.perHour).map(x=>x.films),catchUp:hourly.slice(0,3).reduce((a,b)=>a+b,0)/3,drainedAt,left:{films:state.films,people:state.people}};
}
const CONFIGS=[
 {name:'A0 now: hourly, 60 s from grant (validation against 2026-11-09)',kind:'current',perHour:1,budgetFromGrantS:60},
 {name:'A0, hourly, 150 s from grant',kind:'current',perHour:1,budgetFromGrantS:150},
 {name:'A0, hourly, 240 s from grant',kind:'current',perHour:1,budgetFromGrantS:240},
 {name:'C, hourly, 60 s from grant',kind:'bulk',perHour:1,budgetFromGrantS:60},
 {name:'C, hourly, 150 s from grant',kind:'bulk',perHour:1,budgetFromGrantS:150},
 {name:'C, hourly, deadline 300 s request to release, reserve 15 s',kind:'bulk',perHour:1,deadlineS:300,reserveS:15,minRunS:120},
 {name:'C, 4 windows an hour, deadline 75 s each (same 300 s/h cap)',kind:'bulk',perHour:4,deadlineS:75,reserveS:15,minRunS:30},
 {name:'what-if, slow load fixed (overhead 3 to 9 s): C, 4 windows an hour, deadline 75 s each',kind:'bulk',perHour:4,deadlineS:75,reserveS:15,minRunS:30,fast:true},
 {name:'what-if, slow load fixed (overhead 3 to 9 s): C, hourly, deadline 300 s',kind:'bulk',perHour:1,deadlineS:300,reserveS:15,minRunS:120,fast:true},
 {name:'C, 4 windows an hour, deadline 150 s each (600 s/h = 16.7 %, owner decision)',kind:'bulk',perHour:4,deadlineS:150,reserveS:15,minRunS:60},
 {name:'C, 6 windows an hour, deadline 100 s each (600 s/h = 16.7 %, owner decision)',kind:'bulk',perHour:6,deadlineS:100,reserveS:15,minRunS:45},
];
async function main(){
 const measured=await measure({films:arg('films',5000),pool:arg('pool',8000)});
 const cost=units(measured),seeds=arg('seeds',40);
 const rows=[];
 for(const cfg of CONFIGS){
  const runs=Array.from({length:seeds},(_,seed)=>simulate(cfg,cost[cfg.kind],1000+seed));
  const films=runs.map(r=>r.catchUp),people=runs.map(r=>r.peoplePerHour);
  const windowFilms=runs.flatMap(r=>r.perWindowFilms);
  const drained=runs.map(r=>r.drainedAt).filter(x=>x!==null);
  rows.push({config:cfg.name,catchUpFilmsPerHour:{p10:Math.round(percentile(films,0.1)),p50:Math.round(percentile(films,0.5)),p90:Math.round(percentile(films,0.9))},peoplePerHour:{p50:Math.round(percentile(people,0.5))},
   perWindowFilms:{p50:percentile(windowFilms,0.5),p95:percentile(windowFilms,0.95)},holdPercent:+(100*percentile(runs.map(r=>r.holdFraction),0.5)).toFixed(1),refusedWindowsPer24h:+(runs.reduce((s,r)=>s+r.refused,0)/seeds).toFixed(1),
   drainedFilmBacklogHours:{reachedInSeeds:drained.length+'/'+seeds,p50:drained.length?+percentile(drained,0.5).toFixed(1):null},leftAfter24h:{films:Math.round(percentile(runs.map(r=>r.left.films),0.5)),people:Math.round(percentile(runs.map(r=>r.left.people),0.5))}});
 }
 console.log(JSON.stringify({cost,rows},null,1));
}
await main();
void wallMs;
