// AIR-673 / ADR 0217 (Accepted) decision 9, delivery step 4, tests 14 and 15 (consumers), DORMANT, synthetic and pure: no Worker, network, R2, D1 or production.
// Covered here: the Watchlist ledger settlement `identity:lid_only` (a label with no TMDB movie, no alias invented); the source resolver and membership target decided by CLAIM rows, never by the spelling of an id
// (a Film minted `film:lb:<lid>` is found by its lid, and after an attach by its movie, under the same id); the pinned inventory of readers that still derive something from an id spelling.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {admissionStep,LID_ONLY_RESOLVED_BY} from '../src/letterboxd-sync-admission.js';
import {resolveIdentity} from '../src/canonical-producer-workflow.js';

// ---- 14. Watchlist settlement ----
assert.equal(LID_ONLY_RESOLVED_BY,'identity:lid_only');
const NOW=Date.parse('2026-11-27T10:00:00.000Z');
async function settleWith({label=null,link=null,outcome=null}={}){
 const settled=[];
 const repository={
  dueAdmissions:async()=>({ok:true,rows:[{lid:'lo1',attempts:0,updatedAt:'u',firstSeenSnapshotId:'s1',firstSeenAt:null,lastReason:null}],pending:1,overdue:0,overdueUnknown:0}),
  readSnapshot:async()=>({ok:true,snapshot:{films:[{lid:'lo1',url:'https://letterboxd.com/film/some-short/'}]}}),
  settleAdmission:async(env,fields,options)=>{settled.push({...fields,guards:options?.guards||[]});return {ok:true};},
 };
 const identity={
  MAX_ATTEMPTS:5,
  resolve:async()=>({labels:label?new Map([['lo1',label]]):new Map(),counts:{},outcomes:new Map([['lo1',outcome||{checked:true,class:label?'settled':'definite',reason:label?'lid_only':'x',attempts:0}]])}),
  diaryLinks:async()=>new Map(link?[['lo1',link]]:[]),
 };
 const step=admissionStep({repository,identity,epochGuard:epoch=>({epoch})});
 const ctx={env:{},epoch:1,now:()=>NOW,deadline:NOW+60000};
 const out=await step(ctx,{now:NOW});
 return {out,settled};
}
const OWNER=['INSERT INTO film_person_cas (id,ok) VALUES (1,1)',['lo1']];
{
 const lidOnly=await settleWith({label:{title:null,year:null,tmdb:null,lidOnly:true},outcome:{checked:true,class:'settled',reason:'lid_only',attempts:0,ownerGuard:OWNER}});
 assert.equal(lidOnly.out.resolved,1);
 assert.equal(lidOnly.settled.length,1);
 assert.deepEqual([lidOnly.settled[0].state,lidOnly.settled[0].resolvedBy],['resolved','identity:lid_only'],'a lid-only label settles as a typed success');
 assert.ok(lidOnly.settled[0].guards.some(guard=>guard===OWNER),'the ledger batch carries the current-ownership assertion of the Diary result');
 // a lid-only label WITHOUT that assertion is never trusted: the row stays due and nothing is settled
 const unguarded=await settleWith({label:{title:null,year:null,tmdb:null,lidOnly:true},outcome:{checked:true,class:'settled',reason:'lid_only',attempts:0}});
 assert.equal(unguarded.settled.length,0);assert.equal(unguarded.out.resolved,0);
 // A linked TMDB movie always wins: a label never overrides an alias.
 const linked=await settleWith({label:{title:null,year:null,tmdb:null,lidOnly:true},link:{tmdb:'603'}});
 assert.equal(linked.settled[0].resolvedBy,'identity:603');
 // The ordinary verified label (a movie) is unchanged.
 const verified=await settleWith({label:{title:'T',year:1999,tmdb:'603'}});
 assert.equal(verified.settled[0].resolvedBy,'identity:verified');
 // Pending keeps the row due; terminal keeps its reason: an unresolved id is never turned into a lid-only success.
 const pending=await settleWith({outcome:{checked:true,class:'definite',reason:'tmdb_contradiction',attempts:1}});
 assert.equal(pending.settled[0].state,'pending');
 assert.equal(pending.settled[0].resolvedBy??null,null);
}

