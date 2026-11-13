// AIR-374 H1: the D1 limit on LIKE and GLOB patterns (migrations/0021_d1_glob_pattern_limit.sql), OFFLINE. sqlite3-CLI D1 stand-in only: no Worker, R2, D1 or Cloudflare access; nothing
// here applies anything to production. D1 refuses to EVALUATE a LIKE or GLOB pattern longer than 50 bytes (error 7500, observed on production on 13 Nov 2026: the H1 load was refused at the first INSERT
// into film_rated_admission), while the plain sqlite3 CLI has no such limit, so the stand-in cannot fail on its own. This file therefore (1) scans every migration for a pattern over the limit, with the
// two applied files that carry the defect pinned and superseded, (2) scans the final schema of the whole chain, (3) proves 0021 refuses what it must (version, a non-empty table), (4) proves the rebuilt
// CHECKs accept and refuse EXACTLY what the 92-byte pattern did (a differential over a corpus of time strings), and (5) proves the rest of the four tables is unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

const LIMIT=50;
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-pattern-limit-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const bail=(file,input)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,input)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,input)=>Object.values(rows(file,input)[0]||{})[0];
const patterns=text=>[...text.matchAll(/\b(?:GLOB|LIKE)\s+'((?:[^']|'')*)'/gi)].map(match=>match[1].replace(/''/g,"'"));
const longOf=text=>patterns(text).filter(pattern=>Buffer.byteLength(pattern)>LIMIT);

// ===== 1. every migration file: no pattern over the D1 limit, except the two applied files that 0021 supersedes =====
const SUPERSEDED={'0014_localization_source.sql':2,'0015_film_admission.sql':2};
for(const name of files){
 const text=fs.readFileSync('migrations/'+name,'utf8');
 const long=longOf(text);
 if(name in SUPERSEDED){
  assert.equal(long.length,SUPERSEDED[name],name+' keeps exactly its known long patterns (applied history is never rewritten)');
  assert.ok(long.every(pattern=>Buffer.byteLength(pattern)===92),name+': the known pattern is the 92-byte time pattern');
 }else assert.deepEqual(long.map(pattern=>Buffer.byteLength(pattern)),[],name+' has no LIKE or GLOB pattern over '+LIMIT+' bytes (D1 error 7500)');
}
assert.ok(files.includes('0021_d1_glob_pattern_limit.sql'),'0021 exists');
assert.deepEqual(files.slice(-2),['0021_d1_glob_pattern_limit.sql','0022_epg_priority_pause.sql'],'0021 is followed only by 0022, the inert EPG-priority pause (tests/epg-priority-gate.mjs)');

// ===== 2. the databases: v20 (the defect still in), v21 (0021 applied), and the pattern scan of the final schema =====
const upTo=number=>files.filter(name=>Number(name.slice(0,4))<=number);
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const t19=path.join(root,'t19.sqlite'),t20=path.join(root,'t20.sqlite'),t21=path.join(root,'t21.sqlite');
assert.equal(bail(t19,upTo(19).map(read).join('\n')).status,0);
fs.copyFileSync(t19,t20);
assert.equal(bail(t20,read('0020_canonical_producer_run.sql')).status,0,'0020 applies on a complete schema 19');
fs.copyFileSync(t20,t21);
const apply21=bail(t21,read('0021_d1_glob_pattern_limit.sql'));
assert.equal(apply21.status,0,'0021 applies on a complete schema 20: '+apply21.stderr);
assert.equal(one(t21,'SELECT version FROM schema_contract WHERE id = 1'),21);
assert.equal(one(t21,'SELECT COUNT(*) FROM schema_contract'),1,'one schema_contract row');
const schemaSql=file=>rows(file,"SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name");
const overLimit=file=>schemaSql(file).flatMap(row=>longOf(row.sql).map(pattern=>row.name+':'+Buffer.byteLength(pattern)));
assert.deepEqual(overLimit(t21),[],'the final schema of the chain has no LIKE or GLOB pattern over the D1 limit');
assert.ok(overLimit(t20).length===4,'the stand-in v20 still has the four defective tables: '+overLimit(t20).join(','));
assert.deepEqual(overLimit(t20).map(entry=>entry.split(':')[0]).sort(),['film_localization_source','film_rated_admission','film_retention','person_localization_source']);

