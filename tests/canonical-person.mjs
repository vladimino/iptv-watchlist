import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {CANONICAL_PERSON_VERSION,PERSON_CANDIDATE_REASONS,PERSON_ISSUES,PERSON_LINK_BASES,canonicalPersons,filmVerified,personFold,personKey,personNames,withVerifiedNames} from '../src/domain/canonical-person.js';

// Offline contract: pure, outside the Worker bundle and every runtime writer (AIR-44).
const source=fs.readFileSync('src/domain/canonical-person.js','utf8');
assert.doesNotMatch(source,/\b(fetch|import|require|BUCKET|wrangler|prepare|Date\.now|new Date|Math\.random)\b/);
for(const file of ['build.mjs','src/worker.js','src/catalog-d1.js','src/d1-enrichment.js','src/canonical-repository.js','src/enrichment-projection.js','public/app.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/canonical-person/,`${file} must not load the AIR-44 contract`);

const plain=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))freeze(item);}return value;};
const person=(id,original,localization=null,extra={})=>({id,original,aliases:[],localization,...extra});
const provisional=value=>({status:'provisional',value,source:'wikidata'});
const dictionary=value=>({status:'reviewed',value,source:'dictionary',provenance:{authority:'dictionary'}});
const owner=value=>({status:'reviewed',value,source:'owner',provenance:{authority:'owner'}});
const film=id=>({id,verified:true});
const credit=(filmId,personId,role='actor')=>({filmId,personId,role});
const humanOf=(model,id)=>model.humans.find(human=>human.memberIds.includes(id));

// Units.
assert.equal(CANONICAL_PERSON_VERSION,1);
assert.deepEqual(PERSON_LINK_BASES,['same_key','owner','co_credit']);
assert.deepEqual(personKey('person:actor/jane-doe'),{source:'letterboxd',key:'jane-doe',role:'actor',node:'letterboxd:jane-doe'});
assert.deepEqual(personKey('person:tmdb_director/11'),{source:'tmdb',key:'11',role:'director',node:'tmdb:11'});
assert.deepEqual(personKey('person:role/Narrator'),{source:null,key:null,role:null,node:'record:person:role/Narrator'});
for(const bad of [null,'','actor/jane','person:writer/x','film:x'])assert.equal(personKey(bad),null);
assert.equal(personFold('  Jürgen  PROCHNOW '),'jurgen prochnow');
assert.equal(personFold('Пётр Фёдоров'),personFold('петр федоров'));
assert.equal(personFold('Jean-Luc'),'jean luc');
assert.deepEqual(personNames(person('person:actor/a','Anna',provisional('Анна'),{aliases:[{kind:'name',value:'Anna'},{kind:'name',value:'Ann'},{kind:'title',value:'X'}]})).map(name=>[name.value,name.origin]),[['Anna','original'],['Ann','alias'],['Анна','localization']]);
assert.deepEqual(personNames(person('person:actor/a','Anna',{status:'missing',value:'Анна'})).map(name=>name.value),['Anna'],'a localization not accepted is not a name');
assert.equal(filmVerified({id:'film:a',verified:true}),true);
assert.equal(filmVerified({id:'film:a',externalIds:[{scheme:'tmdb',value:'5',trusted:true,conflicting:false}]}),true);
assert.equal(filmVerified({id:'film:a',externalIds:[{scheme:'tmdb',value:'5',trusted:false}]}),false,'an untrusted id is not evidence');
assert.equal(filmVerified({id:'film:a',externalIds:[{scheme:'tmdb',value:'5',trusted:true,conflicting:true}]}),false);
assert.equal(filmVerified({id:'film:a',externalIds:[{scheme:'tmdb',value:'5',trusted:true},{scheme:'tmdb',value:'6',trusted:true}]}),false,'two trusted ids of one Film are a collision');
assert.equal(filmVerified({id:'film:a',externalIds:[{scheme:'tmdb_tv',value:'9',trusted:true}]}),true);
assert.equal(filmVerified({id:'film:a',canonicalIdentity:'tmdb:5'}),true);
assert.equal(filmVerified({id:'film:a',canonicalIdentity:'tmdb:5',identity:{status:'rejected'}}),false);
assert.equal(filmVerified({id:'film:a'}),false);

