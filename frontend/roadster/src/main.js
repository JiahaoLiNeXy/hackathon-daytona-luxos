import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {createRoadster,CAR_DIMENSIONS} from './car.js';
import {rampPoint,TRACK_DEFAULTS} from './track.js';
import {normalizeTrajectory,parseTrajectory,sampleTrajectory} from './trajectory.js';
import {createFloatingPanels} from './floating-panels.js';
import {adaptPhysicsResult} from './physics-adapter.js';
import {createCurveTrack,validateRampCurve} from './curve-track.js';
import {projectorMarkup} from './projector-markup.js';
import {createIntegrationBridge} from './integration-bridge.js';
import {createVoiceFeedback} from './voice-feedback.js';
import {overlapsWall} from './collision.js';
import './style.css';

const $=id=>document.getElementById(id);
const embed=new URLSearchParams(location.search).get('embed')==='1';
if(embed){document.documentElement.classList.add('embed');document.body.classList.add('embed');}
$('app').innerHTML=projectorMarkup;
const defaultCurve=()=>[...Array.from({length:17},(_,i)=>({x:-25+19*i/16,y:0})),...Array.from({length:128},(_,i)=>{const {position:p}=rampPoint((i+1)/128);return{x:p.x,y:p.y};})];
const defaultSpec=()=>({ramp_curve_m:defaultCurve(),entry_speed_ms:22.2,car_mass_kg:1300,downforce_capability_n:150000,ground_profile:{type:'flat',landing_level_m:0}});
let baseSpec=defaultSpec(),wallState={enabled:false,x:-18,height:3,width:8,thickness:.35};
let scale=1,view='scene',currentTime=0,playing=false,speed=1,trajectory,physicsData=null,activeRampCurve=baseSpec.ramp_curve_m;
let experiment={before:null,after:null,search:null},selection='before',busy=false,requestGeneration=0,requestController=null;
let panels,bridge,voiceFeedback,track,pathLine,ghostTrack,ghostPath,ghostTrajectory,firstHitMarker,playbackAssessment=null,toastTimer;
const rawPosition=new THREE.Vector3();
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0,0);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
$('viewport').prepend(renderer.domElement);renderer.domElement.setAttribute('aria-label','Roadster ramp and wall');
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,1,.05,350);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.07;controls.maxPolarAngle=Math.PI*.96;
const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment(),environment=pmrem.fromScene(room,.04);scene.environment=environment.texture;room.dispose();pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xe8f3ff,0x585348,2.6));
const sun=new THREE.DirectionalLight(0xfff2dc,4.1);sun.position.set(-12,30,22);scene.add(sun);
const fill=new THREE.DirectionalLight(0xbce7dc,1.5);fill.position.set(8,20,-18);scene.add(fill);
const assets=new THREE.Group();assets.name='Roadster_Launch_Study';assets.userData={units:'m',upAxis:'Y',forwardAxis:'X',source:'Visual reconstruction, not calibrated engineering model'};scene.add(assets);
const car=createRoadster();assets.add(car);
const ghostCar=createRoadster();ghostCar.visible=false;scene.add(ghostCar);
ghostCar.traverse(o=>{if(o.isMesh){o.material=o.material.clone();o.material.transparent=true;o.material.opacity=.25;o.material.depthWrite=false;o.material.color?.set(0xef857a);}});
const studioCar=createRoadster();studioCar.visible=false;scene.add(studioCar);
const wall=new THREE.Group();wall.name='Editable_wall';
const wallMat=new THREE.MeshStandardMaterial({color:0xffb183,transparent:true,opacity:.38,roughness:.85,side:THREE.DoubleSide});
const wallMesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),wallMat);
const wallOutline=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1,1,1)),new THREE.LineBasicMaterial({color:0xffbe9b}));wall.add(wallMesh,wallOutline);assets.add(wall);
function dispose(root){root?.traverse(o=>{o.geometry?.dispose();if(o.material)for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();});}
function remove(root){if(root){root.removeFromParent();dispose(root);}}
function toast(message){$('toast').textContent=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').textContent='',5000);}
function save(data,type,name){const url=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
function setBusy(value){busy=value;syncExperiment();}
function cancelPending(){requestGeneration++;requestController?.abort();requestController=null;busy=false;}
function clearComparison(){remove(ghostTrack);remove(ghostPath);remove(firstHitMarker);ghostTrack=ghostPath=firstHitMarker=null;ghostTrajectory=null;ghostCar.visible=false;$('scene-legend').hidden=true;}
function invalidate(message='Settings changed. Run again'){
 cancelPending();experiment={before:null,after:null,search:null};selection='before';clearComparison();installCurve(baseSpec.ramp_curve_m);$('experiment-status').textContent=message;syncExperiment();
}
function syncExperiment(){
 $('wall-fields').hidden=!wallState.enabled;$('wall-add').hidden=wallState.enabled;$('wall-hint').hidden=!wallState.enabled;
 $('wall-x').value=wallState.x;$('wall-position').value=wallState.x;$('wall-height').value=wallState.height;$('entry-speed').value=baseSpec.entry_speed_ms;
 $('trial-button').disabled=busy||!wallState.enabled;$('trial-button').textContent=busy?'Running…':'Run';
 $('adjust-button').disabled=busy||!wallState.enabled||!experiment.before;
 $('comparison-results').hidden=!experiment.before;
 $('before-result').textContent=describeResult(experiment.before);$('after-result').textContent=experiment.after?describeResult(experiment.after):experiment.search?'No solution found':'Pending';
 $('before-result').dataset.status=experiment.before?.assessment.status||'';$('after-result').dataset.status=experiment.after?.assessment.status||'';
 $('comparison-actions').hidden=!experiment.after;
 for(const [id,key] of [['show-before','before'],['show-after','after'],['show-compare','compare']])$(id).classList.toggle('active',selection===key);
 $('adjustment-detail').textContent=experiment.search?(experiment.after?`Raised ${experiment.after.adjustment.liftM.toFixed(1)} m · ${experiment.search.evaluated} options checked`:`${experiment.search.evaluated} options checked`):'';
 $('export-result').disabled=!experiment.before;
}
function describeResult(result){if(!result)return'—';if(!result.result.metrics.traction_ok)return'Lost traction';return result.assessment.status==='clear'?'Cleared wall':result.assessment.status==='collision'?'Hit wall':'Unconfirmed';}
function drawPath(data,color,opacity=.7){const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(data.samples.map(s=>new THREE.Vector3(...s.position))),new THREE.LineDashedMaterial({color,dashSize:.32,gapSize:.22,transparent:true,opacity}));line.computeLineDistances();scene.add(line);return line;}
function syncPlay(){const ready=trajectory&&trajectory.samples.length>1;for(const id of ['play','restart','timeline','speed'])$(id).disabled=!ready||busy;$('play').textContent=playing?'Ⅱ Pause':'▶ Play';}
function setTrajectory(next){trajectory=next;playing=false;currentTime=0;remove(pathLine);pathLine=next.samples.length>1?drawPath(next,selection==='before'?0xef978c:0x9de6cc):null;$('timeline').max=next.duration;syncPlay();updatePose();}
function installCurve(points){const copy=validateRampCurve(points),next=createCurveTrack(copy);remove(track);track=next;assets.add(track);activeRampCurve=copy;physicsData=null;playbackAssessment=null;
 const a=copy[0],b=copy[1],angle=Math.atan2(b.y-a.y,b.x-a.x);setTrajectory({source:'curve',duration:0,samples:[{t:0,position:[a.x,a.y,0],quaternion:[0,0,Math.sin(angle/2),Math.cos(angle/2)]}]});$('source-name').textContent='Ready to run';$('physics-readout').hidden=true;
}
function applyPhysics(payload,assessment=null){const next=adaptPhysicsResult(payload),nextTrack=createCurveTrack(next.problemSpec.ramp_curve_m);remove(track);track=nextTrack;assets.add(track);activeRampCurve=structuredClone(next.problemSpec.ramp_curve_m);physicsData=next;playbackAssessment=assessment;setTrajectory(next.trajectory);$('source-name').textContent=selection==='compare'?'Before / After':selection==='after'?'After':'Before';$('physics-readout').hidden=false;}
function modelPose(target,data,time){const pose=sampleTrajectory(data,time);target.position.copy(pose.position);target.quaternion.copy(pose.quaternion);target.scale.setScalar(scale);if(data.source==='physics'||data.source==='curve')target.position.add(new THREE.Vector3(0,CAR_DIMENSIONS.height*scale/2+.04,0).applyQuaternion(pose.quaternion));return pose;}
function updatePose(){if(!trajectory)return;const pose=modelPose(car,trajectory,currentTime);rawPosition.copy(pose.position);
 if(ghostTrajectory){const hit=experiment.before?.assessment.firstHit?.t;modelPose(ghostCar,ghostTrajectory,Math.min(currentTime,hit??ghostTrajectory.duration));}
 const hit=playbackAssessment?.firstHit?.t;const touching=hit!==undefined&&currentTime>=hit-.03;wallMat.color.set(touching?0xff705b:0xffb183);
 $('timeline').value=currentTime;$('time-label').textContent=`${currentTime.toFixed(2)} / ${trajectory.duration.toFixed(2)} s`;
 if(physicsData)$('physics-readout').textContent=selection==='compare'?'Original stops at impact · Adjusted path continues':touching?'Vehicle envelope hit the wall':playbackAssessment?.status==='clear'?'Full path cleared the wall check':'Simulated path';
}
function renderComparison(mode='compare',fit=false){if(!experiment.before)return;selection=mode;clearComparison();const shown=mode==='before'||!experiment.after?experiment.before:experiment.after;applyPhysics(shown,shown.assessment);
 if(mode==='compare'&&experiment.after){
  ghostTrack=createCurveTrack(experiment.before.problemSpec.ramp_curve_m);ghostTrack.traverse(o=>{if(o.isMesh){o.material=o.material.clone();o.material.transparent=true;o.material.opacity=.15;o.material.depthWrite=false;o.material.color?.set(0xef857a);}});scene.add(ghostTrack);
  ghostTrajectory=adaptPhysicsResult(experiment.before).trajectory;ghostPath=drawPath(ghostTrajectory,0xffa299,.52);ghostCar.visible=view!=='car';$('scene-legend').hidden=false;
 }
 const hit=experiment.before.assessment.firstHit;if(hit){firstHitMarker=new THREE.Mesh(new THREE.SphereGeometry(.36,16,12),new THREE.MeshBasicMaterial({color:0xff9877,transparent:true,opacity:.9}));firstHitMarker.position.fromArray(hit.displayPosition);scene.add(firstHitMarker);}
 syncExperiment();updatePose();if(fit)fitScene();
}
function updateWall(){wall.visible=wallState.enabled;wall.position.set(wallState.x,wallState.height/2,0);wallMesh.scale.set(wallState.thickness,wallState.height,wallState.width);wallOutline.scale.copy(wallMesh.scale);}
function changeWall(patch,source='api'){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['enabled','x','height'].includes(key)))throw new Error('Wall accepts only enabled, x, and height.');const next={...wallState,...patch};if(typeof next.enabled!=='boolean'||!Number.isFinite(next.x)||next.x < -35||next.x>5||!Number.isFinite(next.height)||next.height<1||next.height>25||next.width!==8||next.thickness!==.35)throw new Error('Wall position must be −35 to 5 m; height must be 1 to 25 m');wallState=next;invalidate(next.enabled?'Wall ready. Run the test':'Add a wall to start');updateWall();bridge?.notifyParametersChanged(source);}
function setPlaybackRate(value){if(![.25,.5,1,2].includes(value))throw new Error('Playback rate must be 0.25, 0.5, 1, or 2.');speed=value;$('speed').value=String(value);return speed;}
function setEntrySpeed(value,source='api'){if(!Number.isFinite(value)||value<5||value>40)throw new Error('Entry speed must be 5 to 40 m/s');baseSpec.entry_speed_ms=value;invalidate();bridge?.notifyParametersChanged(source);return value;}
function inputRampHeight(){return Math.max(...baseSpec.ramp_curve_m.map(point=>point.y));}
function fitScene(){if(view==='car')return;const box=new THREE.Box3().setFromObject(track);if(wall.visible)box.union(new THREE.Box3().setFromObject(wall));for(const item of [experiment.before,experiment.after])if(item)for(const p of item.result.trajectory)box.expandByPoint(new THREE.Vector3(p.x,p.y,0));if(trajectory.samples.length>1)for(const p of trajectory.samples)box.expandByPoint(new THREE.Vector3(...p.position));box.expandByScalar(3);
 const center=box.getCenter(new THREE.Vector3()),radius=box.getSize(new THREE.Vector3()).length()/2,direction=new THREE.Vector3(...(view==='side'?[0,0,1]:[-.22,.3,1])).normalize(),right=new THREE.Vector3().crossVectors(camera.up,direction).normalize(),up=new THREE.Vector3().crossVectors(direction,right).normalize(),tanY=Math.tan(THREE.MathUtils.degToRad(camera.fov/2)),tanX=tanY*camera.aspect;let distance=1;
 for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){const p=new THREE.Vector3(x,y,z).sub(center);distance=Math.max(distance,p.dot(direction)+Math.max(Math.abs(p.dot(right))/tanX,Math.abs(p.dot(up))/tanY));}
 distance*=1.08;controls.target.copy(center);camera.position.copy(center).addScaledVector(direction,distance);controls.minDistance=4;controls.maxDistance=Math.max(140,distance*3);camera.far=Math.max(350,distance*5);camera.updateProjectionMatrix();controls.update();
}
function setView(name){if(!['scene','side','car'].includes(name))throw new Error('Unknown view');view=name;const inspection=name==='car';assets.visible=!inspection;studioCar.visible=inspection;studioCar.scale.setScalar(scale);studioCar.position.set(0,CAR_DIMENSIONS.height*scale/2,0);for(const item of [pathLine,ghostTrack,ghostPath,firstHitMarker])if(item)item.visible=!inspection;ghostCar.visible=!inspection&&!!ghostTrajectory;for(const [id,key] of [['view-scene','scene'],['view-side','side'],['view-car','car']])$(id).classList.toggle('active',name===key);
 if(inspection){playing=false;syncPlay();controls.target.set(0,.4,0);camera.position.set(6,3.3,6);controls.minDistance=2;controls.maxDistance=22;controls.update();}else fitScene();
}
async function runExperiment(action){if(!wallState.enabled)throw new Error('Add a wall first');if(action==='adjust'&&!experiment.before)throw new Error('Run the test first');cancelPending();const generation=requestGeneration,controller=new AbortController();requestController=controller;playing=false;setBusy(true);syncPlay();$('experiment-status').textContent=action==='trial'?'Calculating original path…':'Adjusting ramp and checking clearance…';
 try{const response=await fetch('/api/obstacle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,problemSpec:baseSpec,wall:wallState,scale}),signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error||'Simulation service unavailable');if(generation!==requestGeneration)return;
  experiment=data;selection=action==='adjust'&&data.after?'compare':'before';setView('scene');renderComparison(selection,true);panels.show('motion-panel');
  $('experiment-status').textContent=action==='trial'?(data.before.assessment.status==='collision'?'Hit the wall. Adjust the ramp':describeResult(data.before)==='Cleared wall'?'Original path cleared the wall':'Original path failed. Adjust the ramp'):data.after?'Viable ramp found':`No viable ramp found within the search range`;
  currentTime=0;playing=true;setBusy(false);syncPlay();return structuredClone(data);
 }catch(error){if(generation!==requestGeneration||error.name==='AbortError')return;$('experiment-status').textContent=`Failed: ${error.message}`;throw error;}
 finally{if(generation===requestGeneration){requestController=null;setBusy(false);syncPlay();}}
}
function guard(fn){return(...args)=>{try{Promise.resolve(fn(...args)).catch(e=>toast(e.message));}catch(e){toast(e.message);}};}
function togglePlayback(){if(trajectory.samples.length<2||busy)return;if(currentTime>=playEnd())currentTime=0;playing=!playing;if(view==='car')setView('scene');syncPlay();}
function playEnd(){return playbackAssessment?.firstHit&&selection!=='compare'?Math.min(trajectory.duration,playbackAssessment.firstHit.t):trajectory.duration;}
$('wall-add').onclick=guard(()=>changeWall({enabled:true},'ui'));$('wall-remove').onclick=guard(()=>changeWall({enabled:false},'ui'));
$('wall-x').onchange=guard(e=>changeWall({x:Number(e.target.value)},'ui'));$('wall-position').oninput=guard(e=>changeWall({x:Number(e.target.value)},'ui'));$('wall-height').onchange=guard(e=>changeWall({height:Number(e.target.value)},'ui'));
$('entry-speed').onchange=guard(e=>setEntrySpeed(Number(e.target.value),'ui'));
$('trial-button').onclick=guard(()=>runExperiment('trial'));$('adjust-button').onclick=guard(()=>runExperiment('adjust'));
for(const [id,key] of [['show-before','before'],['show-after','after'],['show-compare','compare']])$(id).onclick=()=>renderComparison(key);
$('play').onclick=togglePlayback;$('restart').onclick=()=>{currentTime=0;playing=true;syncPlay();updatePose();};$('timeline').oninput=e=>{currentTime=Number(e.target.value);playing=false;syncPlay();updatePose();};$('speed').onchange=guard(e=>setPlaybackRate(Number(e.target.value)));
for(const [id,key] of [['view-scene','scene'],['view-side','side'],['view-car','car']])$(id).onclick=()=>setView(key);$('reset-view').onclick=()=>setView(view);
// A wall is edited directly on the projected model; orbit is suspended during the drag.
const raycaster=new THREE.Raycaster(),dragPlane=new THREE.Plane(new THREE.Vector3(0,0,1),0);let wallDrag=null;
function pointOnPlane(event){const rect=renderer.domElement.getBoundingClientRect();raycaster.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),camera);return raycaster.ray.intersectPlane(dragPlane,new THREE.Vector3());}
renderer.domElement.addEventListener('pointerdown',event=>{if(event.button!==0||!wallState.enabled||view==='car')return;const point=pointOnPlane(event);if(!point||!raycaster.intersectObject(wallMesh).length)return;wallDrag={pointer:event.pointerId,offset:wallState.x-point.x};controls.enabled=false;renderer.domElement.setPointerCapture(event.pointerId);event.stopImmediatePropagation();event.preventDefault();},true);
renderer.domElement.addEventListener('pointermove',event=>{if(!wallDrag||wallDrag.pointer!==event.pointerId)return;const point=pointOnPlane(event);if(point)changeWall({x:Math.round(THREE.MathUtils.clamp(point.x+wallDrag.offset,-35,5)*4)/4},'ui');event.stopImmediatePropagation();},true);
for(const type of ['pointerup','pointercancel','lostpointercapture'])renderer.domElement.addEventListener(type,()=>{wallDrag=null;controls.enabled=true;},true);
async function exportAsset(kind){const group=new THREE.Group();group.name=`Roadster_${kind}`;group.userData={units:'m',upAxis:'Y',forwardAxis:'X'};if(kind==='car'){const copy=createRoadster();copy.scale.setScalar(scale);group.add(copy);}else if(kind==='ramp')group.add(createCurveTrack(activeRampCurve));else{const copy=assets.clone(true);copy.visible=true;group.add(copy);}try{save(await new GLTFExporter().parseAsync(group,{binary:true}),'model/gltf-binary',`roadster-${kind}.glb`);toast('Exported');}finally{if(kind!=='scene')dispose(group);}}
for(const kind of ['car','ramp','scene'])$(`export-${kind}`).onclick=guard(()=>exportAsset(kind));$('export-result').onclick=()=>save(JSON.stringify({wall:wallState,scale,...experiment},null,2),'application/json','roadster-wall-experiment.json');
$('snapshot').onclick=()=>{renderer.render(scene,camera);renderer.domElement.toBlob(blob=>{if(blob)save(blob,'image/png','roadster-projection.png');});};
function resetExperiment(source='ui'){baseSpec=defaultSpec();wallState={enabled:false,x:-18,height:3,width:8,thickness:.35};invalidate('Add a wall to start');updateWall();setView('scene');bridge?.notifyParametersChanged(source);}
$('reset-experiment').onclick=()=>resetExperiment();
function loadOrdinary(next){cancelPending();clearComparison();experiment={before:null,after:null,search:null};physicsData=null;playbackAssessment=null;setTrajectory(next);$('source-name').textContent='Imported path';$('physics-readout').hidden=true;syncExperiment();setView('scene');panels.show('motion-panel');}
async function importFile(file){if(!file)return;cancelPending();const generation=requestGeneration;if(file.size>10*1024*1024)throw new Error('File must be 10 MB or smaller');const text=await file.text();if(generation===requestGeneration)loadOrdinary(parseTrajectory(text,file.name));$('file-input').value='';}
$('import-button').onclick=()=>$('file-input').click();$('file-input').onchange=guard(e=>importFile(e.target.files[0]));$('viewport').addEventListener('dragover',e=>e.preventDefault());$('viewport').addEventListener('drop',guard(e=>{e.preventDefault();return importFile(e.dataTransfer.files[0]);}));
const api={
 setVoiceState:input=>voiceFeedback.setVoiceState(input),runVoiceCommand:input=>voiceFeedback.runVoiceCommand(input),
 setRampCurve(points){const copy=validateRampCurve(points);createCurveTrack(copy).traverse(o=>{o.geometry?.dispose();if(o.material)o.material.dispose();});baseSpec.ramp_curve_m=copy;invalidate('Ramp updated. Run the test');setView('scene');bridge?.notifyParametersChanged('api');return{points:copy.length,status:'awaiting-physics'};},
 loadPhysicsResult(payload){const validated=adaptPhysicsResult(payload);cancelPending();clearComparison();experiment={before:null,after:null,search:null};baseSpec=structuredClone(validated.problemSpec);selection='before';applyPhysics(payload);syncExperiment();setView('scene');panels.show('motion-panel');bridge?.notifyParametersChanged('api');return{samples:trajectory.samples.length,duration:trajectory.duration,outcome:physicsData.metrics.outcome,warnings:physicsData.warnings};},
 loadTrajectory(data){const next=normalizeTrajectory(data);loadOrdinary(next);return{samples:next.samples.length,duration:next.duration,warnings:next.warnings};},
 setWall:changeWall,setPlaybackRate,setEntrySpeed,getReadyState(){return bridge.getReadyState();},runTrial:()=>runExperiment('trial'),adjustRamp:()=>runExperiment('adjust'),compare(mode='compare'){if(!['before','after','compare'].includes(mode))throw new Error('Unknown comparison mode');if(!experiment.before)throw new Error('Run a trial first');if(mode!=='before'&&!experiment.after)throw new Error('Adjust the ramp first');renderComparison(mode);},
 play(){if(trajectory.samples.length<2||busy)throw new Error('Calculate a path first');if(currentTime>=playEnd())currentTime=0;if(view==='car')setView('scene');playing=true;syncPlay();panels.show('scene-panel');},pause(){playing=false;syncPlay();},seek(t){if(!Number.isFinite(t))throw new Error('Time must be a number');currentTime=THREE.MathUtils.clamp(t,0,trajectory.duration);playing=false;syncPlay();updatePose();},reset(){currentTime=0;playing=false;syncPlay();updatePose();},
 setVehicleScale(value){if(!Number.isFinite(value)||value<.5||value>1.6)throw new Error('Car scale must be 0.5 to 1.6');scale=value;invalidate();studioCar.scale.setScalar(scale);studioCar.position.y=CAR_DIMENSIONS.height*scale/2;bridge?.notifyParametersChanged('api');},
 setRampHeight(value){if(!Number.isFinite(value)||value<12||value>32)throw new Error('Ramp height must be 12 to 32 m');baseSpec.ramp_curve_m=defaultCurve().map(p=>({x:p.x,y:p.y*value/23}));invalidate();setView('scene');bridge?.notifyParametersChanged('api');},
 setView,showModule:id=>panels.show(id),hideModule:id=>panels.hide(id),moveModule:({id,x,y})=>panels.move(id,{x,y}),exportGLB:exportAsset,
 getState(){return{voice:voiceFeedback.getState(),modules:panels.getState(),time:currentTime,duration:trajectory.duration,playing,playbackRate:speed,parameterRevision:bridge?.getRevision()??0,busy,source:trajectory.source,position:rawPosition.toArray(),displayPosition:car.position.toArray(),quaternion:car.quaternion.toArray(),scale,rampHeight:inputRampHeight(),entrySpeedMs:baseSpec.entry_speed_ms,overlapAtCurrentPose:overlapsWall(car.position,car.quaternion,CAR_DIMENSIONS,scale,wallState),wall:{...wallState},ramp:{type:'curve',points:structuredClone(activeRampCurve),width:TRACK_DEFAULTS.width},physics:physicsData?{problemSpec:structuredClone(physicsData.problemSpec),metrics:structuredClone(physicsData.metrics),execution:structuredClone(physicsData.execution)}:null,experiment:structuredClone(experiment),selection,view};}
};window.roadsterSim=Object.freeze(api);
const ro=new ResizeObserver(()=>{const{width,height}=$('viewport').getBoundingClientRect();if(width&&height){renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();}});ro.observe($('viewport'));
installCurve(baseSpec.ramp_curve_m);updateWall();syncExperiment();panels=createFloatingPanels({root:$('desk'),bottomInset:12,onVisibilityChange(id,visible){if(!visible&&id==='scene-panel'){playing=false;syncPlay();}}});
voiceFeedback=createVoiceFeedback({
 execute(command,payload){
  if(['setWall','setEntrySpeed','runTrial','adjustRamp'].includes(command))panels.show('edit-panel');
  if(['setView','setRampCurve','setRampHeight','loadPhysicsResult','runTrial','adjustRamp','compare'].includes(command))panels.show('scene-panel');
  return api[command](payload);
 },
 render(state){
  if(state.phase==='idle'){panels.hide('voice-panel');return;}
  $('voice-panel').dataset.phase=state.phase;
  $('voice-phase').textContent=({listening:'Listening',thinking:'Thinking',speaking:'Speaking',executing:'Working',done:'Done',attention:'Needs adjustment',error:'Error'})[state.phase];
  $('voice-transcript').textContent=state.transcript;
  $('voice-transcript').hidden=!state.transcript;
  $('voice-action').textContent=state.detail||state.action||'';
  $('voice-action').hidden=!$('voice-action').textContent;
  panels.show('voice-panel');
 }
});
const rect=$('viewport').getBoundingClientRect();renderer.setSize(rect.width,rect.height);camera.aspect=rect.width/rect.height;camera.updateProjectionMatrix();setView('scene');
let previous=performance.now();renderer.setAnimationLoop(()=>{const now=performance.now(),dt=Math.min((now-previous)/1000,.1);previous=now;if(playing){currentTime=Math.min(playEnd(),currentTime+dt*speed);if(currentTime>=playEnd()){playing=false;syncPlay();}updatePose();}controls.update();if(!$('scene-panel').classList.contains('is-hidden'))renderer.render(scene,camera);});

bridge=createIntegrationBridge({api:window.roadsterSim,getState:()=>window.roadsterSim.getState(),getParameters:()=>({vehicleScale:scale,rampHeight:inputRampHeight(),wall:{enabled:wallState.enabled,x:wallState.x,height:wallState.height},entrySpeedMs:baseSpec.entry_speed_ms,rampCurve:baseSpec.ramp_curve_m})});
bridge.announceReady();
