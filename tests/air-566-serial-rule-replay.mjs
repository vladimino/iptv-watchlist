import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {catalogIndex,loadRule,replay} from '../scripts/air-566-serial-rule-replay.mjs';

// The replay runs the production functions of src/sources.js, not a copy. Synthetic cohort; titles are invented.
const rule=loadRule();
let n=0;
const row=(t,extra={})=>({ok:'k'+(++n),t,y:null,st:'no_confident_match',tr:'',att:2,ra:'2026-11-28T00:00:00.000Z',dur:'[60]',ds:'',dsh:1,xsh:0,ksh:0,win:1,sl:1,cs:0,oid:false,intent:false,evmis:false,...extra});
const alpha=[7,8,9,10].map(i=>row(`Альфа. ${i}-я серия`));
const low=[row('Бета. 1-я серия'),row('Бета. 2-я серия')];
const collision=[row('Гамма. 9-я серия'),row('Гамма. 10-я серия')];
const yearStem=row('Вега (1975). 9-я серия');
const dash=[row('Дзета 1-01',{ds:'Дзета 1-01'}),row('Дзета 1-02')],singleton=row('Йота 2-5',{ds:'Йота 2-5'});
const dashPlot=[row('Тета 1-3',{ds:'Сюжет'}),row('Тета 1-4',{ds:'Другой сюжет'})];
const pipe=row('Каппа 2|5 Название'),label=row('Лямбда (2026) мини–сериал',{dur:'[190]'}),abbrev=[row('Мю", 3 сезон, 4 с. "Эпизод'),row('Мю", 3 сезон, 5 с. "Эпизод')];
const trusted=row('Альфа. 11-я серия',{cs:1});
const cohort=[...alpha,...low,...collision,yearStem,...dash,singleton,...dashPlot,pipe,label,...abbrev,trusted];
const verified=[{t:'Гамма'},{t:'Случай в квадрате 36-80',ds:'Реальный сюжет',dur:'[69]'}];
const catalog=[{t:'Гамма',o:'Gamma',al:'["Гамма","Gamma"]',mt:null},{t:'Пустой',o:null,al:'not json',mt:'["Другое имя"]'}];
const now=Date.parse('2026-11-22T07:20:00Z');

// The index is built the way scanEPG builds it for a catalog-only Film: title, original, aliases and movie titles, normalized.
const index=catalogIndex(catalog,rule);
assert.equal(index.has('гамма'),true);assert.equal(index.has('gamma'),true);assert.equal(index.has('другое имя'),true);assert.equal(index.has('пустой'),true);assert.equal(index.has('not json'),false);

const result=replay({cohort,history:[],verified,catalog},rule,now);
const reasons=Object.fromEntries(cohort.map(item=>[item.t,result.decisions.get(item.ok)||null]));
assert.equal(reasons['Альфа. 9-я серия'],'ordinal_episode');
assert.equal(reasons['Бета. 1-я серия'],null);                    // ordinals 1 to 6 stay candidates
assert.equal(reasons['Гамма. 9-я серия'],null);                   // the stem is a catalog Film
assert.equal(reasons['Вега (1975). 9-я серия'],null);             // a year in the stem
assert.equal(reasons['Дзета 1-01'],'dash_season_episode');
assert.equal(reasons['Дзета 1-02'],'dash_season_episode');
assert.equal(reasons['Йота 2-5'],null);                           // a singleton stem in the scan is preserved
assert.equal(reasons['Тета 1-3'],null);                           // a real description is not a placeholder
assert.equal(reasons['Каппа 2|5 Название'],'season_pipe_episode');
assert.equal(reasons['Лямбда (2026) мини–сериал'],'mini_series_label');
assert.equal(reasons['Мю", 3 сезон, 4 с. "Эпизод'],null);         // the abbreviated form is not in the production rule
assert.equal(result.withCatalogGuard.hits,5+2+1+1);               // 5 alpha (one of them the trusted-identity row), 2 dash, pipe, label
assert.equal(result.withoutGuard.hits,result.withCatalogGuard.hits+2); // the two collision rows
assert.equal(result.collisionsKeptByGuard,2);
assert.equal(result.withCatalogGuard.byClassifierGroup.ordinal_episode_review,undefined);
assert.equal(result.withoutGuard.byClassifierGroup.ordinal_episode_review,2);
assert.equal(result.withoutGuard.outsideProven,3);assert.equal(result.withCatalogGuard.outsideProven,1); // the collisions and the trusted-identity row
// The trusted-identity row is hit by the ordinal form of the pure rule (the rule ignores identity); the replay reports it instead of hiding it.
assert.equal(result.withCatalogGuard.trustedIdentityHits,1);
assert.equal(result.verifiedControls.productionHitsWithGuard,0);assert.equal(result.verifiedControls.dashStemPossible,1);
assert.equal(result.withCatalogGuard.exposure.in_backoff,result.withCatalogGuard.hits);

// An empty catalog index leaves the ordinal form on in the replay only because the replay passes an index; the production scan gates the form on a
// catalog being present (tests/serial-episode-screening.mjs). The replay with an unrelated catalog keeps every stem unknown.
const unknown=replay({cohort,history:[],verified,catalog:[{t:'Пустой',o:null,al:null,mt:null}]},rule,now);
assert.equal(unknown.withCatalogGuard.hits,unknown.withoutGuard.hits);

// CLI: aggregates only on stdout, hits only to a private directory outside the repository, all four inputs required.
const script=fileURLToPath(new URL('../scripts/air-566-serial-rule-replay.mjs',import.meta.url)),dir=fs.mkdtempSync(path.join(os.tmpdir(),'air-566-replay-'));
const files={cohort,history:[],verified,catalog};
for(const [name,value] of Object.entries(files))fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));
const run=(args,names=Object.keys(files))=>spawnSync(process.execPath,[script,...names.flatMap(name=>['--'+name,path.join(dir,name+'.json')]),...args],{encoding:'utf8'});
const ok=run(['--now','2026-11-22T07:20:00Z','--private-out',path.join(dir,'private')]);
assert.equal(ok.status,0,ok.stderr);
const aggregates=JSON.parse(ok.stdout);assert.equal(aggregates.withCatalogGuard.hits,result.withCatalogGuard.hits);
assert.equal(/Альфа|Гамма|Дзета/u.test(ok.stdout),false);
assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'private','air-566-serial-rule-hits.json'),'utf8')).length,result.withCatalogGuard.hits);
for(const missing of Object.keys(files)){const failed=run([],Object.keys(files).filter(name=>name!==missing));assert.notEqual(failed.status,0);assert.match(failed.stderr,/Usage/);}
const repoRoot=path.join(path.dirname(script),'..');
for(const target of [repoRoot,path.join(repoRoot,'tmp-air-566-replay')]){const refused=run(['--private-out',target]);assert.notEqual(refused.status,0);assert.match(refused.stderr,/outside the repository/);}
assert.equal(fs.existsSync(path.join(repoRoot,'tmp-air-566-replay')),false);
fs.rmSync(dir,{recursive:true,force:true});
console.log('air-566 serial rule replay tests passed');
