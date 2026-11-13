import * as THREE from 'three';

// Back-to-back terraces: local +z faces the pitch, -z faces the circuit.
// Both banks rise to a shared central aisle beneath a gabled canopy.
export function buildStadiumStand(length, { concrete, crowd, roof, steel }) {
  const stand = new THREE.Group();
  stand.name = 'Camp Randall double-sided stand';
  const box = (name, w, h, d, material, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    stand.add(mesh);
    return mesh;
  };

  for (const side of [-1, 1]) {
    const face = side === 1 ? 'field' : 'track';
    for (let row = 0; row < 6; row++) {
      const height = 2.2 + row * 1.65;
      const z = side * (11 - row * 1.8);
      box(`${face} terrace ${row}`, length, height, 1.8, concrete, 0, height / 2, z);
      box(`${face} crowd ${row}`, length - 1, 0.28, 1.5, crowd, 0, height + 0.14, z);
    }
    // Low front rails leave both seating faces open and visible from outside.
    box(`${face} front rail`, length, 0.22, 0.16, steel, 0, 3.2, side * 12);
    for (const x of [-length / 2 + 1, 0, length / 2 - 1]) {
      box(`${face} canopy post`, 0.4, 16.3, 0.4, steel, x, 8.15, side * 12);
    }
    const pitch = Math.atan2(3.5, 13);
    const panel = box(`${face} pitched roof`, length + 2, 0.55,
      Math.hypot(13, 3.5), roof, 0, 18.25, side * 6.5);
    panel.rotation.x = side * pitch;
    box(`${face} red fascia`, length + 2, 0.7, 0.35, roof, 0, 16.4, side * 13);
  }
  box('shared raised aisle', length, 10.6, 2.2, concrete, 0, 5.3, 0);
  box('roof ridge', length + 2, 0.35, 0.7, roof, 0, 20, 0);
  return stand;
}
