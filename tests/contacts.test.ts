import assert from "node:assert/strict";
import test from "node:test";
import { Physics } from "../src/physics.ts";
import { FIXED_DT, HALF_HEIGHT, MAX_RADIUS, radiusAt, slopeAt } from "../src/vessel.ts";

function cube(count = 8): Physics {
  const physics = new Physics(count,1,undefined,0);
  const spacing = Math.max(...physics.radii) * 2.04;
  for (let i = 0; i < 8; i++) {
    const k = i * 3;
    physics.positions[k] = ((i & 1) - 0.5) * spacing;
    physics.positions[k + 1] = HALF_HEIGHT * 0.6 + ((i >> 1) & 1) * spacing;
    physics.positions[k + 2] = (((i >> 2) & 1) - 0.5) * spacing;
    physics.velocities.set([0.02, -0.01, 0.005], k);
  }
  return physics;
}

function contained(physics: Physics): void {
  for (let i = 0; i < physics.count; i++) {
    const k = i * 3;
    const y = physics.positions[k + 1];
    assert.ok(Math.abs(y) + physics.radii[i] <= HALF_HEIGHT + 2e-7);
    const slope = slopeAt(y, physics.neckRadius);
    const distance = (Math.hypot(physics.positions[k], physics.positions[k + 2]) -
      radiusAt(y, physics.neckRadius)) / Math.sqrt(1 + slope * slope);
    assert.ok(distance + physics.radii[i] <= 2e-7, `wall: ${i}`);
  }
  assert.equal(physics.stats.active + physics.stats.sleeping, physics.count);
}

function momentum(physics: Physics): number[] {
  const result = [0, 0, 0];
  for (let i = 0; i < physics.count; i++) {
    const mass = physics.radii[i] ** 3 / physics.radii[0] ** 3;
    for (let axis = 0; axis < 3; axis++) result[axis] += mass * physics.velocities[i * 3 + axis];
  }
  return result;
}

test("free translation matches the Float32 particle integrator", () => {
  const physics = cube();
  const positions = physics.positions.slice();
  const velocities = physics.velocities.slice();
  const acceleration = [0.3, -0.4, 0.2];
  for (let step = 0; step < 12; step++) {
    const h = FIXED_DT / 4;
    for (let sub = 0; sub < 4; sub++) for (let i = 0; i < physics.count; i++) {
      const k = i * 3;
      for (let axis = 0; axis < 3; axis++) velocities[k + axis] += acceleration[axis] * h;
      const travel = Math.hypot(velocities[k], velocities[k + 1], velocities[k + 2]) * h;
      const slices = Math.max(1, Math.ceil(travel / (physics.radii[i] * 0.5)));
      for (let slice = 0; slice < slices; slice++)
        for (let axis = 0; axis < 3; axis++) positions[k + axis] += velocities[k + axis] * (h / slices);
    }
    physics.step(acceleration);
    assert.deepEqual(physics.positions, positions);
    assert.deepEqual(physics.velocities, velocities);
    contained(physics);
  }
  assert.equal(physics.stats.active, physics.count);
});

test("zero-g particles preserve inertia and mass-weighted momentum", () => {
  const physics = cube();
  const velocities = physics.velocities.slice();
  const before = momentum(physics);
  for (let step = 0; step < 30; step++) {
    physics.step([0, 0, 0]);
    assert.deepEqual(physics.velocities, velocities);
    assert.deepEqual(momentum(physics), before);
  }
  physics.step([0, 0, 0], 0);
});

test("wall contact contains particles without permanent bonds", () => {
  const physics = cube();
  for (let i = 0; i < physics.count; i++) {
    physics.positions[i * 3] += MAX_RADIUS * 0.2;
    physics.velocities.set([0.3, 0, 0], i * 3);
  }
  const initial = physics.positions.slice();
  let bounced=false;
  for (let step = 0; step < 70; step++) {
    physics.step([0, 0, 0]);
    contained(physics);
    for(let i=0;i<physics.count;i++){
      const k=i*3,x=physics.positions[k],y=physics.positions[k+1],z=physics.positions[k+2];
      const rho=Math.hypot(x,z),slope=slopeAt(y,physics.neckRadius),normalLength=Math.hypot(1,slope);
      if(rho>0&&(rho-radiusAt(y,physics.neckRadius))/normalLength+physics.radii[i]>-physics.radii[i]*.15){
        const outward=(physics.velocities[k]*x/rho+physics.velocities[k+2]*z/rho-physics.velocities[k+1]*slope)/normalLength;
        if(outward<-.001)bounced=true;
      }
    }
  }
  assert.ok(bounced,"curved-wall rebound reverses the normal component, not necessarily world X");
  let changedSeparation = false;
  for (let i = 0; i < physics.count; i++) for (let j = i + 1; j < physics.count; j++) {
    const a = i * 3, b = j * 3, p = physics.positions;
    const before = Math.hypot(initial[b] - initial[a], initial[b + 1] - initial[a + 1], initial[b + 2] - initial[a + 2]);
    const after = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    if (Math.abs(after - before) > Math.min(physics.radii[i], physics.radii[j]) * 0.1) changedSeparation = true;
  }
  assert.ok(changedSeparation, "wall impacts must let the particle arrangement deform instead of preserving rigid bonds");
});

