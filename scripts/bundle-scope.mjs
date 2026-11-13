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
export function scopedImports(file,name,preamble){
 let source=fs.readFileSync(file,'utf8').replace(/^\s*import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?\r?\n/gm,'');
 if(/^\s*import\s/m.test(source))throw new Error(file+' cannot be bundled: an import is not a single-line named import');
 const reexported=[];
 source=source.replace(/^export\s*\{([^}]+)\};?\r?\n/gm,(_,names)=>{reexported.push(...names.split(',').map(item=>item.trim()).filter(Boolean));return '';});
 const exported=[...new Set([...[...source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gm)].map(match=>match[1]),...reexported])];
 if(!exported.length)throw new Error(file+' hands over nothing');
 return 'const '+name+'=(()=>{\n'+preamble+'\n'+source.replace(/^export\s+/gm,'')+'\nreturn {'+exported.join(',')+'};\n})();';
}

// ADR 0135 (AIR-459). The pure pause contract needs the orchestration policy (Madrid day and instant); both are scoped in front of the Discovery authority, which calls the
// contract. One definition of these names serves the Worker bundle and every test that loads the authority in a vm.
export function scopedEpgPriority(){
 return scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scopedReplacing('src/domain/epg-priority-pause.js','EpgPriorityPause','const {EPG_SCHEDULE,madridDayKey,madridInstant}=OrchestrationPolicy;\n');
}
export function scopedDiscoveryAuthority(){
 return scopedReplacing('src/discovery-authority.js','DiscoveryAuthority','const {discoveryAdmission,pauseRowWrite,admissionBounds,DISCOVERY_EPG_PRIORITY_POLL_MS}=EpgPriorityPause;\n');
}
