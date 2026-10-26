// Offline parser of a Letterboxd account export (the CSV files of the account data download).
// Pure: no file system, network or storage access. Only watched, ratings and watchlist are imported;
// diary is counted as auxiliary input. Profile, comments, reviews, likes and the deleted/orphaned
// folders are never read by the caller and have no parser here.
export const EXPORT_FILES=Object.freeze({watched:'watched.csv',ratings:'ratings.csv',watchlist:'watchlist.csv',diary:'diary.csv'});
export const IMPORTED_KINDS=Object.freeze(['watched','ratings','watchlist']);
const BASE=['Date','Name','Year','Letterboxd URI'];
const COLUMNS={watched:BASE,ratings:[...BASE,'Rating'],watchlist:BASE,diary:[...BASE,'Rating','Watched Date']};
const URI=/^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/;

export class CsvError extends Error{constructor(message,record){super(message);this.name='CsvError';this.record=record;}}

// RFC 4180: comma separator, CRLF or LF records, double-quoted fields with "" escapes and embedded newlines.
// A quote inside an unquoted field, text after a closing quote or an unterminated quote is malformed input.
export function parseCsv(text){
 const s=String(text??'').replace(/^﻿/,''),rows=[];let row=[],field='',quoted=false,closed=false,i=0;
 const endField=()=>{row.push(field);field='';closed=false;};
 while(i<s.length){
  const c=s[i];
  if(quoted){
   if(c==='"'){if(s[i+1]==='"'){field+='"';i+=2;continue;}quoted=false;closed=true;i++;continue;}
   field+=c;i++;continue;
  }
  if(c===','){endField();i++;continue;}
  if(c==='\r'||c==='\n'){endField();rows.push(row);row=[];i+=c==='\r'&&s[i+1]==='\n'?2:1;continue;}
  if(closed)throw new CsvError('Text after a closing quote',rows.length+1);
  if(c==='"'){if(field!=='')throw new CsvError('Quote inside an unquoted field',rows.length+1);quoted=true;i++;continue;}
  field+=c;i++;
 }
 if(quoted)throw new CsvError('Unterminated quoted field',rows.length+1);
 if(field!==''||closed||row.length){endField();rows.push(row);}
 return rows.filter(cells=>!(cells.length===1&&cells[0]===''));
}

const validDate=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value;};
export function parseRating(value){const text=String(value??'').trim();if(!/^\d(\.\d)?$/.test(text))return null;const n=Number(text);return n>=0.5&&n<=5&&Number.isInteger(n*2)?n:null;}

function normalizeRow(kind,col,width,cells){
 if(cells.length!==width)return {reason:'column_count'};
 const get=name=>String(cells[col[name]]??'').trim(),uri=get('Letterboxd URI'),match=uri.match(URI);
 if(!match)return {reason:'invalid_uri'};
 const name=get('Name');if(!name)return {reason:'missing_name'};
 const yearText=get('Year');if(yearText&&!/^\d{4}$/.test(yearText))return {reason:'invalid_year'};
 const date=get('Date');if(date&&!validDate(date))return {reason:'invalid_date'};
 const row={uri,code:match[1],name,year:yearText?Number(yearText):null};
 if(kind==='watched'&&date)row.watchedDate=date;
 if(kind==='ratings'){const rating=parseRating(get('Rating'));if(rating===null)return {reason:'invalid_rating'};row.rating=rating;}
 if(kind==='diary'){const watched=get('Watched Date');if(watched&&!validDate(watched))return {reason:'invalid_date'};if(get('Rating')&&parseRating(get('Rating'))===null)return {reason:'invalid_rating'};}
 return {row};
}

