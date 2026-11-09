// AIR-391 (spike, ADR 0106 Proposed): the read-validity of the grouped write path of scripts/projector-spike-bench.mjs. The group prefetches the
// repository's reads in one batch and writes in a second; the guards inside the write batch re-run every prefetched read and the marker generation
// and refuse the whole group when anything differs. Each conflicting state between the two batches below must be refused with NO row of the group
// written, and the group must then fall back to the per-entity path and end in the same rows as the plain path. Scope: these fixtures and this
// stand-in; nothing here touches the Worker bundle.
import assert from 'node:assert/strict';
import {standin,recordingProjector,sources,seedFilms,filmRecord,bulkGroup,perEntity,holdLease,digestSql,dump} from '../scripts/projector-spike-bench.mjs';

const POOL=40;
async function fixture(){
 const db=standin(),rec=recordingProjector();
 await rec.projector.runD1EnrichmentProjection({DB:db,BUCKET:sources(seedFilms(POOL)),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e9});
 rec.captured.length=0;
 const films=Array.from({length:4},(_,index)=>filmRecord(index,3,POOL));
 await rec.projector.runD1EnrichmentProjection({DB:standin(),BUCKET:sources(films),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e9});
 return {db,projector:rec.projector,films,captured:rec.captured};
}
// Items of the first two Films (their own Persons first) from a plain run on a scratch database.
async function items(){
 const scratch=standin(),rec=recordingProjector();
 const films=Array.from({length:4},(_,index)=>filmRecord(index,3,POOL));
 await rec.projector.runD1EnrichmentProjection({DB:scratch,BUCKET:sources([...seedFilms(POOL),...films]),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e9});
 const people=new Map(rec.captured.filter(x=>x.kind==='person').map(x=>[x.input.person.id,x]));
 const filmItems=rec.captured.filter(x=>x.kind==='film').slice(-4);
 const out=[];const seen=new Set();
 for(const film of filmItems)for(const credit of film.input.credits||[])if(people.has(credit.personId)&&!seen.has(credit.personId)){seen.add(credit.personId);out.push(people.get(credit.personId));}
 return {order:[...out,...filmItems],all:rec.captured,scratch};
}
const base=await items();
const prepared=async()=>{
 const db=standin(),rec=recordingProjector();
 await rec.projector.runD1EnrichmentProjection({DB:db,BUCKET:sources(seedFilms(POOL)),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e9});
 holdLease(db);db.resetCalls();
 return {db,projector:rec.projector};
};
const count=(db,table)=>db.sqlite.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
const groupRows=db=>count(db,'film')+count(db,'person')+count(db,'film_person_credit')+count(db,'projection_state');
const filmIdOf=item=>item.input.film.id;

// 0. A group with no interference: applied in two round trips with every read proven, and the rows equal the plain path's.
let plain;
{
 const {db,projector}=await prepared();
 const stats=await bulkGroup(projector,db,base.order,{lease:'lease-bench'});
 assert.equal(stats.outcome,'applied',JSON.stringify(stats));
 assert.equal(db.calls.batches,2,'one prefetch batch and one write batch');assert.equal(db.calls.reads+db.calls.singleWrites,0);
 assert.ok(stats.guards>=4*3,'every distinct read has a guard: '+stats.guards);assert.equal(stats.prefetchMisses,0);
 plain=await prepared();
 assert.deepEqual(await perEntity(plain.projector,plain.db,base.order,{lease:'lease-bench'}),[]);
 assert.equal(dump(db),dump(plain.db),'the grouped path leaves the rows of the per-entity path (this fixture)');
 const dangling=db.sqlite.prepare('SELECT COUNT(*) AS n FROM film_person_credit c LEFT JOIN person p ON p.id=c.person_id WHERE p.id IS NULL').get().n;
 assert.equal(dangling,0);
}

