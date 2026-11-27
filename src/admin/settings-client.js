// Browser client of the /admin/settings page (card CU, AIR-611), behind the same Cloudflare Access session as the page. `loadCatalogSettings` is one GET of the effective state at /api/admin/settings; `catalogSettingsAction` is one
// explicit POST to the existing owner route /api/admin/settings/catalog-enrichment (pause, resume or retry only: activation is not reachable from here). It sends no credential and no token: the browser session is the only
// authorization, and the route's own guards (Access JWT, owner, Origin, action header) decide what is written.
const CATALOG_SETTINGS_ROUTE='/api/admin/settings/catalog-enrichment';
const CATALOG_SETTINGS_ACTION_HEADER='catalog_enrichment_settings';
const CATALOG_SETTINGS_ACTIONS=['pause','resume','retry'];
async function loadCatalogSettings(options={}){
 return adminCall('/settings',{},{fetch:options.fetch,signal:options.signal});
}
// One POST. The answer is {ok, status, error, body}; `outcome` is the server's own readback word (`applied`, `rejected`, `unknown`) or null; a body that is not JSON is `null`.
async function catalogSettingsAction(body,options={}){
 if(!body||!CATALOG_SETTINGS_ACTIONS.includes(body.action))return {ok:false,status:0,error:'invalid_action',outcome:null,body:null};
 const fetchImpl=options.fetch||globalThis.fetch;
 let response;
 try{response=await fetchImpl(CATALOG_SETTINGS_ROUTE,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-IPTV-Admin-Action':CATALOG_SETTINGS_ACTION_HEADER},credentials:'same-origin',body:JSON.stringify(body)});}
 catch(error){return {ok:false,status:0,error:'network',outcome:'unknown',body:null};}
 let parsed=null;
 try{parsed=await response.json();}catch{parsed=null;}
 const outcome=parsed&&typeof parsed.outcome==='string'?parsed.outcome:null;
 if(!response.ok)return {ok:false,status:response.status,error:parsed&&typeof parsed.error==='string'?parsed.error:'http_'+response.status,outcome,body:parsed};
 return {ok:true,status:response.status,error:null,outcome,body:parsed};
}
