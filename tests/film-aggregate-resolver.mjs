// AIR-646 / ADR 0216 decisions 2-4 and 7: the dormant typed Film resolver with the coherent identity read-set and the reserved final fence.
// Synthetic fixtures only, on the sqlite3-CLI D1 stand-in over the full migration chain. ADR 0216 synthetic tests 5, 5a, 6, 7, 8 and 15a, plus direct
// canonical ids, redirects and cycles, retired movie vs TV, conflicting and untrusted claims, absence, fan-out, changes between reads, and no writes,
// no R2 and no network. Nothing here touches the Worker or production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {
 parseTypedFilmId,resolveFilmIdentity,fenceFilmIdentity,readFilmAggregateIdentity,createStatementBudget,IDENTITY_SNAPSHOT_SQL,
 IDENTITY_MAX_REDIRECT_HOPS,IDENTITY_MAX_FILMS,IDENTITY_MAX_CLAIM_ROWS,AUTHORIZED_ALIASES_PER_SCHEME,REQUEST_STATEMENT_BUDGET,
} from '../src/film-aggregate-resolver.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-aggregate-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1";
const schema=path.join(root,'schema.sqlite');
sqlite(schema,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
sqlite(schema,OPEN);
let n=0;
function database(){const file=path.join(root,'f-'+(n++)+'.sqlite');fs.copyFileSync(schema,file);return file;}
const AT='2026-11-25T10:00:00.000Z';
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";
function film(file,id,claims=[]){
 sqlite(file,`INSERT INTO film (id,contract_version,updated_at) VALUES (${q(id)},1,${q(AT)});INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',${q(id)},1,${q(AT)});`
  +claims.map(([scheme,value,trusted=1,conflicting=0])=>`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES (${q(id)},${q(scheme)},${q(value)},${trusted},${conflicting});`).join(''));
}
const claim=(file,id,scheme,value,trusted=1,conflicting=0)=>sqlite(file,`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES (${q(id)},${q(scheme)},${q(value)},${trusted},${conflicting})`);
const redirect=(file,from,to)=>sqlite(file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES (${q(from)},${q(to)},${q(AT)})`);
const CONFIRM=q(JSON.stringify({by:'owner',at:AT,source:'synthetic'}));
let request=0;
const retire=(file,filmId,movie,tv,lid='lid1')=>sqlite(file,`INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('r${request++}',${q(filmId)},'retire',${q(lid)},${q(movie)},${q(tv)},'{}',${CONFIRM},'owner_request','{}',${q(AT)})`);
const restore=(file,filmId,movie,tv,seq,lid='lid1')=>sqlite(file,`INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,supersedes_seq,payload_json,recorded_at) VALUES ('r${request++}',${q(filmId)},'restore',${q(lid)},${q(movie)},${q(tv)},'{}',${CONFIRM},'owner_request',${seq},'{}',${q(AT)})`);
const bump=(file,id)=>sqlite(file,`UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id=${q(id)}`);
const noR2=new Proxy({},{get(){throw new Error('R2 must not be touched');}});
const env=(file,options)=>{const DB=d1Standin(file,options);return {DB,R2:noR2,calls:DB.calls};};
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// No network: any fetch during this file fails the test.
globalThis.fetch=()=>{throw new Error('network must not be touched');};
const resolve=(file,id,options)=>resolveFilmIdentity(env(file,options),id);
const verdict=async(file,id)=>{const r=await resolve(file,id);return [r.verdict,r.reason??null,r.http];};

// Decision 2 / test 7: the typed grammar. tmdb_ is checked first; a lid that looks like tmdb_<n> is a movie id; anything else under tmdb_ is invalid.
{
 assert.deepEqual(parseTypedFilmId('tmdb_41009'),{scheme:'tmdb_movie',value:'41009'});
 assert.deepEqual(parseTypedFilmId('tmdb_tv:123'),{scheme:'tmdb_tv',value:'123'});
 assert.deepEqual(parseTypedFilmId('film:tmdb:41009'),{scheme:'film',value:'film:tmdb:41009'});
 assert.deepEqual(parseTypedFilmId('10oS'),{scheme:'letterboxd_lid',value:'10oS'});
 assert.deepEqual(parseTypedFilmId('tmdb_999999999999'),{scheme:'tmdb_movie',value:'999999999999'});
 for(const bad of ['tmdb_0','tmdb_01','tmdb_1234567890123','tmdb_x','tmdb_tv:0','tmdb_tv:','tmdb_tv:12a','tmdb:12','tmdb_tv_12','film:','film:a b','','a'.repeat(81),'the-matrix?','Some Title',null,undefined,12,{scheme:'film'},'letterboxd_slug:example-film'])
  assert.throws(()=>parseTypedFilmId(bad),error=>error.code==='invalid',String(bad));
 const file=database();
 for(const bad of ['tmdb_0','tmdb_x','tmdb_tv:0','film:','Some Title'])assert.deepEqual(await verdict(file,bad),['invalid','not_a_typed_id',400],bad);
 // A letterboxd_slug value is not an input scheme: a slug that is a valid lid spelling is looked up as a lid only, and a slug claim never answers it.
 film(file,'film:tmdb:5',[['tmdb','5'],['letterboxd_slug','example-film',0]]);
 assert.deepEqual(await verdict(file,'example-film'),['absent',null,404],'a slug value is never resolved through letterboxd_slug');
}

// Test 5a: the canonical id. found with no external row; redirected for a merged Film; absent only when neither row exists, whatever film_external_id holds.
{
 const file=database();
 film(file,'film:local:1');
 const found=await resolve(file,'film:local:1');
 assert.equal(found.verdict,'found');assert.equal(found.filmId,'film:local:1');assert.deepEqual(found.claims,[]);assert.equal(found.permalink,null);
 assert.deepEqual(found.redirectedFrom,[]);
 film(file,'film:tmdb:7',[['tmdb','7'],['letterboxd','lid7']]);
 film(file,'film:merged:7');redirect(file,'film:merged:7','film:tmdb:7');
 const merged=await resolve(file,'film:merged:7');
 assert.deepEqual([merged.verdict,merged.filmId,merged.redirectedFrom,merged.permalink],['redirected','film:tmdb:7',['film:merged:7'],'/film/tmdb_7']);
 assert.deepEqual(await verdict(file,'film:none:1'),['absent',null,404]);
 // A claim row naming the requested value as a VALUE does not make a film: id exist: absent is decided by the film and redirect rows only.
 claim(file,'film:tmdb:7','legacy_id','film:ghost:1',0);
 assert.deepEqual(await verdict(file,'film:ghost:1'),['absent',null,404]);
 // A redirect row whose source Film row is gone still resolves (step 0 reads the film row OR the redirect row).
 sqlite(file,"PRAGMA foreign_keys=OFF;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:gone:1','film:tmdb:7','"+AT+"')");
 assert.equal((await resolve(file,'film:gone:1')).verdict,'redirected');
 // A film: request whose survivor holds an unsettled claim on a section scheme is a conflict, with no section.
 film(file,'film:local:2',[['letterboxd','dupe',0]]);
 assert.deepEqual(await verdict(file,'film:local:2'),['conflict','unsettled_claim',409]);
}

// Test 5: the corrected TV Films: tmdb_tv identity + retired movie claim + verified lid on one Film. tmdb_tv:<n> and the lid are found; tmdb_<n> of the
// retired id is retired; the movie claim is excluded from the alias sets; equal movie and TV numbers never read each other's keys.
{
 const file=database();
 // Two TV Films: one whose retired movie id equals its TV number (123), one with a different movie id (900 vs 456).
 film(file,'film:tmdb:123',[['tmdb','123'],['tmdb_tv','123'],['letterboxd','tvA']]);retire(file,'film:tmdb:123','123','123','tvA');
 film(file,'film:tmdb:900',[['tmdb','900'],['tmdb_tv','456'],['letterboxd','tvB']]);retire(file,'film:tmdb:900','900','456','tvB');
 // A distinct movie Film whose movie number equals the second TV number: TV 456 never reads movie 456, and the reverse.
 film(file,'film:tmdb:456',[['tmdb','456'],['letterboxd','mv456']]);
 for(const [id,survivor,lid] of [['tmdb_tv:123','film:tmdb:123','tvA'],['tvA','film:tmdb:123','tvA'],['tmdb_tv:456','film:tmdb:900','tvB'],['tvB','film:tmdb:900','tvB']]){
  const r=await resolve(file,id);
  assert.deepEqual([r.verdict,r.filmId],['found',survivor],id);
  assert.deepEqual(r.authorized.tmdb_movie,[],id+': the retired movie claim is in no alias set');
  assert.deepEqual(r.authorized.letterboxd_lid,[lid]);
  assert.ok(r.claims.some(c=>c.scheme==='tmdb'&&c.retired===true),id+': reported as retired evidence');
  assert.equal(r.permalink,'/film/'+lid,'no tmdb_<n> permalink for a retired movie claim');
  // The ledger is read by every claimed movie id of the survivor (here its retired movie claim), never by a TV number.
  assert.deepEqual(r.fence.keys.movies,[survivor.slice('film:tmdb:'.length)],id+': the ledger is read by the claimed movie id only');
 }
 assert.deepEqual((await resolve(file,'tmdb_tv:123')).authorized.tmdb_tv,['123']);
 assert.deepEqual(await verdict(file,'tmdb_123'),['retired','tmdb_retired',410]);
 assert.deepEqual(await verdict(file,'tmdb_900'),['retired','tmdb_retired',410]);
 const movie=await resolve(file,'tmdb_456');
 assert.deepEqual([movie.verdict,movie.filmId,movie.authorized.tmdb_movie,movie.authorized.tmdb_tv],['found','film:tmdb:456',['456'],[]]);
 assert.ok(!movie.fence.keys.pairs.includes(JSON.stringify(['tmdb_tv','456'])),'a movie request never queries the TV pair of the same number');
 assert.ok(!(await resolve(file,'tmdb_tv:456')).fence.keys.pairs.includes(JSON.stringify(['tmdb','456'])),'a TV request never queries the movie pair of the same number');
 assert.deepEqual(await verdict(file,'tmdb_tv:999'),['absent',null,404]);
 // A restore that supersedes the retirement returns the movie claim to its alias set.
 const seq=rows(file,"SELECT seq FROM tmdb_retirement_decision WHERE film_id='film:tmdb:900'")[0].seq;
 restore(file,'film:tmdb:900','900','456',seq,'tvB');
 const restored=await resolve(file,'tmdb_900');
 assert.deepEqual([restored.verdict,restored.authorized.tmdb_movie],['found',['900']]);
 // A settled retirement never vetoes the Film even when another Film now holds an untrusted claim of the retired value.
 const other=database();
 film(other,'film:tmdb:321',[['tmdb','321'],['tmdb_tv','321'],['letterboxd','tvC']]);retire(other,'film:tmdb:321','321','321','tvC');
 film(other,'film:x:1',[['tmdb','321',0]]);
 assert.equal((await resolve(other,'tvC')).verdict,'found','a retired claim is removed before conflict evaluation');
}

// Test 6: merge redirected, retirement 410, competing owner 409 conflict, untrusted only 409 unverified, redirect cycle 409 cycle.
{
 const file=database();
 film(file,'film:tmdb:10',[['tmdb','10'],['letterboxd','l10']]);
 film(file,'film:old:10',[['letterboxd','old10']]);redirect(file,'film:old:10','film:tmdb:10');
 const r=await resolve(file,'old10');
 assert.deepEqual([r.verdict,r.filmId,r.redirectedFrom],['redirected','film:tmdb:10',['film:old:10']],'an external claim of a merged Film reaches the survivor');
 // Competing trusted owner on the requested value (one trusted, one conflicting row on another Film).
 film(file,'film:a:1',[['letterboxd','shared']]);film(file,'film:b:1',[['letterboxd','shared',1,1]]);
 assert.deepEqual(await verdict(file,'shared'),['conflict','competing_owner',409]);
 // An untrusted row of another Film next to the owner's trusted row is still competing.
 film(file,'film:a:2',[['letterboxd','half']]);film(file,'film:b:2',[['letterboxd','half',0]]);
 assert.deepEqual(await verdict(file,'half'),['conflict','competing_owner',409]);
 // Only conflicting rows: conflict. Only untrusted rows: unverified.
 film(file,'film:c:1',[['letterboxd','onlyconf',1,1]]);
 assert.deepEqual(await verdict(file,'onlyconf'),['conflict','competing_owner',409]);
 film(file,'film:d:1',[['tmdb','77',0]]);film(file,'film:d:2',[['tmdb','77',0]]);
 assert.deepEqual(await verdict(file,'tmdb_77'),['unverified','untrusted_only',409]);
 // The survivor holds a second trusted value of a section scheme that another Film also claims: competing, not found.
 film(file,'film:e:1',[['letterboxd','e1'],['tmdb','55']]);film(file,'film:e:2',[['tmdb','55',0]]);
 assert.deepEqual(await verdict(file,'e1'),['conflict','competing_owner',409]);
 // An unsettled claim on a scheme no section reads is reported and does not fail.
 film(file,'film:f:1',[['letterboxd','f1'],['letterboxd_slug','some-slug',0,1]]);
 const f=await resolve(file,'f1');
 assert.equal(f.verdict,'found');assert.ok(f.claims.some(c=>c.scheme==='letterboxd_slug'&&c.conflicting));
 // Retirement of the requested movie: 410, whatever claims exist.
 film(file,'film:tmdb:66',[['tmdb','66'],['tmdb_tv','6600'],['letterboxd','l66']]);retire(file,'film:tmdb:66','66','6600','l66');
 assert.deepEqual(await verdict(file,'tmdb_66'),['retired','tmdb_retired',410]);
 // Redirect cycle and redirect depth.
 const cyc=database();
 film(cyc,'film:c:a');film(cyc,'film:c:b');film(cyc,'film:c:c',[['letterboxd','cyc']]);
 sqlite(cyc,"INSERT INTO film_redirect VALUES ('film:c:c','film:c:a','"+AT+"');INSERT INTO film_redirect VALUES ('film:c:a','film:c:b','"+AT+"');INSERT INTO film_redirect VALUES ('film:c:b','film:c:a','"+AT+"')");
 assert.deepEqual(await verdict(cyc,'cyc'),['cycle','redirect_cycle',409]);
 assert.deepEqual(await verdict(cyc,'film:c:a'),['cycle','redirect_cycle',409]);
 const self=database();film(self,'film:s:1');redirect(self,'film:s:1','film:s:1');
 assert.deepEqual(await verdict(self,'film:s:1'),['cycle','redirect_cycle',409]);
 const deep=database(),ids=Array.from({length:IDENTITY_MAX_REDIRECT_HOPS+2},(_,i)=>'film:h:'+i);
 for(const id of ids)film(deep,id);
 for(let i=0;i<ids.length-1;i++)redirect(deep,ids[i],ids[i+1]);
 assert.deepEqual(await verdict(deep,ids[0]),['cycle','identity_fanout',409],'more than 8 hops');
 const ok=await resolve(deep,ids[1]);
 assert.deepEqual([ok.verdict,ok.redirectedFrom.length,ok.filmId],['redirected',IDENTITY_MAX_REDIRECT_HOPS,ids.at(-1)],'exactly 8 hops resolve');
}

// Fan-out (decision 7): Films met, claim rows, and authorized aliases per scheme.
{
 const many=database();
 const lids=Array.from({length:AUTHORIZED_ALIASES_PER_SCHEME+2},(_,i)=>'m'+i);
 film(many,'film:many:1',[['tmdb','501'],...lids.map(l=>['letterboxd',l])]);
 const r=await resolve(many,'tmdb_501');
 assert.equal(r.verdict,'found');assert.deepEqual(r.aliasOverflow,['letterboxd_lid']);assert.equal(r.authorized.letterboxd_lid.length,AUTHORIZED_ALIASES_PER_SCHEME);
 const wide=database();
 film(wide,'film:w:0',Array.from({length:IDENTITY_MAX_CLAIM_ROWS},(_,i)=>['note','v'+i,0]).concat([['letterboxd','w0']]));
 assert.deepEqual(await verdict(wide,'w0'),['conflict','identity_fanout',409],'65 distinct claim rows');
 // Exactly 64 distinct claim rows pass: a survivor row read both by Film and by pair counts once.
 const exact=database();
 film(exact,'film:x:0',Array.from({length:IDENTITY_MAX_CLAIM_ROWS-1},(_,i)=>['note','v'+i,0]).concat([['letterboxd','x0']]));
 assert.equal((await resolve(exact,'x0')).verdict,'found','64 distinct claim rows');
 const half=database();
 film(half,'film:y:0',Array.from({length:33},(_,i)=>['letterboxd','y'+i]));
 assert.equal((await resolve(half,'y0')).verdict,'found','33 claims are 33 rows, not 66');
 // A wide redirect ancestor: its claims are read and digested, so they count.
 const ancestor=database();
 film(ancestor,'film:z:1',[['letterboxd','z1']]);film(ancestor,'film:z:old',Array.from({length:IDENTITY_MAX_CLAIM_ROWS+10},(_,i)=>['note','a'+i,0]));
 redirect(ancestor,'film:z:old','film:z:1');
 assert.deepEqual(await verdict(ancestor,'film:z:old'),['conflict','identity_fanout',409],'a wide ancestor');
 // Many untrusted rows on the requested key: fan-out, decided before the unverified verdict, from a bounded read.
 const untrusted=database();
 for(let i=0;i<IDENTITY_MAX_CLAIM_ROWS+5;i++)sqlite(untrusted,`INSERT INTO film (id,contract_version,updated_at) VALUES ('film:u:${i}',1,'${AT}');INSERT INTO canonical_revision VALUES ('film','film:u:${i}',1,'${AT}');INSERT INTO film_external_id VALUES ('film:u:${i}','letterboxd','crowd',0,0,NULL)`);
 const seen=[];
 const u=await resolveFilmIdentity(env(untrusted,{onQuery:text=>{seen.push(text);}}),'crowd');
 assert.deepEqual([u.verdict,u.reason],['conflict','identity_fanout']);
 assert.ok(seen.filter(t=>t.includes('json_group_array')).length===1,'decided in the first round');
 assert.ok(seen.every(t=>!t.includes('film:u:')),'the excess Films are never queried');
 const crowd=database();
 film(crowd,'film:k:0',[['letterboxd','k0'],['note','shared',0]]);
 for(let i=1;i<=IDENTITY_MAX_FILMS;i++)film(crowd,'film:k:'+i,[['note','shared',0]]);
 assert.deepEqual(await verdict(crowd,'k0'),['conflict','identity_fanout',409],'more than 16 Films met');
 // The key set never grows past the cap into a query: the 17 Films met are refused before a round reads them.
 const texts=[];
 await resolveFilmIdentity(env(crowd,{onQuery:text=>{texts.push(text);}}),'k0');
 assert.ok(texts.every(t=>!t.includes('film:k:1"')),'the excess Films are never queried');
}

// The marker gate and failures: held, unopened and unreadable stores are 503 before any identity read; a broken read is 503, never absent.
{
 const held=database();sqlite(held,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 assert.deepEqual(await verdict(held,'tmdb_1'),['unavailable','film_person_held',503]);
 const prepared=path.join(root,'prepared.sqlite');
 sqlite(prepared,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 assert.deepEqual(await verdict(prepared,'tmdb_1'),['unavailable','film_person_unavailable',503]);
 const broken=database();film(broken,'film:tmdb:1',[['tmdb','1']]);
 const failing=env(broken,{onQuery:text=>{if(text.includes('json_group_array'))throw new Error('D1_ERROR: boom');}});
 const r=await resolveFilmIdentity(failing,'tmdb_1');
 assert.deepEqual([r.verdict,r.reason,r.http],['unavailable','canonical_read_unavailable',503]);
 // A Film with no canonical_revision is an inconsistent store, never served.
 const norev=database();film(norev,'film:tmdb:2',[['tmdb','2']]);sqlite(norev,"DELETE FROM canonical_revision WHERE id='film:tmdb:2'");
 assert.deepEqual(await verdict(norev,'tmdb_2'),['unavailable','canonical_read_unavailable',503]);
}

// The coherent capture: every round is ONE statement over the whole key set, the answer comes only from a closed round, and the read-set holds
// the absence predicates (zero-row pairs) and every Film met.
{
 const file=database();
 film(file,'film:tmdb:20',[['tmdb','20'],['letterboxd','l20'],['letterboxd','l20b']]);
 film(file,'film:old:20');redirect(file,'film:old:20','film:tmdb:20');
 const e=env(file);
 const r=await resolveFilmIdentity(e,'film:old:20');
 assert.equal(r.verdict,'redirected');
 assert.deepEqual(r.fence.keys.films,['film:old:20','film:tmdb:20']);
 assert.deepEqual(r.fence.keys.pairs,[['letterboxd','l20'],['letterboxd','l20b'],['tmdb','20']].map(p=>JSON.stringify(p)));
 assert.equal(e.calls.batches,0,'no D1 batch: each round is one statement');
 assert.ok(e.calls.queries<=3+4,'marker gate plus at most four rounds here, got '+e.calls.queries);
 assert.match(r.token.readSet,/^sha256:[0-9a-f]{64}$/);assert.equal(r.token.generation,2);
 // A change between two discovery rounds never reaches the answer: the owner is reassigned after round one; the answer is from the closed last round.
 const moving=database();
 film(moving,'film:m:1',[['letterboxd','mv']]);film(moving,'film:m:2');
 let seen=0;
 const m=env(moving,{onQuery:text=>{if(text.includes('json_group_array')&&++seen===2)sqlite(moving,"UPDATE film_external_id SET trusted=0 WHERE film_id='film:m:1';INSERT INTO film_external_id VALUES ('film:m:2','letterboxd','mv',1,0,NULL)");}});
 const moved=await resolveFilmIdentity(m,'mv');
 assert.deepEqual([moved.verdict,moved.reason],['conflict','competing_owner'],'the closed round sees both rows of the pair');
}

// EXPLAIN QUERY PLAN of the snapshot statement (ADR 0216 decision 7). Owner decision of 25 Nov 2026 on PR #1000: option A, a non-unique index
// tmdb_retirement_decision_movie ON tmdb_retirement_decision(movie_id), created by migration 0040 (AIR-667). The fixture is the real migration chain,
// which carries the index; the test asserts the target plan: every lookup is index-served, the ledger is SEARCHed by that index and never scanned.
{
 const file=database();
 assert.equal(rows(file,"SELECT name FROM sqlite_master WHERE type='index' AND name='tmdb_retirement_decision_movie'").length,1,'the chain carries the index (0040)');
 const params=['["film:x"]','["film:x"]','["film:x"]','["film:x"]','65','[["tmdb","1"]]','65','["1"]','65'];
 let i=0;const text=IDENTITY_SNAPSHOT_SQL.replace(/\?/g,()=>{const v=params[i++];return /^\d+$/.test(v)?v:q(v);});
 assert.equal(i,params.length,'every parameter is bound');
 const out=sqliteSync([file],{input:'EXPLAIN QUERY PLAN '+text+';',encoding:'utf8'});
 assert.equal(out.status,0,out.stderr);
 const plan=out.stdout.split('\n').map(line=>line.replace(/^[\s|`-]+/,'').trim()).filter(Boolean);
 // Allowed scans: the bound json_each key lists, a constant row and the LIMITed derived tables of the capped columns; never a base table.
 const scans=plan.filter(d=>/^SCAN /.test(d)&&!/json_each|^SCAN j\b|SCAN CONSTANT ROW|^SCAN \(subquery-\d+\)$/.test(d));
 assert.deepEqual(scans,[],plan.join('\n'));
 assert.ok(plan.some(d=>/^SEARCH tmdb_retirement_decision USING (COVERING )?INDEX tmdb_retirement_decision_movie\b/.test(d)),plan.join('\n'));
 for(const index of ['film_external_id_by_scheme_value'])assert.ok(plan.some(d=>d.includes(index)),index+'\n'+plan.join('\n'));
}

