// AIR-672 / ADR 0217 (Accepted) step 3: migration 0047 and the immutable `film_lid_admission` row (K2), on the sqlite3-CLI D1 stand-in. No Worker, R2, network or production.
// Covered: the refusal of a wrong predecessor and what a refused file creates; the accepted file (an empty table, version 47, nothing else changed); every CHECK of an admitted row (only `absent`/`complete`,
// shortlink equal to the lid, the lid key, optional year); keep-first (a second row for the lid, any UPDATE of a proof column, DELETE) and the one allowed change: `film_id` (a merge).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

const NEW='0047_film_lid_admission.sql',PREVIOUS='0046_letterboxd_admission_authority.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.ok(files.includes(NEW),'0047 exists');
assert.equal(files[files.indexOf(NEW)-1],PREVIOUS,'0047 follows 0046');
const chain=files.slice(0,files.indexOf(NEW));
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lid-admission-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const ok=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr+' <- '+text);};
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern,text);};

const t46=path.join(root,'t46.sqlite'),t47=path.join(root,'t47.sqlite');
ok(t46,chain.map(read).join('\n'));
fs.copyFileSync(t46,t47);ok(t47,read(NEW));
let n=0;
const copy=source=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return file;};
const objects=file=>one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','trigger','index')");
const HEX='a'.repeat(64);
const row=(over={})=>{
 const base={lid:'abc12',film_id:"'film:lb:abc12'",route:"'watchlist_admission'",admitted_at:"'2026-11-27T10:00:00.000Z'",receipt_key:"'admission:lid:abc12'",proof_version:1,final_url:"'https://letterboxd.com/film/some-short/'",slug:"'some-short'",canonical_path:"'/film/some-short/'",shortlink:"'abc12'",type_marker:"'film'",id_block_outcome:"'absent'",completeness_outcome:"'complete'",title:"'Some Short'",year:1999,proof_digest:"'"+HEX+"'",checked_at:"'2026-11-27T10:00:00.000Z'",redirect_status:301,page_status:200};
 const merged={...base,...over};if(merged.lid==='abc12'||typeof merged.lid==='string'&&!merged.lid.startsWith("'"))merged.lid="'"+merged.lid+"'";
 return 'INSERT INTO film_lid_admission ('+Object.keys(merged).join(',')+') VALUES ('+Object.values(merged).join(',')+');';
};

// ===== the migration =====
{
 const before=objects(t46);

 const stale=path.join(root,'t45.sqlite');ok(stale,chain.slice(0,-1).map(read).join('\n'));
 const before45=objects(stale);
 refused(stale,read(NEW));
 assert.equal(objects(stale),before45,'a refused file creates nothing');
 assert.equal(one(stale,'SELECT version FROM schema_contract WHERE id=1'),45);
 const noMarker=copy(t46);ok(noMarker,'DROP TABLE letterboxd_admission_authority');
 refused(noMarker,read(NEW));
 const noTrigger=copy(t46);ok(noTrigger,'DROP TRIGGER schema_contract_no_downgrade');
 refused(noTrigger,read(NEW));
 const taken=copy(t46);ok(taken,'CREATE TABLE film_lid_admission_x (a INTEGER)');
 refused(taken,read(NEW));
 assert.equal(objects(t47),before+4,'exactly the table, its primary-key index and its two triggers are new');
 assert.equal(one(t47,'SELECT version FROM schema_contract WHERE id=1'),47);
 assert.equal(one(t47,'SELECT COUNT(*) FROM film_lid_admission'),0,'the table is empty');
 refused(copy(t47),read(NEW),/./);
}

// ===== an admitted row =====
const fresh=()=>{const file=copy(t47);ok(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:lb:abc12',1,NULL,'Some Short','2026-11-27T10:00:00.000Z')");return file;};
{
 const f=fresh();ok(f,row());
 assert.equal(one(f,'SELECT COUNT(*) FROM film_lid_admission'),1);
 ok(copy(f),'SELECT 1');
 const g=fresh();ok(g,row({year:'NULL'}));assert.equal(one(g,'SELECT year FROM film_lid_admission'),null,'the year is optional for a lid-only admission');
 const bad=(over,why)=>refused(fresh(),row(over),/CHECK|constraint|NOT NULL/i);
 bad({shortlink:"'other'"});bad({receipt_key:"'admission:lid:other'"});bad({id_block_outcome:"'tmdb_movie'"});bad({id_block_outcome:"'unreadable'"});
 bad({completeness_outcome:"'truncated'"});bad({route:"'discovery'"});bad({film_id:"'tmdb:1'"});bad({proof_digest:"'"+'A'.repeat(64)+"'"});bad({proof_digest:"'abc'"});
 bad({page_status:404});bad({redirect_status:200});bad({title:"''"});bad({year:1700});bad({proof_version:0});bad({lid:"'a b'"});bad({lid:"''"});
 refused(f,row(),/UNIQUE|constraint/i);
 refused(f,row({lid:"'abc12'"}).replace('abc12','abc12'),/UNIQUE|constraint/i);
}

// ===== keep-first, immutable, never deleted =====
{
 const f=fresh();ok(f,row());
 for(const column of ["route","admitted_at","final_url","slug","canonical_path","type_marker","title","proof_digest","checked_at"]){
  const value=column==='receipt_key'?"'admission:lid:abc12'":column==='shortlink'?"'abc12'":column==='proof_digest'?"'"+'b'.repeat(64)+"'":column==='route'?"'ratings_diary'":column==='admitted_at'||column==='checked_at'?"'2026-11-28T10:00:00.000Z'":"'changed'";
  refused(f,'UPDATE film_lid_admission SET '+column+'='+value+" WHERE lid='abc12'",/film_lid_admission_immutable|CHECK/i);
 }
 refused(f,"UPDATE film_lid_admission SET year=2000 WHERE lid='abc12'",/film_lid_admission_immutable/);
 refused(f,"UPDATE film_lid_admission SET proof_version=2 WHERE lid='abc12'",/film_lid_admission_immutable/);
 refused(f,"UPDATE film_lid_admission SET lid='zzz' WHERE lid='abc12'",/film_lid_admission_immutable|CHECK/i);
 refused(f,"DELETE FROM film_lid_admission WHERE lid='abc12'",/film_lid_admission_keep/);
 // the one allowed change: a merge moves film_id; every other column stays
 ok(f,"UPDATE film_lid_admission SET film_id='film:tmdb:7' WHERE lid='abc12'");
 assert.equal(one(f,"SELECT film_id FROM film_lid_admission WHERE lid='abc12'"),'film:tmdb:7');
 assert.equal(one(f,"SELECT proof_digest FROM film_lid_admission WHERE lid='abc12'"),HEX);
 refused(f,"UPDATE film_lid_admission SET film_id='tmdb:7' WHERE lid='abc12'",/CHECK/i);
}
console.log('Film lid admission (AIR-672, migration 0047) passed.');