// ---- 15. The resolver decides by claim rows, never by the spelling ----
{
 // A Film minted `film:lb:lo1` holding the trusted letterboxd claim `lo1`: the lid resolves to it by the CLAIM.
 const claims=[{film_id:'film:lb:lo1',scheme:'letterboxd',value:'lo1',trusted:1,conflicting:0}];
 const byLid=resolveIdentity('lo1',{claims});
 assert.deepEqual([byLid.target,byLid.via],['film:lb:lo1','claim']);
 // Minted but never claimed (no trusted claim row): the lid is NOT resolved from the id spelling alone unless the Film is the lid's own Film; an unclaimed lid with no `film:lo1` is unresolved.
 assert.equal(resolveIdentity('lo1',{claims:[],films:new Set(['film:lb:lo1'])}).refused,'producer_identity_unresolved');
 // A competing or untrusted row of the lid is never turned into ownership.
 assert.equal(resolveIdentity('lo1',{claims:[...claims,{film_id:'film:tmdb:9',scheme:'letterboxd',value:'lo1',trusted:0,conflicting:0}]}).refused,'producer_identity_ambiguous');
 // After an attach the same Film is the survivor of its movie: `film:lb:lo1` is returned for the movie reference, never a second `film:tmdb:<n>`.
 const movie=resolveIdentity('tmdb_603',{claims:[{film_id:'film:lb:lo1',scheme:'tmdb',value:'603',trusted:1,conflicting:0}]});
 assert.deepEqual([movie.target,movie.via,movie.movie],['film:lb:lo1','movie_claim','603']);
 // A Film id is permanent and never reinterpreted whatever its spelling: `film:lb:lo1` as an explicit id is itself.
 assert.deepEqual([resolveIdentity('film:lb:lo1',{}).target,resolveIdentity('film:lb:lo1',{}).via],['film:lb:lo1','direct']);
}

// ---- Inventory: readers that still derive something from the SPELLING of an id (decision 9, "inventory all readers inferring claim from ID spelling") ----
// None of them may infer a CLAIM for a `film:lb:` Film. Each entry is one reader with its disposition; a new spelling-derived reader fails this guard until it is classified in docs/reference/domain/film-person.md.
const SPELLING=[/startsWith\('film:tmdb:/,/'film:tmdb:'\s*\+/,/\^film:tmdb:/,/slice\(['"]film:tmdb:/];
const KNOWN={
 'src/canonical-producer-workflow.js':'resolves the movie from claim rows first (AIR-671); the spelling is only the target of a genuinely unclaimed movie',
 'src/owner-review-d1.js':'filmMatches: an identity link first; a spelling fallback that can only under-match a film:lb: Film, never assert a claim',
 'src/offline-importer.js':'legacy import of stored ids (migration tool, not a reader of live Films)',
 'src/worker.js':'rated label hand-off: `tmdb_<n>` -> `film:tmdb:<n>` for a LABEL lookup only; a Film attached after minting as film:lb: loses the label, never gains a wrong one',
 'src/film-admission.js':'the minting spelling of a NEW movie Film; ownership is resolved first (resolveAdmissionFilm)',
 'src/canonical-film-writers.js':'documents the minting namespace; ownership is asserted in the batch (decision 8d)',
 'src/canonical-catalog-reader.js':'catalog titles and admissions: `tmdb_<n>` -> its minting spelling `film:tmdb:<n>`; it under-matches a film:lb: Film attached later (answers absent), never asserts a claim. Resolving by claim is the attach activation (ADR 0217 step 6, 8d)',
 'src/canonical-discovery-admission-producer.js':'Discovery admission of a MOVIE: the trusted tmdb claim owner first, else the minting spelling `film:tmdb:<n>` (planAdmissionFilm)',
 'src/canonical-metadata-sync-producer.js':'metadata sync of a movie id: the minting spelling of a movie Film; ownership is resolved at planning (decision 8d)',
 'src/canonical-producers.js':'producer registry: the target id of a rated admission from its `tmdb_<n>` receipt key; a lid-only receipt carries its own filmId',
 'src/domain/film-person-diagnostics.js':'diagnostic display id only (`film:tmdb:<n>` -> `tmdb_<n>`); no claim is read or written',
 'src/domain/film-person-reader.js':'legacy lifecycle reader: the minting spelling of a stored movie record; not a reader of lid-only Films',
 'src/domain/film-person.js':'the one stored-spelling rule of the legacy lifecycle: `tmdb_<n>` -> `film:tmdb:<n>`; a `film:lb:` id passes through unchanged and is never reinterpreted',
};
{
 const hits=[];
 for(const file of fs.readdirSync('src',{recursive:true}).filter(name=>name.endsWith('.js')).map(name=>'src/'+name)){
  const text=fs.readFileSync(file,'utf8');
  if(SPELLING.some(re=>re.test(text)))hits.push(file);
 }
 const unknown=hits.filter(file=>!KNOWN[file]&&!file.startsWith('src/admin/'));
 assert.deepEqual(unknown,[],'a reader derives a movie from an id spelling: classify it in the inventory (docs/reference/domain/film-person.md) before it ships');
}
console.log('lid-only-consumers: ok');
