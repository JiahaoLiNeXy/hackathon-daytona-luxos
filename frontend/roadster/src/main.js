import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {createRoadster,CAR_DIMENSIONS} from './car.js';
import {createTrack,makeDemoTrajectory,TRACK_DEFAULTS} from './track.js';
import {normalizeTrajectory,parseTrajectory,sampleTrajectory} from './trajectory.js';
import {overlapsWall} from './collision.js';
import {createFloatingPanels} from './floating-panels.js';
import {createIntegrationBridge} from './integration-bridge.js';
import './style.css';

const embed=new URLSearchParams(location.search).get('embed')==='1';
if(embed){document.documentElement.classList.add('embed');document.body.classList.add('embed');}
const $=id=>document.getElementById(id);
$('app').innerHTML=`
<main id="desk" class="desk">
  <section id="scene-panel" class="projection scene-panel" data-panel aria-label="Roadster module">
    <header class="panel-handle" data-drag-handle tabindex="0" aria-label="Move Roadster">
      <span class="handle-grip" aria-hidden="true">⠿</span><h1>Roadster</h1>
      <button class="icon-button close-panel" data-close-panel="scene-panel" aria-label="Hide Roadster">×</button>
    </header>
    <div class="viewport" id="viewport"></div>
    <div class="scene-tools"><div class="view-switch"><button id="view-scene" class="active">Scene</button><button id="view-car">Car</button><button id="view-side">Side</button></div><button id="reset-view" aria-label="Reset view">↺</button><span class="tool-spacer"></span><button id="scene-play" class="primary">▶ Play</button><button data-toggle-panel="edit-panel">Edit</button></div>
    <span class="resize-mark" aria-hidden="true"></span>
  </section>
  <section id="edit-panel" class="projection edit-panel is-hidden" data-panel aria-label="Edit module">
    <header class="panel-handle" data-drag-handle tabindex="0" aria-label="Move Edit"><span class="handle-grip" aria-hidden="true">⠿</span><h2>Edit</h2><button class="icon-button close-panel" data-close-panel="edit-panel" aria-label="Hide Edit">×</button></header>
    <div class="panel-content">
      <div class="row"><label for="car-scale">Car size</label><output id="scale-value">1.00×</output></div><input id="car-scale" type="range" min="0.5" max="1.6" step="0.01" value="1"/>
      <div class="dimensions"><span id="dim-length">4.65</span><i>×</i><span id="dim-width">2.05</span><i>×</i><span id="dim-height">1.18</span><i>m</i></div>
      <div class="rule"></div><div class="row"><label for="ramp-height">Ramp height</label><span class="input-unit"><input id="ramp-height" type="number" min="12" max="32" step="0.5" value="23"/>m</span></div>
      <div class="rule"></div><div class="row"><label for="wall-enabled">Wall</label><input id="wall-enabled" class="toggle" type="checkbox"/></div>
      <div id="wall-fields" hidden><div class="row"><label for="wall-height">Height</label><span class="input-unit"><input id="wall-height" type="number" min="1" max="30" step="0.5" value="12"/>m</span></div><div class="row"><label for="wall-x">Position X</label><span class="input-unit"><input id="wall-x" type="number" min="-40" max="10" step="0.5" value="-18"/>m</span></div><div id="collision-status" class="check-status" title="Bounding-box overlap at this pose only">No overlap</div></div>
    </div>
  </section>
  <section id="motion-panel" class="projection motion-panel is-hidden" data-panel aria-label="Motion module">
    <header class="panel-handle" data-drag-handle tabindex="0" aria-label="Move Motion"><span class="handle-grip" aria-hidden="true">⠿</span><h2>Motion</h2><span id="source-name" class="source-tag">Demo</span><button class="icon-button close-panel" data-close-panel="motion-panel" aria-label="Hide Motion">×</button></header>
    <div class="panel-content"><div class="play-controls"><button id="play" class="primary">▶ Play</button><button id="restart" aria-label="Restart">↺</button><select id="speed" aria-label="Speed"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option></select><span id="time-label" class="time-label">0.00 / 10.00 s</span></div><input id="timeline" type="range" min="0" max="10" step="0.001" value="0" aria-label="Time"/><div class="telemetry"><span>X <b id="pos-x">−24.00</b></span><span>Y <b id="pos-y">0.63</b></span><span>Z <b id="pos-z">0.00</b></span></div></div>
  </section>
  <section id="assets-panel" class="projection assets-panel is-hidden" data-panel aria-label="Files module">
    <header class="panel-handle" data-drag-handle tabindex="0" aria-label="Move Files"><span class="handle-grip" aria-hidden="true">⠿</span><h2>Files</h2><button class="icon-button close-panel" data-close-panel="assets-panel" aria-label="Hide Files">×</button></header>
    <div class="panel-content"><button id="import-button" class="wide primary">Import</button><div class="file-actions"><button id="demo-button">Demo</button><button id="example-button">Sample</button></div><div class="rule"></div><div class="export-list"><button id="export-car"><span>Car</span><small>GLB ↧</small></button><button id="export-ramp"><span>Ramp</span><small>GLB ↧</small></button><button id="export-scene"><span>Scene</span><small>GLB ↧</small></button><button id="snapshot"><span>Image</span><small>PNG ↧</small></button></div></div>
  </section>
  <nav class="module-dock" aria-label="Modules"><span class="desk-mark" aria-hidden="true"><i></i></span><button data-toggle-panel="scene-panel" aria-pressed="true">Model</button><button data-toggle-panel="edit-panel" aria-pressed="false">Edit</button><button data-toggle-panel="motion-panel" aria-pressed="false">Motion</button><button data-toggle-panel="assets-panel" aria-pressed="false">Files</button></nav>
  <input id="file-input" type="file" accept=".json,.csv" hidden/><div id="toast" class="toast" role="status"></div>
</main>
`;
let panels, bridge;

