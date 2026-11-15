// Badger Grand Prix: menus, render loop, split-screen cameras and HUD.
import * as THREE from 'three';
import { Track } from './track.js';
import { createGfx } from './gfx.js';
import { Show } from './show.js';
import { Race, rivalCount } from './race.js';
import { BASE } from './kart.js';
import { BADGERS, KARTS, PERKS, ITEMS } from './teams.js';
import { fetchSeasonData, pickField, emptySeason } from './rankings.js';
import * as input from './input.js';
import * as audio from './audio.js';
import { clamp, wrap, ordinal, formatTime } from './util.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ------------------------------------------------------------------ scene
const glCanvas = $('gl');
const hudCanvas = $('hud');
const hud = hudCanvas.getContext('2d');
const t0 = performance.now();
const gfx = createGfx(glCanvas);
const { scene } = gfx;

const track = new Track();
scene.add(track.build());
const raceShow = new Show(track);
scene.add(raceShow.group);
if (params.has('stats')) console.log(`STATS world built at ${Math.round(performance.now())}ms (gfx+track ${Math.round(performance.now() - t0)}ms)`);

const cameras = [0, 1, 2, 3].map((i) => {
  const c = new THREE.PerspectiveCamera(70, 1, 0.5, 5000);
  c.userData.h = 0;
  c.layers.enableAll();
  c.layers.disable(i + 1); // hide this player's own name tag
  return c;
});

// ------------------------------------------------------------------ state
const cfg = { nPlayers: 1, difficulty: 'normal', laps: 3, players: [], field: [] };
let season = emptySeason();
const seasonReady = fetchSeasonData().then((s) => (season = s));
let race = null;
let paused = false;
let demo = false;
let prevItem = [false, false, false, false];
let W = 1;
let H = 1;

function resize() {
  W = innerWidth;
  H = innerHeight;
  gfx.resize(W, H);
  const dpr = Math.min(devicePixelRatio, 1.5);
  hudCanvas.width = W * dpr;
  hudCanvas.height = H * dpr;
  hud.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
const startQuality = params.get('q') ?? 'auto';
for (const [flag, key] of [['noshadow', 'shadows'], ['nobloom', 'bloom'], ['noenv', 'env'], ['nomsaa', 'msaa']]) {
  if (params.has(flag)) gfx.overrides[key] = key === 'shadows' || key === 'msaa' ? 0 : false; // debug: measure one effect's cost
}
gfx.W = innerWidth;
gfx.H = innerHeight;
if (params.has('scale')) gfx.scale = +params.get('scale'); // debug: fixed render scale
gfx.setQuality(startQuality);
resize();
for (const b of $('quality').children) b.classList.toggle('on', b.dataset.v === startQuality);

// ------------------------------------------------------------------ menus
function show(id) {
  for (const s of ['title', 'setup', 'results']) $(s).classList.toggle('hidden', s !== id);
  $('touch').classList.toggle('hidden', !(id === null && input.isTouchDevice() && cfg.nPlayers === 1));
  $('vignette').classList.toggle('hidden', id !== null);
}

function segmented(id, onPick) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const o of $(id).children) o.classList.toggle('on', o === b);
    audio.sfx('click');
    onPick(b.dataset.v);
  });
}
segmented('players', (v) => (cfg.nPlayers = +v));
segmented('difficulty', (v) => (cfg.difficulty = v));
segmented('laps', (v) => (cfg.laps = +v));
segmented('quality', (v) => gfx.setQuality(v));

$('controlsHint').innerHTML = input.isTouchDevice()
  ? '<b>Phone:</b> tilt to steer (enable on the next screen), it accelerates for you. Buttons: ITEM, BOOST, DRIFT, BRAKE.'
  : '<b>Solo:</b> WASD / arrows · Shift drift · E boost · Space item<br>' +
    '<b>P1:</b> WASD · L-Shift · E · Q &nbsp; <b>P2:</b> arrows · R-Shift · / · Enter<br>' +
    '<b>Gamepad</b> (P1–P4): stick · RT gas · LT brake · RB drift · X item · Y boost<br>' +
    'Esc pause · M mute';

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

function defaultPlayers() {
  cfg.players = Array.from({ length: cfg.nPlayers }, (_, i) => cfg.players[i] ?? { badger: BADGERS[i % BADGERS.length], kart: KARTS[i % KARTS.length], perk: PERKS.filter((o) => o.key !== 'pocket')[i % 3], startingItem: 'cone' });
  // Only one Bucky allowed.
  let seen = false;
  for (const p of cfg.players) {
    if (p.badger.unique) {
      if (seen) p.badger = BADGERS.find((b) => !b.unique && !cfg.players.some((q) => q.badger === b)) ?? BADGERS[1];
      seen = true;
    }
  }
}

