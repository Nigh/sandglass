import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// Bounded cone-retention experiment, not a measured angle-of-repose calibration.
const browser = await chromium.launch({ headless: true, args: ["--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"] });
try {
  const page = await browser.newPage();
  await page.addInitScript({ content: "globalThis.__name = value => value;" });
  const base = process.env.BASE_URL ?? "http://localhost:5177";
  await page.route(base + "/probe", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Granular probe</title>" }));
  await page.goto(base + "/probe");
  const result = await page.evaluate(async ({ base, performanceOnly }) => {
    const { Physics } = await import(base + "/src/physics.ts");
    const { GpuPhysics } = await import(base + "/src/gpu-physics.ts");
    const { HALF_HEIGHT, FIXED_DT, radiusAt } = await import(base + "/src/vessel.ts");
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw Error("WebGPU adapter unavailable");
    const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [] });
    const errors: string[] = [];
    device.addEventListener("uncapturederror", event => errors.push(event.error.message));
    const cases = [];
    for (const material of (performanceOnly ? [1] : [0, 3])) {
      const radius = 0.00065, spacing = radius * 2.08, height = 0.012, width = 0.018;
      const points: number[] = [];
      for (let layer = 0; radius + layer * spacing * Math.sqrt(2 / 3) < height; layer++) {
        const y = radius + layer * spacing * Math.sqrt(2 / 3);
        for (let row = -16; row <= 16; row++) {
          const z = row * spacing * Math.sqrt(3) / 2 + (layer % 2) * spacing / (2 * Math.sqrt(3));
          for (let column = -16; column <= 16; column++) {
            const x = column * spacing + ((row & 1) + (layer % 2)) * spacing / 2;
            if (Math.hypot(x, z) < width * (1 - y / height)) points.push(x, -HALF_HEIGHT + y, z);
          }
        }
      }
      let initial = new Float32Array(points);
      let radii = new Float32Array(points.length / 3).fill(radius);
      if (performanceOnly) {
        const seed = new Physics(1000);
        initial = seed.positions.slice();
        radii = seed.radii;
        for (let i = 0; i < radii.length; i++) initial[i * 3 + 1] *= -1;
      }
      const buffer = device.createBuffer({ size: radii.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const simulation = await GpuPhysics.create(device, buffer, initial, radii, 0.001575, material, false);
      const start = performance.now();
      const timings: number[] = [], early: number[] = [];
      const steps = performanceOnly ? 720 : 360;
      for (let step = 0; step < steps; step++) {
        while (simulation.pending) await device.queue.onSubmittedWorkDone();
        simulation.advance(FIXED_DT, [0, -9.81, 0]);
        await device.queue.onSubmittedWorkDone();
        if (Number.isFinite(simulation.stats.gpuMs)) {
          if (step < 120) early.push(simulation.stats.gpuMs);
          if (step >= steps - 120) timings.push(simulation.stats.gpuMs);
        }
      }
      const state = await simulation.snapshot();
      let peak = 0, radialRms = 0, speedSquared = 0, initialPeak = 0;
      let nonFinite = 0, boundaryViolations = 0;
      for (let i = 0; i < radii.length; i++) {
        for (let axis = 0; axis < 3; axis++) {
          speedSquared += state.velocities[i * 3 + axis] ** 2;
          if (!Number.isFinite(state.positions[i * 3 + axis]) || !Number.isFinite(state.velocities[i * 3 + axis])) nonFinite++;
        }
        const y = state.positions[i * 3 + 1];
        if (Math.abs(y) + radii[i] > HALF_HEIGHT + 2e-6 || Math.hypot(state.positions[i * 3], state.positions[i * 3 + 2]) + radii[i] > radiusAt(y, 0.001575) + 2e-6) boundaryViolations++;
        initialPeak = Math.max(initialPeak, initial[i * 3 + 1] + HALF_HEIGHT + radii[i]);
        peak = Math.max(peak, state.positions[i * 3 + 1] + HALF_HEIGHT + radii[i]);
        radialRms += state.positions[i * 3] ** 2 + state.positions[i * 3 + 2] ** 2;
      }
      timings.sort((a, b) => a - b);
      early.sort((a, b) => a - b);
      cases.push({ steps: simulation.stats.steps, material, scenario: performanceOnly ? "1000 grains initialized in lower chamber" : "close-packed cone", count: radii.length, seconds: steps * FIXED_DT, rmsSpeedMmPerSecond: Math.sqrt(speedSquared / radii.length) * 1000, earlyGpuStepMedianMs: early[Math.floor(early.length / 2)], wallMs: performance.now() - start, gpuStepMedianMs: timings[Math.floor(timings.length / 2)], initialPeakMm: initialPeak * 1000, nonFinite, boundaryViolations, finalPeakMm: peak * 1000, radialRmsMm: Math.sqrt(radialRms / radii.length) * 1000 });
      simulation.dispose(); buffer.destroy();
    }
    const info = adapter.info;
    device.destroy();
    return { adapter: { vendor: info.vendor, architecture: info.architecture, fallback: info.isFallbackAdapter }, cases, errors };
  }, { base, performanceOnly: process.argv.includes("--performance") });
  assert.deepEqual(result.errors, []);
  for (const row of result.cases) {
    assert.ok(Number.isFinite(row.finalPeakMm) && row.finalPeakMm > 0);
    assert.equal(row.steps, row.seconds * 120);
    assert.equal(row.nonFinite, 0);
    assert.equal(row.boundaryViolations, 0);
  }
  await writeFile(process.env.OUTPUT ?? "benchmarks/granular-probe.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
