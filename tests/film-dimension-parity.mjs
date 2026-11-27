// AIR-660 / ADR 0218 stage 1: the offline Film dimension parity reader and its pure classifier, on real SQLite fixtures built from every
// migration (the sqlite3-CLI D1 stand-in). No Worker, R2, network or production access. The reader must only read: every statement is a
// SELECT and the stand-in's row counter sees no write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {readDimensionParity,PARITY_PAGE_MAX,PARITY_REDIRECT_DEPTH} from '../src/film-dimension-parity.js';
import {CANONICAL_REDIRECT_DEPTH} from '../src/canonical-read-model.js';
import {parityReport,sqliteReadOnlyBinding} from '../scripts/film-dimension-parity.mjs';
import {createHash} from 'node:crypto';
import {classifyRow,identityVerdict,localizationFacts,metadataFacts,predictionFacts,retiredMovieIds,usableField,summarize,PARITY_CLASSES} from '../src/domain/film-dimension-parity.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-dimension-parity-'));
const migrations=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);};
const q=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const AT='2026-11-20T10:00:00.000Z';
let n=0;
function database({film='open',prediction='open',owner='open'}={}){
 const file=path.join(root,'p-'+(n++)+'.sqlite');
 sqlite(file,migrations);
 if(film!=='r2')sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
 if(film==='held')sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;");
 if(prediction!=='r2')sqlite(file,`UPDATE prediction_domain_authority SET mode='d1',generation=1 WHERE id=1;`+(prediction==='held'?"UPDATE prediction_domain_authority SET writes='held' WHERE id=1;":''));
 if(owner!=='r2')sqlite(file,"UPDATE owner_review_authority SET mode='d1',generation=1 WHERE id=1;");
 return file;
}
const insert=(table,row)=>`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(q).join(',')});`;
const filmRow=(id,title='Original')=>insert('film',{id,contract_version:1,canonical_identity:null,original_title:title,updated_at:AT});
const claim=(film_id,scheme,value,trusted=1,conflicting=0)=>insert('film_external_id',{film_id,scheme,value:String(value),trusted,conflicting,provenance_json:null});
const STATUS={identity:'resolved',metadata:'fresh',localization:'provisional',fingerprint:'current',prediction:'current'};
const dim=(film_id,dimension,over={})=>insert('film_dimension',{film_id,dimension,status:STATUS[dimension],source:null,source_version:null,provenance_json:null,value:null,authority:null,last_error:null,failure_reason:null,retry_at:null,attempts:0,next_action:'none',updated_at:AT,...over});
const meta=(film_id,over={})=>insert('film_metadata',{film_id,schema_version:1,year:1999,runtime:120,synopsis:'Text',poster:'https://p/x.jpg',url:'https://example.test/x',genres_json:'["Drama"]',people_version:null,payload_json:'{}',r2_key:null,content_sha256:null,updated_at:AT,...over});
const sourceRow=(film_id,src,value,observed_at=AT)=>insert('film_localization_source',{film_id,source:src,value,source_version:'v1',provenance_json:'{}',request_id:'r-'+film_id+'-'+src,observed_at,updated_at:AT});
const ownerEntry=(link,value,key='k-'+link)=>insert('owner_review_entry',{kind:'film',source_key:key,payload_json:JSON.stringify({localization:{status:'reviewed',value,provenance:{authority:'owner'},updatedAt:AT}}),identity_link:link,identity_state:'verified',generation:1});
const print=(film_id,hash='h1',invalidated_at=null)=>insert('prediction_fingerprint',{film_id,fingerprint_hash:hash,schema_version:1,prompt_version:1,generated_at:AT,invalidated_at,r2_key:'fp/'+film_id,content_sha256:'a'.repeat(64),features_json:'{}'});
const pointer=(film_id,hash='h1',r2='pr/'+film_id)=>insert('prediction_pointer',{film_id,taste_profile_version:1,taste_profile_hash:'t',fingerprint_hash:hash,fingerprint_schema_version:1,prediction_prompt_version:1,predicted_rating:3.5,r2_key:r2,content_sha256:'b'.repeat(64),updated_at:AT,display_json:'{}'});
const byKey=result=>Object.fromEntries(result.classified.map(item=>[item.film_id+'/'+item.dimension,item]));
async function run(file,options){const stats={read:0,written:0};const result=await readDimensionParity({DB:d1Standin(file,{rowStats:stats})},options);return {result,stats};}


