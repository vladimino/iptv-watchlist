// AIR-374 M2b: prints the digests of the reader and the text that an authorized operator would hand to an `execute` call. OFFLINE: it reads no file except its own imports, touches no network, D1, R2 or Cloudflare, and is not a GO.
//
//   node scripts/epg-producer-m2b-reader-bundle.mjs digest                     the statements digest, the reader digest and the plan size, as JSON
//   node scripts/epg-producer-m2b-reader-bundle.mjs bundle --database <id>     the text of the `execute` body (stdout) and the digest of that text (stderr)
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {emitSql} from './epg-producer-m2b.mjs';
import {bundleDigest,bundleText,readerDigest} from './epg-producer-m2b-reader.mjs';

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const [command,...rest]=process.argv.slice(2);
 const plan=emitSql();
 if(command==='digest')console.log(JSON.stringify({statementsDigest:plan.statementsDigest,readerDigest:readerDigest(),statements:plan.statements.length,caps:plan.caps},null,1));
 else if(command==='bundle'&&rest[0]==='--database'&&rest[1]){
  const options={plan,databaseId:rest[1]};
  process.stdout.write(bundleText(options)+'\n');
  console.error('bundle digest '+bundleDigest(options));
 }else{console.error('usage: digest | bundle --database <id>');process.exit(2);}
}
