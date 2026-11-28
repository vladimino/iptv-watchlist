import fs from 'node:fs';

// AIR-275 phase 2 (ADR 0056): a file shared with the offline tools runs in its own scope, so its helpers cannot collide with
// Worker names. An ES module gives its exports; a plain script names what it hands over. Neither may import anything.
// A module that imports one already-scoped binding. The replacement runs in the Worker scope, where that binding exists.
export function scopedReplacing(file,name,replacement){
 let source=fs.readFileSync(file,'utf8').replace(/^\s*import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?\r?\n/gm,replacement);
 if(/^\s*import\s/m.test(source)||/^export\s*\{/m.test(source))throw new Error(file+' cannot be bundled: it imports or re-exports');
 const exported=[...source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gm)].map(match=>match[1]);
 if(!exported.length)throw new Error(file+' hands over nothing');
 return 'const '+name+'=(()=>{\n'+source.replace(/^export\s+/gm,'')+'\nreturn {'+exported.join(',')+'};\n})();';
}
export function scoped(file,name,names){
 const source=fs.readFileSync(file,'utf8');
 if(/^\s*import\s/m.test(source)||/^export\s*\{/m.test(source))throw new Error(file+' cannot be bundled: it imports or re-exports');
 const exported=names||[...source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gm)].map(match=>match[1]);
 if(!exported.length)throw new Error(file+' hands over nothing');
 return 'const '+name+'=(()=>{\n'+source.replace(/^export\s+/gm,'')+'\nreturn {'+exported.join(',')+'};\n})();';
}
// The person identity projection imports the canonical Person module. Both are pure. One scope
// strips the import and the exports so the Worker bundle can call them without a second copy of either name.
export function scopePersonIdentity(files=['src/domain/canonical-person.js','src/domain/person-identity-projection.js']){
 let body='';
 for(const file of files){
  let source=fs.readFileSync(file,'utf8');
  source=source.replace(/^\s*import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?\r?\n/gm,'');
  if(/^\s*import\s/m.test(source))throw new Error(file+' cannot be bundled: it imports');
  body+=source.replace(/^export\s+/gm,'')+'\n';
 }
 return 'const PersonIdentity=(()=>{\n'+body+'return {projectPersonIdentity,resolvePersonReference,filmsForPerson,personSurfaces,personFold};\n})();\n';
}

// AIR-374 P3c: a canonical producer module that imports several already-scoped bindings. EVERY single-line import is removed and `preamble` (destructuring of the scopes already in the Worker) takes its place, so the module sees the same
// names it has offline. `export {a,b};` re-export lines are dropped and `a`/`b` are handed over too (they must be bindings of the scope or of the preamble). The scope exports every `export function|const|async function`.
// AIR-648: `options.transform(source)` rewrites the source BEFORE the import checks (a module with a Node-only loader supplies the Worker binding instead; any import left after it still fails the build), and
// `options.extra` names exports the three declaration kinds above cannot see (an `export class`). Both default to nothing, so every other caller is unchanged.
export function scopedImports(file,name,preamble,options={}){
 const original=options.transform?options.transform(fs.readFileSync(file,'utf8')):fs.readFileSync(file,'utf8');
 // AIR-532: every name the module IMPORTS and then USES must be supplied by `preamble`, otherwise the Worker scope has no such binding and the call is a ReferenceError at runtime
 // (an ES-module test cannot see this: the real import resolves there). Checked here so a missing name fails the build, not the first production run that reaches it.
 const body=original.replace(/^\s*import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?\r?\n/gm,'');
 const missing=[...original.matchAll(/^\s*import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"];?/gm)]
  .flatMap(match=>match[1].split(',').map(item=>item.trim()).filter(Boolean).map(item=>item.split(/\s+as\s+/).pop().trim()))
  .filter(local=>new RegExp('(?<![A-Za-z0-9_$.])'+local.replace(/\$/g,'\\$')+'(?![A-Za-z0-9_$])').test(body)&&!new RegExp('(?<![A-Za-z0-9_$.])'+local.replace(/\$/g,'\\$')+'(?![A-Za-z0-9_$])').test(preamble));
 if(missing.length)throw new Error(file+' imports and uses '+missing.join(', ')+' but the scope preamble does not provide it: it would be undefined in the Worker');
 let source=body;
 if(/^\s*import\s/m.test(source))throw new Error(file+' cannot be bundled: an import is not a single-line named import');
 const reexported=[];
 source=source.replace(/^export\s*\{([^}]+)\};?\r?\n/gm,(_,names)=>{reexported.push(...names.split(',').map(item=>item.trim()).filter(Boolean));return '';});
 const exported=[...new Set([...[...source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gm)].map(match=>match[1]),...reexported,...(options.extra||[])])];
 if(!exported.length)throw new Error(file+' hands over nothing');
 return 'const '+name+'=(()=>{\n'+preamble+'\n'+source.replace(/^export\s+/gm,'')+'\nreturn {'+exported.join(',')+'};\n})();';
}

