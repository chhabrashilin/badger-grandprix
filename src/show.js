// Race-day atmosphere: grandstands full of jumping fans, camera flashes,
// confetti, fireworks, lamp glows, a blimp and a trackside big screen.
// Everything here is instanced or point-based, so it costs a handful of draw calls.
import * as THREE from 'three';
import { bake } from './bake.js';
import { WALL } from './track.js';
import { tex, rand } from './util.js';

const SHIRTS = [0xc5050c, 0xc5050c, 0xc5050c, 0xffffff, 0xffffff, 0xe8343b, 0x23262d, 0xffd23f, 0x2d68c4, 0x2f9a3f];
const SKIN = [0xf1c9a5, 0xd9a47a, 0x8d5a3b, 0xf5d6ba, 0x6b4226];
const CONFETTI = [0xc5050c, 0xffffff, 0xffd23f, 0x4fc4ff, 0x5fff8a, 0xff6fae];
const pick = (list) => list[Math.floor(rand(list.length))];
const lam = (color, o = {}) => new THREE.MeshLambertMaterial({ color, ...o });

function softDot(inner = 0.25) {
  return tex(64, 64, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(inner, 'rgba(255,255,255,.75)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, w);
  });
}

export class Show {
  constructor(track) {
    this.track = track;
    this.group = new THREE.Group();
    this.time = { value: 0 };
    this.seats = []; // world-space fan positions, reused for camera flashes
    this.buildStands();
    this.buildFlashes();
    this.buildLampGlow();
    this.buildConfetti();
    this.buildBlimp();
    this.buildScreen();
    this.screenT = 0;
  }

  // ---------------------------------------------------------------- stands + fans
  buildStands() {
    const structure = new THREE.Group();
    const concrete = lam(0xc9cdd3);
    const steel = lam(0x3a3f49);
    const red = lam(0xc5050c);
    const bodyGeo = (() => {
      const parts = [new THREE.BoxGeometry(0.55, 0.8, 0.34).translate(0, 0.4, 0)];
      for (const s of [-1, 1]) parts.push(new THREE.BoxGeometry(0.13, 0.55, 0.13).rotateZ(s * -0.45).translate(s * 0.4, 1.0, 0));
      // merge by hand: all are indexed boxes with the same attributes
      const pos = [];
      const nor = [];
      for (const p of parts) {
        const n = p.toNonIndexed();
        pos.push(...n.attributes.position.array);
        nor.push(...n.attributes.normal.array);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      return g;
    })();
    const headGeo = new THREE.IcosahedronGeometry(0.23, 0).translate(0, 1.02, 0);

    // Fans bounce in the vertex shader: no per-frame CPU work at all.
    const cheer = (material) => {
      material.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = this.time;
        sh.vertexShader = 'uniform float uTime;\nattribute float aPhase;\n' + sh.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  transformed.y += abs(sin(uTime * 5.5 + aPhase)) * 0.32 * step(-0.2, sin(uTime * 0.6 + aPhase * 0.37));',
        );
      };
      return material;
    };
    const bodyMat = cheer(lam(0xffffff));
    const headMat = cheer(lam(0xffffff));

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const col = new THREE.Color();

