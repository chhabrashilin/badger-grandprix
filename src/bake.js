// Static batching: collapses many small meshes into a handful of draw calls.
// Untextured materials are merged into shared vertex-coloured batches; textured
// materials are merged per material. Optionally split by world cell so the
// renderer can still frustum-cull whole regions.
import * as THREE from 'three';

const shared = new Map();
function sharedMaterial(kind, side) {
  const key = `${kind}|${side}`;
  if (!shared.has(key)) {
    shared.set(key, kind === 'glow'
      ? new THREE.MeshBasicMaterial({ vertexColors: true, side })
      : kind === 'metal'
        ? new THREE.MeshStandardMaterial({ vertexColors: true, side, roughness: 0.25, metalness: 0.9 })
        : new THREE.MeshLambertMaterial({ vertexColors: true, side }));
  }
  return shared.get(key);
}

/** Which batch a material belongs to, or null if it must keep its own material. */
function kindOf(m) {
  if (!(m.isMeshStandardMaterial || m.isMeshLambertMaterial) || m.isMeshPhysicalMaterial) return null;
  if (m.userData.own) return null; // e.g. kart paint, which is animated per kart
  if (m.map || m.emissiveMap || m.bumpMap || m.vertexColors || m.transparent || m.flatShading) return null;
  if (m.emissiveIntensity > 0 && m.emissive.getHex() !== 0) return 'glow';
  return m.metalness > 0.5 ? 'metal' : 'matte';
}

/**
 * Merge the static meshes under `root` in place.
 * Skips instanced meshes, sprites, anything under a node with `userData.dynamic`
 * or `userData.keep`, hidden nodes, and geometry without normals.
 * @param opts.cell   world cell size for spatial splitting (0 = one batch per material)
 * @param opts.single force every untextured part into the matte batch (fewest draws)
 * @param opts.cast   override castShadow for the merged batches
 * @param opts.one    a vertex-coloured material: merge every untextured part into ONE mesh using it
 */
export function bake(root, { cell = 0, single = false, cast = null, one = null } = {}) {
  root.updateWorldMatrix(true, true);
  const inv = root.matrixWorld.clone().invert();
  const buckets = new Map();
  const done = [];
  const M = new THREE.Matrix4();
  const centre = new THREE.Vector3();
  const col = new THREE.Color();

  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    for (let p = o; p && p !== root.parent; p = p.parent) {
      if (p.userData.dynamic || p.userData.keep || !p.visible) return;
    }
    const src = o.geometry;
    if (!src.attributes.normal) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m.isShaderMaterial || m.isMeshBasicMaterial)) return;

    const g = src.index ? src.toNonIndexed() : src.clone();
    g.applyMatrix4(M.multiplyMatrices(inv, o.matrixWorld));
    const pos = g.attributes.position.array;
    const nor = g.attributes.normal.array;
    const uv = g.attributes.uv?.array;
    const groups = Array.isArray(o.material) && g.groups.length
      ? g.groups
      : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
    let cellKey = '';
    if (cell) {
      g.computeBoundingBox();
      g.boundingBox.getCenter(centre);
      cellKey = `${Math.floor(centre.x / cell)},${Math.floor(centre.z / cell)}`;
    }
    for (const gr of groups) {
      const m = mats[gr.materialIndex] ?? mats[0];
      let kind = kindOf(m);
      if (kind && single && kind !== 'glow') kind = 'matte';
      const glowing = kind === 'glow';
      if (one && (kind || m.userData.own)) kind = 'one';
      const castFlag = cast ?? o.castShadow;
      const key = kind === 'one' ? 'one' : `${kind ? `${kind}|${m.side}` : m.uuid}|${castFlag ? 1 : 0}|${cellKey}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { kind, material: m, cast: castFlag, receive: o.receiveShadow, pos: [], nor: [], uv: [], col: [], n: 0 }));
      const a = gr.start;
      const z = gr.start + gr.count;
      b.pos.push(pos.subarray(a * 3, z * 3));
      b.nor.push(nor.subarray(a * 3, z * 3));
      if (kind) {
        // Glow batches carry HDR colour so they still bloom.
        if (kind === 'glow') col.copy(m.emissive).multiplyScalar(m.emissiveIntensity);
        else if (glowing) col.copy(m.emissive); // lights keep their colour inside a single-mesh batch
        else col.copy(m.color);
        const c = new Float32Array(gr.count * 3);
        for (let i = 0; i < gr.count; i++) c.set([col.r, col.g, col.b], i * 3);
        b.col.push(c);
      } else {
        b.uv.push(uv ? uv.subarray(a * 2, z * 2) : new Float32Array(gr.count * 2));
      }
      b.n += gr.count;
    }
    done.push(o);
  });

  for (const o of done) o.parent.remove(o);
  const join = (parts, size, n) => {
    const out = new Float32Array(n * size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return new THREE.BufferAttribute(out, size);
  };
  for (const b of buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', join(b.pos, 3, b.n));
    g.setAttribute('normal', join(b.nor, 3, b.n));
    if (b.kind) g.setAttribute('color', join(b.col, 3, b.n));
    else g.setAttribute('uv', join(b.uv, 2, b.n));
    const mesh = new THREE.Mesh(g, b.kind === 'one' ? one : b.kind ? sharedMaterial(b.kind, b.material.side) : b.material);
    mesh.castShadow = b.cast && b.kind !== 'glow';
    mesh.receiveShadow = true;
    mesh.userData.keep = true;
    root.add(mesh);
  }
  return root;
}
