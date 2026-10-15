import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

// Historical integration fixtures contain downloaded production snapshots and
// are intentionally not part of the public repository.
const fixtureDependent=new Set([
 'filters-window.mjs',
 'names.mjs',
 'sources.mjs',
 'synopsis.mjs',
 'titles.mjs',
 'unscheduled.mjs',
]);
const tests=readdirSync('tests').filter(file=>file.endsWith('.mjs')&&!fixtureDependent.has(file)).sort();
for(const file of tests){
 const result=spawnSync(process.execPath,['tests/'+file],{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
console.log(`Passed ${tests.length} self-contained test files.`);
