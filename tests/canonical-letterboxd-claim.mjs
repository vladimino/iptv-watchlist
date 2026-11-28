// AIR-559 (ADR 0184, Accepted; dormant): the trusted `letterboxd` claim of an existing canonical Film that the Ratings domain already ties to one TMDB movie (src/canonical-letterboxd-claim.js), on the sqlite3-CLI
// D1 stand-in. SYNTHETIC ids only (no owner-private profile, no production id list). No Worker, R2, D1 or Cloudflare access.
// Covered: the full proof (both authorities, one unambiguous Ratings alias, unique trusted TMDB ownership, no competing claim), every refusal writes nothing, a pass writes exactly one fenced receipted claim
// and nothing else, idempotent replay and retry, dry run vs live, concurrency and the revision CAS, authority below `open` / held, `catalogStartedFilm` found afterwards with the canonical security rule
// unchanged, the `addOnly` mode of the existing unit (no pruning, existing digests unchanged), the bounds, and the static dormancy. CLAIM_SRC points the file at a mutant copy of src/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.CLAIM_SRC?path.resolve(process.env.CLAIM_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const M=await load('canonical-letterboxd-claim.js');
const {mutateFilm}=await load('canonical-mutations.js');
const {filmExternalIdsDigest,filmExternalIdsContent}=await load('canonical-film-external-ids-producer.js');
const {catalogStartedFilm}=await load('canonical-catalog-reader.js');
const {ensureLetterboxdClaims,LETTERBOXD_CLAIM_OFFER_MAX,LETTERBOXD_CLAIM_ACTIVATED,planLetterboxdClaim,replanLetterboxdClaim,applyLetterboxdClaim,applyLetterboxdClaims,LETTERBOXD_CLAIM_ORIGIN,LETTERBOXD_CLAIM_UNIT_CAP}=M;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-lb-claim-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
// The chain WITHOUT 0055 (ratings_view has no fact_key index): the section 'projection index 0055' proves the same planner verdicts on both.
const template54=path.join(root,'template54.sqlite');
{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name<'0055').sort();
 assert.equal(chain.at(-1).slice(0,4),'0054');
 assert.equal(sqlite(template54,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
let n=0;
function database(stage='open',source=template){
 const file=path.join(root,'c-'+(n++)+'.sqlite');
 fs.copyFileSync(source,file);
 if(['r2','prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='open')assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 assert.equal(sqlite(file,"UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const T='2026-11-20T10:00:00.000Z';
const U='2026-11-01T00:00:00.000Z';
const FID=k=>'film:tmdb:'+k;
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
// A Film with its trusted tmdb claim (default) and any extra stored ids [scheme,value,trusted,conflicting].
const seedFilm=(file,k,{ids=null,identity=true}={})=>{
 const claims=ids||[['tmdb',String(k),1,0]];
 assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+FID(k)+"',2,"+q(identity?'tmdb:'+k:null)+",'Kept Title','"+U+"');"+claims.map(([s,v,t,c])=>"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(k)+"','"+s+"','"+v+"',"+t+","+c+",NULL);").join('')).status,0);
};
// The Ratings side of one record. The AUTHORITATIVE evidence is the pair of D1 documents (link index + fact record); `ratings_view` is only the projection. Options: `docs:false` writes the projection only (a stale
// projection after an unlink), `movie:false` omits the movie alias from the index, `lidKey`/`key` point the lid at another fact key, `record` overrides the record body.
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const putDoc=(file,key,value)=>{const text=JSON.stringify(value),tag=sha(text);assert.equal(sqlite(file,"DELETE FROM ratings_document WHERE key="+q(key)+";INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ("+q(key)+",0,"+q(text)+",'"+tag+"','"+U+"')").status,0);};
const getDoc=(file,key)=>{const r=rows(file,"SELECT body FROM ratings_document WHERE key="+q(key));return r.length?JSON.parse(r[0].body):null;};
const seedRatings=(file,lid,k,{key='tmdb-'+k,movie=true,lidKey=key,docs=true,record=null}={})=>{
 assert.equal(sqlite(file,"INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ("+q(lid)+","+q(lidKey)+",NULL,NULL,1,0,'"+U+"');"+(movie?"INSERT OR IGNORE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('tmdb_"+k+"',"+q(key)+",NULL,NULL,1,0,'"+U+"');":'')).status,0);
 if(!docs)return;
 const index=getDoc(file,'letterboxd/facts/links.json')||{};
 index['letterboxd:'+lid]=lidKey;if(movie)index['tmdb:'+k]=key;
 putDoc(file,'letterboxd/facts/links.json',index);
 putDoc(file,'letterboxd/facts/films/'+lidKey+'.json',record||{schemaVersion:1,factKey:lidKey,links:{letterboxd:lid,tmdb:String(k)},redirectTo:null,migrating:null});
};
const ext=(file,k=1)=>rows(file,"SELECT scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE film_id='"+FID(k)+"' ORDER BY scheme,value");
const pairs=(file,k=1)=>ext(file,k).map(item=>item.scheme+':'+item.value);
const receipts=file=>rows(file,'SELECT request_id,operation,origin,target_id,state,attempts,applied_revision,error_class FROM canonical_write_receipt ORDER BY target_id,created_at');
const revision=(file,id=FID(1))=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+id+"'")??0);
const TABLES=['film','film_external_id','film_alias','film_person_credit','film_redirect','film_rated_admission','film_retention','film_dimension','film_metadata','canonical_revision','canonical_write_receipt','ratings_view','tmdb_retirement_decision'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3')]));
const REQ={event:'cohort:test',now:()=>T};
// A fresh database with ONE provable cohort member: Film 1 (movie 1), lid AAA1.
const proved=(over={})=>{const file=database();seedFilm(file,1);seedRatings(file,'AAA1',1);if(over.more)over.more(file);return file;};

// 1. A pass: exactly one trusted claim with fixed provenance, one revision, one applied receipt of the existing unit; every other row is untouched.
{
 const file=proved(),env=envOf(file),before=dump(file);
 const plan=await planLetterboxdClaim(env,{lid:'AAA1',tmdb:'1'});
 assert.deepEqual({verdict:plan.verdict,reason:plan.reason,filmId:plan.filmId,already:plan.already},{verdict:'pass',reason:'proved',filmId:FID(1),already:false});
 assert.equal(dump(file),before,'planning is read-only');
 const out=await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1'});
 assert.equal(out.state,'written');assert.equal(out.outcomeState,'applied');
 assert.deepEqual(pairs(file),['letterboxd:AAA1','tmdb:1']);
 const claim=ext(file).find(item=>item.scheme==='letterboxd');
 assert.equal(claim.trusted,1);assert.equal(claim.conflicting,0);
 assert.deepEqual(JSON.parse(claim.provenance_json),{source:'ratings_alias_bridge',tmdb:'1',adr:'0184'});
 assert.equal(revision(file),1);
 const r=receipts(file);assert.equal(r.length,1);assert.deepEqual([r[0].operation,r[0].origin,r[0].state,r[0].target_id],['film_external_ids',LETTERBOXD_CLAIM_ORIGIN,'applied',FID(1)]);
 // Nothing else moved: the Film row's identity and title, the aliases, ratings, retention, metadata and the other tables.
 assert.equal(one(file,"SELECT original_title FROM film WHERE id='"+FID(1)+"'"),'Kept Title');
 assert.equal(one(file,"SELECT canonical_identity FROM film WHERE id='"+FID(1)+"'"),'tmdb:1');
 for(const table of ['film_alias','film_person_credit','film_rated_admission','film_retention','film_dimension','film_metadata','ratings_view','tmdb_retirement_decision','film_redirect'])assert.equal(JSON.parse(before).find(item=>item[0]===table)[1].length,rows(file,'SELECT * FROM '+table).length,table+' is untouched');
 // The reader that returned 404 now finds the Film by its lid, without any Ratings fallback and with the unchanged canonical rule.
 const found=await catalogStartedFilm(env,'AAA1');
 assert.equal(found.state,'found');assert.equal(found.film.filmId,FID(1));assert.equal(found.film.tmdb,'1');
 assert.equal((await catalogStartedFilm(env,'tmdb_1')).state,'found');
 assert.equal((await catalogStartedFilm(env,'UNKNOWN')).state,'absent','an unknown id stays absent (404)');
}

// 2. Before the claim the reader answers absent (the AIR-549 defect), so the pass is what fixes it.
{
 const file=proved(),env=envOf(file);
 assert.equal((await catalogStartedFilm(env,'AAA1')).state,'absent');
}

// 3. Idempotent: the same event again, a different event again, and the same call concurrently write no second row, no second revision and no second receipt.
{
 const file=proved(),env=envOf(file);
 await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1'});
 const after=dump(file);
 const again=await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1'});
 assert.equal(again.state,'already');assert.equal(again.reason,'already');
 const other=await applyLetterboxdClaim(env,{...REQ,event:'cohort:other',lid:'AAA1',tmdb:'1'});
 assert.equal(other.state,'already');
 assert.equal(dump(file),after,'a replay and a second event change nothing');
 const file2=proved(),env2=envOf(file2);
 const both=await Promise.all([applyLetterboxdClaim(env2,{...REQ,lid:'AAA1',tmdb:'1'}),applyLetterboxdClaim(env2,{...REQ,lid:'AAA1',tmdb:'1'})].map(p=>p.catch(error=>({state:'error',code:error.code}))));
 assert.ok(both.some(item=>item.state==='written'),'one of two concurrent calls writes');
 assert.equal(pairs(file2).filter(item=>item.startsWith('letterboxd:')).length,1);assert.equal(revision(file2),1);assert.equal(receipts(file2).length,1);
}

// 4. Dry run writes nothing and reports what a live run would do; a live run does exactly that.
{
 const file=proved(),env=envOf(file),before=dump(file);
 const dry=await applyLetterboxdClaims(env,{event:'cohort:dry',items:[{lid:'AAA1',tmdb:'1'}],dryRun:true,now:()=>T});
 assert.equal(dry.dryRun,true);assert.equal(dry.results[0].state,'would_write');assert.equal(dry.written,0);
 assert.equal(dump(file),before,'a dry run writes nothing');
 const live=await applyLetterboxdClaims(env,{event:'cohort:dry',items:[{lid:'AAA1',tmdb:'1'}],now:()=>T});
 assert.deepEqual([live.written,live.already,live.refused,live.unknown,live.deferred],[1,0,0,0,0]);
 const second=await applyLetterboxdClaims(env,{event:'cohort:dry',items:[{lid:'AAA1',tmdb:'1'}],now:()=>T});
 assert.deepEqual([second.written,second.already],[0,1]);
}

// 5. not_proved and conflict: every refusal names its reason and writes NOTHING (the dump is byte-identical).
const refusal=async(name,setup,input,expectVerdict,expectReason)=>{
 const file=database();setup(file);const env=envOf(file),before=dump(file);
 const plan=await planLetterboxdClaim(env,input);
 assert.deepEqual([plan.verdict,plan.reason],[expectVerdict,expectReason],name);
 const out=await applyLetterboxdClaim(env,{...REQ,...input});
 assert.equal(out.state,'refused',name);assert.equal(out.verdict,expectVerdict,name);
 assert.equal(dump(file),before,name+': nothing written');
};
const I={lid:'AAA1',tmdb:'1'};
await refusal('no Ratings alias',file=>seedFilm(file,1),I,'not_proved','ratings_link_absent');
await refusal('Ratings movie alias absent',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{movie:false});},I,'not_proved','ratings_movie_link_absent');
await refusal('Ratings alias points to another movie',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{lidKey:'tmdb-2'});},I,'conflict','ratings_link_points_elsewhere');
await refusal('Ratings alias is a title-style key',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{lidKey:'lb-AAA1'});},I,'conflict','ratings_link_points_elsewhere');
await refusal('a second lid carries the movie key',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1);seedRatings(file,'BBB1',1);},I,'conflict','ratings_link_ambiguous');
await refusal('no canonical Film',file=>seedRatings(file,'AAA1',1),I,'not_proved','film_absent');
await refusal('Film whose tmdb claim is untrusted',file=>{seedFilm(file,1,{ids:[['tmdb','1',0,0]]});seedRatings(file,'AAA1',1);},I,'conflict','tmdb_claim_not_unique_trusted');
await refusal('Film whose tmdb claim is conflicting',file=>{seedFilm(file,1,{ids:[['tmdb','1',1,1]]});seedRatings(file,'AAA1',1);},I,'conflict','tmdb_claim_not_unique_trusted');
await refusal('movie also claimed (untrusted) by another Film',file=>{seedFilm(file,1);seedFilm(file,2,{ids:[['tmdb','2',1,0],['tmdb','1',0,0]]});seedRatings(file,'AAA1',1);},I,'conflict','tmdb_claim_not_unique_trusted');
await refusal('redirected Film',file=>{seedFilm(file,1);seedFilm(file,9);assert.equal(sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+FID(1)+"','"+FID(9)+"','"+U+"')").status,0);seedRatings(file,'AAA1',1);},I,'conflict','film_redirected');
await refusal('lid trusted on another Film',file=>{seedFilm(file,1);seedFilm(file,2,{ids:[['tmdb','2',1,0],['letterboxd','AAA1',1,0]]});seedRatings(file,'AAA1',1);},I,'conflict','lid_claimed_elsewhere');
await refusal('lid untrusted on another Film',file=>{seedFilm(file,1);seedFilm(file,2,{ids:[['tmdb','2',1,0],['letterboxd','AAA1',0,0]]});seedRatings(file,'AAA1',1);},I,'conflict','lid_claimed_elsewhere');
await refusal('Film holds another lid',file=>{seedFilm(file,1,{ids:[['tmdb','1',1,0],['letterboxd','ZZZ9',1,0]]});seedRatings(file,'AAA1',1);},I,'conflict','film_has_other_lid');
await refusal('Film holds an untrusted claim',file=>{seedFilm(file,1,{ids:[['tmdb','1',1,0],['letterboxd','AAA1',0,0]]});seedRatings(file,'AAA1',1);},I,'conflict','film_has_untrusted_claim');
await refusal('Film holds a second tmdb claim',file=>{seedFilm(file,1,{ids:[['tmdb','1',1,0],['tmdb','5',1,0]]});seedRatings(file,'AAA1',1);},I,'conflict','film_has_other_tmdb_claim');
await refusal('retired movie id',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1);assert.equal(sqlite(file,"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('r1','"+FID(1)+"','retire','AAA1','1','7','{}','{\"by\":\"owner\",\"at\":\""+U+"\",\"source\":\"t\"}','owner_request','{}','"+U+"')").status,0);},I,'conflict','tmdb_retired');
await refusal('ratings domain not authoritative',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1);assert.equal(sqlite(file,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1").status,0);},I,'not_proved','ratings_not_authoritative');
for(const bad of [{lid:'',tmdb:'1'},{lid:'a b',tmdb:'1'},{lid:'tmdb_1',tmdb:'1'},{lid:'AAA1',tmdb:'0'},{lid:'AAA1',tmdb:'x'},{lid:'AAA1'},{tmdb:'1'},{lid:7,tmdb:'1'}])
 await refusal('invalid input '+JSON.stringify(bad),file=>{seedFilm(file,1);seedRatings(file,'AAA1',1);},bad,'not_proved','invalid_input');
// A title, a year or the watchlist flag is never accepted as proof: a Ratings row with watchlist=1 and a Film of the same title but no alias writes nothing.
await refusal('same title is not identity',file=>{seedFilm(file,1);seedFilm(file,2);},{lid:'AAA1',tmdb:'2'},'not_proved','ratings_link_absent');

// 6. Authority: below open and held THROW before any statement that writes (never a verdict, never a fallback).
for(const stage of ['legacy','r2','prepared','held']){
 const file=database(stage),env=envOf(file);
 if(stage!=='legacy')seedFilm(file,1);
 const before=dump(file);
 await assert.rejects(()=>planLetterboxdClaim(env,I),error=>!!error.code,'plan at '+stage);
 await assert.rejects(()=>applyLetterboxdClaim(env,{...REQ,...I}),error=>!!error.code,'apply at '+stage);
 assert.equal(dump(file),before,stage+': nothing written');
}
// A marker that moves between the reads is refused (the generation fence of the plan).
{
 const file=proved();let seen=0;
 const env=envOf(file,{onQuery:async text=>{if(/FROM ratings_view/.test(text)&&++seen===1)assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);}});
 await assert.rejects(()=>planLetterboxdClaim(env,I),error=>error.code==='film_person_generation_moved'||error.code==='film_person_held'||error.code==='film_person_not_open');
}

// 7. The fenced write: a Film whose revision moved between the plan and the batch is refused (CAS), writes no claim and leaves the receipt retryable; a retry then writes it once.
{
 const file=proved();let step=0;
 const moved=envOf(file,{onBatch:async()=>{step++;if(step===1)await mutateFilm(envOf(file),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2,aliases:[{kind:'title',value:'Other'}]}});}});
 await assert.rejects(()=>applyLetterboxdClaim(moved,{...REQ,...I}),code('film_person_revision_conflict'));
 assert.deepEqual(pairs(file),['tmdb:1'],'no claim written by the refused batch');
 const soon=await applyLetterboxdClaim(envOf(file),{...REQ,...I});
 assert.equal(soon.state,'deferred');assert.deepEqual(pairs(file),['tmdb:1'],'a retry inside the backoff window writes nothing');
 const retry=await applyLetterboxdClaim(envOf(file),{...REQ,now:()=>'2026-11-21T10:00:00.000Z',...I});
 assert.equal(retry.state,'written');assert.equal(receipts(file).length,1,'the SAME receipt is retried');assert.equal(pairs(file).filter(item=>item.startsWith('letterboxd:')).length,1);
}
// A competing Film that claims the lid between the plan and the batch: the claim is refused, never overwritten.
{
 const file=proved();seedFilm(file,2);let step=0;
 const racing=envOf(file,{onBatch:async()=>{step++;if(step===1)assert.equal(sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(2)+"','letterboxd','AAA1',1,0,NULL)").status,0);}});
 await assert.rejects(()=>applyLetterboxdClaim(racing,{...REQ,...I}),error=>!!error.code);
 assert.deepEqual(pairs(file),['tmdb:1'],'the racing claim stands, ours is not written');
 assert.deepEqual(pairs(file,2),['letterboxd:AAA1','tmdb:2']);
}

