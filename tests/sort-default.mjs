// AIR-382: «Для меня» is the default sort. The retired `time` sort is gone, an old `sort=time` link falls back to the default,
// `title` stays a manual choice, and relevance is automatic only while a query is typed and no sort was chosen.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context=vm.createContext({Date,Intl,Set,Map,URL});
vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
const run=code=>vm.runInContext(code,context);
const read=url=>run(`readUrlState(new URL(${JSON.stringify(url)}))`);
const write=(url,patch)=>{run(`Object.assign(state,{sort:'personal',sortExplicit:false,query:''},${JSON.stringify(patch)})`);return new URL(run(`urlForState(new URL(${JSON.stringify(url)})).href`)).searchParams.get('sort');};
const base='https://iptv.example/';

// Initial state and no `sort`.
assert.equal(run('state.sort'),'personal');
assert.deepEqual([read(base).sort,read(base).sortExplicit],['personal',false]);
// Explicit sorts are kept and marked explicit.
for(const sort of ['personal','title','expiring']){const s=read(base+'?sort='+sort);assert.deepEqual([s.sort,s.sortExplicit],[sort,true],sort);}
// Invalid and retired sorts fall back; with a query the automatic relevance applies.
for(const bad of ['oops','time','TIME','','expiring%00']){const s=read(base+'?sort='+bad);assert.deepEqual([s.sort,s.sortExplicit],['personal',false],'sort='+bad);}
assert.equal(read(base+'?sort=time&q=дюна').sort,'relevance');
assert.equal(read(base+'?q=дюна').sort,'relevance');
assert.equal(read(base+'?q=%20&sort=time').sort,'personal');
// relevance exists only while a query does.
assert.deepEqual([read(base+'?sort=relevance').sort,read(base+'?sort=relevance').sortExplicit],['personal',false]);
assert.deepEqual([read(base+'?sort=relevance&q=%20').sort,read(base+'?sort=relevance&q=дюна').sort],['personal','relevance']);

// Explicit personal -> URL -> reload/restore -> type a query: the choice holds. The implicit default does not leave a trace.
{
 run("Object.assign(state,{sort:'personal',sortExplicit:true,query:''})");
 const url=run("urlForState(new URL('https://iptv.example/')).href");
 assert.equal(new URL(url).searchParams.get('sort'),'personal');
 run(`Object.assign(state,readUrlState(new URL(${JSON.stringify(url)})))`);
 assert.deepEqual([run('state.sort'),run('state.sortExplicit')],['personal',true]);
 run("applySearchInput('дюна')");assert.equal(run('state.sort'),'personal','typing a query keeps the explicit personal');
 run("applySearchInput('')");assert.equal(run('state.sort'),'personal');
 run("Object.assign(state,{sort:'personal',sortExplicit:false,query:''})");
 const implicit=run("urlForState(new URL('https://iptv.example/')).href");
 assert.equal(new URL(implicit).searchParams.get('sort'),null,'the implicit default writes nothing');
 run(`Object.assign(state,readUrlState(new URL(${JSON.stringify(implicit)})))`);
 run("applySearchInput('дюна')");assert.equal(run('state.sort'),'relevance','an implicit default still gives way to relevance');
}

// Writing the URL: the default is silent, other sorts are written, an explicit default with a query is kept.
assert.equal(write(base,{}),null);
assert.equal(write(base,{sort:'title',sortExplicit:true}),'title');
assert.equal(write(base,{sort:'expiring',sortExplicit:true}),'expiring');
assert.equal(write(base,{sort:'relevance',query:'дюна'}),'relevance');
assert.equal(write(base,{sort:'personal',sortExplicit:true,query:'дюна'}),'personal');
assert.equal(write(base,{sort:'personal',sortExplicit:true}),'personal','an explicit personal survives the URL even without a query');
// A legacy link is normalized on the next write: `sort=time` is dropped.
run("Object.assign(state,readUrlState(new URL('https://iptv.example/?sort=time&campaign=save')))");
const rewritten=new URL(run("urlForState(new URL('https://iptv.example/?sort=time&campaign=save')).href"));
assert.equal(rewritten.searchParams.get('sort'),null);assert.equal(rewritten.searchParams.get('campaign'),'save');

// Search input: automatic relevance while a query exists, back to the default when cleared; an explicit sort is untouched.
run("Object.assign(state,{sort:'personal',sortExplicit:false,query:''})");
run("applySearchInput('дюна')");assert.equal(run('state.sort'),'relevance');
run("applySearchInput('')");assert.equal(run('state.sort'),'personal');
for(const sort of ['title','personal','expiring']){run(`Object.assign(state,{sort:${JSON.stringify(sort)},sortExplicit:true,query:''})`);run("applySearchInput('дюна')");assert.equal(run('state.sort'),sort);run("applySearchInput('')");assert.equal(run('state.sort'),sort);}

// The code and the markup: no `time` sort anywhere, the select starts on «Для меня».
const html=fs.readFileSync('public/index.html','utf8'),app=fs.readFileSync('public/app.js','utf8');
const select=html.match(/<select id="sort"[^>]*>([\s\S]*?)<\/select>/)[1];
const options=[...select.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(m=>({value:/value="([^"]*)"/.exec(m[1])[1],selected:/\bselected\b/.test(m[1]),label:m[2]}));
assert.deepEqual(options.map(o=>o.value),['relevance','personal','title','expiring']);
assert.deepEqual(options.filter(o=>o.selected).map(o=>o.value),['personal'],'«Для меня» is the selected option');
assert.equal(options.find(o=>o.value==='personal').label,'Для меня');
assert.equal(options.some(o=>o.value==='time'||/эфир|Свежие показы/.test(o.label)),false,'the time option is removed');
assert.doesNotMatch(app,/sort-time|sort==='time'|'time'\]\.includes/,'no code for the time sort is left');
assert.ok(options.some(o=>o.value==='expiring'),'expiring stays');

// Reset returns to the default.
run("Object.assign(state,{sort:'title',sortExplicit:true,query:'дюна'})");
const resetSource=app.slice(app.indexOf('function reset('),app.indexOf('function reset(')+600);
assert.match(resetSource,/state\.sort='personal';state\.sortExplicit=false/);

// Saved presets: the retired sort is not stored, a chosen one is.
const presets=fs.readFileSync('src/filter-presets.js','utf8');
assert.doesNotMatch(presets,/'time'/);
assert.match(presets,/\['personal','expiring','relevance','title'\]\.includes\(params\.get\('sort'\)\)/);

console.log('Sort default: personal without sort, explicit sorts kept, legacy time and invalid values fall back, automatic relevance only for a query, reset and the select default, no time option and no preset time sort passed');
