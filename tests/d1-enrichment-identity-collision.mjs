// AIR-404, fixed by AIR-405: a Letterboxd Film whose trusted TMDB id is owned in D1 by the Film of the same id that the discovered catalog projected earlier (`film:tmdb:<id>`).
// Deterministic synthetic fixtures with the real projector, repository and migrations (a sqlite stand-in for D1, a memory bucket for R2).
//   S1 the catalog Film is projected first; the Letterboxd Film with the same trusted TMDB id arrives later and the catalog record is still listed, so the view links them.
//      Before AIR-405 the Film was refused with `identity_collision` on every run: projectFilm checked the trusted ids before projectLink released the Film it retires. Now the Film is
//      written with its link in one transaction, the catalog Film becomes a redirect, its aliases and credits move to the survivor, and a later run changes nothing.
//   S2 control: both arrive in the same first run: the link is written, the retired id is a redirect.
//   S3 the catalog Film is projected first, then the catalog no longer lists it (no link in the view): the Film is still refused (fail closed) and the owner row stays untouched: retiring a
//      Film the view does not link would drop its D1-only facts, a decision for the owner (AIR-405).
//   S4 control: the Letterboxd Film is projected first, the catalog Film arrives later: the link is written.
//   S5 an unrelated Film owns the trusted TMDB id (not the catalog twin, no redirect names it): refused, nothing written, the owner kept; the uniqueness of trusted ids is not relaxed.
//   S6 the Film the link retires has EPG history: the whole write is refused, with its own reason, and nothing is written.
//   S7 a stale or missing checkpoint of the survivor after the fix: the run writes it again without collision.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-identity-collision-'));
let databases=0;
const migrated=()=>{
 const db=d1Standin(path.join(root,'d1-'+(databases++)+'.sqlite'));
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const film=(id,title,tmdbId)=>({id,title,original:title,year:1995,tmdbId,url:'https://letterboxd.com/film/'+id+'/',directors:[person('director/m','Director')],actors:[person('actor/a','Actor')]});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis',synopsisFetchedAt:T,runtime:120});
function sources({listed=[],catalog=[]}){
 const bucket=new MemoryBucket();const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films:listed});put('metadata.json',Object.fromEntries(listed.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:listed.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',Object.fromEntries(catalog.map(id=>['tmdb_'+id,{id:'tmdb_'+id,tmdbId:id,title:'Catalog '+id,original:'Catalog '+id,year:1995,discoveredAt:T,synopsis:'Overview',directors:[],actors:[]}])));
 return bucket;
}
const projector=projectorContext({log:()=>{}});
const run=(db,bucket)=>projector.runD1EnrichmentProjection({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e12});
const films=db=>db.sql('SELECT id FROM film ORDER BY id').map(row=>row.id);
const redirects=db=>db.sql('SELECT from_id,to_film_id FROM film_redirect').map(row=>row.from_id+'>'+row.to_film_id);
const refused=summary=>Array.from(summary.errors,item=>item.kind+':'+item.id+':'+item.error);
const HEAT=film('heat','Heat','949');

const rows=(db,sql)=>Array.from(db.sql(sql));
const ids=db=>rows(db,"SELECT film_id,scheme,value,trusted FROM film_external_id ORDER BY film_id,scheme,value").map(row=>row.film_id+':'+row.scheme+':'+row.value+':'+row.trusted);
const listed=db=>rows(db,'SELECT film_id FROM watchlist_film ORDER BY film_id').map(row=>row.film_id);
const dangling=db=>Number(Object.values(db.sql("SELECT (SELECT COUNT(*) FROM film_person_credit c LEFT JOIN film f ON f.id=c.film_id WHERE f.id IS NULL)+(SELECT COUNT(*) FROM film_person_credit c LEFT JOIN person p ON p.id=c.person_id WHERE p.id IS NULL) AS n")[0])[0]);
const dump=db=>JSON.stringify({films:films(db),ext:ids(db),redirects:redirects(db),listed:listed(db),credits:rows(db,'SELECT film_id,person_id,role,ordinal FROM film_person_credit ORDER BY 1,2,3'),aliases:rows(db,'SELECT film_id,kind,value FROM film_alias ORDER BY 1,2,3'),state:rows(db,"SELECT kind,id FROM projection_state WHERE kind='film' ORDER BY 1,2")});
// S1: linked in one write, the facts of the retired Film kept, and nothing changes on later runs.
{
 const db=migrated();
 const catalogActor=person('tmdb_actor/7','Catalog Actor');
 const withCredits=sources({catalog:['949']});
 const catalogOnly=()=>{const bucket=sources({catalog:['949']});bucket.put('epg/generations/run-1/discovered-films.json',JSON.stringify({tmdb_949:{id:'tmdb_949',tmdbId:'949',title:'Catalog 949',original:'Catalog 949',year:1995,discoveredAt:T,synopsis:'Overview',directors:[],actors:[catalogActor]}}));return bucket;};
 const both=()=>{const bucket=sources({listed:[HEAT],catalog:['949']});bucket.put('epg/generations/run-1/discovered-films.json',JSON.stringify({tmdb_949:{id:'tmdb_949',tmdbId:'949',title:'Catalog 949',original:'Catalog 949',year:1995,discoveredAt:T,synopsis:'Overview',directors:[],actors:[catalogActor]}}));return bucket;};
 const first=await run(db,catalogOnly());
 assert.equal(first.outcome,'complete');assert.deepEqual(films(db),['film:tmdb:949']);
 const twinCredits=rows(db,"SELECT person_id FROM film_person_credit WHERE film_id='film:tmdb:949'").map(row=>row.person_id);
 assert.equal(twinCredits.length,1,'the catalog Film has a credit before the link');
 db.sql("INSERT INTO film_alias (film_id,kind,value) VALUES ('film:tmdb:949','title','Catalog twin alias') ON CONFLICT DO NOTHING");
 const next=await run(db,both());
 assert.equal(next.outcome,'complete',JSON.stringify(next.errors));assert.equal(next.errorCount,0);assert.equal(next.writtenFilms,1);
 assert.deepEqual(films(db),['film:heat'],'only the survivor stays');assert.deepEqual(redirects(db),['film:tmdb:949>film:heat']);
 assert.deepEqual(ids(db).filter(entry=>entry.includes(':tmdb:')),['film:heat:tmdb:949:1'],'the survivor holds the trusted TMDB id, nobody else');
 assert.deepEqual(listed(db),['film:heat'],'membership');
 const credits=rows(db,"SELECT person_id FROM film_person_credit WHERE film_id='film:heat'").map(row=>row.person_id);
 assert.ok(twinCredits.every(id=>credits.includes(id)),'the credit of the retired Film moved to the survivor');assert.equal(new Set(credits).size,credits.length,'no duplicate credit');
 assert.equal(dangling(db),0,'no credit without a Film or a Person');
 assert.ok(rows(db,"SELECT value FROM film_alias WHERE film_id='film:heat'").some(row=>row.value==='Catalog twin alias'),'the alias of the retired Film moved to the survivor');
 // Later runs change nothing and report no error.
 const settled=dump(db);
 for(const tick of [1,2]){const again=await run(db,both());assert.equal(again.errorCount,0,'tick '+tick);assert.equal(again.outcome,'complete');assert.equal(dump(db),settled,'tick '+tick+' changes nothing');}
 // S7: the survivor's checkpoint is gone: it is written again, without a collision.
 db.sql("DELETE FROM projection_state WHERE kind='film' AND id='film:heat'");
 const stale=await run(db,both());assert.equal(stale.errorCount,0);assert.equal(stale.outcome,'complete');
 assert.equal(dump(db),settled,'a missing checkpoint is rewritten and the state is the same');
}
// S2: both in the same first run: written, the catalog id is a redirect.
{
 const db=migrated();
 const summary=await run(db,sources({listed:[HEAT],catalog:['949']}));
 assert.equal(summary.outcome,'complete');assert.equal(summary.errorCount,0);
 assert.deepEqual(films(db),['film:heat']);assert.deepEqual(redirects(db),['film:tmdb:949>film:heat']);
}
// S3: the catalog no longer lists the Film: the same refusal and the stale owner row stays.
{
 const db=migrated();
 await run(db,sources({catalog:['949']}));
 const next=await run(db,sources({listed:[HEAT],catalog:[]}));
 assert.equal(next.outcome,'partial');assert.deepEqual(refused(next),['film:film:heat:identity_collision']);
 assert.deepEqual(films(db),['film:tmdb:949']);assert.deepEqual(redirects(db),[]);
}
// S4: the Letterboxd Film first, the catalog Film later: the link is written.
{
 const db=migrated();
 await run(db,sources({listed:[HEAT],catalog:[]}));
 const next=await run(db,sources({listed:[HEAT],catalog:['949']}));
 assert.equal(next.outcome,'complete');assert.equal(next.errorCount,0);
 assert.deepEqual(films(db),['film:heat']);assert.deepEqual(redirects(db),['film:tmdb:949>film:heat']);
}
// S5: an unrelated Film owns the trusted TMDB id: refused, nothing written, the owner kept.
{
 const db=migrated();
 await run(db,sources({catalog:['949']}));
 db.sql("DELETE FROM film_redirect");
 db.sql("DELETE FROM film_external_id WHERE film_id='film:tmdb:949'");db.sql("DELETE FROM film_person_credit WHERE film_id='film:tmdb:949'");db.sql("DELETE FROM film_dimension WHERE film_id='film:tmdb:949'");db.sql("DELETE FROM film_alias WHERE film_id='film:tmdb:949'");db.sql("DELETE FROM film WHERE id='film:tmdb:949'");
 db.sql("INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',1,'tmdb:949','Other','"+T+"')");
 db.sql("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:other','tmdb','949',1,0)");
 const next=await run(db,sources({listed:[HEAT],catalog:[]}));
 assert.equal(next.outcome,'partial');assert.deepEqual(refused(next),['film:film:heat:identity_collision']);
 assert.deepEqual(films(db),['film:other']);assert.deepEqual(ids(db),['film:other:tmdb:949:1']);
 assert.equal(dump(db).includes('film:heat'),false,'nothing of the refused Film is written');
}
// S6: the Film the link retires has EPG history: the whole write is refused with its own reason and nothing is written.
{
 const db=migrated();
 await run(db,sources({catalog:['949']}));
 db.sql("INSERT INTO film_epg_last_airing (film_id,airing_ms,programme_run_id) VALUES ('film:tmdb:949',1,'run-0')");
 const before=dump(db);
 const next=await run(db,sources({listed:[HEAT],catalog:['949']}));
 assert.equal(next.outcome,'partial');assert.equal(next.errorCount,1);
 assert.match(next.errors[0].error,/EPG history/,'its own reason, not identity_collision');
 assert.equal(dump(db),before,'no Film fact is written (the Persons of the Film are written before it, by design)');
 assert.deepEqual(films(db),['film:tmdb:949']);assert.deepEqual(redirects(db),[]);
}
console.log('D1 enrichment identity collision (AIR-404, fixed by AIR-405): a Letterboxd Film whose trusted TMDB id an earlier catalog Film owns is written with its link in one transaction (redirect, aliases, credits, membership, no change on later runs, a missing checkpoint rewritten); without a link in the view, with an unrelated owner, or with EPG history on the retired Film it is still refused and nothing is written');
