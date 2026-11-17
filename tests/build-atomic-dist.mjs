// The test suite runs files in parallel, and several of them run build.mjs before they import dist/server/index.js. A build must
// therefore never expose a missing or partly written bundle to a reader, and two builds running at once must both succeed. This test
// starts three builds at once and reads both outputs in a tight loop while they run: every read must return the complete, expected
// bytes. It also checks that a build still removes outputs it no longer produces, and that its own builds leave no temporary file.
// Other tests build into the same dist/ in parallel, so every assertion on the directory is scoped to this test's own build
// processes (a temporary file is named <output>.<pid>.<random>.tmp) and to the stale entries this test creates.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const build=()=>spawnSync(process.execPath,[path.join(root,'build.mjs')],{cwd:root,encoding:'utf8'});
const files=['dist/server/index.js','dist/server/workflow-entry.js'].map(file=>path.join(root,file));

// 1. One build gives the expected bytes. The build is deterministic, so every later build writes the same content.
const first=build();
assert.equal(first.status,0,'the build succeeds: '+first.stderr);
const expected=files.map(file=>fs.readFileSync(file));
assert.ok(expected[0].length>100000,'the bundle is the full Worker');

// 2. Three builds at once while a reader polls both outputs. A missing file, a short read or different bytes is a failure.
const pids=[first.pid];
const running=[0,1,2].map(()=>new Promise(resolve=>{
 const child=spawn(process.execPath,[path.join(root,'build.mjs')],{cwd:root,stdio:['ignore','ignore','pipe']});
 pids.push(child.pid);
 let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 child.on('close',status=>resolve({status,stderr}));
}));
let done=false,reads=0;
const finished=Promise.all(running).then(results=>{done=true;return results;});
while(!done){
 for(let i=0;i<files.length;i++){
  let bytes;
  try{bytes=fs.readFileSync(files[i]);}
  catch(error){assert.fail(`read ${path.basename(files[i])} during a build: ${error.code||error.message}`);}
  assert.ok(bytes.equals(expected[i]),`read ${path.basename(files[i])} during a build: ${bytes.length} bytes, expected ${expected[i].length}`);
  reads++;
 }
 await new Promise(resolve=>setImmediate(resolve));
}
for(const result of await finished)assert.equal(result.status,0,'every concurrent build succeeds: '+result.stderr);
assert.ok(reads>=20,`the reader overlapped the builds (${reads} reads)`);

// 3. None of this test's builds left a temporary file, and the outputs are still exactly the expected bytes. A temporary file of
// another test's build that is still running is legitimate and is not looked at.
const ownTemp=()=>fs.readdirSync(path.join(root,'dist/server')).filter(name=>pids.some(pid=>name.includes(`.${pid}.`)&&name.endsWith('.tmp')));
assert.deepEqual(ownTemp(),[],'no temporary file of this test\'s builds remains');
files.forEach((file,i)=>assert.ok(fs.readFileSync(file).equals(expected[i]),path.basename(file)));

// 4. Outputs the build no longer produces are removed, as the former whole-directory delete did.
fs.writeFileSync(path.join(root,'dist/server/stale.js'),'stale');
fs.mkdirSync(path.join(root,'dist/stale-dir'),{recursive:true});
fs.writeFileSync(path.join(root,'dist/stale-dir/old.js'),'old');
const again=build();
assert.equal(again.status,0,again.stderr);
pids.push(again.pid);
assert.equal(fs.existsSync(path.join(root,'dist/server/stale.js')),false,'a stale file in dist/server is removed');
assert.equal(fs.existsSync(path.join(root,'dist/stale-dir/old.js')),false,'a stale file elsewhere in dist is removed (an emptied directory may stay)');
assert.deepEqual(ownTemp(),[],'the last build left no temporary file');
files.forEach(file=>assert.ok(fs.existsSync(file),path.basename(file)+' is still in place'));

console.log(`Atomic build output: three concurrent builds succeed, ${reads} reads during them all saw the complete bundle, none of its builds left a temporary file, and stale outputs are removed`);