// ===== 3. 0021 refuses what it must, before anything is dropped =====
const guard=(source,setup,expectRefusal,label)=>{
 const file=path.join(root,'g-'+label+'.sqlite');fs.copyFileSync(source,file);
 if(setup)assert.equal(bail(file,setup).status,0,label+': setup');
 const result=bail(file,read('0021_d1_glob_pattern_limit.sql'));
 if(expectRefusal){
  assert.notEqual(result.status,0,label+': refused');
  assert.equal(one(file,'SELECT version FROM schema_contract WHERE id = 1'),one(source,'SELECT version FROM schema_contract WHERE id = 1'),label+': version unchanged');
  assert.equal(one(file,"SELECT COUNT(*) FROM sqlite_master WHERE name IN ('film_rated_admission','film_retention','film_localization_source','person_localization_source')"),4,label+': no table dropped');
 }else assert.equal(result.status,0,label+': applies');
 return file;
};
guard(t19,null,true,'v19');
guard(t21,null,true,'v21-again');
// a minimal film row whatever the NOT NULL columns of the film table are (the chain's own definition): fill each with a neutral value
const filmInsert=()=>{const cols=rows(t20,"SELECT name, type FROM pragma_table_info('film') WHERE \"notnull\" = 1 AND dflt_value IS NULL AND pk = 0");return `INSERT INTO film (id, ${cols.map(c=>c.name).join(', ')}) VALUES ('film:tmdb:1', ${cols.map(c=>c.type==='INTEGER'?'1':"'x'").join(', ')});`;};
const personInsert=()=>{const cols=rows(t20,"SELECT name, type FROM pragma_table_info('person') WHERE \"notnull\" = 1 AND dflt_value IS NULL AND pk = 0");return `INSERT INTO person (id, ${cols.map(c=>c.name).join(', ')}) VALUES ('person:tmdb:1', ${cols.map(c=>c.type==='INTEGER'?'1':"'x'").join(', ')});`;};
const parents=filmInsert()+'\n'+personInsert()+'\n';
const AT='2026-11-12T10:00:00.000Z';
const admission=at=>`INSERT INTO film_rated_admission (film_id, tmdb, source_code, archive_sha256, title, year, receipt_key, receipt_film_key, verified_at, request_id, updated_at) VALUES ('film:tmdb:1','1','abc','${'a'.repeat(64)}','t',2000,'k','tmdb_1',${at},'r','${AT}')`;
for(const table of ['film_rated_admission','film_retention','film_localization_source','person_localization_source']){
 const row={film_rated_admission:admission("'"+AT+"'"),film_retention:`INSERT INTO film_retention (film_id, basis, watchlist, evidence_json, request_id, observed_at, updated_at) VALUES ('film:tmdb:1','watchlist_fact',1,'{}','r','${AT}','${AT}')`,film_localization_source:`INSERT INTO film_localization_source (film_id, source, value, source_version, provenance_json, request_id, observed_at, updated_at) VALUES ('film:tmdb:1','src','v','1','{}','r','${AT}','${AT}')`,person_localization_source:`INSERT INTO person_localization_source (person_id, source, value, source_version, provenance_json, request_id, observed_at, updated_at) VALUES ('person:tmdb:1','src','v','1','{}','r','${AT}','${AT}')`}[table];
 const file=path.join(root,'full-'+table+'.sqlite');fs.copyFileSync(t20,file);
 assert.equal(bail(file,parents+row).status,0,table+': seed one row on v20');
 const result=bail(file,read('0021_d1_glob_pattern_limit.sql'));
 assert.notEqual(result.status,0,table+': 0021 refuses a non-empty table');
 assert.equal(one(file,'SELECT version FROM schema_contract WHERE id = 1'),20,table+': still version 20');
 assert.equal(one(file,`SELECT COUNT(*) FROM ${table}`),1,table+': the row is still there');
}

