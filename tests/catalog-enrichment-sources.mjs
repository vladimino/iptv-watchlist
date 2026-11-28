// AIR-605: the source fetchers of the Catalog Enrichment Producer (src/catalog-enrichment-sources.js; ADR 0211 decision 2, ADR 0219 decisions 4, 7 and 8). Offline: injected fetch and synthetic pages; no network.
// Covered: the TMDB response (core fields, the complete credits, the typed Russian title from its own translations, an incomplete section), the outcome classes (404 repairable, 403/429/5xx/timeout/network/cooldown transport),
// the shared cooldown (an active one sends no request; a 429 is written; a 404 and a 5xx are not), the Letterboxd agreement contract rule by rule, name-only credits, the hint of a Letterboxd-only page, and Wikidata.
import assert from 'node:assert/strict';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {createCoordinator} from '../src/upstream-cooldown.js';
import * as X from '../src/catalog-enrichment-sources.js';

const res=(status,body='',headers={})=>({status,ok:status>=200&&status<300,headers:{get:name=>headers[String(name).toLowerCase()]??null},text:async()=>body,body:null});
const json=(status,value,headers)=>res(status,JSON.stringify(value),headers);
const fetchOf=routes=>{const calls=[];const impl=async(url,init)=>{calls.push(String(url));const route=routes.find(([match])=>typeof match==='string'?String(url).startsWith(match):match.test(String(url)));if(!route)throw new Error('no route '+url);const out=typeof route[1]==='function'?await route[1](url,init):route[1];if(out instanceof Error)throw out;return out;};impl.calls=calls;return impl;};
const env={TMDB_API_READ_ACCESS_TOKEN:'dummy'};

