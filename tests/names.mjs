import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const dictionary=JSON.parse(fs.readFileSync('data/person-names.json','utf8'));
const ctx=vm.createContext({PERSON_NAME_DICTIONARY:dictionary});vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8'),ctx);
assert.equal(dictionary.length,868);assert.equal(dictionary.filter(p=>p.status==='provisional').length,4);
const films=dictionary.map(p=>({actors:[{id:p.id,original:p.original,name:p.original}],directors:[]}));
const result=ctx.reviewedPeople({films});for(let i=0;i<dictionary.length;i++){const p=result.films[i].actors[0];assert.equal(p.name,dictionary[i].name);assert.equal(p.original,dictionary[i].original);assert.equal(p.nameStatus,dictionary[i].status);assert.ok(p.aliases.includes(p.original));}
ctx.reviewedPeople(result);assert.equal(result.films[0].actors[0].aliases.length,1);
const stranger={id:'actor/unrelated',name:dictionary[0].original,original:dictionary[0].original};ctx.applyReviewedPerson(stranger);assert.equal(stranger.name,stranger.original);
const cached=JSON.parse(fs.readFileSync('../sources/cloud-watchlist.json','utf8'));ctx.reviewedPeople(cached);const people=new Map(cached.films.flatMap(f=>[...(f.directors||[]),...(f.actors||[])]).map(p=>[p.id,p]));const missing=[...people.values()].filter(p=>!/[а-яё]/i.test(p.name));assert.equal(missing.length,0,JSON.stringify(missing));console.log('Names verified:',dictionary.length,'mappings;',people.size,'people; zero untranslated names');
