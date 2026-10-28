import assert from "node:assert/strict";
import test from "node:test";
import { MATERIALS, Physics } from "../src/physics.ts";
import {
  FIXED_DT,
  HALF_HEIGHT,
  MAX_RADIUS,
  neckRadiusFor,
  radiusAt,
  slopeAt,
} from "../src/vessel.ts";

// Closed-system mechanics are checked without environmental air forces.
function vacuum(count:number,material=1,neckRadius=neckRadiusFor(count)):Physics {
  return new Physics(count,material,neckRadius,0);
}

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
      Math.hypot(x, z) + radius <= radiusAt(y, physics.neckRadius) + 2e-7,
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
  const neck = neckRadiusFor(1000);
  assert.equal(radiusAt(0, neck), neck);
  assert.equal(radiusAt(HALF_HEIGHT, neck), MAX_RADIUS);
  assert.equal(radiusAt(-HALF_HEIGHT, neck), MAX_RADIUS);
  for (let i = 0; i <= 100; i++) {
    const y = (i / 100) * HALF_HEIGHT;
    assert.equal(radiusAt(y, neck), radiusAt(-y, neck));
    assert.ok(radiusAt(y, neck) >= neck && radiusAt(y, neck) <= MAX_RADIUS);
  }
  assert.ok(Math.abs((radiusAt(1e-6, neck) - radiusAt(0, neck)) / 1e-6) < 1e-4);
});

test("true acceleration magnitude is preserved, without default gravity", () => {
  const slow = vacuum(1);
  const fast = vacuum(1);
  isolate(slow);
  isolate(fast);
  slow.step([0, -2, 0]);
  fast.step([0, -8, 0]);
  assert.ok(Math.abs(slow.velocities[1] + 2 * FIXED_DT) < 1e-8);
  assert.ok(Math.abs(fast.velocities[1] / slow.velocities[1] - 4) < 1e-6);
  const zero = vacuum(1);
  isolate(zero);
  zero.step([0, 0, 0]);
  assert.deepEqual([...zero.positions], [0, 0, 0]);
  assert.deepEqual([...zero.velocities], [0, 0, 0]);
});

test("zero gravity preserves inertia without global damping or artificial settling", () => {
  const physics = vacuum(1);
  isolate(physics);
  physics.positions[1] = HALF_HEIGHT * 0.6;
  physics.velocities.set([0.03, 0.01, -0.02]);
  const velocity = physics.velocities.slice();
  for (let i = 0; i < 20; i++) physics.step([0, 0, 0]);
  assert.deepEqual(physics.velocities, velocity);
  assert.ok(
    Math.abs(physics.positions[0] - velocity[0] * FIXED_DT * 20) < 1e-7,
  );
  assert.ok(
    Math.abs(physics.positions[1] - (HALF_HEIGHT * 0.6 + velocity[1] * FIXED_DT * 20)) <
      2e-7,
  );
});

