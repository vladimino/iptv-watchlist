// AIR-382: «Для меня» is the default sort. The retired `time` sort is gone, an old `sort=time` link falls back to the default,
// `title` stays a manual choice.
// AIR-626: the `relevance` sort is retired too. The page offers exactly three sorts; a search query never switches the sort;
// an old `sort=relevance` link, history entry or saved preset loads as the default and the parameter is dropped at the next write.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context=vm.createContext({Date,Intl,Set,Map,URL,URLSearchParams});
vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
const run=code=>vm.runInContext(code,context);
const read=url=>run(`readUrlState(new URL(${JSON.stringify(url)}))`);
const write=(url,patch)=>{run(`Object.assign(state,{sort:'personal',sortExplicit:false,query:''},${JSON.stringify(patch)})`);return new URL(run(`urlForState(new URL(${JSON.stringify(url)})).href`)).searchParams.get('sort');};
const base='https://iptv.example/';
const SORTS=['personal','title','expiring'];

// Initial state and no `sort`.
assert.equal(run('state.sort'),'personal');
assert.deepEqual([read(base).sort,read(base).sortExplicit],['personal',false]);
// Explicit sorts are kept and marked explicit, with or without a query.
for(const sort of SORTS){const s=read(base+'?sort='+sort);assert.deepEqual([s.sort,s.sortExplicit],[sort,true],sort);const q=read(base+'?sort='+sort+'&q=дюна');assert.deepEqual([q.sort,q.sortExplicit,q.query],[sort,true,'дюна'],sort+' with a query');}
// Invalid and retired sorts fall back, with and without a query; the query itself is kept.
for(const bad of ['oops','time','TIME','relevance','RELEVANCE','','expiring%00']){
 const s=read(base+'?sort='+bad);assert.deepEqual([s.sort,s.sortExplicit],['personal',false],'sort='+bad);
 const q=read(base+'?sort='+bad+'&q=дюна');assert.deepEqual([q.sort,q.sortExplicit,q.query],['personal',false,'дюна'],'sort='+bad+' with a query');
}
assert.deepEqual([read(base+'?q=дюна').sort,read(base+'?q=дюна').sortExplicit],['personal',false],'a query alone keeps the default');
assert.equal(read(base+'?q=%20&sort=time').sort,'personal');
// An old relevance link keeps every other filter.
{
 const s=read(base+'?sort=relevance&q=дюна&searchIn=people&genre=Драма&period=archive&from=1990&viewing=new');
 assert.deepEqual([s.sort,s.sortExplicit,s.query,s.searchScopes.people,[...s.genres],s.period,s.from,s.viewing],['personal',false,'дюна',true,['Драма'],'archive',1990,'new']);
}

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
 run("applySearchInput('дюна')");assert.deepEqual([run('state.sort'),run('state.sortExplicit')],['personal',false],'an implicit default stays while a query is typed');
 assert.equal(new URL(run("urlForState(new URL('https://iptv.example/')).href")).searchParams.get('sort'),null,'a query with the implicit default still writes no sort');
}

// Writing the URL: the default is silent, other sorts are written, an explicit default with a query is kept.
assert.equal(write(base,{}),null);
assert.equal(write(base,{query:'дюна'}),null,'a query alone writes no sort');
assert.equal(write(base,{sort:'title',sortExplicit:true}),'title');
assert.equal(write(base,{sort:'expiring',sortExplicit:true}),'expiring');
assert.equal(write(base,{sort:'title',sortExplicit:true,query:'дюна'}),'title');
assert.equal(write(base,{sort:'personal',sortExplicit:true,query:'дюна'}),'personal');
assert.equal(write(base,{sort:'personal',sortExplicit:true}),'personal','an explicit personal survives the URL even without a query');
// A legacy link is normalized on the next write: `sort=time` and `sort=relevance` are dropped, everything else stays.
for(const legacy of ['time','relevance']){
 run(`Object.assign(state,readUrlState(new URL('https://iptv.example/?sort=${legacy}&q=дюна&campaign=save')))`);
 const rewritten=new URL(run(`urlForState(new URL('https://iptv.example/?sort=${legacy}&q=дюна&campaign=save')).href`));
 assert.equal(rewritten.searchParams.get('sort'),null,legacy);assert.equal(rewritten.searchParams.get('q'),'дюна',legacy);assert.equal(rewritten.searchParams.get('campaign'),'save',legacy);
}

