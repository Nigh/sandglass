import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { MATERIALS, Physics } from "../src/physics.ts";
import { FIXED_DT, HALF_HEIGHT, radiusAt } from "../src/vessel.ts";

// Run with: npm run benchmark -- --output=benchmark-results.json
// Default is 60 actual wall-clock seconds PER count, not a fabricated 60-second simulation.
// This measures the CPU engine used by physics.worker.ts, directly in Node without render/GPU work.
const secondsArgument = process.argv.find((argument) =>
  argument.startsWith("--seconds="),
);
const seconds = secondsArgument
  ? Number(secondsArgument.slice("--seconds=".length))
  : 60;
const outputArgument = process.argv.find((argument) =>
  argument.startsWith("--output="),
);
const outputPath =
  outputArgument?.slice("--output=".length) || "benchmark-results.json";
if (!Number.isFinite(seconds) || seconds <= 0)
  throw new RangeError("--seconds must be positive and finite");
const countsArgument = process.argv.find((argument) => argument.startsWith("--counts="));
const counts = countsArgument ? countsArgument.slice("--counts=".length).split(",").map(Number) : [1000, 5000, 10000];
if (counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 100_000))
  throw new RangeError("--counts requires comma-separated integers from 1 to 100000");

const results = [];
for (const count of counts) {
  const physics = new Physics(count);
  const durations: number[] = [];
  const sceneNames = [
    "downward-pile",
    "zero-g",
    "continuous-flip",
    "high-magnitude",
    "upward-pile",
  ];
  const scenes = sceneNames.map((name) => ({
    name,
    steps: 0,
    cpuMs: 0,
    maxStepMs: 0,
  }));
  const acceleration = [0, -9.81, 0];
  const initialRadii = physics.radii.slice();
  let nonFiniteComponents = 0;
  let boundaryViolations = 0;
  let radiusChanges = 0;
  let sampledStates = 0;
  let minimumWallClearance = Infinity;
  let maximumSpeed = 0;
  let contacts = 0;
  let upper = 0;
  let neighborChecks = 0;
  let activeTotal = 0;
  let sleepingTotal = 0;
  let supportedActiveTotal = 0;
  let statsSamples = 0;
  let lower = 0;
  let minimumUpper = count;
  let maximumUpper = 0;
  let previousMaterial = physics.material;
  const start = performance.now();
  let elapsed = 0;
  while (elapsed < seconds * 1000) {
    const wallSeconds = elapsed / 1000;
    // Two wall-clock seconds per scene, cycling every ten seconds, even on a slow CPU.
    const phase = Math.floor(wallSeconds / 2) % scenes.length;
    const material = Math.floor(wallSeconds / 10) % MATERIALS.length;
    if (material !== previousMaterial) {
      physics.setMaterial(material);
      previousMaterial = material;
    }
    acceleration[0] = acceleration[2] = 0;
    if (phase === 0) acceleration[1] = -9.81;
    else if (phase === 1) acceleration[1] = 0;
    else if (phase === 2) {
      const angle = ((wallSeconds % 2) / 2) * Math.PI;
      acceleration[0] = 9.81 * Math.sin(angle);
      acceleration[1] = -9.81 * Math.cos(angle);
    } else if (phase === 3) {
      acceleration[0] = 35;
      acceleration[1] = -80;
      acceleration[2] = 20;
    } else acceleration[1] = 30;
    physics.step(acceleration);
    durations.push(physics.stats.ms);
    scenes[phase].steps++;
    scenes[phase].cpuMs += physics.stats.ms;
    scenes[phase].maxStepMs = Math.max(
      scenes[phase].maxStepMs,
      physics.stats.ms,
    );
    contacts += physics.stats.contacts;
    neighborChecks += physics.stats.neighborChecks;
    activeTotal += physics.stats.active;
    sleepingTotal += physics.stats.sleeping;
    supportedActiveTotal += physics.stats.supportedActive;
    statsSamples++;
    // Full state scans are separately included in total wall time, not in reported solver-step times.
    if (physics.stats.steps % 12 === 0) {
      sampledStates++;
      upper = lower = 0;
      for (let i = 0; i < count; i++) {
        const k = i * 3;
        const x = physics.positions[k];
        const y = physics.positions[k + 1];
        const z = physics.positions[k + 2];
        const r = physics.radii[i];
        const vx = physics.velocities[k];
        const vy = physics.velocities[k + 1];
        const vz = physics.velocities[k + 2];
        nonFiniteComponents +=
          Number(!Number.isFinite(x)) +
          Number(!Number.isFinite(y)) +
          Number(!Number.isFinite(z)) +
          Number(!Number.isFinite(vx)) +
          Number(!Number.isFinite(vy)) +
          Number(!Number.isFinite(vz));
        if (r !== initialRadii[i]) radiusChanges++;
        const clearance = Math.min(
          HALF_HEIGHT - Math.abs(y) - r,
          radiusAt(y, physics.neckRadius) - Math.hypot(x, z) - r,
        );
        minimumWallClearance = Math.min(minimumWallClearance, clearance);
        if (clearance < -2e-7) boundaryViolations++;
        maximumSpeed = Math.max(maximumSpeed, Math.hypot(vx, vy, vz));
        if (y >= 0) upper++;
        else lower++;
      }
      minimumUpper = Math.min(minimumUpper, upper);
      maximumUpper = Math.max(maximumUpper, upper);
    }
    elapsed = performance.now() - start;
  }
  durations.sort((a, b) => a - b);
  const cpuMs = scenes.reduce((sum, scene) => sum + scene.cpuMs, 0);
  results.push({
    count,
    neckRadiusMetres: physics.neckRadius,
    requestedWallSeconds: seconds,
    actualWallSeconds: elapsed / 1000,
    simulatedSeconds: physics.stats.steps * FIXED_DT,
    steps: physics.stats.steps,
    simulatedToWallRatio: (physics.stats.steps * FIXED_DT) / (elapsed / 1000),
    solverMs: {
      total: cpuMs,
      mean: cpuMs / durations.length,
      p50: durations[Math.floor((durations.length - 1) * 0.5)],
      p95: durations[Math.floor((durations.length - 1) * 0.95)],
      p99: durations[Math.floor((durations.length - 1) * 0.99)],
      max: durations[durations.length - 1],
    },
    physicsBudgetAt60FpsMs: {
      mean: cpuMs / durations.length / FIXED_DT / 60,
      p95: durations[Math.floor((durations.length - 1) * 0.95)] / FIXED_DT / 60,
    },
    scenes,
    activity: {
      active: physics.stats.active,
      sleeping: physics.stats.sleeping,
      supportedActive: physics.stats.supportedActive,
      meanActive: activeTotal / statsSamples,
      meanSleeping: sleepingTotal / statsSamples,
      meanSupportedActive: supportedActiveTotal / statsSamples,
      sleepingFraction: physics.stats.sleeping / count,
      neighborChecks,
      meanNeighborChecksPerStep: neighborChecks / statsSamples,
    },
    stability: {
      sampledStates,
      nonFiniteComponents,
      boundaryViolations,
      radiusChanges,
      conservedParticleCount:
        physics.count === count && physics.positions.length === count * 3,
      minimumWallClearanceMetres: sampledStates ? minimumWallClearance : null,
      maximumSpeedMetresPerSecond: maximumSpeed,
      lastSampleUpperCount: upper,
      lastSampleLowerCount: lower,
      minimumUpperCount: sampledStates ? minimumUpper : null,
      maximumUpperCount: sampledStates ? maximumUpper : null,
      contacts,
      droppedSeconds: physics.stats.dropped,
    },
  });
}
const report = {
  generatedAt: new Date().toISOString(),
  backend: "CPU particle fallback solver used by the browser Web Worker",
  benchmarkExecution:
    "Node main thread; worker transport and rendering are not measured",
  gpuBackend: "not measured by this CPU-only benchmark",
  renderAndGpuMetrics: null,
  clock: "performance.now, milliseconds",
  fixedDtSeconds: FIXED_DT,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
  },
  results,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(outputPath, json, "utf8");
process.stdout.write(json);
if (
  results.some(
    (result) =>
      result.stability.nonFiniteComponents ||
      result.stability.boundaryViolations ||
      result.stability.radiusChanges,
  )
) {
  process.exitCode = 1;
}
