import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Box3,Vector3} from 'three';
for(const name of ['roadster-2026','launch-ramp','roadster-scene']){
 const data=await readFile(new URL(`../public/models/${name}.glb`,import.meta.url));
 assert.equal(data.subarray(0,4).toString(),'glTF');assert.equal(data.readUInt32LE(4),2);assert.equal(data.readUInt32LE(8),data.length);
 const gltf=await new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),'');
 let meshes=0;gltf.scene.traverse(o=>{if(o.isMesh){meshes++;assert.ok(o.geometry.attributes.position.count>0);}});
 const size=new Box3().setFromObject(gltf.scene).getSize(new Vector3());assert.ok(size.toArray().every(Number.isFinite));
 if(name==='roadster-2026')for(const [actual,expected] of [[size.x,4.65],[size.y,1.18],[size.z,2.05]])assert.ok(Math.abs(actual-expected)<.001);
 console.log(`${name}: loaded ${meshes} meshes; bounds ${size.toArray().map(n=>n.toFixed(3)).join(' × ')} m`);
}
