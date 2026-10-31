// Browser client of the archive preview route, behind the same Cloudflare Access session as the page. One same-origin POST
// of multipart form data per check the owner starts: the ZIP as `archive` and, for a renamed archive, the declared export
// time as `generatedAt`. It sends no credential, keeps nothing after the answer and never starts on page open: the archive
// and the answer live only in the page's memory until the owner resets or leaves the page.
const ARCHIVE_PREVIEW_API='/api/admin/letterboxd-archive/preview';
const ARCHIVE_CLIENT_MAX_BYTES=10*1024*1024;
const ARCHIVE_STANDARD_NAME=/^letterboxd-[A-Za-z0-9_-]+-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-utc\.zip$/;

// What the page can tell before sending anything: no file, not a ZIP, too large, a renamed archive without a time.
function archiveLocalCheck(file,declared){
 if(!file)return {error:'file_required'};
 const name=String(file.name||'');
 if(!/\.zip$/i.test(name))return {error:'not_zip_name'};
 if(typeof file.size==='number'&&file.size>ARCHIVE_CLIENT_MAX_BYTES)return {error:'archive_too_large'};
 const standard=ARCHIVE_STANDARD_NAME.test(name),time=String(declared||'').trim();
 if(standard&&time)return {error:'generated_at_conflict'};
 if(!standard&&!time)return {error:'generated_at_required'};
 return {error:null,standard};
}

// The answer is {mode, error, detail, answer}: `ready` with the preview, `error` with the server code (or `network`,
// `http_<status>`) and the code's detail, `aborted` when the owner cancelled.
async function postArchivePreview(file,declared,options={}){
 const fetchImpl=options.fetch||globalThis.fetch;
 const form=new FormData();
 form.append('archive',file,file.name);
 const time=String(declared||'').trim();
 if(time)form.append('generatedAt',time);
 let response;
 try{response=await fetchImpl(ARCHIVE_PREVIEW_API,{method:'POST',body:form,headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',...(options.signal?{signal:options.signal}:{})});}
 catch(error){return {mode:error&&error.name==='AbortError'?'aborted':'error',error:error&&error.name==='AbortError'?'aborted':'network',detail:null,answer:null};}
 let body=null;
 try{body=await response.json();}catch{body=null;}
 if(!response.ok){
  const error=body&&typeof body.error==='string'?body.error:'http_'+response.status;
  return {mode:'error',error,detail:body&&typeof body==='object'?{code:typeof body.code==='string'?body.code:null,file:typeof body.file==='string'?body.file:null,record:Number.isInteger(body.record)?body.record:null}:null,answer:null};
 }
 if(!body||body.mode!=='preview'||body.writes!==false)return {mode:'error',error:'unexpected_answer',detail:null,answer:null};
 return {mode:'ready',error:null,detail:null,answer:body};
}
