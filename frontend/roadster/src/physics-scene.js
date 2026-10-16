import * as THREE from 'three';

/** Ground reference only. The ramp mesh is built separately from ramp_curve_m. */
export function createPhysicsReference(problemSpec, trajectory) {
  const group = new THREE.Group();
  group.name = 'Physics_ground_reference';
  group.userData = {units:'m', upAxis:'Y', description:'Ground profile reference; no contact simulation'};
  const groundMaterial = new THREE.LineBasicMaterial({color:0xb3d4df, transparent:true, opacity:.55});
  function line(points, material, name) {
    const object = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(...p))), material);
    object.name = name;
    group.add(object);
  }
  const xs = [...trajectory.samples.map(p=>p.position[0]), ...problemSpec.ramp_curve_m.map(p=>p.x)];
  let minX=Infinity,maxX=-Infinity;
  for(const x of xs){minX=Math.min(minX,x);maxX=Math.max(maxX,x);}
  minX-=4;maxX+=4;
  const ground=problemSpec.ground_profile;
  const intervals=ground.type==='gap'
    ? [[Math.min(minX,ground.gap_start_x_m-4),ground.gap_start_x_m],[ground.gap_end_x_m,Math.max(maxX,ground.gap_end_x_m+4)]]
    : [[minX,maxX]];
  for(const [a,b] of intervals){
    for(const z of [-3,3])line([[a,ground.landing_level_m,z],[b,ground.landing_level_m,z]],groundMaterial,'Ground_reference');
    for(const x of [a,b])line([[x,ground.landing_level_m,-3],[x,ground.landing_level_m,3]],groundMaterial,'Ground_edge');
  }
  return group;
}
