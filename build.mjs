import fs from 'node:fs';
const assets={};
for(const [path,file,type] of [['/','index.html','text/html'],['/styles.css','styles.css','text/css'],['/app.js','app.js','text/javascript'],['/data.json','data.json','application/json']]) assets[path]={body:fs.readFileSync('public/'+file,'utf8'),type};
fs.mkdirSync('dist/server',{recursive:true});
fs.writeFileSync('dist/server/index.js','const ASSETS='+JSON.stringify(assets)+';\n'+fs.readFileSync('src/worker.js','utf8'));