// 8. The cohort batch: bounded, duplicates refused, one refusal never stops another item, results carry a verdict per item.
{
 const file=database();seedFilm(file,1);seedRatings(file,'AAA1',1);seedFilm(file,2);seedRatings(file,'BBB2',2);seedFilm(file,3);seedRatings(file,'CCC3',3,{lidKey:'tmdb-4'});seedFilm(file,5);
 const env=envOf(file);
 const out=await applyLetterboxdClaims(env,{event:'cohort:mixed',items:[{lid:'AAA1',tmdb:'1'},{lid:'CCC3',tmdb:'3'},{lid:'BBB2',tmdb:'2'},{lid:'NOPE',tmdb:'5'}],now:()=>T});
 assert.deepEqual([out.written,out.already,out.refused,out.unknown,out.deferred],[2,0,2,0,0]);
 assert.deepEqual(out.results.map(item=>[item.lid,item.state,item.verdict]),[['AAA1','written','pass'],['CCC3','refused','conflict'],['BBB2','written','pass'],['NOPE','refused','not_proved']]);
 assert.deepEqual(pairs(file,3),['tmdb:3'],'the conflicting item is untouched');assert.deepEqual(pairs(file,5),['tmdb:5']);
 assert.equal(receipts(file).length,2);
 await assert.rejects(()=>applyLetterboxdClaims(env,{event:'cohort:dup',items:[{lid:'AAA1',tmdb:'1'},{lid:'AAA1',tmdb:'1'}]}),code('film_person_invalid'));
 const big=Array.from({length:LETTERBOXD_CLAIM_UNIT_CAP+1},(_,i)=>({lid:'L'+i,tmdb:String(i+1)}));
 await assert.rejects(()=>applyLetterboxdClaims(env,{event:'cohort:big',items:big}),code('film_person_bounded'));
 await assert.rejects(()=>applyLetterboxdClaim(env,{lid:'AAA1',tmdb:'1'}),code('film_person_invalid'),'an event is required');
}

