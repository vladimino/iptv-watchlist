// Loads the enrichment projector as the Worker bundle carries it (AIR-275 phase 2, ADR 0056): the domain model, the scoped
// reader, projection and repository, and src/d1-enrichment.js, with the bundle's dictionaries and the reviewed person override.
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {personOverridesFromSource} from '../scripts/snapshot-store.mjs';

export function projectorContext({log=()=>{},globals={},harness=true,ownerReviewStandin=true,metadataCacheStandin=true,publishedEpgStandin=true}={}){
 const context=vm.createContext({Date,Map,Set,WeakMap,JSON,Object,URL,Math,Number,String,Array,Promise,TextEncoder,Uint8Array,encodeURIComponent,decodeURIComponent,crypto:webcrypto,console:{log},D1_ENRICHMENT_TEST_HARNESS:harness});
 const overrides=personOverridesFromSource(fs.readFileSync('src/sources.js','utf8'));
 Object.assign(context,globals);
 context.FILM_TITLE_DICTIONARY=JSON.parse(fs.readFileSync('data/film-titles.json','utf8'));
 context.PERSON_NAME_DICTIONARY=JSON.parse(fs.readFileSync('data/person-names.json','utf8'));
 context.REVIEWED_PEOPLE=overrides;
 // The generation key helpers and the discovery lease key, verbatim from their sources, as the bundle carries them.
 const sources=fs.readFileSync('src/sources.js','utf8');
 vm.runInContext(sources.match(/^const EPG_GENERATION_KEY=.*$/m)[0]+'\n'+sources.match(/^function epgGenerationKey\(.*$/m)[0],context);
 vm.runInContext(fs.readFileSync('src/discovery.js','utf8').match(/^const DISCOVERY_LEASE_KEY=.*$/m)[0],context);
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),context);
 for(const [file,name,names] of [['src/domain/film-person-reader.js','LifecycleReader',['readLifecycle']],['src/enrichment-projection.js','EnrichmentProjection'],['src/canonical-repository.js','CanonicalRepository'],[process.env.PROJECTOR_AUTHORITY_SOURCE||'src/film-person-authority.js','FilmPersonAuthority'],['src/metadata-cache.js',metadataCacheStandin?'MetadataCacheModule':'MetadataCache'],['src/published-epg.js',publishedEpgStandin?'PublishedEpgModule':'PublishedEpg'],['src/owner-review-d1.js',ownerReviewStandin?'OwnerReviewModule':'OwnerReview'],['src/prediction-d1.js','PredictionD1']])vm.runInContext(scoped(file,name,names),context);
 // ADR 0162: an owner-review domain that is not d1 is refused, and only the explicit local stand-in keeps the R2 object. Most
 // projector fixtures stop at schema v4 or v8, before the owner-review tables exist, so the harness opts in to that stand-in
 // explicitly (ownerReviewStandin: false turns it off). A fixture with the owner-review tables still needs its marker at d1.
 // The metadata cache has the same explicit opt-in (metadataCacheStandin: false turns it off); it only answers when the database has
 // no binding, no schema_contract or a contract below 6, and a marker that is not d1 is still refused.
 if(metadataCacheStandin)vm.runInContext("const MetadataCache={...MetadataCacheModule,readAuthority:env=>MetadataCacheModule.readAuthority(env&&typeof env==='object'&&typeof env.prepare!=='function'&&typeof env.get!=='function'?{METADATA_CACHE_DB_OPTIONAL:'standin',...env}:env)};",context);
 // The published EPG has the same explicit opt-in (publishedEpgStandin: false turns it off): a fixture whose database does not install the nine
 // published tables serves the R2 generation, and one that installs them needs its marker at d1 / open with a published generation.
 if(publishedEpgStandin)vm.runInContext("const flagged=env=>env&&typeof env==='object'&&typeof env.prepare!=='function'?{PUBLISHED_EPG_DB_OPTIONAL:'standin',...env}:env;const PublishedEpg={...PublishedEpgModule,readAuthority:env=>PublishedEpgModule.readAuthority(flagged(env)),currentGeneration:env=>PublishedEpgModule.currentGeneration(flagged(env)),authoritativeSnapshot:env=>PublishedEpgModule.authoritativeSnapshot(flagged(env))};",context);
 if(ownerReviewStandin)vm.runInContext("const OwnerReview={...OwnerReviewModule,readAuthority:env=>OwnerReviewModule.readAuthority(env&&typeof env==='object'&&typeof env.prepare!=='function'?{OWNER_REVIEW_DB_OPTIONAL:'standin',...env}:env)};",context);
 vm.runInContext(fs.readFileSync(process.env.PROJECTOR_SOURCE||'src/d1-enrichment.js','utf8')+'\nglobalThis.projector={runD1EnrichmentProjection,d1EnrichmentMode,d1EnrichmentPlan,d1EnrichmentStatus,d1EnrichmentAdapter,CanonicalRepository,EnrichmentProjection,MetadataCache,d1EnrichmentKeySums,d1EnrichmentBucketOf,D1_ENRICHMENT_BUCKET_SQL,D1_ENRICHMENT_BUCKET_EXPR,d1EnrichmentCheckpoints,d1EnrichmentDiff,d1EnrichmentWrite,d1EnrichmentLease,d1EnrichmentGroupCycle,d1EnrichmentDigestSql,d1EnrichmentBulkOptions,d1EnrichmentBulkMode,d1EnrichmentWallPolicy,LifecycleReader,OwnerReview};',context);
 return context.projector;
}