// Same key, several roles: one human, no other evidence needed.
{
 const model=canonicalPersons({persons:[person('person:actor/clint','Clint Eastwood'),person('person:director/clint','Clint Eastwood'),person('person:tmdb_actor/190','Клинт Иствуд'),person('person:tmdb_director/190','Клинт Иствуд')]});
 assert.equal(model.humans.length,2);
 const lb=humanOf(model,'person:actor/clint');
 assert.equal(lb.id,'human:letterboxd:clint');
 assert.deepEqual(lb.memberIds,['person:actor/clint','person:director/clint']);
 assert.deepEqual(lb.roles,['actor','director']);
 assert.deepEqual(plain(lb.links),[{basis:'same_key',key:'letterboxd:clint',personIds:['person:actor/clint','person:director/clint']}]);
 assert.deepEqual(plain(lb.externalIds),[{scheme:'letterboxd_person',value:'clint',trusted:true,personIds:['person:actor/clint','person:director/clint']}]);
 assert.equal(humanOf(model,'person:tmdb_director/190').id,'human:tmdb:190');
 assert.equal(model.candidates.length,0,'different names and no shared Film give no candidate');
}

// The same human across Films and sources: coCredit on verified Films joins a Letterboxd and a TMDB key, with both roles.
const across={
 persons:[
  person('person:actor/jane-doe','Jane Doe',provisional('Джейн Доу')),
  person('person:director/jane-doe','Jane Doe'),
  person('person:tmdb_actor/11','Джейн Доу'),
  person('person:tmdb_director/11','Джейн Доу'),
  person('person:actor/someone','Someone Else'),
  person('person:tmdb_actor/12','Кто-то Другой')
 ],
 credits:[credit('film:one','person:actor/jane-doe'),credit('film:one','person:tmdb_actor/11'),credit('film:two','person:actor/jane-doe'),credit('film:two','person:tmdb_actor/11'),credit('film:three','person:director/jane-doe','director'),credit('film:three','person:tmdb_director/11','director'),credit('film:one','person:actor/someone'),credit('film:one','person:tmdb_actor/12')],
 films:[film('film:one'),film('film:two'),film('film:three')]
};
{
 const model=canonicalPersons(across);
 const jane=humanOf(model,'person:tmdb_actor/11');
 assert.equal(jane.id,'human:letterboxd:jane-doe');
 assert.deepEqual(jane.formerIds,['human:tmdb:11'],'the id the TMDB key had alone stays reachable');
 assert.deepEqual(jane.memberIds,['person:actor/jane-doe','person:director/jane-doe','person:tmdb_actor/11','person:tmdb_director/11']);
 assert.deepEqual(jane.roles,['actor','director']);
 assert.deepEqual(plain(jane.links.map(link=>link.basis)),['same_key','same_key','co_credit'],'one coCredit link per joined pair of groups, whatever the roles');
 // The director records share no accepted name (Jane Doe and Джейн Доу), so film:three is no evidence: names are compared
 // per credited record, as the D1 review queue does. The two directors still join through their same_key groups.
 assert.deepEqual(plain(jane.links[2]),{basis:'co_credit',personIds:['person:actor/jane-doe','person:tmdb_actor/11'],films:['film:one','film:two'],roles:['actor'],names:['джейн доу']});
 assert.deepEqual(plain(jane.credits),[{filmId:'film:one',role:'actor'},{filmId:'film:three',role:'director'},{filmId:'film:two',role:'actor'}]);
 assert.deepEqual(plain(jane.externalIds.map(item=>[item.scheme,item.value])),[['letterboxd_person','jane-doe'],['tmdb_person','11']]);
 assert.notEqual(humanOf(model,'person:actor/someone').id,humanOf(model,'person:tmdb_actor/12').id,'a shared Film without a shared name is no link');
 assert.equal(model.humanOf['person:tmdb_director/11'],'human:letterboxd:jane-doe');
 assert.deepEqual(plain(model.totals),{persons:6,humans:3,joined:1,links:{same_key:2,owner:0,co_credit:1},candidates:{ambiguous_co_credit:0,conflicting_keys:0,owner_different:0,name_only:0,same_name:0},issues:0});
}
// An unverified Film carries no evidence.
{
 const model=canonicalPersons({...across,films:[{id:'film:one',verified:false},{id:'film:two',externalIds:[{scheme:'tmdb',value:'1',trusted:false}]},{id:'film:three',externalIds:[{scheme:'tmdb',value:'2',trusted:true,conflicting:true}]}]});
 assert.notEqual(humanOf(model,'person:actor/jane-doe').id,humanOf(model,'person:tmdb_actor/11').id);
 assert.deepEqual(plain(model.candidates),[{reason:'name_only',humanIds:['human:letterboxd:jane-doe','human:tmdb:11'],names:['джейн доу']}],'without a verified Film a shared name is only a candidate');
}

