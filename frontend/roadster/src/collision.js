import {Box3,Matrix3,Vector3} from 'three';
import {OBB} from 'three/addons/math/OBB.js';
export function overlapsWall(position,quaternion,dimensions,scale,wall){
  if(!wall.enabled) return false;
  const rotation=new Matrix3();
  // Quaternion basis without allocating a scene object.
  const x=new Vector3(1,0,0).applyQuaternion(quaternion),y=new Vector3(0,1,0).applyQuaternion(quaternion),z=new Vector3(0,0,1).applyQuaternion(quaternion);
  rotation.set(x.x,y.x,z.x,x.y,y.y,z.y,x.z,y.z,z.z);
  const box=new OBB(position.clone(),new Vector3(dimensions.length,dimensions.height,dimensions.width).multiplyScalar(scale/2),rotation);
  return box.intersectsBox3(new Box3(new Vector3(wall.x-wall.thickness/2,0,-wall.width/2),new Vector3(wall.x+wall.thickness/2,wall.height,wall.width/2)));
}
