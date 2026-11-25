// AIR-602 (card A1) / ADR 0207 decision 1 (Accepted): the fences of the LEGACY admission path and the `closed` refusals, on the real migrations (a sqlite D1 stand-in), the real canonical writers and
// the real Letterboxd modules (loaded in a vm with the real marker module). No network, no production, no Task.
// Covered: the legacy D1 batch lands at `r2` and at "migration absent", is refused after a close between its read and its commit (and after a close + reopen), and never lands under `closed` or `d1`;
// the producer refuses admission units under `closed`/`d1` before any plan or receipt while retention keeps running; the R2 PUT of the admissions object is guarded by a FRESH read; the Diary check
// defers every id under `closed` without a request or a write; the baseline commit answers 409 `admission_closed` for a chunk with an `admit` item before its intent; the rated identity step refuses
// before its first effect; an unreadable marker is never read as `r2`; at `r2` (and while the migration is absent) all of them run exactly as before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {installRawViewProjection} from './letterboxd-view-double.mjs';
import {admitRatedFilm} from '../src/film-admission.js';
import {applyFilmAdmission,applyRatedAdmissionRetention} from '../src/canonical-rated-admission-producer.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-admission-closed-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const MARKER=files.indexOf('0044_letterboxd_admission_authority.sql');
assert.ok(MARKER>0);
const withMarker=path.join(root,'with.sqlite'),without=path.join(root,'without.sqlite');
sqlite(withMarker,files.map(read).join('\n'));
sqlite(without,files.slice(0,MARKER).map(read).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"
 +"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');"
 +"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;";
let copies=0;
const fresh=(template=withMarker)=>{const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);sqlite(file,OPEN);return file;};
const STAMP='2026-11-25T10:00:00.000Z',AT='2026-11-25T11:00:00.000Z',SHA='a'.repeat(64);
const setMarker=(file,mode)=>{
 const now=rows(file,'SELECT mode,generation FROM letterboxd_admission_authority WHERE id=1')[0];
 if(mode==='closed')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation="+(now.generation+1));
 else if(mode==='r2')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='r2',generation="+(now.generation+1));
 else sqlite(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation="+(now.generation+1)+",activated_at='"+STAMP+"'");
};
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const receipt=(tmdb,sourceCode)=>({tmdb,sourceCode,archiveSha256:SHA,title:'T'+tmdb,year:1999,filmPath:'/film/t'+tmdb+'/',verifiedAt:'2026-11-01T09:00:00.000Z'});
const admissionRows=file=>rows(file,'SELECT COUNT(*) AS n FROM film_rated_admission')[0].n;
const receiptRows=file=>rows(file,'SELECT COUNT(*) AS n FROM canonical_write_receipt')[0].n;

// ===== 1. the legacy D1 batch (admitRatedFilm): it lands at r2 and at "migration absent", never under closed or d1, and a close between its read and its commit refuses it =====
{
 const f=fresh();
 const env={DB:d1Standin(f)};
 const landed=await admitRatedFilm(env,{receiptKey:'tmdb_11',receipt:receipt('11','sc11'),expectedRevision:0,at:AT,requestId:'r-11'});
 assert.equal(landed.admitted,true,'r2: the legacy batch lands');
 assert.equal(admissionRows(f),1);

 // a close between the read and the commit: the batch is refused by its own assertion (the stand-in flips the marker right before the batch runs)
 const g=fresh();
 let flipped=false;
 const racing={DB:d1Standin(g,{onBatch:async()=>{if(!flipped){flipped=true;setMarker(g,'closed');}}})};
 await assert.rejects(()=>admitRatedFilm(racing,{receiptKey:'tmdb_12',receipt:receipt('12','sc12'),expectedRevision:0,at:AT,requestId:'r-12'}),error=>error.code==='film_person_precondition','a batch planned at r2 cannot commit after the close');
 assert.equal(flipped,true);assert.equal(admissionRows(g),0,'nothing was written');
 // a close and a reopen in between moves the generation: refused too, and a fresh attempt lands
 const h=fresh();
 let again=false;
 const reopened={DB:d1Standin(h,{onBatch:async()=>{if(!again){again=true;setMarker(h,'closed');setMarker(h,'r2');}}})};
 await assert.rejects(()=>admitRatedFilm(reopened,{receiptKey:'tmdb_13',receipt:receipt('13','sc13'),expectedRevision:0,at:AT,requestId:'r-13'}),error=>error.code==='film_person_precondition');
 assert.equal(admissionRows(h),0);
 assert.equal((await admitRatedFilm({DB:d1Standin(h)},{receiptKey:'tmdb_13',receipt:receipt('13','sc13'),expectedRevision:0,at:AT,requestId:'r-13'})).admitted,true,'after the reopen a fresh read lands again');

 // under closed there is no admission batch at all
 {
  const k=fresh();setMarker(k,'closed');
  await assert.rejects(()=>admitRatedFilm({DB:d1Standin(k)},{receiptKey:'tmdb_14',receipt:receipt('14','sc14'),expectedRevision:0,at:AT,requestId:'r-14'}),error=>error.code==='letterboxd_admission_closed'&&error.mode==='closed');
  assert.equal(admissionRows(k),0);assert.equal(receiptRows(k),0);
 }
 // at d1 it is the NEW writer (keep-first, receipt_key d1), never the legacy batch: its row does not name the R2 object
 {
  const k=fresh();setMarker(k,'closed');setMarker(k,'d1');
  const landed=await admitRatedFilm({DB:d1Standin(k)},{receiptKey:'tmdb_14',receipt:receipt('14','sc14'),expectedRevision:0,at:AT,requestId:'r-14'});
  assert.equal(landed.admitted,true);
  assert.equal(rows(k,'SELECT receipt_key FROM film_rated_admission')[0].receipt_key,'d1','at d1 the row says it was not admitted through the R2 receipt');
 }
 // migration absent: the legacy batch lands (commit-time check that the table is still absent), and a batch prepared before the migration was applied cannot commit after it
 const a=fresh(without);
 assert.equal((await admitRatedFilm({DB:d1Standin(a)},{receiptKey:'tmdb_15',receipt:receipt('15','sc15'),expectedRevision:0,at:AT,requestId:'r-15'})).admitted,true,'absent: the legacy batch lands');
 const b=fresh(without);
 let applied=false;
 const late={DB:d1Standin(b,{onBatch:async()=>{if(!applied){applied=true;sqlite(b,read('0044_letterboxd_admission_authority.sql'));}}})};
 await assert.rejects(()=>admitRatedFilm(late,{receiptKey:'tmdb_16',receipt:receipt('16','sc16'),expectedRevision:0,at:AT,requestId:'r-16'}),error=>error.code==='film_person_precondition','the migration applied between the read and the commit refuses the legacy batch');
 assert.equal(admissionRows(b),0);
 // an unreadable marker is never r2
 const c=fresh();
 const real=d1Standin(c);
 const broken={DB:{prepare(sql){if(/AS installed/.test(sql))throw new Error('down');return real.prepare(sql);},batch:statements=>real.batch(statements)}};
 await assert.rejects(()=>admitRatedFilm(broken,{receiptKey:'tmdb_17',receipt:receipt('17','sc17'),expectedRevision:0,at:AT,requestId:'r-17'}),code('letterboxd_admission_unavailable'));
 assert.equal(admissionRows(c),0);
}

// ===== 2. the producer: admission units refuse BEFORE any plan or receipt under closed and d1; retention keeps running; r2 and an absent marker run as before =====
{
 const f=fresh();
 const env=()=>({DB:d1Standin(f)});
 const unit={receiptKey:'tmdb_21',receipt:receipt('21','sc21')};
 const ok=await applyRatedAdmissionRetention(env(),{event:'a:1',admissions:[unit],now:()=>AT});
 assert.equal(ok.state,'complete');assert.equal(ok.applied,1,'r2: the legacy producer admits');
 setMarker(f,'closed');
 const before=[admissionRows(f),receiptRows(f)];
 await assert.rejects(()=>applyRatedAdmissionRetention(env(),{event:'a:2',admissions:[{receiptKey:'tmdb_22',receipt:receipt('22','sc22')}],now:()=>AT}),error=>error.code==='letterboxd_admission_closed'&&error.mode==='closed');
 assert.deepEqual([admissionRows(f),receiptRows(f)],before,'no plan, no receipt, no row');
 // the single-call entry (a reconcile or a direct caller) refuses too, before its plan and its receipt
 await assert.rejects(()=>applyFilmAdmission(env(),{origin:'rated_admission_retention',event:'single',input:{receiptKey:'tmdb_24',receipt:receipt('24','sc24')},now:()=>AT}),error=>error.code==='letterboxd_admission_closed'&&error.mode==='closed');
 assert.deepEqual([admissionRows(f),receiptRows(f)],before,'the single-call entry wrote nothing either');
 // a carried admission unit is refused as a whole too
 await assert.rejects(()=>applyRatedAdmissionRetention(env(),{event:'a:3',intent:[{requestId:'x',operation:'film_admission',origin:'rated_admission_retention',event:'e',target:{kind:'film',id:'film:tmdb:21'},input:{}}],now:()=>AT}),code('letterboxd_admission_closed'));
 // retention is not fenced by this marker: a watchlist observation of the admitted Film still lands under closed
 const kept=await applyRatedAdmissionRetention(env(),{event:'a:4',retentions:[{lid:'sc21',tmdbId:'21',watchlist:true,observedAt:AT,evidence:{scanId:'s'}}],now:()=>AT});
 assert.equal(kept.state,'complete');assert.equal(kept.applied,1,'retention keeps running under closed');
 // d1 is not the legacy path either
 setMarker(f,'d1');
 await assert.rejects(()=>applyRatedAdmissionRetention(env(),{event:'a:5',admissions:[{receiptKey:'tmdb_23',receipt:receipt('23','sc23')}],now:()=>AT}),error=>error.code==='letterboxd_admission_closed'&&error.mode==='d1');
 // an absent marker (the migration is not applied) is the legacy path
 const g=fresh(without);
 const legacy=await applyRatedAdmissionRetention({DB:d1Standin(g)},{event:'a:6',admissions:[unit],now:()=>AT});
 assert.equal(legacy.applied,1,'migration absent: the legacy producer admits');
}

// ===== 3. the Letterboxd modules, with the real marker module on the D1 stand-in =====
const records=new Map(),etags=new Map();let rev=0;
const puts=[];
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++rev));puts.push(key);return {etag:etags.get(key)};},
 async list(){return {objects:[],truncated:false};},
};
const fetches=[];
const ctx=vm.createContext({Response,Headers,URL,Date,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,AbortSignal,crypto:webcrypto,console:{...console,log:()=>{}},
 fetch:async url=>{fetches.push(String(url));throw new Error('unexpected request');}});
