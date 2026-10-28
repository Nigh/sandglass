import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { Physics } from "../src/physics.ts";
import { FIXED_DT, HALF_HEIGHT, MAX_RADIUS, MICRO_GRAIN_DIAMETER, ambientDragRate, bedDragRate, estimatedDurationSeconds, grainBaseRadius, neckRadiusFor, radiusAt } from "../src/vessel.ts";

// npx tsx scripts/flow-benchmark.ts --counts=1000,5000,10000 --seconds=300 --neck-scale=1 --output=flow-results.json
// --seconds is simulated time, not a wall-clock budget. No particles are injected or recycled.
const options = new Map<string, string>();
let verifyTarget=false;
for (const argument of process.argv.slice(2)) {
  if(argument==="--verify-target"){verifyTarget=true;continue;}
  const match = /^--(counts|seconds|neck-scale|neck-scales|output)=(.+)$/.exec(argument);
  if (!match) throw new Error(`Unknown or empty option: ${argument}`);
  options.set(match[1], match[2]);
}
const counts = (options.get("counts") ?? "1000,5000,10000").split(",").map(Number);
for (const count of counts) grainBaseRadius(count);
const seconds = Number(options.get("seconds") ?? 300);
const neckScales = (options.get("neck-scales")??options.get("neck-scale")??"1").split(",").map(Number);
if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isSafeInteger(Math.ceil(seconds / FIXED_DT)))
  throw new RangeError("--seconds must be positive, finite and fit a safe step count");
if (neckScales.some(scale=>!Number.isFinite(scale)||scale<=0))
  throw new RangeError("--neck-scale must be positive and finite");
const outputPath = options.get("output") ?? "flow-benchmark-results.json";
const sampleSteps = Math.round(1 / FIXED_DT);
const requestedSteps = Math.ceil(seconds / FIXED_DT);
const acceleration = [0, -9.81, 0];
const stalledWindowSeconds = 30;

/** Surface envelope of nearly resting lower grains; not an assertion that a cone formed. */
function pileAngle(physics: Physics) {
  const binCount = 32;
  const heights = new Float64Array(binCount).fill(-Infinity);
  const populations = new Uint32Array(binCount);
  for (let i = 0; i < physics.count; i++) {
    const p = i * 3;
    const y = physics.positions[p + 1];
    const radius = physics.radii[i];
    if (y >= 0 || Math.hypot(physics.velocities[p], physics.velocities[p + 1], physics.velocities[p + 2]) > 0.03) continue;
    if (y + radius <= -HALF_HEIGHT + 2 * radius) continue;
    const radial = Math.hypot(physics.positions[p], physics.positions[p + 2]);
    const bin = Math.min(binCount - 1, Math.floor(radial / MAX_RADIUS * binCount));
    heights[bin] = Math.max(heights[bin], y + radius);
    populations[bin]++;
  }
  const surface = [];
  for (let bin = 1; bin < binCount - 1; bin++) {
    if (populations[bin] >= 3)
      surface.push({ radiusMetres: (bin + 0.5) * MAX_RADIUS / binCount, heightMetres: heights[bin], grains: populations[bin] });
  }
  let angleDegrees: number | null = null;
  let rSquared: number | null = null;
  if (surface.length >= 3) {
    const meanRadius = surface.reduce((sum, point) => sum + point.radiusMetres, 0) / surface.length;
    const meanHeight = surface.reduce((sum, point) => sum + point.heightMetres, 0) / surface.length;
    let covariance = 0;
    let radiusVariance = 0;
    let heightVariance = 0;
    for (const point of surface) {
      const x = point.radiusMetres - meanRadius;
      const y = point.heightMetres - meanHeight;
      covariance += x * y;
      radiusVariance += x * x;
      heightVariance += y * y;
    }
    angleDegrees = Math.atan(-covariance / radiusVariance) * 180 / Math.PI;
    rSquared = heightVariance > 0 ? covariance ** 2 / (radiusVariance * heightVariance) : null;
  }
  return { angleDegrees, rSquared, surface };
}