// 1. A full classification over one fixture: every class, the control rows never reported as copies, and no write.
{
 const file=database();
 sqlite(file,[
  filmRow('film:a'),claim('film:a','tmdb',1),claim('film:a','letterboxd','lidA'),
  dim('film:a','identity',{status:'found',provenance_json:JSON.stringify({titleSource:{source:'tmdb',at:AT}})}),
  dim('film:a','metadata',{status:'reviewed'}),
  dim('film:a','localization',{status:'provisional',source:'tmdb',value:'Название',provenance_json:'{}'}),
  sourceRow('film:a','tmdb','Название'),
  dim('film:a','fingerprint',{status:'failed',last_error:'boom',attempts:2}),
  dim('film:a','prediction',{status:'current'}),
  print('tmdb_1'),pointer('tmdb_1'),meta('film:a'),
  filmRow('film:b'),claim('film:b','tmdb',2),
  dim('film:b','identity',{status:'resolved'}),
  dim('film:b','metadata',{status:'fresh',authority:'importer'}),
  dim('film:b','localization',{status:'provisional',source:'epg',value:'Старое',provenance_json:'{}'}),
  sourceRow('film:b','epg','Старое','2026-11-01T00:00:00.000Z'),sourceRow('film:b','tmdb','Новое'),
  dim('film:b','fingerprint',{status:'reviewed'}),
  dim('film:b','prediction',{status:'missing',authority:'owner'}),
  filmRow('film:c'),claim('film:c','tmdb',3),
  dim('film:c','identity',{status:'reviewed',authority:'owner'}),
  dim('film:c','metadata',{status:'stale',authority:'owner'}),
  dim('film:c','localization',{status:'reviewed',authority:'owner',source:'owner',value:'Владелец'}),
  filmRow('film:d'),claim('film:d','tmdb',4),
  dim('film:d','identity',{provenance_json:'{bad'}),
  dim('film:d','localization',{status:'weird',value:'x'}),
  dim('film:d','metadata',{provenance_json:JSON.stringify({titleSource:{source:'tmdb'}})}),
 ].join('\n'));
 const {result,stats}=await run(file,{limit:10});
 const rows=byKey(result);
 assert.equal(result.writes,0);
 assert.equal(stats.written,0,'the reader writes nothing');
 assert.equal(result.films,4);
 assert.equal(result.next,null);
 assert.equal(rows['film:a/identity'].class,'control');assert.deepEqual(rows['film:a/identity'].reasons,['title_source']);
 assert.equal(rows['film:a/metadata'].class,'control');assert.deepEqual(rows['film:a/metadata'].reasons,['metadata_lock']);
 assert.equal(rows['film:a/localization'].class,'agree');
 assert.equal(rows['film:a/fingerprint'].class,'stale_copy');assert.ok(rows['film:a/fingerprint'].notes.includes('processing_fields'));
 assert.equal(rows['film:a/fingerprint'].derived,'present','a value under an authorized key is read as is');
 assert.equal(rows['film:a/prediction'].class,'stale_copy');
 assert.equal(rows['film:b/identity'].class,'stale_copy');assert.equal(rows['film:b/identity'].diverges,true,'informational only: a copy status is never truth');
 assert.equal(rows['film:b/metadata'].class,'unknown_legacy');assert.deepEqual(rows['film:b/metadata'].reasons,['unknown_authority']);
 assert.equal(rows['film:b/localization'].class,'stale_copy','F5: tmdb outranks epg, the projection is stale');assert.deepEqual(rows['film:b/localization'].reasons,['projection_stale']);
 assert.deepEqual(rows['film:b/localization'].expected,{tier:'automatic',source:'tmdb'});
 assert.equal(rows['film:b/fingerprint'].class,'unknown_legacy');assert.deepEqual(rows['film:b/fingerprint'].reasons,['unknown_status','reviewed_status']);
 assert.equal(rows['film:b/prediction'].class,'unknown_legacy');assert.deepEqual(rows['film:b/prediction'].reasons,['unknown_authority']);
 assert.equal(rows['film:c/identity'].class,'control');assert.deepEqual(rows['film:c/identity'].reasons,['owner_authority','reviewed']);
 assert.equal(rows['film:c/metadata'].class,'control','authority owner is the lock');
 assert.equal(rows['film:c/localization'].class,'control');assert.deepEqual(rows['film:c/localization'].reasons,['owner_applied']);
 assert.equal(rows['film:d/identity'].class,'unknown_legacy');assert.deepEqual(rows['film:d/identity'].reasons,['malformed_provenance']);
 assert.equal(rows['film:d/localization'].class,'unknown_legacy');assert.deepEqual(rows['film:d/localization'].reasons,['unknown_status']);
 assert.equal(rows['film:d/metadata'].class,'unknown_legacy');assert.deepEqual(rows['film:d/metadata'].reasons,['title_source_outside_identity']);
 // Derived facts of film:a.
 const a=result.facts.get('film:a');
 assert.equal(a.identity.verdict,'found');assert.deepEqual(a.identity.aliases.storageIds,['tmdb_1','lidA']);assert.equal(a.identity.aliases.stable,true);
 assert.deepEqual(a.metadata.present,['year','runtime','synopsis','poster','url','genres']);
 assert.equal(a.metadata.fields.year.confidence,'unattributed');assert.equal(a.metadata.freshness,'unknown');
 assert.equal(a.prediction.fingerprint.status,'present');assert.equal(a.prediction.prediction.status,'partial');
 // Summary: counts only, no ids or values.
 const text=JSON.stringify(result.summary);
 assert.ok(!/film:|Название|lidA/.test(text),'the summary holds no id or value');
 assert.equal(result.summary.rows,result.classified.length);
 assert.equal(Object.values(result.summary.byDimension).reduce((sum,item)=>sum+Object.values(item).reduce((a2,b)=>a2+b,0),0),result.classified.length);
 // Cost: the page is a fixed number of statements, measured, not a threshold.
 assert.ok(result.cost.statements>0&&result.cost.statements<=30,'bounded statements: '+result.cost.statements);
 assert.equal(stats.read,result.cost.rowsReturned,'every row returned is counted');
}

