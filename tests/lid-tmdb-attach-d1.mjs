// AIR-675 / ADR 0217 (Accepted) delivery step 6, tests 9, 10 and 11: the owner re-check of a lid-only Film and the TMDB attach (`lidRecheck`), on the real migrations (a sqlite D1 stand-in), the real canonical writer, receipts, operation-key
// protocol, evidence ledger and writer control, and the REAL Ratings alias protocol (`LetterboxdFacts.linkAttachedPair`, over the generated Worker bundle's scope chain in a vm). Synthetic fixtures only; no network, R2 or production.
// DORMANT: the writer `lid_tmdb_attach` is activated here by the same change rows the owner operation writes; nothing calls the coordinator from a live path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {createHash,webcrypto} from 'node:crypto';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import * as RatingsD1 from '../src/ratings-d1.js';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {admitVerifiedLidOnly} from '../src/letterboxd-admission-d1.js';
import {lidOnlyProofDigest} from '../src/domain/letterboxd-lid-only-digest.js';
import {attachRoot} from '../src/domain/letterboxd-attach-root.js';
import {lidRecheck,planAttachState,readIntent} from '../src/letterboxd-lid-attach.js';
import {resolveAdmissionFilm} from '../src/film-admission.js';
import {MUTATION_STATEMENT_CAP} from '../src/canonical-mutations.js';

execFileSync(process.execPath,['build.mjs'],{stdio:'ignore'});
const bundle=fs.readFileSync('dist/server/index.js','utf8');
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lid-attach-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"
 +"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');"
 +"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;";

