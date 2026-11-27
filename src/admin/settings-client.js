// Browser client of the /admin/settings page (card CU, AIR-611), behind the same Cloudflare Access session as the page. `loadCatalogSettings` is one GET of the effective state at /api/admin/settings; `catalogSettingsAction` is one
// explicit POST to the existing owner route /api/admin/settings/catalog-enrichment (pause, resume or retry only: activation is not reachable from here). It sends no credential and no token: the browser session is the only
// authorization, and the route's own guards (Access JWT, owner, Origin, action header) decide what is written. It never resubmits.
const CATALOG_SETTINGS_ROUTE='/api/admin/settings/catalog-enrichment';
const CATALOG_SETTINGS_ACTION_HEADER='catalog_enrichment_settings';
const CATALOG_SETTINGS_ACTIONS=['pause','resume','retry'];
// Pre-write refusals the route itself types (method, Origin, action header, content type, Access, body validation) and the three 503 codes it answers before any statement runs.
const CATALOG_SETTINGS_REFUSAL_STATUS=[400,401,403,404,405,415];
const CATALOG_SETTINGS_PREWRITE_503=['schema_missing','control_unavailable','unavailable'];
async function loadCatalogSettings(options={}){
 return adminCall('/settings',{},{fetch:options.fetch,signal:options.signal});
}
// One POST. `evidence` is what the ANSWER proves about the command, never what a later read shows:
//   applied   a well-formed 200 `outcome: applied` that echoes this action and request id (a known commit; `readbackUnavailable` says only the server's own readback failed)
//   rejected  a 409 `outcome: rejected` (a compare-and-swap refusal: nothing was written)
//   refused   a typed pre-write refusal (nothing was written)
//   unknown   everything else: a network failure, a non-JSON body (an Access login page, a 502), an unclassified 5xx, a malformed envelope, `outcome: unknown`. A transport or server failure is not proof of a rollback.
async function catalogSettingsAction(body,options={}){
 if(!body||!CATALOG_SETTINGS_ACTIONS.includes(body.action))return {evidence:'refused',ok:false,status:0,error:'invalid_action',outcome:null,readbackUnavailable:false,body:null};
 const fetchImpl=options.fetch||globalThis.fetch;
 let response;
 try{response=await fetchImpl(CATALOG_SETTINGS_ROUTE,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-IPTV-Admin-Action':CATALOG_SETTINGS_ACTION_HEADER},credentials:'same-origin',body:JSON.stringify(body)});}
 catch(error){return {evidence:'unknown',ok:false,status:0,error:'network',outcome:null,readbackUnavailable:false,body:null};}
 let parsed=null;
 try{parsed=await response.json();}catch{parsed=null;}
 const object=!!parsed&&typeof parsed==='object'&&!Array.isArray(parsed);
 const outcome=object&&typeof parsed.outcome==='string'?parsed.outcome:null;
 const error=object&&typeof parsed.error==='string'?parsed.error:null;
 let evidence='unknown';
 if(response.ok){
  if(object&&response.status===200&&parsed.ok===true&&outcome==='applied'&&parsed.action===body.action&&parsed.requestId===body.requestId)evidence='applied';
 }else if(object&&response.status===409&&outcome==='rejected')evidence='rejected';
 else if(object&&error&&outcome!=='unknown'&&(CATALOG_SETTINGS_REFUSAL_STATUS.includes(response.status)||(response.status===503&&CATALOG_SETTINGS_PREWRITE_503.includes(error))))evidence='refused';
 return {evidence,ok:evidence==='applied',status:response.status,error:error||(response.ok?null:'http_'+response.status),outcome,readbackUnavailable:evidence==='applied'&&parsed.readbackUnavailable===true,body:object?parsed:null};
}
