import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
declare global {
  interface Window {
    allowMotion?: boolean;
    lastBenchmark?: unknown;
    motionTimer?: number;
    testGpuDevice?: GPUDevice;
    testGpuFrame?: unknown;
  }
}
const base = process.env.BASE_URL ?? "http://localhost:5177";
const gpu = process.argv.includes("--gpu");
const browser = await chromium.launch({
  headless: true,
  args: gpu
    ? ["--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
// Literal script avoids tsx keepNames helpers crossing the browser execution boundary.
if (gpu) {
  await page.addInitScript({
    content: `
      window.__THREE_DEVTOOLS__ = new EventTarget();
      window.__THREE_DEVTOOLS__.addEventListener("observe", event => {
        const renderer = event.detail;
        if (!renderer.isWebGPURenderer) return;
        window.testGpuRenderer = renderer;
        const render = renderer.render;
        renderer.render = function (scene, camera) {
          if (scene.children.some(child => child.isInstancedMesh)) {
            window.testGpuFrame = { scene, camera };
          }
          return render.call(this, scene, camera);
        };
      });
      const createBuffer = GPUDevice.prototype.createBuffer;
      GPUDevice.prototype.createBuffer = function (descriptor) {
        const buffer = createBuffer.call(this, descriptor);
        if (descriptor.label === "GPU particle positions and radii") window.testGpuPositions = buffer;
        return buffer;
      };
      const requestDevice = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (descriptor) {
        const device = await requestDevice.call(this, descriptor);
        window.testGpuDevice = device;
        return device;
      };
      const create = GPUDevice.prototype.createComputePipelineAsync;
      GPUDevice.prototype.createComputePipelineAsync = async function (descriptor) {
        const pipeline = await create.call(this, descriptor);
        const { promise, resolve } = Promise.withResolvers();
        setTimeout(resolve, 1500);
        await promise;
        return pipeline;
      };
    `,
  });
} else {
  // Exercise the real compatibility path, even when software WebGPU is available.
  await page.addInitScript({
    content: 'Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined });',
  });
}
await page.addInitScript({
  content: `
  window.addEventListener("devicemotion",event=>{if(event.isTrusted)event.stopImmediatePropagation();},true);
  Object.defineProperty(DeviceMotionEvent,"requestPermission",{
    configurable:true,
    value:()=>Promise.resolve(window.allowMotion?"granted":"denied")
  });
`,
});
// Delay the real worker network response to exercise the startup-control boundary.
await page.route("**/physics.worker.ts*", async (route) => {
  await delay(1500);
  await route.continue();
});
await page.goto(base);
await page.waitForSelector("canvas");
for (const id of ["reset", "restore", "material", "quality", "count"])
  assert.equal(await page.locator(`#${id}`).isDisabled(), true);
await page.waitForFunction(
  () => !(document.querySelector("#material") as HTMLSelectElement).disabled,
);
await page.waitForFunction(
  (expected) => document.querySelector("#debug-data")?.textContent?.includes(expected),
  gpu ? "WebGPU Compute" : "CPU / Web Worker",
);
if (gpu) {
  await page.waitForFunction(() => Boolean(window.testGpuFrame));
  await page.locator("#pause").click();
  // Explicit test-only target readback proves geometry, not just a live canvas.
  const pixels = await page.evaluate(`(async () => {
    const renderer = window.testGpuRenderer;
    const { scene, camera } = window.testGpuFrame;
    const mesh = scene.children.find(child => child.isInstancedMesh);
    const target = renderer._frameBufferTarget.clone();
    target.setSize(256, 256);
    const previousTarget = renderer.getRenderTarget();
    const visibility = scene.children.map(child => child.visible);
    const originalCount = mesh.count;
    const device = renderer.backend.device;
    await device.queue.onSubmittedWorkDone();
    const positions = window.testGpuPositions;
    const backup = device.createBuffer({
      size: 32, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const save = device.createCommandEncoder();
    save.copyBufferToBuffer(positions, 0, backup, 0, 32);
    device.queue.submit([save.finish()]);
    const difference = (a, b) => {
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] ||
            a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) changed++;
      }
      return changed;
    };
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const full = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
      mesh.visible = false;
      renderer.render(scene, camera);
      const vessel = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
      for (const child of scene.children) if (child.isMesh) child.visible = false;
      renderer.render(scene, camera);
      const blank = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
      // Instance 1 used to rotate this nonzero world center around the origin.
      const centers = [[-0.014, 0.025, -0.005], [0.016, -0.020, 0.006]];
      const grains = new Float32Array(8);
      centers.forEach((center, index) => {
        grains.set(center, index * 4);
        grains[index * 4 + 3] = 0.0015;
      });
      device.queue.writeBuffer(positions, 0, grains);
      mesh.count = 2;
      mesh.visible = true;
      renderer.render(scene, camera);
      const twoGrains = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 256, 256);
      const projected = centers.map(center => {
        const point = mesh.position.clone().set(...center).project(camera);
        return [(point.x + 1) * 128, (1 - point.y) * 128];
      });
      const centerHits = [0, 0];
      let misplacedPixels = 0;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const offset = (y * 256 + x) * 4;
        if (twoGrains[offset] === blank[offset] && twoGrains[offset + 1] === blank[offset + 1] &&
            twoGrains[offset + 2] === blank[offset + 2] && twoGrains[offset + 3] === blank[offset + 3]) continue;
        let expected = false;
        projected.forEach(([cx, cy], index) => {
          if (Math.abs(x + 0.5 - cx) < 8 && Math.abs(y + 0.5 - cy) < 8) {
            centerHits[index]++;
            expected = true;
          }
        });
        if (!expected) misplacedPixels++;
      }
      return {
        geometryPixels: difference(full, blank),
        particlePixels: difference(full, vessel),
        vesselPixels: difference(vessel, blank),
        centerHits,
        misplacedPixels,
        projected,
      };
    } finally {
      const restore = device.createCommandEncoder();
      restore.copyBufferToBuffer(backup, 0, positions, 0, 32);
      device.queue.submit([restore.finish()]);
      backup.destroy();
      mesh.count = originalCount;
      scene.children.forEach((child, index) => { child.visible = visibility[index]; });
      renderer.setRenderTarget(previousTarget);
      target.dispose();
    }
  })()`) as {
    geometryPixels: number;
    particlePixels: number;
    vesselPixels: number;
    centerHits: number[];
    misplacedPixels: number;
    projected: number[][];
  };
  assert.ok(pixels.geometryPixels > 100 && pixels.vesselPixels > 100, JSON.stringify(pixels));
  assert.ok(pixels.particlePixels > 10, JSON.stringify(pixels));
  assert.ok(pixels.centerHits.every(hits => hits > 3), JSON.stringify(pixels));
  assert.equal(pixels.misplacedPixels, 0, "Grain pixels must surround projected GPU centers, not the origin");
  console.log("GPU 实际目标像素与中心变换验收", pixels);
  await page.locator("#pause").click();
}
await page.waitForFunction(() =>
  document.querySelector("#sensor-status")?.textContent?.includes("拒绝"),
);
await page.locator('[data-g="0"]').click();
await page.waitForFunction(() =>
  document.querySelector("#g-value")?.textContent?.includes("0.00"),
);
await page.locator("#pause").click();
assert.equal(await page.locator("#pause").textContent(), "继续模拟");
await page.locator("#pause").click();
await page.evaluate(() => {
  window.allowMotion = true;
});
await page.locator("#permission").click();
async function motion(value: number) {
  await page.evaluate((y) => {
    clearInterval(window.motionTimer);
    window.motionTimer = window.setInterval(() => {
      const e = new Event("devicemotion");
      Object.defineProperty(e, "accelerationIncludingGravity", {
        value: { x: 0, y, z: 0 },
      });
      window.dispatchEvent(e);
    }, 50);
  }, value);
}
await motion(-19.62);
await page.waitForFunction(
  () => document.querySelector("#mode")?.textContent === "真实传感器",
);
assert.equal(await page.locator("#direction").isDisabled(), true);
await page.evaluate(() => {
  const input = document.querySelector("#magnitude") as HTMLInputElement;
  input.value = "0";
  input.dispatchEvent(new Event("input"));
});
assert.match((await page.locator("#g-value").textContent()) ?? "", /2\.00/);
await motion(0);
await page.waitForFunction(() =>
  document.querySelector("#g-value")?.textContent?.includes("0.00"),
);
await page.evaluate(() => clearInterval(window.motionTimer));
await page.waitForFunction(
  () => document.querySelector("#mode")?.textContent?.includes("数据故障"),
  {},
  { timeout: 5000 },
);
assert.equal(await page.locator("#direction").isDisabled(), false);
await page.locator("#activate-preset").click();
await page.waitForFunction(
  () => document.querySelector("#mode")?.textContent === "预设加速度",
);
await page.selectOption("#material", "2");
await page.locator("#air").uncheck();
await page.waitForFunction(() =>
  document.querySelector("#debug-data")?.textContent?.includes("真空 · 无空气阻力"),
);
await page.locator("#air").check();
await page.selectOption("#material", "1");
await page.locator("#pause").click();
await page.locator("#reset").click();
await page.waitForFunction(() =>
  /累计物理步数\s+0\b/.test(document.querySelector("#debug-data")?.textContent ?? ""),
);
assert.equal(await page.locator("#pause").textContent(), "继续模拟");
await page.selectOption("#quality", "3");
await page.locator("#count").fill("1500");
await page.locator("#count").dispatchEvent("change");
try {
  await page.waitForFunction(() =>
    /粒子数量\s+1500\b/.test(document.querySelector("#debug-data")?.textContent ?? "") &&
    !(document.querySelector("#pause") as HTMLButtonElement).disabled,
  );
  // A late blur can repeat the same change after asynchronous initialization.
  await page.locator("#count").dispatchEvent("change");
  assert.equal(await page.locator("#pause").isDisabled(), false);
  await page.locator("#pause").click();
} catch (error) {
  console.error("数量重建诊断", JSON.stringify({
    fatal: await page.locator("#fatal").textContent(),
    debug: await page.locator("#debug-data").textContent(),
    consoleErrors,
  }));
  throw error;
}
await page.selectOption("#quality", "0");
await page.selectOption("#shape", "3");
assert.equal(await page.locator("#palette").inputValue(), "5");
await page.selectOption("#palette", "3");
await page.selectOption("#shape", "2");
await mkdir("benchmarks", { recursive: true });
await page.screenshot({ path: "benchmarks/desktop.png", fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.locator("#view").click();
assert.equal(
  await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
  false,
);
await page.screenshot({ path: "benchmarks/mobile.png", fullPage: true });
assert.equal(await page.locator("#fatal").isVisible(), false);
assert.deepEqual(errors, []);
console.log(
  `浏览器验收通过（${gpu ? "WebGPU" : "CPU Worker"}）：启动锁定、传感器互斥、2g/0g、故障与预设、暂停重置、数量重建、材料/空气、外观与手机布局。`,
);
if (process.argv.includes("--degradation")) {
  await page.waitForFunction(
    () =>
      document.querySelector("#budget")?.textContent?.includes("低面数细砂"),
    {},
    { timeout: 25000 },
  );
  assert.equal(await page.locator("#shape").inputValue(), "0");
  console.log("回归通过：启动控件锁定与自动外观降级状态同步。");
}
if (process.argv.includes("--benchmark")) {
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = function (blob: Blob | MediaSource) {
      if (blob instanceof Blob && blob.type === "application/json")
        blob.text().then((s) => {
          window.lastBenchmark = JSON.parse(s);
        });
      return original.call(URL, blob);
    };
  });
  const results: unknown[] = [];
  for (const quality of ["0", "1", "2"]) {
    await page.selectOption("#quality", quality);
    await page.selectOption("#shape", "0");
    await page.selectOption("#palette", "0");
    await page.locator("#restore").click();
    await page.locator('[data-g="1"]').click();
    await page.locator("#debug").evaluate((e: HTMLDetailsElement) => {
      e.open = true;
    });
    await page.locator("#benchmark").click();
    // Scheduled changes exercise dense packing, the neck, reversals, zero input and 2g.
    await page.evaluate(() => {
      const direction = document.querySelector(
        "#direction",
      ) as HTMLSelectElement;
      const changes = [
        { ms: 12000, d: "1", g: "1" },
        { ms: 24000, d: "3", g: "2" },
        { ms: 36000, d: "0", g: "0" },
        { ms: 48000, d: "0", g: "2" },
      ];
      for (const c of changes)
        setTimeout(() => {
          direction.value = c.d;
          direction.dispatchEvent(new Event("input"));
          (
            document.querySelector(`[data-g="${c.g}"]`) as HTMLButtonElement
          ).click();
        }, c.ms);
    });
    await page.waitForFunction(
      () =>
        !(document.querySelector("#benchmark") as HTMLButtonElement).disabled,
      {},
      { timeout: 90000 },
    );
    await page.locator("#export").click();
    await page.waitForFunction(() => Boolean(window.lastBenchmark));
    const result = await page.evaluate(() => {
      const result = window.lastBenchmark;
      window.lastBenchmark = null;
      return result;
    });
    results.push(result);
    console.log(
      JSON.stringify(result, (_key, value) =>
        Array.isArray(value) && value.length > 100
          ? `[${value.length} samples]`
          : value,
      ),
    );
  }
  const renderer = await page.evaluate(async (useGpu) => {
    if (useGpu) {
      const adapter = await navigator.gpu.requestAdapter();
      return adapter ? JSON.stringify(adapter.info) : "WebGPU adapter unavailable";
    }
    const gl = document.querySelector("canvas")!.getContext("webgl2")!;
    const extension = gl.getExtension("WEBGL_debug_renderer_info");
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }, gpu);
  await writeFile(
    "benchmarks/browser.json",
    JSON.stringify(
      {
        environment: gpu ? "桌面无头 Chromium / WebGPU；硬件以 renderer 为准" : "桌面无头 Chromium；软件 WebGL；不代表手机性能",
        renderer,
        results,
      },
      null,
      2,
    ),
  );
}
if (gpu) {
  await page.evaluate(() => window.testGpuDevice!.destroy());
  await page.waitForFunction(() =>
    document.querySelector("#fatal")?.textContent?.includes("WebGPU"),
  );
  assert.equal(await page.locator("#fatal").isVisible(), true);
  assert.equal(await page.locator("#material").isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log("GPU 设备丢失显式报错，未冒充 CPU 回退。");
}
await browser.close();
