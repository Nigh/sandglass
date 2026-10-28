import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// Exercise the actual page and its existing 60-second export. No solver-time-to-FPS conversion.
const browser = await chromium.launch({
  headless: true,
  args: process.env.SOFTWARE_GPU === "1"
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : process.platform === "linux"
      ? ["--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
      : [],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(process.env.BASE_URL ?? "http://localhost:5177");
  await page.waitForSelector("#quality:not([disabled])", { timeout: 120000 });
  await page.selectOption("#quality", "1");
  await page.waitForFunction(() => document.querySelector("#debug-data")?.textContent?.includes("粒子数量     5000"));
  await page.locator("#restore").click();
  await page.locator("#debug").evaluate((element: HTMLDetailsElement) => { element.open = true; });
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = function (blob: Blob | MediaSource) {
      if (blob instanceof Blob && blob.type === "application/json")
        blob.text().then(text => { (window as unknown as {lastBenchmark: unknown}).lastBenchmark = JSON.parse(text); });
      return original.call(URL, blob);
    };
  });
  await page.locator("#benchmark").click();
  await page.evaluate(() => {
    const changes = [
      {milliseconds:12000, direction:"1", gravity:"1"},
      {milliseconds:24000, direction:"3", gravity:"2"},
      {milliseconds:36000, direction:"0", gravity:"0"},
      {milliseconds:48000, direction:"0", gravity:"1"},
    ];
    for (const change of changes) setTimeout(() => {
      const direction = document.querySelector("#direction") as HTMLSelectElement;
      direction.value = change.direction;
      direction.dispatchEvent(new Event("input"));
      (document.querySelector(`[data-g="${change.gravity}"]`) as HTMLButtonElement).click();
    }, change.milliseconds);
  });
  await page.waitForSelector("#export:not([disabled])", { timeout: 100000 });
  await page.locator("#export").click();
  await page.waitForFunction(() => Boolean((window as unknown as {lastBenchmark: unknown}).lastBenchmark));
  const report = await page.evaluate(async () => {
    const benchmark = (window as unknown as {lastBenchmark: {
      count:number;averageFps:number;physicsSteps:number;durationMs:number;p95:number;rows:{steps:number;droppedSeconds:number}[];
    }}).lastBenchmark;
    const canvas = document.querySelector("canvas")!;
    const gl = canvas.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = gl ? gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : "WebGPU canvas";
    const first = benchmark.rows[0], last = benchmark.rows.at(-1)!;
    const adapter = await navigator.gpu?.requestAdapter();
    const info = adapter?.info;
    const gpuAdapter = info ? {vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter} : null;
    return {...benchmark, renderer, gpuAdapter, measuredSteps:last.steps-first.steps, measuredDroppedSeconds:last.droppedSeconds-first.droppedSeconds};
  });
  await writeFile(process.env.OUTPUT ?? "benchmarks/realtime-5000.json", JSON.stringify(report, null, 2) + "\n");
  const {rows, ...summary} = report;
  console.log(JSON.stringify({...summary, frames:rows.length}, null, 2));
  assert.deepEqual(errors, []);
  assert.equal(report.count, 5000);
  assert.ok(report.measuredSteps >= report.durationMs / 1000 * 120 * .97, "physics must keep real time, not hide slowdown behind 60 FPS rendering");
  assert.ok(report.averageFps >= 58, "5000 grains must sustain approximately 60 FPS");
  assert.ok(report.p95 <= 20, "95% of rendered frame intervals must stay within 20 ms");
  assert.equal(report.measuredDroppedSeconds, 0, "the performance run must not discard simulation time");
  assert.equal(await page.locator("#fatal").isVisible(), false);
} finally {
  await browser.close();
}