// ---- TMDB ----
const movie=(over={})=>({id:603,release_date:'1999-03-30',runtime:136,overview:' A hacker. ',poster_path:'/top.jpg',genres:[{id:28,name:'боевик'},{id:878,name:'фантастика'}],
 credits:{cast:[{id:2,name:'B',order:1},{id:1,name:'A',order:0}],crew:[{id:9,name:'D',job:'Director'},{id:8,name:'W',job:'Writer'}]},
 translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица',overview:'Хакер.'}},{iso_639_1:'en',iso_3166_1:'US',data:{title:'The Matrix',overview:'A hacker.'}}]},
 images:{posters:[{iso_639_1:'en',file_path:'/en.jpg',width:1000},{iso_639_1:'ru',file_path:'/ru-small.jpg',width:500},{iso_639_1:'ru',file_path:'/ru.jpg',width:2000},{iso_639_1:null,file_path:'/neutral.jpg',width:3000}]},...over});
{
 const impl=fetchOf([['https://api.themoviedb.org/3/movie/603?'+X.TMDB_DETAIL_QUERY,json(200,movie())]]);
 assert.equal(X.TMDB_DETAIL_QUERY,'language=ru-RU&append_to_response=credits,translations,images&include_image_language=ru,en,null','ONE request shape: Russian first, with the tagged translations and image lists in the same call');
 const answer=await X.fetchTmdb(env,{id:'603',fetchImpl:impl});
 assert.equal(answer.status,'ok');
 assert.deepEqual(answer.fields,{year:1999,runtime:136,synopsis:'Хакер.',poster:'https://image.tmdb.org/t/p/w500/ru.jpg',url:'https://www.themoviedb.org/movie/603',genres:['Боевик','Фантастика']},'the Russian synopsis from the tagged translation, the wider Russian poster, the genres in the EXISTING vocabulary through the id table');
 assert.deepEqual(answer.observation.synopsis,{value:'Хакер.',language:'ru',languageBasis:'explicit',coverage:'verified'});
 assert.deepEqual(answer.observation.poster,{value:'https://image.tmdb.org/t/p/w500/ru.jpg',language:'ru',languageBasis:'explicit',coverage:'verified'},'the value that is written carries its tag');
 assert.deepEqual(answer.observation.genres,{coverage:'verified',value:['Боевик','Фантастика'],ids:['28','878'],unmapped:[]});
 assert.deepEqual(answer.credits.items.map(item=>item.role+':'+item.key),['director:9','actor:1','actor:2'],'every supported credit, directors first, the cast in source order');
 assert.deepEqual(answer.title,{status:'value',value:'Матрица'},'the Russian title comes from the response\'s own translations, with no separate fetch');
 assert.equal(impl.calls.length,1,'one request');
 // no cap on the cast
 const big=movie({credits:{cast:Array.from({length:300},(_,i)=>({id:1000+i,name:'N'+i,order:i})),crew:[]}});
 assert.equal((await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',json(200,big)]])})).credits.items.length,300,'no 10/20/30 cap');
 // an incomplete section is unreadable, never a complete set
 const noCredits=await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',json(200,movie({credits:undefined}))]])});
 assert.deepEqual([noCredits.status,noCredits.credits.status],['ok','unreadable']);
 const noTr=await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',json(200,movie({translations:{}}))]])});
 assert.deepEqual(noTr.title,{status:'unreadable'});
 assert.equal(noTr.observation.synopsis.coverage,'unreadable','a missing translations section is not a verified absence of a synopsis');
 // the response of another movie, or not JSON
 assert.equal((await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',json(200,movie({id:1}))]])})).reason,'unexpected_document');
 assert.equal((await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',res(200,'<html>')]])})).reason,'unparsable_response');
 assert.equal((await X.fetchTmdb(env,{id:'abc'})).reason,'invalid_anchor');
 // the token is sent as a bearer and never anywhere else
 let seen=null;
 await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',(url,init)=>{seen=init;return json(200,movie());}]])});
 assert.equal(seen.headers.authorization,'Bearer dummy');
}
// ---- the appended images payload (ADR 0224): a large realistic response still parses; an oversized one is a repairable failure, never a verified absence ----
{
 const entry=(i,lang)=>({aspect_ratio:0.667,height:3000,iso_639_1:lang,file_path:'/'+'p'.repeat(30)+i+'.jpg',vote_average:5.1,vote_count:12,width:2000});
 const big=movie({images:{backdrops:Array.from({length:300},(_,i)=>({...entry(i,null),aspect_ratio:1.778,height:1080,width:1920})),logos:Array.from({length:60},(_,i)=>entry(1000+i,'en')),posters:[...Array.from({length:150},(_,i)=>entry(i,'en')),...Array.from({length:25},(_,i)=>entry(2000+i,'ru')),...Array.from({length:40},(_,i)=>entry(3000+i,null))]}});
 const withoutImages=JSON.stringify(movie({images:undefined})).length,withImages=JSON.stringify(big).length;
 console.log('AIR-684 payload (synthetic, characters): detail without images '+withoutImages+', a large realistic images section '+withImages+', cap '+3000000);
 assert.ok(withImages<3000000,'a large realistic list stays inside the existing body cap');
 const answer=await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',json(200,big)]])});
 assert.equal(answer.status,'ok');assert.equal(answer.observation.poster.value.includes('/ppp'),true);assert.equal(answer.observation.poster.language,'ru');
 // over the cap: a repairable failure (the body is refused), never read as an absence and never a different request
 const huge=res(200,'x'.repeat(3000001),{});
 const refused=await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',huge]])});
 assert.equal(refused.status,'failed');assert.equal(refused.reason,'unparsable_response');
}
// ---- the Russian-first observation (ADR 0224), through the ONE parser ----
{
 const parse=over=>X.parseTmdb(movie(over),603);
 const tr=(...entries)=>({translations:{translations:entries.map(([lang,region,data])=>({iso_639_1:lang,iso_3166_1:region,data}))}});
 // synopsis: Russian first; a tagged English one only after a VERIFIED Russian absence; the top-level overview is never proof of a language
 assert.deepEqual(parse(tr(['en','US',{overview:'English.'}])).observation.synopsis,{value:'English.',language:'en',languageBasis:'explicit',coverage:'verified'},'Russian verified absent: the explicitly tagged English overview');
 assert.equal(parse(tr(['ru','RU',{overview:'  '}],['en','US',{overview:'E'}])).observation.synopsis.language,'en','an explicitly blank Russian overview is an absence');
 assert.deepEqual(parse(tr(['de','DE',{overview:'Deutsch'}])).observation.synopsis,{value:null,language:null,languageBasis:null,coverage:'absent'},'neither language: a verified absence; the top-level overview is NOT used');
 assert.equal(parse(tr(['ru','RU',{overview:'Один'}],['ru','UA',{overview:'Два'}])).observation.synopsis.value,'Один','several Russian values: the RU region decides');
 assert.equal(parse(tr(['ru','UA',{overview:'Один'}],['ru','BY',{overview:'Два'}])).observation.synopsis.coverage,'ambiguous');
 // MALFORMED is never an absence: a Russian or English entry without a string overview, an entry with no data, a missing or invalid tag
 for(const [name,entries] of [['ru overview is an object',[['ru','RU',{overview:{}}],['en','US',{overview:'E'}]]],['ru overview missing',[['ru','RU',{title:'Т'}],['en','US',{overview:'E'}]]],['en data null',[['ru','RU',{overview:''}],['en','US',null]]],
  ['en overview number',[['ru','RU',{overview:''}],['en','US',{overview:5}]]],['ru data null',[['ru','RU',null]]]])
  assert.equal(parse(tr(...entries)).observation.synopsis.coverage,'unreadable',name+': unreadable, not a verified English fallback or absence');
 assert.equal(parse({translations:{translations:[{iso_639_1:7,iso_3166_1:'RU',data:{overview:'x'}}]}}).observation.synopsis.coverage,'unreadable','an invalid language tag');
 assert.equal(parse({translations:{translations:[{iso_3166_1:'RU',data:{overview:'x'}}]}}).observation.synopsis.coverage,'unreadable','a missing language tag');
 assert.equal(parse({translations:{translations:[null]}}).observation.synopsis.coverage,'unreadable');assert.equal(parse({translations:undefined}).observation.synopsis.coverage,'unreadable');
 assert.equal(parse(tr(['ru','RU',{overview:'x'}])).title.status,'unreadable','the title selector reads a Russian entry without a string title as malformed, never a blank');
 // year and runtime: an EMPTY date and a null or zero runtime are explicit absences; a missing key or a bad shape is unreadable, not a verified null
 assert.deepEqual([parse({release_date:''}).observation.year.coverage,parse({release_date:undefined}).observation.year.coverage,parse({release_date:'x'}).observation.year.coverage],['absent','unreadable','unreadable']);
 assert.deepEqual([parse({runtime:0}).observation.runtime.coverage,parse({runtime:null}).observation.runtime.coverage,parse({runtime:undefined}).observation.runtime.coverage,parse({runtime:'90'}).observation.runtime.coverage],['absent','absent','unreadable','unreadable']);
 // poster: ru, then en, then language-neutral, then the top-level path with no language; wider first, then the path; votes never decide
 assert.equal(parse({}).observation.poster.value,'https://image.tmdb.org/t/p/w500/ru.jpg');
 assert.equal(parse({images:{posters:[{iso_639_1:'ru',file_path:'/b.jpg',width:500,vote_average:1},{iso_639_1:'ru',file_path:'/a.jpg',width:500,vote_average:9}]}}).observation.poster.value,'https://image.tmdb.org/t/p/w500/a.jpg','equal width: the smaller path, whatever the votes');
 assert.deepEqual(parse({images:{posters:[{iso_639_1:'en',file_path:'/en.jpg',width:100},{iso_639_1:null,file_path:'/n.jpg',width:900}]}}).observation.poster,{value:'https://image.tmdb.org/t/p/w500/en.jpg',language:'en',languageBasis:'explicit',coverage:'verified'},'English before language-neutral');
 assert.deepEqual(parse({images:{posters:[{iso_639_1:null,file_path:'/n.jpg',width:900}]}}).observation.poster,{value:'https://image.tmdb.org/t/p/w500/n.jpg',language:null,languageBasis:null,coverage:'verified'},'language-neutral before the top-level path');
 assert.deepEqual(parse({images:{posters:[]}}).observation.poster,{value:'https://image.tmdb.org/t/p/w500/top.jpg',language:null,languageBasis:null,coverage:'verified'},'the top-level path with no language as the last resort, never labelled');
 assert.deepEqual(parse({images:{posters:[{iso_639_1:'fr',file_path:'/top.jpg',width:100}]}}).observation.poster,{value:'https://image.tmdb.org/t/p/w500/top.jpg',language:'fr',languageBasis:'explicit',coverage:'verified'},'the last-resort top-level poster keeps the VERIFIED tag of the image that lists it, whatever the language: never ru or en by guess, never lost');
 assert.equal(parse({images:{posters:[{iso_639_1:'fr',file_path:'/other.jpg',width:100}]}}).observation.poster.language,null,'the same path with no listing is unknown, not tagged');
 assert.equal(parse({images:{posters:[{iso_639_1:'fra',file_path:'/top.jpg',width:100}]}}).observation.poster.language,null,'a tag that is not a two-letter language code is not kept');
 assert.deepEqual(parse({images:{posters:[]},poster_path:null}).observation.poster,{value:null,language:null,languageBasis:null,coverage:'absent'},'an explicit null top-level path with no posters is a verified absence');
 assert.equal(parse({images:{posters:[]},poster_path:undefined}).observation.poster.coverage,'unreadable','a MISSING top-level key is not an absence');assert.equal(parse({images:{posters:[]},poster_path:7}).observation.poster.coverage,'unreadable');
 assert.equal(parse({images:undefined}).observation.poster.coverage,'unreadable');assert.equal(parse({images:undefined}).fields.poster,'https://image.tmdb.org/t/p/w500/top.jpg','an unreadable images section never blocks writing the top-level path');
 assert.equal(parse({images:{posters:[{iso_639_1:'ru',file_path:'/x.jpg'}]}}).observation.poster.coverage,'unreadable','a malformed poster entry');
 const order=parse({images:{posters:[{iso_639_1:'ru',file_path:'/a.jpg',width:1},{iso_639_1:'ru',file_path:'/b.jpg',width:2}]}}).observation.poster.value;
 assert.equal(parse({images:{posters:[{iso_639_1:'ru',file_path:'/b.jpg',width:2},{iso_639_1:'ru',file_path:'/a.jpg',width:1}]}}).observation.poster.value,order,'list order never decides');
 // genres: through the reviewed id table into the existing vocabulary; an unmapped id is a gap, not a label; an empty list differs from a missing one
 assert.deepEqual(parse({genres:[{id:878,name:'x'},{id:28,name:'y'},{id:99999,name:'new'}]}).observation.genres,{coverage:'verified',value:['Боевик','Фантастика'],ids:['28','878','99999'],unmapped:['99999']});
 assert.deepEqual(parse({genres:[]}).observation.genres,{coverage:'verified',value:[],ids:[],unmapped:[]});
 assert.equal(parse({genres:undefined}).observation.genres.coverage,'unreadable');assert.equal(parse({genres:[{id:28},{name:'no id'}]}).observation.genres.coverage,'unreadable');
 // credits: a malformed supported entry makes the section unreadable; another job is not judged; a crew list that names NO recognized director is not a verified set
 assert.equal(parse({credits:{cast:[{id:1},{name:'no id'}],crew:[]}}).credits.status,'unreadable');
 assert.equal(parse({credits:{cast:[{id:1}],crew:[{job:'Director',name:'no id'}]}}).credits.status,'unreadable');
 assert.equal(parse({credits:{cast:[{id:1}],crew:[null]}}).credits.status,'unreadable');
 assert.equal(parse({credits:{cast:[{id:1}],crew:[]}}).credits.status,'ok','no crew at all is an empty crew, not an unrecognized one');
 assert.deepEqual([parse({credits:{cast:[{id:1}],crew:[{id:5,job:'Writer'}]}}).credits.status,parse({credits:{cast:[{id:1}],crew:[{id:5,job:'Writer'}]}}).credits.reason],['unreadable','directors_not_recognized'],'crew with no recognized director is NOT a verified credit set');
 assert.equal(parse({credits:{cast:[{id:1}],crew:[{id:5,job:'Режиссёр'}]}}).credits.items[0].key,'5','the localized job strings of the explicit set are recognized (a recorded ru-RU fixture is still an open acceptance condition)');
 assert.equal(parse({credits:{cast:[{id:1}],crew:[{id:5,job:'Director'},{id:6,job:'Editor'}]}}).credits.status,'ok','another job beside a recognized director is not judged');
}
// ---- outcome classes ----
{
 const cls=async status=>{const a=await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',res(status)]])});return [a.status,a.reason];};
 assert.deepEqual(await cls(404),['failed','not_found'],'a 404 is availability (repairable), never identity');
 assert.deepEqual(await cls(410),['failed','not_found']);
 assert.deepEqual(await cls(403),['transport','forbidden']);
 assert.deepEqual(await cls(429),['transport','rate_limited']);
 assert.deepEqual(await cls(503),['transport','upstream_5xx']);
 assert.deepEqual(await cls(418),['failed','unexpected_status']);
 const timeout=await X.fetchTmdb(env,{id:'603',timeoutMs:20,fetchImpl:(url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))))});
 assert.deepEqual([timeout.status,timeout.reason,timeout.kind],['transport','timeout','timeout']);
 const net=await X.fetchTmdb(env,{id:'603',fetchImpl:async()=>{throw new TypeError('fetch failed');}});
 assert.deepEqual([net.status,net.reason],['transport','network_error']);
}
// ---- the shared cooldown ----
{
 const file=migrated();
 const sql=text=>{const r=sqliteSync(['-bail',file],{input:text,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);};
 const db={DB:d1Standin(file)};
 sql("INSERT INTO upstream_coordination (id,mode,revision,updated_at) VALUES (1,'enforce',1,0);");
 const coordinator=()=>createCoordinator(db,{caller:'catalog_enrichment'});
 const limited=fetchOf([['https://api',res(429,'',{'retry-after':'120'})]]);
 const first=await X.fetchTmdb(env,{id:'603',fetchImpl:limited,coordinator:coordinator()});
 assert.deepEqual([first.status,first.reason],['transport','rate_limited']);
 assert.equal(limited.calls.length,1);
 const skipped=fetchOf([['https://api',json(200,movie())]]);
 const gated=await X.fetchTmdb(env,{id:'603',fetchImpl:skipped,coordinator:coordinator()});
 assert.deepEqual([gated.status,gated.reason,gated.kind],['transport','upstream_cooldown','cooldown'],'an active cooldown is a transport outcome: no request is sent');
 assert.equal(skipped.calls.length,0);
 assert.ok(gated.cooldownUntil,'the answer carries the end of the cooldown for retry_at');
 // a cooldown of one scope never blocks another
 const wd=fetchOf([['https://query.wikidata.org',json(200,{results:{bindings:[]}})]]);
 assert.equal((await X.fetchWikidata(env,{tmdbId:'603',fetchImpl:wd,coordinator:coordinator()})).status,'ok');
 assert.equal(wd.calls.length,1,'the tmdb cooldown does not block wikidata');
 // a 404 and a 5xx write no cooldown
 const other=migrated();
 const db2={DB:d1Standin(other)};sqliteSync(['-bail',other],{input:"INSERT INTO upstream_coordination (id,mode,revision,updated_at) VALUES (1,'enforce',1,0);"});
 for(const status of [404,500])await X.fetchTmdb(env,{id:'603',fetchImpl:fetchOf([['https://api',res(status)]]),coordinator:createCoordinator(db2,{caller:'catalog_enrichment'})});
 assert.equal(JSON.parse(String(sqliteSync(['-json',other],{input:'SELECT COUNT(*) AS n FROM upstream_cooldown;',encoding:'utf8'}).stdout))[0].n,0,'a 404 and a 5xx never set the shared cooldown');
}
// ---- Wikidata ----
{
 const q=bindings=>fetchOf([['https://query.wikidata.org/sparql?format=json&query=',json(200,{results:{bindings}})]]);
 const label=value=>({label:{value}});
 assert.deepEqual((await X.fetchWikidata(env,{tmdbId:'603',fetchImpl:q([label('Матрица')])})).title,{status:'value',value:'Матрица'});
 assert.deepEqual((await X.fetchWikidata(env,{tmdbId:'603',fetchImpl:q([])})).title,{status:'absent'});
 assert.deepEqual((await X.fetchWikidata(env,{tmdbId:'603',fetchImpl:q([label('А'),label('Б')])})).title,{status:'ambiguous'});
 assert.equal((await X.fetchWikidata(env,{tmdbId:'603',fetchImpl:fetchOf([['https://query',json(200,{})]])})).reason,'unexpected_document');
 const impl=q([]);await X.fetchWikidata(env,{tmdbId:'603',fetchImpl:impl});
 assert.ok(decodeURIComponent(impl.calls[0]).includes('wdt:P4947 "603"'),'keyed by the TMDB id (P4947)');
 // AIR-696: the request names its client (Wikimedia User-Agent policy) and still asks for SPARQL JSON
 let seen=null;
 await X.fetchWikidata(env,{tmdbId:'603',fetchImpl:async(url,init)=>{seen=init.headers;return json(200,{results:{bindings:[]}});}});
 assert.equal(seen['user-agent'],X.WIKIDATA_USER_AGENT);assert.match(seen['user-agent'],/^WatchlistAirtime\/\d/);
 assert.equal(seen.accept,'application/sparql-results+json');
 // a 403 stays a transport outcome (no failure, no fabricated title)
 const forbidden=await X.fetchWikidata(env,{tmdbId:'603',fetchImpl:fetchOf([['https://query',res(403)]])});
 assert.deepEqual([forbidden.status,forbidden.reason],['transport','forbidden']);assert.equal(forbidden.title,undefined);
}
// ---- Letterboxd ----
// The injected page tools: a toy of the Worker's scoped parseFilm over synthetic pages.
const attr=(tag,name)=>new RegExp(name+'="([^"]*)"').exec(tag)?.[1]??'';
const extractYear=text=>/\((\d{4})\)/.exec(String(text))?.[1]?Number(/\((\d{4})\)/.exec(String(text))[1]):null;
const parseFilm=html=>{
 const ld=/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
 if(!ld)throw new Error('Film metadata missing');
 const meta=JSON.parse(ld[1]);
 const person=(list,role)=>(list||[]).map(item=>{const slug=/\/(?:actor|director)\/([a-z0-9-]+)\//.exec(item.url||'')?.[1];return {id:role+'/'+(slug||item.name),original:item.name,name:item.name};});
 return {creditsComplete:true,original:meta.name,aliases:[meta.name],tmdbId:/data-tmdb-id="(\d+)"/.exec(html)?.[1]||null,year:meta.year??null,runtime:meta.runtime??null,synopsis:meta.description??null,poster:meta.image??null,genres:meta.genre||[],directors:person(meta.director,'director'),actors:person(meta.actor,'actor')};
};
const tools={parseFilm,attr,extractYear};
const page=({code='abc',canonical='/film/the-matrix/',tmdb=['603'],type='movie',shortlink=true,actors=[{name:'Neo Actor',url:'/actor/neo-actor/'},{name:'No Link'}]}={})=>`<html><head>${shortlink?`<link rel="shortlink" href="https://boxd.it/${code}">`:''}${canonical?`<link rel="canonical" href="https://letterboxd.com${canonical}">`:''}<meta property="og:title" content="The Matrix (1999)"><script type="application/ld+json">${JSON.stringify({name:'The Matrix',year:1999,runtime:136,description:'lb synopsis',image:'https://img/p.jpg',genre:['Sci-Fi'],director:[{name:'Lana',url:'/director/lana/'}],actor:actors})}</script></head><body>${tmdb.map(id=>`<div data-tmdb-id="${id}" data-tmdb-type="${type}"></div>`).join('')}</body></html>`;
const lb=(body,{status=200,redirect='https://letterboxd.com/film/the-matrix/',headers={}}={})=>fetchOf([['https://boxd.it/abc',redirect?res(301,'',{location:redirect}):res(status,body,headers)],['https://letterboxd.com/film/the-matrix/',res(status,body,headers)]]);
{
 const impl=lb(page());
 const a=await X.fetchLetterboxd(env,{lid:'abc',tmdbAnchor:'603',fetchImpl:impl,tools});
 assert.equal(a.status,'ok');assert.equal(a.agreed,true);
 assert.deepEqual(impl.calls,['https://boxd.it/abc','https://letterboxd.com/film/the-matrix/'],'boxd.it/<lid> and at most one redirect to the film page');
 assert.equal(a.fields.year,1999);assert.equal(a.fields.url,'https://letterboxd.com/film/the-matrix/');assert.deepEqual(a.fields.genres,['Sci-Fi']);
 assert.deepEqual(a.credits.items.map(item=>item.role+':'+(item.key??'NAME')+':'+!!item.nameOnly),['director:lana:false','actor:neo-actor:false','actor:NAME:true'],'a credit without a person slug is name-only, never keyed by its name');
 assert.deepEqual(a.title,{status:'unsupported'},'a Letterboxd page has no typed title: unsupported coverage, not a verified absence');
 // the contract, rule by rule: any failing rule on a 200 page is a disagreement (owner only), not a failure
 const rule=async (over,tmdbAnchor='603',extra={})=>X.fetchLetterboxd(env,{lid:'abc',tmdbAnchor,fetchImpl:lb(page(over),extra),tools});
 for(const [name,over,reason] of [['shortlink of another lid',{code:'zzz'},'shortlink_mismatch'],['canonical elsewhere',{canonical:'/film/other/'},'canonical_mismatch'],['another TMDB id',{tmdb:['604']},'tmdb_differs'],['no TMDB id',{tmdb:[]},'tmdb_missing'],['two TMDB ids',{tmdb:['603','604']},'tmdb_multiple'],['a tv entity',{type:'tv'},'tmdb_not_movie']]){
  const answer=await rule(over);
  assert.equal(answer.status,'disagreement',name);assert.ok(answer.reasons.includes(reason),name+': '+answer.reasons);
 }
 assert.equal((await rule({shortlink:false})).status,'ok','no shortlink: the redirect from boxd.it/<lid> is the link');
 // a Letterboxd-only Film (no TMDB anchor) needs no TMDB id; one on the page is a hint, never a claim
 const only=await rule({tmdb:['603']},null);
 assert.equal(only.status,'ok');assert.deepEqual(only.hints,[{kind:'page_tmdb_id',values:['603']}]);
 assert.equal((await rule({tmdb:[]},null)).status,'ok','a Letterboxd-only Film without a page TMDB id still agrees');
 // failures and transport
 assert.deepEqual([(await X.fetchLetterboxd(env,{lid:'abc',fetchImpl:fetchOf([['https://boxd.it/abc',res(404)]]),tools})).status,(await X.fetchLetterboxd(env,{lid:'abc',fetchImpl:fetchOf([['https://boxd.it/abc',res(404)]]),tools})).reason],['failed','not_found'],'a 404 grants no fallback and is not a disagreement');
 assert.equal((await X.fetchLetterboxd(env,{lid:'abc',fetchImpl:lb('',{status:403,redirect:null}),tools})).status,'transport');
 const challenge=await X.fetchLetterboxd(env,{lid:'abc',fetchImpl:lb('<title>Just a moment...</title>',{redirect:null}),tools});
 assert.deepEqual([challenge.status,challenge.reason],['transport','challenge'],'a challenge behind a 200 is a blocked answer, never a page');
 assert.equal((await X.fetchLetterboxd(env,{lid:'abc',fetchImpl:lb('<html>not a film</html>'),tools})).status,'failed','a page that does not parse as a film is an invalid page');
 assert.equal((await X.fetchLetterboxd(env,{lid:'abc',fetchImpl:lb(page(),{redirect:'https://evil.example/film/x/'}),tools})).reason,'unexpected_redirect','a redirect off letterboxd.com is refused');
 assert.equal((await X.fetchLetterboxd(env,{lid:'a/b',fetchImpl:lb(page()),tools})).reason,'invalid_anchor');
 assert.equal((await X.fetchLetterboxd(env,{lid:'abc',fetchImpl:lb(page())})).reason,'invalid_anchor','page tools are required');
 // agreement as a pure function
 assert.deepEqual(X.agreement({lid:'abc',evidence:{kind:'unparsable_page'},tmdbAnchor:null}),{agreed:false,reasons:['unparsable_page']});
}
console.log('catalog enrichment sources: ok');