const canonical={applied:[]};
ctx.CanonicalCatalogReader={catalogReaderGate:async()=>({mode:'d1',state:'open',generation:2}),catalogFilmIdentityBridge:async()=>({state:'absent'}),catalogTitlesFromD1:async()=>({})};
ctx.CanonicalRatedAdmission={applyRatedAdmissionRetention:async(env,input)=>{canonical.applied.push(input);return {state:'complete',applied:1,failed:0,unknown:0,preflightFailed:0,deferred:0,refused:0,units:[{kind:'film_admission',state:'applied'}]};},assertRatedAdmissionAccepted:out=>out};
const run=file=>vm.runInContext(fs.readFileSync(file,'utf8').replace(/^export default/m,'globalThis.x='),ctx);
run('src/domain/tmdb-tv-identity.js');run('src/sources.js');
vm.runInContext(scoped('src/letterboxd-match.js','LetterboxdMatch')+'\n'+scopedReplacing('src/letterboxd-identity.js','LetterboxdIdentity','const normTitle=LetterboxdMatch.normTitle;\n')+'\n'+scoped('src/domain/letterboxd-rated-admission.js','LetterboxdRatedAdmission')+'\n'+scoped('src/domain/letterboxd-import-registry.js','LetterboxdImportRegistry')+'\n'+scoped('src/film-person-authority.js','FilmPersonAuthority')+'\nconst LetterboxdAdmissionAuthority=(()=>{const {database,failed,one}=FilmPersonAuthority;\n'+fs.readFileSync('src/letterboxd-admission-authority.js','utf8').replace(/^import .*\n/gm,'').replace(/^export /gm,'')+'\nreturn {readAdmissionAuthority,admissionRoute,guardLegacyWrite,admissionRouteNow};})();',ctx);
for(const file of ['src/letterboxd-facts.js','src/letterboxd-rated-candidates.js','src/letterboxd-diary-identity.js'])run(file);
installRawViewProjection(ctx);
const Facts=vm.runInContext('LetterboxdFacts',ctx),Identity=vm.runInContext('LetterboxdDiaryIdentity',ctx),Candidates=vm.runInContext('LetterboxdRatedCandidates',ctx);
const ADMISSIONS='letterboxd/admissions/verified-films.json';
const diaryItem={lid:'Ab1',tmdb:'900001',title:'Fixture',year:1999,filmPath:'/film/fixture/',verifiedAt:STAMP,evidenceSha256:'b'.repeat(64)};

