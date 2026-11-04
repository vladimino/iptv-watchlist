#!/usr/bin/env node
// Offline status for the discovery marker (ADR 0085). Default is read-only.
// This process does not apply a migration, does not import a ledger, does not
// set mode d1, and does not call the network. A database path that names
// production is refused before sqlite is opened.
import {spawnSync} from 'node:child_process';

const PRODUCTION=/3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb|(?:^|[\\/])iptv(?:[\\/]|$)/i;
const args=process.argv.slice(2);
const database=args.includes('--database')?args[args.indexOf('--database')+1]:undefined;
const refuse=message=>{console.error('refuse: '+message);process.exit(2);};
if(args.includes('--apply')||args.includes('--activate')||args.includes('--import')||args.includes('--load'))refuse('schema apply, import and activation are not this command');
if(!database){console.log(JSON.stringify({configured:false,writes:false,mode:null}));process.exit(0);}
if(PRODUCTION.test(database))refuse('this script does not select production D1');
const result=spawnSync('sqlite3',['-json','-bail',database],{input:"SELECT mode, cutover, generation, programme_run_id FROM discovery_authority WHERE id=1;",encoding:'utf8'});
if(result.status!==0)refuse(result.stderr.trim()||'sqlite failed');
const row=JSON.parse(result.stdout||'[]')[0]||null;
console.log(JSON.stringify({configured:true,writes:false,mode:row?.mode??null,cutover:row?.cutover??null,generation:row?.generation??null,programmeRunId:row?.programme_run_id??null}));
