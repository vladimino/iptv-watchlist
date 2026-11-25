// AIR-602 (card A1) / ADR 0207 decision 4b and 7 (Accepted): the Diary and Watchlist check (`LetterboxdDiaryIdentity.resolve`, the one function both callers go through) over the GENERATED Worker bundle's canonical
// scope chain (the real writers, receipts, operation-key protocol, evidence ledger and the d1 coordinator), the REAL Ratings D1 store and a sqlite D1 stand-in with the real migrations. No network, no production.
// Covered: at `r2` the delivered legacy path is unchanged (R2 receipt, no evidence row, no keyed receipt); at `d1` a verified id is admitted by the coordinator with NO R2 write (one key `admission:lid:<lid>`, keep-first,
// the evidence row of that page check with the CALLER's route in the same batch), the link proceeds, the second caller finds it settled and writes nothing; the typed conflicts become definite pending reasons without
// an admission, a link or an evidence row; a lost check reservation refuses the effect at commit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import * as RatingsD1 from '../src/ratings-d1.js';
import * as WatchlistD1 from '../src/watchlist-d1.js';
import {admissionStep} from '../src/letterboxd-sync-admission.js';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';

execFileSync(process.execPath,['build.mjs'],{stdio:'ignore'});
const bundle=fs.readFileSync('dist/server/index.js','utf8');
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-admission-callers-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"
 +"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');"
 +"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3;";
const STAMP='2026-11-25T10:00:00.000Z';
const NOW=Date.parse('2026-11-25T12:00:00.000Z');
let copies=0;
const fresh=mode=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);sqlite(file,OPEN);
 if(mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1;UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 return file;
};

