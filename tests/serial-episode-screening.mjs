import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// EPG scan: the serial-episode screen removes a narrow set of structural forms before discovery, keeps every film form the audit used as a
// negative control, never overrides a reliable known-Film match, and does not exist in the discovery cheap pass (no stored decision depends on it).
const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,TextDecoder,ReadableStream,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async()=>new Response('{}')});
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),live);
const run=code=>vm.runInContext(code,live);
const reason=(title,known)=>{live.t=title;live.k=known;return run('serialEpisodeReason(t,k)');};

// Pure rule. The ordinal form needs a known-title index: without one it is off (fail safe).
assert.equal(reason('Альфа. 9-я серия'),null);
assert.equal(reason('Альфа. 9-я серия',new Set()),'ordinal_episode');
assert.equal(reason('Альфа (31-я серия)',new Set()),'ordinal_episode');
assert.equal(reason('Альфа. 3-я - 8-я серии',new Set()),'ordinal_episode');
assert.equal(reason('Альфа. 3-я - 4-я серии',new Set()),null);
assert.equal(reason('Альфа. 6-я серия',new Set()),null);          // ordinals 1 to 6: multi-part films are aired in parts
assert.equal(reason('Альфа. 7-я серия',new Set()),'ordinal_episode');
assert.equal(reason('Альфа. 9-я серия',new Set(['альфа'])),null);   // the stem is a known Film
assert.equal(reason('Альфа (1975). 9-я серия',new Set()),null);    // a year in the stem
assert.equal(reason('Альфа 1975. 9-я серия',new Set()),null);
assert.equal(reason('9-я серия',new Set()),null);                  // no stem
assert.equal(reason('Альфа. 9-я серия',{}),null);                  // a malformed index is no index
// Pipe pair and mini-series label.
assert.equal(reason('Бета 2|5 Название серии'),'season_pipe_episode');
assert.equal(reason('Бета (2|1)'),'season_pipe_episode');
assert.equal(reason('Бета 1|10'),'season_pipe_episode');
assert.equal(reason('2|5 Бета'),null);
assert.equal(reason('Бета | Часть 2'),null);
assert.equal(reason('Гамма (2026) мини–сериал'),'mini_series_label');
assert.equal(reason('Гамма: Мини-сериал'),'mini_series_label');
assert.equal(reason('Мини-сериал'),null);                          // a bare word is a title, not a label
assert.equal(reason('Сериал о любви'),null);
assert.equal(reason('Прозрение(2026) мини–сериал'),'mini_series_label');
assert.equal(reason('Гамма - мини-сериал.'),'mini_series_label');
// The label is a trailing descriptor: an inflected word or a title that merely contains it is a film-like title.
for(const title of ['История минисериалов','Драма о мини-сериале','Мой мини-сериал','Мини-сериал: продолжение','Гамма (2026) мини–сериалы','Мини-сериалы 2026','Гамма мини-сериал Икс'])assert.equal(reason(title),null,title);
// Negative controls: feature films and film-like numbers are never serial.
for(const title of ['Звёздные войны. Эпизод 4: Новая надежда','Сезон дождей','Случай в квадрате 36-80','Пример фильма 2-я серия','Золотой телёнок (1968) 1-серия','12-05-08','Шоу Трумана','Агент 117: Каир'])assert.equal(reason(title,new Set()),null,title);
assert.equal(run("serialDashStem('Дельта 2-07')"),'дельта');
assert.equal(run("serialDashStem('2-07')"),null);
assert.equal(run("serialDashStem('Дельта-2-07')"),null);

// The cheap pass is unchanged: neither the title rule nor a stored decision depends on the new forms.
assert.equal(run("nonFilmEPGReason('Альфа. 9-я серия')"),null);
assert.equal(run("screenedNonfilmReason({title:'Альфа. 9-я серия'},null)"),null);
assert.equal(run("screenedNonfilmReason({title:'Бета 2|5 Название'},null)"),null);
assert.equal(run("screenedNonfilmReason({title:'Гамма (2026) мини–сериал'},null)"),null);

