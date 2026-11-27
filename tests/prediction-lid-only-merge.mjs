// AIR-673 / ADR 0217 (Accepted) decision 9, choice M1: the prediction cohort on the result of the real `mergeFilms` of AIR-674. Real migrations on a sqlite D1 stand-in, the real lid-only coordinator and canonical writer. Synthetic only; DORMANT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {readLidOnlyDeferred,cohortFilms} from '../src/prediction-lid-only-exclusion.js';
import {d1Standin} from './d1-standin.mjs';
import {admitVerifiedFilm,admitVerifiedLidOnly,planLidOnlyD1} from '../src/letterboxd-admission-d1.js';
import {lidOnlyProofDigest} from '../src/domain/letterboxd-lid-only-digest.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lid-only-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"
 +"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');"
 +"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;";
const STAMP='2026-11-25T10:00:00.000Z';
let copies=0;
const fresh=(mode='d1')=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);sqlite(file,OPEN);
 if(mode==='closed')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 if(mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1;UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 return file;
};
const T0=Date.parse('2026-11-25T12:00:00.000Z');
const clock=(offsetMs=0)=>{let n=0;return ()=>new Date(T0+offsetMs+(n++)*10).toISOString();};
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const receipts=file=>rows(file,'SELECT request_id,state,operation_key,target_id,error_class FROM canonical_write_receipt ORDER BY created_at,request_id');
const snapshot=file=>JSON.stringify([rows(file,'SELECT * FROM film ORDER BY id'),rows(file,'SELECT * FROM film_external_id ORDER BY film_id,scheme,value'),rows(file,'SELECT * FROM film_lid_admission'),rows(file,'SELECT * FROM film_rated_admission'),rows(file,'SELECT * FROM film_identity_evidence'),receipts(file),rows(file,'SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id')]);
const sha=c=>c.repeat(64);
const proofOf=async(lid='Ab1',over={})=>{
 const proof={proofVersion:1,lid,finalUrl:'https://letterboxd.com/film/some-short-1999/',slug:'some-short-1999',canonicalPath:'/film/some-short-1999/',shortlink:lid,typeMarker:'video.movie',idBlockOutcome:'absent',completenessOutcome:'complete',title:'Some Short',year:1999,redirectStatus:301,pageStatus:200,checkedAt:'2026-11-25T11:59:00.000Z',...over};
 proof.proofDigest=await lidOnlyProofDigest(proof);
 return proof;
};
const LINKS_KEY='letterboxd/facts/links.json';
const NO_LINKS={fence:{key:LINKS_KEY,parts:0,etag:null},tmdbAlias:null};
const checker=async(lid='Ab1',extra={},over={})=>{const calls={n:0};const proof=await proofOf(lid,over);return {calls,reacquire:async()=>{calls.n++;return {ok:true,proof,links:NO_LINKS,...extra};}};};
const run=async(file,lid='Ab1',{route='watchlist_admission',now=clock(),extra={},over={},options,...rest}={})=>{const c=await checker(lid,extra,over);const out=await admitVerifiedLidOnly(envOf(file,options),{lid,route,reacquire:c.reacquire,now,...rest});return {out,calls:c.calls};};

const {mutateFilm,mergeFilms}=await import('../src/canonical-mutations.js');
const AT='2026-11-26T09:00:00.000Z';
const survivorOf=async(file,id='film:survivor')=>mutateFilm(envOf(file),{id,expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'Survivor',externalIds:[]}});
const merge=(file,over={})=>mergeFilms(envOf(file,over.options),{from:'film:lb:Ab1',to:'film:survivor',expected:{from:1,to:1},at:AT,...over.input});
const lidRows=file=>rows(file,'SELECT * FROM film_lid_admission ORDER BY lid');
const world=file=>JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),lidRows(file),rows(file,'SELECT * FROM film_redirect'),rows(file,'SELECT * FROM film_external_id ORDER BY film_id,scheme,value'),
 rows(file,'SELECT * FROM canonical_write_receipt ORDER BY request_id'),rows(file,'SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id')]);


// ===== AIR-673 / ADR 0217 decision 9 (M1), test 15, on the REAL result of AIR-674's `mergeFilms` (not a hand-written redirect): the cohort follows the proof row to the survivor, for every id that names it; an attach ends it =====
{
 const file=fresh();
 await run(file);await survivorOf(file);
 // before the merge: the lid-only Film is in the cohort under every nomination
 const names=['film:lb:Ab1','Ab1','lb-Ab1'];
 assert.deepEqual([...await readLidOnlyDeferred(envOf(file),names)].sort(),[...names].sort(),'before the merge');
 const merged=await merge(file);assert.equal(merged.merged,true);
 // after the real merge the proof row, the claim and the redirect are exactly what mergeFilms wrote; the survivor has no trusted movie claim
 assert.equal(rows(file,"SELECT film_id FROM film_lid_admission WHERE lid='Ab1'")[0].film_id,'film:survivor');
 assert.deepEqual([...await readLidOnlyDeferred(envOf(file),[...names,'film:survivor','film:unrelated'])].sort(),[...names,'film:survivor'].sort(),'after the real merge every id that names the resolved Film is excluded, an unrelated Film is not');
 assert.deepEqual([...await cohortFilms(envOf(file).DB,['film:survivor','film:lb:Ab1','film:unrelated'])].sort(),['film:lb:Ab1','film:survivor']);
 // an attach on the survivor (a current trusted movie claim) ends the exclusion for all of them
 sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:survivor','tmdb','990123',1,0)");
 assert.equal((await readLidOnlyDeferred(envOf(file),[...names,'film:survivor'])).size,0,'after the attach the ordinary gates apply');
}
console.log('prediction-lid-only-merge: ok');