// ---- the bundle's scope chain (the real canonical writers) plus the Letterboxd modules, in one vm ----
const start=bundle.indexOf('const OrchestrationPolicy=(()=>{');
const begin=bundle.indexOf('const LetterboxdAdmissionD1=(()=>{');
assert.ok(start>0&&begin>start,'the bundle holds the scoped chain up to the d1 coordinator');
const end=bundle.indexOf('\n})();',begin)+'\n})();'.length;
const r2=new Map(),etags=new Map();let rev=0;const puts=[];
const bucket={
 async get(key){return r2.has(key)?{etag:etags.get(key),json:async()=>structuredClone(r2.get(key))}:null;},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&r2.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;r2.set(key,JSON.parse(value));etags.set(key,String(++rev));puts.push(key);return {etag:etags.get(key)};},
};
const headersOf=map=>({get:key=>map[String(key).toLowerCase()]??null});
const http=(status,body,headers={})=>({status,ok:status<300,headers:headersOf(headers),async text(){return body;}});
const site=new Map(),movies=new Map(),calls=[];
const fetchImpl=async url=>{
 url=String(url);calls.push(url);
 const boxd=/^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/.exec(url);
 if(boxd){const item=site.get(boxd[1]);if(item&&item.status)return http(item.status,'');return item?http(301,'',{location:'https://letterboxd.com/film/'+item.slug+'/'}):http(404,'');}
 const film=/^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/.exec(url);
 if(film){const item=[...site.values()].find(entry=>entry.slug===film[1]);return item?http(200,item.html):http(404,'');}
 const tm=/api\.themoviedb\.org\/3\/movie\/(\d+)/.exec(url);if(tm&&movies.has(tm[1]))return http(200,movies.get(tm[1]));
 return http(404,'');
};
const add=(lid,slug,tmdb,title,year)=>{
 site.set(lid,{slug,html:'<html><head><link rel="canonical" href="https://letterboxd.com/film/'+slug+'/"><link rel="shortlink" href="https://boxd.it/'+lid+'"><meta property="og:title" content="'+title+' ('+year+')"><script type="application/ld+json">'+JSON.stringify({name:title,releasedEvent:[{'@type':'PublicationEvent',startDate:String(year)}]})+'</script></head><body class="film" data-tmdb-type="movie" data-tmdb-id="'+tmdb+'"></body></html>'});
 movies.set(tmdb,JSON.stringify({id:Number(tmdb),title,original_title:title,release_date:year+'-05-01'}));
};
const ctx=vm.createContext({URL,Response,Request,Headers,Date,Map,Set,JSON,Object,Number,Promise,TextEncoder,TextDecoder,Uint8Array,AbortSignal,crypto:webcrypto,structuredClone,setTimeout,clearTimeout,console:{...console,log:()=>{}},RatingsD1,fetch:fetchImpl});
vm.runInContext(bundle.slice(start,end),ctx);
for(const file of ['src/domain/tmdb-tv-identity.js','src/sources.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace(/^export default/m,'globalThis.x='),ctx);
vm.runInContext(scoped('src/letterboxd-match.js','LetterboxdMatch')+'\n'+scopedReplacing('src/letterboxd-identity.js','LetterboxdIdentity','const normTitle=LetterboxdMatch.normTitle;\n')+'\n'+scoped('src/domain/letterboxd-rated-admission.js','LetterboxdRatedAdmission')+'\n'+scoped('src/domain/letterboxd-import-registry.js','LetterboxdImportRegistry'),ctx);
for(const file of ['src/letterboxd-facts.js','src/letterboxd-rated-candidates.js','src/letterboxd-diary-identity.js'])vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;",ctx);
const Facts=vm.runInContext('LetterboxdFacts',ctx),Identity=vm.runInContext('LetterboxdDiaryIdentity',ctx),D1=vm.runInContext('LetterboxdAdmissionD1',ctx),Candidates=vm.runInContext('LetterboxdRatedCandidates',ctx);
const ADMISSIONS='letterboxd/admissions/verified-films.json';
const world=file=>({DB:d1Standin(file),BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'fixture-token'});
const seed=(env,lid,rating=4)=>Facts.applyDiaryEvidence(env,[{lid,watchedDate:'2026-11-15',rating,ratingState:'rated',sourceRef:'diary:viewing:1'}]);
const opts=extra=>({clock:()=>NOW,remaining:()=>120000,fetchImpl,...extra});
const admissionRows=file=>rows(file,'SELECT film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,verified_at,request_id FROM film_rated_admission ORDER BY film_id');
const receipts=(file,prefix=null)=>rows(file,prefix?"SELECT request_id,state,operation_key FROM canonical_write_receipt WHERE operation_key LIKE '"+prefix+"%' ORDER BY created_at,request_id":"SELECT request_id,state,operation_key FROM canonical_write_receipt WHERE operation='film_admission' ORDER BY created_at,request_id");
const evidence=file=>rows(file,'SELECT subject_value,object_value,route,method,source_root,request_id,film_id FROM film_identity_evidence ORDER BY seq');
const reset=()=>{r2.clear();etags.clear();site.clear();movies.clear();calls.length=0;puts.length=0;};

// ===== A. at r2 the delivered legacy path is unchanged: the R2 receipt entry, the legacy receipt, no evidence row, no operation key =====
{
 reset();
 const file=fresh('r2'),env=world(file);
 await seed(env,'vMEO');add('vMEO','fixture-alpha-2023','900001','Fixture Alpha',2023);
 const out=await Identity.resolve(env,[{lid:'vMEO',slug:'fixture-alpha-2023'}],opts({route:'ratings_diary'}));
 assert.equal(out.outcomes.get('vMEO').class,'settled',JSON.stringify([...out.outcomes]));
 assert.ok(r2.get(ADMISSIONS)?.films?.tmdb_900001,'the R2 receipt entry is written');
 const [row]=admissionRows(file);
 assert.deepEqual([row.film_id,row.source_code,row.receipt_key],['film:tmdb:900001','vMEO',ADMISSIONS],'the legacy row names the R2 object as its receipt');
 assert.equal(evidence(file).length,0,'the legacy path writes no evidence row');
 assert.ok(receipts(file).every(item=>item.operation_key===null),'and no keyed receipt');
 assert.equal(receipts(file).length,1);
}

// ===== B. at d1: the coordinator admits with NO R2 write; the evidence row carries the caller's route; the link proceeds =====
const file=fresh('d1'),env=world(file);
{
 reset();
 await seed(env,'vMEO');add('vMEO','fixture-alpha-2023','900001','Fixture Alpha',2023);
 const out=await Identity.resolve(env,[{lid:'vMEO',slug:'fixture-alpha-2023'}],opts({route:'ratings_diary'}));
 const outcome=out.outcomes.get('vMEO');
 assert.deepEqual([outcome.class,outcome.reason,outcome.checked],['settled','verified',true],JSON.stringify([...out.outcomes]));
 assert.equal(JSON.stringify(out.labels.get('vMEO')),JSON.stringify({title:'Fixture Alpha',year:2023,tmdb:'900001'}),'the label of the verified id');
 assert.equal(r2.has(ADMISSIONS),false,'no R2 admissions object at d1');assert.equal(puts.includes(ADMISSIONS),false);
 const [row]=admissionRows(file);
 assert.deepEqual([row.film_id,row.tmdb,row.source_code,row.title,row.year,row.receipt_key],['film:tmdb:900001','900001','vMEO','Fixture Alpha',2023,'d1']);
 assert.deepEqual(receipts(file).map(item=>[item.state,item.operation_key]),[['applied','admission:lid:vMEO']],'one keyed receipt under the single key');
 assert.equal(receipts(file)[0].request_id,row.request_id);
 const ev=evidence(file);
 assert.equal(ev.length,1);
 assert.deepEqual([ev[0].subject_value,ev[0].object_value,ev[0].route,ev[0].method,ev[0].film_id,ev[0].request_id],['vMEO','900001','ratings_diary','page_check','film:tmdb:900001',row.request_id],'the evidence row of THIS page check, in the admission batch');
 const linked=(await Facts.diaryLinks(env,['vMEO'])).get('vMEO');
 assert.equal(linked.tmdb,'900001','the Ratings link proceeded');
 // the pending entry was handed off, not left as a link intent
 const stored=await Facts.readDiaryIdentity(env);
 assert.ok(!stored.films.vMEO||stored.films.vMEO.reason!=='linking','no link intent is left behind');

 // ---- the SECOND caller (the Watchlist admission step) finds it settled: it writes nothing and fetches nothing ----
 calls.length=0;
 const before=JSON.stringify([admissionRows(file),receipts(file),evidence(file)]);
 const again=await Identity.resolve(env,[{lid:'vMEO',slug:'fixture-alpha-2023'}],opts({route:'watchlist_admission'}));
 assert.equal(again.outcomes.get('vMEO').class,'settled');
 assert.equal(JSON.stringify([admissionRows(file),receipts(file),evidence(file)]),before,'no second admission, receipt or evidence row');
 assert.deepEqual(calls,[],'no source request');
}

// ===== C. the Watchlist caller on its own id: the evidence row carries the WATCHLIST route; one key per lid =====
{
 reset();
 await seed(env,'Wl1');add('Wl1','fixture-beta-2021','900002','Fixture Beta',2021);
 const out=await Identity.resolve(env,[{lid:'Wl1',slug:'fixture-beta-2021'}],opts({route:'watchlist_admission'}));
 assert.equal(out.outcomes.get('Wl1').class,'settled',JSON.stringify([...out.outcomes]));
 const ev=evidence(file).find(item=>item.subject_value==='Wl1');
 assert.deepEqual([ev.route,ev.method,ev.object_value],['watchlist_admission','page_check','900002']);
 assert.deepEqual(receipts(file).filter(item=>item.operation_key==='admission:lid:Wl1').map(item=>item.state),['applied']);
 assert.equal(puts.includes(ADMISSIONS),false,'no R2 admissions object at d1');
}

// ===== D. typed conflicts: a definite pending reason, no admission, no link, no evidence row =====
{
 reset();
 // another short code for a movie that is admitted already (vMEO holds 900001)
 await seed(env,'oth1');add('oth1','fixture-alpha-2023','900001','Fixture Alpha',2023);
 const before=JSON.stringify([admissionRows(file),receipts(file),evidence(file)]);
 const out=await Identity.resolve(env,[{lid:'oth1',slug:'fixture-alpha-2023'}],opts({route:'ratings_diary'}));
 const outcome=out.outcomes.get('oth1');
 assert.deepEqual([outcome.class,outcome.reason,outcome.attempts],['definite','other_code',1],JSON.stringify([...out.outcomes]));
 assert.equal((await Facts.diaryLinks(env,['oth1'])).get('oth1').tmdb,null,'no link');
 assert.equal(JSON.stringify([admissionRows(file),receipts(file),evidence(file)]),before,'no admission, receipt or evidence row');
 // a code held by another Film: `Wl1` is admitted for 900002; a page now names another movie for the same code
 await seed(env,'cod1');add('cod1','fixture-gamma-2020','900003','Fixture Gamma',2020);
 const first=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'cod1',receipt:{tmdb:'900004',archiveSha256:'a'.repeat(64),title:'Fixture Delta',year:2019},now:()=>new Date(NOW).toISOString()});
 assert.equal(first.outcome,'admitted');
 const held=JSON.stringify([admissionRows(file),evidence(file)]);
 const out2=await Identity.resolve(env,[{lid:'cod1',slug:'fixture-gamma-2020'}],opts({route:'ratings_diary'}));
 assert.deepEqual([out2.outcomes.get('cod1').class,out2.outcomes.get('cod1').reason],['definite','admission_conflict'],JSON.stringify([...out2.outcomes]));
 assert.equal((await Facts.diaryLinks(env,['cod1'])).get('cod1').tmdb,null,'no link');
 assert.equal(JSON.stringify([admissionRows(file),evidence(file)]),held,'the conflict wrote no admission and no evidence row');
}

