// The head of the migration chain, read from the same directory that every full-chain fixture applies (migrations/NNNN_*.sql). Tests that need "the full chain ends at
// the current head" use this instead of a literal version, so the next additive migration does not break them (preventive merge check, docs/process/agent-workflow.md).
// Exact predecessor/version checks of one migration keep pinning their own number; only the open-ended head is derived.
import fs from 'node:fs';
export const migrationFiles=()=>fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
export const migrationHead=()=>Number(migrationFiles().at(-1).slice(0,4));
