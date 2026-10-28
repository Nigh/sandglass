import {
  FIXED_DT,
  HALF_HEIGHT,
  MAX_RADIUS,
  grainBaseRadius,
  neckRadiusFor,
  radiusAt,
  slopeAt,
  bedDragRate,
  ambientDragRate,
} from "./vessel";

export const MATERIALS = [
  { name: "极细沙", color: 0xe8d0a2, friction: 0.32, wallFriction:0.14, restitution: 0.04, density: 1500 },
  { name: "标准沙", color: 0xf2b84b, friction: 0.55, wallFriction:0.22, restitution: 0.08, density: 1700 },
  { name: "粗颗粒", color: 0xc68f58, friction: 0.68, wallFriction:0.30, restitution: 0.22, density: 1900 },
  { name: "高摩擦晶体", color: 0x9cbed4, friction: 0.92, wallFriction:0.40, restitution: 0.12, density: 2600 },
] as const;

export interface PhysicsStats {
  /** Wall-clock CPU time of the latest step/advance. */
  ms: number;
  /** Resolved constraints; iterations can count the same contact again. */
  contacts: number;
  steps: number;
  /** Simulated seconds omitted by the catch-up budget. */
  dropped: number;
  active: number;
  sleeping: number;
  /** Active particles whose contact chain currently reaches a vessel wall. */
  supportedActive: number;
  /** Candidate pairs visited by the latest step/advance. */
  neighborChecks: number;
  /** Fixed solver substeps, not per-particle wall sweep segments. */
  substeps: number;
}

const MAX_CATCH_UP_STEPS = 8;
// Smaller steps reduce contact error more effectively than repeated large-step
// projections: https://mmacklin.com/smallsteps.pdf (sections 4.2 and 6).
const SUBSTEP = FIXED_DT / 4;
const CONTACT_ITERATIONS = 5;
const MAX_WALL_SLICES = 512;
const SLEEP_SECONDS = 0.35;
const SLEEP_SPEED = 0.012;
const NONE = -1;
const FLOOR = -2;
const CEILING = -3;
const SIDE = -4;

/** Position-based granular contacts (Macklin et al., 2014): mass-weighted
 * nonpenetration and relative-displacement Coulomb friction. A local Darcy-inspired
 * effective resistance closure does not solve gas velocity, pressure, or mass conservation.
 * Units are metres, seconds and m/s²; MATERIALS density is effective grain kg/m³.
 */
export class Physics {
  readonly count: number;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly radii: Float32Array;
  readonly neckRadius: number;
  material = 1;
  readonly stats: PhysicsStats = {
    ms: 0, contacts: 0, steps: 0, dropped: 0,
    active: 0, sleeping: 0, supportedActive: 0, neighborChecks: 0, substeps: 0,
  };
  private readonly inverseMass: Float32Array;
  private readonly previous: Float32Array;
  /** Constraint displacement, accumulated without subtracting rounded world coordinates. */
  private readonly correction: Float64Array;
  private readonly incoming: Float32Array;
  /** Pre-force motion distinguishes impacts from this substep's support load. */
  private readonly preForceVelocity:Float32Array;
  private readonly stepStart: Float32Array;
  private readonly largest: number;
  private readonly smallest: number;
  private readonly diameter: number;
  private readonly cellSize: number;
  private readonly pairSkin: number;
  private readonly pairReference: Float32Array;
  private pairA: Int32Array;
  private pairB: Int32Array;
  private pairCount = 0;
  private pairActiveCount = 0;
  private readonly wallNormals: Float32Array;
  private readonly wallY: Float64Array;
  private readonly wallRadius: Float64Array;
  private readonly wallSlope: Float64Array;
  private readonly wallLength: Float64Array;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cellCounts: Int32Array;
  private readonly cellOffsets: Int32Array;
  private readonly cellCursor: Int32Array;
  private readonly sorted: Int32Array;
  private readonly cells: Int32Array;
  private readonly active: Int32Array;
  private readonly activeIndex: Int32Array;
  private readonly orderNext: Int32Array;
  private readonly orderHeads: Int32Array;
  private readonly orderTails: Int32Array;
  private activeCount = 0;
  private readonly sleepTime: Float32Array;
  private readonly sleepAnchor: Float32Array;
  private readonly contactCount: Uint8Array;
  private readonly support: Int32Array;
  private readonly supportAlignment: Float32Array;
  private readonly grounded: Uint8Array;
  private readonly supportPath: Int32Array;
  private accumulator = 0;
  private wakeAx = 0;
  private wakeAy = 0;
  private wakeAz = 0;
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private gravity = 0;
  private stabilizing = false;
  private ambientResistance = 0;
  private wallSupportCos=1;
  private capSupportCos=1;

