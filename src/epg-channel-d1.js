// EPG Channel authority (schema v31, migrations/0031_epg_channel_authority.sql, ADR 0187). DORMANT: nothing in the Worker imports or bundles this
// module, no table it names is read by a scan, and applying the migration activates nothing. It is a storage and contract module only; tests load it
// as an ES module.
//
// Effective policy of a channel:  owner override > category policy > 'known_only'.  It is derived here and never stored.
//  - a channel without an override takes the policy of its category;
//  - a channel with no category (not classified), and an id the snapshot does not know, are `known_only`;
//  - an unavailable, absent, torn or incomplete snapshot is reported explicitly (`ok:false` with a reason) and its lookup answers `known_only` with
//    `degraded:true`. It never answers `discover`: a missing authority must not widen what Discovery may admit.
// A scan reads ONE snapshot (four statements, however many channels) and then looks policies up in memory. There is no per-channel D1 read.
// An import never deletes a channel for being missing from the source: it is kept, unclassified (so `known_only` unless it has an override) and reported
// as not listed (`listed:false`), for a later admin diff.
// Writes are compare-and-swap on the single snapshot revision inside one batch; a fence statement aborts the whole batch when the swap changed nothing.
// Channel identity is the provider id, never the channel name: `tvg_1259` is XMLTV `ch1259`, `tvg_1` is `ch001`.

export const POLICIES=Object.freeze(['deny_all','discover','known_only']);
export const DEFAULT_POLICY='known_only';
export const MAX_CHANNELS=4000;
export const MAX_CATEGORIES=100;
export const IMPORT_ERROR_CAP=50;
const CHANNEL_CHUNK=15;
const FENCE_SQL='UPDATE epg_channel_cas SET ok=changes() WHERE id=1';
const TABLES=['epg_channel_revision','epg_channel_cas','epg_channel_category','epg_channel'];
const MARKER_SQL='SELECT revision, source_sha256, plan_sha256, import_revision, category_count, channel_count FROM epg_channel_revision WHERE id=1';
const CATEGORY_SQL='SELECT category_key, name, policy, position, revision FROM epg_channel_category ORDER BY position, category_key';
const CHANNEL_SQL='SELECT channel_id, source_id, name, category_key, override_policy, override_note, override_at, revision, last_seen_revision FROM epg_channel ORDER BY channel_id';

function database(source){return source&&typeof source.prepare==='function'?source:source?.DB;}
async function one(db,sql,params=[]){return (await db.prepare(sql).bind(...params).first())??null;}
async function many(db,sql,params=[]){return (await db.prepare(sql).bind(...params).all()).results||[];}
const isPolicy=value=>POLICIES.includes(value);
const isSha=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);

// ---- identity -------------------------------------------------------------------------------------------------------------------------------------
// `tvg_<digits>` -> `ch<digits padded to three>`. Anything else is a source error: the id is never guessed and never matched by channel name.
export function normalizeProviderId(sourceId){
 const match=/^tvg_(\d{1,6})$/.exec(typeof sourceId==='string'?sourceId.trim():'');
 if(!match)return {ok:false,code:'invalid_source_id'};
 if(match[1].length>1&&match[1].startsWith('0'))return {ok:false,code:'invalid_source_id'};
 return {ok:true,channelId:'ch'+match[1].padStart(3,'0')};
}
export const isChannelId=value=>typeof value==='string'&&/^ch\d{3,6}$/.test(value);
export function categoryKeyOf(name){return typeof name==='string'?name.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase():'';}

