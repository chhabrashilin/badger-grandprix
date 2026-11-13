// One race: karts, AI drivers, items, pickups, collisions and standings.
import * as THREE from 'three';
import { Kart, NO_INPUT } from './kart.js';
import { collideKarts } from './collision.js';
import { ROAD_HALF } from './track.js';
import { KARTS, ITEMS } from './teams.js';
import { RoundedBoxGeometry } from '../vendor/addons/geometries/RoundedBoxGeometry.js';
import { clamp, wrap, rand, shuffle, tex } from './util.js';

export const DIFFICULTY = { easy: 0.9, normal: 0.95, hard: 1.0 };
const TOTAL_KARTS = 8;
export const rivalCount = (nPlayers) => Math.max(4, TOTAL_KARTS - nPlayers);

/** Pooled point particles for sparks, dust and exhaust. */
class Sparks {
  constructor(n = 500, { additive = true, size = 1.1, gravity = 12, gain = 2.2 } = {}) {
    this.n = n;
    this.gravity = gravity;
    this.gain = gain;
    this.i = 0;
    this.pos = new Float32Array(n * 3).fill(-999);
    this.col = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const dot = tex(64, 64, (c, w) => {
      const gr = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.35, 'rgba(255,255,255,.7)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gr;
      c.fillRect(0, 0, w, w);
    });
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size, map: dot, vertexColors: true, transparent: true, opacity: additive ? 1 : 0.5, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending }));
    this.points.frustumCulled = false;
    this.c = new THREE.Color();
  }

  emit(x, y, z, vx, vy, vz, color, life = 0.5) {
    const i = (this.i = (this.i + 1) % this.n);
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.c.setHex(color);
    this.col.set([this.c.r * this.gain, this.c.g * this.gain, this.c.b * this.gain], i * 3); // HDR gain so sparks bloom
    this.life[i] = life;
  }

  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) {
        this.pos[j + 1] = -999;
        continue;
      }
      this.vel[j + 1] -= this.gravity * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] = Math.max(0.1, this.pos[j + 1] + this.vel[j + 1] * dt);
      this.pos[j + 2] += this.vel[j + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

export class Race {
  /**
   * @param track  Track
   * @param cfg    { players: [{ badger, kart, perk }], field: [{ team, mult }], laps, difficulty }
   */
  constructor(track, cfg) {
    this.track = track;
    this.laps = cfg.laps;
    this.group = new THREE.Group();
    this.state = 'countdown';
    this.countT = 3.6;
    this.time = 0;
    this.endT = 0;
    this.flash = 0;
    this.events = []; // { type, kart } consumed by main for audio
    this.shots = [];
    this.slicks = [];
    this.sparks = new Sparks();
    this.smoke = new Sparks(260, { additive: false, size: 3.2, gravity: -3, gain: 1 });
    this.group.add(this.sparks.points, this.smoke.points);

    const diff = DIFFICULTY[cfg.difficulty] ?? DIFFICULTY.normal;
    const rivals = cfg.field.map((f) => new Kart({
      name: `${f.team.school} ${f.team.mascot}`, tag: f.team.abbr, tagColor: '#ffe9a8', look: f.team.look,
      stats: KARTS[Math.floor(rand(KARTS.length))], mult: diff * f.mult, human: -1, perk: null, team: f.team,
    }));
    const humans = cfg.players.map((p, i) => new Kart({
      name: cfg.players.length > 1 ? `P${i + 1} ${p.badger.name}` : p.badger.name,
      tag: cfg.players.length > 1 ? `P${i + 1}` : null, tagColor: '#fff', look: p.badger.look,
      startingItem: p.startingItem, stats: p.kart, mult: 1, human: i, perk: p.perk.key, luck: p.perk.key === 'lucky' ? 0.3 : 0,
    }));
    this.humans = humans;
    // Each player's own name tag lives on a layer their camera skips.
    for (const h of humans) h.model.tag?.layers.set(h.human + 1);
    this.karts = [...shuffle(rivals), ...humans]; // players start at the back of the grid
    this.karts.forEach((k, i) => {
      k.placeAt(track, track.N - 8 - Math.floor(i / 2) * 5, i % 2 ? -4 : 4);
      this.group.add(k.model.group);
    });

    this.buildPickups();
    this.rank();
  }

  buildPickups() {
    const t = this.track;
    const boxTex = tex(64, 64, (c, w, h) => {
      const g = c.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#ff5fa2');
      g.addColorStop(0.5, '#ffd23f');
      g.addColorStop(1, '#4fd1ff');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#fff';
      c.font = '900 50px Arial';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('?', w / 2, h / 2 + 3);
    });
    // Glassy cube with a glowing rainbow core
    const shell = new THREE.MeshPhysicalMaterial({ map: boxTex, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1, emissive: 0xffffff, emissiveMap: boxTex, emissiveIntensity: 0.9 });
    const core = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffffff, emissiveIntensity: 2.6 });
    const geo = new RoundedBoxGeometry(2, 2, 2, 3, 0.3);
    const coreGeo = new THREE.OctahedronGeometry(0.6);
    // All boxes are two instanced meshes (shell + core): 2 draw calls instead of 32.
    this.boxes = [];
    for (const idx of t.boxRows) {
      for (const lat of [-6, -2, 2, 6]) {
        const p = t.pointAt(idx, lat);
        // `mesh` is a plain proxy; syncBoxes() writes it into the instance matrices.
        this.boxes.push({ x: p.x, z: p.z, t: 0, mesh: { visible: true, rotation: { x: Math.random() * 6, y: Math.random() * 6 }, position: { y: 1.7 } } });
      }
    }
    this.boxShell = new THREE.InstancedMesh(geo, shell, this.boxes.length);
    this.boxCore = new THREE.InstancedMesh(coreGeo, core, this.boxes.length);
    for (const m of [this.boxShell, this.boxCore]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.boxShell.castShadow = true;
    this.syncBoxes();
    this.coreMat = core;
    this.shotGeo = { curd: new THREE.DodecahedronGeometry(0.75), football: new THREE.SphereGeometry(0.6, 16, 12).scale(1, 1, 1.6) };
    this.shotMat = {
      curd: new THREE.MeshStandardMaterial({ color: 0xffc83d, emissive: 0xff9a00, emissiveIntensity: 1.6, roughness: 0.4 }),
      football: new THREE.MeshStandardMaterial({ color: 0x8a4516, emissive: 0x5a2000, emissiveIntensity: 0.8, roughness: 0.5 }),
    };
    this.slickGeo = new THREE.SphereGeometry(1.9, 20, 10).scale(1, 0.1, 1);
    this.slickMat = new THREE.MeshStandardMaterial({ color: 0xffe14d, roughness: 0.08, metalness: 0.2, emissive: 0x6b5500, emissiveIntensity: 0.6 });
    // One hidden-away instance of each, so their shaders compile during loading rather than on first use.
    for (const [geo, material] of [[this.shotGeo.curd, this.shotMat.curd], [this.shotGeo.football, this.shotMat.football], [this.slickGeo, this.slickMat]]) {
      const warm = new THREE.Mesh(geo, material);
      warm.position.set(0, -40, 0);
      warm.frustumCulled = false;
      this.group.add(warm);
    }
  }

  syncBoxes() {
    const m4 = (this._m4 ??= new THREE.Matrix4());
    const e = (this._e ??= new THREE.Euler());
    const q = (this._q ??= new THREE.Quaternion());
    const v = (this._v ??= new THREE.Vector3());
    const s = (this._s ??= new THREE.Vector3());
    this.boxes.forEach((b, i) => {
      q.setFromEuler(e.set(b.mesh.rotation.x, b.mesh.rotation.y, 0));
      m4.compose(v.set(b.x, b.mesh.position.y, b.z), q, s.setScalar(b.mesh.visible ? 1 : 0));
      this.boxShell.setMatrixAt(i, m4);
      this.boxCore.setMatrixAt(i, m4);
    });
    this.boxShell.instanceMatrix.needsUpdate = this.boxCore.instanceMatrix.needsUpdate = true;
  }

  rank() {
    const order = [...this.karts].sort((a, b) =>
      a.finished !== b.finished ? (a.finished ? -1 : 1) : a.finished ? a.finishTime - b.finishTime : b.progress - a.progress);
    order.forEach((k, i) => (k.place = i + 1));
    this.order = order;
  }

  // ---------------------------------------------------------------- AI
  aiControl(k, dt) {
    const t = this.track;
    const ai = k.ai;
    if ((ai.t -= dt) <= 0) {
      ai.t = rand(2, 5);
      ai.lat = rand(-1, 1) * (ROAD_HALF - 3);
    }
    const j = (k.idx + 6 + Math.floor(k.speed * 0.12)) % t.N;
    const tx = t.px[j] + t.nx[j] * ai.lat;
    const tz = t.pz[j] + t.nz[j] * ai.lat;
    const diff = wrap(Math.atan2(tx - k.x, tz - k.z) - k.heading);
    const ad = Math.abs(diff);
    if (k.nitro > 0.7 && ad < 0.12) ai.nitro = true;
    if (k.nitro < 0.05 || ad > 0.35) ai.nitro = false;
    let item = false;
    if (k.item && (ai.itemT -= dt) <= 0) {
      item = true;
      ai.itemT = rand(1.5, 5);
    }
    // Gentle rubber-banding against the best-placed human still racing.
    const lead = this.humans.reduce((m, h) => (h.finished ? m : Math.max(m, h.progress)), -Infinity);
    const gap = Number.isFinite(lead) ? k.progress - lead : 0;
    const accel = k.finished ? 0.7 : gap > 70 ? 0.9 : 1;
    return {
      steer: clamp(-diff * 3, -1, 1),
      accel: ad < 0.6 || k.speed < 28 ? accel : 0,
      brake: ad > 1.1 && k.speed > 30,
      drift: false,
      nitro: ai.nitro && !k.finished,
      item,
    };
  }

  // ---------------------------------------------------------------- items
  rollItem(k) {
    const n = this.karts.length;
    const f = clamp((k.place - 1) / (n - 1) + (k.luck ?? 0), 0, 1);
    const w = {
      curd: 3, slick: 1 + 3 * (1 - f), cone: 1 + 3 * f, football: 1 + 2 * f,
      shield: 0.5 + 2 * (1 - f), boombox: f > 0.5 ? 2 * f : 0, blizzard: f > 0.6 ? 1.5 * f : 0,
    };
    let r = Math.random() * Object.values(w).reduce((a, b) => a + b, 0);
    for (const [key, v] of Object.entries(w)) if ((r -= v) <= 0) return key;
    return 'curd';
  }

  useItem(k) {
    const it = k.item;
    if (!it || k.spinT > 0) return;
    k.item = null;
    this.events.push({ type: 'use', kart: k, item: it });
    switch (it) {
      case 'curd':
      case 'football': {
        const mesh = new THREE.Mesh(this.shotGeo[it], this.shotMat[it]);
        this.group.add(mesh);
        const target = it === 'football' ? this.order[k.place - 2] ?? null : null;
        this.shots.push({ type: it, s: k.idx + 2.5, lat: k.lat, v: it === 'curd' ? Math.max(k.speed, 30) + 42 : 88, owner: k, target, life: it === 'curd' ? 4 : 7, mesh });
        break;
      }
      case 'slick': {
        const mesh = new THREE.Mesh(this.slickGeo, this.slickMat);
        const x = k.x - Math.sin(k.heading) * 3.5;
        const z = k.z - Math.cos(k.heading) * 3.5;
        mesh.position.set(x, 0.14, z);
        this.group.add(mesh);
        this.slicks.push({ x, z, mesh, life: 40, arm: 0.6, owner: k });
        break;
      }
      case 'cone':
        k.boostT = Math.max(k.boostT, 2.2);
        break;
      case 'shield':
        k.shield = true;
        break;
      case 'boombox':
        k.starT = 7;
        k.say('JUMP AROUND!');
        break;
      case 'blizzard':
        this.flash = 0.5;
        for (const o of this.karts) {
          if (o !== k && o.place < k.place && !o.finished && o.starT <= 0) {
            if (o.shield) o.shield = false;
            else {
              o.slowT = 3.5;
              o.say('FROZEN!');
            }
          }
        }
        break;
    }
  }

  landHit(victim, by) {
    if (victim.hit()) {
      this.events.push({ type: 'hit', kart: victim });
      victim.say('SPUN OUT!');
      if (by && by !== victim) by.say(`HIT ${victim.tag ?? victim.name.toUpperCase()}!`, 1.2);
      for (let i = 0; i < 14; i++) this.sparks.emit(victim.x, 1.2, victim.z, rand(-7, 7), rand(3, 9), rand(-7, 7), 0xffe14d, 0.7);
    } else {
      this.events.push({ type: 'block', kart: victim });
    }
  }

  updateItems(dt) {
    const t = this.track;
    for (const s of this.shots) {
      s.life -= dt;
      s.s += (s.v * dt) / t.segLen;
      if (s.target && !s.target.finished) s.lat += clamp(s.target.lat - s.lat, -14 * dt, 14 * dt);
      const p = t.pointAt(s.s, s.lat);
      s.mesh.position.set(p.x, 1.1, p.z);
      if (Math.random() < 0.7) this.sparks.emit(p.x, 1.1, p.z, rand(-2, 2), rand(0, 3), rand(-2, 2), s.type === 'curd' ? 0xffc83d : 0xff7a2a, 0.35);
      s.mesh.rotation.x += dt * 9;
      s.mesh.rotation.y += dt * 5;
      for (const k of this.karts) {
        if (k === s.owner || k.y > 1.6) continue;
        if ((k.x - p.x) ** 2 + (k.z - p.z) ** 2 < 6.5) {
          this.landHit(k, s.owner);
          s.life = 0;
          break;
        }
      }
    }
    for (const s of this.slicks) {
      s.life -= dt;
      s.arm -= dt;
      for (const k of this.karts) {
        if ((s.arm > 0 && k === s.owner) || k.y > 0.8) continue;
        if ((k.x - s.x) ** 2 + (k.z - s.z) ** 2 < 6.2) {
          this.landHit(k, s.owner);
          s.life = 0;
          break;
        }
      }
    }
    for (const list of [this.shots, this.slicks]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].life <= 0) {
          this.group.remove(list[i].mesh);
          list.splice(i, 1);
        }
      }
    }
  }

  updatePickups(dt) {
    for (const b of this.boxes) {
      if (b.t > 0) {
        b.t -= dt;
        b.mesh.visible = b.t <= 0;
        continue;
      }
      b.mesh.rotation.y += dt * 1.5;
      b.mesh.rotation.x += dt * 0.9;
      b.mesh.position.y = 1.7 + Math.sin(this.time * 2.5 + b.x) * 0.22;
      for (const k of this.karts) {
        if ((k.x - b.x) ** 2 + (k.z - b.z) ** 2 < 7) {
          b.t = 4;
          b.mesh.visible = false;
          if (!k.item && k.rollT <= 0 && !k.finished) {
            k.rollT = 1.1;
            k.rolling = true;
            this.events.push({ type: 'box', kart: k });
          }
          break;
        }
      }
    }
    this.syncBoxes();
    for (const k of this.karts) {
      if (k.rolling && k.rollT <= 0) {
        k.rolling = false;
        k.item = this.rollItem(k);
        if (k.human >= 0) k.say(ITEMS[k.item].name, 1.2);
      }
      if (k.padCd > 0 || k.y > 0.6) continue;
      for (const p of this.track.pads) {
        if ((k.x - p.x) ** 2 + (k.z - p.z) ** 2 < 11) {
          k.padCd = 0.6;
          k.boostT = Math.max(k.boostT, 1.1);
          k.nitro = Math.min(1, k.nitro + 0.15);
          if (p.jump) k.vy = 12;
          k.say(p.jump ? 'JUMP BOOST!' : 'SPEED BOOST!', 0.9);
          this.events.push({ type: 'pad', kart: k });
          break;
        }
      }
    }
  }

  collide() {
    const ks = this.karts;
    for (let a = 0; a < ks.length; a++) {
      for (let b = a + 1; b < ks.length; b++) {
        const A = ks[a];
        const B = ks[b];
        if (!collideKarts(A, B)) continue;
        if (A.starT > 0 && B.starT <= 0 && B.spinT <= 0) this.landHit(B, A);
        else if (B.starT > 0 && A.starT <= 0 && A.spinT <= 0) this.landHit(A, B);
      }
    }
  }

  emitEffects(k) {
    const sx = Math.sin(k.heading);
    const cz = Math.cos(k.heading);
    const bx = k.x - sx * 1.8;
    const bz = k.z - cz * 1.8;
    if (k.drifting) {
      if (Math.random() < 0.6) this.smoke.emit(bx + rand(-0.8, 0.8), 0.5, bz + rand(-0.8, 0.8), rand(-1, 1), rand(0.5, 2), rand(-1, 1), 0xdfe3e8, 0.7);
      const c = k.driftT > 2 ? 0xff5fd0 : k.driftT > 0.9 ? 0xffa126 : 0x7fd4ff;
      for (const s of [-1, 1]) this.sparks.emit(bx + cz * s, 0.3, bz - sx * s, rand(-3, 3), rand(2, 6), rand(-3, 3), c, 0.35);
    }
    if (k.boosting && Math.random() < 0.8) this.sparks.emit(k.x - sx * 2.6 + rand(-0.4, 0.4), 0.8, k.z - cz * 2.6 + rand(-0.4, 0.4), -sx * 6 + rand(-1, 1), rand(0, 2), -cz * 6 + rand(-1, 1), k.nitroOn ? 0x4fc4ff : 0xff8a1f, 0.3);
    if (k.offroad && k.speed > 10 && Math.random() < 0.5) this.sparks.emit(bx, 0.3, bz, rand(-2, 2), rand(1, 4), rand(-2, 2), 0x8a6b3f, 0.5);
    if (k.starT > 0 && Math.random() < 0.6) this.sparks.emit(k.x + rand(-1.5, 1.5), rand(0.5, 2.5), k.z + rand(-1.5, 1.5), 0, rand(2, 5), 0, [0xff5f5f, 0xffe14d, 0x5fff8a, 0x5fb4ff][Math.floor(rand(4))], 0.5);
  }

  // ---------------------------------------------------------------- frame
  /** @param controls per-human input, indexed by player */
  update(dt, controls) {
    this.flash = Math.max(0, this.flash - dt);
    if (this.state === 'countdown') {
      const before = Math.ceil(this.countT);
      this.countT -= dt;
      if (Math.ceil(this.countT) !== before && this.countT > 0) this.events.push({ type: 'count' });
      if (this.countT <= 0) {
        this.state = 'racing';
        this.events.push({ type: 'go' });
      }
    } else {
      this.time += dt;
    }
    const live = this.state !== 'countdown';

    for (const k of this.karts) {
      let ctl = NO_INPUT;
      if (live) ctl = k.human >= 0 && !k.finished ? controls[k.human] ?? NO_INPUT : this.aiControl(k, dt);
      if (ctl.item) this.useItem(k);
      const lapBefore = k.lap;
      k.update(dt, ctl, this.track);
      if (k.lap > lapBefore && !k.finished) {
        if (k.lap > this.laps) {
          k.finished = true;
          k.finishTime = this.time;
          this.events.push({ type: 'finish', kart: k });
        } else if (k.lap === this.laps && k.lap > 1) {
          k.say('FINAL LAP!', 2);
          this.events.push({ type: 'lap', kart: k });
        } else if (k.lap > 1) {
          k.say(`LAP ${k.lap}`, 1.5);
          this.events.push({ type: 'lap', kart: k });
        }
      }
      this.emitEffects(k);
    }
    this.collide();
    this.updateItems(dt);
    this.updatePickups(dt);
    this.rank();
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.coreMat.emissive.setHSL((this.time * 0.35) % 1, 1, 0.55);
    for (const k of this.karts) k.syncMesh(dt, this.time);

    if (this.state === 'racing' && this.humans.every((h) => h.finished)) {
      this.state = 'finishing';
      this.endT = 2.5;
    }
    if (this.state === 'finishing' && (this.endT -= dt) <= 0) this.state = 'done';
  }

  /** Final standings rows. */
  results() {
    return this.order.map((k) => ({ place: k.place, name: k.name, human: k.human, time: k.finished ? k.finishTime : null, team: k.team }));
  }
}
