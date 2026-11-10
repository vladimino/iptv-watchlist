// AIR-405, owner decision of 10 Nov 2026: when the Film a link would retire (the catalog twin of a Letterboxd Film) holds D1-authoritative prediction-domain facts, the projector skips the duplicate on
// purpose: it keeps the catalog Film and every row that references it, makes no redirect, does not write the Letterboxd Film and no checkpoint for it, and reports `duplicate_film_retained` (not an error, not
// `partial`). Other foreign key and identity errors stay refusals. The real projector, repository and the FULL chain of migrations (schema v18, prediction tables included) over a sqlite stand-in of D1, a memory R2.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-duplicate-retained-'));
const chainFiles=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.ok(chainFiles.length>=18,'the full chain');
let databases=0;
const migrated=()=>{
 const file=path.join(root,'d1-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chainFiles.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return d1Standin(file);
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
const rows=(db,sql)=>Array.from(db.sql(sql));
const films=db=>rows(db,'SELECT id FROM film ORDER BY id').map(row=>row.id);
const HEAT=film('heat','Heat','949');
const TWIN='film:tmdb:949';
const FACTS={
 prediction_current:()=>"INSERT INTO prediction_current (film_id,updated_at) VALUES ('"+TWIN+"','"+T+"')",
 prediction_history:()=>"INSERT INTO prediction_history (film_id,replaced_at,payload_json,r2_key,content_sha256) VALUES ('"+TWIN+"','"+T+"','{}','k','"+'0'.repeat(64)+"')",
 fingerprint_payload:()=>"INSERT INTO fingerprint_payload (film_id,schema_version,fingerprint_hash,r2_key,content_sha256) VALUES ('"+TWIN+"',1,'h','k','"+'0'.repeat(64)+"')",
 candidate_decision:()=>"INSERT INTO candidate (observation_key,title,normalized_title,raw_titles_json,durations_json,observation_schema_version,observation_json,seen_in_latest) VALUES ('obs:1','T','t','[]','[]',1,'{}',1);INSERT INTO candidate_decision (observation_key,status,film_id,checked_at) VALUES ('obs:1','verified','"+TWIN+"','"+T+"')",
 candidate_decision_history:()=>"INSERT INTO candidate (observation_key,title,normalized_title,raw_titles_json,durations_json,observation_schema_version,observation_json,seen_in_latest) VALUES ('obs:2','T','t','[]','[]',1,'{}',1);INSERT INTO candidate_decision_history (observation_key,checked_at,replaced_at,status,film_id) VALUES ('obs:2','"+T+"','"+T+"','verified','"+TWIN+"')",
};
// Everything the catalog Film owns, as one string: the Film, its external ids, aliases, credits, dimensions, metadata and every prediction-domain row.
const owned=db=>JSON.stringify(['film','film_external_id','film_alias','film_person_credit','film_dimension','film_metadata','prediction_current','prediction_history','fingerprint_payload','candidate_decision','candidate_decision_history','film_redirect','watchlist_film'].map(table=>[table,rows(db,'SELECT * FROM '+table+' ORDER BY 1')]));
const checkpoints=db=>rows(db,"SELECT id FROM projection_state WHERE projection='enrichment' AND kind='film' ORDER BY id").map(row=>row.id);
const setup=async()=>{const db=migrated();await run(db,sources({catalog:['949']}));assert.deepEqual(films(db),[TWIN]);return db;};

// 1. Each kind of prediction-domain fact makes the duplicate a retained one: the same outcome, nothing written, nothing of the Letterboxd Film, nothing changed.
for(const [table,insert] of Object.entries(FACTS)){
 const db=await setup();
 db.sql(insert());
 const before=owned(db),statesBefore=checkpoints(db);
 const next=await run(db,sources({listed:[HEAT],catalog:['949']}));
 assert.equal(next.errorCount,0,table+': not an error '+JSON.stringify(next.errors));assert.notEqual(next.outcome,'partial',table);
 assert.equal(next.writtenFilms,0,table+': no Film written');
 assert.equal(next.retainedCount,1,table);assert.deepEqual(Array.from(next.retainedFilms,item=>item.id+':'+item.reason),['film:heat:duplicate_film_retained'],table);
 assert.ok(Array.from(next.retainedFilms[0].held).includes(table),table+': the table that holds the fact is named');
 assert.equal(owned(db),before,table+': the catalog Film and every row of it are unchanged, no redirect, no membership');
 assert.deepEqual(films(db),[TWIN],table+': the Letterboxd Film is not written');
 assert.deepEqual(checkpoints(db),statesBefore,table+': no checkpoint for the skipped Film (no false success)');
}
// 2. Every tick sees it again (no checkpoint), reports the same, changes nothing; a change of the input is read again; the conflict going away lets the link through.
{
 const db=await setup();db.sql(FACTS.prediction_current());
 const before=owned(db);
 for(const tick of [1,2,3]){const next=await run(db,sources({listed:[HEAT],catalog:['949']}));assert.equal(next.retainedCount,1,'tick '+tick);assert.equal(next.errorCount,0);assert.equal(owned(db),before,'tick '+tick);}
 const changed=await run(db,sources({listed:[{...HEAT,title:'Heat (restored)'}],catalog:['949']}));
 assert.equal(changed.retainedCount,1,'a changed input is planned again');assert.equal(owned(db),before);
 // the facts are gone (an owner's repair, simulated here by deleting the rows): the next run links as usual.
 db.sql("DELETE FROM prediction_current WHERE film_id='"+TWIN+"'");
 const linked=await run(db,sources({listed:[HEAT],catalog:['949']}));
 assert.equal(linked.errorCount,0,JSON.stringify(linked.errors));assert.equal(linked.retainedCount,undefined);assert.equal(linked.outcome,'complete');
 assert.deepEqual(films(db),['film:heat']);assert.deepEqual(rows(db,'SELECT from_id,to_film_id FROM film_redirect').map(row=>row.from_id+'>'+row.to_film_id),[TWIN+'>film:heat']);
}
// 3. Without prediction facts the link goes through atomically (the full chain, as in production).
{
 const db=await setup();
 const next=await run(db,sources({listed:[HEAT],catalog:['949']}));
 assert.equal(next.errorCount,0,JSON.stringify(next.errors));assert.equal(next.retainedCount,undefined);
 assert.deepEqual(films(db),['film:heat']);assert.deepEqual(rows(db,'SELECT from_id,to_film_id FROM film_redirect').map(row=>row.from_id+'>'+row.to_film_id),[TWIN+'>film:heat']);
 assert.deepEqual(checkpoints(db).filter(id=>id==='film:heat'),['film:heat']);
}
// 4. Not suppressed: a foreign key of another table is still a refusal with its own error; an unrelated owner is still an identity_collision; EPG history keeps its own reason.
{
 const db=await setup();
 db.sql("INSERT INTO film_sync_state (film_id,metadata_at) VALUES ('"+TWIN+"','"+T+"')");
 const before=owned(db);
 const next=await run(db,sources({listed:[HEAT],catalog:['949']}));
 assert.equal(next.errorCount,1);assert.equal(next.retainedCount,undefined,'not classified as retained');
 assert.match(next.errors[0].error,/FOREIGN KEY/i,'the real foreign key error is kept');assert.equal(owned(db),before);
}
{
 const db=await setup();
 db.sql("DELETE FROM film_redirect");db.sql("DELETE FROM film_external_id WHERE film_id='"+TWIN+"'");
 db.sql("INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',1,'tmdb:949','Other','"+T+"')");
 db.sql("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:other','tmdb','949',1,0)");
 db.sql(FACTS.prediction_current());
 const next=await run(db,sources({listed:[HEAT],catalog:[]}));
 assert.equal(next.errorCount,1);assert.equal(next.retainedCount,undefined);assert.match(next.errors[0].error,/identity_collision/);
 assert.ok(!films(db).includes('film:heat'));
}
{
 const db=await setup();
 db.sql("INSERT INTO film_epg_last_airing (film_id,airing_ms,programme_run_id) VALUES ('"+TWIN+"',1,'run-0')");
 const next=await run(db,sources({listed:[HEAT],catalog:['949']}));
 assert.equal(next.errorCount,1);assert.equal(next.retainedCount,undefined);assert.match(next.errors[0].error,/EPG history/);
}
console.log('D1 enrichment retained duplicate (AIR-405, owner decision 10 Nov 2026): on the full migration chain, a Letterboxd Film whose catalog twin holds prediction-domain facts (each of the five tables) is skipped with duplicate_film_retained: no error, no partial run, no Film written, no redirect, no checkpoint, every row of the catalog Film unchanged, planned again on every run and when its input changes, linked once the facts are gone; a link without facts, a foreign key of another table, an unrelated owner and EPG history behave as before');
