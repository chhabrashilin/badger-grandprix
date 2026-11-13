// Input: keyboard (two layouts), gamepads, phone tilt and on-screen touch buttons.
import { clamp } from './util.js';

const keys = new Set();
const touch = { left: false, right: false, brake: false, drift: false, nitro: false, item: false, used: false };
const tilt = { enabled: false, steer: 0 };

const LAYOUT_A = { left: ['KeyA'], right: ['KeyD'], accel: ['KeyW'], brake: ['KeyS'], drift: ['ShiftLeft'], nitro: ['KeyE'], item: ['KeyQ', 'Space'] };
const LAYOUT_B = { left: ['ArrowLeft'], right: ['ArrowRight'], accel: ['ArrowUp'], brake: ['ArrowDown'], drift: ['ShiftRight'], nitro: ['Slash'], item: ['Enter'] };
const BLOCK = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

// Phones/tablets only: a touchscreen laptop still has a fine primary pointer.
export const isTouchDevice = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
export const tiltEnabled = () => tilt.enabled;

export function initInput(touchRoot) {
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (BLOCK.has(e.code) && !e.target.closest?.('button, select, input')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  for (const btn of touchRoot.querySelectorAll('[data-act]')) {
    const act = btn.dataset.act;
    const set = (v) => (e) => {
      e.preventDefault();
      touch[act] = v;
      touch.used = true;
      btn.classList.toggle('down', v);
    };
    btn.addEventListener('pointerdown', set(true));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, set(false));
  }
}

/**
 * Turn on tilt steering. Must be called from a tap (iOS asks for permission).
 * Uses the gravity direction relative to the screen, so it works whether the
 * phone is held upright like a wheel or flat like a tray.
 */
export async function enableTilt() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return false;
  if (typeof DOE.requestPermission === 'function') {
    try {
      if ((await DOE.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
  }
  window.addEventListener('deviceorientation', (e) => {
    if (e.beta === null || e.gamma === null) return;
    const b = (e.beta * Math.PI) / 180;
    const g = (e.gamma * Math.PI) / 180;
    // World "up" expressed in device axes (x = right edge, y = top edge).
    const upX = -Math.cos(b) * Math.sin(g);
    const upY = Math.sin(b);
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    // Component of "up" along the screen's left axis: positive = right side dipped.
    const side = angle === 90 ? upY : angle === 270 || angle === -90 ? -upY : -upX;
    tilt.steer = clamp(side / 0.42, -1, 1);
  });
  tilt.enabled = true;
  return true;
}

const down = (codes) => codes.some((c) => keys.has(c));

function fromLayout(L) {
  return {
    steer: (down(L.right) ? 1 : 0) - (down(L.left) ? 1 : 0),
    accel: down(L.accel) ? 1 : 0,
    brake: down(L.brake),
    drift: down(L.drift),
    nitro: down(L.nitro),
    item: down(L.item),
  };
}

function fromPad(gp) {
  if (!gp) return null;
  const b = (i) => gp.buttons[i]?.pressed ?? false;
  const v = (i) => gp.buttons[i]?.value ?? 0;
  const ax = Math.abs(gp.axes[0] ?? 0) > 0.12 ? gp.axes[0] : 0;
  return {
    steer: clamp(ax + (b(15) ? 1 : 0) - (b(14) ? 1 : 0), -1, 1),
    accel: Math.max(v(7), b(0) ? 1 : 0),
    brake: v(6) > 0.3 || b(1),
    drift: b(5) || b(4),
    nitro: b(3),
    item: b(2),
  };
}

function merge(a, b) {
  if (!b) return a;
  return {
    steer: clamp(a.steer + b.steer, -1, 1),
    accel: Math.max(a.accel, b.accel),
    brake: a.brake || b.brake,
    drift: a.drift || b.drift,
    nitro: a.nitro || b.nitro,
    item: a.item || b.item,
  };
}

/**
 * Raw (level-triggered) input for player `p`.
 * Solo: both keyboard layouts + first gamepad + tilt/touch.
 * Multiplayer: P1 = WASD, P2 = arrows, and player N also gets gamepad N.
 */
export function readPlayer(p, nPlayers) {
  const pads = (navigator.getGamepads?.() ?? []);
  let c;
  if (nPlayers === 1) {
    c = merge(fromLayout(LAYOUT_A), fromLayout(LAYOUT_B));
    c = merge(c, fromPad([...pads].find(Boolean)));
    if (tilt.enabled || touch.used) {
      const brake = touch.brake;
      c = merge(c, {
        steer: (tilt.enabled ? tilt.steer : 0) + (touch.right ? 1 : 0) - (touch.left ? 1 : 0),
        accel: brake ? 0 : 1, // auto-accelerate on phones
        brake, drift: touch.drift, nitro: touch.nitro, item: touch.item,
      });
    }
  } else {
    c = p === 0 ? fromLayout(LAYOUT_A) : p === 1 ? fromLayout(LAYOUT_B) : { steer: 0, accel: 0, brake: false, drift: false, nitro: false, item: false };
    c = merge(c, fromPad(pads[p]));
  }
  return c;
}

export const keyDown = (code) => keys.has(code);
