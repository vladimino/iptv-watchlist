export class MemoryBucket{
 constructor(){this.objects=new Map();}
 async put(key,body,options={}){
  const text=typeof body==='string'?body:Buffer.from(body).toString('utf8');
  this.objects.set(key,{text,customMetadata:{...(options.customMetadata||{})}});
 }
 async get(key){
  const item=this.objects.get(key);
  if(!item)return null;
  return {json:async()=>JSON.parse(item.text),text:async()=>item.text};
 }
 async delete(key){this.objects.delete(key);}
 async list(options={}){
  const keys=[...this.objects.keys()].filter(key=>!options.prefix||key.startsWith(options.prefix)).sort();
  return {objects:keys.map(key=>({key,customMetadata:this.objects.get(key).customMetadata})),truncated:false};
 }
}