// One file: header check, row validation and per-code de-duplication. A repeated identical row is a duplicate;
// a repeated code with a different rating, name or year is a conflict and the code is withheld from that file.
function readFile(kind,text){
 const stats={present:true,records:0,valid:0,invalid:{},duplicates:0,conflicts:0,missingYear:0},invalidRows=[],rows=new Map(),conflicted=new Set();
 let table;
 try{table=parseCsv(text);}catch(error){throw error instanceof CsvError?new CsvError(EXPORT_FILES[kind]+': '+error.message,error.record):error;}
 if(!table.length)throw new CsvError(EXPORT_FILES[kind]+' has no header',1);
 const header=table[0].map(cell=>cell.trim()),col={};
 for(const name of COLUMNS[kind]){const at=header.indexOf(name);if(at<0)throw new CsvError(EXPORT_FILES[kind]+' lacks the column '+name,1);col[name]=at;}
 table.slice(1).forEach((cells,index)=>{
  stats.records++;const record=index+2,{row,reason}=normalizeRow(kind,col,header.length,cells);
  if(!row){stats.invalid[reason]=(stats.invalid[reason]||0)+1;invalidRows.push({file:EXPORT_FILES[kind],record,reason});return;}
  stats.valid++;if(row.year===null)stats.missingYear++;
  if(kind==='diary')return;
  const previous=rows.get(row.code);
  if(!previous){rows.set(row.code,row);return;}
  if(previous.name===row.name&&previous.year===row.year&&previous.rating===row.rating){stats.duplicates++;return;}
  stats.conflicts++;conflicted.add(row.code);
 });
 for(const code of conflicted)rows.delete(code);
 return {stats,invalidRows,rows};
}

const sorted=values=>[...values].sort();
// files: {watched, ratings, watchlist, diary} as CSV text, or null when the file is absent.
export function parseExport(files={}){
 const result={files:{},invalidRows:[],notes:[]},maps={};
 for(const kind of [...IMPORTED_KINDS,'diary']){
  const text=files[kind];
  if(typeof text!=='string'){result.files[kind]={present:false};maps[kind]=new Map();result.notes.push('missing_file:'+EXPORT_FILES[kind]);continue;}
  const {stats,invalidRows,rows}=readFile(kind,text);
  result.files[kind]=kind==='diary'?{...stats,auxiliary:true}:stats;result.invalidRows.push(...invalidRows);maps[kind]=rows;
 }
 const codes=sorted(new Set([...maps.watched.keys(),...maps.ratings.keys(),...maps.watchlist.keys()]));
 let crossFileMismatches=0;
 result.films=codes.map(code=>{
  const sources=[maps.watched.get(code),maps.ratings.get(code),maps.watchlist.get(code)].filter(Boolean),first=sources[0];
  if(sources.some(row=>row.name!==first.name||row.year!==first.year))crossFileMismatches++;
  const film={code,uri:first.uri,name:first.name,year:first.year,inWatched:maps.watched.has(code),inRatings:maps.ratings.has(code),inWatchlist:maps.watchlist.has(code)};
  if(maps.ratings.has(code))film.rating=maps.ratings.get(code).rating;
  if(maps.watched.get(code)?.watchedDate)film.watchedDate=maps.watched.get(code).watchedDate;
  return film;
 });
 const watched=new Set(maps.watched.keys()),rated=new Set(maps.ratings.keys()),watchlist=new Set(maps.watchlist.keys());
 result.sets={
  watched:sorted(watched),rated:sorted(rated),
  watchedUnrated:sorted([...watched].filter(code=>!rated.has(code))),
  ratedNotWatched:sorted([...rated].filter(code=>!watched.has(code))),
  watchlist:sorted(watchlist),
  watchlistWatched:sorted([...watchlist].filter(code=>watched.has(code))),
 };
 result.crossFileMismatches=crossFileMismatches;
 return result;
}
export const SET_NAMES=Object.freeze(['watched','rated','watchedUnrated','ratedNotWatched','watchlist','watchlistWatched']);
export function filmSets(film){
 const sets=[];if(film.inWatched)sets.push('watched');if(film.inRatings)sets.push('rated');if(film.inWatched&&!film.inRatings)sets.push('watchedUnrated');if(film.inRatings&&!film.inWatched)sets.push('ratedNotWatched');if(film.inWatchlist)sets.push('watchlist');if(film.inWatchlist&&film.inWatched)sets.push('watchlistWatched');
 return sets;
}
