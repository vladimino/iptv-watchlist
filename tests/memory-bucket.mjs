export class MemoryBucket{
 constructor(){this.objects=new Map();}
 async put(key,body,options={}){
  const text=typeof body==='string'?body:Buffer.from(body).toString('utf8');
  this.objects.set(key,{text,customMetadata:{...(options.customMetadata||{})}});
 }
 async get(key){
  const item=this.objects.get(key);
  if(!item)return null;
  return {etag:etagOf(item.text),json:async()=>JSON.parse(item.text),text:async()=>item.text};
 }
 async head(key){const item=this.objects.get(key);return item?{etag:etagOf(item.text),customMetadata:{...item.customMetadata}}:null;}
 async delete(key){this.objects.delete(key);}
 async list(options={}){
  const keys=[...this.objects.keys()].filter(key=>!options.prefix||key.startsWith(options.prefix)).sort();
  return {objects:keys.map(key=>({key,customMetadata:this.objects.get(key).customMetadata})),truncated:false};
 }
}
// A content etag, as R2 gives one per stored version: any change of the bytes changes it.
function etagOf(text){let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);return (hash>>>0).toString(16)+'-'+text.length;}
