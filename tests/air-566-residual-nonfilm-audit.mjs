import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ATTEMPT_LIMIT,GROUPS,audit,buildContext,classify,parseSerial} from '../scripts/air-566-residual-nonfilm-audit.mjs';

// Synthetic cohort. Titles are invented except the public negative controls (a numbered Star Wars episode, a film with a numeric range).
let n=0;
const row=(t,extra={})=>({ok:'k'+(++n),t,y:null,st:'no_confident_match',tr:'',att:2,ra:'2026-11-28T00:00:00.000Z',dur:'[60]',ds:'',dsh:1,xsh:0,ksh:0,...extra});
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
const cohort=[...episodes,...lowOrdinals,...verifiedStem,...yearStem,...dash,...dashWithPlot,singletonDash,filmRange,pipe,label,...abbrev,seasonOnly,decorated,starWars,...family,plain];
const verified=[{t:'Гамма'},{t:'Случай в квадрате 36-80'},{t:'Альфа-фильм'},{t:'Другое: имя'}];
const context=buildContext({cohort,history:[],verified});
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
assert.equal(classify(row('Другое: имя 1'),buildContext({cohort:Array.from({length:10},(_,i)=>row(`Другое: имя ${i}`)),verified})),'no_proof');
// A stem that reaches an ordinal of 7 in the history proves the group, whatever the cohort holds.
assert.equal(classify(row('Бета. 1-я серия'),buildContext({cohort,history:[{t:'Бета. 7-я серия',rs:'archive'}],verified})),'ordinal_episode_proven');
// Ranges and the plural form are parsed; "Эпизод 4" and "Сезон дождей" are not serial forms.
assert.deepEqual(parseSerial('Пример. 1-я - 4-я серии'),{form:'ordinal_range',stem:'пример',n:1,n2:4});
assert.equal(parseSerial('Звёздные войны. Эпизод 4: Новая надежда'),null);
assert.equal(parseSerial('Сезон дождей'),null);

const {report,privateRows}=audit({cohort,history:[],verified},Date.parse('2026-11-22T00:00:00.000Z'));
assert.equal(report.total,cohort.length);
assert.equal(Object.values(report.groups).reduce((sum,g)=>sum+g.observations,0),cohort.length);
for(const [name,g] of Object.entries(report.groups))assert.equal(g.class,GROUPS[name]);
assert.equal(report.groups.ordinal_episode_proven.observations,8);
assert.equal(report.groups.ordinal_episode_proven.remainingAttempts,8*(ATTEMPT_LIMIT-2));
assert.equal(report.groups.ordinal_episode_proven.inBackoff,8);
assert.equal(report.groups.ordinal_episode_proven.actionableNow,0);
// The positive controls: exactly the verified film with a numeric range matches the structural dash predicate.
assert.equal(report.controls.verifiedTitles,verified.length);
assert.equal(report.controls.structuralMatches.dashCode,1);
assert.equal(report.controls.structuralMatches.pipe,0);
// Aggregates carry no title; the private rows do.
assert.equal(/Альфа|Дзета|Звёздные/u.test(JSON.stringify(report)),false);
assert.equal(privateRows.length,cohort.length);
assert.ok(privateRows.some(item=>item.title==='Альфа. 3-я серия'&&item.group==='ordinal_episode_proven'));
// Terminal rows consume no attempts; a retry that is due counts as actionable.
const edge=audit({cohort:[row('Ро. 9-я серия',{tr:'repeated_uncertain_match',att:5}),row('Ро. 10-я серия',{ra:'2026-11-21T00:00:00.000Z',att:1}),row('Ро. 11-я серия',{ra:null,att:0})],history:[],verified:[]},Date.parse('2026-11-22T00:00:00.000Z')).report.groups.ordinal_episode_proven;
assert.deepEqual({terminal:edge.terminal,actionableNow:edge.actionableNow,inBackoff:edge.inBackoff,remainingAttempts:edge.remainingAttempts},{terminal:1,actionableNow:2,inBackoff:0,remainingAttempts:(ATTEMPT_LIMIT-1)+ATTEMPT_LIMIT});

// CLI: aggregates on stdout, private rows only outside the repository.
const script=fileURLToPath(new URL('../scripts/air-566-residual-nonfilm-audit.mjs',import.meta.url)),dir=fs.mkdtempSync(path.join(os.tmpdir(),'air-566-'));
fs.writeFileSync(path.join(dir,'cohort.json'),JSON.stringify([{results:cohort}]));fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify(verified));
const run=args=>spawnSync(process.execPath,[script,'--cohort',path.join(dir,'cohort.json'),'--verified',path.join(dir,'verified.json'),...args],{encoding:'utf8'});
const ok=run(['--private-out',path.join(dir,'private')]);
assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).total,cohort.length);
assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'private','air-566-private-groups.json'),'utf8')).length,cohort.length);
const inside=run(['--private-out',path.join(path.dirname(script),'..','tmp-air-566-private')]);
assert.notEqual(inside.status,0);assert.match(inside.stderr,/outside the repository/);
assert.equal(fs.existsSync(path.join(path.dirname(script),'..','tmp-air-566-private')),false);
const atRoot=run(['--private-out',path.join(path.dirname(script),'..')]);
assert.notEqual(atRoot.status,0);assert.match(atRoot.stderr,/outside the repository/);
fs.rmSync(dir,{recursive:true,force:true});
console.log('air-566 residual non-film audit tests passed');
