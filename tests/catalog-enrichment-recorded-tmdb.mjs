// AIR-684 (ADR 0224): the shared Russian-first parser against RECORDED TMDB responses. The three `ru-RU` detail responses (603 The Matrix, 299536 Avengers: Infinity War, 593 Solaris) and the single comparative `en-US` response of 299536
// were captured once, outside the Worker, on 27 Nov 2026 under the owner's one-time approval (https://github.com/vladimino/iptv-watchlist/pull/1038#issuecomment-7223051965), and sanitized (see `_capture` in each file). Nothing here
// calls TMDB. Every expected value is computed from the recorded response by a different route than the parser, or is a recorded fact; what the sample does NOT show (a Film with no Russian overview, one with no poster, a mixed
// recognized and unrecognized director set) is NOT claimed and stays in the evidence page as an open gap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseTmdb} from '../src/catalog-enrichment-sources.js';
import {Plan} from '../src/catalog-enrichment-plan.js';
import * as D from '../src/catalog-enrichment-discovery.js';

const load=name=>JSON.parse(fs.readFileSync('tests/fixtures/tmdb-recorded/'+name,'utf8'));
const FILMS={603:{file:'603-ru.json',bytes:145883,year:1999,runtime:136,genreIds:['28','878'],labels:['Боевик','Фантастика'],directors:[9339,9340]},
 299536:{file:'299536-ru.json',bytes:326740,year:2018,runtime:149,genreIds:['12','28','878'],labels:['Приключения','Боевик','Фантастика'],directors:[19271,19272]},
 593:{file:'593-ru.json',bytes:68410,year:1972,runtime:169,genreIds:['18','878','9648'],labels:['Драма','Фантастика','Детектив'],directors:[8452]}};
const en=load('299536-en-reference.json');
assert.equal(en._capture.rawResponseBytes,218147);

