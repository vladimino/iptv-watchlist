// AIR-456 H1 guard. The diagnostic D1 binding in wrangler.jsonc must name the REAL database the owner created (GO-1). While `database_id` is the all-zero placeholder this test fails on
// purpose: a deploy of this configuration would fail (or bind nothing), so the pull request must not merge. Replace the placeholder with the uuid read back from the created database.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8').replace(/^\s*\/\/.*$/gm,''));
const entry=config.d1_databases.find(item=>item.binding==='EPG_DIAGNOSTIC_DB');
assert.ok(entry,'the diagnostic D1 binding is declared');
assert.match(entry.database_id,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,'database_id is a uuid');
assert.notEqual(entry.database_id,'00000000-0000-0000-0000-000000000000','database_id is still the placeholder: create the diagnostic database (GO-1) and put its uuid here');
assert.notEqual(entry.database_id,config.d1_databases.find(item=>item.binding==='DB').database_id,'the diagnostic database id is not the production one');
console.log('EPG diagnostic bindings: the diagnostic D1 binding names a real, non-production database passed');
