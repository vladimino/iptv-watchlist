// Offline synthetic catalog at the E6 aggregate volumes, for the M2b dry-run harness.
// It builds a NEW local sqlite file from the repository migrations and deterministic rows. It touches no network, D1, R2, Cloudflare or connector.
// The volumes are the sanitized E6 aggregates (targets below). The row placement is a model that hits those totals: it is not a draw from production and not a distribution of production.
// Output of `measure` is counts and timings only. The sqlite file stays local and is never an input to a production writer.
//
//   node scripts/epg-producer-m2b-synthetic.mjs layout
//   node scripts/epg-producer-m2b-synthetic.mjs build <out.sqlite>
//   node scripts/epg-producer-m2b-synthetic.mjs measure <out.sqlite>
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sqliteSync} from '../tests/sqlite-session.mjs';
import {d1Standin} from '../tests/d1-standin.mjs';
import {dryRun} from './epg-producer-dry-run.mjs';
import {COPY_PLAN,inputsFromCopy,runOnCopy,verifyCopy} from './epg-producer-m2b.mjs';

export const E6_TARGETS=Object.freeze({
 seed:'m2b-synthetic-e6-2026-11-14',
 clock:'2026-11-14T00:00:00.000Z',
 // Sanitized aggregates from the E6 production measurement of 12 Nov 2026. Placement below is modelled, not sampled.
 films:10044,
 persons:53623,
 credits:107064,
 dimensions:34936,
 watchlistFilms:391,
 metadataRows:399,
 syncRows:399,
 creditedPersons:6452,
 watchlistCreditRows:8600,
 watchlistCreditMin:11,
 watchlistCreditMax:26,
 // A second generation-shaped cohort, disjoint from the watchlist, used as the elevated load and as the return scenario. Modelled, not an E6 count.
 elevatedFilms:391,
 elevatedCreditRows:8600,
 elevatedPersons:6452,
 elevatedCreditMin:11,
 elevatedCreditMax:26,
 departedSteady:6,
 departedElevated:6,
 absentDeparted:3,
 creditCap:50,
 largeCreditFilms:30,
 largeCreditSize:50,
 restCreditMax:40,
});

const DIMENSIONS=['identity','metadata','localization','fingerprint','prediction'];
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";
const sqlValue=value=>value===null||value===undefined?'NULL':typeof value==='number'?String(value):q(value);

export function resolveTargets(input){
 const t={...input};
 const required=['seed','clock','films','persons','credits','dimensions','watchlistFilms','metadataRows','syncRows','creditedPersons','watchlistCreditRows','watchlistCreditMin','watchlistCreditMax','elevatedFilms','elevatedCreditRows','elevatedPersons','elevatedCreditMin','elevatedCreditMax','departedSteady','departedElevated','absentDeparted','creditCap','largeCreditFilms','largeCreditSize','restCreditMax'];
 for(const key of required)if(!Number.isInteger(t[key])&&key!=='seed'&&key!=='clock')throw new Error('target '+key+' is not an integer');
 if(typeof t.seed!=='string'||!t.seed)throw new Error('seed is required');
 if(typeof t.clock!=='string'||t.clock.length!==24)throw new Error('clock must be the 24-character instant the localization source accepts');
 const fail=message=>{throw new Error(message);};
 if(t.films<1||t.persons<1)fail('films and persons are required');
 if(t.watchlistFilms+t.elevatedFilms>t.films)fail('cohorts exceed the film total');
 if(t.creditedPersons+t.elevatedPersons>t.persons)fail('cohorts exceed the person total');
 if(t.watchlistCreditRows+t.elevatedCreditRows>t.credits)fail('cohorts exceed the credit total');
 if(t.syncRows!==t.metadataRows)fail('sync rows are paired with metadata rows');
 if(t.metadataRows<t.watchlistFilms)fail('metadata rows cover the watchlist');
 if(t.metadataRows-t.watchlistFilms>t.elevatedFilms)fail('metadata rows beyond the watchlist sit on the elevated cohort');
 if(t.metadataRows-t.watchlistFilms<t.departedSteady)fail('every steady departed film keeps a metadata row');
 if(t.departedSteady>t.elevatedFilms||t.departedElevated<0)fail('the steady departed sample is a prefix of the elevated cohort');
 if(t.departedElevated>t.films-t.watchlistFilms-t.elevatedFilms)fail('the elevated departed sample exceeds films outside both cohorts');
 if(t.dimensions<0||t.dimensions>t.films*DIMENSIONS.length)fail('dimension rows do not fit the films');
 if(t.largeCreditSize>t.creditCap||t.largeCreditFilms<0)fail('a credit list stays within the unit cap');
 if(t.watchlistCreditRows<t.creditedPersons||t.elevatedCreditRows<t.elevatedPersons)fail('each cohort person has a credit');
 if(t.watchlistCreditMin<1||t.watchlistCreditMax>t.creditCap||t.elevatedCreditMin<1||t.elevatedCreditMax>t.creditCap)fail('cohort credit sizes stay inside the cap');
 const restFilms=t.films-t.watchlistFilms-t.elevatedFilms;
 const restCredits=t.credits-t.watchlistCreditRows-t.elevatedCreditRows;
 if(t.largeCreditFilms>restFilms)fail('large credit lists sit outside both cohorts');
 if(t.largeCreditFilms*t.largeCreditSize>restCredits)fail('large credit lists exceed the remaining credits');
 return Object.freeze(t);
}

