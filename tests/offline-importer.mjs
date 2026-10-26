import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {createEpgRepository} from '../src/epg-repository.js';
import {createPredictionRepository} from '../src/prediction-repository.js';
import {acceptanceClasses,classifyObject,identityResolver,importBatch,inventory,parityClaim,projectSource,readDiscovery,refusal,verifyParity} from '../src/offline-importer.js';
import {manifestFor} from '../scripts/migration-export.mjs';
import {loadDomainRules,openSqlite as snapshotSqlite} from '../scripts/offline-import.mjs';

const source=fs.readFileSync('src/offline-importer.js','utf8');
assert.doesNotMatch(source,/d1_databases|\bBUCKET\b|\bfetch\b|\bwrangler\b|INSERT INTO film\s|INSERT INTO prediction_current|INSERT INTO fingerprint_payload/);
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/offline-importer/);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/offline-importer/);

const rules=loadDomainRules();
const identityFor=films=>identityResolver({canonicalize:rules.canonicalFilmId,films});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-offline-import-'));
const database=path.join(root,'import.sqlite');
exec(database,fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const db=openSqlite(database);
const repositories={canonical:createCanonicalRepository(db),epg:createEpgRepository(db),prediction:createPredictionRepository(db)};
const at='2026-10-19T01:00:00.000Z';
const later='2026-10-21T01:00:00.000Z';
const partial=inventory({finishedAt:at,aggregateSha256:'sha-partial',keys:['watchlist.json','programme.json']});
assert.equal(partial.production,false);
assert.equal(partial.scope,'historical-snapshot');
assert.equal(partial.complete,false);
assert.equal(partial.families.discovery.status,'absent');
assert.equal(partial.families.prediction.status,'absent');
assert.equal(partial.absent.includes('discovery'),true);

const owner=film('film:zz-film','Original Title',at,dim('localization','reviewed',at,{value:'Owner Title',source:'owner',provenance:{authority:'owner'}}));
const weaker={...owner,localization:dim('localization','provisional',later,{value:'Other Title',source:'dictionary'})};
const units=[
 {family:'watchlist',kind:'person',sourceKey:'people.json',sourceSha256:'sha-people',targetTable:'person',targetId:'person:actor/zz-role',unportable:false,input:{person:person('person:actor/zz-role','actor/zz-role',at)}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-watchlist',targetTable:'film',targetId:'film:zz-film',unportable:false,input:{film:owner,watchlist:true}},
 {family:'watchlist',kind:'film',sourceKey:'titles.json',sourceSha256:'sha-weaker',targetTable:'film',targetId:'film:zz-film',unportable:false,input:{film:weaker,watchlist:true}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-broken',targetTable:'film',targetId:'film:zz-broken',unportable:false,input:{film:film('film:zz-broken','Broken Title',at),credits:[{personId:'person:missing',role:'actor',ordinal:0}]}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-other',targetTable:'film',targetId:'film:zz-other',unportable:false,input:{film:{...film('film:zz-other','Other Title',at),externalIds:[{scheme:'tmdb',value:'1656',trusted:true,conflicting:false}],canonicalIdentity:'tmdb:1656'}}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-clash',targetTable:'film',targetId:'film:zz-clash',unportable:false,input:{film:{...film('film:zz-clash','Clash Title',at),externalIds:[{scheme:'tmdb',value:'1656',trusted:true,conflicting:false}],canonicalIdentity:'tmdb:1656'}}},
 {family:'programme',kind:'generation',sourceKey:'programme.json',sourceSha256:'sha-programme',targetTable:'programme_generation',targetId:'run-a',unportable:false,input:{programmeRunId:'run-a',phase:'published',expectedProgrammeRunId:null,publishedAt:at,films:[{filmId:'film:zz-film',shows:[{channelId:'channel-a',channel:'Channel A',startMs:1000,endMs:2000,epgTitle:'Visible Title',basis:'title_duration',matchReason:'duration_conflict'}]}],candidates:[]}},
 {family:'programme',kind:'generation',sourceKey:'programme.json',sourceSha256:'sha-stale',targetTable:'programme_generation',targetId:'run-old',unportable:false,input:{programmeRunId:'run-old',phase:'published',expectedProgrammeRunId:'run-missing',publishedAt:'2026-10-18T01:00:00.000Z',films:[{filmId:'film:zz-film',shows:[]}],candidates:[]}},
 {family:'profile',kind:'profile',sourceKey:'enrichment/profile/versions/1.json',sourceSha256:'sha-profile',targetTable:'profile_version',targetId:'1',unportable:false,input:{version:1,profileHash:'profile-1',createdAt:at,r2Key:'enrichment/profile/versions/1.json',contentSha256:'sha-profile'}},
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-null',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'new-hash',generatedAt:null,invalidatedAt:null,r2Key:'enrichment/films/zz-null/fingerprint.json',contentSha256:'sha-null'}},
];
const stopped=await importBatch(db,repositories,{inventory:partial,importedAt:at,units,limit:1});
assert.equal(stopped.applied,1);
assert.equal(stopped.pending,units.length-1);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM import_receipt'),1);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film'),0);
const finished=await importBatch(db,repositories,{inventory:partial,importedAt:at,units});
assert.equal(finished.claimsFullParity,false);
assert.equal(finished.resumed,1);
assert.equal(finished.ledger.some(item=>item.reason==='reviewed_kept'),true);
assert.equal(finished.ledger.some(item=>item.reason==='reference_missing'),true);
assert.equal(finished.ledger.some(item=>item.reason==='identity_collision'),true);
assert.equal((await repositories.canonical.readFilm('film:zz-film')).dimensions.localization.value,'Owner Title');
assert.equal(await repositories.canonical.readFilm('film:zz-broken'),null);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM programme_generation WHERE programme_run_id='run-old'"),0);
assert.equal((await repositories.epg.readPublished()).programmeRunId,'run-a');
const again=await importBatch(db,repositories,{inventory:partial,importedAt:at,units});
assert.equal(again.applied,0);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM film'),2);
assert.equal(await count(db,'SELECT COUNT(*) AS n FROM import_receipt'),finished.applied+stopped.applied);

const nullFilm=film('film:zz-null','Null Title',at);
await repositories.canonical.saveFilm({film:nullFilm});
const dated=await importBatch(db,repositories,{inventory:partial,importedAt:at,units:[
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-null',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'new-hash',generatedAt:null,invalidatedAt:null,r2Key:'enrichment/films/zz-null/fingerprint.json',contentSha256:'sha-null'}},
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-stale-null',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'stale-hash',generatedAt:null,invalidatedAt:null,r2Key:'enrichment/films/zz-null/stale.json',contentSha256:'sha-stale-null'}},
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-dated',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'dated-hash',generatedAt:later,invalidatedAt:null,r2Key:'enrichment/films/zz-null/dated.json',contentSha256:'sha-dated'}},
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-null/fingerprint.json',sourceSha256:'sha-stale-null',targetTable:'fingerprint_payload',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',schemaVersion:1,fingerprintHash:'stale-hash',generatedAt:null,invalidatedAt:null,r2Key:'enrichment/films/zz-null/stale.json',contentSha256:'sha-stale-null'}},
 {family:'prediction',kind:'prediction',sourceKey:'enrichment/films/zz-null/predictions.json',sourceSha256:'sha-prediction-new',targetTable:'prediction_current',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',tasteProfileVersion:1,tasteProfileHash:'profile-1',fingerprintHash:'dated-hash',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4.5,r2Key:'r2/prediction/new',contentSha256:'sha-prediction-new',updatedAt:later}},
 {family:'prediction',kind:'prediction',sourceKey:'enrichment/films/zz-null/predictions.json',sourceSha256:'sha-prediction-old',targetTable:'prediction_current',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',tasteProfileVersion:1,tasteProfileHash:'profile-1',fingerprintHash:'dated-hash',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:3.5,r2Key:'r2/prediction/old',contentSha256:'sha-prediction-old',updatedAt:at}},
 {family:'actual',kind:'rating',sourceKey:'enrichment/films/zz-null/actual.json',sourceSha256:'sha-rate-new',targetTable:'actual_rating',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',rating:4.5,source:'letterboxd',recordedAt:later}},
 {family:'actual',kind:'rating',sourceKey:'enrichment/films/zz-null/actual.json',sourceSha256:'sha-rate-old',targetTable:'actual_rating',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',rating:3.5,source:'letterboxd',recordedAt:at}},
]});
assert.equal(dated.ledger.some(item=>item.reason==='Fingerprint conflicts'),true);
assert.equal(dated.ledger.some(item=>item.reason==='fingerprint_kept'),true);
assert.equal(dated.ledger.some(item=>item.reason==='prediction_kept'),true);
assert.equal(dated.ledger.some(item=>item.reason==='rating_kept'),true);
const kept=await repositories.prediction.readFilm('film:zz-null');
assert.equal(kept.fingerprint.fingerprintHash,'dated-hash');
assert.equal(kept.prediction.predictedRating,4.5);
assert.equal(kept.prediction.updatedAt,later);
assert.equal(kept.history.length,0);
assert.equal(kept.actualRating.rating,4.5);
assert.equal(kept.actualRating.recordedAt,later);
const repeated=await importBatch(db,repositories,{inventory:partial,importedAt:at,units:[
 {family:'prediction',kind:'prediction',sourceKey:'enrichment/films/zz-null/predictions.json',sourceSha256:'sha-prediction-old',targetTable:'prediction_current',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',tasteProfileVersion:1,tasteProfileHash:'profile-1',fingerprintHash:'dated-hash',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:3.5,r2Key:'r2/prediction/old',contentSha256:'sha-prediction-old',updatedAt:at}},
 {family:'actual',kind:'rating',sourceKey:'enrichment/films/zz-null/actual.json',sourceSha256:'sha-rate-old',targetTable:'actual_rating',targetId:'film:zz-null',unportable:false,input:{filmId:'film:zz-null',rating:3.5,source:'letterboxd',recordedAt:at}},
]});
assert.equal(repeated.ledger.filter(item=>item.reason==='prediction_kept').length,1);
assert.equal((await repositories.prediction.readFilm('film:zz-null')).history.length,0);
assert.equal((await repositories.prediction.readFilm('film:zz-null')).actualRating.rating,4.5);
assert.equal(parityClaim({coverage:{unmapped:['epg/generations/run-old/programme.json'],excluded:['epg/raw/guide.xml'],mapped:['watchlist.json']},parity:{ok:true,denominator:1},counts:{},ledger:[],inventory:{complete:true}}),false);
assert.equal(parityClaim({coverage:{unmapped:[],excluded:['epg/raw/guide.xml'],mapped:['watchlist.json']},parity:{ok:false,denominator:1},counts:{},ledger:[],inventory:{complete:true}}),false);
assert.equal(parityClaim({coverage:{unmapped:[],excluded:[],mapped:['watchlist.json']},parity:{ok:true,denominator:1,unprojected:[],records:[]},counts:{},ledger:[],inventory:{complete:false}}),false);
assert.equal(parityClaim({coverage:{unmapped:[],excluded:[],mapped:['watchlist.json']},parity:{ok:true,denominator:0},counts:{},ledger:[],inventory:{complete:true}}),false);
assert.equal(parityClaim({coverage:{unmapped:[],excluded:[],mapped:['watchlist.json']},parity:{ok:true,denominator:1,unprojected:[],records:[{disposition:'mapped'}]},counts:{},ledger:[],inventory:{complete:true}}),true);
assert.equal(parityClaim({coverage:{unmapped:[],excluded:[],mapped:['watchlist.json']},parity:{ok:true,denominator:1,unprojected:[],records:[{disposition:'mapped'}]},counts:{},ledger:[],inventory:{complete:true},classes:{A:{blocking:true}}}),false);
assert.equal(parityClaim({coverage:{unmapped:[],excluded:[],mapped:['watchlist.json']},parity:{ok:true,denominator:1,unprojected:[],records:[{disposition:'unresolved'}]},counts:{},ledger:[],inventory:{complete:true}}),false);
assert.equal(parityClaim({coverage:{unmapped:[],excluded:[],mapped:['watchlist.json']},parity:{ok:true,denominator:1,unprojected:[],records:[{disposition:'mapped'}]},counts:{},ledger:[],inventory:{complete:true},receipts:{stale:[],foreign:[],superseded:[{sourceKey:'x'}]}}),true);
assert.equal(parityClaim({coverage:{unmapped:[],excluded:[],mapped:['watchlist.json']},parity:{ok:true,denominator:1,unprojected:[],records:[{disposition:'mapped'}]},counts:{},ledger:[],inventory:{complete:true},receipts:{stale:[{sourceKey:'x'}],foreign:[]}}),false);
assert.equal(parityClaim({coverage:{unmapped:[],excluded:[],mapped:['watchlist.json']},parity:{ok:true,denominator:1,unprojected:[],records:[{disposition:'mapped'}]},counts:{},ledger:[],inventory:{complete:true},receipts:{stale:[],foreign:[{sourceKey:'y'}]}}),false);

const receiptFilm=film('film:zz-receipt','Receipt Title',at);
db.beforeReceipt=async()=>{throw new Error('receipt_failed');};
const crashed=await importBatch(db,repositories,{importedAt:at,units:[{family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-receipt',targetTable:'film',targetId:'film:zz-receipt',unportable:false,input:{film:receiptFilm,watchlist:false}}]});
assert.equal(crashed.uncheckpointed,1);
assert.equal(crashed.applied,0);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_id='film:zz-receipt'"),0);
assert.equal((await repositories.canonical.readFilm('film:zz-receipt')).originalTitle,'Receipt Title');
const reconciled=await importBatch(db,repositories,{importedAt:at,units:[{family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-receipt',targetTable:'film',targetId:'film:zz-receipt',unportable:false,input:{film:receiptFilm,watchlist:false}}]});
assert.equal(reconciled.reconciled,1);
assert.equal(reconciled.applied,0);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film WHERE id='film:zz-receipt'"),1);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_id='film:zz-receipt'"),1);
const provisionalName=person('person:actor/zz-rename','actor/zz-rename',at,dim('localization','provisional',at,{value:'Name A',source:'dictionary'}));
await repositories.canonical.savePerson({person:provisionalName});
const reviewedName=person('person:actor/zz-rename','actor/zz-rename',later,dim('localization','reviewed',later,{value:'Name B',source:'owner',provenance:{authority:'owner'}}));
const renamed=await importBatch(db,repositories,{importedAt:later,units:[{family:'watchlist',kind:'person',sourceKey:'people.json',sourceSha256:'sha-rename-b',targetTable:'person',targetId:provisionalName.id,unportable:false,input:{person:reviewedName}}]});
assert.equal(renamed.applied,1);
assert.equal(renamed.reconciled,0);
assert.equal((await repositories.canonical.readPerson(provisionalName.id)).dimensions.localization.value,'Name B');
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM import_receipt WHERE source_sha256='sha-rename-b'"),1);
const corruptTitle=film('film:zz-corrupt','Kept Title',at);
db.beforeReceipt=async()=>{throw new Error('receipt_failed');};
const corruptCrash=await importBatch(db,repositories,{importedAt:at,units:[{family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-corrupt',targetTable:'film',targetId:'film:zz-corrupt',unportable:false,input:{film:corruptTitle,watchlist:false}}]});
assert.equal(corruptCrash.uncheckpointed,1);
await db.run("UPDATE film SET original_title='CORRUPTED' WHERE id='film:zz-corrupt'");
db.beforeReceipt=null;
const repaired=await importBatch(db,repositories,{importedAt:at,units:[{family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-corrupt',targetTable:'film',targetId:'film:zz-corrupt',unportable:false,input:{film:corruptTitle,watchlist:false}}]});
assert.equal(repaired.reconciled,0);
assert.equal(repaired.applied,1);
assert.equal((await repositories.canonical.readFilm('film:zz-corrupt')).originalTitle,'Kept Title');
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_id='film:zz-corrupt'"),1);

const castCredits=[{personId:'person:director/zz-role',role:'director',ordinal:0},{personId:'person:actor/zz-a',role:'actor',ordinal:0},{personId:'person:actor/zz-b',role:'actor',ordinal:1}];
const castUnits=[
 {family:'watchlist',kind:'person',sourceKey:'programme.json',sourceSha256:'sha-cast-people',targetTable:'person',targetId:'person:director/zz-role',unportable:false,input:{person:person('person:director/zz-role','director/zz-role',at)}},
 {family:'watchlist',kind:'person',sourceKey:'programme.json',sourceSha256:'sha-cast-people',targetTable:'person',targetId:'person:actor/zz-a',unportable:false,input:{person:person('person:actor/zz-a','actor/zz-a',at)}},
 {family:'watchlist',kind:'person',sourceKey:'programme.json',sourceSha256:'sha-cast-people',targetTable:'person',targetId:'person:actor/zz-b',unportable:false,input:{person:person('person:actor/zz-b','actor/zz-b',at)}},
];
const castFilm={family:'watchlist',kind:'film',sourceKey:'programme.json',sourceSha256:'sha-cast',targetTable:'film',targetId:'film:zz-cast',unportable:false,desiredCredits:castCredits,unmatchedCredits:0,input:{film:film('film:zz-cast','Cast Title',at),watchlist:false}};
const gapFilm={family:'watchlist',kind:'film',sourceKey:'programme.json',sourceSha256:'sha-gap',targetTable:'film',targetId:'film:zz-gap',unportable:false,desiredCredits:[{personId:'person:actor/zz-gap',role:'actor',ordinal:0}],unmatchedCredits:1,input:{film:film('film:zz-gap','Gap Title',at),watchlist:false}};
await importBatch(db,repositories,{importedAt:at,units:[...castUnits,castFilm,gapFilm]});
const storedCast=await db.all("SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id='film:zz-cast' ORDER BY role,ordinal");
assert.equal(JSON.stringify(storedCast),JSON.stringify([{person_id:'person:actor/zz-a',role:'actor',ordinal:0},{person_id:'person:actor/zz-b',role:'actor',ordinal:1},{person_id:'person:director/zz-role',role:'director',ordinal:0}]));
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_id='film:zz-cast'"),1);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_id='film:zz-gap'"),0);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film_person_credit WHERE film_id='film:zz-gap'"),0);
await importBatch(db,repositories,{importedAt:at,units:[...castUnits,{family:'watchlist',kind:'person',sourceKey:'programme.json',sourceSha256:'sha-cast-people',targetTable:'person',targetId:'person:actor/zz-gap',unportable:false,input:{person:person('person:actor/zz-gap','actor/zz-gap',at)}},{...gapFilm,unmatchedCredits:0}]});
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM film_person_credit WHERE film_id='film:zz-gap'"),1);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_id='film:zz-gap'"),1);
await db.run("DELETE FROM film_person_credit WHERE film_id='film:zz-cast' AND person_id='person:actor/zz-b'");
const dropped=await verifyParity(db,{films:[{id:'film:zz-cast',localization:null,credits:castCredits}]});
assert.equal(dropped.ok,false);
assert.equal(dropped.mismatched.some(item=>item.id==='film:zz-cast'&&item.field==='credits'),true);

await repositories.epg.publishGeneration({programmeRunId:'run-b',phase:'published',expectedProgrammeRunId:'run-a',publishedAt:later,films:[{filmId:'film:zz-film',shows:[]}],candidates:[{observationKey:'heat|1995',title:'Title ZZ',normalizedTitle:'heat',year:1995,rawTitles:['Title ZZ'],durations:[170],evidenceKey:'evidence-a',activity:'current',seenInLatest:true,shows:[]}]});
await repositories.epg.recordDecision({observationKey:'heat|1995',programmeRunId:'run-b',status:'ambiguous',reason:'ambiguous',checkedAt:later,evidenceKey:'evidence-a',attempts:5,lastAttemptAt:later,retryAt:'2026-10-28T00:00:00.000Z',terminalReason:'repeated_uncertain_match'});
const rejectedDecision=await importBatch(db,repositories,{importedAt:at,units:[{family:'discovery',kind:'decision',sourceKey:'epg/discovery-resolution.json',sourceSha256:'sha-decision',targetTable:'candidate_decision',targetId:'heat|1995',unportable:false,input:{observationKey:'heat|1995',programmeRunId:'run-b',status:'verified',reason:'verified',checkedAt:'2026-10-22T01:00:00.000Z',evidenceKey:'evidence-a',filmId:'film:zz-film',tmdbId:'1656'}}]});
assert.equal(rejectedDecision.explained,1);
assert.equal(rejectedDecision.ledger[0].reason,'terminal_evidence_unchanged');
assert.equal(rejectedDecision.applied,0);
assert.equal(await count(db,"SELECT COUNT(*) AS n FROM import_receipt WHERE target_id='heat|1995'"),0);
assert.equal((await repositories.epg.readDecision('heat|1995')).current.status,'ambiguous');

const partFile=path.join(root,'partial.sqlite');
exec(partFile,fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const partDb=openSqlite(partFile);
const partRepos={canonical:createCanonicalRepository(partDb),epg:createEpgRepository(partDb),prediction:createPredictionRepository(partDb)};
const partPerson=person('person:actor/zz-part','actor/zz-part',at);
const partFilm=film('film:zz-part','Partial Title',at);
const partRun=await importBatch(partDb,partRepos,{inventory:partial,importedAt:at,units:[
 {family:'watchlist',kind:'person',sourceKey:'people.json',sourceSha256:'sha-part-person',targetTable:'person',targetId:partPerson.id,unportable:false,input:{person:partPerson}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-part-film',targetTable:'film',targetId:partFilm.id,unportable:false,input:{film:partFilm,watchlist:true}},
],expected:{films:[{id:partFilm.id,originalTitle:'Partial Title',canonicalIdentity:null,contractVersion:1,watchlist:true,localization:null,localizationStatus:'missing',credits:[],externalIds:partFilm.externalIds,aliases:[]}],persons:[{id:partPerson.id,roleId:partPerson.roleId,contractVersion:1,localization:null,localizationStatus:'missing',externalIds:partPerson.externalIds,aliases:[]}]}});
assert.equal(partRun.parity.ok,true);
assert.equal(partRun.applied,2);
assert.equal(partRun.claimsFullParity,false);

const sourceKeys=['watchlist.json','programme.json','people.json','epg/discovery-latest.json','epg/generations/run-old/programme.json','enrichment/films/zz-omit/fingerprint.json','enrichment/films/zz-omit/predictions.json','enrichment/films/zz-omit/actual.json','enrichment/profile/versions/1.json'];
const omitFilm=film('film:zz-omit','Omit Title',at);
const omitPerson=person('person:actor/zz-omit','actor/zz-omit',at);
const projected=projectSource({keys:sourceKeys,bodies:{
 'watchlist.json':{films:[{id:'zz-omit'}]},
 'programme.json':{runId:'run-p',films:[{id:'zz-omit',shows:[{channelId:'channel-a',start:1000,title:'Show Title'}]}]},
 'people.json':[{id:'actor/zz-omit'}],
 'epg/discovery-latest.json':{items:[{observationKey:'heat|1995',title:'Title ZZ',normalizedTitle:'heat',year:1995,durations:[170]}]},
 'epg/generations/run-old/programme.json':{films:[]},
 'enrichment/films/zz-omit/fingerprint.json':{fingerprintSchemaVersion:1,fingerprintHash:'print-a',generatedAt:at},
 'enrichment/films/zz-omit/predictions.json':{current:{tasteProfileVersion:1},history:[]},
 'enrichment/films/zz-omit/actual.json':{rating:4,source:'letterboxd',updatedAt:at},
 'enrichment/profile/versions/1.json':{version:1,profileHash:'profile-a',createdAt:at},
},films:[omitFilm],people:[omitPerson],listed:{'film:zz-omit':true},shas:{'enrichment/films/zz-omit/fingerprint.json':'sha-print'},identity:identityFor([omitFilm]),deriveEvidence:rules.candidateEvidence});
assert.equal(projected.candidates.length,1);
assert.equal(projected.candidates[0].evidenceKey,rules.candidateEvidence({normalizedTitle:'heat',year:1995,durations:[170]}));
assert.equal(projected.generations.length,1);
assert.equal(projected.generations[0].shows[0].epgTitle,'Show Title');
assert.equal(projected.unprojected.includes('epg/generations/run-old/programme.json'),false);
assert.equal(projected.r2Only.includes('epg/generations/run-old/programme.json'),true);
assert.equal(classifyObject('epg/generations/run-old/programme.json'),'r2_only');
assert.equal(classifyObject('started/zz.json'),'r2_only');
assert.equal(classifyObject('sync.json'),'r2_only');
assert.equal(classifyObject('mystery/zz.json'),'unmapped');
assert.equal(classifyObject('epg/raw/guide.xml'),'excluded');
assert.equal(classifyObject('archive/export.zip'),'unmapped');
assert.equal(classifyObject('guide.xml'),'unmapped');
assert.equal(classifyObject('epg/guide.xml.gz'),'unmapped');
assert.equal(projected.records.some(record=>record.key==='enrichment/films/zz-omit/predictions.json'&&record.disposition==='unportable'),true);
const omitFile=path.join(root,'omit.sqlite');
exec(omitFile,fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const omitDb=openSqlite(omitFile);
const omitRepos={canonical:createCanonicalRepository(omitDb),epg:createEpgRepository(omitDb),prediction:createPredictionRepository(omitDb)};
const omitted=await importBatch(omitDb,omitRepos,{inventory:inventory({finishedAt:at,aggregateSha256:'sha-omit',keys:sourceKeys}),importedAt:at,units:[
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-omit-film',targetTable:'film',targetId:omitFilm.id,unportable:false,input:{film:omitFilm,watchlist:true}},
],expected:projected});
assert.equal(omitted.parity.missing.some(item=>item.table==='person'&&item.id==='person:actor/zz-omit'),true);
assert.equal(omitted.parity.missing.some(item=>item.table==='programme_generation'&&item.id==='run-p'),true);
assert.equal(omitted.claimsFullParity,false);

const fullFile=path.join(root,'full.sqlite');
exec(fullFile,fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const fullDb=openSqlite(fullFile);
const fullRepos={canonical:createCanonicalRepository(fullDb),epg:createEpgRepository(fullDb),prediction:createPredictionRepository(fullDb)};
const fullPerson=person('person:actor/zz-full','actor/zz-full',at);
const fullFilm=film('film:zz-full','Full Title',at);
const fullMetadata={schemaVersion:1,year:null,runtime:null,synopsis:'Text',poster:null,url:null,genres:[],peopleVersion:1,payload:{},r2Key:'metadata.json',contentSha256:'sha-meta',updatedAt:at};
await importBatch(fullDb,fullRepos,{importedAt:at,units:[
 {family:'watchlist',kind:'person',sourceKey:'people.json',sourceSha256:'sha-full-person',targetTable:'person',targetId:fullPerson.id,unportable:false,input:{person:fullPerson}},
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-full-film',targetTable:'film',targetId:fullFilm.id,unportable:false,input:{film:fullFilm,watchlist:false,metadata:fullMetadata}},
 {family:'fingerprint',kind:'fingerprint',sourceKey:'enrichment/films/zz-full/fingerprint.json',sourceSha256:'sha-full-print',targetTable:'fingerprint_payload',targetId:fullFilm.id,unportable:false,input:{filmId:fullFilm.id,schemaVersion:1,fingerprintHash:'print-full',generatedAt:at,invalidatedAt:null,r2Key:'enrichment/films/zz-full/fingerprint.json',contentSha256:'sha-full-print'}},
 {family:'actual',kind:'rating',sourceKey:'enrichment/films/zz-full/actual.json',sourceSha256:'sha-full-rate',targetTable:'actual_rating',targetId:fullFilm.id,unportable:false,input:{filmId:fullFilm.id,rating:4,source:'letterboxd',recordedAt:at}},
 {family:'programme',kind:'generation',sourceKey:'programme.json',sourceSha256:'sha-full-run',targetTable:'programme_generation',targetId:'run-full',unportable:false,input:{programmeRunId:'run-full',phase:'published',expectedProgrammeRunId:null,publishedAt:at,films:[{filmId:fullFilm.id,shows:[{channelId:'channel-a',channel:'Channel A',startMs:1000,endMs:2000,epgTitle:'Visible Title',basis:null,matchReason:null}]}],candidates:[{observationKey:'heat|1995',title:'Title ZZ',normalizedTitle:'heat',year:1995,rawTitles:['Title ZZ'],durations:[],evidenceKey:'evidence-full',activity:'current',seenInLatest:true,shows:[]}]}},
]});
const fullSpec={films:[{id:fullFilm.id,originalTitle:'Full Title',localization:null,credits:[],metadata:{synopsis:'Text',year:null,runtime:null,peopleVersion:1}}],persons:[{id:fullPerson.id,roleId:fullPerson.roleId,localization:null}],fingerprints:[{id:fullFilm.id,fingerprintHash:'print-full',generatedAt:at,invalidatedAt:null,r2Key:'enrichment/films/zz-full/fingerprint.json'}],ratings:[{id:fullFilm.id,rating:4,source:'letterboxd',recordedAt:at}],generations:[{id:'run-full',phase:'published',shows:[{filmId:fullFilm.id,channelId:'channel-a',startMs:1000,epgTitle:'Visible Title'}]}],candidates:[{id:'heat|1995',programmeRunId:'run-full',evidenceKey:'evidence-full',title:'Title ZZ',normalizedTitle:'heat'}],predictions:[],profiles:[],redirects:[]};
const clean=await verifyParity(fullDb,fullSpec);
assert.equal(clean.ok,true,JSON.stringify({missing:clean.missing,extra:clean.extra,mismatched:clean.mismatched}));
await fullDb.run("UPDATE film SET original_title='CORRUPTED' WHERE id='film:zz-full'");
assert.equal((await verifyParity(fullDb,fullSpec)).mismatched.some(item=>item.id==='film:zz-full'&&item.field==='original_title'),true);
await fullDb.run("UPDATE film SET original_title='Full Title' WHERE id='film:zz-full'");
await fullDb.run("UPDATE actual_rating SET rating=1.0 WHERE film_id='film:zz-full'");
assert.equal((await verifyParity(fullDb,fullSpec)).mismatched.some(item=>item.field==='rating'),true);
await fullDb.run("UPDATE actual_rating SET rating=4 WHERE film_id='film:zz-full'");
await fullDb.run("UPDATE fingerprint_payload SET fingerprint_hash='changed' WHERE film_id='film:zz-full'");
assert.equal((await verifyParity(fullDb,fullSpec)).mismatched.some(item=>item.field==='fingerprint'),true);
await fullDb.run("UPDATE fingerprint_payload SET fingerprint_hash='print-full' WHERE film_id='film:zz-full'");
await fullDb.run("DELETE FROM film_person_credit WHERE film_id='film:zz-full'");
await fullDb.run("DELETE FROM person_external_id WHERE person_id='person:actor/zz-full'");
await fullDb.run("DELETE FROM person_alias WHERE person_id='person:actor/zz-full'");
await fullDb.run("DELETE FROM person_dimension WHERE person_id='person:actor/zz-full'");
await fullDb.run("DELETE FROM person WHERE id='person:actor/zz-full'");
assert.equal((await verifyParity(fullDb,fullSpec)).missing.some(item=>item.table==='person'),true);
await fullRepos.canonical.savePerson({person:fullPerson});
await fullDb.run("DELETE FROM film_show WHERE programme_run_id='run-full'");
assert.equal((await verifyParity(fullDb,fullSpec)).mismatched.some(item=>item.field==='shows'),true);
await fullDb.run("INSERT INTO film_show (programme_run_id,film_id,channel_id,channel,start_ms,end_ms,epg_title,basis,match_reason) VALUES ('run-full','film:zz-full','channel-a','Channel A',1000,2000,'Visible Title',NULL,NULL)");
await fullDb.run("UPDATE film_metadata SET synopsis='Other' WHERE film_id='film:zz-full'");
assert.equal((await verifyParity(fullDb,fullSpec)).mismatched.some(item=>item.field==='metadata'),true);
await fullDb.run("UPDATE film_metadata SET synopsis='Text' WHERE film_id='film:zz-full'");
await fullDb.run("INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:zz-extra',1,NULL,'Extra',?) ",[at]);
assert.equal((await verifyParity(fullDb,fullSpec)).extra.some(item=>item.table==='film'&&item.id==='film:zz-extra'),true);

const predictionBody={tasteProfileVersion:1,tasteProfileHash:'profile-a',fingerprintHash:'print-hash',fingerprintSchemaVersion:1,predictionPromptVersion:1};
const hashed=projectSource({keys:['programme.json','enrichment/films/zz-hash/predictions.json','enrichment/profile/versions/1.json'],bodies:{
 'programme.json':{runId:'run-empty',films:[{id:'zz-hash',shows:[]}]},
 'enrichment/films/zz-hash/predictions.json':{current:{...predictionBody,predictedRating:4,r2Key:'r2/prediction/new',contentSha256:'sha-new',updatedAt:later},history:[{...predictionBody,predictedRating:3,r2Key:'r2/prediction/old',contentSha256:'sha-old',updatedAt:at}]},
 'enrichment/profile/versions/1.json':{version:1,profileHash:'profile-a',createdAt:at},
},films:[film('film:zz-hash','Hash Title',at)],people:[],shas:{'enrichment/profile/versions/1.json':'sha-profile'},identity:identityFor([film('film:zz-hash','Hash Title',at)]),deriveEvidence:rules.candidateEvidence});
assert.equal(hashed.generations[0].films[0].filmId,'film:zz-hash');
assert.equal(hashed.generations[0].films[0].shows.length,0);
assert.equal(hashed.publishedPointer,'run-empty');
assert.equal(hashed.predictions[0].contentSha256,'sha-new');
assert.equal(hashed.predictions[0].history[0].contentSha256,'sha-old');
assert.equal(hashed.profiles[0].contentSha256,'sha-profile');
const brokenHistory=projectSource({keys:['enrichment/films/zz-hash/predictions.json'],bodies:{'enrichment/films/zz-hash/predictions.json':{current:{...predictionBody,predictedRating:4,r2Key:'r2/prediction/new',contentSha256:'sha-new',updatedAt:later},history:[{note:'no-version'}]}},films:[film('film:zz-hash','Hash Title',at)],people:[],identity:identityFor([film('film:zz-hash','Hash Title',at)]),deriveEvidence:rules.candidateEvidence});
assert.equal(brokenHistory.predictions.length,0);
assert.equal(brokenHistory.records.some(record=>record.disposition==='unportable'),true);

const emptyFile=path.join(root,'empty-show.sqlite');
exec(emptyFile,fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const emptyDb=openSqlite(emptyFile);
const emptyRepos={canonical:createCanonicalRepository(emptyDb),epg:createEpgRepository(emptyDb),prediction:createPredictionRepository(emptyDb)};
const emptyFilm=film('film:zz-empty','Empty Title',at);
await importBatch(emptyDb,emptyRepos,{importedAt:at,units:[
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-empty-film',targetTable:'film',targetId:emptyFilm.id,unportable:false,input:{film:emptyFilm,watchlist:false}},
 {family:'programme',kind:'generation',sourceKey:'programme.json',sourceSha256:'sha-empty-run',targetTable:'programme_generation',targetId:'run-empty',unportable:false,input:{programmeRunId:'run-empty',phase:'published',expectedProgrammeRunId:null,publishedAt:at,films:[{filmId:emptyFilm.id,shows:[]}],candidates:[]}},
]});
const emptySpec={generations:[{id:'run-empty',phase:'published',films:[{filmId:emptyFilm.id,shows:[]}],shows:[]}],publishedPointer:'run-empty'};
assert.equal((await verifyParity(emptyDb,emptySpec)).ok,true);
await emptyDb.run("DELETE FROM film_generation WHERE programme_run_id='run-empty' AND film_id='film:zz-empty'");
assert.equal((await verifyParity(emptyDb,emptySpec)).mismatched.some(item=>item.table==='film_generation'&&item.field==='membership'),true);
await emptyDb.run("INSERT INTO film_generation (programme_run_id,film_id) VALUES ('run-empty','film:zz-empty')");
await emptyDb.run("INSERT INTO programme_generation (programme_run_id,phase,published_at) VALUES ('run-other','withheld',NULL)");
await emptyDb.run("UPDATE published_generation SET programme_run_id='run-other' WHERE id=1");
assert.equal((await verifyParity(emptyDb,emptySpec)).mismatched.some(item=>item.table==='published_generation'&&item.field==='pointer'),true);

const hashFile=path.join(root,'hash.sqlite');
exec(hashFile,fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const hashDb=openSqlite(hashFile);
const hashRepos={canonical:createCanonicalRepository(hashDb),epg:createEpgRepository(hashDb),prediction:createPredictionRepository(hashDb)};
const hashFilm=film('film:zz-hash','Hash Title',at);
const hashRun=await importBatch(hashDb,hashRepos,{importedAt:at,units:[
 {family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-hash-film',targetTable:'film',targetId:hashFilm.id,unportable:false,input:{film:hashFilm,watchlist:false}},
 {family:'profile',kind:'profile',sourceKey:'enrichment/profile/versions/1.json',sourceSha256:'sha-profile',targetTable:'profile_version',targetId:'1',unportable:false,input:{version:1,profileHash:'profile-a',createdAt:at,r2Key:'enrichment/profile/versions/1.json',contentSha256:'sha-profile'}},
 {family:'prediction',kind:'prediction',sourceKey:'enrichment/films/zz-hash/predictions.json',sourceSha256:'sha-prediction-bundle',targetTable:'prediction_current',targetId:hashFilm.id,unportable:false,input:{filmId:hashFilm.id,...predictionBody,predictedRating:3,r2Key:'r2/prediction/old',contentSha256:'sha-old',updatedAt:at}},
 {family:'prediction',kind:'prediction',sourceKey:'enrichment/films/zz-hash/predictions.json',sourceSha256:'sha-prediction-bundle',targetTable:'prediction_current',targetId:hashFilm.id+'#1',unportable:false,input:{filmId:hashFilm.id,...predictionBody,predictedRating:4,r2Key:'r2/prediction/new',contentSha256:'sha-new',updatedAt:later}},
]});
assert.equal(hashRun.applied,4,JSON.stringify(hashRun.ledger));
const hashSpec={predictions:[{id:hashFilm.id,predictedRating:4,updatedAt:later,r2Key:'r2/prediction/new',fingerprintHash:'print-hash',contentSha256:'sha-new',history:[{filmId:hashFilm.id,predictedRating:3,updatedAt:at,r2Key:'r2/prediction/old',contentSha256:'sha-old',fingerprintHash:'print-hash',tasteProfileVersion:1,tasteProfileHash:'profile-a',fingerprintSchemaVersion:1,predictionPromptVersion:1}]}],profiles:[{id:1,profileHash:'profile-a',createdAt:at,r2Key:'enrichment/profile/versions/1.json',contentSha256:'sha-profile'}]};
const hashClean=await verifyParity(hashDb,hashSpec);
assert.equal(hashClean.ok,true,JSON.stringify({missing:hashClean.missing,extra:hashClean.extra,mismatched:hashClean.mismatched}));
await hashDb.run("UPDATE prediction_current SET content_sha256='corrupt' WHERE film_id='film:zz-hash'");
assert.equal((await verifyParity(hashDb,hashSpec)).mismatched.some(item=>item.field==='prediction'),true);
await hashDb.run("UPDATE prediction_current SET content_sha256='sha-new' WHERE film_id='film:zz-hash'");
await hashDb.run("UPDATE prediction_history SET content_sha256='corrupt', payload_json='{}' WHERE film_id='film:zz-hash'");
assert.equal((await verifyParity(hashDb,hashSpec)).mismatched.some(item=>item.field==='history'),true);
await hashDb.run("UPDATE profile_version SET content_sha256='corrupt' WHERE version=1");
assert.equal((await verifyParity(hashDb,hashSpec)).mismatched.some(item=>item.field==='profile'),true);

const snapshot=path.join(root,'snapshot');
const canary='CANARY-TITLE';
const secret='history-secret';
const cast={directors:[{id:'director/zz-role',name:'Director',original:'Director'}],actors:[{id:'actor/zz-a',name:'Actor A',original:'Actor A'},{id:'actor/zz-b',name:'Actor B',original:'Actor B'}]};
writeSnapshot(snapshot,{
 'watchlist.json':{films:[{id:'zz-film',title:canary,original:'Original Title'}]},
 'programme.json':{films:[{id:'zz-film',title:canary,original:'Original Title',...cast}]},
 'metadata.json':{'zz-film':{id:'zz-film',original:'Original Title',metadataAt:at,peopleVersion:1,peopleNamesVersion:2,synopsis:'Text',synopsisFetchedAt:at,...cast}},
 'enrichment/profile/current.json':{version:1,profileHash:'profile-a',updatedAt:at},
 ['enrichment/films/zz-film/fingerprint.json']:{fingerprintSchemaVersion:1,fingerprintHash:'print-a',generatedAt:at,invalidatedAt:null},
 ['enrichment/films/zz-film/predictions.json']:{current:{tasteProfileVersion:1,tasteProfileHash:'profile-a',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4},history:[{note:secret}]},
 ['enrichment/films/zz-film/actual.json']:{rating:4,source:'letterboxd',updatedAt:at},
 'epg/raw/guide.xml':Buffer.from('<guide></guide>'),
 'epg/generations/run-old/programme.json':{films:[]},
 'started/zz-film.json':{started:true},
});
const first=runImport(snapshot,path.join(root,'cli.sqlite'));
assert.equal(first.production,false);
assert.equal(first.scope,'historical-snapshot');
assert.equal(first.finishedAt,'2026-10-19T01:00:00.000Z');
assert.equal(typeof first.aggregateSha256,'string');
assert.equal(first.claimsFullParity,false);
assert.equal(first.families.discovery.status,'absent');
assert.equal(first.families.profile.status,'present');
assert.equal(first.unportable>0,true);
assert.equal(first.coverage.excluded.includes('epg/raw/guide.xml'),true);
assert.equal(first.coverage.unmapped.length,0);
assert.equal(first.coverage.r2_only.includes('epg/generations/run-old/programme.json'),true);
assert.equal(first.coverage.r2_only.includes('started/zz-film.json'),true);
assert.equal(first.coverage.r2OnlyFamilies.find(item=>item.family==='archive').count,1);
assert.equal(first.classes.B.decisionRequired.includes('user_state'),true);
assert.equal(first.parity.unprojected.includes('epg/generations/run-old/programme.json'),false);
assert.equal(first.classes.A.mandatory.prediction.status,'present');
assert.equal(first.classes.A.mandatory.prediction.portable,false);
assert.equal(first.classes.A.blockers.includes('prediction_family_unportable'),true);
assert.equal(first.stopped,false);
assert.equal(first.receipts.total,first.applied);
assert.equal(first.receipts.stale.length,0);
assert.equal(first.claimsFullParity,false);
assert.equal(first.parity.ok,true);
assert.equal(first.ledger.some(item=>item.reason==='credits_not_carried'),false);
assert.equal(first.ledger.some(item=>item.reason==='credits_unmatched'),false);
assert.equal(first.ledger.some(item=>item.reason==='profile_version_object_missing'),true);
assert.equal(first.ledger.some(item=>item.reason==='mutable_bundle_is_not_a_version_object'||item.reason==='prediction_version_object_missing'||item.reason==='prediction_fields_missing'),true);
assert.equal(JSON.stringify(first).includes(canary),false);
assert.equal(JSON.stringify(first).includes(secret),false);
const second=runImport(snapshot,path.join(root,'cli.sqlite'));
assert.equal(second.applied,0);
assert.equal(second.resumed,first.applied);
assert.equal(second.claimsFullParity,false);
assert.equal(second.unportable,first.unportable);

const volumeCount=8000;
const volumePad='n'.repeat(160);
const volumeIds=[];
const volumeSql=['BEGIN'];
for(let index=0;index<volumeCount;index++){
 const slug='actor/zz-read-'+String(index).padStart(5,'0')+'-'+volumePad;
 volumeIds.push('person:'+slug);
 volumeSql.push("INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('"+volumeIds[index]+"','"+slug+"',1,'2026-10-19T01:00:00.000Z')");
}
volumeSql.push('COMMIT');
const volumeDatabase=path.join(root,'volume.sqlite');
exec(volumeDatabase,fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
exec(volumeDatabase,volumeSql.join(';\n'));
const volumeRows=await snapshotSqlite(volumeDatabase).all('SELECT id,role_id,contract_version FROM person ORDER BY id');
assert.equal(volumeRows.length,volumeCount);
assert.equal(Buffer.byteLength(JSON.stringify(volumeRows))>1024*1024,true);
const volumeHash=createHash('sha256');
for(const id of volumeIds)volumeHash.update(id);
const readHash=createHash('sha256');
for(const row of volumeRows)readHash.update(row.id);
assert.equal(readHash.digest('hex'),volumeHash.digest('hex'));


// Identity rule: one shared function, redirects followed, collisions and unknown ids left unresolved.
assert.equal(rules.canonicalFilmId('tmdb_7'),'film:tmdb:7');
assert.equal(rules.canonicalFilmId('heat-1995'),'film:heat-1995');
assert.equal(rules.canonicalFilmId('film:tmdb:7'),'film:tmdb:7');
assert.equal(rules.canonicalFilmId(''),null);
assert.equal(rules.canonicalFilmId(null),null);
const survivor={...film('film:heat-1995','Heat',at),externalIds:[{scheme:'letterboxd',value:'heat-1995',trusted:true,conflicting:false},{scheme:'tmdb',value:'7',trusted:true,conflicting:false}],redirects:[{from:'film:tmdb:7',to:'film:heat-1995',at}]};
const holderA={...film('film:slug-a','Slug A',at),externalIds:[{scheme:'letterboxd',value:'slug-a',trusted:true,conflicting:false},{scheme:'tmdb',value:'8',trusted:true,conflicting:false}]};
const holderB={...film('film:slug-b','Slug B',at),externalIds:[{scheme:'letterboxd',value:'slug-b',trusted:true,conflicting:false},{scheme:'tmdb',value:'8',trusted:true,conflicting:false}]};
const unlinked={...film('film:slug-c','Slug C',at),externalIds:[{scheme:'letterboxd',value:'slug-c',trusted:true,conflicting:false},{scheme:'tmdb',value:'11',trusted:true,conflicting:false}]};
const identity=identityFor([survivor,holderA,holderB,unlinked,film('film:tmdb:9','Ronin',at)]);
assert.deepEqual(identity.resolve('tmdb_9'),{source:'tmdb_9',canonical:'film:tmdb:9',filmId:'film:tmdb:9',via:'direct',reason:null});
assert.deepEqual(identity.resolve('tmdb_7'),{source:'tmdb_7',canonical:'film:tmdb:7',filmId:'film:heat-1995',via:'redirect',reason:null});
assert.equal(identity.resolve('heat-1995').filmId,'film:heat-1995');
assert.equal(identity.resolve('tmdb_8').reason,'identity_conflict');
assert.equal(identity.resolve('tmdb_8').filmId,null);
assert.equal(identity.resolve('tmdb_11').reason,'identity_unlinked');
assert.equal(identity.resolve('tmdb_404').reason,'film_unresolved');
// A stored canonical id is not a silent direct hit while another claimant exists: conflicts are detected before the fast path.
const directTmdb={...film('film:tmdb:21','Direct',at),externalIds:[{scheme:'tmdb',value:'21',trusted:true,conflicting:false}]};
const rivalTmdb={...film('film:slug-r','Rival',at),externalIds:[{scheme:'letterboxd',value:'slug-r',trusted:true,conflicting:false},{scheme:'tmdb',value:'21',trusted:true,conflicting:false}]};
assert.equal(identityFor([directTmdb]).resolve('tmdb_21').via,'direct');
assert.equal(identityFor([directTmdb,rivalTmdb]).resolve('tmdb_21').reason,'identity_conflict');
assert.equal(identityFor([directTmdb,rivalTmdb]).resolve('film:tmdb:21').reason,'identity_conflict');
assert.equal(identityFor([directTmdb,{...film('film:conflict:21+22','Conflict',at),externalIds:[]}]).resolve('tmdb_21').reason,'identity_conflict');
assert.equal(identityFor([directTmdb,{...film('film:slug-s','Survivor',at),redirects:[{from:'film:tmdb:21',to:'film:slug-s',at}]}]).resolve('tmdb_21').reason,'identity_conflict');
assert.equal(identityFor([survivor,{...film('film:slug-t','Third',at),externalIds:[{scheme:'letterboxd',value:'slug-t',trusted:true,conflicting:false},{scheme:'tmdb',value:'7',trusted:true,conflicting:false}]}]).resolve('tmdb_7').reason,'identity_conflict');
assert.equal(identityFor([directTmdb,{...film('film:slug-u','Marked',at),externalIds:[{scheme:'tmdb',value:'21',trusted:false,conflicting:true}]}]).resolve('tmdb_21').reason,'identity_conflict');
assert.equal(identity.resolve('').reason,'identity_unreadable');
assert.throws(()=>identityResolver({films:[]}),/canonicalFilmId/);
assert.throws(()=>projectSource({keys:[],films:[]}),/identity resolver/);
assert.throws(()=>readDiscovery({key:'epg/discovery-latest.json',sha256:'sha'},{items:[]}),/candidateEvidence/);
const mismatchRead=readDiscovery({key:'epg/discovery-latest.json',sha256:'sha-latest'},{items:[{key:'heat|1995',title:'Heat',normalizedTitle:'heat',year:1995,durations:[170],evidenceKey:'stale'}]},{deriveEvidence:rules.candidateEvidence});
assert.equal(mismatchRead.candidates.length,0);
assert.equal(mismatchRead.blockers[0].reason,'evidence_mismatch');
assert.equal(mismatchRead.blockers[0].derived,rules.candidateEvidence({normalizedTitle:'heat',year:1995,durations:[170]}));
const refused=refusal({inventory:inventory({finishedAt:at,aggregateSha256:'sha',keys:['watchlist.json','programme.json','mystery/zz.json']}),shas:{'mystery/zz.json':'sha-mystery'},units:[]});
assert.equal(refused.stopped,true);
assert.deepEqual(refused.stopReasons,['unknown_key']);
assert.equal(refused.blockers[0].sourceSha256,'sha-mystery');
assert.equal(refused.applied,0);
assert.equal(refused.claimsFullParity,false);
assert.equal(refusal({inventory:inventory({finishedAt:at,aggregateSha256:'sha',keys:['watchlist.json','started/zz.json']}),units:[]}),null);
const refusedDb=openSqlite(path.join(root,'refused.sqlite'));
exec(path.join(root,'refused.sqlite'),fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
const refusedRun=await importBatch(refusedDb,{canonical:createCanonicalRepository(refusedDb),epg:createEpgRepository(refusedDb),prediction:createPredictionRepository(refusedDb)},{importedAt:at,inventory:inventory({finishedAt:at,aggregateSha256:'sha',keys:['watchlist.json','mystery/zz.json']}),units:[{family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-refused',targetTable:'film',targetId:'film:zz-refused',unportable:false,input:{film:film('film:zz-refused','Refused',at),watchlist:true}}]});
assert.equal(refusedRun.stopped,true);
assert.equal(await count(refusedDb,'SELECT COUNT(*) AS n FROM film'),0);
assert.equal(await count(refusedDb,'SELECT COUNT(*) AS n FROM import_receipt'),0);

// End to end through the CLI: legacy ids, a redirect, a derived evidence key, an unresolved key, bounded batches, reruns, stale receipts.
const ronin={id:'tmdb_9',title:'Ronin',original:'Ronin',tmdbId:9,year:1998};
const heat={id:'heat-1995',title:'Heat',original:'Heat',tmdbId:7,year:1995};
const legacyBodies={
 'watchlist.json':{films:[heat]},
 'programme.json':{runId:'run-legacy',films:[{...heat,shows:[{channelId:'c1',channel:'C1',start:1000,end:2000,title:'Heat'}]},{...ronin,shows:[{channelId:'c2',channel:'C2',start:3000,end:4000,title:'Ronin'}]}]},
 'epg/discovered-films.json':[{...heat,id:'tmdb_7'},ronin],
 'epg/discovery-latest.json':{programmeRunId:'run-legacy',items:[{key:'ronin|1998',title:'Ronin',normalizedTitle:'ronin',year:1998,durations:[122],shows:[{channelId:'c2',start:3000,title:'Ronin'}]},{key:'unknown film|',title:'Unknown Film',normalizedTitle:'unknown film',year:null,durations:[95],shows:[{channelId:'c3',start:5000,title:'Unknown Film'}]}]},
 'epg/discovery-resolution.json':{'ronin|1998':{status:'verified',filmId:'tmdb_9',tmdbId:'9',canonicalIdentity:'tmdb:9',identitySource:'tmdb_detail',checkedAt:at,provenance:{authority:'tmdb_detail'}},'unknown film|':{status:'ambiguous',reason:'ambiguous',checkedAt:at,evidenceKey:rules.candidateEvidence({normalizedTitle:'unknown film',year:null,durations:[95],shows:[{channelId:'c3',start:5000}]})},'gone|2000':{status:'verified',filmId:'tmdb_12',tmdbId:'12',checkedAt:at}},
 'enrichment/profile/current.json':{version:1,profileHash:'profile-a',updatedAt:at},
 'enrichment/profile/versions/1.json':{version:1,profileHash:'profile-a',createdAt:at},
 'enrichment/films/tmdb_7/fingerprint.json':{fingerprintSchemaVersion:1,fingerprintHash:'print-heat',generatedAt:at,invalidatedAt:null},
 'enrichment/films/tmdb_9/fingerprint.json':{fingerprintSchemaVersion:1,fingerprintHash:'print-ronin',generatedAt:at,invalidatedAt:null},
 'enrichment/films/tmdb_9/actual.json':{rating:4,source:'letterboxd',updatedAt:at},
 'enrichment/films/tmdb_9/predictions.json':{current:{tasteProfileVersion:1,tasteProfileHash:'profile-a',fingerprintHash:'print-ronin',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4,r2Key:'enrichment/films/tmdb_9/predictions/1.json',contentSha256:'sha-ronin-1',updatedAt:at},history:[]},
 'enrichment/films/tmdb_404/fingerprint.json':{fingerprintSchemaVersion:1,fingerprintHash:'print-ghost',generatedAt:at,invalidatedAt:null},
};
const legacy=path.join(root,'legacy');
writeSnapshot(legacy,legacyBodies);
const legacyDb=path.join(root,'legacy.sqlite');
const bounded=runImport(legacy,legacyDb,{limit:2});
assert.equal(bounded.stopped,false);
assert.equal(bounded.applied<=2,true);
assert.equal(bounded.pending>0,true);
assert.equal(bounded.claimsFullParity,false);
const legacyRun=runImport(legacy,legacyDb);
assert.equal(legacyRun.stopped,false,JSON.stringify(legacyRun.blockers));
assert.equal(legacyRun.resumed,bounded.applied);
assert.equal(legacyRun.ledger.some(item=>item.reason==='reference_missing'),false,JSON.stringify(legacyRun.ledger));
assert.equal(legacyRun.conflicts,0,JSON.stringify(legacyRun.ledger));
const legacyHandle=snapshotSqlite(legacyDb);
assert.equal((await legacyHandle.get("SELECT film_id FROM fingerprint_payload WHERE r2_key='enrichment/films/tmdb_7/fingerprint.json'")).film_id,'film:heat-1995');
assert.equal((await legacyHandle.get("SELECT film_id FROM fingerprint_payload WHERE r2_key='enrichment/films/tmdb_9/fingerprint.json'")).film_id,'film:tmdb:9');
assert.equal((await legacyHandle.get("SELECT rating FROM actual_rating WHERE film_id='film:tmdb:9'")).rating,4);
assert.equal((await legacyHandle.get("SELECT film_id FROM prediction_current WHERE r2_key='enrichment/films/tmdb_9/predictions/1.json'")).film_id,'film:tmdb:9');
assert.equal((await legacyHandle.get("SELECT to_film_id FROM film_redirect WHERE from_id='film:tmdb:7'")).to_film_id,'film:heat-1995');
assert.equal(await count(legacyHandle,"SELECT COUNT(*) AS n FROM import_receipt WHERE source_key='enrichment/films/tmdb_7/fingerprint.json' AND target_id='film:heat-1995'"),1);
assert.equal(await count(legacyHandle,"SELECT COUNT(*) AS n FROM film WHERE id LIKE 'film:tmdb:404%' OR id LIKE 'film:tmdb:12%'"),0);
const roninDecision=await legacyHandle.get("SELECT film_id,evidence_key,provenance_json FROM candidate_decision WHERE observation_key='ronin|1998'");
assert.equal(roninDecision.film_id,'film:tmdb:9');
assert.equal(roninDecision.evidence_key,rules.candidateEvidence(legacyBodies['epg/discovery-latest.json'].items[0]));
assert.equal(JSON.parse(roninDecision.provenance_json).importEvidence,'derived');
assert.equal(JSON.parse(roninDecision.provenance_json).importIdentity,'direct');
assert.equal(JSON.parse((await legacyHandle.get("SELECT provenance_json FROM candidate_decision WHERE observation_key='unknown film|'")).provenance_json).importEvidence,'stored');
assert.equal((await legacyHandle.get("SELECT evidence_key FROM candidate_generation WHERE observation_key='ronin|1998'")).evidence_key,roninDecision.evidence_key);
const ghost=legacyRun.ledger.find(item=>item.sourceKey==='enrichment/films/tmdb_404/fingerprint.json');
assert.equal(ghost.outcome,'unresolved');
assert.equal(ghost.reason,'film_unresolved');
assert.equal(ghost.class,'C');
assert.equal(ghost.identity.canonical,'film:tmdb:404');
assert.equal(typeof ghost.sourceSha256,'string');
const gone=legacyRun.ledger.find(item=>item.targetId==='gone|2000');
assert.equal(gone.outcome,'unresolved');
assert.equal(gone.reason,'decision_without_candidate');
assert.equal(legacyRun.classes.C.count,2);
assert.equal(legacyRun.classes.C.reasons.film_unresolved,1);
assert.equal(legacyRun.classes.C.reasons.decision_without_candidate,1);
assert.equal(legacyRun.provenance.identity.redirect>=1,true);
assert.equal(legacyRun.provenance.identity.direct>=1,true);
assert.equal(legacyRun.provenance.evidence.derived>=2,true);
assert.equal(legacyRun.provenance.evidence.stored>=1,true);
assert.equal(legacyRun.classes.A.mandatory.prediction.portable,true);
assert.equal(legacyRun.classes.A.mandatory.prediction.applied,1);
assert.equal(legacyRun.parity.ok,true,JSON.stringify({missing:legacyRun.parity.missing,extra:legacyRun.parity.extra,mismatched:legacyRun.parity.mismatched}));
assert.equal(legacyRun.parity.records.some(record=>record.key==='enrichment/films/tmdb_7/fingerprint.json'&&record.disposition==='mapped'&&record.identity.via==='redirect'),true);
assert.equal(legacyRun.parity.records.some(record=>record.key==='enrichment/films/tmdb_404/fingerprint.json'&&record.disposition==='unresolved'),true);
assert.equal(legacyRun.parity.records.some(record=>record.key==='epg/discovery-resolution.json'&&record.id==='gone|2000'&&record.disposition==='unresolved'),true);
assert.equal(legacyRun.claimsFullParity,false);
assert.equal(legacyRun.classes.C.count>0,true);
const legacyAgain=runImport(legacy,legacyDb);
assert.equal(legacyAgain.applied,0);
assert.equal(legacyAgain.resumed,bounded.applied+legacyRun.applied);
assert.equal(legacyAgain.receipts.stale.length,0);
assert.equal(legacyAgain.receipts.foreign.length,0);
assert.equal(legacyAgain.receipts.total,legacyAgain.resumed);
assert.equal(legacyAgain.classes.C.count,legacyRun.classes.C.count);
const staleSha=(await legacyHandle.get("SELECT source_sha256 FROM import_receipt WHERE source_key='enrichment/films/tmdb_9/actual.json'")).source_sha256;
writeSnapshot(legacy,{...legacyBodies,'enrichment/films/tmdb_9/actual.json':{rating:4.5,source:'letterboxd',updatedAt:later}});
const revised=runImport(legacy,legacyDb);
assert.equal(revised.applied,1);
assert.equal(revised.receipts.superseded.some(item=>item.sourceKey==='enrichment/films/tmdb_9/actual.json'&&item.sourceSha256===staleSha),true);
assert.equal(revised.receipts.stale.length,0);
assert.equal(revised.receipts.blocking,false);
assert.equal(revised.classes.A.blockers.includes('receipts_stale'),false);
assert.equal((await legacyHandle.get("SELECT rating FROM actual_rating WHERE film_id='film:tmdb:9'")).rating,4.5);
// A revision that cannot land leaves the earlier receipts stale with nothing superseding them: acceptance fails closed on the audit, not only on the read-back.
writeSnapshot(legacy,{...legacyBodies,'enrichment/films/tmdb_9/actual.json':{rating:'broken',source:'letterboxd',updatedAt:later}});
const broken=runImport(legacy,legacyDb);
assert.equal(broken.applied,0);
assert.equal(broken.parity.extra.some(item=>item.table==='actual_rating'&&item.id==='film:tmdb:9'),true);
assert.equal(broken.receipts.stale.filter(item=>item.sourceKey==='enrichment/films/tmdb_9/actual.json').length,2);
// The verdict itself is tested apart from the read-back: a clean parity with a stale or foreign receipt still blocks class A.
assert.equal(acceptanceClasses({inventory:inventory({finishedAt:at,aggregateSha256:'sha',keys:['enrichment/films/zz/predictions.json']}),coverage:emptyCoverageFor(),parity:{ok:true},receipts:{stale:[],foreign:[]}}).A.blocking,false);
assert.deepEqual(acceptanceClasses({inventory:inventory({finishedAt:at,aggregateSha256:'sha',keys:['enrichment/films/zz/predictions.json']}),coverage:emptyCoverageFor(),parity:{ok:true},receipts:{stale:[{sourceKey:'x'}],foreign:[]}}).A.blockers,['receipts_stale']);
assert.deepEqual(acceptanceClasses({inventory:inventory({finishedAt:at,aggregateSha256:'sha',keys:['enrichment/films/zz/predictions.json']}),coverage:emptyCoverageFor(),parity:{ok:true},receipts:{stale:[],foreign:[{sourceKey:'y'}]}}).A.blockers,['receipts_foreign']);
assert.equal(broken.receipts.superseded.length,0);
assert.equal(broken.receipts.blocking,true);
assert.equal(broken.classes.A.blockers.includes('receipts_stale'),true);
assert.equal(broken.classes.A.blocking,true);
assert.equal(broken.claimsFullParity,false);
await legacyHandle.run("INSERT INTO import_receipt (source_key,source_sha256,target_table,target_id,imported_at) VALUES ('enrichment/films/tmdb_77/actual.json','sha-foreign','actual_rating','film:tmdb:77',?)",[at]);
writeSnapshot(legacy,{...legacyBodies,'enrichment/films/tmdb_9/actual.json':{rating:4.5,source:'letterboxd',updatedAt:later}});
const foreign=runImport(legacy,legacyDb);
assert.equal(foreign.receipts.stale.length,0);
assert.equal(foreign.receipts.foreign.length,1);
assert.equal(foreign.receipts.foreign[0].sourceKey,'enrichment/films/tmdb_77/actual.json');
assert.equal(foreign.classes.A.blockers.includes('receipts_foreign'),true);
assert.equal(foreign.classes.A.blocking,true);
assert.equal(foreign.claimsFullParity,false);
assert.equal(foreign.classes.C.acknowledgementRequired,true);
assert.equal(foreign.parity.ok,true,JSON.stringify({missing:foreign.parity.missing,extra:foreign.parity.extra,mismatched:foreign.parity.mismatched}));

// A stored decision whose key disagrees with the derived key stops the run before the database exists.
const mismatch=path.join(root,'mismatch');
writeSnapshot(mismatch,{...legacyBodies,'epg/discovery-resolution.json':{...legacyBodies['epg/discovery-resolution.json'],'ronin|1998':{...legacyBodies['epg/discovery-resolution.json']['ronin|1998'],evidenceKey:'stale-evidence'}}});
const mismatchDb=path.join(root,'mismatch.sqlite');
const stoppedRun=runImport(mismatch,mismatchDb,{status:3});
assert.equal(stoppedRun.stopped,true);
assert.deepEqual(stoppedRun.stopReasons,['evidence_mismatch']);
assert.equal(stoppedRun.blockers[0].targetId,'ronin|1998');
assert.equal(stoppedRun.blockers[0].stored,'stale-evidence');
assert.equal(stoppedRun.blockers[0].class,'C');
assert.equal(stoppedRun.applied,0);
assert.equal(stoppedRun.claimsFullParity,false);
assert.equal(fs.existsSync(mismatchDb),false);
const itemMismatch=path.join(root,'item-mismatch');
writeSnapshot(itemMismatch,{...legacyBodies,'epg/discovery-latest.json':{...legacyBodies['epg/discovery-latest.json'],items:[{...legacyBodies['epg/discovery-latest.json'].items[0],evidenceKey:'stale-evidence'}]}});
const itemStopped=runImport(itemMismatch,path.join(root,'item-mismatch.sqlite'),{status:3});
assert.equal(itemStopped.stopReasons.includes('evidence_mismatch'),true);
assert.equal(fs.existsSync(path.join(root,'item-mismatch.sqlite')),false);

// An unknown key fails closed.
const unknown=path.join(root,'unknown');
writeSnapshot(unknown,{...legacyBodies,'mystery/zz.json':{anything:true}});
const unknownDb=path.join(root,'unknown.sqlite');
const unknownRun=runImport(unknown,unknownDb,{status:3});
assert.equal(unknownRun.stopped,true);
assert.deepEqual(unknownRun.stopReasons,['unknown_key']);
assert.equal(unknownRun.coverage.unmapped.includes('mystery/zz.json'),true);
assert.equal(unknownRun.blockers[0].sourceKey,'mystery/zz.json');
assert.equal(fs.existsSync(unknownDb),false);

// Identity collisions: two stored Films claim one TMDB id. The second Film is a conflict and the enrichment key for that id stays unresolved.
const collision=path.join(root,'collision');
const slugA={id:'slug-a',title:'Slug A',original:'Slug A',tmdbId:8,year:2000},slugB={id:'slug-b',title:'Slug B',original:'Slug B',tmdbId:8,year:2001};
writeSnapshot(collision,{
 'watchlist.json':{films:[slugA,slugB]},
 'programme.json':{runId:'run-collision',films:[{...slugA,shows:[]},{...slugB,shows:[]}]},
 'enrichment/films/tmdb_8/fingerprint.json':{fingerprintSchemaVersion:1,fingerprintHash:'print-eight',generatedAt:at,invalidatedAt:null},
 'enrichment/films/tmdb_8/actual.json':{rating:3,source:'letterboxd',updatedAt:at},
});
const collided=runImport(collision,path.join(root,'collision.sqlite'));
assert.equal(collided.ledger.some(item=>item.reason==='identity_collision'&&item.class==='A'),true,JSON.stringify(collided.ledger));
const eight=collided.ledger.filter(item=>item.sourceKey.startsWith('enrichment/films/tmdb_8/'));
assert.equal(eight.length,2);
assert.equal(eight.every(item=>item.outcome==='unresolved'&&item.reason==='identity_conflict'&&item.class==='C'),true);
// The generation that lists the colliding Film cannot be stored either; that stays a mapped-domain conflict, not an invented row.
assert.equal(collided.ledger.filter(item=>item.reason==='reference_missing').every(item=>item.targetTable==='programme_generation'),true,JSON.stringify(collided.ledger));
assert.equal(collided.ledger.some(item=>item.reason==='reference_missing'&&item.family!=='programme'),false);
assert.equal(collided.classes.A.mandatory.prediction.status,'absent');
assert.equal(collided.classes.A.blockers.includes('prediction_family_absent'),true);
assert.equal(collided.families.prediction.mandatory,true);
assert.equal(collided.claimsFullParity,false);
const collisionHandle=snapshotSqlite(path.join(root,'collision.sqlite'));
assert.equal(await count(collisionHandle,"SELECT COUNT(*) AS n FROM fingerprint_payload"),0);
assert.equal(await count(collisionHandle,"SELECT COUNT(*) AS n FROM film"),1);

function emptyCoverageFor(){return {denominator:0,mapped:[],r2_only:[],excluded:[],unmapped:[],r2OnlyFamilies:[]};}
function dim(dimension,status,updatedAt,extra={}){return {dimension,status,updatedAt,source:extra.source||'letterboxd',sourceVersion:null,provenance:extra.provenance||null,value:extra.value??null,nextAction:'none',attempts:0};}
function film(id,title,updatedAt,localization){return {contractVersion:1,id,canonicalIdentity:null,originalTitle:title,externalIds:[{scheme:'letterboxd',value:id.slice('film:'.length),trusted:true,conflicting:false}],aliases:[],identity:dim('identity','resolved',updatedAt),metadata:dim('metadata','fresh',updatedAt),localization:localization||dim('localization','missing',updatedAt),fingerprint:dim('fingerprint','missing',updatedAt),prediction:dim('prediction','missing',updatedAt)};}
function person(id,roleId,updatedAt,localization){return {contractVersion:1,id,roleId,externalIds:[{scheme:'letterboxd-role',value:roleId,trusted:true,conflicting:false}],aliases:[],identity:dim('identity','resolved',updatedAt),localization:localization||dim('localization','missing',updatedAt)};}
function writeSnapshot(directory,bodies){
 fs.rmSync(directory,{recursive:true,force:true});
 fs.mkdirSync(path.join(directory,'objects'),{recursive:true});
 const entries=Object.entries(bodies).map(([key,value])=>{
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value),'utf8');
  const name=createHash('sha256').update(Buffer.from(key,'utf8')).digest('hex')+'.bin';
  fs.writeFileSync(path.join(directory,'objects',name),bytes);
  return {key,file:'objects/'+name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),metadata:{size:bytes.length}};
 });
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifestFor(entries,1,'2026-10-19T00:00:00.000Z','2026-10-19T01:00:00.000Z',[])));
}
function runImport(directory,file,{status=0,limit=null}={}){
 const args=['scripts/offline-import.mjs','--snapshot',directory,'--database',file];
 if(limit!=null)args.push('--limit',String(limit));
 const result=spawnSync(process.execPath,args,{encoding:'utf8'});
 assert.equal(result.status,status,result.stderr||result.stdout);
 return JSON.parse(result.stdout);
}
async function count(databaseHandle,sql){return (await databaseHandle.get(sql)).n;}
function openSqlite(file){
 const state={buffer:null};
 return {run(sql,params=[]){const statement=render(sql,params)+';';if(state.buffer)state.buffer.push(statement);else exec(file,statement);return Promise.resolve();},get(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return Promise.resolve(query(file,sql,params)[0]??null);},all(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return Promise.resolve(query(file,sql,params));},async transaction(fn){if(state.buffer)return fn();state.buffer=[];try{await fn();exec(file,'BEGIN;\n'+state.buffer.join('\n')+'\nCOMMIT;\n');}finally{state.buffer=null;}}};
}
function exec(file,sql){const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||'sqlite failed');}
function query(file,sql,params){const result=spawnSync('sqlite3',['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+render(sql,params)+';',encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr||'sqlite failed');const text=result.stdout.trim();return text?JSON.parse(text):[];}
function render(sql,params=[]){let index=0;const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('Missing SQL parameter');return literal(params[index++]);});if(index!==params.length)throw new Error('Unused SQL parameter');return text;}
function literal(value){if(value==null)return 'NULL';if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Bad SQL number');return String(value);}if(typeof value==='boolean')return value?'1':'0';return "'"+String(value).replaceAll("'","''")+"'";}
