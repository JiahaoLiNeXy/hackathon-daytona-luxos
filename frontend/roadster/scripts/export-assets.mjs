import {writeFile,mkdir} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {createRoadster} from '../src/car.js';
import {createTrack,makeDemoTrajectory} from '../src/track.js';
// The exporter uses this small browser FileReader API for GLB packaging. Geometry needs no textures.
globalThis.FileReader=class {
 readAsArrayBuffer(blob){blob.arrayBuffer().then(result=>{this.result=result;this.onloadend?.();}).catch(error=>this.onerror?.(error));}
 readAsDataURL(blob){blob.arrayBuffer().then(result=>{this.result=`data:${blob.type};base64,${Buffer.from(result).toString('base64')}`;this.onloadend?.();}).catch(error=>this.onerror?.(error));}
};
await mkdir(new URL('../public/models/',import.meta.url),{recursive:true});
const car=createRoadster(),ramp=createTrack();
const scene=new THREE.Group();scene.name='Roadster_launch_reference';scene.userData={units:'m',upAxis:'Y',forwardAxis:'X',dimensions:'Visual estimates, not official dimensions'};
const parked=car.clone(true);parked.position.set(-24,.63,0);scene.add(parked,ramp.clone(true));
for(const [name,model] of [['roadster-2026',car],['launch-ramp',ramp],['roadster-scene',scene]]){
 const binary=await new GLTFExporter().parseAsync(model,{binary:true});
 await writeFile(new URL(`../public/models/${name}.glb`,import.meta.url),Buffer.from(binary));
 console.log(`${name}.glb: ${binary.byteLength} bytes`);
}
const demo=makeDemoTrajectory();await writeFile(new URL('../public/examples/illustrative-launch.json',import.meta.url),JSON.stringify({version:1,units:'m',upAxis:'Y',label:'Synthetic illustrative launch, not measured',samples:demo.samples},null,2)+'\n');