function rngOf(seed){
 let state=createHash('sha256').update(String(seed)).digest().readUInt32BE(0)||1;
 return ()=>(state=(Math.imul(state,1664525)+1013904223)>>>0);
}
function shuffle(items,rng){
 const out=items.slice();
 for(let i=out.length-1;i>0;i--){const j=rng()%(i+1);const swap=out[i];out[i]=out[j];out[j]=swap;}
 return out;
}
const hashOrder=id=>createHash('sha256').update(id).digest('hex');

function fitCounts(n,total,min,max){
 if(n===0){if(total!==0)throw new Error('credits with no films');return [];}
 if(total<n*min||total>n*max)throw new Error('infeasible credit sizes: '+n+' films, '+total+' credits, ['+min+','+max+']');
 const counts=Array(n).fill(min);
 let left=total-n*min;
 const pinned=new Set();
 if(n>=2&&left>0){
  const give=Math.min(max-min,left);
  counts[1]+=give;left-=give;
  pinned.add(1);
  if(left<=Math.max(0,n-2)*(max-min))pinned.add(0);
 }
 let guard=0,i=0;
 while(left>0){
  const idx=i%n;
  if(!pinned.has(idx)&&counts[idx]<max){counts[idx]++;left--;}
  i++;
  if(++guard>n*(max-min+2))throw new Error('credit spread stuck');
 }
 return counts;
}

function restPlan(nFilms,totalCredits,largeFilms,largeSize,cap){
 const largeSum=largeFilms*largeSize;
 const others=nFilms-largeFilms;
 const budget=totalCredits-largeSum;
 let zero=Math.floor(others*0.2);
 for(;;){
  const active=others-zero;
  const max=Math.min(cap,Math.max(largeSize,1));
  if((active===0&&budget===0)||(active>0&&budget>=active&&budget<=active*max)){
   const activeCounts=active?fitCounts(active,budget,1,max):[];
   return [...Array(largeFilms).fill(largeSize),...Array(zero).fill(0),...activeCounts];
  }
  if(zero===0)throw new Error('remaining credits do not fit the remaining films');
  zero--;
 }
}

function assignCredits(filmIds,counts,personIds){
 const edges=counts.reduce((sum,n)=>sum+n,0);
 if(edges===0)return filmIds.map(()=>[]);
 if(personIds.length===0||edges<personIds.length)throw new Error('not enough credit edges for the person cohort');
 const base=Math.floor(edges/personIds.length);
 let extra=edges-base*personIds.length;
 const remaining=personIds.map((_,index)=>base+(index<extra?1:0));
 const lists=filmIds.map(()=>[]);
 let cursor=0;
 for(let f=0;f<filmIds.length;f++){
  const seen=new Set();
  while(lists[f].length<counts[f]){
   let guard=0;
   while(remaining[cursor]===0||seen.has(cursor)){
    cursor=(cursor+1)%personIds.length;
    if(++guard>personIds.length)throw new Error('credit placement stuck');
   }
   seen.add(cursor);
   remaining[cursor]--;
   const role=lists[f].length===0?'director':'actor';
   const ordinal=lists[f].reduce((sum,item)=>sum+(item.role===role?1:0),0);
   lists[f].push({personId:personIds[cursor],role,ordinal});
   cursor=(cursor+1)%personIds.length;
  }
 }
 if(remaining.some(n=>n!==0))throw new Error('unplaced credit edges');
 return lists;
}