// ---- import plan (pure) ---------------------------------------------------------------------------------------------------------------------------
// groups: [{name, policy}] in provider order. entries: [{sourceId, name, group}]. A conflict or duplicate is a source error and refuses the whole
// plan (nothing partial). An entry without a group is stored unclassified. A group an entry names but `groups` does not declare is an error.
export function planImport({groups,entries}){
 const errors=[];const add=(code,detail)=>{if(errors.length<IMPORT_ERROR_CAP)errors.push({code,...detail});};
 if(!Array.isArray(groups)||!Array.isArray(entries))return {ok:false,errors:[{code:'invalid_input'}]};
 if(groups.length>MAX_CATEGORIES)add('too_many_categories',{count:groups.length});
 if(entries.length>MAX_CHANNELS)add('too_many_channels',{count:entries.length});
 const categories=new Map();
 groups.forEach((group,position)=>{
  const key=categoryKeyOf(group?.name);
  if(!key)return add('invalid_category',{position});
  if(!isPolicy(group.policy))return add('invalid_policy',{category:key});
  if(categories.has(key))return add('duplicate_category',{category:key});
  categories.set(key,{categoryKey:key,name:group.name.normalize('NFC').trim().replace(/\s+/g,' '),policy:group.policy,position});
 });
 const channels=new Map();const sourceIds=new Set();
 entries.forEach((entry,index)=>{
  const id=normalizeProviderId(entry?.sourceId);
  if(!id.ok)return add(id.code,{index});
  const sourceId=entry.sourceId.trim();
  if(channels.has(id.channelId)||sourceIds.has(sourceId))return add('duplicate_channel_id',{channelId:id.channelId});
  const key=entry.group==null||entry.group===''?null:categoryKeyOf(entry.group);
  if(key!==null&&!categories.has(key))return add('unknown_category',{channelId:id.channelId});
  sourceIds.add(sourceId);
  channels.set(id.channelId,{channelId:id.channelId,sourceId,name:typeof entry.name==='string'?entry.name:null,categoryKey:key});
 });
 if(errors.length)return {ok:false,errors};
 return {ok:true,categories:[...categories.values()],channels:[...channels.values()]};
}

// ---- snapshot -------------------------------------------------------------------------------------------------------------------------------------
function lookupOf(categories,channels,degraded){
 return {
  degraded,
  policyFor(channelId){
   if(degraded)return {policy:DEFAULT_POLICY,basis:'unavailable',degraded:true};
   const channel=channels.get(channelId);
   if(!channel)return {policy:DEFAULT_POLICY,basis:'unknown',degraded:false};
   if(channel.overridePolicy)return {policy:channel.overridePolicy,basis:'override',degraded:false};
   const category=channel.categoryKey===null?null:categories.get(channel.categoryKey);
   return category?{policy:category.policy,basis:'category',degraded:false}:{policy:DEFAULT_POLICY,basis:'unclassified',degraded:false};
  },
 };
}
const failure=reason=>({ok:false,reason,lookup:lookupOf(new Map(),new Map(),true)});

function build(marker,categoryRows,channelRows){
 const revision=Number(marker.revision);
 if(!Number.isInteger(revision)||revision<0)return null;
 if(categoryRows.length!==Number(marker.category_count)||channelRows.length!==Number(marker.channel_count))return null;
 const importRevision=Number(marker.import_revision);
 if(!Number.isInteger(importRevision)||importRevision<0||importRevision>revision)return null;
 if(revision===0&&(categoryRows.length||channelRows.length))return null;
 const categories=new Map();
 for(const row of categoryRows){
  if(!isPolicy(row.policy)||!(Number(row.revision)>=1&&Number(row.revision)<=revision))return null;
  categories.set(row.category_key,{categoryKey:row.category_key,name:row.name,policy:row.policy,position:Number(row.position)});
 }
 const channels=new Map();
 for(const row of channelRows){
  if(!(Number(row.revision)>=1&&Number(row.revision)<=revision))return null;
  if(!(Number(row.last_seen_revision)>=1&&Number(row.last_seen_revision)<=importRevision))return null;
  if(row.category_key!==null&&!categories.has(row.category_key))return null;
  if(row.override_policy!==null&&!isPolicy(row.override_policy))return null;
  channels.set(row.channel_id,{channelId:row.channel_id,sourceId:row.source_id,name:row.name,categoryKey:row.category_key,overridePolicy:row.override_policy,overrideNote:row.override_note,overrideAt:row.override_at,listed:Number(row.last_seen_revision)===importRevision});
 }
 return {revision,importRevision,sourceSha256:marker.source_sha256??null,planSha256:marker.plan_sha256??null,categories,channels};
}

