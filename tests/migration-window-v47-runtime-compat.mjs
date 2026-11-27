// AIR-603: checkpoint A (schema v47) against the CURRENT code of the cards that follow it, C2 (AIR-607: the rated Catalog Enrichment scope) and A2 (AIR-608: the Letterboxd
// admission close, flip and D1 admission). The v47 database is produced by the window operator itself (v38 -> v47, scratch sqlite) and the REAL existing paths run on it with the
// existing fixtures and stand-ins (no network, no R2 binding, nothing applied anywhere):
//   C2  only the rated scope is activated (control active, one scope row with the cutoff; no other scope);
//   A2  the admission marker goes r2 -> closed -> d1 and a verified Film is admitted through the D1 path in one fenced batch (Film, claim, receipt with its operation key, evidence row);
//       the 0047 emitters write the eligible `admitted` signal in that batch; the producer consumes it and processes the rated unit (core, localization, credits) WITHOUT any provenance table;
//   no R2 authority write (the environment has no bucket: any use would throw), no Discovery scope, no LID-only table, no writer control row.
import assert from 'node:assert/strict';
import * as Authority from '../src/discovery-authority.js';
import * as D from '../src/catalog-enrichment-discovery.js';
import * as Admission from '../src/letterboxd-admission-authority.js';
import * as FilmAdmission from '../src/film-admission.js';
import * as S from '../src/catalog-enrichment-store.js';
import * as PR from '../src/catalog-enrichment-producer.js';
import {admitVerifiedFilm} from '../src/letterboxd-admission-d1.js';
import {readControl} from '../src/film-metadata-provenance.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {migrated,sql} from './prediction-d1-flow-lib.mjs';
import {tools,upstream} from './catalog-enrichment-fixtures.mjs';
import * as Op from '../scripts/d1-migration-window-production.mjs';

const MID=Date.parse('2026-11-27T13:30:00.000Z');
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const T='2026-11-26T10:00:00.000Z',STAMP='2026-11-25T10:00:00.000Z';
const at=s=>new Date(Date.parse(T)+s*1000).toISOString();
const sha=c=>c.repeat(64);
const evidenceOf=({lid,tmdb,root:r=sha('e'),route='ratings_diary'})=>({subject:{kind:'letterboxd_lid',value:lid},relation:'same_work',object:{kind:'tmdb_movie',value:tmdb},polarity:'asserts',route,method:'page_check',sourceRoot:r,sourceRef:'check:'+lid,observedAt:'2026-11-25T11:59:00.000Z'});
const itemOf=({lid='Ab1',tmdb='603',title='The Matrix',year=1999,digest=sha('e'),evidence=true,...over}={})=>({kind:'lid',lid,receipt:{tmdb,archiveSha256:digest,title,year,filmPath:'/film/the-matrix/'},evidence:evidence?evidenceOf({lid,tmdb,root:digest}):null,...over});