let setupStep = 0;
const itemHelp = {
  cone: 'A short burst of speed.', shield: 'Blocks one hit.',
  curd: 'Throw it at the kart ahead.', football: 'Chases the racer ahead.',
  slick: 'Drop it behind you.', boombox: 'Seven seconds of invincibility.',
  blizzard: 'Slows racers ahead of you.',
};

function renderCards() {
  $('setupTitle').textContent = setupStep === 0 ? 'PICK YOUR RACER' : 'PICK YOUR POWER-UP';
  $('setupSteps').textContent = setupStep === 0 ? '1 / 2  RACER + KART' : '2 / 2  STARTING POWER-UP';
  $('start').textContent = setupStep === 0 ? 'NEXT: POWER-UPS' : 'START RACE';
  $('cards').innerHTML = cfg.players.map((p, i) => {
    const options = (list, key, selected) => list.map((o) => {
      const locked = key === 'badger' && o.unique && cfg.players.some((q) => q !== p && q.badger.unique);
      return `<button class="pick ${o === selected ? 'selected' : ''}" data-p="${i}" data-k="${key}" data-value="${o.key}" aria-pressed="${o === selected}" ${locked ? 'disabled' : ''}>
        ${o === selected ? '<small>Selected</small>' : ''}
        <b>${o.look ? `<span class="sw" style="background:${hex(o.look.c1)}"></span>` : ''}${o.name}</b>
        <i>${locked ? 'Taken by another player' : o.desc ?? (o.unique ? 'Wisconsin’s own.' : 'Ready to race.')}</i></button>`;
    }).join('');
    return `<div class="card"><h4>PLAYER ${i + 1}</h4>${setupStep === 0
      ? `<h3>Character</h3><div class="choice-grid">${options(BADGERS, 'badger', p.badger)}</div><h3>Kart</h3>${options(KARTS, 'kart', p.kart)}`
      : `<p class="racer-summary">${p.badger.name} · ${p.kart.name}</p><p class="tag" style="margin:0 0 12px">Start with one item. Grab ? boxes on track for more.</p>
        <div class="choice-grid">${Object.entries(ITEMS).map(([key, item]) => `<button class="pick ${p.startingItem === key ? 'selected' : ''}" data-p="${i}" data-k="startingItem" data-value="${key}" aria-pressed="${p.startingItem === key}">${p.startingItem === key ? '<small>Selected</small>' : ''}<b><span class="item-icon">${item.icon}</span>${item.name}</b><i>${itemHelp[key]}</i></button>`).join('')}</div>
        <h3>Bonus</h3>${options(PERKS.filter((o) => o.key !== 'pocket'), 'perk', p.perk)}`}</div>`;
  }).join('');
}

$('cards').addEventListener('click', (e) => {
  const b = e.target.closest('.pick');
  if (!b || b.disabled) return;
  const p = cfg.players[+b.dataset.p];
  const key = b.dataset.k;
  if (key === 'startingItem') p.startingItem = b.dataset.value;
  else {
    const list = key === 'badger' ? BADGERS : key === 'kart' ? KARTS : PERKS;
    p[key] = list.find((o) => o.key === b.dataset.value);
  }
  audio.sfx('click');
  renderCards();
  $('cards').querySelector(`[data-p="${b.dataset.p}"][data-k="${key}"][data-value="${b.dataset.value}"]`)?.focus();
});

function rollField() {
  cfg.field = pickField(rivalCount(cfg.nPlayers), season);
  $('pollNote').textContent = season.ok ? `· live ${season.poll}` : '· live rankings unavailable';
  $('field').innerHTML = cfg.field.map((f) => `
    <li><span class="sw" style="background:${hex(f.team.look.c1)}"></span>
      <span class="n">${f.team.school} <span style="opacity:.6">${f.team.mascot}</span></span>
      ${f.badges.map((b) => `<span class="badge ${b.kind}">${b.text}</span>`).join('')}</li>`).join('');
}