// -> {ok:true,revision,empty,sourceSha256,categories,channels,lookup} | {ok:false,reason:'unavailable'|'absent'|'incomplete',lookup}
export async function readSnapshot(source){
 const db=database(source);
 if(!db)return failure('unavailable');
 let names;
 try{names=(await many(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('epg_channel_revision','epg_channel_cas','epg_channel_category','epg_channel')")).map(row=>row.name);}
 catch{return failure('unavailable');}
 if(!names.length)return failure('absent');
 if(TABLES.some(name=>!names.includes(name)))return failure('incomplete');
 for(let attempt=0;attempt<2;attempt++){
  let before,categoryRows,channelRows,after;
  try{before=await one(db,MARKER_SQL);categoryRows=await many(db,CATEGORY_SQL);channelRows=await many(db,CHANNEL_SQL);after=await one(db,MARKER_SQL);}catch{return failure('unavailable');}
  if(!before||!after)return failure('incomplete');
  if(Number(before.revision)!==Number(after.revision))continue;
  const built=build(before,categoryRows,channelRows);
  if(!built)return failure('incomplete');
  return {ok:true,empty:built.revision===0,...built,lookup:lookupOf(built.categories,built.channels,false)};
 }
 return failure('unavailable');
}

// ---- writes ---------------------------------------------------------------------------------------------------------------------------------------
async function fenced(db,statements){
 if(typeof db.batch!=='function')return 'unavailable';
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));return 'ok';}
 catch(error){return /CHECK constraint failed|UNIQUE constraint failed|FOREIGN KEY constraint failed/i.test(String(error?.message||error))?'conflict':'unavailable';}
}
async function readMarker(db){
 try{const row=await one(db,MARKER_SQL);return row?{revision:Number(row.revision),sourceSha256:row.source_sha256??null,planSha256:row.plan_sha256??null,categoryCount:Number(row.category_count),channelCount:Number(row.channel_count)}:null;}
 catch{return null;}
}

// Digest of the WHOLE normalized plan: categories with their policies and positions, and every channel. It is computed here, never taken from the caller,
// so the no-op below can never keep a stale category policy. `sourceSha256` is provenance of the provider files and decides nothing.
async function planDigest(plan){
 const channels=[...plan.channels].sort((left,right)=>left.channelId<right.channelId?-1:left.channelId>right.channelId?1:0);
 const text=JSON.stringify([plan.categories.map(c=>[c.categoryKey,c.name,c.policy,c.position]),channels.map(c=>[c.channelId,c.sourceId,c.name,c.categoryKey])]);
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
 return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

// Replaces classification and category policy from one import. Nothing is deleted for being missing: a channel the import no longer lists is kept, loses its
// category (so it is `known_only` unless it has an override) and reads `listed:false`; every override survives. `plan` is the ok result of planImport.
// An import whose whole plan digest equals the stored one at the current revision writes nothing.
// -> {ok:true,revision,unchanged?} | {ok:false,reason:'invalid'|'conflict'|'unavailable'}
export async function commitImport(source,{expectedRevision,sourceSha256,plan,now}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!plan?.ok||!isSha(sourceSha256)||!Number.isInteger(expectedRevision)||expectedRevision<0||typeof now!=='string')return {ok:false,reason:'invalid'};
 if(plan.channels.length>MAX_CHANNELS||plan.categories.length>MAX_CATEGORIES)return {ok:false,reason:'invalid'};
 const digest=await planDigest(plan);
 const marker=await readMarker(db);
 if(!marker)return {ok:false,reason:'unavailable'};
 if(marker.revision!==expectedRevision)return {ok:false,reason:'conflict'};
 if(marker.revision>0&&marker.planSha256===digest)return {ok:true,revision:marker.revision,unchanged:true};
 const revision=expectedRevision+1;
 const statements=[
  ['UPDATE epg_channel_revision SET revision=?, import_revision=?, source_sha256=?, plan_sha256=?, updated_at=? WHERE id=1 AND revision=?',[revision,revision,sourceSha256,digest,now,expectedRevision]],
  [FENCE_SQL,[]],
 ];
 for(const category of plan.categories){
  statements.push(['INSERT INTO epg_channel_category (category_key,name,policy,position,revision) VALUES (?,?,?,?,?) ON CONFLICT(category_key) DO UPDATE SET name=excluded.name, policy=excluded.policy, position=excluded.position, revision=excluded.revision',[category.categoryKey,category.name,category.policy,category.position,revision]]);
 }
 for(let start=0;start<plan.channels.length;start+=CHANNEL_CHUNK){
  const chunk=plan.channels.slice(start,start+CHANNEL_CHUNK);
  statements.push([
   'INSERT INTO epg_channel (channel_id,source_id,name,category_key,revision,last_seen_revision) VALUES '+chunk.map(()=>'(?,?,?,?,?,?)').join(',')+' ON CONFLICT(channel_id) DO UPDATE SET source_id=excluded.source_id, name=excluded.name, category_key=excluded.category_key, revision=excluded.revision, last_seen_revision=excluded.last_seen_revision',
   chunk.flatMap(channel=>[channel.channelId,channel.sourceId,channel.name,channel.categoryKey,revision,revision]),
  ]);
 }
 statements.push(
  ['UPDATE epg_channel SET category_key=NULL, revision=? WHERE last_seen_revision<? AND category_key IS NOT NULL',[revision,revision]],
  ['DELETE FROM epg_channel_category WHERE revision<?',[revision]],
  // The counts a reader proves completeness against are those of the stored rows (retained channels included), not of the import.
  ['UPDATE epg_channel_revision SET category_count=(SELECT COUNT(*) FROM epg_channel_category), channel_count=(SELECT COUNT(*) FROM epg_channel) WHERE id=1',[]],
 );
 const outcome=await fenced(db,statements);
 if(outcome==='conflict')return {ok:false,reason:'conflict'};
 if(outcome!=='ok'){
  // A lost reply is not a failed write. Success is claimed only when the marker holds exactly this plan (its whole digest) at the next revision.
  const after=await readMarker(db);
  if(after&&after.revision===revision&&after.planSha256===digest)return {ok:true,revision};
  return {ok:false,reason:'unavailable'};
 }
 return {ok:true,revision};
}

