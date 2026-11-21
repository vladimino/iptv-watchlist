// Browser client of the Channel admin API (AIR-562), behind the same Cloudflare Access session as the page. Reads are GETs; every write is one same-origin
// JSON POST with the admin action header, an explicit confirm and the revision the page holds. Nothing is stored here and no credential is sent. The page
// sends only normalized {sourceId,name,group} entries: a stream URL, a token or the raw playlist never reaches this client.
const CHANNELS_API='/api/admin/channels';
const CHANNELS_ACTION_HEADER='epg_channel_admin';
function channelsRequestId(){const bytes=new Uint8Array(12);crypto.getRandomValues(bytes);let text='ch';for(const byte of bytes)text+=byte.toString(16).padStart(2,'0');return text;}
async function channelsSha256(text){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
 return [...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function channelsCall(path,init,options){
 const fetchImpl=(options&&options.fetch)||globalThis.fetch;
 let response;
 try{response=await fetchImpl(CHANNELS_API+path,{credentials:'same-origin',cache:'no-store',...init,...(options&&options.signal?{signal:options.signal}:{})});}
 catch(error){return {ok:false,status:0,error:error&&error.name==='AbortError'?'aborted':'network',body:null};}
 let body=null;
 try{body=await response.json();}catch{body=null;}
 if(!response.ok)return {ok:false,status:response.status,error:body&&typeof body.error==='string'?body.error:'http_'+response.status,body};
 return {ok:true,status:response.status,error:null,body};
}
function channelsQuery(params){
 const search=new URLSearchParams();
 for(const [name,value] of Object.entries(params||{}))if(value!==null&&value!==undefined&&value!=='')search.set(name,String(value));
 const text=search.toString();
 return text?'?'+text:'';
}
async function getChannels(params,options){return channelsCall(channelsQuery(params),{headers:{Accept:'application/json'}},options);}
function postChannels(path,body,options){
 return channelsCall(path,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-IPTV-Admin-Action':CHANNELS_ACTION_HEADER},body:JSON.stringify(body)},options);
}
const previewChannelImport=(submission,options)=>postChannels('/preview',{groups:submission.groups,entries:submission.entries},options);
const commitChannelImport=(submission,fields,options)=>postChannels('/import',{groups:submission.groups,entries:submission.entries,sourceSha256:fields.sourceSha256,expectedRevision:fields.expectedRevision,requestId:fields.requestId,confirm:true},options);
const saveChannelOverride=(fields,options)=>postChannels('/override',{channelId:fields.channelId,policy:fields.policy,note:fields.note||null,expectedRevision:fields.expectedRevision,requestId:fields.requestId,confirm:true},options);
const saveChannelCategory=(fields,options)=>postChannels('/category',{channelId:fields.channelId,categoryKey:fields.categoryKey,note:fields.note||null,expectedRevision:fields.expectedRevision,requestId:fields.requestId,confirm:true},options);
