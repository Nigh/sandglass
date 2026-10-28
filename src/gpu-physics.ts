import { MATERIALS, type PhysicsStats } from "./physics";
import { FIXED_DT, HALF_HEIGHT, MAX_RADIUS, ambientDragRate, bedDragRate } from "./vessel";
import shader from "./gpu-physics.wgsl?raw";

const SUBSTEPS = 8;
const ITERATIONS = 3;
// ponytail: two steps cap catch-up at 120 Hz on a 60 Hz display; retain backlog.
// Use a measured GPU-time catch-up budget if transient stalls must be recovered.
const MAX_BATCH_STEPS = 2;
const WORKGROUP = 128;

/** GPU-resident, mass-weighted Jacobi granular dynamics, in SI units.
 * Schedule/grid inspiration: https://github.com/SamG-Coder/grain-cuda-sand
 * (MIT, kernels/granular.cu and src/simulation.js). This is independent WGSL;
 * unlike that visual solver, no displacement/speed cap or equal-mass assumption.
 * Small steps: https://mmacklin.com/smallsteps.pdf.
 * No rotations; contacts are discrete, and extreme grain speeds can tunnel.
 * Darcy is a local quasi-steady resistance closure, not a gas pressure solve.
 */
export class GpuPhysics {
  readonly count: number;
  readonly backend = "webgpu";
  readonly stats: PhysicsStats & { gpuMs: number } = {
    ms: 0, gpuMs: NaN, contacts: NaN, steps: 0, dropped: 0, active: 0, sleeping: 0,
    supportedActive: NaN, neighborChecks: NaN, substeps: 0,
  };
  private readonly owned: GPUBuffer[] = [];
  private readonly uniform: GPUBuffer;
  private readonly velocities: GPUBuffer;
  private readonly predictions: readonly GPUBuffer[];
  private readonly auxiliary: GPUBuffer;
  private readonly heads: GPUBuffer;
  private readonly links: GPUBuffer;
  private readonly occupiedCells: GPUBuffer;
  private timestampQueries: GPUQuerySet | null = null;
  private timestampResolve: GPUBuffer | null = null;
  private timestampRead: GPUBuffer | null = null;
  private timingPending = false;
  private readonly initial: Float32Array<ArrayBuffer>;
  private readonly parameters = new ArrayBuffer(80);
  private readonly floats = new Float32Array(this.parameters);
  private readonly integers = new Uint32Array(this.parameters);
  private readonly bindings: GPUBindGroup[] = [];
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  private readonly cells: number;
  private readonly groups: number;
  private material = 1;
  private air = true;
  private accumulator = 0;
  private fence: Promise<void> | null = null;
  private failure: unknown = null;
  private disposed = false;

  get pending(): boolean { return this.fence !== null; }
  get backlogSeconds(): number { return this.accumulator; }

  static async create(device: GPUDevice, positions: GPUBuffer, initialPositions: Float32Array,
    radii: Float32Array, neckRadius: number, material: number, air: boolean): Promise<GpuPhysics> {
    const simulation = new GpuPhysics(device, positions, initialPositions, radii, neckRadius, material, air);
    try {
      await simulation.initialize();
      simulation.reset();
      return simulation;
    } catch (error) {
      simulation.dispose();
      throw error;
    }
  }