// ADR 0135 (AIR-459). The pure pause contract needs the orchestration policy (Madrid day and instant); both are scoped in front of the Discovery authority, which calls the
// contract. One definition of these names serves the Worker bundle and every test that loads the authority in a vm.
export function scopedEpgPriority(){
 return scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scopedReplacing('src/domain/epg-priority-pause.js','EpgPriorityPause','const {EPG_SCHEDULE,madridDayKey,madridInstant}=OrchestrationPolicy;\n');
}
// ADR 0142: the per-slot evidence rule is a pure module scoped in front of the authority, which assigns slots with it.
// ADR 0178: the identity review module is scoped here too, because the owner write checks a revoke command with it.
export function scopedDiscoveryAuthority(){
 return scoped('src/domain/slot-evidence.js','SlotEvidence')+'\n'+scoped('src/domain/discovery-identity-review.js','DiscoveryIdentity')+'\n'+scopedImports('src/discovery-authority.js','DiscoveryAuthority','const {revokeWriteMatches,originalStillEffective}=DiscoveryIdentity;\nconst {discoveryAdmission,pauseRowWrite,admissionBounds,DISCOVERY_EPG_PRIORITY_POLL_MS}=EpgPriorityPause;\nconst {slotEligibility,slotScanConfirmation,decisionAnchor,slotMinutes,revalidationPlan,revalidatedDecision,REVALIDATION_LIMIT:SLOT_REVALIDATION_LIMIT}=SlotEvidence;\nconst {planDomainEvidence,domainEvidenceStatements,readWriter,WRITER_ACTIVE_SQL}=IdentityEvidenceWriter;\nconst {planOwnerEvidence,ownerEvidenceStatements,OWNER_WRITER}=DiscoveryOwnerEvidence;');
}
// AIR-617 (ADR 0215): the Discovery decision write appends its identity evidence row, so the writer module and what it imports are scoped IN FRONT of the Discovery authority. `FilmPersonAuthority`, `ProducerFence`, `CanonicalMutations` and `CanonicalReceipts`
// must already be in scope (build.mjs scopes them there, ahead of this call; none of them depends on Discovery; `loadDiscoveryAuthority` below does the same for a test world).
export function scopedIdentityEvidence(){
 return scopedImports('src/identity-evidence.js','IdentityEvidence','const {assertWritable,database,failed,one,readAuthority}=FilmPersonAuthority;\nconst {fenced}=CanonicalMutations;\nconst {RETRY_POLICY,defineOperation,digestOf,receiptedWrite,requestIdOf}=CanonicalReceipts;')+'\n'+scopedImports('src/identity-evidence-writer.js','IdentityEvidenceWriter','const {database,failed,many,one}=FilmPersonAuthority;\nconst {fenced}=CanonicalMutations;\nconst {evidenceKeyOf,normalizeEvidence,KNOWN_ALIAS_SCOPES}=IdentityEvidence;')+'\n'+scopedImports('src/discovery-owner-evidence.js','DiscoveryOwnerEvidence','const {evidenceKeyOf,normalizeEvidence}=IdentityEvidence;\nconst {ABSENT,domainEvidenceStatements,identityEvidenceControlStatus,planDomainEvidence}=IdentityEvidenceWriter;');
}

// AIR-617: the Discovery authority now calls the identity evidence writer, so a test world that loads the authority needs the layers scoped in front of it. `run` is `script=>vm.runInContext(script,world)`.
// A world that already holds `FilmPersonAuthority` (it loads it for its own reasons) keeps that copy.
export function loadDiscoveryAuthority(run){
 if(run('typeof FilmPersonAuthority')==='undefined')run(scoped('src/film-person-authority.js','FilmPersonAuthority'));
 // The same three scopes, with the same preambles, as build.mjs (which a test reads as text, so it keeps its own copy).
 run(scoped('src/canonical-producer-fence.js','ProducerFence'));
 // AIR-631: the merge reads the provenance control row, so the provenance module (and the pure planner whose anchor digest it shares) is scoped in front of the mutations, as build.mjs does.
 if(run('typeof CatalogEnrichmentPlan')==='undefined')run(scoped('src/catalog-enrichment-plan.js','CatalogEnrichmentPlan'));
 run(scopedImports('src/film-metadata-provenance.js','FilmMetadataProvenance','const {failed,many,one}=FilmPersonAuthority;\nconst {computeAnchors,anchorSetGuard,canonicalJson}=CatalogEnrichmentPlan;'));
 run(scopedImports('src/canonical-mutations.js','CanonicalMutations','const {assertWritable,database,dropGateReuse,failed,many,one,readAuthority,readWriterGate}=FilmPersonAuthority;\nconst {bindProducerFence,fenceStatements}=ProducerFence;\nconst {readControl,reconcileMetadata}=FilmMetadataProvenance;'));
 run(scopedImports('src/canonical-receipts.js','CanonicalReceipts','const {assertWritable,database,dropGateReuse,failed,many,one,readAuthority,readWriterGate,reuseSchemaFact}=FilmPersonAuthority;\nconst {fenced}=CanonicalMutations;'));
 run(scopedIdentityEvidence());
 run(scopedDiscoveryAuthority());
}

