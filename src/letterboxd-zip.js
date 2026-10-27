// Reads named files from a Letterboxd account export ZIP in memory and binds them to the archive: its SHA-256, the
// generation time from Letterboxd's archive name, and each file's SHA-256 (contract "Export origin"). Node-only; no
// extraction to disk. Stored and deflated entries only; encrypted, multi-disk and ZIP64 archives are refused.
import {createHash} from 'node:crypto';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';

export class ZipError extends Error{constructor(message){super(message);this.name='ZipError';}}
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const CRC_TABLE=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
export function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=CRC_TABLE[(c^b)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}

// The name Letterboxd gives an export: letterboxd-<user>-YYYY-MM-DD-HH-MM-utc.zip. Returns the generation time or null.
export function archiveGeneratedAt(fileName){
 const match=/^letterboxd-[A-Za-z0-9_-]+-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-utc\.zip$/.exec(path.basename(String(fileName)));
 if(!match)return null;
 const [,y,mo,d,h,mi]=match,date=new Date(Date.UTC(+y,+mo-1,+d,+h,+mi));
 if(date.getUTCFullYear()!==+y||date.getUTCMonth()!==+mo-1||date.getUTCDate()!==+d||date.getUTCHours()!==+h||date.getUTCMinutes()!==+mi)return null;
 return date.toISOString();
}

// Returns {archiveSha256, files: {name: {text, sha256}}} for the requested top-level names; a missing name is absent.
export function readZip(bytes,names){
 if(!Buffer.isBuffer(bytes)||bytes.length<22)throw new ZipError('Not a ZIP archive');
 let eocd=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-22-65535);i--)if(bytes.readUInt32LE(i)===0x06054b50){eocd=i;break;}
 if(eocd<0)throw new ZipError('ZIP end of central directory not found');
 if(bytes.readUInt16LE(eocd+4)!==0||bytes.readUInt16LE(eocd+6)!==0)throw new ZipError('Multi-disk ZIP archives are not supported');
 const count=bytes.readUInt16LE(eocd+10),size=bytes.readUInt32LE(eocd+12),offset=bytes.readUInt32LE(eocd+16);
 if(count===0xffff||size===0xffffffff||offset===0xffffffff)throw new ZipError('ZIP64 archives are not supported');
 if(offset+size>eocd)throw new ZipError('ZIP central directory is out of range');
 const wanted=new Set(names),files={},seen=new Set();let at=offset;
 for(let n=0;n<count;n++){
  if(bytes.readUInt32LE(at)!==0x02014b50)throw new ZipError('ZIP central directory entry is corrupt');
  const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),compressed=bytes.readUInt32LE(at+20),plain=bytes.readUInt32LE(at+24);
  const nameLength=bytes.readUInt16LE(at+28),extraLength=bytes.readUInt16LE(at+30),commentLength=bytes.readUInt16LE(at+32),local=bytes.readUInt32LE(at+42);
  const name=bytes.subarray(at+46,at+46+nameLength).toString('utf8');at+=46+nameLength+extraLength+commentLength;
  if(!wanted.has(name))continue;
  if(seen.has(name))throw new ZipError('ZIP holds '+name+' twice');seen.add(name);
  if(flags&1)throw new ZipError('Encrypted ZIP entries are not supported');
  if(bytes.readUInt32LE(local)!==0x04034b50)throw new ZipError('ZIP local header is corrupt');
  const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28),data=bytes.subarray(start,start+compressed);
  if(data.length!==compressed)throw new ZipError('ZIP entry '+name+' is truncated');
  let content;
  if(method===0)content=Buffer.from(data);
  else if(method===8){try{content=inflateRawSync(data);}catch{throw new ZipError('ZIP entry '+name+' does not inflate');}}
  else throw new ZipError('ZIP entry '+name+' uses an unsupported method');
  if(content.length!==plain||crc32(content)!==crc)throw new ZipError('ZIP entry '+name+' fails its checksum');
  files[name]={text:content.toString('utf8'),sha256:sha256(content)};
 }
 return {archiveSha256:sha256(bytes),files};
}
