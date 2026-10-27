// Finds display-only exclusion (ADR-0028): the offline builder and the read path of GET /api/catalog/available. Strict
// original title + exact year, uniqueness in the export and the catalog, identity wins, per-generation evaluation, the
// FINDS_TITLE_EXCLUSION switch, fail-open on any invalid list, and no per-film data or list hash in the response. Synthetic data only.
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {crc32} from '../src/letterboxd-zip.js';
import {normTitle} from '../src/letterboxd-match.js';
import {plan} from '../scripts/letterboxd-baseline-import.mjs';
import {build} from '../scripts/letterboxd-display-exclusion.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const KEY='letterboxd/display-exclusion.json';

// Worker in a context of its own, with a bucket that also serves raw text and object sizes.
const raw=new Map();let gets=[],puts=[],textReads=0,sizeOverride=null;
const bucket={
 async get(key){gets.push(key);if(!raw.has(key))return null;const text=raw.get(key);return {etag:'1',size:sizeOverride??Buffer.byteLength(text),body:{cancel:async()=>{}},text:async()=>{textReads++;return text;},json:async()=>JSON.parse(text)};},
 async put(key){puts.push(key);},async delete(key){puts.push('delete:'+key);},async list(){return {objects:[],truncated:false};}
};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},fetch:async()=>{throw new Error('unexpected fetch');}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker,constant=name=>vm.runInContext(name,context);

// Normalization parity: the Worker key and the builder's normTitle are the same function (normTitle_v1).
for(const value of ['Ёлки–Палки!','  The  Raid: Redemption ','Amélie','ＦＵＬＬ　ＷＩＤＴＨ','8½','Dr. Strangelove…',null,''])assert.equal(constant('findsTitleKey')(value),normTitle(value),String(value));

