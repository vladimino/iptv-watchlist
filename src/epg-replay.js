// AIR-454 / ADR 0121. Immutable, versioned, digest-verified replay datasets for the EPG diagnostic canary, INERT: nothing calls this module at
// runtime, it reads through a caller-supplied READ-ONLY reader, writes nothing, starts no provider fetch and holds no binding. AIR-455 (the owner-only
// Workflow) consumes it; copying a dataset into the diagnostic bucket is a separate owner-approved operation (AIR-456).
//
// What a dataset is. The EPG `seal_stage` archives the observations that left the scan (`departures`) of the commit being sealed. Its input is the scan
// of that run, which the live `epg` step builds from the provider feed and which is not stored as such. What IS stored, per published generation, is
// `epg/generations/<programmeRunId>/discovery-latest.json` (the ledger of that generation: in `bounded` mode exactly the latest scan, merged into
// canonical candidates) and the archive it names (pointer, manifest, segments). A dataset freezes that persisted state as the baseline, verifies it, and
// derives a deterministic, seeded, bounded mutation of it (N departures, optionally some returns from the archive) as the replay scan. It is therefore
// honest about its fidelity: `reduced`, with the reason `scan_is_canonical_ledger_not_raw_feed` (and others, see `fidelity`), never `full`.
//
// Determinism: the dataset is canonical JSON (sorted keys, items sorted by key) under a sha256 digest; the mutation uses a seeded integer PRNG over the
// sorted keys, so the same dataset and seed give the same plan, digest included, on any platform, and another seed gives another plan.
// The segment arithmetic is NOT reimplemented here: the caller passes the real `ledgerArchiveSegment` (and `discoveryCandidateKey`) of the Worker.
// Concatenated into the Worker like the other server modules: one global.
const EpgReplay=(()=>{
 const SCHEMA_VERSION=1,KIND='epg-replay-dataset',PLAN_KIND='epg-replay-plan',BUILDER='epg-replay/1';
 const GENERATION_KEY=id=>'epg/generations/'+id+'/discovery-latest.json';
 const ARCHIVE_PREFIX='epg/discovery-archive/v1/';
 const MANIFEST_KEY=id=>ARCHIVE_PREFIX+'manifests/'+id+'.json';
 // Bounds. A dataset above the byte or item budget is refused whole (never truncated silently); a plan above the departure cap is refused.
 const LIMITS=Object.freeze({maxBytes:96*1024*1024,maxItems:120000,maxSegments:256,maxDepartures:8000,maxReentries:2000,maxSeedLength:128});
 const fail=(code,detail={})=>Object.assign(new Error('epg_replay_'+code),{code:'epg_replay_'+code,reason:code,...detail});
 const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

 // ---- canonical form and digests -------------------------------------------------------------------------------
 function canonical(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 }
 async function sha256(text){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(text))));
  return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
 }
 const byteLength=text=>new TextEncoder().encode(text).length;
 const digestOf=async value=>{const {digest,...rest}=value;void digest;return sha256(canonical(rest));};
 // The digest the Worker writes for a stored segment: sha256 of the exact text of the object (`textSha256`).
 const segmentDigest=sha256;

 // ---- the builder: read-only --------------------------------------------------------------------------------------
 // `reader.get(key)` must return null or an object with `text()`; the builder calls nothing else, so a reader over the diagnostic copy or over a
 // read-only export serves it. `options.builtAt` is injected (the dataset is immutable, its time is part of its digest).
 async function readText(reader,key,code){
  let object;
  try{object=await reader.get(key);}catch(error){throw fail('unreadable',{key,cause:String(error?.message||error).slice(0,120)});}
  if(!object)throw fail(code,{key});
  if(typeof object.text!=='function')throw fail('reader_unsupported',{key});
  return object.text();
 }
 function parseJson(text,key){
  try{return JSON.parse(text);}catch{throw fail('malformed',{key});}
 }
 async function buildDataset(reader,{programmeRunId,builtAt,maxBytes=LIMITS.maxBytes,maxItems=LIMITS.maxItems}={}){
  if(typeof programmeRunId!=='string'||!/^[A-Za-z0-9-]{8,64}$/.test(programmeRunId))throw fail('invalid_generation');
  if(!reader||typeof reader.get!=='function')throw fail('reader_unsupported');
  if(typeof builtAt!=='string'||!Number.isFinite(Date.parse(builtAt)))throw fail('invalid_built_at');
  const key=GENERATION_KEY(programmeRunId);
  const generationText=await readText(reader,key,'generation_missing');
  let bytes=byteLength(generationText);
  if(bytes>maxBytes)throw fail('size_budget_exceeded',{bytes,maxBytes});
  const document=parseJson(generationText,key);
  if(!isObject(document)||!Array.isArray(document.items))throw fail('generation_incomplete',{key});
  if(document.programmeRunId!==programmeRunId)throw fail('generation_mismatch',{expected:programmeRunId,found:document.programmeRunId??null});
  if(document.items.length>maxItems)throw fail('size_budget_exceeded',{items:document.items.length,maxItems});
  const seen=new Set();
  for(const item of document.items){
   if(!isObject(item)||typeof item.key!=='string'||!item.key)throw fail('item_malformed');
   if(seen.has(item.key))throw fail('duplicate_key',{key:item.key});
   seen.add(item.key);
  }
  const items=[...document.items].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const reasons=['scan_is_canonical_ledger_not_raw_feed'];
  if(items.some(item=>item.seenInLatestSnapshot!==true))reasons.push('ledger_holds_unseen_backlog');
  let archive=null;
  const named=document.archive?.manifestId||null;
  if(named){
   const manifestKey=MANIFEST_KEY(named);
   const manifestText=await readText(reader,manifestKey,'manifest_missing');
   bytes+=byteLength(manifestText);
   const manifest=parseJson(manifestText,manifestKey);
   if(!isObject(manifest)||manifest.manifestId!==named||!Array.isArray(manifest.segments)||!Number.isInteger(manifest.segmentCount)||manifest.segmentCount<1||manifest.segmentCount>LIMITS.maxSegments)throw fail('manifest_malformed',{key:manifestKey});
   const segments=[];
   let archivedItems=0;
   for(const entry of manifest.segments){
    if(!isObject(entry)||!Number.isInteger(entry.segment))throw fail('manifest_malformed',{key:manifestKey});
    if(!entry.object){segments.push({segment:entry.segment,object:null,sha256:null,items:0,bytes:0,text:null});continue;}
    if(typeof entry.object!=='string'||!entry.object.startsWith(ARCHIVE_PREFIX+'segments/'))throw fail('segment_key_foreign',{segment:entry.segment});
    const text=await readText(reader,entry.object,'segment_missing');
    bytes+=byteLength(text);
    if(bytes>maxBytes)throw fail('size_budget_exceeded',{bytes,maxBytes});
    if(await segmentDigest(text)!==entry.sha256)throw fail('segment_digest_mismatch',{segment:entry.segment});
    const body=parseJson(text,entry.object);
    if(!isObject(body)||body.segment!==entry.segment||!isObject(body.items))throw fail('segment_malformed',{segment:entry.segment});
    const count=Object.keys(body.items).length;
    if(count!==entry.items)throw fail('segment_count_mismatch',{segment:entry.segment,expected:entry.items,found:count});
    archivedItems+=count;
    segments.push({segment:entry.segment,object:entry.object,sha256:entry.sha256,items:count,bytes:byteLength(text),text});
   }
   if(archivedItems!==manifest.totals?.items)throw fail('manifest_totals_mismatch',{expected:manifest.totals?.items??null,found:archivedItems});
   archive={manifestId:named,segmentCount:manifest.segmentCount,manifest,segments};
  }else reasons.push('archive_absent');
  if(bytes>maxBytes)throw fail('size_budget_exceeded',{bytes,maxBytes});
  const dataset={
   schemaVersion:SCHEMA_VERSION,kind:KIND,builder:BUILDER,builtAt,
   source:{programmeRunId,generationKey:key,ledgerMode:document.ledgerMode??null,archiveManifestId:named},
   fidelity:{level:'reduced',reasons},
   counts:{items:items.length,archivedItems:archive?archive.segments.reduce((n,s)=>n+s.items,0):0,segments:archive?archive.segments.filter(s=>s.object).length:0,bytes},
   baseline:{generation:{...document,items:undefined},items,archive},
  };
  dataset.digest=await digestOf(dataset);
  return dataset;
 }

 // ---- the validator ------------------------------------------------------------------------------------------------
 // Verifies an existing dataset (as read back from wherever it was kept) without trusting it: digest, shape, generation, counts, segments.
 async function verifyDataset(dataset,{expectedDigest=null,expectedProgrammeRunId=null,maxBytes=LIMITS.maxBytes}={}){
  const problems=[];
  const bad=code=>{problems.push(code);};
  if(!isObject(dataset)||dataset.kind!==KIND||dataset.schemaVersion!==SCHEMA_VERSION)return {ok:false,problems:['dataset_unrecognized']};
  if(typeof dataset.digest!=='string')bad('digest_missing');
  else{
   const actual=await digestOf(dataset);
   if(actual!==dataset.digest)bad('digest_mismatch');
   if(expectedDigest&&dataset.digest!==expectedDigest)bad('digest_unexpected');
  }
  const source=dataset.source,baseline=dataset.baseline;
  if(!isObject(source)||!isObject(baseline)||!Array.isArray(baseline.items))return {ok:false,problems:[...problems,'dataset_incomplete']};
  if(expectedProgrammeRunId&&source.programmeRunId!==expectedProgrammeRunId)bad('generation_mismatch');
  if(baseline.generation?.programmeRunId!==source.programmeRunId)bad('generation_mismatch');
  if(dataset.counts?.bytes>maxBytes)bad('size_budget_exceeded');
  if(dataset.counts?.items!==baseline.items.length)bad('item_count_mismatch');
  const keys=new Set();let previous=null;
  for(const item of baseline.items){
   if(!isObject(item)||typeof item.key!=='string'||!item.key){bad('item_malformed');break;}
   if(keys.has(item.key)){bad('duplicate_key');break;}
   if(previous!==null&&item.key<previous){bad('items_unsorted');break;}
   keys.add(item.key);previous=item.key;
  }
  if(!Array.isArray(dataset.fidelity?.reasons)||dataset.fidelity.level!=='reduced')bad('fidelity_unstated');
  const archive=baseline.archive;
  if((source.archiveManifestId||null)!==(archive?.manifestId||null))bad('archive_mismatch');
  if(archive){
   let items=0,withObject=0;
   if(archive.manifest?.manifestId!==archive.manifestId||!Array.isArray(archive.manifest?.segments)||archive.manifest.segments.length!==archive.segments?.length)bad('manifest_malformed');
   for(const [index,segment] of (archive.segments||[]).entries()){
    const entry=archive.manifest?.segments?.[index];
    if(!entry||entry.segment!==segment.segment||(entry.object||null)!==(segment.object||null)){bad('manifest_malformed');continue;}
    if(!segment.object)continue;
    withObject++;
    if(typeof segment.text!=='string'||await segmentDigest(segment.text)!==segment.sha256||segment.sha256!==entry.sha256){bad('segment_digest_mismatch');continue;}
    let body=null;try{body=JSON.parse(segment.text);}catch{bad('segment_malformed');continue;}
    if(!isObject(body?.items)||Object.keys(body.items).length!==segment.items||segment.items!==entry.items)bad('segment_count_mismatch');
    items+=segment.items;
   }
   if(items!==archive.manifest?.totals?.items||items!==dataset.counts?.archivedItems)bad('manifest_totals_mismatch');
   if(withObject!==dataset.counts?.segments)bad('segment_count_mismatch');
  }
  return {ok:problems.length===0,problems:[...new Set(problems)]};
 }

 // ---- deterministic mutation ---------------------------------------------------------------------------------------
 // xmur3 string hash into a mulberry32 generator: integer arithmetic only, the same on every platform.
 function rng(seed){
  let h=1779033703^seed.length;
  for(let i=0;i<seed.length;i++){h=Math.imul(h^seed.charCodeAt(i),3432918353);h=(h<<13)|(h>>>19);}
  let a=0;
  const mix=()=>{h=Math.imul(h^(h>>>16),2246822507);h=Math.imul(h^(h>>>13),3266489909);return (h^=h>>>16)>>>0;};
  a=mix();
  return ()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};
 }
 // Picks `count` keys of `sorted` (already sorted) by a seeded partial Fisher-Yates; returns them sorted.
 function pick(sorted,count,random){
  const pool=[...sorted];
  for(let i=0;i<count;i++){const j=i+Math.floor(random()*(pool.length-i));[pool[i],pool[j]]=[pool[j],pool[i]];}
  return pool.slice(0,count).sort();
 }
 // The keys that live ONLY in the archive (a candidate for a return to the scan), with their payloads, from the verified dataset.
 function archivedOnly(dataset){
  const active=new Set(dataset.baseline.items.map(item=>item.key)),out=new Map();
  for(const segment of dataset.baseline.archive?.segments||[]){
   if(!segment.object)continue;
   const body=JSON.parse(segment.text);
   for(const [key,record] of Object.entries(body.items))if(!active.has(key)&&!out.has(key))out.set(key,record.payload);
  }
  return out;
 }
 // `helpers.segmentOf(key,count)` is the Worker's `ledgerArchiveSegment`. The plan is small (keys, counts, digests) and carries no payload.
 async function planMutation(dataset,{seed,departures,returns=0}={},helpers={}){
  if(typeof seed!=='string'||!seed||seed.length>LIMITS.maxSeedLength)throw fail('invalid_seed');
  if(!Number.isInteger(departures)||departures<0)throw fail('invalid_departures');
  if(!Number.isInteger(returns)||returns<0)throw fail('invalid_returns');
  // The caller may only lower the caps (a smaller budget for one run), never raise them.
  const departureCap=Math.min(LIMITS.maxDepartures,Number.isInteger(helpers.maxDepartures)&&helpers.maxDepartures>=0?helpers.maxDepartures:Infinity);
  const returnCap=Math.min(LIMITS.maxReentries,Number.isInteger(helpers.maxReturns)&&helpers.maxReturns>=0?helpers.maxReturns:Infinity);
  if(departures>departureCap)throw fail('excessive_departures',{departures,max:departureCap});
  if(returns>returnCap)throw fail('excessive_returns',{returns,max:returnCap});
  if(typeof helpers.segmentOf!=='function')throw fail('segment_function_missing');
  const checked=await verifyDataset(dataset);
  if(!checked.ok)throw fail('dataset_invalid',{problems:checked.problems});
  const keys=dataset.baseline.items.map(item=>item.key);
  if(departures>keys.length)throw fail('excessive_departures',{departures,active:keys.length});
  const only=archivedOnly(dataset),onlyKeys=[...only.keys()].sort();
  if(returns>onlyKeys.length)throw fail('excessive_returns',{returns,archived:onlyKeys.length});
  const random=rng(dataset.digest+'|'+seed);
  const departed=pick(keys,departures,random),returned=pick(onlyKeys,returns,random);
  const count=dataset.baseline.archive?.segmentCount||64;
  const bySegment={};
  for(const key of departed){const segment=helpers.segmentOf(key,count);bySegment[segment]=(bySegment[segment]||0)+1;}
  const plan={
   kind:PLAN_KIND,schemaVersion:SCHEMA_VERSION,datasetDigest:dataset.digest,programmeRunId:dataset.source.programmeRunId,seed,
   departureCount:departed.length,returnCount:returned.length,activeBefore:keys.length,activeAfter:keys.length-departed.length+returned.length,
   departures:departed,returns:returned,
   archive:{segmentCount:count,segmentsRewritten:Object.keys(bySegment).map(Number).sort((a,b)=>a-b),departuresBySegment:Object.fromEntries(Object.keys(bySegment).map(Number).sort((a,b)=>a-b).map(segment=>[segment,bySegment[segment]])),upsertedKeysDigest:await sha256(canonical(departed))},
   fidelity:dataset.fidelity,
  };
  plan.digest=await sha256(canonical(plan));
  return plan;
 }
 // The scan the planner would receive: the active ledger of the baseline without the departures, plus the returned payloads. Candidates are the ledger's own
 // records (they carry `key`, `title` and `year`, from which the Worker's `discoveryCandidateKey` derives the same key).
 async function replayScan(dataset,plan,helpers={}){
  const checked=await verifyDataset(dataset);
  if(!checked.ok)throw fail('dataset_invalid',{problems:checked.problems});
  if(!isObject(plan)||plan.kind!==PLAN_KIND||plan.datasetDigest!==dataset.digest)throw fail('plan_mismatch');
  const {digest,...rest}=plan;
  if(digest!==await sha256(canonical(rest)))throw fail('plan_digest_mismatch');
  const gone=new Set(plan.departures),scan=dataset.baseline.items.filter(item=>!gone.has(item.key));
  if(plan.returns.length){const only=archivedOnly(dataset);for(const key of plan.returns){if(!only.has(key))throw fail('plan_mismatch');scan.push(only.get(key));}}
  if(typeof helpers.candidateKey==='function'){
   const keys=new Set(scan.map(item=>helpers.candidateKey(item)));
   if(keys.size!==scan.length)throw fail('scan_keys_collide');
  }
  return scan;
 }
 return {SCHEMA_VERSION,KIND,PLAN_KIND,LIMITS,GENERATION_KEY,MANIFEST_KEY,canonical,sha256,digestOf,buildDataset,verifyDataset,planMutation,replayScan};
})();
