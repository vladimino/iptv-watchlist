// AIR-374 M2b: prints the digests of the reader. The text of an `execute` call is BLOCKED (no tested delivery path for a full-table result). OFFLINE: it reads no file except its own imports, touches no network, D1, R2 or Cloudflare, and is not a GO.
//
//   node scripts/epg-producer-m2b-reader-bundle.mjs digest                     the statements digest, the reader digest and the plan size, as JSON
//   node scripts/epg-producer-m2b-reader-bundle.mjs bundle ...                 BLOCKED: refuses (exit 3) and prints nothing on stdout; see the runbook, section 2a
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {emitSql} from './epg-producer-m2b.mjs';
import {bundleText,readerDigest} from './epg-producer-m2b-reader.mjs';

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const [command,...rest]=process.argv.slice(2);
 const plan=emitSql();
 if(command==='digest')console.log(JSON.stringify({statementsDigest:plan.statementsDigest,readerDigest:readerDigest(),statements:plan.statements.length,caps:plan.caps},null,1));
 else if(command==='bundle'){
  // The single-result delivery cannot carry a full-table capture (the connector returns about 6,000 tokens by default): no text is offered to an operator.
  try{process.stdout.write(bundleText({plan,databaseId:rest[1]})+'\n');}
  catch(error){console.error('BLOCKED: '+error.message+' (a tested lossless connector-to-local-file handoff and an owner decision on the delivery path are required; see docs/runbooks/film-person-m2b-dry-run-copy.md section 2a)');process.exit(3);}
 }else{console.error('usage: digest (bundle is blocked)');process.exit(2);}
}
