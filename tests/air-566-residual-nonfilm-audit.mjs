import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ATTEMPT_LIMIT,GROUPS,audit,buildContext,classify,durationsOf,exposure,parseSerial,proposedScreen} from '../scripts/air-566-residual-nonfilm-audit.mjs';

// Synthetic cohort. Titles are invented except the public negative controls (a numbered Star Wars episode, a film with a numeric range).
let n=0;
const row=(t,extra={})=>({ok:'k'+(++n),t,y:null,st:'no_confident_match',tr:'',att:2,ra:'2026-11-28T00:00:00.000Z',dur:'[60]',ds:'',dsh:1,xsh:0,ksh:0,win:1,sl:1,cs:0,oid:false,intent:false,evmis:false,...extra});
const episodes=[1,2,3,4,5,6,7,8].map(i=>row(`Альфа. ${i}-я серия`));
const lowOrdinals=[row('Бета. 1-я серия'),row('Бета. 2-я серия')];
const verifiedStem=[row('Гамма. 9-я серия'),row('Гамма. 3-я серия')];
const yearStem=[row('Вега (1975). 8-я серия'),row('Вега (1975). 2-я серия')];
const dash=[row('Дзета 1-01',{ds:'Дзета 1-01'}),row('Дзета 1-02',{ds:'Дзета 1-02'}),row('Дзета 2-10',{ds:''})];
const dashWithPlot=[row('Тета 1-3',{ds:'Сюжет с настоящим описанием'}),row('Тета 1-4',{ds:'Другой сюжет'})];
const singletonDash=row('Йота 2-5',{ds:'Йота 2-5'});
const filmRange=row('Случай в квадрате 36-80',{ds:'В Северной Атлантике проходят учения',dur:'[69]'});
const pipe=row('Каппа 2|5 Название серии');
const label=row('Лямбда (2026) мини–сериал',{dur:'[190]'});
const abbrev=[row('Мю", 3 сезон, 4 с. "Эпизод',{ds:''}),row('Мю", 3 сезон, 5 с. "Эпизод',{ds:''})];
const seasonOnly=row('Ню шоу 2 сезон');
const decorated=row('Омикрон 2026 Драма');
const starWars=row('Звёздные войны. Эпизод 4: Новая надежда');
const family=Array.from({length:10},(_,i)=>row(`Семейство шоу: выпуск-тема ${i}`));
const plain=row('Обычный фильм',{ds:'Сюжет'});
// Counterexamples of the review: a season number is not an episode ordinal; one abbreviated observation seen twice is one observation;
// a missing or malformed duration fails the dash guard; trusted identity on any slot keeps a row out of every proven group.
const seasonOnlyAlpha=row('Пи 9 сезон'),lowPi=row('Пи. 1-я серия');
const abbrevHigh=row('Хи", 2 сезон, 9 с. "Эпизод',{ds:''}),lowChi=row('Хи. 1-я серия');
const singletonAbbrev=row('Ро", 2 сезон, 3 с. "Эпизод',{ds:''});
const noDuration=[row('Сигма 1-01',{ds:'',dur:null}),row('Сигма 1-02',{ds:'',dur:'not json'})];
const trusted=[row('Альфа. 11-я серия',{cs:1}),row('Альфа. 12-я серия',{oid:true}),row('Альфа. 13-я серия',{intent:true})];
const cohort=[...episodes,...lowOrdinals,...verifiedStem,...yearStem,...dash,...dashWithPlot,singletonDash,filmRange,pipe,label,...abbrev,seasonOnly,decorated,starWars,...family,plain,seasonOnlyAlpha,lowPi,singletonAbbrev,...noDuration,...trusted,abbrevHigh,lowChi];
const verified=[{t:'Гамма'},{t:'Случай в квадрате 36-80',ds:'В Северной Атлантике проходят учения',dur:'[69]'},{t:'Другое: имя'}];
const history=[{ok:singletonAbbrev.ok,t:singletonAbbrev.t,rs:'active'}];
const context=buildContext({cohort,history,verified});
const group=title=>classify(cohort.find(item=>item.t===title),context);

