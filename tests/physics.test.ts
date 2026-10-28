import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_DT,
  HALF_HEIGHT,
  MATERIALS,
  MAX_RADIUS,
  NECK_RADIUS,
  Physics,
  radiusAt,
} from "../src/physics.ts";

function assertContained(physics: Physics): void {
  assert.equal(physics.positions.length, physics.count * 3);
  assert.equal(physics.velocities.length, physics.count * 3);
  for (let i = 0; i < physics.count; i++) {
    const k = i * 3;
    const x = physics.positions[k];
    const y = physics.positions[k + 1];
    const z = physics.positions[k + 2];
    const radius = physics.radii[i];
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
    assert.ok(
      Math.abs(y) + radius <= HALF_HEIGHT + 2e-7,
      `end cap: grain ${i}`,
    );
    assert.ok(
      Math.hypot(x, z) + radius <= radiusAt(y) + 2e-7,
      `wall: grain ${i}`,
    );
    for (let axis = 0; axis < 3; axis++)
      assert.ok(Number.isFinite(physics.velocities[k + axis]));
  }
}

function isolate(physics: Physics): void {
  physics.positions.fill(0);
  physics.velocities.fill(0);
}

test("analytic hourglass is smooth, symmetric, and uses metre dimensions", () => {
  assert.equal(radiusAt(0), NECK_RADIUS);
  assert.equal(radiusAt(HALF_HEIGHT), MAX_RADIUS);
  assert.equal(radiusAt(-HALF_HEIGHT), MAX_RADIUS);
  for (let i = 0; i <= 100; i++) {
    const y = (i / 100) * HALF_HEIGHT;
    assert.equal(radiusAt(y), radiusAt(-y));
    assert.ok(radiusAt(y) >= NECK_RADIUS && radiusAt(y) <= MAX_RADIUS);
  }
  assert.ok(Math.abs((radiusAt(1e-6) - radiusAt(0)) / 1e-6) < 1e-4);
});

test("true acceleration magnitude is preserved, without default gravity", () => {
  const slow = new Physics(1);
  const fast = new Physics(1);
  isolate(slow);
  isolate(fast);
  slow.step([0, -2, 0]);
  fast.step([0, -8, 0]);
  assert.ok(Math.abs(slow.velocities[1] + 2 * FIXED_DT) < 1e-8);
  assert.ok(Math.abs(fast.velocities[1] / slow.velocities[1] - 4) < 1e-6);
  const zero = new Physics(1);
  isolate(zero);
  zero.step([0, 0, 0]);
  assert.deepEqual([...zero.positions], [0, 0, 0]);
  assert.deepEqual([...zero.velocities], [0, 0, 0]);
});

test("zero gravity preserves inertia without global damping or artificial settling", () => {
  const physics = new Physics(1);
  isolate(physics);
  physics.positions[1] = 0.11;
  physics.velocities.set([0.03, 0.01, -0.02]);
  const velocity = physics.velocities.slice();
  for (let i = 0; i < 20; i++) physics.step([0, 0, 0]);
  assert.deepEqual(physics.velocities, velocity);
  assert.ok(
    Math.abs(physics.positions[0] - velocity[0] * FIXED_DT * 20) < 1e-7,
  );
  assert.ok(
    Math.abs(physics.positions[1] - (0.11 + velocity[1] * FIXED_DT * 20)) <
      2e-7,
  );
});

test("size-weighted collision conserves momentum and never adds kinetic energy", () => {
  const physics = new Physics(2, 2);
  const halfDistance = (physics.radii[0] + physics.radii[1]) * 0.495;
  const massB = (physics.radii[1] / physics.radii[0]) ** 3;
  physics.positions.set([-halfDistance, 0.12, 0, halfDistance, 0.12, 0]);
  physics.velocities.set([
    0.1,
    0.02,
    0.01,
    -0.1 / massB,
    -0.02 / massB,
    -0.01 / massB,
  ]);
  const energy = physics.velocities.reduce(
    (sum, value, index) => sum + value * value * (index < 3 ? 1 : massB),
    0,
  );
  physics.step([0, 0, 0]);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(
      Math.abs(
        physics.velocities[axis] + physics.velocities[axis + 3] * massB,
      ) < 1e-7,
    );
  }
  assert.ok(
    physics.velocities.reduce(
      (sum, value, index) => sum + value * value * (index < 3 ? 1 : massB),
      0,
    ) <=
      energy + 1e-7,
  );
  assert.ok(physics.stats.contacts > 0);
  assertContained(physics);
});

