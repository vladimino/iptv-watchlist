// AIR-490. A non-functional check runs only when the runner sets IPTV_TEST_SUITE=non-functional.
// The core delivery suite does not call the callback, so a runner wall-clock miss cannot fail a deploy.
export function nonFunctional(id, fn){
 if(typeof id!=='string'||id==='')throw new Error('nonFunctional requires an id');
 if(typeof fn!=='function')throw new Error('nonFunctional requires a function');
 if(process.env.IPTV_TEST_SUITE!=='non-functional')return undefined;
 return fn();
}
// The production-size memory scenarios run the built Worker over `node:sqlite` (scripts/footer-memory-profile.mjs), which Node has since 22.5; the nightly workflow
// pins Node 22. On an older Node outside CI the scenario is skipped with a note instead of failing on a module that cannot exist (24 Nov 2026: Node 20.20 on the
// owner's machine); on CI an older Node is a configuration fault and the scenario fails as before.
export function nodeSqliteOrSkip(id){
 const [major,minor]=String(process.versions.node).split('.').map(Number);
 if(major>22||(major===22&&minor>=5)||process.env.CI)return true;
 console.log(id+': skipped, node:sqlite needs Node 22.5 or later (this is Node '+process.versions.node+'; the nightly workflow runs Node 22)');
 return false;
}
