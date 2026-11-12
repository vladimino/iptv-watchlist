// A small JSON Schema checker for the subset the repository's own offline contracts use (type, const, enum, required, properties, additionalProperties false, items, min/max, pattern, uniqueItems). Test helper only.
const typeOf=v=>v===null?'null':Array.isArray(v)?'array':Number.isInteger(v)?'integer':typeof v;
export function check(s,v,path='$'){
 const errors=[];const types=s.type===undefined?null:[].concat(s.type);
 if(s.const!==undefined&&v!==s.const)errors.push(path+' const');
 if(s.enum&&!s.enum.includes(v))errors.push(path+' enum');
 if(types&&!types.some(t=>t==='number'?typeof v==='number':typeOf(v)===t))return [path+' type '+typeOf(v)];
 if(typeof v==='number'){if(s.minimum!==undefined&&v<s.minimum)errors.push(path+' minimum');if(s.maximum!==undefined&&v>s.maximum)errors.push(path+' maximum');}
 if(typeof v==='string'){if(s.minLength!==undefined&&v.length<s.minLength)errors.push(path+' minLength');if(s.maxLength!==undefined&&v.length>s.maxLength)errors.push(path+' maxLength');if(s.pattern&&!new RegExp(s.pattern).test(v))errors.push(path+' pattern');}
 if(Array.isArray(v)){if(s.minItems!==undefined&&v.length<s.minItems)errors.push(path+' minItems');if(s.maxItems!==undefined&&v.length>s.maxItems)errors.push(path+' maxItems');if(s.uniqueItems&&new Set(v.map(x=>JSON.stringify(x))).size!==v.length)errors.push(path+' uniqueItems');if(s.items)v.forEach((x,i)=>errors.push(...check(s.items,x,path+'['+i+']')));}
 if(v&&typeof v==='object'&&!Array.isArray(v)){for(const k of s.required||[])if(!(k in v))errors.push(path+' missing '+k);for(const [k,x] of Object.entries(v)){if(s.properties?.[k])errors.push(...check(s.properties[k],x,path+'.'+k));else if(s.additionalProperties===false)errors.push(path+' extra '+k);}}
 return errors;
}
