import * as THREE from 'three';

/** Visual reconstruction of the silver October 2026 concept, not a factory CAD model.
 * Local frame: +X forward, +Y up, +Z right. The origin is the visual bounds centre.
 */
export const CAR_DIMENSIONS = Object.freeze({ length: 4.65, width: 2.05, height: 1.18 });

export function createRoadster() {
  const car = new THREE.Group();
  car.name = 'Roadster_2026_visual_reconstruction';
  car.userData = {
    description: 'Approximate visual reconstruction of the October 2026 silver angular Tesla Roadster concept. Dimensions are simulation assumptions, not manufacturer measurements.',
    localForward: '+X', units: 'metres', dimensions: { ...CAR_DIMENSIONS },
  };
  const silver = new THREE.MeshStandardMaterial({ color: 0xaab0b8, metalness: 0.83, roughness: 0.27, flatShading: true });
  const silverLight = new THREE.MeshStandardMaterial({ color: 0xbec5cc, metalness: 0.84, roughness: 0.25, flatShading: true });
  const silverDark = new THREE.MeshStandardMaterial({ color: 0x777f8b, metalness: 0.8, roughness: 0.3, flatShading: true });
  const black = new THREE.MeshStandardMaterial({ color: 0x10141a, metalness: 0.3, roughness: 0.36 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111316, metalness: 0, roughness: 0.84 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x101a25, metalness: 0.72, roughness: 0.12, side: THREE.DoubleSide });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc1c8d1, metalness: 0.95, roughness: 0.2 });
  const brake = new THREE.MeshStandardMaterial({ color: 0x555b63, metalness: 0.85, roughness: 0.38 });
  const red = new THREE.MeshStandardMaterial({ color: 0xcf2636, metalness: 0.45, roughness: 0.3 });
  const headlight = new THREE.MeshStandardMaterial({ color: 0xe4f5ff, emissive: 0xb7e0ff, emissiveIntensity: 3.2, roughness: 0.2 });
  const taillight = new THREE.MeshStandardMaterial({ color: 0xff2136, emissive: 0xff1228, emissiveIntensity: 2.3, roughness: 0.25 });

  function mesh(geometry, material, name, parent = car) {
    const m = new THREE.Mesh(geometry, material);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  function surface(points, triangles, material, name, parent = car) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
    geometry.setIndex(triangles.flat());
    geometry.computeVertexNormals();
    return mesh(geometry, material, name, parent);
  }
  function quad(points, material, name, parent = car) {
    return surface(points, [[0, 1, 2], [0, 2, 3]], material, name, parent);
  }
  function box(name, size, position, material, parent = car) {
    const m = mesh(new THREE.BoxGeometry(...size), material, name, parent);
    m.position.set(...position);
    return m;
  }
  function beam(name, a, b, radius, material, parent = car) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const delta = end.clone().sub(start);
    const m = mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), 5), material, name, parent);
    m.position.copy(start.add(end).multiplyScalar(0.5));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    return m;
  }

  // Longitudinal stations: [x, half width, hood/deck height, shoulder height].
  // Distinct flat hood, raised fenders, and crisp shoulders avoid the rounded 2017 silhouette.
  const stations = [
    [-2.325, 0.84, 0.095, 0.10], [-2.08, 0.935, 0.185, 0.205],
    [-1.48, 0.985, 0.205, 0.235], [-0.85, 0.96, 0.16, 0.19],
    [0.15, 0.915, 0.105, 0.14], [0.75, 0.93, 0.10, 0.175],
    [1.48, 0.965, 0.065, 0.205], [1.99, 0.875, -0.035, 0.075],
    [2.325, 0.735, -0.145, -0.105],
  ];
  function at(x, column) {
    for (let i = 1; i < stations.length; i++) {
      if (x <= stations[i][0]) {
        const a = stations[i - 1], b = stations[i];
        return THREE.MathUtils.lerp(a[column], b[column], THREE.MathUtils.clamp((x - a[0]) / (b[0] - a[0]), 0, 1));
      }
    }
    return stations.at(-1)[column];
  }
  function sideZ(x, y) {
    return at(x, 1) - Math.max(0, -y - 0.07) * 0.12;
  }
  const body = new THREE.Group(); body.name = 'Faceted_silver_body'; car.add(body);
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    for (const s of [-1, 1]) {
      const pts = [
        [a[0], a[2], 0], [b[0], b[2], 0],
        [b[0], b[3] + 0.008, s * b[1] * 0.76], [a[0], a[3] + 0.008, s * a[1] * 0.76],
      ];
      if (s === 1) pts.reverse();
      quad(pts, silverLight, `Upper_plane_${i}_${s}`, body);
      const edge = [
        [a[0], a[3] + 0.008, s * a[1] * 0.76], [b[0], b[3] + 0.008, s * b[1] * 0.76],
        [b[0], b[3], s * b[1]], [a[0], a[3], s * a[1]],
      ];
      if (s === 1) edge.reverse();
      quad(edge, silver, `Shoulder_plane_${i}_${s}`, body);
    }
  }
  // A concave contour leaves actual empty wheel arches, rather than painting circles on a slab.
  const sideOutline = stations.map(s => new THREE.Vector2(s[0], s[3])).reverse();
  sideOutline.push(new THREE.Vector2(-2.325, -0.35), new THREE.Vector2(-1.90, -0.405));
  const archRadius = 0.393, wheelY = -0.235;
  for (const centre of [-1.48, 1.48]) {
    sideOutline.push(new THREE.Vector2(centre - archRadius, -0.405));
    for (let i = 0; i <= 20; i++) {
      const theta = Math.PI - i * Math.PI / 20;
      sideOutline.push(new THREE.Vector2(centre + Math.cos(theta) * archRadius, wheelY + Math.sin(theta) * archRadius));
    }
    sideOutline.push(new THREE.Vector2(centre + archRadius, -0.405));
  }
  sideOutline.push(new THREE.Vector2(2.325, -0.31));
  const sideTriangles = THREE.ShapeUtils.triangulateShape(sideOutline, []);
  for (const s of [-1, 1]) {
    const points = sideOutline.map(p => [p.x, p.y, s * sideZ(p.x, p.y)]);
    const tris = sideTriangles.map(t => s === 1 ? t : [...t].reverse());
    surface(points, tris, silver, `Sculpted_side_${s}`, body);
    // Arch lips and dark inner liners follow the same contour.
    for (const centre of [-1.48, 1.48]) {
      for (let i = 0; i < 20; i++) {
        const a = Math.PI - i * Math.PI / 20, b = Math.PI - (i + 1) * Math.PI / 20;
        const p = angle => {
          const x = centre + Math.cos(angle) * archRadius, y = wheelY + Math.sin(angle) * archRadius;
          return [x, y, s * (sideZ(x, y) + 0.001)];
        };
        const aa = p(a), bb = p(b);
        beam(`Arch_lip_${centre}_${s}_${i}`, aa, bb, 0.006, silverDark, body);
        quad([aa, bb, [bb[0], bb[1], s * 0.76], [aa[0], aa[1], s * 0.76]], black, `Wheelhouse_${centre}_${s}_${i}`, body);
      }
    }
    // Flat black rocker blade between the wheel openings.
    const z = s * 0.92;
    box(`Carbon_side_skirt_${s}`, [2.10, 0.075, 0.09], [0, -0.402, z], black, body);
    beam(`Shoulder_crease_${s}`, [-0.98, 0.16, s * 0.957], [0.98, 0.164, s * 0.941], 0.004, silverDark, body);
  }
  box('Undertray', [3.55, 0.045, 1.47], [-0.02, -0.421, 0], black, body);

  // Sloping angular front face and a shallow aero intake / splitter.
  quad([[2.313, -0.145, -0.735], [2.313, -0.145, 0.735], [2.313, -0.31, 0.735], [2.313, -0.31, -0.735]], silver, 'Nose_face', body);
  box('Front_intake_shadow', [0.018, 0.071, 1.19], [2.315, -0.263, 0], black, body);
  box('Front_splitter', [0.21, 0.028, 1.65], [2.20, -0.363, 0], black, body);
  for (const s of [-1, 1]) {
    // The white strip wraps outward across the two flat facets at each corner.
    beam(`Headlamp_recess_${s}`, [2.288, -0.110, s * 0.27], [2.288, -0.086, s * 0.716], 0.015, black, body);
    beam(`Headlamp_white_${s}`, [2.288, -0.102, s * 0.28], [2.288, -0.078, s * 0.714], 0.0085, headlight, body);
    beam(`Headlamp_corner_${s}`, [2.288, -0.078, s * 0.714], [2.10, 0.025, s * 0.824], 0.008, headlight, body);
    quad([[2.24, -0.195, s * 0.75], [1.99, -0.10, s * 0.876], [2.00, -0.29, s * 0.85], [2.24, -0.31, s * 0.74]], black, `Front_brake_duct_${s}`, body);
    beam(`Hood_shutline_${s}`, [1.97, -0.018, s * 0.59], [0.68, 0.123, s * 0.62], 0.0025, silverDark, body);
  }

  const canopy = new THREE.Group(); canopy.name = 'Continuous_tinted_canopy'; car.add(canopy);
  const windshieldBottom = [[0.74, 0.132, -0.714], [0.74, 0.132, 0.714]];
  const windshieldTop = [[-0.22, 0.57, -0.622], [-0.22, 0.57, 0.622]];
  quad([windshieldBottom[0], windshieldTop[0], windshieldTop[1], windshieldBottom[1]], glass, 'Long_raked_windshield', canopy);
  quad([[-0.22, 0.57, -0.622], [-0.83, 0.555, -0.615], [-0.83, 0.555, 0.615], [-0.22, 0.57, 0.622]], glass, 'Dark_glass_roof', canopy);
  quad([[-0.83, 0.555, -0.615], [-1.48, 0.223, -0.76], [-1.48, 0.223, 0.76], [-0.83, 0.555, 0.615]], glass, 'Sloping_rear_glass', canopy);
  for (const s of [-1, 1]) {
    const points = [[0.74, 0.132, s * 0.714], [-0.22, 0.57, s * 0.622], [-0.83, 0.555, s * 0.615], [-1.48, 0.223, s * 0.76], [-0.98, 0.186, s * 0.857], [0.55, 0.155, s * 0.831]];
    surface(points, [[0, 1, 5], [1, 2, 5], [2, 4, 5], [2, 3, 4]], glass, `Side_window_${s}`, canopy);
    beam(`Silver_A_pillar_${s}`, points[0], points[1], 0.014, silverLight, canopy);
    beam(`Roof_edge_${s}`, points[1], points[2], 0.014, silverLight, canopy);
    beam(`Rear_buttress_${s}`, points[2], points[3], 0.018, silver, canopy);
    beam(`Window_lower_trim_${s}`, points[4], points[5], 0.009, black, canopy);
    beam(`Window_divider_${s}`, [-0.69, 0.546, s * 0.618], [-0.89, 0.19, s * 0.851], 0.007, black, canopy);
    // Restrained door outlines and flush handles; one long door per side.
    const door = [[0.58, 0.14], [0.53, -0.28], [0.35, -0.335], [-0.74, -0.335], [-1.01, -0.24], [-1.05, 0.16]];
    for (let i = 0; i < door.length - 1; i++) {
      const a = door[i], b = door[i + 1];
      beam(`Door_seam_${s}_${i}`, [a[0], a[1], s * (sideZ(...a) + 0.003)], [b[0], b[1], s * (sideZ(...b) + 0.003)], 0.0027, black, body);
    }
    box(`Flush_door_handle_${s}`, [0.18, 0.017, 0.008], [-0.68, 0.085, s * 0.951], black, body);
    beam(`Mirror_stalk_${s}`, [0.48, 0.163, s * 0.82], [0.40, 0.208, s * 0.943], 0.013, black, body);
    const mirror = box(`Faceted_mirror_${s}`, [0.18, 0.062, 0.11], [0.36, 0.22, s * 0.957], silverDark, body);
    mirror.rotation.y = s * 0.13;
  }
  // A narrow roof crest establishes the 1.18 m nominal visual envelope.
  beam('Roof_front_edge', [-0.22, 0.578674, -0.622], [-0.22, 0.578674, 0.622], 0.014, black, canopy);

  // Broad high tail, continuous red signature, low deployed active spoiler.
  quad([[-2.315, 0.095, 0.84], [-2.315, 0.095, -0.84], [-2.315, -0.35, -0.84], [-2.315, -0.35, 0.84]], silverDark, 'Tail_face', body);
  box('Rear_light_recess', [0.014, 0.039, 1.68], [-2.317, 0.052, 0], black, body);
  box('Continuous_red_tailbar', [0.016, 0.014, 1.60], [-2.325 + 0.008, 0.055, 0], taillight, body);
  box('Rear_diffuser_core', [0.23, 0.13, 1.69], [-2.19, -0.329, 0], black, body);
  for (let i = -3; i <= 3; i++) box(`Diffuser_fin_${i}`, [0.38, 0.11, 0.013], [-2.09, -0.407, i * 0.22], black, body);
  for (const s of [-1, 1]) {
    box(`Spoiler_support_${s}`, [0.055, 0.062, 0.045], [-2.02, 0.234, s * 0.59], black, body);
  }
  const spoiler = box('Active_rear_spoiler', [0.215, 0.028, 1.81], [-2.028, 0.272, 0], silverDark, body);
  spoiler.rotation.z = -0.045;
  for (const z of [-0.64, -0.32, 0.32, 0.64]) {
    const nozzle = mesh(new THREE.CylinderGeometry(0.059, 0.066, 0.045, 20, 1, true), chrome, `Rear_thruster_nozzle_${z}`, body);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.set(-2.297, -0.225, z);
    const dark = mesh(new THREE.CircleGeometry(0.054, 20), black, `Rear_thruster_recess_${z}`, body);
    dark.rotation.y = -Math.PI / 2;
    dark.position.set(-2.323, -0.225, z);
  }

  const wheels = new THREE.Group(); wheels.name = 'Wheels'; car.add(wheels);
  const profile = [[0.276, -0.126], [0.310, -0.126], [0.337, -0.111], [0.352, -0.083], [0.355, -0.05], [0.355, 0.05], [0.352, 0.083], [0.337, 0.111], [0.310, 0.126], [0.276, 0.126], [0.276, -0.126]].map(p => new THREE.Vector2(...p));
  const tireGeometry = new THREE.LatheGeometry(profile, 64);
  for (const [axle, x] of [['Front', 1.48], ['Rear', -1.48]]) {
    for (const s of [-1, 1]) {
      const label = `${axle}_${s === 1 ? 'Right' : 'Left'}`;
      const wheel = new THREE.Group(); wheel.name = `Wheel_${label}`;
      wheel.position.set(x, wheelY, s * 0.899); wheels.add(wheel);
      wheel.userData = { axle, side: s === 1 ? 'right' : 'left', radius: 0.355, rollingAxis: 'Z' };
      const tire = mesh(tireGeometry, rubber, `Tire_${label}`, wheel); tire.rotation.x = Math.PI / 2;
      const disk = mesh(new THREE.CylinderGeometry(0.279, 0.279, 0.018, 48), black, `Aero_rim_${label}`, wheel);
      disk.rotation.x = Math.PI / 2; disk.position.z = s * 0.109;
      const rotor = mesh(new THREE.CylinderGeometry(0.226, 0.226, 0.012, 48), brake, `Brake_rotor_${label}`, wheel);
      rotor.rotation.x = Math.PI / 2; rotor.position.z = s * 0.103;
      const outerRing = mesh(new THREE.TorusGeometry(0.276, 0.008, 8, 64), chrome, `Polished_rim_edge_${label}`, wheel);
      outerRing.position.z = s * 0.118;
      // Five broad, swept machined faces over a black aerodynamic wheel disc.
      for (let i = 0; i < 5; i++) {
        const shape = new THREE.Shape();
        shape.moveTo(0.052, -0.026); shape.lineTo(0.255, -0.064); shape.lineTo(0.272, -0.006);
        shape.lineTo(0.126, 0.042); shape.lineTo(0.052, 0.025); shape.closePath();
        const spoke = mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.009, bevelEnabled: false }), chrome, `Aero_spoke_${label}_${i + 1}`, wheel);
        spoke.rotation.z = i * Math.PI * 2 / 5 + 0.2;
        spoke.position.z = s === 1 ? 0.111 : -0.12;
      }
      const hub = mesh(new THREE.CylinderGeometry(0.061, 0.061, 0.013, 24), silverDark, `Centre_hub_${label}`, wheel);
      hub.rotation.x = Math.PI / 2; hub.position.z = s * 0.117;
      const caliper = box(`Brake_caliper_${label}`, [0.055, 0.14, 0.027], [-0.175, 0.04, s * 0.10], red, wheel);
      caliper.rotation.z = -0.25;
      // Tiny embossed tread rings remain ordinary exportable meshes.
      for (const offset of [-0.065, 0.065]) {
        const tread = mesh(new THREE.TorusGeometry(0.3535, 0.0015, 4, 64), rubber, `Tread_edge_${label}_${offset}`, wheel);
        tread.position.z = offset;
      }
    }
  }
  return car;
}
