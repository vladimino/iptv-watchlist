const SOURCES={epg:'https://example.invalid/epg.xml',watchlist:'https://letterboxd.com/demo-user/watchlist/'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname==='/api/source-check'&&request.method==='POST'){
  const result={checkedAt:new Date().toISOString(),sources:{},storage:!!env.BUCKET};
  for(const [name,href] of Object.entries(SOURCES)){
   try{const r=await fetch(href,{signal:AbortSignal.timeout(30000)});const reader=r.body?.getReader();let text='';const decoder=new TextDecoder();while(reader&&text.length<160000){const {done,value}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});if(name==='epg'&&text.includes('<tv>'))break;}await reader?.cancel();result.sources[name]={status:r.status,contentType:r.headers.get('content-type'),valid:name==='epg'?text.includes('<tv>'):text.includes('js-watchlist-count'),count:name==='watchlist'?text.match(/js-watchlist-count[^>]*>([\d,]+)/)?.[1]:undefined};}catch(e){result.sources[name]={error:e.message};}
  }
  return json(result);
 }
 const asset=ASSETS[url.pathname];if(asset&&request.method==='GET')return new Response(asset.body,{headers:{'Content-Type':asset.type+'; charset=utf-8'}});
 return json({error:'Not found'},404);
}};