let renderer;
try {renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});}
catch(error){$('app').innerHTML='<div class="fatal">This browser could not start WebGL.<br>Open this local preview in Chrome or Safari with hardware acceleration enabled.</div>';throw error;}
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0x000000,0);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
$('viewport').append(renderer.domElement);renderer.domElement.setAttribute('aria-label','Interactive 3D Roadster and launch ramp');
const scene=new THREE.Scene();scene.fog=null;
const camera=new THREE.PerspectiveCamera(35,1,.05,350);
const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.07;controls.maxDistance=130;controls.minDistance=2;controls.maxPolarAngle=Math.PI*.96;
const room=new RoomEnvironment();const pmrem=new THREE.PMREMGenerator(renderer);const env=pmrem.fromScene(room,.035);scene.environment=env.texture;room.dispose();pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xdeecff,0x414a3b,1.2));
const sun=new THREE.DirectionalLight(0xeaf4ff,3.0);sun.position.set(-16,38,22);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-50;sun.shadow.camera.right=50;sun.shadow.camera.top=45;sun.shadow.camera.bottom=-45;sun.shadow.camera.far=130;sun.shadow.normalBias=.03;scene.add(sun);
const fill=new THREE.DirectionalLight(0xbce7dc,1.5);fill.position.set(8,20,-18);scene.add(fill);
const stage=new THREE.Mesh(new THREE.PlaneGeometry(260,260),new THREE.ShadowMaterial({opacity:.13}));stage.rotation.x=-Math.PI/2;stage.position.y=-.01;stage.receiveShadow=true;scene.add(stage);
const grid=new THREE.GridHelper(150,75,0x35443f,0x26332f);grid.position.y=-.005;grid.material.transparent=true;grid.material.opacity=.18;grid.visible=false;scene.add(grid);
const assets=new THREE.Group();assets.name='Roadster_Launch_Study';assets.userData={units:'m',upAxis:'Y',forwardAxis:'X',source:'Visual reconstruction; estimated dimensions; no physical calibration'};scene.add(assets);
let track=createTrack();assets.add(track);
const car=createRoadster();car.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});assets.add(car);
const studioCar=createRoadster();studioCar.name='Vehicle_inspection_copy';studioCar.visible=false;scene.add(studioCar);
const wallState={enabled:false,height:12,x:-18,width:8,thickness:.35};
const wall=new THREE.Group();wall.name='Editable_wall';
const wallMat=new THREE.MeshStandardMaterial({color:0x9cad99,roughness:.8,metalness:.03,transparent:true,opacity:.52,side:THREE.DoubleSide});
const wallMesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),wallMat);wallMesh.castShadow=true;wallMesh.receiveShadow=true;wall.add(wallMesh);
const wallOutline=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1,1,1)),new THREE.LineBasicMaterial({color:0xc4ddba}));wall.add(wallOutline);assets.add(wall);
let pathLine;
let scale=1,rampHeight=TRACK_DEFAULTS.height,currentTime=0,playing=false,speed=1,view='scene';
let trajectory=makeDemoTrajectory();let collision=false,previousFrame=performance.now();let toastTimer;let importGeneration=0;
function toast(message){$('toast').textContent=message;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').textContent='',7000);}
function disposeObject(root){root.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});}
function updateWall(){wall.visible=wallState.enabled;wall.position.set(wallState.x,wallState.height/2,0);wallMesh.scale.set(wallState.thickness,wallState.height,wallState.width);wallOutline.scale.copy(wallMesh.scale);updatePose();}
function drawPath(){if(pathLine){scene.remove(pathLine);pathLine.geometry.dispose();pathLine.material.dispose();}const points=trajectory.samples.map(s=>new THREE.Vector3(...s.position));pathLine=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineDashedMaterial({color:0x8ebcad,dashSize:.3,gapSize:.22,transparent:true,opacity:.38}));pathLine.name='Trajectory_preview';pathLine.computeLineDistances();pathLine.visible=view!=='car';scene.add(pathLine);}
function syncPlay(){for(const id of ['play','scene-play'])$(id).textContent=playing?'Ⅱ Pause':'▶ Play';}
function setTrajectory(next){
 trajectory=next;playing=false;currentTime=0;syncPlay();
 $('timeline').max=trajectory.duration;
 $('source-name').textContent=trajectory.source==='demo'?'Demo':'Imported';
 $('source-name').title=trajectory.source==='demo'?'Illustrative trajectory':trajectory.label;
 drawPath();updatePose();
 if(trajectory.warnings?.length)toast('Rotation follows path.');
}
function regenerateDemo(){if(trajectory.source==='demo')setTrajectory(makeDemoTrajectory(rampHeight,CAR_DIMENSIONS.height*scale));else{playing=false;syncPlay();updatePose();toast('Scene updated · trajectory unchanged');}}
function updatePose(){const pose=sampleTrajectory(trajectory,currentTime);car.position.copy(pose.position);car.quaternion.copy(pose.quaternion);car.scale.setScalar(scale);collision=overlapsWall(pose.position,pose.quaternion,CAR_DIMENSIONS,scale,wallState);wallMat.color.set(collision?0xc87552:0x9cad99);wallOutline.material.color.set(collision?0xffab7c:0xc4ddba);$('collision-status').classList.toggle('hit',collision);$('collision-status').textContent=collision?'Box overlap':'No overlap';$('timeline').value=currentTime;$('time-label').textContent=`${currentTime.toFixed(2)} / ${trajectory.duration.toFixed(2)} s`;$('pos-x').textContent=pose.position.x.toFixed(2);$('pos-y').textContent=pose.position.y.toFixed(2);$('pos-z').textContent=pose.position.z.toFixed(2);}
function setView(next){view=next;const inspection=next==='car';assets.visible=!inspection;studioCar.visible=inspection;studioCar.scale.setScalar(scale);studioCar.position.set(0,CAR_DIMENSIONS.height*scale/2,0);pathLine.visible=!inspection;for(const [id,key] of [['view-scene','scene'],['view-car','car'],['view-side','side']])$(id).classList.toggle('active',next===key);
 if(inspection){controls.target.set(0,.4,0);camera.position.set(6,3.3,6);controls.minDistance=2;controls.maxDistance=22;}
 else if(next==='side'){controls.target.set(-11,10,0);camera.position.set(-11,10,69);controls.minDistance=10;controls.maxDistance=140;}
 else{controls.target.set(-10,9,0);camera.position.set(-40,24,53);controls.minDistance=6;controls.maxDistance=140;}
 controls.update();}