const STAMP='2026-11-25T10:00:00.000Z';
const NOWMS=Date.parse('2026-11-27T12:00:00.000Z');
let copies=0;
const WRITER_AT='2026-11-27T09:00:00.000Z';
const change=(kind,from,to,generation,extra='')=>"INSERT INTO identity_evidence_writer_change (writer,kind,from_state,to_state,generation,reason,deployed_version,evidence_link,drain_evidence,break_from,recorded_at) VALUES ('lid_tmdb_attach','"+kind+"','"+from+"','"+to+"',"+generation+",'test','v1','https://trello.com/c/x',"+(kind==='drain_complete'?"'only versions with the attach serve'":'NULL')+",NULL,'"+WRITER_AT+"');";
const writerOn=file=>sqlite(file,change('activate','off','pending',1)+change('drain_complete','pending','on',2));
// d1 admission marker, the Ratings domain `d1`/`open`, the writer `on` (unless `writer` says otherwise)
const fresh=({mode='d1',writer='on'}={})=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);sqlite(file,OPEN);
 sqlite(file,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3;");
 if(mode==='closed')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 if(mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1;UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 if(writer==='on')writerOn(file);else if(writer==='pending')sqlite(file,change('activate','off','pending',1));
 return file;
};
let tick=0;
const clock=()=>()=>new Date(NOWMS+(tick++)*10).toISOString();
const envOf=(file,options)=>({DB:d1Standin(file,options),TMDB_API_READ_ACCESS_TOKEN:'fixture-token'});
const sha=c=>c.repeat(64);
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const r2=new Map(),etags=new Map();let rev=0;
const bucket={
 async get(key){return r2.has(key)?{etag:etags.get(key),json:async()=>structuredClone(r2.get(key))}:null;},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&r2.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;r2.set(key,JSON.parse(value));etags.set(key,String(++rev));return {etag:etags.get(key)};},
 async delete(key){r2.delete(key);etags.delete(key);},
};
// ---- the bundle's scope chain plus the Letterboxd Facts, in one vm (the REAL Ratings alias protocol) ----
const start=bundle.indexOf('const OrchestrationPolicy=(()=>{');
const begin=bundle.indexOf('const LetterboxdAdmissionD1=(()=>{');
assert.ok(start>0&&begin>start,'the bundle holds the scoped chain up to the d1 coordinator');
const end=bundle.indexOf('\n})();',begin)+'\n})();'.length;
const ctx=vm.createContext({URL,Response,Request,Headers,Date,Map,Set,JSON,Object,Number,Promise,TextEncoder,TextDecoder,Uint8Array,AbortSignal,crypto:webcrypto,structuredClone,setTimeout,clearTimeout,console:{...console,log:()=>{}},RatingsD1,fetch:async()=>{throw new Error('no network in this test');}});
vm.runInContext(bundle.slice(start,end),ctx);
for(const file of ['src/domain/tmdb-tv-identity.js','src/sources.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace(/^export default/m,'globalThis.x='),ctx);
vm.runInContext(scoped('src/letterboxd-match.js','LetterboxdMatch')+'\n'+scopedReplacing('src/letterboxd-identity.js','LetterboxdIdentity','const normTitle=LetterboxdMatch.normTitle;\n')+'\n'+scoped('src/domain/letterboxd-rated-admission.js','LetterboxdRatedAdmission')+'\n'+scoped('src/domain/letterboxd-import-registry.js','LetterboxdImportRegistry'),ctx);
vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8'),ctx);
vm.runInContext(scoped('src/letterboxd-admission-documents.js','LetterboxdAdmissionDocuments'),ctx);
vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;",ctx);
const Facts=vm.runInContext('LetterboxdFacts',ctx);
const LINKS='letterboxd/facts/links.json';
const sqlText=text=>"'"+String(text).replace(/'/g,"''")+"'";
const setLinks=(file,value)=>{const body=JSON.stringify(value);sqlite(file,'DELETE FROM ratings_document WHERE key='+sqlText(LINKS)+';INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+sqlText(LINKS)+',0,'+sqlText(body)+','+sqlText(createHash('sha256').update(body).digest('hex'))+",'2026-11-27T09:00:00.000Z')");};
const setDocRaw=(file,key,value)=>{const body=JSON.stringify(value);sqlite(file,'DELETE FROM ratings_document WHERE key='+sqlText(key)+';INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+sqlText(key)+',0,'+sqlText(body)+','+sqlText(createHash('sha256').update(body).digest('hex'))+",'2026-11-27T09:00:00.000Z')");};
const getLinks=file=>{const found=rows(file,'SELECT body FROM ratings_document WHERE key='+sqlText(LINKS)+' ORDER BY part');return found.length?JSON.parse(found.map(row=>row.body).join('')):null;};
const linkPort=env=>({link:args=>Facts.linkAttachedPair(env,args)});

// ---- a lid-only Film to attach to, minted by the real lid-only coordinator (AIR-672) ----
const lidProof=async(lid,over={})=>{
 const proof={proofVersion:1,lid,finalUrl:'https://letterboxd.com/film/some-short-1999/',slug:'some-short-1999',canonicalPath:'/film/some-short-1999/',shortlink:lid,typeMarker:'video.movie',idBlockOutcome:'absent',completenessOutcome:'complete',title:'Some Short',year:1999,redirectStatus:301,pageStatus:200,checkedAt:'2026-11-25T11:59:00.000Z',...over};
 proof.proofDigest=await lidOnlyProofDigest(proof);
 return proof;
};
const NO_LINKS={fence:{key:LINKS,parts:0,etag:null},tmdbAlias:null};
const mint=async(file,lid='Ab1')=>{
 const proof=await lidProof(lid);
 const out=await admitVerifiedLidOnly(envOf(file),{lid,route:'watchlist_admission',reacquire:async()=>({ok:true,proof,links:NO_LINKS}),now:clock()});
 assert.equal(out.outcome,'admitted_lid_only',JSON.stringify(out));
 return 'film:lb:'+lid;
};
// ---- the check an owner re-check would run (synthetic), and the coordinator call ----
const movie=(over={})=>({id:603,title:'Some Short',original_title:'Some Short',release_date:'1999-03-31',...over});
const found=(tmdb='603',over={},detail={})=>({ok:true,state:'tmdb_movie',proof:{slug:'some-short-1999',path:'/film/some-short-1999/',finalUrl:'https://letterboxd.com/film/some-short-1999/',tmdb,title:'Some Short',year:1999,detail:movie({id:Number(tmdb),...detail}),...over}});
const recheck=async(file,{lid='Ab1',requestId='req-1',answer=found(),options,ports=true,now=clock(),...rest}={})=>{
 const calls={n:0};
 const env=envOf(file,options);
 const out=await lidRecheck(env,{lid,requestId,reacquire:async()=>{calls.n++;return typeof answer==='function'?answer():answer;},ports:ports?linkPort(env):undefined,now,...rest});
 return {out,calls,env};
};
const evidence=file=>rows(file,'SELECT subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,film_id,request_id FROM film_identity_evidence ORDER BY seq');
const claims=file=>rows(file,"SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id ORDER BY film_id,scheme,value");
const receipts=file=>rows(file,"SELECT request_id,state,operation_key,target_id FROM canonical_write_receipt ORDER BY created_at,request_id");
const intents=file=>rows(file,'SELECT request_id,lid,state,outcome,revision,attempt_request_id,film_id,link_state,attach_root,tmdb FROM lid_recheck_intent ORDER BY request_id');
const snapshot=file=>JSON.stringify([rows(file,'SELECT * FROM film ORDER BY id'),claims(file),rows(file,'SELECT * FROM film_lid_admission'),evidence(file),receipts(file),rows(file,'SELECT * FROM canonical_revision ORDER BY kind,id')]);
const canonical=file=>JSON.stringify([rows(file,'SELECT * FROM film ORDER BY id'),claims(file),evidence(file)]);
const ROOT=async()=>(await attachRoot({lid:'Ab1',slug:'some-short-1999',path:'/film/some-short-1999/',tmdb:'603',title:'Some Short',year:1999,finalUrl:'https://letterboxd.com/film/some-short-1999/',detail:movie()})).root;

// ===== 9. attach to a free movie: one batch writes the claim, canonical_identity, the evidence row and the intent; the id is unchanged =====
const EXPECTED_ROOT=await ROOT();
{
 const file=fresh();
 const filmId=await mint(file);setLinks(file,{});
 const lidOnlyCanonical=canonical(file);
 const {out,calls,env}=await recheck(file);
 assert.deepEqual([out.outcome,out.terminal,out.id,out.tmdb,out.attachRoot],['linked',true,'film:lb:Ab1','603',EXPECTED_ROOT],JSON.stringify(out));
 assert.equal(calls.n,1,'one source check');
 // the Film keeps its id; its identity and its trusted claim are written, nothing is deleted
 assert.deepEqual(rows(file,'SELECT id,canonical_identity FROM film'),[{id:'film:lb:Ab1',canonical_identity:'tmdb:603'}]);
 const rowsOf=claims(file);
 assert.deepEqual(rowsOf.map(r=>[r.film_id,r.scheme,r.value,r.trusted,r.conflicting]),[['film:lb:Ab1','letterboxd','Ab1',1,0],['film:lb:Ab1','tmdb','603',1,0]]);
 assert.deepEqual(JSON.parse(rowsOf[1].provenance_json),{source:'owner_action',adr:'0217',evidence:EXPECTED_ROOT},'provenance names the owner action, the ADR and the attach root');
 // the evidence row: film_has_id(survivor, tmdb_movie) asserted by page_check from owner_action, rooted in the attach root
 const ev=evidence(file);
 assert.equal(ev.length,1);
 assert.deepEqual([ev[0].subject_kind,ev[0].subject_value,ev[0].relation,ev[0].object_kind,ev[0].object_value,ev[0].polarity,ev[0].route,ev[0].method,ev[0].source_root,ev[0].film_id],
  ['film','film:lb:Ab1','film_has_id','tmdb_movie','603','asserts','owner_action','page_check',EXPECTED_ROOT,'film:lb:Ab1']);
 // the receipt of the common lid key is applied for BOTH kinds (the lid-only admission, then the attach); the attach receipt is the evidence's own request
 const rec=receipts(file);
 assert.deepEqual(rec.map(r=>[r.state,r.operation_key,r.target_id]),[['applied','admission:lid:Ab1','film:lb:Ab1'],['applied','admission:lid:Ab1','film:lb:Ab1']]);
 assert.equal(rec[1].request_id,ev[0].request_id);
 // the intent: attached, then settled by the link in the same batch as the alias
 const [intent]=intents(file);
 assert.deepEqual([intent.state,intent.outcome,intent.link_state,intent.film_id,intent.attach_root,intent.tmdb,intent.attempt_request_id],['settled','attached','linked','film:lb:Ab1',EXPECTED_ROOT,'603',rec[1].request_id]);
 // the Ratings alias exists: both ids on one fact key; no film_rated_admission row (outside the enrichment scope)
 const links=getLinks(file);
 assert.deepEqual(links,{'letterboxd:Ab1':'lb-Ab1','tmdb:603':'lb-Ab1'},'the lid keeps its OWN fact key lb-<lid> and gains the movie alias; no tmdb-<n> key is made');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_rated_admission')[0].n,0);
 // both permalinks resolve to the same Film: by the lid (its proof row) and by the movie (its trusted claim)
 assert.equal((await resolveAdmissionFilm(env,'603')).id,'film:lb:Ab1');
 assert.equal(rows(file,"SELECT film_id FROM film_lid_admission WHERE lid='Ab1'")[0].film_id,'film:lb:Ab1');
 assert.notEqual(canonical(file),lidOnlyCanonical);

 // ---- a settled requestId replays by readback: no fetch, no write, no gate ----
 const before=snapshot(file);
 const again=await recheck(file);
 assert.equal(again.calls.n,0,'no fetch');
 assert.deepEqual([again.out.outcome,again.out.terminal,again.out.replay],['linked',true,true],JSON.stringify(again.out));
 assert.equal(snapshot(file),before);
 // ... even when the writer was turned off afterwards: a settled intent is only read
 sqlite(file,change('deactivate','on','off',3));
 assert.equal((await recheck(file)).out.replay,true);
 // the same requestId with another lid
 const other=await recheck(file,{lid:'Zz9'});
 assert.deepEqual([other.out.outcome,other.out.terminal],['request_conflict',true]);assert.equal(other.calls.n,0);
}

// ===== 9. a transport failure, then the SAME requestId makes progress =====
{
 const file=fresh();await mint(file);setLinks(file,{});
 const flaky=await recheck(file,{answer:{ok:false,reason:'timeout'}});
 assert.deepEqual([flaky.out.outcome,flaky.out.terminal],['source_unavailable',false],JSON.stringify(flaky.out));
 assert.deepEqual(intents(file).map(i=>[i.state,i.outcome]),[['open',null]],'the intent stays open');
 const tmdbDown=await recheck(file,{answer:{ok:true,state:'tmdb_unavailable',reason:'rate_limited'}});
 assert.deepEqual([tmdbDown.out.outcome,tmdbDown.out.terminal],['source_unavailable',false],'TMDB unavailable is non-terminal');
 assert.equal(claims(file).filter(r=>r.scheme==='tmdb').length,0,'nothing canonical was written');
 const ok=await recheck(file);
 assert.equal(ok.out.outcome,'linked',JSON.stringify(ok.out));assert.equal(ok.calls.n,1);
 assert.equal(intents(file).length,1,'one intent for the one requestId');
}

// ===== 9. an open intent whose page now names another movie: the observation is replaced (nothing had landed) =====
{
 const file=fresh();await mint(file);setLinks(file,{});
 // the writer batch of the first attempt is refused by an injected failure AFTER the observation was recorded: nothing lands
 let armed=true;
 const first=await recheck(file,{options:{onBatch:async list=>{if(armed&&list.some(item=>/INSERT INTO film_external_id/.test(item.text))){armed=false;throw new Error('injected transport failure');}}}}).catch(error=>({error}));
 assert.ok(first.error||first.out,'the first attempt did not complete');
 const [mid]=intents(file);
 assert.equal(mid.state,'open');assert.equal(mid.outcome,null);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_identity_evidence')[0].n,0,'nothing landed');
 const second=await recheck(file,{answer:found('604',{},{title:'Some Short'})});
 assert.equal(second.out.outcome,'linked',JSON.stringify(second.out));
 assert.equal(rows(file,"SELECT canonical_identity FROM film WHERE id='film:lb:Ab1'")[0].canonical_identity,'tmdb:604','the new observation was attached');
 assert.notEqual(intents(file)[0].attach_root,EXPECTED_ROOT);
 assert.ok(receipts(file).some(r=>r.state==='abandoned'||r.state==='failed')||receipts(file).filter(r=>r.state==='applied').length===2,'the first attempt never landed');
}

// ===== 9. an attached Film is not attached again, by any requestId: the survivor already has a canonical identity =====
{
 const file=fresh();await mint(file);setLinks(file,{});
 assert.equal((await recheck(file)).out.outcome,'linked');
 const before=canonical(file);
 const second=await recheck(file,{requestId:'req-2'});
 assert.deepEqual([second.out.outcome,second.out.terminal],['already_attached',true],JSON.stringify(second.out));
 assert.equal(second.calls.n,0,'no fetch');
 assert.equal(canonical(file),before);
 // an earlier observation of the same open intent that named another movie, with the Film attached to a movie meanwhile: source_changed
 sqlite(file,"INSERT INTO lid_recheck_intent (request_id,lid,state,revision,created_at,updated_at) VALUES ('req-3','Ab1','open',1,'2026-11-27T09:00:00.000Z','2026-11-27T09:00:00.000Z');UPDATE lid_recheck_intent SET revision=2,proof_version=1,tmdb='999',final_url='https://letterboxd.com/film/some-short-1999/',slug='some-short-1999',canonical_path='/film/some-short-1999/',title='Some Short',year=1999,tmdb_doc_digest='"+sha('d')+"',attach_root='"+sha('e')+"' WHERE request_id='req-3'");
 const changed=await recheck(file,{requestId:'req-3'});
 assert.deepEqual([changed.out.outcome,changed.out.terminal],['source_changed',true],JSON.stringify(changed.out));
 assert.equal(canonical(file),before,'never a second attach');
}

// ===== 9. the same page checked by another route gives the SAME root; the source is the normalized page URL =====
{
 const a=await attachRoot({lid:'Ab1',slug:'some-short-1999',path:'/film/some-short-1999/',tmdb:'603',title:'Some Short',year:1999,finalUrl:'https://letterboxd.com/film/some-short-1999/',detail:movie()});
 const b=await attachRoot({lid:'Ab1',slug:'some-short-1999',path:'/film/some-short-1999/',tmdb:'603',title:'Some Short',year:1999,finalUrl:'HTTPS://Letterboxd.com/film/some-short-1999?utm=1#x',detail:movie(),route:'ratings_diary'});
 assert.equal(a.root,b.root,'a route name and an un-normalized URL do not change the root');
 assert.equal(a.root,EXPECTED_ROOT);
 const changedDoc=await attachRoot({lid:'Ab1',slug:'some-short-1999',path:'/film/some-short-1999/',tmdb:'603',title:'Some Short',year:1999,finalUrl:'https://letterboxd.com/film/some-short-1999/',detail:movie({release_date:'1998-03-31'})});
 assert.notEqual(changedDoc.root,a.root,'the TMDB document fields are in the root');
 assert.equal(await attachRoot({lid:'Ab1',slug:'x',path:'/film/some-short-1999/',tmdb:'603',title:'T',year:1999,finalUrl:'https://letterboxd.com/film/x/',detail:movie()}),null,'an inconsistent input has no root');
 assert.equal(await attachRoot({lid:'Ab1',slug:'some-short-1999',path:'/film/some-short-1999/',tmdb:'603',title:'Some Short',year:1999,finalUrl:'https://letterboxd.com/film/some-short-1999/',detail:movie({id:7})}),null,'a document of another movie has no root');
}

// ===== 10. the writer and the gates: refused with NO write, NO fetch and NO intent, whatever the page says =====
{
 for(const writer of ['off','pending']){
  const file=fresh({writer});await mint(file);setLinks(file,{});
  const before=snapshot(file);
  const probe=await recheck(file).then(()=>null,error=>error);
  assert.ok(probe,'expected a refusal');
  assert.equal(probe.code,'evidence_writer_inactive');
  assert.equal(probe.reason,writer==='off'?'writer_off':'writer_pending');
  assert.equal(snapshot(file),before,'no canonical write');
  assert.equal(intents(file).length,0,'no intent row either');
 }
 // a fetch is never started: the check is not even called
 {const file=fresh({writer:'off'});await mint(file);const calls={n:0};
  await assert.rejects(()=>lidRecheck(envOf(file),{lid:'Ab1',requestId:'r',reacquire:async()=>{calls.n++;return found();},ports:linkPort(envOf(file)),now:clock()}),code('evidence_writer_inactive'));
  assert.equal(calls.n,0,'no fetch while the writer is not on');}
 // a deactivated writer (an `on` writer turned off) refuses too, and so does a rollback that broke the interval
 {const file=fresh();await mint(file);sqlite(file,change('deactivate','on','off',3));
  await assert.rejects(()=>recheck(file),code('evidence_writer_inactive'));}
 // the admission marker is not d1
 for(const mode of ['closed','r2']){
  const file=fresh({mode});await assert.rejects(()=>recheck(file),code('letterboxd_admission_closed'),'mode '+mode);
  assert.equal(intents(file).length,0);
 }
 // migration 0052 (or 0051) not applied: the schema refuses before any effect
 {const file=fresh();await mint(file);sqlite(file,'DROP TRIGGER lid_recheck_intent_keep;DROP TABLE lid_recheck_intent');
  await assert.rejects(()=>recheck(file),code('admission_unavailable'));}
 // an invalid lid or request id
 {const file=fresh();await assert.rejects(()=>recheck(file,{lid:'a b'}),code('film_person_invalid'));await assert.rejects(()=>recheck(file,{requestId:'bad id'}),code('film_person_invalid'));}
}

// ===== 10. attach refusals: each is settled on the intent and writes NO canonical row =====
const refusal=async(setup,expected,{lid='Ab1',answer,extra}={})=>{
 const file=fresh();await mint(file,lid);setLinks(file,{});
 if(setup)await setup(file);
 const before=canonical(file);
 const {out,calls}=await recheck(file,{lid,answer:answer??found(),...extra});
 assert.deepEqual([out.outcome,out.terminal],[expected,true],JSON.stringify(out));
 assert.equal(canonical(file),before,'no canonical write: '+expected);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_identity_evidence')[0].n,0);
 assert.deepEqual(intents(file).map(i=>[i.state,i.outcome,i.link_state]),[['settled',expected,null]],'the intent is settled with the outcome');
 // settled intents are answered by readback: a repeat does not fetch
 const again=await recheck(file,{lid});assert.equal(again.calls.n,0);assert.equal(again.out.outcome,expected);
 return {file,calls};
};
// the movie is held by another Film (any trust): L1, no automatic merge
await refusal(file=>sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:603',1,'tmdb:603','Held','2026-11-27T09:00:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:603','tmdb','603',1,0,'{}')"),'tmdb_on_other_film');
await refusal(file=>sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:603',1,NULL,'Held','2026-11-27T09:00:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:603','tmdb','603',0,0,'{}')"),'tmdb_on_other_film');
// the movie is retired by an owner decision (and a restored one is not)
const RETIRE="INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:1',1,NULL,'Other','2026-11-27T09:00:00.000Z');INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('ret-1','film:tmdb:1','retire','Zz9','603','77','{}','{\"by\":\"owner\",\"at\":\"2026-11-27T09:00:00.000Z\",\"source\":\"t\"}','owner_request','{}','2026-11-27T09:00:00.000Z');";
await refusal(file=>sqlite(file,RETIRE),'tmdb_retired');
// the identity dimension is owner or reviewed
await refusal(file=>sqlite(file,"INSERT INTO film_dimension (film_id,dimension,status,authority,provenance_json,updated_at) VALUES ('film:lb:Ab1','identity','reviewed','owner','{}','2026-11-27T09:00:00.000Z')"),'owner_kept');
// another tmdb claim already on this Film
await refusal(file=>sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:lb:Ab1','tmdb','777',0,0,'{}')"),'admission_conflict');
// the lid has been reassigned or has gained a competing row
await refusal(file=>sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:5',1,'tmdb:5','X','2026-11-27T09:00:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:5','letterboxd','Ab1',0,0,'{}')"),'admission_conflict');
await refusal(file=>sqlite(file,"UPDATE film_external_id SET trusted=0 WHERE scheme='letterboxd' AND value='Ab1'"),'admission_conflict');
// a Film that is not a lid-only Film at all
{
 const file=fresh();sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:5',1,'tmdb:5','X','2026-11-27T09:00:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:5','letterboxd','Ab1',1,0,'{}')");
 const {out,calls}=await recheck(file);assert.deepEqual([out.outcome,out.reason],['admission_conflict','not_lid_only']);assert.equal(calls.n,0,'no fetch');
 const none=fresh();const r=await recheck(none);assert.deepEqual([r.out.outcome,r.out.reason],['admission_conflict','lid_only_film_missing']);
}
// every non-admitting state of the check is a terminal outcome with no canonical write; transport states are not terminal
for(const [state,outcome] of [['tmdb_none','still_none'],['tmdb_tv','tmdb_tv'],['tmdb_unreadable','tmdb_unreadable'],['tmdb_missing','tmdb_missing'],['tmdb_disagrees','tmdb_disagrees'],['tmdb_failed','tmdb_failed'],['page_not_read','page_not_read'],['page_refused','page_refused']])
 await refusal(null,outcome,{answer:{ok:true,state}});
{
 const file=fresh();await mint(file);await assert.rejects(()=>recheck(file,{answer:{ok:true,state:'surprise'}}),code('film_person_invalid'));
}
// a check whose inputs cannot make a root is unreadable, not attached
await refusal(null,'tmdb_unreadable',{answer:found('603',{slug:'other'})});

// ===== 11. attach races: exactly one trusted owner of the movie, whoever wins =====
{
 // a Discovery admission of the movie lands between the plan and the attach batch: the batch's own predicate fails, nothing is written, the outcome is the typed refusal
 const file=fresh();await mint(file);setLinks(file,{});
 let armed=true;
 const racer=async list=>{
  if(armed&&list.some(item=>/INSERT INTO film_external_id \(film_id,scheme,value,trusted,conflicting,provenance_json\) VALUES \(\?,'tmdb'/.test(item.text)||/INSERT INTO film_external_id/.test(item.text))){
   armed=false;
   sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:603',1,'tmdb:603','Discovery','2026-11-27T09:30:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:603','tmdb','603',1,0,'{}')");
  }
 };
 const {out}=await recheck(file,{options:{onBatch:racer}});
 assert.deepEqual([out.outcome,out.terminal],['tmdb_on_other_film',true],JSON.stringify(out));
 assert.deepEqual(claims(file).filter(r=>r.scheme==='tmdb').map(r=>r.film_id),['film:tmdb:603'],'exactly one trusted owner of the movie');
 assert.equal(rows(file,"SELECT canonical_identity FROM film WHERE id='film:lb:Ab1'")[0].canonical_identity,null);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_identity_evidence')[0].n,0);
 // ... and the other order: the attach wins, then the stale admission plan for the movie resolves to the attached Film and never mints a duplicate
 const second=fresh();await mint(second);setLinks(second,{});
 assert.equal((await recheck(second)).out.outcome,'linked');
 const target=await resolveAdmissionFilm(envOf(second),'603');
 assert.deepEqual([target.id,target.exists,target.owner,target.held],['film:lb:Ab1',true,'film:lb:Ab1',null],'a TMDB admission now resolves to the survivor, not film:tmdb:603');
 assert.equal(rows(second,"SELECT COUNT(*) AS n FROM film WHERE id='film:tmdb:603'")[0].n,0);
 // a stale writeFilmFacts-style insert of film:tmdb:603 carrying a trusted claim is refused by the one-trusted-owner index
 assert.throws(()=>sqlite(second,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:603',1,'tmdb:603','Dup','2026-11-27T09:30:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:603','tmdb','603',1,0,'{}')"),/UNIQUE|constraint/i);
}
// ===== 11. the attach races the lid itself: a merge / correction / competing claim between the plan and the batch =====
{
 const file=fresh();await mint(file);setLinks(file,{});
 let armed=true;
 const {out}=await recheck(file,{options:{onBatch:async list=>{if(armed&&list.some(item=>/INSERT INTO film_external_id/.test(item.text))){armed=false;sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:9',1,'tmdb:9','X','2026-11-27T09:30:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:9','letterboxd','Ab1',0,0,'{}')");}}}});
 assert.deepEqual([out.outcome,out.terminal],['admission_conflict',true],JSON.stringify(out));
 assert.equal(rows(file,"SELECT canonical_identity FROM film WHERE id='film:lb:Ab1'")[0].canonical_identity,null);
}

// ===== 11. reserve-time compare-and-swap: a concurrent request with the same requestId cannot also own the intent =====
{
 const file=fresh();await mint(file);setLinks(file,{});
 // another caller takes the intent (attempt, revision) between this one's reads and its reservation
 let armed=true;
 const out=await recheck(file,{options:{onBatch:async list=>{
  if(armed&&list.some(item=>/INSERT INTO canonical_write_receipt/.test(item.text)&&/lid_recheck_intent/.test(list.map(l=>l.text).join(' ')))){
   armed=false;sqlite(file,"UPDATE lid_recheck_intent SET attempt_request_id='other-owner',revision=revision+1,updated_at='2026-11-27T09:40:00.000Z' WHERE request_id='req-1'");
  }}}});
 // the reservation batch failed whole (no receipt of this attempt); the call replanned from the durable state and, the intent now being at a newer revision, completed on the second round
 assert.equal(out.out.outcome,'linked',JSON.stringify(out.out));
 assert.equal(out.calls.n,1,'the check is made once per call');
 assert.equal(receipts(file).filter(r=>r.state==='applied').length,2);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_identity_evidence')[0].n,1,'exactly one attach');
}

// ===== 8c. the Ratings link handoff: transient is retryable, a proved conflict or correction is terminal =====
const attached=async(portOverride)=>{
 const file=fresh();await mint(file);setLinks(file,{});
 const env=envOf(file);
 const out=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',reacquire:async()=>found(),ports:portOverride??{link:async()=>{const e=new Error('write_contention');e.code='write_contention';throw e;}},now:clock()});
 return {file,env,out};
};
{
 // transient failure of the link step (a moved etag / epoch / contention): the attach stays, the intent stays open with the link owed
 const {file,env,out}=await attached();
 assert.deepEqual([out.outcome,out.terminal,out.reason,out.attached],['link_owed',false,'write_contention',true],JSON.stringify(out));
 assert.deepEqual(intents(file).map(i=>[i.state,i.outcome,i.link_state]),[['open','attached','owed']]);
 assert.equal(rows(file,"SELECT canonical_identity FROM film WHERE id='film:lb:Ab1'")[0].canonical_identity,'tmdb:603');
 assert.deepEqual(getLinks(file),{},'no alias yet');
 // the SAME requestId resumes the link step only: no fetch, no second attach
 const calls={n:0};
 const again=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',reacquire:async()=>{calls.n++;return found();},ports:linkPort(env),now:clock()});
 assert.deepEqual([again.outcome,again.terminal],['linked',true],JSON.stringify(again));
 assert.equal(calls.n,0);assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_identity_evidence')[0].n,1);
 assert.deepEqual(intents(file).map(i=>[i.state,i.link_state]),[['settled','linked']]);
 // the writer being turned off after the attach does not strand the link
}
{
 // a store that cannot carry the statement (the document is not owned by D1): fail closed, nothing written, owed
 const {file,env}=await attached();
 sqlite(file,"UPDATE ratings_domain_authority SET cutover='held', generation=generation+1");
 const out=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',ports:linkPort(env),now:clock()});
 assert.equal(out.outcome,'link_owed',JSON.stringify(out));assert.deepEqual(getLinks(file),{});
 assert.equal(intents(file)[0].state,'open');
}
{
 // a PROVED alias conflict: the movie is already linked to another fact key
 const {file,env}=await attached();
 setLinks(file,{'letterboxd:Ab1':'k1','tmdb:603':'k2'});
 const out=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',ports:linkPort(env),now:clock()});
 assert.deepEqual([out.outcome,out.terminal],['alias_conflict',true],JSON.stringify(out));
 assert.deepEqual(intents(file).map(i=>[i.state,i.outcome,i.link_state]),[['settled','attached','alias_conflict']]);
 assert.deepEqual(getLinks(file),{'letterboxd:Ab1':'k1','tmdb:603':'k2'},'the document is untouched');
 const replay=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',now:clock()});assert.deepEqual([replay.outcome,replay.replay],['alias_conflict',true]);
}
{
 // a PROVED correction between the attach and the link (the claim was reassigned, a retirement now applies): link_blocked, and no alias
 const {file,env}=await attached();
 sqlite(file,"UPDATE film_external_id SET trusted=0 WHERE scheme='tmdb' AND value='603'");
 const out=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',ports:linkPort(env),now:clock()});
 assert.deepEqual([out.outcome,out.terminal],['link_blocked',true],JSON.stringify(out));
 assert.deepEqual(getLinks(file),{},'no alias written for a stale claim');
 assert.deepEqual(intents(file).map(i=>[i.state,i.link_state]),[['settled','link_blocked']]);
 // a merge: the Film became a redirect source
 const m=await attached();
 sqlite(m.file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:603',1,NULL,'Survivor','2026-11-27T09:50:00.000Z');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb:Ab1','film:tmdb:603','2026-11-27T09:50:00.000Z')");
 const merged=await lidRecheck(m.env,{lid:'Ab1',requestId:'req-1',ports:linkPort(m.env),now:clock()});
 assert.equal(merged.outcome,'link_blocked',JSON.stringify(merged));assert.deepEqual(getLinks(m.file),{});
 // a retirement of the movie
 const r=await attached();sqlite(r.file,RETIRE);
 const retired=await lidRecheck(r.env,{lid:'Ab1',requestId:'req-1',ports:linkPort(r.env),now:clock()});
 assert.equal(retired.outcome,'link_blocked',JSON.stringify(retired));
}
{
 // LOST RESPONSE: the alias is in the document already. The settlement is NOT a separate unfenced update: the document is rewritten unchanged by the guarded batch that carries the intent settlement
 const {file,env}=await attached();
 setLinks(file,{'letterboxd:Ab1':'lb-key-1','tmdb:603':'lb-key-1'});
 const out=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',ports:linkPort(env),now:clock()});
 assert.deepEqual([out.outcome,out.terminal,out.factKey],['linked',true,'lb-key-1'],JSON.stringify(out));
 assert.deepEqual(intents(file).map(i=>[i.state,i.link_state]),[['settled','linked']]);
 assert.deepEqual(getLinks(file),{'letterboxd:Ab1':'lb-key-1','tmdb:603':'lb-key-1'},'the document is unchanged');
}
{
 // the primary path settles the intent in the SAME batch as the alias: a batch that fails writes neither
 const file=fresh();await mint(file);setLinks(file,{});
 let armed=true;
 const env=envOf(file,{onBatch:async list=>{if(armed&&list.some(item=>/UPDATE lid_recheck_intent SET state='settled',link_state='linked'/.test(item.text))){armed=false;throw new Error('injected: the link batch dies');}}});
 const first=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',reacquire:async()=>found(),ports:linkPort(env),now:clock()});
 assert.equal(first.outcome,'link_owed',JSON.stringify(first));
 assert.deepEqual(getLinks(file),{},'the alias and the intent cannot disagree: neither landed');
 assert.deepEqual(intents(file).map(i=>[i.state,i.link_state]),[['open','owed']]);
 const again=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',ports:linkPort(env),now:clock()});
 assert.equal(again.outcome,'linked');
}

// ===== 16. statement count: the attach batch at its largest stays within the cap =====
{
 const file=fresh();await mint(file);setLinks(file,{});
 const sizes=[];
 const {out}=await recheck(file,{options:{onBatch:async list=>{sizes.push(list.length);}}});
 assert.equal(out.outcome,'linked');
 assert.ok(Math.max(...sizes)<=MUTATION_STATEMENT_CAP,'largest batch '+Math.max(...sizes)+' statements, cap '+MUTATION_STATEMENT_CAP);
}
// ===== read-only helpers =====
{
 const file=fresh();await mint(file);
 const env=envOf(file);
 assert.deepEqual((await planAttachState(env,{lid:'Ab1'})).outcome,'attachable');
 assert.equal(await readIntent(env,'nope'),null);
}

// ===== 8c (review of PR #1043, P1): the link is fenced by the existing document compare-and-swap and the markers, for EVERY outcome =====
const seedParts=(file,value,{parts=2,etagOf=body=>createHash('sha256').update(body).digest('hex')}={})=>{
 const body=JSON.stringify(value),size=Math.ceil(body.length/parts),etag=etagOf(body);
 sqlite(file,'DELETE FROM ratings_document WHERE key='+sqlText(LINKS)+';'+Array.from({length:parts},(_,i)=>'INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+sqlText(LINKS)+','+i+','+sqlText(body.slice(i*size,(i+1)*size))+','+sqlText(etag)+",'2026-11-27T09:00:00.000Z')").join(';'));
};
const partsOf=file=>rows(file,'SELECT part,etag FROM ratings_document WHERE key='+sqlText(LINKS)+' ORDER BY part');
const runOnce=(file,options,ports)=>{const env=envOf(file,options);return lidRecheck(env,{lid:'Ab1',requestId:'req-1',ports:ports??linkPort(env),now:clock()});};
const NOLINK=()=>({link:async()=>{const e=new Error('write_contention');e.code='write_contention';throw e;}});
{
 // a MULTIPART links document, replaced between the read and the settlement: the stale batch writes nothing (the exact part count and etag are in the batch); the retried one links at the NEW version
 const {file}=await attached(NOLINK().link?NOLINK():undefined);
 const big={};for(let i=0;i<40;i++)big['letterboxd:Z'+i]='lb-Z'+i;
 seedParts(file,big,{parts:3});assert.equal(partsOf(file).length,3);
 let replaced=false;
 const out=await runOnce(file,{onBatch:async list=>{if(!replaced&&list.some(item=>/UPDATE lid_recheck_intent SET state='settled'/.test(item.text))){replaced=true;seedParts(file,{...big,'letterboxd:Other':'lb-Other'},{parts:2});}}});
 assert.equal(replaced,true,'the document was replaced between the read and the batch');
 assert.deepEqual([out.outcome,out.terminal,out.factKey],['linked',true,'lb-Ab1'],JSON.stringify(out));
 const links=getLinks(file);
 assert.equal(links['letterboxd:Ab1'],'lb-Ab1');assert.equal(links['tmdb:603'],'lb-Ab1','BOTH aliases are in the document the intent was settled against');
 assert.equal(links['letterboxd:Other'],'lb-Other','the replacement was kept, not overwritten by the stale version');
 assert.deepEqual(intents(file).map(i=>[i.state,i.link_state]),[['settled','linked']]);
}
{
 // a multipart document already holding both aliases (lost response): settled unchanged; one holding neither is never reported as linked
 const {file}=await attached();
 const big={'letterboxd:Ab1':'lb-Ab1','tmdb:603':'lb-Ab1'};for(let i=0;i<40;i++)big['letterboxd:Z'+i]='lb-Z'+i;
 seedParts(file,big,{parts:3});
 const out=await runOnce(file);
 assert.equal(out.outcome,'linked',JSON.stringify(out));assert.deepEqual(getLinks(file),big);
 assert.equal(partsOf(file).length>=1,true);
}
{
 // the LID's own fact key, from a real Diary-first record: the movie alias joins `lb-<lid>` (with the record's history), no key is renamed or created from the movie
 const {file}=await attached();
 setLinks(file,{'letterboxd:Ab1':'lb-diary-1','letterboxd:Other':'lb-Other'});
 const out=await runOnce(file);
 assert.deepEqual([out.outcome,out.factKey],['linked','lb-diary-1'],JSON.stringify(out));
 assert.deepEqual(getLinks(file),{'letterboxd:Ab1':'lb-diary-1','letterboxd:Other':'lb-Other','tmdb:603':'lb-diary-1'},'readback through both aliases gives ONE key; nothing else moved');
 // ... and the Facts record of that key is the one the Ratings protocol reads (history kept): the record document is untouched by the link
 // no link at all: the key is lb-<lid>, never tmdb-<n>
 const none=await attached();setLinks(none.file,{});
 assert.equal((await runOnce(none.file)).factKey,'lb-Ab1');assert.equal(getLinks(none.file)['tmdb:603'],'lb-Ab1');
}
{
 // a competing movie fact key (the movie is mapped to ANOTHER key, the lid not linked yet): a PROVED conflict, nothing linked, the existing mapping is not reused
 const {file}=await attached();
 setLinks(file,{'tmdb:603':'tmdb-603'});
 const out=await runOnce(file);
 assert.deepEqual([out.outcome,out.terminal],['alias_conflict',true],JSON.stringify(out));
 assert.deepEqual(getLinks(file),{'tmdb:603':'tmdb-603'},'no lid alias was written');
 // the lid key already holds ANOTHER movie id
 const other=await attached();setLinks(other.file,{'letterboxd:Ab1':'lb-Ab1','tmdb:999':'lb-Ab1'});
 assert.equal((await runOnce(other.file)).outcome,'alias_conflict');
}
{
 // a conflict CLEARED before the terminal write: the document moved, so the guarded batch refuses and the retried one re-decides at the new version (linked, not alias_conflict)
 const {file}=await attached();
 setLinks(file,{'letterboxd:Ab1':'k1','tmdb:603':'k2'});
 let cleared=false;
 const out=await runOnce(file,{onBatch:async list=>{if(!cleared&&list.some(item=>/UPDATE lid_recheck_intent SET state='settled'/.test(item.text))){cleared=true;setLinks(file,{'letterboxd:Ab1':'lb-Ab1'});}}});
 assert.equal(cleared,true);
 assert.deepEqual([out.outcome,out.terminal],['linked',true],JSON.stringify(out));
 assert.deepEqual(getLinks(file),{'letterboxd:Ab1':'lb-Ab1','tmdb:603':'lb-Ab1'});
}
{
 // a LOST intent compare-and-swap (another caller raised the revision): the batch is refused whole, nothing is linked, the intent stays owed, and the next call links
 const {file}=await attached();
 let taken=false;
 const out=await runOnce(file,{onBatch:async list=>{if(!taken&&list.some(item=>/UPDATE lid_recheck_intent SET state='settled'/.test(item.text))){taken=true;sqlite(file,"UPDATE lid_recheck_intent SET revision=revision+1,updated_at='2026-11-27T13:00:00.000Z' WHERE request_id='req-1'");}}});
 assert.equal(taken,true);
 assert.deepEqual([out.outcome,out.terminal],['link_owed',false],JSON.stringify(out));
 assert.deepEqual(getLinks(file),{},'no alias landed with a lost compare-and-swap');
 assert.deepEqual(intents(file).map(i=>[i.state,i.link_state]),[['open','owed']]);
 const next=await runOnce(file);assert.equal(next.outcome,'linked',JSON.stringify(next));
}
{
 // a MARKER that moved between the read and the batch (the admission marker leaves d1): refused whole, owed, no alias
 const {file}=await attached();
 let moved=false;
 const out=await runOnce(file,{onBatch:async list=>{if(!moved&&list.some(item=>/UPDATE lid_recheck_intent SET state='settled'/.test(item.text))){moved=true;sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=generation+1");}}});
 assert.equal(moved,true);
 assert.deepEqual([out.outcome,out.terminal],['link_owed',false],JSON.stringify(out));
 assert.deepEqual(getLinks(file),{});assert.equal(intents(file)[0].state,'open');
 // the Ratings domain held or not authoritative: nothing written, owed (the terminal settlements are as fenced as the link)
 const held=await attached();sqlite(held.file,"UPDATE ratings_domain_authority SET cutover='held', generation=generation+1");
 setLinks(held.file,{'letterboxd:Ab1':'k1','tmdb:603':'k2'});
 const refused=await runOnce(held.file);
 assert.equal(refused.outcome,'link_owed',JSON.stringify(refused));assert.equal(intents(held.file)[0].state,'open','a conflict is not settled while Ratings is not authoritative');
 const blockedHeld=await attached();sqlite(blockedHeld.file,"UPDATE film_external_id SET trusted=0 WHERE scheme='tmdb' AND value='603'");sqlite(blockedHeld.file,"UPDATE ratings_domain_authority SET cutover='held', generation=generation+1");
 assert.equal((await runOnce(blockedHeld.file)).outcome,'link_owed','a proved correction is not settled while Ratings is not authoritative either');assert.equal(intents(blockedHeld.file)[0].state,'open');
}
{
 // a correction CLEARED before the terminal write (the claim is trusted again between the read and the batch): refused whole, the retried call links
 const {file}=await attached();
 sqlite(file,"UPDATE film_external_id SET trusted=0 WHERE scheme='tmdb' AND value='603'");
 let healed=false;
 const out=await runOnce(file,{onBatch:async list=>{if(!healed&&list.some(item=>/UPDATE lid_recheck_intent SET state='settled'/.test(item.text))){healed=true;sqlite(file,"UPDATE film_external_id SET trusted=1 WHERE scheme='tmdb' AND value='603'");}}});
 assert.equal(healed,true);
 assert.equal(out.outcome,'link_owed',JSON.stringify(out));assert.deepEqual(intents(file).map(i=>[i.state,i.link_state]),[['open','owed']],'the stale correction was not recorded');
 assert.equal((await runOnce(file)).outcome,'linked');
}
{
 // the R2 stand-in (a store that cannot batch) refuses whole: it never links without the guards
 const {file,env}=await attached();
 const facts=vm.runInContext('LetterboxdFacts',ctx);
 const bare=env.DB;void bare;
 await assert.rejects(()=>facts.linkAttachedPair({BUCKET:bucket},{lid:'Ab1',tmdb:'603',extra:[['SELECT 1',[]]],statementsFor:()=>[]}),error=>error.code==='atomic_unavailable');
 await assert.rejects(()=>facts.linkAttachedPair(env,{lid:'Ab1',tmdb:'603',extra:[],statementsFor:()=>[]}),error=>error.code==='atomic_unavailable','a call without a guard statement is refused');
}

// ===== 8c (second review of PR #1043, P1-4): the real Diary-first record, read through BOTH aliases by the actual consumers =====
{
 const file=fresh();await mint(file);
 const env=envOf(file);
 const Fx=vm.runInContext('LetterboxdFacts',ctx);
 // a REAL Diary-first fact record with an observation, written by the real writer (the lid's key is lb-Ab1)
 const seeded=await Fx.applyDiaryEvidence(env,[{lid:'Ab1',watchedDate:'2026-11-15',rating:4,ratingState:'rated',sourceRef:'diary:viewing:1'}]);
 assert.equal(seeded.written,1);
 const recordKeyOf=key=>'letterboxd/facts/films/'+key+'.json';
 const readRecord=()=>{const found=rows(file,'SELECT body FROM ratings_document WHERE key='+sqlText(recordKeyOf('lb-Ab1'))+' ORDER BY part');return JSON.parse(found.map(r=>r.body).join(''));};
 const before=readRecord();
 assert.equal(getLinks(file)['letterboxd:Ab1'],'lb-Ab1');assert.equal((await Fx.diaryLinks(env,['Ab1'])).get('Ab1').tmdb,null,'before the attach the record has no movie');
 assert.deepEqual(rows(file,'SELECT alias_id,fact_key,actual_rating FROM ratings_view ORDER BY alias_id'),[{alias_id:'Ab1',fact_key:'lb-Ab1',actual_rating:4}]);
 const out=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',reacquire:async()=>found(),ports:{...linkPort(env),complete:args=>Fx.completeAttachedLink(env,args)},now:clock()});
 assert.deepEqual([out.outcome,out.terminal,out.factKey,out.projection],['linked',true,'lb-Ab1','done'],JSON.stringify(out));
 // the fact key and its history survive: no key renamed, the observation and rating of the record are exactly what the real writer wrote
 assert.deepEqual(getLinks(file),{'letterboxd:Ab1':'lb-Ab1','tmdb:603':'lb-Ab1'});
 const after=readRecord();
 assert.deepEqual(after.rating,before.rating,'the rating observation survives');assert.deepEqual(after.watched,before.watched,'and the watched observation');
 assert.deepEqual([after.links.letterboxd,after.links.tmdb],['Ab1','603'],'the record now carries the movie id');
 // the ACTUAL consumers read the value through BOTH aliases: the Facts link read and the ratings view the Worker serves
 assert.equal((await Fx.diaryLinks(env,['Ab1'])).get('Ab1').tmdb,'603');
 assert.deepEqual(rows(file,'SELECT alias_id,fact_key,watched,actual_rating,rating_known FROM ratings_view ORDER BY alias_id'),
  [{alias_id:'Ab1',fact_key:'lb-Ab1',watched:1,actual_rating:4,rating_known:1},{alias_id:'tmdb_603',fact_key:'lb-Ab1',watched:1,actual_rating:4,rating_known:1}],'the rating 4 reads back through the lid AND the movie alias');
 // a repeat of the settled request is a readback with nothing pending: no write at all
 const snap=JSON.stringify([rows(file,'SELECT * FROM ratings_document ORDER BY key,part'),rows(file,'SELECT * FROM ratings_view ORDER BY alias_id'),intents(file)]);
 const again=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',ports:{...linkPort(env),complete:args=>Fx.completeAttachedLink(env,args)},now:clock()});
 assert.deepEqual([again.outcome,again.replay,again.projection],['linked',true,undefined]);
 assert.equal(JSON.stringify([rows(file,'SELECT * FROM ratings_document ORDER BY key,part'),rows(file,'SELECT * FROM ratings_view ORDER BY alias_id'),intents(file)]),snap);
 // a record whose completion failed after the settlement is repaired by the same requestId (idempotent), the intent staying settled
 const broken=fresh();await mint(broken);const benv=envOf(broken);
 await Fx.applyDiaryEvidence(benv,[{lid:'Ab1',watchedDate:'2026-11-15',rating:3,ratingState:'rated',sourceRef:'diary:viewing:1'}]);
 const flaky={...linkPort(benv),complete:async()=>{throw new Error('projection down');}};
 const first=await lidRecheck(benv,{lid:'Ab1',requestId:'req-1',reacquire:async()=>found(),ports:flaky,now:clock()});
 assert.deepEqual([first.outcome,first.projection],['linked','pending'],JSON.stringify(first));
 assert.equal(intents(broken)[0].state,'settled','the settlement is not undone');assert.equal((await Fx.diaryLinks(benv,['Ab1'])).get('Ab1').tmdb,null);
 const repaired=await lidRecheck(benv,{lid:'Ab1',requestId:'req-1',ports:{...linkPort(benv),complete:args=>Fx.completeAttachedLink(benv,args)},now:clock()});
 assert.equal(repaired.outcome,'linked');assert.equal((await Fx.diaryLinks(benv,['Ab1'])).get('Ab1').tmdb,'603');
 assert.deepEqual(rows(broken,'SELECT alias_id,actual_rating FROM ratings_view ORDER BY alias_id'),[{alias_id:'Ab1',actual_rating:3},{alias_id:'tmdb_603',actual_rating:3}]);
}
{
 // ANOTHER LID's record: the same-scheme conflict of the existing alias protocol. `letterboxd:Other` already points at lb-Ab1 and Ab1 has no mapping: linking would put `letterboxd:Ab1` and the movie on the OTHER record, so it is a proved
 // conflict and that record stays untouched
 const {file}=await attached();
 setLinks(file,{'letterboxd:Other':'lb-Ab1'});
 const out=await runOnce(file);
 assert.deepEqual([out.outcome,out.terminal],['alias_conflict',true],JSON.stringify(out));
 assert.deepEqual(getLinks(file),{'letterboxd:Other':'lb-Ab1'},'the existing record is untouched');
 assert.deepEqual(intents(file).map(i=>[i.state,i.link_state]),[['settled','alias_conflict']]);
 // the lid's OWN record already holds a second Letterboxd id: the same predicate, nothing linked
 const two=await attached();setLinks(two.file,{'letterboxd:Ab1':'k1','letterboxd:Other':'k1'});
 const refused=await runOnce(two.file);
 assert.equal(refused.outcome,'alias_conflict',JSON.stringify(refused));assert.deepEqual(getLinks(two.file),{'letterboxd:Ab1':'k1','letterboxd:Other':'k1'});
}

// ===== 8c (third review of PR #1043): the record and view completion is an identity effect, fenced like the link =====
{
 const Fx=vm.runInContext('LetterboxdFacts',ctx);
 // a Diary-first record whose completion has NOT run yet (the settled alias batch landed, the completion failed or was never reached)
 const prepare=async()=>{
  const file=fresh();await mint(file);const env=envOf(file);
  await Fx.applyDiaryEvidence(env,[{lid:'Ab1',watchedDate:'2026-11-15',rating:4,ratingState:'rated',sourceRef:'diary:viewing:1'}]);
  const down={...linkPort(env),complete:async()=>{throw new Error('completion down');}};
  const first=await lidRecheck(env,{lid:'Ab1',requestId:'req-1',reacquire:async()=>found(),ports:down,now:clock()});
  assert.deepEqual([first.outcome,first.projection],['linked','pending'],JSON.stringify(first));
  return {file,env,real:{...linkPort(env),complete:args=>Fx.completeAttachedLink(env,args)}};
 };
 const recordDoc=file=>{const r=rows(file,'SELECT body FROM ratings_document WHERE key='+sqlText('letterboxd/facts/films/lb-Ab1.json')+' ORDER BY part');return r.length?JSON.parse(r.map(x=>x.body).join('')):null;};
 const viewIds=file=>rows(file,'SELECT alias_id FROM ratings_view ORDER BY alias_id').map(r=>r.alias_id);
 const replay=(env,ports)=>lidRecheck(env,{lid:'Ab1',requestId:'req-1',ports,now:clock()});

 // (a) a PROVED CORRECTION after the settlement: the claim was reassigned, then the settled request is replayed: nothing is written (no obsolete movie id on the record, no view row of it)
 {
  const {file,env,real}=await prepare();
  const before=JSON.stringify([recordDoc(file),viewIds(file)]);
  sqlite(file,"UPDATE film_external_id SET trusted=0 WHERE scheme='tmdb' AND value='603'");
  const out=await replay(env,real);
  assert.deepEqual([out.outcome,out.projection],['linked','blocked'],JSON.stringify(out));
  assert.equal(JSON.stringify([recordDoc(file),viewIds(file)]),before,'no stale identity and no stale view row after a correction');
  assert.equal(recordDoc(file).links.tmdb??null,null);
  // a retirement and a merge are corrections too
  const r=await prepare();sqlite(r.file,RETIRE);const retired=await replay(r.env,r.real);assert.equal(retired.projection,'blocked');assert.equal(recordDoc(r.file).links.tmdb??null,null);
  const m=await prepare();sqlite(m.file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:603',1,NULL,'Survivor','2026-11-27T09:50:00.000Z');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb:Ab1','film:tmdb:603','2026-11-27T09:50:00.000Z')");
  assert.equal((await replay(m.env,m.real)).projection,'blocked');assert.equal(recordDoc(m.file).links.tmdb??null,null);
 }
 // (b) the alias REMAPPED between the observation and the record write: the batch carries the document fence of THAT observation, so it is refused whole; the replay then sees the new mapping and writes nothing
 {
  const {file,env,real}=await prepare();
  let remapped=false;
  const hooked=envOf(file,{onBatch:async list=>{if(!remapped&&list.some(item=>/letterboxd\/facts\/films\/lb-Ab1/.test(item.text))){remapped=true;setLinks(file,{'letterboxd:Ab1':'lb-Ab1','tmdb:603':'tmdb-other'});}}});
  const out=await replay(hooked,{...linkPort(hooked),complete:args=>Fx.completeAttachedLink(hooked,args)});
  assert.equal(remapped,true);
  assert.deepEqual([out.outcome,out.projection],['linked','pending'],JSON.stringify(out));
  assert.equal(recordDoc(file).links.tmdb??null,null,'the stale observation wrote no movie id');
  assert.deepEqual(viewIds(file),['Ab1'],'and no view row of the movie');
  const next=await replay(env,real);
  assert.equal(next.projection,'pending','after the remap the pair is not the lid key mapping any more: nothing is written');
  assert.equal(recordDoc(file).links.tmdb??null,null);
 }
 // (c) a closed or not-authoritative Ratings domain: no write at all, the legacy store included
 {
  const {file,env,real}=await prepare();
  sqlite(file,"UPDATE ratings_domain_authority SET cutover='held', generation=generation+1");
  const out=await replay(env,real);
  assert.equal(out.projection,'pending',JSON.stringify(out));assert.equal(recordDoc(file).links.tmdb??null,null);
  assert.equal(r2.size,0,'the legacy R2 stand-in was not written either');
 }
 // (d) the record moved (a redirect): never followed, a conflict, nothing written
 {
  const {file,env,real}=await prepare();
  const doc=recordDoc(file);setDocRaw(file,'letterboxd/facts/films/lb-Ab1.json',{...doc,redirectTo:'lb-Other'});
  const out=await replay(env,real);
  assert.equal(out.projection,'conflict',JSON.stringify(out));assert.equal(recordDoc(file).redirectTo,'lb-Other');
 }
 // (e) a replay with the guards intact completes the record AND both view rows
 {
  const {file,env,real}=await prepare();
  const out=await replay(env,real);
  assert.equal(out.projection,undefined,JSON.stringify(out));
  assert.equal(recordDoc(file).links.tmdb,'603');assert.deepEqual(viewIds(file),['Ab1','tmdb_603']);
  // (f) the INTERRUPTED record-to-view boundary: the record carries the movie but a view row is missing (a crash between the two): the replay checks the ACTUAL rows and repairs them under the same guards
  sqlite(file,"DELETE FROM ratings_view WHERE alias_id='tmdb_603'");
  assert.deepEqual(viewIds(file),['Ab1']);
  const repaired=await replay(env,real);
  assert.equal(repaired.projection,undefined,JSON.stringify(repaired));
  assert.deepEqual(rows(file,'SELECT alias_id,actual_rating FROM ratings_view ORDER BY alias_id'),[{alias_id:'Ab1',actual_rating:4},{alias_id:'tmdb_603',actual_rating:4}],'the missing movie view row is back, with the rating');
  // and a fully complete pair writes nothing on a further replay
  const snap=JSON.stringify([recordDoc(file),rows(file,'SELECT * FROM ratings_view ORDER BY alias_id')]);
  await replay(env,real);assert.equal(JSON.stringify([recordDoc(file),rows(file,'SELECT * FROM ratings_view ORDER BY alias_id')]),snap);
 }
}
console.log('Lid TMDB attach (AIR-675, tests 9, 10, 11 and 16 and the fenced Ratings link) passed.');
