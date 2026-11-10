// AIR-404: characterization of the `identity_collision` the D1 enrichment projector reports for a Letterboxd Film whose trusted TMDB id is already owned in D1 by the
// Film of the same id that the discovered catalog projected earlier (`film:tmdb:<id>`). It pins what the code does today, on deterministic synthetic fixtures and the real
// projector, repository and migrations (a sqlite stand-in for D1, a memory bucket for R2); it does not say that this behaviour is right. When the projector is fixed
// the S1 and S3 assertions are to be turned around in the same change.
//   S1 the catalog Film is projected first; the Letterboxd Film with the same trusted TMDB id (and the catalog record still listed, so the view links them) arrives later:
//      the Film is refused with `identity_collision`, on every later run, and never written. projectFilm checks the trusted external ids BEFORE projectLink releases the
//      retiring owner, and planFilm only accepts an owner named in `input.releasing`, which the projector does not pass.
//   S2 control: both arrive in the same first run: the link is written, the retired id is a redirect.
//   S3 the catalog Film is projected first, then the catalog no longer lists it (no redirect in the view): the same refusal, and the stale owner row stays.
//   S4 control: the Letterboxd Film is projected first, the catalog Film arrives later: the link is written.
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

// S1: refused, on every run, never written; the catalog Film's row stays the owner of the TMDB id.
{
 const db=migrated();
 const first=await run(db,sources({catalog:['949']}));
 assert.equal(first.outcome,'complete');assert.deepEqual(films(db),['film:tmdb:949']);
 for(const tick of [1,2,3]){
  const next=await run(db,sources({listed:[HEAT],catalog:['949']}));
  assert.equal(next.outcome,'partial','tick '+tick);
  assert.equal(next.errorCount,1);assert.deepEqual(refused(next),['film:film:heat:identity_collision']);
  assert.equal(next.writtenFilms,0);assert.equal(next.remaining,0,'a refused Film is not counted in remaining');
  assert.deepEqual(films(db),['film:tmdb:949'],'the Letterboxd Film is never written');assert.deepEqual(redirects(db),[]);
 }
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
console.log('D1 enrichment identity collision (AIR-404, characterization): a Letterboxd Film whose trusted TMDB id is owned in D1 by an earlier catalog Film is refused with identity_collision on every run and never written, with or without the catalog record in the view; the same pair in one run, or the Letterboxd Film first, is linked with a redirect');
