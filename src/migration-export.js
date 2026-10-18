// Read-only source-R2 bridge. Disabled unless explicitly enabled for the old Site.
const MIGRATION_SOURCE_SITE_ID='appgprj_6abfed826e148191903dec4175166ff7';
const migrationJson=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const migrationMetadata=object=>({key:object.key,size:object.size,etag:object.etag,version:object.version||null,uploaded:object.uploaded?.toISOString?.()||null,httpMetadata:object.httpMetadata||{},customMetadata:object.customMetadata||{},storageClass:object.storageClass||null});
function migrationEqualSecret(left,right){
 if(typeof left!=='string'||typeof right!=='string'||!left||left.length!==right.length)return false;
 let difference=0;for(let index=0;index<left.length;index++)difference|=left.charCodeAt(index)^right.charCodeAt(index);return difference===0;
}
async function migrationExportRoute(request,env,url){
 // The Sites access policy must also remain owner-only. This additional key is
 // deliberately absent from the new Cloudflare Worker environment.
 if(url.origin!=='https://iptv.vladimino.chatgpt.site'||env.MIGRATION_EXPORT_SITE_ID!==MIGRATION_SOURCE_SITE_ID||env.MIGRATION_EXPORT_ENABLED!=='true'||!migrationEqualSecret(env.MIGRATION_EXPORT_KEY,request.headers.get('X-Migration-Export-Key')))return migrationJson({error:'Not found'},404);
 if(request.method!=='GET')return migrationJson({error:'Method not allowed'},405);
 try{
  if(url.pathname==='/api/migration-export/list'){
   const cursor=url.searchParams.get('cursor');if(cursor!==null&&(!cursor||cursor.length>8192))return migrationJson({error:'Invalid cursor'},400);
   const page=await env.BUCKET.list({limit:100,include:['httpMetadata','customMetadata'],...(cursor?{cursor}:{})});
   if(page.truncated&&!page.cursor)return migrationJson({error:'Incomplete listing page'},502);
   return migrationJson({objects:page.objects.map(migrationMetadata),truncated:!!page.truncated,nextCursor:page.truncated?page.cursor:null});
  }
  if(url.pathname==='/api/migration-export/head'||url.pathname==='/api/migration-export/object'){
   const key=url.searchParams.get('key'),etag=url.searchParams.get('etag'),version=url.searchParams.get('version');
   if(key===null||!key||key.length>1024||!etag||etag.length>256||!version||version.length>256)return migrationJson({error:'Invalid object selector'},400);
   if(url.pathname.endsWith('/head')){
    const object=await env.BUCKET.head(key);
    if(!object)return migrationJson({error:'Object missing'},409);
    if(object.etag!==etag||object.version!==version)return migrationJson({error:'Object changed'},409);
    return migrationJson(migrationMetadata(object));
   }
   const object=await env.BUCKET.get(key,{onlyIf:{etagMatches:etag}});
   if(!object||!object.body||object.etag!==etag||object.version!==version)return migrationJson({error:'Object changed or missing'},409);
   return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Migration-Etag':object.etag,'X-Migration-Version':object.version,'X-Migration-Size':String(object.size)}});
  }
  return migrationJson({error:'Not found'},404);
 }catch{return migrationJson({error:'Export read failed'},502);}
}
