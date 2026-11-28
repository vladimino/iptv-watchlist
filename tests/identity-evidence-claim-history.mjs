// AIR-641 / ADR 0215 (Accepted), card E3c: the family (c) extraction of canonical claim history and retirement (src/identity-evidence-claim-history.js), on the offline sqlite3-CLI
// stand-in and the pure dry run of card ER. No Worker, R2, network or production access.
// Covered (ADR 0215 Tables 5 and 10): c1 and c6-c9 counted with no row; c2 (402-style null-provenance tmdb) no row; c3 each claim `bridge_root_unavailable`, a reviewer's causal root
// only listed; c4 retire as `same_work` with `source_order` = seq and `confirmation.at`, restore as a scoped withdrawal naming the retire's key, an unresolved restore reported;
// c5 `film_has_id` only on an exact provenance match, ambiguous or mismatching claims unattributable, untrusted retired `tmdb` no row; the report-only dry run; replay and
// determinism of the digest; every read is a plain SELECT that runs on the real schema; the dormant wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {evidenceKeyOf,normalizeEvidence} from '../src/identity-evidence.js';
import {CLAIM_HISTORY_READS,CLAIM_HISTORY_FAMILY,extractClaimHistory} from '../src/identity-evidence-claim-history.js';
import {planManifest} from '../src/identity-evidence-import.js';

const CONFIRMATION={by:'owner',at:'2026-10-30',source:'https://trello.com/c/EswNQuv8'};
const FILMS=[
 {lid:'1IUo',movie:'17266',tv:'9687',url:'https://letterboxd.com/film/the-odyssey/'},
 {lid:'3tCe',movie:'101915',tv:'8042',url:'https://letterboxd.com/film/tess-of-the-durbervilles/'},
 {lid:'daU4',movie:'378779',tv:'64099',url:'https://letterboxd.com/film/war-and-peace-2016/'},
 {lid:'g97G',movie:'452736',tv:'1457',url:'https://letterboxd.com/film/pride-and-prejudice-1995/'}
];
const evidenceOf=item=>({movieStatus:404,movieCheckedAt:'2026-10-30T10:00:00Z',letterboxdUrl:item.url,link:'tv/'+item.tv,linkCheckedAt:'2026-10-30T10:01:00Z',tvResponseId:item.tv,tvCheckedAt:'2026-10-30T10:02:00Z'});
const decisionRow=(seq,item,over={})=>({seq,request_id:'r2-import:abc'+seq+':film:'+item.lid,film_id:'film:'+item.lid,kind:'retire',lid:item.lid,movie_id:item.movie,tv_id:item.tv,evidence_json:JSON.stringify(evidenceOf(item)),
 confirmation_json:JSON.stringify(CONFIRMATION),origin:'r2_import',input_sha256:'a'.repeat(64),supersedes_seq:null,...over});
const tvClaimRow=(item,over={})=>({film_id:'film:'+item.lid,scheme:'tmdb_tv',value:item.tv,trusted:1,conflicting:0,
 provenance_json:JSON.stringify({source:'letterboxd_tmdb_link',url:item.url,link:'tv/'+item.tv,checkedAt:'2026-10-30T10:01:00Z',confirmation:CONFIRMATION}),...over});
const baseData=()=>({
 decisions:FILMS.map((item,index)=>decisionRow(index+1,item)),
 tvClaims:FILMS.map(item=>tvClaimRow(item)),
 retiredMovieClaims:FILMS.map(item=>({film_id:'film:'+item.lid,scheme:'tmdb',value:item.movie,trusted:0,conflicting:0,provenance_json:'{"status":"retired"}'})),
 tmdbClaimsOnOtherFilms:[{film_id:'film:AbCd',scheme:'tmdb',value:'12345',trusted:1,conflicting:0,provenance_json:null},{film_id:'film:EfGh',scheme:'tmdb',value:'67890',trusted:1,conflicting:0,provenance_json:null}],
 letterboxdClaimsOnOtherFilms:[{film_id:'film:tmdb:99',scheme:'letterboxd',value:'xY12',trusted:1,conflicting:0,provenance_json:'{"source":"ratings_alias_bridge"}'}],
 counts:{c1_tmdb:10,c1_letterboxd:5,c6_slug:5,c7_receipts:30,c8_redirects:2}
});
const COHORT='2026-11-28T08:00:00.000Z';
const dry=async(data,runId='e3c-test-1')=>{const {records,report}=await extractClaimHistory(data);const plan=await planManifest({runId,family:CLAIM_HISTORY_FAMILY,cohortAt:COHORT,records});return {records,report,plan};};