// Ambiguous aliases: two TMDB records under one name on the same Film and role stop the link from that Film.
{
 const model=canonicalPersons({
  persons:[person('person:actor/ivan-petrov','Ivan Petrov',provisional('Иван Петров')),person('person:tmdb_actor/21','Иван Петров'),person('person:tmdb_actor/22','Иван Петров')],
  credits:[credit('film:a','person:actor/ivan-petrov'),credit('film:a','person:tmdb_actor/21'),credit('film:a','person:tmdb_actor/22')],
  films:[film('film:a')]
 });
 assert.equal(model.humans.length,3,'nothing joined');
 assert.deepEqual(plain(model.candidates),[
  {reason:'ambiguous_co_credit',personIds:['person:actor/ivan-petrov','person:tmdb_actor/21','person:tmdb_actor/22'],films:['film:a'],roles:['actor'],names:['иван петров']},
  {reason:'same_name',source:'tmdb',humanIds:['human:tmdb:21','human:tmdb:22'],names:['иван петров']}
 ]);
}
// Collision: one TMDB key with evidence for two Letterboxd keys on different Films joins neither.
{
 const model=canonicalPersons({
  persons:[person('person:actor/john-smith','John Smith'),person('person:actor/john-smith-1','John Smith'),person('person:tmdb_actor/31','John Smith')],
  credits:[credit('film:a','person:actor/john-smith'),credit('film:a','person:tmdb_actor/31'),credit('film:b','person:actor/john-smith-1'),credit('film:b','person:tmdb_actor/31')],
  films:[film('film:a'),film('film:b')]
 });
 assert.equal(model.humans.length,3);
 assert.deepEqual(plain(model.candidates.filter(item=>item.reason==='ambiguous_co_credit').map(item=>item.personIds)),[['person:actor/john-smith','person:tmdb_actor/31'],['person:actor/john-smith-1','person:tmdb_actor/31']]);
 assert.deepEqual(plain(model.candidates.find(item=>item.reason==='same_name')),{reason:'same_name',source:'letterboxd',humanIds:['human:letterboxd:john-smith','human:letterboxd:john-smith-1'],names:['john smith']});
}
// Remake counterpart: namesakes on two verified Films of one title are not linked across the Films.
{
 const model=canonicalPersons({
  persons:[person('person:actor/mary-lee','Mary Lee'),person('person:tmdb_actor/41','Mary Lee')],
  credits:[credit('film:the-thing-1951','person:actor/mary-lee'),credit('film:the-thing-1982','person:tmdb_actor/41')],
  films:[film('film:the-thing-1951'),film('film:the-thing-1982')]
 });
 assert.equal(model.humans.length,2);
 assert.deepEqual(plain(model.candidates),[{reason:'name_only',humanIds:['human:letterboxd:mary-lee','human:tmdb:41'],names:['mary lee']}]);
}
// Two keys of one source never join through coCredit: an owner link already gave the TMDB group another Letterboxd key.
{
 const model=canonicalPersons({
  persons:[person('person:actor/a-one','Alex Grey'),person('person:actor/a-two','Alex Grey'),person('person:tmdb_actor/51','Alex Grey')],
  credits:[credit('film:a','person:actor/a-two'),credit('film:a','person:tmdb_actor/51')],
  films:[film('film:a')],
  decisions:[{personIds:['person:actor/a-one','person:tmdb_actor/51'],verdict:'same',at:'2026-10-30T10:00:00.000Z',basis:'owner checked'}]
 });
 const grey=humanOf(model,'person:tmdb_actor/51');
 assert.deepEqual(grey.memberIds,['person:actor/a-one','person:tmdb_actor/51']);
 assert.deepEqual(plain(grey.links),[{basis:'owner',personIds:['person:actor/a-one','person:tmdb_actor/51'],at:'2026-10-30T10:00:00.000Z',decision:'decision',reason:'owner checked'}]);
 assert.equal(humanOf(model,'person:actor/a-two').memberIds.length,1);
 assert.deepEqual(plain(model.candidates.find(item=>item.reason==='conflicting_keys')),{reason:'conflicting_keys',personIds:['person:actor/a-two','person:tmdb_actor/51'],films:['film:a'],roles:['actor'],names:['alex grey']});
}

