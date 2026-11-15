// Kart model (built from primitives) and arcade driving physics.
import * as THREE from 'three';
import { RoundedBoxGeometry } from '../vendor/addons/geometries/RoundedBoxGeometry.js';
import { ROAD_HALF, WALL } from './track.js';
import { clamp, wrap, tex } from './util.js';
import { bake } from './bake.js';
import { moveKnockback } from './collision.js';

export const BASE = { max: 58, acc: 24, turn: 1.9 };
export const NO_INPUT = Object.freeze({ steer: 0, accel: 0, brake: false, drift: false, nitro: false, item: false });

/** Diffuse material unless the part is metallic. */
function soft(color, o = {}) {
  if (o.metalness > 0.5) return new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...o });
  const { roughness, metalness, ...rest } = o;
  return new THREE.MeshLambertMaterial({ color, ...rest });
}
const carPaint = (color) => new THREE.MeshStandardMaterial({
  color, roughness: 0.18, metalness: 0.62, envMapIntensity: 1.15,
});
const glow = (color, intensity) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: color, emissiveIntensity: intensity });

const FLAME_NITRO = new THREE.Color(0x4fc4ff).multiplyScalar(4);
const FLAME_BOOST = new THREE.Color(0xff8a1f).multiplyScalar(4);

// Shared geometry, created once.
const rbox = (w, h, d, r, seg = 1) => new RoundedBoxGeometry(w, h, d, seg, r);
const ball = (r = 1) => new THREE.SphereGeometry(r, 16, 11);
function tyreGeo(r, w) {
  const s = 0.12;
  const pts = [[r * 0.5, -w / 2], [r - s, -w / 2], [r, -w / 2 + s], [r, w / 2 - s], [r - s, w / 2], [r * 0.5, w / 2]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 16).rotateZ(Math.PI / 2);
}
const GEO = {
  floor: rbox(2.0, 0.2, 3.9, 0.09),
  body: rbox(1.3, 0.6, 2.5, 0.24, 2),
  nose: ball(0.5).scale(1.05, 0.56, 2.3),
  noseTip: ball(0.3).scale(1.1, 0.55, 0.9),
  wing: rbox(2.5, 0.1, 0.6, 0.045),
  plate: rbox(0.09, 0.44, 0.66, 0.04),
  pod: rbox(0.52, 0.46, 1.6, 0.18, 2),
  intake: rbox(0.36, 0.26, 0.12, 0.05),
  engine: rbox(0.95, 0.52, 1.05, 0.2, 2),
  scoop: rbox(0.42, 0.3, 0.6, 0.12),
  pipe: new THREE.CylinderGeometry(0.13, 0.15, 0.7, 10).rotateX(Math.PI / 2),
  rearWing: rbox(2.35, 0.1, 0.66, 0.045),
  rearPlate: rbox(0.09, 0.56, 0.78, 0.04),
  strut: rbox(0.1, 0.62, 0.2, 0.04),
  tail: rbox(1.0, 0.13, 0.1, 0.04),
  lamp: new THREE.SphereGeometry(0.11, 8, 6),
  seat: rbox(0.82, 0.75, 0.26, 0.1),
  column: new THREE.CylinderGeometry(0.035, 0.035, 0.6, 8),
  wheel: new THREE.TorusGeometry(0.21, 0.04, 5, 12),
  tyreF: tyreGeo(0.46, 0.44),
  tyreR: tyreGeo(0.56, 0.58),
  rimF: new THREE.CylinderGeometry(0.27, 0.27, 0.46, 12).rotateZ(Math.PI / 2),
  rimR: new THREE.CylinderGeometry(0.32, 0.32, 0.6, 12).rotateZ(Math.PI / 2),
  spokeF: new THREE.BoxGeometry(0.47, 0.5, 0.09),
  spokeR: new THREE.BoxGeometry(0.61, 0.6, 0.1),
  torso: new THREE.CapsuleGeometry(0.37, 0.45, 4, 12),
  band: new THREE.CylinderGeometry(0.385, 0.385, 0.15, 12, 1, true),
  arm: new THREE.CapsuleGeometry(0.1, 0.5, 3, 7),
  flame: new THREE.ConeGeometry(0.17, 1.7, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.85),
  shield: new THREE.SphereGeometry(2.6, 20, 12),
  shadow: new THREE.CircleGeometry(1.9, 20),
  unit: ball(1),
  cone: new THREE.ConeGeometry(1, 1, 10),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
  torus: new THREE.TorusGeometry(1, 0.38, 7, 16),
  small: new THREE.SphereGeometry(1, 8, 6),
  box: rbox(1, 1, 1, 0.2),
  half: new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.56),
};

