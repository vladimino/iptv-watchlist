// ADR 0103 / AIR-383 review: the R2 side effects reachable from the Discovery chunk, workflow and admin-recovery paths, enumerated by
// source and classified against the projector's inputs. This is a structural test: it finds every R2 write call site in the files
// that hold those paths (a conservative superset of what a chunk reaches), requires each one to be classified here, requires the
// classification to match the site's guard in the code just before the call, and proves that a write to a key the projector reads is
// either routed to D1 under a D1 authority or fenced by the Discovery lease, which the window takes over. A new, unclassified or
// stale entry fails the test, so a future writer cannot reach a projector input without being looked at.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as Authority from '../src/discovery-authority.js';

const FILES=['src/discovery.js','src/discovery-workflow.js','src/admin/discovery-recovery.js'];
const CALL=/(env\.BUCKET\.(?:put|delete)|\bsaveJSON|\bmergeStoredJSON)\(/g;

function sites(file){
 const text=fs.readFileSync(file,'utf8'),found=[];let match;
 while((match=CALL.exec(text))){
  let depth=0,start=match.index+match[0].length,index=start;const args=[];
  for(;index<text.length;index++){
   const c=text[index];
   if('([{'.includes(c))depth++;
   else if(')]}'.includes(c)){if(depth===0)break;depth--;}
   else if(c===','&&depth===0){args.push(text.slice(start,index));start=index+1;if(args.length>=2)break;}
  }
  args.push(text.slice(start,index));
  const keyArg=(match[1].includes('BUCKET')?args[0]:args[1]||'').replace(/\s+/g,'');
  found.push({file,call:match[1],key:keyArg,before:text.slice(Math.max(0,match.index-700),match.index)});
 }
 return found;
}

// The projector's inputs, read from its own source (never typed here): every .json key it reads through its input readers.
const projector=fs.readFileSync('src/d1-enrichment.js','utf8');
const inputs=new Set();
for(const line of projector.split('\n')){
 if(!/d1EnrichmentRead\(|d1EnrichmentDiscoveryRead\(/.test(line))continue;
 for(const m of line.matchAll(/'([^']+\.json)'/g))inputs.add(m[1]);
}
for(const expected of ['watchlist.json','metadata.json','titles.json','people.json','epg/discovery-resolution.json','discovered-films.json','programme.json'])assert.ok(inputs.has(expected)||[...inputs].some(k=>k.endsWith(expected)),'the projector input list is read from the source: '+expected);
const isInput=key=>[...inputs].some(name=>key.includes("'"+name+"'")||key.includes('/'+name+"'"));

// Guard patterns: what must stand in the code just before the write. `lease` is the Discovery lease (fenced in D1; taken over by the
// window), `d1` a D1 compare-and-swap, `none` a write that no projector input depends on.
const LEASE=/await fence\(\)|renewDiscoveryLease\(env,lease\)|await guard\(\)|catalogPosterGuard/;
const classes={
 'discovery.js|saveJSON|DISCOVERY_SCORE_PREVIEW_KEY':{count:1,input:false,guard:/if\(fence\)await fence\(\)/},
 'discovery.js|env.BUCKET.put|DISCOVERY_LEASE_KEY':{count:3,input:false,guard:null,note:'the legacy R2 lease record itself; the projector reads it only as its writer-idle gate'},
 "discovery.js|saveJSON|epgGenerationKey(seenRunId,'discovered-films.json')":{count:1,input:true,guard:LEASE,routed:'epg/discovered-films.json'},
 "discovery.js|saveJSON|'epg/discovered-films.json'":{count:1,input:true,guard:LEASE,routed:'epg/discovered-films.json'},
 'discovery.js|env.BUCKET.put|key':{count:2,input:false,guard:/await guard\(\)|const stop=await guard\(\)|put=/,note:'catalog poster copy (guard before each write) and the observation shard put (immutable segment); neither is read by the projector under D1'},
 'discovery.js|env.BUCKET.put|CATALOG_POSTER_NEGATIVES_KEY':{count:1,input:false,guard:LEASE},
 "discovery.js|saveJSON|epgGenerationKey(seenRunId,'programme.json')":{count:2,input:true,guard:/patchProgramme|publishedPointer\(env\)|await fence\(\)/,note:'the D1 published programme is the projector input under D1 (PublishedEpg.authoritativeSnapshot); this is the R2 compatibility copy behind a D1 CAS or pointer check'},
 "discovery.js|saveJSON|'programme.json'":{count:1,input:true,guard:LEASE,note:'only without a published D1 pointer'},
 "discovery.js|saveJSON|'epg/discovery-status.json'":{count:5,input:false,guard:null},
 "discovery.js|saveJSON|'epg/discovery-resolution.json'":{count:3,input:true,guard:LEASE,routed:'epg/discovery-resolution.json'},
 'discovery.js|saveJSON|manifestKey':{count:1,input:false,guard:LEASE},
 'discovery.js|env.BUCKET.put|CONTINUATION_DIAGNOSTICS_KEY':{count:1,input:false,guard:null},
 'discovery.js|env.BUCKET.put|CONTINUATION_KEY':{count:1,input:false,guard:null,note:'lease-free in R2 mode; in D1 mode routed through DiscoveryAuthority.writeContinuation with windowHeldGuard'},
 'discovery.js|saveJSON|CONTINUATION_KEY':{count:1,input:false,guard:null},
 // ADR 0118: the ledger of Discovery report-failure notices (events/discovery-report-faults.json): an Events Log delivery buffer in its own key and its own etag, never read by the projector.
 'discovery-workflow.js|env.BUCKET.put|DISCOVERY_REPORT_FAULT_KEY':{count:1,input:false,guard:null,note:'a bounded buffer of Events Log notices; not a projector input'},
 'discovery-workflow.js|env.BUCKET.put|DISCOVERY_WORKFLOW_STATE_KEY':{count:1,input:false,guard:null,note:'routed through DiscoveryAuthority.writeWorkflow with windowHeldGuard in D1 mode'},
 'admin/discovery-recovery.js|env.BUCKET.put|drActionKey(idempotencyKey)':{count:1,input:false,guard:null},
 'admin/discovery-recovery.js|env.BUCKET.put|DiscoveryIndex.observationIndexManifestKey(run)':{count:1,input:false,guard:null},
 'admin/discovery-recovery.js|env.BUCKET.put|DR_RESOLUTION_KEY':{count:2,input:true,guard:/renewDiscoveryLease\(env,lease\)/,direct:true,note:'an R2 copy written after the lease is renewed; the projector reads the D1-owned decisions under a D1 authority and never this copy'},
 'admin/discovery-recovery.js|env.BUCKET.put|layout.manifestKey(run)':{count:2,input:false,guard:null},
 'admin/discovery-recovery.js|env.BUCKET.put|diActionKey(body.idempotencyKey)':{count:1,input:false,guard:null},
 'admin/discovery-recovery.js|env.BUCKET.put|diActionKey(submitted.idempotencyKey)':{count:3,input:false,guard:null},
};

const found=new Map();
for(const file of FILES)for(const site of sites(file)){
 const id=site.file.replace('src/','')+'|'+site.call+'|'+site.key;
 if(!found.has(id))found.set(id,[]);found.get(id).push(site);
}
// Every site is classified, with the counted number of sites, and every classification still exists: a stale entry fails too.
for(const [id,list] of found)assert.ok(classes[id],'unclassified R2 write reachable from Discovery: '+id+' (classify it against the projector inputs)');
for(const id of Object.keys(classes))assert.ok(found.has(id),'stale classification, the site no longer exists: '+id);
for(const [id,list] of found)assert.equal(list.length,classes[id].count,id+': the number of call sites changed');

// The classification agrees with the projector's own input list, so an input cannot be marked "not an input".
for(const [id,list] of found){
 const spec=classes[id],key=list[0].key.replace(/^[A-Z_]+$/,k=>k==='DR_RESOLUTION_KEY'?"'epg/discovery-resolution.json'":k);
 if(isInput(key))assert.equal(spec.input,true,id+' writes a key the projector reads and must be marked as an input');
 if(spec.input===true)assert.ok(isInput(key),id+' is marked as an input but the projector does not read that key');
 // The guard stands in the code right before the call (a lease fence, a lease renewal or a D1 compare-and-swap).
 if(spec.guard)for(const site of list)assert.match(site.before,spec.guard,id+': the guard before the write is missing');
}

// Each projector input a chunk can write is either D1-routed under a D1 authority (so no R2 object exists for the projector to read)
// or lease-fenced, and the lease is the row the window takes over (the window tests prove a lease-fenced batch fails once it does).
for(const [id,spec] of Object.entries(classes)){
 if(!spec.input)continue;
 if(spec.routed)assert.equal(Authority.ownsKey(spec.routed),true,id+': a key routed to D1 must be owned by the Discovery authority');
 assert.ok(spec.routed||spec.guard,id+': an input write needs a route to D1 or a lease guard');
}
for(const key of ['epg/discovery-resolution.json','epg/discovered-films.json','epg/discovery-status.json','epg/resolver-continuation.json'])assert.equal(Authority.ownsKey(key),true,key);
// The projector inputs that are not Discovery's at all have no writer in these files.
for(const name of ['metadata.json','titles.json','people.json','watchlist.json','letterboxd/diary/history.json','enrichment/view-index.json','letterboxd/admissions/verified-films.json','admin/owner-reviews.json']){
 for(const file of FILES)assert.equal(fs.readFileSync(file,'utf8').includes("'"+name+"'"),false,file+' must not name the projector input '+name);
}

console.log('Projector window R2 side effects: '+[...found.values()].reduce((n,l)=>n+l.length,0)+' R2 write sites in '+FILES.length+' Discovery files classified; every projector input written there is D1-routed or lease-fenced, and the other inputs are not written there');
