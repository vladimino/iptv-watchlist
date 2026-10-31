// The metadata step's first Film/Person SQL read: a bounded roster for films whose names that step is
// already localizing. Proven rows change only the walk order of credit objects the film already holds.
// Anything else, including a database error, leaves the R2 cache on the same bytes as a Worker with no DB.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {d1Standin} from './d1-standin.mjs';

const NOW=new Date().toISOString();
const EARLIER=new Date(Date.now()-3600000).toISOString();
const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'iptv-metadata-roster-')),'d1.sqlite');
const sqlite=(sql,json=false)=>{const result=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr.trim()||'sqlite failed');return result.stdout;};
for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'])sqlite(fs.readFileSync('migrations/'+name+'.sql','utf8'));
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const rowsOf=lines=>lines.filter(Boolean).join(',\n');

const mann={id:'director/michael-mann',name:'Майкл Манн',original:'Michael Mann'};
const zoe={id:'actor/zoe',name:'Зои',original:'Zoe'};
const pacino={id:'actor/al-pacino',name:'Аль Пачино',original:'Al Pacino'};
const film=(id,extra={})=> ({id,url:'https://letterboxd.com/film/'+id+'/',title:id,original:id,year:1995,metadataAt:NOW,synopsisFetchedAt:NOW,peopleVersion:1,peopleNamesVersion:1,directors:[structuredClone(mann)],actors:[structuredClone(zoe),structuredClone(pacino)],...extra});
const heat=film('heat',{tmdbId:'949'});
const lag=film('lag',{tmdbId:'948'});
const gone=film('gone');
const tv=film('tv',{tmdbId:'100'});
const ambiguous=film('amb',{tmdbId:'111'});
const untrusted=film('untrusted');
const jane=film('jane',{directors:[{id:'director/jane',name:'Джейн',original:'Jane Doe'}],actors:[{id:'actor/jane',name:'Джейн',original:'Jane Doe'}]});
const adopt=film('adopt');
const batchFilms=[heat,lag,gone,tv,ambiguous,untrusted,jane,adopt];

