import test from 'node:test';
import assert from 'node:assert/strict';
import {Quaternion,Vector3} from 'three';
import {overlapsWall} from '../src/collision.js';
const dimensions={length:4,height:1,width:2};
const wall={enabled:true,height:3,x:0,width:6,thickness:.3};
test('wall overlap respects full oriented vehicle extent and height',()=>{
 const q=new Quaternion();
 assert.equal(overlapsWall(new Vector3(2,1,0),q,dimensions,1,wall),true);
 assert.equal(overlapsWall(new Vector3(2.2,1,0),q,dimensions,1,wall),false);
 assert.equal(overlapsWall(new Vector3(0,3.6,0),q,dimensions,1,wall),false);
 const vertical=new Quaternion().setFromAxisAngle(new Vector3(0,0,1),Math.PI/2);
 assert.equal(overlapsWall(new Vector3(0,3.6,0),vertical,dimensions,1,wall),true);
 assert.equal(overlapsWall(new Vector3(0,1,4.1),q,dimensions,1,wall),false);
 assert.equal(overlapsWall(new Vector3(2,1,0),q,dimensions,.5,wall),false);
 assert.equal(overlapsWall(new Vector3(0,1,0),q,dimensions,1,{...wall,enabled:false}),false);
});
