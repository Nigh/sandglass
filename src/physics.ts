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
  /** Current free-translation or supported sleeping components (not rigid bodies). */
  islands: number;
  /** Members of current components; moving members remain included in active. */
  clustered: number;
  /** Particle substeps advanced using one shared velocity update per component. */
  bulkIntegrated: number;
  /** Directed internal grid candidates bypassed during swept-contact certification. */
  bulkPairSkips: number;
  /** Components refined back to particles during this step/advance. */
  islandSplits: number;
}

const MAX_CATCH_UP_STEPS = 8;
const SUBSTEP = FIXED_DT / 2;
const ITERATIONS = 5;
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
    islands: 0, clustered: 0, bulkIntegrated: 0, bulkPairSkips: 0, islandSplits: 0,
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
  private readonly nx: number;
  private readonly ny: number;
  private readonly heads: Int32Array;
  private readonly next: Int32Array;
  private readonly previousInCell: Int32Array;
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
  private readonly islandOf: Int32Array;
  private readonly islandNext: Int32Array;
  private readonly islandSize: Int32Array;
  private readonly islandReference: Float32Array;
  private readonly mergeParent: Int32Array;
  private readonly mergeSize: Uint32Array;
  private readonly mergeEligible: Uint8Array;
  private readonly mergeBlocked: Uint8Array;
  private accumulator = 0;
  private wakeAx = 0;
  private wakeAy = 0;
  private wakeAz = 0;
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private gravity = 0;
  private stabilizing = false;
  private airDecay = 1;
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
    this.nx = Math.ceil(2 * MAX_RADIUS / this.diameter) + 3;
    this.ny = Math.ceil(2 * HALF_HEIGHT / this.diameter) + 3;
    this.heads = new Int32Array(this.nx * this.ny * this.nx);
    this.next = new Int32Array(count);
    this.previousInCell = new Int32Array(count);
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
    this.islandOf = new Int32Array(count);
    this.islandNext = new Int32Array(count);
    this.islandSize = new Int32Array(count);
    this.islandReference = new Float32Array(count * 3);
    this.mergeParent = new Int32Array(count);
    this.mergeSize = new Uint32Array(count);
    this.mergeEligible = new Uint8Array(count);
    this.mergeBlocked = new Uint8Array(count);
    this.setMaterial(material);
    this.reset();
  }

  reset(): void {
    this.velocities.fill(0);
    this.sleepTime.fill(0);
    this.contactCount.fill(0);
    this.support.fill(NONE);
    this.grounded.fill(0);
    this.heads.fill(NONE);
    this.cells.fill(NONE);
    this.next.fill(NONE);
    this.previousInCell.fill(NONE);
    this.islandOf.fill(NONE);
    this.islandNext.fill(NONE);
    this.islandSize.fill(0);
    this.accumulator = 0;
    this.wakeAx = this.wakeAy = this.wakeAz = 0;
    this.stats.ms = this.stats.contacts = this.stats.steps = this.stats.dropped = 0;
    this.stats.neighborChecks = this.stats.substeps = this.stats.sleeping = 0;
    this.stats.supportedActive = 0;
    this.stats.islands = this.stats.clustered = this.stats.bulkIntegrated = 0;
    this.stats.bulkPairSkips = this.stats.islandSplits = 0;
    this.activeCount = this.count;
    const spacing = this.diameter * 1.04;
    const width = Math.ceil(MAX_RADIUS / spacing);
    let grain = 0;
    let layer = 0;
    // Fill the upper funnel from the throat, not a levitating partial ceiling sheet.
    for (let y = this.largest + 1e-5; y < HALF_HEIGHT-this.largest && grain < this.count; y += spacing, layer++) {
      const slope = slopeAt(y, this.neckRadius);
      const limit = radiusAt(y, this.neckRadius) - this.largest * Math.sqrt(1 + slope * slope) - 1e-5;
      const offset = (layer % 2) * 0.5;
      for (let iz = -width; iz <= width && grain < this.count; iz++) {
        const z = (iz + offset) * spacing;
        for (let ix = -width; ix <= width && grain < this.count; ix++) {
          const x = (ix + offset) * spacing;
          if (limit < 0 || x * x + z * z > limit * limit) continue;
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
      this.updateCell(i);
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
    this.stats.bulkIntegrated = this.stats.bulkPairSkips = this.stats.islandSplits = 0;
  }

  private validateAcceleration(a: readonly number[]): void {
    if (a.length < 3 || !Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(a[2]))
      throw new RangeError("Acceleration requires three finite components");
  }

  private wake(i: number): void {
    this.sleepTime[i] = 0;
    if (this.activeIndex[i] !== NONE) return;
    const island = this.islandOf[i];
    if (island !== NONE) {
      this.splitIsland(island, true);
      return;
    }
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

  private splitIsland(root: number, wake: boolean): void {
    if (this.islandSize[root] === 0) return;
    this.stats.islands--;
    this.stats.clustered -= this.islandSize[root];
    this.islandSize[root] = 0;
    this.stats.islandSplits++;
    for (let i = root; i !== NONE; i = this.islandNext[i]) this.islandOf[i] = NONE;
    for (let i = root; i !== NONE;) {
      const next = this.islandNext[i];
      this.islandOf[i] = NONE;
      this.islandNext[i] = NONE;
      if (wake) this.wake(i);
      i = next;
    }
  }

  /** Keep exposed sleepers individual. Six occupied axial sectors identify
   * buried samples; a separate 64-member cap bounds impact-triggered wake work.
   */
  private sleepInterior(i: number): boolean {
    const p = this.positions;
    const k = i * 3;
    const cell = this.cells[i];
    const plane = this.nx * this.ny;
    let sectors = 0;
    for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++)
      for (let j = this.heads[cell + x + this.nx * y + plane * z]; j !== NONE; j = this.next[j]) {
        if (j === i || this.activeIndex[j] !== NONE) continue;
        const b = j * 3;
        const dx = p[b] - p[k], dy = p[b + 1] - p[k + 1], dz = p[b + 2] - p[k + 2];
        if (dx * dx + dy * dy + dz * dz > (this.diameter * 1.08) ** 2) continue;
        if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz)) sectors |= dx > 0 ? 1 : 2;
        else if (Math.abs(dy) >= Math.abs(dz)) sectors |= dy > 0 ? 4 : 8;
        else sectors |= dz > 0 ? 16 : 32;
        if (sectors === 63) return true;
      }
    return false;
  }

  /** Certify the swept sphere against the analytic profile, not just its endpoint.
   * The global derivative bound also covers the wall solver's normal-distance test.
   */
  private freeSweep(i: number, vx: number, vy: number, vz: number, h: number): boolean {
    if (this.inDragRegion(i)) return false;
    const k = i * 3;
    const p = this.positions;
    const x = p[k] + vx * h;
    const y = p[k + 1] + vy * h;
    const z = p[k + 2] + vz * h;
    const radius = this.radii[i] + this.smallest * 0.08;
    if (Math.max(Math.abs(p[k + 1]), Math.abs(y)) + radius >= HALF_HEIGHT) return false;
    if (Math.min(Math.abs(p[k + 1]), Math.abs(y)) <= 2 * this.neckRadius ||
      p[k + 1] * y < 0) return false;
    const nearY = Math.abs(p[k + 1]) < Math.abs(y) ? p[k + 1] : y;
    const slopeBound = (MAX_RADIUS - this.neckRadius) * Math.PI / (2 * HALF_HEIGHT);
    const rho = Math.max(Math.hypot(p[k], p[k + 2]), Math.hypot(x, z));
    return rho + radius * Math.sqrt(1 + slopeBound * slopeBound) <
      radiusAt(nearY, this.neckRadius);
  }

  private mergeRoot(i: number): number {
    let root = i;
    while (this.mergeParent[root] !== root) root = this.mergeParent[root];
    while (i !== root) {
      const next = this.mergeParent[i];
      this.mergeParent[i] = root;
      i = next;
    }
    return root;
  }

  /** Conservative translational subset of adaptive model reduction:
   * https://arxiv.org/abs/1510.01507 . No velocity averaging, rotation, or bonds.
   * Supported sleeping components follow https://box2d.org/posts/2023/10/simulation-islands/ .
   */
  private prepareIslands(ax: number, ay: number, az: number, h: number): void {
    const p = this.positions;
    const v = this.velocities;
    for (let root = 0; root < this.count; root++) {
      if (this.islandSize[root] === 0) continue;
      const moving = this.activeIndex[root] !== NONE;
      const a = root * 3;
      const vx = Math.fround(Math.fround(v[a] + ax * h) * this.airDecay);
      const vy = Math.fround(Math.fround(v[a + 1] + ay * h) * this.airDecay);
      const vz = Math.fround(Math.fround(v[a + 2] + az * h) * this.airDecay);
      for (let i = root; i !== NONE; i = this.islandNext[i]) {
        const k = i * 3;
        if (this.inDragRegion(i) || (this.activeIndex[i] !== NONE) !== moving ||
          p[k] !== this.islandReference[k] || p[k + 1] !== this.islandReference[k + 1] ||
          p[k + 2] !== this.islandReference[k + 2] ||
          v[k] !== v[a] || v[k + 1] !== v[a + 1] || v[k + 2] !== v[a + 2] ||
          (moving && !this.freeSweep(i, vx, vy, vz, h))) {
          this.splitIsland(root, !moving);
          break;
        }
      }
    }
    this.mergeBlocked.fill(0);
    for (let i = 0; i < this.count; i++) {
      this.mergeParent[i] = i;
      this.mergeSize[i] = 1;
      const k = i * 3;
      this.mergeEligible[i] = this.islandOf[i] === NONE && !this.inDragRegion(i) &&
        (this.activeIndex[i] === NONE ? this.sleepInterior(i) :
          this.freeSweep(i, Math.fround(Math.fround(v[k] + ax * h) * this.airDecay),
            Math.fround(Math.fround(v[k + 1] + ay * h) * this.airDecay), Math.fround(Math.fround(v[k + 2] + az * h) * this.airDecay), h)) ? 1 : 0;
    }
    const plane = this.nx * this.ny;
    for (let i = 0; i < this.count; i++) {
      if (!this.mergeEligible[i]) continue;
      const a = i * 3;
      const cell = this.cells[i];
      for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        for (let j = this.heads[cell + x + this.nx * y + plane * z]; j !== NONE; j = this.next[j]) {
          if (j <= i || !this.mergeEligible[j] ||
            (this.activeIndex[i] === NONE) !== (this.activeIndex[j] === NONE)) continue;
          const b = j * 3;
          if (v[a] !== v[b] || v[a + 1] !== v[b + 1] || v[a + 2] !== v[b + 2]) continue;
          this.stats.neighborChecks++;
          const distance = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
          const limit = this.radii[i] + this.radii[j];
          if (distance > this.diameter * 1.08) continue;
          let left = this.mergeRoot(i);
          let right = this.mergeRoot(j);
          if (left > right) {
            const swap = left;
            left = right;
            right = swap;
          }
          if (left !== right && this.activeIndex[i] === NONE &&
            this.mergeSize[left] + this.mergeSize[right] > 64) continue;
          if (left !== right) {
            this.mergeParent[right] = left;
            this.mergeSize[left] += this.mergeSize[right];
            this.mergeBlocked[left] |= this.mergeBlocked[right];
          }
          // Never hide an existing penetration inside a reduced component.
          if (this.activeIndex[i] !== NONE && distance < limit - this.smallest * 1e-5)
            this.mergeBlocked[left] = 1;
        }
      }
    }
    for (let i = 0; i < this.count; i++) {
      if (!this.mergeEligible[i]) continue;
      const root = this.mergeRoot(i);
      if (this.mergeBlocked[root]) continue;
      this.islandOf[i] = root;
      if (i === root) {
        this.stats.islands++;
        this.islandNext[i] = NONE;
      } else {
        this.islandNext[i] = this.islandNext[root];
        this.islandNext[root] = i;
      }
      this.islandSize[root]++;
      this.stats.clustered++;
      const k = i * 3;
      for (let axis = 0; axis < 3; axis++) this.islandReference[k + axis] = p[k + axis];
    }
    for (let root = 0; root < this.count; root++) {
      if (this.islandSize[root] === 1) {
        this.stats.islands--;
        this.stats.clustered--;
        this.islandSize[root] = 0;
        this.islandOf[root] = NONE;
      } else if (this.islandSize[root] > 1 && this.activeIndex[root] !== NONE &&
        this.externalSweep(root, ax, ay, az, h)) this.splitIsland(root, false);
    }
  }

  /** External swept spheres are tested once, before any member is advanced.
   * Internal member pairs never enter the PBD solver. The persistent grid supplies
   * the surface candidates; late contacts still split during ordinary PBD passes.
   */
  private externalSweep(root: number, ax: number, ay: number, az: number, h: number): boolean {
    const p = this.positions;
    const v = this.velocities;
    const a = root * 3;
    const vx = Math.fround(Math.fround(v[a] + ax * h) * this.airDecay);
    const vy = Math.fround(Math.fround(v[a + 1] + ay * h) * this.airDecay);
    const vz = Math.fround(Math.fround(v[a + 2] + az * h) * this.airDecay);
    let reach = 0;
    for (let j = 0; j < this.count; j++) {
      if (this.islandOf[j] === root) continue;
      const b = j * 3;
      const moving = this.activeIndex[j] !== NONE;
      const ux = moving ? Math.fround(Math.fround(v[b] + ax * h) * this.airDecay) : 0;
      const uy = moving ? Math.fround(Math.fround(v[b + 1] + ay * h) * this.airDecay) : 0;
      const uz = moving ? Math.fround(Math.fround(v[b + 2] + az * h) * this.airDecay) : 0;
      reach = Math.max(reach, Math.hypot(ux - vx, uy - vy, uz - vz) * h);
      if (moving && this.inDragRegion(j) && this.contactCount[j] >= 2)
        reach = Math.max(reach, Math.hypot(vx, vy, vz) * h);
    }
    const range = Math.ceil((reach + this.diameter + this.smallest * 0.05) / this.diameter);
    const plane = this.nx * this.ny;
    for (let i = root; i !== NONE; i = this.islandNext[i]) {
      const k = i * 3;
      const cell = this.cells[i];
      const cx = cell % this.nx;
      const cy = Math.floor(cell / this.nx) % this.ny;
      const cz = Math.floor(cell / plane);
      for (let z = Math.max(0, cz - range); z <= Math.min(this.nx - 1, cz + range); z++)
        for (let y = Math.max(0, cy - range); y <= Math.min(this.ny - 1, cy + range); y++)
          for (let x = Math.max(0, cx - range); x <= Math.min(this.nx - 1, cx + range); x++)
            for (let j = this.heads[x + this.nx * y + plane * z]; j !== NONE; j = this.next[j]) {
              if (this.islandOf[j] === root) {
                if (j !== i) this.stats.bulkPairSkips++;
                continue;
              }
              this.stats.neighborChecks++;
              const b = j * 3;
              const moving = this.activeIndex[j] !== NONE;
              const dx = p[b] - p[k], dy = p[b + 1] - p[k + 1], dz = p[b + 2] - p[k + 2];
              const tx = ((moving ? Math.fround(Math.fround(v[b] + ax * h) * this.airDecay) : 0) - vx) * h;
              const ty = ((moving ? Math.fround(Math.fround(v[b + 1] + ay * h) * this.airDecay) : 0) - vy) * h;
              const tz = ((moving ? Math.fround(Math.fround(v[b + 2] + az * h) * this.airDecay) : 0) - vz) * h;
              const travel2 = tx * tx + ty * ty + tz * tz;
              const t = travel2 > 0 ? Math.max(0, Math.min(1, -(dx * tx + dy * ty + dz * tz) / travel2)) : 0;
              const limit = this.radii[i] + this.radii[j] + this.smallest * 0.05;
              if (moving && this.inDragRegion(j) && this.contactCount[j] >= 2) {
                if (Math.hypot(dx, dy, dz) <= limit + reach) return true;
              } else if ((dx + t * tx) ** 2 + (dy + t * ty) ** 2 + (dz + t * tz) ** 2 <= limit * limit)
                return true;
            }
    }
    return false;
  }

  private integrateIslands(ax: number, ay: number, az: number, h: number): void {
    const p = this.positions;
    const v = this.velocities;
    for (let root = 0; root < this.count; root++) {
      if (this.islandSize[root] === 0 || this.activeIndex[root] === NONE) continue;
      const a = root * 3;
      const vx = Math.fround(Math.fround(v[a] + ax * h) * this.airDecay);
      const vy = Math.fround(Math.fround(v[a + 1] + ay * h) * this.airDecay);
      const vz = Math.fround(Math.fround(v[a + 2] + az * h) * this.airDecay);
      const travel = Math.hypot(vx, vy, vz) * h;
      for (let i = root; i !== NONE; i = this.islandNext[i]) {
        const k = i * 3;
        this.support[i] = NONE;
        this.supportAlignment[i] = 0;
        this.contactCount[i] = 0;
        for (let axis = 0; axis < 3; axis++) {
          this.previous[k + axis] = p[k + axis];
          this.correction[k + axis] = 0;
        }
        v[k] = this.incoming[k] = vx;
        v[k + 1] = this.incoming[k + 1] = vy;
        v[k + 2] = this.incoming[k + 2] = vz;
        // Match the ordinary path's Float32 coordinate rounding, including fast sweeps.
        const slices = Math.max(1, Math.ceil(travel / (this.radii[i] * 0.5)));
        for (let s = 0; s < slices; s++) {
          p[k] += vx * (h / slices);
          p[k + 1] += vy * (h / slices);
          p[k + 2] += vz * (h / slices);
        }
        for (let axis = 0; axis < 3; axis++) this.islandReference[k + axis] = p[k + axis];
        this.updateCell(i);
        this.stats.bulkIntegrated++;
      }
    }
  }

  private integrate(ax: number, ay: number, az: number, dt: number): void {
    const gravity = Math.hypot(ax, ay, az);
    const subdivisions = Math.ceil(dt / SUBSTEP);
    // Reject unrepresentable work before touching particle state; never clamp real acceleration.
    if (!Number.isFinite(gravity) || gravity * dt * dt > this.smallest * 100_000 || subdivisions > 4096)
      throw new RangeError("Acceleration or dt exceeds the CPU solver safety budget; current step was not advanced");
    const h = dt / subdivisions;
    this.ambientResistance=ambientDragRate(MATERIALS[this.material].density)*this.airResistanceScale;
    this.airDecay=1/(1+this.ambientResistance*h);
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
    // Public typed arrays can also be edited by calibration/tests. Keep the persistent
    // grid coherent, and do not leave externally moved sleepers pinned in mid-air.
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      if (this.activeIndex[i] === NONE && (
        this.positions[k] !== this.previous[k] || this.positions[k + 1] !== this.previous[k + 1] ||
        this.positions[k + 2] !== this.previous[k + 2] || this.velocities[k] !== 0 ||
        this.velocities[k + 1] !== 0 || this.velocities[k + 2] !== 0
      )) this.wake(i);
      this.updateCell(i);
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
      this.prepareIslands(ax, ay, az, h);
      // Only externally supplied initial overlap needs position-only repair.
      // Repeating frictionless repair every substep bypasses granular friction
      // and creeps a resting pile outward.
      if(this.stats.steps===0&&sub===0){
        this.stabilizing = true;
        this.solvePairs(h, false);
        for(let n=0;n<this.activeCount;n++){
          const i=this.active[n];
          if(this.islandOf[i]!==NONE)continue;
          this.solveWalls(i,h,false);
          this.updateCell(i);
        }
        this.stabilizing = false;
      }
      this.integrateIslands(ax, ay, az, h);
      for (let n = 0; n < this.activeCount; n++) {
        const i = this.active[n];
        if (this.islandOf[i] !== NONE) continue;
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
        this.updateCell(i);
      }
      this.orderActive();
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        this.solvePairs(h, false);
        for (let n = 0; n < this.activeCount; n++) {
          const i = this.active[n];
          if (this.islandOf[i] !== NONE) continue;
          this.solveWalls(i, h, false);
          this.updateCell(i);
        }
      }
      for (let n = 0; n < this.activeCount; n++) {
        const i = this.active[n];
        if (this.islandOf[i] !== NONE) continue;
        const k = i * 3;
        for (let axis = 0; axis < 3; axis++)
          v[k + axis] = this.incoming[k + axis] + this.correction[k + axis] / h;
      }
      this.solvePairs(h, true);
      for (let n = 0; n < this.activeCount; n++)
        if (this.islandOf[this.active[n]] === NONE) this.wallVelocity(this.active[n]);
      if (this.gravity >= 0.05) for (let pass = 0; pass < 2; pass++) {
        this.solvePairs(h, true, false);
        for (let n = 0; n < this.activeCount; n++)
          if (this.islandOf[this.active[n]] === NONE) this.wallVelocity(this.active[n], false);
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

  private updateCell(i: number): void {
    const k = i * 3;
    const x = Math.max(1, Math.min(this.nx - 2, Math.floor((this.positions[k] + MAX_RADIUS) / this.diameter) + 1));
    const y = Math.max(1, Math.min(this.ny - 2, Math.floor((this.positions[k + 1] + HALF_HEIGHT) / this.diameter) + 1));
    const z = Math.max(1, Math.min(this.nx - 2, Math.floor((this.positions[k + 2] + MAX_RADIUS) / this.diameter) + 1));
    const cell = x + this.nx * (y + this.ny * z);
    const old = this.cells[i];
    if (cell === old) return;
    if (old !== NONE) {
      const before = this.previousInCell[i];
      const after = this.next[i];
      if (before === NONE) this.heads[old] = after;
      else this.next[before] = after;
      if (after !== NONE) this.previousInCell[after] = before;
    }
    const head = this.heads[cell];
    this.next[i] = head;
    this.previousInCell[i] = NONE;
    if (head !== NONE) this.previousInCell[head] = i;
    this.heads[cell] = i;
    this.cells[i] = cell;
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

  private solvePairs(h: number, velocityPass: boolean, restitution = true): void {
    const p = this.positions;
    const v = this.velocities;
    const plane = this.nx * this.ny;
    const friction = MATERIALS[this.material].friction;
    for (let n = 0; n < this.activeCount; n++) {
      const i = this.active[n];
      if (this.islandOf[i] !== NONE) continue;
      const a = i * 3;
      const cell = this.cells[i];
      for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
        for (let j = this.heads[cell + x + this.nx * y + plane * z]; j !== NONE;) {
          // Position constraints update the grid after each pass, not while traversing a linked list.
          const next = this.next[j];
          if (j === i || (this.islandOf[j] === NONE &&
            this.activeIndex[j] !== NONE && this.activeIndex[j] < n)) { j = next; continue; }
          this.stats.neighborChecks++;
          const b = j * 3;
          let nx = p[b] - p[a];
          let ny = p[b + 1] - p[a + 1];
          let nz = p[b + 2] - p[a + 2];
          const limit = this.radii[i] + this.radii[j];
          const d2 = nx * nx + ny * ny + nz * nz;
          const tolerance = this.smallest * 0.025;
          if (d2 > (limit + tolerance) ** 2) { j = next; continue; }
          // A late contact after another PBD correction refines the whole island.
          // Members already received this substep's acceleration; never integrate twice.
          const island = this.islandOf[j];
          if (island !== NONE) this.splitIsland(island, this.activeIndex[j] === NONE);
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
          const relativeNormal = (v[b] - v[a]) * nx + (v[b + 1] - v[a + 1]) * ny + (v[b + 2] - v[a + 2]) * nz;
          // Quiet support loads are not impacts. Even a slow fine-sand impact
          // must wake a sleeping surface; a fixed 0.12 m/s threshold misses it.
          const impact=(this.preForceVelocity[b]-this.preForceVelocity[a])*nx+
            (this.preForceVelocity[b+1]-this.preForceVelocity[a+1])*ny+
            (this.preForceVelocity[b+2]-this.preForceVelocity[a+2])*nz;
          if(this.activeIndex[j]===NONE&&(impact < -Math.max(.0001,Math.sqrt(this.gravity*this.smallest)*.03)||penetration>this.smallest*.08))
            this.wake(j);
          const wa = this.inverseMass[i];
          const wb = this.activeIndex[j] === NONE ? 0 : this.inverseMass[j];
          const inverseWeight = 1 / (wa + wb);
          if (velocityPass) {
            const before = (this.incoming[b] - this.incoming[a]) * nx +
              (this.incoming[b + 1] - this.incoming[a + 1]) * ny +
              (this.incoming[b + 2] - this.incoming[a + 2]) * nz;
            const bounce = before < -0.1 ? MATERIALS[this.material].restitution : 0;
            // Never restore separating motion already dissipated by another contact.
            // Extra stack passes only remove closing velocity; restitution occurs once.
            const target = !restitution ? Math.max(0, relativeNormal) :
              before < 0 ? -bounce * before : Math.max(0, Math.min(before, relativeNormal));
            const impulse = Math.max(0, target - relativeNormal) * inverseWeight;
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
              const speed=Math.hypot(tx,ty,tz);
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
            const tangent = Math.hypot(dx, dy, dz);
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
          j = next;
        }
      }
    }
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
      const rho = Math.hypot(p[k], p[k + 2]);
      const slope = slopeAt(p[k + 1], this.neckRadius);
      const length = Math.sqrt(1 + slope * slope);
      const penetration = (rho - radiusAt(p[k + 1], this.neckRadius)) / length + radius;
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
    const tangent = Math.hypot(dx, dy, dz);
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
    const rho = Math.hypot(p[k], p[k + 2]);
    const slope = slopeAt(p[k + 1], this.neckRadius);
    const length = Math.sqrt(1 + slope * slope);
    if (rho > 1e-12 && (rho - radiusAt(p[k + 1], this.neckRadius)) / length + this.radii[i] >= -tolerance)
      this.limitWallVelocity(i, p[k] / (rho * length), -slope / length, p[k + 2] / (rho * length), restitution);
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
      const speed=Math.hypot(tx,ty,tz);
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
      const rho = Math.hypot(p[k], p[k + 2]);
      const slope = slopeAt(p[k + 1], this.neckRadius);
      const length = Math.sqrt(1 + slope * slope);
      return rho > 1e-12 && (rho - radiusAt(p[k + 1], this.neckRadius)) / length + radius >= -tolerance &&
        (p[k] * this.gx / rho - slope * this.gy + p[k + 2] * this.gz / rho) / length >= this.wallSupportCos;
    }
    const b = parent * 3;
    const dx = p[b] - p[k];
    const dy = p[b + 1] - p[k + 1];
    const dz = p[b + 2] - p[k + 2];
    const distance = Math.hypot(dx, dy, dz);
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
