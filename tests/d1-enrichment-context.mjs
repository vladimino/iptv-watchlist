// Loads the enrichment projector as the Worker bundle carries it (AIR-275 phase 2, ADR 0056): the domain model, the scoped
// reader, projection and repository, and src/d1-enrichment.js, with the bundle's dictionaries and the reviewed person override.
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {personOverridesFromSource} from '../scripts/snapshot-store.mjs';

export function projectorContext({log=()=>{}}={}){
 const context=vm.createContext({Date,Map,Set,WeakMap,JSON,Object,URL,Math,Number,String,Array,Promise,TextEncoder,Uint8Array,encodeURIComponent,decodeURIComponent,crypto:webcrypto,console:{log}});
 const overrides=personOverridesFromSource(fs.readFileSync('src/sources.js','utf8'));
 context.FILM_TITLE_DICTIONARY=JSON.parse(fs.readFileSync('data/film-titles.json','utf8'));
 context.PERSON_NAME_DICTIONARY=JSON.parse(fs.readFileSync('data/person-names.json','utf8'));
 context.REVIEWED_PEOPLE=overrides;
 // The generation key helpers and the discovery lease key, verbatim from their sources, as the bundle carries them.
 const sources=fs.readFileSync('src/sources.js','utf8');
 vm.runInContext(sources.match(/^const EPG_GENERATION_KEY=.*$/m)[0]+'\n'+sources.match(/^function epgGenerationKey\(.*$/m)[0],context);
 vm.runInContext(fs.readFileSync('src/discovery.js','utf8').match(/^const DISCOVERY_LEASE_KEY=.*$/m)[0],context);
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),context);
 for(const [file,name,names] of [['src/domain/film-person-reader.js','LifecycleReader',['readLifecycle']],['src/enrichment-projection.js','EnrichmentProjection'],['src/canonical-repository.js','CanonicalRepository'],['src/metadata-cache.js','MetadataCache'],['src/published-epg.js','PublishedEpg']])vm.runInContext(scoped(file,name,names),context);
 vm.runInContext(fs.readFileSync('src/d1-enrichment.js','utf8')+'\nglobalThis.projector={runD1EnrichmentProjection,d1EnrichmentMode,d1EnrichmentPlan,d1EnrichmentStatus,d1EnrichmentAdapter,CanonicalRepository,EnrichmentProjection,MetadataCache};',context);
 return context.projector;
}