// 9. The `addOnly` mode of the existing unit: it never prunes, and every existing digest is unchanged by its introduction.
{
 const base={id:FID(1),at:T,schemes:['letterboxd'],externalIds:[{scheme:'letterboxd',value:'AAA1',trusted:true}]};
 assert.equal(await filmExternalIdsDigest(base),await filmExternalIdsDigest({...base,addOnly:false}),'addOnly:false is the default and the same digest');
 assert.notEqual(await filmExternalIdsDigest(base),await filmExternalIdsDigest({...base,addOnly:true}),'addOnly is content when true');
 assert.deepEqual(filmExternalIdsContent(base),{schemes:['letterboxd'],externalIds:[{scheme:'letterboxd',value:'AAA1',trusted:true,conflicting:false,provenance:null}]});
 assert.throws(()=>filmExternalIdsContent({...base,addOnly:'yes'}),code('film_person_invalid'));
 const {applyFilmExternalIds}=await load('canonical-film-external-ids-producer.js');
 const file=database();seedFilm(file,1,{ids:[['tmdb','1',1,0],['letterboxd','OLD1',1,0]]});
 const env=envOf(file);
 // Without addOnly the owned scheme is replaced (the stored lid is pruned); with addOnly it is kept next to the new one (the trusted-per-scheme rule then refuses the second trusted value).
 await assert.rejects(()=>applyFilmExternalIds(env,{origin:'x',event:'e',input:{...base,addOnly:true}}),code('identity_collision'));
 assert.deepEqual(pairs(file),['letterboxd:OLD1','tmdb:1'],'addOnly pruned nothing');
 const pruning=await applyFilmExternalIds(env,{origin:'x',event:'e2',input:base,now:()=>T});
 assert.equal(pruning.state,'applied');assert.deepEqual(pairs(file),['letterboxd:AAA1','tmdb:1'],'the existing mode still prunes');
}