// 1. The historical shape: four retire decisions and the four TV claims they applied.
{
 const {records,report,plan}=await dry(baseData());
 assert.equal(records.length,8,'four decisions and four attributed TV claims');
 assert.equal(plan.report.disposition,'import_candidate');
 assert.equal(plan.report.counts.rows,8);
 assert.match(plan.digest,/^[0-9a-f]{64}$/);
 assert.equal(report.families.c4.retire,4);assert.equal(report.families.c4.rows,4);assert.equal(report.families.c5.attributed,4);assert.deepEqual(report.families.c5.unattributable,[]);
 assert.deepEqual(report.families.c4.dateOnly,[1,2,3,4],'a date-only confirmation is read as midnight UTC and reported');
 const rows=plan.manifest.chunks.flatMap(chunk=>chunk.rows);
 const sameWork=rows.filter(row=>row.relation==='same_work'),applied=rows.filter(row=>row.relation==='film_has_id');
 assert.equal(sameWork.length,4);assert.equal(applied.length,4);
 for(const [index,row] of sameWork.entries()){
  assert.equal(row.subjectKind,'tmdb_movie');assert.equal(row.objectKind,'tmdb_tv');assert.equal(row.polarity,'asserts');assert.equal(row.route,'owner_action');assert.equal(row.method,'owner_statement');
  assert.equal(row.sourceOrder,index+1,'source_order is the decision seq');assert.equal(row.observedAt,'2026-10-30T00:00:00.000Z');assert.equal(row.sourceRoot,'r2-import:abc'+(index+1)+':film:'+FILMS[index].lid);
  assert.equal(row.filmId,'film:'+FILMS[index].lid);
 }
 for(const row of applied){assert.equal(row.subjectKind,'film');assert.equal(row.objectKind,'tmdb_tv');assert.equal(row.observedAt,null,'application time is not recorded');assert.equal(row.sourceOrder,null,'application order is not recorded');}
 assert.equal(new Set(rows.map(row=>row.key)).size,8,'every evidence key once');
 // c2, c3, c1, c6-c9: reported, no row.
 assert.equal(report.families.c2.count,2);assert.equal(report.families.c2.rows,0);
 assert.equal(report.families.c3.count,1);assert.equal(report.families.c3.claims[0].reason,'bridge_root_unavailable');assert.equal(report.families.c3.claims[0].source,'ratings_alias_bridge');assert.equal(report.families.c3.rows,0);
 assert.deepEqual([report.families.c1.tmdb,report.families.c1.letterboxd,report.families.c6.count,report.families.c7.count,report.families.c8.count],[10,5,5,30,2]);
 assert.equal(report.retiredMovieUntrusted,4,'the untrusted retired tmdb rows give no row');
 assert.equal(rows.some(row=>row.subjectValue==='xY12'||row.objectValue==='xY12'),false,'no bridge row is invented');
}

