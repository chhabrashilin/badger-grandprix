// World-space knockback lets a hit move a kart sideways without steering it.
export function moveKnockback(k, dt) {
  const decay = Math.exp(-4 * dt);
  k.x += k.bumpX * (1 - decay) / 4;
  k.z += k.bumpZ * (1 - decay) / 4;
  k.bumpX *= decay;
  k.bumpZ *= decay;
}

export function collideKarts(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const distance = Math.hypot(dx, dz);
  if (distance >= 2.6 || Math.abs(a.y - b.y) > 1.2) return false;

  // A deterministic normal also separates karts at exactly the same position.
  const nx = distance > 1e-6 ? dx / distance : Math.cos(a.heading);
  const nz = distance > 1e-6 ? dz / distance : -Math.sin(a.heading);
  const wa = a.stats.heavy ? 0.6 : 1;
  const wb = b.stats.heavy ? 0.6 : 1;
  const overlap = 2.6 - distance;
  a.x -= nx * overlap * wa / (wa + wb);
  a.z -= nz * overlap * wa / (wa + wb);
  b.x += nx * overlap * wb / (wa + wb);
  b.z += nz * overlap * wb / (wa + wb);

  const closing = (Math.sin(a.heading) * a.speed + a.bumpX
    - Math.sin(b.heading) * b.speed - b.bumpX) * nx
    + (Math.cos(a.heading) * a.speed + a.bumpZ
    - Math.cos(b.heading) * b.speed - b.bumpZ) * nz;
  // Separating contacts need correction only, never another kick.
  if (closing > 0) {
    const impulse = closing * 1.25 / (wa + wb);
    a.bumpX -= nx * impulse * wa;
    a.bumpZ -= nz * impulse * wa;
    b.bumpX += nx * impulse * wb;
    b.bumpZ += nz * impulse * wb;
  }
  return true;
}
