// AIR-290: a TMDB TV entry is a typed `tmdb_tv` identity, and an owner-confirmed retired TMDB movie id leaves the Film's
// trusted identity without being deleted. Synthetic records and a sqlite3 D1 stand-in only; no network, R2 or production D1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CONFIRMED_RETIREMENTS,RETIREMENTS_KEY,buildPlan,d1Expected,d1Holders,d1Readback,d1State,loadDomain,r2References,sqliteReader} from '../scripts/tmdb-tv-identity-plan.mjs';

// Offline only: the domain file stays out of the Worker bundle, and the planner neither requests nor writes.
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/tmdb-tv-identity/);
const planner=fs.readFileSync('scripts/tmdb-tv-identity-plan.mjs','utf8');
assert.doesNotMatch(planner,/\bfetch\(|\bBUCKET\b|writeFile\(.*objects|\.transaction\(|\.run\(|\b(INSERT|UPDATE|DELETE|REPLACE)\b/,'the planner writes no statement and makes no request: D1 follows R2 through the projector');
assert.doesNotMatch(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),/\bfetch\b|\benv\./);

const domain=loadDomain();
const {readLifecycle,linkFilms,letterboxdTmdbLink,tmdbRetirement,applyTmdbRetirement,tmdbTvCollisions,TMDB_TV_SCHEME,TMDB_RETIRED_STATUS}=domain;
const plain=value=>JSON.parse(JSON.stringify(value));
const AT='2026-10-30T12:00:00.000Z',NOW=Date.parse(AT);
assert.equal(TMDB_TV_SCHEME,'tmdb_tv');

// 1. The Letterboxd TMDB link: the visible link, compared with the attributes, never the attributes alone.
const page=(attrs,...links)=>attrs+links.map(link=>`<a href="https://www.themoviedb.org/${link}/" class="micro-button">TMDB</a>`).join('');
const MINISERIES=page('<body data-tmdb-type="movie" data-tmdb-id="17266">','tv/9687');
let link=letterboxdTmdbLink(MINISERIES);
assert.deepEqual(plain(link),{status:'review',reason:'link_disagrees_with_attributes',link:{type:'tv',id:'9687'},links:[{type:'tv',id:'9687'}],attributes:{types:['movie'],ids:['17266']}});
assert.deepEqual(plain(letterboxdTmdbLink(page('<body data-tmdb-type="movie" data-tmdb-id="949">','movie/949','movie/949'))).status,'resolved','one link repeated is one link');
assert.deepEqual(plain(letterboxdTmdbLink(page('<body data-tmdb-type="tv" data-tmdb-id="1457">','tv/1457'))).link,{type:'tv',id:'1457'});
for(const [html,status,reason] of [
 ['<body data-tmdb-type="movie" data-tmdb-id="949">','unresolved','no_tmdb_link'],
 [page('<body data-tmdb-type="movie" data-tmdb-id="949">','movie/949','tv/949'),'review','multiple_tmdb_links'],
 [page('<body data-tmdb-type="movie" data-tmdb-id="949"><i data-tmdb-id="950">','movie/949'),'review','contradictory_attributes'],
 [page('<body>','tv/1457'),'review','attributes_missing'],
 ['<p>see https://www.themoviedb.org/tv/1457/ for details</p><body data-tmdb-type="tv" data-tmdb-id="1457">','unresolved','no_tmdb_link'],
 ['<body data-tmdb-type="tv" data-tmdb-id="1457"><a href="http://www.themoviedb.org/tv/1457/">TMDB</a>','unresolved','no_tmdb_link'],
 [null,'unresolved','no_tmdb_link'],
 ['<body data-tmdb-type="tv" data-tmdb-id="1457"><link rel="alternate" href="https://www.themoviedb.org/tv/1457/">','unresolved','no_tmdb_link'],
 ['<body data-tmdb-type="tv" data-tmdb-id="1457"><div data-url="x" href="https://www.themoviedb.org/tv/1457/"></div>','unresolved','no_tmdb_link'],
 ['<body data-tmdb-type="tv" data-tmdb-id="1457"><area href="https://www.themoviedb.org/tv/1457/">','unresolved','no_tmdb_link']
]){const out=letterboxdTmdbLink(html);assert.deepEqual([out.status,out.reason],[status,reason],String(html));}
assert.equal(letterboxdTmdbLink(page('<b data-tmdb-type="tv" data-tmdb-id="1457">','tv/1457?language=ru')).status,'resolved');
assert.equal(letterboxdTmdbLink('<b data-tmdb-type="tv" data-tmdb-id="1457"><a class="micro-button" target="_blank" href="https://www.themoviedb.org/tv/1457/">TMDB</a>').status,'resolved','attributes before href');

// 2. A retirement is checked field by field and names exactly one Film.
const EVIDENCE={movieStatus:404,movieCheckedAt:'2026-10-30T09:44:03.540Z',letterboxdUrl:'https://letterboxd.com/film/the-odyssey/',link:'tv/9687',linkCheckedAt:'2026-10-30T10:33:04.632Z',tvResponseId:'9687',tvCheckedAt:'2026-10-30T10:15:00.000Z'};
const CONFIRMATION={by:'owner',at:'2026-10-30',source:'https://trello.com/c/EswNQuv8'};
const ENTRY={filmId:'film:1IUo',lid:'1IUo',movieId:'17266',tvId:'9687',evidence:EVIDENCE,confirmation:CONFIRMATION};
const retirement=tmdbRetirement(ENTRY);
assert.equal(retirement.ok,true);
for(const [patch,reason] of [
 [{filmId:'film:other'},'film_id'],[{lid:'../x'},'lid'],[{movieId:'0'},'movie_id'],[{tvId:'x'},'tv_id'],
 [{evidence:{...EVIDENCE,movieStatus:200}},'movie_404'],[{evidence:{...EVIDENCE,letterboxdUrl:'https://www.themoviedb.org/tv/9687'}},'letterboxd_url'],
 [{evidence:{...EVIDENCE,link:'tv/9688'}},'letterboxd_link'],[{evidence:{...EVIDENCE,link:'movie/9687'}},'letterboxd_link'],[{evidence:{...EVIDENCE,tvResponseId:'1'}},'tv_entry'],
 [{confirmation:{...CONFIRMATION,by:'agent'}},'owner_confirmation'],[{confirmation:null},'owner_confirmation']
]){const out=tmdbRetirement({...ENTRY,...patch});assert.equal(out.ok,false);assert.ok(out.reasons.includes(reason),reason+' '+out.reasons);}

// 3. Applying it to the Film as the lifecycle reader builds it. Movie 9687 is an unrelated catalog Film (the namespaces
// reuse numbers), and a catalog record still showing the retired movie 17266 exists.
const fresh='2026-10-29T00:00:00.000Z';
const store=()=>({
 watchlist:{films:[
  {id:'1IUo',title:'The Odyssey',original:'The Odyssey',year:1997,tmdbId:'17266',url:'https://letterboxd.com/film/the-odyssey/'},
  {id:'zz01',title:'Other',original:'Other',tmdbId:'500',url:'https://letterboxd.com/film/other/'}
 ]},
 programme:null,metadata:{'1IUo':{tmdbId:'17266',title:'The Odyssey',original:'The Odyssey'}},titles:{'1IUo':{tmdbId:'17266',title:'Одиссей'}},people:{},filmTitles:[],personNames:[],personOverrides:{},sync:{failures:[]},
 discoveryResolution:{'c1':{status:'verified',tmdbId:'9687',filmId:'tmdb_9687'}},
 discoveredFilms:{tmdb_9687:{id:'tmdb_9687',tmdbId:'9687',title:'Movie 9687',original:'Movie 9687',discoveredAt:fresh,directors:[],actors:[]}},
 fingerprints:{'1IUo':{fingerprintSchemaVersion:1,invalidatedAt:null,generatedAt:fresh,fingerprintHash:'print-a'}},
 predictions:{'1IUo':{current:{tasteProfileVersion:3,tasteProfileHash:'profile-a',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4}}},
 profile:{version:3,profileHash:'profile-a'}
});
const view=readLifecycle(store(),NOW);
const odyssey=view.films.find(film=>film.id==='film:1IUo'),movie9687=view.films.find(film=>film.id==='film:tmdb:9687');
assert.ok(odyssey&&movie9687);
assert.equal(odyssey.canonicalIdentity,'tmdb:17266');
const applied=applyTmdbRetirement(plain(odyssey),retirement.retirement,AT);
assert.equal(applied.ok,true);assert.equal(applied.changed,true);
const corrected=applied.film;
assert.equal(corrected.canonicalIdentity,'tmdb_tv:9687');
assert.deepEqual(plain(corrected.externalIds.map(item=>[item.scheme,item.value,item.trusted,item.conflicting])),plain(odyssey.externalIds.flatMap(item=>item.scheme==='tmdb'?[['tmdb','17266',false,false],['tmdb_tv','9687',true,false]]:[[item.scheme,item.value,item.trusted,item.conflicting]])));
const retired=corrected.externalIds.find(item=>item.scheme==='tmdb');
assert.deepEqual(plain(retired.provenance),{status:TMDB_RETIRED_STATUS,reason:'tmdb_movie_404',replacement:{scheme:'tmdb_tv',value:'9687'},evidence:EVIDENCE,confirmation:CONFIRMATION,previous:odyssey.externalIds.find(item=>item.scheme==='tmdb').provenance??null});
assert.deepEqual(plain(corrected.externalIds.find(item=>item.scheme==='tmdb_tv').provenance),{source:'letterboxd_tmdb_link',url:EVIDENCE.letterboxdUrl,link:'tv/9687',checkedAt:EVIDENCE.linkCheckedAt,confirmation:CONFIRMATION});
assert.deepEqual([corrected.identity.status,corrected.identity.sourceVersion,corrected.identity.provenance.tmdbTvId,corrected.identity.provenance.retiredTmdbId],['resolved','tmdb_tv:9687','9687','17266']);
// Everything but the identity is the Film as it was: id, aliases, localization, fingerprint, prediction, history, redirects.
const rest=film=>plain({...film,externalIds:null,canonicalIdentity:null,identity:null});
assert.deepEqual(rest(corrected),rest(odyssey));
// Idempotent: the corrected Film is returned unchanged.
const again=applyTmdbRetirement(plain(corrected),retirement.retirement,'2026-11-01T00:00:00.000Z');
assert.deepEqual([again.ok,again.changed],[true,false]);assert.deepEqual(plain(again.film),plain(corrected));
// Refused, not repaired: another Film, another lid, another movie id, a conflict, a different or half-applied TV id.
const refuse=(film,reason,entry=retirement.retirement)=>{const out=applyTmdbRetirement(film,entry,AT);assert.deepEqual([out.ok,out.reason],[false,reason]);};
refuse(plain(movie9687),'film_mismatch');
refuse({...plain(odyssey),externalIds:odyssey.externalIds.map(item=>item.scheme==='letterboxd'?{...item,value:'9999'}:item)},'lid_mismatch');
refuse({...plain(odyssey),externalIds:odyssey.externalIds.map(item=>item.scheme==='tmdb'?{...item,value:'17267'}:item)},'movie_id_mismatch');
refuse({...plain(odyssey),externalIds:[...odyssey.externalIds.map(item=>item.scheme==='tmdb'?{...item,conflicting:true,trusted:false}:item),{scheme:'tmdb',value:'1',trusted:false,conflicting:true}]},'conflicting_tmdb');
refuse({...plain(odyssey),externalIds:[...plain(odyssey.externalIds),{scheme:'tmdb_tv',value:'1',trusted:true,conflicting:false}]},'tv_id_mismatch');
refuse({...plain(odyssey),externalIds:[...plain(odyssey.externalIds),{scheme:'tmdb_tv',value:'9687',trusted:true,conflicting:false}]},'partial_correction');
refuse({...plain(odyssey),identity:{...odyssey.identity,status:'ambiguous'}},'identity_not_resolved');
// Only an exact correction is a no-op: each missing or different piece of it is refused as partial, never taken as done.
const tamper=(change)=>{const film=plain(corrected);change(film);return film;};
const entry=(film,scheme)=>film.externalIds.find(item=>item.scheme===scheme);
for(const [label,change] of [
 ['tv confirmation missing',film=>{delete entry(film,'tmdb_tv').provenance.confirmation;}],
 ['tv provenance null',film=>{entry(film,'tmdb_tv').provenance=null;}],
 ['tv untrusted',film=>{entry(film,'tmdb_tv').trusted=false;}],
 ['retired evidence changed',film=>{entry(film,'tmdb').provenance.evidence={...EVIDENCE,link:'tv/1'};}],
 ['retired confirmation missing',film=>{delete entry(film,'tmdb').provenance.confirmation;}],
 ['retired previous missing',film=>{delete entry(film,'tmdb').provenance.previous;}],
 ['retired status only',film=>{entry(film,'tmdb').provenance={status:TMDB_RETIRED_STATUS};}],
 ['identity source version',film=>{film.identity.sourceVersion='tmdb:17266';}],
 ['identity provenance missing tv',film=>{delete film.identity.provenance.tmdbTvId;}],
 ['identity provenance null',film=>{film.identity.provenance=null;}],
 ['canonical identity',film=>{film.canonicalIdentity='tmdb:17266';}],
 ['tv row without retirement',film=>{const movie=entry(film,'tmdb');movie.trusted=true;movie.provenance=null;film.canonicalIdentity='tmdb:17266';}],
 ['retired row without tv',film=>{film.externalIds=film.externalIds.filter(item=>item.scheme!=='tmdb_tv');}]
]){const out=applyTmdbRetirement(tamper(change),retirement.retirement,AT);assert.deepEqual([out.ok,out.reason],[false,'partial_correction'],label);}
// Key order of a stored provenance does not matter.
assert.equal(applyTmdbRetirement(tamper(film=>{const tv=entry(film,'tmdb_tv');tv.provenance=Object.fromEntries(Object.entries(tv.provenance).reverse());}),retirement.retirement,AT).changed,false);

// 4. Linking: equal numbers in the two schemes never link. Before the correction a catalog record of the retired movie
// would have joined the Film; after it, the retired id is evidence only.
const linked=linkFilms(plain(corrected),plain(movie9687),AT);
assert.deepEqual([linked.ok,linked.reason],[false,'identity_collision']);
const catalog17266={...plain(movie9687),id:'film:tmdb:17266',canonicalIdentity:'tmdb:17266',externalIds:[{scheme:'tmdb',value:'17266',trusted:true,conflicting:false,provenance:null}]};
assert.equal(linkFilms(plain(odyssey),plain(catalog17266),AT).ok,true,'the uncorrected Film still trusts the retired movie id');
assert.deepEqual(plain(linkFilms(plain(corrected),plain(catalog17266),AT)).reason,'unverified');
let collisions=tmdbTvCollisions([corrected,movie9687]);
assert.deepEqual(plain(collisions),{collisions:[],numericOverlaps:[{value:'9687',tvFilms:['film:1IUo'],movieFilms:['film:tmdb:9687']}]});
collisions=tmdbTvCollisions([corrected,{id:'film:x',externalIds:[{scheme:'tmdb_tv',value:'9687',trusted:true,conflicting:false}]}]);
assert.deepEqual(plain(collisions.collisions),[{scheme:'tmdb_tv',value:'9687',films:['film:1IUo','film:x']}]);

// 5. R2 references: the records that carry either number are listed, the movie id and the overlapping TV number apart.
const refs=r2References(store(),retirement.retirement);
assert.deepEqual(refs.map(ref=>[ref.key,ref.id,ref.kind]).sort(),[
 ['epg/discovered-films.json','tmdb_9687','tv_number'],['epg/discovery-resolution.json','c1','tv_number'],['metadata.json','1IUo','movie'],['titles.json','1IUo','movie'],['watchlist.json','1IUo','movie']].sort());

// 6. The planner over a D1 stand-in and an AIR-286-shaped artifact for the four confirmed Films.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-tmdb-tv-')),file=path.join(root,'d1.sqlite'),artifact=path.join(root,'air286');
const sqlite=(sql,json=false)=>{const r=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const rows=sql=>{const out=sqlite(sql,true).trim();return out?JSON.parse(out):[];};
for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity'])sqlite(fs.readFileSync('migrations/'+name+'.sql','utf8'));
const T='2026-10-29T00:00:00.000Z';
fs.mkdirSync(path.join(artifact,'tmdb'),{recursive:true});
let seed=`INSERT INTO profile_version(version,profile_hash,created_at,r2_key,content_sha256) VALUES(1,'h','${T}','k','s');
INSERT INTO film VALUES('film:tmdb:9687',1,'tmdb:9687','Movie 9687','${T}');
INSERT INTO film_external_id VALUES('film:tmdb:9687','tmdb','9687',1,0,NULL);
INSERT INTO person VALUES('person:actor/a','actor/a',1,'${T}'),('person:tmdb_actor/1','tmdb_actor/1',1,'${T}');\n`;
for(const item of CONFIRMED_RETIREMENTS){
 seed+=`INSERT INTO film VALUES('${item.filmId}',1,'tmdb:${item.movieId}','${item.lid}','${T}');
INSERT INTO film_external_id VALUES('${item.filmId}','letterboxd','${item.lid}',1,0,NULL),('${item.filmId}','tmdb','${item.movieId}',1,0,'{"source":"watchlist"}'),('${item.filmId}','letterboxd_slug','s-${item.lid.toLowerCase()}',0,0,NULL);
INSERT INTO film_dimension(film_id,dimension,status,source,source_version,provenance_json,next_action,updated_at) VALUES('${item.filmId}','identity','resolved','watchlist','tmdb:${item.movieId}','{"letterboxdId":"${item.lid}","tmdbId":"${item.movieId}"}','stop','${T}');
INSERT INTO film_dimension(film_id,dimension,status,value,updated_at) VALUES('${item.filmId}','localization','reviewed','Ru ${item.lid}','${T}');
INSERT INTO watchlist_film VALUES('${item.filmId}','${T}');
INSERT INTO film_person_credit VALUES('${item.filmId}','person:actor/a','actor',0),('${item.filmId}','person:tmdb_actor/1','actor',1);
INSERT INTO prediction_current(film_id,taste_profile_version,predicted_rating,updated_at) VALUES('${item.filmId}',1,4.0,'${T}');
INSERT INTO actual_rating VALUES('${item.filmId}',4.5,'letterboxd','${T}');\n`;
 fs.writeFileSync(path.join(artifact,'tmdb',item.movieId+'.json'),JSON.stringify({tmdbId:item.movieId,kind:'movie',fetchedAt:'2026-10-30T09:44:00.000Z',status:404,letterboxd:{url:item.letterboxdUrl,checkedAt:'2026-10-30T10:33:00.000Z',status:200,links:['tv/'+item.tvId]}}));
 fs.writeFileSync(path.join(artifact,'tmdb','tv-'+item.tvId+'.json'),JSON.stringify({tmdbId:item.tvId,kind:'tv',fetchedAt:'2026-10-30T10:15:00.000Z',response:{id:Number(item.tvId),original_name:'Series '+item.lid}}));
}
seed+=`INSERT INTO film_redirect VALUES('film:old-1IUo','film:1IUo','${T}');`;
sqlite(seed);
const db=sqliteReader(file);
const ids=CONFIRMED_RETIREMENTS.map(item=>item.filmId),numbers=CONFIRMED_RETIREMENTS.flatMap(item=>[item.movieId,item.tvId]);
const snapshotOf=()=>['film','film_external_id','film_dimension','film_person_credit','prediction_current','actual_rating','watchlist_film','film_redirect','person'].map(table=>[table,rows(`select * from ${table}`).map(row=>JSON.stringify(row)).sort()]);
const planOnce=async()=>{const state=await d1State(db,ids);return buildPlan({domain,artifactDir:artifact,films:state.films,holders:await d1Holders(db,numbers),preserved:state.preserved,at:AT});};
const beforeAll=snapshotOf();
let plan=await planOnce();
assert.deepEqual(snapshotOf(),beforeAll,'planning reads only');
assert.deepEqual(plan.totals,{films:4,ready:4,unchanged:0,ownerReview:0,refused:0});
assert.equal(plan.writes,0);assert.equal(plan.requests,0);
const first=plan.films.find(item=>item.filmId==='film:1IUo');
assert.deepEqual([first.old,first.new,first.before.canonicalIdentity,first.after.canonicalIdentity,first.tvName],[{scheme:'tmdb',value:'17266'},{scheme:'tmdb_tv',value:'9687'},'tmdb:17266','tmdb_tv:9687','Series 1IUo']);
assert.deepEqual(plain(first.numericOverlaps),[{value:'9687',tvFilms:['film:1IUo'],movieFilms:['film:tmdb:9687']}]);
assert.deepEqual(first.preserved,{credits:{letterboxd:1,tmdb:1},prediction:1,rating:1,watchlist:1,redirectsTo:1,localization:'Ru 1IUo'});
assert.equal(first.d1Expected.canonicalIdentity,'tmdb_tv:9687');
assert.deepEqual(first.d1Before.externalIds.map(item=>[item.scheme,item.value,item.trusted]),[['tmdb','17266',true]]);
assert.deepEqual(plan.r2Retirements.key,RETIREMENTS_KEY);
assert.deepEqual(plan.r2Retirements.body.retirements.map(entry=>[entry.filmId,entry.movieId,entry.tvId]),CONFIRMED_RETIREMENTS.map(item=>[item.filmId,item.movieId,item.tvId]));
// Before any write the readback finds every Film pending.
assert.deepEqual((await d1Readback(db,plan)).map(item=>item.state),['pending','pending','pending','pending']);

// D1 is written by the ADR 0056 projector, not by this tool. This test-only writer stands in for it and writes the expected
// identity rows: the unique index on trusted ids accepts tmdb_tv 9687 beside the catalog's trusted tmdb 9687, and credits,
// predictions, ratings, redirects and localization stay.
const project=item=>{const e=item.d1Expected,q=v=>v==null?'NULL':"'"+String(v).replace(/'/g,"''")+"'";
 sqlite(`BEGIN;UPDATE film SET canonical_identity=${q(e.canonicalIdentity)} WHERE id=${q(item.filmId)};DELETE FROM film_external_id WHERE film_id=${q(item.filmId)} AND scheme IN ('tmdb','tmdb_tv');
${e.externalIds.map(x=>`INSERT INTO film_external_id VALUES(${q(item.filmId)},${q(x.scheme)},${q(x.value)},${x.trusted?1:0},${x.conflicting?1:0},${q(JSON.stringify(x.provenance))});`).join('\n')}
UPDATE film_dimension SET source_version=${q(e.identity.sourceVersion)},provenance_json=${q(JSON.stringify(e.identity.provenance))} WHERE film_id=${q(item.filmId)} AND dimension='identity';COMMIT;`);};
for(const item of plan.films)project(item);
const afterAll=snapshotOf();
for(const [table,body] of afterAll)if(!['film','film_external_id','film_dimension'].includes(table))assert.deepEqual(body,beforeAll.find(([name])=>name===table)[1],table);
assert.deepEqual(rows(`select id,canonical_identity c from film order by id`).map(row=>[row.id,row.c]),[['film:1IUo','tmdb_tv:9687'],['film:3tCe','tmdb_tv:8042'],['film:daU4','tmdb_tv:64099'],['film:g97G','tmdb_tv:1457'],['film:tmdb:9687','tmdb:9687']]);
assert.deepEqual(rows(`select scheme,value,trusted from film_external_id where film_id='film:1IUo' order by scheme`).map(row=>[row.scheme,row.value,row.trusted]),[['letterboxd','1IUo',1],['letterboxd_slug','s-1iuo',0],['tmdb','17266',0],['tmdb_tv','9687',1]]);
assert.equal(JSON.parse(rows(`select provenance_json p from film_external_id where film_id='film:1IUo' and scheme='tmdb'`)[0].p).previous.source,'watchlist','the replaced provenance is kept');
assert.deepEqual(rows(`select status,source_version v from film_dimension where film_id='film:1IUo' and dimension='identity'`),[{status:'resolved',v:'tmdb_tv:9687'}]);
assert.deepEqual((await d1Readback(db,plan)).map(item=>item.state),['corrected','corrected','corrected','corrected']);
// Idempotent: a new plan finds every Film done, with the same expected state, and the readback agrees.
const replan=await planOnce();
assert.deepEqual(replan.totals,{films:4,ready:4,unchanged:4,ownerReview:0,refused:0});
assert.deepEqual(plain(replan.films.map(item=>item.d1Expected)),plain(plan.films.map(item=>item.d1Expected)));
assert.deepEqual(snapshotOf(),afterAll,'re-planning writes nothing');
// A tampered or partial D1 state is a mismatch in the readback and owner review in a new plan, never a done correction.
sqlite(`UPDATE film_dimension SET provenance_json='{"letterboxdId":"1IUo","tmdbId":"17266"}' WHERE film_id='film:1IUo' AND dimension='identity';`);
assert.equal((await d1Readback(db,plan))[0].state,'mismatch');
assert.deepEqual((await planOnce()).films[0].reasons,['partial_correction']);
sqlite(`UPDATE film_dimension SET provenance_json=${"'"+JSON.stringify(first.d1Expected.identity.provenance)+"'"} WHERE film_id='film:1IUo' AND dimension='identity';
UPDATE film_external_id SET provenance_json='{"source":"letterboxd_tmdb_link"}' WHERE film_id='film:1IUo' AND scheme='tmdb_tv';`);
assert.equal((await d1Readback(db,plan))[0].state,'mismatch');
assert.deepEqual((await planOnce()).films[0].reasons,['partial_correction']);
project(first);
assert.equal((await d1Readback(db,plan))[0].state,'corrected');

// Unexpected state is owner review, never a fix: a second Film already trusting the same TV entry, or still trusting the
// retired movie id; a Film edited to another movie id; and evidence missing from the artifact refuses the retirement.
// (D1's unique index already refuses two trusted rows of one entry; the plan reports it before any write tries.)
sqlite(`UPDATE film SET canonical_identity='tmdb:101915' WHERE id='film:3tCe';UPDATE film_external_id SET trusted=1,provenance_json=NULL WHERE film_id='film:3tCe' AND scheme='tmdb';DELETE FROM film_external_id WHERE film_id='film:3tCe' AND scheme='tmdb_tv';
UPDATE film_dimension SET source_version='tmdb:101915' WHERE film_id='film:3tCe' AND dimension='identity';
INSERT INTO film VALUES('film:x',1,'tmdb_tv:8042','X','${T}');INSERT INTO film_external_id VALUES('film:x','tmdb_tv','8042',1,0,NULL);`);
plan=await planOnce();
assert.deepEqual([plan.films.find(item=>item.filmId==='film:3tCe').status,plan.films.find(item=>item.filmId==='film:3tCe').reasons],['owner_review',['tmdb_tv_collision']]);
assert.equal(plan.r2Retirements.body.retirements.some(entry=>entry.filmId==='film:3tCe'),false,'a Film under review is not in the R2 entry');
sqlite(`DELETE FROM film_external_id WHERE film_id='film:x';DELETE FROM film WHERE id='film:x';`);
// R2 records are not under D1's unique index: a snapshot can show a second Film trusting the retired movie id.
{const state=await d1State(db,ids);plan=buildPlan({domain,artifactDir:artifact,films:state.films,holders:[...await d1Holders(db,numbers),{id:'film:y',externalIds:[{scheme:'tmdb',value:'101915',trusted:true,conflicting:false}]}],preserved:state.preserved,at:AT});}
assert.deepEqual(plan.films.find(item=>item.filmId==='film:3tCe').reasons,['retired_movie_on_other_film']);
sqlite(`UPDATE film_external_id SET value='777' WHERE film_id='film:daU4' AND scheme='tmdb';`);
fs.rmSync(path.join(artifact,'tmdb','tv-1457.json'));
plan=await planOnce();
assert.deepEqual([plan.films.find(item=>item.filmId==='film:daU4').status,plan.films.find(item=>item.filmId==='film:daU4').reasons],['owner_review',['movie_id_mismatch']]);
assert.deepEqual([plan.films.find(item=>item.filmId==='film:g97G').status,plan.films.find(item=>item.filmId==='film:g97G').reasons],['refused',['evidence_tv_entry']]);
// A Film missing from D1 is refused, and only the four confirmed Films are ever planned.
sqlite(`DELETE FROM film_person_credit WHERE film_id='film:1IUo';DELETE FROM prediction_current WHERE film_id='film:1IUo';DELETE FROM actual_rating WHERE film_id='film:1IUo';DELETE FROM watchlist_film WHERE film_id='film:1IUo';DELETE FROM film_redirect WHERE to_film_id='film:1IUo';DELETE FROM film_dimension WHERE film_id='film:1IUo';DELETE FROM film_external_id WHERE film_id='film:1IUo';DELETE FROM film WHERE id='film:1IUo';`);
plan=await planOnce();
assert.deepEqual(plan.films.find(item=>item.filmId==='film:1IUo').reasons,['film_missing']);
assert.deepEqual(plan.films.map(item=>item.filmId),ids);
fs.rmSync(root,{recursive:true,force:true});
console.log('tmdb-tv-identity: ok');