// 2. Replay and determinism: the same extraction gives the same digest; another order of the claim rows does too; another run id gives another digest.
{
 const first=await dry(baseData()),second=await dry(baseData()),shuffled=await dry({...baseData(),tvClaims:[...baseData().tvClaims].reverse()});
 assert.equal(first.plan.digest,second.plan.digest);
 assert.notEqual(first.plan.digest,shuffled.plan.digest,'the manifest order follows the extraction order, so a reordered read is a different cohort and needs its own GO');
 assert.notEqual(first.plan.digest,(await dry(baseData(),'e3c-test-2')).plan.digest);
 // `recorded_at` of a loaded row (the load time) is never read: it does not enter a guard.
 const withTime=baseData();withTime.decisions=withTime.decisions.map(row=>({...row,recorded_at:'2026-11-04T10:00:00.000Z'}));
 assert.equal((await dry(withTime)).plan.digest,first.plan.digest);
 for(const chunk of first.plan.manifest.chunks)for(const source of chunk.sources)if(source.table==='tmdb_retirement_decision')assert.equal('recorded_at' in source.guard,false);
}

// 3. c5: a TV claim is attributed only on an exact provenance match with exactly one retire decision.
{
 for(const [name,mutate] of [
  ['link',row=>({...row,provenance_json:JSON.stringify({...JSON.parse(row.provenance_json),link:'tv/1'})})],
  ['url',row=>({...row,provenance_json:JSON.stringify({...JSON.parse(row.provenance_json),url:'https://letterboxd.com/film/other/'})})],
  ['checkedAt',row=>({...row,provenance_json:JSON.stringify({...JSON.parse(row.provenance_json),checkedAt:'2026-10-31T00:00:00Z'})})],
  ['confirmation',row=>({...row,provenance_json:JSON.stringify({...JSON.parse(row.provenance_json),confirmation:{...CONFIRMATION,by:'someone'}})})],
  ['null provenance',row=>({...row,provenance_json:null})],
  ['not json',row=>({...row,provenance_json:'{'})],
  ['other film',row=>({...row,film_id:'film:zzzz'})]
 ]){
  const data=baseData();data.tvClaims[0]=mutate(data.tvClaims[0]);
  const {report,plan}=await dry(data);
  assert.equal(report.families.c5.attributed,3,name);assert.equal(report.families.c5.unattributable.length,1,name);assert.equal(report.families.c5.unattributable[0].reason,'no_matching_decision',name);
  assert.equal(plan.report.counts.rows,7,name+': the unattributable claim yields no row');
 }
 // Two retire decisions that both match the claim make it ambiguous: no row, reported.
 const ambiguous=baseData();ambiguous.decisions.push(decisionRow(5,FILMS[0],{request_id:'req-second'}));
 const {report}=await dry(ambiguous);
 assert.equal(report.families.c5.unattributable.length,1);assert.equal(report.families.c5.unattributable[0].reason,'ambiguous_decisions');
 // Untrusted or conflicting TV claims are not counted as applications.
 const untrusted=baseData();untrusted.tvClaims[1]=tvClaimRow(FILMS[1],{trusted:0});
 assert.equal((await dry(untrusted)).report.families.c5.trustedTv,3);
}

