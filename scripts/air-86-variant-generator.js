// Historical AIR-86 variant generator, copied out of src/discovery.js when AIR-91 retired the optional search.
// The Worker does not load this file. scripts/air-86-replay.mjs evaluates it in the same vm as src/sources.js,
// which defines norm, so the frozen manifest docs/evidence/scored-resolver/air-86-replay-manifest.json stays reproducible.
// Do not import it from src/.
function candidateReleaseYear(value){if(value==null||value==='')return null;const number=Number(value);return Number.isFinite(number)?number:null;}
const CANDIDATE_NUMBER_WORDS={1:'один',2:'два',3:'три',4:'четыре',5:'пять',6:'шесть',7:'семь',8:'восемь',9:'девять',10:'десять',11:'одиннадцать',12:'двенадцать'};
function candidateSpellToken(text){
 const token=String(text||'').trim();
 if(!token||/[\s-]/u.test(token)||[...token].length>8)return null;
 if(/э/i.test(token))return token.replace(/э/g,'е').replace(/Э/g,'Е');
 if(/е/i.test(token))return token.replace(/е/g,'э').replace(/Е/g,'Э');
 return null;
}
function candidateSearchVariants(candidate){
 const title=String(candidate?.title||'').trim(),year=candidateReleaseYear(candidate?.year),out=[],seen=new Set();
 const push=(query,yearValue,reason)=>{const text=String(query||'').replace(/\s+/g,' ').trim();if(norm(text).length<3)return;const key=norm(text)+'|'+(yearValue??'');if(seen.has(key))return;seen.add(key);out.push({query:text,year:yearValue,reason});};
 const stem=title.match(/^(.*\p{L}.*)\s+([12])$/u),stemText=stem&&norm(stem[1]).length>=3?stem[1].trim():null;
 if(stemText)push(stemText,year,'part_suffix');
 const spelled=candidateSpellToken(title);if(spelled)push(spelled,year,'spelling_e');
 const stemSpelled=stemText?candidateSpellToken(stemText):null;if(stemSpelled)push(stemSpelled,year,'spelling_e');
 const lead=title.match(/^(\d{1,2})\s+(\p{L}.*)$/u);
 if(lead&&/\p{Script=Cyrillic}/u.test(lead[2])&&CANDIDATE_NUMBER_WORDS[Number(lead[1])])push(CANDIDATE_NUMBER_WORDS[Number(lead[1])]+' '+lead[2],year,'numeral');
 if(year!=null){push(title,year-1,'year_before');push(title,year+1,'year_after');}
 return out;
}
function variantHit(candidate,movie,variant){
 const release=Number(String(movie?.release_date||'').slice(0,4));
 if(candidate?.year&&release&&Math.abs(release-Number(candidate.year))>1)return false;
 const titles=[movie?.title,movie?.original_title].map(norm).filter(Boolean),wanted=[norm(variant?.query),candidate?.normalizedTitle].filter(Boolean);
 if(titles.some(title=>wanted.includes(title)))return true;
 const observed=candidate?.normalizedTitle||'';
 return !!observed&&titles.some(title=>title.startsWith(observed+' ')||observed.startsWith(title+' '));
}
function variantAliasRank(candidate,movies){
 const observed=new Set(norm(candidate?.normalizedTitle||candidate?.title||'').split(' ').filter(Boolean)),durations=[...(candidate?.durations||[]),candidate?.duration].filter(value=>Number.isFinite(value)),year=candidateReleaseYear(candidate?.year);
 return movies.filter(movie=>movie?.id!=null).map(movie=>{
  const release=candidateReleaseYear(String(movie.release_date||'').slice(0,4));
  if(year!=null&&release!=null&&Math.abs(release-year)>1)return null;
  const runtime=Number(movie.runtime),runtimeDistance=Number.isFinite(runtime)&&durations.length?Math.min(...durations.map(value=>Math.abs(runtime-value))):1000;
  const shared=norm((movie.title||'')+' '+(movie.original_title||'')).split(' ').filter(Boolean).filter(token=>observed.has(token)).length;
  return {movie,yearDistance:year!=null&&release!=null?Math.abs(release-year):1,runtimeDistance,shared};
 }).filter(Boolean).sort((a,b)=>a.yearDistance-b.yearDistance||a.runtimeDistance-b.runtimeDistance||b.shared-a.shared||String(a.movie.id).localeCompare(String(b.movie.id)));
}
