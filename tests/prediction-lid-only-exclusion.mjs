// AIR-673 / ADR 0217 (Accepted) decision 9 (M1), test 15 (queue, manifest and submit exclude a lid-only Film and stop excluding it after an attach), on the real migrations (sqlite D1 stand-in).
// Synthetic rows only; no Worker, network, R2 or production. DORMANT: nothing activates lid-only admission.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {LID_ONLY_DEFERRED,lidCandidate,predictionEligibility,readLidOnlyDeferred} from '../src/prediction-lid-only-exclusion.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lid-only-m1-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite'),legacy=path.join(root,'legacy.sqlite');
const NEW='0048_film_lid_admission.sql';
sqlite(legacy,files.filter(name=>name<NEW).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
let copies=0;
const fresh=(source=template)=>{const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(source,file);return file;};
const STAMP="'2026-11-27T10:00:00.000Z'",HEX="'"+'a'.repeat(64)+"'";
const film=(file,id)=>sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+id+"',1,NULL,'T',"+STAMP+")");
const claim=(file,id,scheme,value,{trusted=1,conflicting=0}={})=>sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('"+id+"','"+scheme+"','"+value+"',"+trusted+","+conflicting+")");
const admission=(file,lid,filmId)=>sqlite(file,"INSERT INTO film_lid_admission (lid,film_id,route,admitted_at,receipt_key,proof_version,final_url,slug,canonical_path,shortlink,type_marker,id_block_outcome,completeness_outcome,title,year,proof_digest,checked_at,redirect_status,page_status) VALUES ('"+lid+"','"+filmId+"','watchlist_admission',"+STAMP+",'admission:lid:"+lid+"',1,'https://letterboxd.com/film/s/','s','/film/s/','"+lid+"','film','absent','complete','T',1999,"+HEX+","+STAMP+",301,200)");
const envOf=file=>({DB:d1Standin(file)});

// The id spelling only nominates a lid; it never decides.
assert.equal(lidCandidate('abc12'),'abc12');
assert.equal(lidCandidate('lb-abc12'),'abc12');
assert.equal(lidCandidate('film:lb:abc12'),'abc12');
assert.equal(lidCandidate('tmdb_603'),null,'a movie id is never a lid candidate');
assert.equal(lidCandidate('film:tmdb:603'),null);
assert.equal(lidCandidate('a b'),null);
assert.equal(lidCandidate(7),null);

// 1. A lid-only Film with no trusted tmdb claim is excluded, whichever spelling the queue names it by; an unrelated lid and a movie id are not.
{
 const file=fresh();
 film(file,'film:lb:abc12');claim(file,'film:lb:abc12','letterboxd','abc12');admission(file,'abc12','film:lb:abc12');
 film(file,'film:tmdb:603');claim(file,'film:tmdb:603','tmdb','603');
 const out=await readLidOnlyDeferred(envOf(file),['abc12','lb-abc12','film:lb:abc12','zzz99','tmdb_603']);
 assert.deepEqual([...out].sort(),['abc12','film:lb:abc12','lb-abc12']);
}

// 2. After an attach (a trusted tmdb claim on the SAME Film) the exclusion ends; the id spelling `film:lb:` changes nothing, the claim rows decide.
{
 const file=fresh();
 film(file,'film:lb:abc12');claim(file,'film:lb:abc12','letterboxd','abc12');admission(file,'abc12','film:lb:abc12');
 assert.equal((await readLidOnlyDeferred(envOf(file),['abc12'])).size,1);
 claim(file,'film:lb:abc12','tmdb','603');
 assert.equal((await readLidOnlyDeferred(envOf(file),['abc12'])).size,0,'the attach removes only the exclusion');
 // An untrusted or conflicting tmdb claim is not a trusted claim: still excluded.
 const other=fresh();
 film(other,'film:lb:q1');claim(other,'film:lb:q1','letterboxd','q1');admission(other,'q1','film:lb:q1');
 claim(other,'film:lb:q1','tmdb','11',{trusted:0});
 claim(other,'film:lb:q1','tmdb','12',{trusted:1,conflicting:1});
 assert.equal((await readLidOnlyDeferred(envOf(other),['q1'])).size,1);
}

// 3. A merge: the admission row's Film is a redirect source; the survivor's trusted tmdb claim ends the exclusion, the survivor's absence keeps it.
{
 const file=fresh();
 film(file,'film:lb:m1');claim(file,'film:lb:m1','letterboxd','m1');admission(file,'m1','film:lb:m1');
 film(file,'film:tmdb:700');
 sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb:m1','film:tmdb:700',"+STAMP+")");
 assert.equal((await readLidOnlyDeferred(envOf(file),['m1'])).size,1,'survivor without a trusted movie claim: still excluded');
 claim(file,'film:tmdb:700','tmdb','700');
 assert.equal((await readLidOnlyDeferred(envOf(file),['m1'])).size,0,'survivor with a trusted movie claim: not excluded');
}

// 4. Dormant paths: the table not applied (nothing lid-only can exist), no D1 binding (R2-only world), no candidate (no read at all).
{
 assert.equal((await readLidOnlyDeferred(envOf(fresh(legacy)),['abc12'])).size,0,'migration 0048 not applied: nothing excluded');
 assert.equal((await readLidOnlyDeferred({},['abc12'])).size,0);
 let queried=0;
 const spy={DB:{prepare(){queried++;throw new Error('must not query');}}};
 assert.equal((await readLidOnlyDeferred(spy,['tmdb_603','film:tmdb:603'])).size,0);
 assert.equal(queried,0,'ids that cannot be lids cost no statement');
}

// 5. Fail closed: any read failure other than the missing table is thrown, never turned into "not excluded".
{
 const broken={DB:{prepare(){return {bind(){return {all:async()=>{throw new Error('D1_ERROR: network connection lost');}};}};}}};
 await assert.rejects(()=>readLidOnlyDeferred(broken,['abc12']),error=>error.code==='lid_only_exclusion_unreadable');
}

// 6. Chunking: more than 80 candidates are read in chunks, all found.
{
 const file=fresh();
 const lids=Array.from({length:130},(_,i)=>'l'+i);
 for(const lid of lids){film(file,'film:lb:'+lid);claim(file,'film:lb:'+lid,'letterboxd',lid);admission(file,lid,'film:lb:'+lid);}
 const out=await readLidOnlyDeferred(envOf(file),lids);
 assert.equal(out.size,130);
}

// 7. The separate `predictions.eligibility` field: a statement about eligibility only; it never invents anything about values.
{
 const trusted={scheme:'tmdb',value:'603',trusted:true,conflicting:false};
 assert.deepEqual(predictionEligibility({claims:[{scheme:'letterboxd',value:'abc12',trusted:true,conflicting:false}],lidAdmitted:true}),LID_ONLY_DEFERRED);
 assert.deepEqual(LID_ONLY_DEFERRED,{status:'not_eligible',reason:'lid_only_deferred'});
 assert.equal(predictionEligibility({claims:[trusted],lidAdmitted:true}),null,'after an attach the ordinary gates apply');
 assert.equal(predictionEligibility({claims:[{...trusted,retired:true}],lidAdmitted:true})?.reason,'lid_only_deferred','a retired movie claim is not a current claim');
 assert.equal(predictionEligibility({claims:[],lidAdmitted:false}),null,'no admission row: no statement');
 assert.equal(predictionEligibility({claims:null,lidAdmitted:true}),null);
 assert.notEqual(predictionEligibility({claims:[],lidAdmitted:true}),LID_ONLY_DEFERRED,'a fresh object each time');
}
console.log('prediction-lid-only-exclusion: ok');