// 4. c4 restore: a scoped withdrawal of the retire row it supersedes, ordered by its own seq; unresolved targets give no row.
{
 const data=baseData();
 data.decisions.push(decisionRow(5,FILMS[0],{request_id:'restore-1',kind:'restore',supersedes_seq:1,evidence_json:JSON.stringify({reason:'wrong'}),confirmation_json:JSON.stringify({...CONFIRMATION,at:'2026-11-02T09:30:00Z'})}));
 const {records,report,plan}=await dry(data);
 assert.equal(report.families.c4.restore,1);assert.deepEqual(report.families.c4.restoreUnresolved,[]);
 const retire=plan.manifest.chunks.flatMap(chunk=>chunk.rows).find(row=>row.sourceRoot==='r2-import:abc1:film:1IUo'&&row.relation==='same_work');
 const withdrawal=plan.manifest.chunks.flatMap(chunk=>chunk.rows).find(row=>row.sourceRoot==='restore-1');
 assert.ok(retire&&withdrawal);
 assert.equal(withdrawal.polarity,'refutes');assert.equal(withdrawal.scopeEvidenceKey,retire.key,'it names exactly the retire row');assert.equal(withdrawal.sourceOrder,5);assert.equal(withdrawal.observedAt,'2026-11-02T09:30:00.000Z');
 assert.equal(plan.report.counts.rows,9);assert.equal(records.length,9);
 assert.deepEqual(report.families.c4.dateOnly,[1,2,3,4],'an instant confirmation is not date-only');
 // The retire key is deterministic: it is the key the ledger formula gives the same row.
 const expected=await evidenceKeyOf(normalizeEvidence({subject:{kind:'tmdb_movie',value:'17266'},relation:'same_work',object:{kind:'tmdb_tv',value:'9687'},polarity:'asserts',route:'owner_action',method:'owner_statement',
  sourceRoot:'r2-import:abc1:film:1IUo',origin:'reconstruction',reconstructionRun:'x',reconstructedFrom:'y'}));
 assert.equal(retire.key,expected);
 // Unresolved: no such seq, a restore of a restore, another Film, other ids.
 for(const [name,over] of [['missing',{supersedes_seq:99}],['restore of restore',{supersedes_seq:5}],['other film',{supersedes_seq:2}],['other ids',{supersedes_seq:1,tv_id:'1'}]]){
  const bad=baseData();
  bad.decisions.push(decisionRow(5,FILMS[0],{request_id:'restore-1',kind:'restore',supersedes_seq:1,evidence_json:JSON.stringify({reason:'wrong'})}));
  bad.decisions.push(decisionRow(6,FILMS[0],{request_id:'restore-2',kind:'restore',evidence_json:JSON.stringify({reason:'wrong'}),...over}));
  const result=await dry(bad);
  assert.equal(result.report.families.c4.restoreUnresolved.length,1,name);assert.equal(result.report.families.c4.restoreUnresolved[0].seq,6,name);assert.equal(result.plan.report.counts.rows,9,name);
 }
}

// 5. c3: a reviewer's found causal root is listed for review and never mapped to a row.
{
 const data=baseData();data.causalRoots=[{filmId:'film:tmdb:99',value:'xY12',source:'page-check-digest-from-review'}];
 const {report,plan}=await dry(data);
 assert.equal(report.families.c3.reviewRequired.length,1);assert.equal(report.families.c3.rows,0);assert.equal(plan.report.counts.rows,8);
 assert.match(report.families.c3.reviewRequired[0].note,/never imported/);
}

// 6. Report-only: nothing eligible gives no manifest and no digest; a decision without confirmation or ids is reported, not guessed.
{
 const empty=await dry({counts:{c1_tmdb:1}});
 assert.equal(empty.plan.manifest,null);assert.equal(empty.plan.digest,null);assert.equal(empty.plan.report.disposition,'no_import');
 const claimsOnly=await dry({...baseData(),decisions:[],tvClaims:baseData().tvClaims});
 assert.equal(claimsOnly.plan.report.disposition,'no_import');assert.equal(claimsOnly.report.families.c5.unattributable.length,4,'no decision attributes a claim: nothing is invented');
 const broken=baseData();broken.decisions[0]=decisionRow(1,FILMS[0],{confirmation_json:null});
 const result=await dry(broken);
 assert.deepEqual(result.report.notEligible,[{seq:1,reason:'decision_incomplete'}]);assert.equal(result.plan.report.counts.rows,6,'the other three decisions and their claims; the first claim is then unattributable');
 assert.equal(result.report.families.c5.unattributable.length,1);
}