const results = [];
for (const neckScale of neckScales) for (const count of counts) {
  const neckRadius = neckRadiusFor(count) * neckScale;
  if (neckRadius >= MAX_RADIUS)
    throw new RangeError(`Scaled neck radius must be below MAX_RADIUS (count=${count})`);
  const physics = new Physics(count, 1, neckRadius);
  const initialRadii = physics.radii.slice();
  const observedBelow = new Uint8Array(count);
  const thresholds = [0.1, 0.5, 0.9, 0.95] as const;
  const crossingTimes: (number | null)[] = thresholds.map(() => null);
  let crossed = 0;
  let upper = 0;
  let lower = 0;
  let lastOutflowSeconds: number | null = null;
  let firstAllBelowSeconds: number | null = null;
  let longestFlowGapSeconds=0;
  let nonFiniteComponents = 0;
  let boundaryViolations = 0;
  let radiusChanges = 0;
  let countViolations = 0;
  let minimumWallClearance = Infinity;
  let contacts = 0;
  let neighborChecks = 0;
  let bulkIntegrated=0,bulkPairSkips=0,islandSplits=0;
  let solverMs = 0;
  let maxStepMs = 0;
  let initialUpperCount = 0;
  let initialLowerCount = 0;
  let smallestRadius = Infinity;
  let largestRadius = 0;
  let grainsTooWideForNeck = 0;
  let initialGrainVolume = 0;
  for (const radius of initialRadii) {
    smallestRadius = Math.min(smallestRadius, radius);
    largestRadius = Math.max(largestRadius, radius);
    grainsTooWideForNeck += Number(radius >= physics.neckRadius);
    initialGrainVolume += (4 / 3) * Math.PI * radius ** 3;
  }
  const samples: {
    simulatedSeconds: number;
    upper: number;
    lower: number;
    firstObservedBelow: number;
    active: number;
    sleeping: number;
    sleepingFraction: number;
    supportedActive: number;
  }[] = [];
  function sample(simulatedSeconds: number) {
    upper = lower = 0;
    const previousCrossed = crossed;
    for (let i = 0; i < count; i++) {
      const p = i * 3;
      const x = physics.positions[p];
      const y = physics.positions[p + 1];
      const z = physics.positions[p + 2];
      const radius = physics.radii[i];
      for (let axis = 0; axis < 3; axis++) {
        nonFiniteComponents += Number(!Number.isFinite(physics.positions[p + axis]));
        nonFiniteComponents += Number(!Number.isFinite(physics.velocities[p + axis]));
      }
      if (!Number.isFinite(radius)) nonFiniteComponents++;
      if (radius !== initialRadii[i]) radiusChanges++;
      const clearance = Math.min(HALF_HEIGHT - Math.abs(y) - radius, radiusAt(y, physics.neckRadius) - Math.hypot(x, z) - radius);
      minimumWallClearance = Math.min(minimumWallClearance, clearance);
      if (clearance < -2e-7) boundaryViolations++;
      if (y >= 0) upper++;
      else if (y < 0) {
        lower++;
        if (!observedBelow[i]) {
          observedBelow[i] = 1;
          crossed++;
        }
      }
    }
    if (crossed > previousCrossed) lastOutflowSeconds = simulatedSeconds;
    if(crossed<count*.95)longestFlowGapSeconds=Math.max(longestFlowGapSeconds,simulatedSeconds-(lastOutflowSeconds??0));
    if (physics.count !== count || physics.positions.length !== count * 3 || physics.velocities.length !== count * 3 || physics.radii.length !== count || upper + lower !== count)
      countViolations++;
    if (simulatedSeconds === 0) {
      initialUpperCount = upper;
      initialLowerCount = lower;
    } else {
      for (let index = 0; index < thresholds.length; index++)
        if (crossingTimes[index] === null && crossed >= Math.ceil(count * thresholds[index]))
          crossingTimes[index] = simulatedSeconds;
      if (lower === count && firstAllBelowSeconds === null) firstAllBelowSeconds = simulatedSeconds;
    }
    samples.push({
      simulatedSeconds, upper, lower, firstObservedBelow: crossed,
      active: physics.stats.active, sleeping: physics.stats.sleeping,
      sleepingFraction: physics.stats.sleeping / count,
      supportedActive: physics.stats.supportedActive,
    });
  }
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  sample(0);
  for (let step = 1; step <= requestedSteps; step++) {
    physics.step(acceleration, FIXED_DT);
    solverMs += physics.stats.ms;
    maxStepMs = Math.max(maxStepMs, physics.stats.ms);
    contacts += physics.stats.contacts;
    neighborChecks += physics.stats.neighborChecks;
    bulkIntegrated+=physics.stats.bulkIntegrated;
    bulkPairSkips+=physics.stats.bulkPairSkips;
    islandSplits+=physics.stats.islandSplits;
    if (step % sampleSteps === 0 || step === requestedSteps) sample(step * FIXED_DT);
  }
  const pile = pileAngle(physics);
  const wallSeconds = (performance.now() - wallStart) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  const simulatedSeconds = requestedSteps * FIXED_DT;
  const noObservedOutflowSeconds = simulatedSeconds - (lastOutflowSeconds ?? 0);
  const status = lower === count ? "drained" : noObservedOutflowSeconds >= stalledWindowSeconds ? "stalled" : "incomplete";
  const stable = !nonFiniteComponents && !boundaryViolations && !radiusChanges && !countViolations && initialUpperCount === count && initialLowerCount === 0;
  const durationTargetPassed=stable&&status==="drained"&&crossingTimes[3]!==null&&crossingTimes[3]>=60&&longestFlowGapSeconds<=10;
  results.push({
    count,
    status,
    durationTargetPassed,
    longestFlowGapSeconds,
    microGrainDiameterMetres:MICRO_GRAIN_DIAMETER,
    roughDurationEstimateSeconds:estimatedDurationSeconds(count),
    neckDragRatePerSecond:bedDragRate(1700),
    ambientDragRatePerSecond:ambientDragRate(1700),
    statusReason: status === "drained" ? "Every grain is below y=0 at the final sample" : status === "stalled" ? `Grains remain above y=0 with no newly observed crossing for at least ${stalledWindowSeconds} simulated seconds` : "Requested simulated time ended before all grains reached the lower chamber",
    material: "standard sand",
    accelerationMetresPerSecondSquared: acceleration,
    requestedSimulatedSeconds: seconds,
    simulatedSeconds,
    wallSeconds,
    realCpuSeconds: (cpu.user + cpu.system) / 1e6,
    cpuUserSeconds: cpu.user / 1e6,
    cpuSystemSeconds: cpu.system / 1e6,
    simulatedToWallRatio: simulatedSeconds / wallSeconds,
    steps: requestedSteps,
    neckScale,
    neckRadiusMetres: physics.neckRadius,
    neckDiameterMetres: physics.neckRadius * 2,
    neckDiameterToMeanGrainDiameter: physics.neckRadius / grainBaseRadius(count),
    smallestGrainRadiusMetres: smallestRadius,
    largestGrainRadiusMetres: largestRadius,
    grainsTooWideForNeck,
    openingWarning: grainsTooWideForNeck ? "Some grains cannot pass the neck geometrically; no recycling or forced release is applied" : "Geometric clearance does not rule out frictional arching",
    flow: {
      initialUpperCount, initialLowerCount, upperCount: upper, lowerCount: lower,
      firstObservedBelowCount: crossed,
      t10Seconds: crossingTimes[0], t50Seconds: crossingTimes[1],
      t90Seconds: crossingTimes[2], t95Seconds: crossingTimes[3],
      lastObservedOutflowSeconds: lastOutflowSeconds,
      firstAllBelowSeconds,
      noObservedOutflowSeconds,
    },
    activity: {
      active: physics.stats.active, sleeping: physics.stats.sleeping,
      sleepingFraction: physics.stats.sleeping / count,
      supportedActive: physics.stats.supportedActive,
      meanSampledSleepingFraction: samples.reduce((sum, entry) => sum + entry.sleepingFraction, 0) / samples.length,
      meanSampledSupportedActive: samples.reduce((sum, entry) => sum + entry.supportedActive, 0) / samples.length,
      neighborChecks, contacts,
      islands:physics.stats.islands,clustered:physics.stats.clustered,
      bulkIntegrated,bulkPairSkips,islandSplits,
    },
    pile,
    solverMs: { total: solverMs, mean: solverMs / requestedSteps, max: maxStepMs },
    stability: {
      passed: stable, sampledStates: samples.length, nonFiniteComponents,
      boundaryViolations, radiusChanges, countViolations,
      initialGrainVolumeCubicMetres: initialGrainVolume,
      conservedParticleCountAndRadii: !countViolations && !radiusChanges,
      minimumWallClearanceMetres: minimumWallClearance,
      droppedSeconds: physics.stats.dropped,
    },
    samples,
  });
  process.stderr.write(`${count}: ${status}; simulated=${simulatedSeconds.toFixed(3)}s wall=${wallSeconds.toFixed(3)}s lower=${lower}/${count}\n`);
}
const report = {
  generatedAt: new Date().toISOString(),
  backend: "CPU particle solver, standard sand under fixed 1 g; no rendering or worker transport",
  model:"coarse fine-sand volume samples + PBD Coulomb friction + adaptive translation/sleep islands + ambient Stokes and local Darcy-inspired resistance; no gas pressure/velocity solver",
  fixedDtSeconds: FIXED_DT,
  sampling: {
    intervalSimulatedSeconds: sampleSteps * FIXED_DT,
    crossings: "Each grain counts once when first observed below y=0; times are upper sample bounds, quantized to at most one simulated second. Crossings that return above y=0 between samples are not observed.",
    stability: "Full particle scans at t=0, each simulated second, and the final step; not every step",
    stalledWindowSeconds,
    pile: "Linear fit of radial top-surface bins for lower grains moving at <=0.03 m/s; excludes floor-touching grains, central bin, outer bin and bins with <3 grains. Positive angle means height decreases outward; null means insufficient data. This measurement alone does not establish a stable cone.",
  },
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  results,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(outputPath, json, "utf8");
process.stdout.write(json);
if (results.some((result) => !result.stability.passed||(verifyTarget&&!result.durationTargetPassed))) process.exitCode = 1;