// 3a. the R2 PUT of the admissions object is guarded by a FRESH read
{
 const f=fresh();
 const env={BUCKET:bucket,DB:d1Standin(f),TMDB_API_READ_ACCESS_TOKEN:'t'};
 assert.equal(await Facts.admitDiaryFilm(env,diaryItem),'admitted','r2: the legacy R2 step writes');
 assert.ok(records.get(ADMISSIONS).films.tmdb_900001,'the entry is in the object');
 const before=JSON.stringify(records.get(ADMISSIONS));puts.length=0;
 setMarker(f,'closed');
 await assert.rejects(()=>Facts.admitDiaryFilm(env,{...diaryItem,lid:'Ab2',tmdb:'900002'}),error=>error.code==='letterboxd_admission_closed'&&error.mode==='closed','closed: refused at the PUT');
 await assert.rejects(()=>Facts.admitDiaryFilm(env,{...diaryItem,lid:'Ab3',tmdb:'900003'}),code('letterboxd_admission_closed'),'a request that read r2 earlier still refuses at its own write: the guard reads fresh');
 assert.equal(JSON.stringify(records.get(ADMISSIONS)),before,'the object is byte-identical');assert.deepEqual(puts,[],'no PUT reached the bucket');
 setMarker(f,'r2');
 assert.equal(await Facts.admitDiaryFilm(env,{...diaryItem,lid:'Ab4',tmdb:'900004'}),'admitted','reopen: the legacy step writes again');
 setMarker(f,'closed');setMarker(f,'d1');
 await assert.rejects(()=>Facts.admitDiaryFilm(env,{...diaryItem,lid:'Ab5',tmdb:'900005'}),error=>error.code==='letterboxd_admission_closed'&&error.mode==='d1','after d1 the Worker never writes the object again');
 // an unreadable marker refuses; the object is not touched
 const broken={BUCKET:bucket,DB:{prepare(){throw new Error('down');}}};
 await assert.rejects(()=>Facts.admitDiaryFilm(broken,{...diaryItem,lid:'Ab6',tmdb:'900006'}),code('letterboxd_admission_unavailable'));
 // the migration is absent: the legacy step writes
 const old=fresh(without);
 assert.equal(await Facts.admitDiaryFilm({BUCKET:bucket,DB:d1Standin(old)},{...diaryItem,lid:'Ab7',tmdb:'900007'}),'admitted','migration absent: legacy');
}

