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
import {webcrypto,createHash} from 'node:crypto';
import {scoped,scopedImports,scopedReplacing} from '../scripts/bundle-scope.mjs';
import * as RatingsD1 from '../src/ratings-d1.js';
import * as WatchlistD1 from '../src/watchlist-d1.js';
import {admissionStep} from '../src/letterboxd-sync-admission.js';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {lidOnlyProofDigest} from '../src/domain/letterboxd-lid-only-digest.js';
import {attachRoot} from '../src/domain/letterboxd-attach-root.js';

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
// ADR 0222: at marker `d1` the import coordination documents (rated candidates, chunk intent / receipt / candidates result) are D1 Ratings documents behind a complete-import manifest; there is no R2 copy.
const MANIFEST='letterboxd/imports/documents-manifest.json';
// a complete import of an empty cohort: count, key list and digest agree
const EMPTY_MANIFEST={schemaVersion:1,complete:true,count:0,keys:[],inventorySha256:createHash('sha256').update('[]').digest('hex')};
const sqlText=text=>"'"+String(text).replace(/'/g,"''")+"'";
const setDocD1=(file,key,value)=>{const body=JSON.stringify(value);sqlite(file,'DELETE FROM ratings_document WHERE key='+sqlText(key)+';INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+sqlText(key)+',0,'+sqlText(body)+','+sqlText(createHash('sha256').update(body).digest('hex'))+','+sqlText(STAMP)+')');};
const getDocD1=(file,key)=>{const found=rows(file,'SELECT body FROM ratings_document WHERE key='+sqlText(key)+' ORDER BY part');return found.length?JSON.parse(found.map(row=>row.body).join('')):null;};
const dbFiles=new Set();
const fresh=mode=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);sqlite(file,OPEN);
 if(mode==='d1'){sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1;UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");setDocD1(file,MANIFEST,EMPTY_MANIFEST);dbFiles.add(file);}
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
vm.runInContext(scopedImports('src/domain/letterboxd-lid-only-proof.js','LetterboxdLidOnlyProof','const {TMDB_STATES,pageTmdbObservation}=LetterboxdRatedAdmission;\nconst {LID_ONLY_PROOF_VERSION,lidOnlyProofDigest,normalizeFilmUrl}=LetterboxdLidOnlyDigest;'),ctx);
for(const file of ['src/letterboxd-facts.js','src/letterboxd-rated-candidates.js','src/letterboxd-diary-identity.js'])vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
vm.runInContext(scopedImports('src/domain/letterboxd-attach-root.js','LetterboxdAttachRoot','const {agreementNorm}=LetterboxdRatedAdmission;\nconst {normalizeFilmUrl}=LetterboxdLidOnlyDigest;'),ctx);
vm.runInContext(scoped('src/letterboxd-admission-documents.js','LetterboxdAdmissionDocuments'),ctx);
vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;",ctx);
const Facts=vm.runInContext('LetterboxdFacts',ctx),Identity=vm.runInContext('LetterboxdDiaryIdentity',ctx),D1=vm.runInContext('LetterboxdAdmissionD1',ctx),Candidates=vm.runInContext('LetterboxdRatedCandidates',ctx);
const ADMISSIONS='letterboxd/admissions/verified-films.json';
const world=file=>({DB:d1Standin(file),BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'fixture-token'});
const seed=(env,lid,rating=4)=>Facts.applyDiaryEvidence(env,[{lid,watchedDate:'2026-11-15',rating,ratingState:'rated',sourceRef:'diary:viewing:1'}]);
const opts=extra=>({clock:()=>NOW,remaining:()=>120000,fetchImpl,...extra});
const admissionRows=file=>rows(file,'SELECT film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,verified_at,request_id FROM film_rated_admission ORDER BY film_id');
const receipts=(file,prefix=null)=>rows(file,prefix?"SELECT request_id,state,operation_key FROM canonical_write_receipt WHERE operation_key LIKE '"+prefix+"%' ORDER BY created_at,request_id":"SELECT request_id,state,operation_key FROM canonical_write_receipt WHERE operation='film_admission' ORDER BY created_at,request_id");
const evidence=file=>rows(file,'SELECT subject_value,object_value,route,method,source_root,request_id,film_id FROM film_identity_evidence ORDER BY seq');
const reset=()=>{for(const db of dbFiles)sqlite(db,"DELETE FROM ratings_document WHERE key LIKE 'letterboxd/imports/%' AND key<>"+sqlText(MANIFEST));r2.clear();etags.clear();site.clear();movies.clear();calls.length=0;puts.length=0;};

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
 const seedDoc=(code,name,year)=>setDocD1(file,KEY,candidateDoc(code,name,year));
 const rowOf=code=>getDocD1(file,KEY).candidates[code];
 // the delivered R2 path (marker r2) keeps its R2 document
 const seedDocR2=(code,name,year)=>{r2.set(KEY,candidateDoc(code,name,year));etags.set(KEY,String(++rev));};
 const rowOfR2=code=>r2.get(KEY).candidates[code];
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
 const doc=getDocD1(file,KEY);doc.candidates.rt1.enrichment='pending';setDocD1(file,KEY,doc);calls.length=0;puts.length=0;
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
 seedDocR2('rt3','Fixture Rated Three',2019);add('rt3','fixture-rated-2019','900011','Fixture Rated Three',2019);
 const legacy=await Candidates.identityStep(oldEnv,{sha:SHA,fetchImpl});
 assert.equal(legacy.verified,true,JSON.stringify(legacy));
 assert.ok(r2.get(ADMISSIONS)?.films?.tmdb_900011,'r2: the legacy R2 entry');
 assert.equal(admissionRows(old).find(item=>item.source_code==='rt3').receipt_key,ADMISSIONS);
 assert.equal(evidence(old).length,0);assert.ok(receipts(old).every(item=>item.operation_key===null));
 assert.equal(rowOfR2('rt3').enrichment,'pending','r2: enrichment is still pending (legacy)');
}

// ===== E2. review of PR #1018 (P1): an `admitting` row is recovered from DURABLE STATE and a REAL reacquisition, never from its stored intent =====
{
 const SHA='e'.repeat(64),KEY='letterboxd/imports/'+SHA+'/rated-candidates.json';
 const row=(code,tmdb,path,name,year,extra={})=>({code,state:'admitting',reason:null,rating:4,observedAt:'2026-11-20T10:00:00.000Z',name,year,historicalTmdb:null,tmdb:null,chunk:0,registeredAt:'2026-11-20T10:00:00.000Z',enrichment:'pending',intendedTmdb:tmdb,filmPath:path,...extra});
 const seedRow=r=>setDocD1(file,KEY,{schemaVersion:1,archiveSha256:SHA,generatedAt:'2026-11-20T10:00:00.000Z',candidates:{[r.code]:r},checkpoint:{cursor:null,stopped:null}});
 const rowOf=code=>getDocD1(file,KEY).candidates[code];
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

 // PR #1018 review (P1-2): EVERY terminal rated decision at d1 is one batch with the history assertion of the history its reconcile observed. The competitor lands immediately before the terminal document batch.
 const moveBefore=(lid,fn)=>{let hit=0;return {count:()=>hit,env:{...env,DB:d1Standin(file,{onBatch:async list=>{
  if(!hit&&list.some(item=>/ratings_document/.test(item.text)&&item.text.includes(KEY)&&/needs_review/.test(item.text))&&list.some(item=>new RegExp('admission:lid:'+lid).test(item.text))){hit++;fn();}
 }})}};};
 // (2b) the SIXTH source answer (the cap) is terminal: a competing attempt before that batch refuses it whole; the row stays admitting with its intent
 reset();
 seedRow(row('rc2b','900075','/film/fixture-rc-75/','Fixture RDB',2011,{sourceAttempts:5}));
 const cap=moveBefore('rc2b',()=>hasPending('rc2b','late-2b',false));
 const heldCap=await step(cap.env);
 assert.equal(cap.count(),1,'the competitor landed before the terminal batch');
 assert.deepEqual([heldCap.state,heldCap.reason],['admitting','in_flight'],JSON.stringify(heldCap));
 assert.deepEqual([rowOf('rc2b').state,rowOf('rc2b').intendedTmdb],['admitting','900075'],'not terminal on a moved history, and the intent is kept');
 assert.equal(rowOf('rc2b').sourceAttempts,5,'the charge and the disposition are one batch: a refused terminal outcome leaves NO stale charge');
 // control: the same row without the competitor reaches the cap and is terminal in that one write (counter and disposition together)
 const capped2b=await step();
 assert.deepEqual([capped2b.state,capped2b.reason],['needs_review','source_unavailable'],JSON.stringify(capped2b));
 assert.deepEqual([rowOf('rc2b').state,rowOf('rc2b').sourceAttempts,rowOf('rc2b').intendedTmdb],['needs_review',6,null]);
 // (2c) a PENDING row's terminal review (the page cannot be reviewed) reconciles first and is guarded the same way: the row stays pending
 reset();
 seedRow({...row('rc2c',null,null,'Fixture RDC',2011),state:'pending',intendedTmdb:null,filmPath:null});
 const pend=moveBefore('rc2c',()=>hasPending('rc2c','late-2c',false));
 const heldPending=await step(pend.env);
 assert.equal(pend.count(),1,'the competitor landed before the terminal batch of the pending row');
 assert.deepEqual([heldPending.state,heldPending.reason],['pending','in_flight'],JSON.stringify(heldPending));
 assert.equal(rowOf('rc2c').state,'pending','a pending row is not made terminal on a superseded history');
 // control: without the competitor the same pending row IS terminal (the review is a real outcome, not a refusal of the fence)
 const terminalPending=await step();
 assert.equal(terminalPending.state,'needs_review',JSON.stringify(terminalPending));
 // (2d) a reservation that LOST A RACE (a rival admits the code for another Film between the plan and the writer batch): the typed conflict surfaces with its receipt still unresolved, so it is NOT terminal: the row
 // keeps its intent; the next step reconciles the key and finalizes the conflict under the history assertion
 reset();
 seedRow({...row('rc2d',null,null,'Fixture RDD',2013),state:'pending',intendedTmdb:null,filmPath:null});add('rc2d','fixture-rc-2d-171','900171','Fixture RDD',2013);
 let rival=0;
 const racing2d={...env,DB:d1Standin(file,{onBatch:async list=>{
  // the writer's own admission batch: the rival lands immediately before it
  if(!rival&&list.some(item=>/INSERT INTO film_rated_admission/.test(item.text)&&item.text.includes('rc2d'))){
   rival++;
   sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES ('film:tmdb:900172',1,'tmdb:900172','"+STAMP+"');INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:900172','900172','rc2d','"+'a'.repeat(64)+"','Rival',1970,'d1','tmdb_900172','"+STAMP+"','rival-2d','"+STAMP+"')");
  }
 }})};
 const lost2d=await step(racing2d);
 assert.equal(rival,1,'the rival landed between the plan and the admission');
 assert.notEqual(lost2d.state,'needs_review','a conflict from a reservation that lost a race is not terminal: its receipt is unresolved');
 assert.ok(['admitting','pending'].includes(rowOf('rc2d').state),JSON.stringify(rowOf('rc2d')));
 const settled2d=await step();
 assert.deepEqual([settled2d.state,settled2d.reason],['needs_review','historical_alias_conflict'],'the next step reconciles and finalizes the conflict under the history assertion: '+JSON.stringify(settled2d));
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_rated_admission WHERE source_code='rc2d'")[0].n,1,'only the rival admission exists');

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

 // (3c) the CRASH GAP of the rated step: the pair is admitted by ANOTHER route; this archive's check claims the row (`admitting`, with its evidence obligation) and the process dies before the admission
 // call: the restart is not settled from the intent, it reacquires both sources and records this archive's evidence
 reset();
 const p3c=await D1.admitVerifiedFilm(env,{kind:'lid',lid:'rc3c',receipt:{tmdb:'900085',archiveSha256:'a'.repeat(64),title:'Fixture RK',year:2004},now:()=>new Date(NOW).toISOString()});
 assert.equal(p3c.outcome,'admitted');
 seedRow({...row('rc3c',null,null,'Fixture RK',2004),state:'pending',intendedTmdb:null,filmPath:null});add('rc3c','fixture-rc-85','900085','Fixture RK',2004);
 const realDb3=env.DB;
 // the process dies at the first canonical call AFTER the claim (the step now reconciles the key BEFORE the claim, which must work): the obligation is durable by then
 const dyingEnv={...env,DB:{prepare:sql=>{if(/canonical_write_receipt/.test(sql)&&getDocD1(file,KEY).candidates.rc3c?.state==='admitting')throw new Error('D1_ERROR: process died');return realDb3.prepare(sql);},batch:statements=>realDb3.batch(statements)}};
 await assert.rejects(()=>step(dyingEnv),error=>/film_person_unavailable|process died/.test(String(error?.message||error)),'the step dies at the first canonical call after the claim');
 assert.equal(rowOf('rc3c').state,'admitting');assert.equal(rowOf('rc3c').evidenceDue,true,'the obligation was durable before the first effect');
 calls.length=0;
 const restarted3=await step();
 assert.equal(restarted3.verified,true,JSON.stringify(restarted3));
 assert.ok(boxdCalls()>0,'the source is really reacquired');
 assert.deepEqual(rows(file,"SELECT route,source_scope FROM film_identity_evidence WHERE subject_value='rc3c'").map(item=>[item.route,item.source_scope]),[['letterboxd_rated_archive',SHA]],'and this archive\'s evidence is recorded');
 assert.equal(rowOf('rc3c').evidenceDue,false,'the obligation is cleared once the row is verified');

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
 // ADR 0222: the terminal review and the history assertion are ONE batch. The history moves immediately BEFORE that batch runs; the whole batch (document included) must then be refused.
 const watching={...env,DB:d1Standin(file,{onBatch:async list=>{
  if(!moved&&list.some(item=>/ratings_document/.test(item.text)&&item.text.includes(KEY))&&list.some(item=>/admission:lid:rc7/.test(item.text))){moved++;hasPending('rc7','late-r7',false);}
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
  // AIR-672 / ADR 0217 decision 5b: the rival is seen by the PLANNER, before the reservation: a plain conflict, and nothing was linked (the link runs only inside an owned attempt, which was never reserved).
  assert.deepEqual([json.conflicts,json.entries[0].conflict,json.entries[0].admission],[1,true,'conflict']);
  assert.equal(await Facts.resolveAlias(env,'letterboxd:Bz5'),null,'no link: the reservation precedes the mark and the link, and a settled conflict reserves nothing');
  assert.equal((await Facts.diaryLinks(env,['Bz5'])).get('Bz5').tmdb,null,'and no fact record was written for it');
  assert.equal(admissionRows(file).filter(item=>item.source_code==='Bz5').length,1,'only the rival admission exists');
  assert.equal(evidence(file).filter(item=>item.subject_value==='Bz5').length,0,'no evidence row for the refused item');
 }

 // PR #1018 review (P1-1): the irreversible effects BEFORE the item's own admission (the inferred mark, the link, and for another code on the Film the facts) assert the operation history the verdict was computed
 // against IN THEIR OWN BATCH. A competing attempt that appears under the key BEFORE the link/fact batch refuses that batch whole: nothing is linked or published, the chunk stops (409), no receipt, no claim.
 {
  const ADD=(lid,tmdb,title='Held',year=1981)=>D1.admitVerifiedFilm(env,{kind:'lid',lid,receipt:{tmdb,archiveSha256:'a'.repeat(64),title,year},now:()=>new Date(NOW).toISOString()});
  const competitor=(lid,film)=>"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('late-"+lid+"','film_admission','rated_admission_retention','film','"+film+"','"+'7'.repeat(64)+"',0,2,'pending',1,'"+new Date(Date.now()-3600000).toISOString()+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:"+lid+"')";
  const factRecords=()=>rows(file,"SELECT key FROM ratings_document WHERE key LIKE 'letterboxd/facts/films/%' AND part=0").length;
  const receiptDoc=(chunk)=>getDocD1(file,'letterboxd/imports/'+SHA+'/chunks/'+chunk+'.receipt.json');
  for(const [lid,tmdb,other,chunk] of [['Fz1','700041',true,41],['Fz2','700042',false,42]]){
   // `other`: the movie already belongs to another code (the verdict is present_other_code and the link and the facts proceed); otherwise the pair is planned (reserved, then linked inside the owned attempt, then admitted)
   if(other)assert.equal((await ADD('Fo'+lid,tmdb)).outcome,'admitted');
   let moved=0;
   const watching={...env,DB:d1Standin(file,{onBatch:async list=>{
    // the FIRST batch that writes the link or a fact record of this lid (the inferred mark, or the link): the competitor lands just before it
    // `other` (no reservation: the verdict is settled before any): a competitor reserves the key just before the link or fact batch. Otherwise (a NEW admission) the item's OWN attempt already holds the key (ADR 0217
    // decision 5b: the reservation precedes the mark and the link), so the competing event is the attempt being ABANDONED (expired and superseded) just before its mark or link batch: the assertion of the exact owned
    // attempt refuses that batch whole.
    if(!moved&&list.some(item=>/ratings_document/.test(item.text)&&/letterboxd\/facts\/(links\.json|films\/)/.test(item.text))&&(!other||list.some(item=>new RegExp('admission:lid:'+lid).test(item.text)))){moved++;sqlite(file,other?competitor(lid,'film:tmdb:'+tmdb):"UPDATE canonical_write_receipt SET state='abandoned',error_class='superseded_by_retry',next_attempt_at=NULL,updated_at='"+STAMP+"',settled_at='"+STAMP+"' WHERE operation_key='admission:lid:"+lid+"' AND state='pending'");}
   }})};
   const before={links:(await Facts.diaryLinks(env,[lid])).get(lid)?.tmdb??null,records:factRecords(),admissions:admissionRows(file).length};
   const response=await Facts.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body([item(lid,tmdb)],chunk))}),watching,'/api/letterboxd/baseline/commit');
   const json=await response.json();
   assert.equal(moved,1,lid+': the competitor landed before the link/fact batch');
   assert.equal(response.status,409,lid+' '+JSON.stringify(json));assert.equal(json.code,'admission_not_settled');
   assert.equal(await Facts.resolveAlias(env,'letterboxd:'+lid),null,lid+': no alias link was written on the superseded verdict');
   assert.equal((await Facts.diaryLinks(env,[lid])).get(lid)?.tmdb??null,before.links,lid+': no link');
   assert.equal(factRecords(),before.records,lid+': no fact record, no observation');
   assert.equal(receiptDoc(chunk),null,lid+': no chunk receipt (so no claim either)');
   assert.equal(admissionRows(file).length,before.admissions,lid+': no admission');
   assert.equal(evidence(file).filter(entry=>entry.subject_value===lid).length,0,lid+': no evidence');
  }
 }

 // PR #1018 re-review: a typed refusal that surfaced from the ACTUAL reservation batch (the writer's own admission batch refused it) left its receipt unresolved: it is not a settled verdict. The failed attempt is reconciled,
 // the verdict recomputed, and its fresh guard is carried into the post-link facts and the chunk receipt.
 {
  const rivalFor=(lid,film,tmdb,code)=>"INSERT OR IGNORE INTO film (id,contract_version,canonical_identity,updated_at) VALUES ('"+film+"',1,'tmdb:"+tmdb+"','"+STAMP+"');INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('"+film+"','"+tmdb+"','"+code+"','"+'a'.repeat(64)+"','Rival',1970,'d1','tmdb_"+tmdb+"','"+STAMP+"','rival-"+code+"','"+STAMP+"')";
  const pend=lid=>"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('late-"+lid+"','film_admission','rated_admission_retention','film','film:tmdb:0',"+"'"+'7'.repeat(64)+"',0,2,'pending',1,'"+new Date(Date.now()-3600000).toISOString()+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:"+lid+"')";
  const records=()=>rows(file,"SELECT key FROM ratings_document WHERE key LIKE 'letterboxd/facts/films/%' AND part=0").length;
  const receiptOf=chunk=>getDocD1(file,'letterboxd/imports/'+SHA+'/chunks/'+chunk+'.receipt.json');
  const commit=(e,items,chunk)=>Facts.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body(items,chunk))}),e,'/api/letterboxd/baseline/commit');
  const onWriterBatch=(lid,fn)=>{let hit=0;return {count:()=>hit,env:{...env,DB:d1Standin(file,{onBatch:async list=>{
   if(!hit&&list.some(entry=>/INSERT INTO film_rated_admission/.test(entry.text)&&entry.text.includes("'"+lid+"'"))){hit++;fn();}
  }})}};};
  // (i) the writer batch loses to a rival that admits the same CODE for another Film: after the reconcile the verdict is a conflict: refused_after_link (the inferred-marked link stays; no facts, no claim), recorded WITH its guard
  {
   const w=onWriterBatch('Rb1',()=>sqlite(file,rivalFor('Rb1','film:tmdb:700152','700152','Rb1')));
   const res=await commit(w.env,[item('Rb1','700151')],51);const json=await res.json();
   assert.equal(w.count(),1,'the rival landed inside the writer\'s own admission batch');
   assert.equal(res.status,200,JSON.stringify(json));
   assert.deepEqual([json.conflicts,json.entries[0].conflict,json.entries[0].admission],[1,true,'refused_after_link'],JSON.stringify(json.entries[0]));
   assert.equal((await Facts.diaryLinks(env,['Rb1'])).get('Rb1').tmdb,null,'no fact was published for the refused item (the inferred-marked alias link stays)');
   assert.equal(receiptOf(51).entries[0].admission,'refused_after_link','the receipt records the verdict');
   assert.equal(admissionRows(file).filter(entry=>entry.source_code==='Rb1').length,1,'only the rival admission exists');
  }
  // (ii) the writer batch loses to a rival that admits ANOTHER code for the same movie: after the reconcile the verdict is present_other_code: facts publish, under that verdict's guard
  {
   const w=onWriterBatch('Rb2',()=>sqlite(file,rivalFor('Rb2','film:tmdb:700161','700161','RbOther')));
   const res=await commit(w.env,[item('Rb2','700161')],52);const json=await res.json();
   assert.equal(w.count(),1);assert.equal(res.status,200,JSON.stringify(json));
   assert.equal(json.entries[0].admission,'present_other_code',JSON.stringify(json.entries[0]));
   assert.equal((await Facts.diaryLinks(env,['Rb2'])).get('Rb2').tmdb,'700161','the facts of a genuinely settled present_other_code verdict are published');
   assert.equal(admissionRows(file).filter(entry=>entry.source_code==='Rb2').length,0,'and no admission is made for the second code');
   assert.ok(receiptOf(52),'with its chunk receipt');
  }
  // (iii) the same, and a conflicting admission of the code settles AFTER the failed attempt and BEFORE the fact write: the stale present_other_code verdict publishes nothing (the fact batch asserts its guard) and the chunk stops
  {
   let landed=0;
   const w=onWriterBatch('Rb3',()=>sqlite(file,rivalFor('Rb3','film:tmdb:700171','700171','RbOther3')));
   const watching={...w.env,DB:d1Standin(file,{onBatch:async list=>{
    if(!w.count()&&list.some(entry=>/INSERT INTO film_rated_admission/.test(entry.text)&&entry.text.includes("'Rb3'"))){sqlite(file,rivalFor('Rb3','film:tmdb:700171','700171','RbOther3'));w.env.__hit=1;landed=0;}
    else if(w.env.__hit===1&&!landed&&list.some(entry=>/letterboxd\/facts\/films\//.test(entry.text))&&list.some(entry=>/admission:lid:Rb3/.test(entry.text))){landed++;sqlite(file,pend('Rb3'));}
   }})};
   const res=await commit(watching,[item('Rb3','700171')],53);const json=await res.json();
   assert.equal(landed,1,'the conflicting attempt settled before the fact write');
   assert.equal(res.status,409,JSON.stringify(json));assert.equal(json.code,'admission_not_settled');
   assert.equal((await Facts.diaryLinks(env,['Rb3'])).get('Rb3').tmdb,null,'no fact was published on the stale verdict');
   assert.equal(receiptOf(53),null,'and the chunk has no receipt');
  }
 }

 // a conflict verdict is fenced by the operation history: another attempt appears under the key before the chunk receipt is written -> the chunk stops (409), nothing is recorded; a LIVE attempt stops it before any verdict
 {
  const ADD=(lid,tmdb)=>D1.admitVerifiedFilm(env,{kind:'lid',lid,receipt:{tmdb,archiveSha256:'a'.repeat(64),title:'Held',year:1981},now:()=>new Date(NOW).toISOString()});
  assert.equal((await ADD('Bz6','700020')).outcome,'admitted');
  let movedAt=0;
  // ADR 0222: the receipt document and the history assertion are one batch; the history moves immediately before that batch, which is refused whole.
  const watching={...env,DB:d1Standin(file,{onBatch:async list=>{
   if(!movedAt&&list.some(item=>/chunks\/6\.receipt\.json/.test(item.text))&&list.some(item=>/admission:lid:Bz6/.test(item.text))){
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

// ===== F2. AIR-672 / ADR 0217 decision 5b and test 5c: the inferred import RESERVES the common lid key BEFORE its mark and link; both run inside the owned attempt; the canonical batch settles it =====
{
 reset();
 const SHA='d'.repeat(64);
 const body=(items,chunk=0,sha=SHA)=>({origin:{archiveSha256:sha,generatedAt:'2026-11-20T10:00:00.000Z',generatedAtSource:'archive_name'},chunk,items});
 const commit=async(e,b)=>{const response=await Facts.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),e,'/api/letterboxd/baseline/commit');return {status:response.status,json:await response.json()};};
 const item=(lid,tmdb,title='Baseline',year=1999)=>({lid,facts:{watched:true},tmdb,identity:'inferred',admit:{title,year}});
 const watch=(onBatch)=>({...env,DB:d1Standin(file,{onBatch})});
 const kindOf=list=>list.some(entry=>/INSERT INTO film_rated_admission/.test(entry.text))?'canonical':list.some(entry=>/INSERT INTO canonical_write_receipt/.test(entry.text)&&/operation_key/.test(entry.text))?'reserve':list.some(entry=>/ratings_document/.test(entry.text)&&/letterboxd\/facts\/(links\.json|films\/)/.test(entry.text))?'effect':null;
 const lidReceipts=lid=>receipts(file).filter(entry=>entry.operation_key==='admission:lid:'+lid);
 const films=lid=>rows(file,"SELECT id FROM film WHERE id IN (SELECT film_id FROM film_rated_admission WHERE source_code='"+lid+"') OR id='film:lb:"+lid+"'");
 const proofOf=async lid=>{const proof={proofVersion:1,lid,finalUrl:'https://letterboxd.com/film/short-1999/',slug:'short-1999',canonicalPath:'/film/short-1999/',shortlink:lid,typeMarker:'video.movie',idBlockOutcome:'absent',completenessOutcome:'complete',title:'Short',year:1999,redirectStatus:301,pageStatus:200,checkedAt:'2026-11-20T10:00:00.000Z'};proof.proofDigest=await lidOnlyProofDigest(proof);return proof;};

 // (1) the reservation precedes the first mark or link batch, which precedes the canonical admission; the receipt of the key is applied by the canonical batch
 {
  const order=[];
  const out=await commit(watch(async list=>{const kind=kindOf(list);if(kind)order.push(kind);}),body([item('Oz1','710001')],1));
  assert.equal(out.status,200,JSON.stringify(out.json));assert.equal(out.json.entries[0].admission,'admitted');
  assert.ok(order.indexOf('reserve')>=0&&order.indexOf('effect')>order.indexOf('reserve'),'reservation first, then the effects: '+order.join(','));
  assert.ok(order.indexOf('canonical')>order.indexOf('effect'),'then the canonical admission: '+order.join(','));
  assert.deepEqual(lidReceipts('Oz1').map(entry=>entry.state),['applied'],'one receipt, settled by the canonical batch');
  assert.ok((await Facts.diaryLinks(env,['Oz1'])).get('Oz1').tmdb==='710001','linked');
 }

 // (2) the pending attempt is ABANDONED (expired and superseded) before the link batch: the owned-attempt assertion refuses it, nothing is linked or admitted, the chunk stops without a receipt
 {
  let moved=0;
  const out=await commit(watch(async list=>{if(!moved&&kindOf(list)==='effect'){moved++;sqlite(file,"UPDATE canonical_write_receipt SET state='abandoned',error_class='superseded_by_retry',next_attempt_at=NULL,updated_at='"+STAMP+"',settled_at='"+STAMP+"' WHERE operation_key='admission:lid:Oz2' AND state='pending'");}}),body([item('Oz2','710002')],2));
  assert.equal(moved,1);assert.deepEqual([out.status,out.json.code],[409,'admission_not_settled']);
  assert.equal(await Facts.resolveAlias(env,'letterboxd:Oz2'),null,'a late link of an abandoned owner never lands');
  assert.equal(admissionRows(file).filter(entry=>entry.source_code==='Oz2').length,0);
  assert.equal(lidReceipts('Oz2').some(entry=>entry.state==='applied'),false);
  // the re-sent chunk replans from durable state and succeeds under a NEW attempt
  const again=await commit(env,body([item('Oz2','710002')],2));
  assert.equal(again.status,200,JSON.stringify(again.json));assert.equal(again.json.entries[0].admission,'admitted');
  assert.deepEqual(lidReceipts('Oz2').map(entry=>entry.state).sort(),['abandoned','applied']);
  assert.equal(admissionRows(file).filter(entry=>entry.source_code==='Oz2').length,1);
 }

 // (2b) review P1-2 (and its residual): the receipt stays PENDING but its window passes AFTER an effect batch was built and BEFORE the database executes it. The deadline is compared in the batch's own SQL with the time the
 // database runs it at, so the already-bound mark or link batch fails. Test seam: the stand-in rewrites the database clock expression of that one batch to a later instant at execution (the statements were bound earlier).
 {
  const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  // `at`: the batch after which the NEXT effect batch is delayed past the deadline: the reservation (the FIRST effect batch is late) or the first effect batch (the SECOND, the link, is late)
  for(const [lid,at,chunk] of [['Oy1','reserve',21],['Oy2','effect',22]]){
   let armed=0,late=0;
   const out=await commit(watch(async list=>{
    const kind=kindOf(list);
    if(!armed&&kind===at){armed++;return;}
    if(armed&&!late&&kind==='effect'){late++;for(const entry of list)entry.text=entry.text.split(NOW).join("'2099-01-01T00:00:00.000Z'");}
   }),body([item(lid,'7200'+chunk)],chunk));
   assert.equal(late,1,lid+': a bound effect batch reached execution after the deadline');
   assert.deepEqual([out.status,out.json.code],[409,'admission_not_settled'],lid+' '+JSON.stringify(out.json));
   assert.equal(await Facts.resolveAlias(env,'letterboxd:'+lid),null,lid+': no late link');
   assert.equal(admissionRows(file).filter(entry=>entry.source_code===lid).length,0,lid+': no admission');
   assert.equal(lidReceipts(lid).some(entry=>entry.state==='applied'),false,lid+': never applied');
   // the receipt was `pending` (inside nobody's abandonment) when the batch ran; the failed effect leaves it unresolved (`unknown`), never applied, and the next attempt supersedes it
   assert.equal(lidReceipts(lid).length,1,lid+': one receipt');assert.ok(['pending','unknown','failed'].includes(lidReceipts(lid)[0].state),lid+': unresolved, not applied: '+lidReceipts(lid)[0].state);
  }
 }

 // (3) the code is linked elsewhere AFTER the reservation: the link finds the conflict, the attempt is not settled, nothing is admitted, no chunk receipt
 {
  let moved=0;
  const out=await commit(watch(async list=>{if(!moved&&kindOf(list)==='effect'){moved++;await Facts.linkFilm(env,{letterboxd:'Oz3',tmdb:'710099'});}}),body([item('Oz3','710003')],3));
  assert.equal(moved,1);assert.deepEqual([out.status,out.json.code],[409,'admission_not_settled'],JSON.stringify(out.json));
  assert.equal(admissionRows(file).filter(entry=>entry.source_code==='Oz3').length,0,'no admission on the linked-elsewhere code');
  assert.equal(lidReceipts('Oz3').some(entry=>entry.state==='applied'),false,'the reserved attempt was never applied');
 }

 // (4) a failure BETWEEN the link and the canonical commit: the retry recovers from durable state, the link is idempotent, ONE admission, ONE applied receipt
 {
  let failedOnce=0;
  const first=await commit(watch(async list=>{if(!failedOnce&&kindOf(list)==='canonical'){failedOnce++;throw new Error('crash before the canonical commit');}}),body([item('Oz4','710004')],4)).catch(error=>({status:500,error}));
  assert.equal(failedOnce,1);assert.notEqual(first.status,200,'the chunk did not settle');
  assert.ok((await Facts.diaryLinks(env,['Oz4'])).get('Oz4').tmdb==='710004'||await Facts.resolveAlias(env,'letterboxd:Oz4'),'the link landed inside the owned attempt');
  assert.equal(admissionRows(file).filter(entry=>entry.source_code==='Oz4').length,0,'but nothing was admitted');
  const retry=await commit(env,body([item('Oz4','710004')],4));
  assert.equal(retry.status,200,JSON.stringify(retry.json));assert.equal(retry.json.entries[0].admission,'admitted');
  assert.equal(admissionRows(file).filter(entry=>entry.source_code==='Oz4').length,1);
  assert.equal(lidReceipts('Oz4').filter(entry=>entry.state==='applied').length,1,'exactly one applied receipt');
  assert.equal(films('Oz4').length,1,'one Film');
  // idempotent replay of the settled chunk
  const before=JSON.stringify([admissionRows(file),lidReceipts('Oz4'),evidence(file)]);
  const replay=await commit(env,body([item('Oz4','710004')],4));
  assert.deepEqual([replay.status,replay.json.replay],[200,true]);assert.equal(JSON.stringify([admissionRows(file),lidReceipts('Oz4'),evidence(file)]),before);
 }

 // (5) competing lid-only and inferred attempts, both orders: never two Films for one lid, never an automatic attach
 {
  const lidOnly=(lid)=>D1.admitVerifiedLidOnly(env,{lid,route:'ratings_diary',reacquire:async()=>{const doc=rows(file,"SELECT COUNT(*) AS n,MIN(etag) AS etag FROM ratings_document WHERE key='letterboxd/facts/links.json'")[0];return {ok:true,proof:await proofOf(lid),links:{fence:{key:'letterboxd/facts/links.json',parts:doc.n,etag:doc.etag},tmdbAlias:null}};},now:()=>new Date(NOW).toISOString()});
  // lid-only first: the inferred import is a conflict with no link and no fact
  assert.equal((await lidOnly('Oz5')).outcome,'admitted_lid_only');
  const blocked=await commit(env,body([item('Oz5','710005')],5));
  assert.equal(blocked.status,200,JSON.stringify(blocked.json));
  assert.deepEqual([blocked.json.conflicts,blocked.json.entries[0].conflict,blocked.json.entries[0].admission],[1,true,'conflict']);
  assert.equal(await Facts.resolveAlias(env,'letterboxd:Oz5'),null,'no link');
  assert.equal(admissionRows(file).filter(entry=>entry.source_code==='Oz5').length,0,'no TMDB admission for the lid');
  assert.deepEqual(films('Oz5').map(entry=>entry.id),['film:lb:Oz5'],'one Film, the lid-only one');
  // inferred first: the lid-only attempt sees the durable admission and stops
  const admitted=await commit(env,body([item('Oz6','710006')],6));
  assert.equal(admitted.json.entries[0].admission,'admitted');
  // the rated admission holds the code, but no trusted `letterboxd` claim of the lid exists yet (the claim unit settles later): ownership is incomplete, so the lid-only attempt FAILS CLOSED (non-terminal), never `present`
  const stop=await lidOnly('Oz6');
  assert.deepEqual([stop.outcome,stop.reason,stop.terminal],['held','ownership_incomplete',false],JSON.stringify(stop));
  sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:710006','letterboxd','Oz6',1,0,'{}')");
  assert.equal((await lidOnly('Oz6')).outcome,'present','with the complete ownership it is present');
  assert.deepEqual(films('Oz6').map(entry=>entry.id),['film:tmdb:710006'],'one Film, the TMDB one');
 }
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

 // (6d) the CRASH GAP: an admission of A from ANOTHER route exists; a genuine check of A writes its intent and the process dies before the evidence write. The intent was written with its evidence obligation, so
 // the restart is NOT settled from the intent: it reacquires the source for real and records the evidence
 reset();
 await seed(env,'hw6d');
 assert.equal((await D1.admitVerifiedFilm(env,{kind:'lid',lid:'hw6d',receipt:{tmdb:'900082',archiveSha256:'a'.repeat(64),title:'Fixture HO',year:2008},now:()=>new Date(NOW).toISOString()})).outcome,'admitted');
 add('hw6d','fixture-h-900082','900082','Fixture HO',2008);
 let dead=false;
 const dying={...env,DB:d1Standin(file,{onBatch:async statements=>{
  const text=statements.map(item=>item.text||'').join('\n');
  // the process dies when the evidence-only operation starts (the first write after the intent) and nothing after it commits
  if(dead||(/canonical_write_receipt/.test(text)&&/evidence:/.test(text))){dead=true;throw new Error('D1_ERROR: process died');}
 }})};
 await Identity.resolve(dying,[{lid:'hw6d',slug:'fixture-h-900082'}],opts({route:'watchlist_admission'}));
 assert.equal(evidence(file).filter(item=>item.subject_value==='hw6d').length,0,'the process died before the evidence write');
 const owed=await entry('hw6d');
 assert.equal(owed.reason,'linking');assert.equal(owed.evidenceDue,true,'the obligation was durable before the first effect');
 calls.length=0;
 // a restart after the dead step's check reservation has expired
 const restarted=await Identity.resolve(env,[{lid:'hw6d',slug:'fixture-h-900082'}],opts({route:'watchlist_admission',clock:()=>NOW+6*60000}));
 assert.equal(restarted.outcomes.get('hw6d').class,'settled',JSON.stringify([...restarted.outcomes]));
 assert.ok(boxdCalls()>0,'not settled from the intent alone: the source is really reacquired');
 assert.deepEqual(evidence(file).filter(item=>item.subject_value==='hw6d').map(item=>item.route),['watchlist_admission'],'and the evidence of the genuine check is recorded');

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
 // the shared Diary check document still holds the entries of the earlier scenarios; this one needs a queue that holds only its own id, whatever the sort order of the runtime
 sqlite(file,"DELETE FROM ratings_document WHERE key='letterboxd/facts/scans/diary-identity.json'");
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

// ===== P1-3 (PR #1018 review): every R2 write of the moved families is preceded by a FRESH marker read; a write routed to R2 earlier is refused after a close or a flip, never switched to D1 =====
{
 reset();
 const SHAP='9'.repeat(64),REGISTRY_KEY='letterboxd/imports/registry.json',CAND='letterboxd/imports/'+SHAP+'/rated-candidates.json';
 const markerMover=(f,nth,toD1=false)=>{let reads=0,moved=false;return {moved:()=>moved,env:{DB:d1Standin(f,{onQuery:async text=>{
  if(!moved&&/FROM letterboxd_admission_authority/.test(text)&&++reads===nth){moved=true;sqlite(f,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1"+(toD1?";UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'":''));}
 }}),BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'fixture-token'}};};
 const rowsOf=code=>[{code,disposition:'pending',reason:null,rating:4,name:'Fixture '+code,year:2001,historicalTmdb:null}];
 // the candidate document: the routing read is the first marker read, the guard right before the PUT the second
 for(const toD1 of [false,true]){
  const f=fresh('r2');
  if(toD1)setDocD1(f,MANIFEST,EMPTY_MANIFEST);
  r2.clear();puts.length=0;
  const mover=markerMover(f,2,toD1);
  await assert.rejects(()=>Candidates.registerCandidates(mover.env,{sha:SHAP,generatedAt:'2026-11-20T10:00:00.000Z',chunk:0,rows:rowsOf('lg1')}),error=>error.code==='letterboxd_admission_closed');
  assert.equal(mover.moved(),true);
  assert.deepEqual(puts.filter(key=>key===CAND),[],'no R2 put of the candidate document after the marker moved '+(toD1?'(d1)':'(closed)'));
  assert.equal(rows(f,"SELECT COUNT(*) AS n FROM ratings_document WHERE key="+sqlText(CAND))[0].n,0,'and the write was not switched to D1');
 }
 // the registry projection is a legacy R2 write too: the marker moves after the candidate write and before the registry PUT -> the candidate document stands, the registry is not written
 {
  const f=fresh('r2');r2.clear();puts.length=0;
  const mover=markerMover(f,3);
  const saved=await Candidates.registerCandidates(mover.env,{sha:SHAP,generatedAt:'2026-11-20T10:00:00.000Z',chunk:0,rows:rowsOf('lg2')});
  assert.equal(mover.moved(),true);assert.equal(saved.changed,true,'the primary write stands');
  assert.ok(puts.includes(CAND),'the candidate document was written at r2');
  assert.equal(puts.includes(REGISTRY_KEY),false,'the derived registry projection was refused by its own fresh guard');
 }
 // the inferred chunk intent (a chunk WITHOUT an admit item, which the closed check at the top does not cover): its R2 PUT is guarded too
 {
  const f=fresh('r2');r2.clear();puts.length=0;
  // marker reads of this path: the replay read of the receipt (1), the route of the intent write (2), and the guard right before its PUT (3): the marker moves just before the guard
  const mover=markerMover(f,3);
  const response=await Facts.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin:{archiveSha256:SHAP,generatedAt:'2026-11-20T10:00:00.000Z',generatedAtSource:'archive_name'},chunk:7,items:[{lid:'lh1',facts:{watched:true},tmdb:'900190',identity:'inferred'}]})}),mover.env,'/api/letterboxd/baseline/commit');
  assert.equal(mover.moved(),true);assert.equal(response.status,409,JSON.stringify(await response.json()));
  assert.equal(puts.some(key=>key.includes('/chunks/7.')),false,'no R2 put of the chunk intent or receipt after the marker moved');
  assert.equal(rows(f,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE '%/chunks/7.%'")[0].n,0,'and nothing was switched to D1');
 }
}

// ===== PR #1018 review: the owned movie ids are read in keyset pages, complete however many Films are admitted (no 50,000 business cap) =====
{
 const f=fresh('d1'),big={DB:d1Standin(f)};
 const N=12003;
 sqlite(f,"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<"+N+") INSERT INTO film (id,contract_version,canonical_identity,updated_at) SELECT 'film:tmdb:'||(800000+i),1,'tmdb:'||(800000+i),'"+STAMP+"' FROM n;"
  +"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<"+N+") INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) SELECT 'film:tmdb:'||(800000+i),''||(800000+i),'bulk'||i,'"+'a'.repeat(64)+"','T',1999,'d1','tmdb_'||(800000+i),'"+STAMP+"','bulk-'||i,'"+STAMP+"' FROM n;");
 const all=await D1.admittedMovieIds(big);
 assert.equal(all.length,N,'every admitted movie id, across three pages');
 assert.equal(new Set(all).size,N);
 const without=await D1.admittedMovieIds(big,{exceptCode:'bulk7'});
 assert.equal(without.length,N-1);assert.equal(without.includes('800007'),false,'the admission of the excepted code is left out');
}

// ===== AIR-673 / ADR 0217 decision 9, test 14: the rated archive candidate of a lid-only Film, and the Diary on a lid already admitted lid-only (DORMANT: H1 rules are supplied by the test only) =====
{
 const SHA='e'.repeat(64),KEY='letterboxd/imports/'+SHA+'/rated-candidates.json';
 const RULES={eligibleTypes:['video.movie'],idBlockMarker:'<section class="film-ids">'};
 const noTmdbPage=(lid,slug,title,year)=>'<html><head><link rel="canonical" href="https://letterboxd.com/film/'+slug+'/"><link rel="shortlink" href="https://boxd.it/'+lid+'"><meta property="og:type" content="video.movie"><meta property="og:title" content="'+title+' ('+year+')"><script type="application/ld+json">'+JSON.stringify({name:title,releasedEvent:[{startDate:String(year)}]})+'</script></head><body class="film"><section class="film-ids"></section></body></html>';
 const addNoTmdb=(lid,slug,title='Lid Only',year=1999)=>site.set(lid,{slug,html:noTmdbPage(lid,slug,title,year)});
 const doc=(code,over={})=>({schemaVersion:1,archiveSha256:SHA,generatedAt:'2026-11-20T10:00:00.000Z',candidates:{[code]:{code,state:'pending',reason:null,rating:4,observedAt:'2026-11-20T10:00:00.000Z',name:'Lid Only',year:1999,historicalTmdb:null,tmdb:null,chunk:0,registeredAt:'2026-11-20T10:00:00.000Z',enrichment:null,...over}},checkpoint:{cursor:null,stopped:null}});
 const rowOf=code=>getDocD1(file,KEY).candidates[code];
 const lidRows=lid=>rows(file,"SELECT film_id,route,receipt_key FROM film_lid_admission WHERE lid='"+lid+"'");
 const factRecord=async lid=>(await Facts.readJSON?.(env,Facts.recordKey('lb-'+lid)))??null;
 const linksDoc=()=>getDocD1(file,'letterboxd/facts/links.json');
 const step=extra=>Candidates.identityStep(env,{sha:SHA,fetchImpl,lidOnlyRules:RULES,...extra});

 // 1. the SHIPPED (empty) rules: a page with no TMDB is never admitted; the delivered terminal review is unchanged.
 reset();
 setDocD1(file,KEY,doc('lo0'));addNoTmdb('lo0','lid-only-1999');
 const refused=await Candidates.identityStep(env,{sha:SHA,fetchImpl});
 assert.equal(refused.verified,false,JSON.stringify(refused));
 assert.equal(rowOf('lo0').state,'needs_review','without rules the page is reviewed, as delivered');
 assert.equal(lidRows('lo0').length,0,'no lid-only admission without H1 rules');

 // 2. with H1 rules: the Film, the proof row, ONE keyed receipt, the rated row verified with tmdb null, the rating under the LID fact key, and no TMDB alias anywhere.
 reset();
 setDocD1(file,KEY,doc('lo1'));addNoTmdb('lo1','lid-only-1999');
 const out=await step();
 assert.equal(out.verified,true,JSON.stringify(out));
 assert.deepEqual([out.tmdb,out.lidOnly,out.filmId],[null,true,'film:lb:lo1']);
 assert.deepEqual(rows(file,"SELECT id FROM film WHERE id='film:lb:lo1'").length,1);
 assert.deepEqual(lidRows('lo1').map(item=>[item.film_id,item.route]),[['film:lb:lo1','letterboxd_rated_archive']]);
 assert.deepEqual(receipts(file).filter(item=>item.operation_key==='admission:lid:lo1').map(item=>item.state),['applied'],'one keyed receipt under the common lid key');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_rated_admission WHERE source_code='lo1'")[0].n,0,'no film_rated_admission row: the Film stays outside the ADR 0211 scope');
 assert.equal(evidence(file).filter(item=>item.subject_value==='lo1').length,0,'K2 writes no evidence row');
 const r=rowOf('lo1');
 assert.deepEqual([r.state,r.kind,r.tmdb,r.intendedTmdb,r.enrichment,r.filmPath],['verified','lid_only',null,null,'done','/film/lid-only-1999/']);
 const links=linksDoc();
 assert.equal(links['letterboxd:lo1'],'lb-lo1','the lid is linked to its own fact key');
 assert.equal(Object.keys(links).some(alias=>alias.startsWith('tmdb:')&&links[alias]==='lb-lo1'),false,'no TMDB alias is invented');
 const fact=getDocD1(file,'letterboxd/facts/films/lb-lo1.json');
 assert.deepEqual([fact.links.letterboxd,fact.links.tmdb,fact.rating?.value,fact.watched?.value],['lo1',null,4,true],'the rating and the watched fact are written under the lid fact key');
 assert.equal(puts.includes(ADMISSIONS),false,'no R2 admissions object');

 // 3. interruption after the canonical batch: the row is `admitting` again, the receipt is applied. The recovery finishes WITHOUT a fetch, a second Film, a second receipt or a second proof row.
 const filmsBefore=JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),lidRows('lo1'),receipts(file)]);
 const interrupted=getDocD1(file,KEY);interrupted.candidates.lo1={...interrupted.candidates.lo1,state:'admitting',tmdb:null,enrichment:'pending'};setDocD1(file,KEY,interrupted);
 calls.length=0;
 const recovered=await step();
 assert.equal(recovered.verified,true,JSON.stringify(recovered));
 assert.deepEqual(calls,[],'recovery from an applied receipt makes no request');
 assert.equal(JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),lidRows('lo1'),receipts(file)]),filmsBefore,'idempotent: nothing is written twice');
 assert.deepEqual([rowOf('lo1').state,rowOf('lo1').kind,rowOf('lo1').tmdb],['verified','lid_only',null]);
 // a replay of the same rating writes no second rating event
 assert.equal(getDocD1(file,'letterboxd/facts/films/lb-lo1.json').rating.value,4);

 // 4. the Diary on a lid ALREADY admitted lid-only, whose page now names a movie (ADR 0217 case 5a): the coordinator answers `present_lid_only`, which only SETTLES. The entry (intent) is cleared with the outcome
 // `lid_only`, the label carries `lidOnly`, NO TMDB alias is written, nothing is attached (never an automatic attach) and no receipt of its own is written.
 add('lo1','lid-only-1999','900150','Lid Only',1999);
 await seed(env,'lo1');
 const receiptsBefore=JSON.stringify(receipts(file)),factsBefore=JSON.stringify(linksDoc()),claimsBefore=JSON.stringify(rows(file,'SELECT film_id,scheme,value,trusted FROM film_external_id ORDER BY film_id,scheme,value'));
 calls.length=0;
 const diary=await Identity.resolve(env,[{lid:'lo1',slug:'lid-only-1999'}],opts({route:'ratings_diary'}));
 const outcome=diary.outcomes.get('lo1');
 assert.deepEqual([outcome.class,outcome.reason],['settled','lid_only'],JSON.stringify([...diary.outcomes]));
 assert.equal(JSON.stringify(diary.labels.get('lo1')),JSON.stringify({title:null,year:null,tmdb:null,lidOnly:true}));
 assert.equal(JSON.stringify(receipts(file)),receiptsBefore,'no receipt of its own');
 assert.equal(JSON.stringify(linksDoc()),factsBefore,'no alias written');
 assert.equal(JSON.stringify(rows(file,'SELECT film_id,scheme,value,trusted FROM film_external_id ORDER BY film_id,scheme,value')),claimsBefore,'no TMDB claim: never an automatic attach');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film WHERE id='film:tmdb:900150'")[0].n,0,'and no second Film for the movie');
 assert.equal((await Facts.diaryLinks(env,['lo1'])).get('lo1').tmdb,null);
 const stored=await Facts.readDiaryIdentity(env);
 assert.ok(!stored.films.lo1,'the Diary entry is cleared with the outcome lid_only');
 // idempotent: a second Diary check settles the same way and changes nothing
 const again=await Identity.resolve(env,[{lid:'lo1',slug:'lid-only-1999'}],opts({route:'ratings_diary'}));
 assert.equal(again.outcomes.get('lo1').reason,'lid_only',JSON.stringify([...again.outcomes]));
 assert.equal(JSON.stringify(receipts(file)),receiptsBefore);
 assert.equal(JSON.stringify(linksDoc()),factsBefore);

 // 5. a changed intent: the row holds a TMDB intent, the page now proves lid-only: reviewed as a changed source, nothing admitted.
 reset();
 setDocD1(file,KEY,doc('lo2',{state:'admitting',intendedTmdb:'900123',filmPath:'/film/other-slug/',enrichment:'pending'}));addNoTmdb('lo2','lid-only-1999');
 const changed=await step();
 assert.equal(rowOf('lo2').state,'needs_review',JSON.stringify(changed));
 assert.equal(rowOf('lo2').reason,'source_changed');
 assert.equal(lidRows('lo2').length,0,'nothing admitted on a changed intent');

 // 6. the Ratings link of the lid already names a movie: held, never admitted lid-only, no Film and no proof row.
 reset();
 await Facts.linkFilm(env,{letterboxd:'lo3',tmdb:'900124'});
 setDocD1(file,KEY,doc('lo3'));addNoTmdb('lo3','lid-only-1999');
 const held=await step();
 assert.notEqual(held.verified,true,JSON.stringify(held));
 assert.equal(lidRows('lo3').length,0);
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film WHERE id='film:lb:lo3'")[0].n,0,'no Film on a lid whose Ratings link names a movie');
 assert.equal(rowOf('lo3').state,'admitting','the row stays in its durable intent for another attempt');
}

