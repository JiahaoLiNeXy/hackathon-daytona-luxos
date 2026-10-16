const cancelled=()=>new DOMException('Experiment cancelled','AbortError');

/** A wall edit runs the original path to completion/impact before trying a new ramp. */
export function createExperimentFlow({calculate,replay,onPhase=()=>{}}){
 let active=null;
 const cancel=()=>{active?.abort();active=null;};
 return Object.freeze({
  cancel,
  async run({wallEnabled}){
   cancel();const controller=new AbortController();active=controller;
   const {signal}=controller;
   const check=()=>{if(signal.aborted)throw cancelled();};
   try{
    onPhase('testing');
    const before=await calculate('trial',signal);check();
    if(!before?.before)throw new Error('The trial returned no trajectory.');
    onPhase('before',before);await replay(before,signal);check();
    if(!wallEnabled||(before.before.assessment.status==='clear'&&before.before.result.metrics.traction_ok)){
     onPhase('complete',before);return before;
    }
    onPhase('adjusting',before);
    const after=await calculate('adjust',signal);check();
    if(!after?.before)throw new Error('The adjustment returned no result.');
    if(!after.after){onPhase('no-solution',after);return after;}
    onPhase('after',after);await replay(after,signal);check();
    onPhase('complete',after);return after;
   }catch(error){if(!signal.aborted)onPhase('error',error);throw error;}
   finally{if(active===controller)active=null;}
  },
 });
}