// Owner decisions: different refuses coCredit, the later verdict wins, an equal time keeps different, a key is never split.
{
 const at=hour=>`2026-10-30T${hour}:00:00.000Z`;
 const different={personIds:['person:tmdb_actor/11','person:actor/jane-doe'],verdict:'different',at:at('10'),basis:'not the same'};
 let model=canonicalPersons({...across,decisions:[different]});
 assert.notEqual(humanOf(model,'person:actor/jane-doe').id,humanOf(model,'person:tmdb_actor/11').id);
 assert.deepEqual(plain(model.candidates.filter(item=>item.reason==='owner_different').map(item=>item.films)),[['film:one','film:two']],'the refusal holds the evidence as a candidate');
 model=canonicalPersons({...across,decisions:[different,{...different,verdict:'same',at:at('11')}]});
 assert.equal(humanOf(model,'person:actor/jane-doe').id,humanOf(model,'person:tmdb_actor/11').id,'a later same lifts the refusal');
 model=canonicalPersons({...across,decisions:[{...different,verdict:'same',at:at('10')},different]});
 assert.notEqual(humanOf(model,'person:actor/jane-doe').id,humanOf(model,'person:tmdb_actor/11').id,'at the same time different wins');
 model=canonicalPersons({...across,decisions:[{personIds:['person:actor/jane-doe','person:director/jane-doe'],verdict:'different',at:at('12')}]});
 assert.equal(humanOf(model,'person:actor/jane-doe').id,humanOf(model,'person:director/jane-doe').id);
 assert.deepEqual(plain(model.issues),[{code:'owner_split_same_key',personIds:['person:actor/jane-doe','person:director/jane-doe'],key:'letterboxd:jane-doe'}]);
 // A same that contradicts an owner different between the two groups is refused, not applied.
 model=canonicalPersons({persons:[person('person:actor/x','X'),person('person:director/x','X'),person('person:tmdb_actor/1','X')],decisions:[{personIds:['person:director/x','person:tmdb_actor/1'],verdict:'different',at:at('10')},{personIds:['person:actor/x','person:tmdb_actor/1'],verdict:'same',at:at('11')}]});
 assert.equal(model.humans.length,2);
 assert.deepEqual(plain(model.issues),[{code:'invalid_decision',personIds:['person:actor/x','person:tmdb_actor/1'],reason:'contradicts_owner_different'}]);
 // AIR-126 role links are owner same decisions, also for a keyless person:role record.
 model=canonicalPersons({persons:[person('person:actor/vo','V. O.',null,{roleLinks:[{id:'person:role/Voice',reason:'owner_same_person',at:at('09')}]}),person('person:role/Voice','Voice')]});
 assert.equal(model.humans.length,1);
 assert.equal(model.humans[0].id,'human:letterboxd:vo');
 assert.deepEqual(model.humans[0].formerIds,['human:record:role/Voice']);
 assert.deepEqual(plain(model.humans[0].links),[{basis:'owner',personIds:['person:actor/vo','person:role/Voice'],at:at('09'),decision:'role_link',reason:'owner_same_person'}]);
}

