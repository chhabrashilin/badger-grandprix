// The circuit: a closed spline sampled into evenly spaced points, plus the whole world around it.
import * as THREE from 'three';
import { RoundedBoxGeometry } from '../vendor/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from '../vendor/addons/utils/BufferGeometryUtils.js';
import { tex, rand, fbm, smooth } from './util.js';
import { bake } from './bake.js';
import { buildStadiumStand } from './stadium-stand.js';

export const ROAD_HALF = 9; // half road width
export const WALL = 14; // barrier distance from the centre line
const WATER_Y = -1.2;

// Control points (x, z). The lap starts at the first point, heading +z.
const CTRL = [
  [0, -60], [0, 50], [0, 130], [35, 200], [125, 232], [210, 195], [232, 105],
  [182, 40], [190, -40], [250, -110], [222, -200], [125, -232], [35, -200], [0, -140],
];

const matCache = new Map();
/** Cheap diffuse material by default; PBR only for metal or emissive surfaces. */
function mat(color, o = {}) {
  const make = () => {
    if (o.metalness > 0.3 || o.emissive !== undefined) return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...o });
    const { roughness, metalness, ...rest } = o;
    return new THREE.MeshLambertMaterial({ color, ...rest });
  };
  if (o.map) return make();
  const key = color + JSON.stringify(o);
  if (!matCache.has(key)) matCache.set(key, make());
  return matCache.get(key);
}

function put(geo, material, x, y, z, parent, cast = true) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = cast;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

