// Immutable prediction version objects. Each committed prediction is also written once as its own R2 object whose key
// carries the SHA-256 of its canonical bytes; the mutable predictions.json bundle keeps a pointer (r2Key, contentSha256)
// on its current record and on every history record written after this rule. Pure functions only: hashing is injected.
const PREDICTION_VERSION_SCHEMA_VERSION=1;
const PREDICTION_VERSION_PATTERN=/^enrichment\/films\/([^/]+)\/predictions\/versions\/([0-9a-f]{64})\.json$/;
function canonicalValue(value){
 if(Array.isArray(value))return value.map(canonicalValue);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalValue(value[key])]));
 return value;
}
// The version body is the prediction record as it was current: pointer fields and the history-only replacedAt are not part of it.
function predictionVersionBody(record){
 if(!record||typeof record!=='object')return null;
 const {r2Key,contentSha256,replacedAt,...body}=record;
 return canonicalValue(body);
}
function predictionVersionText(record){const body=predictionVersionBody(record);return body?JSON.stringify(body):null;}
function predictionVersionKey(filmId,sha256){return 'enrichment/films/'+encodeURIComponent(String(filmId))+'/predictions/versions/'+sha256+'.json';}
function predictionVersionPointer(filmId,sha256){return {r2Key:predictionVersionKey(filmId,sha256),contentSha256:sha256};}
function parsePredictionVersionKey(key){
 const match=typeof key==='string'?key.match(PREDICTION_VERSION_PATTERN):null;
 if(!match)return null;
 let filmId;try{filmId=decodeURIComponent(match[1]);}catch{return null;}
 return {filmId,sha256:match[2]};
}
// A record is linked when it points at the version object of its own film and the key names its own checksum.
function predictionVersionLinked(record,filmId){
 const parsed=parsePredictionVersionKey(record?.r2Key);
 return !!parsed&&typeof record.contentSha256==='string'&&parsed.sha256===record.contentSha256&&(filmId==null||parsed.filmId===String(filmId));
}
// The one-time materialization plan for a bundle: which records lack a pointer and the exact bytes each version object would hold.
// It writes nothing; the caller hashes each text and decides, under its own approval, whether to write.
function predictionMaterializationPlan(filmId,bundle){
 const records=[];
 if(bundle?.current&&typeof bundle.current==='object')records.push({role:'current',index:null,record:bundle.current});
 (Array.isArray(bundle?.history)?bundle.history:[]).forEach((record,index)=>{if(record&&typeof record==='object')records.push({role:'history',index,record});});
 const linked=[],pending=[],malformed=[];
 for(const item of records){
  if(predictionVersionLinked(item.record,filmId)){linked.push({role:item.role,index:item.index,r2Key:item.record.r2Key,contentSha256:item.record.contentSha256});continue;}
  if(item.record.r2Key!=null||item.record.contentSha256!=null){malformed.push({role:item.role,index:item.index,reason:'pointer_not_version_object'});continue;}
  pending.push({role:item.role,index:item.index,text:predictionVersionText(item.record),replacedAt:item.record.replacedAt??null});
 }
 return {filmId:String(filmId),schemaVersion:PREDICTION_VERSION_SCHEMA_VERSION,linked,pending,malformed,bundleRewriteNeeded:pending.length>0};
}
