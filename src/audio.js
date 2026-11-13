// Synthesized audio: engine drone, sound effects and a short original music loop.
let ctx = null;
let master = null;
let engine = null;
let muted = false;
let musicTimer = null;

export function initAudio() {
  if (ctx) return ctx.resume();
  const AC = window.AudioContext ?? window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 500;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(filter).connect(gain).connect(master);
  osc.start();
  engine = { osc, filter, gain };
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.5;
  return muted;
}

/** speed 0..~1.4 (fraction of base top speed) */
export function setEngine(speed, boosting, on = true) {
  if (!engine) return;
  const t = ctx.currentTime;
  engine.osc.frequency.setTargetAtTime(55 + speed * 110 + (boosting ? 25 : 0), t, 0.05);
  engine.filter.frequency.setTargetAtTime(350 + speed * 900, t, 0.05);
  engine.gain.gain.setTargetAtTime(on ? 0.07 : 0, t, 0.08);
}

function tone(freq, dur, type = 'square', vol = 0.15, when = 0, slideTo = null) {
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const SFX = {
  count: () => tone(440, 0.18),
  go: () => tone(880, 0.5),
  box: () => [660, 880, 1100].forEach((f, i) => tone(f, 0.08, 'square', 0.1, i * 0.07)),
  use: () => tone(300, 0.2, 'triangle', 0.2, 0, 900),
  hit: () => tone(220, 0.45, 'sawtooth', 0.2, 0, 50),
  block: () => tone(1200, 0.15, 'triangle', 0.15),
  pad: () => tone(200, 0.35, 'sawtooth', 0.12, 0, 800),
  lap: () => [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'square', 0.12, i * 0.1)),
  finish: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.16, 'square', 0.14, i * 0.13)),
  click: () => tone(700, 0.05, 'square', 0.08),
};
export const sfx = (name) => SFX[name]?.();

// Original 16-step driving loop (bass + lead), A minor.
const BASS = [110, 0, 110, 0, 110, 0, 131, 0, 147, 0, 147, 0, 98, 0, 123, 0];
const LEAD = [440, 0, 523, 659, 0, 587, 523, 0, 587, 0, 659, 784, 0, 659, 587, 494];

export function startMusic() {
  if (!ctx || musicTimer) return;
  let step = 0;
  const beat = 0.14;
  musicTimer = setInterval(() => {
    const i = step++ % 16;
    if (BASS[i]) tone(BASS[i], beat * 1.6, 'triangle', 0.16);
    if (LEAD[i]) tone(LEAD[i], beat * 0.9, 'square', 0.035);
  }, beat * 1000);
}

export function stopMusic() {
  clearInterval(musicTimer);
  musicTimer = null;
}