export class Track {
  constructor(n = 640) {
    const curve = new THREE.CatmullRomCurve3(CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
    const pts = curve.getSpacedPoints(n);
    this.N = n;
    this.length = curve.getLength();
    this.segLen = this.length / n;
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.nx = new Float32Array(n);
    this.nz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.px[i] = pts[i].x;
      this.pz[i] = pts[i].z;
    }
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n;
      const b = (i + 1) % n;
      const dx = this.px[b] - this.px[a];
      const dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz);
      this.tx[i] = dx / l;
      this.tz[i] = dz / l;
      this.nx[i] = this.tz[i]; // lateral axis (positive = driver's left)
      this.nz[i] = -this.tx[i];
    }
    this.bounds = { minX: Math.min(...this.px), maxX: Math.max(...this.px), minZ: Math.min(...this.pz), maxZ: Math.max(...this.pz) };

    // Gameplay features, as [lap fraction, lateral offset].
    this.boxRows = [0.1, 0.33, 0.56, 0.8].map((f) => Math.floor(f * n));
    this.pads = [[0.2, -4], [0.2, 4], [0.45, 0, true], [0.66, 5], [0.9, -5]].map(([f, lat, jump]) => ({
      idx: Math.floor(f * n), lat, jump: !!jump, ...this.pointAt(Math.floor(f * n), lat),
    }));
    this.animated = [];
    // Areas scenery must stay out of: [centre x, centre z, half-width, half-depth]
    this.keepOut = [[100, 118, 62, 62], [104, -105, 82, 60], [36, -60, 18, 58], [-27, -18, 16, 16]];
    this.stands = this.planStands();
  }

  /** Grandstand sites: the main one on the start straight plus a few on the outside of the circuit. */
  planStands() {
    const stands = [{ x: 27, z: -60, rot: 0, len: 100, rows: 7 }];
    for (const f of [0.3, 0.6, 0.86]) {
      const i = Math.floor(f * this.N);
      for (const s of [1, -1]) {
        const front = this.pointAt(i, s * (WALL + 8));
        const back = this.pointAt(i, s * (WALL + 24));
        if (back.x < -30 || this.distToCentre(back.x, back.z) < WALL + 20) continue;
        if (this.keepOut.some(([cx, cz, hw, hd]) => Math.abs(back.x - cx) < hw + 24 && Math.abs(back.z - cz) < hd + 24)) continue;
        stands.push({ x: front.x, z: front.z, rot: Math.atan2(-s * this.nz[i], s * this.nx[i]), len: 44, rows: 5 });
        break;
      }
    }
    return stands;
  }

  blocked(x, z, pad = 0) {
    return this.keepOut.some(([cx, cz, hw, hd]) => Math.abs(x - cx) < hw + pad && Math.abs(z - cz) < hd + pad)
      || this.stands.some((s) => Math.hypot(x - s.x, z - s.z) < s.len / 2 + 10 + pad);
  }

  /** Nearest sample index to (x, z). Searches around `hint`, or everywhere if hint < 0. */
  locate(x, z, hint = -1) {
    const n = this.N;
    let best = 0;
    let bd = Infinity;
    const from = hint < 0 ? 0 : hint - 10;
    const to = hint < 0 ? n - 1 : hint + 24;
    for (let k = from; k <= to; k++) {
      const i = ((k % n) + n) % n;
      const dx = x - this.px[i];
      const dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  /** World position at fractional sample `s`, shifted sideways by `lat`. */
  pointAt(s, lat = 0) {
    const n = this.N;
    const i = ((Math.floor(s) % n) + n) % n;
    const j = (i + 1) % n;
    const f = s - Math.floor(s);
    return {
      x: this.px[i] + (this.px[j] - this.px[i]) * f + this.nx[i] * lat,
      z: this.pz[i] + (this.pz[j] - this.pz[i]) * f + this.nz[i] * lat,
    };
  }

  headingAt(i) {
    return Math.atan2(this.tx[i], this.tz[i]);
  }

  distToCentre(x, z) {
    let bd = Infinity;
    for (let i = 0; i < this.N; i += 3) {
      const d = Math.hypot(x - this.px[i], z - this.pz[i]);
      if (d < bd) bd = d;
    }
    return bd;
  }

  /** Terrain height: flat around the circuit, rolling hills beyond, dipping into the lake to the west. */
  groundY(x, z, d = this.distToCentre(x, z)) {
    const hill = smooth((d - 120) / 170) * (fbm(x * 0.006 + 5, z * 0.006 + 9) * 58 - 9);
    const shore = smooth((-36 - x) / 44);
    // Sink a trench under the asphalt so grass never z-fights through the road.
    const trench = smooth((WALL + 4 - d) / 5) * 0.55;
    return hill * (1 - shore) - shore * 7 - 0.07 - trench;
  }

  /** Ribbon following the track between two lateral offsets. */
  ribbon(a, ya, b, yb, vTile, { up = false } = {}) {
    const n = this.N;
    const pos = [];
    const uv = [];
    const nor = [];
    const idx = [];
    for (let k = 0; k <= n; k++) {
      const i = k % n;
      pos.push(this.px[i] + this.nx[i] * a, ya, this.pz[i] + this.nz[i] * a);
      pos.push(this.px[i] + this.nx[i] * b, yb, this.pz[i] + this.nz[i] * b);
      const v = (k * this.segLen) / vTile;
      uv.push(0, v, 1, v);
      if (up) nor.push(0, 1, 0, 0, 1, 0);
      if (k < n) {
        if (up) idx.push(2 * k, 2 * k + 2, 2 * k + 1, 2 * k + 1, 2 * k + 2, 2 * k + 3);
        else idx.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    if (up) g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    else g.computeVertexNormals();
    return g;
  }

  /** Per-frame scenery animation (scrolling boost pads, water ripples, balloons). */
  animate(t) {
    for (const fn of this.animated) fn(t);
  }

  /** Build road, barriers and scenery into a group. */
  build() {
    const g = new THREE.Group();
    const strip = (geo, material) => {
      const m = new THREE.Mesh(geo, material);
      m.receiveShadow = true;
      m.userData.keep = true; // already one draw call each
      g.add(m);
      return m;
    };
    const two = ({ roughness, metalness, ...o }) => new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, ...o });

    this.buildTerrain(g);

    // ---- Road surface: dense asphalt that reads as pavement, not grass
    const asphalt = tex(1024, 2048, (c, w, h) => {
      c.fillStyle = '#2c2e34';
      c.fillRect(0, 0, w, h);
      const img = c.getImageData(0, 0, w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const n = fbm(x * 0.35, y * 0.35, 3);
          const n2 = fbm(x * 1.1 + 20, y * 1.1, 2);
          const chip = (n2 > 0.62 ? 28 : 0) + (n2 < 0.22 ? -18 : 0);
          const v = 38 + n * 42 + chip + (Math.sin(x * 0.04 + y * 0.01) * 3);
          d[i] = v;
          d[i + 1] = v + 1;
          d[i + 2] = v + 4;
        }
      }
      c.putImageData(img, 0, 0);
      const worn = c.createLinearGradient(0, 0, w, 0);
      worn.addColorStop(0.08, 'rgba(0,0,0,0)');
      worn.addColorStop(0.35, 'rgba(8,8,10,.18)');
      worn.addColorStop(0.5, 'rgba(0,0,0,.38)');
      worn.addColorStop(0.65, 'rgba(8,8,10,.18)');
      worn.addColorStop(0.92, 'rgba(0,0,0,0)');
      c.fillStyle = worn;
      c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(6,6,8,.4)';
      for (let i = 0; i < 18; i++) {
        c.lineWidth = rand(1.5, 5);
        const x = rand(w * 0.15, w * 0.85);
        const y = rand(h);
        c.beginPath();
        c.moveTo(x, y);
        c.bezierCurveTo(x + rand(-18, 18), y + 160, x + rand(-30, 30), y + 320, x + rand(-40, 40), y + 520);
        c.stroke();
      }
      c.strokeStyle = 'rgba(12,12,14,.55)';
      c.lineWidth = 1.2;
      for (let i = 0; i < 10; i++) {
        const x = rand(w * 0.1, w * 0.9);
        let y = rand(h);
        c.beginPath();
        c.moveTo(x, y);
        for (let s = 0; s < 6; s++) {
          y += rand(40, 90);
          c.lineTo(x + rand(-22, 22), y);
        }
        c.stroke();
      }
      c.fillStyle = '#f4f4f0';
      c.fillRect(w * 0.028, 0, w * 0.016, h);
      c.fillRect(w * 0.956, 0, w * 0.016, h);
      c.fillStyle = '#ffd040';
      const dash = h * 0.05;
      const gap = h * 0.035;
      for (let y = 0; y < h; y += dash + gap) c.fillRect(w / 2 - w * 0.007, y, w * 0.014, dash);
    });
    asphalt.anisotropy = 8;
    const asphaltBump = tex(512, 1024, (c, w, h) => {
      const img = c.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const v = 110 + fbm(x * 0.55, y * 0.55, 3) * 90;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    });
    asphaltBump.anisotropy = 4;
    asphaltBump.colorSpace = THREE.NoColorSpace;
    const asphaltRough = tex(512, 1024, (c, w, h) => {
      const img = c.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const edge = Math.abs(x / w - 0.5) * 2;
          const v = 150 + fbm(x * 0.2, y * 0.2, 2) * 60 - (1 - edge) * 35;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    });
    asphaltRough.colorSpace = THREE.NoColorSpace;
    const roadMat = new THREE.MeshStandardMaterial({
      map: asphalt,
      bumpMap: asphaltBump,
      bumpScale: 0.55,
      roughnessMap: asphaltRough,
      roughness: 0.85,
      metalness: 0.04,
      envMapIntensity: 0.4,
      side: THREE.DoubleSide,
    });
    strip(this.ribbon(-ROAD_HALF, 0.08, ROAD_HALF, 0.08, 18, { up: true }), roadMat);

    // Runoff shoulder between asphalt and barriers
    const shoulder = tex(256, 512, (c, w, h) => {
      c.fillStyle = '#3a3c40';
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 12000; i++) {
        const v = 40 + Math.floor(rand(50));
        c.fillStyle = `rgb(${v},${v - 2},${v - 4})`;
        c.fillRect(rand(w), rand(h), rand(1, 3), rand(1, 3));
      }
    });
    const shoulderMat = new THREE.MeshStandardMaterial({
      map: shoulder, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide,
    });
    strip(mergeGeometries([-1, 1].map((s) => this.ribbon(
      s * ROAD_HALF, 0.05, s * (WALL - 0.2), 0.05, 14, { up: true },
    ))), shoulderMat);

    // ---- Kerbs
    const kerb = tex(128, 256, (c, w, h) => {
      c.fillStyle = '#c5050c';
      c.fillRect(0, 0, w, h / 2);
      c.fillStyle = '#f2f2ef';
      c.fillRect(0, h / 2, w, h / 2);
      c.fillStyle = 'rgba(0,0,0,.14)';
      for (let i = 0; i < 80; i++) c.fillRect(rand(w), rand(h), rand(2, 8), 1);
      c.fillStyle = 'rgba(0,0,0,.18)';
      c.fillRect(0, h / 2 - 3, w, 5);
      c.fillRect(0, h - 3, w, 3);
      c.fillStyle = 'rgba(255,255,255,.12)';
      c.fillRect(0, 2, w, 4);
    });
    const kerbMat = new THREE.MeshStandardMaterial({
      map: kerb, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide, envMapIntensity: 0.25,
    });
    strip(mergeGeometries([-1, 1].map((s) => this.ribbon(
      s * ROAD_HALF, 0.09, s * (ROAD_HALF + 1.5), 0.22, 4, { up: true },
    ))), kerbMat);

    // ---- Barriers: a solid profile (inner face, cap, outer face)
    const wallTex = tex(256, 512, (c, w, h) => {
      c.fillStyle = '#e8eaee';
      c.fillRect(0, 0, w, h);
      // Concrete speckles
      for (let i = 0; i < 6000; i++) {
        const v = 200 + Math.floor(rand(40));
        c.fillStyle = `rgba(${v},${v},${v + 2},0.55)`;
        c.fillRect(rand(w), rand(h), rand(1, 2), rand(1, 2));
      }
      c.fillStyle = '#c5050c';
      c.fillRect(w * 0.2, 0, w * 0.6, h / 2);
      c.fillStyle = 'rgba(255,255,255,.12)';
      c.fillRect(w * 0.2, 4, w * 0.6, 8);
      c.fillStyle = '#1e2228';
      c.fillRect(0, 0, w * 0.12, h);
      c.fillStyle = 'rgba(0,0,0,.2)';
      c.fillRect(0, 0, w, 4);
      c.fillRect(0, h / 2, w, 4);
      c.fillRect(0, h - 4, w, 4);
    });
    const wallMat = new THREE.MeshStandardMaterial({
      map: wallTex, roughness: 0.62, metalness: 0.08, side: THREE.DoubleSide, envMapIntensity: 0.2,
    });
    const capMat = new THREE.MeshStandardMaterial({
      color: 0x2a2d35, roughness: 0.45, metalness: 0.35, side: THREE.DoubleSide, envMapIntensity: 0.35,
    });
    const W0 = WALL + 0.9;
    strip(mergeGeometries([-1, 1].flatMap((s) => [this.ribbon(s * W0, 0, s * W0, 1.25, 8), this.ribbon(s * (W0 + 0.7), 0, s * (W0 + 0.7), 1.25, 8)])), wallMat).castShadow = true;
    strip(mergeGeometries([-1, 1].map((s) => this.ribbon(s * W0, 1.25, s * (W0 + 0.7), 1.25, 8))), capMat);

    // ---- Start / finish line and gantry
    const checker = tex(256, 32, (c) => {
      for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) {
        c.fillStyle = (x + y) % 2 ? '#15161a' : '#f5f5f2';
        c.fillRect(x * 8, y * 8, 8, 8);
      }
    });
    const line = put(new THREE.PlaneGeometry(ROAD_HALF * 2, 3), mat(0xffffff, { map: checker, roughness: 0.6 }), this.px[0], 0.1, this.pz[0], g, false);
    line.rotation.x = -Math.PI / 2;
    const steel = mat(0x2a2d35, { roughness: 0.4, metalness: 0.7 });
    const red = mat(0xc5050c, { roughness: 0.4, metalness: 0.2 });
    const banner = tex(1024, 128, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#e01018');
      gr.addColorStop(1, '#9c040a');
      c.fillStyle = gr;
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#fff';
      c.font = '700 78px "Dela Gothic One", Impact, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('BADGER GRAND PRIX', w / 2, h / 2 + 4);
    });
    const bannerMat = mat(0xffffff, { map: banner, roughness: 0.5 });
    for (const s of [-1, 1]) {
      put(new RoundedBoxGeometry(1.4, 11.5, 1.4, 1, 0.25), steel, this.px[0] + s * (WALL + 3), 5.75, this.pz[0], g);
    }
    put(new THREE.BoxGeometry(WALL * 2 + 7.4, 3, 1), [red, red, red, red, bannerMat, bannerMat], this.px[0], 10.6, this.pz[0], g);
    put(new THREE.BoxGeometry(WALL * 2 + 7.4, 0.35, 1.6), steel, this.px[0], 12.3, this.pz[0], g);
    const bulb = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a1a, emissiveIntensity: 4 });
    for (let i = -2; i <= 2; i++) put(new THREE.SphereGeometry(0.42, 12, 8), bulb, this.px[0] + i * 1.6, 8.6, this.pz[0] - 0.7, g, false);

    // ---- Boost pads (scrolling, glowing chevrons)
    const chev = tex(128, 128, (c, w, h) => {
      c.fillStyle = '#1b1206';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#fff';
      c.lineWidth = 16;
      c.lineJoin = 'miter';
      for (const y of [h * 0.85, h * 0.35]) {
        c.beginPath();
        c.moveTo(10, y + 20);
        c.lineTo(w / 2, y - 22);
        c.lineTo(w - 10, y + 20);
        c.stroke();
      }
    });
    const padMat = new THREE.MeshStandardMaterial({ color: 0x1a1206, emissive: 0xffa21a, emissiveMap: chev, emissiveIntensity: 3.2, roughness: 0.4 });
    this.animated.push((t) => (chev.offset.y = (t * 1.6) % 1));
    const rampMat = mat(0xf2b01e, { roughness: 0.45, metalness: 0.2 });
    const boostSign = tex(512, 128, (c, w, h) => {
      c.fillStyle = '#ffe366';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#111827';
      c.font = '700 46px "Dela Gothic One", Impact, sans-serif';
      c.textAlign = 'center';
      c.fillText('SPEED BOOST >>', w / 2, 62);
      c.font = '800 22px "Zen Kaku Gothic New", sans-serif';
      c.fillText('DRIVE OVER GOLD ARROWS', w / 2, 103);
    });
    const signMat = new THREE.SpriteMaterial({ map: boostSign, depthTest: true });
    for (const p of this.pads) {
      const sign = new THREE.Sprite(signMat);
      sign.position.set(p.x, 5.5, p.z);
      sign.scale.set(12, 3, 1);
      g.add(sign);
      const m = put(new THREE.PlaneGeometry(5, 6.5), padMat, p.x, 0.12, p.z, g, false);
      m.rotation.set(-Math.PI / 2, 0, Math.PI - this.headingAt(p.idx));
      if (p.jump) {
        const ramp = put(new RoundedBoxGeometry(6.4, 0.6, 5.4, 1, 0.15), rampMat, p.x, 0.5, p.z, g);
        ramp.rotation.set(-0.22, this.headingAt(p.idx), 0, 'YXZ');
      }
    }

    this.buildTrackside(g);
    this.buildScenery(g);
    // Collapse the hundreds of small static props into a few batches per 220 m cell.
    bake(g, { cell: 320, cast: true });
    // Nothing here moves except the flagged boats/balloons: skip per-frame matrix updates.
    g.traverse((o) => {
      let dynamic = false;
      for (let q = o; q && q !== g; q = q.parent) dynamic ||= !!q.userData.dynamic;
      if (!dynamic) {
        o.updateMatrix();
        o.matrixAutoUpdate = false;
      }
    });
    g.updateMatrixWorld(true);
    return g;
  }

  buildTerrain(g) {
    const geo = new THREE.PlaneGeometry(3800, 3800, 120, 120).rotateX(-Math.PI / 2).translate(110, 0, 0);
    const p = geo.attributes.position;
    const cols = new Float32Array(p.count * 3);
    const grassA = new THREE.Color(0x58b33c);
    const grassB = new THREE.Color(0x3f9a35);
    const dry = new THREE.Color(0x9bbf4a);
    const sand = new THREE.Color(0xe6d59a);
    const rock = new THREE.Color(0x6f8a5a);
    const c = new THREE.Color();
    const dirt = new THREE.Color(0x6a5a3a);
    const asphaltEdge = new THREE.Color(0x3a3c42);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const d = this.distToCentre(x, z);
      const y = this.groundY(x, z, d);
      p.setY(i, y);
      c.copy(grassA).lerp(grassB, smooth(fbm(x * 0.02, z * 0.02) * 1.6 - 0.3));
      c.lerp(dry, smooth(fbm(x * 0.05 + 40, z * 0.05) * 2 - 1.1) * 0.7);
      c.lerp(dirt, smooth(fbm(x * 0.03 + 9, z * 0.03) * 2 - 0.9) * 0.35);
      c.lerp(rock, smooth((y - 22) / 26));
      c.lerp(sand, smooth((0.4 - y) / 1.4) * smooth((-30 - x) / 12));
      // Near-track verge reads as dark runoff, not bright lawn under the barriers.
      c.lerp(asphaltEdge, smooth((WALL + 10 - d) / 8) * 0.85);
      cols.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    const detail = tex(512, 512, (x, w, h) => {
      const img = x.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        for (let px = 0; px < w; px++) {
          const i = (y * w + px) * 4;
          const n = fbm(px * 0.08, y * 0.08, 4);
          const blade = fbm(px * 0.4, y * 0.15, 2);
          const v = 170 + n * 55 + blade * 25;
          d[i] = v * 0.92;
          d[i + 1] = v;
          d[i + 2] = v * 0.78;
          d[i + 3] = 255;
        }
      }
      x.putImageData(img, 0, 0);
    }, 180, 180);
    detail.anisotropy = 4;
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, map: detail, roughness: 0.95, metalness: 0, envMapIntensity: 0.15,
    }));
    ground.receiveShadow = true;
    ground.userData.keep = true;
    g.add(ground);

    // Lake: reflective water with drifting ripples
    const ripple = tex(256, 256, (x, w, h) => {
      x.fillStyle = '#808080';
      x.fillRect(0, 0, w, h);
      for (let i = 0; i < 260; i++) {
        const px = rand(w);
        const py = rand(h);
        const r = rand(6, 22);
        const gr = x.createRadialGradient(px, py, 0, px, py, r);
        gr.addColorStop(0, i % 2 ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.5)');
        gr.addColorStop(1, 'rgba(128,128,128,0)');
        x.fillStyle = gr;
        x.fillRect(px - r, py - r, r * 2, r * 2);
      }
    }, 240, 240);
    ripple.colorSpace = THREE.NoColorSpace;
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshStandardMaterial({
        color: 0x1a6fbf, roughness: 0.08, metalness: 0.55,
        bumpMap: ripple, bumpScale: 1.2, envMapIntensity: 1.1,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(-800, WATER_Y, 0);
    water.userData.keep = true;
    g.add(water);
    this.animated.push((t) => ripple.offset.set(t * 0.012, t * 0.007));

    // Snow-capped mountain ridges for depth
    const lo = new THREE.Color();
    const hi = new THREE.Color();
    const snow = new THREE.Color(0xf4f8ff);
    for (const [radius, base, amp, colLo, colHi, seed] of [[1800, 110, 380, 0x6f8fb8, 0x8ea9c9, 3], [1480, 40, 210, 0x4f7a94, 0x6f97a8, 11]]) {
      const seg = 160;
      const pos = [];
      const col = [];
      const idx = [];
      lo.setHex(colLo);
      hi.setHex(colHi);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const x = 110 + Math.cos(a) * radius;
        const z = Math.sin(a) * radius;
        const land = smooth((Math.cos(a) + 0.75) / 0.5); // fade out over the lake side
        const h = (base + fbm(Math.cos(a) * 3 + seed, Math.sin(a) * 3 + seed, 5) * amp) * land;
        const cap = h > base + amp * 0.42 ? snow : hi;
        pos.push(x, -20, z, x, h * 0.62, z, x, h, z);
        col.push(lo.r, lo.g, lo.b, hi.r, hi.g, hi.b, cap.r, cap.g, cap.b);
        if (i < seg) {
          const o = 3 * i;
          idx.push(o, o + 1, o + 3, o + 1, o + 4, o + 3, o + 1, o + 2, o + 4, o + 2, o + 5, o + 4);
        }
      }
      const ridge = new THREE.BufferGeometry();
      ridge.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      ridge.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      ridge.setIndex(idx);
      g.add(new THREE.Mesh(ridge, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    }
  }

  /** Lamp posts, sponsor boards, gantries and tyre stacks hugging the circuit. */
  buildTrackside(g) {
    const steel = mat(0x30343d, { roughness: 0.4, metalness: 0.7 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0x332a10, emissive: 0xfff0c0, emissiveIntensity: 3.5 });
    const poleGeo = new THREE.CylinderGeometry(0.16, 0.22, 10, 8);
    const armGeo = new THREE.BoxGeometry(3.2, 0.18, 0.22);
    const headGeo = new RoundedBoxGeometry(1.1, 0.22, 0.5, 1, 0.08);
    for (let i = 0, k = 0; i < this.N; i += 26, k++) {
      const s = k % 2 ? 1 : -1;
      const post = new THREE.Group();
      put(poleGeo, steel, 0, 5, 0, post);
      put(armGeo, steel, -s * 1.5, 9.9, 0, post, false);
      put(headGeo, lamp, -s * 3, 9.75, 0, post, false);
      const p = this.pointAt(i, s * (WALL + 3));
      post.position.set(p.x, 0, p.z);
      post.rotation.y = this.headingAt(i);
      g.add(post);
    }

    // Sponsor boards facing the road
    const boards = [
      ['ON, WISCONSIN!', '#c5050c', '#fff'], ['MADTOWN 500', '#14161c', '#ffd23f'], ['CURD POWER', '#ffd23f', '#14161c'],
      ['JUMP AROUND', '#fff', '#c5050c'], ['BADGER GP', '#0b5fb8', '#fff'], ['LAKESIDE TYRES', '#1f8a4c', '#fff'],
    ].map(([text, bg, fg]) => mat(0xffffff, { roughness: 0.5, map: tex(512, 128, (c, w, h) => {
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      c.fillStyle = fg;
      c.fillRect(0, 0, w, 8);
      c.fillRect(0, h - 8, w, 8);
      c.font = '700 58px "Dela Gothic One", Impact, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, w / 2, h / 2 + 3);
    }) }));
    const frame = mat(0x23262d, { roughness: 0.5, metalness: 0.5 });
    for (let i = 13, k = 0; i < this.N; i += 39, k++) {
      const s = k % 2 ? -1 : 1;
      const face = boards[k % boards.length];
      const b = new THREE.Group();
      put(new THREE.BoxGeometry(13, 3.2, 0.3), [frame, frame, frame, frame, face, frame], 0, 3.4, 0, b);
      for (const x of [-5, 5]) put(new THREE.BoxGeometry(0.3, 2, 0.3), frame, x, 1, 0, b);
      const p = this.pointAt(i, s * (WALL + 5.5));
      if (this.blocked(p.x, p.z, 4)) continue; // no boards in front of a grandstand
      b.position.set(p.x, 0, p.z);
      b.rotation.y = Math.atan2(-this.nx[i] * s, -this.nz[i] * s); // face the centre line
      g.add(b);
    }

    // Gantries over the item-box rows
    const redM = mat(0xc5050c, { roughness: 0.4, metalness: 0.3 });
    const strip = new THREE.MeshStandardMaterial({ color: 0x102030, emissive: 0x6fd8ff, emissiveIntensity: 3 });
    for (const idx of this.boxRows) {
      const gt = new THREE.Group();
      for (const s of [-1, 1]) put(new RoundedBoxGeometry(1, 11, 1, 1, 0.2), steel, s * (WALL + 3), 5.5, 0, gt);
      put(new RoundedBoxGeometry(WALL * 2 + 7, 1.7, 1.2, 1, 0.25), redM, 0, 11, 0, gt);
      put(new THREE.BoxGeometry(WALL * 2 + 4, 0.18, 1.3), strip, 0, 10.05, 0, gt, false);
      gt.position.set(this.px[idx], 0, this.pz[idx]);
      gt.rotation.y = this.headingAt(idx);
      g.add(gt);
    }

    // Tyre stacks on the outside of the tighter corners (instanced)
    const spots = [];
    for (let i = 0; i < this.N; i += 4) {
      const a = this.headingAt(i);
      const b = this.headingAt((i + 8) % this.N);
      const turn = Math.atan2(Math.sin(b - a), Math.cos(b - a));
      if (Math.abs(turn) > 0.2) spots.push([i, turn > 0 ? 1 : -1]);
    }
    const tyres = new THREE.InstancedMesh(new THREE.TorusGeometry(0.55, 0.26, 6, 10).rotateX(Math.PI / 2), mat(0xffffff, { roughness: 0.9 }), spots.length * 3);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    spots.forEach(([i, s], k) => {
      const p = this.pointAt(i, s * (WALL + 0.1));
      for (let l = 0; l < 3; l++) {
        m4.makeTranslation(p.x, 0.26 + l * 0.5, p.z);
        tyres.setMatrixAt(k * 3 + l, m4);
        tyres.setColorAt(k * 3 + l, col.setHex((k + l) % 2 ? 0xd2101a : 0xf2f2f2));
      }
    });
    tyres.castShadow = tyres.receiveShadow = true;
    g.add(tyres);
  }

  buildScenery(g) {
    const blocked = (x, z, pad = 0) => this.blocked(x, z, pad);

    // ---- Capitol-style dome in the infield
    const stone = mat(0xf4efe4, { roughness: 0.6 });
    const cap = new THREE.Group();
    put(new THREE.BoxGeometry(92, 2, 92), mat(0xd9d3c4), 0, 0.8, 0, cap);
    put(new RoundedBoxGeometry(84, 13, 24, 1, 0.6), stone, 0, 8, 0, cap);
    put(new RoundedBoxGeometry(24, 13, 84, 1, 0.6), stone, 0, 8, 0, cap);
    for (const [x, z] of [[46, 0], [-46, 0], [0, 46], [0, -46]]) {
      for (let i = -2; i <= 2; i++) put(new THREE.CylinderGeometry(0.9, 0.9, 11, 12), stone, x ? x : i * 4, 7.5, z ? z : i * 4, cap);
    }
    put(new THREE.CylinderGeometry(17, 19, 5, 40), stone, 0, 17, 0, cap);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      put(new THREE.CylinderGeometry(0.8, 0.8, 13, 10), stone, Math.cos(a) * 15.5, 25.5, Math.sin(a) * 15.5, cap);
    }
    put(new THREE.CylinderGeometry(13, 13, 13, 32), mat(0xe2dbcc, { roughness: 0.6 }), 0, 25.5, 0, cap);
    put(new THREE.CylinderGeometry(17, 17, 1.6, 40), stone, 0, 32.5, 0, cap);
    put(new THREE.SphereGeometry(15, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xf7f3ea, { roughness: 0.45 }), 0, 33, 0, cap).scale.y = 1.25;
    put(new THREE.CylinderGeometry(2.6, 3.2, 8, 16), stone, 0, 54, 0, cap);
    put(new THREE.ConeGeometry(1.3, 6, 12), mat(0xf0c040, { roughness: 0.25, metalness: 1, emissive: 0x6b4a00, emissiveIntensity: 0.6 }), 0, 61, 0, cap);
    cap.position.set(100, 0, 118);
    g.add(cap);

    // ---- Stadium in the lower infield
    const crowd = tex(256, 128, (x, w, h) => {
      x.fillStyle = '#6d0f15';
      x.fillRect(0, 0, w, h);
      for (let i = 0; i < 3200; i++) {
        x.fillStyle = ['#d2101a', '#ffffff', '#e8343b', '#f5d6d6', '#2a2a2a', '#ffd23f'][Math.floor(rand(6))];
        x.fillRect(Math.floor(rand(w / 3)) * 3, Math.floor(rand(h / 4)) * 4, 2, 3);
      }
    }, 5, 2);
    const crowdMat = mat(0xffffff, { map: crowd, roughness: 0.9 });
    const concrete = mat(0xc3c7ce, { roughness: 0.7 });
    const stad = new THREE.Group();
    const standMaterials = {
      concrete, crowd: crowdMat,
      roof: mat(0xc5050c, { roughness: 0.5 }),
      steel: mat(0x414650, { roughness: 0.5, metalness: 0.6 }),
    };
    for (const [x, z, rot, len] of [[0, -40, 0, 120], [0, 40, Math.PI, 120], [-66, 0, Math.PI / 2, 62], [66, 0, -Math.PI / 2, 62]]) {
      const s = buildStadiumStand(len, standMaterials);
      s.position.set(x, 0, z);
      s.rotation.y = rot;
      stad.add(s);
    }
    const turf = put(new THREE.PlaneGeometry(104, 50), mat(0xffffff, { roughness: 0.9, map: tex(512, 256, (x, w, h) => {
      for (let i = 0; i < 10; i++) {
        x.fillStyle = i % 2 ? '#2f9a3f' : '#3bab4b';
        x.fillRect((i * w) / 10, 0, w / 10, h);
      }
      x.fillStyle = '#c5050c';
      x.fillRect(0, 0, w / 10, h);
      x.fillRect(w * 0.9, 0, w / 10, h);
      x.strokeStyle = 'rgba(255,255,255,.85)';
      x.lineWidth = 3;
      for (let i = 1; i < 10; i++) {
        x.beginPath();
        x.moveTo((i * w) / 10, 0);
        x.lineTo((i * w) / 10, h);
        x.stroke();
      }
      x.fillStyle = '#fff';
      x.font = '900 120px Arial';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText('W', w / 2, h / 2 + 6);
    }) }), 0, 0.08, 0, stad, false);
    turf.rotation.x = -Math.PI / 2;
    stad.position.set(104, 0, -105);
    g.add(stad);

    // ---- Buildings: denser facade tile with lintels, mullions, and brick/stone grain
    const facade = (wall, frame, glass) => mat(0xffffff, { roughness: 0.58, map: tex(512, 512, (x, w, h) => {
      x.fillStyle = wall;
      x.fillRect(0, 0, w, h);
      // Surface grain
      for (let i = 0; i < 9000; i++) {
        const a = 12 + Math.floor(rand(18));
        x.fillStyle = `rgba(0,0,0,${0.03 + rand(0.05)})`;
        x.fillRect(rand(w), rand(h), rand(1, 3), rand(1, 2));
        x.fillStyle = `rgba(255,255,255,${0.02 + rand(0.04)})`;
        x.fillRect(rand(w), rand(h), 1, 1);
      }
      for (let cx = 0; cx < 4; cx++) for (let cy = 0; cy < 4; cy++) {
        const bx = cx * 128 + 16;
        const by = cy * 128 + 18;
        x.fillStyle = frame;
        x.fillRect(bx, by, 96, 92);
        // Mullions
        x.fillStyle = 'rgba(0,0,0,.25)';
        x.fillRect(bx + 46, by + 6, 4, 80);
        x.fillRect(bx + 6, by + 44, 84, 3);
        const gr = x.createLinearGradient(0, by + 8, 0, by + 84);
        gr.addColorStop(0, glass);
        gr.addColorStop(0.55, '#3a5a78');
        gr.addColorStop(1, '#1a3048');
        x.fillStyle = Math.random() < 0.2 ? '#ffe7ad' : gr;
        x.fillRect(bx + 8, by + 8, 36, 34);
        x.fillRect(bx + 52, by + 8, 36, 34);
        x.fillRect(bx + 8, by + 50, 36, 34);
        x.fillRect(bx + 52, by + 50, 36, 34);
        // Window highlight
        x.fillStyle = 'rgba(255,255,255,.18)';
        x.fillRect(bx + 10, by + 10, 12, 28);
        x.fillRect(bx + 54, by + 10, 12, 28);
      }
      x.fillStyle = 'rgba(0,0,0,.16)';
      for (let cy = 1; cy < 4; cy++) x.fillRect(0, cy * 128 - 4, w, 6);
      // Cornice strip
      x.fillStyle = 'rgba(255,255,255,.1)';
      x.fillRect(0, 0, w, 6);
    }) });
    const facades = [
      facade('#b4523f', '#efe3d0', '#9fd0f0'), facade('#e4d8be', '#8f8470', '#a9d6f2'),
      facade('#8fa0b3', '#e6edf3', '#bfe6ff'), facade('#c9773a', '#f3e6d2', '#9fd0f0'), facade('#f2f0ea', '#5c6672', '#8cc4ea'),
    ];
    const roof = mat(0x474b54, { roughness: 0.8 });
    const unit = mat(0xaeb4bd, { roughness: 0.5, metalness: 0.4 });
    let placed = 0;
    for (let tries = 0; placed < 44 && tries < 2500; tries++) {
      const x = rand(-18, 430);
      const z = rand(-430, 430);
      const d = this.distToCentre(x, z);
      if (d < 46 || blocked(x, z, 24)) continue;
      const gy = this.groundY(x, z, d);
      if (gy > 14) continue;
      const w = rand(18, 36);
      const dp = rand(18, 36);
      const h = d > 110 ? rand(26, 78) : rand(11, 30);
      const geo = new THREE.BoxGeometry(w, h, dp);
      const uv = geo.attributes.uv;
      for (let i = 0; i < 24; i++) {
        if (i >= 8 && i < 16) continue;
        uv.setXY(i, uv.getX(i) * Math.round((i < 8 ? dp : w) / 10), uv.getY(i) * Math.max(1, Math.round(h / 10)));
      }
      const f = facades[Math.floor(rand(facades.length))];
      const b = new THREE.Group();
      put(geo, [f, f, roof, roof, f, f], 0, h / 2, 0, b);
      put(new THREE.BoxGeometry(w + 0.8, 1, dp + 0.8), roof, 0, h + 0.3, 0, b);
      put(new THREE.BoxGeometry(w * 0.3, 2.4, dp * 0.3), unit, w * 0.15, h + 2, -dp * 0.12, b);
      b.position.set(x, gy - 2, z);
      b.rotation.y = Math.floor(rand(4)) * (Math.PI / 2) + rand(-0.12, 0.12);
      g.add(b);
      placed++;
    }

    // ---- Lakefront: pier, terrace chairs, sailboats
    const wood = mat(0x94683a, { roughness: 0.8 });
    put(new THREE.BoxGeometry(84, 0.6, 7), wood, -86, 0.5, 30, g);
    for (let x = -124; x <= -50; x += 12) for (const z of [27, 33]) put(new THREE.CylinderGeometry(0.35, 0.35, 5, 8), wood, x, -1.6, z, g);
    put(new RoundedBoxGeometry(34, 0.7, 50, 1, 0.2), mat(0xd9ceb8, { roughness: 0.7 }), -33, 0.2, 30, g);
    const chairCols = [0xf6c21c, 0xf07f1b, 0x3fae49];
    for (let i = 0; i < 24; i++) {
      const ch = put(new THREE.CylinderGeometry(1.1, 1.1, 0.14, 16), mat(chairCols[i % 3], { roughness: 0.4, metalness: 0.3 }), -46 + (i % 6) * 5, 1.5, 12 + Math.floor(i / 6) * 11, g);
      ch.rotation.set(Math.PI / 2 - 0.3, 0, 0);
    }
    const sailMat = mat(0xffffff, { side: THREE.DoubleSide, roughness: 0.7 });
    const hullGeo = new THREE.SphereGeometry(1, 10, 6).scale(1.6, 0.9, 5);
    const boats = [];
    for (let i = 0; i < 14; i++) {
      const boat = new THREE.Group();
      put(hullGeo, mat([0xc5050c, 0xffffff, 0x1f3f7a, 0xffc233][i % 4], { roughness: 0.35 }), 0, 0, 0, boat);
      put(new THREE.CylinderGeometry(0.14, 0.14, 14, 6), wood, 0, 7.4, 0.6, boat);
      put(new THREE.ConeGeometry(4.6, 12, 3), sailMat, 0, 8, -1.6, boat).scale.set(0.1, 1, 1);
      put(new THREE.ConeGeometry(2.6, 8, 3), sailMat, 0, 6.2, 3, boat).scale.set(0.1, 1, 1);
      boat.position.set(rand(-620, -110), WATER_Y + 0.3, rand(-430, 430));
      boat.rotation.y = rand(Math.PI * 2);
      boat.userData.phase = rand(6);
      boat.userData.dynamic = true;
      g.add(boat);
      boats.push(boat);
    }
    this.animated.push((t) => {
      for (const b of boats) {
        b.rotation.z = Math.sin(t * 0.9 + b.userData.phase) * 0.06;
        b.position.y = WATER_Y + 0.3 + Math.sin(t * 1.3 + b.userData.phase) * 0.12;
      }
    });

    // ---- Hot-air balloons
    const balloons = [];
    [[0xc5050c, 0xffffff], [0xffc233, 0x1763d6], [0x2fae5a, 0xffffff], [0xff6fae, 0x6f3fd6]].forEach(([a, b], i) => {
      const skin = mat(0xffffff, { roughness: 0.55, map: tex(256, 64, (x, w, h) => {
        for (let s = 0; s < 12; s++) {
          x.fillStyle = '#' + (s % 2 ? a : b).toString(16).padStart(6, '0');
          x.fillRect((s * w) / 12, 0, w / 12 + 1, h);
        }
      }) });
      const bl = new THREE.Group();
      put(new THREE.SphereGeometry(15, 18, 12), skin, 0, 0, 0, bl, false).scale.set(1, 1.18, 1);
      put(new THREE.ConeGeometry(8.5, 14, 18, 1, true), skin, 0, -19, 0, bl, false).rotation.x = Math.PI;
      put(new RoundedBoxGeometry(4, 3.4, 4, 1, 0.4), mat(0x8a5a2b), 0, -30, 0, bl, false);
      const a0 = i * 1.7 + 0.6;
      bl.position.set(110 + Math.cos(a0) * (330 + i * 70), 120 + i * 28, Math.sin(a0) * (330 + i * 60));
      bl.userData.y = bl.position.y;
      bl.userData.dynamic = true;
      g.add(bl);
      balloons.push(bl);
    });
    this.animated.push((t) => balloons.forEach((b, i) => (b.position.y = b.userData.y + Math.sin(t * 0.25 + i * 2) * 7)));

    this.buildPlants(g, blocked);
  }

  /** Instanced stylised trees, bushes and rocks, split into world cells so off-screen ones are culled. */
  buildPlants(g, blocked) {
    // Deterministic vertex wobble so duplicated vertices stay welded
    const wobble = (geo, amt) => {
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        const n = 1 + (fbm(x * 1.7 + y * 2.1, z * 1.9 - y * 1.3, 2) - 0.45) * amt;
        p.setXYZ(i, x * n, y * n, z * n);
      }
      return geo;
    };
    const shade = (geo, lo = 0.62, hi = 1.1) => {
      geo.computeBoundingBox();
      const { min, max } = geo.boundingBox;
      const p = geo.attributes.position;
      const c = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        const v = lo + ((p.getY(i) - min.y) / (max.y - min.y)) * (hi - lo);
        c.set([v, v, v], i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return geo;
    };
    const blob = (x, y, z, r, detail = 0) => wobble(new THREE.IcosahedronGeometry(r, detail), 0.5).translate(x, y, z);
    // ~140 triangles per tree: one detailed crown plus chunky side lobes
    // The trunk is part of the same mesh (dark vertex colour), so each tree kind is one draw per cell.
    const withTrunk = (crown, drop) => {
      const trunk = new THREE.CylinderGeometry(0.3, 0.55, 3.6, 5, 1, true).toNonIndexed().translate(0, -drop, 0);
      const c = new Float32Array(trunk.attributes.position.count * 3).fill(0.3);
      for (let i = 0; i < c.length; i += 3) c[i + 2] = 0.16; // brownish after the leaf tint
      trunk.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return mergeGeometries([crown, trunk]);
    };
    const roundGeo = withTrunk(shade(mergeGeometries([blob(0, 0, 0, 2.5, 1), blob(1.7, -0.5, 0.4, 1.8), blob(-1.5, -0.3, -0.7, 1.9), blob(0.2, -0.4, 1.6, 1.7)])), 3.3);
    const cone = (r, h, y) => new THREE.ConeGeometry(r, h, 7, 1, true).toNonIndexed().translate(0, y, 0);
    const pineGeo = withTrunk(shade(mergeGeometries([cone(2.6, 3.6, 0), cone(1.9, 3.2, 2.4), cone(1.2, 3.0, 4.6)]), 0.6, 1.15), 2.0);
    const bushGeo = shade(mergeGeometries([blob(0, 0, 0, 1), blob(0.9, -0.1, 0.2, 0.7), blob(-0.8, -0.15, -0.3, 0.75)]));
    const rockGeo = shade(wobble(new THREE.IcosahedronGeometry(1, 0), 0.9), 0.75, 1.05);
    const trunkGeo = new THREE.CylinderGeometry(0.3, 0.55, 3.4, 5, 1, true);
    const leafMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const trunkMat = mat(0x6b4526, { roughness: 0.9 });

    const greens = [0x4fb53a, 0x3f9f38, 0x6cc644, 0x2f8f3a, 0x86cf4a];
    const autumn = [0xf2a31b, 0xe2571c, 0xc5050c, 0xf7cf3d];
    const pineCols = [0x1f7a45, 0x2a8a52, 0x1a6a3f];
    const pick = (list) => list[Math.floor(rand(list.length))];

    // Collect placements per world cell and kind
    const CELL = 320;
    const cells = new Map();
    const add = (kind, x, z, item) => {
      const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
      if (!cells.has(key)) cells.set(key, { round: [], pine: [], bush: [], rock: [] });
      cells.get(key)[kind].push(item);
    };
    const onTerrace = (x, z) => x < -14 && Math.abs(z - 30) < 32;
    for (let placed = 0, tries = 0; placed < 430 && tries < 9000; tries++) {
      const x = rand(-44, 470);
      const z = rand(-470, 470);
      const d = this.distToCentre(x, z);
      if (d < WALL + 7 || (d > 70 && Math.random() < 0.55) || blocked(x, z, 5) || onTerrace(x, z)) continue;
      const isPine = d > 60 && Math.random() < 0.45;
      const color = isPine ? pick(pineCols) : Math.random() < 0.3 ? pick(autumn) : pick(greens);
      const s = rand(0.9, 1.9);
      add(isPine ? 'pine' : 'round', x, z, { x, y: this.groundY(x, z, d), z, sx: s, sy: s * rand(0.95, 1.25), color, lift: isPine ? 3.6 : 4.9, trunk: true });
      placed++;
    }
    for (let placed = 0, tries = 0; placed < 230 && tries < 5000; tries++) {
      const x = rand(-40, 420);
      const z = rand(-420, 420);
      const d = this.distToCentre(x, z);
      if (d < WALL + 4 || d > 75 || blocked(x, z, 3) || onTerrace(x, z)) continue;
      const y = this.groundY(x, z, d);
      if (Math.random() < 0.72) {
        const s = rand(0.9, 1.8);
        add('bush', x, z, { x, y, z, sx: s, sy: s * 0.8, color: pick(greens), lift: 0.6 });
      } else {
        const s = rand(0.6, 2);
        add('rock', x, z, { x, y, z, sx: s, sy: s * 0.7, color: pick([0x9aa0a6, 0x858b92, 0xb0b3b2]), lift: 0.3 });
      }
      placed++;
    }

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const col = new THREE.Color();
    const instanced = (geo, material, list, place) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach((t, i) => place(t, i, mesh));
      // Foliage uses baked blob shadows — casting hundreds of tree shadows
      // into the sun map is the main HD stall. Buildings / walls still cast.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      mesh.matrixAutoUpdate = false;
      g.add(mesh);
    };
    const leaf = (t, i, mesh) => {
      q.setFromAxisAngle(up, (t.x * 7 + t.z * 3) % 6.28);
      m4.compose(v.set(t.x, t.y + t.lift * t.sx, t.z), q, sc.set(t.sx, t.sy, t.sx));
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, col.setHex(t.color));
    };
    const trees = [...cells.values()].flatMap((c) => [...c.round, ...c.pine]);
    const blobTex = tex(64, 64, (x, w) => {
      const gr = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      gr.addColorStop(0, 'rgba(0,0,0,.8)');
      gr.addColorStop(0.6, 'rgba(0,0,0,.45)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = gr;
      x.fillRect(0, 0, w, w);
    });
    const decals = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      trees.length,
    );
    trees.forEach((t, i) => {
      // offset away from the sun so it reads as a cast shadow
      m4.compose(v.set(t.x + 1.4 * t.sx, t.y + 0.12, t.z - 1.2 * t.sx), q.identity(), sc.set(7.5 * t.sx, 1, 7.5 * t.sx));
      decals.setMatrixAt(i, m4);
    });
    decals.frustumCulled = true;
    decals.computeBoundingSphere();
    decals.boundingSphere.radius += 12;
    decals.renderOrder = 1;
    decals.matrixAutoUpdate = false;
    g.add(decals);
    // Always keep foliage contact blobs — trees no longer cast real shadows.
    this.fakeShadows = decals;
    this.fakeShadows.visible = true;

    for (const c of cells.values()) {
      instanced(roundGeo, leafMat, c.round, leaf);
      instanced(pineGeo, leafMat, c.pine, leaf);
      instanced(bushGeo, leafMat, c.bush, leaf);
      instanced(rockGeo, rockMat, c.rock, leaf);
    }
  }
}
