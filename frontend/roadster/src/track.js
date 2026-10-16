import * as THREE from 'three';

// Visual reconstruction from the supplied launch-ramp frame. Dimensions are editable assumptions.
export const TRACK_DEFAULTS = { height: 23, width: 5.6, approach: 25, thickness: 0.28 };
export function rampPoint(u, height = 23) {
  const a = new THREE.Vector3(-6, 0, 0), b = new THREE.Vector3(0, 7, 0);
  const curve = u <= .35
    ? new THREE.CubicBezierCurve3(a, new THREE.Vector3(-1.8, 0, 0), new THREE.Vector3(0, 2.8, 0), b)
    : new THREE.CubicBezierCurve3(b, new THREE.Vector3(0, 14, 0), new THREE.Vector3(-2.2, 18, 0), new THREE.Vector3(-5.5, 23, 0));
  const t = u <= .35 ? u / .35 : (u - .35) / .65;
  const p = curve.getPoint(t), tangent = curve.getTangent(t);
  p.y *= height / 23; tangent.y *= height / 23; tangent.normalize();
  return { position: p, tangent, normal: new THREE.Vector3(-tangent.y, tangent.x, 0) };
}
function beam(a, b, radius, material) {
  const v = b.clone().sub(a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, v.length(), 6), material);
  mesh.position.copy(a).add(b).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
  return mesh;
}
function strip(points, z0, z1, offset, material) {
  const vertices = [], indices = [];
  points.forEach(({ position:p, normal:n }, i) => {
    for(const z of [z0,z1]) vertices.push(p.x+n.x*offset,p.y+n.y*offset,z);
    if(i){ const j=i*2; indices.push(j-2,j,j-1,j,j+1,j-1); }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3)); geo.setIndex(indices); geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo,material); mesh.receiveShadow=true; mesh.castShadow=true; return mesh;
}
export function createTrack(options={}) {
  const config={...TRACK_DEFAULTS,...options};
  const group = new THREE.Group(); group.name = 'Launch_Ramp_visual_reconstruction';
  group.userData={type:'reference-reconstruction',units:'m',dimensions:'assumed',config};
  const surface=new THREE.MeshStandardMaterial({color:0x586066,roughness:.86,metalness:.16,envMapIntensity:.4,side:THREE.DoubleSide});
  const edge=new THREE.MeshStandardMaterial({color:0xbc5149,roughness:.55,side:THREE.DoubleSide});
  const white=new THREE.MeshStandardMaterial({color:0xeeeae2,roughness:.7,side:THREE.DoubleSide});
  const steel=new THREE.MeshStandardMaterial({color:0x68717a,metalness:.75,roughness:.45});
  const points=[];
  for(let i=0;i<=16;i++) points.push({position:new THREE.Vector3(-config.approach+(-6+config.approach)*i/16,0,0),normal:new THREE.Vector3(0,1,0)});
  for(let i=1;i<=128;i++) points.push(rampPoint(i/128,config.height));
  group.add(strip(points,-config.width/2,config.width/2,0,surface));
  group.add(strip(points,-config.width/2,config.width/2,-config.thickness,steel));
  for(const side of [-1,1]) {
    const z=side*(config.width/2-.09);
    group.add(strip(points,z-.07,z+.07,.025,edge));
    const outer = points.map(p=>p.position.clone().addScaledVector(p.normal,-config.thickness/2).setZ(side*config.width/2));
    group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(outer),160,.065,6,false),steel));
  }
  group.add(strip(points,-.035,.035,.023,white));
  // Steel side trusses follow the ramp profile; ties and cross-braces stay behind the deck.
  const frame=[];
  for(let i=0;i<=12;i++){
    const {position:p,normal:n}=rampPoint(i/12,config.height);
    frame.push({front:p.clone().addScaledVector(n,-.32),back:p.clone().addScaledVector(n,-1.65)});
  }
  for(const z of [-config.width/2-.12,config.width/2+.12]) {
    frame.forEach((s,i)=>{
      const f=s.front.clone().setZ(z),b=s.back.clone().setZ(z);
      group.add(beam(f,b,.06,steel));
      if(i){const prev=frame[i-1];group.add(beam(prev.front.clone().setZ(z),f,.065,steel),beam(prev.back.clone().setZ(z),b,.065,steel),beam(prev.back.clone().setZ(z),f,.045,steel));}
    });
    for(const index of [4,7,10,12]){
      const b=frame[index].back.clone().setZ(z),foot=new THREE.Vector3(2.7,0,z);
      group.add(beam(b,foot,.075,steel));
    }
  }
  frame.filter((_,i)=>i%2===0).forEach(s=>group.add(beam(s.back.clone().setZ(-config.width/2),s.back.clone().setZ(config.width/2),.055,steel)));
  const base = new THREE.Mesh(new THREE.BoxGeometry(6,.18,config.width+2),steel);base.position.set(1,.09,0);group.add(base);
  return group;
}
export function makeDemoTrajectory(height=23, vehicleHeight=1.18) {
  const samples=[], clearance=vehicleHeight/2+.04;
  const put=(t,p,angle)=>{const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),angle);samples.push({t,position:p.toArray(),quaternion:q.toArray()});};
  for(let i=0;i<=72;i++)put(i/30,new THREE.Vector3(-24+18*i/72,clearance,0),0);
  for(let i=1;i<=96;i++){
    const r=rampPoint(i/96,height);put(2.4+i/30,r.position.addScaledVector(r.normal,clearance),Math.atan2(r.tangent.y,r.tangent.x));
  }
  const exit=rampPoint(1,height),start=exit.position.addScaledVector(exit.normal,clearance),startAngle=Math.atan2(exit.tangent.y,exit.tangent.x);
  const finish=new THREE.Vector3(-29,clearance,0);
  for(let i=1;i<=108;i++){
    const u=i/108,p=start.clone().lerp(finish,u);p.y+=Math.sin(Math.PI*u)*8;
    const smooth=u*u*(3-2*u);put(5.6+i/30,p,startAngle+(Math.PI*2-startAngle)*smooth);
  }
  for(let i=1;i<=24;i++)put(9.2+i/30,new THREE.Vector3(-29+4*i/24,clearance,0),Math.PI*2);
  return {version:1,units:'m',upAxis:'Y',label:'Illustrative launch · synthetic',samples,source:'demo',duration:10,warnings:[]};
}