// AIR-648: the shared Film resolver, the FilmAggregateV1 sections and the multi-alias history, scoped into the Worker bundle (DORMANT: no route names them until the owner-approved
// activation). One definition serves the Worker and every test that loads them. All four go through scopedImports, so the AIR-532 check (a name the module imports and uses must be supplied
// by the preamble) applies to each. The history module loads three plain domain scripts through node:fs/node:vm offline; the Worker already holds those scripts as globals (film-history.js,
// prediction-versions.js and the LetterboxdFacts scope), so `historyLoader` replaces exactly those declarations with bindings to the same globals and fails the build if the source stops matching.
// This scope must come AFTER src/letterboxd-facts.js in the bundle (its LetterboxdFacts const is read when the scope runs). `export class` is not one of the declaration kinds
// scopedImports sees, so each class a module exports is handed over explicitly (FilmAggregateInvalid, the typed invalid-request error).
const exportedClasses=file=>[...fs.readFileSync(file,'utf8').matchAll(/^export\s+class\s+([A-Za-z0-9_]+)/gm)].map(match=>match[1]);
function historyLoader(source){
 const loader=/^const legacy=vm\.runInNewContext\([^\n]*\n[^\n]*compareHistoryEvents\}\)',\{\}\);\r?\nconst letterboxdFacts=vm\.runInNewContext\([^\n]*\r?\nconst versionRule=vm\.runInNewContext\([^\n]*\r?\n/m;
 const alias=/^export \{eventIdOf as historyEventId\};\r?\n/m;
 for(const [pattern,label] of [[loader,'the domain-script loader'],[alias,'the historyEventId re-export'],[/^import fs from 'node:fs';\r?\n/m,"import fs"],[/^import vm from 'node:vm';\r?\n/m,"import vm"]])
  if(!pattern.test(source))throw new Error('src/film-history-aggregate.js: '+label+' no longer matches the Worker replacement');
 return source
  .replace(loader,'const legacy={historyTime,historyValue,predictionHistoryEvent,ratingHistoryEvent,legacyRatingEvent,diaryViewingEvent,compareHistoryEvents};\nconst letterboxdFacts=LetterboxdFacts;\nconst versionRule={predictionVersionLinked};\n')
  .replace(alias,'const historyEventId=eventIdOf;\nexport {historyEventId};\n')
  .replace(/^import fs from 'node:fs';\r?\n/m,'').replace(/^import vm from 'node:vm';\r?\n/m,'');
}
export function scopedFilmAggregate(){
 const resolver='src/film-aggregate-resolver.js',aggregate='src/film-aggregate.js',history='src/film-history-aggregate.js';
 return scoped('src/sha256-sync.js','Sha256Sync')+'\n'
  +scopedImports(resolver,'FilmAggregateResolver','const {sha256Hex}=Sha256Sync;\nconst {database,many,readAuthority}=FilmPersonAuthority;',{extra:exportedClasses(resolver)})+'\n'
  +scopedImports(aggregate,'FilmAggregate','const {sha256Hex}=Sha256Sync;\nconst {CREDIT_SELECTION_SQL,database}=FilmPersonAuthority;\nconst {localizationInputsFromRows,ownerCandidatesFromEntries,resolveLocalization}=LocalizationSources;\nconst {readFilmAggregateIdentity,REQUEST_STATEMENT_BUDGET,FILM_AGGREGATE_CONTRACT}=FilmAggregateResolver;\nconst {COHORT_SQL,MISSING_LID_ADMISSION,predictionEligibility}=PredictionLidOnly;',{extra:exportedClasses(aggregate)})+'\n'
  +scopedImports(history,'FilmHistoryAggregate','const {sha256Hex}=Sha256Sync;\nconst {database}=FilmPersonAuthority;\nconst {readFilmAggregateIdentity,REQUEST_STATEMENT_BUDGET}=FilmAggregateResolver;\nconst {aliases:authorizedAliases,readRatings,countedDatabase}=FilmAggregate;',{transform:historyLoader,extra:exportedClasses(history)});
}
