const PRESET_KEY='ui/filter-presets.json';
const EMPTY_PRESET_ETAG='"none"';
const MAX_PRESETS=30;
const MAX_PRESET_NAME=80;
const MAX_PRESET_QUERY=4000;
const EXECUTION_PRESET_VALUES={
 plot_engine:['weak','medium','strong'],
 pace:['slow','medium','fast','variable'],
 stakes:['low','medium','high'],
 decision_logic:['weak','mixed','strong'],
 protagonist_competence:['low','mixed','high'],
 opposition_competence:['low','mixed','high'],
 problem_solving:['weak','medium','strong'],
 plan_counterplan_strength:['none','weak','medium','strong'],
 multi_party_goals:['none','weak','medium','strong'],
 chemistry:['weak','medium','strong'],
 payoff:['weak','mixed','strong'],
 ending_quality:['weak','mixed','strong'],
 technical_plausibility:['weak','mixed','strong'],
};
function presetHttpEtag(object){if(!object)return EMPTY_PRESET_ETAG;if(object.httpEtag)return object.httpEtag;const etag=String(object.etag||'');return etag.startsWith('"')?etag:`"${etag}"`;}
function barePresetEtag(value){return String(value||'').trim().replace(/^W\//,'').replace(/^"(.*)"$/,'$1');}
function cleanPresetText(value,max){if(typeof value!=='string')return '';const text=value.trim().replace(/\s+/g,' ');if(!text||text.length>max||/[\u0000-\u001f\u007f]/.test(text))return '';return text;}
function cleanPresetName(value){return cleanPresetText(value,MAX_PRESET_NAME);}
function uniquePresetValues(values){return [...new Set(values)];}
const PRESET_SEARCH_SCOPES=['titles','people','plot'];
function presetSearchScope(value){
 const selected=new Set(String(value||'').split(',').map(item=>item.trim()).filter(id=>PRESET_SEARCH_SCOPES.includes(id)));
 const ordered=PRESET_SEARCH_SCOPES.filter(id=>selected.has(id));
 return !ordered.length||(ordered.length===1&&ordered[0]==='titles')?'':ordered.join(',');
}
function normalizePresetQuery(input){
 const source=String(input??'');
 if(source.length>MAX_PRESET_QUERY)return null;
 const params=new URLSearchParams(source.replace(/^\?/,''));
 const url=new URL('https://iptv.example/');
 const add=(key,value)=>url.searchParams.append(key,String(value));
 if(params.get('shortlist')==='today')add('shortlist','today');
 if(params.get('view')==='watchlist')add('view','watchlist');
 if(['archive','future'].includes(params.get('period')))add('period',params.get('period'));
 const query=cleanPresetText(params.get('q')||'',200);if(query)add('q',query);
 const searchIn=presetSearchScope(params.get('searchIn'));if(searchIn)add('searchIn',searchIn);
 if(['personal','expiring','time','relevance','title'].includes(params.get('sort')))add('sort',params.get('sort'));
 for(const genre of uniquePresetValues(params.getAll('genre').map(value=>cleanPresetText(value,80)).filter(Boolean)).sort((a,b)=>a.localeCompare(b,'ru')))add('genre',genre);
 for(const mechanic of uniquePresetValues(params.getAll('mechanic').filter(value=>/^[a-z0-9_]{1,80}$/.test(value))).sort())add('mechanic',mechanic);
 for(const mood of uniquePresetValues(params.getAll('mood').filter(value=>/^[a-z0-9_]{1,80}$/.test(value))).sort((a,b)=>a.localeCompare(b,'ru')))add('mood',mood);
 for(const channel of uniquePresetValues(params.getAll('channel').map(value=>cleanPresetText(value,120)).filter(Boolean)).sort((a,b)=>a.localeCompare(b,'ru')))add('channel',channel);
 for(const [dimension,allowed] of Object.entries(EXECUTION_PRESET_VALUES))for(const value of allowed)if(params.getAll('execution').includes(`${dimension}:${value}`))add('execution',`${dimension}:${value}`);
 const year=key=>/^\d{4}$/.test(params.get(key)||'')?Number(params.get(key)):null;
 const from=year('from'),to=year('to');
 if(from!==null&&to!==null&&from>=1900&&to<=2100&&from<=to){if(from!==1900)add('from',from);if(to!==2100)add('to',to);}
 else {if(from!==null&&from>=1900&&from<=2100&&from!==1900&&to===null)add('from',from);if(to!==null&&to>=1900&&to<=2100&&to!==2100&&from===null)add('to',to);}
 const runtime=params.get('runtime');if(/^[1-9]\d*$/.test(runtime||'')&&Number.isSafeInteger(Number(runtime)))add('runtime',Number(runtime));
 if(['new','rewatch'].includes(params.get('viewing')))add('viewing',params.get('viewing'));
 if(params.get('started')==='1')add('started','1');
 if(params.get('lastChance')==='1')add('lastChance','1');
 for(const [key,param] of [['director','director'],['actor','actor']]){const id=params.get(param);if(id&&id.length<=200&&!/[\s#&?]/.test(id))add(key,id);}
 if(['3.5','4','4.5'].includes(params.get('prediction')))add('prediction',params.get('prediction'));
 if(['0.5','0.7','0.85'].includes(params.get('chance')))add('chance',params.get('chance'));
 return url.searchParams.toString();
}
function presetRecord(item){
 if(!item||typeof item!=='object'||typeof item.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id))return null;
 const name=cleanPresetName(item.name),query=normalizePresetQuery(item.query||'');
 if(!name||query===null)return null;
 const createdAt=typeof item.createdAt==='string'&&Number.isFinite(Date.parse(item.createdAt))?item.createdAt:null;
 const updatedAt=typeof item.updatedAt==='string'&&Number.isFinite(Date.parse(item.updatedAt))?item.updatedAt:createdAt;
 if(!createdAt||!updatedAt)return null;
 return {id:item.id,name,schemaVersion:1,query,createdAt,updatedAt};
}
function presetDocument(presets){return {schemaVersion:1,presets};}
function inspectPresetDocument(data){
 if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.presets)||data.presets.length>MAX_PRESETS)return {error:'Stored filter presets are unreadable'};
 const presets=[];
 for(const item of data.presets){const record=presetRecord(item);if(!record)return {error:'Stored filter presets are unreadable'};presets.push(record);}
 return {presets};
}
async function readPresetDocument(env){
 const object=await env.BUCKET.get(PRESET_KEY);
 if(!object)return {etag:EMPTY_PRESET_ETAG,presets:[],missing:true};
 let data;try{data=await object.json();}catch{return {etag:presetHttpEtag(object),error:'Stored filter presets are unreadable'};}
 const inspected=inspectPresetDocument(data);
 if(inspected.error)return {etag:presetHttpEtag(object),error:inspected.error};
 return {etag:presetHttpEtag(object),presets:inspected.presets,missing:false};
}
function presetJson(data,status=200,etag){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...(etag?{ETag:etag}:{})}});}
async function writePresetDocument(env,presets,ifMatch){
 const bare=barePresetEtag(ifMatch);
 const onlyIf=bare==='none'?{etagDoesNotMatch:'*'}:{etagMatches:bare};
 const stored=await env.BUCKET.put(PRESET_KEY,JSON.stringify(presetDocument(presets)),{onlyIf,httpMetadata:{contentType:'application/json'}});
 if(!stored)return null;
 return presetHttpEtag(stored);
}
async function filterPresetsRoute(request,env,url){
 const current=await readPresetDocument(env);
 if(current.error)return presetJson({error:current.error},500,current.etag);
 const item=url.pathname.slice('/api/ui/filter-presets/'.length);
 const id=item?decodeURIComponent(item):'';
 if(request.method==='GET'&&!id)return presetJson({schemaVersion:1,presets:current.presets},200,current.etag);
 if(id&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return presetJson({error:'Unknown filter preset'},404);
 if(!['POST','PATCH','DELETE'].includes(request.method))return presetJson({error:'Not found'},404);
 const origin=request.headers.get('Origin');
 if(origin&&origin!==url.origin)return presetJson({error:'Origin not allowed'},403);
 const ifMatch=request.headers.get('If-Match');
 if(!ifMatch)return presetJson({error:'If-Match required'},428);
 if(current.missing&&barePresetEtag(ifMatch)!=='none')return presetJson({error:'Filter presets changed',presets:[]},412,current.etag);
 let body=null;
 if(request.method!=='DELETE'){
  const raw=await request.text();
  if(raw.length>MAX_PRESET_QUERY+1000)return presetJson({error:'Request is too large'},400);
  try{body=JSON.parse(raw);}catch{return presetJson({error:'Invalid JSON'},400);}
  if(!body||typeof body!=='object'||Array.isArray(body))return presetJson({error:'Invalid request'},400);
 }
 const now=new Date().toISOString();
 const presets=current.presets.map(preset=>({...preset}));
 if(request.method==='POST'){
  if(presets.length>=MAX_PRESETS)return presetJson({error:'Too many filter presets'},400);
  const name=cleanPresetName(body.name),query=normalizePresetQuery(body.query||'');
  if(!name)return presetJson({error:'Invalid preset name'},400);
  if(query===null)return presetJson({error:'Invalid preset state'},400);
  presets.push({id:crypto.randomUUID(),name,schemaVersion:1,query,createdAt:now,updatedAt:now});
 }else{
  const index=presets.findIndex(preset=>preset.id===id);
  if(index<0)return presetJson({error:'Unknown filter preset'},404);
  if(request.method==='DELETE')presets.splice(index,1);
  else{
   const hasName=Object.hasOwn(body,'name'),hasQuery=Object.hasOwn(body,'query');
   if(!hasName&&!hasQuery)return presetJson({error:'Nothing to update'},400);
   if(hasName){const name=cleanPresetName(body.name);if(!name)return presetJson({error:'Invalid preset name'},400);presets[index].name=name;}
   if(hasQuery){const query=normalizePresetQuery(body.query||'');if(query===null)return presetJson({error:'Invalid preset state'},400);presets[index].query=query;}
   presets[index].updatedAt=now;
  }
 }
 const etag=await writePresetDocument(env,presets,ifMatch);
 if(!etag){const fresh=await readPresetDocument(env);return presetJson({error:'Filter presets changed',presets:fresh.presets||[]},412,fresh.etag);}
 return presetJson({schemaVersion:1,presets},request.method==='POST'?201:200,etag);
}