// Sets (policy one of POLICIES) or clears (policy null) the owner override of one known channel. -> {ok:true,revision} | {ok:false,reason:'invalid'|'unknown_channel'|'conflict'|'unavailable'}
export async function setOverride(source,{expectedRevision,channelId,policy,note=null,now}){
 const db=database(source);
 if(!db)return {ok:false,reason:'unavailable'};
 if(!isChannelId(channelId)||(policy!==null&&!isPolicy(policy))||!Number.isInteger(expectedRevision)||expectedRevision<1||typeof now!=='string'||(note!==null&&typeof note!=='string'))return {ok:false,reason:'invalid'};
 const marker=await readMarker(db);
 if(!marker)return {ok:false,reason:'unavailable'};
 if(marker.revision!==expectedRevision)return {ok:false,reason:'conflict'};
 let row;
 try{row=await one(db,'SELECT channel_id FROM epg_channel WHERE channel_id=?',[channelId]);}catch{return {ok:false,reason:'unavailable'};}
 if(!row)return {ok:false,reason:'unknown_channel'};
 const revision=expectedRevision+1;
 const outcome=await fenced(db,[
  ['UPDATE epg_channel_revision SET revision=?, updated_at=? WHERE id=1 AND revision=?',[revision,now,expectedRevision]],
  [FENCE_SQL,[]],
  ['UPDATE epg_channel SET override_policy=?, override_note=?, override_at=?, revision=? WHERE channel_id=?',[policy,policy===null?null:note,policy===null?null:now,revision,channelId]],
  [FENCE_SQL,[]],
 ]);
 if(outcome==='conflict')return {ok:false,reason:'conflict'};
 if(outcome!=='ok'){
  // Success only when the stored override is exactly this request, metadata and time included; another writer's same-policy override is not ours.
  const after=await readMarker(db);
  if(after&&after.revision===revision){
   let stored;try{stored=await one(db,'SELECT override_policy, override_note, override_at, revision FROM epg_channel WHERE channel_id=?',[channelId]);}catch{return {ok:false,reason:'unavailable'};}
   const wantNote=policy===null?null:note,wantAt=policy===null?null:now;
   if(stored&&Number(stored.revision)===revision&&(stored.override_policy??null)===policy&&(stored.override_note??null)===wantNote&&(stored.override_at??null)===wantAt)return {ok:true,revision};
   return {ok:false,reason:'conflict'};
  }
  return {ok:false,reason:'unavailable'};
 }
 return {ok:true,revision};
}
