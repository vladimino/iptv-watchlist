// The one write on the catalogue page: a confirmed preferred title for the open film. The page builds the command.
// A network failure is `error: 'network'` so the page can repeat the same requestId. No credential is attached;
// the browser session is the only authorization.
async function adminSaveFilmTitle(storedId,body){
 let response;
 try{response=await fetch(ADMIN_API+'/films/'+encodeURIComponent(storedId)+'/title-review',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-IPTV-Admin-Action':'film_title_review'},credentials:'same-origin',body:JSON.stringify(body)});}
 catch{return {ok:false,status:0,error:'network',body:null};}
 let payload=null;
 try{payload=await response.json();}catch{payload=null;}
 const reason=payload&&(payload.reason||payload.error)||null;
 return {ok:response.ok&&!!(payload&&payload.ok),status:response.status,error:reason,body:payload};
}
