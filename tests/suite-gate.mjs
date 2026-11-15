// AIR-490. A non-functional check runs only when the runner sets IPTV_TEST_SUITE=non-functional.
// The core delivery suite does not call the callback, so a runner wall-clock miss cannot fail a deploy.
export function nonFunctional(id, fn){
 if(typeof id!=='string'||id==='')throw new Error('nonFunctional requires an id');
 if(typeof fn!=='function')throw new Error('nonFunctional requires a function');
 if(process.env.IPTV_TEST_SUITE!=='non-functional')return undefined;
 return fn();
}
