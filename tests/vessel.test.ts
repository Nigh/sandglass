import assert from "node:assert/strict";
import test from "node:test";
import { Physics } from "../src/physics.ts";
import {
  HALF_HEIGHT,
  MAX_RADIUS,
  grainBaseRadius,
  neckRadiusFor,
  radiusAt,
  slopeAt,
} from "../src/vessel.ts";

test("shared profile is symmetric, smooth through the throat and bounded by the end caps", () => {
  for (const count of [1, 1000, 5000, 10000, 100000]) {
    const neck = neckRadiusFor(count);
    assert.equal(radiusAt(0, neck), neck);
    assert.equal(radiusAt(HALF_HEIGHT, neck), MAX_RADIUS);
    assert.equal(radiusAt(-HALF_HEIGHT, neck), MAX_RADIUS);
    assert.equal(slopeAt(0, neck), 0);
    assert.equal(slopeAt(HALF_HEIGHT, neck), 0);
    assert.equal(slopeAt(-HALF_HEIGHT, neck), 0);
    for (let i = 0; i <= 100; i++) {
      const y = (i / 100) * HALF_HEIGHT;
      assert.equal(radiusAt(y, neck), radiusAt(-y, neck));
      assert.equal(slopeAt(y, neck), -slopeAt(-y, neck) || 0);
      assert.ok(radiusAt(y, neck) >= neck && radiusAt(y, neck) <= MAX_RADIUS);
      if (i < 100) {
        const delta = 1e-7;
        const numerical = (radiusAt(y + delta, neck) - radiusAt(y - delta, neck)) / (2 * delta);
        assert.ok(Math.abs(numerical - slopeAt(y, neck)) < 2e-6);
      }
    }
    assert.equal(radiusAt(2 * HALF_HEIGHT, neck), MAX_RADIUS);
    assert.equal(slopeAt(2 * HALF_HEIGHT, neck), 0);
  }
});

test("quantity changes retain a traversable, bounded neck", () => {
  let previousNeck = Infinity;
  for (const count of [1000, 5000, 10000]) {
    const radius = grainBaseRadius(count);
    const neck = neckRadiusFor(count);
    assert.ok(neck <= previousNeck + 1e-12);
    assert.ok(neck > radius * 1.2 && neck < MAX_RADIUS);
    previousNeck = neck;
  }
  for (const count of [0, -1, 1.5, 100001, NaN])
    assert.throws(() => grainBaseRadius(count), RangeError);
});

test("5000 grains start half way up the upper chamber behind a thin, traversable aperture", () => {
  const physics = new Physics(5000);
  let highest = 0;
  let largest = 0;
  for (let i = 0; i < physics.count; i++) {
    highest = Math.max(highest, physics.positions[3 * i + 1] + physics.radii[i]);
    largest = Math.max(largest, physics.radii[i]);
  }
  assert.ok(highest >= 0.45 * HALF_HEIGHT && highest <= 0.55 * HALF_HEIGHT);
  assert.ok(physics.neckRadius <= 0.0016, "aperture remains below 3.2 mm across");
  assert.ok(physics.neckRadius <= 0.065 * MAX_RADIUS, "thin aperture relative to the chamber");
  assert.ok(radiusAt(0.15 * HALF_HEIGHT, physics.neckRadius) >= 1.5 * physics.neckRadius,
    "funnel opens directly above the short throat, not a long tube");
  assert.ok(physics.neckRadius > largest, "largest grain clears the aperture without wall overlap");

  const cellSize = 2 * largest;
  const cells = new Map<string, number[]>();
  for (let i = 0; i < physics.count; i++) {
    const k = 3 * i;
    const cx = Math.floor(physics.positions[k] / cellSize);
    const cy = Math.floor(physics.positions[k + 1] / cellSize);
    const cz = Math.floor(physics.positions[k + 2] / cellSize);
    for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
      const neighbors = cells.get(`${cx + x},${cy + y},${cz + z}`) ?? [];
      for (const j of neighbors) {
        const distance = Math.hypot(
          physics.positions[k] - physics.positions[3 * j],
          physics.positions[k + 1] - physics.positions[3 * j + 1],
          physics.positions[k + 2] - physics.positions[3 * j + 2],
        );
        assert.ok(distance + 1e-8 >= physics.radii[i] + physics.radii[j], "initial grains cannot overlap");
      }
    }
    const key = `${cx},${cy},${cz}`;
    const members = cells.get(key);
    if (members) members.push(i);
    else cells.set(key, [i]);
  }
});

test("standard sand continues through the narrow throat under real gravity", () => {
  const physics = new Physics(5000);
  let previousDischarge = 0;
  for (let step = 1; step <= 360; step++) {
    physics.step([0, -9.81, 0]);
    if (step >= 120 && step % 60 === 0) {
      let discharged = 0;
      for (let i = 0; i < physics.count; i++)
        if (physics.positions[3 * i + 1] < -physics.radii[i]) discharged++;
      assert.ok(discharged > previousDischarge,
        `standard sand keeps flowing at ${step / 120} seconds without a prescribed discharge rate`);
      previousDischarge = discharged;
    }
  }
});

test("initial fill fits the chamber across the supported quantity range", () => {
  for (const count of [1, 2, 3, 10, 100, 1000, 5000, 10000, 20000, 100000]) {
    const physics = new Physics(count);
    let volume = 0;
    for (let i = 0; i < count; i++) {
      const k = 3 * i;
      const radius = physics.radii[i];
      const y = physics.positions[k + 1];
      const slope = slopeAt(y, physics.neckRadius);
      const wallDistance = (radiusAt(y, physics.neckRadius) -
        Math.hypot(physics.positions[k], physics.positions[k + 2])) / Math.hypot(1, slope);
      assert.ok(y - radius >= -1e-8, `upper chamber: ${count} grains`);
      assert.ok(y + radius <= HALF_HEIGHT, `end cap: ${count} grains`);
      assert.ok(wallDistance + 1e-8 >= radius, `side wall: ${count} grains`);
      volume += radius ** 3;
    }
    const expected = count * grainBaseRadius(count) ** 3;
    assert.ok(Math.abs(volume / expected - 1) < 1e-6, "quantity preserves requested material volume");
  }
});