$('toSetup').addEventListener('click', async () => {
  audio.initAudio();
  audio.sfx('click');
  await Promise.race([seasonReady, new Promise((r) => setTimeout(r, 4000))]);
  defaultPlayers();
  setupStep = 0;
  renderCards();
  rollField();
  $('tiltBtn').classList.toggle('hidden', !(input.isTouchDevice() && cfg.nPlayers === 1) || input.tiltEnabled());
  show('setup');
});
$('reroll').addEventListener('click', rollField);
$('back').addEventListener('click', () => {
  if (setupStep > 0) { setupStep = 0; renderCards(); }
  else show('title');
});
$('tiltBtn').addEventListener('click', async () => {
  const ok = await input.enableTilt();
  $('tiltBtn').textContent = ok ? '📱 Tilt steering on' : '📱 Tilt unavailable (needs HTTPS + permission)';
  $('tiltBtn').disabled = true;
});
$('start').addEventListener('click', () => {
  if (setupStep === 0) { setupStep = 1; renderCards(); $('setup').scrollTop = 0; }
  else startRace();
});
$('again').addEventListener('click', startRace);
$('menu').addEventListener('click', () => {
  endRace();
  show('title');
});

function endRace() {
  if (race) scene.remove(race.group);
  race = null;
  audio.stopMusic();
  audio.setEngine(0, false, false);
}

function startRace() {
  endRace();
  audio.initAudio();
  audio.startMusic();
  race = new Race(track, cfg);
  scene.add(race.group);
  paused = false;
  for (const [i, k] of race.humans.entries()) cameras[i].userData.h = k.heading;
  // Compile the race shaders now (including effects that start hidden) so nothing hitches mid-race.
  const hidden = race.karts.flatMap((k) => [k.model.flame, k.model.shield]);
  for (const o of hidden) o.visible = true;
  cameras[0].position.set(race.humans[0].x, 30, race.humans[0].z - 40);
  cameras[0].lookAt(race.humans[0].x, 0, race.humans[0].z);
  gfx.warmUp([{ rect: [0, 0, W, H], camera: cameras[0], focus: race.humans[0], range: 60 }]);
  for (const o of hidden) o.visible = false;
  show(null);
}

function showResults() {
  const rows = race.results();
  const best = rows.find((r) => r.human >= 0);
  $('resultTitle').textContent = best.place === 1
    ? `🏆 ${best.name.toUpperCase()} WINS!`
    : cfg.nPlayers === 1 ? `You finished ${ordinal(best.place)}` : `${best.name} leads the badgers in ${ordinal(best.place)}`;
  $('standings').innerHTML = rows.map((r) => `
    <li class="${r.human >= 0 ? 'me' : ''}" style="--i:${r.place}"><b>${ordinal(r.place)}</b><span>${r.name}</span><span>${r.time === null ? '—' : formatTime(r.time)}</span></li>`).join('');
  audio.setEngine(0, false, false);
  show('results');
}

addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') audio.toggleMute();
  if (e.code === 'Escape' && race && race.state !== 'done') paused = !paused;
});

// ------------------------------------------------------------------ views
function views(n) {
  if (n === 1) return [[0, 0, W, H]];
  if (n === 2) return W >= H ? [[0, 0, W / 2, H], [W / 2, 0, W / 2, H]] : [[0, 0, W, H / 2], [0, H / 2, W, H / 2]];
  const w = W / 2;
  const h = H / 2;
  return [[0, 0, w, h], [w, 0, w, h], [0, h, w, h], [w, h, w, h]].slice(0, n);
}

function chase(cam, k, dt) {
  const u = cam.userData;
  u.h += wrap(k.heading - u.h) * Math.min(1, 7 * dt);
  u.pull = (u.pull ?? 0) + ((k.boosting ? 1.8 : 0) - (u.pull ?? 0)) * Math.min(1, 4 * dt);
  const sx = Math.sin(u.h);
  const cz = Math.cos(u.h);
  const dist = 7.6 + u.pull;
  // Small shake at speed / under boost, a bigger kick when spun out.
  const shake = (k.boosting ? 0.05 : 0) + (k.spinT > 0 ? 0.12 : 0) + (k.offroad && k.speed > 10 ? 0.04 : 0);
  cam.position.set(
    k.x - sx * dist + (Math.random() - 0.5) * shake,
    3.5 + k.y * 0.6 + (Math.random() - 0.5) * shake,
    k.z - cz * dist + (Math.random() - 0.5) * shake,
  );
  cam.lookAt(k.x + sx * 9, 1.5 + k.y * 0.5, k.z + cz * 9);
  if (params.has('front')) {
    // Debug/photo view: look back at the kart from the front.
    cam.position.set(k.x + sx * 5 + cz * 2.2, 2.3, k.z + cz * 5 - sx * 2.2);
    cam.lookAt(k.x, 1.5, k.z);
  }
  const fov = 68 + clamp(k.speed / BASE.max, 0, 1.4) * 9 + u.pull * 6;
  cam.fov += (fov - cam.fov) * Math.min(1, 5 * dt);
}