// Search input: typing, changing and clearing the query never change the sort, chosen or implicit.
run("Object.assign(state,{sort:'personal',sortExplicit:false,query:''})");
run("applySearchInput('дюна')");assert.deepEqual([run('state.sort'),run('state.query')],['personal','дюна']);
run("applySearchInput('дюна 2')");assert.equal(run('state.sort'),'personal');
run("applySearchInput('')");assert.deepEqual([run('state.sort'),run('state.sortExplicit')],['personal',false]);
for(const sort of SORTS){run(`Object.assign(state,{sort:${JSON.stringify(sort)},sortExplicit:true,query:''})`);run("applySearchInput('дюна')");assert.equal(run('state.sort'),sort);run("applySearchInput('')");assert.deepEqual([run('state.sort'),run('state.sortExplicit')],[sort,true]);}
assert.match(fs.readFileSync('public/app.js','utf8').match(/function applySearchInput\([^)]*\)\{[^}]*\}/)[0],/^function applySearchInput\(value\)\{state\.query=value;\}$/,'the search input only sets the query');

// The code and the markup: no `time` or `relevance` sort anywhere, exactly three options, the select starts on «Для меня».
const html=fs.readFileSync('public/index.html','utf8'),app=fs.readFileSync('public/app.js','utf8');
const select=html.match(/<select id="sort"[^>]*>([\s\S]*?)<\/select>/)[1];
const options=[...select.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map(m=>({value:/value="([^"]*)"/.exec(m[1])[1],selected:/\bselected\b/.test(m[1]),label:m[2]}));
assert.deepEqual(options.map(o=>({value:o.value,label:o.label})),[{value:'personal',label:'Для меня'},{value:'title',label:'Название · А–Я'},{value:'expiring',label:'Сначала исчезающие'}],'exactly the three sorts, in this order');
assert.deepEqual(options.filter(o=>o.selected).map(o=>o.value),['personal'],'«Для меня» is the selected option');
assert.equal(options.some(o=>o.value==='time'||o.value==='relevance'||/эфир|Свежие показы|релевантност/i.test(o.label)),false,'the time and relevance options are removed');
assert.doesNotMatch(app,/sort-time|sort==='time'|'time'\]\.includes/,'no code for the time sort is left');
assert.doesNotMatch(app,/state\.sort==='relevance'|sort==='relevance'|=='relevance'|sort='relevance'|'relevance'\]/,'no code for the relevance sort is left');
assert.doesNotMatch(html,/relevance/,'no relevance in the markup');
// The membership helper stays: the query still decides which films are listed.
assert.match(app,/function searchRank\(/);
assert.match(app,/function eligible\(film\)[^\n]*searchRank\(film,parsed\.normalized,parsed\.tokens\)!==null/);
// The comparator knows exactly the three sorts.
const visible=app.slice(app.indexOf('function visibleFilms('),app.indexOf('\n',app.indexOf('function visibleFilms(')));
assert.deepEqual([...visible.matchAll(/state\.sort==='([a-z]+)'/g)].map(m=>m[1]),['title','personal','expiring']);

// Reset returns to the default.
run("Object.assign(state,{sort:'title',sortExplicit:true,query:'дюна'})");
const resetSource=app.slice(app.indexOf('function reset('),app.indexOf('function reset(')+600);
assert.match(resetSource,/state\.sort='personal';state\.sortExplicit=false/);

// The preset mark: a stored preset with the retired sort is the same scenario as the page showing the default; a chosen sort still counts.
assert.equal(run("presetKey('q=дюна&sort=relevance')"),run("presetKey('q=дюна')"));
assert.equal(run("presetKey('q=дюна&sort=time')"),run("presetKey('q=дюна')"));
assert.notEqual(run("presetKey('q=дюна&sort=title')"),run("presetKey('q=дюна')"));
assert.equal(run("presetKey('q=дюна&sort=title')"),run("presetKey('sort=title&q=дюна')"));

// Saved presets: the retired sorts are not stored, a chosen one is.
const presets=fs.readFileSync('src/filter-presets.js','utf8');
assert.doesNotMatch(presets,/'time'/);
assert.match(presets,/\['personal','expiring','title'\]\.includes\(params\.get\('sort'\)\)/);
assert.doesNotMatch(presets,/'relevance'/,'the preset normalizer does not accept the retired sort');
{
 const presetContext=vm.createContext({URL,URLSearchParams,Set,Map,Number,Date,Response:class{},crypto:{randomUUID:()=>'00000000-0000-4000-8000-000000000000'}});
 vm.runInContext(presets,presetContext);
 const normalize=query=>new URLSearchParams(vm.runInContext(`normalizePresetQuery(${JSON.stringify(query)})`,presetContext));
 assert.deepEqual([...normalize('q=дюна&sort=relevance&genre=Драма').entries()],[['q','дюна'],['genre','Драма']],'a stored relevance preset loses only its sort');
 assert.deepEqual([...normalize('sort=relevance').entries()],[],'a relevance-only preset becomes the default');
 for(const sort of SORTS)assert.equal(normalize('q=дюна&sort='+sort).get('sort'),sort,sort);
 assert.equal(normalize('q=дюна&sort=time').get('sort'),null);
}

console.log('Sort default: personal without sort, explicit sorts kept with and without a query, legacy time and relevance values fall back and are dropped, the search input never changes the sort, exactly three options, reset, the preset mark and no preset retired sort passed');