// ---- the operator-built v47, with the production-shaped markers the owner operations rely on ----
const file=migrated(38);
sql(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1;UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1");
sql(file,"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z')");
const db=d1Standin(file);
const applied=await Op.execute('apply',{binding:db,clock:()=>MID,params:{through:47,start:38,manifestSha256:Op.manifestSha256(),operatorSha256:Op.operatorSha256()}});
assert.equal(applied.after.schemaVersion,47);
const env={DB:db};// NO bucket: an R2 authority write would throw
const rows=text=>sql(file,text);
const names=()=>rows("SELECT name FROM sqlite_master").map(row=>row.name);

// 1. no capability beyond v47
for(const name of ['film_lid_admission','film_metadata_provenance_control','film_metadata_field','lid_recheck_intent'])assert.equal(names().includes(name),false,name+' is absent at v47');
assert.equal(rows("SELECT COUNT(*) n FROM pragma_table_info('discovery_transfer') WHERE name IN ('origin','origin_batches')")[0].n,0,'0050 columns absent');
assert.equal(rows("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('identity_assertion','identity_rule_version','identity_application')")[0].n,3,'0054 has not retired anything');
assert.equal(await readControl(db),null,'provenance control absent');
assert.equal(await FilmAdmission.hasLidAdmissionTable(db),false,'the lid-only table is absent: no lid-only Film can be admitted');
assert.equal(rows('SELECT COUNT(*) n FROM identity_evidence_writer')[0].n,0,'no writer control row: every identity evidence writer is off');

// 2. C2: activate ONLY the rated scope (the owner operation: control active, one scope row with the cutoff)
rows("INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'"+T+"','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2");
rows("INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('rated',1,1,'"+T+"',1,'"+T+"')");
assert.deepEqual(rows('SELECT scope,activated,enabled FROM catalog_enrichment_scope'),[{scope:'rated',activated:1,enabled:1}],'only the rated scope');
const generation=rows('SELECT generation FROM catalog_enrichment_control')[0].generation;

// 3. A2: the admission marker at the v47 contract; close, then the d1 flip (the owner operations of A2), then a verified admission through the real D1 path
assert.deepEqual(await Admission.readAdmissionAuthority(env),{mode:'r2',proof:'explicit_r2',generation:0,installed:true,version:47});
assert.equal(Admission.admissionRoute(await Admission.readAdmissionAuthority(env)),'legacy');
rows("UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
assert.equal(Admission.admissionRoute(await Admission.readAdmissionAuthority(env)),'closed');
rows("UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
assert.equal(Admission.admissionRoute(await Admission.readAdmissionAuthority(env)),'d1');
const clock=(()=>{let n=0;return ()=>new Date(Date.parse('2026-11-26T12:00:00.000Z')+(n++)*10).toISOString();})();
const admitted=await admitVerifiedFilm(env,{...itemOf(),now:clock()});
assert.equal(admitted.outcome,'admitted',JSON.stringify(admitted));assert.equal(admitted.terminal,true);
assert.deepEqual(rows("SELECT film_id,tmdb,source_code,receipt_key FROM film_rated_admission"),[{film_id:'film:tmdb:603',tmdb:'603',source_code:'Ab1',receipt_key:'d1'}],'the admission row of the D1 path');
assert.equal(rows("SELECT COUNT(*) n FROM film_external_id WHERE film_id='film:tmdb:603' AND scheme='tmdb' AND value='603' AND trusted=1 AND conflicting=0")[0].n,1,'the trusted tmdb claim');
assert.deepEqual(rows("SELECT state,operation_key,target_id FROM canonical_write_receipt"),[{state:'applied',operation_key:'admission:lid:Ab1',target_id:'film:tmdb:603'}],'the keyed receipt is applied');
assert.equal(rows('SELECT COUNT(*) n FROM film_identity_evidence')[0].n,1,'the evidence row in the same batch');
// the 0047 emitter wrote the eligible signal of the rated scope in that batch
const signals=rows("SELECT kind,subject,source,state FROM enrichment_signal WHERE kind='admitted'");
assert.deepEqual(signals,[{kind:'admitted',subject:'tmdb:603',source:'rated',state:'pending'}],'the admission emits one pending rated `admitted` signal');

// 4. C2: the producer consumes that signal and processes the rated unit with provenance ABSENT (no provenance table is needed or written)
const lease=await S.acquireLease(env,{leaseId:'lease-603-aaaaaaaa',now:T});
const [signal]=await S.runnableSignals(env,{now:at(1)});
assert.ok(signal,'the signal is runnable');
assert.equal((await S.consumeSignal(env,{signal,generation,leaseId:lease.leaseId,now:at(1)})).consumed,true);
const up=upstream({});
const step=(now,extra={})=>PR.processFilm(env,{filmId:'film:tmdb:603',leaseId:lease.leaseId,generation,now,tools,fetchImpl:up,env,...extra});
assert.equal((await step(at(10))).state,'replan','a new Film is first anchor-checked');
const done=await step(at(11));
assert.equal(done.state,'done',JSON.stringify(done));
const meta=rows("SELECT year,runtime FROM film_metadata WHERE film_id='film:tmdb:603'")[0];
assert.deepEqual(meta,{year:1999,runtime:136},'the core unit wrote the Film metadata');
assert.ok(rows("SELECT COUNT(*) n FROM catalog_enrichment_state WHERE film_id='film:tmdb:603'")[0].n>=3,'the state rows of the film and its parts');
assert.equal(names().includes('film_metadata_field'),false,'still no provenance table');
assert.equal(await readControl(db),null,'and no provenance control: the writers took their pre-provenance path');

// 5. nothing outside the two cards: no Discovery scope, no other scope, the Discovery scope activation refuses at v47, no R2 object was needed
assert.deepEqual(rows('SELECT scope FROM catalog_enrichment_scope'),[{scope:'rated'}]);
const preflight=await D.activationPreflight(env);
assert.deepEqual([preflight.ok,preflight.problems],[false,['schema_not_applied']],'the Discovery scope activation refuses at v47');
const lease2={id:'lease-603-d',expiresAt:Date.now()+3600000};
rows("UPDATE discovery_lease SET lease_id='lease-603-d', expires_at="+lease2.expiresAt+", programme_run_id=NULL WHERE id=1");
env.discoveryLease=lease2;
const obs=key=>({key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[100],shows:[{channelId:'c',channel:'C',start:Date.now()+3600000,end:Date.now()+3700000}],seenInLatestSnapshot:true,lastAiring:Date.now()+3700000});
const before=rows("SELECT COUNT(*) n FROM enrichment_signal WHERE source='discovery'")[0].n;
await Authority.ingestLedger(env,{programmeRunId:'run-603',handoff:true,lease:lease2,items:(async function*(){yield obs('obs-a');})()});
assert.equal(rows("SELECT COUNT(*) n FROM enrichment_signal WHERE source='discovery'")[0].n,before,'the Discovery ingest emits no enrichment signal at v47');
assert.equal(rows('SELECT version FROM schema_contract WHERE id=1')[0].version,47);
console.log('migration-window-v47-runtime-compat: ok');
