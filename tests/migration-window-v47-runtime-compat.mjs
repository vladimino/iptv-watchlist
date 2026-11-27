// AIR-603: checkpoint A (schema v47) against the CURRENT bundled Worker code. The v47 database is produced by the window operator itself (v38 -> v47, scratch sqlite), and the
// code that cards C2 (AIR-607) and A2 (AIR-608) rely on is run on it: no new global capability, provenance absent, H1 empty, the Discovery scope settlement not deployed, the
// Letterboxd admission marker `r2` (legacy route), the lid-only table absent. Offline only; nothing is applied anywhere.
import assert from 'node:assert/strict';
import * as Authority from '../src/discovery-authority.js';
import * as D from '../src/catalog-enrichment-discovery.js';
import * as Admission from '../src/letterboxd-admission-authority.js';
import * as FilmAdmission from '../src/film-admission.js';
import {readControl} from '../src/film-metadata-provenance.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {migrated,sql} from './prediction-d1-flow-lib.mjs';
import * as Op from '../scripts/d1-migration-window-production.mjs';

const MID=Date.parse('2026-11-27T13:30:00.000Z'),T='2026-11-27T10:00:00.000Z';
const file=migrated(38);
sql(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
const db=d1Standin(file);
const out=await Op.execute('apply',{binding:db,clock:()=>MID,params:{through:47,start:38,manifestSha256:Op.manifestSha256(),operatorSha256:Op.operatorSha256()}});
assert.equal(out.after.schemaVersion,47);
const env={DB:db,BUCKET:new MemoryBucket()};
const names=()=>sql(file,"SELECT name FROM sqlite_master").map(row=>row.name);

// 1. no capability beyond v47: none of the objects of 0048..0054 exists, and the contract says 47
for(const name of ['film_lid_admission','film_metadata_provenance_control','film_metadata_field','lid_recheck_intent'])assert.equal(names().includes(name),false,name+' is absent at v47');
assert.equal(sql(file,"SELECT COUNT(*) n FROM pragma_table_info('discovery_transfer') WHERE name IN ('origin','origin_batches')")[0].n,0,'0050 columns absent');
assert.equal(sql(file,"SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('identity_assertion','identity_rule_version','identity_application')")[0].n,3,'0054 has not retired anything');

// 2. provenance is absent for the Worker (a null control: the writers keep their pre-0049 path), H1 has no rules and the three identity writers have no control row
assert.equal(await readControl(db),null,'provenance control absent');
assert.equal(await FilmAdmission.hasLidAdmissionTable(db),false,'the lid-only table is absent: no lid-only Film can be admitted');
assert.equal(sql(file,'SELECT COUNT(*) n FROM identity_evidence_writer')[0].n,0,'no writer control row: every identity evidence writer is off');
assert.equal(sql(file,'SELECT COUNT(*) n FROM identity_evidence_writer_change')[0].n,0);

// 3. A2: the Letterboxd admission authority reads r2 at generation 0 and routes legacy (the A2 close and flip are separate owner operations)
const authority=await Admission.readAdmissionAuthority(env);
assert.deepEqual(authority,{mode:'r2',proof:'explicit_r2',generation:0,installed:true,version:47});
assert.equal(Admission.admissionRoute(authority),'legacy');
assert.equal((await Admission.guardLegacyWrite(env)).mode,'r2');

// 4. C2: the Catalog Enrichment tables of 0047 exist and are readable; the Discovery scope settlement of 0050 is NOT deployed, so the activation preflight refuses (the scope cannot be activated by mistake)
const preflight=await D.activationPreflight(env);
assert.deepEqual([preflight.ok,preflight.problems],[false,['schema_not_applied']],'the Discovery scope activation refuses at v47');
assert.equal(sql(file,'SELECT COUNT(*) n FROM catalog_enrichment_scope')[0].n,0,'no scope row: nothing is activated by the schema');
// the Discovery ingest on the real writer emits no enrichment signal at v47 (the staged/admitted triggers belong to 0050)
const lease={id:'lease-603',expiresAt:Date.now()+3600000};
sql(file,"UPDATE discovery_lease SET lease_id='lease-603', expires_at="+lease.expiresAt+", programme_run_id=NULL WHERE id=1");
env.discoveryLease=lease;
const obs=key=>({key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[100],shows:[{channelId:'c',channel:'C',start:Date.now()+3600000,end:Date.now()+3700000}],seenInLatestSnapshot:true,lastAiring:Date.now()+3700000});
const before=sql(file,'SELECT COUNT(*) n FROM enrichment_signal')[0].n;
await Authority.ingestLedger(env,{programmeRunId:'run-603',handoff:true,lease,items:(async function*(){yield obs('obs-a');})()});
assert.equal(sql(file,'SELECT COUNT(*) n FROM enrichment_signal')[0].n,before,'no signal written by the Discovery ingest at v47');
assert.equal(sql(file,'SELECT version FROM schema_contract WHERE id=1')[0].version,47);

// 5. the markers the Worker reads are the ones the window left unchanged
// (the test's own Discovery lease would make the operator answer discovery_busy: release it first, as a quiet window would have)
sql(file,"UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1");
const status=await Op.execute('status',{binding:db,clock:()=>MID});
assert.equal(status.plan[54].decision,'apply','B remains plannable from v47');assert.equal(status.chain.verified,true);
console.log('migration-window-v47-runtime-compat: ok');
