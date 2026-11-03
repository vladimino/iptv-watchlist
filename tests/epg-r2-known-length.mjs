// workerd's R2 put refuses a plain ReadableStream. The generation upload has to be the readable
// side of FixedLengthStream, with a length counted while the ledger is folded. This file runs that
// contract on Miniflare's R2 and a synthetic D1 publication. It does not call production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Miniflare} from 'miniflare';
import {scoped} from '../scripts/bundle-scope.mjs';

const OLD='71820185-3cc1-4303-b674-14293dca938b';
const RUN='00ff34fa-e518-4ac7-ae63-b2e46f803503';
const ACTIVE=34102;
const LATEST=19868;
const ARCHIVED=23820;
const WATCH=395;
const CATALOG=2631;

function workerSource(){
 const files=['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/continuation.js','src/worker.js'];
 let source='const ASSETS={};\n'+scoped('src/published-epg.js','PublishedEpg')+'\n';
 for(const file of files)source+=fs.readFileSync(file,'utf8').replace('export const DiscoveryContinuation','const DiscoveryContinuation').replace('export default','const productionWorker =')+'\n';
 source+=String.raw`
const OLD='71820185-3cc1-4303-b674-14293dca938b';
const RUN='00ff34fa-e518-4ac7-ae63-b2e46f803503';
const ACTIVE=34102,LATEST=19868,ARCHIVED=23820,WATCH=395,CATALOG=2631,BASE=Date.UTC(2026,10,1,12);
function storedRow(i,pad){
 const dup=i===ACTIVE-1,n=dup?0:i,title='Брат '+n;
 const item={title:title+' (1997)',year:1997,rawTitles:[title],description:(dup?'ДУБЛЬ ':'')+'О'.repeat(pad),firstAiring:BASE+i,lastAiring:BASE+i+10,airings:3,duration:90,shows:[
  {channelId:'ch'+(i%5),channel:'Канал '+(i%5),start:BASE+i*1000,end:BASE+i*1000+5400000,epgTitle:title},
  {channelId:'chx',channel:'Канал доп',start:BASE+i*1000+60000,end:BASE+i*1000+5460000,epgTitle:title},
  {channelId:'chy',channel:'Канал ночь',start:BASE+i*1000+120000,end:BASE+i*1000+5520000,epgTitle:title}
 ]};
 item.key=discoveryCandidateKey(item);
 return item;
}
function reentryRow(){
 const item={title:'Кандидат вне эфира (1991)',year:1991,rawTitles:['Кандидат вне эфира'],description:'архивная строка',firstAiring:BASE-86400000,lastAiring:BASE-86400000+10,airings:1,duration:80,shows:[{channelId:'arc',channel:'Архив',start:BASE-86400000,end:BASE-86400000+5400000,epgTitle:'Кандидат вне эфира'}]};
 item.key=discoveryCandidateKey(item);
 return item;
}
async function seedLedger(env,pad,archive){
 const enc=new TextEncoder();
 const prefix='{"programmeRunId":"'+OLD+'","updatedAt":"2026-11-02T16:13:02.965Z","rawCandidates":'+ACTIVE+',"filteredNonMovies":0,"ledgerMode":"frozen","archive":'+JSON.stringify(archive)+',"items":[';
 const suffix=']}';
 const piece=(i,comma)=>enc.encode((comma?',':'')+JSON.stringify(storedRow(i,pad)));
 let length=enc.encode(prefix).byteLength+enc.encode(suffix).byteLength;
 for(let i=0;i<ACTIVE;i++)length+=piece(i,i>0).byteLength;
 let index=-1;
 const source=new ReadableStream({pull(controller){
  if(index<0){controller.enqueue(enc.encode(prefix));index=0;return;}
  if(index<ACTIVE){controller.enqueue(piece(index,index>0));index++;return;}
  controller.enqueue(enc.encode(suffix));controller.close();
 }},{highWaterMark:1});
 await putKnownLength(env.BUCKET,epgGenerationKey(OLD,'discovery-latest.json'),length,source,{httpMetadata:{contentType:'application/json'}});
 return length;
}
async function publishSynthetic(env){
 const reentry=reentryRow();
 const segment=ledgerArchiveSegment(reentry.key),segmentKey=ledgerArchiveSegmentKey(segment,'write-1'),manifestId='manifest-known-length';
 const archive={version:'v1',manifestId,segments:64,items:ARCHIVED,bytes:10,alsoArchived:[],uniqueArchivedItems:ARCHIVED};
 const manifest={schemaVersion:1,manifestId,parentManifestId:null,segmentCount:64,hash:'fnv1a32-utf8',segments:Array.from({length:64},(_,index)=>({segment:index,object:index===segment?segmentKey:null,sha256:null,items:index===segment?1:0,bytes:0})),totals:{items:ARCHIVED,bytes:10},upsertedKeys:[reentry.key],writer:{runId:OLD,kind:'split'}};
 await env.BUCKET.put(segmentKey,JSON.stringify({schemaVersion:1,segment,writeId:'write-1',items:{[reentry.key]:{payload:reentry,envelope:{archivedAt:'2026-10-28T00:00:00.000Z',archivedFromProgrammeRunId:OLD,archiveWriteId:'write-1'}}}}),{httpMetadata:{contentType:'application/json'}});
 await env.BUCKET.put(ledgerArchiveManifestKey(manifestId),JSON.stringify(manifest),{httpMetadata:{contentType:'application/json'}});
 await env.BUCKET.put('epg/discovery-archive/v1/current.json',JSON.stringify({manifestId}),{httpMetadata:{contentType:'application/json'}});
 const sample=new TextEncoder().encode(JSON.stringify(storedRow(0,1))).byteLength;
 const wider=new TextEncoder().encode(JSON.stringify(storedRow(0,2))).byteLength;
 const pad=Math.max(8,Math.round(((43116001/ACTIVE)-sample)/Math.max(1,wider-sample))+1);
 const seededAt=Date.now();
 const seedBytes=await seedLedger(env,pad,archive);
 const seedMs=Date.now()-seededAt;
 await env.BUCKET.put('sync.json',JSON.stringify({runId:RUN,stage:'epg'}),{httpMetadata:{contentType:'application/json'}});
 const latest=[];
 for(let i=0;i<LATEST-1;i++){
  const title='Брат '+i,item={title:title+' (1997)',year:1997,rawTitles:[title+' х/ф'],description:'свежий '+i,firstAiring:BASE+86400000+i,lastAiring:BASE+86400000+i+10,airings:1,duration:91,shows:[{channelId:'ch'+(i%5),channel:'Канал '+(i%5),start:BASE+86400000+i*1000,end:BASE+86400000+i*1000+5400000,epgTitle:title}]};
  item.key=discoveryCandidateKey(item);latest.push(item);
 }
 latest.push(reentry);
 const watchlist={updatedAt:'2026-11-03T16:00:00.000Z',films:Array.from({length:WATCH},(_,i)=>({id:'f'+i,title:'Схватка '+i}))};
 const catalog={};
 for(let i=0;i<CATALOG;i++)catalog['tmdb:'+(1000+i)]={id:'c'+i,title:'Солярис '+i,tmdbId:1000+i};
 const programme={runId:RUN,updatedAt:'2026-11-03T16:00:00.000Z',watchlistCount:WATCH,films:[{id:'f0',title:'Схватка 0',year:1995,shows:[{channelId:'c1',channel:'Кино',start:BASE,end:BASE+60000,epgTitle:'Схватка'}]}],people:{directors:[],actors:[]},stats:{}};
 const started=Date.now();
 const published=await publishGenerationWithLedger(env,RUN,latest,{programmeRunId:RUN,updatedAt:programme.updatedAt,rawCandidates:latest.length,filteredNonMovies:0},{'programme.json':programme,'discovered-films.json':catalog},watchlist);
 const publishMs=Date.now()-started;
 const key=epgGenerationKey(RUN,'discovery-latest.json');
 const stored=await env.BUCKET.get(key);
 const shared=await env.BUCKET.get('epg/discovery-latest.json');
 const programmeCopy=await env.BUCKET.get('programme.json');
 const catalogCopy=await env.BUCKET.get('epg/discovered-films.json');
 let count=0,sawBrother=false,sawReentry=false;
 await forEachJsonArrayItems(ledgerChunks(stored),'items',item=>{count++;if(String(item?.title||'').includes('Брат 0'))sawBrother=true;if(String(item?.title||'').includes('Кандидат вне эфира'))sawReentry=true;});
 const live=await PublishedEpg.currentGeneration(env);
 return {seedBytes,seedMs,pad,publishMs,storedSize:stored?.size??null,sharedSize:shared?.size??null,programmeSize:programmeCopy?.size??null,catalogSize:catalogCopy?.size??null,count,sawBrother,sawReentry,authoritative:!!published?.authoritative,mirrored:!!published?.mirrored,programmeRunId:live?.programmeRunId||null,generation:live?.generation??null,latest:latest.length,watch:watchlist.films.length,catalog:Object.keys(catalog).length};
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 try{
  if(url.pathname==='/plain'){
   const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"a":1}'));controller.close();}});
   try{await env.BUCKET.put('plain.json',stream);return Response.json({ok:true});}
   catch(error){return Response.json({ok:false,name:error.name,message:String(error.message)});}
  }
  if(url.pathname==='/fixed'){
   const bytes=new TextEncoder().encode('{"название":"Брат"}');
   const pair=new FixedLengthStream(bytes.byteLength);
   const writing=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}).pipeTo(pair.writable);
   await env.BUCKET.put('fixed.json',pair.readable);
   await writing;
   const stored=await env.BUCKET.get('fixed.json');
   return Response.json({size:stored.size,text:await stored.text(),expected:bytes.byteLength});
  }
  if(url.pathname==='/mismatch'){
   const bytes=new TextEncoder().encode('abc');
   const source=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}});
   try{await putKnownLength(env.BUCKET,'mismatch.json',bytes.byteLength+4,source,{httpMetadata:{contentType:'application/json'}});return Response.json({ok:true,stored:!!await env.BUCKET.head('mismatch.json')});}
   catch(error){return Response.json({ok:false,name:error.name,message:String(error.message),stored:!!await env.BUCKET.head('mismatch.json')});}
  }
  if(url.pathname==='/publish')return Response.json(await publishSynthetic(env));
  return new Response('no',{status:404});
 }catch(error){return Response.json({ok:false,name:error.name,message:String(error.message)},{status:500});}
}};
`;
 return source;
}

