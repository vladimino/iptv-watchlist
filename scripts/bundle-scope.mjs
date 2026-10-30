import fs from 'node:fs';

// AIR-275 phase 2 (ADR 0054): a file shared with the offline tools runs in its own scope, so its helpers cannot collide with
// Worker names. An ES module gives its exports; a plain script names what it hands over. Neither may import anything.
export function scoped(file,name,names){
 const source=fs.readFileSync(file,'utf8');
 if(/^\s*import\s/m.test(source)||/^export\s*\{/m.test(source))throw new Error(file+' cannot be bundled: it imports or re-exports');
 const exported=names||[...source.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gm)].map(match=>match[1]);
 if(!exported.length)throw new Error(file+' hands over nothing');
 return 'const '+name+'=(()=>{\n'+source.replace(/^export\s+/gm,'')+'\nreturn {'+exported.join(',')+'};\n})();';
}
