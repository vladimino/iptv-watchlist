// The one POST of the catalogue page. It is not part of the shared GET client, so the limbo, poster and recovery
// bundles do not carry this write. The action header is the same token the route requires.
async function adminPost(path,body,options={}){
 const fetchImpl=options.fetch||globalThis.fetch;
 let response;
 try{response=await fetchImpl(ADMIN_API+path,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-IPTV-Admin-Action':'person_name_review'},credentials:'same-origin',body:JSON.stringify(body),...(options.signal?{signal:options.signal}:{})});}
 catch(error){return {ok:false,status:0,error:error&&error.name==='AbortError'?'aborted':'network',body:null};}
 let payload=null;
 try{payload=await response.json();}catch{payload=null;}
 if(!response.ok)return {ok:false,status:response.status,error:payload&&typeof payload.error==='string'?payload.error:'http_'+response.status,body:payload};
 return {ok:true,status:response.status,error:null,body:payload};
}
