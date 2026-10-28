import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true, args: ["--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu"] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript({ content: `
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener("observe", event => {
      const renderer = event.detail;
      if (!renderer.isWebGPURenderer) return;
      const render = renderer.render;
      renderer.render = function (scene, camera) {
        const mesh = scene.children.find(child => child.isInstancedMesh);
        if (mesh) window.mobileFrame = {
          camera: camera.position.toArray(), count: mesh.count, pixelRatio: renderer.getPixelRatio()
        };
        return render.call(this, scene, camera);
      };
    });
  ` });
  await page.goto(process.env.BASE_URL ?? "http://localhost:5177");
  await page.waitForFunction("window.mobileFrame && !document.querySelector('#pause').disabled");
  const state = () => page.evaluate("window.mobileFrame") as Promise<{ camera: number[]; count: number; pixelRatio: number }>;
  const initial = await state();
  assert.equal(initial.count, 1000);
  assert.ok(Math.abs(initial.camera[0]) < 1e-12);
  assert.ok(Math.abs(initial.camera[1]) < 1e-12);
  assert.ok(initial.pixelRatio <= 1);
  assert.equal(await page.locator("#polarity").inputValue(), "-1");
  assert.equal(await page.locator("#view").isVisible(), false);
  const canvas = page.locator("canvas");
  await canvas.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 180, clientY: 300, button: 0 });
  await canvas.dispatchEvent("pointermove", { pointerId: 1, pointerType: "touch", clientX: 280, clientY: 400, button: 0 });
  await canvas.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", clientX: 280, clientY: 400, button: 0 });
  await page.waitForTimeout(100);
  assert.deepEqual((await state()).camera, initial.camera);
  await canvas.dispatchEvent("dblclick");
  await page.waitForTimeout(100);
  assert.deepEqual((await state()).camera, initial.camera);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(100);
  assert.deepEqual((await state()).camera, initial.camera);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#pause").click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: "docs/mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await desktop.goto(process.env.BASE_URL ?? "http://localhost:5177");
  await desktop.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#pause")!.disabled);
  await desktop.locator("#pause").click();
  await desktop.screenshot({ path: "docs/screenshot.png", fullPage: true });
  console.log("移动端验收通过：反向极性、1000 粒、像素比上限、触摸/双击/横竖屏固定视角、布局及截图。");
} finally { await browser.close(); }