for(const [id,facts] of Object.entries(FILMS)){
 const raw=load(facts.file);
 assert.equal(raw._capture.rawResponseBytes,facts.bytes,id+': the recorded raw size');
 assert.ok(raw._capture.rawResponseBytes<3000000,id+': inside the existing body cap (a text length: the characters are fewer than the bytes)');
 const parsed=parseTmdb(raw,id);
 assert.ok(parsed,id+': the recorded document is this movie\'s');
 const o=parsed.observation;
 assert.deepEqual(Plan.unresolvedFields(o),[],id+': every selected field is verified coverage on a REAL response');
 assert.deepEqual([o.year.value,o.runtime.value],[facts.year,facts.runtime],id);
 // synopsis: the tagged Russian translation, computed here without the parser
 const ru=raw.translations.translations.find(entry=>entry.iso_639_1==='ru'&&entry.iso_3166_1==='RU').data.overview.trim();
 assert.ok(ru.length>100);assert.deepEqual([o.synopsis.value,o.synopsis.language,o.synopsis.languageBasis],[ru,'ru','explicit'],id+': a tagged Russian synopsis');
 assert.equal(raw.overview.trim(),ru,id+': recorded fact: under `ru-RU` the top-level overview equals the Russian translation (still never used as proof of a language)');
 assert.ok(raw.translations.translations.every(entry=>['homepage','overview','runtime','tagline','title'].every(key=>key in entry.data)),id+': recorded fact: every translation entry carries all five keys, an empty overview is an explicit empty string');
 // poster: the Russian tier, the widest then the smallest path, computed here by a different route; and what TMDB itself put at the top level
 const russian=raw.images.posters.filter(p=>p.iso_639_1==='ru');
 const widest=Math.max(...russian.map(p=>p.width));
 const expected=russian.filter(p=>p.width===widest).map(p=>p.file_path).sort()[0];
 assert.deepEqual([o.poster.value,o.poster.language,o.poster.languageBasis],['https://image.tmdb.org/t/p/w500'+expected,'ru','explicit'],id+': the stable selector');
 assert.deepEqual([...new Set(raw.images.posters.map(p=>p.iso_639_1))].sort(),['en','ru',null].sort(),id+': recorded fact: `include_image_language=ru,en,null` returned exactly ru, en and language-neutral posters');
 const topListed=raw.images.posters.find(p=>p.file_path===raw.poster_path);
 assert.equal(topListed.iso_639_1,'ru',id+': recorded fact: the top-level poster_path of a `ru-RU` request is a listed Russian poster');
 // genres: ids and the existing vocabulary
 assert.deepEqual([o.genres.ids,o.genres.value,o.genres.unmapped],[facts.genreIds,facts.labels,[]],id+': every recorded genre id is in the reviewed table');
 assert.ok(raw.genres.every(g=>g.name===g.name.toLowerCase()),id+': recorded fact: the Russian genre NAMES TMDB returns are lowercase and are not the words of the existing vocabulary: the id table is what is used');
 // credits: directors by their ids, jobs and departments as recorded
 assert.equal(parsed.credits.status,'ok');
 const directors=parsed.credits.items.filter(item=>item.role==='director').map(item=>Number(item.key));
 assert.deepEqual([...directors].sort((a,b)=>a-b),facts.directors,id+': the directors');
 assert.deepEqual(directors,raw.credits.crew.filter(c=>c.job==='Director').map(c=>c.id),id+': in the crew order of the source');
 assert.equal(directors.length,raw.credits.crew.filter(c=>c.job==='Director').length,id+': exactly the `Director` entries; an assistant, second unit or other directing job is not a director');
 assert.ok(raw.credits.crew.some(c=>c.department==='Directing'&&c.job!=='Director'),id+': recorded fact: the Directing department also holds other jobs');
 assert.equal(parsed.credits.items.filter(item=>item.role==='actor').length,raw.credits.cast.length,id+': the whole cast, no cap');
 // the digest and the observer: one version from the same parse
 const versions=await D.tmdbPartVersions(raw,id);
 assert.equal(versions.core,await Plan.coreVersion('tmdb',id,o));
 assert.ok(versions.credits&&versions.localization,id);
}
// The comparative en-US reference of 299536 (the multi-director film): the director ids, the crew, the cast, the job and department strings and the genre ids are the same under `ru-RU`
{
 const ruRaw=load('299536-ru.json');
 const ids=(c,job)=>c.credits.crew.filter(x=>x.job===job).map(x=>x.id).sort((a,b)=>a-b);
 assert.deepEqual(ids(en,'Director'),[19271,19272]);assert.deepEqual(ids(ruRaw,'Director'),ids(en,'Director'),'the `ru-RU` response names the same directors as the en-US reference');
 const jobs=c=>[...new Set(c.credits.crew.map(x=>x.department+'|'+x.job))].sort();
 assert.deepEqual(jobs(ruRaw),jobs(en),'recorded fact: `job` and `department` are NOT localized under `ru-RU`: the recognized strings are not at risk on this sample');
 assert.deepEqual(ruRaw.credits.crew.map(x=>x.id).sort((a,b)=>a-b),en.credits.crew.map(x=>x.id).sort((a,b)=>a-b));
 assert.deepEqual(ruRaw.credits.cast.map(x=>x.id).sort((a,b)=>a-b),en.credits.cast.map(x=>x.id).sort((a,b)=>a-b));
 assert.deepEqual(ruRaw.genres.map(g=>g.id),en.genres.map(g=>g.id),'the genre ids are the same');
 // the reviewed table's English names are the names TMDB returns for the same ids under en-US
 const P=await import('../src/catalog-enrichment-plan.js');
 for(const g of en.genres)assert.equal(P.TMDB_GENRES[g.id][0],g.name,'genre '+g.id+' is '+g.name+' in the reviewed table');
}
console.log('catalog enrichment recorded TMDB: ok');
