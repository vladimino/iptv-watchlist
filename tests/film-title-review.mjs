import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {filmQueue,searchFilms} from '../src/domain/admin-query.js';

const domain=fs.readFileSync('src/domain/film-person.js','utf8'),review=fs.readFileSync('src/domain/film-title-review.js','utf8');
// Offline contract: pure and dependency-free. The Worker bundle loads it; these functions do not write.
assert.doesNotMatch(review,/\b(fetch|import|export|require|BUCKET|wrangler|R2|D1)\b/);
assert.doesNotMatch(review,/linkFilms\(|localFilmId\(|externalIds\(|mergeExternal\(|identityState\(/,'a title review never mints or links identity');
// Both files share one script scope, so a top-level name defined twice would silently replace the lifecycle contract's function.
const topLevelNames=source=>new Set([...source.matchAll(/^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(match=>match[1]));
const lifecycleNames=topLevelNames(domain);
for(const name of topLevelNames(review))assert.equal(lifecycleNames.has(name),false,`${name} is already defined by film-person.js`);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/mcp.js','src/continuation.js','public/app.js','public/admin.js','src/admin/client.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/film-title-review|applyTitleReview|titleReviewState/,file);
assert.match(fs.readFileSync('build.mjs','utf8'),/src\/domain\/film-title-review\.js/);
assert.match(fs.readFileSync('src/admin/film-title-route.js','utf8'),/applyTitleReview/);
assert.match(fs.readFileSync('src/admin/read.js','utf8'),/titleReviewState/);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/film-title-review|applyTitleReview|titleReviewState/);

const ctx=vm.createContext({Date,Map,Set,JSON,Object,Math});
vm.runInContext(domain+'\n'+review+'\nglobalThis.api={filmView,preferredTitle,applyAutomaticLocalization,applyReviewedLocalization,linkFilms,transition,TITLE_REVIEW_CONTRACT_VERSION,TITLE_REVIEW_MODES,titleReviewVersion,titleReviewOptions,titleReviewState,titleReviewProjection,validateTitleReview,applyTitleReview};',ctx);
const {filmView,preferredTitle,applyAutomaticLocalization,linkFilms,transition,TITLE_REVIEW_CONTRACT_VERSION,TITLE_REVIEW_MODES,titleReviewVersion,titleReviewOptions,titleReviewState,titleReviewProjection,validateTitleReview,applyTitleReview}=ctx.api;

const NOW=Date.parse('2026-10-25T12:00:00.000Z');
const LATER=NOW+60000;
const DAY=86400000;
const FRESH=new Date(NOW-2*DAY).toISOString();
const snapshot=value=>JSON.stringify(value);
// Values built inside the vm realm have their own Array/Object prototypes; compare them as plain data.
const plain=value=>JSON.parse(JSON.stringify(value));
const deepEqual=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);

function facts(extra={}){
 return {letterboxdId:'28nq',tmdbId:'1656',now:NOW,decision:{status:'verified'},metadata:{present:true,metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsisPresent:true},title:{original:'The Legend of Zorro',epgTitle:'Зорро (2005)',provisional:{title:'Легенда о Зорро',sources:['wikidata']}},fingerprint:{present:true,schemaVersion:1,invalidatedAt:null,generatedAt:FRESH},prediction:{present:true,tasteProfileVersion:3,tasteProfileHash:'profile-a',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1},profile:{version:3,profileHash:'profile-a'},currentFingerprintHash:'print-a',...extra};
}
const provisional=filmView(facts());
assert.equal(provisional.localization.status,'provisional');
assert.equal(provisional.localization.value,'Легенда о Зорро');
assert.equal(provisional.canonicalIdentity,'tmdb:1656');
const frozen=snapshot(provisional);

// Read model: options in display order, no duplicates, the preferred one flagged, a version token.
assert.equal(TITLE_REVIEW_CONTRACT_VERSION,1);
deepEqual([...TITLE_REVIEW_MODES],['alias','manual']);
const state=titleReviewState(provisional);
assert.equal(state.filmId,'film:28nq');
assert.equal(state.canonicalIdentity,'tmdb:1656');
assert.equal(state.preferred.value,'Легенда о Зорро');
assert.equal(state.preferred.status,'provisional');
assert.equal(state.preferred.reviewedAt,null);
assert.equal(state.preferred.authority,null);
// filmView already records the original and EPG titles as aliases, so they show up as aliases with their source.
deepEqual(state.options.map(option=>[option.value,option.origin,option.preferred]),[['Легенда о Зорро','preferred',true],['The Legend of Zorro','alias',false],['Зорро (2005)','alias',false]]);
assert.equal(state.options[1].provenance.source,'letterboxd');
assert.equal(state.options[2].provenance.source,'epg');
// A bare record without alias seeds falls back to the original and EPG facts.
deepEqual(titleReviewOptions({id:'film:x',originalTitle:'Orig',epgTitle:'Epg',aliases:[],localization:{status:'missing',value:null}}).map(option=>[option.value,option.origin]),[['Orig','original'],['Epg','epg']]);
deepEqual(state.reviews,[]);
assert.equal(state.heldConflicts,0);
assert.match(state.version,/^title-review:1:[0-9a-f]{14}$/);
assert.equal(state.version,titleReviewVersion(provisional),'the token is deterministic');
assert.equal(titleReviewVersion({...provisional,aliases:[...provisional.aliases,{kind:'title',value:'Ещё одно'}]})===state.version,false,'an alias change is a version change');
assert.equal(titleReviewVersion({...provisional,metadata:{...provisional.metadata,status:'stale'}}),state.version,'metadata is not part of the title version');
assert.equal(titleReviewVersion({...provisional,fingerprint:{...provisional.fingerprint,status:'stale'},prediction:{...provisional.prediction,status:'stale'}}),state.version,'fingerprint and prediction are not part of the title version');
// Provenance-only concurrent changes are version changes too: the screen shows provenance, so a stale screen must not pass CAS.
assert.notEqual(titleReviewVersion({...provisional,localization:{...provisional.localization,provenance:{...provisional.localization.provenance,basis:'другое основание'}}}),state.version,'a localization provenance change is a version change');
assert.notEqual(titleReviewVersion({...provisional,localization:{...provisional.localization,provenance:{...provisional.localization.provenance,requestId:'req-x'}}}),state.version,'a localization requestId change is a version change');
assert.notEqual(titleReviewVersion({...provisional,aliases:provisional.aliases.map((alias,index)=>index===0?{...alias,provenance:{...alias.provenance,source:'tmdb'}}:alias)}),state.version,'an alias provenance change is a version change');
assert.notEqual(titleReviewVersion({...provisional,localizationConflicts:[{reason:'untrusted_review',value:'Удержано'}]}),state.version,'a held conflict is a version change');
assert.notEqual(titleReviewVersion({...provisional,aliases:[],epgTitle:'Зорро (2006)'}),titleReviewVersion({...provisional,aliases:[]}),'an option text change is a version change');
assert.equal(titleReviewVersion({...provisional,aliases:[provisional.aliases[1],provisional.aliases[0],...provisional.aliases.slice(2)]}),state.version,'alias order does not matter');
assert.equal(titleReviewVersion({...provisional,localization:Object.fromEntries(Object.entries(provisional.localization).reverse())}),state.version,'key order does not matter');
assert.equal(snapshot(provisional),frozen,'reading does not mutate');
const dedupe=titleReviewOptions({...provisional,aliases:[{kind:'title',value:'The Legend of Zorro',provenance:{source:'epg'}},{kind:'name',value:'Not a title'}]});
deepEqual(dedupe.map(option=>option.value),['Легенда о Зорро','The Legend of Zorro','Зорро (2005)']);
assert.equal(dedupe[1].origin,'alias','the first occurrence wins');

// Alias mode: the EPG title becomes the reviewed preferred title; the provisional value is kept as an alias.
const pickEpg={filmId:'film:28nq',requestId:'req-1',mode:'alias',value:'Зорро (2005)',expectedVersion:state.version};
const checked=validateTitleReview(provisional,pickEpg);
assert.equal(checked.ok,true);
assert.equal(checked.selected.origin,'alias');
assert.equal(checked.selected.provenance.source,'epg');
const first=applyTitleReview(provisional,pickEpg,NOW);
assert.equal(first.ok,true);
assert.equal(first.changed,true);
assert.equal(first.idempotent,false);
const reviewed=first.film;
assert.equal(reviewed.localization.status,'reviewed');
assert.equal(reviewed.localization.value,'Зорро (2005)');
assert.equal(reviewed.localization.source,'owner');
assert.equal(reviewed.localization.sourceVersion,'owner');
assert.equal(reviewed.localization.updatedAt,new Date(NOW).toISOString());
assert.equal(reviewed.localization.nextAction,'keep_reviewed');
deepEqual(reviewed.localization.provenance,{source:'owner',authority:'owner',mode:'alias',basis:null,requestId:'req-1',selectedFrom:'epg'});
assert.equal(preferredTitle(reviewed),'Зорро (2005)');
assert.equal(reviewed.aliases.some(alias=>alias.value==='Легенда о Зорро'&&alias.kind==='title'),true,'the old preferred title is preserved as an alias');
assert.equal(reviewed.aliases.find(alias=>alias.value==='Легенда о Зорро').provenance.value,'Легенда о Зорро');
assert.equal(reviewed.aliases.some(alias=>alias.value==='The Legend of Zorro'),true);
assert.equal(reviewed.aliases.some(alias=>alias.value==='Зорро (2005)'),false,'the preferred title is not also an alias');
assert.equal(reviewed.id,provisional.id);
assert.equal(reviewed.canonicalIdentity,provisional.canonicalIdentity);
deepEqual(reviewed.externalIds,provisional.externalIds);
deepEqual(reviewed.identity,provisional.identity);
deepEqual(reviewed.metadata,provisional.metadata);
deepEqual(reviewed.fingerprint,provisional.fingerprint);
deepEqual(reviewed.prediction,provisional.prediction);
deepEqual(reviewed.localizationConflicts,[]);
assert.equal(snapshot(provisional),frozen,'the input Film is not mutated');
// Audit entry and version.
assert.equal(reviewed.titleReviews.length,1);
assert.equal(first.review,reviewed.titleReviews[0]);
deepEqual(first.review,{contractVersion:1,requestId:'req-1',filmId:'film:28nq',at:new Date(NOW).toISOString(),mode:'alias',authority:'owner',basis:null,selectedFrom:'epg',from:{value:'Легенда о Зорро',status:'provisional',source:'wikidata'},to:{value:'Зорро (2005)',status:'reviewed'},version:{before:state.version,after:first.version}});
assert.notEqual(first.version,state.version);
assert.equal(first.version,titleReviewVersion(reviewed));
assert.equal(titleReviewState(reviewed).preferred.reviewedAt,new Date(NOW).toISOString());
assert.equal(titleReviewState(reviewed).preferred.authority,'owner');
deepEqual(titleReviewState(reviewed).options.map(option=>[option.value,option.origin]),[['Зорро (2005)','preferred'],['The Legend of Zorro','alias'],['Легенда о Зорро','alias']]);

// Compare-and-set: the token from before the review is stale now.
const stale=applyTitleReview(reviewed,{filmId:'film:28nq',requestId:'req-2',mode:'manual',value:'Легенда Зорро',expectedVersion:state.version},LATER);
assert.equal(stale.ok,false);
assert.equal(stale.reason,'version_conflict');
assert.equal(stale.expected,first.version);
assert.equal(stale.received,state.version);
assert.equal(validateTitleReview(reviewed,{filmId:'film:28nq',requestId:'req-2',mode:'manual',value:'Легенда Зорро'}).reason,'version_conflict','a missing token is a conflict, not a bypass');

// Idempotency: the same requestId with the same payload replays, with a different payload is refused.
// pickEpg still carries the token from before the review, so this is the retry with a stale expectedVersion.
assert.notEqual(pickEpg.expectedVersion,first.version);
const replay=applyTitleReview(reviewed,pickEpg,LATER);
assert.equal(replay.ok,true);
assert.equal(replay.idempotent,true);
assert.equal(replay.changed,false);
assert.equal(replay.film,reviewed,'the same Film object comes back');
assert.equal(replay.review,reviewed.titleReviews[0]);
assert.equal(replay.version,first.version);
assert.equal(applyTitleReview(reviewed,{...pickEpg,expectedVersion:undefined},LATER).idempotent,true,'a retry without a token replays too');
assert.equal(applyTitleReview(reviewed,{...pickEpg,value:'  Зорро   (2005) ',basis:'   '},LATER).idempotent,true,'normalized value and blank basis match the committed request');
const reused=applyTitleReview(reviewed,{...pickEpg,mode:'manual',value:'Другое',expectedVersion:first.version},LATER);
assert.equal(reused.ok,false);
assert.equal(reused.reason,'request_id_reused');
assert.equal(reused.review.requestId,'req-1');
// Replay identity covers every semantic field, not only mode and value.
const reusedBasis=applyTitleReview(reviewed,{...pickEpg,basis:'Другое основание'},LATER);
assert.equal(reusedBasis.ok,false,'a changed basis under the same requestId is not a replay');
assert.equal(reusedBasis.reason,'request_id_reused');
assert.equal(applyTitleReview(reviewed,{...pickEpg,mode:'manual'},LATER).reason,'request_id_reused','a changed mode is not a replay');
// Shape checks run before the replay lookup: a mismatching Film or an identity payload is refused, never replayed.
const otherFilm=applyTitleReview(reviewed,{...pickEpg,filmId:'film:other'},LATER);
assert.equal(otherFilm.ok,false);
assert.equal(otherFilm.reason,'film_mismatch');
assert.equal(Object.hasOwn(otherFilm,'idempotent'),false);
for(const field of ['canonicalIdentity','externalIds','identity','tmdbId','letterboxdId','id','redirects']){
 const forbidden=applyTitleReview(reviewed,{...pickEpg,[field]:'tmdb:999'},LATER);
 assert.equal(forbidden.ok,false,field);
 assert.equal(forbidden.reason,'identity_change_forbidden');
 assert.equal(forbidden.field,field);
}
assert.equal(applyTitleReview(reviewed,{...pickEpg,mode:'pick'},LATER).reason,'invalid_mode');
assert.equal(applyTitleReview(reviewed,{...pickEpg,value:'Зорро\u0007(2005)'},LATER).reason,'invalid_title');
assert.equal(applyTitleReview(reviewed,{...pickEpg,basis:'b'.repeat(501)},LATER).reason,'invalid_basis');
// An audit entry recorded for another Film never replays here, even with a matching requestId.
const foreign={...reviewed,titleReviews:[{...reviewed.titleReviews[0],filmId:'film:other'}]};
assert.equal(applyTitleReview(foreign,pickEpg,LATER).reason,'request_id_reused');
assert.equal(reviewed.titleReviews.length,1,'replays and refusals leave the audit as it was');
// Re-sending the current reviewed title under a new requestId changes nothing and leaves no audit noise.
const same=applyTitleReview(reviewed,{filmId:'film:28nq',requestId:'req-3',mode:'manual',value:'  Зорро   (2005) ',expectedVersion:first.version},LATER);
assert.equal(same.ok,true);
assert.equal(same.changed,false);
assert.equal(same.idempotent,false);
assert.equal(same.film,reviewed);
assert.equal(same.review,null);
assert.equal(reviewed.titleReviews.length,1);

// Manual mode: a typed title with a basis; the previous reviewed value stays as an alias and the audit grows.
const typed={filmId:'film:28nq',requestId:'req-4',mode:'manual',value:'Легенда Зорро',basis:'Официальный прокатный перевод',expectedVersion:first.version};
const second=applyTitleReview(reviewed,typed,LATER);
assert.equal(second.ok,true);
assert.equal(second.changed,true);
const corrected=second.film;
assert.equal(corrected.localization.status,'reviewed');
assert.equal(corrected.localization.value,'Легенда Зорро');
assert.equal(corrected.localization.provenance.basis,'Официальный прокатный перевод');
assert.equal(corrected.localization.provenance.mode,'manual');
assert.equal(corrected.localization.provenance.selectedFrom,null);
assert.equal(corrected.localization.updatedAt,new Date(LATER).toISOString());
deepEqual(corrected.aliases.map(alias=>alias.value).sort(),['The Legend of Zorro','Зорро (2005)','Легенда о Зорро'].sort());
assert.equal(corrected.aliases.find(alias=>alias.value==='Зорро (2005)').provenance.authority,'owner','the replaced reviewed title keeps its provenance');
assert.equal(corrected.titleReviews.length,2);
assert.equal(corrected.titleReviews[1].from.value,'Зорро (2005)');
assert.equal(corrected.titleReviews[1].from.status,'reviewed');
assert.equal(corrected.titleReviews[1].basis,'Официальный прокатный перевод');
assert.equal(corrected.titleReviews[1].filmId,'film:28nq');
assert.equal(applyTitleReview(corrected,typed,LATER).idempotent,true,'a manual review with a basis replays with the same basis');
assert.equal(applyTitleReview(corrected,{...typed,basis:'  Официальный прокатный перевод  '},LATER).idempotent,true,'basis whitespace is normalized for replay');
assert.equal(applyTitleReview(corrected,{...typed,basis:null},LATER).reason,'request_id_reused','dropping the basis is a different request');
assert.equal(corrected.titleReviews[1].version.before,first.version);
assert.equal(corrected.titleReviews[1].version.after,second.version);
assert.equal(second.version,titleReviewVersion(corrected),'stamping version.after on the new entry does not move the token');
// The audit history is part of the token in full: a metadata-only correction to an earlier entry under the same requestId is a version change.
const historyEdit=(patch,index=0)=>titleReviewVersion({...corrected,titleReviews:corrected.titleReviews.map((review,i)=>i===index?{...review,...patch}:review)});
assert.notEqual(historyEdit({basis:'Задним числом'}),second.version,'an audit basis edit is a version change');
assert.notEqual(historyEdit({selectedFrom:'wikidata'}),second.version,'an audit provenance edit is a version change');
assert.notEqual(historyEdit({at:new Date(LATER).toISOString()}),second.version,'an audit timestamp edit is a version change');
assert.notEqual(historyEdit({from:{...corrected.titleReviews[0].from,value:'Другое'}}),second.version,'an audit from/to edit is a version change');
assert.notEqual(historyEdit({version:{...corrected.titleReviews[0].version,before:'title-review:1:00000000000000'}}),second.version,'an audit version.before edit is a version change');
assert.equal(historyEdit({version:{...corrected.titleReviews[0].version,after:'title-review:1:00000000000000'}}),second.version,'version.after is the one field outside the token');
assert.equal(titleReviewVersion({...corrected,titleReviews:[corrected.titleReviews[1],corrected.titleReviews[0]]})===second.version,false,'audit order is part of the history');
assert.equal(applyTitleReview({...corrected,titleReviews:corrected.titleReviews.map((review,i)=>i===0?{...review,basis:'Задним числом'}:review)},{filmId:'film:28nq',requestId:'req-6',mode:'alias',value:'Зорро (2005)',expectedVersion:second.version},LATER).reason,'version_conflict','a review prepared before the history edit is refused');
assert.equal(corrected.titleReviews[0],reviewed.titleReviews[0],'earlier audit entries are kept as they were');
assert.equal(corrected.canonicalIdentity,'tmdb:1656');
assert.equal(snapshot(reviewed.titleReviews),snapshot(first.film.titleReviews));

// Reviewed precedence: automatic refreshes cannot downgrade or replace the owner's title.
const refreshed=applyAutomaticLocalization(corrected,{status:'provisional',value:'Легенда о Зорро 2',source:'wikidata',provenance:{source:'wikidata'}},LATER);
assert.equal(refreshed.localization,corrected.localization);
assert.equal(refreshed.localizationConflicts.length,1);
assert.equal(refreshed.localizationConflicts[0].reason,'untrusted_review');
assert.equal(refreshed.aliases.some(alias=>alias.value==='Легенда о Зорро 2'),true,'the held value is kept as an alias');
assert.equal(titleReviewState(refreshed).heldConflicts,1);
// The held value changed what the screen shows, so a review prepared from the earlier screen must reload.
assert.notEqual(titleReviewVersion(refreshed),second.version);
assert.equal(applyTitleReview(refreshed,{filmId:'film:28nq',requestId:'req-5',mode:'alias',value:'Легенда о Зорро 2',expectedVersion:second.version},LATER).reason,'version_conflict');
assert.equal(applyTitleReview(refreshed,typed,LATER).idempotent,true,'the committed request still replays after the concurrent change');
assert.equal(transition(corrected.localization,'provisional').ok,false);
assert.equal(transition(corrected.localization,'missing').ok,false);
const spoofed=applyAutomaticLocalization(corrected,{status:'reviewed',value:'Подмена',source:'wikidata',provenance:{source:'wikidata'}},LATER);
assert.equal(spoofed.localization,corrected.localization);
// A later dictionary verification does not silently override the owner either way: it is a reviewed→reviewed transition that applyReviewedLocalization allows only for a trusted authority.
const dictionary=ctx.api.applyReviewedLocalization(corrected,{value:'Словарный вариант',authority:'wikidata',source:'wikidata'},LATER);
assert.equal(dictionary.localization,corrected.localization);
assert.equal(dictionary.localizationConflicts.at(-1).reason,'untrusted_authority');
// Linking an incoming record keeps the survivor's reviewed title.
const linked=linkFilms(corrected,{...corrected,id:'film:tmdb:1656',localization:{...corrected.localization,value:'Другое проверенное'},titleReviews:[]},LATER);
assert.equal(linked.ok,true);
assert.equal(linked.survivor.localization.value,'Легенда Зорро');
assert.equal(linked.survivor.titleReviews.length,2);

// Validation failures, each without any change.
const fresh=titleReviewVersion(provisional);
const expectFailure=(command,reason,film=provisional)=>{const result=applyTitleReview(film,command,NOW);assert.equal(result.ok,false,reason);assert.equal(result.reason,reason);assert.equal(Object.hasOwn(result,'film'),false);return result;};
expectFailure({filmId:'film:other',requestId:'r',mode:'manual',value:'X',expectedVersion:fresh},'film_mismatch');
expectFailure({filmId:'film:28nq',mode:'manual',value:'X',expectedVersion:fresh},'missing_request_id');
expectFailure({filmId:'film:28nq',requestId:'  ',mode:'manual',value:'X',expectedVersion:fresh},'missing_request_id');
expectFailure({filmId:'film:28nq',requestId:'r',mode:'pick',value:'X',expectedVersion:fresh},'invalid_mode');
expectFailure({filmId:'film:28nq',requestId:'r',mode:'manual',value:'',expectedVersion:fresh},'invalid_title');
expectFailure({filmId:'film:28nq',requestId:'r',mode:'manual',value:'   ',expectedVersion:fresh},'invalid_title');
expectFailure({filmId:'film:28nq',requestId:'r',mode:'manual',value:'Звонок\u0007внутри',expectedVersion:fresh},'invalid_title');
// Tabs and newlines are whitespace: they collapse into one space instead of being refused.
assert.equal(validateTitleReview(provisional,{filmId:'film:28nq',requestId:'r',mode:'manual',value:'Таб\tи\nперенос',expectedVersion:fresh}).value,'Таб и перенос');
expectFailure({filmId:'film:28nq',requestId:'r',mode:'manual',value:'Д'.repeat(201),expectedVersion:fresh},'invalid_title');
expectFailure({filmId:'film:28nq',requestId:'r',mode:'manual',value:42,expectedVersion:fresh},'invalid_title');
expectFailure({filmId:'film:28nq',requestId:'r',mode:'manual',value:'X',basis:'b'.repeat(501),expectedVersion:fresh},'invalid_basis');
expectFailure({filmId:'film:28nq',requestId:'r',mode:'alias',value:'Нет такого алиаса',expectedVersion:fresh},'unknown_alias');
deepEqual(expectFailure({filmId:'film:28nq',requestId:'r',mode:'alias',value:'Нет такого алиаса',expectedVersion:fresh},'unknown_alias').options,['Легенда о Зорро','The Legend of Zorro','Зорро (2005)']);
for(const field of ['canonicalIdentity','externalIds','identity','tmdbId','letterboxdId','id','redirects'])assert.equal(expectFailure({filmId:'film:28nq',requestId:'r',mode:'manual',value:'X',expectedVersion:fresh,[field]:'tmdb:999'},'identity_change_forbidden').field,field);
expectFailure({filmId:'film:28nq',requestId:'r',mode:'manual',value:'X',expectedVersion:fresh},'rejected_identity',{...provisional,identity:{...provisional.identity,status:'rejected'}});
// Shape failures come before the state checks: a bad title on a rejected or stale Film reports the title.
assert.equal(validateTitleReview({...provisional,identity:{...provisional.identity,status:'rejected'}},{filmId:'film:28nq',requestId:'r',mode:'manual',value:'',expectedVersion:fresh}).reason,'invalid_title');
assert.equal(validateTitleReview(provisional,{filmId:'film:28nq',requestId:'r',mode:'manual',value:'X',basis:42,expectedVersion:'stale'}).reason,'invalid_basis');
assert.equal(validateTitleReview(provisional,{filmId:'film:28nq',requestId:'r',mode:'manual',value:'X',basis:'  Основание  ',expectedVersion:fresh}).basis,'Основание');
assert.equal(applyTitleReview(null,{filmId:'x',requestId:'r',mode:'manual',value:'X'},NOW).reason,'missing_film');
assert.equal(applyTitleReview(provisional,null,NOW).reason,'invalid_command');
assert.equal(applyTitleReview(provisional,['x'],NOW).reason,'invalid_command');
assert.equal(snapshot(provisional),frozen,'failed commands never mutate the Film');

// A film with no localization at all: alias mode can pick the original or EPG title; manual mode works too.
const missing=filmView(facts({title:{original:'Hokum',epgTitle:'Хокум (2026)'}}));
assert.equal(missing.localization.status,'missing');
deepEqual(titleReviewOptions(missing).map(option=>option.value),['Hokum','Хокум (2026)']);
const fromMissing=applyTitleReview(missing,{filmId:missing.id,requestId:'req-m',mode:'alias',value:'Хокум (2026)',expectedVersion:titleReviewVersion(missing)},NOW);
assert.equal(fromMissing.ok,true);
assert.equal(fromMissing.film.localization.status,'reviewed');
assert.equal(fromMissing.review.from.status,'missing');
assert.equal(fromMissing.review.from.value,null);
assert.equal(fromMissing.film.aliases.map(alias=>alias.value).includes('Hokum'),true);

// Admin projection: the reviewed title is what search and the queues see; the old title still matches through its alias.
const projection=titleReviewProjection(corrected);
assert.equal(projection.preferred,'Легенда Зорро');
assert.equal(titleReviewProjection(missing).preferred,null,'an original title is not a preferred title');
const byNew=searchFilms([projection,titleReviewProjection(missing)],{query:'легенда зорро',limit:5});
deepEqual(byNew.items.map(item=>item.id),['film:28nq']);
const byOld=searchFilms([projection,titleReviewProjection(missing)],{query:'Легенда о Зорро',limit:5});
deepEqual(byOld.items.map(item=>item.id),['film:28nq']);
const byEpg=searchFilms([projection],{query:'Зорро (2005)',limit:5});
assert.equal(byEpg.items.length,1);
deepEqual(filmQueue([projection,titleReviewProjection(provisional)],{queue:'localization-provisional',limit:5}).items.map(item=>item.id),['film:28nq'],'only the provisional record is queued');
assert.equal(filmQueue([projection],{queue:'localization-provisional',limit:5}).items.length,0,'a reviewed film leaves the provisional queue');
assert.equal(filmQueue([titleReviewProjection(refreshed)],{queue:'localization-conflict',limit:5}).items.length,1,'a held automatic value is visible as a conflict');

console.log('Film title review: options and version token, alias and manual reviews with preserved aliases and audit, CAS and idempotency, reviewed precedence, validation failures and admin projection passed');
