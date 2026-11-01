import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {personQueue,searchPeople} from '../src/domain/admin-query.js';

const domain=fs.readFileSync('src/domain/film-person.js','utf8'),review=fs.readFileSync('src/domain/person-name-review.js','utf8'),titleReview=fs.readFileSync('src/domain/film-title-review.js','utf8');
// Offline contract: pure, dependency-free, outside the Worker bundle and outside every runtime writer.
assert.doesNotMatch(review,/\b(fetch|import|export|require|BUCKET|wrangler|R2|D1)\b/);
assert.doesNotMatch(review,/linkFilms\(|localFilmId\(|localPersonId\(|externalIds\(|mergeExternal\(|identityState\(/,'a name review never mints, links or merges identity');
// All three files may share one script scope, so a top-level name defined twice would silently replace another contract's function.
const topLevelNames=source=>new Set([...source.matchAll(/^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(match=>match[1]));
const taken=new Set([...topLevelNames(domain),...topLevelNames(titleReview)]);
for(const name of topLevelNames(review))assert.equal(taken.has(name),false,`${name} is already defined by film-person.js or film-title-review.js`);
for(const file of ['src/worker.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/mcp.js','src/continuation.js','public/app.js','public/admin.js','src/admin/client.js','src/admin/person-name-client.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/person-name-review|applyPersonNameReview|personNameState|reconcilePersonName/,file);
assert.match(fs.readFileSync('build.mjs','utf8'),/src\/domain\/person-name-review\.js/);
assert.match(fs.readFileSync('build.mjs','utf8'),/src\/admin\/person-name-route\.js/);
assert.match(fs.readFileSync('build.mjs','utf8'),/src\/admin\/owner-reviews\.js/);
const buildSource=fs.readFileSync('build.mjs','utf8');
assert.ok(buildSource.indexOf('src/domain/person-name-review.js')<buildSource.indexOf('src/admin/read.js'));
assert.ok(buildSource.indexOf('src/admin/read.js')<buildSource.indexOf('src/admin/owner-reviews.js'));
assert.ok(buildSource.indexOf('src/admin/owner-reviews.js')<buildSource.indexOf('src/admin/person-name-route.js'));
const reviewKey=(fs.readFileSync('src/admin/owner-reviews.js','utf8').match(/OWNER_REVIEWS_KEY='([^']+)'/)||[])[1];
assert.equal(reviewKey,'admin/owner-reviews.json');
const workerSource=fs.readFileSync('src/worker.js','utf8');
assert.equal((workerSource.match(/admin\/owner-reviews\.json/g)||[]).length,1,'the overlay key lives in one helper; the EPG commit does not name it');
assert.deepEqual(workerSource.split('\n').filter(line=>line.includes('publishedOwnerReviews')).map(line=>line.includes("pathname==='/api/programme'")?'programme':line.includes("pathname==='/api/watchlist'")?'watchlist':'helper'),['helper','programme','watchlist'],'programme and watchlist reads pass the overlay');

const ctx=vm.createContext({Date,Map,Set,JSON,Object,Math,String});
vm.runInContext(domain+'\n'+review+'\n'+titleReview+'\nglobalThis.api={personView,applyAutomaticLocalization,applyReviewedLocalization,transition,NAME_REVIEW_CONTRACT_VERSION,NAME_REVIEW_MODES,personNameVersion,personNameOptions,personNameCollisions,personNameState,personNameProjection,validatePersonNameReview,applyPersonNameReview,personNameReviewCompletion,reconcilePersonName};',ctx);
const {personView,applyAutomaticLocalization,applyReviewedLocalization,transition,NAME_REVIEW_CONTRACT_VERSION,NAME_REVIEW_MODES,personNameVersion,personNameOptions,personNameCollisions,personNameState,personNameProjection,validatePersonNameReview,applyPersonNameReview,personNameReviewCompletion,reconcilePersonName}=ctx.api;

const NOW=Date.parse('2026-10-25T12:00:00.000Z');
const LATER=NOW+60000;
const snapshot=value=>JSON.stringify(value);
// Values built inside the vm realm have their own Array/Object prototypes; compare them as plain data.
const plain=value=>JSON.parse(JSON.stringify(value));
const deepEqual=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);

// Fixtures: the same human under two role ids, plus an unrelated person and a dictionary-reviewed one.
const actor=personView({roleId:'actor/chris-pratt',original:'Chris Pratt',cacheName:'Крис Пратт',now:NOW});
const director=personView({roleId:'director/chris-pratt',original:'Chris Pratt',now:NOW});
const other=personView({roleId:'actor/someone-else',original:'Someone Else',cacheName:'Кто-то Другой',now:NOW});
const dictionary=personView({roleId:'actor/delia-enea',original:'Delia Enea',dictionary:{name:'Делия Энеа',status:'verified',source:'https://ru.wikipedia.org/wiki/Delia_Enea',aliases:['Делия Энея']},now:NOW});
const people=[actor,director,other,dictionary];
assert.equal(actor.id,'person:actor/chris-pratt');
assert.equal(actor.localization.status,'provisional');
assert.equal(actor.localization.value,'Крис Пратт');
assert.equal(director.localization.status,'missing');
assert.equal(dictionary.localization.status,'reviewed');
const frozen=snapshot(people);

// Read model: options in display order, collisions by folded original or preferred, a version token.
assert.equal(NAME_REVIEW_CONTRACT_VERSION,1);
deepEqual([...NAME_REVIEW_MODES],['alias','manual']);
const state=personNameState(actor,people);
assert.equal(state.personId,'person:actor/chris-pratt');
assert.equal(state.roleId,'actor/chris-pratt');
assert.equal(state.original,'Chris Pratt');
assert.equal(state.preferred.value,'Крис Пратт');
assert.equal(state.preferred.status,'provisional');
assert.equal(state.preferred.authority,null);
assert.equal(state.preferred.reviewedAt,null);
deepEqual(state.options.map(option=>[option.value,option.origin,option.preferred]),[['Крис Пратт','preferred',true],['Chris Pratt','alias',false]]);
assert.equal(state.options[1].provenance.source,'letterboxd');
deepEqual(personNameOptions({id:'person:x',original:'Orig',aliases:[],localization:{status:'missing',value:null}}).map(option=>[option.value,option.origin]),[['Orig','original']]);
deepEqual(state.reviews,[]);
deepEqual(state.roleLinks,[]);
assert.equal(state.heldConflicts,0);
deepEqual(state.collisions.map(item=>[item.id,item.reason,item.linked,item.status]),[['person:director/chris-pratt','same_original',false,'missing']]);
assert.equal(state.collisions[0].version,personNameVersion(director));
deepEqual(personNameCollisions(other,people),[]);
deepEqual(personNameCollisions({...director,original:'CHRIS  PRÄTT'},people).map(item=>item.id),['person:actor/chris-pratt'],'collisions compare folded text');
deepEqual(personNameCollisions({...other,localization:{...other.localization,value:'Крис Пратт'}},people).map(item=>[item.id,item.reason]),[['person:actor/chris-pratt','same_preferred']]);
deepEqual(personNameCollisions(actor,null),[]);
assert.match(state.version,/^name-review:1:[0-9a-f]{14}$/);
assert.equal(state.version,personNameVersion(actor),'the token is deterministic');
assert.notEqual(personNameVersion(actor),personNameVersion(director),'each role carries its own token');
assert.notEqual(personNameVersion({...actor,aliases:[...actor.aliases,{kind:'name',value:'Ещё одно'}]}),state.version,'an alias change is a version change');
assert.equal(personNameVersion({...actor,identity:{...actor.identity,updatedAt:'2000-01-01T00:00:00.000Z'},externalIds:[]}),state.version,'identity and external ids are not part of the name version');
assert.notEqual(personNameVersion({...actor,localization:{...actor.localization,provenance:{...actor.localization.provenance,basis:'другое'}}}),state.version,'a provenance change is a version change');
assert.notEqual(personNameVersion({...actor,aliases:actor.aliases.map(alias=>({...alias,provenance:{source:'tmdb'}}))}),state.version,'an alias provenance change is a version change');
assert.notEqual(personNameVersion({...actor,localizationConflicts:[{reason:'untrusted_review',value:'Удержано'}]}),state.version,'a held conflict is a version change');
assert.notEqual(personNameVersion({...actor,roleLinks:[{id:'person:director/chris-pratt'}]}),state.version,'a role link is a version change');
assert.notEqual(personNameVersion({...actor,aliases:[],original:'Chris Pratt Jr'}),personNameVersion({...actor,aliases:[]}),'an option text change is a version change');
assert.equal(personNameVersion({...actor,localization:Object.fromEntries(Object.entries(actor.localization).reverse())}),state.version,'key order does not matter');
assert.equal(snapshot(people),frozen,'reading does not mutate');

// Alias mode: the Wikidata name becomes the reviewed preferred name of the actor record alone.
const pick={personId:actor.id,requestId:'req-1',mode:'alias',value:'Крис Пратт',expectedVersion:state.version};
const checked=validatePersonNameReview(actor,pick,people);
assert.equal(checked.ok,true);
assert.equal(checked.selected.origin,'preferred');
deepEqual(checked.linked,[]);
const first=applyPersonNameReview(actor,pick,NOW,people);
assert.equal(first.ok,true);
assert.equal(first.changed,true);
assert.equal(first.idempotent,false);
const reviewed=first.person;
assert.equal(reviewed.id,actor.id);
assert.equal(reviewed.roleId,actor.roleId);
assert.equal(reviewed.localization.status,'reviewed');
assert.equal(reviewed.localization.value,'Крис Пратт');
assert.equal(reviewed.localization.source,'owner');
assert.equal(reviewed.localization.updatedAt,new Date(NOW).toISOString());
deepEqual(reviewed.localization.provenance,{source:'owner',authority:'owner',mode:'alias',basis:null,requestId:'req-1',selectedFrom:'preferred',linkedFrom:null});
assert.equal(reviewed.aliases.some(alias=>alias.value==='Chris Pratt'&&alias.kind==='name'),true,'the original stays an alias');
assert.equal(reviewed.aliases.some(alias=>alias.value==='Крис Пратт'),false,'the preferred name is not also an alias');
deepEqual(reviewed.externalIds,actor.externalIds);
deepEqual(reviewed.identity,actor.identity);
assert.equal(reviewed.identity.provenance.dedupe,'deferred','a review does not resolve dedupe');
deepEqual(reviewed.localizationConflicts,[]);
deepEqual(reviewed.roleLinks??[],[]);
deepEqual(first.people,[]);
deepEqual(first.reviews,[]);
assert.equal(snapshot(people),frozen,'the input records are not mutated');
assert.equal(reviewed.nameReviews.length,1);
assert.equal(first.review,reviewed.nameReviews[0]);
deepEqual(first.review,{contractVersion:1,requestId:'req-1',personId:actor.id,linkedFrom:null,at:new Date(NOW).toISOString(),mode:'alias',authority:'owner',basis:null,selectedFrom:'preferred',roles:[],nameChanged:true,records:[],from:{value:'Крис Пратт',status:'provisional',source:'wikidata'},to:{value:'Крис Пратт',status:'reviewed'},version:{before:state.version,after:first.version}});
deepEqual(first.commit,[{id:actor.id,version:{before:state.version,after:first.version}}]);
assert.notEqual(first.version,state.version);
assert.equal(first.version,personNameVersion(reviewed));
assert.equal(personNameState(reviewed).preferred.authority,'owner');
assert.equal(personNameState(reviewed).preferred.reviewedAt,new Date(NOW).toISOString());

// Compare-and-set, idempotent replay, reused requestId, shape checks before the replay lookup.
const stale=applyPersonNameReview(reviewed,{personId:actor.id,requestId:'req-2',mode:'manual',value:'Крис Прэтт',expectedVersion:state.version},LATER,people);
assert.equal(stale.reason,'version_conflict');
assert.equal(stale.expected,first.version);
assert.equal(validatePersonNameReview(reviewed,{personId:actor.id,requestId:'req-2',mode:'manual',value:'Крис Прэтт'}).reason,'version_conflict','a missing token is a conflict, not a bypass');
const replay=applyPersonNameReview(reviewed,pick,LATER,people);
assert.equal(replay.idempotent,true);
assert.equal(replay.changed,false);
assert.equal(replay.person,reviewed);
assert.equal(replay.review,reviewed.nameReviews[0]);
assert.equal(replay.version,first.version);
assert.equal(applyPersonNameReview(reviewed,{...pick,expectedVersion:undefined,value:'  Крис   Пратт ',basis:'  '},LATER,people).idempotent,true,'a retry with a stale token and normalized payload replays');
assert.equal(applyPersonNameReview(reviewed,{...pick,basis:'Другое основание'},LATER,people).reason,'request_id_reused');
assert.equal(applyPersonNameReview(reviewed,{...pick,mode:'manual'},LATER,people).reason,'request_id_reused');
assert.equal(applyPersonNameReview(reviewed,{...pick,roles:[director.id]},LATER,people).reason,'request_id_reused','a changed role set is not a replay');
assert.equal(applyPersonNameReview(reviewed,{...pick,personId:'person:other'},LATER,people).reason,'person_mismatch');
for(const field of ['id','roleId','externalIds','identity','canonicalIdentity','tmdbId','redirects'])assert.equal(applyPersonNameReview(reviewed,{...pick,[field]:'x'},LATER,people).field,field);
assert.equal(applyPersonNameReview(reviewed,{...pick,mode:'pick'},LATER,people).reason,'invalid_mode');
assert.equal(applyPersonNameReview(reviewed,{...pick,value:'Крис\u0007Пратт'},LATER,people).reason,'invalid_name');
assert.equal(applyPersonNameReview(reviewed,{...pick,basis:'b'.repeat(501)},LATER,people).reason,'invalid_basis');
assert.equal(applyPersonNameReview(reviewed,{...pick,roles:'director/chris-pratt'},LATER,people).reason,'invalid_roles');
assert.equal(applyPersonNameReview(reviewed,{...pick,roles:[actor.id]},LATER,people).reason,'invalid_roles','a record cannot link to itself');
assert.equal(applyPersonNameReview(reviewed,{...pick,roles:[director.id,director.id]},LATER,people).reason,'invalid_roles','duplicate roles are refused');
assert.equal(applyPersonNameReview({...reviewed,nameReviews:[{...reviewed.nameReviews[0],personId:'person:other'}]},pick,LATER,people).reason,'request_id_reused','an audit entry of another record never replays');
assert.equal(reviewed.nameReviews.length,1,'replays and refusals leave the audit as it was');
// Re-sending the current reviewed name under a new requestId changes nothing and leaves no audit noise.
const same=applyPersonNameReview(reviewed,{personId:actor.id,requestId:'req-3',mode:'manual',value:'Крис Пратт',expectedVersion:first.version},LATER,people);
assert.equal(same.ok,true);
assert.equal(same.changed,false);
assert.equal(same.person,reviewed);
assert.equal(same.review,null);

// Manual mode with a basis, linking the director role: both records get the reviewed name and a
// link to each other; ids, role ids and external ids stay as they were.
const typed={personId:actor.id,requestId:'req-4',mode:'manual',value:'Крис Прэтт',basis:'Русская Википедия',expectedVersion:first.version,roles:[{id:director.id,expectedVersion:personNameVersion(director)}]};
const linkedPeople=[reviewed,director,other,dictionary];
const second=applyPersonNameReview(reviewed,typed,LATER,linkedPeople);
assert.equal(second.ok,true);
assert.equal(second.changed,true);
const corrected=second.person;
assert.equal(corrected.localization.value,'Крис Прэтт');
assert.equal(corrected.localization.provenance.basis,'Русская Википедия');
assert.equal(corrected.localization.provenance.selectedFrom,null);
deepEqual(corrected.aliases.map(alias=>alias.value).sort(),['Chris Pratt','Крис Пратт'],'the previous reviewed name stays an alias');
assert.equal(corrected.aliases.find(alias=>alias.value==='Крис Пратт').provenance.authority,'owner');
deepEqual(corrected.roleLinks,[{id:director.id,roleId:'director/chris-pratt',reason:'owner_same_person',requestId:'req-4',at:new Date(LATER).toISOString()}]);
assert.equal(corrected.nameReviews.length,2);
deepEqual(corrected.nameReviews[1].roles,[director.id]);
assert.equal(corrected.nameReviews[1].from.value,'Крис Пратт');
assert.equal(corrected.nameReviews[1].version.before,first.version);
assert.equal(corrected.nameReviews[1].version.after,second.version);
assert.equal(second.version,personNameVersion(corrected),'stamping version.after does not move the token');
assert.equal(corrected.nameReviews[0],reviewed.nameReviews[0]);
assert.equal(second.people.length,1);
const linkedDirector=second.people[0];
assert.equal(linkedDirector.id,director.id);
assert.equal(linkedDirector.roleId,director.roleId);
deepEqual(linkedDirector.externalIds,director.externalIds);
deepEqual(linkedDirector.identity,director.identity);
assert.equal(linkedDirector.localization.status,'reviewed');
assert.equal(linkedDirector.localization.value,'Крис Прэтт');
assert.equal(linkedDirector.localization.provenance.authority,'owner');
assert.equal(linkedDirector.localization.provenance.linkedFrom,actor.id);
assert.equal(linkedDirector.aliases.some(alias=>alias.value==='Chris Pratt'),true);
deepEqual(linkedDirector.roleLinks,[{id:actor.id,roleId:'actor/chris-pratt',reason:'owner_same_person',requestId:'req-4',at:new Date(LATER).toISOString()}]);
assert.equal(linkedDirector.nameReviews.length,1);
assert.equal(second.reviews[0],linkedDirector.nameReviews[0]);
assert.equal(second.reviews[0].linkedFrom,actor.id);
assert.equal(second.reviews[0].from.status,'missing');
assert.equal(second.reviews[0].version.before,personNameVersion(director));
assert.equal(second.reviews[0].version.after,personNameVersion(linkedDirector));
assert.equal(second.reviews[0].nameChanged,true);
deepEqual(corrected.nameReviews[1].records,[{id:director.id,version:{before:personNameVersion(director),after:personNameVersion(linkedDirector)}}]);
deepEqual(second.commit,[{id:actor.id,version:{before:first.version,after:second.version}},{id:director.id,version:{before:personNameVersion(director),after:personNameVersion(linkedDirector)}}],'commit lists every record the writer must persist');
assert.equal(snapshot(people),frozen,'linking never mutates the input records');
assert.notEqual(personNameVersion(linkedDirector),personNameVersion(director),'the linked role has a new token of its own');
deepEqual(personNameState(corrected,[corrected,linkedDirector,other]).collisions.map(item=>[item.id,item.linked,item.status]),[[director.id,true,'reviewed']]);
// Replay of the linking request on the primary record replays without touching anyone.
const linkedReplay=applyPersonNameReview(corrected,typed,LATER,[corrected,linkedDirector,other]);
assert.equal(linkedReplay.idempotent,true);
deepEqual(linkedReplay.people,[]);
// The same name and the same links again under a new requestId is a no-op.
assert.equal(applyPersonNameReview(corrected,{...typed,requestId:'req-5',expectedVersion:second.version,roles:[{id:director.id,expectedVersion:personNameVersion(linkedDirector)}]},LATER,[corrected,linkedDirector,other]).changed,false);
// (a) The primary record already carries the name and the command links a new role whose name changes:
// the primary record still gets an audit entry for the requestId, so a retry with the original tokens replays.
const extra=personView({roleId:'role/Chris Pratt',original:'Chris Pratt',now:NOW});
assert.equal(extra.localization.status,'missing');
const extraCommand={personId:actor.id,requestId:'req-6',mode:'manual',value:'Крис Прэтт',basis:'Русская Википедия',expectedVersion:second.version,roles:[{id:extra.id,expectedVersion:personNameVersion(extra)}]};
const third=applyPersonNameReview(corrected,extraCommand,LATER,[corrected,linkedDirector,extra]);
assert.equal(third.ok,true);
assert.equal(third.changed,true);
assert.equal(third.person.localization,corrected.localization,'the primary name is untouched');
assert.equal(third.review.requestId,'req-6');
assert.equal(third.review.nameChanged,false);
assert.equal(third.review.from.value,'Крис Прэтт');
assert.equal(third.review.to.value,'Крис Прэтт');
deepEqual(third.review.roles,[extra.id]);
deepEqual(third.review.records.map(item=>item.id),[extra.id]);
assert.equal(third.person.nameReviews.length,3);
assert.equal(third.person.nameReviews[2],third.review);
assert.equal(third.review.version.before,second.version);
assert.equal(third.review.version.after,third.version);
assert.equal(third.version,personNameVersion(third.person),'stamping version.after on a link-only entry does not move the token');
assert.notEqual(third.version,second.version,'a new link is a version change on the primary record');
deepEqual(third.person.roleLinks.map(link=>link.id),[director.id,extra.id]);
const linkedExtra=third.people[0];
assert.equal(linkedExtra.localization.value,'Крис Прэтт');
assert.equal(linkedExtra.nameReviews.length,1);
assert.equal(linkedExtra.nameReviews[0].linkedFrom,actor.id);
assert.equal(linkedExtra.nameReviews[0].nameChanged,true);
deepEqual(linkedExtra.roleLinks.map(link=>link.id),[actor.id]);
const thirdRetry=applyPersonNameReview(third.person,extraCommand,LATER,[third.person,linkedDirector,linkedExtra]);
assert.equal(thirdRetry.idempotent,true,'a retry with the original (now stale) tokens replays');
assert.equal(thirdRetry.review,third.review);
deepEqual(thirdRetry.people,[]);
assert.equal(applyPersonNameReview(third.person,{...extraCommand,basis:'Другое'},LATER,[third.person,linkedDirector,linkedExtra]).reason,'request_id_reused');
assert.equal(applyPersonNameReview(third.person,{...extraCommand,roles:[]},LATER,[third.person,linkedDirector,linkedExtra]).reason,'request_id_reused','dropping the role is a different request');
assert.equal(applyPersonNameReview(linkedExtra,{personId:extra.id,requestId:'req-6',mode:'manual',value:'Крис Прэтт',expectedVersion:personNameVersion(linkedExtra)},LATER,[linkedExtra]).reason,'request_id_reused','the entry a link wrote onto the role is not a replay of a primary command');
// (b) The primary record already carries the name and the command links a role that already carries it too:
// link only, no entry on the role, an audit entry on the primary record, and the same replay guarantees.
const preNamed={...personView({roleId:'tmdb_actor/10',original:'Chris Pratt',now:NOW}),localization:{...corrected.localization}};
const linkCommand={personId:actor.id,requestId:'req-7',mode:'manual',value:'Крис Прэтт',basis:'Русская Википедия',expectedVersion:second.version,roles:[{id:preNamed.id,expectedVersion:personNameVersion(preNamed)}]};
const linkOnly=applyPersonNameReview(corrected,linkCommand,LATER,[corrected,preNamed]);
assert.equal(linkOnly.changed,true);
assert.equal(linkOnly.review.nameChanged,false);
assert.equal(linkOnly.review.requestId,'req-7');
deepEqual(linkOnly.review.records.map(item=>item.id),[preNamed.id]);
assert.equal(linkOnly.people[0].nameReviews,undefined,'the role already carried the name: no entry of its own');
assert.equal(linkOnly.people[0].localization,preNamed.localization);
deepEqual(linkOnly.people[0].roleLinks.map(link=>link.id),[actor.id]);
assert.equal(linkOnly.review.records[0].version.after,personNameVersion(linkOnly.people[0]));
assert.notEqual(linkOnly.version,second.version,'a new link is a version change on the primary record');
assert.equal(applyPersonNameReview(linkOnly.person,linkCommand,LATER,[linkOnly.person,linkOnly.people[0]]).idempotent,true,'a retry of a link-only command replays');
assert.equal(applyPersonNameReview(linkOnly.person,{...linkCommand,mode:'alias'},LATER,[linkOnly.person,linkOnly.people[0]]).reason,'request_id_reused');
// A command that changes nothing at all (same name, same links on both sides) stays a true no-op without an entry.
const nothing=applyPersonNameReview(linkOnly.person,{personId:actor.id,requestId:'req-8',mode:'manual',value:'Крис Прэтт',expectedVersion:linkOnly.version,roles:[{id:preNamed.id,expectedVersion:personNameVersion(linkOnly.people[0])}]},LATER,[linkOnly.person,linkOnly.people[0]]);
assert.equal(nothing.changed,false);
assert.equal(nothing.review,null);
assert.equal(nothing.person.nameReviews.length,linkOnly.person.nameReviews.length);
// Completion check for a multi-record write: every record applied, a role still at its old token is pending, anything else diverged.
deepEqual(personNameReviewCompletion(third.review,third.person,[linkedDirector,linkedExtra]),{complete:true,records:[{id:actor.id,state:'applied'},{id:extra.id,state:'applied'}]});
deepEqual(personNameReviewCompletion(third.review,third.person,[extra]),{complete:false,records:[{id:actor.id,state:'applied'},{id:extra.id,state:'pending'}]},'the role write never landed');
deepEqual(personNameReviewCompletion(third.review,corrected,[linkedExtra]).records[0],{id:actor.id,state:'pending'},'the primary write never landed');
deepEqual(personNameReviewCompletion(third.review,third.person,[{...linkedExtra,aliases:[]}]).records[1],{id:extra.id,state:'diverged'});
deepEqual(personNameReviewCompletion(third.review,third.person,[]).records[1],{id:extra.id,state:'missing'});
deepEqual(personNameReviewCompletion(null,third.person,[]),{complete:false,records:[]});

// Role failures: unknown, unrelated, rejected and stale roles are refused before anything changes.
const roleCommand=(roles,extra={})=>({personId:actor.id,requestId:'req-7',mode:'manual',value:'Крис Прэтт',expectedVersion:first.version,roles,...extra});
assert.equal(applyPersonNameReview(reviewed,roleCommand([{id:'person:director/nobody',expectedVersion:'x'}]),LATER,linkedPeople).reason,'unknown_role');
assert.equal(applyPersonNameReview(reviewed,roleCommand([{id:other.id,expectedVersion:personNameVersion(other)}]),LATER,linkedPeople).role,other.id);
assert.equal(applyPersonNameReview(reviewed,roleCommand([{id:other.id,expectedVersion:personNameVersion(other)}]),LATER,linkedPeople).reason,'unrelated_role');
const staleRole=applyPersonNameReview(reviewed,roleCommand([{id:director.id,expectedVersion:state.version}]),LATER,linkedPeople);
assert.equal(staleRole.reason,'role_version_conflict');
assert.equal(staleRole.role,director.id);
assert.equal(staleRole.expected,personNameVersion(director));
assert.equal(applyPersonNameReview(reviewed,roleCommand([{id:director.id}]),LATER,linkedPeople).reason,'role_version_conflict','a missing role token is a conflict');
assert.equal(applyPersonNameReview(reviewed,roleCommand([{id:director.id,expectedVersion:personNameVersion(director)}]),LATER,[reviewed,{...director,identity:{...director.identity,status:'rejected'}},other]).reason,'rejected_role');
assert.equal(applyPersonNameReview(reviewed,roleCommand([{id:director.id,expectedVersion:personNameVersion(director)}]),LATER,[]).reason,'unknown_role','roles must be among the supplied records');
assert.equal(Object.hasOwn(applyPersonNameReview(reviewed,roleCommand([{id:director.id,expectedVersion:state.version}]),LATER,linkedPeople),'person'),false);

// Reviewed precedence: later automatic or dictionary inputs cannot replace the owner's name.
const refreshed=reconcilePersonName(corrected,{status:'provisional',value:'Крис Пратт 2',source:'wikidata',provenance:{source:'wikidata'}},LATER);
assert.equal(refreshed.localization,corrected.localization);
assert.equal(refreshed.localizationConflicts.length,1);
assert.equal(refreshed.localizationConflicts[0].reason,'owner_kept');
assert.equal(refreshed.aliases.some(alias=>alias.value==='Крис Пратт 2'),true,'the held value is kept as an alias');
assert.equal(personNameState(refreshed).heldConflicts,1);
assert.notEqual(personNameVersion(refreshed),second.version,'a held value is a version change');
const heldAgain=reconcilePersonName(refreshed,{status:'provisional',value:'Крис Пратт 2',source:'wikidata',provenance:{source:'wikidata'}},LATER+60000);
assert.equal(heldAgain,refreshed,'the same held value is not appended on the next read');
assert.equal(heldAgain.localizationConflicts.length,1);
const dictionaryLater=reconcilePersonName(corrected,{status:'reviewed',authority:'dictionary',value:'Словарный Прэтт',source:'dictionary',provenance:{sources:['https://example.org']}},LATER);
assert.equal(dictionaryLater.localization,corrected.localization,'a later dictionary value does not replace the owner');
assert.equal(dictionaryLater.localizationConflicts[0].reason,'owner_kept');
assert.equal(reconcilePersonName(corrected,{status:'reviewed',authority:'dictionary',value:'Крис Прэтт',source:'dictionary'},LATER),corrected,'the same value is not a conflict');
assert.equal(applyAutomaticLocalization(corrected,{status:'provisional',value:'Подмена',source:'wikidata'},LATER,'name').localization,corrected.localization);
assert.equal(applyReviewedLocalization(corrected,{value:'Чужое',authority:'wikidata',source:'wikidata'},LATER,'name').localization,corrected.localization);
assert.equal(transition(corrected.localization,'provisional').ok,false);
assert.equal(transition(corrected.localization,'missing').ok,false);
// A record the owner has not reviewed follows the lifecycle contract.
const promoted=reconcilePersonName(actor,{status:'reviewed',authority:'dictionary',value:'Крис Прэтт',source:'dictionary'},LATER);
assert.equal(promoted.localization.status,'reviewed');
assert.equal(promoted.localization.provenance.authority,'dictionary');
assert.equal(promoted.aliases.some(alias=>alias.value==='Крис Пратт'),true);
const replacedDictionary=reconcilePersonName(dictionary,{status:'reviewed',authority:'dictionary',value:'Делия Энеа (новая)',source:'dictionary'},LATER);
assert.equal(replacedDictionary.localization.value,'Делия Энеа (новая)','a dictionary value replaces an earlier dictionary value');
const automatic=reconcilePersonName(director,{status:'provisional',value:'Крис Прэтт (кэш)',source:'wikidata',provenance:{source:'wikidata'}},LATER);
assert.equal(automatic.localization.status,'provisional');
assert.equal(automatic.localization.value,'Крис Прэтт (кэш)');
assert.equal(reconcilePersonName(dictionary,{status:'provisional',value:'Автомат',source:'wikidata'},LATER).localizationConflicts[0].reason,'untrusted_review');
// An owner rename of a dictionary name stores that dictionary value once, and the audit after-token is the reconstructed record.
const dictionaryCommand={personId:dictionary.id,requestId:'req-delia',mode:'manual',value:'Делия Енеа',expectedVersion:personNameVersion(dictionary)};
const dictionaryReview=applyPersonNameReview(dictionary,dictionaryCommand,LATER,[dictionary]);
assert.equal(dictionaryReview.ok,true);
assert.equal(dictionaryReview.person.localization.value,'Делия Енеа');
assert.equal(dictionaryReview.person.localizationConflicts.length,1);
assert.equal(dictionaryReview.person.localizationConflicts[0].reason,'owner_kept');
assert.equal(dictionaryReview.person.localizationConflicts[0].value,'Делия Энеа');
assert.equal(dictionaryReview.version,personNameVersion(dictionaryReview.person));
const dictionaryLive={status:dictionary.localization.status,value:dictionary.localization.value,source:dictionary.localization.source,authority:dictionary.localization.provenance?.authority||null,provenance:dictionary.localization.provenance};
const dictionaryRead=reconcilePersonName(dictionaryReview.person,dictionaryLive,LATER+60000);
assert.equal(dictionaryRead,dictionaryReview.person,'a later read of the same dictionary value adds no conflict');
assert.equal(personNameReviewCompletion(dictionaryReview.review,dictionaryRead,[]).complete,true,'the stored after-token matches the reconstructed record');
const dictionarySecond=applyPersonNameReview(dictionaryRead,{...dictionaryCommand,requestId:'req-delia-2',value:'Делия Енея',expectedVersion:dictionaryReview.version},LATER+120000,[dictionaryRead]);
assert.equal(dictionarySecond.ok,true);
assert.equal(dictionarySecond.changed,true);
assert.equal(dictionarySecond.person.localizationConflicts.filter(item=>item.reason==='owner_kept'&&item.value==='Делия Энеа').length,1,'a second edit keeps the one held dictionary value');
assert.equal(reconcilePersonName(null,{value:'x'},LATER),null);

// Validation failures, each without any change.
const fresh=personNameVersion(actor);
const expectFailure=(command,reason,person=actor)=>{const result=applyPersonNameReview(person,command,NOW,people);assert.equal(result.ok,false,reason);assert.equal(result.reason,reason);assert.equal(Object.hasOwn(result,'person'),false);return result;};
expectFailure({personId:'person:other',requestId:'r',mode:'manual',value:'X',expectedVersion:fresh},'person_mismatch');
expectFailure({personId:actor.id,mode:'manual',value:'X',expectedVersion:fresh},'missing_request_id');
expectFailure({personId:actor.id,requestId:' ',mode:'manual',value:'X',expectedVersion:fresh},'missing_request_id');
expectFailure({personId:actor.id,requestId:'r',mode:'pick',value:'X',expectedVersion:fresh},'invalid_mode');
expectFailure({personId:actor.id,requestId:'r',mode:'manual',value:'',expectedVersion:fresh},'invalid_name');
expectFailure({personId:actor.id,requestId:'r',mode:'manual',value:'Д'.repeat(201),expectedVersion:fresh},'invalid_name');
expectFailure({personId:actor.id,requestId:'r',mode:'manual',value:42,expectedVersion:fresh},'invalid_name');
assert.equal(validatePersonNameReview(actor,{personId:actor.id,requestId:'r',mode:'manual',value:'Таб\tи\nперенос',expectedVersion:fresh}).value,'Таб и перенос');
expectFailure({personId:actor.id,requestId:'r',mode:'manual',value:'X',basis:42,expectedVersion:fresh},'invalid_basis');
deepEqual(expectFailure({personId:actor.id,requestId:'r',mode:'alias',value:'Нет такого',expectedVersion:fresh},'unknown_alias').options,['Крис Пратт','Chris Pratt']);
expectFailure({personId:actor.id,requestId:'r',mode:'manual',value:'X',expectedVersion:fresh},'rejected_identity',{...actor,identity:{...actor.identity,status:'rejected'}});
assert.equal(validatePersonNameReview({...actor,identity:{...actor.identity,status:'rejected'}},{personId:actor.id,requestId:'r',mode:'manual',value:'',expectedVersion:fresh}).reason,'invalid_name','shape checks come first');
assert.equal(applyPersonNameReview(null,{personId:'x',requestId:'r',mode:'manual',value:'X'},NOW).reason,'missing_person');
assert.equal(applyPersonNameReview(actor,null,NOW).reason,'invalid_command');
assert.equal(applyPersonNameReview(actor,['x'],NOW).reason,'invalid_command');
assert.equal(snapshot(people),frozen,'failed commands never mutate the records');

// A person with no localization at all: alias mode can pick the original credit text.
const fromMissing=applyPersonNameReview(director,{personId:director.id,requestId:'req-m',mode:'alias',value:'Chris Pratt',expectedVersion:personNameVersion(director)},NOW);
assert.equal(fromMissing.ok,true);
assert.equal(fromMissing.person.localization.status,'reviewed');
assert.equal(fromMissing.review.from.status,'missing');
assert.equal(fromMissing.review.selectedFrom,'letterboxd');
assert.equal(fromMissing.person.aliases.some(alias=>alias.value==='Chris Pratt'),false);

// Admin projection: the reviewed name is what search and the queues see; the old name still matches through its alias.
const projection=personNameProjection(corrected);
assert.equal(projection.preferred,'Крис Прэтт');
assert.equal(personNameProjection(director).preferred,null,'an original credit is not a preferred name');
deepEqual(searchPeople([projection,personNameProjection(other)],{query:'крис прэтт',limit:5}).items.map(item=>item.id),[actor.id]);
deepEqual(searchPeople([projection,personNameProjection(other)],{query:'Крис Пратт',limit:5}).items.map(item=>item.id),[actor.id]);
assert.equal(searchPeople([projection],{query:'Chris Pratt',limit:5}).items.length,1);
deepEqual(personQueue([projection,personNameProjection(actor)],{queue:'localization-provisional',limit:5}).items.map(item=>item.id),[actor.id],'only the provisional record is queued');
assert.equal(personQueue([projection],{queue:'localization-provisional',limit:5}).items.length,0,'a reviewed person leaves the provisional queue');
assert.equal(personQueue([personNameProjection(refreshed)],{queue:'localization-conflict',limit:5}).items.length,1,'a held automatic value is visible as a conflict');
// Two reviewed roles of the same human are two search rows with a collision flag, not one merged record.
const twoRoles=searchPeople([projection,personNameProjection(linkedDirector)],{query:'Крис Прэтт',limit:5});
deepEqual(twoRoles.items.map(item=>[item.id,item.collision]),[[actor.id,true],[director.id,true]]);

// Adding an alias does not replace the preferred name. Promoting keeps the previous preferred selectable.
const sandra=personView({roleId:'actor/sandra-bullock',original:'Sandra Bullock',cacheName:'Сандра Буллок',now:NOW});
const sandraVersion=personNameVersion(sandra);
const added=applyPersonNameReview(sandra,{personId:sandra.id,requestId:'add-1',mode:'manual',value:'Сандра Баллок',basis:'устаревший вариант',expectedVersion:sandraVersion,effect:'add_alias'},NOW);
assert.equal(added.ok,true);
assert.equal(added.changed,true);
assert.equal(added.review.effect,'alias_added');
assert.equal(added.person.localization.value,'Сандра Буллок');
assert.equal(added.person.localization.status,'provisional');
assert.equal(added.person.localization.source,'wikidata');
assert.notEqual(added.person.localization.provenance?.authority,'owner');
assert.equal(added.person.original,'Sandra Bullock');
assert.deepEqual(added.person.roleLinks??[],[]);
assert.equal(added.person.identity.status,sandra.identity.status);
assert.equal(added.person.aliases.filter(alias=>alias.value==='Сандра Баллок').length,1);
assert.equal(added.person.aliases.find(alias=>alias.value==='Сандра Баллок').provenance.authority,'owner');
const addedSearch=personNameProjection(added.person);
assert.equal(addedSearch.preferred,'Сандра Буллок');
assert.equal(searchPeople([addedSearch],{query:'Сандра Баллок',limit:5}).items.length,1);
assert.equal(searchPeople([addedSearch],{query:'Сандра Буллок',limit:5}).items.length,1);
const duplicate=applyPersonNameReview(added.person,{personId:sandra.id,requestId:'add-2',mode:'manual',value:'Сандра Баллок',expectedVersion:added.version,effect:'add_alias'},NOW);
assert.equal(duplicate.ok,true);
assert.equal(duplicate.changed,false);
assert.equal(duplicate.reason,'duplicate_alias');
assert.equal(duplicate.review,null);
assert.equal(added.person.aliases.filter(alias=>alias.value==='Сандра Баллок').length,1);
const replayed=applyPersonNameReview(added.person,{personId:sandra.id,requestId:'add-1',mode:'manual',value:'Сандра Баллок',basis:'устаревший вариант',expectedVersion:'stale',effect:'add_alias'},NOW);
assert.equal(replayed.idempotent,true);
assert.equal(applyPersonNameReview(added.person,{personId:sandra.id,requestId:'add-1',mode:'manual',value:'Сандра Баллок',expectedVersion:added.version,effect:'promote'},NOW).reason,'request_id_reused');
assert.equal(applyPersonNameReview(sandra,{personId:sandra.id,requestId:'add-roles',mode:'manual',value:'Ещё',expectedVersion:sandraVersion,effect:'add_alias',roles:[{id:director.id,expectedVersion:personNameVersion(director)}]},NOW,people).reason,'roles_not_allowed');
assert.equal(applyPersonNameReview(sandra,{personId:sandra.id,requestId:'add-bad',mode:'manual',value:'Ещё',expectedVersion:sandraVersion,effect:'replace'},NOW).reason,'invalid_effect');
assert.equal(applyPersonNameReview(sandra,{personId:sandra.id,requestId:'add-stale',mode:'manual',value:'Ещё имя',expectedVersion:'stale',effect:'add_alias'},NOW).reason,'version_conflict');
const sandraPromoted=applyPersonNameReview(added.person,{personId:sandra.id,requestId:'prom-1',mode:'manual',value:'Сандра Баллок',expectedVersion:added.version,effect:'promote'},NOW);
assert.equal(sandraPromoted.ok,true,sandraPromoted.reason);
assert.equal(sandraPromoted.review.effect,'preferred_changed');
assert.equal(sandraPromoted.person.localization.value,'Сандра Баллок');
assert.equal(sandraPromoted.person.localization.provenance.authority,'owner');
const previous=sandraPromoted.person.aliases.find(alias=>alias.value==='Сандра Буллок');
assert.equal(previous.provenance.previousPreferred,true);
assert.equal(previous.provenance.historicalSource,'wikidata');
assert.equal(sandraPromoted.person.aliases.find(alias=>alias.value==='Sandra Bullock').provenance.previousPreferred,undefined);
const restored=applyPersonNameReview(sandraPromoted.person,{personId:sandra.id,requestId:'prom-2',mode:'alias',value:'Сандра Буллок',expectedVersion:sandraPromoted.version,effect:'promote'},NOW);
assert.equal(restored.ok,true,restored.reason);
assert.equal(restored.person.localization.value,'Сандра Буллок');
assert.equal(restored.person.aliases.find(alias=>alias.value==='Сандра Баллок').provenance.previousPreferred,true);
assert.equal(snapshot(sandra)!==snapshot(added.person),true);

console.log('Person name review: options, collisions and version token, alias and manual reviews with role links, CAS and idempotency, reviewed precedence, validation failures and admin projection passed');