assert.equal(group('Альфа. 3-я серия'),'ordinal_episode_proven');
assert.equal(group('Бета. 1-я серия'),'ordinal_episode_review');
assert.equal(group('Гамма. 9-я серия'),'ordinal_episode_review');
assert.equal(group('Вега (1975). 8-я серия'),'ordinal_episode_review');
assert.equal(group('Дзета 1-01'),'dash_season_episode_placeholder');
assert.equal(group('Дзета 2-10'),'dash_season_episode_placeholder');
assert.equal(group('Тета 1-3'),'numeric_suffix_block_review');
assert.equal(group('Йота 2-5'),'numeric_suffix_block_review');
assert.equal(group('Случай в квадрате 36-80'),'numeric_suffix_block_review');
assert.equal(group('Каппа 2|5 Название серии'),'pipe_season_episode');
assert.equal(group('Лямбда (2026) мини–сериал'),'series_label_suffix');
assert.equal(group('Мю", 3 сезон, 4 с. "Эпизод'),'season_abbrev_episode');
assert.equal(group('Ню шоу 2 сезон'),'season_marker_only');
assert.equal(group('Омикрон 2026 Драма'),'decorated_film_title');
assert.equal(group('Семейство шоу: выпуск-тема 3'),'show_family');
// Negative controls never leave no_proof: a numbered Star Wars episode, an ordinary film.
assert.equal(group('Звёздные войны. Эпизод 4: Новая надежда'),'no_proof');
assert.equal(group('Обычный фильм'),'no_proof');
// A family whose prefix is a verified title is not a show family.
assert.equal(classify(row('Другое: имя 1'),buildContext({cohort:Array.from({length:10},(_,i)=>row(`Другое: имя ${i}`)),history:[],verified})),'no_proof');
// A stem that reaches an ordinal of 7 in the history proves the group, whatever the cohort holds.
assert.equal(classify(row('Бета. 1-я серия'),buildContext({cohort,history:[{ok:'h1',t:'Бета. 7-я серия',rs:'archive'}],verified})),'ordinal_episode_proven');
// Review counterexamples. A season number never proves an episode ordinal of the same stem.
assert.equal(group('Пи. 1-я серия'),'ordinal_episode_review');
assert.equal(group('Пи 9 сезон'),'season_marker_only');
// An abbreviated episode number of the same stem is not an ordinal either, and a singleton abbreviation stays review.
assert.equal(group('Хи. 1-я серия'),'ordinal_episode_review');
assert.equal(group('Хи", 2 сезон, 9 с. "Эпизод'),'ordinal_episode_review');
// One abbreviated observation that appears in the history and in the cohort counts once.
assert.equal(group('Ро", 2 сезон, 3 с. "Эпизод'),'ordinal_episode_review');
// A missing or malformed duration fails the dash guard even for a repeated placeholder stem.
assert.equal(group('Сигма 1-01'),'numeric_suffix_block_review');
assert.equal(group('Сигма 1-02'),'numeric_suffix_block_review');
assert.equal(durationsOf({dur:'[60,70]'}).length,2);for(const dur of [null,'','[]','[0]','[null]','x','[60,"a"]'])assert.equal(durationsOf({dur}),null);
// Trusted identity on a slot, an owner decision or an owner intent keeps a row in review even with a proven ordinal stem.
for(const title of ['Альфа. 11-я серия','Альфа. 12-я серия','Альфа. 13-я серия'])assert.equal(group(title),'trusted_identity_review');
// Ranges and the plural form are parsed; "Эпизод 4" and "Сезон дождей" are not serial forms.
assert.deepEqual(parseSerial('Пример. 1-я - 4-я серии'),{form:'ordinal_range',stem:'пример',n:1,n2:4});
assert.equal(parseSerial('Звёздные войны. Эпизод 4: Новая надежда'),null);
assert.equal(parseSerial('Сезон дождей'),null);
// The controls are required.
assert.throws(()=>buildContext({cohort,verified}),/required/);assert.throws(()=>buildContext({cohort,history}),/required/);

// The proposed stateless predicate uses one programme's title, description and durations only.
assert.equal(proposedScreen(row('Новый. 9-я серия')),'ordinal_episode');
assert.equal(proposedScreen(row('Новый. 6-я серия')),null);
assert.equal(proposedScreen(row('Новый. 3-я - 8-я серии')),'ordinal_episode');
assert.equal(proposedScreen(row('Йота 2-5',{ds:'Йота 2-5'})),'dash_season_episode_placeholder'); // no repeat count is available to it
assert.equal(proposedScreen(row('Йота 2-5',{ds:'Йота 2-5',dur:null})),null);
assert.equal(proposedScreen(row('Йота 2-5',{ds:'Йота 2-5',dur:'[90]'})),null);
assert.equal(proposedScreen(filmRange),null);
assert.equal(proposedScreen(row('Гамма. 9-я серия')),'ordinal_episode');
assert.equal(proposedScreen(row('Гамма. 9-я серия'),{knownTitles:new Set(['гамма'])}),null);
assert.equal(proposedScreen(starWars),null);