// ------------------------------------------------------------------ HUD
const FONT = '"Rowdies", "Impact", sans-serif';
const UI_FONT = '"M PLUS Rounded 1c", "Segoe UI", sans-serif';
const PLACE_GRAD = [['#fff3a8', '#ffb400'], ['#ffffff', '#aab6c4'], ['#ffd2a6', '#c9742e']];
const mapPts = (() => {
  const b = track.bounds;
  const pts = [];
  for (let i = 0; i < track.N; i += 4) pts.push([b.maxX - track.px[i], b.maxZ - track.pz[i]]);
  return { pts, w: b.maxX - b.minX, h: b.maxZ - b.minZ };
})();

function text(str, x, y, size, color = '#fff', align = 'left', display = true) {
  hud.font = `${display ? 700 : 800} ${size}px ${display ? FONT : UI_FONT}`;
  hud.textAlign = align;
  hud.textBaseline = 'middle';
  hud.lineWidth = Math.max(3, size * 0.16);
  hud.strokeStyle = 'rgba(6,8,14,.85)';
  hud.lineJoin = 'round';
  hud.strokeText(str, x, y);
  hud.fillStyle = color;
  hud.fillText(str, x, y);
}

/** Skewed dark plate with a coloured leading edge. */
function plate(x, y, w, h, accent = '#e01018', fill = 'rgba(8,10,16,.66)') {
  const k = h * 0.22;
  hud.beginPath();
  hud.moveTo(x + k, y);
  hud.lineTo(x + w + k, y);
  hud.lineTo(x + w, y + h);
  hud.lineTo(x, y + h);
  hud.closePath();
  hud.fillStyle = fill;
  hud.fill();
  hud.beginPath();
  hud.moveTo(x + k, y);
  hud.lineTo(x + k + 5, y);
  hud.lineTo(x + 5, y + h);
  hud.lineTo(x, y + h);
  hud.closePath();
  hud.fillStyle = accent;
  hud.fill();
}

