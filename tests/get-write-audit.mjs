// AIR-412: the GET/HEAD read-side-effect audit (ADR 0107). Every read route of the production bundle, every MCP read tool and every page is requested in
// eight storage scenarios against an instrumented R2 and an instrumented D1; the effects of each request must equal what tests/get-write-baseline.mjs lists
// for it, which for a route that does not write is nothing. A new writer, a changed writer, a writer that was fixed but not removed from the baseline,
// and a read route or MCP tool the inventory does not know all fail here. Nothing is mocked to hide a writer: see tests/get-write-audit-lib.mjs.
import assert from 'node:assert/strict';
import {loadBundle,buildScenario,Probe,effectsOf,SCENARIOS} from './get-write-audit-lib.mjs';
import {PAGES,PREFIX_ROUTES,QUERY,SAMPLES,MCP_READ_TOOLS,MCP_WRITE_TOOLS,BASELINE,MCP_BASELINE} from './get-write-baseline.mjs';

const bundle=await loadBundle(),source=bundle.source;
const probe=Probe(bundle);

// ---- the inventory is derived from the bundle, then checked against the registry ----
const exact=new Set(),postOnly=new Set();
for(const match of source.matchAll(/(?:url\.pathname|path)==='(\/api\/[^']+)'&&request\.method==='(GET|POST|PUT|PATCH|DELETE)'/g))(match[2]==='GET'?exact:postOnly).add(match[1]);
for(const match of source.matchAll(/\[((?:'\/api\/[^']+',?)+)\]\.includes\((?:url\.pathname|path)\)&&request\.method==='(GET|POST|PUT|PATCH|DELETE)'/g))for(const item of match[1].split(','))(match[2]==='GET'?exact:postOnly).add(item.slice(1,-1));
for(const item of exact)postOnly.delete(item);
assert(exact.size>=25,'route extraction found '+exact.size+' GET routes');
// Prefix-routed reads are not visible as exact paths: every prefix the dispatcher uses must be registered with the routes that stand for it.
const prefixes=new Set([...source.matchAll(/(?:url\.pathname|path)\.startsWith\('(\/api\/[^']+)'\)/g)].map(match=>match[1]));
// A route dispatched by path alone, whatever the method, is routed by its own method check and is registered the same way.
for(const match of source.matchAll(/url\.pathname==='(\/api\/[^']+)'\)return/g))prefixes.add(match[1]);
for(const prefix of prefixes)assert.ok(PREFIX_ROUTES[prefix],'the dispatcher routes the prefix '+prefix+', which tests/get-write-baseline.mjs PREFIX_ROUTES does not register; register it with one sample GET path per distinct read it serves');
for(const prefix of Object.keys(PREFIX_ROUTES))assert.ok(prefixes.has(prefix),'PREFIX_ROUTES registers '+prefix+', which the dispatcher no longer routes; remove it');
const withQuery=route=>route+(QUERY[route]||'');
const readRoutes=[...exact].sort().map(withQuery).concat(Object.values(PREFIX_ROUTES).flat().filter(Boolean),SAMPLES);
assert.equal(new Set(readRoutes).size,readRoutes.length,'a read route is listed twice');

// ---- the matrix ----
const observed={},statuses={};
const key=(method,route,scenario)=>method+' '+route.replace(/\?.*$/,'')+(route.includes('?')?' ?'+route.split('?')[1]:'')+' @ '+scenario;
const names=Object.keys(SCENARIOS);
const failures=[];
const consumed=new Set();
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const baselineFor=(table,method,route,scenario)=>{
 const entry=table.find(item=>item.routes.includes(method+' '+route));
 return entry?{entry,effects:entry.effects[scenario]||[],sql:entry.sql?.[scenario]||[]}:{entry:null,effects:[],sql:[]};
};
for(const name of names){
 const scenario=await buildScenario(name);
 for(const route of readRoutes)for(const method of ['GET','HEAD']){
  const result=await probe.run(scenario,[route,{method}]);
  const found=effectsOf(result);
  observed[key(method,route,name)]=found;statuses[key(method,route,name)]=result.status;
  const {entry,effects,sql}=baselineFor(BASELINE,method,route,name),statements=[...new Set(result.statements)];
  if(entry&&effects.length&&same(found,effects)&&same(statements,sql))consumed.add(entry.id+'@'+name);
  if(!same(found,effects))failures.push(key(method,route,name)+'\n   observed: '+JSON.stringify(found)+'\n   baseline: '+JSON.stringify(effects));
  else if(!same(statements,sql))failures.push(key(method,route,name)+' writes other SQL than the baseline lists\n   observed: '+JSON.stringify(statements)+'\n   baseline: '+JSON.stringify(sql));
  // A GET never ends in a route error in the two healthy scenarios (a 503 is a storage that is not there, not an error); a HEAD never writes anything at all.
  if(method==='GET'&&(name==='r2'||name==='d1')&&[500,502,599].includes(result.status))failures.push(key(method,route,name)+' ended in a route error ('+result.status+')');
  if(method==='HEAD'&&found.length)failures.push('HEAD '+route+' @ '+name+' has effects: '+found.join(', '));
 }
 // A route that accepts only POST must not do anything when it is asked with GET.
 for(const route of [...postOnly].sort()){
  const result=await probe.run(scenario,[route,{method:'GET'}]);
  const found=effectsOf(result);
  if(found.length)failures.push('GET on the POST-only route '+route+' @ '+name+' has effects: '+found.join(', '));
 }
 // The pages are assets: no storage, no request.
 for(const page of PAGES)for(const method of ['GET','HEAD']){
  const result=await probe.run(scenario,[page,{method}]);
  const found=effectsOf(result);
  if(found.length)failures.push(method+' '+page+' @ '+name+' has effects: '+found.join(', '));
 }
 // MCP: the tool list is the inventory; a tool the registry does not name fails; a read-only tool never has an effect.
 const listing=await probe.run(scenario,null,{mcp:{method:'tools/list'}});
 const tools=JSON.parse(listing.body).result.tools;
 for(const tool of tools){
  const read=MCP_READ_TOOLS[tool.name],write=MCP_WRITE_TOOLS.includes(tool.name);
  if(!read&&!write){failures.push('MCP tool '+tool.name+' is not registered in MCP_READ_TOOLS or MCP_WRITE_TOOLS');continue;}
  if(read&&write){failures.push('MCP tool '+tool.name+' is registered as read and as write');continue;}
  if(write){if(tool.annotations?.readOnlyHint===true)failures.push('MCP write tool '+tool.name+' is annotated readOnlyHint true');continue;}
  const result=await probe.run(scenario,null,{mcp:{name:tool.name,arguments:read.arguments||{}}});
  const found=effectsOf(result);
  observed[key('MCP',tool.name,name)]=found;statuses[key('MCP',tool.name,name)]=result.status;
  const {entry,effects,sql}=baselineFor(MCP_BASELINE,'MCP',tool.name,name),statements=[...new Set(result.statements)];
  if(entry&&effects.length&&same(found,effects)&&same(statements,sql))consumed.add(entry.id+'@'+name);
  if(!same(found,effects))failures.push(key('MCP',tool.name,name)+'\n   observed: '+JSON.stringify(found)+'\n   baseline: '+JSON.stringify(effects));
  else if(!same(statements,sql))failures.push(key('MCP',tool.name,name)+' writes other SQL than the baseline lists\n   observed: '+JSON.stringify(statements)+'\n   baseline: '+JSON.stringify(sql));
  // The annotation is a promise to the client: readOnlyHint true means no effect in any scenario, whatever the baseline says.
  // A documented annotation defect (`annotationDefect` in the baseline) is a finding of this audit, not an exemption for a new one.
  if(tool.annotations?.readOnlyHint===true&&found.length&&!entry?.annotationDefect)failures.push('MCP tool '+tool.name+' is annotated readOnlyHint true and has effects @ '+name+': '+found.join(', '));
  if(entry?.annotationDefect&&tool.annotations?.readOnlyHint!==true)failures.push('MCP tool '+tool.name+' is registered as an annotation defect but is no longer annotated readOnlyHint true; drop annotationDefect');
  if(name==='r2'&&tool.annotations?.readOnlyHint!==true&&!MCP_BASELINE.some(item=>item.routes.includes('MCP '+tool.name)))failures.push('MCP read tool '+tool.name+' is not annotated readOnlyHint true and has no baseline entry: annotate it readOnlyHint true or register its writer');
 }
 for(const registered of [...Object.keys(MCP_READ_TOOLS),...MCP_WRITE_TOOLS])if(!tools.some(tool=>tool.name===registered))failures.push('the registry names the MCP tool '+registered+', which tools/list no longer returns');
}
// GET /api/enrichment/view overlays the compiled seed in memory: missing and partial indexes, a concurrent pair of reads, and both R2
// and D1 pending work must not persist the seed, dispatch work, or change the DTO between two equal probes.
{
 const dto=body=>{const data=JSON.parse(body);return {actualRating:data.films?.w1?.actualRating??null,watched:Object.hasOwn(data.films?.w1||{},'watched')?data.films.w1.watched:null,ids:Object.keys(data.films||{}).sort()};};
 const noPersist=result=>{
  assert.equal(result.dispatches,0);
  assert.equal(result.background,0);
  assert.equal(result.workflows,0);
  assert.ok(!effectsOf(result).some(item=>item.includes('view-index')),'view index write: '+effectsOf(result).join(', '));
 };
 const missing=await buildScenario('r2-pending');
 const [first,second]=await Promise.all([probe.run(missing,['/api/enrichment/view',{method:'GET'}]),probe.run(missing,['/api/enrichment/view',{method:'GET'}])]);
 assert.equal(first.status,200);assert.equal(second.status,200);
 noPersist(first);noPersist(second);
 assert.deepEqual(effectsOf(first),[]);assert.deepEqual(effectsOf(second),[]);
 assert.deepEqual(dto(first.body),{actualRating:4,watched:null,ids:['w1']});
 assert.deepEqual(dto(first.body),dto(second.body));
 assert.equal(JSON.parse(missing.snapshot.get('enrichment/view-index.json').text).w1,undefined);
 const partialSnapshot=new Map(missing.snapshot);
 partialSnapshot.set('enrichment/view-index.json',{text:JSON.stringify({kept:{actualRating:null,watched:true},w1:{fingerprintHash:'x'}}),customMetadata:{}});
 const partial=await probe.run({...missing,snapshot:partialSnapshot},['/api/enrichment/view',{method:'GET'}]);
 assert.equal(partial.status,200);noPersist(partial);assert.deepEqual(effectsOf(partial),[]);
 const partialFilms=JSON.parse(partial.body).films;
 assert.equal(partialFilms.kept.actualRating,null);assert.equal(partialFilms.kept.watched,true);assert.equal(partialFilms.w1.actualRating,4);
 const d1Pending=await buildScenario('d1-pending');
 const d1View=await probe.run(d1Pending,['/api/enrichment/view',{method:'GET'}]);
 assert.equal(d1View.status,200);noPersist(d1View);
 assert.equal(JSON.parse(d1View.body).films.w1.actualRating,4);
}

probe.restore();

// A baseline entry that no probe ever matched with a non-empty effect list was fixed (or never real): it has to go, so the fix turns the route into a prohibition.
for(const entry of [...BASELINE,...MCP_BASELINE])for(const scenario of Object.keys(entry.effects))if(entry.effects[scenario].length&&!consumed.has(entry.id+'@'+scenario))failures.push('baseline '+entry.id+' lists effects for '+scenario+' that no request has any more; remove them');
const known=new Set([...readRoutes.map(route=>'GET '+route),...Object.keys(MCP_READ_TOOLS).map(tool=>'MCP '+tool)]);
for(const entry of [...BASELINE,...MCP_BASELINE]){
 assert.ok(entry.owner&&entry.summary&&['d1-write','r2-write','r2-d1-write','outbound-read'].includes(entry.kind),entry.id+' needs an owner, a summary and a kind');
 for(const route of entry.routes)assert.ok(known.has(route),entry.id+' names a route that is not in the inventory: '+route);
}

if(process.env.AUDIT_PRINT){
 const grouped={};
 for(const [id,found] of Object.entries(observed))if(found.length){const [head,scenario]=id.split(' @ ');(grouped[head]??={})[scenario]=found;}
 console.log(JSON.stringify(grouped,null,1));
 console.log(JSON.stringify(Object.fromEntries(Object.entries(statuses).filter(([id,status])=>status>=500&&id.startsWith('GET')&&/@ (r2|d1)$/.test(id))),null,1));
}
assert.equal(failures.length,0,failures.length+' read-side-effect finding(s):\n'+failures.join('\n'));
console.log('GET/HEAD audit: '+readRoutes.length+' read routes, '+postOnly.size+' POST-only routes asked with GET, '+PAGES.length+' pages, '+Object.keys(MCP_READ_TOOLS).length+' MCP read tools and '+MCP_WRITE_TOOLS.length+' write tools, '+names.length+' scenarios; '+(BASELINE.length+MCP_BASELINE.length)+' documented writer families');