// ===== E. the rated-archive step at d1: admitted by the coordinator with the ARCHIVE route and scope, the R2 admissions object untouched, enrichment retired; at r2 it is the delivered legacy step =====
{
 const SHA='d'.repeat(64),KEY='letterboxd/imports/'+SHA+'/rated-candidates.json';
 const candidateDoc=(code,name='Fixture Rated',year=2018)=>({schemaVersion:1,archiveSha256:SHA,generatedAt:'2026-11-20T10:00:00.000Z',candidates:{[code]:{code,state:'pending',reason:null,rating:4,observedAt:'2026-11-20T10:00:00.000Z',name,year,historicalTmdb:null,tmdb:null,chunk:0,registeredAt:'2026-11-20T10:00:00.000Z',enrichment:null}},checkpoint:{cursor:null,stopped:null}});
 const seedDoc=(code,name,year)=>{r2.set(KEY,candidateDoc(code,name,year));etags.set(KEY,String(++rev));};
 const rowOf=code=>r2.get(KEY).candidates[code];
 // d1
 reset();
 seedDoc('rt1');add('rt1','fixture-rated-2018','900010','Fixture Rated',2018);
 const out=await Candidates.identityStep(env,{sha:SHA,fetchImpl});
 assert.equal(out.verified,true,JSON.stringify(out));
 assert.equal(r2.has(ADMISSIONS),false,'no R2 admissions object at d1');assert.equal(puts.includes(ADMISSIONS),false);
 const row=admissionRows(file).find(item=>item.source_code==='rt1');
 assert.deepEqual([row.film_id,row.tmdb,row.archive_sha256,row.receipt_key],['film:tmdb:900010','900010',SHA,'d1'],'keep-first row: the archive digest is the first admitting archive');
 assert.deepEqual(receipts(file).filter(item=>item.operation_key==='admission:lid:rt1').map(item=>item.state),['applied'],'one keyed receipt under the single key (the rated step and the Diary share it)');
 const ev=evidence(file).find(item=>item.subject_value==='rt1');
 assert.deepEqual([ev.route,ev.method,ev.object_value],['letterboxd_rated_archive','page_check','900010'],'the evidence row names the archive route');
 assert.equal(rows(file,"SELECT source_scope FROM film_identity_evidence WHERE subject_value='rt1'")[0].source_scope,SHA,'and the archive scope: a second archive is its own evidence');
 assert.deepEqual([rowOf('rt1').state,rowOf('rt1').enrichment],['verified','done'],'verified with nothing left to enrich: W5 and W6 no longer write the R2 entry');
 // a verified row still waiting for enrichment (verified at r2) is settled without a page request and without an R2 write
 const doc=r2.get(KEY);doc.candidates.rt1.enrichment='pending';r2.set(KEY,doc);etags.set(KEY,String(++rev));calls.length=0;puts.length=0;
 const retired=await Candidates.identityStep(env,{sha:SHA,fetchImpl,code:'rt1'});
 assert.equal(retired.reason,'enrichment_retired',JSON.stringify(retired));assert.deepEqual(calls,[],'no request');assert.equal(rowOf('rt1').enrichment,'done');
 assert.equal(puts.includes(ADMISSIONS),false,'no R2 admissions write');
 // the same movie under another code: another code on the Film -> needs_review duplicate_tmdb, no admission, no evidence row
 const before=JSON.stringify([admissionRows(file),evidence(file)]);
 reset();seedDoc('rt2');add('rt2','fixture-rated-2018','900010','Fixture Rated',2018);
 const dup=await Candidates.identityStep(env,{sha:SHA,fetchImpl});
 assert.equal(dup.verified,false,JSON.stringify(dup));
 assert.equal(dup.reason,'tmdb_already_imported','the movie ids already admitted are read from D1 at d1, not from the frozen R2 object');
 assert.equal(JSON.stringify([admissionRows(file),evidence(file)]),before,'a conflict writes nothing');
 // a movie that has a D1 admission but NO facts link (admitted above through the coordinator for `cod1`) is still owned: the reader of the owned ids reads D1 at d1
 reset();seedDoc('rt4','Fixture Delta',2019);add('rt4','fixture-delta-2019','900004','Fixture Delta',2019);
 const owned=await Candidates.identityStep(env,{sha:SHA,fetchImpl});
 assert.deepEqual([owned.verified,owned.reason],[false,'tmdb_already_imported'],JSON.stringify(owned));
 // at r2: the delivered legacy step (R2 receipt entry, legacy row, no evidence, no keyed receipt)
 reset();
 const old=fresh('r2'),oldEnv=world(old);
 seedDoc('rt3','Fixture Rated Three',2019);add('rt3','fixture-rated-2019','900011','Fixture Rated Three',2019);
 const legacy=await Candidates.identityStep(oldEnv,{sha:SHA,fetchImpl});
 assert.equal(legacy.verified,true,JSON.stringify(legacy));
 assert.ok(r2.get(ADMISSIONS)?.films?.tmdb_900011,'r2: the legacy R2 entry');
 assert.equal(admissionRows(old).find(item=>item.source_code==='rt3').receipt_key,ADMISSIONS);
 assert.equal(evidence(old).length,0);assert.ok(receipts(old).every(item=>item.operation_key===null));
 assert.equal(rowOf('rt3').enrichment,'pending','r2: enrichment is still pending (legacy)');
}