function mesh(geo, material, x, y, z, parent, cast = false) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = cast;
  parent.add(m);
  return m;
}
/** Unit shape scaled into place. */
function part(geo, material, pos, scale, parent, cast = false) {
  const m = mesh(geo, material, pos[0], pos[1], pos[2], parent, cast);
  if (typeof scale === 'number') m.scale.setScalar(scale);
  else m.scale.set(...scale);
  return m;
}

/** Driver head with mascot features. Faces +z. */
function buildHead(look, parent) {
  const fur = soft(look.fur);
  const dark = soft(0x15151a, { roughness: 0.5 });
  const eyeWhite = soft(0xffffff, { roughness: 0.25 });
  const pupil = soft(0x0c0c10, { roughness: 0.15 });
  const accent = soft(look.c2, { roughness: 0.45, metalness: 0.2 });
  const cream = soft(0xfff1dc);
  const head = new THREE.Group();
  head.position.set(0, 2.1, -0.35);
  parent.add(head);
  part(GEO.unit, fur, [0, 0, 0], 0.6, head, true);

  const badger = look.extra === 'stripes';
  const ex = badger ? 0.25 : 0.23;
  const ez = badger ? 0.57 : 0.5;
  for (const s of [-1, 1]) {
    part(GEO.unit, eyeWhite, [s * ex, 0.13, ez], badger ? 0.11 : 0.14, head);
    part(GEO.small, pupil, [s * ex, 0.13, ez + (badger ? 0.075 : 0.1)], badger ? 0.06 : 0.075, head);
  }

  switch (look.ears) {
    case 'round':
      for (const s of [-1, 1]) {
        part(GEO.unit, badger ? dark : fur, [s * 0.44, 0.47, -0.05], 0.2, head, true);
        part(GEO.unit, badger ? eyeWhite : cream, [s * 0.44, 0.47, 0.06], 0.12, head);
      }
      break;
    case 'point':
      for (const s of [-1, 1]) part(GEO.cone, fur, [s * 0.36, 0.66, -0.05], [0.2, 0.46, 0.2], head, true).rotation.z = s * -0.25;
      break;
    case 'flop':
      for (const s of [-1, 1]) part(GEO.unit, soft(0x6b4a2b), [s * 0.6, 0.02, 0], [0.12, 0.32, 0.22], head, true);
      break;
    case 'big':
      for (const s of [-1, 1]) part(GEO.unit, fur, [s * 0.72, 0.1, -0.1], [0.1, 0.5, 0.48], head, true);
      break;
  }
  switch (look.snout) {
    case 'short':
      part(GEO.unit, cream, [0, -0.15, 0.44], [0.29, 0.21, 0.26], head);
      part(GEO.small, dark, [0, -0.07, 0.68], 0.09, head);
      break;
    case 'beak':
      part(GEO.cone, soft(0xf59a1b, { roughness: 0.4 }), [0, -0.1, 0.78], [0.2, 0.6, 0.16], head).rotation.x = Math.PI / 2;
      break;
    case 'long':
      part(GEO.box, fur, [0, -0.16, 0.72], [0.46, 0.3, 0.8], head, true);
      part(GEO.box, eyeWhite, [0, -0.3, 0.76], [0.38, 0.07, 0.66], head);
      for (const s of [-1, 1]) part(GEO.small, dark, [s * 0.12, -0.02, 1.08], 0.04, head);
      break;
    case 'trunk':
      part(GEO.cyl, fur, [0, -0.38, 0.62], [0.13, 0.9, 0.13], head, true).rotation.x = -0.5;
      break;
  }
  switch (look.extra) {
    case 'stripes': // badger face: two dark bands running over the eyes
      for (const s of [-1, 1]) part(GEO.unit, dark, [s * 0.26, 0.19, 0], [0.16, 0.44, 0.6], head).rotation.z = s * -0.12;
      break;
    case 'teeth':
      part(GEO.box, eyeWhite, [0, -0.33, 0.6], [0.16, 0.16, 0.06], head);
      break;
    case 'horns':
      for (const s of [-1, 1]) part(GEO.cone, soft(0xfff8e7, { roughness: 0.3 }), [s * 0.85, 0.34, 0], [0.1, 0.95, 0.1], head, true).rotation.z = s * -1.2;
      break;
    case 'helmet':
      part(GEO.half, accent, [0, 0.03, -0.03], 0.67, head, true);
      part(GEO.box, soft(look.c1, { roughness: 0.4 }), [0, 0.7, -0.05], [0.12, 0.3, 1.0], head);
      break;
    case 'hat':
      part(GEO.cyl, accent, [0, 0.46, 0], [0.86, 0.07, 0.86], head, true);
      part(GEO.cyl, accent, [0, 0.68, 0], [0.44, 0.44, 0.44], head, true);
      part(GEO.cyl, soft(look.c1), [0, 0.54, 0], [0.455, 0.1, 0.455], head);
      break;
    case 'mane':
      part(GEO.torus, soft(0x8a5a1e), [0, 0, -0.12], 0.56, head, true);
      break;
    case 'crest':
      part(GEO.box, accent, [0, 0.66, -0.1], [0.1, 0.42, 0.7], head, true).rotation.x = -0.3;
      break;
    case 'nut':
      part(GEO.unit, soft(0xd9b98a), [0, 0, 0.26], [0.44, 0.46, 0.4], head);
      break;
  }
  return head;
}

