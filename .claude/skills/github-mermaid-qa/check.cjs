// Checks the Mermaid diagrams of a page exactly as GitHub renders them (headless Chromium, the viewscreen.githubusercontent.com frames).
// Usage: node check.cjs <github blob url> [needle ...]   (a needle is text that must appear in one rendered diagram)
// Prints one JSON line per diagram and a verdict; exit code 1 on a diagram without an SVG, with an error, with text outside its SVG, or a missing needle.
// It saves no file: screenshots are not created, saved or attached (docs/process/agent-workflow.md, Visual QA).
const {chromium}=require('playwright');
const [,, url, ...needles]=process.argv;
if(!url){console.error('usage: node check.cjs <github blob url> [needle ...]');process.exit(2);}
(async()=>{
 const browser=await chromium.launch();
 const context=await browser.newContext({viewport:{width:1280,height:1000},deviceScaleFactor:1});
 const page=await context.newPage();
 // A long page may never reach network idle: load the document first, then wait for idle only as long as it takes, and judge the HTTP status of the document itself.
 const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>null);
 await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{});
 // GitHub renders each ```mermaid block in its own iframe after the page loads.
 await page.waitForTimeout(8000);
 const frames=page.frames().filter(frame=>/viewscreen\.githubusercontent\.com/.test(frame.url()));
 const results=[];
 for(const [index,frame] of frames.entries()){
  const info=await frame.evaluate(()=>{
   const svg=document.querySelector('svg');
   const body=(document.body.innerText||'').replace(/\s+/g,' ').trim();
   if(!svg)return {svg:false,error:/error|syntax/i.test(body),text:body.slice(0,200)};
   const box=svg.getBoundingClientRect();
   let outside=0,labels=0;
   svg.querySelectorAll('text,foreignObject').forEach(node=>{
    labels++;
    const b=node.getBoundingClientRect();
    if(b.width>0&&(b.left<box.left-2||b.right>box.right+2||b.top<box.top-2||b.bottom>box.bottom+2))outside++;
   });
   return {svg:true,error:false,width:Math.round(box.width),height:Math.round(box.height),labels,outside,text:(svg.textContent||'').replace(/\s+/g,' ')};
  }).catch(error=>({svg:false,error:true,text:'frame not readable: '+String(error.message).slice(0,80)}));
  results.push({index,...info});
 }
 let failed=false;
 for(const item of results){
  const bad=!item.svg||item.error||item.outside>0;
  if(bad)failed=true;
  console.log(JSON.stringify({index:item.index,ok:!bad,svg:item.svg,width:item.width,height:item.height,labels:item.labels,textOutsideSvg:item.outside,error:item.error}));
 }
 for(const needle of needles){
  const hit=results.find(item=>item.text&&item.text.includes(needle));
  if(!hit)failed=true;
  console.log(JSON.stringify({needle,foundInDiagram:hit?hit.index:null}));
 }
 console.log(JSON.stringify({url,httpStatus:response&&response.status(),diagrams:results.length,verdict:failed||!response||response.status()!==200||results.length===0?'FAIL':'PASS'}));
 await browser.close();
 process.exit(failed||!response||response.status()!==200||results.length===0?1:0);
})();