// 11. Review findings. (a) The projection is not evidence: after an unlink the link documents drop the lid but `ratings_view` keeps the alias, and nothing is trusted from it.
await refusal('unlinked: index dropped, stale projection kept',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1);const index=getDoc(file,'letterboxd/facts/links.json');delete index['letterboxd:AAA1'];putDoc(file,'letterboxd/facts/links.json',index);},I,'not_proved','ratings_link_absent');
await refusal('unlinked: record no longer carries the lid',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{record:{schemaVersion:1,factKey:'tmdb-1',links:{letterboxd:null,tmdb:'1'},redirectTo:null,migrating:null}});},I,'conflict','ratings_record_disagrees');
await refusal('projection only, no link documents',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{docs:false});},I,'not_proved','ratings_link_absent');
await refusal('record is a redirect',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{record:{schemaVersion:1,factKey:'tmdb-1',links:{letterboxd:'AAA1',tmdb:'1'},redirectTo:'tmdb-9',migrating:null}});},I,'conflict','ratings_record_not_settled');
await refusal('record is mid-migration',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{record:{schemaVersion:1,factKey:'tmdb-1',links:{letterboxd:'AAA1',tmdb:'1'},redirectTo:null,migrating:{to:'x'}}});},I,'conflict','ratings_record_not_settled');
await refusal('record document missing',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1);assert.equal(sqlite(file,"DELETE FROM ratings_document WHERE key='letterboxd/facts/films/tmdb-1.json'").status,0);},I,'not_proved','ratings_record_absent');
// (b) The Film's recorded identity must be this movie: another one would make the reader answer `conflict` after the write.
await refusal('canonical identity of another movie',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1);assert.equal(sqlite(file,"UPDATE film SET canonical_identity='tmdb:77' WHERE id='"+FID(1)+"'").status,0);},I,'conflict','canonical_identity_mismatch');
{ // a null identity is accepted
 const file=database();seedFilm(file,1,{identity:false});seedRatings(file,'AAA1',1);
 assert.equal((await planLetterboxdClaim(envOf(file),I)).verdict,'pass');
}
// (c) Write-time proof: whatever changes between the plan and the batch without moving the Film revision fails the WHOLE fenced batch.
const raced=async(name,change)=>{
 const file=proved();let step=0;
 const env=envOf(file,{onBatch:async()=>{step++;if(step===1)change(file);}});
 let result=null;
 try{result=await applyLetterboxdClaim(env,{...REQ,...I});}catch(error){assert.ok(error.code,name+': a typed failure');}
 assert.ok(!result||result.state!=='written',name+': never reported written');
 assert.ok(!pairs(file).some(item=>item.startsWith('letterboxd:')),name+': no claim written');
 assert.equal(revision(file),0,name+': no revision moved');
};
await raced('ratings domain held after the plan',file=>assert.equal(sqlite(file,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1").status,0));
await raced('ratings generation moved after the plan (alias or record changed)',file=>assert.equal(sqlite(file,"UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1").status,0));
await raced('another Film holds an UNTRUSTED claim of the lid',file=>{seedFilm(file,2);assert.equal(sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(2)+"','letterboxd','AAA1',0,0,NULL)").status,0);});
await raced('the movie is retired after the plan',file=>assert.equal(sqlite(file,"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('r2','"+FID(1)+"','retire','AAA1','1','7','{}','{\"by\":\"owner\",\"at\":\""+U+"\",\"source\":\"t\"}','owner_request','{}','"+U+"')").status,0));
await raced('an untrusted second claim of the movie appears',file=>{seedFilm(file,2);assert.equal(sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(2)+"','tmdb','1',0,0,NULL)").status,0);});
await raced('the Film identity changes to another movie',file=>assert.equal(sqlite(file,"UPDATE film SET canonical_identity='tmdb:77' WHERE id='"+FID(1)+"'").status,0));
// (d) A receipt retry re-plans from the CURRENT stores: a source that no longer proves the claim is never written from a stale proof.
{
 const file=proved();let step=0;
 const moved=envOf(file,{onBatch:async()=>{step++;if(step===1)await mutateFilm(envOf(file),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2,aliases:[{kind:'title',value:'Other'}]}});}});
 await assert.rejects(()=>applyLetterboxdClaim(moved,{...REQ,...I}),code('film_person_revision_conflict'));
 const index=getDoc(file,'letterboxd/facts/links.json');delete index['letterboxd:AAA1'];putDoc(file,'letterboxd/facts/links.json',index);
 const later=await applyLetterboxdClaim(envOf(file),{...REQ,now:()=>'2026-11-21T10:00:00.000Z',...I});
 assert.equal(later.state,'refused');assert.equal(later.reason,'ratings_link_absent');
 assert.deepEqual(pairs(file),['tmdb:1'],'the unlinked lid is not written on retry');
 assert.equal(await replanLetterboxdClaim(envOf(file),{lid:'AAA1',tmdb:'1',filmId:FID(1),now:()=>T}),null,'the re-plan of a receipt retry uses the CURRENT stores');
 const file2=proved();
 const fresh=await replanLetterboxdClaim(envOf(file2),{lid:'AAA1',tmdb:'1',filmId:FID(1),now:()=>T});
 assert.equal(fresh.id,FID(1));assert.equal(fresh.addOnly,true);assert.ok(fresh.guards.length>0);
 assert.equal(await replanLetterboxdClaim(envOf(file2),{lid:'AAA1',tmdb:'1',filmId:FID(2),now:()=>T}),null,'another Film is not the same claim');
}
// (e) An applied receipt is not claim evidence: a lid removed after an earlier run of the SAME event is not reported as a success; a new event writes it.
{
 const file=proved(),env=envOf(file);
 assert.equal((await applyLetterboxdClaim(env,{...REQ,...I})).state,'written');
 assert.equal(sqlite(file,"DELETE FROM film_external_id WHERE film_id='"+FID(1)+"' AND scheme='letterboxd'").status,0);
 const stale=await applyLetterboxdClaim(env,{...REQ,...I});
 assert.equal(stale.state,'unknown');assert.equal(stale.reason,'readback_missing_claim');
 assert.deepEqual(pairs(file),['tmdb:1'],'nothing was restored by the old receipt');
 const fresh=await applyLetterboxdClaim(env,{...REQ,event:'cohort:again',...I});
 assert.equal(fresh.state,'written');assert.deepEqual(pairs(file),['letterboxd:AAA1','tmdb:1']);
}