function drawHud([vx, vy, vw, vh], k, now) {
  const touchUi = !$('touch').classList.contains('hidden');
  const liftL = touchUi ? 96 : 0;
  const liftR = touchUi ? 190 : 0;
  const u = clamp(Math.min(vw, vh) / 640, 0.5, 1.5);
  const pad = 18 * u;
  hud.save();
  hud.beginPath();
  hud.rect(vx, vy, vw, vh);
  hud.clip();
  hud.translate(vx, vy);

  // Boost speed lines + vignette
  if (k.boosting) {
    hud.strokeStyle = 'rgba(255,255,255,.3)';
    hud.lineWidth = 2;
    for (let i = 0; i < 30; i++) {
      const a = (i * 2.399 + now * 3) % (Math.PI * 2);
      const r0 = Math.max(vw, vh) * (0.33 + ((i * 37 + now * 500) % 100) / 480);
      hud.beginPath();
      hud.moveTo(vw / 2 + Math.cos(a) * r0, vh / 2 + Math.sin(a) * r0);
      hud.lineTo(vw / 2 + Math.cos(a) * (r0 + 90 * u), vh / 2 + Math.sin(a) * (r0 + 90 * u));
      hud.stroke();
    }
  }
  if (k.slowT > 0) {
    hud.fillStyle = 'rgba(120,190,255,.16)';
    hud.fillRect(0, 0, vw, vh);
  }
  if (race.flash > 0) {
    hud.fillStyle = `rgba(210,235,255,${Math.min(0.6, race.flash)})`;
    hud.fillRect(0, 0, vw, vh);
  }

  // Lap + time (top-left)
  plate(pad, pad, 150 * u, 44 * u);
  text('LAP', pad + 24 * u, pad + 23 * u, 13 * u, '#ff9aa0', 'left', false);
  text(`${clamp(k.lap, 1, race.laps)}`, pad + 66 * u, pad + 22 * u, 30 * u);
  text(`/${race.laps}`, pad + 90 * u, pad + 25 * u, 18 * u, '#c9d2dd');
  plate(pad - 8 * u, pad + 50 * u, 132 * u, 28 * u, '#ffd23f');
  text(formatTime(k.finished ? k.finishTime : race.time), pad + 12 * u, pad + 65 * u, 16 * u, '#fff', 'left', false);

  // Live standings (left)
  if (vh > 430 && vw > 520) {
    const rh = 23 * u;
    race.order.forEach((o, i) => {
      const y = pad + 96 * u + i * (rh + 3 * u);
      const me = o === k;
      plate(pad - 8 * u - i * 0, y, (me ? 128 : 112) * u, rh, me ? '#fff' : o.human >= 0 ? '#ff9aa0' : hex(o.look.c1), me ? 'rgba(210,12,22,.88)' : 'rgba(8,10,16,.55)');
      text(String(i + 1), pad + 20 * u, y + rh / 2 + 1, 13 * u, me ? '#fff' : '#ffd23f', 'center', false);
      text(o.tag ?? (o.human >= 0 ? 'YOU' : o.name), pad + 36 * u, y + rh / 2 + 1, 12.5 * u, '#fff', 'left', false);
    });
  }

  // Item slot (top-centre)
  const ir = 33 * u;
  const ix = vw / 2;
  const iy = pad + ir;
  hud.beginPath();
  hud.arc(ix, iy, ir, 0, 7);
  const ig = hud.createRadialGradient(ix, iy - ir * 0.4, 2, ix, iy, ir);
  ig.addColorStop(0, 'rgba(60,70,95,.6)');
  ig.addColorStop(1, 'rgba(8,10,16,.55)');
  hud.fillStyle = ig;
  hud.fill();
  hud.lineWidth = 4 * u;
  hud.strokeStyle = k.item ? '#ffd23f' : k.rolling ? '#6fd8ff' : 'rgba(255,255,255,.35)';
  hud.stroke();
  const keys = Object.keys(ITEMS);
  const icon = k.rolling ? ITEMS[keys[Math.floor(now * 14) % keys.length]].icon : k.item ? ITEMS[k.item].icon : '';
  hud.fillStyle = '#fff';
  hud.textAlign = 'center';
  hud.textBaseline = 'middle';
  if (icon) {
    hud.font = `${38 * u}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
    hud.fillText(icon, ix, iy + 2 * u);
  }
  const status = (k.shield ? '🛡️' : '') + (k.starT > 0 ? '📻' : '') + (k.slowT > 0 ? '❄️' : '');
  if (status) {
    hud.font = `${22 * u}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
    hud.textAlign = 'left';
    hud.fillText(status, ix + ir + 10 * u, iy);
  }

  const itemKey = touchUi ? 'ITEM' : k.human === 1 ? 'ENTER / X' : k.human > 1 ? 'X' : cfg.nPlayers === 1 ? 'SPACE / X' : 'Q / X';
  text(k.item ? `${itemKey}: ${ITEMS[k.item].name.toUpperCase()}` : k.rolling ? 'PICKING ITEM...' : 'GRAB A ? BOX', ix, iy + ir + 18 * u, 14 * u, '#fff', 'center', false);

  // Minimap (top-right)
  const ms = 128 * u;
  const sc = ms / Math.max(mapPts.w, mapPts.h);
  const mw = mapPts.w * sc;
  const mx = vw - pad - mw - 8 * u;
  const my = pad + 8 * u;
  hud.fillStyle = 'rgba(8,10,16,.5)';
  hud.beginPath();
  hud.roundRect(mx - 12 * u, my - 12 * u, mw + 24 * u, ms + 24 * u, 14 * u);
  hud.fill();
  hud.beginPath();
  mapPts.pts.forEach(([x, z], i) => (i ? hud.lineTo(mx + x * sc, my + z * sc) : hud.moveTo(mx + x * sc, my + z * sc)));
  hud.closePath();
  hud.lineJoin = 'round';
  hud.strokeStyle = 'rgba(0,0,0,.7)';
  hud.lineWidth = 8 * u;
  hud.stroke();
  hud.strokeStyle = '#f2f4f8';
  hud.lineWidth = 3.5 * u;
  hud.stroke();
  for (const o of [...race.karts].sort((a, b) => (a === k) - (b === k))) {
    hud.beginPath();
    hud.arc(mx + (track.bounds.maxX - o.x) * sc, my + (track.bounds.maxZ - o.z) * sc, (o === k ? 5.5 : 3.6) * u, 0, 7);
    hud.fillStyle = o === k ? '#ff2a33' : o.human >= 0 ? '#ff9aa0' : hex(o.look.c2 === 0xffffff ? o.look.c1 : o.look.c2);
    hud.fill();
    hud.strokeStyle = o === k ? '#fff' : '#000';
    hud.lineWidth = o === k ? 2 : 1;
    hud.stroke();
  }

  // Place (bottom-left)
  const ord = ordinal(k.place);
  const py = vh - pad - 46 * u - liftL;
  const [c0, c1] = PLACE_GRAD[k.place - 1] ?? ['#ffffff', '#cfd6e0'];
  const pg = hud.createLinearGradient(0, py - 50 * u, 0, py + 50 * u);
  pg.addColorStop(0, c0);
  pg.addColorStop(1, c1);
  text(ord.slice(0, -2), pad + 4 * u, py, 104 * u, pg);
  const nw = hud.measureText(ord.slice(0, -2)).width;
  text(ord.slice(-2).toUpperCase(), pad + nw + 12 * u, py - 22 * u, 30 * u, pg);
  text(`/${race.karts.length}`, pad + nw + 12 * u, py + 18 * u, 22 * u, '#c9d2dd');

  // Speed + nitro gauge (bottom-right)
  const gr = 62 * u;
  const gx = vw - pad - gr - 6 * u;
  const gy = vh - pad - gr - 2 * u - liftR;
  const A0 = Math.PI * 0.75;
  const SWEEP = Math.PI * 1.5;
  hud.beginPath();
  hud.arc(gx, gy, gr + 8 * u, 0, 7);
  hud.fillStyle = 'rgba(8,10,16,.6)';
  hud.fill();
  hud.lineCap = 'round';
  const arc = (r, frac, width, style) => {
    hud.beginPath();
    hud.arc(gx, gy, r, A0, A0 + SWEEP * clamp(frac, 0.001, 1));
    hud.lineWidth = width;
    hud.strokeStyle = style;
    hud.stroke();
  };
  arc(gr, 1, 9 * u, 'rgba(255,255,255,.14)');
  const sg = hud.createLinearGradient(gx - gr, 0, gx + gr, 0);
  sg.addColorStop(0, k.boosting ? '#6fd8ff' : '#ffd23f');
  sg.addColorStop(1, k.boosting ? '#ff5fd0' : '#ff3b30');
  arc(gr, Math.abs(k.speed) / (BASE.max * 1.45), 9 * u, sg);
  arc(gr - 14 * u, 1, 5 * u, 'rgba(255,255,255,.12)');
  arc(gr - 14 * u, k.nitro, 5 * u, k.nitroOn ? '#c8f3ff' : k.nitro > 0.15 ? '#39b8ff' : '#5a7088');
  hud.lineCap = 'butt';
  text(String(Math.round(Math.abs(k.speed) * 3.4)), gx, gy - 4 * u, 38 * u, k.boosting ? '#aee9ff' : '#fff', 'center');
  text('KM/H', gx, gy + 22 * u, 11 * u, '#c9d2dd', 'center', false);
  text('BOOST', gx, gy + 44 * u, 10 * u, k.nitro > 0.15 ? '#6fd8ff' : '#7f8ea0', 'center', false);

  // A readable, continuously refilling boost meter, separate from speed.
  const bw = Math.min(260 * u, vw * 0.44);
  const bx = (vw - bw) / 2;
  const by = touchUi ? 155 * u : vh - 60 * u;
  const ready = k.nitro > 0.15;
  const boostKey = touchUi ? 'BOOST' : k.human === 1 ? '/ or Y' : k.human > 1 ? 'Y' : 'E or Y';
  hud.fillStyle = 'rgba(5,8,16,.9)';
  hud.fillRect(bx - 10 * u, by - 24 * u, bw + 20 * u, 76 * u);
  text(k.boosting ? 'BOOSTING!' : ready ? `HOLD ${boostKey} TO BOOST` : 'BOOST RECHARGING', vw / 2, by - 11 * u, 17 * u, ready ? '#65e4ff' : '#fff', 'center', false);
  hud.fillStyle = '#273449';
  hud.fillRect(bx, by + 4 * u, bw, 17 * u);
  hud.fillStyle = k.boosting ? '#fff27a' : '#31caff';
  hud.fillRect(bx, by + 4 * u, bw * k.nitro, 17 * u);
  hud.fillStyle = '#0b1527';
  for (let i = 1; i < 10; i++) hud.fillRect(bx + bw * i / 10, by + 4 * u, 2 * u, 17 * u);
  text(`${Math.round(k.nitro * 100)}%  /  DRIFT TO CHARGE FASTER`, vw / 2, by + 37 * u, 12 * u, '#fff', 'center', false);
  if (race.time < 8 && race.state === 'racing') text('GOLD ARROWS = FREE SPEED BOOST', vw / 2, vh * 0.72, 20 * u, '#ffe366', 'center', false);

  // Centre messages
  const cy = vh * 0.33;
  if (race.state === 'countdown') {
    const n = Math.ceil(race.countT);
    if (n <= 3) {
      const pop = 1 + (race.countT - Math.floor(race.countT)) * 0.35;
      text(String(n), vw / 2, cy, 140 * u * pop, '#ffd23f', 'center');
    } else text('GET READY', vw / 2, cy, 50 * u, '#fff', 'center');
  } else if (race.time < 1) {
    text('GO!', vw / 2, cy, 150 * u, '#5fff8a', 'center');
  } else if (k.finished) {
    text('FINISH!', vw / 2, cy - 34 * u, 78 * u, '#ffd23f', 'center');
    text(ordinal(k.place).toUpperCase() + ' PLACE', vw / 2, cy + 36 * u, 40 * u, '#fff', 'center');
  } else if (k.msg) {
    text(k.msg.text.toUpperCase(), vw / 2, cy, 46 * u, '#fff', 'center');
  } else {
    const facing = Math.cos(k.heading - track.headingAt(k.idx));
    if (facing < -0.3 && Math.abs(k.speed) > 4) text('WRONG WAY', vw / 2, cy, 52 * u, '#ff4d55', 'center');
  }
  hud.restore();
}

