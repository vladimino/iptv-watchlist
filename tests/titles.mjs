import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const dictionary=JSON.parse(fs.readFileSync('data/film-titles.json','utf8')),watchlist=JSON.parse(fs.readFileSync('../sources/cloud-watchlist.json','utf8')),programme=JSON.parse(fs.readFileSync('../sources/cloud-programme.json','utf8'));
const ctx=vm.createContext({FILM_TITLE_DICTIONARY:dictionary,Response,URL,Date,Map,Set,JSON});vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8')+'\n'+fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),ctx);
assert.equal(dictionary.length,413);assert.equal(new Set(dictionary.map(f=>f.id)).size,413);assert.ok(dictionary.every(f=>f.sources.length&&(/[а-яё]/i.test(f.title)||f.title==='65')));
const translated=ctx.reviewedPeople(structuredClone(watchlist));assert.equal(translated.films.length,watchlist.films.length);
for(let i=0;i<watchlist.films.length;i++){const original=watchlist.films[i],f=translated.films[i];assert.equal(f.original,original.original);assert.ok(f.titleSources.length);assert.ok(f.aliases.includes(original.original));assert.equal(f.title,dictionary.find(d=>d.id===f.id).title);}
for(const [id,title] of [['28nq','Легенда Зорро'],['2FAs','Черное золото'],['27xk','Соблазн'],['sxVa','Икс']]){assert.equal(translated.films.find(f=>f.id===id).title,title);assert.equal(vm.runInContext('eventFilm',ctx)({id,title:'old'}).title,title);}
const merged=ctx.reviewedPeople(ctx.programmeWithWatchlist(programme,watchlist));for(const f of merged.films){assert.equal(f.title,translated.films.find(x=>x.id===f.id).title);}
const wrong={id:'28nq',tmdbId:'9999999',title:'Other'};ctx.applyReviewedTitle(wrong);assert.equal(wrong.title,'Other');
const stranger={id:'different',original:'Original Sin',title:'Original Sin'};ctx.applyReviewedTitle(stranger);assert.equal(stranger.title,'Original Sin');
const repeated=structuredClone(translated);ctx.reviewedPeople(repeated);assert.equal(JSON.stringify(repeated),JSON.stringify(translated));
console.log('All 413 titles verified; originals, aliases, identity guards, scheduled/unscheduled and event titles passed.');