// ===== E2. review of PR #1018 (P1): an `admitting` row is recovered from DURABLE STATE and a REAL reacquisition, never from its stored intent =====
{
 const SHA='e'.repeat(64),KEY='letterboxd/imports/'+SHA+'/rated-candidates.json';
 const row=(code,tmdb,path,name,year,extra={})=>({code,state:'admitting',reason:null,rating:4,observedAt:'2026-11-20T10:00:00.000Z',name,year,historicalTmdb:null,tmdb:null,chunk:0,registeredAt:'2026-11-20T10:00:00.000Z',enrichment:'pending',intendedTmdb:tmdb,filmPath:path,...extra});
 const seedRow=r=>{r2.set(KEY,{schemaVersion:1,archiveSha256:SHA,generatedAt:'2026-11-20T10:00:00.000Z',candidates:{[r.code]:r},checkpoint:{cursor:null,stopped:null}});etags.set(KEY,String(++rev));};
 const rowOf=code=>r2.get(KEY).candidates[code];
 const boxdCalls=()=>calls.filter(url=>url.includes('boxd.it')||url.includes('api.themoviedb.org')).length;
 const hasPending=(code,id,future)=>sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('"+id+"','film_admission','rated_admission_retention','film','film:tmdb:900070','"+'7'.repeat(64)+"',0,2,'pending',1,'"+new Date(Date.now()+(future?3600000:-3600000)).toISOString()+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:"+code+"')");
 const step=(e=env,code=undefined)=>Candidates.identityStep(e,{sha:SHA,fetchImpl,...(code?{code}:{})});

 // (1) CHANGED source: the intent says 900070, the page now names 900071: needs_review source_changed. Nothing is admitted, no rating, no evidence
 reset();
 seedRow(row('rc1','900070','/film/fixture-rc-70/','Fixture RC',2012));add('rc1','fixture-rc-70','900071','Fixture RC',2012);
 const before=JSON.stringify([admissionRows(file),evidence(file)]);
 const changed=await step();
 assert.deepEqual([changed.verified,changed.state,changed.reason],[false,'needs_review','source_changed'],JSON.stringify(changed));
 assert.equal(JSON.stringify([admissionRows(file),evidence(file)]),before,'nothing is admitted from a changed source');

 // (2) UNAVAILABLE source (404): the row stays admitting and is retried; the cap makes it needs_review. Nothing is admitted from the intent
 reset();
 seedRow(row('rc2','900072','/film/fixture-rc-72/','Fixture RD',2011));
 for(let n=1;n<=5;n++){
  const out=await step();
  assert.deepEqual([out.state,out.reason],['admitting','source_unavailable'],'attempt '+n+' '+JSON.stringify(out));
  assert.equal(rowOf('rc2').sourceAttempts,n);
 }
 const capped=await step();
 assert.deepEqual([capped.state,capped.reason],['needs_review','source_unavailable'],JSON.stringify(capped));
 assert.equal(admissionRows(file).some(item=>item.source_code==='rc2'),false,'no admission from an intent whose source never answered');

 // (3) an APPLIED attempt that matches the intent (a lost response): the row finishes WITHOUT a fetch and without fresh evidence
 reset();
 const lost=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'rc3',receipt:{tmdb:'900073',archiveSha256:SHA,title:'Fixture RE',year:2010},evidence:{subject:{kind:'letterboxd_short_code',value:'rc3'},relation:'same_work',object:{kind:'tmdb_movie',value:'900073'},polarity:'asserts',route:'letterboxd_rated_archive',method:'page_check',sourceRoot:'b'.repeat(64),sourceRef:'archive-step:'+SHA.slice(0,12),sourceScope:SHA,observedAt:new Date(NOW).toISOString()},now:()=>new Date(NOW).toISOString()});
 assert.equal(lost.outcome,'admitted');
 seedRow(row('rc3','900073','/film/fixture-rc-73/','Fixture RE',2010));
 const evBefore=evidence(file).length;calls.length=0;
 const finished=await step();
 assert.equal(finished.verified,true,JSON.stringify(finished));
 assert.equal(boxdCalls(),0,'no fetch: the applied attempt proves the admission');
 assert.equal(evidence(file).length,evBefore,'no evidence is manufactured for a recovery that made no check');
 assert.equal(rowOf('rc3').state,'verified');

 // (3b) the pair is admitted but THIS archive never recorded its evidence (the invocation died before it): the row is not settled from the intent: both sources are really reacquired and the evidence is recorded
 reset();
 const p3b=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'rc3b',receipt:{tmdb:'900079',archiveSha256:'a'.repeat(64),title:'Fixture RJ',year:2005},now:()=>new Date(NOW).toISOString()});
 assert.equal(p3b.outcome,'admitted');
 seedRow(row('rc3b','900079','/film/fixture-rc-79/','Fixture RJ',2005,{evidenceDue:true}));add('rc3b','fixture-rc-79','900079','Fixture RJ',2005);
 calls.length=0;
 const due3b=await step();
 assert.equal(due3b.verified,true,JSON.stringify(due3b));
 assert.ok(boxdCalls()>0,'the obligation is not provably fulfilled: a real check is made');
 assert.deepEqual(rows(file,"SELECT route,source_scope FROM film_identity_evidence WHERE subject_value='rc3b'").map(item=>[item.route,item.source_scope]),[['letterboxd_rated_archive',SHA]],'and its evidence is recorded');

 // (4) a LIVE attempt of the key: the row waits, no fetch, nothing changes
 reset();
 seedRow(row('rc4','900074','/film/fixture-rc-74/','Fixture RF',2009));hasPending('rc4','live-r4',true);
 calls.length=0;
 const waiting=await step();
 assert.deepEqual([waiting.verified,waiting.state,waiting.reason],[false,'admitting','in_flight'],JSON.stringify(waiting));
 assert.equal(boxdCalls(),0);

 // (5) a GENUINE second check of an admitted pair (a later archive): one keyed evidence-only row with the archive scope
 reset();
 const p5=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'rc5',receipt:{tmdb:'900075',archiveSha256:'a'.repeat(64),title:'Fixture RG',year:2008},now:()=>new Date(NOW).toISOString()});
 assert.equal(p5.outcome,'admitted');
 seedRow({...row('rc5',null,null,'Fixture RG',2008),state:'pending',intendedTmdb:null,filmPath:null});add('rc5','fixture-rc-75','900075','Fixture RG',2008);
 const second=await step();
 assert.equal(second.verified,true,JSON.stringify(second));
 const ev5=rows(file,"SELECT route,source_scope FROM film_identity_evidence WHERE subject_value='rc5'");
 assert.deepEqual(ev5.map(item=>[item.route,item.source_scope]),[['letterboxd_rated_archive',SHA]],'the genuine second check is one row with this archive as its scope');

 // (6) an evidence write that FAILS keeps the row admitting with the evidence to record; the retry records it without a fetch and finishes
 reset();
 const p6=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'rc6',receipt:{tmdb:'900076',archiveSha256:'a'.repeat(64),title:'Fixture RH',year:2007},now:()=>new Date(NOW).toISOString()});
 assert.equal(p6.outcome,'admitted');
 seedRow({...row('rc6',null,null,'Fixture RH',2007),state:'pending',intendedTmdb:null,filmPath:null});add('rc6','fixture-rc-76','900076','Fixture RH',2007);
 const realDb=env.DB;let failing=true;
 const lossy={...env,DB:{prepare:sql=>realDb.prepare(sql),batch:async statements=>{if(failing&&statements.some(item=>/INSERT INTO film_identity_evidence/.test(item.text||'')))throw new Error('D1_ERROR: evidence batch lost');return realDb.batch(statements);}}};
 const lostEvidence=await step(lossy);
 assert.deepEqual([lostEvidence.verified,lostEvidence.state,lostEvidence.reason],[false,'admitting','evidence_unrecorded'],JSON.stringify(lostEvidence));
 assert.ok(rowOf('rc6').pendingEvidence,'the evidence to record is kept');
 failing=false;calls.length=0;
 const healed=await step();
 assert.equal(healed.verified,true,JSON.stringify(healed));
 assert.equal(boxdCalls(),0,'recorded from the kept evidence without a fetch');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_identity_evidence WHERE subject_value='rc6'")[0].n,1,'the evidence of the genuine check is not lost');

 // (7) the terminal review of a changed source is written only while the history is the one the reconcile observed: another attempt appears under the key first -> the row stays admitting
 reset();
 seedRow(row('rc7','900077','/film/fixture-rc-77/','Fixture RI',2006));add('rc7','fixture-rc-77','900078','Fixture RI',2006);
 let moved=0;
 const watching={...env,DB:d1Standin(file,{onQuery:async text=>{
  if(!moved&&/CASE WHEN/.test(text)&&/operation_key/.test(text)&&/admission:lid:rc7/.test(text)){moved++;hasPending('rc7','late-r7',false);}
 }})};
 const held=await step(watching);
 assert.equal(moved,1,'the history moved between the reconcile and the terminal write');
 assert.deepEqual([held.state,held.reason],['admitting','in_flight'],JSON.stringify(held));
 assert.equal(rowOf('rc7').state,'admitting','not terminal on a moved history');
}