function nameTag(text, color) {
  const map = tex(256, 72, (c, w, h) => {
    c.fillStyle = 'rgba(12,14,20,.78)';
    c.beginPath();
    c.roundRect(6, 8, w - 12, h - 16, 26);
    c.fill();
    c.fillStyle = color;
    c.fillRect(22, h - 20, w - 44, 4);
    c.font = '900 36px Arial';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 - 2);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, depthWrite: false }));
  s.scale.set(2.7, 0.76, 1);
  s.position.y = 3.8;
  // Fade out when close to whichever camera is drawing, so tags never fill the screen.
  const p = new THREE.Vector3();
  s.onBeforeRender = (_r, _s, camera) => {
    s.material.opacity = clamp((camera.position.distanceTo(s.getWorldPosition(p)) - 10) / 10, 0, 1);
  };
  return s;
}

/** @param detailed keep separately rolling/steering wheels (used for player karts, which are seen up close) */
export function buildKartModel(look, tag, tagColor = '#fff', detailed = false) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const paint = carPaint(look.c1);
  paint.userData.own = true;
  const trim = new THREE.MeshStandardMaterial({ color: look.c2, roughness: 0.3, metalness: 0.55 });
  const carbon = soft(0x15171c, { roughness: 0.45, metalness: 0.4 });
  const rubber = soft(0x121214, { roughness: 0.92 });
  const chrome = soft(0xd8dde4, { roughness: 0.18, metalness: 1 });

  // Chassis
  mesh(GEO.floor, carbon, 0, 0.32, 0.05, body, true);
  mesh(GEO.body, paint, 0, 0.66, -0.3, body, true);
  mesh(GEO.nose, paint, 0, 0.56, 1.2, body, true);
  mesh(GEO.noseTip, trim, 0, 0.5, 2.18, body);
  mesh(GEO.wing, trim, 0, 0.3, 2.3, body, true);
  for (const s of [-1, 1]) {
    mesh(GEO.plate, paint, s * 1.25, 0.44, 2.3, body);
    mesh(GEO.pod, paint, s * 0.84, 0.56, -0.4, body, true);
    mesh(GEO.intake, carbon, s * 0.84, 0.6, 0.38, body);
    mesh(GEO.pipe, chrome, s * 0.3, 0.8, -2.0, body);
    mesh(GEO.rearPlate, paint, s * 1.17, 1.52, -1.8, body);
    mesh(GEO.strut, carbon, s * 0.45, 1.3, -1.72, body);
    mesh(GEO.lamp, glow(0xfff2c4, 1.8), s * 0.26, 0.64, 2.02, body);
  }
  mesh(GEO.engine, paint, 0, 0.98, -1.3, body, true);
  mesh(GEO.scoop, trim, 0, 1.34, -1.1, body);
  mesh(GEO.rearWing, trim, 0, 1.64, -1.8, body, true);
  mesh(GEO.tail, glow(0xff1a1a, 1.6), 0, 0.98, -1.84, body);
  mesh(GEO.seat, carbon, 0, 1.02, -0.78, body);
  mesh(GEO.column, carbon, 0, 1.0, 0.45, body).rotation.x = -0.9;
  mesh(GEO.wheel, carbon, 0, 1.18, 0.24, body).rotation.x = 0.65;

  // Wheels: pivot (steers) > spinner (rolls)
  const wheels = [];
  for (const [x, z, front] of [[-1.13, 1.32, 1], [1.13, 1.32, 1], [-1.16, -1.22, 0], [1.16, -1.22, 0]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, front ? 0.46 : 0.56, z);
    body.add(pivot);
    const spin = new THREE.Group();
    pivot.add(spin);
    pivot.userData.dynamic = detailed; // player karts keep wheels that roll and steer
    mesh(front ? GEO.tyreF : GEO.tyreR, rubber, 0, 0, 0, spin, true);
    mesh(front ? GEO.rimF : GEO.rimR, trim, 0, 0, 0, spin);
    mesh(front ? GEO.spokeF : GEO.spokeR, carbon, 0, 0, 0, spin);
    mesh(front ? GEO.spokeF : GEO.spokeR, carbon, 0, 0, 0, spin).rotation.x = Math.PI / 2;
    wheels.push(pivot);
  }

  // Driver
  const cloth = soft(look.sweater ?? look.c1, { roughness: 0.85 });
  mesh(GEO.torso, cloth, 0, 1.36, -0.38, body, true);
  if (look.sweater !== undefined) mesh(GEO.band, soft(0xffffff, { roughness: 0.85 }), 0, 1.3, -0.38, body);
  for (const s of [-1, 1]) {
    const arm = mesh(GEO.arm, cloth, s * 0.34, 1.36, -0.02, body);
    arm.rotation.set(1.15, 0, s * -0.22);
    part(GEO.unit, soft(look.fur), [s * 0.2, 1.2, 0.26], 0.11, body);
  }
  buildHead(look, body);

  // Exhaust flames (additive, HDR so they bloom)
  const flameMat = new THREE.MeshBasicMaterial({ color: FLAME_NITRO.clone(), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const flame = new THREE.Group();
  for (const s of [-1, 1]) mesh(GEO.flame, flameMat, s * 0.3, 0.8, -2.3, flame);
  flame.visible = false;
  flame.userData.dynamic = true;
  body.add(flame);

  // Batch the whole kart into a single vertex-coloured mesh (plus four wheels on player karts).
  const skin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.22 });
  bake(body, { cast: true, one: skin });
  if (detailed) for (const w of wheels) bake(w.children[0], { cast: true, one: skin });

  const shield = mesh(
    GEO.shield,
    new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.3, depthWrite: false }),
    0, 1.2, 0, group,
  );
  shield.visible = false;
  const shadow = mesh(GEO.shadow, new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.35, depthWrite: false }), 0, 0.05, 0, group);
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1, 1.5, 1);
  const tagSprite = tag ? nameTag(tag, tagColor) : null;
  if (tagSprite) group.add(tagSprite);
  return { group, body, wheels, flame, flameMat, shield, shadow, paint: skin, tag: tagSprite, detailed };
}

