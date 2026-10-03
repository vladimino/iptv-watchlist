import fs from 'node:fs';
const assets={};
for(const [path,file,type] of [['/','index.html','text/html'],['/styles.css','styles.css','text/css'],['/app.js','app.js','text/javascript']]) assets[path]={body:fs.readFileSync('public/'+file,'utf8'),type};
fs.rmSync('dist',{recursive:true,force:true});
fs.mkdirSync('dist/server',{recursive:true});
fs.writeFileSync('dist/server/index.js','const ASSETS='+JSON.stringify(assets)+';\nconst PERSON_NAME_DICTIONARY='+fs.readFileSync('data/person-names.json','utf8')+';\nconst FILM_TITLE_DICTIONARY='+fs.readFileSync('data/film-titles.json','utf8')+';\n'+fs.readFileSync('src/sources.js','utf8')+'\n'+fs.readFileSync('src/worker.js','utf8'));