// ------------------------------------------------------------------ loop
function readControls() {
  return race.humans.map((k, i) => {
    if (demo) return race.aiControl(k, 1 / 60);
    const c = input.readPlayer(i, cfg.nPlayers);
    const pressed = c.item && !prevItem[i];
    prevItem[i] = c.item;
    return { ...c, item: pressed };
  });
}

function playEvents() {
  for (const e of race.events) {
    if (e.type === 'go') raceShow.celebrate(track.px[0], track.pz[0], 4);
    if (e.type === 'finish' && e.kart.human >= 0) {
      raceShow.celebrate(track.px[0], track.pz[0], 8);
      // fireworks over the start straight
      for (let b = 0; b < 5; b++) {
        const fx = track.px[0] + (Math.random() - 0.5) * 60;
        const fy = 26 + Math.random() * 22;
        const fz = track.pz[0] + 20 + Math.random() * 90;
        const c = [0xff4d55, 0xffd23f, 0x5fb4ff, 0x5fff8a, 0xff6fae][b];
        for (let i = 0; i < 26; i++) {
          const a = Math.random() * 6.28;
          const up = Math.random() * 2 - 0.4;
          race.sparks.emit(fx, fy, fz, Math.cos(a) * 14, up * 14, Math.sin(a) * 14, c, 1.3);
        }
      }
    }
    if (e.type === 'count' || e.type === 'go') audio.sfx(e.type);
    else if (e.kart?.human >= 0) audio.sfx(e.type);
  }
  race.events.length = 0;
}