// ===== F. the inferred baseline import at d1: no R2 entry; the pair is planned BEFORE the link, admitted AFTER it with a `restricts` evidence row; the receipt records the admission; a replay offers it again idempotently =====
{
 reset();
 const SHA='c'.repeat(64);
 const body=(items,chunk=0,sha=SHA)=>({origin:{archiveSha256:sha,generatedAt:'2026-11-20T10:00:00.000Z',generatedAtSource:'archive_name'},chunk,items});
 const post=async b=>{const response=await Facts.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),env,'/api/letterboxd/baseline/commit');return {status:response.status,json:await response.json()};};
 const item=(lid,tmdb,title='Baseline',year=1999)=>({lid,facts:{watched:true},tmdb,identity:'inferred',admit:{title,year}});
 const res=await post(body([item('Bz1','700001')]));
 assert.equal(res.status,200,JSON.stringify(res.json));
 assert.equal(res.json.entries[0].admission,'admitted',JSON.stringify(res.json.entries));
 assert.equal(r2.has(ADMISSIONS),false,'no R2 admissions object at d1');
 const row=admissionRows(file).find(item=>item.source_code==='Bz1');
 assert.deepEqual([row.film_id,row.tmdb,row.archive_sha256,row.receipt_key],['film:tmdb:700001','700001',SHA,'d1']);
 const ev=evidence(file).find(item=>item.subject_value==='Bz1');
 assert.deepEqual([ev.route,ev.method,ev.source_root],['letterboxd_export_import','title_year_search',SHA]);
 assert.equal(rows(file,"SELECT polarity FROM film_identity_evidence WHERE subject_value='Bz1'")[0].polarity,'restricts','an inferred pair is `restricts`, never proof');
 assert.deepEqual(receipts(file).filter(item=>item.operation_key==='admission:lid:Bz1').map(item=>item.state),['applied']);
 assert.ok((await Facts.diaryLinks(env,['Bz1'])).get('Bz1').tmdb==='700001','the inferred pair is linked');

 // replay: the same chunk again is a replay that writes nothing new
 const before=JSON.stringify([admissionRows(file),receipts(file),evidence(file)]);
 const replay=await post(body([item('Bz1','700001')]));
 assert.deepEqual([replay.status,replay.json.replay],[200,true]);
 assert.equal(JSON.stringify([admissionRows(file),receipts(file),evidence(file)]),before,'a replay offers the admission again idempotently');

 // a replay offers the admission again for an item its receipt recorded as admitted: if the admission row is gone (the receipt outlived it), the replay restores it through the coordinator
 sqlite(file,"DELETE FROM film_rated_admission WHERE source_code='Bz1'");
 assert.equal(admissionRows(file).filter(item=>item.source_code==='Bz1').length,0);
 const restored=await post(body([item('Bz1','700001')]));
 assert.deepEqual([restored.status,restored.json.replay],[200,true]);
 assert.equal(admissionRows(file).filter(item=>item.source_code==='Bz1').length,1,'the replay re-offered the admission');

 // another code on a movie that is admitted (and not linked in the facts: a linked movie is already an alias conflict): present_other_code, no admission, the link and the facts proceed
 const base=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'Zc1',receipt:{tmdb:'700006',archiveSha256:'a'.repeat(64),title:'Baseline Six',year:1999},now:()=>new Date(NOW).toISOString()});
 assert.equal(base.outcome,'admitted');
 const other=await post(body([item('Bz3','700006')],1));
 assert.equal(other.status,200,JSON.stringify(other.json));
 assert.equal(other.json.entries[0].admission,'present_other_code');
 assert.equal(admissionRows(file).filter(item=>item.tmdb==='700006').length,1,'no second admission for the movie');
 assert.equal(evidence(file).filter(item=>item.subject_value==='Bz3').length,0,'no admission, no evidence row');
 assert.equal((await Facts.diaryLinks(env,['Bz3'])).get('Bz3').tmdb,'700006','the link and the facts proceed');

 // a code held by another Film: a conflict BEFORE the link: no link, no fact
 const held=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'Bz2',receipt:{tmdb:'700009',archiveSha256:'a'.repeat(64),title:'Other',year:1980},now:()=>new Date(NOW).toISOString()});
 assert.equal(held.outcome,'admitted');
 const conflict=await post(body([item('Bz2','700002')],2));
 assert.equal(conflict.status,200,JSON.stringify(conflict.json));
 assert.deepEqual([conflict.json.conflicts,conflict.json.entries[0].conflict,conflict.json.entries[0].admission],[1,true,'conflict']);
 assert.equal((await Facts.diaryLinks(env,['Bz2'])).get('Bz2').tmdb,null,'no link');
 assert.equal(admissionRows(file).filter(item=>item.tmdb==='700002').length,0);

 // refused AFTER the link: a concurrent writer admits the code for another Film between the plan (before the link) and the admission (after it). Terminal: no fact, the link stays, an admission conflict entry
 {
  let injected=false,seen5=0;
  const racing={...env,DB:d1Standin(file,{onQuery:async text=>{
   if(!injected&&/operation_key=.admission:lid:Bz5./.test(text)&&++seen5>=2){
    injected=true;
    sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES ('film:tmdb:700099',1,'tmdb:700099','"+STAMP+"');INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:700099','700099','Bz5','"+'a'.repeat(64)+"','Rival',1970,'d1','tmdb_700099','"+STAMP+"','rival-5','"+STAMP+"')");
   }
  }})};
  const response=await Facts.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body([item('Bz5','700005')],5))}),racing,'/api/letterboxd/baseline/commit');
  const json=await response.json();
  assert.equal(injected,true,'the rival landed between the plan and the admission');
  assert.equal(response.status,200,JSON.stringify(json));
  assert.deepEqual([json.conflicts,json.entries[0].conflict,json.entries[0].admission],[1,true,'refused_after_link']);
  assert.ok(await Facts.resolveAlias(env,'letterboxd:Bz5'),'the inferred-marked alias link stays (it was made before the admission, and is never a claim proof)');
  assert.equal((await Facts.diaryLinks(env,['Bz5'])).get('Bz5').tmdb,null,'but no fact record was written for it');
  assert.equal(admissionRows(file).filter(item=>item.source_code==='Bz5').length,1,'only the rival admission exists');
  assert.equal(evidence(file).filter(item=>item.subject_value==='Bz5').length,0,'no evidence row for the refused item');
 }

 // a conflict verdict is fenced by the operation history: another attempt appears under the key before the chunk receipt is written -> the chunk stops (409), nothing is recorded; a LIVE attempt stops it before any verdict
 {
  const ADD=(lid,tmdb)=>D1.admitVerifiedFilm(env,{kind:'lid',lid,receipt:{tmdb,archiveSha256:'a'.repeat(64),title:'Held',year:1981},now:()=>new Date(NOW).toISOString()});
  assert.equal((await ADD('Bz6','700020')).outcome,'admitted');
  let movedAt=0;
  const watching={...env,DB:d1Standin(file,{onQuery:async text=>{
   if(!movedAt&&/CASE WHEN/.test(text)&&/operation_key/.test(text)&&/admission:lid:Bz6/.test(text)){
    movedAt++;
    sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('late-6','film_admission','rated_admission_retention','film','film:tmdb:700020','"+'7'.repeat(64)+"',0,2,'pending',1,'"+new Date(Date.now()-3600000).toISOString()+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:Bz6')");
   }
  }})};
  const response=await Facts.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body([item('Bz6','700021')],6))}),watching,'/api/letterboxd/baseline/commit');
  assert.equal(movedAt,1);assert.equal(response.status,409);assert.equal((await response.json()).code,'admission_not_settled','a verdict against a moved history is not recorded');
  // a live attempt of the key: the chunk stops before any verdict
  assert.equal((await ADD('Bz7','700022')).outcome,'admitted');
  sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('live-7','film_admission','rated_admission_retention','film','film:tmdb:700022','"+'7'.repeat(64)+"',0,2,'pending',1,'"+new Date(Date.now()+3600000).toISOString()+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:Bz7')");
  const live=await post(body([item('Bz7','700023')],7));
  assert.deepEqual([live.status,live.json.code],[409,'admission_not_settled'],'a live attempt stops the chunk (non-terminal)');
 }

 // an identity that is held (an untrusted claim on the movie id) is non-terminal: 409, the chunk is re-sent, and succeeds once the hold is gone
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES ('film:held',1,'x','"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:held','tmdb','700004',0,0)");
 const stopped=await post(body([item('Bz4','700004')],3));
 assert.deepEqual([stopped.status,stopped.json.code],[409,'admission_not_settled']);
 assert.equal(admissionRows(file).filter(item=>item.tmdb==='700004').length,0);
 assert.equal(await Facts.resolveAlias(env,'letterboxd:Bz4'),null,'the stop came BEFORE the link');
 sqlite(file,"DELETE FROM film_external_id WHERE film_id='film:held'");
 const resumed=await post(body([item('Bz4','700004')],3));
 assert.equal(resumed.status,200,JSON.stringify(resumed.json));assert.equal(resumed.json.entries[0].admission,'admitted');
}