// Same-scan repeat pass for "<Title> S-EE". Candidates are objects of the scan's discovery map.
const info=new Map([['а 1-01|',{stem:'зета',maxMinutes:60}],['а 1-02|',{stem:'зета',maxMinutes:58}],['б 2-5|',{stem:'эта',maxMinutes:60}],['в 1-3|',{stem:'тета',maxMinutes:60}],['в 1-4|',{stem:'тета',maxMinutes:60}],['г 1-1|',{stem:'йота',maxMinutes:120}],['г 1-2|',{stem:'йота',maxMinutes:120}],['д 1-1|',{stem:'каппа',maxMinutes:60}],['д 1-2|',{stem:'каппа',maxMinutes:null}],['е 1-1|',{stem:'лямбда',maxMinutes:60}],['е 1-2|',{stem:'лямбда',maxMinutes:60}],['ж 1-1|',{stem:'мю',maxMinutes:60}],['ж 1-2|',{stem:'мю',maxMinutes:60}]]);
const cand=(title,extra={})=>({title,rawTitles:[title],description:null,confirmedTmdbId:null,confirmedSlots:[],...extra});
const candidates=new Map([['а 1-01|',cand('Зета 1-01')],['а 1-02|',cand('Зета 1-02',{description:'Зета 1-02'})],['б 2-5|',cand('Эта 2-5')],['в 1-3|',cand('Тета 1-3',{description:'Сюжет'})],['в 1-4|',cand('Тета 1-4',{description:'Другой сюжет'})],['г 1-1|',cand('Йота 1-1')],['г 1-2|',cand('Йота 1-2')],['д 1-1|',cand('Каппа 1-1')],['д 1-2|',cand('Каппа 1-2')],['е 1-1|',cand('Лямбда 1-1',{confirmedTmdbId:'5'})],['е 1-2|',cand('Лямбда 1-2')],['ж 1-1|',cand('Мю 1-1',{confirmedSlots:[{channelId:'c',start:1,tmdbId:'6'}]})],['ж 1-2|',cand('Мю 1-2')]]);
live.info=info;live.candidates=candidates;
assert.deepEqual([...run('serialDashEpisodes(info,candidates)')].sort(),['а 1-01|','а 1-02|']);
// Of a stem pair, one confirmed or per-slot confirmed member leaves the other a singleton: nothing is dropped.