function dimensionCounts(n,total){
 const pattern=[0,1,2,3,4,5,3,2,4,1,5,3,0,4,2];
 const reserved=new Set();
 const reserveCap=Math.floor(n*0.05);
 for(let i=0;i<n&&reserved.size<reserveCap;i++)if(pattern[i%pattern.length]===0)reserved.add(i);
 const counts=Array.from({length:n},(_,i)=>reserved.has(i)?0:pattern[i%pattern.length]);
 let sum=counts.reduce((s,v)=>s+v,0);
 let guard=0,i=0;
 while(sum<total){
  const idx=i%n;
  if(!reserved.has(idx)&&counts[idx]<DIMENSIONS.length){counts[idx]++;sum++;}
  i++;
  if(++guard>n*DIMENSIONS.length+n)throw new Error('dimension rows do not fit');
 }
 guard=0;i=0;
 while(sum>total){
  const idx=i%n;
  if(!reserved.has(idx)&&counts[idx]>0){counts[idx]--;sum--;}
  i++;
  if(++guard>n*DIMENSIONS.length+n)throw new Error('dimension rows cannot be reduced');
 }
 return counts;
}

// The deterministic row plan. `films` carries the ids the writer and the scenarios need; `summary` is counts only.
export function buildLayout(targets){
 const t=resolveTargets(targets);
 const filmId=n=>'film:tmdb:'+n;
 const personId=n=>'person:tmdb:'+n;
 const rng=rngOf(t.seed);
 const order=shuffle(Array.from({length:t.films},(_,i)=>i+1),rng);
 const watchSet=new Set(order.slice(0,t.watchlistFilms));
 const off=order.slice(t.watchlistFilms).map(filmId).sort((a,b)=>hashOrder(a).localeCompare(hashOrder(b)));
 const elevatedIds=off.slice(0,t.elevatedFilms);
 const elevatedSet=new Set(elevatedIds);
 const restIds=off.slice(t.elevatedFilms);
 const departedIds=elevatedIds.slice(0,t.departedSteady);
 const elevatedDepartedIds=restIds.slice(0,t.departedElevated);
 const absentIds=Array.from({length:t.absentDeparted},(_,i)=>filmId(t.films+100000+i+1));
 const personIds=Array.from({length:t.persons},(_,i)=>personId(i+1));
 const watchPersons=personIds.slice(0,t.creditedPersons);
 const elevatedPersons=personIds.slice(t.creditedPersons,t.creditedPersons+t.elevatedPersons);
 const unusedPersons=Math.floor((t.persons-t.creditedPersons-t.elevatedPersons)*0.05);
 const restPersons=personIds.slice(t.creditedPersons+t.elevatedPersons,t.persons-unusedPersons);
 const watchIds=order.slice(0,t.watchlistFilms).map(filmId);
 const watchCounts=fitCounts(t.watchlistFilms,t.watchlistCreditRows,t.watchlistCreditMin,t.watchlistCreditMax);
 const elevatedCounts=fitCounts(t.elevatedFilms,t.elevatedCreditRows,t.elevatedCreditMin,t.elevatedCreditMax);
 const restCounts=restPlan(restIds.length,t.credits-t.watchlistCreditRows-t.elevatedCreditRows,t.largeCreditFilms,t.largeCreditSize,t.restCreditMax);
 const watchCredits=assignCredits(watchIds,watchCounts,watchPersons);
 const elevatedCredits=assignCredits(elevatedIds,elevatedCounts,elevatedPersons);
 const restCredits=assignCredits(restIds,restCounts,restPersons);
 const creditsOf=new Map();
 watchIds.forEach((id,i)=>creditsOf.set(id,watchCredits[i]));
 elevatedIds.forEach((id,i)=>creditsOf.set(id,elevatedCredits[i]));
 restIds.forEach((id,i)=>creditsOf.set(id,restCredits[i]));
 const dims=dimensionCounts(t.films,t.dimensions);
 const metadataExtra=t.metadataRows-t.watchlistFilms;
 const metadataIds=new Set([...watchIds,...elevatedIds.slice(0,metadataExtra)]);
 const films=[];
 let nullTitles=0,nullYears=0,missingExternal=0,conflictingExternal=0,zeroCreditFilms=0,maxCredits=0,localizationSources=0;
 for(let n=1;n<=t.films;n++){
  const id=filmId(n);
  const cohort=watchSet.has(n)?'watchlist':elevatedSet.has(id)?'elevated':'rest';
  const cohortIndex=cohort==='watchlist'?watchIds.indexOf(id):cohort==='elevated'?elevatedIds.indexOf(id):restIds.indexOf(id);
  const nullTitle=(cohort==='elevated'&&cohortIndex%19===0)||(cohort==='rest'&&cohortIndex%17===0);
  if(nullTitle)nullTitles++;
  const trusted=cohort==='watchlist'||cohortIndex%5!==0;
  const conflicting=!trusted&&cohort==='rest'&&cohortIndex%11===0;
  if(!trusted)missingExternal++;
  if(conflicting)conflictingExternal++;
  const credits=creditsOf.get(id)||[];
  if(credits.length===0)zeroCreditFilms++;
  if(credits.length>maxCredits)maxCredits=credits.length;
  const nullYear=cohort==='watchlist'&&cohortIndex%4===0;
  if(nullYear)nullYears++;
  const metadata=metadataIds.has(id)?{
   year:nullYear?null:1990+(n%40),
   runtime:nullYear?null:90+(n%40),
   synopsis:nullYear?null:'Synthetic synopsis',
   poster:nullYear?null:'/synthetic.jpg',
   url:nullYear?null:'https://example.test/synthetic',
   genres:nullYear?[]:['drama'],
   peopleVersion:2,
   payload:n%2===0?{note:'synthetic'}:{},
  }:null;
  const names=DIMENSIONS.slice(0,dims[n-1]);
  if(names.includes('localization'))localizationSources++;
  films.push({
   id,n,cohort,title:nullTitle?null:'Synthetic '+n,
   canonicalIdentity:trusted?'tmdb:'+n:null,
   trusted,conflicting,
   metadata,sync:metadataIds.has(id),
   dimensions:names.map(name=>({name,value:name==='localization'?'Synthetic title':null})),
   credits,
  });
 }
 const summary={
  seed:t.seed,clock:t.clock,
  films:films.length,persons:t.persons,credits:films.reduce((sum,film)=>sum+film.credits.length,0),
  dimensions:films.reduce((sum,film)=>sum+film.dimensions.length,0),
  watchlistFilms:films.filter(film=>film.cohort==='watchlist').length,
  elevatedFilms:films.filter(film=>film.cohort==='elevated').length,
  metadataRows:films.filter(film=>film.metadata).length,
  syncRows:films.filter(film=>film.sync).length,
  watchlistCreditRows:watchCredits.reduce((sum,list)=>sum+list.length,0),
  watchlistPersons:t.creditedPersons,
  watchlistCreditMin:Math.min(...watchCounts),watchlistCreditMax:Math.max(...watchCounts),
  elevatedCreditRows:elevatedCredits.reduce((sum,list)=>sum+list.length,0),
  elevatedPersons:t.elevatedPersons,
  departedSteady:departedIds.length,departedElevated:elevatedDepartedIds.length,absentDeparted:absentIds.length,
  zeroCreditFilms,nullTitles,nullYearMetadata:nullYears,missingExternalIds:missingExternal,conflictingExternalIds:conflictingExternal,
  maxCreditsPerFilm:maxCredits,personsWithoutCredits:unusedPersons,
  localizationSources,redirects:Math.min(20,t.watchlistFilms),
  modelled:true,productionSample:false,
 };
 if(summary.films!==t.films||summary.credits!==t.credits||summary.dimensions!==t.dimensions||summary.metadataRows!==t.metadataRows)throw new Error('layout missed a target: '+JSON.stringify(summary));
 if(summary.watchlistCreditMin!==t.watchlistCreditMin||summary.watchlistCreditMax!==t.watchlistCreditMax)throw new Error('watchlist credit range drifted');
 return {targets:t,summary,films,personIds,departedIds,elevatedDepartedIds,absentIds,elevatedIds};
}

