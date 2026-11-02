// Wrangler 4.151.1 deploy --dry-run for the inert Discovery Workflow entry.
// That release requires Node.js >= 22. CI runs this after the Node.js 20 tests
// and build, from an explicit Node.js 22 step. npm test must not start Wrangler.
// --dry-run bundles the already built entry and does not deploy, create an
// instance, or call TMDB.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

const major=Number(process.versions.node.split('.')[0]);
if(!(major>=22)){
 console.error('Wrangler 4.151.1 deploy --dry-run requires Node.js >= 22; this process is '+process.version);
 process.exit(1);
}
const ci=fs.readFileSync('.github/workflows/ci.yml','utf8');
const pinned=ci.match(/wranglerVersion:\s*"([^"]+)"/)?.[1];
assert.equal(pinned,'4.151.1');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
assert.equal(pkg.devDependencies?.wrangler,'4.151.1');
assert.equal(fs.existsSync('dist/server/workflow-entry.js'),true,'run npm run build before this check');
assert.match(fs.readFileSync('dist/server/workflow-entry.js','utf8'),/export class DiscoveryWorkflow extends WorkflowEntrypoint/);
assert.doesNotMatch(fs.readFileSync('dist/server/index.js','utf8'),/cloudflare:workers/);
const bin='node_modules/.bin/wrangler';
const version=execFileSync(bin,['--version'],{encoding:'utf8'}).trim();
assert.match(version,/4\.151\.1/);
const outdir='dist/workflow-dry-run';
fs.rmSync(outdir,{recursive:true,force:true});
const output=execFileSync(bin,['deploy','--dry-run','--outdir',outdir],{
 encoding:'utf8',
 timeout:180000,
 env:{...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_API_TOKEN:'',CI:'true'}
});
assert.match(output,/--dry-run|dry-run/i);
assert.doesNotMatch(output,/Deployed|Current Version ID/i);
assert.equal(fs.existsSync(outdir),true);
const bundled=fs.readdirSync(outdir).map(name=>fs.readFileSync(outdir+'/'+name,'utf8')).join('\n');
assert.match(bundled,/DiscoveryWorkflow/);
assert.doesNotMatch(bundled,/workflows"\s*:\s*\[[^\]]*"schedules"/);
fs.rmSync(outdir,{recursive:true,force:true});
const wrangler=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
assert.equal(wrangler.workflows[0].schedules,undefined);
assert.equal(JSON.stringify(wrangler).includes('schedules'),false);
console.log('Discovery workflow bundle: wrangler',pinned,'dry-run validated the generated entry and did not deploy');
