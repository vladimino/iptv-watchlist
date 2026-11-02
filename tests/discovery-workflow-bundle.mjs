// Offline bundle check for the inert Discovery Workflow entry. Uses the Wrangler version pinned by the
// production deploy job. --dry-run builds the module and does not deploy, create an instance, or call TMDB.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

const ci=fs.readFileSync('.github/workflows/ci.yml','utf8');
const pinned=ci.match(/wranglerVersion:\s*"([^"]+)"/)?.[1];
assert.equal(pinned,'4.151.1');
execFileSync(process.execPath,['build.mjs'],{stdio:'inherit'});
assert.equal(fs.existsSync('dist/server/workflow-entry.js'),true);
assert.match(fs.readFileSync('dist/server/workflow-entry.js','utf8'),/export class DiscoveryWorkflow extends WorkflowEntrypoint/);
assert.doesNotMatch(fs.readFileSync('dist/server/index.js','utf8'),/cloudflare:workers/);
const outdir='dist/workflow-dry-run';
fs.rmSync(outdir,{recursive:true,force:true});
const output=execFileSync('npx',['--yes',`wrangler@${pinned}`,'deploy','--dry-run','--outdir',outdir],{
 encoding:'utf8',
 timeout:180000,
 env:{...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_API_TOKEN:'',CI:'true'}
});
assert.match(output,/--dry-run|dry-run/i);
assert.equal(fs.existsSync(outdir),true);
const bundled=fs.readdirSync(outdir).map(name=>fs.readFileSync(outdir+'/'+name,'utf8')).join('\n');
assert.match(bundled,/DiscoveryWorkflow/);
assert.doesNotMatch(bundled,/workflows"\s*:\s*\[[^\]]*"schedules"/);
const wrangler=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
assert.equal(wrangler.workflows[0].schedules,undefined);
assert.equal(JSON.stringify(wrangler).includes('schedules'),false);
console.log('Discovery workflow bundle: wrangler',pinned,'dry-run validated the generated entry');