export function layoutDigest(layout){
 const hash=createHash('sha256');
 hash.update(JSON.stringify(layout.summary));
 for(const film of layout.films){
  hash.update('\n'+film.id+'|'+film.cohort+'|'+(film.title===null?'':'t'));
  for(const credit of film.credits)hash.update('|'+credit.personId+','+credit.role+','+credit.ordinal);
 }
 return hash.digest('hex');
}

const sqlite=(file,text)=>{
 const result=sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<28});
 if(result.status!==0)throw new Error((result.stderr||'sqlite failed').trim().slice(0,300));
};

function writeChunks(file,statements){
 const size=400;
 for(let i=0;i<statements.length;i+=size)sqlite(file,'BEGIN;\n'+statements.slice(i,i+size).join('\n')+'\nCOMMIT;\n');
}

// A new sqlite file. Refuses an existing path. Foreign keys are checked after the load; the manifest is what verifyCopy compares.
export function writeSynthetic(file,targets,{root=process.cwd()}={}){
 if(fs.existsSync(file))throw new Error('output_exists');
 const layout=buildLayout(targets);
 const migrations=path.join(root,'migrations');
 const chain=fs.readdirSync(migrations).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 sqlite(file,chain.map(name=>fs.readFileSync(path.join(migrations,name),'utf8')).join('\n'));
 const t=layout.targets;
 const clock=q(t.clock);
 const statements=[];
 for(const film of layout.films){
  statements.push('INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('+[q(film.id),'1',sqlValue(film.canonicalIdentity),sqlValue(film.title),clock].join(',')+');');
 }
 for(let n=1;n<=t.persons;n++)statements.push("INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ("+q('person:tmdb:'+n)+","+q('role:'+n)+",1,"+clock+");");
 writeChunks(file,statements);
 const children=[];
 for(const film of layout.films){
  if(film.cohort==='watchlist')children.push('INSERT INTO watchlist_film (film_id,updated_at) VALUES ('+q(film.id)+','+clock+');');
  if(film.trusted)children.push("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(film.id)+",'tmdb',"+q(String(film.n))+",1,0,NULL);");
  else if(film.conflicting)children.push("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(film.id)+",'tmdb',"+q('c'+film.n)+",0,1,NULL);");
  if(film.metadata){
   const m=film.metadata;
   children.push('INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES ('+[q(film.id),'1',sqlValue(m.year),sqlValue(m.runtime),sqlValue(m.synopsis),sqlValue(m.poster),sqlValue(m.url),q(JSON.stringify(m.genres)),'2',q(JSON.stringify(m.payload)),'NULL','NULL',clock].join(',')+');');
   children.push('INSERT INTO film_sync_state (film_id,metadata_at,synopsis_fetched_at,people_names_version,people_localized_at) VALUES ('+[q(film.id),clock,clock,'2',clock].join(',')+');');
  }
  for(const dimension of film.dimensions){
   const provenance=dimension.name==='identity'?q(JSON.stringify({titleSource:{source:'tmdb',at:t.clock}})):'NULL';
   children.push('INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES ('+[q(film.id),q(dimension.name),"'provisional'",q(dimension.name==='fingerprint'?'synthetic':'tmdb'),"'1'",provenance,sqlValue(dimension.value),'NULL','NULL','NULL','NULL','0',"'none'",clock].join(',')+');');
  }
  if(film.dimensions.some(dimension=>dimension.name==='localization'))children.push('INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ('+[q(film.id),"'tmdb'",q('Synthetic title'),"'1'",q('{}'),"'synthetic'",clock,clock].join(',')+');');
  for(const credit of film.credits)children.push('INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('+[q(film.id),q(credit.personId),q(credit.role),String(credit.ordinal)].join(',')+');');
  children.push("INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(film.id)+",1,"+clock+");");
 }
 for(let n=1;n<=t.persons;n++){
  children.push("INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('person',"+q('person:tmdb:'+n)+",1,"+clock+");");
  if(n%4===0)children.push('INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES ('+q('person:tmdb:'+n)+",'name',"+q('p'+n)+',NULL);');
  if(n%3===0)children.push('INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('+q('person:tmdb:'+n)+",'tmdb',"+q(String(n))+',1,0,NULL);');
 }
 const redirects=layout.summary.redirects;
 for(let i=1;i<=redirects;i++)children.push('INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('+q('film:retired:'+i)+','+q(layout.films.find(film=>film.cohort==='watchlist').id)+','+clock+');');
 writeChunks(file,children);
 const manifest=["CREATE TABLE m2b_copy_manifest (table_name TEXT PRIMARY KEY, row_count INTEGER NOT NULL, max_rowid INTEGER) STRICT;"];
 for(const item of COPY_PLAN)manifest.push('INSERT INTO m2b_copy_manifest (table_name,row_count,max_rowid) SELECT '+q(item.table)+', COUNT(*), MAX(rowid) FROM '+item.table+';');
 sqlite(file,manifest.join('\n'));
 const verdict=verifyCopy(file);
 if(!verdict.ok||!verdict.representative)throw new Error('synthetic copy refused: '+verdict.refusals.join(','));
 return {ok:true,summary:layout.summary,counts:verdict.counts,digest:layoutDigest(layout)};
}

