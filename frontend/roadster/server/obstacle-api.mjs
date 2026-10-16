import {runPhysics} from './physics-runner.mjs';
import {assessWall} from '../src/wall-clearance.js';
import {makeCandidates} from './ramp-search.mjs';

const invalid=message=>{throw Object.assign(new Error(message),{code:'invalid_input'});};
export async function evaluateObstacle(input,{signal}={}){
 if(!input||!['trial','adjust'].includes(input.action))invalid('action must be trial or adjust');
 const {problemSpec,wall,scale=1}=input;
 if(!wall||typeof wall.enabled!=='boolean'||![wall.x,wall.height,scale].every(Number.isFinite)||wall.x < -35||wall.x>5||wall.height<1||wall.height>25||scale<.5||scale>1.6||wall.width!==8||wall.thickness!==.35)invalid('Wall or vehicle dimensions are outside the supported range');
 if(input.action==='adjust'&&!wall.enabled)invalid('Place a wall before adjusting the ramp');
 const spec=structuredClone(problemSpec),obstacle=structuredClone(wall);
 const [result]=await runPhysics([spec],{signal});
 const before={problemSpec:spec,result,assessment:assessWall({problemSpec:spec,result},obstacle,{scale})};
 if(before.assessment.status==='invalid')invalid(before.assessment.reason);
 if(input.action==='trial')return{before,after:null,search:null};
 if(before.assessment.status==='clear'&&result.metrics.traction_ok)return{before,after:{...before,adjustment:{liftM:0,kind:'unchanged'}},search:{evaluated:1,feasible:1,status:'already-clear'}};
 const candidates=makeCandidates(spec,obstacle);
 let evaluated=0,feasible=0,best=null;
 // Fixed-size batches keep memory bounded and yield between CPU work.
 for(let offset=0;offset<candidates.length;offset+=24){
  if(signal?.aborted)throw Object.assign(new Error('Cancelled'),{name:'AbortError'});
  const batch=candidates.slice(offset,offset+24),results=await runPhysics(batch.map(item=>item.problemSpec),{signal});
  for(let i=0;i<results.length;i++){
   evaluated++;const item=batch[i],candidateResult=results[i];
   if(!candidateResult.metrics.traction_ok)continue;
   const envelope={problemSpec:item.problemSpec,result:candidateResult},assessment=assessWall(envelope,obstacle,{scale});
   if(assessment.status!=='clear')continue;
   feasible++;if(!best||item.score<best.score)best={...envelope,assessment,adjustment:item.adjustment,score:item.score};
  }
 }
 if(best)delete best.score;
 return{before,after:best,search:{evaluated,feasible,status:best?'found':'no-solution',method:'Bounded smooth approach deformation; unchanged speed, mass and downforce; fresh Python solve and complete continuous vehicle-envelope check for every accepted candidate'}};
}

export function obstacleApiPlugin(){let running=0;
 const middleware=async(req,res,next)=>{
  if(req.url?.split('?')[0]!=='/api/obstacle')return next();
  const reply=(status,value)=>{if(res.destroyed)return;res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  if(req.method!=='POST')return reply(405,{error:'POST is required'});
  const host=req.headers.host||'';if(!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host))return reply(403,{error:'Local access only'});
  if(req.headers.origin&&req.headers.origin!==`http://${host}`)return reply(403,{error:'A same-origin request is required'});
  if(!req.headers['content-type']?.startsWith('application/json'))return reply(415,{error:'A JSON request is required'});
  if(running>=2)return reply(429,{error:'Calculation in progress. Try again shortly'});
  let bytes=0;const chunks=[];let rejected=false;
  req.on('data',chunk=>{bytes+=chunk.length;if(bytes>256*1024){if(!rejected){rejected=true;reply(413,{error:'Request is too large'});}}else chunks.push(chunk);});
  req.on('end',async()=>{
   if(rejected)return;let input;try{input=JSON.parse(Buffer.concat(chunks).toString());}catch{return reply(400,{error:'Invalid JSON syntax'});}
   if(running>=2)return reply(429,{error:'Calculation in progress. Try again shortly'});
   const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});running++;
   try{reply(200,await evaluateObstacle(input,{signal:controller.signal}));}
   catch(error){if(error.name!=='AbortError')reply(error.code==='invalid_input'?400:500,{error:error.message,code:error.code||'calculation_failed'});}
   finally{running--;}
  });
 };
 return{name:'local-obstacle-physics',configureServer(server){server.middlewares.use(middleware);},configurePreviewServer(server){server.middlewares.use(middleware);}};
}
