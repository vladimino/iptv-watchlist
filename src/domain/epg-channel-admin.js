// Pure helpers of the owner Channel admin page (AIR-562, ADR 0187). One file for the browser and the Worker; it imports nothing and touches no storage.
//  - parseM3u: the browser reads the owner's playlist and keeps ONLY the normalized fields {sourceId, name, group}. A stream URL line is read to close an entry
//    and is never stored, returned or logged. The raw playlist never leaves the page.
//  - validateSubmission: the Worker re-validates the normalized set (exact keys, types, sizes, no URL or credential-looking value) before the repository plans it.
//  - buildPreview / channelView / filterChannels: what an import would do to the stored snapshot, and the list rows, derived from plain objects.
// Effective policy is the repository's rule (owner override > owner category > provider category > known_only); it is recomputed here only to describe a
// preview and is never stored.

export const SUBMISSION_LIMITS=Object.freeze({entries:4000,groups:100,sourceId:20,name:200,group:120,note:500,bodyBytes:1048576});
export const PREVIEW_ITEM_CAP=200;
const POLICY_SET=['deny_all','discover','known_only'];

// ---- browser side -----------------------------------------------------------------------------------------------------------------------------------
const URL_LIKE=/[a-z][a-z0-9+.-]*:\/\//i;
const SECRET_LIKE=/(?:^|[\s?&;,])(?:token|password|passwd|secret|api[_-]?key|auth|username|user|pass)\s*=/i;
export function unsafeValue(text){return typeof text==='string'&&(URL_LIKE.test(text)||SECRET_LIKE.test(text));}
// -> {entries:[{sourceId,name,group}], groups:[name in first-seen order], issues:{missingId,orphan,unsafe,total}, examples:[{line,reason}]}
// An entry without a tvg-id, an orphan EXTINF (no stream line) and an unsafe name or group are dropped from `entries` and counted. ANY of them makes the file an
// incomplete source: `importBlockers` refuses the ordinary preview and import, because importing a partial file as complete would unlist and unclassify the
// channels it lost (ADR 0187: a source error refuses the whole import). A partial-import mode, if ever wanted, needs its own explicit owner-approved workflow.
export function parseM3u(text,{maxLines=200000}={}){
 const out={entries:[],groups:[],issues:{missingId:0,orphan:0,unsafe:0,total:0},examples:[],truncated:false};
 if(typeof text!=='string')return out;
 const seenGroups=new Set();
 const note=(reason,line)=>{out.issues[reason]+=1;out.issues.total+=1;if(out.examples.length<10)out.examples.push({line,reason});};
 let pending=null;
 const lines=text.split(/\r?\n/);
 const limit=Math.min(lines.length,maxLines);
 if(lines.length>maxLines)out.truncated=true;
 const finish=line=>{
  if(!pending)return;
  const entry=pending;pending=null;
  if(!entry.sourceId)return note('missingId',line);
  if(unsafeValue(entry.name)||unsafeValue(entry.group)||unsafeValue(entry.sourceId))return note('unsafe',line);
  out.entries.push({sourceId:entry.sourceId,name:entry.name,group:entry.group});
  if(entry.group&&!seenGroups.has(entry.group)){seenGroups.add(entry.group);out.groups.push(entry.group);}
 };
 for(let index=0;index<limit;index++){
  const line=lines[index].trim();
  if(!line)continue;
  if(line.startsWith('#EXTINF')){
   if(pending)note('orphan',index+1);
   const attrs={};
   for(const match of line.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g))attrs[match[1].toLowerCase()]=match[2].trim();
   const lastQuote=line.lastIndexOf('"');
   const comma=line.indexOf(',',lastQuote+1);
   const display=comma>=0?line.slice(comma+1).trim():'';
   pending={sourceId:(attrs['tvg-id']||attrs['tvg_id']||'').trim(),name:(attrs['tvg-name']||display||'').trim()||null,group:(attrs['group-title']||'').trim()||null};
   continue;
  }
  if(line.startsWith('#EXTGRP:')){if(pending){const group=line.slice(8).trim();if(group)pending.group=group;}continue;}
  if(line.startsWith('#'))continue;
  finish(index+1); // a stream line: closes the entry and is dropped here
 }
 if(pending)note('orphan',limit);
 return out;
}

// -> [{code, count}] one per reason the file cannot be imported as a complete playlist; empty when it can.
export function importBlockers(parsed){
 const out=[];
 if(!parsed||!Array.isArray(parsed.entries))return [{code:'unreadable',count:1}];
 const i=parsed.issues||{};
 if(i.missingId)out.push({code:'missing_tvg_id',count:i.missingId});
 if(i.orphan)out.push({code:'orphan_extinf',count:i.orphan});
 if(i.unsafe)out.push({code:'unsafe_value',count:i.unsafe});
 if(parsed.truncated)out.push({code:'truncated',count:1});
 if(!parsed.entries.length)out.push({code:'no_channels',count:0});
 return out;
}