function round(ms){return Number(ms.toFixed(1));}
function elapsed(){
 const start=process.hrtime.bigint();
 const cpu=process.resourceUsage();
 return ()=>{
  const end=process.resourceUsage();
  return {wallMs:round(Number(process.hrtime.bigint()-start)/1e6),cpuUserMs:round((end.userCPUTime-cpu.userCPUTime)/1000),cpuSystemMs:round((end.systemCPUTime-cpu.systemCPUTime)/1000)};
 };
}
function environment(){
 let sqliteVersion=null;
 try{const result=sqliteSync(['-version'],{input:'',encoding:'utf8'});if(result.status===0)sqliteVersion=String(result.stdout||'').trim().split('\n')[0]||null;}catch{sqliteVersion=null;}
 return {node:process.version,platform:process.platform,arch:process.arch,cpus:os.cpus().length,sqlite:sqliteVersion};
}
function publicReport(report){
 return {
  planned:report.planned,byKind:report.byKind,refusedByCode:report.refusedByCode,failedByCode:report.failedByCode,
  changed:report.changed,changedShare:report.changedShare,latencyMs:report.latencyMs,d1ReadsPerUnit:report.d1ReadsPerUnit,
  planMs:report.planMs,fingerprint:report.fingerprint,writes:report.writes,
 };
}
const fileHash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function guardedRun(file,options){
 const stop=elapsed();
 const result=await runOnCopy(file,{...options,at:options.at,clock:options.clock});
 return {...result,report:result.report?publicReport(result.report):null,timing:stop(),timingMeans:'local sqlite stand-in; not Worker CPU, not a D1 round trip, not production latency'};
}

