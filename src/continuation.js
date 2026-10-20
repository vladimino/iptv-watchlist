// Public HTTP always reaches the default export. This entrypoint stays internal and runs one chunk; it does not schedule the next one.
export const DiscoveryContinuation={async fetch(request,env,execution){
 if(request.method!=='POST'||new URL(request.url).pathname!==new URL(DISCOVERY_CONTINUATION_URL).pathname)return json({error:'Not found'},404);
 if(!env.BUCKET)return json({error:'Storage unavailable'},503);
 let body;try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join()!=='chunks'||!Number.isInteger(body.chunks)||body.chunks<0||body.chunks>11)return json({error:'Invalid continuation'},400);
 try{return await resolveDiscoveryRequest(env,execution,{chunks:body.chunks});}catch(e){return json({error:String(e.message).slice(0,160)},502);}
}};
