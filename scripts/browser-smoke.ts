import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
declare global {
  interface Window {
    allowMotion?: boolean;
    lastBenchmark?: unknown;
    motionTimer?: number;
  }
}
const base = process.env.BASE_URL ?? "http://localhost:5177";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
// Literal script avoids tsx keepNames helpers crossing the browser execution boundary.
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
await page.selectOption("#quality", "0");
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
  "浏览器验收通过：权限拒绝/恢复、真实输入互斥、2g/0g、过期故障、显式预设、暂停、外观切换与手机布局。",
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
  const renderer = await page.evaluate(() => {
    const gl = document.querySelector("canvas")!.getContext("webgl2")!;
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return e
      ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  });
  await writeFile(
    "benchmarks/browser.json",
    JSON.stringify(
      {
        environment: "桌面无头 Chromium；软件 GPU；不代表手机性能",
        renderer,
        results,
      },
      null,
      2,
    ),
  );
}
await browser.close();
