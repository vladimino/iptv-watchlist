// AIR-558: the D1-derived view index input the four Letterboxd operator scripts now require (--view-index-d1). Written outside the repository.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {SOURCE,VIEW_INDEX_D1_SCHEMA} from '../scripts/view-index-d1-export.mjs';

let sequence=0;
export async function writeD1Input(dir,index={}){
 await mkdir(dir,{recursive:true});
 const file=path.join(dir,'view-index.d1.'+(++sequence)+'.json');
 const keys=Object.keys(index).length;
 await writeFile(file,JSON.stringify({schema:VIEW_INDEX_D1_SCHEMA,source:SOURCE,readAt:'2026-11-20T15:00:00.000Z',database:{id:null},markers:null,counts:{pointer:0,fingerprint:0,ratings:0,keys},index}));
 return file;
}