// ---- Worker side: the submitted normalized set --------------------------------------------------------------------------------------------------------
const hasControl=text=>/[\u0000-\u001f\u007f]/.test(text);
const isPlain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function exactKeys(value,allowed){return Object.keys(value).every(key=>allowed.includes(key));}
// -> {ok:true,groups:[{name,policy}],entries:[{sourceId,name,group}]} | {ok:false,errors:[{code,...}]}
export function validateSubmission(body){
 const errors=[];const add=(code,detail)=>{if(errors.length<50)errors.push({code,...detail});};
 if(!isPlain(body)||!Array.isArray(body.groups)||!Array.isArray(body.entries))return {ok:false,errors:[{code:'invalid_input'}]};
 const L=SUBMISSION_LIMITS;
 if(body.entries.length>L.entries)add('too_many_entries',{count:body.entries.length});
 if(body.groups.length>L.groups)add('too_many_groups',{count:body.groups.length});
 if(errors.length)return {ok:false,errors};
 const groups=[],entries=[];
 const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!hasControl(value);
 body.groups.forEach((group,index)=>{
  if(!isPlain(group)||!exactKeys(group,['name','policy']))return add('invalid_group',{index});
  if(!text(group.name,L.group))return add('invalid_group',{index});
  if(unsafeValue(group.name))return add('unsafe_value',{index,field:'group'});
  if(!POLICY_SET.includes(group.policy))return add('invalid_policy',{index});
  groups.push({name:group.name,policy:group.policy});
 });
 body.entries.forEach((entry,index)=>{
  if(!isPlain(entry)||!exactKeys(entry,['sourceId','name','group']))return add('invalid_entry',{index});
  if(!text(entry.sourceId,L.sourceId))return add('invalid_source_id',{index});
  if(entry.name!==null&&!text(entry.name,L.name))return add('invalid_name',{index});
  if(entry.group!==null&&!text(entry.group,L.group))return add('invalid_group_name',{index});
  if(unsafeValue(entry.sourceId)||unsafeValue(entry.name)||unsafeValue(entry.group))return add('unsafe_value',{index});
  entries.push({sourceId:entry.sourceId,name:entry.name,group:entry.group});
 });
 return errors.length?{ok:false,errors}:{ok:true,groups,entries};
}
export function validateNote(note){return note===null||note===undefined||(typeof note==='string'&&note.length<=SUBMISSION_LIMITS.note&&!hasControl(note)&&!unsafeValue(note));}

// ---- views --------------------------------------------------------------------------------------------------------------------------------------------
// snapshot channel + categories (Map by key) -> the row the page shows. `effective` follows the repository's precedence.
export function effectiveOf(channel,categories){
 if(channel.overridePolicy)return {policy:channel.overridePolicy,basis:'override'};
 const owned=channel.ownerCategoryKey==null?null:categories.get(channel.ownerCategoryKey);
 if(owned)return {policy:owned.policy,basis:'owner_category'};
 const category=channel.categoryKey==null?null:categories.get(channel.categoryKey);
 return category?{policy:category.policy,basis:'category'}:{policy:'known_only',basis:'unclassified'};
}
export function channelView(channel,categories,presence){
 const named=key=>{const c=key==null?null:categories.get(key);return c?{key:c.categoryKey,name:c.name,policy:c.policy}:null;};
 // Published Film-show presence only: published_epg_show holds the shows the programme matched to a Film, not every XMLTV programme of the channel.
 const seen=presence&&presence.get?presence.get(channel.channelId):null;
 return {
  channelId:channel.channelId,sourceId:channel.sourceId??null,origin:channel.origin,name:channel.name??null,listed:channel.listed!==false,
  category:named(channel.categoryKey),ownerCategory:named(channel.ownerCategoryKey),ownerCategoryNote:channel.ownerCategoryNote??null,ownerCategoryAt:channel.ownerCategoryAt??null,
  overridePolicy:channel.overridePolicy??null,overrideNote:channel.overrideNote??null,overrideAt:channel.overrideAt??null,
  effective:effectiveOf(channel,categories),
  publishedFilmShows:seen?{shows:seen.shows,lastStartMs:seen.lastStartMs}:null,
 };
}
// rows: channelView results. filters: q (id, provider id or name, case-insensitive), category (key), policy, source ('m3u'|'xmltv'|'unlisted'), queue ('unclassified').
export function filterChannels(rows,{q='',category='',policy='',source='',queue=''}={}){
 const needle=String(q||'').trim().toLowerCase();
 return rows.filter(row=>{
  if(queue==='unclassified'&&row.effective.basis!=='unclassified')return false;
  if(category){const key=row.ownerCategory?.key??row.category?.key??null;if(category==='none'?key!==null:key!==category)return false;}
  if(policy&&row.effective.policy!==policy)return false;
  if(source==='unlisted'){if(row.listed)return false;}else if(source&&row.origin!==source)return false;
  if(needle&&!(row.channelId.toLowerCase().includes(needle)||(row.sourceId||'').toLowerCase().includes(needle)||(row.name||'').toLowerCase().includes(needle)))return false;
  return true;
 });
}