// Reviewed precedence of the preferred name across members.
{
 const credits=[credit('film:a','person:actor/p'),credit('film:a','person:tmdb_actor/61')];
 const run=(lb,tm)=>humanOf(canonicalPersons({persons:[person('person:actor/p','Pat Kay',lb),person('person:tmdb_actor/61','Пэт Кей',tm)],credits,films:[film('film:a')]}),'person:actor/p');
 let pat=run(provisional('Пэт Кей'),owner('Пат Кей'));
 assert.equal(pat.memberIds.length,2);
 assert.deepEqual(plain(pat.preferred),{value:'Пат Кей',status:'reviewed',source:'owner',authority:'owner',personId:'person:tmdb_actor/61'},'an owner review beats a provisional name of any member');
 assert.ok(pat.aliases.some(alias=>alias.value==='Пэт Кей'),'the replaced name stays an alias');
 pat=run(dictionary('Пэт Кей'),owner('Пат Кей'));
 assert.equal(pat.preferred.value,'Пат Кей','an owner review beats a dictionary name');
 pat=run(dictionary('Пэт Кей'),provisional('Пэт Кей'));
 assert.deepEqual(plain(pat.preferred),{value:'Пэт Кей',status:'reviewed',source:'dictionary',authority:'dictionary',personId:'person:actor/p'});
 pat=humanOf(canonicalPersons({persons:[person('person:actor/p','Pat Kay',dictionary('Пэт Кей')),person('person:director/p','Pat Kay',dictionary('Пат Кей'))]}),'person:actor/p');
 assert.equal(pat.preferred.value,'Пэт Кей','Letterboxd before TMDB, then id order, decides between equals');
 assert.deepEqual(plain(pat.nameConflicts),[{value:'Пат Кей',personId:'person:director/p',status:'reviewed',source:'dictionary'}]);
 assert.ok(pat.aliases.some(alias=>alias.value==='Пат Кей'),'a conflicting name is kept, not dropped');
 pat=run(null,null);
 assert.deepEqual(plain(pat.preferred),{value:null,status:'missing',source:null,authority:null,personId:null});
 assert.equal(pat.original,'Pat Kay');
}