test("fixed accumulator is independent of render cadence and reports dropped seconds", () => {
  const a = new Physics(1);
  const b = new Physics(1);
  isolate(a);
  isolate(b);
  for (let i = 0; i < 12; i++) a.advance(FIXED_DT / 2, [0, -1, 0]);
  for (let i = 0; i < 6; i++) b.step([0, -1, 0]);
  assert.equal(a.stats.steps, 6);
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.velocities, b.velocities);
  a.advance(1, [0, 0, 0]);
  assert.equal(a.stats.steps, 14);
  assert.ok(Math.abs(a.stats.dropped - (1 - 8 * FIXED_DT)) < 1e-10);
  const before = a.positions.slice();
  a.advance(30, [0, -100, 0], true);
  assert.deepEqual(a.positions, before);
  assert.equal(a.stats.steps, 14);
  assert.ok(Math.abs(a.stats.dropped - (1 - 8 * FIXED_DT)) < 1e-10);
});

test("all four materials preserve particle state and count", () => {
  const physics = new Physics(1000);
  const positions = physics.positions.slice();
  const velocities = physics.velocities.slice();
  const radii = physics.radii.slice();
  assert.equal(MATERIALS.length, 4);
  for (let i = 0; i < MATERIALS.length; i++) {
    physics.setMaterial(i);
    assert.equal(physics.material, i);
    assert.deepEqual(physics.positions, positions);
    assert.deepEqual(physics.velocities, velocities);
    assert.deepEqual(physics.radii, radii);
  }
  assertContained(physics);
});

test("material friction changes contact motion rather than only visual appearance", () => {
  const fine = new Physics(1, 0);
  const crystal = new Physics(1, 3);
  for (const physics of [fine, crystal]) {
    physics.positions.set([0, -HALF_HEIGHT + physics.radii[0], 0]);
    physics.velocities.set([2, -1, 0]);
    physics.step([0, 0, 0], 0.001);
    assertContained(physics);
    assert.ok(physics.stats.contacts > 0);
  }
  assert.ok(Math.abs(crystal.velocities[0]) < Math.abs(fine.velocities[0]));
});

test("visible solid volume stays constant across supported benchmark counts", () => {
  const volumes = [1000, 5000, 10000].map((count) => {
    const physics = new Physics(count);
    assert.ok(
      physics.radii.some(
        (radius) => Math.abs(radius - physics.radii[0]) > 1e-5,
      ),
    );
    assertContained(physics);
    return physics.radii.reduce(
      (sum, r) => sum + (4 * Math.PI * r ** 3) / 3,
      0,
    );
  });
  assert.ok(Math.abs(volumes[0] / volumes[1] - 1) < 1e-6);
  assert.ok(Math.abs(volumes[0] / volumes[2] - 1) < 1e-6);
});

test("adaptive collision subdivisions contain a high-speed grain", () => {
  const physics = new Physics(1);
  physics.positions.set([0, 0.12, 0]);
  physics.velocities.set([30, -60, 20]);
  for (let i = 0; i < 20; i++) {
    physics.step([80, -150, -40]);
    assertContained(physics);
  }
});

test("long run keeps every grain through zero-g, flips, high force, and both piles", () => {
  const physics = new Physics(180);
  const radii = physics.radii.slice();
  const scenes = [
    [0, -9.81, 0],
    [0, 0, 0],
    [0, 9.81, 0],
    [35, -80, 20],
    [0, 50, 0],
  ];
  for (let i = 0; i < 1200; i++) {
    if (i % 300 === 0) physics.setMaterial((i / 300) % MATERIALS.length);
    physics.step(scenes[Math.floor(i / 120) % scenes.length]);
    if (i % 30 === 0) assertContained(physics);
  }
  assertContained(physics);
  assert.equal(physics.count, 180);
  assert.deepEqual(physics.radii, radii);
  assert.equal(physics.stats.steps, 1200);
});