// 12. Second review. (a) A Diary-first link keeps its `lb-<lid>` key and later gains the movie alias on the SAME key: a valid current link, so the claim is written (the key is never built from the movie id).
{
 const file=database();seedFilm(file,1);seedRatings(file,'AAA1',1,{key:'lb-AAA1'});
 const env=envOf(file);
 const plan=await planLetterboxdClaim(env,I);
 assert.deepEqual([plan.verdict,plan.reason],['pass','proved']);
 assert.equal((await applyLetterboxdClaim(env,{...REQ,...I})).state,'written');
 assert.deepEqual(pairs(file),['letterboxd:AAA1','tmdb:1']);
 assert.equal((await catalogStartedFilm(env,'AAA1')).state,'found');
}
await refusal('Diary-first key but the movie alias is on another key',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{key:'lb-AAA1'});const index=getDoc(file,'letterboxd/facts/links.json');index['tmdb:1']='tmdb-1';putDoc(file,'letterboxd/facts/links.json',index);},I,'conflict','ratings_link_points_elsewhere');
await refusal('malformed link key',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1);const index=getDoc(file,'letterboxd/facts/links.json');index['letterboxd:AAA1']='../x';putDoc(file,'letterboxd/facts/links.json',index);},I,'conflict','ratings_link_malformed');
await refusal('record names another fact key',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{key:'lb-AAA1',record:{schemaVersion:1,factKey:'lb-OTHER',links:{letterboxd:'AAA1',tmdb:'1'},redirectTo:null,migrating:null}});},I,'conflict','ratings_record_disagrees');
// (b) The projection check covers BOTH aliases (a missing row is neither a conflict nor proof).
await refusal('movie projection row carries another key',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1);assert.equal(sqlite(file,"UPDATE ratings_view SET fact_key='tmdb-9' WHERE alias_id='tmdb_1'").status,0);},I,'conflict','ratings_alias_points_elsewhere');
{
 const file=database();seedFilm(file,1);seedRatings(file,'AAA1',1);assert.equal(sqlite(file,"DELETE FROM ratings_view").status,0);
 assert.equal((await planLetterboxdClaim(envOf(file),I)).verdict,'pass','a missing projection is not a conflict (the link documents prove)');
}
// Section 'projection index 0055' (AIR-653): the planner's projection statement (`alias_id=? OR alias_id=? OR fact_key=?`) was a table scan and is index-served once migration 0055 is applied.
// The verdicts must be identical on the chain without and with the index, for each projection conflict the statement exists to find.
for(const [name,source] of [['without 0055',template54],['with 0055',template]]){
 for(const [what,mutate,reason] of [
  ['the lid alias row carries another key',file=>assert.equal(sqlite(file,"UPDATE ratings_view SET fact_key='tmdb-2000' WHERE alias_id='AAA1'").status,0),'ratings_alias_points_elsewhere'],
  ['the movie alias row carries another key',file=>assert.equal(sqlite(file,"UPDATE ratings_view SET fact_key='tmdb-2000' WHERE alias_id='tmdb_1'").status,0),'ratings_alias_points_elsewhere'],
  ['a rival (third) alias shares the fact key',file=>assert.equal(sqlite(file,"INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('RIVAL','tmdb-1',NULL,NULL,0,0,'"+U+"')").status,0),'ratings_alias_ambiguous'],
 ]){
  const file=database('open',source);seedFilm(file,1);seedRatings(file,'AAA1',1);mutate(file);
  const env=envOf(file),before=dump(file),plan=await planLetterboxdClaim(env,I);
  assert.deepEqual([plan.verdict,plan.reason],['conflict',reason],name+': '+what);
  assert.equal((await applyLetterboxdClaim(env,{...REQ,...I})).state,'refused',name+': '+what+' is refused');
  assert.equal(dump(file),before,name+': '+what+': nothing written');
 }
 {
  const file=database('open',source);seedFilm(file,1);seedRatings(file,'AAA1',1);
  assert.deepEqual([(await planLetterboxdClaim(envOf(file),I)).verdict,(await planLetterboxdClaim(envOf(file),I)).reason],['pass','proved'],name+': the unconflicted pair still passes');
 }
}
// (c) The write-time guard asserts that the target Film STILL owns exactly one trusted tmdb claim for the movie.
await raced('the Film loses its trusted tmdb claim after the plan',file=>assert.equal(sqlite(file,"DELETE FROM film_external_id WHERE film_id='"+FID(1)+"' AND scheme='tmdb'").status,0));
await raced('the Film gains a second trusted tmdb value after the plan',file=>assert.equal(sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(1)+"','tmdb','5',1,0,NULL)").status,0));
await raced('the Film trusted tmdb claim is downgraded after the plan',file=>assert.equal(sqlite(file,"UPDATE film_external_id SET trusted=0 WHERE film_id='"+FID(1)+"' AND scheme='tmdb'").status,0));