  constructor(count: number, material = 1, neckRadius = neckRadiusFor(count), private airResistanceScale = 1) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100_000)
      throw new RangeError("count must be an integer from 1 to 100000");
    if (!Number.isFinite(neckRadius) || neckRadius <= 0 || neckRadius >= MAX_RADIUS)
      throw new RangeError("neckRadius must lie between zero and MAX_RADIUS");
    if (!Number.isFinite(airResistanceScale) || airResistanceScale < 0)
      throw new RangeError("airResistanceScale must be finite and nonnegative");
    this.count = count;
    this.neckRadius = neckRadius;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.radii = new Float32Array(count);
    this.inverseMass = new Float32Array(count);
    this.previous = new Float32Array(count * 3);
    this.correction = new Float64Array(count * 3);
    this.incoming = new Float32Array(count * 3);
    this.preForceVelocity=new Float32Array(count*3);
    this.stepStart = new Float32Array(count * 3);
    const base = grainBaseRadius(count);
    let cubes = 0;
    for (let i = 0; i < count; i++) {
      const factor = 0.8 + 0.4 * ((i * 0.618033988749895) % 1);
      this.radii[i] = factor;
      cubes += this.radii[i] ** 3;
    }
    const normalization = Math.cbrt(count / cubes);
    let largest = 0;
    let smallest = Infinity;
    for (let i = 0; i < count; i++) {
      this.radii[i] *= base * normalization;
      largest = Math.max(largest, this.radii[i]);
      smallest = Math.min(smallest, this.radii[i]);
      this.inverseMass[i] = (base / this.radii[i]) ** 3;
    }
    this.largest = largest;
    this.smallest = smallest;
    this.diameter = largest * 2;
    this.pairSkin = this.diameter * 0.25;
    this.cellSize = this.diameter + this.pairSkin;
    this.pairReference = new Float32Array(count * 3);
    this.pairA = new Int32Array(count * 48);
    this.pairB = new Int32Array(count * 48);
    this.wallNormals = new Float32Array(count * 3);
    this.wallY = new Float64Array(count);
    this.wallY.fill(NaN);
    this.wallRadius = new Float64Array(count);
    this.wallSlope = new Float64Array(count);
    this.wallLength = new Float64Array(count);
    this.nx = Math.ceil(2 * MAX_RADIUS / this.cellSize) + 3;
    this.ny = Math.ceil(2 * HALF_HEIGHT / this.cellSize) + 3;
    const gridCells = this.nx * this.ny * this.nx;
    this.cellCounts = new Int32Array(gridCells);
    this.cellOffsets = new Int32Array(gridCells + 1);
    this.cellCursor = new Int32Array(gridCells);
    this.sorted = new Int32Array(count);
    this.cells = new Int32Array(count);
    this.active = new Int32Array(count);
    this.activeIndex = new Int32Array(count);
    this.orderNext = new Int32Array(count);
    this.orderHeads = new Int32Array(this.nx * 2 + this.ny + 4);
    this.orderTails = new Int32Array(this.orderHeads.length);
    this.sleepTime = new Float32Array(count);
    this.sleepAnchor = new Float32Array(count * 3);
    this.contactCount = new Uint8Array(count);
    this.support = new Int32Array(count);
    this.supportAlignment = new Float32Array(count);
    this.grounded = new Uint8Array(count);
    this.supportPath = new Int32Array(count);
    this.setMaterial(material);
    this.reset();
  }

  reset(): void {
    this.velocities.fill(0);
    this.sleepTime.fill(0);
    this.contactCount.fill(0);
    this.support.fill(NONE);
    this.grounded.fill(0);
    this.accumulator = 0;
    this.wakeAx = this.wakeAy = this.wakeAz = 0;
    this.stats.ms = this.stats.contacts = this.stats.steps = this.stats.dropped = 0;
    this.stats.neighborChecks = this.stats.substeps = this.stats.sleeping = 0;
    this.stats.supportedActive = 0;
    this.activeCount = this.count;
    this.pairActiveCount = -1;
    const spacing = this.diameter * 1.01;
    const rowSpacing = spacing * Math.sqrt(3) / 2;
    const layerSpacing = spacing * Math.sqrt(2 / 3);
    let grain = 0;
    let layer = 0;
    // Non-overlapping close-packed layers fill from the throat, with no suspended ceiling sheet.
    for (let y = this.largest + 1e-5; y < HALF_HEIGHT - this.largest && grain < this.count; y += layerSpacing, layer++) {
      const slope = slopeAt(y, this.neckRadius);
      const limit = radiusAt(y, this.neckRadius) - this.largest * Math.sqrt(1 + slope * slope) - 1e-5;
      if (limit < 0) continue;
      const width = Math.ceil(limit / rowSpacing) + 1;
      const offset = (layer % 2) * 0.5;
      for (let iz = -width; iz <= width && grain < this.count; iz++) {
        const z = iz * rowSpacing + offset * spacing / Math.sqrt(3);
        for (let ix = -width; ix <= width && grain < this.count; ix++) {
          const x = (ix + (iz & 1) * 0.5 + offset) * spacing;
          if (x * x + z * z > limit * limit) continue;
          const k = grain++ * 3;
          this.positions[k] = x;
          this.positions[k + 1] = y;
          this.positions[k + 2] = z;
        }
      }
    }
    if (grain !== this.count) throw new Error("Initial grain volume exceeds the upper chamber");
    for (let i = 0; i < this.count; i++) {
      this.active[i] = this.activeIndex[i] = i;
    }
    this.previous.set(this.positions);
    this.sleepAnchor.set(this.positions);
    this.stats.active = this.count;
  }

  setAirResistance(enabled:boolean):void {
    if(typeof enabled!=="boolean")throw new TypeError("Air resistance requires a boolean");
    this.airResistanceScale=enabled?1:0;
    for(let i=0;i<this.count;i++)this.wake(i);
  }

  setMaterial(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= MATERIALS.length)
      throw new RangeError("Unknown material");
    this.material = index;
    this.wallSupportCos=1/Math.hypot(1,MATERIALS[index].wallFriction);
    this.capSupportCos=1/Math.hypot(1,MATERIALS[index].friction);
    // Material changes alter the static friction cone, not positions or momentum.
    if (this.activeIndex) for (let i = 0; i < this.count; i++) this.wake(i);
  }

  step(acceleration: readonly number[], dt = FIXED_DT): void {
    this.validateAcceleration(acceleration);
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError("dt must be finite and nonnegative");
    const start = performance.now();
    this.clearWorkStats();
    if (dt > 0) this.integrate(acceleration[0], acceleration[1], acceleration[2], dt);
    this.stats.ms = performance.now() - start;
  }

  advance(elapsed: number, acceleration: readonly number[], paused = false): void {
    this.validateAcceleration(acceleration);
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw new RangeError("elapsed must be finite and nonnegative");
    const start = performance.now();
    this.clearWorkStats();
    if (paused) this.accumulator = 0;
    else {
      this.accumulator += elapsed;
      const available = Math.floor((this.accumulator + 1e-12) / FIXED_DT);
      const steps = Math.min(available, MAX_CATCH_UP_STEPS);
      this.stats.dropped += (available - steps) * FIXED_DT;
      this.accumulator = Math.max(0, this.accumulator - available * FIXED_DT);
      for (let i = 0; i < steps; i++)
        this.integrate(acceleration[0], acceleration[1], acceleration[2], FIXED_DT);
    }
    this.stats.ms = performance.now() - start;
  }

  private clearWorkStats(): void {
    this.stats.contacts = this.stats.neighborChecks = this.stats.substeps = 0;
  }

  private validateAcceleration(a: readonly number[]): void {
    if (a.length < 3 || !Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(a[2]))
      throw new RangeError("Acceleration requires three finite components");
  }

  private wake(i: number): void {
    this.sleepTime[i] = 0;
    if (this.activeIndex[i] !== NONE) return;
    this.pairActiveCount = -1;
    this.activeIndex[i] = this.activeCount;
    this.active[this.activeCount++] = i;
    this.stats.active = this.activeCount;
    this.stats.sleeping = this.count - this.activeCount;
    const k = i * 3;
    for (let axis = 0; axis < 3; axis++) {
      this.previous[k + axis] = this.positions[k + axis];
      this.correction[k + axis] = 0;
      this.incoming[k + axis] = this.velocities[k + axis];
    }
  }

  private inDragRegion(i: number): boolean {
    return Math.abs(this.positions[i * 3 + 1]) <= 2 * this.neckRadius;
  }


  private integrate(ax: number, ay: number, az: number, dt: number): void {
    const gravity = Math.hypot(ax, ay, az);
    const subdivisions = Math.ceil(dt / SUBSTEP);
    // Reject unrepresentable work before touching particle state; never clamp real acceleration.
    if (!Number.isFinite(gravity) || gravity * dt * dt > this.smallest * 100_000 || subdivisions > 4096)
      throw new RangeError("Acceleration or dt exceeds the CPU solver safety budget; current step was not advanced");
    const h = dt / subdivisions;
    this.ambientResistance=ambientDragRate(MATERIALS[this.material].density)*this.airResistanceScale;
    // Preflight active velocities before changing particle state. The acceleration
    // bound also covers sleeping grains that may wake during this outer step.
    if (Math.ceil(gravity * dt * h / (this.smallest * 0.5)) > MAX_WALL_SLICES)
      throw new RangeError("Acceleration exceeds the local wall sweep safety budget; current step was not advanced");
    for (let n = 0; n < this.activeCount; n++) {
      const i = this.active[n];
      const k = i * 3;
      const speed = Math.hypot(this.velocities[k], this.velocities[k + 1], this.velocities[k + 2]);
      if (Math.ceil((speed + gravity * dt) * h / (this.radii[i] * 0.5)) > MAX_WALL_SLICES)
        throw new RangeError("Velocity exceeds the local wall sweep safety budget; current step was not advanced");
    }
    this.gravity = gravity;
    this.gx = gravity > 0 ? ax / gravity : 0;
    this.gy = gravity > 0 ? ay / gravity : 0;
    this.gz = gravity > 0 ? az / gravity : 0;
    const change = Math.hypot(ax - this.wakeAx, ay - this.wakeAy, az - this.wakeAz);
    if (gravity < 0.05 || change > Math.max(0.025, Math.hypot(this.wakeAx, this.wakeAy, this.wakeAz) * 0.05)) {
      for (let i = 0; i < this.count; i++) this.wake(i);
      this.wakeAx = ax;
      this.wakeAy = ay;
      this.wakeAz = az;
    }
    // Public typed arrays can also be edited by calibration/tests.
    // Do not leave externally moved sleepers pinned in mid-air.
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      if (this.activeIndex[i] === NONE && (
        this.positions[k] !== this.previous[k] || this.positions[k + 1] !== this.previous[k + 1] ||
        this.positions[k + 2] !== this.previous[k + 2] || this.velocities[k] !== 0 ||
        this.velocities[k + 1] !== 0 || this.velocities[k + 2] !== 0
      )) this.wake(i);
    }
    this.validateSupports();
    for (let i = 0; i < this.count; i++)
      if (this.activeIndex[i] === NONE && (this.grounded[i] !== 2 || this.inDragRegion(i))) this.wake(i);
    this.stepStart.set(this.positions);
    const p = this.positions;
    const v = this.velocities;
    const resistance = bedDragRate(MATERIALS[this.material].density) * this.airResistanceScale;
    for (let sub = 0; sub < subdivisions; sub++) {
      for(let n=0;n<this.activeCount;n++){
        const k=this.active[n]*3;
        this.preForceVelocity[k]=v[k];
        this.preForceVelocity[k+1]=v[k+1];
        this.preForceVelocity[k+2]=v[k+2];
      }
      // Only externally supplied initial overlap needs position-only repair.
      // Repeating frictionless repair every substep bypasses granular friction
      // and creeps a resting pile outward.
      if(this.stats.steps===0&&sub===0){
        this.stabilizing = true;
        this.solvePairs(h, false);
        for(let n=0;n<this.activeCount;n++){
          const i=this.active[n];
          this.solveWalls(i,h,false);
        }
        this.stabilizing = false;
      }
      for (let n = 0; n < this.activeCount; n++) {
        const i = this.active[n];
        const k = i * 3;
        this.support[i] = NONE;
        this.supportAlignment[i] = 0;
        for (let axis = 0; axis < 3; axis++) {
          this.previous[k + axis] = p[k + axis];
          this.correction[k + axis] = 0;
        }
        v[k] += ax * h;
        v[k + 1] += ay * h;
        v[k + 2] += az * h;
        // Coarse fine-sand bed: Darcy drag exists only in a contacting neck plug.
        // ponytail: quasi-steady permeability, not transient gas CFD; use a pressure grid for resolved airflow.
        const axial = p[k + 1] / (2 * this.neckRadius);
        const packedRate=this.contactCount[i]>=2&&Math.abs(axial)<1?resistance*(1-axial*axial)**2:0;
        const decay=1/(1+(this.ambientResistance+packedRate)*h);
        v[k] *= decay;
        v[k+1] *= decay;
        v[k+2] *= decay;
        this.contactCount[i] = 0;
        // Only this moving grain pays for high-speed wall sweeps. Sleeping grains
        // never enter a CFL scan or an integration/neighbor pass.
        const travel = Math.hypot(v[k], v[k + 1], v[k + 2]) * h;
        const slices = Math.max(1, Math.ceil(travel / (this.radii[i] * 0.5)));
        if (!Number.isFinite(slices) || slices > MAX_WALL_SLICES)
          throw new RangeError("Collision velocity exceeds the local wall sweep safety budget; step may be partially advanced");
        const slice = h / slices;
        for (let s = 0; s < slices; s++) {
          p[k] += v[k] * slice;
          p[k + 1] += v[k + 1] * slice;
          p[k + 2] += v[k + 2] * slice;
          if (slices > 1) this.solveWalls(i, slice, true);
        }
        for (let axis = 0; axis < 3; axis++) {
          this.incoming[k + axis] = v[k + axis];
        }
      }
      this.orderActive();
      for (let iteration = 0; iteration < CONTACT_ITERATIONS; iteration++) {
        this.solvePairs(h, false);
        for (let n = 0; n < this.activeCount; n++) {
          const i = this.active[n];
          this.solveWalls(i, h, false);
        }
      }
      for (let n = 0; n < this.activeCount; n++) {
        const i = this.active[n];
        const k = i * 3;
        for (let axis = 0; axis < 3; axis++)
          v[k + axis] = this.incoming[k + axis] + this.correction[k + axis] / h;
      }
      this.solvePairs(h, true);
      for (let n = 0; n < this.activeCount; n++) this.wallVelocity(this.active[n]);
      if (sub === subdivisions - 1 && this.gravity >= 0.05) for (let pass = 0; pass < 2; pass++) {
        this.solvePairs(h, true, false);
        for (let n = 0; n < this.activeCount; n++) this.wallVelocity(this.active[n], false);
      }
      this.stats.substeps++;
    }
    this.updateSleep(dt);
    this.stats.steps++;
  }

  private orderActive(): void {
    if (this.gravity < 0.05) return;
    this.orderHeads.fill(NONE);
    this.orderTails.fill(NONE);
    // Stable counting order along gravity: bottom contacts propagate support
    // upward first. Neither masses nor physical acceleration are rescaled.
    for (let n = 0; n < this.activeCount; n++) {
      const i = this.active[n];
      const k = i * 3;
      const height = this.positions[k] * this.gx + this.positions[k + 1] * this.gy + this.positions[k + 2] * this.gz;
      const bucket = Math.max(0, Math.min(this.orderHeads.length - 1,
        Math.floor((height + HALF_HEIGHT + MAX_RADIUS * 2) / this.diameter)));
      const tail = this.orderTails[bucket];
      if (tail === NONE) this.orderHeads[bucket] = i;
      else this.orderNext[tail] = i;
      this.orderTails[bucket] = i;
      this.orderNext[i] = NONE;
    }
    let n = 0;
    for (let bucket = this.orderHeads.length - 1; bucket >= 0; bucket--)
      for (let i = this.orderHeads[bucket]; i !== NONE; i = this.orderNext[i]) {
        this.active[n] = i;
        this.activeIndex[i] = n++;
      }
  }

  /** Count / exclusive scan / scatter keeps each cell's indices contiguous,
   * as in grain-cuda-sand's countGrains / scatterGrains compute pipeline.
   * No bucket capacity or neighbor cap can discard a particle.
   */
  private buildGrid(): void {
    this.cellCounts.fill(0);
    const inverseCell = 1 / this.cellSize;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      const x = Math.max(1, Math.min(this.nx - 2, Math.floor((this.positions[k] + MAX_RADIUS) * inverseCell) + 1));
      const y = Math.max(1, Math.min(this.ny - 2, Math.floor((this.positions[k + 1] + HALF_HEIGHT) * inverseCell) + 1));
      const z = Math.max(1, Math.min(this.nx - 2, Math.floor((this.positions[k + 2] + MAX_RADIUS) * inverseCell) + 1));
      const cell = x + this.nx * (y + this.ny * z);
      this.cells[i] = cell;
      this.cellCounts[cell]++;
    }
    let offset = 0;
    for (let cell = 0; cell < this.cellCounts.length; cell++) {
      this.cellOffsets[cell] = this.cellCursor[cell] = offset;
      offset += this.cellCounts[cell];
    }
    this.cellOffsets[this.cellCounts.length] = offset;
    for (let i = 0; i < this.count; i++) this.sorted[this.cellCursor[this.cells[i]]++] = i;
  }

  private recordSupport(i: number, support: number, alignment: number): void {
    // A wall alone supports rest only inside its Coulomb cone. Merely touching
    // a steep funnel is not static support, especially with slow air-damped flow.
    if(support<NONE&&alignment<(support===SIDE?this.wallSupportCos:this.capSupportCos))return;
    // A direct wall contact already supplies a complete support chain. Do not
    // replace it with a steeper grain contact whose chain may end in freefall.
    if (alignment > 0.15 && (support < NONE ||
      (this.support[i] >= NONE && alignment > this.supportAlignment[i]))) {
      this.support[i] = support;
      this.supportAlignment[i] = alignment;
    }
  }

  /** Verlet candidates over Müller's 27-cell grid. Rebuild before the skin can
   * close: both moving endpoints may consume half the margin.
   * https://matthias-research.github.io/pages/tenMinutePhysics/11-hashing.pdf
   */
  private preparePairs(): void {
    if (this.activeCount === 0) {
      this.pairCount = this.pairActiveCount = 0;
      return;
    }
    const p = this.positions;
    const threshold = (this.pairSkin - this.smallest * 0.04) * 0.5;
    const threshold2 = threshold * threshold;
    let rebuild = this.pairActiveCount !== this.activeCount;
    for (let n = 0; !rebuild && n < this.activeCount; n++) {
      const k = this.active[n] * 3;
      const dx = p[k] - this.pairReference[k];
      const dy = p[k + 1] - this.pairReference[k + 1];
      const dz = p[k + 2] - this.pairReference[k + 2];
      rebuild = dx * dx + dy * dy + dz * dz >= threshold2;
    }
    if (!rebuild) return;
    this.buildGrid();
    this.pairReference.set(p);
    this.pairActiveCount = this.activeCount;
    this.pairCount = 0;
    const plane = this.nx * this.ny;
    for (let n = 0; n < this.activeCount; n++) {
      const i = this.active[n], a = i * 3, cell = this.cells[i];
      for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        const neighbor = cell + x + this.nx * y + plane * z;
        const end = this.cellOffsets[neighbor + 1];
        for (let at = this.cellOffsets[neighbor]; at < end; at++) {
          const j = this.sorted[at];
          if (j === i || (this.activeIndex[j] !== NONE && this.activeIndex[j] < n)) continue;
          this.stats.neighborChecks++;
          const b = j * 3;
          const dx = p[b] - p[a];
          const reach = this.radii[i] + this.radii[j] + this.pairSkin;
          if (dx > reach || dx < -reach) continue;
          const dy = p[b + 1] - p[a + 1];
          if (dy > reach || dy < -reach) continue;
          const dz = p[b + 2] - p[a + 2];
          if (dz > reach || dz < -reach) continue;
          if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
          if (this.pairCount === this.pairA.length) {
            const left = new Int32Array(this.pairA.length * 2);
            const right = new Int32Array(left.length);
            left.set(this.pairA); right.set(this.pairB);
            this.pairA = left; this.pairB = right;
          }
          this.pairA[this.pairCount] = i;
          this.pairB[this.pairCount++] = j;
        }
      }
    }
  }

  private solvePairs(h: number, velocityPass: boolean, restitution = true): void {
    this.preparePairs();
    const p = this.positions;
    const v = this.velocities;
    const friction = MATERIALS[this.material].friction;
    const tolerance = this.smallest * 0.025;
    for (let pair = 0; pair < this.pairCount; pair++) {
          const i = this.pairA[pair], j = this.pairB[pair];
          const a = i * 3, b = j * 3;
          this.stats.neighborChecks++;
          let nx = p[b] - p[a];
          let ny = p[b + 1] - p[a + 1];
          let nz = p[b + 2] - p[a + 2];
          const limit = this.radii[i] + this.radii[j];
          const d2 = nx * nx + ny * ny + nz * nz;
          if (d2 > (limit + tolerance) ** 2) continue;
          if (velocityPass && restitution) {
            this.contactCount[i] = Math.min(255, this.contactCount[i] + 1);
            this.contactCount[j] = Math.min(255, this.contactCount[j] + 1);
          }
          const distance = Math.sqrt(d2);
          if (distance < 1e-12) { nx = 1; ny = nz = 0; }
          else { nx /= distance; ny /= distance; nz /= distance; }
          const alignment = nx * this.gx + ny * this.gy + nz * this.gz;
          this.recordSupport(i, j, alignment);
          if (this.activeIndex[j] !== NONE) this.recordSupport(j, i, -alignment);
          const penetration = Math.max(0, limit - distance);
          // Quiet support loads are not impacts. Fine-grain impacts must still
          // wake a sleeping surface; active pairs need no wake calculation.
          if (this.activeIndex[j] === NONE) {
            const impact=(this.preForceVelocity[b]-this.preForceVelocity[a])*nx+
              (this.preForceVelocity[b+1]-this.preForceVelocity[a+1])*ny+
              (this.preForceVelocity[b+2]-this.preForceVelocity[a+2])*nz;
            if (impact < -Math.max(.0001,Math.sqrt(this.gravity*this.smallest)*.03)||penetration>this.smallest*.08)
              this.wake(j);
          }
          if (!velocityPass && penetration === 0) continue;
          const wa = this.inverseMass[i];
          const wb = this.activeIndex[j] === NONE ? 0 : this.inverseMass[j];
          const inverseWeight = 1 / (wa + wb);
          if (velocityPass) {
            const relativeNormal = (v[b] - v[a]) * nx + (v[b + 1] - v[a + 1]) * ny + (v[b + 2] - v[a + 2]) * nz;
            if (!restitution && relativeNormal >= 0) continue;
            const before = (this.incoming[b] - this.incoming[a]) * nx +
              (this.incoming[b + 1] - this.incoming[a + 1]) * ny +
              (this.incoming[b + 2] - this.incoming[a + 2]) * nz;
            const bounce = before < -0.1 ? MATERIALS[this.material].restitution : 0;
            // Never restore separating motion already dissipated by another contact.
            // Extra stack passes only remove closing velocity; restitution occurs once.
            const target = !restitution ? Math.max(0, relativeNormal) :
              before < 0 ? -bounce * before : Math.max(0, Math.min(before, relativeNormal));
            const impulse = Math.max(0, target - relativeNormal) * inverseWeight;
            if (impulse === 0) continue;
            v[a] -= nx * impulse * wa;
            v[a + 1] -= ny * impulse * wa;
            v[a + 2] -= nz * impulse * wa;
            if (wb > 0) {
              v[b] += nx * impulse * wb;
              v[b + 1] += ny * impulse * wb;
              v[b + 2] += nz * impulse * wb;
            }
            if(impulse>0){
              // Speculative skin contacts can carry normal impulse without
              // penetration; they need the same Coulomb law as PBD contacts.
              const normal=(v[b]-v[a])*nx+(v[b+1]-v[a+1])*ny+(v[b+2]-v[a+2])*nz;
              const tx=v[b]-v[a]-normal*nx;
              const ty=v[b+1]-v[a+1]-normal*ny;
              const tz=v[b+2]-v[a+2]-normal*nz;
              const speed=Math.sqrt(tx*tx+ty*ty+tz*tz);
              const desired=speed*inverseWeight;
              const tangentImpulse=desired<=friction*impulse?desired:Math.min(desired,friction*.8*impulse);
              const scale=tangentImpulse/Math.max(speed,1e-12);
              v[a]+=tx*scale*wa;v[a+1]+=ty*scale*wa;v[a+2]+=tz*scale*wa;
              if(wb>0){v[b]-=tx*scale*wb;v[b+1]-=ty*scale*wb;v[b+2]-=tz*scale*wb;}
            }
          } else if (penetration > 0) {
            let dx = p[b] - this.previous[b] - p[a] + this.previous[a];
            let dy = p[b + 1] - this.previous[b + 1] - p[a + 1] + this.previous[a + 1];
            let dz = p[b + 2] - this.previous[b + 2] - p[a + 2] + this.previous[a + 2];
            const normalDisplacement = dx * nx + dy * ny + dz * nz;
            dx -= normalDisplacement * nx;
            dy -= normalDisplacement * ny;
            dz -= normalDisplacement * nz;
            const tangent = Math.sqrt(dx * dx + dy * dy + dz * dz);
            // Static friction cancels tangential displacement inside the Coulomb cone.
            // Sliding uses a smaller dynamic coefficient, never global viscous damping.
            const scale = this.stabilizing ? 0 : tangent <= friction * penetration ? 1 : Math.min(1, friction * 0.8 * penetration / Math.max(tangent, 1e-12));
            const cx = (nx * penetration - dx * scale) * inverseWeight;
            const cy = (ny * penetration - dy * scale) * inverseWeight;
            const cz = (nz * penetration - dz * scale) * inverseWeight;
            p[a] -= cx * wa;
            p[a + 1] -= cy * wa;
            p[a + 2] -= cz * wa;
            this.correction[a] -= cx * wa;
            this.correction[a + 1] -= cy * wa;
            this.correction[a + 2] -= cz * wa;
            if (wb > 0) {
              p[b] += cx * wb;
              p[b + 1] += cy * wb;
              p[b + 2] += cz * wb;
              this.correction[b] += cx * wb;
              this.correction[b + 1] += cy * wb;
              this.correction[b + 2] += cz * wb;
            }
            this.stats.contacts++;
          }
    }
  }

  private cacheWall(i: number): void {
    const y = this.positions[i * 3 + 1];
    if (y === this.wallY[i]) return;
    this.wallY[i] = y;
    const slope = slopeAt(y, this.neckRadius);
    this.wallRadius[i] = radiusAt(y, this.neckRadius);
    this.wallSlope[i] = slope;
    this.wallLength[i] = Math.sqrt(1 + slope * slope);
  }

  private solveWalls(i: number, h: number, sweep: boolean): void {
    const k = i * 3;
    const p = this.positions;
    const radius = this.radii[i];
    const top = HALF_HEIGHT - radius;
    const tolerance = this.smallest * 0.025;
    if (p[k + 1] >= top - tolerance) {
      this.recordSupport(i, CEILING, this.gy);
      if (p[k + 1] > top) this.wallConstraint(i, 0, 1, 0, p[k + 1] - top, h, sweep);
    }
    if (p[k + 1] <= -top + tolerance) {
      this.recordSupport(i, FLOOR, -this.gy);
      if (p[k + 1] < -top) this.wallConstraint(i, 0, -1, 0, -top - p[k + 1], h, sweep);
    }
    // Newton projection along the analytic surface normal, not a radial velocity clamp.
    for (let pass = 0; pass < 3; pass++) {
      const rho = Math.sqrt(p[k] * p[k] + p[k + 2] * p[k + 2]);
      this.cacheWall(i);
      const slope = this.wallSlope[i];
      const length = this.wallLength[i];
      const penetration = (rho - this.wallRadius[i]) / length + radius;
      if (rho < 1e-12 || penetration < -tolerance) break;
      const nx = p[k] / (rho * length);
      const ny = -slope / length;
      const nz = p[k + 2] / (rho * length);
      this.recordSupport(i, SIDE, nx * this.gx + ny * this.gy + nz * this.gz);
      if (penetration <= 0) break;
      this.wallConstraint(i, nx, ny, nz, penetration + 1e-9, h, sweep);
    }
    // Side projection can approach an end cap at the rim.
    if (p[k + 1] > top) this.wallConstraint(i, 0, 1, 0, p[k + 1] - top, h, sweep);
    if (p[k + 1] < -top) this.wallConstraint(i, 0, -1, 0, -top - p[k + 1], h, sweep);
    if (Math.abs(p[k + 1]) >= top - tolerance) {
      // At a cap/side intersection the cap projection can re-enter the side.
      // Project their intersection radially without undoing either constraint.
      this.cacheWall(i);
      const rho = Math.sqrt(p[k] * p[k] + p[k + 2] * p[k + 2]);
      const limit = this.wallRadius[i] - radius * this.wallLength[i] - 1e-9;
      if (rho > limit && rho > 1e-12) {
        const scale = Math.max(0, limit) / rho;
        const dx = p[k] * (scale - 1), dz = p[k + 2] * (scale - 1);
        p[k] += dx; p[k + 2] += dz;
        if (!sweep) {
          this.correction[k] += dx;
          this.correction[k + 2] += dz;
        }
        this.stats.contacts++;
      }
    }
  }

  private wallConstraint(i: number, nx: number, ny: number, nz: number, penetration: number, h: number, sweep: boolean): void {
    const k = i * 3;
    const p = this.positions;
    const v = this.velocities;
    // Rough inner end caps differ from the smooth curved glass.
    const friction = nx===0&&nz===0?MATERIALS[this.material].friction:MATERIALS[this.material].wallFriction;
    let dx = sweep ? v[k] * h : p[k] - this.previous[k];
    let dy = sweep ? v[k + 1] * h : p[k + 1] - this.previous[k + 1];
    let dz = sweep ? v[k + 2] * h : p[k + 2] - this.previous[k + 2];
    const normal = dx * nx + dy * ny + dz * nz;
    dx -= normal * nx;
    dy -= normal * ny;
    dz -= normal * nz;
    const tangent = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const scale = this.stabilizing ? 0 : tangent <= friction * penetration ? 1 : Math.min(1, friction * 0.8 * penetration / Math.max(tangent, 1e-12));
    p[k] -= nx * penetration + dx * scale;
    p[k + 1] -= ny * penetration + dy * scale;
    p[k + 2] -= nz * penetration + dz * scale;
    if (!sweep) {
      this.correction[k] -= nx * penetration + dx * scale;
      this.correction[k + 1] -= ny * penetration + dy * scale;
      this.correction[k + 2] -= nz * penetration + dz * scale;
    }
    if (sweep) {
      const speed = v[k] * nx + v[k + 1] * ny + v[k + 2] * nz;
      if (speed > 0) {
        const bounce = speed > 0.1 ? MATERIALS[this.material].restitution : 0;
        v[k] -= (1 + bounce) * speed * nx + dx * scale / h;
        v[k + 1] -= (1 + bounce) * speed * ny + dy * scale / h;
        v[k + 2] -= (1 + bounce) * speed * nz + dz * scale / h;
      }
    }
    this.stats.contacts++;
  }

  private wallVelocity(i: number, restitution = true): void {
    const k = i * 3;
    const p = this.positions;
    const top = HALF_HEIGHT - this.radii[i];
    const tolerance = this.smallest * 0.04;
    if (p[k + 1] >= top - tolerance) this.limitWallVelocity(i, 0, 1, 0, restitution);
    if (p[k + 1] <= -top + tolerance) this.limitWallVelocity(i, 0, -1, 0, restitution);
    if (restitution) {
      this.wallNormals[k] = this.wallNormals[k + 1] = this.wallNormals[k + 2] = 0;
      const rho = Math.sqrt(p[k] * p[k] + p[k + 2] * p[k + 2]);
      this.cacheWall(i);
      const slope = this.wallSlope[i];
      const length = this.wallLength[i];
      if (rho > 1e-12 && (rho - this.wallRadius[i]) / length + this.radii[i] >= -tolerance) {
        this.wallNormals[k] = p[k] / (rho * length);
        this.wallNormals[k + 1] = -slope / length;
        this.wallNormals[k + 2] = p[k + 2] / (rho * length);
      }
    }
    if (this.wallNormals[k] !== 0 || this.wallNormals[k + 2] !== 0)
      this.limitWallVelocity(i, this.wallNormals[k], this.wallNormals[k + 1], this.wallNormals[k + 2], restitution);
  }

  private limitWallVelocity(i: number, nx: number, ny: number, nz: number, restitution: boolean): void {
    const k = i * 3;
    const v = this.velocities;
    const before = this.incoming[k] * nx + this.incoming[k + 1] * ny + this.incoming[k + 2] * nz;
    if (restitution && before < -1e-7) return;
    const current = v[k] * nx + v[k + 1] * ny + v[k + 2] * nz;
    const bounce = before > 0.1 ? MATERIALS[this.material].restitution : 0;
    const change = restitution ? Math.min(0, -bounce * before - current) : -Math.max(0, current);
    v[k] += change * nx;
    v[k + 1] += change * ny;
    v[k + 2] += change * nz;
    if(change<0){
      const tx=v[k]-(current+change)*nx;
      const ty=v[k+1]-(current+change)*ny;
      const tz=v[k+2]-(current+change)*nz;
      const speed=Math.sqrt(tx*tx+ty*ty+tz*tz);
      const friction=nx===0&&nz===0?MATERIALS[this.material].friction:MATERIALS[this.material].wallFriction;
      const removed=speed<=friction*-change?speed:Math.min(speed,friction*.8*-change);
      const scale=removed/Math.max(speed,1e-12);
      v[k]-=tx*scale;v[k+1]-=ty*scale;v[k+2]-=tz*scale;
    }
  }

  private supportValid(i: number): boolean {
    const parent = this.support[i];
    const k = i * 3;
    const p = this.positions;
    const radius = this.radii[i];
    const tolerance = this.smallest * 0.08;
    if (this.gravity < 0.05 || parent === NONE) return false;
    if (parent === FLOOR) return -this.gy >= this.capSupportCos && p[k + 1] <= -HALF_HEIGHT + radius + tolerance;
    if (parent === CEILING) return this.gy >= this.capSupportCos && p[k + 1] >= HALF_HEIGHT - radius - tolerance;
    if (parent === SIDE) {
      const rho = Math.sqrt(p[k] * p[k] + p[k + 2] * p[k + 2]);
      this.cacheWall(i);
      const slope = this.wallSlope[i];
      const length = this.wallLength[i];
      return rho > 1e-12 && (rho - this.wallRadius[i]) / length + radius >= -tolerance &&
        (p[k] * this.gx / rho - slope * this.gy + p[k + 2] * this.gz / rho) / length >= this.wallSupportCos;
    }
    const b = parent * 3;
    const dx = p[b] - p[k];
    const dy = p[b + 1] - p[k + 1];
    const dz = p[b + 2] - p[k + 2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return distance <= radius + this.radii[parent] + tolerance &&
      dx * this.gx + dy * this.gy + dz * this.gz > distance * 0.15;
  }

  private validateSupports(): void {
    // 0 unknown, 1 visiting, 2 reaches a wall, 3 unsupported. Memoization keeps
    // support validation linear, including waking an entire unsupported chain.
    this.grounded.fill(0);
    for (let i = 0; i < this.count; i++) {
      if (this.grounded[i] !== 0) continue;
      let length = 0;
      let current = i;
      let valid = false;
      while (true) {
        if (this.grounded[current] !== 0) {
          valid = this.grounded[current] === 2;
          break;
        }
        this.grounded[current] = 1;
        this.supportPath[length++] = current;
        if (!this.supportValid(current)) break;
        const parent = this.support[current];
        if (parent < NONE) { valid = true; break; }
        current = parent;
      }
      while (length > 0) this.grounded[this.supportPath[--length]] = valid ? 2 : 3;
    }
  }

  private updateSleep(dt: number): void {
    this.validateSupports();
    for (let i = 0; i < this.count; i++)
      if (this.activeIndex[i] === NONE && (this.grounded[i] !== 2 || this.inDragRegion(i))) this.wake(i);
    const p = this.positions;
    const v = this.velocities;
    let supportedActive = 0;
    for (let n = 0; n < this.activeCount;) {
      const i = this.active[n];
      const k = i * 3;
      const speed = Math.hypot(v[k], v[k + 1], v[k + 2]);
      const movement = Math.hypot(p[k] - this.stepStart[k], p[k + 1] - this.stepStart[k + 1], p[k + 2] - this.stepStart[k + 2]);
      if (!this.inDragRegion(i) && this.grounded[i] === 2 && speed < SLEEP_SPEED && movement < this.radii[i] * 0.02) {
        if (this.sleepTime[i] === 0) {
          this.sleepAnchor[k] = p[k];
          this.sleepAnchor[k + 1] = p[k + 1];
          this.sleepAnchor[k + 2] = p[k + 2];
        }
        const drift = Math.hypot(p[k] - this.sleepAnchor[k], p[k + 1] - this.sleepAnchor[k + 1], p[k + 2] - this.sleepAnchor[k + 2]);
        if (drift < this.radii[i] * 0.05) this.sleepTime[i] += dt;
        else this.sleepTime[i] = 0;
      } else this.sleepTime[i] = 0;
      if (this.sleepTime[i] >= SLEEP_SECONDS) {
        this.pairActiveCount = -1;
        this.activeIndex[i] = NONE;
        this.activeCount--;
        const replacement = this.active[this.activeCount];
        this.active[n] = replacement;
        if (replacement !== i) this.activeIndex[replacement] = n;
        v[k] = v[k + 1] = v[k + 2] = 0;
        this.preForceVelocity[k]=this.preForceVelocity[k+1]=this.preForceVelocity[k+2]=0;
        this.previous[k] = p[k];
        this.previous[k + 1] = p[k + 1];
        this.previous[k + 2] = p[k + 2];
        this.incoming[k] = this.incoming[k + 1] = this.incoming[k + 2] = 0;
      } else {
        if (this.grounded[i] === 2) supportedActive++;
        n++;
      }
    }
    this.stats.active = this.activeCount;
    this.stats.sleeping = this.count - this.activeCount;
    this.stats.supportedActive = supportedActive;
  }
}
