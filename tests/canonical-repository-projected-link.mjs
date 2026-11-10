// AIR-405: the projector's per-entity Film write is projectFilm (with the redirects of the Film) followed by projectLink for each redirect, in one transaction. The trusted
// external ids are unique over all Films, so the Films a write retires must be released before the survivor's ids are inserted, and only those owners are accepted. Covered at
// the repository (the real code over a sqlite stand-in of D1): one redirect, several redirects that each hold a different trusted id, the facts of the retired Films moving to the
// survivor, an owner the write does not retire (refused, nothing written), a retired Film with EPG history (refused with its own reason, nothing written), a redirect that does not
// target the survivor, a repeated write (no change), and a write whose later statement fails (the transaction leaves nothing).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const domain=vm.createContext({Date,Map,Set,JSON});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\nglobalThis.contract={filmView,personView,linkFilms};',domain);
const {filmView,personView,linkFilms}=domain.contract;
const projector=projectorContext({log:()=>{}});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-projected-link-'));
let databases=0;
const NOW='2026-10-13T09:30:00.000Z',FRESH='2026-10-01T09:30:00.000Z';
const migrated=()=>{
 const db=d1Standin(path.join(root,'d1-'+(databases++)+'.sqlite'),{onBatch:process.env.DEBUG_BATCH?async list=>{for(const item of list)if(/film_person_credit|film_redirect/.test(item.text))console.log(item.text.slice(0,230));}:null});
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const facts=(extra={})=>({now:NOW,metadata:{present:true,metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsisPresent:true},fingerprint:{present:false},prediction:{present:false},title:{original:'The Legend of Zorro'},...extra});
const dictionary={title:'Legend',status:'verified',tmdbId:'1656',sources:['dictionary']};
const catalog=filmView(facts({localId:'film:tmdb:1656',tmdbId:'1656',decision:{status:'verified'},title:{original:'The Legend of Zorro',dictionary}}));
const letterboxd=filmView(facts({letterboxdId:'28nq',title:{original:'The Legend of Zorro',provisional:{title:'Zorro'}}}));
const person=personView({roleId:'director/legend',original:'Martin Campbell',now:NOW,dictionary:{name:'Martin Campbell',status:'verified',source:'dictionary'}});
const linked=linkFilms(letterboxd,catalog,NOW,{verified:true});
assert.equal(linked.ok,true);
const survivor=linked.survivor,redirectA=linked.redirect;
assert.equal(redirectA.to,survivor.id);
const metadata={schemaVersion:1,year:2005,runtime:129,synopsis:'A sequel.',genres:['adventure'],peopleVersion:1,payload:{letterboxdId:'28nq'},updatedAt:NOW};
const director={personId:person.id,role:'director',ordinal:0};
// One adapter per database, shared by the repository and the transaction, so that the statements of a write are buffered into one batch as the projector's are.
const adapters=new WeakMap();
const adapterOf=db=>{if(!adapters.has(db))adapters.set(db,projector.d1EnrichmentAdapter(db));return adapters.get(db);};
const setup=async db=>{
 const repository=projector.CanonicalRepository.createCanonicalRepository(adapterOf(db));
 await repository.projectPerson({person});
 await repository.projectFilm({film:catalog,watchlist:true,credits:[director],metadata});
 return repository;
};
const transact=(db,fn)=>adapterOf(db).transaction(fn);
// The projector's per-entity write, as src/d1-enrichment.js runs it.
const write=(db,repository,{film=survivor,redirects,credits=[director],watchlist=null}={})=>adapterOf(db).transaction(async()=>{
 await repository.projectFilm({film,watchlist,credits,metadata,redirects});
 for(const redirect of redirects)await repository.projectLink({survivor:film,redirect,releasing:redirects.map(item=>item.from)});
});
const rows=(db,sql)=>Array.from(db.sql(sql));
const state=db=>JSON.stringify({films:rows(db,'SELECT id FROM film ORDER BY id'),ext:rows(db,'SELECT film_id,scheme,value,trusted FROM film_external_id ORDER BY 1,2,3'),redirects:rows(db,'SELECT from_id,to_film_id FROM film_redirect ORDER BY 1'),listed:rows(db,'SELECT film_id FROM watchlist_film ORDER BY 1'),credits:rows(db,'SELECT film_id,person_id,role,ordinal FROM film_person_credit ORDER BY 1,2,3'),aliases:rows(db,'SELECT film_id,kind,value FROM film_alias ORDER BY 1,2,3')});
const add=(db,id,scheme,value)=>{
 db.sql("INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+id+"',1,NULL,'Old','"+NOW+"')");
 db.sql("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+id+"','"+scheme+"','"+value+"',1,0)");
};

// 1. One redirect: the survivor takes the trusted id, the retired Film becomes a redirect, its facts move, membership follows.
{
 const db=migrated(),repository=await setup(db);
 await assert.rejects(()=>transact(db,()=>repository.projectFilm({film:survivor,watchlist:null,credits:[director],metadata})),/identity_collision/,'without the redirect named, the owner still refuses the Film');
 await write(db,repository,{redirects:[redirectA]});
 assert.deepEqual(rows(db,'SELECT id FROM film').map(row=>row.id),[survivor.id]);
 assert.deepEqual(rows(db,'SELECT from_id,to_film_id FROM film_redirect').map(row=>row.from_id+'>'+row.to_film_id),['film:tmdb:1656>'+survivor.id]);
 assert.deepEqual(rows(db,"SELECT film_id FROM film_external_id WHERE scheme='tmdb' AND value='1656' AND trusted=1").map(row=>row.film_id),[survivor.id]);
 assert.deepEqual(rows(db,'SELECT film_id FROM watchlist_film').map(row=>row.film_id),[survivor.id],'the membership of the retired Film moved');
 assert.equal(rows(db,"SELECT COUNT(*) AS n FROM film_person_credit WHERE film_id='"+survivor.id+"'")[0].n,1,'one credit, no duplicate');
 const done=state(db);
 await write(db,repository,{redirects:[redirectA]});
 assert.equal(state(db),done,'a repeated write changes nothing');
}
// 2. Two redirects, each retired Film holding a different trusted id of the survivor: both are released, both become redirects.
{
 const db=migrated(),repository=await setup(db);
 add(db,'film:legacy-lb','letterboxd','28nq');
 const redirectB={from:'film:legacy-lb',to:survivor.id,at:NOW};
 await assert.rejects(()=>write(db,repository,{redirects:[redirectA]}),/identity_collision/,'the second owner is not named: refused');
 assert.deepEqual(rows(db,'SELECT id FROM film ORDER BY id').map(row=>row.id),['film:legacy-lb','film:tmdb:1656'],'nothing was written');
 await write(db,repository,{redirects:[redirectA,redirectB]});
 assert.deepEqual(rows(db,'SELECT id FROM film').map(row=>row.id),[survivor.id]);
 assert.deepEqual(rows(db,'SELECT from_id FROM film_redirect ORDER BY from_id').map(row=>row.from_id),['film:legacy-lb','film:tmdb:1656']);
 assert.equal(rows(db,"SELECT COUNT(*) AS n FROM film_external_id WHERE trusted=1 AND conflicting=0 AND film_id<>'"+survivor.id+"'")[0].n,0,'every trusted id belongs to the survivor');
 const done=state(db);await write(db,repository,{redirects:[redirectA,redirectB]});assert.equal(state(db),done);
}
// 2b. The credits, aliases and membership only the retired Films hold survive the whole transaction and a repeated write (the review of AIR-405): two distinct retiring Films, each with a
// TMDB credit and an alias the incoming roster does not list; the later link does not erase what the earlier one adopted, and the ordinals of the adopted credits never meet (before AIR-405
// a retired Film with several credits of a role, some taken and some not, made the unique index refuse the whole write). The survivor is a watchlist Film, as the projector's listed Films are.
{
 const db=migrated(),repository=await setup(db);
 add(db,'film:legacy-lb','letterboxd','28nq');
 for(const id of ['person:tmdb_actor/8','person:tmdb_actor/9','person:tmdb_actor/10'])db.sql("INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('"+id+"','"+id.slice(7)+"',1,'"+NOW+"')");
 db.sql("INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:1656','person:tmdb_actor/8','actor',0),('film:legacy-lb','person:tmdb_actor/9','actor',0),('film:legacy-lb','person:tmdb_actor/10','actor',1)");
 db.sql("INSERT INTO film_alias (film_id,kind,value) VALUES ('film:tmdb:1656','title','Alias of the catalog Film'),('film:legacy-lb','title','Alias of the legacy Film')");
 db.sql("INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:legacy-lb','"+NOW+"')");
 const redirectB={from:'film:legacy-lb',to:survivor.id,at:NOW};
 await write(db,repository,{redirects:[redirectA,redirectB],watchlist:true});
 const credits=()=>rows(db,"SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id='"+survivor.id+"' ORDER BY role,ordinal");
 const held=credits();
 const ofRole=role=>held.filter(item=>item.role===role).map(item=>item.person_id);
 assert.deepEqual(ofRole('director'),[person.id],'the roster credit, once');
 assert.deepEqual(ofRole('actor').sort(),['person:tmdb_actor/10','person:tmdb_actor/8','person:tmdb_actor/9'],'every credit only a retired Film held is on the survivor');
 assert.equal(new Set(held.map(item=>item.person_id+'/'+item.role)).size,held.length,'no duplicate credit');
 assert.equal(new Set(held.map(item=>item.role+'/'+item.ordinal)).size,held.length,'no two credits share an ordinal of a role');
 assert.equal(rows(db,"SELECT COUNT(*) AS n FROM film_person_credit c LEFT JOIN film f ON f.id=c.film_id LEFT JOIN person p ON p.id=c.person_id WHERE f.id IS NULL OR p.id IS NULL")[0].n,0,'no dangling credit');
 const aliases=rows(db,"SELECT value FROM film_alias WHERE film_id='"+survivor.id+"'").map(item=>item.value);
 assert.ok(aliases.includes('Alias of the catalog Film')&&aliases.includes('Alias of the legacy Film'),'both aliases moved');
 assert.deepEqual(rows(db,'SELECT film_id FROM watchlist_film').map(item=>item.film_id),[survivor.id],'membership of either retired Film moved');
 const done=state(db);
 await write(db,repository,{redirects:[redirectA,redirectB],watchlist:true});
 assert.equal(state(db),done,'a repeated write keeps all of it');
 await write(db,repository,{redirects:[redirectA,redirectB],watchlist:true});
 assert.equal(state(db),done,'and again');
}
// 3. An unrelated owner (not named by any redirect): refused, nothing written, the uniqueness holds.
{
 const db=migrated(),repository=await setup(db);
 add(db,'film:unrelated','letterboxd','28nq');
 const before=state(db);
 await assert.rejects(()=>write(db,repository,{redirects:[redirectA]}),/identity_collision/);
 assert.equal(state(db),before);
}
// 4. The retired Film has EPG history: its own reason, nothing written.
{
 const db=migrated(),repository=await setup(db);
 db.sql("INSERT INTO film_epg_last_airing (film_id,airing_ms,programme_run_id) VALUES ('film:tmdb:1656',1,'run-0')");
 const before=state(db);
 await assert.rejects(()=>write(db,repository,{redirects:[redirectA]}),/EPG history/);
 assert.equal(state(db),before);
}
// 5. A redirect that does not target the survivor: refused before anything is written.
{
 const db=migrated(),repository=await setup(db);const before=state(db);
 await assert.rejects(()=>write(db,repository,{redirects:[{...redirectA,to:'film:other'}]}),/Redirect target must be the survivor/);
 assert.equal(state(db),before);
}
// 6. A later statement fails: the transaction leaves nothing (the release and the Film write are not kept).
{
 const db=migrated(),repository=await setup(db);const before=state(db);
 await assert.rejects(()=>adapterOf(db).transaction(async()=>{
  await repository.projectFilm({film:survivor,watchlist:null,credits:[director],metadata,redirects:[redirectA]});
  await repository.projectLink({survivor,redirect:redirectA,releasing:[redirectA.from]});
  await adapterOf(db).run('INSERT INTO film_redirect (from_id,to_film_id,at) VALUES (?,?,?)',['film:tmdb:1656','film:x',NOW]);
 }));
 assert.equal(state(db),before,'nothing of the write, not the release of the retired Film either');
}
console.log('Canonical repository projected link (AIR-405): a Film is written with the links that retire the Films holding its trusted ids, released before the survivor\'s ids are inserted; one or several redirects move facts and membership; an unrelated owner, EPG history on the retired Film or a redirect to another Film refuses everything; a repeated write changes nothing; a failing statement leaves nothing');