// ===== G. the source changed between two attempts: the `linking` intent names A, the page now names B: `source_changed`, no admission, no link =====
{
 reset();
 await seed(env,'chg1');
 const intent={reason:'linking',class:'intent',slug:'fixture-eps-2022',tmdb:'900050',attempts:0,streak:0,queuedAt:new Date(NOW-3600000).toISOString(),lastAttemptAt:new Date(NOW-3000000).toISOString(),nextAttemptAt:new Date(NOW-1000).toISOString(),route:'ratings_diary'};
 await Facts.updateDiaryIdentity(env,{set:{chg1:intent},expect:{chg1:null}});
 add('chg1','fixture-eps-2022','900051','Fixture Eps',2022);
 const before=JSON.stringify([admissionRows(file),evidence(file)]);
 const out=await Identity.resolve(env,[{lid:'chg1',slug:'fixture-eps-2022'}],opts({route:'ratings_diary'}));
 const outcome=out.outcomes.get('chg1');
 assert.deepEqual([outcome.class,outcome.reason,outcome.attempts],['definite','source_changed',1],JSON.stringify([...out.outcomes]));
 assert.equal(JSON.stringify([admissionRows(file),evidence(file)]),before,'no admission and no evidence row');
 assert.equal((await Facts.diaryLinks(env,['chg1'])).get('chg1').tmdb,null,'no link');
 // the same movie again is no change: the repaired intent proceeds to the admission
 await seed(env,'chg2');
 await Facts.updateDiaryIdentity(env,{set:{chg2:{...intent,tmdb:'900052',slug:'fixture-zeta-2023'}},expect:{chg2:null}});
 add('chg2','fixture-zeta-2023','900052','Fixture Zeta',2023);
 const again=await Identity.resolve(env,[{lid:'chg2',slug:'fixture-zeta-2023'}],opts({route:'ratings_diary'}));
 assert.equal(again.outcomes.get('chg2').class,'settled',JSON.stringify([...again.outcomes]));
 assert.ok(admissionRows(file).some(item=>item.source_code==='chg2'&&item.tmdb==='900052'),'the same movie as the intent is admitted');
}