test("a surface velocity change never shares its impulse with co-moving neighbors", () => {
  const physics = cube();
  physics.step([0, 0, 0]);
  physics.velocities[0] = -0.04;
  const before = momentum(physics);
  const x = physics.positions[0];
  physics.step([0, 0, 0]);
  assert.ok(physics.positions[0] < x);
  assert.equal(physics.velocities[0], Math.fround(-0.04));
  for (let i = 1; i < physics.count; i++) assert.equal(physics.velocities[i * 3], Math.fround(0.02));
  assert.deepEqual(momentum(physics), before);
  contained(physics);
});

test("an external projectile collides and conserves momentum", () => {
  const physics = cube(9);
  physics.positions.set([MAX_RADIUS * 0.45, HALF_HEIGHT * 0.6, physics.positions[2]], 24);
  physics.velocities.set([-0.04, -0.01, 0.005], 24);
  const before = momentum(physics);
  let contacts = 0;
  for (let step = 0; step < 40; step++) {
    physics.step([0, 0, 0]);
    contacts += physics.stats.contacts;
    contained(physics);
  }
  assert.ok(contacts > 0);
  const after = momentum(physics);
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(after[axis] - before[axis]) < 2e-5);
});

test("supported surface sleepers stay individual instead of binding impacts to the whole bed", () => {
  const physics = new Physics(2);
  const spacing = Math.max(...physics.radii) * 2.04;
  for (let i = 0; i < physics.count; i++)
    physics.positions.set([(i - 0.5) * spacing, -HALF_HEIGHT + physics.radii[i], 0], i * 3);
  for (let step = 0; step < 180; step++) physics.step([0, -9.81, 0]);
  assert.equal(physics.stats.sleeping, 2);
  physics.velocities[0] = -0.1;
  physics.step([0, -9.81, 0]);
  assert.equal(physics.stats.active, 1);
  assert.equal(physics.stats.sleeping, 1);
  contained(physics);
});

test("the entire Darcy region stays individual and cannot sleep on a wall", () => {
  const physics = new Physics(1, 1, MAX_RADIUS * 0.6);
  physics.positions.set([physics.neckRadius - physics.radii[0], 0, 0]);
  for (let step = 0; step < 180; step++) physics.step([9.81, 0, 0]);
  assert.equal(physics.stats.sleeping, 0);
  assert.equal(physics.stats.active, 1);
  contained(physics);
});

test("exactly touching co-moving grains preserve momentum", () => {
  const physics = new Physics(2,1,undefined,0);
  const distance = physics.radii[0] + physics.radii[1];
  physics.positions.set([-distance / 2, HALF_HEIGHT * 0.6, 0, distance / 2, HALF_HEIGHT * 0.6, 0]);
  physics.velocities.set([0.02, 0, 0, 0.02, 0, 0]);
  const before = momentum(physics);
  physics.step([0, 0, 0]);
  assert.deepEqual(momentum(physics), before);
  contained(physics);
});

test("overlapping co-moving grains resolve penetration", () => {
  const physics = new Physics(2,1,undefined,0);
  const distance = (physics.radii[0] + physics.radii[1]) * 0.95;
  physics.positions.set([-distance / 2, HALF_HEIGHT * 0.6, 0, distance / 2, HALF_HEIGHT * 0.6, 0]);
  physics.velocities.set([0.02, 0, 0, 0.02, 0, 0]);
  physics.step([0, 0, 0]);
  assert.ok(physics.stats.contacts > 0);
  const separation = Math.hypot(
    physics.positions[3] - physics.positions[0],
    physics.positions[4] - physics.positions[1],
    physics.positions[5] - physics.positions[2],
  );
  assert.ok(separation >= physics.radii[0] + physics.radii[1] - 1e-7);
});

test("wall corrections rebuild candidates before a new particle contact is missed", () => {
  const physics = new Physics(2, 1, undefined, 0);
  const y = HALF_HEIGHT * 0.6;
  const wall = radiusAt(y, physics.neckRadius);
  const slope = slopeAt(y, physics.neckRadius);
  const length = Math.hypot(1, slope), nx = 1 / length, ny = -slope / length;
  const distance = physics.radii[0] + physics.radii[1];
  const center = wall - physics.radii[0] * length;
  physics.positions.set([
    center + nx * distance * 1.1, y + ny * distance * 1.1, 0,
    center - nx * distance * 0.8, y - ny * distance * 0.8, 0,
  ]);
  const neighbor = physics.positions.slice(3);
  assert.ok(Math.hypot(physics.positions[3] - physics.positions[0], physics.positions[4] - physics.positions[1]) > distance * 1.5);
  for (let step = 0; step < 3; step++) physics.step([0, 0, 0]);
  contained(physics);
  const p = physics.positions;
  const separation = Math.hypot(p[3] - p[0], p[4] - p[1], p[5] - p[2]);
  assert.ok(separation >= (physics.radii[0] + physics.radii[1]) * 0.98);
  assert.ok(Math.hypot(p[3] - neighbor[0], p[4] - neighbor[1]) > Math.min(...physics.radii) * 0.01,
    "wall projection must create and resolve a new contact, not leave the inner grain untouched");
});
