// Browser client of the archive preview route, behind the same Cloudflare Access session as the page. One same-origin POST
// of multipart form data per check the owner starts: the ZIP as `archive` and, for a renamed archive, the declared export
// time as `generatedAt`. It sends no credential, keeps nothing after the answer and never starts on page open: the archive
// and the answer live only in the page's memory until the owner resets or leaves the page.
const ARCHIVE_PREVIEW_API='/api/admin/letterboxd-archive/preview';
const ARCHIVE_CONFIRM_API='/api/admin/letterboxd-archive/apply-confirm';
const ARCHIVE_APPLY_API='/api/admin/letterboxd-archive/apply';
const ARCHIVE_ROLLBACK_CONFIRM_API='/api/admin/letterboxd-archive/rollback-confirm';
const ARCHIVE_ROLLBACK_API='/api/admin/letterboxd-archive/rollback';
const ARCHIVE_ACTION_HEADER='letterboxd_archive_apply';
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

function archiveForm(file,declared,fields){
 const form=new FormData();
 form.append('archive',file,file.name);
 const time=String(declared||'').trim();
 if(time)form.append('generatedAt',time);
 for(const [name,value] of Object.entries(fields||{}))form.append(name,value);
 return form;
}
function archiveIdempotencyKey(){
 const bytes=new Uint8Array(16);
 crypto.getRandomValues(bytes);
 let text='lb';
 for(const byte of bytes)text+=byte.toString(16).padStart(2,'0');
 return text;
}

// One same-origin POST. `expect` is the mode the answer must have. A write route also sends the action header; the
// Access assertion is added by the edge, never by this page.
async function archiveRequest(url,body,options,expect){
 const fetchImpl=options.fetch||globalThis.fetch;
 const headers={Accept:'application/json',...(options.action?{'X-IPTV-Admin-Action':ARCHIVE_ACTION_HEADER}:{}),...(options.json?{'Content-Type':'application/json'}:{})};
 let response;
 try{response=await fetchImpl(url,{method:'POST',body,headers,credentials:'same-origin',cache:'no-store',...(options.signal?{signal:options.signal}:{})});}
 catch(error){return {mode:error&&error.name==='AbortError'?'aborted':'error',error:error&&error.name==='AbortError'?'aborted':'network',detail:null,answer:null};}
 let payload=null;
 try{payload=await response.json();}catch{payload=null;}
 if(!response.ok){
  const error=payload&&typeof payload.error==='string'?payload.error:'http_'+response.status;
  return {mode:'error',error,detail:payload&&typeof payload==='object'?{code:typeof payload.code==='string'?payload.code:null,file:typeof payload.file==='string'?payload.file:null,record:Number.isInteger(payload.record)?payload.record:null,refusal:typeof payload.refusal==='string'?payload.refusal:null}:null,answer:null};
 }
 if(!payload||payload.mode!==expect)return {mode:'error',error:'unexpected_answer',detail:null,answer:null};
 if(expect==='preview'&&payload.writes!==false)return {mode:'error',error:'unexpected_answer',detail:null,answer:null};
 return {mode:'ready',error:null,detail:null,answer:payload};
}

async function postArchivePreview(file,declared,options={}){
 return archiveRequest(ARCHIVE_PREVIEW_API,archiveForm(file,declared),options,'preview');
}
async function postArchiveConfirm(file,declared,fields,options={}){
 return archiveRequest(ARCHIVE_CONFIRM_API,archiveForm(file,declared,fields),{...options,action:true},'apply_confirm');
}
async function postArchiveCommit(file,declared,confirmation,options={}){
 return archiveRequest(ARCHIVE_APPLY_API,archiveForm(file,declared,{confirmation:JSON.stringify(confirmation)}),{...options,action:true},'apply');
}
async function postArchiveRollbackConfirm(body,options={}){
 return archiveRequest(ARCHIVE_ROLLBACK_CONFIRM_API,JSON.stringify(body),{...options,action:true,json:true},'rollback_confirm');
}
async function postArchiveRollback(confirmation,options={}){
 return archiveRequest(ARCHIVE_ROLLBACK_API,JSON.stringify({confirmation}),{...options,action:true,json:true},'rollback');
}
