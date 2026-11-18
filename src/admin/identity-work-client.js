// Browser client of GET /api/admin/identity-work, behind the same Cloudflare Access session as the page. One GET per view and one more
// per "show more", the cursor under the pin the first page returned. It stores nothing, sends no credential and has no write method.
// A 409, a `stale_cursor` or a pin that differs from the held one is a stale list read: the page keeps what it shows and says so.
const IDENTITY_WORK_LIMIT=25;
function identityWorkParams(state,cursor){
 return {type:state.type||null,disposition:state.disposition||null,include:state.include&&!state.disposition?'resolved':null,q:state.q||null,limit:IDENTITY_WORK_LIMIT,cursor:cursor||null};
}
async function loadIdentityWork(state,cursor,options={}){
 const result=await adminCall('/identity-work',identityWorkParams(state,cursor),{fetch:options.fetch,signal:options.signal,pin:cursor?options.pin||null:null});
 if(result.error==='aborted')return {mode:'aborted',error:null};
 if(result.status===409||(result.status===400&&result.error==='stale_cursor'))return {mode:'stale',error:result.error==='stale_cursor'?'stale_cursor':'stale_pin'};
 if(!result.ok)return {mode:'error',error:result.error};
 const body=result.body||{};
 if(cursor&&options.pin&&body.pin&&body.pin!==options.pin)return {mode:'stale',error:'stale_pin'};
 return {mode:'ready',error:null,pin:body.pin||null,snapshot:body.snapshot||null,rows:Array.isArray(body.rows)?body.rows:[],nextCursor:body.nextCursor||null,coverage:body.coverage||{}};
}
