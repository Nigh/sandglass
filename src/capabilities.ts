export async function detectBackends(canvas: HTMLCanvasElement) {
  const gpu = (
    navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }
  ).gpu;
  let webgpu = false;
  try {
    webgpu = Boolean(gpu && (await gpu.requestAdapter()));
  } catch {
    /* Adapter acquisition can be denied by browser policy. */
  }
  const gl = canvas.getContext("webgl2");
  const floatTargets = Boolean(gl?.getExtension("EXT_color_buffer_float"));
  return {
    selected: "CPU Web Worker",
    webgpuAdapter: webgpu,
    webgl2: Boolean(gl),
    floatTargets,
    sharedArrayBuffer:
      crossOriginIsolated && typeof SharedArrayBuffer !== "undefined",
    reason:
      "当前使用连续 TypedArray + 均匀网格接触求解。WebGL2 浮点纹理不提供可靠的通用原子分桶；未启用 GPU 物理后端。WebGPU 能力检测不代表已实现或已验证 Compute 求解器。",
  };
}