const person=(roleId,alias)=>({id:'person:'+roleId,roleId,alias});
const people=[
 person('director/michael-mann','Michael Mann'),person('actor/al-pacino','Al Pacino'),person('actor/zoe','Zoe'),
 person('tmdb_actor/1158','Al Pacino'),person('director/jane','Jane Doe'),person('actor/jane','Jane Doe'),
 person('actor/extra','Extra Person'),person('actor/badname','Other'),
];
const cast=(id,credits)=>credits.map(credit=>({film:id,...credit}));
const shared=id=>cast(id,[{person:'director/michael-mann',role:'director',ordinal:0},{person:'actor/al-pacino',role:'actor',ordinal:0},{person:'actor/zoe',role:'actor',ordinal:1}]);
const credits=[
 ...shared('heat'),{film:'heat',person:'tmdb_actor/1158',role:'actor',ordinal:2},
 ...shared('lag'),...shared('tv'),...shared('amb'),...shared('untrusted'),...shared('adopt'),
 ...shared('bare'),...shared('mismatch'),...shared('nometa'),...shared('conflict'),...shared('renamed'),
 ...shared('badcanon'),...shared('nocanon'),...shared('oldpeople'),
 ...cast('jane',[{person:'director/jane',role:'director',ordinal:0},{person:'actor/jane',role:'actor',ordinal:0}]),
 ...shared('extra'),{film:'extra',person:'actor/extra',role:'actor',ordinal:2},
 {film:'badname',person:'director/michael-mann',role:'director',ordinal:0},{film:'badname',person:'actor/badname',role:'actor',ordinal:0},
 {film:'short',person:'director/michael-mann',role:'director',ordinal:0},
];
const external=[
 ['heat','letterboxd','heat',1,0],['heat','tmdb','949',1,0],
 ['lag','letterboxd','lag',1,0],['lag','tmdb','948',1,0],
 ['tv','letterboxd','tv',1,0],['tv','tmdb','100',0,0],['tv','tmdb_tv','100',1,0],
 ['amb','letterboxd','amb',1,0],['amb','tmdb','111',1,0],['amb','tmdb','222',1,0],
 ['untrusted','letterboxd','untrusted',0,0],
 ['jane','letterboxd','jane',1,0],
 ['adopt','letterboxd','adopt',1,0],['adopt','tmdb','777',1,0],
 ['bare','letterboxd','bare',1,0],['bare','tmdb','301',1,0],
 ['mismatch','letterboxd','mismatch',1,0],['mismatch','tmdb','950',1,0],
 ['nometa','letterboxd','nometa',1,0],
 ['conflict','letterboxd','conflict',1,0],['conflict','tmdb','960',1,1],
 ['renamed','letterboxd','someone-else',1,0],
 ['extra','letterboxd','extra',1,0],['extra','tmdb','961',1,0],
 ['badname','letterboxd','badname',1,0],['badname','tmdb','962',1,0],
 ['short','letterboxd','short',1,0],['short','tmdb','963',1,0],
 ['oldpeople','letterboxd','oldpeople',1,0],['oldpeople','tmdb','964',1,0],
 ['badcanon','letterboxd','badcanon',1,0],['badcanon','tmdb','951',1,0],
 ['nocanon','letterboxd','nocanon',1,0],['nocanon','tmdb','952',1,0],
];
const meta=(id,at,version)=>`(${q('film:'+id)},1,'[]',${version},${q('{}')},${q(at)})`;
sqlite(`
INSERT INTO person (id,role_id,contract_version,updated_at) VALUES
${rowsOf(people.map(item=>`(${q(item.id)},${q(item.roleId)},1,${q(NOW)})`))};
INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES
${rowsOf(people.map(item=>`(${q(item.id)},'name',${q(item.alias)},NULL)`))};
INSERT INTO person_dimension (person_id,dimension,status,value,updated_at) VALUES
(${q('person:actor/al-pacino')},'localization','reviewed',${q('ЧУЖОЕ ИМЯ')},${q(NOW)});
INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES
('film:heat',1,'tmdb:949','Heat',${q(NOW)}),
('film:lag',1,'tmdb:948','Lag',${q(NOW)}),
('film:tv',1,'tmdb_tv:100','Tv',${q(NOW)}),
('film:amb',1,NULL,'Amb',${q(NOW)}),
('film:untrusted',1,NULL,'Untrusted',${q(NOW)}),
('film:jane',1,NULL,'Jane',${q(NOW)}),
('film:adopt',1,'tmdb:777','Adopt',${q(NOW)}),
('film:bare',1,'tmdb:301','Bare',${q(NOW)}),
('film:mismatch',1,'tmdb:950','Mismatch',${q(NOW)}),
('film:nometa',1,NULL,'Nometa',${q(NOW)}),
('film:conflict',1,NULL,'Conflict',${q(NOW)}),
('film:renamed',1,NULL,'Renamed',${q(NOW)}),
('film:extra',1,'tmdb:961','Extra',${q(NOW)}),
('film:badname',1,'tmdb:962','Badname',${q(NOW)}),
('film:short',1,'tmdb:963','Short',${q(NOW)}),
('film:oldpeople',1,'tmdb:964','Old',${q(NOW)}),
('film:badcanon',1,'tmdb:1','Badcanon',${q(NOW)}),
('film:nocanon',1,NULL,'Nocanon',${q(NOW)});
INSERT INTO film_metadata (film_id,schema_version,genres_json,people_version,payload_json,updated_at) VALUES
${meta('heat',NOW,1)},${meta('lag',EARLIER,1)},${meta('tv',NOW,1)},${meta('amb',NOW,1)},${meta('untrusted',NOW,1)},
${meta('jane',NOW,1)},${meta('adopt',NOW,1)},${meta('bare',NOW,1)},${meta('mismatch',NOW,1)},${meta('conflict',NOW,1)},
${meta('renamed',NOW,1)},${meta('extra',NOW,1)},${meta('badname',NOW,1)},${meta('short',NOW,1)},${meta('oldpeople',NOW,2)},
${meta('badcanon',NOW,1)},${meta('nocanon',NOW,1)};
INSERT INTO watchlist_film (film_id,updated_at) VALUES
${rowsOf(['heat','lag','tv','amb','untrusted','jane','adopt','mismatch','nometa','conflict','renamed','extra','badname','short','oldpeople','badcanon','nocanon'].map(id=>`(${q('film:'+id)},${q(NOW)})`))};
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES
${rowsOf(external.map(([id,scheme,value,trusted,conflicting])=>`(${q('film:'+id)},${q(scheme)},${q(value)},${trusted},${conflicting},NULL)`))};
INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES
${rowsOf(credits.map(item=>`(${q('film:'+item.film)},${q('person:'+item.person)},${q(item.role)},${item.ordinal})`))};
`);

const inner=d1Standin(file);
const statements=[];
const db={prepare(sql){const text=sql.trim();if(!/^select\b/i.test(text)||/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(text))throw new Error('roster sql is not a select');statements.push(text);return inner.prepare(sql);}};
const dump=()=>inner.sql("select 'film' t,id a,coalesce(canonical_identity,'') b,updated_at c from film union all select 'meta',film_id,coalesce(cast(people_version as text),''),updated_at from film_metadata union all select 'ext',film_id,scheme||':'||value||':'||trusted||':'||conflicting,'' from film_external_id union all select 'credit',film_id,person_id||':'||role||':'||ordinal,'' from film_person_credit union all select 'alias',person_id,value,'' from person_alias union all select 'dim',person_id,coalesce(value,''),'' from person_dimension union all select 'watch',film_id,'',updated_at from watchlist_film order by 1,2,3");