// ===== 4. DIFFERENTIAL: the rebuilt time CHECKs accept and refuse exactly what the 92-byte pattern did =====
const corpus=[
 '2026-11-12T10:00:00.000Z','2026-11-12T10:00:00.00Z','2026-11-12T10:00:00.0000Z','2026-11-12 10:00:00.000Z','2026-11-12T10:00:00,000Z','2026-11-12T10:00:00.000z','2026-11-12T10:00:00.000',
 '2026-11-12T10:00:00.000ZZ','2026-11-12T10:00:00+000Z','2026-11-12T10:00:00.00aZ','2026-11-12T1a:00:00.000Z','2026-1a-12T10:00:00.000Z','202a-11-12T10:00:00.000Z','2026-11-1aT10:00:00.000Z',
 '2026-11-12T10:0a:00.000Z','2026-11-12T10:00:0a.000Z','2026/11/12T10:00:00.000Z','2026-11-12T10-00-00.000Z','','Z','T','2026-11-12','10:00:00.000Z',' 2026-11-12T10:00:00.000Z','2026-11-12T10:00:00.000Z ',
 '2026-13-45T25:61:61.999Z','0000-00-00T00:00:00.000Z','9999-99-99T99:99:99.999Z','２０２６-11-12T10:00:00.000Z','2026-11-12T10:00:00.00éZ','2026-11-12T10:00:00.000\nZ',
];
const writer=file=>({
 film_rated_admission:at=>admission(q(at)),
 film_retention:at=>`INSERT INTO film_retention (film_id, basis, watchlist, evidence_json, request_id, observed_at, updated_at) VALUES ('film:tmdb:1','watchlist_fact',1,'{}','r',${q(at)},'${AT}')`,
 film_localization_source:at=>`INSERT INTO film_localization_source (film_id, source, value, source_version, provenance_json, request_id, observed_at, updated_at) VALUES ('film:tmdb:1','src','v','1','{}','r',${q(at)},'${AT}')`,
 person_localization_source:at=>`INSERT INTO person_localization_source (person_id, source, value, source_version, provenance_json, request_id, observed_at, updated_at) VALUES ('person:tmdb:1','src','v','1','{}','r',${q(at)},'${AT}')`,
});
function q(value){return "'"+String(value).replace(/'/g,"''")+"'";}
const verdict=(file,table,at)=>{
 const probe=path.join(root,'p-'+Math.random().toString(16).slice(2)+'.sqlite');fs.copyFileSync(file,probe);
 const result=bail(probe,parents+writer(probe)[table](at));
 fs.rmSync(probe,{force:true});
 return result.status===0;
};
let accepted=0,refused=0;
for(const table of Object.keys(writer(t20))){
 for(const at of corpus){
  const before=verdict(t20,table,at),after=verdict(t21,table,at);
  assert.equal(after,before,`${table}: ${JSON.stringify(at)} is ${before?'accepted':'refused'} by the 92-byte CHECK and must be ${before?'accepted':'refused'} by the rebuilt one`);
  if(after)accepted++;else refused++;
 }
}
assert.ok(accepted>=4,'the corpus has accepted values: '+accepted);
assert.ok(refused>=4*20,'the corpus has refused values: '+refused);
assert.equal(verdict(t21,'film_rated_admission',AT),true,'a normalized UTC time is accepted');
assert.equal(verdict(t21,'film_retention','2026-11-12T10:00:00.000z'),false,'a lower-case z is refused');


// ===== 4b. DIFFERENTIAL over every OTHER CHECK of the four tables: each variant breaks one column, and v21 must give the verdict v20 gives =====
const SHA='a'.repeat(64);
const base={
 film_rated_admission:{film_id:'film:tmdb:1',tmdb:'1',source_code:'abc',archive_sha256:SHA,title:'t',year:2000,receipt_key:'k',receipt_film_key:'tmdb_1',verified_at:AT,request_id:'r',updated_at:AT},
 film_retention:{film_id:'film:tmdb:1',basis:'watchlist_fact',watchlist:1,evidence_json:'{}',request_id:'r',observed_at:AT,updated_at:AT},
 film_localization_source:{film_id:'film:tmdb:1',source:'src',value:'v',source_version:'1',provenance_json:'{}',request_id:'r',observed_at:AT,updated_at:AT},
 person_localization_source:{person_id:'person:tmdb:1',source:'src',value:'v',source_version:'1',provenance_json:'{}',request_id:'r',observed_at:AT,updated_at:AT},
};
const variants={
 film_rated_admission:[{tmdb:'0'},{tmdb:'01'},{tmdb:'1x'},{tmdb:'1234567890123'},{source_code:''},{archive_sha256:SHA.toUpperCase()},{archive_sha256:'a'.repeat(63)},{archive_sha256:'g'.repeat(64)},{receipt_key:''},{receipt_film_key:'tmdb_2'},{request_id:''},{title:null},{year:null}],
 film_retention:[{basis:'other'},{watchlist:2},{watchlist:-1},{evidence_json:'{'},{request_id:''}],
 film_localization_source:[{source:'Src'},{source:'owner'},{source:'dictionary'},{source:'reviewed'},{source:'a'.repeat(41)},{source:'a'.repeat(40)},{value:''},{source_version:''},{provenance_json:'{'},{request_id:''}],
 person_localization_source:[{source:'Src'},{source:'owner'},{source:'reviewed'},{source:'a'.repeat(41)},{value:''},{source_version:''},{provenance_json:'{'},{request_id:''}],
};
const rowSql=(table,row)=>`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(v=>v===null?'NULL':typeof v==='number'?String(v):q(v)).join(',')})`;
let otherDiffs=0,otherRefused=0;
for(const [table,list] of Object.entries(variants)){
 for(const patch of [{},...list]){
  const sql=rowSql(table,{...base[table],...patch});
  const verdictOf=file=>{const probe=path.join(root,'v-'+Math.random().toString(16).slice(2)+'.sqlite');fs.copyFileSync(file,probe);const r=bail(probe,parents+sql);fs.rmSync(probe,{force:true});return r.status===0;};
  const before=verdictOf(t20),after=verdictOf(t21);
  assert.equal(after,before,`${table}: variant ${JSON.stringify(patch).slice(0,80)} gets the verdict of the 92-byte schema (${before?'accepted':'refused'})`);
  otherDiffs++;if(!after)otherRefused++;
 }
}
assert.ok(otherDiffs>=30&&otherRefused>=20,'the other-CHECK differential ran '+otherDiffs+' variants, '+otherRefused+' refused');

// ===== 5. the rest of the four tables is unchanged: the columns, the keys, the indexes, and the other CHECKs =====
for(const table of ['film_rated_admission','film_retention','film_localization_source','person_localization_source']){
 const cols=file=>JSON.stringify(rows(file,`SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY cid`));
 assert.equal(cols(t21),cols(t20),table+': same columns');
 const fks=file=>JSON.stringify(rows(file,`SELECT "table", "from", "to" FROM pragma_foreign_key_list('${table}') ORDER BY id`));
 assert.equal(fks(t21),fks(t20),table+': same foreign keys');
 const idx=file=>JSON.stringify(rows(file,`SELECT name, "unique" FROM pragma_index_list('${table}') ORDER BY name`));
 assert.equal(idx(t21),idx(t20),table+': same indexes');
 const strict=file=>one(file,`SELECT strict FROM pragma_table_list('${table}')`);
 assert.equal(strict(t21),strict(t20),table+': still STRICT');
}
assert.equal(one(t21,"SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN ('film_rated_admission_tmdb','film_rated_admission_source_code')"),2,'both unique indexes are back');
for(const table of ['film_rated_admission','film_retention','film_localization_source','person_localization_source'])assert.equal(one(t21,`SELECT COUNT(*) FROM ${table}`),0,table+' is empty after 0021');
// no downgrade
assert.notEqual(bail(t21,'UPDATE schema_contract SET version = 20 WHERE id = 1').status,0,'the version never goes down');
// a second run of the guard row: the file refuses at version 21 (checked above); the other four-table CHECKs still hold
assert.notEqual(bail(t21,parents+admission("'x'")).status,0,'a bad time is still refused on v21');
console.log('migration-pattern-limit ok: '+files.length+' migrations scanned, differential '+accepted+' accepted / '+refused+' refused');