// ===== AIR-673 review: races that actually interrupt the rated lid-only settlement, an already-present Film of another route, and the survivor Film after a merge =====
{
 const SHA='f'.repeat(64),KEY='letterboxd/imports/'+SHA+'/rated-candidates.json';
 const RULES={eligibleTypes:['video.movie'],idBlockMarker:'<section class="film-ids">'};
 const page=(lid,slug,title,year)=>'<html><head><link rel="canonical" href="https://letterboxd.com/film/'+slug+'/"><link rel="shortlink" href="https://boxd.it/'+lid+'"><meta property="og:type" content="video.movie"><meta property="og:title" content="'+title+' ('+year+')"><script type="application/ld+json">'+JSON.stringify({name:title,releasedEvent:[{startDate:String(year)}]})+'</script></head><body class="film"><section class="film-ids"></section></body></html>';
 const addPage=(lid,slug,title='Lid Only',year=1999)=>site.set(lid,{slug,html:page(lid,slug,title,year)});
 const doc=(code,over={})=>({schemaVersion:1,archiveSha256:SHA,generatedAt:'2026-11-20T10:00:00.000Z',candidates:{[code]:{code,state:'pending',reason:null,rating:4,observedAt:'2026-11-20T10:00:00.000Z',name:'Lid Only',year:1999,historicalTmdb:null,tmdb:null,chunk:0,registeredAt:'2026-11-20T10:00:00.000Z',enrichment:null,...over}},checkpoint:{cursor:null,stopped:null}});
 const rowOf=code=>getDocD1(file,KEY).candidates[code];
 const lidRows=lid=>rows(file,"SELECT film_id,route,proof_digest FROM film_lid_admission WHERE lid='"+lid+"'");
 const linksDoc=()=>getDocD1(file,'letterboxd/facts/links.json')||{};
 const fresh2=()=>{reset();};
 // A world whose database runs a side effect at a chosen moment, as a competing writer would.
 const hooked=({onBatch=null,onQuery=null}={})=>({DB:d1Standin(file,{onBatch:onBatch?statements=>onBatch(statements.map(item=>item.text)):null,onQuery:onQuery||null}),BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'fixture-token'});
 const stepWith=(e,extra)=>Candidates.identityStep(e,{sha:SHA,fetchImpl,lidOnlyRules:RULES,...extra});
 const proofFor=(lid,slug,title,year)=>vm.runInContext('(async()=>{const html='+JSON.stringify(page(lid,slug,title,year))+';const landing=new URL("https://letterboxd.com/film/'+slug+'/");const evidence=LetterboxdIdentity.pageEvidence(html,landing,letterboxdPageTools());return LetterboxdLidOnlyProof.lidOnlyPageProof({lid:'+JSON.stringify(lid)+',redirect:{status:301},fetched:{html,landing},evidence,rules:'+JSON.stringify(RULES)+',checkedAt:"2026-11-27T10:00:00.000Z"});})()',ctx);
 const admitElsewhere=async(lid,slug,title)=>{
  const proof=await proofFor(lid,slug,title,1999);assert.equal(proof.admits,true);
  const out=await D1.admitVerifiedLidOnly(env,{lid,route:'watchlist_admission',reacquire:async()=>({ok:true,proof:proof.proof,links:await Facts.linksObservation(env,lid)}),now:()=>new Date(NOW).toISOString()});
  assert.equal(out.outcome,'admitted_lid_only',JSON.stringify(out));return {proof,out};
 };

 // R1. The candidate row is REMOVED between the admission and the settlement's own read: the settlement refuses BEFORE any fact is written; the row stays removed and no terminal write lands.
 fresh2();setDocD1(file,KEY,doc('lq1'));addPage('lq1','lid-only-1999');
 let armed=false;
 const r1=await stepWith(hooked({onBatch:texts=>{if(!armed&&texts.some(t=>/INSERT INTO film_lid_admission/.test(t))){armed=true;const d=getDocD1(file,KEY);d.candidates.lq1.state='removed';setDocD1(file,KEY,d);}}}));
 assert.notEqual(r1.verified,true,JSON.stringify(r1));
 assert.equal(rowOf('lq1').state,'removed','a row removed meanwhile is never settled');
 assert.equal(Object.keys(linksDoc()).includes('letterboxd:lq1'),false,'no fact link was written for a candidate that no longer exists');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_rated_admission WHERE source_code='lq1'")[0].n,0);

 // R2. A COMPETING CLAIM of the lid arrives after the coordinator returned and before the settlement batch: the batch's ownership assertion fails and nothing is reported verified.
 fresh2();setDocD1(file,KEY,doc('lq2'));addPage('lq2','lid-only-1999');
 sqlite(file,"INSERT OR IGNORE INTO film (id,contract_version,updated_at) VALUES ('film:other-owner-lq',1,'"+STAMP+"');INSERT OR IGNORE INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:other-owner-lq',1,'"+STAMP+"')");
 let armed2=false,fired2=false;
 const r2=await stepWith(hooked({onBatch:texts=>{if(texts.some(t=>/INSERT INTO film_lid_admission/.test(t)))armed2=true;else if(armed2&&!fired2&&texts.some(t=>/^\s*(INSERT INTO|DELETE FROM) ratings_document/.test(t)&&t.includes('films/lb-lq2'))){fired2=true;sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:other-owner-lq','letterboxd','lq2',0,0)");}}}));
 assert.equal(fired2,true,'the competing claim was injected after the admission');
 assert.notEqual(r2.verified,true,JSON.stringify(r2));
 assert.equal(rowOf('lq2').state,'admitting','the row keeps its durable intent: ownership changed, not verified');
 assert.equal(r2.reason,'ownership_changed',JSON.stringify(r2));

 // R2b. The guard becomes false at EACH effect: no watched, rating, link or projection effect commits after it. (a) the competing claim lands at the FIRST effect (the link batch): nothing at all is written;
 // (b) it lands at the SECOND effect (the record batch): the earlier valid link is kept (never rolled back), the record and its projection are not written.
 const hasLink=lid=>Object.hasOwn(linksDoc(),'letterboxd:'+lid);
 const hasRecord=lid=>getDocD1(file,'letterboxd/facts/films/lb-'+lid+'.json')!==null;
 const viewRows=lid=>rows(file,"SELECT alias_id FROM ratings_view WHERE alias_id='"+lid+"'").length;
 const ownerRow=lid=>sqlite(file,"INSERT OR IGNORE INTO film (id,contract_version,updated_at) VALUES ('film:other-owner-lq',1,'"+STAMP+"');INSERT OR IGNORE INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:other-owner-lq',1,'"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:other-owner-lq','letterboxd','"+lid+"',0,0)");
 const atBatch=(pattern,react)=>{let armed=false,fired=false;return {fired:()=>fired,onBatch:texts=>{if(texts.some(t=>/INSERT INTO film_lid_admission/.test(t)))armed=true;else if(armed&&!fired&&texts.some(t=>/^\s*(INSERT INTO|DELETE FROM) ratings_document/.test(t)&&pattern.test(t))){fired=true;react();}}};};
 for(const [code,pattern,expectLink] of [['lq2a',/letterboxd\/facts\/links\.json/,false],['lq2b',/films\/lb-lq2b/,true]]){
  fresh2();setDocD1(file,KEY,doc(code));addPage(code,'lid-only-1999');
  sqlite(file,"INSERT OR IGNORE INTO film (id,contract_version,updated_at) VALUES ('film:other-owner-lq',1,'"+STAMP+"');INSERT OR IGNORE INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:other-owner-lq',1,'"+STAMP+"')");
  const hook=atBatch(pattern,()=>ownerRow(code));
  const out2=await stepWith(hooked({onBatch:hook.onBatch}));
  assert.equal(hook.fired(),true,code+': the competing claim landed at its effect');
  assert.notEqual(out2.verified,true,JSON.stringify(out2));
  assert.equal(rowOf(code).state,'admitting',code);
  assert.equal(hasLink(code),expectLink,code+': the link effect '+(expectLink?'committed before the guard turned false and is kept':'never committed'));
  assert.equal(hasRecord(code),false,code+': no watched/rating record after the guard became false');
  assert.equal(viewRows(code),0,code+': no projection after the guard became false');
 }

 // R7. The candidate row is REPLACED at the effect (another content, same code): the document fence refuses every effect; nothing new commits and the replaced row is left as it is.
 fresh2();setDocD1(file,KEY,doc('lq7'));addPage('lq7','lid-only-1999');
 const replaced=atBatch(/letterboxd\/facts\/links\.json/,()=>{const d=getDocD1(file,KEY);d.candidates.lq7={...d.candidates.lq7,state:'admitting',kind:'lid_only',intendedTmdb:null,filmPath:'/film/lid-only-1999/',proofDigest:'9'.repeat(64),rating:2};setDocD1(file,KEY,d);});
 const out7=await stepWith(hooked({onBatch:replaced.onBatch}));
 assert.equal(replaced.fired(),true);
 assert.notEqual(out7.verified,true,JSON.stringify(out7));
 assert.equal(rowOf('lq7').proofDigest,'9'.repeat(64),'the replaced row is not overwritten');assert.notEqual(rowOf('lq7').state,'verified');
 assert.deepEqual([Object.hasOwn(linksDoc(),'letterboxd:lq7'),getDocD1(file,'letterboxd/facts/films/lb-lq7.json')!==null,rows(file,"SELECT alias_id FROM ratings_view WHERE alias_id='lq7'").length],[false,false,0],'no link, record or projection committed after the row was replaced');

 // R8. A movie alias onto the SAME `lb-<lid>` key (a Diary-first link shape) appears at the effect: refused at the effect itself; the lid-only contract holds at the write, not only at the read.
 fresh2();setDocD1(file,KEY,doc('lq8'));addPage('lq8','lid-only-1999');
 const aliased=atBatch(/letterboxd\/facts\/links\.json/,()=>setDocD1(file,'letterboxd/facts/links.json',{...linksDoc(),'letterboxd:lq8':'lb-lq8','tmdb:900800':'lb-lq8'}));
 const out8=await stepWith(hooked({onBatch:aliased.onBatch}));
 assert.equal(aliased.fired(),true);assert.notEqual(out8.verified,true,JSON.stringify(out8));
 const out8b=await stepWith(world(file));
 assert.notEqual(out8b.verified,true,JSON.stringify(out8b));
 assert.equal(rowOf('lq8').state,'needs_review',JSON.stringify([out8,out8b]));assert.equal(rowOf('lq8').reason,'ratings_tmdb_link');
 assert.equal(hasRecord('lq8'),false,'no record was written for a lid whose key carries a movie alias');
 // the writers' own contract: a redirected record and a record that carries a movie id are refused at the write
 await Facts.recordObservations(env,'lb-lq9',{letterboxd:'lq9'},[]).catch(()=>null);
 const redirected=getDocD1(file,'letterboxd/facts/films/lb-lq9.json');
 setDocD1(file,'letterboxd/facts/films/lb-lq9.json',{...(redirected||Facts.emptyRecord('lb-lq9',{letterboxd:'lq9'})),redirectTo:'tmdb-900999'});
 await assert.rejects(()=>Facts.recordObservations(env,'lb-lq9',{letterboxd:'lq9'},[],{lidOnly:true}),error=>error.code==='alias_conflict','a redirected record is a conflict, not followed');
 setDocD1(file,'letterboxd/facts/films/lb-lq9.json',{...Facts.emptyRecord('lb-lq9',{letterboxd:'lq9',tmdb:'900999'})});
 await assert.rejects(()=>Facts.recordObservations(env,'lb-lq9',{letterboxd:'lq9'},[],{lidOnly:true}),error=>error.code==='alias_conflict','a record that carries a movie id is a conflict');

 // R10. The row is REPLACED between the coordinator and the settlement's snapshot (same proof and path, ANOTHER rating): the snapshot value is the one the facts derive from and it no longer matches the exact
 // intent, so nothing is written for the stale attempt and the replaced row is neither verified nor reviewed.
 fresh2();setDocD1(file,KEY,doc('lq10'));addPage('lq10','lid-only-1999');
 let armed10=false,fired10=false;
 const replaced10=await stepWith(hooked({
  onBatch:texts=>{if(texts.some(t=>/INSERT INTO film_lid_admission/.test(t)))armed10=true;},
  onQuery:text=>{if(armed10&&!fired10&&/FROM ratings_document/.test(text)&&text.includes('rated-candidates.json')){fired10=true;const d=getDocD1(file,KEY);d.candidates.lq10={...d.candidates.lq10,rating:2};setDocD1(file,KEY,d);}}}));
 assert.equal(fired10,true,'the replacement landed between the coordinator and the snapshot');
 assert.notEqual(replaced10.verified,true,JSON.stringify(replaced10));
 assert.deepEqual([rowOf('lq10').state,rowOf('lq10').rating],['admitting',2],'the replaced row is neither verified nor reviewed by the stale attempt');
 assert.deepEqual([hasLink('lq10'),hasRecord('lq10'),viewRows('lq10')],[false,false,0],'no facts for the replaced row');

 // R11. The row is replaced AFTER a valid earlier effect (the link) and before the next effect: the document fence refuses the later effects and the terminal settlement; the valid link is kept.
 fresh2();setDocD1(file,KEY,doc('lq11'));addPage('lq11','lid-only-1999');
 const swap=atBatch(/films\/lb-lq11/,()=>{const d=getDocD1(file,KEY);d.candidates.lq11={...d.candidates.lq11,rating:3.5};setDocD1(file,KEY,d);});
 const out11=await stepWith(hooked({onBatch:swap.onBatch}));
 assert.equal(swap.fired(),true);
 assert.notEqual(out11.verified,true,JSON.stringify(out11));
 assert.deepEqual([rowOf('lq11').state,rowOf('lq11').rating],['admitting',3.5],'the replaced row is not verified or reviewed');
 assert.equal(hasLink('lq11'),true,'the valid earlier link is kept');
 assert.deepEqual([hasRecord('lq11'),viewRows('lq11')],[false,0],'no record or projection after the replacement');

 // R12. A movie alias onto the SAME key appears AFTER the lid-only link and before the record batch: the positive links fence of the later batches refuses it; the next ordinary step reviews the row.
 fresh2();setDocD1(file,KEY,doc('lq12'));addPage('lq12','lid-only-1999');
 const late=atBatch(/films\/lb-lq12/,()=>setDocD1(file,'letterboxd/facts/links.json',{...linksDoc(),'tmdb:900812':'lb-lq12'}));
 const out12=await stepWith(hooked({onBatch:late.onBatch}));
 assert.equal(late.fired(),true);assert.notEqual(out12.verified,true,JSON.stringify(out12));
 assert.deepEqual([hasRecord('lq12'),viewRows('lq12')],[false,0],'no record or projection onto a key that carries a movie alias');
 const out12b=await stepWith(world(file));
 assert.notEqual(out12b.verified,true,JSON.stringify(out12b));
 assert.equal(rowOf('lq12').state,'needs_review',JSON.stringify([out12,out12b]));assert.equal(rowOf('lq12').reason,'ratings_tmdb_link');
 assert.equal(hasRecord('lq12'),false);

 // R13. An INTERRUPTED PRESENT settlement (the exact R4 shape): another route proved the Film (digest Y), this candidate's own check produced X and its intent X is persisted; the first attempt dies at the link batch.
 // The unchanged source is run again: the fresh check still matches X and the Film is independently present, so it settles on current ownership ALONE (no receipt of its own, none invented), not `source_changed`.
 fresh2();
 const otherY=await admitElsewhere('lq13','lid-only-1999','Other Title');
 setDocD1(file,KEY,doc('lq13'));addPage('lq13','lid-only-1999','Lid Only');
 const receipts13=receipts(file,'admission:lid:lq13').length;
 let crashed13=0;
 const dying={DB:d1Standin(file,{onBatch:statements=>{const texts=statements.map(item=>item.text);if(!crashed13&&texts.some(t=>/^\s*(INSERT INTO|DELETE FROM) ratings_document/.test(t)&&/letterboxd\/facts\/links\.json/.test(t))){crashed13++;throw new Error('D1_ERROR: process lost');}}}),BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'fixture-token'};
 await stepWith(dying).catch(()=>null);
 assert.equal(crashed13,1,'the first attempt died at the link batch');
 assert.equal(rowOf('lq13').state,'admitting');assert.notEqual(rowOf('lq13').proofDigest,otherY.proof.proof.proofDigest,'the candidate holds its OWN intent X, the Film holds proof Y');
 assert.equal(hasLink('lq13'),false);
 calls.length=0;
 const again13=await stepWith(world(file));
 assert.equal(again13.verified,true,JSON.stringify(again13));
 assert.equal(rowOf('lq13').state,'verified');assert.equal(rowOf('lq13').filmId,'film:lb:lq13');
 assert.equal(receipts(file,'admission:lid:lq13').length,receipts13,'no receipt of its own was created or invented');
 assert.equal(lidRows('lq13')[0].proof_digest,otherY.proof.proof.proofDigest,'the proof row stays the other route\'s');

 // R14. The terminal disposition carries the EXACT candidate: a row replaced right before the terminal write of a coordinator conflict is neither reviewed nor reported reviewed by the stale attempt.
 fresh2();setDocD1(file,KEY,doc('lq14'));addPage('lq14','lid-only-1999');
 sqlite(file,"INSERT OR IGNORE INTO film (id,contract_version,updated_at) VALUES ('film:other-owner-lq',1,'"+STAMP+"');INSERT OR IGNORE INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:other-owner-lq',1,'"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:other-owner-lq','letterboxd','lq14',0,0)");
 let seen14=0,fired14=false;
 const out14=await stepWith(hooked({onBatch:texts=>{if(texts.some(t=>/^\s*(INSERT INTO|DELETE FROM) ratings_document/.test(t)&&/rated-candidates\.json/.test(t))){seen14++;if(seen14===2&&!fired14){fired14=true;const d=getDocD1(file,KEY);d.candidates.lq14={...d.candidates.lq14,rating:1.5};setDocD1(file,KEY,d);}}}}));
 assert.equal(fired14,true,'the replacement landed right before the terminal write');
 assert.notEqual(rowOf('lq14').state,'needs_review',JSON.stringify(out14));
 assert.equal(rowOf('lq14').rating,1.5,'the replaced row is left as it is');

 // R15. The post-link observation must show that the LID maps to the key just linked: a remap of `letterboxd:<lid>` between the link and the observation is refused before the record batch.
 fresh2();setDocD1(file,KEY,doc('lq15'));addPage('lq15','lid-only-1999');
 let linked15=false,fired15=false;
 const out15=await stepWith(hooked({
  onBatch:texts=>{if(texts.some(t=>/^\s*(INSERT INTO|DELETE FROM) ratings_document/.test(t)&&/letterboxd\/facts\/links\.json/.test(t)&&!/film_lid_admission/.test(t)))linked15=true;},
  onQuery:text=>{if(linked15&&!fired15&&/FROM ratings_document/.test(text)&&text.includes('letterboxd/facts/links.json')){fired15=true;setDocD1(file,'letterboxd/facts/links.json',{...linksDoc(),'letterboxd:lq15':'tmdb-900777'});}}}));
 assert.equal(fired15,true,'the remap landed between the link and its observation');
 assert.notEqual(out15.verified,true,JSON.stringify(out15));
 assert.deepEqual([hasRecord('lq15'),viewRows('lq15')],[false,0],'no record or projection while the lid maps to another key');

 // R16. REPLACEMENT BEFORE THE CLAIM: a recovering LID-only row (intent A) is read and its source checked; before the claim CAS another writer replaces it with intent B. The CAS sees B, which is not the original:
 // `claim_changed`: B is not reviewed, charged or settled on the old observer's behalf.
 fresh2();
 setDocD1(file,KEY,doc('lq16',{state:'admitting',kind:'lid_only',intendedTmdb:null,filmPath:'/film/lid-only-1999/',proofDigest:'a'.repeat(64),enrichment:'pending'}));addPage('lq16','lid-only-1999');
 let swapped16=false;
 const out16=await stepWith(hooked({onBatch:texts=>{if(!swapped16&&texts.some(t=>/^\s*(INSERT INTO|DELETE FROM) ratings_document/.test(t)&&/rated-candidates\.json/.test(t))){swapped16=true;const d=getDocD1(file,KEY);d.candidates.lq16={...d.candidates.lq16,proofDigest:'b'.repeat(64)};setDocD1(file,KEY,d);}}}));
 assert.equal(swapped16,true,'the replacement landed before the claim CAS');
 assert.notEqual(rowOf('lq16').state,'needs_review',JSON.stringify(out16));
 assert.deepEqual([rowOf('lq16').state,rowOf('lq16').proofDigest,rowOf('lq16').sourceAttempts??0],['admitting','b'.repeat(64),0],'the replacement is neither reviewed nor charged');
 assert.equal(lidRows('lq16').length,0);

 // R17. CONTROL, the reverse direction on an UNCHANGED row: a LID-only intent row meets a page that now names a movie. The row is still the original and the source really changed: `source_changed`.
 fresh2();
 add('lq17','mismatch-r17-2001','900917','Mismatch R17',2001);
 setDocD1(file,KEY,doc('lq17',{state:'admitting',kind:'lid_only',intendedTmdb:null,filmPath:'/film/mismatch-r17-2001/',proofDigest:'a'.repeat(64),enrichment:'pending',name:'Mismatch R17',year:2001}));
 const out17=await stepWith(world(file));
 assert.equal(rowOf('lq17').state,'needs_review',JSON.stringify(out17));assert.equal(rowOf('lq17').reason,'source_changed');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_rated_admission WHERE source_code='lq17'")[0].n,0,'the LID-only intent never lets the movie be admitted');

 // R3. A Ratings alias to a MOVIE appears after the admission and before the facts link: reviewed (`ratings_tmdb_link`), never a TMDB-linked record reported as the lid's own.
 fresh2();setDocD1(file,KEY,doc('lq3'));addPage('lq3','lid-only-1999');
 let armed3=false,fired3=false;
 const r3=await stepWith(hooked({onBatch:texts=>{if(texts.some(t=>/INSERT INTO film_lid_admission/.test(t)))armed3=true;else if(armed3&&!fired3&&texts.some(t=>/^\s*(INSERT INTO|DELETE FROM) ratings_document/.test(t)&&t.includes('letterboxd/facts/links.json'))){fired3=true;setDocD1(file,'letterboxd/facts/links.json',{...linksDoc(),'letterboxd:lq3':'tmdb-900300','tmdb:900300':'tmdb-900300'});}}}));
 assert.equal(fired3,true);
 assert.notEqual(r3.verified,true,JSON.stringify(r3));
 assert.notEqual(rowOf('lq3').state,'verified','a TMDB-linked record is never reported as the lid\'s own');
 // the next ordinary step (no competing writer) reconciles the applied receipt, meets the same alias and reviews the row
 const r3b=await stepWith(world(file));
 assert.notEqual(r3b.verified,true,JSON.stringify(r3b));
 assert.equal(rowOf('lq3').state,'needs_review',JSON.stringify([r3,r3b]));assert.equal(rowOf('lq3').reason,'ratings_tmdb_link');
 assert.equal(linksDoc()['letterboxd:lq3'],'tmdb-900300','our write did not touch the alias that appeared');
 assert.equal(Object.values(linksDoc()).includes('lb-lq3'),false);
 // and the guard itself: a lid whose record is a movie's is refused by the lid-only link writer
 await assert.rejects(()=>Facts.linkLidOnly(env,'lq3'),error=>error.code==='alias_conflict');

 // R4. An ALREADY-PRESENT Film admitted by ANOTHER route (a different proof digest): settled as present, with no receipt of its own and no TMDB alias; the resolved Film id is the proof row's.
 fresh2();
 const other=await admitElsewhere('lq4','lid-only-1999','Other Title');
 const receiptsBefore=receipts(file,'admission:lid:lq4').length;
 setDocD1(file,KEY,doc('lq4'));addPage('lq4','lid-only-1999','Lid Only');
 const r4=await stepWith(world(file));
 assert.equal(r4.verified,true,JSON.stringify(r4));
 assert.equal(r4.filmId,'film:lb:lq4');
 assert.equal(receipts(file,'admission:lid:lq4').length,receiptsBefore,'no receipt of its own for a present Film');
 assert.equal(lidRows('lq4')[0].proof_digest,other.proof.proof.proofDigest,'the proof row stays the first route\'s');
 assert.notEqual(rowOf('lq4').proofDigest,other.proof.proof.proofDigest,'the candidate carries its own page digest');
 assert.deepEqual([rowOf('lq4').state,rowOf('lq4').tmdb,rowOf('lq4').filmId],['verified',null,'film:lb:lq4']);

 // R5. After a MERGE the proof row and the claim name an arbitrary survivor: the settlement uses the coordinator's resolved Film id, not `film:lb:<lid>`.
 fresh2();
 await admitElsewhere('lq5','lid-only-1999','Other Title');
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:survivor-lq5',1,'"+STAMP+"');INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:survivor-lq5',1,'"+STAMP+"');DELETE FROM film_external_id WHERE film_id='film:lb:lq5' AND scheme='letterboxd';INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:survivor-lq5','letterboxd','lq5',1,0);UPDATE film_lid_admission SET film_id='film:survivor-lq5' WHERE lid='lq5';INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb:lq5','film:survivor-lq5','"+STAMP+"')");
 setDocD1(file,KEY,doc('lq5'));addPage('lq5','lid-only-1999','Lid Only');
 const r5=await stepWith(world(file));
 assert.equal(r5.verified,true,JSON.stringify(r5));
 assert.equal(r5.filmId,'film:survivor-lq5');assert.equal(rowOf('lq5').filmId,'film:survivor-lq5');

 // R6. A REAL mismatched intent: the row holds a lid-only intent for ANOTHER page digest; the page now proves a different digest: `source_changed`, nothing admitted.
 fresh2();
 setDocD1(file,KEY,doc('lq6',{state:'admitting',kind:'lid_only',intendedTmdb:null,filmPath:'/film/lid-only-1999/',proofDigest:'0'.repeat(64),enrichment:'pending'}));addPage('lq6','lid-only-1999');
 const r6=await stepWith(world(file));
 assert.equal(rowOf('lq6').state,'needs_review',JSON.stringify(r6));assert.equal(rowOf('lq6').reason,'source_changed');
 assert.equal(lidRows('lq6').length,0);
}

// ===== AIR-673 review: the Diary and the Watchlist ledger on a FRESH H1 lid-only admission (injected synthetic rules; the shipped rules stay empty), its recovery, and the current-ownership fence of both settlements =====
{
 const RULES={eligibleTypes:['video.movie'],idBlockMarker:'<section class="film-ids">'};
 const page=(lid,slug,title,year)=>'<html><head><link rel="canonical" href="https://letterboxd.com/film/'+slug+'/"><link rel="shortlink" href="https://boxd.it/'+lid+'"><meta property="og:type" content="video.movie"><meta property="og:title" content="'+title+' ('+year+')"><script type="application/ld+json">'+JSON.stringify({name:title,releasedEvent:[{startDate:String(year)}]})+'</script></head><body class="film"><section class="film-ids"></section></body></html>';
 const addPage=(lid,slug,title='Lid Only',year=1999)=>site.set(lid,{slug,html:page(lid,slug,title,year)});
 const linksDoc=()=>getDocD1(file,'letterboxd/facts/links.json')||{};
 const entry=async lid=>(await Facts.readDiaryIdentity(env)).films[lid]||null;
 const lidRows=lid=>rows(file,"SELECT film_id FROM film_lid_admission WHERE lid='"+lid+"'");
 const diary=(e,lid,slug,extra={})=>Identity.resolve(e,[{lid,slug}],opts({route:'ratings_diary',lidOnlyRules:RULES,...extra}));
 const hooked=({onBatch})=>({DB:d1Standin(file,{onBatch:statements=>onBatch(statements.map(item=>item.text))}),BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'fixture-token'});

 // D1. A fresh H1 page through the Diary: admitted by the `lid_only` kind under the common key, ONE applied receipt, the entry cleared, the label `lidOnly`, no alias, the ownership assertion handed on.
 reset();
 await seed(env,'dq1');addPage('dq1','diary-lid-only-1999');
 const first=await diary(env,'dq1','diary-lid-only-1999');
 const o1=first.outcomes.get('dq1');
 assert.deepEqual([o1.class,o1.reason],['settled','lid_only'],JSON.stringify([...first.outcomes]));
 assert.equal(JSON.stringify(first.labels.get('dq1')),JSON.stringify({title:null,year:null,tmdb:null,lidOnly:true}));
 assert.ok(Array.isArray(o1.ownerGuard),'the Watchlist ledger receives the current-ownership assertion');
 assert.deepEqual(lidRows('dq1').map(r=>r.film_id),['film:lb:dq1']);
 assert.deepEqual(receipts(file,'admission:lid:dq1').map(r=>r.state),['applied'],'one applied receipt of its own');
 assert.equal((await Facts.diaryLinks(env,['dq1'])).get('dq1').tmdb,null);
 assert.equal(Object.keys(linksDoc()).some(alias=>alias==='tmdb:900150'),false);
 assert.equal(await entry('dq1'),null,'the intent is cleared with the outcome lid_only');

 // D2. Recovery: the admission applied, the entry (the durable intent) survived a crash. The next step settles it from the applied receipt, with the same single receipt and no second Film.
 const before=JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),receipts(file,'admission:lid:dq1'),lidRows('dq1')]);
 await Facts.updateDiaryIdentity(env,{set:{dq1:{reason:'lid_only_intent',class:'intent',kind:'lid_only',tmdb:null,proofDigest:rows(file,"SELECT proof_digest FROM film_lid_admission WHERE lid='dq1'")[0].proof_digest,slug:'diary-lid-only-1999',attempts:0,streak:0,queuedAt:new Date(NOW).toISOString(),lastAttemptAt:new Date(NOW).toISOString(),nextAttemptAt:new Date(NOW).toISOString(),route:'ratings_diary'}},expect:{dq1:null}});
 assert.equal((await entry('dq1')).reason,'lid_only_intent');
 calls.length=0;
 const again=await diary(env,'dq1','diary-lid-only-1999');
 assert.deepEqual(calls,[],'lost-response recovery of the persisted LID intent makes NO source request');
 assert.deepEqual([again.outcomes.get('dq1').class,again.outcomes.get('dq1').reason],['settled','lid_only'],JSON.stringify([...again.outcomes]));
 assert.equal(await entry('dq1'),null,'the recovered intent is cleared');
 assert.equal(JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),receipts(file,'admission:lid:dq1'),lidRows('dq1')]),before,'idempotent: nothing written twice');

 // D2b. A DIFFERENT durable digest with an existing applied receipt: the persisted intent names ANOTHER proof than the applied attempt. It is a changed source: never settled as this caller's replay, never silently a present result.
 reset();
 await seed(env,'dq6');addPage('dq6','diary-lid-only-1999');
 assert.equal((await diary(env,'dq6','diary-lid-only-1999')).outcomes.get('dq6').reason,'lid_only');
 const filmsAt6=JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),receipts(file,'admission:lid:dq6'),lidRows('dq6')]);
 await Facts.updateDiaryIdentity(env,{set:{dq6:{reason:'lid_only_intent',class:'intent',kind:'lid_only',tmdb:null,proofDigest:'f'.repeat(64),slug:'diary-lid-only-1999',attempts:0,streak:0,queuedAt:new Date(NOW).toISOString(),lastAttemptAt:new Date(NOW).toISOString(),nextAttemptAt:new Date(NOW).toISOString(),route:'ratings_diary'}},expect:{dq6:null}});
 const mism=await diary(env,'dq6','diary-lid-only-1999');
 assert.notEqual(mism.outcomes.get('dq6').class,'settled',JSON.stringify([...mism.outcomes]));
 assert.equal(mism.labels.has('dq6'),false,'a mismatched intent is never reinterpreted as a present result');
 assert.equal((await entry('dq6')).reason,'source_changed');
 assert.equal(JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),receipts(file,'admission:lid:dq6'),lidRows('dq6')]),filmsAt6,'nothing admitted or written');

 // D2c. The mismatch in BOTH directions, through the real entry point. (i) A LID-only intent meets a page that now names a movie. (ii) A TMDB intent meets a page that now proves a lid-only Film.
 reset();
 await seed(env,'dq7');add('dq7','mismatch-a-2001','900401','Mismatch A',2001);
 await Facts.updateDiaryIdentity(env,{set:{dq7:{reason:'lid_only_intent',class:'intent',kind:'lid_only',tmdb:null,proofDigest:'e'.repeat(64),slug:'mismatch-a-2001',attempts:0,streak:0,queuedAt:new Date(NOW).toISOString(),lastAttemptAt:new Date(NOW).toISOString(),nextAttemptAt:new Date(NOW).toISOString(),route:'ratings_diary'}},expect:{dq7:null}});
 const lidThenTmdb=await diary(env,'dq7','mismatch-a-2001');
 assert.notEqual(lidThenTmdb.outcomes.get('dq7').class,'settled',JSON.stringify([...lidThenTmdb.outcomes]));
 assert.equal((await entry('dq7')).reason,'source_changed');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_rated_admission WHERE source_code='dq7'")[0].n,0,'the LID-only intent never lets the TMDB movie be admitted');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film WHERE id='film:tmdb:900401'")[0].n,0);
 await seed(env,'dq8');addPage('dq8','mismatch-b-1999');
 await Facts.updateDiaryIdentity(env,{set:{dq8:{reason:'linking',class:'intent',tmdb:'900402',slug:'mismatch-b-1999',attempts:0,streak:0,queuedAt:new Date(NOW).toISOString(),lastAttemptAt:new Date(NOW).toISOString(),nextAttemptAt:new Date(NOW).toISOString(),route:'ratings_diary'}},expect:{dq8:null}});
 const tmdbThenLid=await diary(env,'dq8','mismatch-b-1999');
 assert.notEqual(tmdbThenLid.outcomes.get('dq8').class,'settled',JSON.stringify([...tmdbThenLid.outcomes]));
 assert.equal(lidRows('dq8').length,0,'the TMDB intent never lets a lid-only Film be admitted');
 assert.equal((await entry('dq8')).reason,'source_changed');

 // D2d. A persisted LID-only intent meets a TRUSTED BRIDGE (a canonical Film with both claims): the bridge shortcut performs no check and must NOT overwrite the intent; the ordinary check reconciles it and a
 // mismatching movie is `source_changed` through the fenced finalization (not an uncharged deferral).
 reset();
 await seed(env,'dq9');add('dq9','bridge-lid-2001','900901','Bridge Lid',2001);
 await Facts.updateDiaryIdentity(env,{set:{dq9:{reason:'lid_only_intent',class:'intent',kind:'lid_only',tmdb:null,proofDigest:'d'.repeat(64),slug:'bridge-lid-2001',attempts:0,streak:0,queuedAt:new Date(NOW).toISOString(),lastAttemptAt:new Date(NOW).toISOString(),nextAttemptAt:new Date(NOW).toISOString(),route:'ratings_diary'}},expect:{dq9:null}});
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES ('film:tmdb:900901',1,'tmdb:900901','"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:900901','tmdb','900901',1,0),('film:tmdb:900901','letterboxd','dq9',1,0)");
 const bridged=await diary(env,'dq9','bridge-lid-2001');
 assert.notEqual(bridged.outcomes.get('dq9').class,'settled',JSON.stringify([...bridged.outcomes]));
 assert.equal((await Facts.diaryLinks(env,['dq9'])).get('dq9').tmdb,null,'the bridge shortcut did not link the movie over the LID-only intent');
 assert.equal((await entry('dq9')).reason,'source_changed','the mismatch is finalized, charged, through the fenced path');

 // D2e. An interrupted settlement whose proof belongs to ANOTHER route: the persisted intent names digest X, the Film's proof row and applied receipt are digest Y (independently proved, the page still says Y). It is NOT
 // turned into this caller's own replay (no fabricated receipt): `source_changed`, finalized, nothing written.
 reset();
 await seed(env,'dq10');addPage('dq10','other-route-1999');
 const otherProof=await vm.runInContext('(async()=>{const html='+JSON.stringify(page('dq10','other-route-1999','Lid Only',1999))+';const landing=new URL("https://letterboxd.com/film/other-route-1999/");const evidence=LetterboxdIdentity.pageEvidence(html,landing,letterboxdPageTools());return LetterboxdLidOnlyProof.lidOnlyPageProof({lid:"dq10",redirect:{status:301},fetched:{html,landing},evidence,rules:'+JSON.stringify(RULES)+',checkedAt:"2026-11-27T10:00:00.000Z"});})()',ctx);
 const elsewhere=await D1.admitVerifiedLidOnly(env,{lid:'dq10',route:'watchlist_admission',reacquire:async()=>({ok:true,proof:otherProof.proof,links:await Facts.linksObservation(env,'dq10')}),now:()=>new Date(NOW).toISOString()});
 assert.equal(elsewhere.outcome,'admitted_lid_only');
 const before10=JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),receipts(file,'admission:lid:dq10'),lidRows('dq10')]);
 await Facts.updateDiaryIdentity(env,{set:{dq10:{reason:'lid_only_intent',class:'intent',kind:'lid_only',tmdb:null,proofDigest:'c'.repeat(64),slug:'other-route-1999',attempts:0,streak:0,queuedAt:new Date(NOW).toISOString(),lastAttemptAt:new Date(NOW).toISOString(),nextAttemptAt:new Date(NOW).toISOString(),route:'ratings_diary'}},expect:{dq10:null}});
 const foreign=await diary(env,'dq10','other-route-1999');
 assert.notEqual(foreign.outcomes.get('dq10').class,'settled',JSON.stringify([...foreign.outcomes]));
 assert.equal(foreign.labels.has('dq10'),false);
 assert.equal((await entry('dq10')).reason,'source_changed');
 assert.equal(JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),receipts(file,'admission:lid:dq10'),lidRows('dq10')]),before10,'no receipt fabricated, nothing written');

 // D2f. The equivalent INTERRUPTED PRESENT in the Diary: the persisted intent X, the Film independently proved by another route (digest Y), the page unchanged (still X). Settled on current ownership alone: entry cleared,
 // label `lidOnly`, no receipt of its own created or invented, never `source_changed`.
 reset();
 await seed(env,'dq11');addPage('dq11','present-lid-1999','Lid Only',1999);
 const proofX=await vm.runInContext('(async()=>{const html='+JSON.stringify(page('dq11','present-lid-1999','Lid Only',1999))+';const landing=new URL("https://letterboxd.com/film/present-lid-1999/");const evidence=LetterboxdIdentity.pageEvidence(html,landing,letterboxdPageTools());return LetterboxdLidOnlyProof.lidOnlyPageProof({lid:"dq11",redirect:{status:301},fetched:{html,landing},evidence,rules:'+JSON.stringify(RULES)+',checkedAt:"2026-11-27T10:00:00.000Z"});})()',ctx);
 const proofY=await vm.runInContext('(async()=>{const html='+JSON.stringify(page('dq11','present-lid-1999','Other Title',1999))+';const landing=new URL("https://letterboxd.com/film/present-lid-1999/");const evidence=LetterboxdIdentity.pageEvidence(html,landing,letterboxdPageTools());return LetterboxdLidOnlyProof.lidOnlyPageProof({lid:"dq11",redirect:{status:301},fetched:{html,landing},evidence,rules:'+JSON.stringify(RULES)+',checkedAt:"2026-11-27T10:00:00.000Z"});})()',ctx);
 assert.notEqual(proofX.proof.proofDigest,proofY.proof.proofDigest);
 assert.equal((await D1.admitVerifiedLidOnly(env,{lid:'dq11',route:'watchlist_admission',reacquire:async()=>({ok:true,proof:proofY.proof,links:await Facts.linksObservation(env,'dq11')}),now:()=>new Date(NOW).toISOString()})).outcome,'admitted_lid_only');
 await Facts.updateDiaryIdentity(env,{set:{dq11:{reason:'lid_only_intent',class:'intent',kind:'lid_only',tmdb:null,proofDigest:proofX.proof.proofDigest,slug:'present-lid-1999',attempts:0,streak:0,queuedAt:new Date(NOW).toISOString(),lastAttemptAt:new Date(NOW).toISOString(),nextAttemptAt:new Date(NOW).toISOString(),route:'ratings_diary'}},expect:{dq11:null}});
 const receipts11=receipts(file,'admission:lid:dq11').length;
 const present=await diary(env,'dq11','present-lid-1999');
 assert.deepEqual([present.outcomes.get('dq11').class,present.outcomes.get('dq11').reason],['settled','lid_only'],JSON.stringify([...present.outcomes]));
 assert.equal(JSON.stringify(present.labels.get('dq11')),JSON.stringify({title:null,year:null,tmdb:null,lidOnly:true}));
 assert.equal(receipts(file,'admission:lid:dq11').length,receipts11,'no receipt of its own created or invented');
 assert.equal(await entry('dq11'),null,'the intent is cleared');

 // D3. A COMPETING CLAIM of the lid arrives after the coordinator admitted and before the Diary write: the write's ownership assertion refuses it, the entry (intent) stays and NO settled outcome or label is returned.
 reset();
 await seed(env,'dq3');addPage('dq3','diary-lid-only-1999');
 sqlite(file,"INSERT OR IGNORE INTO film (id,contract_version,updated_at) VALUES ('film:other-owner-dq',1,'"+STAMP+"');INSERT OR IGNORE INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:other-owner-dq',1,'"+STAMP+"')");
 let admitted3=false,fired3=false;
 const raced=await diary(hooked({onBatch:texts=>{if(texts.some(t=>/INSERT INTO film_lid_admission/.test(t)))admitted3=true;else if(admitted3&&!fired3&&texts.some(t=>/diary-identity\.json/.test(t)&&/^\s*(INSERT INTO|DELETE FROM) ratings_document/.test(t))){fired3=true;sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:other-owner-dq','letterboxd','dq3',0,0)");}}}),'dq3','diary-lid-only-1999');
 assert.equal(fired3,true,'the competing claim landed after the admission and before the Diary write');
 const o3=raced.outcomes.get('dq3');
 assert.notEqual(o3.class,'settled',JSON.stringify([...raced.outcomes]));
 assert.equal(raced.labels.has('dq3'),false,'no successful label for another consumer to trust');
 assert.equal(o3.ownerGuard,undefined);
 assert.ok(await entry('dq3'),'the intent entry is kept');

 // D4. The Watchlist ledger over the REAL repository: a fresh H1 lid-only admission settles the row `identity:lid_only` (ownership assertion in the ledger batch); a competing claim between the Diary result and the
 // ledger settlement leaves the row due, never resolved.
 reset();
 sqlite(file,"DELETE FROM ratings_document WHERE key='letterboxd/facts/scans/diary-identity.json'");
 const GUARD='INSERT INTO watchlist_cas (id, ok) SELECT 1, 1 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
 const ledger=()=>Object.fromEntries(rows(file,'SELECT lid,state,attempts,last_reason,resolved_by FROM watchlist_admission_pending').map(r=>[r.lid,r]));
 const bridge=(rules,e=env)=>({MAX_ATTEMPTS:Identity.MAX_ATTEMPTS,resolve:(env2,items,o)=>Identity.resolve(e,items,{...o,fetchImpl,lidOnlyRules:rules}),diaryLinks:(e2,lids)=>Facts.diaryLinks(e2,lids)});
 const wnow=Date.now();
 await seed(env,'dq4');await seed(env,'dq5');addPage('dq4','wl-lid-only-1999');addPage('dq5','wl-lid-only-2000','Lid Only Five',2000);
 const wfilm=(id,slug,year)=>({id,title:'T'+id,year,url:'https://letterboxd.com/film/'+slug+'/'});
 const pub=await WatchlistD1.publishSnapshot(env,[wfilm('dq4','wl-lid-only-1999',1999),wfilm('dq5','wl-lid-only-2000',2000)],{scanId:'sdq',observedAt:'2026-11-27T11:00:00.000Z',runId:'r-sdq',slotKey:'k'},{now:Date.parse('2026-11-27T11:00:00.000Z')});
 assert.equal(pub.ok,true,JSON.stringify(pub));
 const ctxOf=e=>({env:e,epoch:1,now:()=>wnow,deadline:wnow+600000});
 const out=await admissionStep({repository:WatchlistD1,identity:bridge(RULES),epochGuard:()=>[GUARD,[]]})(ctxOf(env),{limit:3,now:wnow});
 assert.equal(out.resolved,2,JSON.stringify(out)+JSON.stringify(ledger()));
 assert.deepEqual([ledger().dq4.state,ledger().dq4.resolved_by],['resolved','identity:lid_only']);
 assert.deepEqual(lidRows('dq4').map(r=>r.film_id),['film:lb:dq4']);
 // a stale ledger: the competing claim lands BETWEEN the Diary result and the ledger batch (injected in that very batch); the ledger refuses and the row stays due
 sqlite(file,"UPDATE watchlist_admission_pending SET state='pending',resolved_by=NULL WHERE lid='dq5'");
 sqlite(file,"INSERT OR IGNORE INTO film (id,contract_version,updated_at) VALUES ('film:other-owner-dq',1,'"+STAMP+"');INSERT OR IGNORE INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:other-owner-dq',1,'"+STAMP+"')");
 let injected=false;
 const ledgerEnv={...env,DB:d1Standin(file,{onBatch:statements=>{const texts=statements.map(item=>item.text);if(!injected&&texts.some(t=>/UPDATE watchlist_admission_pending/.test(t)&&/identity:lid_only/.test(t))){injected=true;sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:other-owner-dq','letterboxd','dq5',0,0)");}}})};
 const stale=await admissionStep({repository:WatchlistD1,identity:bridge(RULES),epochGuard:()=>[GUARD,[]]})(ctxOf(ledgerEnv),{limit:3,now:wnow});
 assert.equal(injected,true,'the competing claim was injected in the ledger batch itself');
 assert.equal(ledger().dq5.state,'pending',JSON.stringify([stale,ledger()]));
 assert.notEqual(ledger().dq5.resolved_by,'identity:lid_only','a competing claim in the ledger batch refuses the settlement');
}


// ===== G. review of PR #1043 (P1, ADR 0217 decision 8b): ONE common normalized root across the REAL page-check callers =====
// The Diary, the Watchlist step and the rated-archive step check the SAME page (one fixture, served by one offline site) on three separate databases. Each writes its evidence row; their roots must be the SAME common root (no route name in it), equal to the
// root the owner re-check computes for that page. The legacy digests stay: the admission receipt digest is the route's own, and the legacy digest rides on the row as route provenance (`source_ref`, never part of the key). No historical receipt is rewritten.
{
 const SHA='e'.repeat(64),KEY='letterboxd/imports/'+SHA+'/rated-candidates.json';
 reset();
 const LID='Cm1',SLUG='fixture-common-2020';
 add(LID,SLUG,'900020','Fixture Common',2020);
 const detail=JSON.parse(movies.get('900020'));
 const expected=(await attachRoot({lid:LID,slug:SLUG,path:'/film/'+SLUG+'/',tmdb:'900020',title:'Fixture Common',year:2020,finalUrl:'https://letterboxd.com/film/'+SLUG+'/',detail})).root;
 assert.match(expected,/^[0-9a-f]{64}$/);
 const legacyDiary=createHash('sha256').update(JSON.stringify({lid:LID,slug:SLUG,path:'/film/'+SLUG+'/',tmdb:'900020',title:'Fixture Common',year:2020,source:'letterboxd_diary_page'})).digest('hex');
 const evRows=db=>rows(db,"SELECT route,method,source_root,source_ref,source_scope,subject_value FROM film_identity_evidence WHERE subject_value='"+LID+"' ORDER BY seq");
 // the Diary
 const diaryDb=fresh('d1'),diaryEnv=world(diaryDb);
 await seed(diaryEnv,LID);
 const viaDiary=await Identity.resolve(diaryEnv,[{lid:LID,slug:SLUG}],opts({route:'ratings_diary'}));
 assert.equal(viaDiary.outcomes.get(LID).class,'settled',JSON.stringify([...viaDiary.outcomes]));
 // the Watchlist step
 const wlDb=fresh('d1'),wlEnv=world(wlDb);
 await seed(wlEnv,LID);
 const viaWatchlist=await Identity.resolve(wlEnv,[{lid:LID,slug:SLUG}],opts({route:'watchlist_admission'}));
 assert.equal(viaWatchlist.outcomes.get(LID).class,'settled',JSON.stringify([...viaWatchlist.outcomes]));
 // the rated archive
 const arDb=fresh('d1'),arEnv=world(arDb);
 setDocD1(arDb,KEY,{schemaVersion:1,archiveSha256:SHA,generatedAt:'2026-11-20T10:00:00.000Z',candidates:{[LID]:{code:LID,state:'pending',reason:null,rating:4,observedAt:'2026-11-20T10:00:00.000Z',name:'Fixture Common',year:2020,historicalTmdb:null,tmdb:null,chunk:0,registeredAt:'2026-11-20T10:00:00.000Z',enrichment:null}},checkpoint:{cursor:null,stopped:null}});
 const viaArchive=await Candidates.identityStep(arEnv,{sha:SHA,fetchImpl});
 assert.equal(viaArchive.verified,true,JSON.stringify(viaArchive));
 const [diary]=evRows(diaryDb),[watchlist]=evRows(wlDb),[archive]=evRows(arDb);
 assert.deepEqual([diary.route,watchlist.route,archive.route],['ratings_diary','watchlist_admission','letterboxd_rated_archive'],'each caller keeps its own route');
 assert.deepEqual([diary.source_root,watchlist.source_root,archive.source_root],[expected,expected,expected],'the SAME common root from the three real callers on one page');
 // route provenance: the legacy digest rides on the row (never part of the key); the archive keeps its own legacy encoding
 assert.equal(diary.source_ref,'diary:'+LID+':legacy:'+legacyDiary);assert.equal(watchlist.source_ref,'diary:'+LID+':legacy:'+legacyDiary);
 assert.match(archive.source_ref,/^archive-step:[0-9a-f]{12}:legacy:[0-9a-f]{64}$/);assert.notEqual(archive.source_ref.split(':legacy:')[1],expected,'the archive legacy digest is another encoding, kept as provenance only');
 // the admission receipt keeps the route's own digest: replay compatibility is untouched
 const archiveRow=rows(diaryDb,"SELECT archive_sha256 FROM film_rated_admission WHERE source_code='"+LID+"'")[0];
 assert.equal(archiveRow.archive_sha256,legacyDiary,'the Diary admission digest is still its legacy page-check digest');
 // the evidence KEY follows the root: the same page by the same route twice is one row; a different route is another row (ADR 0213: independence counts DISTINCT ROOTS, and these are one root)
 assert.equal(new Set([diary.source_root,watchlist.source_root,archive.source_root]).size,1,'three callers, ONE root: no independent corroboration is manufactured');
 // the claim bridge row (Diary and Watchlist) is rooted in the same common root
 const bridge=rows(diaryDb,"SELECT source_root FROM film_identity_evidence WHERE method='alias_bridge' AND object_value='"+LID+"'");
 for(const row of bridge)assert.equal(row.source_root,expected,'the bridge row carries the common root too');
}

// ===== H. review of PR #1043 (P1-1 residual): receipt identity and root compatibility, on ONE database with a PRIOR legacy receipt and evidence =====
{
 reset();
 const LID='Lg1',SLUG='fixture-legacy-2019',TM='900030';
 add(LID,SLUG,TM,'Fixture Legacy',2019);
 const detail=JSON.parse(movies.get(TM));
 const common=(await attachRoot({lid:LID,slug:SLUG,path:'/film/'+SLUG+'/',tmdb:TM,title:'Fixture Legacy',year:2019,finalUrl:'https://letterboxd.com/film/'+SLUG+'/',detail})).root;
 const legacy=createHash('sha256').update(JSON.stringify({lid:LID,slug:SLUG,path:'/film/'+SLUG+'/',tmdb:TM,title:'Fixture Legacy',year:2019,source:'letterboxd_diary_page'})).digest('hex');
 const receipt={tmdb:TM,archiveSha256:legacy,title:'Fixture Legacy',year:2019,filmPath:'/film/'+SLUG+'/'};
 const row=(route,root,extra={})=>({subject:{kind:'letterboxd_lid',value:LID},relation:'same_work',object:{kind:'tmdb_movie',value:TM},polarity:'asserts',route,method:'page_check',sourceRoot:root,sourceRef:'diary:'+LID,observedAt:new Date(NOW).toISOString(),...extra});
 const NEWSTYLE=route=>row(route,common,{legacySourceRoot:legacy,legacyAlternates:[{route:'ratings_diary',sourceRoot:legacy},{route:'watchlist_admission',sourceRoot:legacy}]});
 const stamp=()=>new Date(NOW).toISOString();
 const lidKeyReceipts=db=>rows(db,"SELECT request_id,state,content_digest,operation_key FROM canonical_write_receipt WHERE operation_key='admission:lid:"+LID+"' ORDER BY created_at,request_id");

 // (1) the receipt CONTENT DIGEST: the same check made with the legacy-only input (the code before this change) and with the new input gives the SAME receipt digest
 const oldDb=fresh('d1'),oldEnv=world(oldDb),newDb=fresh('d1'),newEnv=world(newDb);
 const asOld=await D1.admitVerifiedFilm(oldEnv,{kind:'lid',lid:LID,receipt,evidence:row('ratings_diary',legacy),now:()=>stamp()});
 const asNew=await D1.admitVerifiedFilm(newEnv,{kind:'lid',lid:LID,receipt,evidence:NEWSTYLE('ratings_diary'),now:()=>stamp()});
 assert.deepEqual([asOld.outcome,asNew.outcome],['admitted','admitted']);
 assert.equal(lidKeyReceipts(newDb)[0].content_digest,lidKeyReceipts(oldDb)[0].content_digest,'the receipt content digest is the LEGACY-keyed one, byte for byte (replay compatibility), not derived from the common root');
 assert.deepEqual([evidence(oldDb)[0].source_root,evidence(newDb)[0].source_root],[legacy,common],'while the evidence row of the new check is rooted in the common root');

 // (2) a PRIOR legacy receipt and evidence (written by the old code) is recovered by the new code: no new admission, no new receipt, no new evidence row
 const beforeRows=JSON.stringify([admissionRows(oldDb),lidKeyReceipts(oldDb),evidence(oldDb)]);
 const sameRoute=await D1.admitVerifiedFilm(oldEnv,{kind:'lid',lid:LID,receipt,evidence:NEWSTYLE('ratings_diary'),now:()=>stamp()});
 assert.equal(sameRoute.outcome,'present',JSON.stringify(sameRoute));
 assert.equal(JSON.stringify([admissionRows(oldDb),lidKeyReceipts(oldDb),evidence(oldDb)]),beforeRows,'a new check of the same source by the same route adds no row: the legacy root is adopted and its key already exists');
 await seed(oldEnv,LID);
 const real=await Identity.resolve(oldEnv,[{lid:LID,slug:SLUG}],opts({route:'ratings_diary'}));
 assert.equal(real.outcomes.get(LID).class,'settled',JSON.stringify([...real.outcomes]));
 assert.equal(evidence(oldDb).length,1,'the REAL Diary caller on the prior-legacy database also adds no second root');
 assert.equal(lidKeyReceipts(oldDb).length,1,'and no second receipt under the key');

 // (3) the SIBLING route (the legacy digest was shared by the Diary and the Watchlist step): its new check joins the legacy root, so ONE root stands for the source and nothing is counted as independent proof
 const sibling=await D1.admitVerifiedFilm(oldEnv,{kind:'lid',lid:LID,receipt,evidence:NEWSTYLE('watchlist_admission'),now:()=>stamp()});
 assert.equal(sibling.outcome,'present',JSON.stringify(sibling));
 const roots=rows(oldDb,"SELECT route,source_root FROM film_identity_evidence WHERE subject_value='"+LID+"' ORDER BY seq");
 assert.deepEqual(roots.map(r=>r.route),['ratings_diary','watchlist_admission'],'the genuinely new check of another route is its own row');
 assert.equal(new Set(roots.map(r=>r.source_root)).size,1,'but under ONE root: the independence calculation (distinct roots) counts this source once');
 assert.equal(roots[0].source_root,legacy);
 // a repeat of that sibling check is idempotent
 await D1.admitVerifiedFilm(oldEnv,{kind:'lid',lid:LID,receipt,evidence:NEWSTYLE('watchlist_admission'),now:()=>stamp()});
 assert.equal(evidence(oldDb).length,2);

 // (3b) the RATED ARCHIVE on a prior-legacy database (the Diary admission and its LEGACY evidence row written by the old code, no Ratings link yet, so the archive's own import rule lets it check): its own legacy key differs (subject kind,
 // route, encoding, scope) and cannot find the Diary row by itself, but the Diary legacy root of the same page is computable from what the archive holds, so the archive check joins that root: ONE root across the routes
 {
  const legacyDb=fresh('d1'),legacyEnv=world(legacyDb);
  await seed(legacyEnv,LID);
  assert.equal((await D1.admitVerifiedFilm(legacyEnv,{kind:'lid',lid:LID,receipt,evidence:row('ratings_diary',legacy),now:()=>stamp()})).outcome,'admitted');
  const SHA3='1'.repeat(64),KEY3='letterboxd/imports/'+SHA3+'/rated-candidates.json';
  setDocD1(legacyDb,KEY3,{schemaVersion:1,archiveSha256:SHA3,generatedAt:'2026-11-20T10:00:00.000Z',candidates:{[LID]:{code:LID,state:'pending',reason:null,rating:4,observedAt:'2026-11-20T10:00:00.000Z',name:'Fixture Legacy',year:2019,historicalTmdb:null,tmdb:null,chunk:0,registeredAt:'2026-11-20T10:00:00.000Z',enrichment:null}},checkpoint:{cursor:null,stopped:null}});
  const viaArchive=await Candidates.identityStep(legacyEnv,{sha:SHA3,fetchImpl});
  assert.equal(viaArchive.verified,true,JSON.stringify(viaArchive));
  const all=rows(legacyDb,"SELECT route,source_root FROM film_identity_evidence WHERE subject_value='"+LID+"' ORDER BY seq");
  assert.deepEqual(all.map(r=>r.route),['ratings_diary','letterboxd_rated_archive'],'the archive recorded its own evidence row beside the Diary one');
  assert.equal(new Set(all.map(r=>r.source_root)).size,1,'Diary legacy row and the archive check: ONE root: '+JSON.stringify(all));
  assert.equal(all[0].source_root,legacy);
 }
 // (3c) the claim bridge handoff carries the ADOPTED root of the evidence row (the coordinator names it), never an independent common root beside it
 {
  const out=await D1.admitVerifiedFilm(oldEnv,{kind:'lid',lid:LID,receipt,evidence:NEWSTYLE('ratings_diary'),now:()=>stamp()});
  assert.equal(out.evidenceRoot,legacy,'the coordinator hands on the adopted root');
  const fresh2=await D1.admitVerifiedFilm(newEnv,{kind:'lid',lid:LID,receipt,evidence:NEWSTYLE('ratings_diary'),now:()=>stamp()});
  assert.equal(fresh2.evidenceRoot,common,'and the common root where nothing legacy exists');
 }
 // (3d) an uncertain lookup never mints a second root: a failing ledger read is a failure of the check, not "no legacy row"; only an ABSENT ledger means no legacy row
 {
  const flaky=world(oldDb);
  const failing={...flaky,DB:d1Standin(oldDb,{onQuery:async text=>{if(/FROM film_identity_evidence WHERE evidence_key/.test(text))throw new Error('D1_ERROR: read failed');}})};
  await assert.rejects(()=>D1.admitVerifiedFilm(failing,{kind:'lid',lid:LID,receipt,evidence:NEWSTYLE('watchlist_admission'),now:()=>stamp()}),()=>true,'the read failure surfaces');
  assert.equal(new Set(rows(oldDb,"SELECT source_root FROM film_identity_evidence WHERE subject_value='"+LID+"'").map(r=>r.source_root)).size,1,'no second root was minted');
 }

 // (4) a source with NO legacy row records under the common root for every route (the new database above): two routes, one root
 const second=await D1.admitVerifiedFilm(newEnv,{kind:'lid',lid:LID,receipt,evidence:NEWSTYLE('watchlist_admission'),now:()=>stamp()});
 assert.equal(second.outcome,'present');
 assert.deepEqual([...new Set(rows(newDb,"SELECT source_root FROM film_identity_evidence WHERE subject_value='"+LID+"'").map(r=>r.source_root))],[common]);

 // (5) the rated-archive step on a source whose Diary evidence is common-rooted: the verified-row ("already") branch carries the root of the check it really made, so no legacy archive root is written beside it
 const SHA2='f'.repeat(64),KEY2='letterboxd/imports/'+SHA2+'/rated-candidates.json';
 setDocD1(newDb,KEY2,{schemaVersion:1,archiveSha256:SHA2,generatedAt:'2026-11-20T10:00:00.000Z',candidates:{[LID]:{code:LID,state:'pending',reason:null,rating:4,observedAt:'2026-11-20T10:00:00.000Z',name:'Fixture Legacy',year:2019,historicalTmdb:null,tmdb:null,chunk:0,registeredAt:'2026-11-20T10:00:00.000Z',enrichment:null}},checkpoint:{cursor:null,stopped:null}});
 await seed(newEnv,LID);
 const archive=await Candidates.identityStep(newEnv,{sha:SHA2,fetchImpl});
 assert.equal(archive.verified,true,JSON.stringify(archive));
 const archiveRow=rows(newDb,"SELECT source_root,source_ref,source_scope FROM film_identity_evidence WHERE route='letterboxd_rated_archive' AND subject_value='"+LID+"'");
 assert.equal(archiveRow.length,1);assert.equal(archiveRow[0].source_root,common,'the archive check of a page already admitted is rooted in the common root of the check it made');
 assert.match(archiveRow[0].source_ref,/:legacy:[0-9a-f]{64}$/);
 assert.equal(rows(newDb,"SELECT COUNT(DISTINCT source_root) AS n FROM film_identity_evidence WHERE subject_value='"+LID+"'")[0].n,1,'every route, ONE root');
}
console.log('Letterboxd admission callers at r2 and d1 (AIR-602) passed.');