// 3b. the Diary check under closed: every id is not-now, no request, no write; r2 runs the delivered code
{
 const f=fresh();
 const env={BUCKET:bucket,DB:d1Standin(f),TMDB_API_READ_ACCESS_TOKEN:'t'};
 setMarker(f,'closed');
 const stored=JSON.stringify([...records.entries()]);fetches.length=0;puts.length=0;
 const out=await Identity.resolve(env,[{lid:'Dz1',slug:'dz-one'},{lid:'Dz2',slug:'dz-two'}],{clock:()=>Date.parse(STAMP),route:'watchlist_admission'});
 for(const lid of ['Dz1','Dz2']){
  const outcome=out.outcomes.get(lid);
  assert.deepEqual([outcome.checked,outcome.class,outcome.reason,outcome.attempts],[false,'not_now','admission_closed',null],lid+': not now, no attempt');
 }
 assert.deepEqual(fetches,[],'no source request');assert.deepEqual(puts,[],'no write: no reservation, no entry, no backlog record');assert.equal(JSON.stringify([...records.entries()]),stored);
 assert.equal(out.counts.checked,0);
 // an unreadable marker is not-now too, and never the legacy path
 const broken=await Identity.resolve({BUCKET:bucket,DB:{prepare(){throw new Error('down');}}},[{lid:'Dz3',slug:'dz-three'}],{clock:()=>Date.parse(STAMP)});
 assert.equal(broken.outcomes.get('Dz3').reason,'admission_unavailable');assert.deepEqual(puts,[]);
 // r2: the delivered code runs (the id is looked up; the page request is attempted, and fails the fixture's unexpected request as a transport stop)
 setMarker(f,'r2');
 const legacy=await Identity.resolve(env,[{lid:'Dz4',slug:'dz-four'}],{clock:()=>Date.parse(STAMP),route:'ratings_diary'});
 assert.notEqual(legacy.outcomes.get('Dz4').reason,'admission_closed','r2 is not closed');
 assert.ok(fetches.length>=1||legacy.outcomes.get('Dz4').class!=='not_now'||legacy.outcomes.get('Dz4').reason!=='admission_unavailable','r2 reaches the source check path');
}