// ===== H. review of PR #1018: the durable intent, reconcile BEFORE the fetch, proven evidence and the history fence, through the real Diary and Watchlist caller =====
{
 const entryOf=(tmdb,extra={})=>({reason:'linking',class:'intent',slug:'fixture-h-'+tmdb,tmdb,attempts:0,streak:0,queuedAt:new Date(NOW-3600000).toISOString(),lastAttemptAt:new Date(NOW-3000000).toISOString(),nextAttemptAt:new Date(NOW-1000).toISOString(),route:'ratings_diary',...extra});
 const putIntent=async(lid,tmdb,extra)=>Facts.updateDiaryIdentity(env,{set:{[lid]:entryOf(tmdb,extra)},expect:{[lid]:null}});
 const pendingReceipt=(lid,id,future)=>sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('"+id+"','film_admission','rated_admission_retention','film','film:tmdb:900060','"+'7'.repeat(64)+"',0,2,'pending',1,'"+new Date(NOW+(future?3600000:-3600000)).toISOString()+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:"+lid+"')");
 const entry=async lid=>(await Facts.readDiaryIdentity(env)).films[lid]||null;
 const resolve1=(lid,slug,route='ratings_diary')=>Identity.resolve(env,[{lid,slug}],opts({route}));
 const intentOf8=e=>e?(e.reason==='linking'?e.tmdb:e.intent?.tmdb):null;
 const boxdCalls=()=>calls.filter(url=>url.includes('boxd.it')||url.includes('api.themoviedb.org')).length;

 // (1) a LIVE attempt of A under the key, the page now names B: the id waits WITHOUT a fetch and the durable intent A survives
 reset();
 await seed(env,'hw1');await putIntent('hw1','900060');add('hw1','fixture-h-900060','900061','Fixture HB',2020);pendingReceipt('hw1','live-A',true);
 const waited=await resolve1('hw1','fixture-h-900060');
 assert.deepEqual([waited.outcomes.get('hw1').class,waited.outcomes.get('hw1').reason],['not_now','in_flight'],JSON.stringify([...waited.outcomes]));
 assert.equal(boxdCalls(),0,'reconcile first: a live attempt means no fetch');
 const kept=await entry('hw1');
 assert.equal(kept.reason,'linking');assert.equal(kept.tmdb,'900060','the intended movie is untouched by the wait');

 // (2) the attempt of A EXPIRED (a crash): it is abandoned first, then the real check names B: source_changed, never an admission of B
 reset();
 await seed(env,'hw2');await putIntent('hw2','900060');add('hw2','fixture-h-900060','900062','Fixture HC',2021);pendingReceipt('hw2','stale-A',false);
 const changed=await resolve1('hw2','fixture-h-900060');
 assert.deepEqual([changed.outcomes.get('hw2').class,changed.outcomes.get('hw2').reason],['definite','source_changed'],JSON.stringify([...changed.outcomes]));
 assert.equal(rows(file,"SELECT state FROM canonical_write_receipt WHERE request_id='stale-A'")[0].state,'abandoned','the old attempt was settled before the check was believed');
 assert.equal(admissionRows(file).some(item=>item.source_code==='hw2'),false,'B is never admitted over an intent for A');

 // (3) an APPLIED attempt of A proves the work: the item finishes from the intent WITHOUT a fetch and without fresh evidence, even though the page now names B
 reset();
 await seed(env,'hw3');
 const admitted=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'hw3',receipt:{tmdb:'900063',archiveSha256:'a'.repeat(64),title:'Fixture HD',year:2019},evidence:{subject:{kind:'letterboxd_lid',value:'hw3'},relation:'same_work',object:{kind:'tmdb_movie',value:'900063'},polarity:'asserts',route:'watchlist_admission',method:'page_check',sourceRoot:'c'.repeat(64),sourceRef:'diary:hw3',observedAt:new Date(NOW).toISOString()},now:()=>new Date(NOW).toISOString()});
 assert.equal(admitted.outcome,'admitted');
 await putIntent('hw3','900063');add('hw3','fixture-h-900063','900064','Fixture HE',2018);
 calls.length=0;
 const evAfterSetup=evidence(file).length;
 const settled=await resolve1('hw3','fixture-h-900063','watchlist_admission');
 assert.deepEqual([settled.outcomes.get('hw3').class,settled.outcomes.get('hw3').reason],['settled','verified'],JSON.stringify([...settled.outcomes]));
 assert.equal(boxdCalls(),0,'no fetch: the applied attempt proves the work');
 assert.equal((await Facts.diaryLinks(env,['hw3'])).get('hw3').tmdb,'900063','linked to the INTENDED movie, not the one the page names now');
 assert.equal(evidence(file).length,evAfterSetup,'a recovery that made no check writes no evidence');

 // (3b) the intent OWES its evidence (a NEW genuine check of an admitted pair whose invocation died before its evidence was written): the admission is applied and matches the intent, but the item is NOT settled
 // from the intent: a real check is due, and it records the evidence. The obligation is a flag set before the first effect; the evidence ledger is never read to decide it (ADR 0213 decision 8)
 reset();
 await seed(env,'hw3b');
 assert.equal((await D1.admitVerifiedFilm(env,{kind:'lid',lid:'hw3b',receipt:{tmdb:'900071',archiveSha256:'a'.repeat(64),title:'Fixture HK',year:2012},now:()=>new Date(NOW).toISOString()})).outcome,'admitted');
 await putIntent('hw3b','900071',{evidenceDue:true});add('hw3b','fixture-h-900071','900071','Fixture HK',2012);
 calls.length=0;
 const due=await resolve1('hw3b','fixture-h-900071','watchlist_admission');
 assert.equal(due.outcomes.get('hw3b').class,'settled',JSON.stringify([...due.outcomes]));
 assert.ok(boxdCalls()>0,'the obligation is not provably fulfilled: the source is really reacquired');
 assert.deepEqual(evidence(file).filter(item=>item.subject_value==='hw3b').map(item=>item.route),['watchlist_admission'],'and the evidence of that check is recorded');
 // the same intent, the real check now names ANOTHER movie: source_changed, never a link
 reset();
 await seed(env,'hw3c');
 assert.equal((await D1.admitVerifiedFilm(env,{kind:'lid',lid:'hw3c',receipt:{tmdb:'900072',archiveSha256:'a'.repeat(64),title:'Fixture HL',year:2011},now:()=>new Date(NOW).toISOString()})).outcome,'admitted');
 await putIntent('hw3c','900072',{evidenceDue:true});add('hw3c','fixture-h-900072','900073','Fixture HM',2010);
 const changed3c=await resolve1('hw3c','fixture-h-900072','watchlist_admission');
 assert.deepEqual([changed3c.outcomes.get('hw3c').class,changed3c.outcomes.get('hw3c').reason],['definite','source_changed'],JSON.stringify([...changed3c.outcomes]));

 // (4) a genuine SECOND check of an admitted pair is recorded through the keyed evidence-only operation
 reset();
 await seed(env,'hw4');
 const first=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'hw4',receipt:{tmdb:'900065',archiveSha256:'a'.repeat(64),title:'Fixture HF',year:2017},now:()=>new Date(NOW).toISOString()});
 assert.equal(first.outcome,'admitted');
 add('hw4','fixture-h-900065','900065','Fixture HF',2017);
 const second=await resolve1('hw4','fixture-h-900065','watchlist_admission');
 assert.equal(second.outcomes.get('hw4').class,'settled',JSON.stringify([...second.outcomes]));
 const ev4=evidence(file).filter(item=>item.subject_value==='hw4');
 assert.deepEqual(ev4.map(item=>item.route),['watchlist_admission'],'the genuine second check is one evidence row');
 const keyed=receipts(file,'evidence:');
 assert.ok(keyed.some(item=>item.state==='applied'&&item.operation_key==='evidence:'+rows(file,"SELECT evidence_key FROM film_identity_evidence WHERE subject_value='hw4'")[0].evidence_key),'under its own key evidence:<evidence_key>');

 // (5) an evidence write that FAILS is never reported as success: the id is not linked, the intent keeps the evidence to record, and the next step records it WITHOUT a fetch and then links
 reset();
 await seed(env,'hw5');
 const a5=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'hw5',receipt:{tmdb:'900066',archiveSha256:'a'.repeat(64),title:'Fixture HG',year:2016},now:()=>new Date(NOW).toISOString()});
 assert.equal(a5.outcome,'admitted');
 add('hw5','fixture-h-900066','900066','Fixture HG',2016);
 const realDb=env.DB;let failing=true;
 const lossy={...env,DB:{prepare:sql=>realDb.prepare(sql),batch:async statements=>{if(failing&&statements.some(item=>/INSERT INTO film_identity_evidence/.test(item.text||'')))throw new Error('D1_ERROR: evidence batch lost');return realDb.batch(statements);}}};
 const failed=await Identity.resolve(lossy,[{lid:'hw5',slug:'fixture-h-900066'}],opts({route:'ratings_diary'}));
 assert.deepEqual([failed.outcomes.get('hw5').class,failed.outcomes.get('hw5').reason],['not_now','evidence_unrecorded'],JSON.stringify([...failed.outcomes]));
 assert.equal((await Facts.diaryLinks(env,['hw5'])).get('hw5').tmdb,null,'not linked: the check is not proven recorded');
 const kept5=await entry('hw5');
 assert.equal(kept5.reason,'linking');assert.ok(kept5.pendingEvidence&&kept5.pendingEvidence.route==='ratings_diary','the evidence is kept for a recoverable retry');
 failing=false;calls.length=0;
 const healed=await Identity.resolve(env,[{lid:'hw5',slug:'fixture-h-900066'}],opts({route:'ratings_diary'}));
 assert.equal(healed.outcomes.get('hw5').class,'settled',JSON.stringify([...healed.outcomes]));
 assert.equal(boxdCalls(),0,'recorded from the kept evidence, without a fetch');
 assert.equal(evidence(file).filter(item=>item.subject_value==='hw5').length,1,'the evidence of the genuine check is no longer lost');
 assert.equal((await Facts.diaryLinks(env,['hw5'])).get('hw5').tmdb,'900066');

 // (6) a TERMINAL outcome is fenced by the operation history IN the same D1 batch that writes the entry: another attempt appears under the key meanwhile, the write is refused, the attempt replans
 reset();
 await seed(env,'hw6');await putIntent('hw6','900060');add('hw6','fixture-h-900060','900067','Fixture HH',2015);
 let injected=0;
 const racing={...env,DB:d1Standin(file,{onBatch:async statements=>{
  if(!injected&&statements.some(item=>/letterboxd\/facts\/scans\/diary-identity\.json/.test(item.text||''))&&statements.some(item=>/operation_key/.test(item.text||'')&&/admission:lid:hw6/.test(item.text||''))){
   injected++;pendingReceipt('hw6','late-A',false);
  }
 }})};
 const fenced=await Identity.resolve(racing,[{lid:'hw6',slug:'fixture-h-900060'}],opts({route:'ratings_diary'}));
 assert.equal(injected,1,'the history moved between the plan and the terminal write');
 assert.deepEqual([fenced.outcomes.get('hw6').class,fenced.outcomes.get('hw6').reason],['definite','source_changed'],JSON.stringify([...fenced.outcomes]));
 assert.equal(rows(file,"SELECT state FROM canonical_write_receipt WHERE request_id='late-A'")[0].state,'abandoned','the replan settled the newcomer before answering again');

 // (6b) an answer that COSTS an attempt (a 404) is fenced by the history like any terminal write: another attempt appears under the key before the entry is written -> refused, replanned, charged ONCE, one fetch
 reset();
 await seed(env,'hw6b');
 let injected6=0;
 const racing6={...env,DB:d1Standin(file,{onBatch:async statements=>{
  if(!injected6&&statements.some(item=>/letterboxd\/facts\/scans\/diary-identity\.json/.test(item.text||''))&&statements.some(item=>/operation_key/.test(item.text||'')&&/admission:lid:hw6b/.test(item.text||''))){injected6++;pendingReceipt('hw6b','late-6b',false);}
 }})};
 const charged=await Identity.resolve(racing6,[{lid:'hw6b',slug:'fixture-h-gone'}],opts({route:'ratings_diary'}));
 assert.equal(injected6,1,'the history moved between the plan and the charged write');
 assert.deepEqual([charged.outcomes.get('hw6b').class,charged.outcomes.get('hw6b').reason,charged.outcomes.get('hw6b').attempts],['gone','not_found',1],JSON.stringify([...charged.outcomes]));
 assert.equal(boxdCalls(),1,'the replan reused the answer: ONE source request');
 assert.equal(rows(file,"SELECT state FROM canonical_write_receipt WHERE request_id='late-6b'")[0].state,'abandoned');

 // (6c) a TRUSTED BRIDGE for the id names ANOTHER movie than its unresolved intent: the bridge shortcut (which performs no check) must neither replace the intent nor link: the coordinator settles it
 reset();
 await seed(env,'hw6c');await putIntent('hw6c','900080');add('hw6c','fixture-h-900080','900080','Fixture HN',2009);
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES ('film:tmdb:900081',1,'tmdb:900081','"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:900081','tmdb','900081',1,0),('film:tmdb:900081','letterboxd','hw6c',1,0)");
 const bridged=await resolve1('hw6c','fixture-h-900080');
 assert.notEqual((await Facts.diaryLinks(env,['hw6c'])).get('hw6c').tmdb,'900081','the bridge shortcut did not link the other movie over the intent');
 assert.equal(intentOf8(await entry('hw6c'))??'900080','900080','the intent was not replaced');
 void bridged;

 // (7) a TRANSPORT stop (403) after the reconcile never discards the intent: the entry keeps `intent` A, and the next check that names B is still `source_changed`
 reset();
 await seed(env,'hw7');await putIntent('hw7','900060');add('hw7','fixture-h-900060','900068','Fixture HI',2014);site.get('hw7').status=403;
 const stop7=await resolve1('hw7','fixture-h-900060');
 assert.deepEqual([stop7.outcomes.get('hw7').class,stop7.outcomes.get('hw7').reason],['transport','forbidden'],JSON.stringify([...stop7.outcomes]));
 const after7=await entry('hw7');
 assert.equal(after7.intent?.tmdb,'900060','the transport stop kept the intended movie');
 delete site.get('hw7').status;
 await Facts.updateDiaryIdentity(env,{set:{hw7:{...after7,nextAttemptAt:new Date(NOW-1000).toISOString()}},expect:{hw7:JSON.stringify(after7)}});
 const again7=await resolve1('hw7','fixture-h-900060');
 assert.deepEqual([again7.outcomes.get('hw7').class,again7.outcomes.get('hw7').reason],['definite','source_changed'],JSON.stringify([...again7.outcomes]));

 // (8) a crash right after the check, before anything settles: the entry still names A (the intent is never replaced by the movie of an unsettled check)
 reset();
 await seed(env,'hw8');await putIntent('hw8','900060');add('hw8','fixture-h-900060','900069','Fixture HJ',2013);
 let thrown=0;
 const crashing={...env,DB:d1Standin(file,{onBatch:async statements=>{
  if(!thrown&&statements.some(item=>/letterboxd\/facts\/scans\/diary-identity\.json/.test(item.text||''))&&statements.some(item=>/operation_key/.test(item.text||'')&&/admission:lid:hw8/.test(item.text||''))){thrown++;throw new Error('D1_ERROR: process lost');}
 }})};
 await Identity.resolve(crashing,[{lid:'hw8',slug:'fixture-h-900060'}],opts({route:'ratings_diary'}));
 assert.equal(thrown,1);
 const after8=await entry('hw8');
 assert.equal(intentOf8(after8),'900060','the durable intent is still A, never B');
}

