import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collideKarts, moveKnockback } from '../src/collision.js';

const kart = (props = {}) => ({ x: 0, y: 0, z: 0, heading: 0, speed: 0,
  bumpX: 0, bumpZ: 0, stats: {}, ...props });

test('rear-end hit moves the stopped kart and recoils the attacker', () => {
  const a = kart({ speed: 40 });
  const b = kart({ z: 2 });
  assert.ok(collideKarts(a, b));
  assert.ok(a.bumpZ < 0 && b.bumpZ > 0);
  assert.ok(Math.abs(a.bumpZ + b.bumpZ) < 1e-10);
  const before = b.z;
  moveKnockback(b, 0.1);
  assert.ok(b.z > before);
});

test('side impact pushes sideways and heavy karts resist more', () => {
  const a = kart({ heading: Math.PI / 2, speed: 20, stats: { heavy: true } });
  const b = kart({ x: 2 });
  collideKarts(a, b);
  assert.ok(b.bumpX > 0 && a.bumpX < 0);
  assert.ok(Math.abs(a.bumpX) < b.bumpX);
  assert.ok(Math.abs(b.x - a.x - 2.6) < 1e-10);
});

test('separating karts do not receive another impulse', () => {
  const a = kart({ bumpX: -5 });
  const b = kart({ x: 2, bumpX: 5 });
  collideKarts(a, b);
  assert.equal(a.bumpX, -5);
  assert.equal(b.bumpX, 5);
});

test('exact overlaps separate without invalid coordinates', () => {
  const a = kart();
  const b = kart();
  collideKarts(a, b);
  assert.equal(Math.hypot(b.x - a.x, b.z - a.z), 2.6);
  assert.equal(a.bumpX, 0);
});

test('airborne and distant karts do not collide', () => {
  assert.equal(collideKarts(kart(), kart({ y: 3 })), false);
  assert.equal(collideKarts(kart(), kart({ x: 4 })), false);
});

test('knockback decays consistently across frame rates', () => {
  const a = kart({ bumpX: 10, bumpZ: -5 });
  const b = { ...a };
  moveKnockback(a, 1);
  for (let i = 0; i < 60; i++) moveKnockback(b, 1 / 60);
  assert.ok(Math.abs(a.x - b.x) < 1e-10);
  assert.ok(Math.abs(a.z - b.z) < 1e-10);
  assert.ok(Math.abs(a.bumpX - b.bumpX) < 1e-10);
  assert.ok(a.bumpX < 1);
});
