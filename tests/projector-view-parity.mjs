// AIR-402: the projector's view build and its inputs are byte-for-byte what they were before the linear indexes.
// The baseline is a frozen copy of src/domain/film-person-reader.js and src/enrichment-projection.js at d73ac48 (tests/fixtures/air-402-baseline/),
// loaded beside the current sources in separate scopes. Many seeded stores, built twice (never shared between the two), go through
// readLifecycle(entitiesOnly), enrichmentInputs and every change key; the JSON text of each result must be identical. Five deliberate
// defects in the indexed code must each break the comparison somewhere, which shows the stores reach the paths the indexes replace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';

vm.runInThisContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'));
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'air402-'));
let loaded=0;
function load(readerSource,projectionSource,readerNames=['readLifecycle']){
 const id=++loaded;
 const readerFile=path.join(scratch,'reader'+id+'.js'),projectionFile=path.join(scratch,'projection'+id+'.js');
 fs.writeFileSync(readerFile,readerSource);fs.writeFileSync(projectionFile,projectionSource);
 vm.runInThisContext(scoped(readerFile,'Reader'+id,readerNames)+'\n'+scoped(projectionFile,'Projection'+id));
 return vm.runInThisContext('({reader:Reader'+id+',projection:Projection'+id+'})');
}
const baselineReader=fs.readFileSync('tests/fixtures/air-402-baseline/film-person-reader.baseline.js','utf8');
const baselineProjection=fs.readFileSync('tests/fixtures/air-402-baseline/enrichment-projection.baseline.js','utf8');
const currentReader=fs.readFileSync('src/domain/film-person-reader.js','utf8');
const currentProjection=fs.readFileSync('src/enrichment-projection.js','utf8');
const baseline=load(baselineReader,baselineProjection);
const INDEX_NAMES=['readLifecycle','orderedFilmIndex','storedFilmId'];
const indexed=load(currentReader,currentProjection,INDEX_NAMES);

