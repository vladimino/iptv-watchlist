// Neutral S3-API store over the R2 bucket, shared by the read-only offline installer dry run
// (scripts/discovery-ledger-install.mjs) and the prediction-domain production operator
// (scripts/prediction-domain-production.mjs). It has no side effects on import. Writes and deletes exist only for keys named in
// `allowedWrites` / `allowedDeletes`; the Discovery installer passes neither, so it can only read.
import {createHash} from 'node:crypto';
import {parseListing,readCredentials,signRequest} from './r2-snapshot-export.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const unquote=etag=>etag==null?null:String(etag).trim().replace(/^"(.*)"$/,'$1');
const quote=etag=>/^".*"$/.test(etag)?etag:'"'+etag+'"';
const TRANSIENT=new Set([429,500,502,503,504]);
export class InstallError extends Error{constructor(message,exitCode=1){super(message);this.name='InstallError';this.exitCode=exitCode;}}
// The write credential is separate from the snapshot one; only the prediction-domain production operator reads it.
export function readInstallCredentials(env=process.env){
 if(!String(env.R2_INSTALL_ACCESS_KEY_ID||'').trim()||!String(env.R2_INSTALL_SECRET_ACCESS_KEY||'').trim())throw new InstallError('R2_INSTALL_ACCESS_KEY_ID and R2_INSTALL_SECRET_ACCESS_KEY are required',2);
 return readCredentials({...env,R2_SNAPSHOT_ACCESS_KEY_ID:env.R2_INSTALL_ACCESS_KEY_ID,R2_SNAPSHOT_SECRET_ACCESS_KEY:env.R2_INSTALL_SECRET_ACCESS_KEY,R2_SNAPSHOT_ACCOUNT_ID:env.R2_INSTALL_ACCOUNT_ID||env.R2_SNAPSHOT_ACCOUNT_ID});
}

// An R2-binding-like store over the S3 API: get, head, put with onlyIf, list with prefix. Writes exist only when
// `allowedWrites` names the key; everything else is refused before a request is built.
export function createS3Store({credentials,fetchImpl=fetch,allowedWrites=null,allowedDeletes=null,now=()=>new Date(),retries=4,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
 const calls={list:0,head:0,get:0,put:0,refusedWrites:0},writes=[];
 async function send(method,key,query,headers={},body=null){
  const url=new URL(credentials.endpoint);
  url.pathname='/'+encodeURIComponent(credentials.bucket)+(key==null?'':'/'+key.split('/').map(segment=>encodeURIComponent(segment).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())).join('/'));
  for(const [name,value] of Object.entries(query||{}))if(value!=null)url.searchParams.set(name,value);
  const payloadHash=body==null?sha256(''):sha256(body);
  for(let attempt=0;;attempt++){
   const signed=signRequest({method,url,headers:{'Accept-Encoding':'identity',...headers},payloadHash,credentials,now:now()});
   let response;
   const once=method==='PUT'||method==='DELETE';
   try{response=await fetchImpl(url,{method,headers:signed,body:body??undefined,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(600000)});}
   catch{if(attempt<retries&&!once){await sleep(100*2**attempt);continue;}throw new InstallError('Request failed'+(once?' during a write; the outcome is unknown, re-run the dry-run before any retry':' after retries'));}
   if(TRANSIENT.has(response.status)&&attempt<retries&&!once){await response.body?.cancel();await sleep(100*2**attempt);continue;}
   if(response.status===412){await response.body?.cancel();return null;}
   if(response.status===404&&key!=null&&method!=='PUT'){await response.body?.cancel();return null;}
   if(response.status===401||response.status===403){await response.body?.cancel();throw new InstallError('Credential was refused by the bucket ('+method+')',3);}
   if(!response.ok){await response.body?.cancel();throw new InstallError(method+' failed with HTTP '+response.status);}
   return response;
  }
 }
 const metadata=response=>{const etag=unquote(response.headers.get('etag'));if(!etag||/^W\//.test(String(response.headers.get('etag'))))throw new InstallError('Object response lacks a strong ETag');return {etag,size:Number(response.headers.get('content-length'))};};
 return {
  calls,writes,
  async get(key){calls.get++;const response=await send('GET',key);if(!response)return null;const bytes=Buffer.from(await response.arrayBuffer()),meta=metadata(response);return {...meta,json:async()=>JSON.parse(bytes.toString('utf8')),text:async()=>bytes.toString('utf8'),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)};},
  async head(key){calls.head++;const response=await send('HEAD',key);if(!response)return null;await response.body?.cancel();return metadata(response);},
  async put(key,value,options={}){
   if(!allowedWrites||!allowedWrites.has(key)){calls.refusedWrites++;throw new InstallError('Write refused: '+key+' is not an allowed key',3);}
   const c=options.onlyIf||{},headers={'Content-Type':options.httpMetadata?.contentType||'application/json'};
   if(c.etagDoesNotMatch==='*')headers['If-None-Match']='*';
   else if(c.etagMatches)headers['If-Match']=quote(c.etagMatches);
   else throw new InstallError('Write refused: '+key+' has no precondition',3);
   calls.put++;
   const body=Buffer.from(typeof value==='string'?value:value,'utf8'),response=await send('PUT',key,null,headers,body);
   if(!response)return null;
   await response.body?.cancel();
   const meta=metadata(response);writes.push({key,etag:meta.etag,sha256:sha256(body),bytes:body.length,at:now().toISOString()});
   return {etag:meta.etag};
  },
  async list({prefix=''}={}){
   const objects=[];let cursor=null;
   do{calls.list++;const response=await send('GET',null,{'list-type':'2','max-keys':'1000',...(prefix?{prefix}:{}),...(cursor?{'continuation-token':cursor}:{})});const page=parseListing(await response.text());objects.push(...page.objects);cursor=page.truncated?page.nextCursor:null;}while(cursor);
   return {objects:objects.map(o=>({key:o.key,size:o.size,etag:o.etag})),truncated:false};
  },
  // ONE page of a listing (AIR-608): the caller follows the continuation itself, so it can bound the page count and refuse a truncated page that carries no (or a repeated) continuation token.
  async listPage({prefix='',cursor=null,limit=1000}={}){
   calls.list++;
   const response=await send('GET',null,{'list-type':'2','max-keys':String(limit),...(prefix?{prefix}:{}),...(cursor?{'continuation-token':cursor}:{})});
   const page=parseListing(await response.text());
   return {objects:page.objects.map(o=>({key:o.key,size:o.size,etag:o.etag})),truncated:Boolean(page.truncated),cursor:page.truncated?(page.nextCursor??null):null};
  },
  async delete(key){
   if(!allowedDeletes||!allowedDeletes.has(key)){calls.refusedWrites++;throw new InstallError('Delete refused: this store never deletes outside its allowlist',3);}
   calls.delete=(calls.delete||0)+1;
   const response=await send('DELETE',key);
   if(response)await response.body?.cancel();
  }
 };
}