// 1..4. A writer changes state the group read, between the prefetch and the write batch. The write batch is refused whole.
const conflicts=[
 ['a redirect appears for a Film of the group',(db,item)=>db.sqlite.exec("INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',1,NULL,'x','t'); INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+filmIdOf(item)+"','film:other','t')")],
 ['an owner review of a Person of the group appears',(db)=>{const target=base.order.find(item=>item.kind==='person').input.person;db.sqlite.prepare("INSERT OR IGNORE INTO person (id,role_id,contract_version,updated_at) VALUES (?,?,1,'t')").run(target.id,'role:'+target.id);db.sqlite.prepare("INSERT OR REPLACE INTO person_dimension (person_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES (?,'localization','reviewed','owner',NULL,NULL,'Owner value','owner',NULL,NULL,NULL,0,'none','t')").run(target.id);}],
 ['the marker generation moves (a canonical writer is being activated)',db=>db.sqlite.exec('UPDATE film_person_authority SET generation=generation+1')],
 ['the projector lease is lost',db=>db.sqlite.exec("UPDATE projection_run SET lease_id='someone-else'")],
];
for(const [name,mutate] of conflicts){
 const {db,projector}=await prepared();
 const film=base.order.find(item=>item.kind==='film');
 let rowsBefore=null;
 const stats=await bulkGroup(projector,db,base.order,{lease:'lease-bench',beforeApply:async()=>{mutate(db,film);rowsBefore=groupRows(db);}});
 assert.equal(stats.outcome,'fallback',name+': '+JSON.stringify(stats));
 assert.equal(stats.reason,'guard_refused',name);
 assert.equal(groupRows(db),rowsBefore,name+': the refused batch wrote nothing');
}

// 5. A conflict that the per-entity path also reports: the redirected Film fails alone, every other entity is written.
{
 const {db,projector}=await prepared();
 const film=base.order.find(item=>item.kind==='film');
 db.sqlite.exec("INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',1,NULL,'x','t'); INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+filmIdOf(film)+"','film:other','t')");
 const stats=await bulkGroup(projector,db,base.order,{lease:'lease-bench'});
 assert.equal(stats.outcome,'fallback','a redirect that is already there is found by the traced read at prefetch time');
 assert.equal(stats.reason,'plan_error');
 const errors=await perEntity(projector,db,base.order,{lease:'lease-bench'});
 assert.deepEqual(errors.map(item=>item.id),[filmIdOf(film)],'only the redirected Film fails');
 assert.match(errors[0].error,/redirect/i);
 assert.equal(count(db,'film_person_credit')>0,true,'the other Films were written');
}

// 6. A read the traced pass did not see (a data-dependent branch) is a miss: the group is not applied from it and falls back.
{
 const {db,projector}=await prepared();
 // the second repository the group creates (the collecting pass) issues a read the tracing pass never saw
 let calls=0;
 const flaky={...projector,CanonicalRepository:{...projector.CanonicalRepository,createCanonicalRepository:target=>{
  const repository=projector.CanonicalRepository.createCanonicalRepository(target);
  calls++;
  return calls===2?{...repository,projectPerson:async input=>{await target.get('SELECT 1 AS ok FROM person WHERE id=?',[input.person.id+'#second-pass-only']);return repository.projectPerson(input);}}:repository;
 }}};
 const stateBefore=count(db,'projection_state'),creditsBefore=count(db,'film_person_credit');
 const stats=await bulkGroup(flaky,db,base.order,{lease:'lease-bench'});
 assert.equal(stats.outcome,'fallback');assert.equal(stats.reason,'prefetch_miss');
 assert.ok(stats.prefetchMisses>0);
 assert.deepEqual([count(db,'projection_state'),count(db,'film_person_credit')],[stateBefore,creditsBefore],'nothing of the group was written');
}

// 7. A read shape that cannot be digested sends the group to the per-entity path instead of being written unproven.
assert.equal(digestSql('SELECT COUNT(*) AS n FROM film'),null);
assert.equal(digestSql('SELECT a FROM t GROUP BY a'),null);
assert.match(digestSql('SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id=? ORDER BY role,ordinal'),/json_group_array\(json_array\(person_id,role,ordinal\)\)/);
assert.match(digestSql('SELECT 1 AS ok FROM watchlist_film WHERE film_id=?'),/json_array\(ok\)/);

console.log('projector-bulk-spike: the grouped write path proves every read inside its write batch (an appearing redirect, an owner correction of a read Person, a marker generation move and a lost lease each refuse the whole group and write nothing), falls back to the per-entity path on a refusal, an unseen read or an undigestable read, and leaves the per-entity path\'s rows when nothing interferes');