function rng(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const T='2026-10-28T10:00:00.000Z';
const NOW=Date.parse('2026-11-09T22:00:00.000Z');
const NOW_ISO=new Date(NOW).toISOString();
const UNICODE=['é','ñ','日本','Ж','😀','á','ß'];

// One deterministic store, built from scratch on every call: the two implementations never share an object. `share` of the films live only in
// the discovered catalog; the rest are on the programme and watchlist. Collisions on purpose: two catalog records with one TMDB id, a catalog
// record with the TMDB id of a listed Film, a catalog record whose id is already a stored id, a thin archive stub under a catalog id (richer and
// poorer than the record), metadata entries under a lid, under tmdb_<n>, under a key whose own id names another film, null entries and
// integer-like keys, ids with accents and astral characters, a record listed on both lists as one object, falsy list items.
function makeStore(seed,{films=120,share=0.6,nullItem=false,admit=true,twoIds=false}={}){
 const random=rng(seed),pick=list=>list[Math.floor(random()*list.length)];
 const people=[];
 for(let index=0;index<films*4;index++)people.push({id:(index%3?'tmdb_actor/':'actor/')+(1000+index),name:'Person '+index+pick(UNICODE),original:'Person '+index});
 const roster=()=>({directors:[pick(people)],actors:Array.from({length:1+Math.floor(random()*6)},()=>pick(people))});
 const watchlist=[],programme=[],metadata={},discovered={},archive={},admissions={},alt=new Map();
 const catalogCount=Math.round(films*share),listed=films-catalogCount;
 const tmdbOf=index=>String(300000+index);
 for(let index=0;index<listed;index++){
  const id='w'+index.toString(36)+(index%9===0?pick(UNICODE):'');
  const record={id,title:'Film '+index,original:'Film '+index,year:1980+index%40,tmdbId:index%7===0?null:tmdbOf(index%9===4&&index>0?index-1:index),url:'https://letterboxd.com/film/'+id+'/',...roster()};
  const inProgramme=index%5!==0;
  if(index%11===0){watchlist.push(record);programme.push(record);}else{watchlist.push(record);if(inProgramme)programme.push({...record,shows:[]});}
  // a Film that two metadata entries answer to, by two different ids: the entry under its alternative id comes first. The view's Film is renamed to that id by run().
  if(twoIds&&index%4===1&&index%3!==0){alt.set('film:'+id,'film:tmdb:'+(700000+index));metadata['tmdb:'+(700000+index)]={title:'alternative entry '+index,metadataAt:T,synopsis:'alternative synopsis',synopsisFetchedAt:T};}
  if(index%3!==0)metadata[index%13===0?'tmdb_'+tmdbOf(index):id]={...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis of '+id,synopsisFetchedAt:T,runtime:90+index%60};
  if(index%17===0)metadata['k'+index]={...record,id:'w'+((index+1)%Math.max(1,listed)).toString(36),metadataAt:T,synopsis:'misnamed'};
  if(index%19===0)metadata['n'+index]=null;
  if(index%23===0)metadata[String(1000+index)]={id:'x'+index,title:'numeric key'};
  if(admit&&index%29===0)admissions[id]=index%2===0;
  // a Film that left the lists but stays admitted (withheld when its cache is gone)
  if(admit&&index%7===3){admissions['r'+index]=index%2===0;if(index%14===3)metadata['r'+index]={id:'r'+index,title:'Retained '+index,metadataAt:T,synopsis:'Retained synopsis',synopsisFetchedAt:T};}
 }
 if(nullItem)watchlist.push(null);
 if(random()<0.5)watchlist.push(0,'');
 for(let index=0;index<catalogCount;index++){
  const n=listed+index;
  let tmdbId=tmdbOf(n);
  if(index%6===0&&listed>0)tmdbId=tmdbOf(Math.floor(random()*listed));
  if(index%10===1&&index>0)tmdbId=tmdbOf(listed+index-1);
  const id=index%14===2&&listed>0?'w'+Math.floor(random()*listed).toString(36):'tmdb_'+tmdbId+(index%31===0?'_'+index:'');
  discovered[id+(discovered[id]?'~'+index:'')]={id,tmdbId,title:'Catalog '+index+pick(UNICODE),original:'Catalog '+index,year:1950+index%70,discoveredAt:T,...(index%3?{synopsis:'Overview '+index}:{}),...roster()};
  if(index%12===0)archive['tmdb_'+tmdbId]={tmdb:tmdbId,title:'Archive '+index,year:1990+index%20,...(index%24===0?{synopsis:'Archive synopsis',directors:[pick(people)],peopleVersion:1,metadataAt:T}:{})};
 }
 return {watchlist:{updatedAt:T,films:watchlist},programme:{updatedAt:T,films:programme},metadata,discovered,archive,admissions,alt};
}
function storeOf(impl,raw){
 return impl.projection.enrichmentStore({watchlist:raw.watchlist,programme:raw.programme,metadata:raw.metadata,titles:{},people:{},discoveredFilms:raw.discovered,discoveryResolution:{},diaryHistory:null,tmdbRetirements:null,watchlistAdmissions:raw.admissions,archiveAdmissions:raw.archive,filmTitles:[],personNames:[],personOverrides:{}});
}
function run(impl,seed,options){
 try{
  const raw=makeStore(seed,options),store=storeOf(impl,raw);
  const view=impl.reader.readLifecycle(store,NOW,{entitiesOnly:true});
  if(options?.twoIds)view.films=view.films.map(film=>raw.alt.has(film.id)?{...film,id:raw.alt.get(film.id)}:film);
  const inputs=impl.projection.enrichmentInputs({view,store});
  const keys=[...inputs.people.map(entry=>impl.projection.personChangeKey(entry,NOW_ISO)),...inputs.films.map(entry=>impl.projection.filmChangeKey(entry,NOW_ISO))];
  return {view,inputs,keys,text:{view:JSON.stringify(view),inputs:JSON.stringify(inputs),keys:keys.join('\n')}};
 }catch(error){
  // a store the baseline cannot build must fail the same way in the indexed code
  return {view:{films:[],people:[]},inputs:{films:[],people:[]},keys:[],threw:String(error.message),text:{view:'threw '+error.message,inputs:'',keys:''}};
 }
}
const SHAPES=[{films:60,share:0.05},{films:120,share:0.6},{films:240,share:0.9},{films:90,share:0.5,nullItem:true,admit:false},{films:40,share:1},{films:120,share:0.3,twoIds:true}];
function compare(left,right,seed,options){
 const a=run(left,seed,options),b=run(right,seed,options);
 return {same:a.text.view===b.text.view&&a.text.inputs===b.text.inputs&&a.text.keys===b.text.keys,a,b};
}

// 1. parity on every seed and shape, with counters that show the interesting paths were taken
const SEEDS=Array.from({length:24},(_,index)=>index+1);
const seen={films:0,people:0,redirects:0,credits:0,withheld:0,watchlist:0,metadata:0,unicodeIds:0};
for(const options of SHAPES)for(const seed of SEEDS){
 const {same,a}=compare(baseline,indexed,seed,options);
 assert.ok(same,'indexed view, inputs or keys differ from the baseline (seed '+seed+', '+JSON.stringify(options)+')');
 seen.films+=a.view.films.length;seen.people+=a.view.people.length;
 for(const film of a.view.films)if((film.redirects||[]).length)seen.redirects++;
 for(const entry of a.inputs.films){
  if(entry.credits)seen.credits++;
  if(entry.preserveCanonical)seen.withheld++;
  if(entry.watchlist)seen.watchlist++;
  if(entry.metadata)seen.metadata++;
  if(/[^\u0000-\u007f]/.test(entry.id))seen.unicodeIds++;
 }
}
assert.ok(seen.films>5000&&seen.people>5000,'the stores are large enough to mean something: '+JSON.stringify(seen));
for(const name of ['redirects','credits','withheld','watchlist','metadata','unicodeIds'])assert.ok(seen[name]>0,'the stores never reach '+name+': '+JSON.stringify(seen));

// 2. the ordered Film index against a naive model: random sets (new keys and keys set again), deletes and lookups, compared with the linear scans it replaces
function modelHolds(api,seed,steps=1500){
 const random=rng(seed),films=new Map(),index=api.reader.orderedFilmIndex(films);
 const mirror=new Map();
 const pick=list=>list[Math.floor(random()*list.length)];
 const values=['1','2','3','4','5','x'];
 const make=n=>{
  const externalIds=[];
  for(let count=Math.floor(random()*3);count>0;count--)externalIds.push({scheme:pick(['tmdb','tmdb','letterboxd','tmdb_tv']),value:pick(values),trusted:random()<0.7,conflicting:random()<0.15});
  return {id:'film:'+pick(['a','b','c','d'])+n,externalIds:random()<0.1?undefined:externalIds,n};
 };
 const tmdbOf=value=>[...mirror.values()].find(film=>(film.externalIds||[]).some(item=>item.scheme==='tmdb'&&item.trusted&&!item.conflicting&&item.value===value))||null;
 const storedOf=value=>[...mirror.values()].find(film=>api.reader.storedFilmId(film)===value)||null;
 for(let step=0;step<steps;step++){
  const key='k'+Math.floor(random()*12);
  if(random()<0.7){const film=make(step);index.set(key,film);mirror.set(key,film);}else{index.delete(key);mirror.delete(key);}
  if([...films.keys()].join()!==[...mirror.keys()].join())return false;
  for(const value of values)if(index.firstWithTmdb(value)!==tmdbOf(value))return false;
  for(const value of ['tmdb_1','tmdb_2','tmdb_3','tmdb_x','film:a'+(step-1),...[...mirror.values()].slice(0,3).map(film=>api.reader.storedFilmId(film))])if(index.firstStored(value)!==storedOf(value))return false;
 }
 return true;
}
for(const seed of [1,2,3,4,5,6,7,8])assert.ok(modelHolds(indexed,seed),'the Film index disagrees with the linear scans (seed '+seed+')');

// 3. deliberate defects in the indexed code: each must break the store comparison or the index model somewhere
const replaceOnce=(text,from,to)=>{assert.ok(text.includes(from),'missing: '+from);return text.replace(from,to);};
const defects=[
 {name:'last Film wins in the TMDB bucket',reader:replaceOnce(currentReader,'for(const [key,seq] of group)if(seq<lowest){found=key;lowest=seq;}','for(const [key,seq] of group)if(true){found=key;lowest=seq;}')},
 {name:'a key set again moves to the end',reader:replaceOnce(currentReader,'films.set(key,film);place(key,film,sequence.get(key));return;','films.set(key,film);place(key,film,counter++);return;')},
 {name:'a deleted Film stays in the index',reader:replaceOnce(currentReader,'delete(key){if(!films.has(key))return;remove(key,films.get(key));','delete(key){if(!films.has(key))return;')},
 {name:'records not restored to list order',projection:replaceOnce(currentProjection,'placed.sort((a,b)=>a[0]-b[0]);','')},
 {name:'the last metadata entry wins for an id',projection:replaceOnce(currentProjection,'if(!first.has(other))first.set(other,at);','first.set(other,at);')},
 {name:'the highest position wins among a Film\'s ids',projection:replaceOnce(currentProjection,'if(at!==undefined&&(best<0||at<best))best=at;','if(at!==undefined)best=at;')}
];
for(const defect of defects){
 const api=load(defect.reader||currentReader,defect.projection||currentProjection,INDEX_NAMES);
 let broken=[1,2,3,4,5,6,7,8].some(seed=>!modelHolds(api,seed));
 for(const options of SHAPES){if(broken)break;for(const seed of SEEDS){if(!compare(baseline,api,seed,options).same){broken=true;break;}}}
 assert.ok(broken,'the tests do not notice: '+defect.name);
}

// 4. a null watchlist item keeps the linear answer, errors included: with a retained Film (an admission) the linear lookup reaches the null item and throws,
// and the indexed code throws the same error; without one the answer is the same text
{
 const throwing={films:30,share:0.3,nullItem:true,admit:true};
 let threw=0;
 for(const seed of [1,2,3,4,5,6]){
  const a=run(baseline,seed,throwing),b=run(indexed,seed,throwing);
  assert.equal(a.text.view,b.text.view);assert.equal(a.text.inputs,b.text.inputs);assert.equal(a.threw,b.threw);
  if(a.threw)threw++;
 }
 assert.ok(threw>0,'no store reached the null item with a retained Film');
}

fs.rmSync(scratch,{recursive:true,force:true});
console.log('Projector view parity: indexed view, inputs and change keys equal the baseline on '+SHAPES.length*SEEDS.length+' stores ('+seen.films+' Films, '+seen.people+' Persons, '+seen.redirects+' redirects); '+defects.length+' deliberate defects caught');