// EPG scan.
const now=Date.UTC(2026,9,27,12);
const stamp=ms=>new Date(ms).toISOString().slice(0,19).replace(/[-T:]/g,'')+' +0000';
let slot=0;
const programme=(title,minutes,{channel='c1',desc,start=now+(slot++)*600000}={})=>`<programme start="${stamp(start)}" stop="${stamp(start+minutes*60000)}" channel="${channel}"><title>${title}</title>${desc===undefined?'':`<desc>${desc}</desc>`}</programme>`;
const sharedStart=now+400*60000;
const feed=[
 programme('Альфа. 9-я серия',55),programme('Альфа. 10-я серия',55),programme('Альфа. 3-я серия',55),
 programme('Бета (1975). 12-я серия',55),
 programme('Гамма. 15-я серия',55),
 programme('Дельта 2|5 Название',55),programme('Эпсилон (2026) мини–сериал',190),
 programme('Зета 1-01',60),programme('Зета 1-02',60),programme('Эта 2-5',60),
 programme('Тета 1-3',60,{desc:'Настоящий сюжет первой серии'}),programme('Тета 1-4',60,{desc:'Настоящий сюжет второй серии'}),
 programme('Йота 1-1',120),programme('Йота 1-2',120),
 programme('Каппа 1-1',60,{desc:'Каппа 1-1'}),programme('Каппа 1-2',60,{desc:'Каппа 1-2'}),
 programme('Случай в квадрате 36-80',69,{desc:'Реальный сюжет фильма'}),
 programme('Звёздные войны. Эпизод 4: Новая надежда',121),
 programme('Лямбда. 9-я серия',55,{channel:'c2'}),programme('Лямбда. 9-я серия',55,{channel:'c3'}),programme('Лямбда (1990)',100,{channel:'c2'}),
 programme('Омега. 9-я серия (1990)',55),
 programme('История минисериалов',100),programme('Драма о мини-сериале',100),programme('Мой мини-сериал',100),
 programme('Омикрон 1-01',60),programme('Омикрон 1-02',60),
 programme('Эта. 9-я серия (2005)',55),
 programme('Фильм Икс (1999)',100,{channel:'c3',start:sharedStart}),programme('Сигма. 9-я серия',55,{channel:'c3',start:sharedStart}),
 programme('Фильм Игрек (1999)',100,{channel:'c3',start:sharedStart+3600000}),programme('Эта. 9-я серия (2005)',55,{channel:'c3',start:sharedStart+3600000}),
].join('');
live.xml=`<tv><channel id="c1"><display-name>Кино</display-name></channel><channel id="c2"><display-name>Кино 2</display-name></channel><channel id="c3"><display-name>Кино 3</display-name></channel>${feed}</tv>`;live.now=now;
live.watchlist=[
 {id:'cat-gamma',title:'Гамма',original:'Gamma',aliases:['Гамма','Gamma'],year:2000,runtime:100,tmdbId:'910001',catalogOnly:true},
 {id:'cat-lambda',title:'Лямбда',original:'Lambda',aliases:['Лямбда','Lambda'],year:1990,runtime:100,tmdbId:'910002',catalogOnly:true},
 {id:'cat-omikron',title:'Омикрон 1-01',original:'Омикрон 1-01',aliases:['Омикрон 1-01'],year:2001,runtime:120,tmdbId:'910006',catalogOnly:true},
 {id:'lb-eta',title:'Эта. 9-я серия',original:'Эта. 9-я серия',aliases:['Эта. 9-я серия'],year:1990,runtime:55,tmdbId:'910005'},
 {id:'lb-omega',title:'Омега. 9-я серия',original:'Омега. 9-я серия',aliases:['Омега. 9-я серия'],year:1990,runtime:55,tmdbId:'910003'},
 {id:'lb-y',title:'Фильм Игрек',original:'Фильм Игрек',aliases:['Фильм Игрек'],year:1999,runtime:100,tmdbId:'910007'},
 {id:'lb-x',title:'Фильм Икс',original:'Фильм Икс',aliases:['Фильм Икс'],year:1999,runtime:100,tmdbId:'910004'},
];
live.policies=new Map([['c1',{policy:'discover',basis:'category'}],['c2',{policy:'discover',basis:'category'}],['c3',{policy:'known_only',basis:'category'}]]);
const scan=await run('scanEPG(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(xml));c.close();}}),watchlist,now,{policies})');
const kept=new Set(scan.discovery.map(item=>item.title));
for(const title of ['Альфа. 9-я серия','Альфа. 10-я серия','Дельта 2|5 Название','Эпсилон (2026) мини–сериал','Зета 1-01','Зета 1-02','Каппа 1-1','Каппа 1-2'])assert(!kept.has(title),'screened: '+title);
for(const title of ['Альфа. 3-я серия','Бета (1975). 12-я серия','Эта 2-5','Тета 1-3','Тета 1-4','Йота 1-1','Йота 1-2','Случай в квадрате 36-80','Звёздные войны. Эпизод 4: Новая надежда'])assert(kept.has(title),'kept: '+title);
// The stem 'Гамма' and the stem 'Лямбда' are known catalog Films: their episodes are not screened, and the Film itself is matched.
assert(kept.has('Гамма. 15-я серия'));assert(kept.has('Лямбда. 9-я серия'));
assert(scan.discovery.some(item=>item.confirmedTmdbId==='910002')); // the catalog Film itself is confirmed on its slot
// A reliable single watchlist match of an episode-shaped title outranks the screen (valid.length === 1).
assert(scan.films.some(film=>film.id==='lb-omega'));
// Film-like titles that merely contain the label are kept (an inflected word, a title that does not end with the label).
for(const title of ['История минисериалов','Драма о мини-сериале','Мой мини-сериал'])assert(kept.has(title),'kept: '+title);
// The deferred "<Title> S-EE" pass keeps the whole-title precedence: a known catalog Film whose title only the runtime refused (valid is empty, the candidate is unconfirmed)
// never enters the pass, so its placeholder sibling stays a singleton and both are kept.
assert(kept.has('Омикрон 1-01'));assert(kept.has('Омикрон 1-02'));
// A whole title that is a known Film title, refused only by the year, is not screened by any new form either.
assert(kept.has('Эта. 9-я серия (2005)')||scan.uncertain.some(item=>item.title==='Эта. 9-я серия (2005)'));assert(!kept.has('Омега. 9-я серия (1990)'));
assert.deepEqual(JSON.parse(JSON.stringify(scan.stats.serialFiltered)),{ordinal_episode:2,season_pipe_episode:1,mini_series_label:1,dash_season_episode:4});
// Cross-channel: the same screened title on a discover channel is screened and on a known_only channel is skipped; neither reaches discovery.
assert.equal([...kept].filter(title=>title.startsWith('Лямбда. 9-я')).length,1);
// A screened programme on a known_only channel does not claim the slot of a known Film on the same channel and start (ADR 0142 decision 1).
assert(scan.films.some(film=>film.id==='lb-x'));
// A programme whose whole title is a known Film title (refused only by the year) keeps its ordinary slot claim on a known_only channel: with a known Film on the
// same channel and start both are discarded (ADR 0142 decision 1), exactly as before the serial screen, so exactly one conflict exists.
assert.equal(scan.stats.duplicate_slot,1);assert(!scan.films.some(film=>film.id==='lb-y'));
assert(!kept.has('Сигма. 9-я серия'));

// No catalog in the scan input (empty or unavailable) disables the ordinal form: an empty index must never permit a screen. The other forms are structural and stay on.
live.watchlist=[{id:'lb-only',title:'Единственный',original:'Единственный',aliases:['Единственный'],year:2001,runtime:100,tmdbId:'910009'}];live.policies=null;
const bare=await run('scanEPG(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(xml));c.close();}}),watchlist,now)');
const bareKept=new Set(bare.discovery.map(item=>item.title));
assert(bareKept.has('Альфа. 9-я серия'));assert(bareKept.has('Гамма. 15-я серия'));
assert(!bareKept.has('Дельта 2|5 Название'));assert(!bareKept.has('Зета 1-01'));
assert.equal(bare.stats.serialFiltered.ordinal_episode,undefined);

console.log('Serial episode screening: structural forms, film negatives, stem and year guards, known-Film precedence, slot claims, same-scan repeat pass and an unchanged cheap pass passed');
