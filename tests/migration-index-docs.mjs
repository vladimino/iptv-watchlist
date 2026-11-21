// The migration index and the Letterboxd control-plane documentation name the real files in the real order (AIR-571 docs check).
import fs from 'node:fs';import assert from 'node:assert/strict';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const index=fs.readFileSync('migrations/README.md','utf8');
for(const name of files)assert.ok(index.includes('['+name+']('+name+')'),'migrations/README.md has no row for '+name);
assert.deepEqual(files.slice(-3),['0031_watchlist_authority.sql','0032_epg_channel_authority.sql','0033_letterboxd_sync_control.sql'],'the chain order the docs pin');
const schema=fs.readFileSync('docs/reference/data/d1-schema.md','utf8');
const section=schema.slice(schema.indexOf('## Letterboxd Sync control plane'),schema.indexOf('## Accepted design (proposed schema'));
assert.match(section,/schema v33/);assert.match(section,/0033_letterboxd_sync_control\.sql/);
assert.doesNotMatch(section,/\b0032\b(?!` is the EPG Channel)/,'the Letterboxd control plane is 0033, never 0032');
assert.doesNotMatch(schema,/`0031_\*` file|rebased as `0032`/,'the resolved numbering conflict is not a current instruction');
console.log('migration index docs: ok');