async function filmOnly(file,{films,departed,at}){
 const before=fileHash(file);
 const stop=elapsed();
 const report=await dryRun({env:{DB:d1Standin(file)},runId:'m2b',at,films,departed,persons:[],credits:[],personRows:[]});
 if(fileHash(file)!==before)throw new Error('copy changed during a film-only scenario');
 return {copyUnchanged:true,report:publicReport(report),timing:stop(),timingMeans:'local sqlite stand-in; film units only, persons and credits not re-planned'};
}

function addMembership(source,dest,ids,clock){
 fs.copyFileSync(source,dest);
 const inserts=ids.map(id=>'INSERT INTO watchlist_film (film_id,updated_at) VALUES ('+q(id)+','+q(clock)+');').join('\n');
 sqlite(dest,'BEGIN;\n'+inserts+'\nUPDATE m2b_copy_manifest SET row_count = row_count + '+ids.length+" WHERE table_name = 'watchlist_film';\nCOMMIT;\n");
}

// Steady generation, elevated generation (the steady departed cohort returned onto the watchlist), and an absence scenario of departed ids the store does not hold.
export async function measureSynthetic(file,targets,{root=os.tmpdir()}={}){
 const layout=buildLayout(targets);
 const at=layout.targets.clock;
 const steadyInputs=inputsFromCopy(file,{departed:layout.targets.departedSteady});
 const steadyDeparted=new Set(layout.departedIds);
 const steadyInputDeparted=new Set(steadyInputs.departed);
 if(steadyInputs.departed.length!==layout.departedIds.length||layout.departedIds.some(id=>!steadyInputDeparted.has(id)))throw new Error('steady departed sample is not the harness sample');
 if(layout.departedIds.some(id=>steadyInputs.films.some(film=>film.id===id)))throw new Error('a departed film is also observed');
 const steady=await guardedRun(file,{departed:layout.targets.departedSteady,at});
 const absent=await filmOnly(file,{films:[],departed:[...layout.departedIds,...layout.absentIds],at});
 const elevatedFile=path.join(root,'m2b-synthetic-elevated-'+process.pid+'.sqlite');
 let elevated;
 try{
  addMembership(file,elevatedFile,layout.elevatedIds,at);
  const elevatedInputs=inputsFromCopy(elevatedFile,{departed:layout.targets.departedElevated});
  const observed=new Set(elevatedInputs.films.map(film=>film.id));
  const departed=new Set(elevatedInputs.departed);
  if(elevatedInputs.departed.length!==layout.elevatedDepartedIds.length||layout.elevatedDepartedIds.some(id=>!departed.has(id)))throw new Error('elevated departed sample is not the harness sample');
  const returned=layout.departedIds.filter(id=>observed.has(id)&&!departed.has(id)).length;
  elevated=await guardedRun(elevatedFile,{departed:layout.targets.departedElevated,at});
  elevated.returnedSteadyDeparted=returned;
  elevated.returnedExpected=layout.departedIds.length;
 }finally{try{fs.rmSync(elevatedFile,{force:true});}catch{/* the copy is a measurement scratch */}}
 const leak=JSON.stringify({steady:steady.report,absent:absent.report,elevated:elevated.report});
 if(/film:|person:|Synthetic/.test(leak))throw new Error('a measurement report contains an id or a title');
 return {
  ok:steady.ok===true&&elevated.ok===true&&steady.representative===true&&elevated.representative===true,
  label:'synthetic-at-scale',
  productionSample:false,
  authoritativeParity:false,
  changedShareMeaning:'harness comparison against rows this fixture wrote; not the production changedShare',
  personState:'unmeasured',
  environment:environment(),
  summary:layout.summary,
  steady:{volume:steady.volume,representative:steady.representative,notADCInput:steady.notADCInput===true,report:steady.report,timing:steady.timing},
  absent:{storedDeparted:layout.departedIds.length,unknownIds:layout.absentIds.length,report:absent.report,timing:absent.timing},
  elevated:{returnedSteadyDeparted:elevated.returnedSteadyDeparted,returnedExpected:elevated.returnedExpected,volume:elevated.volume,representative:elevated.representative,report:elevated.report,timing:elevated.timing},
  limits:'Local planning cost and unit counts on a modelled catalog. Not production latency, not D1 CPU or write cost, not a Worker to D1 round trip, not Workflow limits, and not person_state.',
 };
}

const isMain=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(isMain){
 const [command,target]=process.argv.slice(2);
 let out;
 try{
  if(command==='layout')out=buildLayout(E6_TARGETS).summary;
  else if(command==='build'&&target)out=writeSynthetic(target,E6_TARGETS);
  else if(command==='measure'&&target)out=await measureSynthetic(target,E6_TARGETS);
  else{console.error('usage: layout | build <out.sqlite> | measure <out.sqlite>');process.exit(2);}
 }catch(error){console.error('refused: '+String(error?.message||error).slice(0,400));process.exit(1);}
 console.log(JSON.stringify(out,null,1));
 if(out&&out.ok===false)process.exit(1);
}