// 3c. the baseline commit: a chunk with an admit item answers 409 admission_closed before its intent
{
 const f=fresh();
 const env={BUCKET:bucket,DB:d1Standin(f)};
 const body=items=>({origin:{archiveSha256:'c'.repeat(64),generatedAt:'2026-11-20T10:00:00.000Z',generatedAtSource:'archive_name'},chunk:0,items});
 const post=async(e,b)=>{const response=await Facts.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),e,'/api/letterboxd/baseline/commit');return {status:response.status,json:await response.json()};};
 const admitItem={lid:'Bz1',facts:{watched:true},tmdb:'700001',identity:'inferred',admit:{title:'Baseline',year:1999}};
 const plainItem={lid:'Bz2',facts:{watched:true}};
 setMarker(f,'closed');
 const stored=JSON.stringify([...records.entries()]);puts.length=0;
 const closed=await post(env,body([admitItem]));
 assert.deepEqual([closed.status,closed.json.code],[409,'admission_closed'],'a chunk with an admit item is refused');
 assert.equal(JSON.stringify([...records.entries()]),stored,'before its intent: nothing is stored');assert.deepEqual(puts,[]);
 const mixed=await post(env,body([plainItem,admitItem]));
 assert.equal(mixed.status,409,'any admit item refuses the whole chunk');assert.deepEqual(puts,[]);
 const unreadable=await post({BUCKET:bucket,DB:{prepare(){throw new Error('down');}}},body([admitItem]));
 assert.deepEqual([unreadable.status,unreadable.json.code],[503,'admission_unavailable'],'an unreadable marker is never the legacy path');
 const noAdmit=await post(env,body([plainItem]));
 assert.notEqual(noAdmit.status,409,'a chunk that admits nothing is not refused by the marker');
 assert.notEqual(noAdmit.json.code,'admission_closed');
 setMarker(f,'r2');
 const open=await post(env,body([{...admitItem,lid:'Bz3',tmdb:'700003'}]));
 assert.notEqual(open.json.code,'admission_closed','r2: the legacy baseline commit is not refused');
}

// 3d. the rated identity step refuses before its first effect under closed
{
 const f=fresh();
 const env={BUCKET:bucket,DB:d1Standin(f),TMDB_API_READ_ACCESS_TOKEN:'t'};
 const sha='d'.repeat(64);
 assert.equal((await Candidates.identityStep(env,{sha})).error,'not_eligible','r2: the delivered step runs (no candidate document: not eligible)');
 setMarker(f,'closed');puts.length=0;fetches.length=0;
 assert.deepEqual({...await Candidates.identityStep(env,{sha})},{error:'admission_closed'},'closed: refused before the first effect');
 assert.deepEqual([puts,fetches],[[],[]]);
 assert.deepEqual({...await Candidates.identityStep({BUCKET:bucket,DB:{prepare(){throw new Error('down');}}},{sha})},{error:'admission_unavailable'});
}

console.log('Letterboxd admission closed fences (AIR-602) passed.');
