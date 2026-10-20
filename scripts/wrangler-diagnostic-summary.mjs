import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const METHODS=['GET','POST','PUT','PATCH','DELETE','HEAD'];
const ALLOWED_SEGMENTS=new Set(['client','v4','accounts','users','tokens','verify','workers','scripts','settings','subdomain','routes','services','schedules','tails','versions','deployments','domains','memberships','iptv']);

export function summarizeWranglerLog(text){
 const requests=[];
 const seen=new Set();
 const urlPattern=new RegExp(`\\b(${METHODS.join('|')})\\s+(https://api\\.cloudflare\\.com/[^\\s"'<>]+)`,'gi');
 for(const match of text.matchAll(urlPattern))addRequest(requests,seen,match[1],match[2],text,match.index+match[0].length);
 const jsonPattern=/"method"\s*:\s*"(GET|POST|PUT|PATCH|DELETE|HEAD)"[\s\S]{0,240}?"url"\s*:\s*"(https:\/\/api\.cloudflare\.com\/[^"]+)"/gi;
 for(const match of text.matchAll(jsonPattern))addRequest(requests,seen,match[1],match[2],text,match.index+match[0].length);
 const lines=requests.map(item=>`${item.method} ${item.route} -> ${item.status} ${classify(item.status)}`);
 if(/Unable to fetch bindings, routes, or services metadata/i.test(text))lines.push('error: dashboard metadata fetch failed');
 return lines.length?lines.join('\n')+'\n':'error: no allowlisted diagnostic lines\n';
}
function addRequest(requests,seen,method,rawUrl,text,from){
 let url;try{url=new URL(rawUrl);}catch{return;}
 if(url.origin!=='https://api.cloudflare.com')return;
 const route=normalizeRoute(url.pathname);
 const status=nearbyStatus(text.slice(from,from+500));
 const line=`${method.toUpperCase()} ${route} -> ${status}`;
 if(seen.has(line))return;
 seen.add(line);
 requests.push({method:method.toUpperCase(),route,status});
}
function normalizeRoute(pathname){
 return pathname.split('/').map(segment=>{
  if(!segment)return '';
  if(ALLOWED_SEGMENTS.has(segment))return segment;
  if(/^[a-f0-9]{32}$/i.test(segment))return '{account_id}';
  return '{id}';
 }).join('/');
}
function nearbyStatus(window){
 const [first='',second='']=window.split('\n');
 const statusPattern=/(?:status(?:Code)?|HTTP\/1\.[01])["']?\s*[:=]\s*["']?([1-5]\d{2})\b/i;
 const same=first.match(statusPattern);
 if(same)return same[1];
 const next=second.match(new RegExp(`^\\s*${statusPattern.source}\\s*$`,'i'));
 return next?next[1]:'unknown';
}
function classify(status){
 if(status==='unknown')return 'status not found';
 if(status==='200')return 'ok';
 if(status==='401')return 'token rejected';
 if(status==='403')return 'permission denied';
 if(status==='404')return 'not found';
 if(status==='429')return 'rate limited';
 if(status.startsWith('5'))return 'cloudflare unavailable';
 return 'unexpected';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const token=process.env.CLOUDFLARE_API_TOKEN||'';
 let text='';
 try{text=readFileSync(process.argv[2],'utf8');}catch{process.stderr.write('Wrangler diagnostic log was not created. The deploy failure above is unchanged.\n');process.exit(0);}
 const summary=summarizeWranglerLog(text);
 if(token&&summary.includes(token))process.stdout.write('The diagnostic summary still contained the API token, so it was not published.\n');
 else process.stdout.write(summary);
}