// 14. AIR-559: an INFERRED link (ADR 0104, a unique original title and year in a personal export) is not proof of the lid, whatever flow offers it. The fact record that first received the lid from that import carries
// `identity`; the planner refuses it before any write and a Diary-first or verified key does not help. Any other recorded identity fails closed. An already stored claim on such a link is NOT `already` (no full proof).
const INFERRED={kind:'inferred',basis:'original_title_exact_year_unique',sourceRef:'a'.repeat(64)};
await refusal('inferred link (title/year match)',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{record:{schemaVersion:1,factKey:'tmdb-1',links:{letterboxd:'AAA1',tmdb:'1'},identity:INFERRED,redirectTo:null,migrating:null}});},I,'not_proved','ratings_link_inferred');
await refusal('inferred link on a Diary-first key',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{key:'lb-AAA1',record:{schemaVersion:1,factKey:'lb-AAA1',links:{letterboxd:'AAA1',tmdb:'1'},identity:INFERRED,redirectTo:null,migrating:null}});},I,'not_proved','ratings_link_inferred');
await refusal('unknown recorded identity kind',file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{record:{schemaVersion:1,factKey:'tmdb-1',links:{letterboxd:'AAA1',tmdb:'1'},identity:{kind:'guessed'},redirectTo:null,migrating:null}});},I,'not_proved','ratings_link_unverified');
{
 const file=database();seedFilm(file,1,{ids:[['tmdb','1',1,0],['letterboxd','AAA1',1,0]]});
 seedRatings(file,'AAA1',1,{record:{schemaVersion:1,factKey:'tmdb-1',links:{letterboxd:'AAA1',tmdb:'1'},identity:INFERRED,redirectTo:null,migrating:null}});
 const env=envOf(file),before=dump(file);
 const plan=await planLetterboxdClaim(env,I);
 assert.deepEqual([plan.verdict,plan.reason],['not_proved','ratings_link_inferred'],'a stored claim on an inferred link is not declared already');
 const out=await ensureLetterboxdClaims(env,{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:true,now:()=>T});
 assert.deepEqual([out.state,out.written,out.already,out.refused],['incomplete',0,0,1]);assert.equal(out.results[0].reason,'ratings_link_inferred');
 assert.equal(dump(file),before,'nothing is written, nothing removed: the stored claim is left for a case-by-case owner decision (ADR 0192)');
}
// The PAIR marks (AIR-559, `inferredPairs`, append-only, written and read back by the import before the alias): an entry naming this pair is refused, among others too; an unreadable list or entry fails
// closed; entries naming only other pairs (attempts that conflicted) do not block this one.
const PAIR=(lid,tmdb)=>({kind:'inferred',basis:'original_title_exact_year_unique',sourceRef:'a'.repeat(64),letterboxd:lid,tmdb});
const withPairs=pairs=>file=>{seedFilm(file,1);seedRatings(file,'AAA1',1,{key:'lb-AAA1',record:{schemaVersion:1,factKey:'lb-AAA1',links:{letterboxd:'AAA1',tmdb:'1'},inferredPairs:pairs,redirectTo:null,migrating:null}});};
await refusal('pair entry naming this pair (Diary-first record)',withPairs([PAIR('AAA1','1')]),I,'not_proved','ratings_link_inferred');
await refusal('entry naming this pair after an entry of a failed earlier pair',withPairs([PAIR('AAA1','7'),PAIR('AAA1','1')]),I,'not_proved','ratings_link_inferred');
await refusal('pair entry of an unknown kind naming this pair',withPairs([{...PAIR('AAA1','1'),kind:'guessed'}]),I,'not_proved','ratings_link_unverified');
for(const bad of ['inferred',{kind:'inferred'},[{kind:'inferred'}],[PAIR('AAA1','7'),'x'],[{kind:'inferred',letterboxd:'AAA1'}]])await refusal('unreadable pair marks '+JSON.stringify(bad),withPairs(bad),I,'not_proved','ratings_link_unverified');
{
 const file=database();withPairs([PAIR('AAA1','2'),PAIR('ZZZ9','1')])(file);
 assert.deepEqual((({verdict,reason})=>[verdict,reason])(await planLetterboxdClaim(envOf(file),I)),['pass','proved'],'entries naming only other pairs do not block this one');
}
// The inferred mark is part of the fact record, covered by the ratings generation: one that APPEARS between the plan and the batch moves the generation and fails the whole fenced batch.
await raced('the record becomes an inferred link after the plan',file=>{const record=getDoc(file,'letterboxd/facts/films/tmdb-1.json');record.identity=INFERRED;putDoc(file,'letterboxd/facts/films/tmdb-1.json',record);assert.equal(sqlite(file,"UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1").status,0);});
// A verified link whose canonical Film arrives LATER (another writer admits it): `film_absent` first, then a later offer of the same flow (the Diary `claim_pending` retry, an owner replay of the chunk) passes once the Film owns the movie, and only then.
{
 const file=database();seedRatings(file,'AAA1',1);const env=envOf(file);
 assert.deepEqual((({verdict,reason})=>[verdict,reason])(await planLetterboxdClaim(env,I)),['not_proved','film_absent']);
 const early=await ensureLetterboxdClaims(env,{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:true,now:()=>T});
 assert.deepEqual([early.written,early.refused],[0,1]);assert.equal(rows(file,"SELECT COUNT(*) AS c FROM film_external_id")[0].c,0,'no Film, no claim, nothing created');
 seedFilm(file,1);
 const later=await ensureLetterboxdClaims(env,{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:true,now:()=>T});
 assert.deepEqual([later.state,later.written],['complete',1]);assert.deepEqual(pairs(file),['letterboxd:AAA1','tmdb:1']);
 assert.equal(rows(file,"SELECT COUNT(*) AS c FROM film")[0].c,1,'the claim never creates a Film');
}