// Frame-time tracking: drives the automatic resolution/quality scaling. ?stats=N logs every N frames.
const perf = {
  prev: 0, sum: 0, n: 0, frames: 0, worst: 0, avg: 16.7, calls: 0, tris: 0,
  window: +params.get('stats') || 45,
  tick(t) {
    gfx.renderer.info.reset();
    const d = this.prev ? t - this.prev : 0;
    this.prev = t;
    if (!d) return;
    this.frames++;
    this.worst = Math.max(this.worst, d);
    if (d < 120) { // ignore one-off stalls (tab switches, shader compiles)
      this.sum += d;
      this.n++;
    }
    if (this.frames < this.window) return;
    if (this.n > this.window / 2) {
      this.avg = this.sum / this.n;
      if (!paused && !document.hidden && !params.has('noadapt')) gfx.adapt(this.avg, this.worst, !race || race.state === 'countdown');
    }
    if (params.has('stats')) {
      console.log(`STATS avg ${this.avg.toFixed(1)}ms worst ${this.worst.toFixed(0)}ms calls ${this.calls} tris ${this.tris} scale ${gfx.scale.toFixed(2)} q ${gfx.qualityName} | js: sim ${(this.sim ?? 0).toFixed(1)} render-submit ${(this.draw ?? 0).toFixed(1)} hud ${(this.hud ?? 0).toFixed(1)}ms`);
    }
    this.sum = this.n = this.frames = this.worst = 0;
  },
  end() {
    this.calls = gfx.renderer.info.render.calls;
    this.tris = gfx.renderer.info.render.triangles;
  },
};

