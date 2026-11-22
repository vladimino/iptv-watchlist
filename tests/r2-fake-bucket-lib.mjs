// A fake S3-compatible bucket over HTTP for the production R2 snapshot exporter (shared by tests/r2-snapshot-export.mjs and the AIR-554 converter test): paged ListObjectsV2, conditional HEAD and GET,
// independent signature verification, write refusal. Local stand-in only; no network beyond loopback.
import {createHash,createHmac} from 'node:crypto';
import http from 'node:http';
import {gzipSync} from 'node:zlib';

export const ACCOUNT='0123456789abcdef0123456789abcdef',ACCESS='test-access-key',SECRET='test-secret-key';
const sha256=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
export const envFor=endpoint=>({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:ACCESS,R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET,R2_SNAPSHOT_BUCKET:'iptv',R2_SNAPSHOT_ENDPOINT:endpoint});
export function fakeBucket(initial,{pageSize=3}={}){
 const items=new Map();
 let revision=0;
 const put=(key,bytes)=>{revision++;items.set(key,{bytes:Buffer.from(bytes),etag:sha256(Buffer.from(bytes)).slice(0,32)+'-'+revision,lastModified:new Date(Date.UTC(2026,9,26,0,0,revision)).toUTCString()});};
 for(const [key,bytes] of Object.entries(initial))put(key,bytes);
 const options={ignorePrefix:false};   // a misbehaving server that answers a prefixed listing with unrelated keys
 const calls={list:0,head:0,get:0,writes:0,badSignature:0,listPrefixes:[],touched:[]};
 const hooks=[];
 const escape=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 const rfc=value=>encodeURIComponent(value).replace(/[!'()*]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase());
 function verify(request,url){
  const header=request.headers.authorization||'';
  const match=header.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
  if(!match||match[1]!==ACCESS)return false;
  const [,,date,region,service,signedHeaders,signature]=match;
  const names=signedHeaders.split(';');
  const canonicalPath=url.pathname.split('/').map(segment=>rfc(decodeURIComponent(segment))).join('/')||'/';
  const query=[...url.searchParams.entries()].map(([name,value])=>[rfc(name),rfc(value)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:1).map(pair=>pair.join('=')).join('&');
  const canonical=[request.method,canonicalPath,query,...names.map(name=>name+':'+String(request.headers[name]??'').trim().replace(/\s+/g,' ')),'',signedHeaders,request.headers['x-amz-content-sha256']].join('\n');
  const scope=date+'/'+region+'/'+service+'/aws4_request';
  const stringToSign=['AWS4-HMAC-SHA256',request.headers['x-amz-date'],scope,sha256(canonical)].join('\n');
  const key=hmac(hmac(hmac(hmac('AWS4'+SECRET,date),region),service),'aws4_request');
  return createHmac('sha256',key).update(stringToSign).digest('hex')===signature&&request.headers['x-amz-content-sha256']===sha256('');
 }
 const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1');
  const [,bucketName,...rest]=url.pathname.split('/');
  const key=rest.length?rest.map(decodeURIComponent).join('/'):null;
  let etagOverride=null,compress=false;
  for(const hook of hooks){const result=await hook({method:request.method,key,url,calls,put,items,request});if(result==='drop'){request.socket.destroy();return;}if(typeof result==='number'){response.writeHead(result);response.end();return;}if(result&&typeof result==='object'&&result.etag)etagOverride=result.etag;if(result&&typeof result==='object'&&result.compress)compress=true;}
  if(!verify(request,url)){calls.badSignature++;response.writeHead(403);response.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');return;}
  if(bucketName!=='iptv'){response.writeHead(404);response.end();return;}
  if(request.method!=='GET'&&request.method!=='HEAD'){calls.writes++;response.writeHead(403);response.end('<Error><Code>AccessDenied</Code></Error>');return;}
  if(key===null){
   calls.list++;calls.listPrefixes.push(url.searchParams.get('prefix')||'');
   if(url.searchParams.get('list-type')!=='2'){response.writeHead(400);response.end();return;}
   const prefix=options.ignorePrefix?'':(url.searchParams.get('prefix')||''),keys=[...items.keys()].filter(item=>item.startsWith(prefix)).sort(),start=url.searchParams.has('continuation-token')?Number(Buffer.from(url.searchParams.get('continuation-token'),'base64').toString()):0;
   const limit=Math.min(pageSize,Number(url.searchParams.get('max-keys')||1000)),selected=keys.slice(start,start+limit),truncated=start+limit<keys.length;
   const body='<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>iptv</Name><KeyCount>'+selected.length+'</KeyCount><MaxKeys>'+limit+'</MaxKeys><IsTruncated>'+truncated+'</IsTruncated>'+(truncated?'<NextContinuationToken>'+Buffer.from(String(start+limit)).toString('base64')+'</NextContinuationToken>':'')+selected.map(item=>{const object=items.get(item);return '<Contents><Key>'+escape(item)+'</Key><LastModified>'+object.lastModified+'</LastModified><ETag>&quot;'+object.etag+'&quot;</ETag><Size>'+object.bytes.length+'</Size><StorageClass>STANDARD</StorageClass></Contents>';}).join('')+'</ListBucketResult>';
   response.writeHead(200,{'Content-Type':'application/xml','Content-Length':Buffer.byteLength(body)});response.end(body);return;
  }
  if(request.method==='HEAD')calls.head++;else calls.get++;
  calls.touched.push(key);
  const object=items.get(key);
  if(!object){response.writeHead(404);response.end();return;}
  const ifMatch=request.headers['if-match'];
  // Like Cloudflare's edge: unless the client asks for identity, the object is compressed on the fly, its ETag becomes weak,
  // Content-Length disappears and If-Match (a strong comparison) can never succeed.
  if(compress||request.headers['accept-encoding']!=='identity'){
   if(ifMatch){response.writeHead(412);response.end();return;}
   const body=gzipSync(object.bytes);
   response.writeHead(200,{ETag:'W/"'+object.etag+'"','Content-Encoding':'gzip','Last-Modified':object.lastModified,'Content-Type':'application/octet-stream'});
   if(request.method==='HEAD')response.end();else response.end(body);return;
  }
  if(!etagOverride&&ifMatch&&ifMatch.replace(/^"(.*)"$/,'$1')!==object.etag){response.writeHead(412);response.end();return;}
  response.writeHead(200,{ETag:'"'+(etagOverride||object.etag)+'"','Content-Length':object.bytes.length,'Last-Modified':object.lastModified,'Content-Type':'application/octet-stream'});
  if(request.method==='HEAD')response.end();else response.end(object.bytes);
 });
 return {items,calls,put,hooks,server,options,
  async start(){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;},
  async stop(){await new Promise(resolve=>server.close(resolve));}};
}