function setScale(value,source='api'){if(!Number.isFinite(value)||value<.5||value>1.6)throw new Error('Vehicle scale must be between 0.5 and 1.6.');scale=value;$('car-scale').value=value;$('scale-value').textContent=`${value.toFixed(2)}×`;$('dim-length').textContent=(CAR_DIMENSIONS.length*scale).toFixed(2);$('dim-width').textContent=(CAR_DIMENSIONS.width*scale).toFixed(2);$('dim-height').textContent=(CAR_DIMENSIONS.height*scale).toFixed(2);studioCar.scale.setScalar(scale);studioCar.position.y=CAR_DIMENSIONS.height*scale/2;regenerateDemo();bridge?.notifyParametersChanged(source);}
function setRampHeight(value,source='api'){if(!Number.isFinite(value)||value<12||value>32)throw new Error('Ramp height must be between 12 and 32 metres.');rampHeight=value;$('ramp-height').value=value;assets.remove(track);disposeObject(track);track=createTrack({height:value});assets.add(track);regenerateDemo();bridge?.notifyParametersChanged(source);}
function changeWall(patch,source='api'){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['enabled','x','height'].includes(key)))throw new Error('Wall accepts only enabled, x, and height.');const next={...wallState,...patch};if(typeof next.enabled!=='boolean'||!Number.isFinite(next.x)||next.x < -40||next.x>10||!Number.isFinite(next.height)||next.height<1||next.height>30)throw new Error('Wall: height 1–30 m, X position −40–10 m.');Object.assign(wallState,next);$('wall-enabled').checked=next.enabled;$('wall-height').value=next.height;$('wall-x').value=next.x;$('wall-fields').hidden=!next.enabled;updateWall();bridge?.notifyParametersChanged(source);}
function setPlaybackRate(value){if(![.25,.5,1,2].includes(value))throw new Error('Playback rate must be 0.25, 0.5, 1, or 2.');speed=value;$('speed').value=String(value);return speed;}
function guard(action){try{action();}catch(error){toast(error.message);}}
async function importFile(file){if(!file)return;const generation=++importGeneration;try{if(file.size>10*1024*1024)throw new Error('Trajectory file must be under 10 MB.');const text=await file.text();if(generation!==importGeneration)return;const next=parseTrajectory(text,file.name);setTrajectory(next);setView('scene');toast(`Imported · ${next.samples.length.toLocaleString()} poses`);}catch(error){if(generation===importGeneration)toast(error.message);}finally{$('file-input').value='';}}
$('import-button').onclick=()=>$('file-input').click();$('file-input').onchange=e=>importFile(e.target.files[0]);
$('viewport').addEventListener('dragover',e=>e.preventDefault());$('viewport').addEventListener('drop',e=>{e.preventDefault();importFile(e.dataTransfer.files[0]);});
function togglePlayback(){if(currentTime>=trajectory.duration)currentTime=0;playing=!playing;syncPlay();if(view==='car')setView('scene');panels.show('scene-panel');}
$('play').onclick=()=>{togglePlayback();panels.bringToFront('motion-panel');};$('scene-play').onclick=togglePlayback;
$('restart').onclick=()=>{playing=false;currentTime=0;syncPlay();updatePose();};
$('timeline').oninput=e=>{playing=false;syncPlay();currentTime=Number(e.target.value);updatePose();};
$('speed').onchange=e=>guard(()=>setPlaybackRate(Number(e.target.value)));
$('car-scale').oninput=e=>guard(()=>setScale(Number(e.target.value),'ui'));
$('ramp-height').onchange=e=>guard(()=>setRampHeight(Number(e.target.value),'ui'));
$('wall-enabled').onchange=e=>guard(()=>changeWall({enabled:e.target.checked},'ui'));
$('wall-height').onchange=e=>guard(()=>changeWall({height:Number(e.target.value)},'ui'));
$('wall-x').onchange=e=>guard(()=>changeWall({x:Number(e.target.value)},'ui'));
$('view-scene').onclick=()=>setView('scene');$('view-car').onclick=()=>{playing=false;syncPlay();setView('car');};$('view-side').onclick=()=>setView('side');$('reset-view').onclick=()=>setView(view);
$('demo-button').onclick=()=>{importGeneration++;setTrajectory(makeDemoTrajectory(rampHeight,CAR_DIMENSIONS.height*scale));setView('scene');};
$('example-button').onclick=async()=>{const generation=++importGeneration;try{const response=await fetch('./examples/engineer-trajectory.json');if(!response.ok)throw new Error('Example could not be loaded.');const value=await response.json();if(generation!==importGeneration)return;setTrajectory(normalizeTrajectory(value));setView('scene');toast('Sample loaded');}catch(error){toast(error.message);}};
async function exportAsset(kind){const group=new THREE.Group();group.name=`Roadster_${kind}`;group.userData={units:'m',upAxis:'Y',forwardAxis:'X',dimensions:'Estimated, not official CAD'};if(kind==='car'){const copy=createRoadster();copy.scale.setScalar(scale);group.add(copy);}else if(kind==='ramp'){group.add(createTrack({height:rampHeight}));}else{const copy=assets.clone(true);copy.visible=true;group.add(copy);}try{const data=await new GLTFExporter().parseAsync(group,{binary:true});const url=URL.createObjectURL(new Blob([data],{type:'model/gltf-binary'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=`roadster-${kind}.glb`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),2000);toast(`${kind[0].toUpperCase()+kind.slice(1)} saved`);}catch(error){toast(`Export failed: ${error.message}`);}finally{if(kind!=='scene')disposeObject(group);}}
$('snapshot').onclick=()=>{renderer.render(scene,camera);renderer.domElement.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`roadster-${view}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);});};
for(const kind of ['car','ramp','scene'])$(`export-${kind}`).onclick=()=>exportAsset(kind);
// Direct module integration. Explicit methods, no network, no eval. The iframe bridge accepts only its same-origin parent.
window.roadsterSim=Object.freeze({
 loadTrajectory(data){importGeneration++;const next=normalizeTrajectory(data);setTrajectory(next);return {samples:next.samples.length,duration:next.duration,warnings:next.warnings};},
 play(){if(currentTime>=trajectory.duration)currentTime=0;playing=true;syncPlay();if(view==='car')setView('scene');panels.show('scene-panel');},
 pause(){playing=false;syncPlay();},
 seek(t){if(!Number.isFinite(t))throw new Error('Time must be a finite number.');currentTime=THREE.MathUtils.clamp(t,0,trajectory.duration);playing=false;syncPlay();updatePose();},
 setVehicleScale:setScale,setRampHeight,setWall:changeWall,setPlaybackRate,
 getReadyState(){return bridge.getReadyState();},
 reset(){playing=false;currentTime=0;syncPlay();updatePose();},
 setView(name){if(!['scene','side','car'].includes(name))throw new Error('Unknown view.');setView(name);},
 showModule(id){panels.show(id);},
 hideModule(id){panels.hide(id);},
 moveModule({id,x,y}){panels.move(id,{x,y});},
 getState(){return {modules:panels.getState(),time:currentTime,duration:trajectory.duration,playing,playbackRate:speed,parameterRevision:bridge?.getRevision()??0,source:trajectory.source,position:car.position.toArray(),quaternion:car.quaternion.toArray(),scale,rampHeight,wall:{...wallState},overlapAtCurrentPose:collision,view};},
 exportGLB:exportAsset
});
const ro=new ResizeObserver(()=>{const {width,height}=$('viewport').getBoundingClientRect();if(width&&height){renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();}});ro.observe($('viewport'));
setTrajectory(trajectory);setView('scene');updateWall();
panels=createFloatingPanels({root:$('desk'),bottomInset:84,onVisibilityChange(id,visible){if(!visible&&id==='scene-panel'){playing=false;syncPlay();}}});
renderer.setAnimationLoop(()=>{const now=performance.now(),dt=Math.min((now-previousFrame)/1000,.1);previousFrame=now;if(playing){currentTime=Math.min(trajectory.duration,currentTime+dt*speed);if(currentTime>=trajectory.duration){playing=false;syncPlay();}updatePose();}controls.update();if(!$('scene-panel').classList.contains('is-hidden'))renderer.render(scene,camera);});

bridge=createIntegrationBridge({api:window.roadsterSim,getState:()=>window.roadsterSim.getState(),getParameters:()=>({vehicleScale:scale,rampHeight,wall:{enabled:wallState.enabled,x:wallState.x,height:wallState.height}})});
bridge.announceReady();
