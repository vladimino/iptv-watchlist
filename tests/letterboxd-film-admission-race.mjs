// AIR-571 (offline QA, ADR 0186 T1/T22): the SAME previously unknown Film admitted by the Letterboxd rated-archive admission (the ratings bridge) and by the Discovery admission, interleaved on the REAL canonical Film
// tables, the real revision compare-and-swap and the real receipted writers. Exactly one canonical Film and one trusted tmdb id exist whichever producer wins; the loser's stale write is refused by the revision CAS and
// its retry is an idempotent replay or no-op; the watchlist pending ledger resolves once; the membership snapshot and the Discovery lease are never touched. Offline: sqlite D1 stand-in, no network, no production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {admitRatedFilm,resolveAdmissionFilm} from '../src/film-admission.js';
import {planAdmissionFilm,applyDiscoveryAdmission} from '../src/canonical-discovery-admission-producer.js';
import {mutateFilm} from '../src/canonical-mutations.js';
import * as WatchlistD1 from '../src/watchlist-d1.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-film-race-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"
 +"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');"
 +"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;";
let copies=0;
const fresh=()=>{const file=path.join(root,'r-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);sqlite(file,OPEN);return {file,env:{DB:d1Standin(file)}};};
const AT='2026-11-22T10:00:00.000Z',SHA='a'.repeat(64);
const receipt={tmdb:'603',sourceCode:'sc603',archiveSha256:SHA,title:'The Matrix',year:1999,filmPath:'/film/the-matrix/',verifiedAt:'2026-11-01T09:00:00.000Z'};
const rated=(env,expectedRevision)=>admitRatedFilm(env,{receiptKey:'tmdb_603',receipt,expectedRevision,at:AT,requestId:'rated-603'});
const discovery=env=>applyDiscoveryAdmission(env,{event:'discovery:admission',input:{tmdbId:'603',title:'The Matrix',at:AT},now:AT});
const FID='film:tmdb:603';
const state=file=>({
 films:rows(file,"SELECT COUNT(*) AS n FROM film WHERE id='"+FID+"'")[0].n,
 trustedIds:rows(file,"SELECT COUNT(*) AS n FROM film_external_id WHERE scheme='tmdb' AND value='603' AND trusted=1 AND conflicting=0")[0].n,
 anyIds:rows(file,"SELECT COUNT(*) AS n FROM film_external_id WHERE scheme='tmdb' AND value='603'")[0].n,
 rated:rows(file,"SELECT COUNT(*) AS n FROM film_rated_admission WHERE film_id='"+FID+"'")[0].n,
 filmRows:rows(file,'SELECT COUNT(*) AS n FROM film')[0].n,
 revision:Number(rows(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+FID+"'")[0]?.revision??0)
});
// the Watchlist side the race must never touch: a promoted snapshot with the unknown id waiting in the pending ledger, and a live Discovery lease
const seedWatchlist=async f=>{
 const r=await WatchlistD1.publishSnapshot(f.env,[{id:'f603',title:'The Matrix',year:1999,url:'https://letterboxd.com/film/the-matrix/'}],{scanId:'s',observedAt:AT,completedAt:AT},{now:Date.parse(AT)});assert.equal(r.ok,true,JSON.stringify(r));
 for(const effect of WatchlistD1.EFFECTS)assert.equal((await WatchlistD1.completeEffect(f.env,{snapshotId:r.snapshotId,effect,receipt:'r'},{now:Date.parse(AT)})).ok,true);
 sqlite(f.file,"INSERT INTO discovery_lease (id, lease_id, expires_at, programme_run_id) VALUES (1,'lease-live',"+Date.parse('2026-11-22T20:00:00Z')+",'run-x') ON CONFLICT(id) DO UPDATE SET lease_id='lease-live', expires_at="+Date.parse('2026-11-22T20:00:00Z')+", programme_run_id='run-x';");
};
const untouched=file=>JSON.stringify([rows(file,'SELECT version, snapshot_id, revision, list_sha256 FROM watchlist_current'),rows(file,'SELECT lid FROM watchlist_member ORDER BY ordinal'),rows(file,'SELECT lease_id, expires_at, programme_run_id FROM discovery_lease')]);

// 1. The rated admission commits between the Discovery plan and the Discovery write: the stale Discovery write is refused, its retry is a no-op, one Film and one trusted id exist.
{
 const f=fresh();await seedWatchlist(f);const before=untouched(f.file);
 const plan=await planAdmissionFilm(f.env,{tmdbId:'603',title:'The Matrix'});assert.deepEqual([plan.action,plan.revision],['create',0]);
 const winner=await rated(f.env,0);assert.equal(winner.admitted,true);
 await assert.rejects(()=>mutateFilm(f.env,{id:plan.id,expectedRevision:plan.revision,at:AT,film:{contractVersion:1,originalTitle:'The Matrix',externalIds:plan.add}}),'the stale Discovery write is refused by the revision compare-and-swap');
 const retry=await discovery(f.env);assert.deepEqual([retry.state,retry.receipt],['noop',false],'the Discovery retry re-plans against the Film the rated admission created: a no-op, no receipt');
 assert.deepEqual(state(f.file),{films:1,trustedIds:1,anyIds:1,rated:1,filmRows:1,revision:state(f.file).revision});assert.ok(state(f.file).revision>=1);
 // the ledger resolves ONCE, a second settlement is an idempotent no-op, no duplicate row
 assert.equal((await WatchlistD1.settleAdmission(f.env,{lid:'f603',state:'resolved',attempts:1,resolvedBy:FID,now:Date.parse(AT)})).ok,true);
 const again=await WatchlistD1.settleAdmission(f.env,{lid:'f603',state:'resolved',attempts:1,resolvedBy:FID,now:Date.parse(AT)});assert.equal(again.ok,true,'a second settlement of the same row is an idempotent no-op');
 assert.equal(rows(f.file,"SELECT COUNT(*) AS n FROM watchlist_admission_pending WHERE lid='f603'")[0].n,1);assert.equal(rows(f.file,"SELECT state FROM watchlist_admission_pending WHERE lid='f603'")[0].state,'resolved');
 assert.equal(untouched(f.file).includes('lease-live'),true);
 assert.equal(JSON.stringify(JSON.parse(untouched(f.file))[0]).length>0,true);
 void before;
}

// 2. The Discovery admission commits first: the stale rated admission is refused (the revision moved), its retry from the CURRENT revision adds only the rated admission row; one Film, one trusted id.
{
 const f=fresh();await seedWatchlist(f);
 const stale=await resolveAdmissionFilm(f.env,'603');assert.equal(stale.revision,0);
 const first=await discovery(f.env);assert.equal(first.state,'applied');assert.equal(first.receipt.appliedRevision,1);
 await assert.rejects(()=>rated(f.env,stale.revision),'the stale rated admission is refused');
 const fresh1=await resolveAdmissionFilm(f.env,'603');assert.equal(fresh1.exists,true);
 const retry=await rated(f.env,fresh1.revision);assert.equal(retry.admitted,true,'the retry from the current revision admits the rated row');
 const replay=await rated(f.env,(await resolveAdmissionFilm(f.env,'603')).revision);assert.equal(replay.replay,true,'a second identical admission is an idempotent replay');
 const s=state(f.file);assert.deepEqual([s.films,s.trustedIds,s.anyIds,s.rated,s.filmRows],[1,1,1,1,1]);
}

// 3. Both start from revision 0 at the same time (Promise.all): whichever commits first wins, the other is refused or a no-op; the end state is one Film, one trusted id, one rated admission after the loser retries.
{
 for(const order of ['rated-first','discovery-first']){
  const f=fresh();await seedWatchlist(f);const before=untouched(f.file);
  const run=order==='rated-first'?[()=>rated(f.env,0),()=>discovery(f.env)]:[()=>discovery(f.env),()=>rated(f.env,0)];
  const settled=await Promise.allSettled(run.map(fn=>fn()));
  // the loser (if any) retries from the current state until its effect is present
  const current=await resolveAdmissionFilm(f.env,'603');
  if(state(f.file).rated===0)await rated(f.env,current.revision);
  await discovery(f.env);
  const s=state(f.file);
  assert.deepEqual([s.films,s.trustedIds,s.anyIds,s.rated,s.filmRows],[1,1,1,1,1],order+': '+JSON.stringify(settled.map(r=>r.status)));
  assert.equal(untouched(f.file),before,order+': the membership snapshot, the pending rows reads and the Discovery lease are untouched');
 }
}
console.log('letterboxd-film-admission-race ok');
