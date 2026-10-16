import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperimentFlow} from '../src/experiment-flow.js';
const attempt=(status='collision')=>({before:{assessment:{status},result:{metrics:{traction_ok:true}}},after:null});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};

test('first attempt must visibly finish before adjustment is calculated; the new result is then replayed',async()=>{
 const steps=[],first=deferred(),second=deferred();
 const original=attempt(),adjusted={...original,after:{assessment:{status:'clear'}}};
 const flow=createExperimentFlow({calculate:async action=>{steps.push(action);return action==='trial'?original:adjusted;},replay:async(data,signal)=>{steps.push(data.after?'replay-after':'replay-before');await(data.after?second.promise:first.promise);},onPhase:phase=>steps.push(phase)});
 const result=flow.run({wallEnabled:true});
 await new Promise(setImmediate);
 assert.deepEqual(steps,['testing','trial','before','replay-before']);
 first.resolve();await new Promise(setImmediate);
 assert.deepEqual(steps.slice(-4),['adjusting','adjust','after','replay-after']);
 second.resolve();assert.equal(await result,adjusted);assert.equal(steps.at(-1),'complete');
});

test('without a wall, Play computes and replays the actual original path without searching',async()=>{
 const calls=[];const flow=createExperimentFlow({calculate:async action=>{calls.push(action);return attempt('clear');},replay:async()=>calls.push('replay')});
 await flow.run({wallEnabled:false});assert.deepEqual(calls,['trial','replay']);
});

test('an already clear original path is replayed and does not get a gratuitous ramp change',async()=>{
 const calls=[];const flow=createExperimentFlow({calculate:async action=>{calls.push(action);return attempt('clear');},replay:async()=>{}});
 await flow.run({wallEnabled:true});assert.deepEqual(calls,['trial']);
});

test('moving a wall during playback cancels the previous chain before it can adjust',async()=>{
 const wait=deferred(),calls=[];
 const flow=createExperimentFlow({calculate:async action=>{calls.push(action);return attempt();},replay:async()=>wait.promise});
 const stale=flow.run({wallEnabled:true});await new Promise(setImmediate);flow.cancel();wait.resolve();
 await assert.rejects(stale,{name:'AbortError'});assert.deepEqual(calls,['trial']);
});

test('stale solver results cannot start a replay',async()=>{
 const wait=deferred(),calls=[];
 const flow=createExperimentFlow({calculate:()=>wait.promise,replay:async()=>calls.push('replay')});
 const stale=flow.run({wallEnabled:true});flow.cancel();wait.resolve(attempt());
 await assert.rejects(stale,{name:'AbortError'});assert.deepEqual(calls,[]);
});

test('a failed search reports no solution and does not replay a fabricated after result',async()=>{
 const phases=[],calls=[];
 const flow=createExperimentFlow({calculate:async action=>{calls.push(action);return {...attempt(),search:action==='adjust'?{status:'no-solution'}:null};},replay:async()=>calls.push('replay'),onPhase:phase=>phases.push(phase)});
 const result=await flow.run({wallEnabled:true});assert.equal(result.after,null);assert.deepEqual(calls,['trial','replay','adjust']);assert.equal(phases.at(-1),'no-solution');
});

test('service failure surfaces instead of leaving a silently parked car',async()=>{
 const phases=[];const flow=createExperimentFlow({calculate:async()=>{throw new Error('Solver unavailable');},replay:async()=>{},onPhase:phase=>phases.push(phase)});
 await assert.rejects(flow.run({wallEnabled:false}),/Solver unavailable/);assert.equal(phases.at(-1),'error');
});
