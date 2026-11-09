// «Смотрел» on a Finds card must take its own click. The title link's `.film-open::after{position:absolute;inset:0}` stretches over the
// nearest positioned ancestor (`.finds-card` is `position:relative`), so any control that is not itself positioned above it sits under
// the overlay and the click opens the film page instead. The stylesheet must lift every interactive control of the card above it.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const css=fs.readFileSync('public/styles.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'');
const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m=>({selectors:m[1].split(',').map(s=>s.trim()),body:m[2]}));
const lifts=selector=>rules.some(r=>r.selectors.includes(selector)&&/position:\s*relative/.test(r.body)&&/z-index:\s*[1-9]/.test(r.body));
assert.ok(rules.some(r=>r.selectors.includes('.film-open::after')&&/position:\s*absolute/.test(r.body)&&/inset:\s*0/.test(r.body)),'the stretched title link is still the card-open mechanism');
assert.ok(rules.some(r=>r.selectors.includes('.finds-card')&&/position:\s*relative/.test(r.body)),'the Finds card is the containing block of the overlay');
for(const selector of ['.finds-card .finds-watched','.finds-card .letterboxd-link','.finds-card .finds-mark-error'])assert.ok(lifts(selector),selector+' sits above the title overlay');
// The markup still has the pieces the CSS targets, and the click handler keeps mark and open separate.
const app=fs.readFileSync('public/app.js','utf8');
assert.match(app,/class="finds-watched" data-finds-watched=/);
assert.match(app,/function onFindsClick[\s\S]*?const mark=event\.target\.closest\('\[data-finds-watched\]'\)/);
console.log('finds watched hit area ok');