// ---- preview ------------------------------------------------------------------------------------------------------------------------------------------
// snapshot: the ok result of readSnapshot. plan: the ok result of planImport (categories, channels). -> what commitImport would do. Nothing is written here.
export function buildPreview(snapshot,plan){
 const cap=PREVIEW_ITEM_CAP;
 const buckets={new:[],renamed:[],changedCategory:[],unlisted:[],conflicts:[]};
 const totals={new:0,renamed:0,changedCategory:0,unlisted:0,conflicts:0,unchanged:0,overridesKept:0,ownerCategoriesKept:0,effectivePolicyChanges:0};
 const push=(bucket,item)=>{totals[bucket]+=1;if(buckets[bucket].length<cap)buckets[bucket].push(item);};
 const newCategories=new Map(plan.categories.map(category=>[category.categoryKey,category]));
 const keptOwnerKeys=new Set();
 for(const channel of snapshot.channels.values())if(channel.ownerCategoryKey!=null)keptOwnerKeys.add(channel.ownerCategoryKey);
 const after=new Map(newCategories);
 for(const key of keptOwnerKeys)if(!after.has(key)&&snapshot.categories.has(key))after.set(key,snapshot.categories.get(key));
 const name=key=>key==null?null:(newCategories.get(key)||snapshot.categories.get(key))?.name??key;
 const planned=new Map(plan.channels.map(channel=>[channel.channelId,channel]));
 for(const next of plan.channels){
  const stored=snapshot.channels.get(next.channelId);
  if(!stored){push('new',{channelId:next.channelId,sourceId:next.sourceId,name:next.name,category:name(next.categoryKey)});continue;}
  let changed=false;
  if(next.name!=null&&next.name!==stored.name){changed=true;push('renamed',{channelId:next.channelId,from:stored.name,to:next.name});}
  if((next.categoryKey??null)!==(stored.categoryKey??null)){
   changed=true;
   push('changedCategory',{channelId:next.channelId,name:next.name??stored.name,from:name(stored.categoryKey),to:name(next.categoryKey)});
   if(stored.overridePolicy||stored.ownerCategoryKey!=null)push('conflicts',{channelId:next.channelId,kind:stored.overridePolicy?'override_retained':'owner_category_retained',detail:'provider category changes; the owner decision is kept'});
  }
  const before=effectiveOf(stored,snapshot.categories),afterPolicy=effectiveOf({...stored,categoryKey:next.categoryKey??null},after);
  if(before.policy!==afterPolicy.policy){totals.effectivePolicyChanges+=1;}
  if(!changed)totals.unchanged+=1;
 }
 for(const stored of snapshot.channels.values()){
  if(stored.overridePolicy)totals.overridesKept+=1;
  if(stored.ownerCategoryKey!=null)totals.ownerCategoriesKept+=1;
  if(planned.has(stored.channelId))continue;
  push('unlisted',{channelId:stored.channelId,name:stored.name,from:name(stored.categoryKey)});
  const afterPolicy=effectiveOf({...stored,categoryKey:null},after);
  if(effectiveOf(stored,snapshot.categories).policy!==afterPolicy.policy)totals.effectivePolicyChanges+=1;
  if(stored.overridePolicy||stored.ownerCategoryKey!=null)push('conflicts',{channelId:stored.channelId,kind:stored.overridePolicy?'override_retained':'owner_category_retained',detail:'absent from the playlist; kept with the owner decision'});
 }
 const categories={added:[],removed:[],policyChanged:[]};
 for(const category of plan.categories){
  const stored=snapshot.categories.get(category.categoryKey);
  if(!stored)categories.added.push({name:category.name,policy:category.policy});
  else if(stored.policy!==category.policy)categories.policyChanged.push({name:category.name,from:stored.policy,to:category.policy});
 }
 for(const stored of snapshot.categories.values()){
  if(newCategories.has(stored.categoryKey))continue;
  categories.removed.push({name:stored.name,keptForOwner:keptOwnerKeys.has(stored.categoryKey)});
 }
 return {totals,items:buckets,categories,capped:Object.values(totals).length>0&&Object.keys(buckets).some(key=>totals[key]>buckets[key].length),itemCap:cap};
}