test("size-weighted collision conserves momentum and never adds kinetic energy", () => {
  const physics = vacuum(2, 2);
  const halfDistance = (physics.radii[0] + physics.radii[1]) * 0.495;
  const massB = (physics.radii[1] / physics.radii[0]) ** 3;
  physics.positions.set([-halfDistance, HALF_HEIGHT * 0.6, 0, halfDistance, HALF_HEIGHT * 0.6, 0]);
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

test("nonpenetrating contact skins apply Coulomb friction, not frictionless support",()=>{
  const pair=vacuum(2,3);
  const separation=pair.radii[0]+pair.radii[1]+Math.min(...pair.radii)*.015;
  pair.positions.set([0,HALF_HEIGHT*.6,0,separation,HALF_HEIGHT*.6,0]);
  pair.velocities.set([.001,.02,0,-.001,-.02,0]);
  pair.step([0,0,0]);
  assert.ok(Math.abs(pair.velocities[1]-pair.velocities[4])<.04-.0004,"a supported skin contact must dissipate tangential slip");
  const floor=vacuum(1,3);
  floor.positions.set([0,-HALF_HEIGHT+floor.radii[0]*1.03,0]);
  floor.velocities.set([.02,-.001,0]);
  floor.step([0,0,0]);
  assert.ok(floor.velocities[0]<.0198,"wall skin contact needs friction before penetration");
  assert.ok(Math.abs(floor.velocities[1])<1e-6);
});

test("slow air-damped motion on a steep wall cannot be mistaken for static support",()=>{
  const physics=new Physics(1);
  const y=HALF_HEIGHT*.7,slope=slopeAt(y,physics.neckRadius);
  physics.positions.set([radiusAt(y,physics.neckRadius)-physics.radii[0]*Math.hypot(1,slope),y,0]);
  physics.velocities.fill(0);
  for(let i=0;i<60;i++)physics.step([0,-.06,0]);
  const height=physics.positions[1];
  for(let i=0;i<60;i++)physics.step([0,-.06,0]);
  assert.equal(physics.stats.sleeping,0,"touching a wall outside its Coulomb support cone is not rest");
  assert.ok(physics.positions[1]<height-1e-5,"a terminal drift must continue instead of freezing");
  assertContained(physics);
});

test("fixed accumulator is independent of render cadence and reports dropped seconds", () => {
  const a = vacuum(1);
  const b = vacuum(1);
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
  const physics = vacuum(1000);
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
  const fine = vacuum(1, 0);
  const crystal = vacuum(1, 3);
  for (const physics of [fine, crystal]) {
    physics.positions.set([0, -HALF_HEIGHT + physics.radii[0], 0]);
    physics.velocities.set([2, -1, 0]);
    physics.step([0, 0, 0], 0.001);
    assertContained(physics);
    assert.ok(physics.stats.contacts > 0);
  }
  assert.ok(Math.abs(crystal.velocities[0]) < Math.abs(fine.velocities[0]));
});

test("more particles add real sand volume", () => {
  const volumes = [1000, 5000, 10000].map((count) => {
    const physics = vacuum(count);
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
  assert.ok(volumes[1]>volumes[0]);
  assert.ok(volumes[2]>volumes[1]);
});

test("local wall sweeps contain a high-speed grain without global CFL subdivisions", () => {
  const physics = vacuum(1);
  physics.positions.set([0, HALF_HEIGHT * 0.6, 0]);
  physics.velocities.set([30, -60, 20]);
  for (let i = 0; i < 20; i++) {
    physics.step([80, -150, -40]);
    assertContained(physics);
    assert.equal(physics.stats.substeps, 4);
  }
});

test("long run keeps every grain through zero-g, flips, high force, and both piles", () => {
  const physics = vacuum(180);
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
  const physics = vacuum(25, 3);
  const initial = physics.positions.slice();
  physics.step([5, -20, 3]);
  physics.reset();
  assert.deepEqual(physics.positions, initial);
  assert.ok(physics.velocities.every((value) => value === 0));
  assert.equal(physics.material, 3);
  assert.equal(physics.stats.steps, 0);
  assert.throws(() => vacuum(0), RangeError);
  assert.throws(() => physics.setMaterial(4), RangeError);
  assert.throws(() => physics.step([NaN, 0, 0]), RangeError);
  assert.throws(() => physics.advance(-1, [0, 0, 0]), RangeError);
  const positions = physics.positions.slice();
  assert.throws(() => physics.step([1e300, 0, 0]), /safety budget/);
  assert.deepEqual(physics.positions, positions);
});

test("finite extreme input is rejected before a local wall sweep can exhaust the CPU", () => {
  const physics = vacuum(1);
  const positions = physics.positions.slice();
  const velocities = physics.velocities.slice();
  assert.throws(() => physics.step([1e6, 0, 0]), /wall sweep safety budget/);
  assert.deepEqual(physics.positions, positions);
  assert.deepEqual(physics.velocities, velocities);
  assert.equal(physics.stats.steps, 0);
  physics.velocities.set([1e5, 0, 0]);
  const fast = physics.velocities.slice();
  assert.throws(() => physics.step([0, 0, 0]), /wall sweep safety budget/);
  assert.deepEqual(physics.positions, positions);
  assert.deepEqual(physics.velocities, fast);
  assert.equal(physics.stats.steps, 0);
});

test("only supported, quiet grains sleep after at least 0.25 seconds", () => {
  const physics = vacuum(1);
  physics.positions.set([0, -HALF_HEIGHT + physics.radii[0], 0]);
  physics.velocities.fill(0);
  for (let i = 0; i < 29; i++) physics.step([0, -9.81, 0]);
  assert.equal(physics.stats.sleeping, 0);
  for (let i = 0; i < 90; i++) physics.step([0, -9.81, 0]);
  assert.equal(physics.stats.sleeping, 1);
  assert.equal(physics.stats.active, 0);
  const settled = physics.positions.slice();
  physics.step([0, -9.81, 0]);
  assert.deepEqual(physics.positions, settled);
  assert.equal(physics.stats.neighborChecks, 0);
  assert.equal(physics.stats.contacts, 0);

  const airborne = vacuum(1);
  airborne.positions.set([0, HALF_HEIGHT * 0.6, 0]);
  airborne.velocities.fill(0);
  for (let i = 0; i < 120; i++) airborne.step([0, 0, 0]);
  assert.equal(airborne.stats.sleeping, 0);
  assert.equal(airborne.stats.active, 1);
});

test("removing a sleeping support wakes its dependent grain without an airborne freeze", () => {
  const physics = vacuum(2);
  const bottom = -HALF_HEIGHT + physics.radii[0];
  physics.positions.set([0, bottom, 0, 0, bottom + physics.radii[0] + physics.radii[1], 0]);
  physics.velocities.fill(0);
  for (let i = 0; i < 240; i++) physics.step([0, -9.81, 0]);
  assert.equal(physics.stats.sleeping, 2);
  const height = physics.positions[4];
  physics.positions[0] = MAX_RADIUS * 0.6;
  physics.step([0, -9.81, 0]);
  assert.ok(physics.stats.active >= 1);
  for (let i = 0; i < 8; i++) physics.step([0, -9.81, 0]);
  assert.ok(physics.positions[4] < height - 0.001);
  assertContained(physics);
});

test("a moving grain collides with and wakes a sleeper still present in the grid", () => {
  const physics = vacuum(2);
  physics.positions.set([
    -MAX_RADIUS * 0.3, -HALF_HEIGHT + physics.radii[0], 0,
    MAX_RADIUS * 0.3, -HALF_HEIGHT + physics.radii[1], 0,
  ]);
  physics.velocities.fill(0);
  for (let i = 0; i < 180; i++) physics.step([0, -9.81, 0]);
  assert.equal(physics.stats.sleeping, 2);
  physics.velocities[0] = 2;
  let wokeOnImpact = false;
  for (let i = 0; i < 10; i++) {
    physics.step([0, -9.81, 0]);
    if (physics.velocities[3] > 0.01) wokeOnImpact = true;
    assert.equal(physics.stats.substeps, 4);
    assertContained(physics);
  }
  assert.ok(wokeOnImpact);
});

test("a gentle fine-sand impact wakes its sleeping support instead of freezing the bed",()=>{
  const physics=vacuum(2);
  physics.positions.set([-MAX_RADIUS*.3,-HALF_HEIGHT+physics.radii[0],0,MAX_RADIUS*.3,-HALF_HEIGHT+physics.radii[1],0]);
  physics.velocities.fill(0);
  for(let i=0;i<180;i++)physics.step([0,-9.81,0]);
  assert.equal(physics.stats.sleeping,2);
  physics.positions[3]=physics.positions[0];
  physics.positions[4]=physics.positions[1]+physics.radii[0]+physics.radii[1]+1e-5;
  physics.velocities[4]=-.035;
  physics.step([0,-9.81,0]);
  assert.equal(physics.stats.active,2,"even sub-0.12 m/s impacts must update the receiving grain");
  assertContained(physics);
});

test("small floor tilt is resisted by displacement friction before sleeping", () => {
  const physics = vacuum(1, 1);
  physics.positions.set([0, -HALF_HEIGHT + physics.radii[0], 0]);
  physics.velocities.fill(0);
  for (let i = 0; i < 180; i++) physics.step([0.4, -9.81, 0]);
  assert.ok(Math.abs(physics.positions[0]) < physics.radii[0] * 0.1);
  assert.equal(physics.stats.sleeping, 1);
});

test("gravity reversal and zero gravity wake supported sleepers while preserving zero-g inertia", () => {
  const physics = vacuum(1);
  const settle = () => {
    physics.positions.set([0, -HALF_HEIGHT + physics.radii[0], 0]);
    physics.velocities.fill(0);
    for (let i = 0; i < 120; i++) physics.step([0, -9.81, 0]);
    assert.equal(physics.stats.sleeping, 1);
  };
  settle();
  const bottom = physics.positions[1];
  physics.step([0, 9.81, 0]);
  assert.equal(physics.stats.active, 1);
  assert.ok(physics.velocities[1] > 0.08);
  assert.ok(physics.positions[1] > bottom);
  settle();
  physics.step([0, 0, 0]);
  assert.equal(physics.stats.sleeping, 0);
  physics.velocities.set([0, 0.03, 0]);
  const velocity = physics.velocities.slice();
  for (let i = 0; i < 20; i++) physics.step([0, 0, 0]);
  assert.deepEqual(physics.velocities, velocity);
  assert.equal(physics.stats.active, 1);
});

test("a localized fine-sand pour forms a resting cone and resists a small tilt", () => {
  // A free-falling, staggered column isolates deposition from the slow throat.
  // Only initial positions are sampled; every subsequent position is integrated.
  const physics = new Physics(1000);
  const spacing=Math.max(...physics.radii)*2.01;
  const row=spacing*Math.sqrt(3)/2;
  let grain=0, layer=0;
  for(let y=-HALF_HEIGHT+Math.max(...physics.radii)*5;grain<physics.count;y+=spacing*Math.sqrt(2/3),layer++){
    for(let iz=-3;iz<=3&&grain<physics.count;iz++)
      for(let ix=-3;ix<=3&&grain<physics.count;ix++){
        const x=(ix+(iz&1)*.5+(layer&1)*.5)*spacing;
        const z=iz*row+(layer&1)*row/3;
        if(x*x+z*z>(MAX_RADIUS*.24)**2)continue;
        physics.positions.set([x,y,z],grain*3);
        grain++;
      }
  }
  physics.velocities.fill(0);
  assertContained(physics);
  const radii = physics.radii.slice();
  for (let i = 0; i < 1200; i++) physics.step([0, -9.81, 0]);
  const surface = () => {
    let lowerCount=0,centerX=0,centerZ=0;
    for(let i=0;i<physics.count;i++){
      if(physics.positions[i*3+1]>=0)continue;
      lowerCount++;centerX+=physics.positions[i*3];centerZ+=physics.positions[i*3+2];
    }
    assert.ok(lowerCount>=physics.count*.9,"the deposition fixture must remain in the lower chamber");
    centerX/=lowerCount;centerZ/=lowerCount;
    // The pour leaves a central plateau. Measure the outer half of the actual
    // footprint, not fixed vessel radii that can land entirely on that plateau.
    let footprint=0;
    for(let i=0;i<physics.count;i++){
      if(physics.positions[i*3+1]>=0)continue;
      footprint=Math.max(footprint,Math.hypot(physics.positions[i*3]-centerX,physics.positions[i*3+2]-centerZ));
    }
    const heights=new Float64Array(6).fill(-Infinity);
    const populations=new Uint32Array(6);
    const binWidth=footprint/(heights.length*2);
    for(let i=0;i<physics.count;i++){
      const k=i*3;
      if(physics.positions[k+1]>=0)continue;
      const radius=Math.hypot(physics.positions[k]-centerX,physics.positions[k+2]-centerZ);
      const bin=Math.min(heights.length-1,Math.floor((radius-footprint*.5)/binWidth));
      if(bin<0||bin>=heights.length)continue;
      populations[bin]++;
      heights[bin]=Math.max(heights[bin],physics.positions[k+1]+physics.radii[i]);
    }
    assert.ok(populations.every(n=>n>=3),"the heap must populate the measured flank");
    const mean=heights.reduce((sum,h)=>sum+h,0)/heights.length;
    let cross=0,xx=0,yy=0;
    for(let bin=0;bin<heights.length;bin++){
      const x=(bin-(heights.length-1)/2)*binWidth,y=heights[bin]-mean;
      cross+=x*y;xx+=x*x;yy+=y*y;
    }
    const angle=Math.atan(-cross/xx)*180/Math.PI;
    assert.ok(angle>=12&&angle<=55,`granular flank angle ${angle}°, not a flat fluid layer or vertical column`);
    assert.ok(cross*cross/(xx*yy)>.65,"a conical flank must decrease consistently with radius");
  };
  surface();
  assert.ok(physics.stats.sleeping > physics.count / 3, "resting pile needs genuine sleeping contacts");
  const meanSpeedSquared = physics.velocities.reduce((sum, velocity) => sum + velocity * velocity, 0) / physics.count;
  assert.ok(meanSpeedSquared < 0.012 ** 2, "discharge motion must dissipate through contacts before tilt");
  const before = physics.positions.reduce((sum, value, index) => sum + (index % 3 === 0 ? value : 0), 0) / physics.count;
  // About 4.7 degrees: enough to wake the solver, well inside this material's
  // static friction cone. No preset surface or artificial grain placement follows.
  for (let i = 0; i < 240; i++) physics.step([0.8, -9.81, 0]);
  const after = physics.positions.reduce((sum, value, index) => sum + (index % 3 === 0 ? value : 0), 0) / physics.count;
  assert.ok(Math.abs(after - before) < 0.006, "small tilt must not liquefy the heap");
  surface();
  assertContained(physics);
  assert.deepEqual(physics.radii, radii);
  assert.equal(physics.stats.active + physics.stats.sleeping, physics.count);
});

test("local porous-bed resistance slows contacting samples but preserves acceleration amplitude",()=>{
  const samples=[new Physics(3),new Physics(3),new Physics(3)];
  for(const physics of samples){
    physics.positions.set([-physics.radii[0]-physics.radii[1],0,0,0,0,0,physics.radii[1]+physics.radii[2],0,0]);
    physics.velocities.fill(0);
    physics.step([0,0,0]);
  }
  const [slow,fast,zero]=samples;
  slow.step([0,-9.81,0]);
  fast.step([0,-19.62,0]);
  zero.step([0,0,0]);
  assert.ok(Math.abs(slow.velocities[4])<9.81*FIXED_DT*.5,"contacting bed must exert a real resisting force");
  assert.ok(Math.abs(fast.velocities[4])>Math.abs(slow.velocities[4])*1.5,"larger measured acceleration must still drive faster motion");
  assert.ok(zero.velocities.every((v,i)=>i%3!==1||v===0),"resistance cannot manufacture downward motion");
  assert.ok(Math.hypot(...zero.velocities)<1e-6,"contact stabilization must not inject appreciable energy");
  const isolated=new Physics(1);
  const outside=new Physics(1);
  isolate(isolated);isolate(outside);
  outside.positions[1]=HALF_HEIGHT*.6;
  isolated.velocities.set([.02,0,0]);outside.velocities.set([.02,0,0]);
  for(let i=0;i<20;i++){isolated.step([0,0,0]);outside.step([0,0,0]);}
  assert.deepEqual(isolated.velocities,outside.velocities,"an isolated neck sample has ambient drag, not porous-bed drag");
  assert.ok(isolated.velocities[0]>0&&isolated.velocities[0]<.02,"air dissipates momentum without manufacturing a fixed velocity");
  isolated.setAirResistance(false);
  const carried=isolated.velocities.slice();
  for(let i=0;i<20;i++)isolated.step([0,0,0]);
  assert.deepEqual(isolated.velocities,carried,"disabling air preserves current inertia without resetting grains");
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
