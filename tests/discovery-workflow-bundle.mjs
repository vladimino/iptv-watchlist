// Node.js 20 does not start Wrangler. Wrangler 4.151.1 requires Node.js >= 22, and CI
// runs that dry-run in a later step (scripts/check-discovery-workflow-bundle.mjs).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';

const ci=fs.readFileSync('.github/workflows/ci.yml','utf8');
assert.equal(ci.match(/wranglerVersion:\s*"([^"]+)"/)?.[1],'4.151.1');
assert.match(ci,/node-version:\s*20/);
assert.match(ci,/node-version:\s*22/);
const testsAt=ci.indexOf('npm test');
const buildAt=ci.indexOf('npm run build');
const node22At=ci.indexOf('node-version: 22');
const checkAt=ci.indexOf('node scripts/check-discovery-workflow-bundle.mjs');
assert.ok(testsAt>0&&buildAt>testsAt&&node22At>buildAt&&checkAt>node22At,'the Node 22 dry-run follows the Node 20 tests and build');
const script=fs.readFileSync('scripts/check-discovery-workflow-bundle.mjs','utf8');
assert.match(script,/\['deploy','--dry-run'/);
assert.match(script,/4\.151\.1/);
assert.doesNotMatch(script,/--message/);
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
assert.equal(pkg.devDependencies.wrangler,'4.151.1');
execFileSync(process.execPath,['build.mjs'],{stdio:'inherit'});
assert.equal(fs.existsSync('dist/server/workflow-entry.js'),true);
assert.match(fs.readFileSync('dist/server/workflow-entry.js','utf8'),/export class DiscoveryWorkflow extends WorkflowEntrypoint/);
assert.doesNotMatch(fs.readFileSync('dist/server/index.js','utf8'),/cloudflare:workers/);
const wrangler=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
assert.equal(wrangler.workflows[0].schedules,undefined);
assert.equal(JSON.stringify(wrangler).includes('schedules'),false);
console.log('Discovery workflow bundle: Node 20 suite pins the Node 22 dry-run and does not start Wrangler');
