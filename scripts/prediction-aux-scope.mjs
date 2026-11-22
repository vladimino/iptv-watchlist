// AIR-554 (owner GO of 22 Nov 2026): the ONE definition of the Predictions auxiliary export scope. The exporter (scripts/r2-snapshot-export.mjs, `--scope prediction-aux`), the converter
// (scripts/prediction-aux-export-convert.mjs) and the cutover operator (scripts/prediction-aux-cutover-production.mjs) all read it from here, so the proof a capture claims is the proof the
// operator checks. It names no bucket and no network; it only describes WHICH objects a scoped cut covers and which fence keys guard exactly those.
//
// The scope is the legacy auxiliary R2 state that ADR 0194 moves to D1 as one cohort and that the importer consumes: the held stage and the event outbox index (exact singleton keys), the run sources,
// the persisted batch manifests and the stop and start event records (prefixes). A prefix is listed completely, so a key under it that the importer would not consume is still part of the cut and is
// refused by the converter (`unconsumed_key`), never dropped. The fence keys are the leases of the batch runner and writer: the only coordination objects of THIS domain. The EPG and Discovery
// coordination keys and every other bucket object are deliberately outside the proof: an unrelated writer must not turn a valid auxiliary cut into a NO-GO.
import {createHash} from 'node:crypto';

export const STAGE_KEY='enrichment/batch-stage.json';
export const OUTBOX_KEY='enrichment/event-outbox.json';
export const PREDICTION_AUX_SCOPE=Object.freeze({
 kind:'prediction_aux',
 version:1,
 singletons:Object.freeze([STAGE_KEY,OUTBOX_KEY]),
 prefixes:Object.freeze(['enrichment/sources/','enrichment/batch-manifest/','enrichment/stop-events/','enrichment/start-events/']),
 fenceKeys:Object.freeze(['enrichment/runner-lease.json','enrichment/writer-lease.json'])
});
// A snapshot that carries no scope is the whole-bucket cut of the original exporter and keeps meaning exactly that.
export const WHOLE_STORE_SCOPE=Object.freeze({kind:'full_bucket',version:1});

const canonical=scope=>JSON.stringify(scope.kind==='prediction_aux'?{kind:scope.kind,version:scope.version,singletons:[...scope.singletons],prefixes:[...scope.prefixes],fenceKeys:[...scope.fenceKeys]}:{kind:scope.kind,version:scope.version});
export const scopeDigest=scope=>createHash('sha256').update(canonical(scope)).digest('hex');
export const SCOPE_NAMES=Object.freeze({'prediction-aux':PREDICTION_AUX_SCOPE});

// The scope a manifest or a capture claims, reduced to {kind, digest}; anything that is not exactly the current definition of a known scope is `null`.
export function describeScope(value){
 if(value==null)return {kind:WHOLE_STORE_SCOPE.kind,digest:scopeDigest(WHOLE_STORE_SCOPE)};
 if(typeof value!=='object')return null;
 if(value.kind==='full_bucket'&&value.version===1)return {kind:'full_bucket',digest:scopeDigest(WHOLE_STORE_SCOPE)};
 if(value.kind==='prediction_aux'){
  const digest=scopeDigest(value);
  return digest===scopeDigest(PREDICTION_AUX_SCOPE)?{kind:'prediction_aux',digest}:null;
 }
 return null;
}
export const sameScope=(a,b)=>!!a&&!!b&&a.kind===b.kind&&a.digest===b.digest;
// Is this object key inside the auxiliary scope?
export function inAuxScope(key){
 return typeof key==='string'&&(PREDICTION_AUX_SCOPE.singletons.includes(key)||PREDICTION_AUX_SCOPE.prefixes.some(prefix=>key.startsWith(prefix)&&key.length>prefix.length));
}
