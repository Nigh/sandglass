import assert from "node:assert/strict";
import test from "node:test";
import {
  HALF_HEIGHT,
  MAX_RADIUS,
  grainBaseRadius,
  neckRadiusFor,
  radiusAt,
  slopeAt,
} from "../src/vessel.ts";

test("shared profile is smooth, symmetric and has the requested aperture", () => {
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
      const delta = 1e-7;
      const numerical = (radiusAt(y + delta, neck) - radiusAt(y - delta, neck)) / (2 * delta);
      assert.ok(Math.abs(numerical - slopeAt(y, neck)) < 2e-6);
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