test("reset restores deterministic initial state; invalid input is rejected", () => {
  const physics = new Physics(25, 3);
  const initial = physics.positions.slice();
  physics.step([5, -20, 3]);
  physics.reset();
  assert.deepEqual(physics.positions, initial);
  assert.ok(physics.velocities.every((value) => value === 0));
  assert.equal(physics.material, 3);
  assert.equal(physics.stats.steps, 0);
  assert.throws(() => new Physics(0), RangeError);
  assert.throws(() => physics.setMaterial(4), RangeError);
  assert.throws(() => physics.step([NaN, 0, 0]), RangeError);
  assert.throws(() => physics.advance(-1, [0, 0, 0]), RangeError);
  const positions = physics.positions.slice();
  assert.throws(() => physics.step([1e300, 0, 0]), /safety budget/);
  assert.deepEqual(physics.positions, positions);
});

test("worker protocol transfers ping-pong buffers and does not advance without requests", async () => {
  type Frame = {
    type: string;
    positions: ArrayBuffer;
    radii?: ArrayBuffer;
    count: number;
    stats: { steps: number };
    samples?: { count: number; msPerStep: number }[];
  };
  const scope = globalThis as unknown as {
    postMessage?: (message: unknown, transfer?: Transferable[]) => void;
    onmessage?: (event: MessageEvent) => void;
  };
  const oldPostMessage = scope.postMessage;
  const oldOnMessage = scope.onmessage;
  const frames: Frame[] = [];
  scope.postMessage = (message, transfer) =>
    frames.push(structuredClone(message, { transfer }) as Frame);
  try {
    // Load boundary is intentional: static import would install the worker before the mocked message port.
    await import("../src/physics.worker.ts");
    scope.onmessage!(
      new MessageEvent("message", {
        data: { type: "init", count: 25, material: 1 },
      }),
    );
    assert.equal(frames.length, 1);
    const initial = frames[0];
    assert.equal(initial.type, "state");
    assert.equal(initial.positions.byteLength, 25 * 3 * 4);
    assert.equal(initial.radii?.byteLength, 25 * 4);
    const saved = new Float32Array(initial.positions).slice();
    scope.onmessage!(
      new MessageEvent("message", { data: { type: "material", material: 3 } }),
    );
    scope.onmessage!(new MessageEvent("message", { data: { type: "reset" } }));
    assert.equal(
      frames.length,
      1,
      "control messages must not create unsolicited frames",
    );
    const request = structuredClone(
      {
        type: "advance",
        elapsed: 10,
        acceleration: [0, 0, 0],
        paused: true,
        buffer: initial.positions,
      },
      { transfer: [initial.positions] },
    );
    assert.equal(initial.positions.byteLength, 0);
    scope.onmessage!(new MessageEvent("message", { data: request }));
    assert.equal(
      request.buffer.byteLength,
      0,
      "worker transfers rather than retains the outgoing buffer",
    );
    assert.equal(frames.length, 2);
    assert.equal(frames[1].radii, undefined);
    assert.equal(frames[1].stats.steps, 0);
    assert.deepEqual(new Float32Array(frames[1].positions), saved);
    scope.onmessage!(
      new MessageEvent("message", { data: { type: "calibrate" } }),
    );
    assert.equal(frames[2].type, "calibrated");
    assert.deepEqual(
      frames[2].samples?.map((sample) => sample.count),
      [1000, 5000, 10000],
    );
    assert.ok(
      frames[2].samples?.every(
        (sample) => sample.msPerStep >= 0 && Number.isFinite(sample.msPerStep),
      ),
    );
  } finally {
    if (oldPostMessage) scope.postMessage = oldPostMessage;
    else delete scope.postMessage;
    if (oldOnMessage) scope.onmessage = oldOnMessage;
    else delete scope.onmessage;
  }
});