// 2. Presence, usability and absence are three axes: a stored non-null value is present whatever its type, with a usability diagnostic;
// a null is unknown (no explicit-null provenance exists yet); nothing is absent. A Film with no dimension rows yields facts but no row.
{
 const file=database();
 sqlite(file,[filmRow('film:e'),claim('film:e','tmdb',5),meta('film:e',{year:0,runtime:null,synopsis:'  ',poster:'',url:null,genres_json:'not json'}),filmRow('film:f')].join('\n'));
 const {result}=await run(file);
 assert.equal(result.classified.length,0,'a missing dimension row is not classified as anything');
 const e=result.facts.get('film:e').metadata;
 for(const field of ['year','synopsis','poster','genres'])assert.deepEqual([e.fields[field].status,e.fields[field].usable,e.fields[field].confidence],['present',false,'unattributed'],field);
 assert.equal(e.fields.year.diagnostic,'not_positive');assert.equal(e.fields.synopsis.diagnostic,'empty');assert.equal(e.fields.poster.diagnostic,'empty');assert.equal(e.fields.genres.diagnostic,'malformed');
 for(const field of ['runtime','url'])assert.deepEqual([e.fields[field].status,e.fields[field].reason],['unknown','null_unproved'],field);
 assert.deepEqual(e.present,['year','synopsis','poster','genres']);assert.deepEqual(e.usable,[]);
 assert.equal(usableField('url',{url:42}).reason,'wrong_type');
 const mixed=metadataFacts({year:'1999',runtime:90,synopsis:'s',poster:'p',url:'u',genres_json:'[]'});
 assert.deepEqual([mixed.fields.year.status,mixed.fields.year.diagnostic],['present','wrong_type']);
 assert.deepEqual([mixed.fields.genres.status,mixed.fields.genres.diagnostic],['present','empty']);
 const f=result.facts.get('film:f');
 assert.equal(f.metadata.fields.year.reason,'no_metadata_row');
 assert.equal(f.identity.verdict,'found');assert.equal(f.identity.aliases.stable,false);
 assert.equal(f.prediction.prediction.status,'unknown');assert.equal(f.prediction.prediction.reason,'no_authorized_alias');
 assert.equal(f.localization.status,'unknown');
}