  private constructor(private readonly device: GPUDevice, private readonly positions: GPUBuffer,
    initialPositions: Float32Array, radii: Float32Array, readonly neckRadius: number,
    material: number, air: boolean) {
    this.count = radii.length;
    if (!Number.isSafeInteger(this.count) || this.count < 1 || this.count > 100_000 || initialPositions.length !== this.count * 3)
      throw new RangeError("GPU particles require matching xyz positions and 1–100000 radii");
    if (!(neckRadius > 0 && neckRadius < MAX_RADIUS)) throw new RangeError("Invalid GPU neck radius");
    if (positions.size < this.count * 16 ||
      (positions.usage & (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST)) !==
      (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST))
      throw new Error("GPU position buffer requires vec4 storage and COPY_SRC/COPY_DST usage");
    let largest = 0;
    let smallest = Infinity;
    this.initial = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      const r = radii[i];
      if (!Number.isFinite(r) || r <= 0 || r >= neckRadius) throw new RangeError("Invalid GPU grain radius");
      largest = Math.max(largest, r);
      smallest = Math.min(smallest, r);
      for (let axis = 0; axis < 3; axis++) {
        const value = initialPositions[i * 3 + axis];
        if (!Number.isFinite(value)) throw new RangeError("Non-finite initial GPU position");
        this.initial[i * 4 + axis] = value;
      }
      this.initial[i * 4 + 3] = r;
    }
    const cellSize = largest * 2.08;
    const nx = Math.ceil(MAX_RADIUS * 2 / cellSize) + 2;
    const ny = Math.ceil(HALF_HEIGHT * 2 / cellSize) + 2;
    this.cells = nx * ny * nx;
    this.groups = Math.ceil(this.count / WORKGROUP);
    this.integers.set([this.count, nx, ny, this.cells]);
    this.floats.set([cellSize, FIXED_DT / SUBSTEPS, neckRadius, HALF_HEIGHT], 4);
    this.floats.set([MAX_RADIUS, 0, 0, 0], 8);
    this.floats[19] = 0.025 * smallest;
    this.setMaterial(material);
    this.setAirResistance(air);
    const make = (size: number, label: string, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) => {
      if (size > device.limits.maxBufferSize || ((usage & GPUBufferUsage.STORAGE) && size > device.limits.maxStorageBufferBindingSize))
        throw new RangeError(`${label} exceeds this device's GPU buffer limit`);
      const buffer = device.createBuffer({ size, label, usage });
      this.owned.push(buffer);
      return buffer;
    };
    this.uniform = make(80, "GPU sand parameters", GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.velocities = make(this.count * 16, "GPU sand velocities", GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.predictions = [make(this.count * 16, "GPU Jacobi A"), make(this.count * 16, "GPU Jacobi B")];
    this.auxiliary = make(this.count * 48, "GPU sand contact workspace");
    // One link per grain, not per cell: no bucket capacity, overflow, scan, or dropped grain.
    // Track each grain's previous cell so rebuilding clears occupied cells only.
    this.heads = make(this.cells * 4, "GPU spatial bin heads");
    this.links = make(this.count * 4, "GPU spatial bin links");
    this.occupiedCells = make(this.count * 4, "GPU occupied cells");
    if (device.features.has("timestamp-query")) {
      this.timestampQueries = device.createQuerySet({ type: "timestamp", count: 2 });
      this.timestampResolve = make(16, "GPU compute timestamp resolve", GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
      this.timestampRead = make(16, "GPU compute timestamp read", GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    }
    this.stats.active = this.count;
  }

  private async initialize(): Promise<void> {
    const module = this.device.createShaderModule({ label: "GPU sand physics", code: shader });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === "error");
    if (errors.length) throw new Error(errors.map(message => `WGSL ${message.lineNum}:${message.linePos} ${message.message}`).join("\n"));
    const layout = this.device.createBindGroupLayout({ entries: Array.from({ length: 9 }, (_, binding) => ({
      binding, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: binding === 0 ? "uniform" as const : "storage" as const },
    })) });
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const names = ["predict", "clearBins", "buildBins", "solvePositions", "solveVelocity", "commit"];
    const pipelines = await Promise.all(names.map(entryPoint => this.device.createComputePipelineAsync({
      label: `GPU sand ${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint },
    })));
    names.forEach((name, index) => this.pipelines.set(name, pipelines[index]));
    for (let side = 0; side < 2; side++) {
      const buffers = [this.uniform, this.positions, this.velocities, this.predictions[side],
        this.predictions[1 - side], this.auxiliary, this.heads, this.links, this.occupiedCells];
      this.bindings.push(this.device.createBindGroup({ layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    }
  }

  advance(elapsed: number, acceleration: readonly number[], paused = false): void {
    this.assertUsable();
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new RangeError("GPU elapsed time must be finite and nonnegative");
    if (acceleration.length !== 3 || !acceleration.every(Number.isFinite)) throw new RangeError("GPU acceleration requires three finite components");
    // Reject unrepresentable f32 inputs; never normalize or truncate sensor magnitude.
    if (acceleration.some(value => Math.abs(value) > 1e6)) throw new RangeError("Acceleration exceeds GPU solver safety budget");
    const start = performance.now();
    this.stats.ms = 0;
    this.stats.substeps = 0;
    if (paused) { this.accumulator = 0; return; }
    this.accumulator += elapsed;
    if (this.fence) return;
    const steps = Math.min(MAX_BATCH_STEPS, Math.floor((this.accumulator + 1e-12) / FIXED_DT));
    if (steps === 0) return;
    this.floats.set(acceleration, 12);
    this.device.queue.writeBuffer(this.uniform, 0, this.parameters);
    const encoder = this.device.createCommandEncoder({ label: "GPU granular fixed steps" });
    const recordTiming = this.timestampQueries !== null && !this.timingPending;
    const pass = encoder.beginComputePass(recordTiming ? { timestampWrites: {
      querySet: this.timestampQueries!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1,
    } } : undefined);
    const dispatch = (name: string, side = 0, groups = this.groups) => {
      pass.setPipeline(this.pipelines.get(name)!);
      pass.setBindGroup(0, this.bindings[side]);
      pass.dispatchWorkgroups(groups);
    };
    const grid = (side: number) => {
      dispatch("clearBins", side);
      dispatch("buildBins", side);
    };
    for (let step = 0; step < steps; step++) for (let substep = 0; substep < SUBSTEPS; substep++) {
      dispatch("clearBins");
      dispatch("predict");
      let side = 0;
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        if (iteration > 0) grid(side);
        dispatch("solvePositions", side);
        side = 1 - side;
      }
      // Final projection changes neighbors too. Never reuse an earlier grid.
      grid(side);
      dispatch("solveVelocity", side);
      dispatch("commit", side);
    }
    pass.end();
    if (recordTiming) {
      encoder.resolveQuerySet(this.timestampQueries!, 0, 2, this.timestampResolve!, 0);
      encoder.copyBufferToBuffer(this.timestampResolve!, 0, this.timestampRead!, 0, 16);
    }
    this.device.queue.submit([encoder.finish()]);
    this.accumulator = Math.max(0, this.accumulator - steps * FIXED_DT);
    this.stats.steps += steps;
    this.stats.substeps = steps * SUBSTEPS;
    this.stats.ms = performance.now() - start; // CPU encoding/submission, never GPU duration.
    this.fence = this.device.queue.onSubmittedWorkDone().catch(error => { this.failure = error; }).finally(() => { this.fence = null; });
    // Timing never blocks simulation or causes a mapped-buffer submission.
    if (recordTiming) {
      this.timingPending = true;
      void this.timestampRead!.mapAsync(GPUMapMode.READ).then(() => {
        if (this.disposed) return;
        const timestamps = new BigUint64Array(this.timestampRead!.getMappedRange());
        this.stats.gpuMs = Number(timestamps[1] - timestamps[0]) / 1e6;
        this.timestampRead!.unmap();
      }).catch(error => { if (!this.disposed) this.failure = error; }).finally(() => { this.timingPending = false; });
    }
  }

  reset(): void {
    this.assertUsable();
    this.device.queue.writeBuffer(this.positions, 0, this.initial);
    const encoder = this.device.createCommandEncoder({ label: "Reset GPU sand" });
    encoder.clearBuffer(this.velocities);
    encoder.clearBuffer(this.auxiliary);
    encoder.clearBuffer(this.heads);
    this.device.queue.submit([encoder.finish()]);
    this.accumulator = 0;
    this.stats.ms = this.stats.steps = this.stats.substeps = this.stats.dropped = 0;
  }

  setMaterial(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= MATERIALS.length) throw new RangeError("Unknown material");
    this.material = index;
    const material = MATERIALS[index];
    this.floats[9] = material.friction;
    this.floats[10] = material.wallFriction;
    this.floats[11] = material.restitution;
    this.updateDrag();
  }

  setAirResistance(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("Air resistance must be a boolean");
    this.air = enabled;
    this.updateDrag();
  }

  private updateDrag(): void {
    const density = MATERIALS[this.material].density;
    this.floats[16] = this.air ? ambientDragRate(density) : 0;
    this.floats[17] = this.air ? bedDragRate(density) : 0;
  }

  /** Explicit diagnostics only. Normal rendering never maps or copies particle data. */
  async snapshot(): Promise<{ positions: Float32Array; velocities: Float32Array }> {
    this.assertUsable();
    const bytes = this.count * 16;
    const staging = this.device.createBuffer({ size: bytes * 2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder({ label: "Explicit GPU physics snapshot" });
      encoder.copyBufferToBuffer(this.positions, 0, staging, 0, bytes);
      encoder.copyBufferToBuffer(this.velocities, 0, staging, bytes, bytes);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange());
      const positions = new Float32Array(this.count * 3);
      const velocities = new Float32Array(this.count * 3);
      for (let i = 0; i < this.count; i++) for (let axis = 0; axis < 3; axis++) {
        positions[i * 3 + axis] = data[i * 4 + axis];
        velocities[i * 3 + axis] = data[this.count * 4 + i * 4 + axis];
      }
      staging.unmap();
      return { positions, velocities };
    } finally { staging.destroy(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const buffer of this.owned) buffer.destroy();
    this.timestampQueries?.destroy();
    // positions belongs to the renderer, not this solver.
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("GPU physics has been disposed");
    if (this.failure) throw new Error("GPU physics submission failed", { cause: this.failure });
  }
}