// ===== W. the Watchlist admission step (`letterboxd-sync-admission.js`, the real ledger of the Watchlist repository) over the real Diary check, at d1 =====
{
 reset();
 const publish=async(list,id,at)=>{const r=await WatchlistD1.publishSnapshot(env,list,{scanId:id,observedAt:at,runId:'r-'+id,slotKey:'k'},{now:Date.parse(at)});assert.equal(r.ok,true,JSON.stringify(r));return r;};
 const ledger=()=>Object.fromEntries(rows(file,'SELECT lid,state,attempts,last_reason,resolved_by FROM watchlist_admission_pending').map(r=>[r.lid,r]));
 const GUARD='INSERT INTO watchlist_cas (id, ok) SELECT 1, 1 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
 const identityBridge={MAX_ATTEMPTS:Identity.MAX_ATTEMPTS,resolve:(e,items,o)=>Identity.resolve(e,items,{...o,fetchImpl}),diaryLinks:(e,lids)=>Facts.diaryLinks(e,lids)};
 const stepCtx=(now)=>({env,epoch:1,now:()=>now,deadline:now+600000});
 const wnow=Date.now();
 await seed(env,'Wa1');await seed(env,'Wa2');
 add('Wa1','fixture-w-2001','900090','Fixture WA',2001);add('Wa2','fixture-w-2002','900091','Fixture WB',2002);
 // Wa2's code is held by another Film already
 assert.equal((await D1.admitVerifiedFilm(env,{kind:'lid',lid:'Wa2',receipt:{tmdb:'900099',archiveSha256:'a'.repeat(64),title:'Other WB',year:1999},now:()=>new Date(NOW).toISOString()})).outcome,'admitted');
 const film=(id,slug,year)=>({id,title:'T'+id,year,url:'https://letterboxd.com/film/'+slug+'/'});
 await publish([film('Wa1','fixture-w-2001',2001),film('Wa2','fixture-w-2002',2002)],'sw','2026-11-25T11:00:00.000Z');
 const step=admissionStep({repository:WatchlistD1,identity:identityBridge,epochGuard:()=>[GUARD,[]]});
 const out=await step(stepCtx(wnow),{limit:3,now:wnow});
 assert.equal(out.resolved,1,JSON.stringify(out));
 const rowsNow=ledger();
 assert.deepEqual([rowsNow.Wa1.state,rowsNow.Wa2.state,rowsNow.Wa2.last_reason,rowsNow.Wa2.attempts],['resolved','pending','admission_conflict',1],JSON.stringify(rowsNow));
 const evw=evidence(file).filter(item=>item.subject_value==='Wa1');
 assert.deepEqual(evw.map(item=>item.route),['watchlist_admission'],'the Watchlist caller\'s own route is on the evidence row');
 assert.equal(puts.includes(ADMISSIONS),false,'no R2 admissions object at d1');
 assert.equal((await Facts.diaryLinks(env,['Wa1'])).get('Wa1').tmdb,'900090','linked');
 assert.equal(evidence(file).filter(item=>item.subject_value==='Wa2').length,0,'the conflict wrote no evidence');
}

// ===== W2. between the Diary write and the ledger settlement: a competing attempt reserves under the key -> the ledger refuses its settlement (the row keeps its token and is read again) =====
{
 reset();
 const GUARD='INSERT INTO watchlist_cas (id, ok) SELECT 1, 1 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
 await seed(env,'Wb1');
 const film={id:'Wb1',title:'TWb1',year:2003,url:'https://letterboxd.com/film/fixture-wb-2003/'};
 const r=await WatchlistD1.publishSnapshot(env,[film],{scanId:'sw2',observedAt:'2026-11-25T11:30:00.000Z',runId:'r-sw2',slotKey:'k'},{now:Date.parse('2026-11-25T11:30:00.000Z')});
 assert.equal(r.ok,true,JSON.stringify(r));
 let competed=0;
 const settling={...env,DB:d1Standin(file,{onBatch:async statements=>{
  if(!competed&&statements.some(item=>/UPDATE watchlist_admission_pending/.test(item.text||''))){
   competed++;
   sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('late-wb','film_admission','rated_admission_retention','film','film:tmdb:900095','"+'7'.repeat(64)+"',0,2,'pending',1,'"+new Date(Date.now()-3600000).toISOString()+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:Wb1')");
  }
 }})};
 const bridge={MAX_ATTEMPTS:Identity.MAX_ATTEMPTS,resolve:(e,items,o)=>Identity.resolve(e,items,{...o,fetchImpl}),diaryLinks:(e,lids)=>Facts.diaryLinks(e,lids)};
 const wnow=Date.now();
 const out=await admissionStep({repository:WatchlistD1,identity:bridge,epochGuard:()=>[GUARD,[]]})({env:settling,epoch:1,now:()=>wnow,deadline:wnow+600000},{limit:3,now:wnow});
 const ledgerRow=rows(file,"SELECT state,attempts,last_reason FROM watchlist_admission_pending WHERE lid='Wb1'")[0];
 assert.equal(competed,1,'a competing attempt appeared between the Diary write and the ledger settlement');
 assert.equal(out.counts.rowChanged>=1,true,JSON.stringify(out.counts));
 assert.deepEqual([ledgerRow.state,ledgerRow.attempts],['pending',0],'the ledger refused the settlement: the row is unchanged and is read again');
}

console.log('Letterboxd admission callers at r2 and d1 (AIR-602) passed.');