// 3. Held and moved markers: identity unavailable proves nothing; a held prediction marker makes fingerprint/prediction proof unavailable;
// a marker that moves during the page refuses it.
{
 const file=database({film:'held'});
 sqlite(file,[filmRow('film:g'),claim('film:g','tmdb',7),dim('film:g','identity',{status:'found'}),dim('film:g','prediction',{status:'current'})].join('\n'));
 const {result}=await run(file);
 const rows=byKey(result);
 assert.equal(result.facts.get('film:g').identity.verdict,'unavailable');
 assert.equal(rows['film:g/identity'].proof,'unavailable');assert.equal(rows['film:g/identity'].diverges,null);
 assert.equal(rows['film:g/prediction'].proof,'unavailable');
 assert.equal(result.markers.filmPerson,'held');
}
{
 const file=database({prediction:'held'});
 sqlite(file,[filmRow('film:h'),claim('film:h','tmdb',8),dim('film:h','fingerprint',{status:'current'}),print('tmdb_8')].join('\n'));
 const {result}=await run(file);
 assert.equal(byKey(result)['film:h/fingerprint'].proof,'unavailable');
 assert.equal(result.facts.get('film:h').prediction.fingerprint.status,'unavailable');
 assert.equal(result.markers.prediction,'held');
}
{
 const file=database();
 sqlite(file,[filmRow('film:i'),claim('film:i','tmdb',9)].join('\n'));
 let moved=false;
 const db=d1Standin(file,{onQuery:text=>{if(!moved&&/FROM film_external_id/.test(text)){moved=true;sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;");}}});
 await assert.rejects(readDimensionParity({DB:db}),error=>error.code==='film_person_generation_moved');
}

// 4. Redirects, cycles, competing claims, retired movie claims and aliases (G1).
{
 const file=database();
 sqlite(file,[
  filmRow('film:s'),claim('film:s','tmdb',10),claim('film:s','letterboxd','lidS'),
  filmRow('film:old'),insert('film_redirect',{from_id:'film:old',to_film_id:'film:s',at:AT}),dim('film:old','identity',{status:'found'}),
  filmRow('film:x'),filmRow('film:y'),insert('film_redirect',{from_id:'film:x',to_film_id:'film:y',at:AT}),insert('film_redirect',{from_id:'film:y',to_film_id:'film:x',at:AT}),
  filmRow('film:k'),claim('film:k','tmdb',11),filmRow('film:k2'),claim('film:k2','tmdb',11,0,1),
  filmRow('film:u'),claim('film:u','letterboxd','lidU',0,0),
  filmRow('film:tv'),claim('film:tv','tmdb_tv',12),claim('film:tv','tmdb',13),claim('film:tv','letterboxd','lidTv'),
  insert('tmdb_retirement_decision',{request_id:'r1',film_id:'film:tv',kind:'retire',lid:'lidTv',movie_id:'13',tv_id:'12',evidence_json:'{}',confirmation_json:JSON.stringify({by:'owner',at:AT,source:'t'}),origin:'owner_request',input_sha256:null,supersedes_seq:null,payload_json:'{}',recorded_at:AT}),
  filmRow('film:tvonly'),claim('film:tvonly','tmdb_tv',14),
  claim('film:s','letterboxd_slug','slug-s',0,0),
 ].join('\n'));
 const {result}=await run(file);
 const facts=id=>result.facts.get(id).identity;
 assert.equal(facts('film:old').verdict,'redirected');assert.equal(facts('film:old').survivor,'film:s');
 assert.ok(byKey(result)['film:old/identity'].notes.includes('film_redirected'));
 assert.equal(facts('film:s').verdict,'found','an unsettled claim on a scheme no section reads does not fail identity');
 assert.equal(facts('film:x').verdict,'cycle');assert.equal(facts('film:y').verdict,'cycle');
 assert.equal(facts('film:k').verdict,'conflict');assert.equal(facts('film:k').reason,'competing_claim');
 assert.equal(facts('film:k2').verdict,'conflict');assert.equal(facts('film:k2').reason,'unsettled_claim');
 assert.equal(facts('film:u').verdict,'conflict');
 assert.equal(facts('film:tv').verdict,'found','a settled retirement is not a conflict');
 assert.deepEqual(facts('film:tv').aliases.storageIds,['lidTv'],'the retired movie key is never an alias');
 assert.equal(facts('film:tvonly').aliases.stable,false,'tmdb_tv only: no stable alias');
}

// 5. Localization: owner precedence through redirect ancestors, owner conflict, sole-record projection, reviewed dictionary.
{
 const file=database();
 sqlite(file,[
  filmRow('film:l1'),claim('film:l1','tmdb',21),dim('film:l1','localization',{status:'provisional',source:'tmdb',value:'Авто',provenance_json:'{}'}),sourceRow('film:l1','tmdb','Авто'),
  filmRow('film:l1old'),insert('film_redirect',{from_id:'film:l1old',to_film_id:'film:l1',at:AT}),ownerEntry('film:l1old','Владелец'),
  filmRow('film:l2'),claim('film:l2','tmdb',22),dim('film:l2','localization',{status:'provisional',source:'tmdb',value:'Авто'}),ownerEntry('film:l2','A','k1'),ownerEntry('film:l2','B','k2'),
  filmRow('film:l3'),claim('film:l3','tmdb',23),dim('film:l3','localization',{status:'provisional',source:'wikidata',value:'Старый импорт'}),
  filmRow('film:l4'),claim('film:l4','tmdb',24),dim('film:l4','localization',{status:'reviewed',authority:'dictionary',source:'dictionary',value:'Словарь'}),sourceRow('film:l4','tmdb','Авто'),
 ].join('\n'));
 // film:l1old is itself a Film row with a redirect: only the page Films are classified, and its rows would be moved/held.
 const {result}=await run(file);
 const rows=byKey(result);
 assert.equal(rows['film:l1/localization'].class,'stale_copy','owner entry of a redirect ancestor outranks the automatic projection');
 assert.deepEqual(rows['film:l1/localization'].expected,{tier:'owner',source:'owner'});
 assert.equal(rows['film:l2/localization'].class,'unknown_legacy');assert.deepEqual(rows['film:l2/localization'].reasons,['owner_conflict']);
 assert.equal(rows['film:l3/localization'].class,'control');assert.deepEqual(rows['film:l3/localization'].reasons,['projection_sole_record']);
 assert.equal(rows['film:l4/localization'].class,'control');assert.deepEqual(rows['film:l4/localization'].reasons,['reviewed_applied']);
}
{
 // Owner review not authoritative: the projection cannot be proved and is kept.
 const file=database({owner:'r2'});
 sqlite(file,[filmRow('film:m'),dim('film:m','localization',{status:'provisional',source:'tmdb',value:'X'}),sourceRow('film:m','tmdb','Y')].join('\n'));
 const {result}=await run(file);
 const row=byKey(result)['film:m/localization'];
 assert.equal(row.class,'control');assert.equal(row.proof,'unavailable');assert.deepEqual(row.reasons,['projection_unproved']);
}

// 6. Prediction compatibility and conflict between authorized storage ids; complete coverage supplied by the caller allows a negative.
{
 const file=database();
 sqlite(file,[
  filmRow('film:p1'),claim('film:p1','tmdb',31),print('tmdb_31','h1'),pointer('tmdb_31','h2'),
  filmRow('film:p2'),claim('film:p2','tmdb',32),claim('film:p2','letterboxd','lidP2'),pointer('tmdb_32','h','r/a'),pointer('lidP2','h','r/b'),
  filmRow('film:p3'),claim('film:p3','tmdb',33),
  filmRow('film:p4'),claim('film:p4','tmdb',34),print('tmdb_34','h4','2026-11-01T00:00:00.000Z'),pointer('tmdb_34','h4'),
 ].join('\n'));
 const {result}=await run(file,{coverage:id=>id==='film:p3'?{status:'complete'}:{status:'incomplete',reason:'seed_absent_unproved'}});
 const p=id=>result.facts.get(id).prediction;
 assert.equal(p('film:p1').compatibility,'incompatible');assert.equal(p('film:p1').compatibilityReason,'fingerprint_hash_mismatch');
 assert.equal(p('film:p2').prediction.status,'conflict','a known conflict survives incomplete coverage');
 assert.equal(p('film:p3').fingerprint.status,'absent');assert.equal(p('film:p3').prediction.status,'absent');
 assert.equal(p('film:p4').compatibilityReason,'fingerprint_invalidated');
}
{
 const file=database({prediction:'r2'});
 sqlite(file,[filmRow('film:q'),claim('film:q','tmdb',41),dim('film:q','prediction',{status:'current'})].join('\n'));
 const {result}=await run(file);
 assert.equal(result.facts.get('film:q').prediction.prediction.reason,'prediction_not_authoritative');
 assert.equal(byKey(result)['film:q/prediction'].proof,'unavailable');
}

// 7. Paging and bounds: the cursor walks every Film once; the page size is capped; an id outside the film scheme is refused.
{
 const file=database();
 const statements=[];for(let i=0;i<7;i++)statements.push(filmRow('film:n'+i),dim('film:n'+i,'prediction',{status:'current'}));
 sqlite(file,statements.join('\n'));
 const seen=[];let after='';
 for(let guard=0;guard<10;guard++){const {result}=await run(file,{after,limit:3});seen.push(...result.classified.map(item=>item.film_id));if(!result.next)break;after=result.next;}
 assert.deepEqual(seen,[...Array(7).keys()].map(i=>'film:n'+i));
 await assert.rejects(readDimensionParity({DB:d1Standin(file)},{limit:PARITY_PAGE_MAX+1}),error=>error.code==='parity_bounded');
 await assert.rejects(readDimensionParity({DB:d1Standin(file)},{limit:0}),error=>error.code==='parity_bounded');
 await assert.rejects(readDimensionParity({DB:d1Standin(file)},{after:'tmdb_1'}),error=>error.code==='parity_invalid');
 // Statements per page do not grow with the number of Films in the page.
 const small=(await run(file,{limit:1})).result.cost.statements,large=(await run(file,{limit:7})).result.cost.statements;
 assert.equal(small,large,'a fixed number of statements per page');
}

// 8. Pure rules, one per case.
{
 assert.equal(PARITY_REDIRECT_DEPTH,CANONICAL_REDIRECT_DEPTH,'the parity reader follows redirects as deep as the read model');
 assert.deepEqual([...retiredMovieIds([{seq:1,kind:'retire',movie_id:'5'},{seq:2,kind:'restore',movie_id:'5',supersedes_seq:1},{seq:3,kind:'retire',movie_id:'6'}])],['6']);
 assert.equal(identityVerdict({requested:'film:z',filmExists:false,redirect:{state:'direct',survivor:'film:z',chain:[]}}).verdict,'absent');
 assert.equal(identityVerdict({requested:'film:z',available:false}).verdict,'unavailable');
 assert.equal(usableField('genres',{genres_json:'[]'}).usable,false);
 assert.equal(usableField('genres',{genres_json:'[""]'}).usable,false);
 assert.equal(usableField('runtime',{runtime:'90'}).usable,false);
 assert.equal(usableField('year',{year:2001}).usable,true);
 // An explicit-null provenance (once ADR 0214 PV1 lands) is the only proof of absence.
 const explicit=metadataFacts({year:null,runtime:1,synopsis:'s',poster:'p',url:'u',genres_json:'["a"]'},{provenance:{year:{explicitNull:true,confidence:'tmdb'}}});
 assert.equal(explicit.fields.year.status,'absent');
 assert.equal(metadataFacts({year:null,genres_json:'[]'}).fields.year.status,'unknown');
 // Cross-source disagreement keeps the fixed order, not the newer observation.
 const loc=localizationFacts({sources:[{source:'letterboxd',value:'Старое',observed_at:'2026-01-01T00:00:00.000Z'},{source:'tmdb',value:'Новое',observed_at:'2026-11-01T00:00:00.000Z'}]});
 assert.equal(loc.resolved.source,'letterboxd');
 assert.equal(predictionFacts({available:false}).prediction.status,'unavailable');
 const none=predictionFacts({storageIds:['tmdb_1'],coverage:{status:'incomplete',reason:'discovery_cap'}});
 assert.equal(none.prediction.status,'partial','never none under incomplete coverage');
 // Every class is reachable and the summary counts each row once.
 const made=[classifyRow({film_id:'film:1',dimension:'prediction',status:'current'},{}),classifyRow({film_id:'film:1',dimension:'metadata',status:'reviewed'},{}),classifyRow({film_id:'film:1',dimension:'fingerprint',status:'current',authority:'y'},{})];
 assert.deepEqual(made.map(item=>item.class),['stale_copy','control','unknown_legacy']);
 assert.ok(PARITY_CLASSES.includes('agree'));
 assert.equal(summarize(made).rows,3);
}

// 9. Offline copy parity: the CLI report over a read-only sqlite3 binding equals the stand-in run, pages through every Film, prints no id or
// value without --detail, leaves the file byte-identical, and a write statement is refused before it reaches the copy.
{
 const file=database();
 const statements=[];for(let i=0;i<5;i++)statements.push(filmRow('film:c'+i),claim('film:c'+i,'tmdb',100+i),dim('film:c'+i,'metadata',{status:i%2?'reviewed':'fresh'}),dim('film:c'+i,'prediction',{status:'current'}));
 sqlite(file,statements.join('\n'));
 const digest=()=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const before=digest();
 const report=await parityReport({DB:sqliteReadOnlyBinding(file)},{page:2});
 assert.equal(digest(),before,'the copy is unchanged');
 assert.equal(report.films,5);assert.equal(report.pages,3);assert.equal(report.cost.rowsWritten,0);
 assert.deepEqual(report.summary.byDimension.metadata,{agree:0,stale_copy:3,control:2,unknown_legacy:0});
 assert.deepEqual(report.summary.byDimension.prediction,{agree:0,stale_copy:5,control:0,unknown_legacy:0});
 const same=await run(file,{limit:10});
 assert.deepEqual(report.summary,same.result.summary,'offline copy parity equals the stand-in parity');
 assert.ok(!/film:c/.test(JSON.stringify(report)),'no id without --detail');
 assert.ok((await parityReport({DB:sqliteReadOnlyBinding(file)},{detail:true})).rows.length===10);
 const truncated=await parityReport({DB:sqliteReadOnlyBinding(file)},{page:2,maxFilms:2});
 assert.equal(truncated.truncated,true);
 const writer={DB:{prepare(sql){if(/^\s*SELECT/i.test(sql))return sqliteReadOnlyBinding(file).prepare(sql);throw new Error('reached the copy');}}};
 await assert.doesNotReject(readDimensionParity(writer));
 assert.equal(digest(),before);
}

// 11. Review of 713eb19. (a) The fatal identity fence: a conflicting, held or cyclic identity yields no metadata, localization or prediction
// section even when those rows exist; control rows stay control, copies carry proof unavailable; a redirect to a missing survivor is unavailable.
// (b) Unknown statuses and ambiguous provenance are unknown_legacy on every dimension; proof distinguishes complete, incomplete and unavailable.
// (c) An owner authority on a non-reviewed localization is never an automatic candidate.
{
 const file=database();
 sqlite(file,[
  filmRow('film:k1'),claim('film:k1','tmdb',51),filmRow('film:k2'),claim('film:k2','tmdb',51,0,1),
  meta('film:k1'),ownerEntry('film:k1','Владелец'),print('tmdb_51'),pointer('tmdb_51'),
  dim('film:k1','localization',{status:'reviewed',authority:'owner',source:'owner',value:'Владелец'}),
  dim('film:k1','metadata'),dim('film:k1','prediction'),
  filmRow('film:k3'),filmRow('film:k4'),insert('film_redirect',{from_id:'film:k3',to_film_id:'film:k4',at:AT}),insert('film_redirect',{from_id:'film:k4',to_film_id:'film:k3',at:AT}),
  dim('film:k3','localization',{status:'provisional',source:'tmdb',value:'Цикл'}),dim('film:k3','identity'),
 ].join('\n'));
 const {result}=await run(file,{coverage:()=>({status:'complete'})});
 const rows=byKey(result),k1=result.facts.get('film:k1');
 assert.equal(k1.identity.verdict,'conflict');assert.deepEqual(k1.identity.aliases.storageIds,[],'a failed verdict authorizes no alias');
 assert.equal(k1.metadata.status,'unavailable');assert.equal(k1.localization.status,'unavailable');
 assert.equal(k1.prediction.prediction.status,'unavailable');assert.equal(k1.prediction.prediction.reason,'identity_conflict');
 assert.equal(rows['film:k1/localization'].class,'control','the applied owner title stays control under a failed fence');
 assert.deepEqual([rows['film:k1/metadata'].class,rows['film:k1/metadata'].proof],['stale_copy','unavailable']);
 assert.deepEqual([rows['film:k1/prediction'].class,rows['film:k1/prediction'].proof],['stale_copy','unavailable']);
 assert.equal(result.facts.get('film:k3').identity.verdict,'cycle');
 assert.deepEqual([rows['film:k3/localization'].class,rows['film:k3/localization'].reasons,rows['film:k3/localization'].proof],['control',['projection_unproved'],'unavailable']);
 assert.deepEqual([rows['film:k3/identity'].class,rows['film:k3/identity'].proof],['stale_copy','complete']);
 assert.deepEqual(identityVerdict({requested:'film:z',filmExists:true,redirect:{state:'redirected',survivor:'film:gone',chain:['film:z']},survivorExists:false}),{verdict:'unavailable',reason:'survivor_missing',survivor:null,chain:['film:z'],aliases:{tmdb:[],lids:[],tmdbTv:[],storageIds:[],stable:false}});
}
{
 const file=database({film:'held'});
 sqlite(file,[filmRow('film:h1'),claim('film:h1','tmdb',52),meta('film:h1'),dim('film:h1','localization',{status:'provisional',source:'tmdb',value:'X'}),sourceRow('film:h1','tmdb','Y')].join('\n'));
 const {result}=await run(file);
 assert.equal(result.facts.get('film:h1').localization.status,'unavailable','no localization fact under a held identity');
 assert.deepEqual([byKey(result)['film:h1/localization'].class,byKey(result)['film:h1/localization'].proof],['control','unavailable']);
}
{
 const file=database();
 sqlite(file,[
  filmRow('film:u1'),claim('film:u1','tmdb',61),claim('film:u1','letterboxd','lidU1'),print('tmdb_61'),pointer('tmdb_61'),meta('film:u1'),
  dim('film:u1','identity',{status:'legacy_custom'}),dim('film:u1','metadata',{status:'legacy_custom'}),
  dim('film:u1','localization',{status:'provisional',authority:'owner',source:'owner',value:'Владелец'}),sourceRow('film:u1','tmdb','Авто'),
  dim('film:u1','fingerprint',{status:'legacy_custom'}),dim('film:u1','prediction',{provenance_json:'{bad'}),
  filmRow('film:u2'),claim('film:u2','tmdb',62),print('tmdb_62'),pointer('tmdb_62'),meta('film:u2'),
  dim('film:u2','metadata',{provenance_json:'[1]'}),dim('film:u2','fingerprint'),dim('film:u2','prediction'),
  dim('film:u2','localization',{status:'provisional',authority:'dictionary',source:'tmdb',value:'Авто'}),sourceRow('film:u2','tmdb','Авто'),
  filmRow('film:u3'),claim('film:u3','tmdb',63),print('tmdb_63'),dim('film:u3','fingerprint'),dim('film:u3','prediction'),
 ].join('\n'));
 const {result}=await run(file,{coverage:id=>id==='film:u2'?{status:'complete'}:{status:'incomplete',reason:'seed_absent_unproved'}});
 const rows=byKey(result);
 for(const dimension of ['identity','metadata','fingerprint'])assert.deepEqual([rows['film:u1/'+dimension].class,rows['film:u1/'+dimension].reasons],['unknown_legacy',['unknown_status']],dimension);
 assert.deepEqual([rows['film:u1/prediction'].class,rows['film:u1/prediction'].reasons],['unknown_legacy',['malformed_provenance']]);
 assert.deepEqual([rows['film:u2/metadata'].class,rows['film:u2/metadata'].reasons],['unknown_legacy',['malformed_provenance']],'a non-object provenance is ambiguous');
 assert.deepEqual([rows['film:u1/localization'].class,rows['film:u1/localization'].reasons],['unknown_legacy',['owner_authority_not_reviewed']],'an owner row never falls to agree or stale_copy');
 assert.equal(result.facts.get('film:u1').localization.resolved.source,'tmdb','the inconsistent owner row is not an automatic candidate');
 assert.deepEqual([rows['film:u2/localization'].class,rows['film:u2/localization'].reasons],['unknown_legacy',['dictionary_authority_not_reviewed']]);
 // Proof: complete coverage and a present state prove; incomplete coverage or a partial state never do.
 assert.deepEqual([rows['film:u2/fingerprint'].proof,rows['film:u2/prediction'].proof],['complete','complete']);
 assert.deepEqual([rows['film:u3/fingerprint'].proof,rows['film:u3/prediction'].proof],['incomplete','incomplete']);
 assert.equal(rows['film:u2/metadata'].proof,'complete');
 assert.equal(classifyRow({film_id:'film:9',dimension:'prediction',status:'current'},{identity:{verdict:'found'},prediction:{prediction:{status:'conflict'},coverage:{status:'complete'}}}).proof,'incomplete','a conflict is never a proof');
 assert.equal(classifyRow({film_id:'film:9',dimension:'metadata',status:'fresh'},{identity:{verdict:'found'},metadata:metadataFacts(null)}).proof,'incomplete','no metadata row: unproved');
}

// 10. Static: inactive. Only the dormant stage-6 retirement module (AIR-666, itself imported by nothing, see its test) imports the reader or its pure half, so the Worker bundle cannot reach it.
{
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&!full.endsWith('film-dimension-parity.js')&&fs.readFileSync(full,'utf8').includes('film-dimension-parity'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers.map(item=>item.replace(/\\/g,'/')),['src/film-dimension-retirement.js'],'only the dormant retirement module imports the parity reader');
 for(const f of ['package.json','wrangler.jsonc','build.mjs'])assert.ok(!fs.readFileSync(f,'utf8').includes('film-dimension-parity'),f+' does not bundle it');
}

fs.rmSync(root,{recursive:true,force:true});

// ADR 0218 D1 (AIR-662): a marked owner projection is a projection of the owner decision, not an independent owner input; an unmarked legacy owner row keeps its control.
{
 const marked={film_id:'film:p',dimension:'localization',status:'reviewed',source:'owner',source_version:'owner_review',provenance_json:'{"authority":"owner","projection":"owner_review","entries":["k"]}',value:'Жара',authority:'owner',updated_at:AT};
 const legacy={...marked,provenance_json:'{"authority":"owner"}'};
 const none=localizationFacts({row:marked,sources:[],ownerValues:[],ownerAvailable:true});
 assert.deepEqual([none.status,none.resolved.tier],['unknown','none'],'the marked row is not an owner input once no entry backs it');
 assert.equal(localizationFacts({row:legacy,sources:[],ownerValues:[],ownerAvailable:true}).resolved.tier,'owner','an unmarked legacy owner row is still the owner');
 const facts=(row,owner)=>({identity:{verdict:'found'},localization:localizationFacts({row,sources:[],ownerValues:owner,ownerAvailable:true})});
 const stale=classifyRow(marked,facts(marked,[]));
 assert.deepEqual([stale.class,stale.reasons],['control',['owner_projection_stale']]);
 const backed=classifyRow(marked,facts(marked,[{value:'Жара'}]));
 assert.deepEqual([backed.class,backed.reasons],['agree',['owner_projection']]);
 const unproved=classifyRow(marked,{identity:{verdict:'found'},localization:localizationFacts({row:marked,sources:[],ownerValues:[],ownerAvailable:false})});
 assert.deepEqual([unproved.class,unproved.reasons],['control',['owner_projection_unproved']]);
 assert.equal(classifyRow(legacy,facts(legacy,[])).reasons[0],'owner_applied');
}

console.log('film-dimension-parity: ok');