    for (const st of this.track.stands) {
      const stand = new THREE.Group();
      stand.position.set(st.x, 0, st.z);
      stand.rotation.y = st.rot;
      const depth = st.rows * 2;
      const top = 1 + st.rows * 1.1;
      // Terraces (local +x points away from the track)
      for (let r = 0; r < st.rows; r++) {
        const h = 1 + r * 1.1;
        const step = new THREE.Mesh(new THREE.BoxGeometry(2, h, st.len), concrete);
        step.position.set(r * 2 + 1, h / 2, 0);
        step.castShadow = step.receiveShadow = true;
        stand.add(step);
      }
      const back = new THREE.Mesh(new THREE.BoxGeometry(1, top + 7, st.len), concrete);
      back.position.set(depth + 0.5, (top + 7) / 2, 0);
      const band = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3, st.len + 0.2), red);
      band.position.set(depth + 0.5, top + 3, 0);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(depth + 5, 0.7, st.len + 4), red);
      roof.position.set(depth / 2 - 0.5, top + 7.2, 0);
      roof.rotation.z = -0.07;
      back.castShadow = roof.castShadow = true;
      stand.add(back, band, roof);
      for (let z = -st.len / 2 + 2; z <= st.len / 2 - 2; z += (st.len - 4) / 3) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, top + 7, 0.5), steel);
        post.position.set(-0.6, (top + 7) / 2, z);
        stand.add(post);
      }
      const fence = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.3, st.len), steel);
      fence.position.set(-0.2, 1.4, 0);
      stand.add(fence);
      structure.add(stand);

      // Fans
      stand.updateMatrixWorld(true);
      const spots = [];
      for (let r = 0; r < st.rows; r++) {
        for (let z = -st.len / 2 + 1.2; z < st.len / 2 - 1; z += 1.7) {
          if (Math.random() < 0.22) continue; // thinner crowd: fewer instances, same cheer energy
          spots.push(v.set(r * 2 + 1 + rand(-0.3, 0.3), 1 + r * 1.1, z + rand(-0.3, 0.3)).applyMatrix4(stand.matrixWorld).clone());
        }
      }
      const phases = new Float32Array(spots.length);
      const bodies = new THREE.InstancedMesh(bodyGeo.clone(), bodyMat, spots.length);
      const heads = new THREE.InstancedMesh(headGeo.clone(), headMat, spots.length);
      q.setFromAxisAngle(up, st.rot + Math.PI / 2);
      spots.forEach((p, i) => {
        const s = rand(1.35, 1.7);
        m4.compose(p, q, sc.set(s, s, s));
        bodies.setMatrixAt(i, m4);
        heads.setMatrixAt(i, m4);
        bodies.setColorAt(i, col.setHex(pick(SHIRTS)));
        heads.setColorAt(i, col.setHex(pick(SKIN)));
        phases[i] = rand(100);
        this.seats.push(p.x, p.y + 1.6, p.z);
      });
      for (const mesh of [bodies, heads]) {
        mesh.geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
        mesh.computeBoundingSphere();
        mesh.boundingSphere.radius += 1;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
      }
    }
    this.group.add(bake(structure));
  }

  // ---------------------------------------------------------------- camera flashes
  buildFlashes() {
    const n = 44;
    this.flashPos = new Float32Array(n * 3).fill(-999);
    this.flashLife = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.flashPos, 3));
    const star = tex(64, 64, (c, w) => {
      const gr = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.18, 'rgba(255,255,255,.9)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gr;
      c.fillRect(0, 0, w, w);
      c.fillStyle = 'rgba(255,255,255,.9)';
      c.fillRect(0, w / 2 - 1.5, w, 3);
      c.fillRect(w / 2 - 1.5, 0, 3, w);
    });
    this.flashes = new THREE.Points(g, new THREE.PointsMaterial({
      map: star, size: 4.2, color: new THREE.Color(1.6, 1.7, 2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.flashes.frustumCulled = false;
    this.group.add(this.flashes);
  }

  // ---------------------------------------------------------------- lamp glows (cheap stand-in for bloom)
  buildLampGlow() {
    const t = this.track;
    const pos = [];
    for (let i = 0, k = 0; i < t.N; i += 26, k++) {
      const p = t.pointAt(i, (k % 2 ? 1 : -1) * WALL);
      pos.push(p.x, 9.55, p.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const glow = new THREE.Points(g, new THREE.PointsMaterial({
      map: softDot(0.2), size: 5, color: 0xffe9b0, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.group.add(glow);
  }

  // ---------------------------------------------------------------- confetti
  buildConfetti() {
    const n = 320;
    this.conf = { n, pos: new Float32Array(n * 3).fill(-999), vel: new Float32Array(n * 3), life: new Float32Array(n), next: 0, emit: 0, at: new THREE.Vector3() };
    const cols = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      c.setHex(pick(CONFETTI));
      cols.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.conf.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.confetti = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.42, vertexColors: true }));
    this.confetti.frustumCulled = false; // always drawn (parked off-screen) so its shader compiles during loading
    this.group.add(this.confetti);
  }

  /** Rain confetti around a point for `seconds`. */
  celebrate(x, z, seconds = 5) {
    this.conf.at.set(x, 0, z);
    this.conf.emit = seconds;
    this.conf.active = true;
  }

  // ---------------------------------------------------------------- blimp
  buildBlimp() {
    const b = new THREE.Group();
    const skin = lam(0xffffff, { map: tex(512, 128, (c, w, h) => {
      c.fillStyle = '#f4f4f1';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#c5050c';
      c.fillRect(0, 0, w, h * 0.22);
      c.fillRect(0, h * 0.78, w, h * 0.22);
      c.font = '400 50px "Dela Gothic One", Impact, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (const x of [0, w * 0.5, w]) c.fillText('BADGER GP', x, h / 2 + 3); // u = 0 and 0.5 are the two flanks
    }) });
    const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), skin);
    hull.scale.set(8, 8, 24);
    b.add(hull);
    const red = lam(0xc5050c);
    for (const r of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 7), red);
      fin.position.set(Math.sin(r) * 6, Math.cos(r) * 6, -19);
      fin.rotation.z = -r;
      b.add(fin);
    }
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 2.4, 8), lam(0x2a2d35));
    cabin.position.y = -8.6;
    b.add(cabin);
    b.userData.dynamic = true;
    this.blimp = b;
    this.group.add(b);
  }

  // ---------------------------------------------------------------- big screen
  buildScreen() {
    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = 512;
    this.screenCanvas.height = 256;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Group();
    const frame = lam(0x1a1c22);
    const body = new THREE.Mesh(new THREE.BoxGeometry(25, 13.5, 1.2), frame);
    body.position.y = 13;
    body.castShadow = true;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(23.4, 11.9), new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }));
    face.position.set(0, 13, 0.65);
    s.add(body, face);
    for (const x of [-9, 9]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1, 7, 1), frame);
      leg.position.set(x, 3.5, 0);
      s.add(leg);
    }
    s.position.set(-27, 0, -18);
    s.rotation.y = 2.25; // angled towards drivers coming down the start straight
    this.group.add(s);
    this.drawScreen(null);
  }

  drawScreen(race) {
    const c = this.screenCanvas.getContext('2d');
    const w = 512;
    const h = 256;
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#16233f');
    g.addColorStop(1, '#0a0f1c');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#c5050c';
    c.fillRect(0, 0, w, 46);
    c.fillStyle = '#fff';
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.font = '400 26px "Dela Gothic One", Impact, sans-serif';
    if (!race) {
      c.fillText('BADGER GRAND PRIX', 16, 24);
      c.font = '400 54px "Dela Gothic One", Impact, sans-serif';
      c.textAlign = 'center';
      c.fillStyle = '#ffd23f';
      c.fillText('RACE DAY', w / 2, 120);
      c.fillStyle = '#fff';
      c.font = '900 20px "Zen Kaku Gothic New", sans-serif';
      c.fillText('MADISON CIRCUIT', w / 2, 190);
    } else {
      const lead = race.order[0];
      c.fillText(race.state === 'countdown' ? 'STARTING GRID' : `LAP ${Math.min(Math.max(lead.lap, 1), race.laps)} / ${race.laps}`, 16, 24);
      race.order.slice(0, 4).forEach((k, i) => {
        const y = 78 + i * 46;
        c.fillStyle = k.human >= 0 ? '#c5050c' : 'rgba(255,255,255,.08)';
        c.fillRect(12, y - 19, w - 24, 38);
        c.fillStyle = '#ffd23f';
        c.font = '400 26px "Dela Gothic One", Impact, sans-serif';
        c.fillText(String(i + 1), 24, y + 1);
        c.fillStyle = '#fff';
        c.font = '900 22px "Zen Kaku Gothic New", sans-serif';
        c.fillText(k.name.toUpperCase().slice(0, 24), 64, y + 1);
      });
    }
    this.screenTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- per frame
  update(t, dt, race) {
    this.time.value = t;

    // Camera flashes: a few seats light up for a split second
    const seats = this.seats.length / 3;
    for (let i = 0; i < this.flashLife.length; i++) {
      if (this.flashLife[i] > 0) {
        if ((this.flashLife[i] -= dt) <= 0) this.flashPos[i * 3 + 1] = -999;
      } else if (seats && Math.random() < dt * 0.55) {
        const s = Math.floor(rand(seats)) * 3;
        this.flashPos.set([this.seats[s], this.seats[s + 1], this.seats[s + 2]], i * 3);
        this.flashLife[i] = rand(0.05, 0.12);
      }
    }
    this.flashes.geometry.attributes.position.needsUpdate = true;

    // Confetti
    const cf = this.conf;
    if (cf.active) {
      if (cf.emit > 0) {
        cf.emit -= dt;
        for (let k = 0; k < 3; k++) {
          const i = (cf.next = (cf.next + 1) % cf.n);
          cf.pos.set([cf.at.x + rand(-17, 17), rand(11, 15), cf.at.z + rand(-7, 7)], i * 3);
          cf.vel.set([rand(-1.5, 1.5), rand(-1, 0.5), rand(-1.5, 1.5)], i * 3);
          cf.life[i] = 5;
        }
      }
      let alive = cf.emit > 0;
      for (let i = 0; i < cf.n; i++) {
        if (cf.life[i] <= 0) continue;
        alive = true;
        const j = i * 3;
        cf.life[i] -= dt;
        cf.vel[j + 1] = Math.max(-3.2, cf.vel[j + 1] - 4 * dt);
        cf.pos[j] += (cf.vel[j] + Math.sin(t * 5 + i) * 1.2) * dt;
        cf.pos[j + 1] += cf.vel[j + 1] * dt;
        cf.pos[j + 2] += (cf.vel[j + 2] + Math.cos(t * 4 + i) * 1.2) * dt;
        if (cf.life[i] <= 0 || cf.pos[j + 1] < 0.05) {
          cf.life[i] = 0;
          cf.pos[j + 1] = -999;
        }
      }
      this.confetti.geometry.attributes.position.needsUpdate = true;
      cf.active = alive;
    }

    // Blimp circles the circuit
    const a = t * 0.035;
    this.blimp.position.set(110 + Math.cos(a) * 270, 135 + Math.sin(t * 0.3) * 4, Math.sin(a) * 300);
    this.blimp.rotation.y = Math.atan2(-Math.sin(a) * 270, Math.cos(a) * 300);

    // Big screen refreshes twice a second
    if ((this.screenT -= dt) <= 0) {
      this.screenT = 0.5;
      this.drawScreen(race);
    }
  }
}