// Import of the verified dictionary names as an offline projection.
{
 const entries=[{id:'actor/p',name:'Пэт Кей',status:'verified',verification_basis:'user_supplied',aliases:['Пэт Кэй']},{id:'actor/q',name:'Кью',status:'provisional'},{id:'actor/r',name:'Ар',status:'verified'}];
 const records=freeze([person('person:actor/p','Pat Kay',provisional('Пэт Кэй')),person('person:actor/q','Q'),person('person:actor/r','R',owner('Арр'))]);
 const [p,q,r]=withVerifiedNames(records,entries);
 assert.deepEqual(plain(p.localization),{status:'reviewed',value:'Пэт Кей',source:'dictionary',provenance:{authority:'dictionary',basis:'user_supplied'}});
 assert.deepEqual(plain(p.aliases),[{kind:'name',value:'Пэт Кэй',provenance:{source:'dictionary'}}],'the replaced provisional name stays as an alias, once');
 assert.equal(q,records[1],'a provisional dictionary entry changes nothing');
 assert.deepEqual(plain(r.localization),plain(records[2].localization),'an owner review keeps its name');
 assert.deepEqual(plain(r.localizationConflicts),[{value:'Ар',source:'dictionary',reason:'owner_kept'}]);
 assert.equal(humanOf(canonicalPersons({persons:[r]}),'person:actor/r').preferred.value,'Арр');
 assert.ok(humanOf(canonicalPersons({persons:[r]}),'person:actor/r').aliases.some(alias=>alias.value==='Ар'&&alias.origins.includes('held')),'a held name is still an alias');
 // The real dictionary: every verified entry projects onto a lifecycle personView as a reviewed name.
 const ctx=vm.createContext({Date,Map,Set,JSON,Object,Math,String,URL});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\nglobalThis.api={personView};',ctx);
 const real=JSON.parse(fs.readFileSync('data/person-names.json','utf8')).filter(entry=>entry.status==='verified'&&/^(actor|director)\//.test(entry.id));
 assert.ok(real.length>0);
 const views=real.map(entry=>plain(ctx.api.personView({roleId:entry.id,original:entry.original,now:Date.parse('2026-10-30T00:00:00.000Z')})));
 const projected=withVerifiedNames(views,real);
 projected.forEach((view,index)=>{assert.equal(view.localization.status,'reviewed');assert.equal(view.localization.value,real[index].name.trim());});
 const model=canonicalPersons({persons:projected});
 assert.equal(model.issues.length,0);
 assert.equal(model.totals.persons,new Set(real.map(entry=>entry.id)).size);
}

// No destructive merge: inputs untouched, every name and key kept, order-independent, and an owner split restores the parts.
{
 const input=freeze(plain(across));
 const before=JSON.stringify(input);
 const model=canonicalPersons(input);
 assert.equal(JSON.stringify(input),before);
 const jane=humanOf(model,'person:actor/jane-doe');
 for(const id of jane.memberIds){
  const record=input.persons.find(item=>item.id===id);
  for(const name of personNames(record))assert.ok(jane.preferred.value===name.value||jane.aliases.some(alias=>alias.value===name.value),`${name.value} of ${id} is kept`);
 }
 const reversed=canonicalPersons({persons:[...input.persons].reverse(),credits:[...input.credits].reverse(),films:[...input.films].reverse()});
 assert.deepEqual(plain(reversed),plain(model),'the model does not depend on input order');
 const split=canonicalPersons({...input,decisions:[{personIds:['person:actor/jane-doe','person:tmdb_actor/11'],verdict:'different',at:'2026-10-30T10:00:00.000Z'}]});
 const lb=humanOf(split,'person:actor/jane-doe'),tm=humanOf(split,'person:tmdb_actor/11');
 assert.deepEqual(lb.memberIds,['person:actor/jane-doe','person:director/jane-doe']);
 assert.deepEqual(tm.memberIds,['person:tmdb_actor/11','person:tmdb_director/11']);
 assert.equal(tm.id,'human:tmdb:11','the split part gets back the id it had alone');
}

// Invalid input is reported, never guessed.
{
 const model=canonicalPersons({
  persons:[person('person:actor/a','A'),person('person:actor/a','A again'),{id:'person:writer/x'},null],
  credits:[credit('film:a','person:actor/a','writer'),credit('film:a','person:actor/missing'),{filmId:'film:a'}],
  decisions:[{personIds:['person:actor/a'],verdict:'same'},{personIds:['person:actor/a','person:actor/zzz'],verdict:'same'},{personIds:['person:actor/a','person:actor/a'],verdict:'same'},{personIds:['person:actor/a','person:actor/b'],verdict:'maybe'}]
 });
 assert.equal(model.humans.length,1);
 assert.equal(model.humans[0].original,'A','the first record of a duplicated id is kept');
 assert.deepEqual(plain(model.issues.map(issue=>issue.code)).sort(),['duplicate_person','invalid_credit','invalid_credit','invalid_decision','invalid_decision','invalid_decision','invalid_person','invalid_person','unknown_person','unknown_person'].sort());
 for(const issue of model.issues)assert.ok(PERSON_ISSUES.includes(issue.code));
 for(const reason of new Set(model.candidates.map(item=>item.reason)))assert.ok(PERSON_CANDIDATE_REASONS.includes(reason));
 assert.deepEqual(plain(canonicalPersons()),{version:1,totals:{persons:0,humans:0,joined:0,links:{same_key:0,owner:0,co_credit:0},candidates:{ambiguous_co_credit:0,conflicting_keys:0,owner_different:0,name_only:0,same_name:0},issues:0},humans:[],humanOf:{},candidates:[],issues:[]});
}

console.log('Canonical Person: keys, coCredit on verified Films, ambiguity and collision guards, owner decisions, reviewed precedence, dictionary import and non-destructive grouping passed');