export class Kart {
  /**
   * @param {object} o  { name, tag, tagColor, look, stats, mult, human (player index or -1), perk, team }
   */
  constructor(o) {
    Object.assign(this, o);
    this.model = buildKartModel(o.look, o.tag, o.tagColor, o.human >= 0);
    this.x = this.z = this.y = this.vy = 0;
    this.heading = 0;
    this.speed = 0;
    this.bumpX = this.bumpZ = 0;
    this.steer = 0;
    this.idx = 0;
    this.lat = 0;
    this.lap = 0;
    this.progress = 0;
    this.place = 1;
    this.nitro = o.perk === 'rocket' ? 1 : 0.25;
    this.nitroOn = false;
    this.boostT = 0;
    this.spinT = 0;
    this.starT = 0;
    this.slowT = 0;
    this.shield = false;
    this.item = o.startingItem ?? (o.perk === 'pocket' ? 'curd' : null);
    this.rollT = 0;
    this.drifting = false;
    this.driftDir = 0;
    this.driftT = 0;
    this.padCd = 0;
    this.finished = false;
    this.finishTime = 0;
    this.msg = null;
    this.spinMult = (o.stats.spin ?? 1) * (o.perk === 'fur' ? 0.5 : 1);
    this.ai = { t: 0, lat: 0, itemT: 2, nitro: false };
  }

