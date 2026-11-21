// The migration index and the Letterboxd control-plane documentation name the real files in the real order (AIR-571 docs check).
import fs from 'node:fs';import assert from 'node:assert/strict';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const index=fs.readFileSync('migrations/README.md','utf8');
for(const name of files)assert.ok(index.includes('['+name+']('+name+')'),'migrations/README.md has no row for '+name);
// The chain the docs pin: these three files exist, in this order, with their versions. A later migration (0034 and on) never breaks this.
const chain=['0031_watchlist_authority.sql','0032_epg_channel_authority.sql','0033_letterboxd_sync_control.sql'];
const positions=chain.map(name=>files.indexOf(name));
assert.ok(positions.every(position=>position>=0)&&positions.every((position,i)=>i===0||position>positions[i-1]),'0031, 0032 and 0033 exist in order');
for(const name of chain)assert.ok(index.includes('['+name+']('+name+') | '+Number(name.slice(0,4))+' |'),'the index row of '+name+' names its schema version');
const schema=fs.readFileSync('docs/reference/data/d1-schema.md','utf8');
const start=schema.indexOf('## Letterboxd Sync control plane');
const section=schema.slice(start,schema.indexOf('\n## ',start+4));
assert.match(section,/schema v33/);assert.match(section,/0033_letterboxd_sync_control\.sql/);
assert.doesNotMatch(section,/\b0032\b(?!` is the EPG Channel)/,'the Letterboxd control plane is 0033, never 0032');
assert.doesNotMatch(schema,/`0031_\*` file|rebased as `0032`/,'the resolved numbering conflict is not a current instruction');
console.log('migration index docs: ok');