// 7. The reads are plain SELECTs that run on the real schema; the minting counts split exactly as defined.
{
 const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-claim-history-'));
 process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
 const file=path.join(root,'c.sqlite');
 const run=(args,input)=>{const r=sqliteSync(args,{input,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
 run(['-bail',file],files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 const lit=value=>value===null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
 const claims=[['film:tmdb:1','tmdb','1',1],['film:tmdb:2','tmdb','2',1],['film:AbCd','tmdb','3',1],['film:AbCd','letterboxd','AbCd',1],['film:tmdb:2','letterboxd','Zz99',1],['film:AbCd','letterboxd_slug','a-slug',0],
  ['film:1IUo','tmdb','17266',0],['film:1IUo','tmdb_tv','9687',1]];
 run(['-bail',file],'PRAGMA foreign_keys=OFF;\n'+claims.map(([film,scheme,value,trusted])=>'INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('+[lit(film),lit(scheme),lit(value),trusted,0,'NULL'].join(',')+');').join('\n'));
 const read=sql=>{const out=run(['-json','-bail',file],sql+';');return out?JSON.parse(out):[];};
 for(const [name,sql] of Object.entries(CLAIM_HISTORY_READS))assert.match(sql,/^SELECT /,name+' is a plain SELECT'),assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA|REPLACE)\b/i.test(sql),name+' writes nothing');
 const counts=read(CLAIM_HISTORY_READS.counts)[0];
 assert.deepEqual([counts.c1_tmdb,counts.c1_letterboxd,counts.c6_slug,counts.c7_receipts,counts.c8_redirects],[2,1,1,0,0]);
 assert.deepEqual(read(CLAIM_HISTORY_READS.tmdbClaimsOnOtherFilms).map(row=>row.film_id+'/'+row.value),['film:AbCd/3'],'only the trusted tmdb on a Film not minted from it');
 assert.deepEqual(read(CLAIM_HISTORY_READS.letterboxdClaimsOnOtherFilms).map(row=>row.film_id+'/'+row.value),['film:tmdb:2/Zz99']);
 assert.deepEqual(read(CLAIM_HISTORY_READS.tvClaims).map(row=>row.value),['9687']);
 assert.deepEqual(read(CLAIM_HISTORY_READS.retiredMovieClaims).map(row=>row.value),['17266']);
 assert.deepEqual(read(CLAIM_HISTORY_READS.decisions),[]);
 // The whole chain on rows read from the real schema.
 const from={decisions:read(CLAIM_HISTORY_READS.decisions),tvClaims:read(CLAIM_HISTORY_READS.tvClaims),retiredMovieClaims:read(CLAIM_HISTORY_READS.retiredMovieClaims),
  tmdbClaimsOnOtherFilms:read(CLAIM_HISTORY_READS.tmdbClaimsOnOtherFilms),letterboxdClaimsOnOtherFilms:read(CLAIM_HISTORY_READS.letterboxdClaimsOnOtherFilms),counts};
 const result=await extractClaimHistory(from);
 assert.equal(result.report.families.c2.count,1);assert.equal(result.report.families.c3.count,1);assert.equal(result.report.families.c5.unattributable.length,1);assert.equal(result.records.length,0);
}

// 8. Dormant: nothing imports this module, it does not import the import path, and it performs no I/O.
{
 const sources=fs.readdirSync('src',{recursive:true}).filter(name=>String(name).endsWith('.js')).map(name=>path.join('src',String(name)));
 const importers=sources.filter(name=>/from\s+['"]\.{1,2}\/(?:[\w-]+\/)*identity-evidence-claim-history\.js['"]/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(importers,[],'no route, Workflow, cron or producer calls it');
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('identity-evidence-claim-history'),'the Worker bundle does not include it');
 const text=fs.readFileSync('src/identity-evidence-claim-history.js','utf8');
 assert.ok(!/from\s+['"]\.\/identity-evidence-import\.js['"]/.test(text),'it does not import the import path');
 assert.ok(!/\bfetch\(|\.prepare\(|\.batch\(|\.put\(|crypto\.randomUUID|Math\.random/.test(text),'no network, D1, R2 write or random id');
 for(const workflow of fs.readdirSync('.github/workflows'))assert.ok(!text.includes(workflow),'not referenced');
}
console.log('identity evidence claim history (family c): ok');