const hosts=[];
const walks=[];
const env={};
const ctx=vm.createContext({FILM_TITLE_DICTIONARY:[],PERSON_NAME_DICTIONARY:[],env,Response,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,fetch:async url=>{hosts.push(new URL(url).host);return {ok:true,json:async()=>({results:{bindings:[]}}),text:async()=>''};}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8')+'\n'+fs.readFileSync('src/catalog-d1.js','utf8')+'\n'+fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),ctx);
const rosterPeople=ctx.rosterPeople;
ctx.rosterPeople=item=>{const people=rosterPeople(item);if(Array.isArray(item?.rosterOrder))walks.push({film:item.id,ids:people.map(person=>person.id)});return people;};
const roster=(films)=>ctx.d1MetadataSyncRoster({DB:db},films);
const reason=async(item)=>(await roster([item])).get(item.id).reason;
const placeholders=sql=>(sql.match(/\?/g)||[]).length;
const plain=value=>JSON.parse(JSON.stringify(value));

const reasons=await roster([
 heat,lag,gone,tv,ambiguous,untrusted,jane,adopt,
 film('bare',{tmdbId:'301'}),film('mismatch',{tmdbId:'999'}),film('nometa'),film('conflict'),film('renamed'),
 film('extra',{tmdbId:'961'}),film('badname',{tmdbId:'962',actors:[{id:'actor/badname',name:'Зои',original:'Zoe'}]}),
 film('short',{tmdbId:'963',actors:[structuredClone(pacino)]}),film('oldpeople',{tmdbId:'964'}),
 film('badcanon',{tmdbId:'951'}),film('nocanon',{tmdbId:'952'}),
]);
assert.equal(reasons.get('heat').reason,'proven');
assert.deepEqual(plain(reasons.get('heat').order),['director/michael-mann','actor/al-pacino','actor/zoe']);
assert.equal(reasons.get('lag').reason,'lag');
assert.equal(reasons.get('gone').reason,'missing');
assert.equal(reasons.get('tv').reason,'tmdb_tv');
assert.equal(reasons.get('amb').reason,'identity');
assert.equal(reasons.get('untrusted').reason,'identity');
assert.deepEqual(plain(reasons.get('jane').order),['director/jane','actor/jane']);
assert.equal(reasons.get('adopt').reason,'identity');
assert.equal(reasons.get('bare').reason,'not_watchlist');
assert.equal(reasons.get('mismatch').reason,'identity');
assert.equal(reasons.get('nometa').reason,'lag');
assert.equal(reasons.get('conflict').reason,'identity');
assert.equal(reasons.get('renamed').reason,'identity');
assert.equal(reasons.get('extra').reason,'credits');
assert.equal(reasons.get('badname').reason,'credits');
assert.equal(reasons.get('short').reason,'credits');
assert.equal(reasons.get('oldpeople').reason,'lag');
assert.equal(reasons.get('badcanon').reason,'identity');
assert.deepEqual(plain(reasons.get('nocanon').order),['director/michael-mann','actor/al-pacino','actor/zoe']);
assert.equal(statements.length,3);
assert.ok(statements.every(sql=>placeholders(sql)===19));
assert.equal(await reason(film('heat',{tmdbId:'949',peopleVersion:2})),'lag');
assert.equal(await reason(film('heat',{tmdbId:'949',actors:[structuredClone(pacino),structuredClone(pacino)]})),'credits');

const before=statements.length;
const capped=[];
for(let i=0;i<24;i++)capped.push({id:'c'+String(i).padStart(2,'0'),peopleVersion:1,metadataAt:NOW,directors:[],actors:[]});
capped.push(heat);
const cappedVerdicts=await roster(capped);
assert.equal(cappedVerdicts.size,24);
assert.equal(cappedVerdicts.has('heat'),false);
assert.equal(cappedVerdicts.get('c00').reason,'missing');
assert.deepEqual(statements.slice(before).map(placeholders),[24,24,24]);
const quiet=statements.length;
await roster([]);
await roster([{id:'tmdb_5',peopleVersion:1,metadataAt:NOW}]);
await roster([heat,structuredClone(heat)]);
assert.equal(statements.length,quiet+3);
assert.deepEqual(statements.slice(quiet).map(placeholders),[1,1,1]);

const storedOrder=['director/michael-mann','actor/al-pacino','actor/zoe'];
async function sync(database,films){
 const files=new Map();
 const live=films.map(item=>structuredClone(item));
 files.set('metadata.json',Object.fromEntries(live.map(item=>[item.id,structuredClone(item)])));
 files.set('titles.json',{});files.set('people.json',{});
 env.BUCKET={get:async key=>files.has(key)?{json:async()=>structuredClone(files.get(key))}:null,put:async(key,body)=>{files.set(key,JSON.parse(body));}};
 env.DB=database;
 hosts.length=0;walks.length=0;
 const run={runId:'roster',stage:'metadata',watchlist:live,pending:live.map(item=>item.id),cursor:0,remaining:live.length,failures:[]};
 const result=await ctx.metadataSync(env,run);
 return {files,result,hosts:[...hosts],walks:[...walks]};
}
const strip=metadata=>{const copy=structuredClone(metadata);for(const item of Object.values(copy))delete item.peopleLocalizedAt;return copy;};
const snapshot=files=>({metadata:strip(files.get('metadata.json')),people:files.get('people.json'),titles:files.get('titles.json')});
const wikidataOnly=list=>{assert.ok(list.length>0);assert.ok(list.every(host=>host==='query.wikidata.org'));};

const kept=dump();
const withDb=await sync(db,batchFilms);
const withoutDb=await sync(null,batchFilms);
assert.deepEqual(dump(),kept,'the roster select leaves every D1 row where it was');
assert.deepEqual(plain(withDb.result.filmPersonRead),{queried:8,proven:2,fallback:6});
assert.deepEqual(plain(withoutDb.result.filmPersonRead),{queried:0,proven:0,fallback:8,reason:'unbound'});
assert.equal(withDb.result.stage,'epg');assert.equal(withDb.result.failedMetadata,0);assert.equal(withoutDb.result.failedMetadata,0);
assert.deepEqual(snapshot(withDb.files),snapshot(withoutDb.files));
assert.deepEqual(withDb.hosts,withoutDb.hosts);
wikidataOnly(withDb.hosts);wikidataOnly(withoutDb.hosts);
assert.deepEqual(plain(withDb.walks),[
 {film:'heat',ids:storedOrder},{film:'jane',ids:['director/jane','actor/jane']},
 {film:'heat',ids:storedOrder},{film:'jane',ids:['director/jane','actor/jane']},
]);
assert.deepEqual(plain(withoutDb.walks),[]);
const saved=withDb.files.get('metadata.json');
assert.deepEqual(saved.heat.actors.map(person=>person.id),['actor/zoe','actor/al-pacino']);
assert.equal(saved.heat.actors[1].name,'Аль Пачино');
assert.equal(saved.heat.directors[0].name,'Майкл Манн');
assert.equal(Object.hasOwn(saved.heat,'rosterOrder'),false);
assert.equal(saved.adopt.tmdbId,undefined);
assert.equal(saved.jane.tmdbId,undefined);
assert.equal(saved.tv.tmdbId,'100');
const savedText=JSON.stringify(saved)+JSON.stringify(withDb.files.get('people.json'));
assert.equal(savedText.includes('ЧУЖОЕ ИМЯ'),false);
assert.equal(savedText.includes('tmdb_actor'),false);
assert.equal(savedText.includes('rosterOrder'),false);

const broken=await sync({prepare(){throw new Error('d1 down');}},batchFilms);
assert.deepEqual(plain(broken.result.filmPersonRead),{queried:8,proven:0,fallback:8,reason:'error'});
assert.equal(broken.result.stage,'epg');assert.equal(broken.result.failedMetadata,0);
assert.deepEqual(snapshot(broken.files),snapshot(withoutDb.files));
assert.deepEqual(plain(broken.walks),[]);
wikidataOnly(broken.hosts);

const named=await sync(db,[film('heat',{tmdbId:'949',peopleNamesVersion:2})]);
assert.equal(Object.hasOwn(named.result,'filmPersonRead'),false);
assert.equal(named.walks.length,0);
const marked=statements.length;
const skipped=await sync(db,[heat,{id:'tmdb_5',url:'https://letterboxd.com/film/tmdb/',title:'T',original:'T',year:2020,metadataAt:NOW,synopsisFetchedAt:NOW,peopleVersion:1,peopleNamesVersion:1,directors:[],actors:[]}]);
assert.deepEqual(plain(skipped.result.filmPersonRead),{queried:1,proven:1,fallback:1});
assert.deepEqual(statements.slice(marked).map(placeholders),[1,1,1]);
assert.deepEqual(plain(skipped.walks).map(item=>item.film),['heat','heat']);
wikidataOnly(skipped.hosts);

sqlite(`update film_metadata set updated_at=${q(EARLIER)} where film_id='film:heat'`);
assert.equal(await reason(heat),'lag');
sqlite(`update film_external_id set value='not-jane' where film_id='film:jane' and scheme='letterboxd'`);
assert.equal(await reason(jane),'identity');

console.log('Metadata sync D1 roster: proven walk order, fallbacks, cap and unchanged R2 cache passed');
