// AIR-499 metadata_sync: the four atomic kinds of metadataSync, on the sqlite3-CLI D1 stand-in. No Worker, R2 or Cloudflare access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.METADATA_SYNC_SRC?path.resolve(process.env.METADATA_SYNC_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const M=await load('canonical-metadata-sync-producer.js');
const {PRODUCER_OPERATIONS,PRODUCER_WIRING,handoffReadiness}=await load('canonical-producers.js');
const {activationAudit}=await load('film-person-open-handoff.js');
const {
 applyMetadataSync,applyFilmMetadata,METADATA_SYNC_KINDS,canonicalMetadataFilmId,titleSourceOf,personSourcesOf,
 metadataFactsInput,syncFactsInput,FILM_METADATA_OPERATION,FILM_SYNC_OPERATION,LOCALIZATION_SOURCE_OPERATION,LOCALIZATION_CONFLICT_OPERATION,
}=M;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-metadata-sync-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
let n=0;
function database(stage='open'){
 const file=path.join(root,'e-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['r2','prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='open')assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const envOf=file=>({DB:d1Standin(file)});
const code=expected=>error=>error.code===expected;
const T='2026-11-16T12:00:00.000Z';
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const FID='film:tmdb:1656';
const PID='person:director/michael-mann';
const seed=(file)=>{
 assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ("+q(FID)+",1,'tmdb:1656','Heat','"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(FID)+",'tmdb','1656',1,0,NULL);INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ("+q(PID)+",'director/michael-mann',1,'"+T+"');").status,0);
};
const film=over=>({id:'28nq',tmdbId:'1656',title:'Heat',original:'Heat',url:'https://letterboxd.com/film/heat-1995/',year:1995,runtime:170,synopsis:'A group of professional bank robbers.',poster:'p',metadataAt:T,synopsisFetchedAt:T,peopleVersion:1,peopleNamesVersion:2,peopleLocalizedAt:T,directors:[{id:'director/michael-mann',name:'Майкл Манн',original:'Michael Mann'}],actors:[],...over});
const titles={'28nq':{tmdbId:'1656',title:'Схватка',status:'provisional',sources:['https://www.wikidata.org/wiki/Q202001']}};
const people={'director/michael-mann':{name:'Майкл Манн',original:'Michael Mann'}};
const KEYS=['film_credits','film_facts','film_metadata','film_mutation','film_sync_state','localization_conflict','localization_source','person_mutation','person_state'];

assert.equal(canonicalMetadataFilmId(film()),FID);
assert.equal(titleSourceOf(film(),titles).source.value,'Схватка');
assert.equal(personSourcesOf(film(),people)[0].id,PID);
{
 const snap={film:{id:FID,contract_version:1}};
 assert.ok(metadataFactsInput(snap,film(),T).metadata.synopsis);
 assert.ok(syncFactsInput(snap,film(),T).sync.metadataAt);
 assert.equal(metadataFactsInput(snap,{id:'28nq'},T),null);
}

{
 const file=database('prepared');seed(file);
 const before=one(file,'SELECT COUNT(*) FROM film_metadata');
 const out=await applyMetadataSync(envOf(file),{event:'metadata:run-1',films:[film()],titles,people,now:()=>T});
 assert.equal(out.state,'skipped');assert.equal(out.reason,'projector_is_writer');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_metadata'),before);
 assert.equal(rows(file,'SELECT * FROM canonical_write_receipt').length,0);
}

{
 const file=database('open');seed(file);
 const env=envOf(file);
 const out=await applyMetadataSync(env,{event:'metadata:run-1',films:[film()],titles,people,now:()=>T});
 assert.equal(out.state,'done');
 assert.ok(out.applied>=2,JSON.stringify(out));
 const kinds=rows(file,'SELECT operation FROM canonical_write_receipt ORDER BY created_at').map(row=>row.operation);
 assert.deepEqual(kinds.filter(k=>METADATA_SYNC_KINDS.includes(k)).slice(0,2),[FILM_METADATA_OPERATION,FILM_SYNC_OPERATION]);
 assert.ok(kinds.includes(LOCALIZATION_SOURCE_OPERATION));
 assert.equal(one(file,'SELECT synopsis FROM film_metadata WHERE film_id='+q(FID)),'A group of professional bank robbers.');
 assert.equal(one(file,'SELECT metadata_at FROM film_sync_state WHERE film_id='+q(FID)),T);
 assert.equal(one(file,'SELECT value FROM film_localization_source WHERE film_id='+q(FID)),'Схватка');
 assert.equal(one(file,'SELECT value FROM person_localization_source WHERE person_id='+q(PID)),'Майкл Манн');
 const replay=await applyMetadataSync(env,{event:'metadata:run-1',films:[film()],titles,people,now:()=>T});
 assert.equal(one(file,'SELECT COUNT(*) FROM film_localization_source WHERE film_id='+q(FID)),1);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_metadata WHERE film_id='+q(FID)),1);
 assert.ok(replay.noop+replay.applied>=1);
}

{
 const file=database('open');seed(file);
 const env=envOf(file);
 await applyFilmMetadata(env,{origin:'metadata_sync',event:'metadata:partial:meta',input:metadataFactsInput({film:{id:FID,contract_version:1}},film(),T),now:()=>T});
 assert.equal(one(file,'SELECT synopsis FROM film_metadata WHERE film_id='+q(FID)),'A group of professional bank robbers.');
 const again=await applyMetadataSync(env,{event:'metadata:partial',films:[film()],titles,people,now:()=>T});
 assert.equal(again.state,'done');
 assert.equal(one(file,'SELECT metadata_at FROM film_sync_state WHERE film_id='+q(FID)),T);
}

{
 const file=database('open');seed(file);
 const env=envOf(file);
 await applyMetadataSync(env,{event:'metadata:failparse',films:[film()],titles,people,failedIds:['28nq'],now:()=>T});
 assert.equal(one(file,'SELECT COUNT(*) FROM film_metadata'),0);
}

{
 const file=database('open');seed(file);
 sqlite(file,"INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ("+q(FID)+",'localization','reviewed','owner','owner','{\"authority\":\"owner\"}','Жара','owner',0,'none','"+T+"')");
 const env=envOf(file);
 const out=await applyMetadataSync(env,{event:'metadata:held',films:[film()],titles,people,now:()=>T});
 assert.equal(out.state,'done');
 assert.ok(rows(file,'SELECT reason FROM localization_conflict WHERE entity_id='+q(FID)).some(row=>String(row.reason).includes('held_by_owner')));
}

{
 const file=database('held');seed(file);
 await assert.rejects(()=>applyMetadataSync(envOf(file),{event:'metadata:held-marker',films:[film()],now:()=>T}),code('film_person_held'));
}

{
 const file=database('open');
 const env=envOf(file);
 const out=await applyMetadataSync(env,{event:'metadata:missing',films:[film()],titles,people,now:()=>T});
 assert.equal(out.absent>=1,true);
 assert.equal(one(file,'SELECT COUNT(*) FROM film'),0);
}

{
 assert.deepEqual([...PRODUCER_OPERATIONS.keys()].sort(),KEYS);
 for(const kind of METADATA_SYNC_KINDS)assert.equal(PRODUCER_OPERATIONS.get(kind).atomic,true);
 const flipped=PRODUCER_WIRING.filter(item=>item.requires.every(kind=>[...PRODUCER_OPERATIONS.values()].some(op=>op.operation===kind&&op.atomic===true))).map(item=>item.name);
 assert.deepEqual(flipped,['epg_commit','metadata_sync','discovery_admission']);
 const audit=activationAudit();
 assert.equal(audit.producers.find(item=>item.name==='metadata_sync').wired,true);
 assert.equal(audit.producers.find(item=>item.name==='rated_admission_retention').wired,false);
 const ready=await handoffReadiness(envOf(database('prepared')),{now:T});
 assert.equal(ready.ready,false);
 assert.ok(!ready.blockers.includes('producer_not_wired:metadata_sync'));
 assert.ok(ready.blockers.includes('producer_not_wired:rated_admission_retention'));
}

{
 const source=fs.readFileSync(path.join(SRC,'canonical-metadata-sync-producer.js'),'utf8');
 assert.ok(!/canonical-producers\.js/.test(source),'no import of the registry (no cycle)');
 const workerText=fs.readFileSync('src/worker.js','utf8');
 assert.equal(workerText.split('CanonicalMetadataSync.applyMetadataSync').length-1,1);
 assert.ok(/typeof CanonicalMetadataSync!=='undefined'/.test(workerText));
 const build=fs.readFileSync('build.mjs','utf8');
 assert.ok(/scopedImports\('src\/canonical-metadata-sync-producer\.js','CanonicalMetadataSync'/.test(build));
}

console.log('canonical-metadata-sync-producer: ok');
