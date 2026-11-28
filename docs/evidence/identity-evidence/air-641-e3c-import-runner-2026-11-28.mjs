// AIR-641 E3c stage 3-4 runner: a thin driver of the reviewed ER operators (src/identity-evidence-import.js) over the D1 REST adapter of the existing production operators.
// Under the owner's L3 GO for exactly manifest SHA-256 2989f46c...de904. `check` writes nothing; `apply` loads, seals and imports that one manifest; `readback` only reads.
import fs from 'node:fs';
import {createD1Adapter,readTarget} from '/home/user/iptv-watchlist/scripts/d1-backfill.mjs';
import {createCacheBinding,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID} from '/home/user/iptv-watchlist/scripts/metadata-cache-production.mjs';
import * as ER from '/home/user/iptv-watchlist/src/identity-evidence-import.js';
const DIGEST='2989f46ce833a068f3f689a05d9e7f5808de3f9a78f3f809dfa2f893a36de904',RUN='e3c-dryrun-2026-11-28',OWNER='executor-air-641';
const mode=process.argv[2];
if(!['check','apply','readback'].includes(mode))throw new Error('usage: check|apply|readback');
const manifest=JSON.parse(fs.readFileSync('/home/user/iptv-watchlist/docs/evidence/identity-evidence/air-641-e3c-manifest-2026-11-28.json','utf8'));
const digest=await ER.manifestDigest(manifest);
if(digest!==DIGEST||manifest.runId!==RUN||manifest.family!=='c')throw new Error('manifest is not the approved one: '+digest);
const target=readTarget({...process.env,D1_BACKFILL_DATABASE_ID:PRODUCTION_DATABASE_ID});
if(target.accountId!==PRODUCTION_ACCOUNT_ID)throw new Error('account is not the production account');
const adapter=createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl:fetch});
const desc=await adapter.describe();
if(desc.name!=='iptv'||desc.uuid!==PRODUCTION_DATABASE_ID)throw new Error('target database is not iptv');
const env={DB:createCacheBinding(adapter)};
const out={mode,digest,database:desc.name,chunks:manifest.chunks.length,rows:manifest.chunks.reduce((n,c)=>n+c.rows.length,0)};
out.status=await ER.identityEvidenceImportStatus(env);
if(mode==='check'){out.run=await ER.readImportRun(env,RUN);console.log(JSON.stringify(out,null,1));process.exit(0);}
if(mode==='apply'){
 out.loaded=await ER.loadAndSealManifest(env,{manifest,approvedDigest:DIGEST});
 out.imported=await ER.importRun(env,{runId:RUN,approvedDigest:DIGEST,owner:OWNER});
}
out.run=await ER.readImportRun(env,RUN);
out.report=await ER.readImportReport(env,RUN);
console.log(JSON.stringify(out,null,1));