function sampleHost(){
 const mem=process.memoryUsage();
 let workerd=null;
 for(const name of fs.readdirSync('/proc')){
  if(!/^\d+$/.test(name))continue;
  let comm='';
  try{comm=fs.readFileSync('/proc/'+name+'/comm','utf8').trim();}catch{continue;}
  if(comm!=='workerd')continue;
  const status=fs.readFileSync('/proc/'+name+'/status','utf8');
  workerd={pid:Number(name),rssKiB:Number(status.match(/VmRSS:\s+(\d+)/)?.[1]||0),hwmKiB:Number(status.match(/VmHWM:\s+(\d+)/)?.[1]||0)};
 }
 return {heapUsed:mem.heapUsed,external:mem.external,arrayBuffers:mem.arrayBuffers,rss:mem.rss,workerd};
}

function sqlStatements(sql){
 const parts=[];let buf='';
 for(const piece of sql.replace(/--[^\n]*/g,'').split(';')){
  buf+=piece+';';
  const flat=buf.replace(/\s+/g,' ').trim();
  const begins=(flat.match(/\bBEGIN\b/g)||[]).length,ends=(flat.match(/\bEND\b/g)||[]).length;
  if(begins===ends&&flat.replace(/;/g,'').trim()){parts.push(flat.replace(/;\s*$/,'').trim());buf='';}
 }
 if(buf.trim())parts.push(buf.replace(/\s+/g,' ').trim().replace(/;\s*$/,''));
 return parts.filter(Boolean);
}
const migrations=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority'];
const mf=new Miniflare({
 logRequests:false,
 workers:[{
  config:{
   name:'iptv-known-length',
   compatibilityDate:'2026-10-18',
   manifest:{mainModule:'worker.js',modulesRoot:'/',modules:{'worker.js':{type:'esm',contents:workerSource()}}},
   env:{
    BUCKET:{type:'r2',name:'epg-known-length'},
    DB:{type:'d1',name:'epg-known-length'},
    DISCOVERY_LEDGER_MODE:{type:'text',value:'frozen'},
    LETTERBOXD_USERNAME:{type:'text',value:'fixture'},
    EPG_XML_URL:{type:'text',value:'https://epg.invalid/guide.xml'}
   }
  }
 }]
});
try{
 const db=await mf.getD1Database('DB');
 for(const name of migrations)for(const statement of sqlStatements(fs.readFileSync('migrations/'+name+'.sql','utf8')))await db.exec(statement);
 await db.exec("UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+OLD+"', generation=1, mirror_programme_run_id='"+OLD+"' WHERE id=1");
 const before=sampleHost();
 const plain=await (await mf.dispatchFetch('http://worker.test/plain')).json();
 assert.equal(plain.ok,false);
 assert.equal(plain.name,'TypeError');
 assert.match(plain.message,/known length/i);
 const fixed=await (await mf.dispatchFetch('http://worker.test/fixed')).json();
 assert.equal(fixed.size,fixed.expected);
 assert.equal(fixed.text,'{"название":"Брат"}');
 const mismatch=await (await mf.dispatchFetch('http://worker.test/mismatch')).json();
 assert.equal(mismatch.ok,false);
 assert.equal(mismatch.stored,false);
 const started=Date.now();
 const response=await mf.dispatchFetch('http://worker.test/publish');
 const body=await response.json();
 const after=sampleHost();
 assert.equal(response.status,200,JSON.stringify(body));
 assert.ok(body.seedBytes>=40_000_000&&body.seedBytes<=48_000_000,'seed '+body.seedBytes);
 assert.equal(body.latest,LATEST);
 assert.equal(body.watch,WATCH);
 assert.equal(body.catalog,CATALOG);
 assert.equal(body.count,ACTIVE);
 assert.equal(body.sawBrother,true);
 assert.equal(body.sawReentry,true);
 assert.equal(body.storedSize,body.sharedSize);
 assert.ok(body.storedSize>1_000_000,'stored '+body.storedSize);
 assert.ok(body.programmeSize>0&&body.catalogSize>0);
 assert.equal(body.authoritative,true);
 assert.equal(body.programmeRunId,RUN);
 assert.equal(body.generation,2);
 const measured={
  runtime:'miniflare workerd',
  compatibilityDate:'2026-10-18',
  isolateCap:'not configured',
  seedBytes:body.seedBytes,
  storedSize:body.storedSize,
  sharedSize:body.sharedSize,
  programmeSize:body.programmeSize,
  catalogSize:body.catalogSize,
  count:body.count,
  pad:body.pad,
  seedMs:body.seedMs,
  publishMs:body.publishMs,
  wallMs:Date.now()-started,
  mirrored:body.mirrored,
  hostBefore:before,
  hostAfter:after
 };
 console.log('epg r2 known length '+JSON.stringify(measured));
}finally{
 await mf.dispose();
}