// 13. Producer wiring (ADR 0184 decision 5): the gate is off in code, `ensureLetterboxdClaims` writes nothing until it is on, never throws into a flow, is bounded and idempotent.
// ACTIVATION DIFF (runbook activation plan): the activation PR changes this one assertion together with the constant and the literal check in
// tests/canonical-film-external-ids-producer.mjs. Everything else in this file follows the constant or passes `enabled` explicitly.
assert.equal(LETTERBOXD_CLAIM_ACTIVATED,true,'the activation constant ships on');
{
 // The default gate follows the shipped constant: off, the default call writes nothing; on, the default call is the active producer (covered with `enabled:true`
 // below and end to end in tests/letterboxd-claim-activation-rehearsal.mjs). The explicit `enabled:false` stays inactive whatever the constant says.
 const gateFile=proved(),gateEnv=envOf(gateFile),gateBefore=dump(gateFile);
 const byDefault=await ensureLetterboxdClaims(gateEnv,{pairs:[{lid:'AAA1',tmdb:'1'}],now:()=>T});
 if(LETTERBOXD_CLAIM_ACTIVATED){assert.deepEqual([byDefault.state,byDefault.written],['complete',1],'gate on: the default call claims');}
 else{assert.equal(byDefault.state,'inactive');assert.equal(dump(gateFile),gateBefore,'gate off: the default call writes not one statement');}
}
{
 const file=proved(),env=envOf(file),before=dump(file);
 const offExplicit=await ensureLetterboxdClaims(env,{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:false});assert.equal(offExplicit.state,'inactive');
 assert.equal(dump(file),before,'explicitly disabled: not one statement writes');
 const on=await ensureLetterboxdClaims(env,{pairs:[{lid:'AAA1',tmdb:'1'},{lid:'AAA1',tmdb:'1'},{lid:'tmdb_1',tmdb:'1'},{lid:'bad id',tmdb:'1'},{lid:'ZZZ',tmdb:'x'},null],enabled:true,now:()=>T});
 assert.deepEqual([on.state,on.requested,on.written,on.already,on.refused],['complete',1,1,0,0],'duplicates and malformed pairs are dropped');
 assert.deepEqual(pairs(file),['letterboxd:AAA1','tmdb:1']);
 const again=await ensureLetterboxdClaims(env,{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:true,now:()=>T});
 assert.deepEqual([again.state,again.written,again.already],['complete',0,1]);
 assert.equal(receipts(file).length,1,'a repeat adds no receipt');assert.equal(revision(file),1,'a repeat adds no revision');
}
// A refusal is reported honestly and never turns into a trusted claim; the flow is not failed.
{
 const file=database();seedFilm(file,1);seedRatings(file,'AAA1',1,{lidKey:'tmdb-9'});seedFilm(file,2);seedRatings(file,'BBB2',2);
 const out=await ensureLetterboxdClaims(envOf(file),{pairs:[{lid:'AAA1',tmdb:'1'},{lid:'BBB2',tmdb:'2'}],enabled:true,now:()=>T});
 assert.deepEqual([out.state,out.written,out.refused],['incomplete',1,1]);
 assert.deepEqual(pairs(file),['tmdb:1'],'the unproven pair writes nothing');assert.deepEqual(pairs(file,2),['letterboxd:BBB2','tmdb:2']);
}
// Bounded: at most LETTERBOXD_CLAIM_UNIT_CAP full proofs per call, unclaimed lids first (one batched ordering read, never evidence); the rest is `overflow`; a held lid is NOT declared `already` without the full proof.
{
 const file=database();const all=[];
 for(let k=1;k<=LETTERBOXD_CLAIM_UNIT_CAP+2;k++){seedFilm(file,k);seedRatings(file,'L'+k,k);all.push({lid:'L'+k,tmdb:String(k)});}
 const env=envOf(file);
 const first=await ensureLetterboxdClaims(env,{pairs:all,enabled:true,now:()=>T});
 assert.deepEqual([first.state,first.written,first.overflow],['incomplete',LETTERBOXD_CLAIM_UNIT_CAP,2]);
 assert.deepEqual(first.unattempted.sort(),['L'+(LETTERBOXD_CLAIM_UNIT_CAP+1),'L'+(LETTERBOXD_CLAIM_UNIT_CAP+2)].sort(),'the not-attempted unclaimed lids are listed for a caller that keeps a retry state');
 const second=await ensureLetterboxdClaims(env,{pairs:all,enabled:true,now:()=>T});
 assert.deepEqual([second.written,second.already,second.overflow,second.unattempted.length],[2,LETTERBOXD_CLAIM_UNIT_CAP-2,2,0],'unclaimed first, then proofs of held lids up to the cap; a held lid that did not fit needs nothing and is not listed');
 assert.ok(second.results.filter(result=>result.state==='already').every(result=>result.verdict==='pass'&&result.reason==='already'),'`already` comes from the full read-only proof');
 assert.equal(receipts(file).length,LETTERBOXD_CLAIM_UNIT_CAP+2);
}
// A still-trusted claim is NOT `already` when its proof is gone: a removed Ratings link, a competing claim or a retirement is reported `refused`, never success.
{
 const file=proved(),env=envOf(file);
 assert.equal((await ensureLetterboxdClaims(env,{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:true,now:()=>T})).written,1);
 const index=getDoc(file,'letterboxd/facts/links.json');delete index['letterboxd:AAA1'];putDoc(file,'letterboxd/facts/links.json',index);
 const stale=await ensureLetterboxdClaims(env,{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:true,now:()=>T});
 assert.deepEqual([stale.already,stale.refused,stale.state],[0,1,'incomplete']);assert.equal(stale.results[0].reason,'ratings_link_absent');
 const file2=proved(),env2=envOf(file2);
 await ensureLetterboxdClaims(env2,{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:true,now:()=>T});
 seedFilm(file2,2);assert.equal(sqlite(file2,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(2)+"','letterboxd','AAA1',0,0,NULL)").status,0);
 const competing=await ensureLetterboxdClaims(env2,{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:true,now:()=>T});
 assert.deepEqual([competing.already,competing.refused],[0,1]);assert.equal(competing.results[0].reason,'lid_claimed_elsewhere');
}
// The D1 read budget of a call does not grow with the input: a large offer costs the same number of statements as one of the cap (one ordering read, then at most the cap of full proofs), and the cutoff is reported as overflow.
{
 const count=async size=>{
  const file=database();let queries=0;
  const env=envOf(file,{onQuery:async()=>{queries++;}});
  const offer=Array.from({length:size},(_,i)=>({lid:'Z'+i,tmdb:String(1000+i)}));
  const out=await ensureLetterboxdClaims(env,{pairs:offer,enabled:true,now:()=>T});
  return {queries,out};
 };
 const small=await count(LETTERBOXD_CLAIM_UNIT_CAP),large=await count(LETTERBOXD_CLAIM_OFFER_MAX+50);
 assert.equal(large.queries,small.queries,'statements do not grow with the offer');
 assert.equal(large.out.requested,LETTERBOXD_CLAIM_OFFER_MAX+50);assert.equal(large.out.overflow,LETTERBOXD_CLAIM_OFFER_MAX+50-LETTERBOXD_CLAIM_UNIT_CAP,'every cut-off pair is overflow');
 assert.equal(large.out.unattempted.length,large.out.overflow,'and listed, none processed silently');assert.equal(large.out.results.length,LETTERBOXD_CLAIM_UNIT_CAP);
}
// A held or unreadable authority never throws into the flow: nothing is written, the pair is reported `failed`, and the next ordinary run offers it again.
{
 const file=database('held');seedFilm(file,1);seedRatings(file,'AAA1',1);const before=dump(file);
 const out=await ensureLetterboxdClaims(envOf(file),{pairs:[{lid:'AAA1',tmdb:'1'}],enabled:true,now:()=>T});
 assert.deepEqual([out.state,out.failed,out.written],['incomplete',1,0]);assert.equal(dump(file),before);
}
// Static: the flows reach the claim only through the guarded global, after their durable steps, inside a try. The rated-candidate path is deliberately NOT wired: its rating link carries no `letterboxd:<code>`
// alias, its short code is never a lid, and it refuses a movie that is already linked to a lid (`tmdb_already_imported`), so it never holds a provable pair (tests/letterboxd-rated-candidates.mjs, AIR-559).
{
 const diary=fs.readFileSync(path.join(SRC,'letterboxd-diary-identity.js'),'utf8'),facts=fs.readFileSync(path.join(SRC,'letterboxd-facts.js'),'utf8'),rated=fs.readFileSync(path.join(SRC,'letterboxd-rated-candidates.js'),'utf8');
 for(const text of [diary,facts])assert.ok(/typeof CanonicalLetterboxdClaim[!=]=='undefined'/.test(text),'guarded by typeof');
 assert.ok(diary.indexOf('updateDiaryIdentity(env,{set,clear')<diary.indexOf('ensureLetterboxdClaims'),'Diary: the claim step follows the durable pending document');
 assert.ok(facts.indexOf('await projectRecords(env,records);')<facts.indexOf('await ensureChunkClaims(env,items,films);'),'import: the claim step follows the facts, the link and the read-back');
 assert.ok(facts.indexOf("importKey(sha,chunk,'receipt'),null,current=>current?null:next")<facts.indexOf('await ensureChunkClaims(env,items,films);'),'import: the claim step follows the committed chunk receipt');
 assert.ok(!/CanonicalLetterboxdClaim|ensureLetterboxdClaims/.test(rated),'rated candidates are not wired');
}

// 10. Dormancy: the Worker bundle does not import the module yet (producer activation is separate from the accepted ADR).
{
 const worker=fs.readFileSync(path.join(SRC,'worker.js'),'utf8');
 assert.ok(!/canonical-letterboxd-claim/.test(worker),'src/worker.js does not import the claim module');
 // The owner-only backfill operator (tests/letterboxd-claim-backfill.mjs) is the ONLY module that imports the claim module; no other module reaches it by path.
 for(const file of fs.readdirSync(SRC).filter(name=>name.endsWith('.js')&&name!=='canonical-letterboxd-claim.js'&&name!=='letterboxd-claim-backfill.js'))assert.ok(!/canonical-letterboxd-claim/.test(fs.readFileSync(path.join(SRC,file),'utf8')),file+' does not import the claim module');
}
console.log('canonical letterboxd claim: ok');