const hour=3600000,now=Date.now(),G1='11111111-1111-4111-8111-111111111111',G2='22222222-2222-4222-8222-222222222222';
const current={prediction:{predictedRating:4.5,probability4Plus:.9,confidence:'high',matchSignals:[],mainRisk:null,tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1},fingerprintHash:'f',fingerprint:{fingerprintHash:'f',plotMechanics:[],execution:{}}};
const film=(n,original,year,extra={})=>({id:'tmdb_'+n,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,title:original,original,year,runtime:100,genres:[],poster:null,url:null,directors:[],actors:[],shows:[{channelId:'c1',channel:'One',start:now-hour,end:now+hour}],...extra});
const CATALOG={
 tmdb_1:film(1,'Exact Film',2000),                                          // unique original title, same year: hidden
 tmdb_2:film(2,'Remade',1990),tmdb_3:film(3,'Remade',2010),                 // a remake in another year blocks both
 tmdb_4:film(4,'Off By One',2001),                                          // the list says 2000: not hidden
 tmdb_5:film(5,'Original Five',2005,{title:'Локальное',aliases:['Alias Five']}), // list matches only the localized title and alias
 tmdb_6:film(6,'Linked Film',2006),                                         // has a stored Letterboxd id: identity decides
 tmdb_7:film(7,'No Year',null),                                             // record without a year
 tmdb_8:film(8,'Alias Clash',2008),tmdb_9:film(9,'Other Nine',2009,{aliases:['Alias Clash']}), // namesake through an alias
 tmdb_12:film(12,'Ёлки–Палки',2012),                                        // normalization: hidden
 tmdb_14:film(14,'Plain Film',2014),                                        // not in the list
};
const ENTRIES=[['alias clash',2008],['alias five',2005],['elsewhere only',1999],['exact film',2000],['linked film',2006],['no year',2007],['off by one',2000],['remade',1990],['елки палки',2012],['локальное',2005]].map(([title,year])=>({title,year}));
const list=(entries=ENTRIES,patch={})=>{const value={schemaVersion:1,kind:'letterboxd_display_exclusion',rule:'strict_original_exact_year',normalization:'normTitle_v1',source:{type:'letterboxd_export',archiveSha256:'a'.repeat(64),exportedAt:'2026-10-26T13:48:00.000Z',baselinePlanSha256:'b'.repeat(64)},builtAt:'2026-10-27T10:00:00.000Z',counts:{exportFilms:entries.length,entries:entries.length},entries,contentSha256:sha256(JSON.stringify(entries))};return {...value,...patch};};
function seed({catalog=CATALOG,generation=G1,exclusion=list()}={}){
 raw.clear();gets=[];puts=[];textReads=0;sizeOverride=null;
 const put=(key,value)=>raw.set(key,JSON.stringify(value));
 put('epg/published-generation.json',{phase:'published',programmeRunId:generation});
 put('epg/generations/'+generation+'/programme.json',{runId:generation,films:[]});
 put('epg/generations/'+generation+'/discovered-films.json',Object.fromEntries(Object.entries(catalog).map(([id,item])=>[id,{...item,showsProgrammeRunId:generation}])));
 put('watchlist.json',{films:[]});
 put('metadata.json',{lbx6:{id:'lbx6',tmdbId:'6',title:'Linked Film',year:2006}});
 put(constant('profileKey'),{version:1,profileHash:'p1'});
 put(constant('ENRICHMENT_KEY')+'view-index.json',Object.fromEntries(Object.keys(catalog).map(id=>[id,current])));
 if(exclusion!==null)raw.set(KEY,typeof exclusion==='string'?exclusion:JSON.stringify(exclusion));
}
const get=async env=>{const response=await worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/catalog/available'),{BUCKET:bucket,...env},{waitUntil(){}});return {status:response.status,body:await response.json()};};
const ids=body=>body.films.map(item=>item.id).sort();
const ALL=Object.keys(CATALOG).sort();

// 1. Switch on, valid list: only the strict matches are hidden; the response says state and a count, nothing more.
{
 seed();const r=await get({FINDS_TITLE_EXCLUSION:'on'});
 assert.equal(r.status,200,JSON.stringify(r.body));
 assert.deepEqual(ids(r.body),ALL.filter(id=>!['tmdb_1','tmdb_12'].includes(id)),'exact original title + year hidden; remake, ±1, alias, localized, linked, no-year and alias namesake shown');
 assert.deepEqual(r.body.displayExclusion,{state:'applied',excluded:2});
 assert.equal(r.body.total,r.body.films.length);
 const text=JSON.stringify(r.body);
 for(const secret of ['Exact Film','exact film','Ёлки','елки палки','elsewhere only','a'.repeat(64),'b'.repeat(64),list().contentSha256])assert.ok(!text.includes(secret),'response leaks '+secret);
 assert.deepEqual(puts,[],'GET writes nothing');
}
// 2. A new generation is evaluated afresh: a namesake entering the catalog shows the film again.
{
 seed({catalog:{...CATALOG,tmdb_13:film(13,'Exact Film',1980)},generation:G2});
 const r=await get({FINDS_TITLE_EXCLUSION:'on'});
 assert.ok(ids(r.body).includes('tmdb_1')&&ids(r.body).includes('tmdb_13'),'a remake in the new generation blocks the rule');
 assert.ok(!ids(r.body).includes('tmdb_12'));assert.deepEqual(r.body.displayExclusion,{state:'applied',excluded:1});
}
// 3. Switch off (absent, any other value, a non-string): the object is not read and nothing is hidden.
for(const value of [undefined,'off','On',' on','on ',true,1]){
 seed();const r=await get(value===undefined?{}:{FINDS_TITLE_EXCLUSION:value});
 assert.deepEqual(ids(r.body),ALL,'switch '+String(value));assert.deepEqual(r.body.displayExclusion,{state:'off',excluded:0});
 assert.ok(!gets.includes(KEY),'switch off does not read the list');
}
// 4. Fail-open: a missing, oversized or invalid list hides nothing and the route still answers 200.
const resign=entries=>list(entries,{counts:{entries:entries.length}});
const invalid={
 missing:null,
 'not JSON':'{"schemaVersion":1',
 'unknown schemaVersion':list(ENTRIES,{schemaVersion:2}),
 'unknown kind':list(ENTRIES,{kind:'other'}),
 'unknown rule':list(ENTRIES,{rule:'relaxed_year'}),
 'unknown normalization':list(ENTRIES,{normalization:'normTitle_v2'}),
 'extra top-level key':{...list(),extra:1},
 'extra source key':list(ENTRIES,{source:{...list().source,code:'x'}}),
 'source type':list(ENTRIES,{source:{...list().source,type:'manual'}}),
 'archive hash':list(ENTRIES,{source:{...list().source,archiveSha256:'A'.repeat(64)}}),
 'missing plan hash':list(ENTRIES,{source:{type:'letterboxd_export',archiveSha256:'a'.repeat(64),exportedAt:'2026-10-26T13:48:00.000Z'}}),
 'bad exportedAt':list(ENTRIES,{source:{...list().source,exportedAt:'yesterday'}}),
 'export after build':list(ENTRIES,{source:{...list().source,exportedAt:'2026-10-28T00:00:00.000Z'}}),
 'builtAt in the future':list(ENTRIES,{builtAt:new Date(now+24*hour).toISOString()}),
 'bad builtAt':list(ENTRIES,{builtAt:'2026-13-45T00:00:00Z'}),
 'counts mismatch':list(ENTRIES,{counts:{entries:ENTRIES.length+1}}),
 'negative count':list(ENTRIES,{counts:{entries:ENTRIES.length,droppedNoYear:-1}}),
 'duplicate entry':resign([...ENTRIES.slice(0,4),ENTRIES[3],...ENTRIES.slice(4)]),
 'unsorted entries':resign([...ENTRIES].reverse()),
 'title not normalized':resign([{title:'Exact Film',year:2000}]),
 'empty title':resign([{title:'',year:2000}]),
 'year out of range':resign([{title:'exact film',year:1800}]),
 'fractional year':resign([{title:'exact film',year:2000.5}]),
 'extra entry key':resign([{title:'exact film',year:2000,code:'Ab1'}]),
 'checksum mismatch':list(ENTRIES,{contentSha256:'c'.repeat(64)}),
 'too many entries':resign(Array.from({length:20001},(_,i)=>({title:'film '+String(i).padStart(5,'0'),year:2000}))),
};
for(const [name,value] of Object.entries(invalid)){
 seed({exclusion:value});const r=await get({FINDS_TITLE_EXCLUSION:'on'});
 assert.equal(r.status,200,name);assert.deepEqual(ids(r.body),ALL,name+': every film shown');assert.deepEqual(r.body.displayExclusion,{state:'unavailable',excluded:0},name);
}
// The size cap is checked from the object size before the body is read or parsed.
{
 seed();sizeOverride=2*1024*1024+1;const r=await get({FINDS_TITLE_EXCLUSION:'on'});
 assert.deepEqual(r.body.displayExclusion,{state:'unavailable',excluded:0});assert.equal(textReads,0,'an oversized list is not read');
}
// A storage error reading the list is not a route error.
{
 seed();const original=bucket.get;bucket.get=async key=>{if(key===KEY)throw new Error('R2 down');return original(key);};
 try{const r=await get({FINDS_TITLE_EXCLUSION:'on'});assert.equal(r.status,200);assert.deepEqual(r.body.displayExclusion,{state:'unavailable',excluded:0});}
 finally{bucket.get=original;}
}
// A film already excluded for another reason (rated) is not counted as hidden.
{
 seed();const view=JSON.parse(raw.get(constant('ENRICHMENT_KEY')+'view-index.json'));view.tmdb_1={...current,actualRating:4};raw.set(constant('ENRICHMENT_KEY')+'view-index.json',JSON.stringify(view));
 const r=await get({FINDS_TITLE_EXCLUSION:'on'});assert.ok(!ids(r.body).includes('tmdb_1'));assert.deepEqual(r.body.displayExclusion,{state:'applied',excluded:1});
}

// 5. Offline builder: bound to a verified baseline plan, only unidentified watched or rated films with a year and a unique name.
function zip(files){
 const locals=[],centrals=[];let offset=0;
 for(const [name,text] of Object.entries(files)){
  const data=Buffer.from(text),nameBytes=Buffer.from(name),crc=crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,nameBytes,data);centrals.push(central,nameBytes);offset+=30+nameBytes.length+data.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
const scratch=await mkdtemp(path.join(os.tmpdir(),'iptv-display-exclusion-'));
try{
 const csv=(header,rows)=>header+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n';
 const exportFiles={
  'watched.csv':csv('Date,Name,Year,Letterboxd URI',[['2024-05-01','Invented Heist','1995','https://boxd.it/Ab1'],['2024-05-02','Unique Seen','2003','https://boxd.it/Gh3'],['2024-05-03','Twin Name','2001','https://boxd.it/Ij4'],['2024-05-04','Twin Name','2011','https://boxd.it/Kl5'],['2024-05-05','No Year Film','','https://boxd.it/Mn6'],['2024-05-06','Shared Wish','2000','https://boxd.it/St9']]),
  'ratings.csv':csv('Date,Name,Year,Letterboxd URI,Rating',[['2024-05-07','Rated Only','2007','https://boxd.it/Op7','4']]),
  'watchlist.csv':csv('Date,Name,Year,Letterboxd URI',[['2024-01-01','Shared Wish','2008','https://boxd.it/Qr8']]),
  'diary.csv':csv('Date,Name,Year,Letterboxd URI,Rating,Watched Date',[]),
 };
 const zipPath=path.join(scratch,'letterboxd-demo-user-2026-10-26-13-48-utc.zip');await writeFile(zipPath,zip(exportFiles));
 const snapshot=async(name,films)=>{
  const dir=path.join(scratch,name);await mkdir(path.join(dir,'objects'),{recursive:true});const entries=[];
  for(const [key,value] of Object.entries({'watchlist.json':{films}})){const bytes=Buffer.from(JSON.stringify(value)),file='objects/'+sha256(Buffer.from(key))+'.bin';await writeFile(path.join(dir,file),bytes);entries.push({key,file,size:bytes.length,sha256:sha256(bytes)});}
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,source:{kind:'cloudflare-r2-s3',bucket:'iptv',readOnly:true},status:'consistent_fenced',noGoReasons:[],fence:{ok:true,keys:[]},changes:[],baselineIdentity:{programmeRunId:'run-test'},objects:entries}));
  return dir;
 };
 const snapshotDir=await snapshot('snapshot',[{id:'Ab1',title:'Invented Heist',original:'Invented Heist',year:1995,tmdbId:'949'}]);
 const planDir=path.join(scratch,'plan'),buildNow=Date.parse('2026-10-27T10:00:00Z');
 await plan({zip:zipPath,snapshot:snapshotDir,output:planDir,now:buildNow});
 const origin=JSON.parse(fs.readFileSync(path.join(planDir,'origin.json'),'utf8'));
 const output=path.join(scratch,'display-exclusion.json');
 const report=await build({zip:zipPath,plan:planDir,snapshot:snapshotDir,output,now:buildNow});
 assert.deepEqual(report.counts,{exportFilms:7,withIdentity:1,droppedNoYear:1,droppedNoName:0,droppedExportNamesake:3,entries:2});
 for(const secret of ['Unique','Twin','Rated','Gh3','Op7'])assert.ok(!JSON.stringify(report).includes(secret),'report leaks '+secret);
 const built=JSON.parse(fs.readFileSync(output,'utf8'));
 assert.equal(fs.statSync(output).mode&0o777,0o600);
 assert.deepEqual(built.entries,[{title:'rated only',year:2007},{title:'unique seen',year:2003}],'identified, no-year, namesake (also watchlist-only) and watchlist-only films are left out');
 assert.deepEqual(built.source,{type:'letterboxd_export',archiveSha256:origin.archiveSha256,exportedAt:origin.generatedAt,baselinePlanSha256:origin.planSha256});
 assert.doesNotMatch(fs.readFileSync(output,'utf8'),/Ab1|Gh3|boxd\.it|"rating"|2024-05/,'no codes, URIs, ratings or dates');
 // The built list is accepted by the Worker as is.
 seed({catalog:{tmdb_20:film(20,'Unique Seen',2003),tmdb_21:film(21,'Rated Only',2008)},exclusion:built});
 const r=await get({FINDS_TITLE_EXCLUSION:'on'});assert.deepEqual(ids(r.body),['tmdb_21']);assert.deepEqual(r.body.displayExclusion,{state:'applied',excluded:1});
 // Binding: a snapshot that does not reproduce the plan, a tampered plan, an existing or in-repository output are refused.
 const other=await snapshot('other',[]);
 await assert.rejects(build({zip:zipPath,plan:planDir,snapshot:other,output:path.join(scratch,'o1.json'),now:buildNow}),/does not reproduce the baseline plan/);
 await assert.rejects(build({zip:zipPath,plan:planDir,snapshot:snapshotDir,output,now:buildNow}),/EEXIST/);
 await assert.rejects(build({zip:zipPath,plan:planDir,snapshot:snapshotDir,output:path.resolve('tests','private-list.json'),now:buildNow}),/outside the Git repository/);
 const tampered=path.join(scratch,'tampered');fs.cpSync(planDir,tampered,{recursive:true});fs.appendFileSync(path.join(tampered,'plan.jsonl'),'\n');
 await assert.rejects(build({zip:zipPath,plan:tampered,snapshot:snapshotDir,output:path.join(scratch,'o2.json'),now:buildNow}),/plan.jsonl differs/);
 assert.ok(!fs.existsSync(path.join(scratch,'o1.json'))&&!fs.existsSync(path.join(scratch,'o2.json')),'a refused build writes nothing');
}finally{await rm(scratch,{recursive:true,force:true});}

console.log('Finds title exclusion: strict match, uniqueness, identity wins, generation recompute, switch, fail-open, privacy and the bound offline builder passed');
