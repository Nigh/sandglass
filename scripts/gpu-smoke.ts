import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// Run the shipped GPU solver on a real WebGPU device, without rendering or CPU physics steps.
const base = process.env.BASE_URL ?? "http://localhost:5177";
const browser = await chromium.launch({headless:true,args:process.platform === "linux"
  ? ["--use-angle=vulkan","--enable-features=Vulkan","--disable-vulkan-surface","--ignore-gpu-blocklist","--enable-unsafe-webgpu"] : []});
try {
  const page = await browser.newPage();
  // tsx emits this name-preservation helper for nested functions sent to Chromium.
  await page.addInitScript({content:"globalThis.__name = (value) => value;"});
  await page.route(base + "/gpu-smoke", route => route.fulfill({contentType:"text/html",body:"<!doctype html><title>GPU physics check</title>"}));
  await page.goto(base + "/gpu-smoke");
  const result = await page.evaluate(async (origin) => {
    // Imports execute inside Chromium; the Vite origin is selected by BASE_URL at runtime.
    const {Physics} = await import(origin + "/src/physics.ts");
    const {GpuPhysics} = await import(origin + "/src/gpu-physics.ts");
    const {HALF_HEIGHT,FIXED_DT,radiusAt} = await import(origin + "/src/vessel.ts");
    const adapter = await navigator.gpu?.requestAdapter({powerPreference:"high-performance"});
    if (!adapter) throw new Error("WebGPU adapter required for GPU validation");
    const device = await adapter.requestDevice({requiredFeatures:adapter.features.has("timestamp-query")?["timestamp-query"]:[]});
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const initial = new Physics(5000);
    const positions = device.createBuffer({size:5000*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST|GPUBufferUsage.VERTEX});
    const simulation = await GpuPhysics.create(device,positions,initial.positions,initial.radii,initial.neckRadius,1,true);
    const samples: {time:number;lower:number;nonFinite:number;boundaryViolations:number;maxOverlapFraction:number;gpuBatchMs:number|null}[] = [];
    let initialTop = -Infinity;
    for(let i=0;i<5000;i++)initialTop=Math.max(initialTop,initial.positions[i*3+1]+initial.radii[i]);
    const sample = async (time:number) => {
      const state = await simulation.snapshot();
      let lower=0,nonFinite=0,boundaryViolations=0,maxOverlapFraction=0;
      for(let i=0;i<5000;i++) {
        const k=i*3,x=state.positions[k],y=state.positions[k+1],z=state.positions[k+2],r=initial.radii[i];
        if(y<0)lower++;
        for(let axis=0;axis<3;axis++)if(!Number.isFinite(state.positions[k+axis])||!Number.isFinite(state.velocities[k+axis]))nonFinite++;
        if(Math.abs(y)+r>HALF_HEIGHT+2e-6 || Math.hypot(x,z)+r>radiusAt(y,initial.neckRadius)+2e-6)boundaryViolations++;
      }
      // Sample contacts throughout the index range, not just adjacent initialization rows.
      for(let i=0;i<5000;i+=17)for(let j=i+1;j<5000;j++){
        const a=i*3,b=j*3,diameter=initial.radii[i]+initial.radii[j];
        const distance=Math.hypot(state.positions[a]-state.positions[b],state.positions[a+1]-state.positions[b+1],state.positions[a+2]-state.positions[b+2]);
        maxOverlapFraction=Math.max(maxOverlapFraction,(diameter-distance)/diameter);
      }
      samples.push({time,lower,nonFinite,boundaryViolations,maxOverlapFraction,gpuBatchMs:simulation.stats.gpuMs??null});
    };
    await sample(0);
    for(let step=1;step<=360;step++){
      while(simulation.pending)await device.queue.onSubmittedWorkDone();
      simulation.advance(FIXED_DT,[0,-9.81,0]);
      if(step%120===0)await sample(step*FIXED_DT);
    }
    const gravitySteps=simulation.stats.steps;
    simulation.reset();
    simulation.setAirResistance(false);
    simulation.setMaterial(0);
    for(let step=0;step<60;step++){
      while(simulation.pending)await device.queue.onSubmittedWorkDone();
      simulation.advance(FIXED_DT,[0,9.81,0]);
    }
    const upward=await simulation.snapshot();
    let upwardMean=0,initialMean=0;
    for(let i=0;i<5000;i++){upwardMean+=upward.positions[i*3+1]/5000;initialMean+=initial.positions[i*3+1]/5000;}
    simulation.dispose();positions.destroy();
    const info=adapter.info;
    device.destroy();
    return {adapter:{vendor:info.vendor,architecture:info.architecture,isFallbackAdapter:info.isFallbackAdapter},count:5000,gravitySteps,initialTopFraction:initialTop/HALF_HEIGHT,samples,upwardMean,initialMean,errors};
  }, base);
  await writeFile("benchmarks/gpu-smoke.json",JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result,null,2));
  assert.deepEqual(result.errors, []);
  assert.equal(result.gravitySteps,360,"the flow check must advance all three simulated seconds");
  assert.ok(result.initialTopFraction>=.45&&result.initialTopFraction<=.55,"5000-grain initial surface must lie near half the upper chamber");
  for(const sample of result.samples){
    assert.equal(sample.nonFinite,0,"particle state must stay finite");
    assert.equal(sample.boundaryViolations,0,"grains must remain inside the vessel");
    assert.ok(sample.maxOverlapFraction<.35,"contact solver must prevent bulk collapse into overlapping centers");
  }
  assert.ok(result.samples[1].lower>0,"gravity must move sand through the throat");
  assert.ok(result.samples[3].lower>result.samples[1].lower,"flow must continue rather than stop after initial throat grains");
  assert.ok(result.upwardMean>result.initialMean+.002,"reversing acceleration must move the bed upward");
} finally {
  await browser.close();
}