  get boosting() {
    return this.boostT > 0 || this.nitroOn;
  }

  placeAt(track, idx, lat) {
    this.bumpX = this.bumpZ = 0;
    const p = track.pointAt(idx, lat);
    this.x = p.x;
    this.z = p.z;
    this.idx = ((idx % track.N) + track.N) % track.N;
    this.lat = lat;
    this.heading = track.headingAt(this.idx);
    this.progress = this.idx - track.N;
    this.syncMesh(0, 0);
  }

  say(text, t = 1.6) {
    this.msg = { text, t };
  }

  /** Returns true if the hit landed (false if blocked). */
  hit() {
    if (this.starT > 0) return false;
    if (this.shield) {
      this.shield = false;
      return false;
    }
    this.spinT = 1.3 * this.spinMult;
    this.speed *= 0.35;
    this.drifting = false;
    this.nitroOn = false;
    return true;
  }

  update(dt, ctl, track) {
    for (const k of ['boostT', 'starT', 'slowT', 'padCd', 'rollT']) this[k] = Math.max(0, this[k] - dt);
    if (this.msg && (this.msg.t -= dt) <= 0) this.msg = null;
    const spun = this.spinT > 0;
    if (spun) {
      this.spinT -= dt;
      ctl = NO_INPUT;
    }
    const st = this.stats;
    const off = Math.abs(this.lat) > ROAD_HALF + 0.8 && this.starT <= 0;

    // Nitro: needs a little in the tank to light, then burns until empty or released.
    if (ctl.nitro && (this.nitroOn || this.nitro > 0.15) && this.nitro > 0) {
      this.nitroOn = true;
      this.nitro = Math.max(0, this.nitro - dt * 0.34);
    } else {
      this.nitroOn = false;
      this.nitro = Math.min(1, this.nitro + dt * 0.08);
    }

    let max = BASE.max * st.top * this.mult;
    if (this.boosting) max *= 1.32;
    if (this.starT > 0) max *= 1.12;
    if (this.slowT > 0) max *= 0.7;
    if (off) max *= 0.5;

    if (ctl.accel > 0 && this.speed < max) {
      const a = BASE.acc * st.accel * (this.boosting ? 2 : 1) * (1.15 - clamp(this.speed / max, 0, 1));
      this.speed = Math.min(max, this.speed + a * ctl.accel * dt);
    } else if (this.speed > max) {
      this.speed -= (this.speed - max) * Math.min(1, 3 * dt);
    } else if (!ctl.accel) {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), 9 * dt);
    }
    if (ctl.brake) this.speed = Math.max(-14, this.speed - 46 * dt);
    if (spun) this.speed *= 1 - Math.min(1, 2.2 * dt);

    // Drift
    if (!this.drifting && ctl.drift && Math.abs(ctl.steer) > 0.25 && this.speed > 22 && !off && this.y <= 0) {
      this.drifting = true;
      this.driftDir = Math.sign(ctl.steer);
      this.driftT = 0;
    }
    if (this.drifting) {
      if (!ctl.drift || this.speed < 15) {
        if (this.driftT > 0.9) this.boostT = Math.max(this.boostT, this.driftT > 2 ? 1.1 : 0.6);
        this.drifting = false;
      } else {
        this.driftT += dt;
        this.nitro = Math.min(1, this.nitro + dt * 0.2 * st.drift);
      }
    }
    let steer = clamp(ctl.steer, -1, 1);
    if (this.drifting) steer = this.driftDir * 0.6 + steer * 0.65;
    this.steer = steer;
    const grip = clamp(this.speed / 18, -1, 1);
    this.heading -= steer * BASE.turn * st.turn * grip * dt;

    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z += Math.cos(this.heading) * this.speed * dt;
    moveKnockback(this, dt);
    if (this.y > 0 || this.vy > 0) {
      this.vy -= 32 * dt;
      this.y = Math.max(0, this.y + this.vy * dt);
      if (this.y === 0) this.vy = 0;
    }

    // Track position, laps, barriers
    const n = track.N;
    const i = track.locate(this.x, this.z, this.idx);
    const d = i - this.idx;
    if (d < -n / 2) this.lap++;
    else if (d > n / 2) this.lap--;
    this.idx = i;
    this.lat = (this.x - track.px[i]) * track.nx[i] + (this.z - track.pz[i]) * track.nz[i];
    if (Math.abs(this.lat) > WALL) {
      const s = Math.sign(this.lat);
      const ex = Math.abs(this.lat) - WALL;
      this.x -= track.nx[i] * ex * s;
      this.z -= track.nz[i] * ex * s;
      this.lat = s * WALL;
      this.speed *= 1 - Math.min(1, 1.8 * dt);
      const dir = this.speed >= 0 ? 0 : Math.PI;
      this.heading += wrap(track.headingAt(i) + dir - this.heading) * Math.min(1, 3.5 * dt);
    }
    this.progress = (this.lap - 1) * n + i;
    this.offroad = off;
  }

  syncMesh(dt, time) {
    const m = this.model;
    m.group.position.set(this.x, this.y, this.z);
    m.group.rotation.y = this.heading;
    const targetYaw = this.drifting ? -this.driftDir * 0.42 : 0;
    const spin = this.spinT > 0 ? this.spinT * 11 : 0;
    this.visYaw = (this.visYaw ?? 0) + (targetYaw - (this.visYaw ?? 0)) * Math.min(1, 10 * dt);
    m.body.rotation.y = this.visYaw + spin;
    m.body.rotation.z = this.steer * 0.07 * clamp(this.speed / 40, 0, 1);
    m.body.rotation.x = clamp(-this.vy * 0.02, -0.3, 0.3);
    if (m.detailed) {
      m.wheels[0].rotation.y = m.wheels[1].rotation.y = -this.steer * 0.4;
      for (const w of m.wheels) w.children[0].rotation.x += this.speed * dt * 2;
    }
    m.shield.rotation.y = time * 1.5;
    m.flame.visible = this.boosting;
    if (m.flame.visible) {
      m.flame.scale.set(1, 1, 0.7 + Math.random() * 0.7);
      m.flameMat.color.copy(this.nitroOn ? FLAME_NITRO : FLAME_BOOST);
    }
    m.shield.visible = this.shield;
    m.shadow.position.y = 0.05 - this.y;
    if (this.starT > 0) m.paint.emissive.setHSL((time * 2) % 1, 1, 0.5);
    else if (this.slowT > 0) m.paint.emissive.setHex(0x2a6fb0);
    else m.paint.emissive.setHex(0);
  }
}