let last = performance.now();
let frameNo = 0;
function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = clamp((nowMs - last) / 1000, 0, 0.05); // rAF time can precede `last` on the first frame
  last = nowMs;
  const now = nowMs / 1000;
  perf.tick(nowMs);
  frameNo++;
  const drawUi = frameNo % 2 === 0 || paused; // the 2D overlay is redrawn every other frame
  if (drawUi) hud.clearRect(0, 0, W, H);
  track.animate(now);
  raceShow.update(now, dt, race);
  track.fakeShadows.visible = !gfx.shadowsOn;

  if (!race) {
    // Attract mode: a slow cinematic orbit over the circuit behind the menus.
    const cam = cameras[0];
    const a = now * 0.06;
    cam.position.set(105 + Math.cos(a) * 250, 46 + Math.sin(a * 0.7) * 14, Math.sin(a) * 285);
    cam.lookAt(105, 12, 0);
    cam.fov = 52;
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    gfx.render([{ rect: [0, 0, W, H], camera: cam, focus: { x: 105 + Math.cos(a) * 110, z: Math.sin(a) * 125 }, range: 150 }]);
    perf.end();
    return;
  }

  const u0 = performance.now();
  if (!paused && race.state !== 'done') {
    race.update(dt, readControls());
    playEvents();
    const p1 = race.humans[0];
    audio.setEngine(Math.abs(p1.speed) / BASE.max, p1.boosting, !p1.finished);
    if (race.state === 'done') showResults();
  }

  perf.sim = performance.now() - u0;
  const r0 = performance.now();
  const vs = views(race.humans.length);
  gfx.render(vs.map((rect, i) => {
    const cam = cameras[i];
    const k = race.humans[i];
    if (!paused) chase(cam, k, dt);
    cam.aspect = rect[2] / rect[3];
    cam.updateProjectionMatrix();
    return { rect, camera: cam, focus: k, range: 60 };
  }));
  const blob = !gfx.shadowsOn; // blob shadows stand in when real ones are off
  for (const k of race.karts) k.model.shadow.visible = blob;
  perf.end();
  perf.draw = performance.now() - r0;
  if (!drawUi) return;
  const h0 = performance.now();
  if (race.state !== 'done') vs.forEach((v, i) => drawHud(v, race.humans[i], now));
  perf.hud = performance.now() - h0;

  if (vs.length > 1) {
    hud.fillStyle = '#05060a';
    if (vs.length === 2 && W >= H) hud.fillRect(W / 2 - 2, 0, 4, H);
    else {
      hud.fillRect(0, H / 2 - 2, W, 4);
      if (vs.length > 2) hud.fillRect(W / 2 - 2, 0, 4, H);
    }
    if (vs.length === 3 && race.state !== 'done') drawStandingsPanel(W / 2, H / 2, W / 2, H / 2);
  }
  if (paused) {
    hud.fillStyle = 'rgba(4,6,10,.6)';
    hud.fillRect(0, 0, W, H);
    text('PAUSED', W / 2, H / 2 - 10, 72, '#fff', 'center');
    text('ESC TO RESUME', W / 2, H / 2 + 48, 20, '#ffd23f', 'center', false);
  }
}

/** With three players the spare quadrant shows the full running order. */
function drawStandingsPanel(x, y, w, h) {
  hud.fillStyle = '#0b0d14';
  hud.fillRect(x + 2, y + 2, w, h);
  const u = clamp(Math.min(w, h) / 420, 0.5, 1.4);
  text('RUNNING ORDER', x + w / 2, y + 34 * u, 24 * u, '#ffd23f', 'center');
  race.order.forEach((o, i) => {
    const ry = y + 62 * u + i * 40 * u;
    plate(x + w * 0.14, ry, w * 0.68, 32 * u, o.human >= 0 ? '#fff' : hex(o.look.c1), o.human >= 0 ? 'rgba(210,12,22,.9)' : 'rgba(255,255,255,.07)');
    text(String(i + 1), x + w * 0.14 + 34 * u, ry + 17 * u, 18 * u, '#ffd23f', 'center', false);
    text(o.name, x + w * 0.14 + 60 * u, ry + 17 * u, 16 * u, '#fff', 'left', false);
  });
}

input.initInput($('touch'));

// Demo / test hook: ?auto=N starts an AI-driven race with N badgers; &skip=S pre-simulates S seconds; &q=low|medium|high.
if (params.has('auto')) {
  demo = true;
  cfg.nPlayers = clamp(+params.get('auto') || 1, 1, 4);
  defaultPlayers();
  cfg.field = pickField(rivalCount(cfg.nPlayers), season);
  startRace();
  for (let t = 0; t < (+params.get('skip') || 0); t += 1 / 60) {
    race.update(1 / 60, readControls());
    race.events.length = 0;
  }
}

// Let the loading screen paint, draw one hidden frame to compile shaders and upload textures, then start.
requestAnimationFrame(() => requestAnimationFrame(() => {
  const cam = cameras[0];
  if (!race) {
    cam.position.set(355, 46, 0);
    cam.lookAt(105, 12, 0);
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    gfx.warmUp([{ rect: [0, 0, W, H], camera: cam, focus: { x: 105, z: 0 }, range: 330 }]);
  }
  $('loading').classList.add('hidden');
  if (params.has('stats')) console.log(`STATS ready at ${Math.round(performance.now())}ms, ${gfx.renderer.info.programs.length} shader programs`);
  requestAnimationFrame(frame);
}));

// Offline/instant reloads: cache the game files with a service worker (not on file://).
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !params.has('nosw')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