// Test 8: a concurrent reassignment, merge, retirement, revision move, new competing claim, vanished row or marker move between resolution and the last
// section read: 503 identity_moved with no section. An unchanged read-set passes and returns the sections.
{
 const cases=[
  ['reassignment',f=>sqlite(f,"UPDATE film_external_id SET film_id='film:o:1' WHERE film_id='film:tmdb:30' AND scheme='letterboxd'")],
  ['merge',f=>sqlite(f,"INSERT INTO film_redirect VALUES ('film:tmdb:30','film:o:1','"+AT+"')")],
  ['retirement',f=>retire(f,'film:tmdb:30','30','3000','l30')],
  ['revision',f=>bump(f,'film:tmdb:30')],
  ['competing claim',f=>claim(f,'film:o:1','letterboxd','l30',0)],
  ['new claim of the survivor',f=>claim(f,'film:tmdb:30','letterboxd','l30b')],
  ['vanished claim',f=>sqlite(f,"DELETE FROM film_external_id WHERE film_id='film:tmdb:30' AND scheme='letterboxd'")],
  ['trust change',f=>sqlite(f,"UPDATE film_external_id SET conflicting=1 WHERE film_id='film:tmdb:30' AND scheme='tmdb'")],
  ['marker held',f=>sqlite(f,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1")],
  ['marker generation',f=>sqlite(f,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1")],
 ];
 for(const [name,change] of cases){
  const file=database();
  film(file,'film:tmdb:30',[['tmdb','30'],['letterboxd','l30']]);film(file,'film:o:1');
  const out=await readFilmAggregateIdentity(env(file),'tmdb_30',{sections:async()=>{change(file);return {display:{status:'present'}};}});
  assert.equal(out.http,503,name);
  assert.deepEqual(out.body,{contract:'film-aggregate/v1',identity:{verdict:'unavailable',reason:'identity_moved',requested:{scheme:'tmdb_movie',value:'30'}}},name+': no section');
 }
 // An unrelated write elsewhere does not move the fence.
 const file=database();
 film(file,'film:tmdb:30',[['tmdb','30'],['letterboxd','l30']]);film(file,'film:o:1');
 const out=await readFilmAggregateIdentity(env(file),'tmdb_30',{sections:async(resolution,budget)=>{
  assert.ok(budget.reserved>=1,'the fence is reserved before any section read');
  film(file,'film:unrelated:1',[['letterboxd','zzz']]);bump(file,'film:o:1');
  return {display:{status:'present'}};
 }});
 assert.equal(out.http,200);assert.equal(out.body.identity.verdict,'found');assert.deepEqual(out.body.display,{status:'present'});
 assert.equal(out.body.identity.permalink,'/film/tmdb_30');assert.ok(!('fence' in out.body.identity)&&!('authorized' in out.body.identity));
 // A non-found identity returns no section and never calls the section readers.
 for(const id of ['tmdb_404404','not a lid','tmdb_0']){
  const res=await readFilmAggregateIdentity(env(file),id,{sections:()=>{throw new Error('must not read sections');}});
  assert.ok(res.http===404||res.http===400,id);assert.deepEqual(Object.keys(res.body),['contract','identity']);
 }
}

// Test 15a and decision 7: the final capture cannot run -> 503 with no section. The fence statement is reserved first, so sections cannot spend it.
{
 const file=database();
 film(file,'film:tmdb:40',[['tmdb','40'],['letterboxd','l40']]);
 // The fence read fails.
 let armed=false;
 const e=env(file,{onQuery:text=>{if(armed&&text.includes('json_group_array'))throw new Error('D1_ERROR: unavailable');}});
 const out=await readFilmAggregateIdentity(e,'tmdb_40',{sections:async()=>{armed=true;return {display:{status:'present'}};}});
 assert.deepEqual([out.http,out.body.identity.reason,Object.keys(out.body)],[503,'canonical_read_unavailable',['contract','identity']]);
 // Sections that try to spend the whole budget cannot take the reserved fence statement; the fence still runs and passes.
 const spent=await readFilmAggregateIdentity(env(file),'tmdb_40',{sections:async(resolution,budget)=>{
  let taken=0;while(budget.take(1))taken++;
  assert.equal(budget.available,0);assert.equal(budget.reserved,1);assert.ok(taken>0);
  return {display:{status:'unavailable',reason:'budget_exceeded'}};
 }});
 assert.equal(spent.http,200);
 // A fence with no reservation cannot run: fail closed, never a pass.
 const r=await resolveFilmIdentity(env(file),'tmdb_40');
 assert.deepEqual(await fenceFilmIdentity(env(file),r,createStatementBudget()),{ok:false,reason:'canonical_read_unavailable'});
 const reserved=createStatementBudget();reserved.reserve(1);
 assert.deepEqual(await fenceFilmIdentity(env(file),r,reserved),{ok:true});
 assert.deepEqual(await fenceFilmIdentity(env(file),{verdict:'absent'},reserved),{ok:false,reason:'canonical_read_unavailable'});
 // A budget too small for the identity capture is 503, never a guess.
 const tiny=await readFilmAggregateIdentity(env(file),'tmdb_40',{budgetLimit:2});
 assert.deepEqual([tiny.http,tiny.body.identity.reason],[503,'budget_exceeded']);
 const none=await readFilmAggregateIdentity(env(file),'tmdb_40',{budgetLimit:0});
 assert.equal(none.http,503);
 // Actual D1 statements, the authority gate included, never exceed the budget, also for tiny budgets.
 for(const limit of [0,1,2,3,4,5,6,REQUEST_STATEMENT_BUDGET]){
  const e=env(file);
  const out=await readFilmAggregateIdentity(e,'tmdb_40',{budgetLimit:limit,sections:async(resolution,budget)=>{
   let rowsRead=0;while(budget.take(1)){await e.DB.prepare("SELECT film_id FROM film_external_id WHERE film_id=?").bind(resolution.filmId).all();rowsRead++;}
   return {display:{status:'partial',reads:rowsRead}};
  }});
  assert.ok(e.calls.queries<=limit,limit+': '+e.calls.queries+' statements');
  if(limit===REQUEST_STATEMENT_BUDGET){assert.equal(out.http,200);assert.equal(e.calls.queries,REQUEST_STATEMENT_BUDGET,'sections spend the rest, the fence its reservation');}
 }
 assert.equal(REQUEST_STATEMENT_BUDGET,40);
}

// The resolver writes nothing and touches neither R2 nor the network: the database file is byte-identical after every kind of read.
{
 const file=database();
 film(file,'film:tmdb:50',[['tmdb','50'],['tmdb_tv','5050'],['letterboxd','l50']]);retire(file,'film:tmdb:50','50','5050','l50');
 film(file,'film:old:50');redirect(file,'film:old:50','film:tmdb:50');
 const before=sha(file),stats={read:0,written:0};
 for(const id of ['tmdb_50','tmdb_tv:5050','l50','film:old:50','film:none','tmdb_51','bad id'])await readFilmAggregateIdentity(env(file,{rowStats:stats}),id,{sections:async()=>({})});
 assert.equal(stats.written,0);assert.equal(sha(file),before);
 // The module is not bundled: no Worker source imports it (only the equally dormant aggregate of AIR-647, proved unbundled in tests/film-aggregate.mjs).
 for(const name of fs.readdirSync('src').filter(f=>f.endsWith('.js')&&f!=='film-aggregate-resolver.js'&&f!=='film-aggregate.js'&&f!=='film-history-aggregate.js'))
  assert.ok(!fs.readFileSync('src/'+name,'utf8').includes('film-aggregate-resolver'),name+' must not import the dormant resolver');
 assert.ok(!fs.readFileSync('src/film-aggregate-resolver.js','utf8').match(/\b(INSERT|UPDATE|DELETE|REPLACE)\s/),'only SELECTs');
}

// Review of PR #1000: retirement by claimed movie id, whatever Film the ledger names, with restore semantics and fenced.
{
 const file=database();
 // The ledger retires movie 70 under a historical Film id that no longer holds the claim; the current owner holds trusted tmdb 70.
 film(file,'film:cur:70',[['tmdb','70'],['letterboxd','l70']]);retire(file,'film:hist:70','70','7070','l70');
 const r=await resolve(file,'l70');
 assert.deepEqual([r.verdict,r.authorized.tmdb_movie,r.permalink],['found',[],'/film/l70'],'a retired movie id is never authorized, whatever Film the ledger names');
 assert.ok(r.claims.some(c=>c.scheme==='tmdb'&&c.value==='70'&&c.retired));
 assert.deepEqual(await verdict(file,'tmdb_70'),['retired','tmdb_retired',410]);
 assert.equal((await resolve(file,'film:cur:70')).authorized.tmdb_movie.length,0);
 // A TV number equal to a movie number is never looked up in the ledger.
 const tv=database();
 film(tv,'film:tv:1',[['tmdb_tv','88'],['letterboxd','tv88']]);
 assert.deepEqual((await resolve(tv,'tv88')).fence.keys.movies,[]);
 // Concurrent retirement during the section reads, under another Film id: identity_moved.
 const c1=database();film(c1,'film:c:80',[['tmdb','80'],['letterboxd','l80']]);
 const moved=await readFilmAggregateIdentity(env(c1),'l80',{sections:async()=>{retire(c1,'film:other:80','80','8080','l80');return {display:{}};}});
 assert.deepEqual([moved.http,moved.body.identity.reason],[503,'identity_moved']);
 // Concurrent restore during the section reads: identity_moved.
 const c2=database();film(c2,'film:c:81',[['tmdb','81'],['letterboxd','l81']]);retire(c2,'film:old:81','81','8181','l81');
 const seq=rows(c2,"SELECT seq FROM tmdb_retirement_decision WHERE movie_id='81'")[0].seq;
 const restoredMid=await readFilmAggregateIdentity(env(c2),'l81',{sections:async()=>{restore(c2,'film:old:81','81','8181',seq,'l81');return {display:{}};}});
 assert.deepEqual([restoredMid.http,restoredMid.body.identity.reason],[503,'identity_moved']);
 assert.deepEqual((await resolve(c2,'l81')).authorized.tmdb_movie,['81'],'after the restore the movie claim is authorized again');
}

// Review of PR #1000: growth of the read-set past the caps during the sections fails the fence closed with 503.
{
 const file=database();film(file,'film:g:1',[['letterboxd','g1']]);
 const out=await readFilmAggregateIdentity(env(file),'g1',{sections:async()=>{
  sqlite(file,Array.from({length:IDENTITY_MAX_CLAIM_ROWS+5},(_,i)=>`INSERT INTO film_external_id VALUES ('film:g:1','note','n${i}',0,0,NULL);`).join(''));
  return {display:{}};
 }});
 assert.deepEqual([out.http,out.body.identity.reason,Object.keys(out.body)],[503,'identity_moved',['contract','identity']]);
}

// Review of PR #1000: a throwing section reader never bypasses the fence; its sections are typed unavailable; envelope fields are protected.
{
 const file=database();film(file,'film:t:1',[['tmdb','91'],['letterboxd','t1']]);film(file,'film:t:2');
 let fenced=0;
 const e=env(file,{onQuery:text=>{if(text.includes('json_group_array'))fenced++;}});
 const quiet=await readFilmAggregateIdentity(e,'t1',{sections:async()=>{fenced=0;throw new Error('section failed');}});
 assert.equal(fenced,1,'the fence ran after the throwing section');
 assert.deepEqual([quiet.http,quiet.body.sectionsUnavailable,Object.keys(quiet.body)],[200,{reason:'section_read_failed'},['contract','identity','sectionsUnavailable']]);
 const moved=await readFilmAggregateIdentity(env(file),'t1',{sections:async()=>{sqlite(file,"UPDATE film_external_id SET film_id='film:t:2' WHERE value='t1'");throw new Error('section failed');}});
 assert.deepEqual([moved.http,moved.body.identity.reason,Object.keys(moved.body)],[503,'identity_moved',['contract','identity']]);
 const other=database();film(other,'film:t:3',[['letterboxd','t3']]);
 const guarded=await readFilmAggregateIdentity(env(other),'t3',{sections:async()=>({contract:'forged',identity:{verdict:'found',filmId:'film:evil'},sectionsUnavailable:{reason:'x'},display:{status:'present'}})});
 assert.equal(guarded.body.contract,'film-aggregate/v1');assert.equal(guarded.body.identity.filmId,'film:t:3');
 assert.ok(!('sectionsUnavailable' in guarded.body));assert.deepEqual(guarded.body.display,{status:'present'});
}

fs.rmSync(root,{recursive:true,force:true});
console.log('film-aggregate-resolver: ok');
