// The EPG commit folds the active discovery ledger one candidate at a time and publishes the same
// generation the in-memory merge would. A crash before the generation pin moves leaves that pin alone.
// A retry of the same run keeps the events already saved. Synthetic titles only; no production snapshot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';
import {d1Standin} from './d1-standin.mjs';

const context=loadWorker();
const call=code=>vm.runInContext(code,context);
let encodedBytes=0;
{
 const Native=context.TextEncoder;
 context.TextEncoder=class extends Native{encode(value){const bytes=super.encode(value);encodedBytes+=bytes.byteLength;return bytes;}};
}
const merge=(previous,latest,runId)=>call('mergeDiscoveryCandidates')(previous,latest,{replaceShows:true,programmeRunId:runId});
const keyOf=raw=>call('discoveryCandidateKey')(raw);

function memoryBucket({stream=true,chunk=5}={}){
 const objects=new Map(),etags=new Map();let revision=0;
 const read=async value=>{
  if(typeof value==='string')return value;
  if(value&&typeof value.getReader==='function'){
   const reader=value.getReader(),decoder=new TextDecoder();let text='';
   while(true){const step=await reader.read();if(step.done)return text+decoder.decode();text+=decoder.decode(step.value,{stream:true});}
  }
  return Buffer.from(value).toString('utf8');
 };
 return {
  objects,
  seed(key,value){const text=typeof value==='string'?value:JSON.stringify(value);objects.set(key,text);etags.set(key,'e'+(++revision));},
  async get(key){
   if(!objects.has(key))return null;
   const text=objects.get(key),etag=etags.get(key);
   const object={etag,size:Buffer.byteLength(text),json:async()=>JSON.parse(text)};
   if(!stream)return object;
   object.text=async()=>text;
   Object.defineProperty(object,'body',{get(){const bytes=new TextEncoder().encode(text);return new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=chunk)controller.enqueue(bytes.slice(i,i+chunk));controller.close();}});}});
   return object;
  },
  async put(key,value,options={}){
   if(value&&typeof value.getReader==='function'&&String(key).includes('/generations/')&&String(key).endsWith('discovery-latest.json')){
    const prepared=encodedBytes-publishMark;
    const reader=value.getReader();
    let text='',reads=0,pending=0;const decoder=new TextDecoder();
    while(true){
     const step=await reader.read();
     if(step.done){text+=decoder.decode();break;}
     text+=decoder.decode(step.value,{stream:true});
     reads++;
     if(reads===2)pending=encodedBytes-publishMark;
    }
    assert.ok(prepared<Buffer.byteLength(text)/2,'encoded '+prepared+' bytes before the consumer read a '+Buffer.byteLength(text)+' byte document');
    assert.ok(pending>0&&pending<Buffer.byteLength(text)/2,'two pulls had already encoded '+pending+' bytes');
    value=text;
   }
   const text=await read(value),only=options.onlyIf;
   if(only?.etagDoesNotMatch==='*'&&objects.has(key)||only?.etagMatches&&only.etagMatches!==etags.get(key))return null;
   objects.set(key,text);etags.set(key,'e'+(++revision));return {etag:etags.get(key)};
  },
  async delete(key){objects.delete(key);etags.delete(key);},
  async list({prefix=''}={}){return {objects:[...objects.keys()].filter(key=>key.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
 };
}

const BASE=Date.UTC(2026,10,1,12);
const titles=['Брат','Сталкер','Солярис','Зеркало','Кин-дза-дза','Ирония судьбы','Кавычки "цитата"','Скобка {блок}'];
function raw(i,day=0){
 const title=titles[i%titles.length]+' '+i+(day?' день '+day:''),year=1960+(i%40);
 return {title:title+' ('+year+')',year,rawTitles:[title+(i%2?' х/ф':'')],description:'Описание '+i+' \\\\ "цитата" {скобка}',firstAiring:BASE+day*86400000+i,lastAiring:BASE+day*86400000+i+10,airings:1+(day?2:0),duration:90+(i%5),confirmedTmdbId:i%11===0?String(5000+i):null,shows:[{channelId:'ch'+(i%5),channel:'Канал '+(i%5),start:BASE+day*86400000+i*1000,end:BASE+day*86400000+i*1000+5400000,epgTitle:title}]};
}
const OLD='71820185-3cc1-4303-b674-14293dca938b',RUN='00ff34fa-e518-4ac7-ae63-b2e46f803503';

async function scan(text,size){
 const chunks=(async function*(){
  const bytes=new TextEncoder().encode(text),decoder=new TextDecoder();
  for(let i=0;i<bytes.length;i+=size)yield decoder.decode(bytes.slice(i,i+size),{stream:true});
  const tail=decoder.decode();if(tail)yield tail;
 })();
 const items=[];
 const wrapper=await call('forEachJsonArrayItems')(chunks,'items',item=>items.push(item));
 return {items,wrapper};
}
{
 const items=[raw(1),raw(2),raw(3)];
 const document={programmeRunId:OLD,note:'до',archive:{manifestId:'m-1',alsoArchived:['ключ|1991'],bytes:4},items,ledgerMode:'frozen',tail:true};
 const text=JSON.stringify(document);
 for(const size of [1,3,7,text.length]){
  const scanned=await scan(text,size);
  assert.deepEqual(scanned.items,items,'chunk '+size);
  assert.equal(scanned.wrapper.programmeRunId,OLD);
  assert.deepEqual(scanned.wrapper.archive,document.archive);
  assert.equal(scanned.wrapper.ledgerMode,'frozen');
  assert.equal(scanned.wrapper.tail,true);
  assert.equal(scanned.wrapper.items,undefined);
 }
 await assert.rejects(scan(text.slice(0,-5),4),/Discovery ledger JSON is incomplete/);
 const empty=await scan(JSON.stringify({programmeRunId:OLD,items:[]})+' \n\t',1);
 assert.deepEqual(empty.items,[]);
 assert.equal(empty.wrapper.programmeRunId,OLD);
 const reject=async body=>{
  for(const size of [1,3,body.length])await assert.rejects(scan(body,size),/Discovery ledger JSON is incomplete/);
 };
 await reject(JSON.stringify({programmeRunId:OLD,archive:{manifestId:'m'}}));
 await reject(JSON.stringify({items:{}}));
 await reject(JSON.stringify({items:null}));
 await reject('{"note":1,"items":[],"items":[]}');
 await reject(text+' true');
 await reject(text+'\n{}');
}

function folded(previous,reentry,latest,runId){
 const duplicates=new Set(),seen=new Set();
 for(const item of previous){const key=keyOf(item);if(seen.has(key))duplicates.add(key);else seen.add(key);}
 const session=call('openDiscoveryMerge')(latest,reentry,{replaceShows:true,programmeRunId:runId},duplicates);
 const placed=[],holes=new Map();
 for(const item of previous){
  const next=session.push(item);
  if(next){placed.push(next);continue;}
  const key=keyOf(item);if(!holes.has(key)){holes.set(key,placed.length);placed.push(null);}
 }
 const done=session.end();
 for(const entry of done.deferred)placed[holes.get(entry.key)]=entry.item;
 return [...placed.filter(Boolean),...done.appended];
}
{
 const repeated=raw(0),again={...raw(0),description:'второе описание',airings:4,shows:[{channelId:'ch9',channel:'Канал 9',start:BASE+50,end:BASE+80,epgTitle:'ещё'}]};
 const previous=[repeated,raw(1),again,raw(4)];
 const latest=[raw(1,2),raw(4,2),raw(9)];
 const reentry=[raw(9)];
 const plain=value=>JSON.parse(JSON.stringify(value));
 assert.deepEqual(plain(folded(previous,reentry,latest,RUN)),plain(merge([...previous,...reentry],latest,RUN)));
 assert.deepEqual(plain(folded(previous,[],latest,RUN)),plain(merge(previous,latest,RUN)));
 assert.equal(keyOf(repeated),keyOf(again));
}

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-memory-'));
let databases=0;
function openDb(onBatch=null){
 const file=path.join(root,'epg-'+(databases++)+'.sqlite');
 const db=d1Standin(file,{onBatch});
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0008_published_epg_authority']){
  if(name==='0008_published_epg_authority')db.sql(fs.readFileSync('migrations/0007_prediction_authority.sql','utf8'));
  db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
 }
 db.sql("UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+OLD+"', generation=1, mirror_programme_run_id='"+OLD+"' WHERE id=1");
 return db;
}
function arm(store,previousItems){
 const payload=merge([],[raw(9)],OLD)[0];
 const segment=call('ledgerArchiveSegment')(payload.key);
 const segmentKey=call('ledgerArchiveSegmentKey')(segment,'write-1');
 const manifestId='manifest-1';
 store.seed(segmentKey,{schemaVersion:1,segment,writeId:'write-1',items:{[payload.key]:{payload,envelope:{archivedAt:'2026-10-28T00:00:00.000Z',archivedFromProgrammeRunId:OLD,archiveWriteId:'write-1'}}}});
 const manifest={schemaVersion:1,manifestId,parentManifestId:null,segmentCount:64,hash:'fnv1a32-utf8',segments:Array.from({length:64},(_,index)=>({segment:index,object:index===segment?segmentKey:null,sha256:null,items:index===segment?1:0,bytes:0})),totals:{items:1,bytes:10},upsertedKeys:[payload.key],writer:{runId:OLD,kind:'split'}};
 store.seed('epg/discovery-archive/v1/manifests/'+manifestId+'.json',manifest);
 store.seed('epg/discovery-archive/v1/current.json',{manifestId});
 const ledger={programmeRunId:OLD,updatedAt:'2026-11-02T16:13:02.965Z',rawCandidates:previousItems.length,filteredNonMovies:0,items:previousItems,ledgerMode:'frozen',archive:{version:'v1',manifestId,segments:64,items:1,bytes:10,alsoArchived:[],uniqueArchivedItems:1}};
 store.seed('epg/generations/'+OLD+'/discovery-latest.json',ledger);
 store.seed('epg/discovery-latest.json',ledger);
 store.seed('epg/published-generation.json',{programmeRunId:OLD,phase:'published'});
 store.seed('sync.json',{runId:RUN,stage:'epg'});
 store.seed('epg/generations/'+OLD+'/discovered-films.json',{});
 return payload;
}
const programmeBody=()=>({runId:RUN,updatedAt:'2026-11-03T16:00:00.000Z',watchlistCount:1,films:[{id:'film1',title:'Схватка',year:1995,shows:[{channelId:'c1',channel:'Кино',start:BASE,end:BASE+60000,epgTitle:'Схватка'}]}],people:{directors:[],actors:[]},stats:{}});
let publishMark=0;
async function publish(store,latest,db){
 publishMark=encodedBytes;
 const env={BUCKET:store,DISCOVERY_LEDGER_MODE:'frozen',LETTERBOXD_USERNAME:'fixture',EPG_XML_URL:'https://epg.invalid/guide.xml',...(db?{DB:db}:{})};
 const programme=programmeBody();
 await call('publishGenerationWithLedger')(env,RUN,latest,{programmeRunId:RUN,updatedAt:programme.updatedAt,rawCandidates:latest.length,filteredNonMovies:0},{'programme.json':programme,'discovered-films.json':{}},{updatedAt:programme.updatedAt,films:[{id:'film1',title:'Схватка'}]});
}

const previous=merge([],[raw(0),raw(1),raw(2),raw(4)],OLD);
const latest=[raw(1,3),raw(2,3),raw(9)];

for(const [name,store] of [['chunked',memoryBucket({stream:true,chunk:5})],['json-only',memoryBucket({stream:false})]]){
 const payload=arm(store,previous);
 const pointer=store.objects.get('epg/discovery-archive/v1/current.json');
 await publish(store,latest,null);
 const written=JSON.parse(store.objects.get('epg/generations/'+RUN+'/discovery-latest.json'));
 assert.deepEqual(written.items,JSON.parse(JSON.stringify(merge([...previous,payload],latest,RUN))),name);
 assert.equal(written.ledgerMode,'frozen',name);
 assert.equal(store.objects.get('epg/discovery-archive/v1/current.json'),pointer,name+' archive pointer stays');
 assert.equal(JSON.parse(store.objects.get('epg/published-generation.json')).programmeRunId,RUN,name+' pin');
 assert.deepEqual(JSON.parse(store.objects.get('epg/discovery-latest.json')).items,written.items,name+' shared copy');
}
{
 const store=memoryBucket({stream:true,chunk:1});
 const again={...raw(0),description:'второе описание',airings:4,shows:[{channelId:'ch9',channel:'Канал 9',start:BASE+50,end:BASE+80,epgTitle:'ещё'}]};
 const prior=merge([],[raw(0),raw(1),again,raw(4)],OLD);
 arm(store,prior);
 const next=[raw(1,3),raw(4,3)];
 await publish(store,next,null);
 const written=JSON.parse(store.objects.get('epg/generations/'+RUN+'/discovery-latest.json'));
 assert.deepEqual(written.items,JSON.parse(JSON.stringify(merge(prior,next,RUN))),'repeated key');
}

{
 const store=memoryBucket();
 arm(store,previous);
 const text=store.objects.get('epg/generations/'+OLD+'/discovery-latest.json');
 store.objects.set('epg/generations/'+OLD+'/discovery-latest.json',text.slice(0,-1));
 await assert.rejects(publish(store,latest,null),/Discovery ledger JSON is incomplete/);
 assert.equal(store.objects.has('epg/generations/'+RUN+'/discovery-latest.json'),false);
 assert.equal(JSON.parse(store.objects.get('epg/published-generation.json')).programmeRunId,OLD);
}

// Same run, events already saved: a failed publish and a later success do not add a second removal.
{
 const xmltv=t=>new Date(t).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
 const start=Date.now()+10*3600000;
 const xml=`<tv><channel id="c1"><display-name>Кино</display-name></channel><programme channel="c1" start="${xmltv(start)}" stop="${xmltv(start+170*60000)}"><title>Heat (1995)</title><desc>Описание</desc></programme></tv>`;
 context.fetch=async url=>{
  const href=String(url);
  if(href==='https://epg.test/guide.xml')return new Response(xml);
  if(href.startsWith('https://query.wikidata.org/'))return Response.json({results:{bindings:[]}});
  return new Response('',{status:404});
 };
 const store=memoryBucket({stream:false});
 const previousLedger=merge([],[raw(1)],OLD);
 arm(store,previousLedger);
 store.seed('watchlist.json',{updatedAt:'2026-11-01T00:00:00.000Z',films:[{id:'film1',title:'Heat',original:'Heat',year:1995,url:'https://letterboxd.com/film/heat-1995/',tmdbId:'165',runtime:170},{id:'film2',title:'Gone',original:'Gone',year:1990,url:'https://letterboxd.com/film/gone/',tmdbId:'2',runtime:100}]});
 store.seed('titles.json',{});store.seed('people.json',{});
 const film={id:'film1',title:'Heat',original:'Heat',year:1995,url:'https://letterboxd.com/film/heat-1995/',tmdbId:'165',runtime:170,aliases:['Heat']};
 const run={runId:RUN,stage:'epg',startedAt:'2026-11-03T15:59:24.928Z',pages:1,pending:[],watchlist:[film]};
 const env={BUCKET:store,DISCOVERY_LEDGER_MODE:'frozen',LETTERBOXD_USERNAME:'fixture',EPG_XML_URL:'https://epg.test/guide.xml'};
 store.seed('programme.json',{runId:OLD,updatedAt:'2026-11-02T00:00:00.000Z',films:[],stats:{epgEnd:start}});
 const fail=memoryBucket({stream:false});
 for(const [key,text] of store.objects)fail.seed(key,text);
 const realPut=fail.put.bind(fail);
 fail.put=async(key,value,options)=>{if(String(key).includes('/discovery-latest.json'))throw new Error('publish stopped');return realPut(key,value,options);};
 await assert.rejects(call('epgSync')({...env,BUCKET:fail},run),/publish stopped/);
 assert.equal(run.events.length,2);
 assert.equal(run.events[0].removed.length,1);
 const refs=JSON.parse(JSON.stringify(run.removalRefs));
 fail.put=realPut;
 await call('epgSync')({...env,BUCKET:fail},run);
 assert.equal(run.events.length,2);
 assert.equal(JSON.stringify(run.removalRefs),JSON.stringify(refs));
 assert.equal(run.stage,'complete');
}

{
 vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),context);
 const store=memoryBucket({chunk:4});
 const payload=arm(store,previous);
 const db=openDb();
 await publish(store,latest,db);
 const row=db.sql("SELECT phase FROM published_epg_generation WHERE programme_run_id='"+RUN+"'")[0];
 assert.equal(row.phase,'published');
 assert.equal(Number(db.sql("SELECT COUNT(*) AS n FROM published_epg_member WHERE programme_run_id='"+RUN+"'")[0].n),2);
 assert.equal(Number(db.sql("SELECT COUNT(*) AS n FROM published_epg_show WHERE programme_run_id='"+RUN+"'")[0].n),1);
 const authority=db.sql('SELECT programme_run_id AS run, generation FROM published_epg_authority WHERE id=1')[0];
 assert.equal(authority.run,RUN);
 assert.equal(Number(authority.generation),2);
 assert.equal(payload.key,keyOf(raw(9)));

 const blockedStore=memoryBucket({chunk:4});
 arm(blockedStore,previous);
 const blocked=openDb(statements=>{if(statements.some(item=>/UPDATE published_epg_authority/.test(item.text)))throw new Error('pin refused');});
 await assert.rejects(publish(blockedStore,latest,blocked),/published_epg_unavailable|pin refused/);
 const pin=blocked.sql('SELECT programme_run_id AS run, generation FROM published_epg_authority WHERE id=1')[0];
 assert.equal(pin.run,OLD);
 assert.equal(Number(pin.generation),1);
 assert.equal(blocked.sql("SELECT COUNT(*) AS n FROM published_epg_generation WHERE programme_run_id='"+RUN+"'")[0].n,0);

 const absent=memoryBucket({chunk:4});
 arm(absent,previous);
 const absentPointer=absent.objects.get('epg/discovery-archive/v1/current.json');
 absent.objects.delete('epg/generations/'+OLD+'/discovery-latest.json');
 absent.objects.delete('epg/discovery-latest.json');
 const absentDb=openDb();
 await assert.rejects(publish(absent,latest,absentDb),/Discovery ledger is missing for the published generation/);
 const absentPin=absentDb.sql('SELECT programme_run_id AS run, generation FROM published_epg_authority WHERE id=1')[0];
 assert.equal(absentPin.run,OLD);
 assert.equal(Number(absentPin.generation),1);
 assert.equal(absent.objects.has('epg/generations/'+RUN+'/discovery-latest.json'),false);
 assert.equal(absent.objects.get('epg/discovery-archive/v1/current.json'),absentPointer);
 assert.equal(JSON.parse(absent.objects.get('epg/published-generation.json')).programmeRunId,OLD);
 assert.equal(absentDb.sql("SELECT COUNT(*) AS n FROM published_epg_generation WHERE programme_run_id='"+RUN+"'")[0].n,0);

 const stale=memoryBucket({chunk:1});
 arm(stale,previous);
 const stalePointer=stale.objects.get('epg/discovery-archive/v1/current.json');
 stale.objects.delete('epg/generations/'+OLD+'/discovery-latest.json');
 const staleBody=JSON.parse(stale.objects.get('epg/discovery-latest.json'));
 staleBody.programmeRunId='stale-run';
 stale.objects.set('epg/discovery-latest.json',JSON.stringify(staleBody));
 const staleDb=openDb();
 await assert.rejects(publish(stale,latest,staleDb),/Discovery ledger does not match the published generation/);
 const stalePin=staleDb.sql('SELECT programme_run_id AS run, generation FROM published_epg_authority WHERE id=1')[0];
 assert.equal(stalePin.run,OLD);
 assert.equal(Number(stalePin.generation),1);
 assert.equal(stale.objects.has('epg/generations/'+RUN+'/discovery-latest.json'),false);
 assert.equal(stale.objects.get('epg/discovery-archive/v1/current.json'),stalePointer);
 assert.equal(JSON.parse(stale.objects.get('epg/published-generation.json')).programmeRunId,OLD);
 assert.equal(staleDb.sql("SELECT COUNT(*) AS n FROM published_epg_generation WHERE programme_run_id='"+RUN+"'")[0].n,0);
}

console.log('epg commit memory: streamed ledger matches the in-memory merge, a bad ledger and a missing or stale published ledger leave the pin, and a retry keeps the saved events');