const now=Date.parse('2026-11-22T00:00:00.000Z');
const {report,privateRows}=audit({cohort,history,verified},now);
assert.equal(report.total,cohort.length);
assert.equal(Object.values(report.groups).reduce((sum,g)=>sum+g.observations,0),cohort.length);
for(const [name,g] of Object.entries(report.groups))assert.equal(g.class,GROUPS[name]);
assert.equal(report.groups.ordinal_episode_proven.observations,8);
assert.equal(report.groups.ordinal_episode_proven.exposure.attemptsUpperBound,8*(ATTEMPT_LIMIT-2));
assert.equal(report.groups.ordinal_episode_proven.exposure.in_backoff,8);
assert.equal(report.groups.ordinal_episode_proven.exposure.selectable_now,0);
assert.equal(report.groups.trusted_identity_review.observations,3);
// The positive controls: exactly the verified film with a numeric range matches the structural dash predicate, and the proposed predicate
// does not fire on it because its description is a real plot.
assert.equal(report.controls.verifiedTitles,verified.length);
assert.equal(report.controls.structuralMatches.dashCode,1);
assert.equal(report.controls.structuralMatches.pipe,0);
assert.equal(report.controls.proposedPredicate.hits,0);
// The proposed predicate replayed over every row: intersections and additional hits are counted, not assumed.
const proposed=report.proposed.unguarded;
assert.equal(proposed.hits,Object.values(proposed.byReason).reduce((sum,value)=>sum+value,0));
assert.equal(proposed.hits,Object.values(proposed.byClassifierGroup).reduce((sum,value)=>sum+value,0));
assert.equal(proposed.trustedIdentityHits,3); // classify keeps these rows in review, but the predicate itself ignores identity: the rule needs the identity precedence
assert.ok(proposed.outsideProven>0);
assert.ok(report.proposed.withKnownTitleGuard.hits<proposed.hits);
assert.ok(report.proposed.provenNotReached>0&&report.proposed.provenNotReached<report.proposed.provenTotal); // the low ordinals are proven by history but unreachable statelessly
assert.ok(proposed.byClassifierGroup.ordinal_episode_review>=2); // the verified-stem and year-stem rows with a high ordinal
// Aggregates carry no title; the private rows do.
assert.equal(/Альфа|Дзета|Звёздные/u.test(JSON.stringify(report)),false);
assert.equal(privateRows.length,cohort.length);
assert.ok(privateRows.some(item=>item.title==='Альфа. 3-я серия'&&item.group==='ordinal_episode_proven'));
// Exposure on unchanged evidence: outside the window or terminal rows consume nothing, a changed evidence_key bypasses terminal, due is selectable.
assert.deepEqual(exposure(row('x',{win:0}),now),{state:'outside_window',attempts:0});
assert.deepEqual(exposure(row('x',{sl:0}),now),{state:'outside_window',attempts:0});
assert.deepEqual(exposure(row('x',{tr:'repeated_uncertain_match',att:5}),now),{state:'terminal',attempts:0});
assert.deepEqual(exposure(row('x',{tr:'repeated_uncertain_match',att:5,evmis:true}),now),{state:'selectable_now',attempts:ATTEMPT_LIMIT});
assert.deepEqual(exposure(row('x',{ra:'2026-11-21T00:00:00.000Z',att:1}),now),{state:'selectable_now',attempts:ATTEMPT_LIMIT-1});
assert.deepEqual(exposure(row('x',{ra:null,att:0}),now),{state:'selectable_now',attempts:ATTEMPT_LIMIT});
assert.deepEqual(exposure(row('x',{st:'excluded_nonfilm'}),now),{state:'terminal',attempts:0});
assert.deepEqual(exposure(row('x'),now),{state:'in_backoff',attempts:ATTEMPT_LIMIT-2});
// A cohort row without the identity or window fields is refused instead of silently counted as clean.
for(const field of ['cs','oid','intent','win','sl']){const broken=row('Пример. 9-я серия');delete broken[field];assert.throws(()=>audit({cohort:[broken],history:[],verified:[]},now),new RegExp(field));}

// CLI: aggregates on stdout, private rows only outside the repository, every input required.
const script=fileURLToPath(new URL('../scripts/air-566-residual-nonfilm-audit.mjs',import.meta.url)),dir=fs.mkdtempSync(path.join(os.tmpdir(),'air-566-'));
fs.writeFileSync(path.join(dir,'cohort.json'),JSON.stringify([{results:cohort}]));fs.writeFileSync(path.join(dir,'history.json'),JSON.stringify(history));fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify(verified));
const run=(args,files=['--cohort','--history','--verified'])=>spawnSync(process.execPath,[script,...files.flatMap(name=>[name,path.join(dir,name.slice(2)+'.json')]),...args],{encoding:'utf8'});
const ok=run(['--private-out',path.join(dir,'private')]);
assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).total,cohort.length);
assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'private','air-566-private-groups.json'),'utf8')).length,cohort.length);
for(const missing of ['--history','--verified','--cohort']){const result=run([],['--cohort','--history','--verified'].filter(name=>name!==missing));assert.notEqual(result.status,0);assert.match(result.stderr,/Usage/);}
const inside=run(['--private-out',path.join(path.dirname(script),'..','tmp-air-566-private')]);
assert.notEqual(inside.status,0);assert.match(inside.stderr,/outside the repository/);
assert.equal(fs.existsSync(path.join(path.dirname(script),'..','tmp-air-566-private')),false);
const atRoot=run(['--private-out',path.join(path.dirname(script),'..')]);
assert.notEqual(atRoot.status,0);assert.match(atRoot.stderr,/outside the repository/);
fs.rmSync(dir,{recursive:true,force:true});
console.log('air-566 residual non-film audit tests passed');
