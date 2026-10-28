export const HALF_HEIGHT = 0.18;
export const MAX_RADIUS = 0.09;
export const NECK_RADIUS = 0.012;
export const FIXED_DT = 1 / 120;

/** Analytic surface of revolution, in metres; end caps lie at ±HALF_HEIGHT. */
export function radiusAt(y: number): number {
  const s = Math.sin(
    (Math.PI * Math.max(-HALF_HEIGHT, Math.min(HALF_HEIGHT, y))) /
      (2 * HALF_HEIGHT),
  );
  return NECK_RADIUS + (MAX_RADIUS - NECK_RADIUS) * s * s;
}

export const MATERIALS = [
  {
    name: "极细沙",
    color: 0xe8d0a2,
    friction: 0.32,
    restitution: 0.04,
    density: 1500,
  },
  {
    name: "标准沙",
    color: 0xf2b84b,
    friction: 0.55,
    restitution: 0.08,
    density: 1700,
  },
  {
    name: "粗颗粒",
    color: 0xc68f58,
    friction: 0.68,
    restitution: 0.22,
    density: 1900,
  },
  {
    name: "高摩擦晶体",
    color: 0x9cbed4,
    friction: 0.92,
    restitution: 0.12,
    density: 2600,
  },
] as const;

export interface PhysicsStats {
  /** Wall-clock CPU time for the latest step/advance, not simulated time. */
  ms: number;
  /** Contacts resolved during the latest step/advance; solver passes may repeat a pair. */
  contacts: number;
  /** Cumulative number of fixed outer steps. */
  steps: number;
  /** Cumulative seconds deliberately discarded by the catch-up budget. */
  dropped: number;
}

const MAX_SLOPE = ((MAX_RADIUS - NECK_RADIUS) * Math.PI) / (2 * HALF_HEIGHT);
const WALL_MARGIN_FACTOR = Math.sqrt(1 + MAX_SLOPE * MAX_SLOPE);
const MAX_CATCH_UP_STEPS = 8;
const MAX_SUBDIVISIONS = 128;

/** CPU particle solver. Acceleration is m/s² in fixed screen coordinates, never normalized.
 * Particle count and individual radii remain constant through collisions and material changes.
 * Grain masses are proportional to radius³; shared material density cancels out of impulses.
 */
export class Physics {
  readonly count: number;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly radii: Float32Array;
  material: number;
  readonly stats: PhysicsStats = { ms: 0, contacts: 0, steps: 0, dropped: 0 };
  private readonly radius: number;
  private readonly minRadius: number;
  private readonly inverseMass: Float32Array;
  private readonly diameter: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly heads: Int32Array;
  private readonly next: Int32Array;
  private readonly cells: Int32Array;
  private readonly touched: Int32Array;
  private touchedCount = 0;
  private accumulator = 0;

  constructor(count: number, material = 1) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
      throw new RangeError("count must be an integer from 1 to 100000");
    }
    this.count = count;
    this.material = 1;
    this.setMaterial(material);
    // Deterministic 0.8–1.2 size distribution, normalized to preserve total grain volume.
    // The small-count cap keeps even the largest grain narrower than the neck.
    const baseRadius = Math.min(0.0073, 0.0043 * Math.cbrt(1000 / count));
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.radii = new Float32Array(count);
    this.inverseMass = new Float32Array(count);
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
      this.radii[i] *= baseRadius * normalization;
      largest = Math.max(largest, this.radii[i]);
      smallest = Math.min(smallest, this.radii[i]);
      this.inverseMass[i] = (baseRadius / this.radii[i]) ** 3;
    }
    this.radius = largest;
    this.minRadius = smallest;
    this.diameter = 2 * largest;
    this.nx = Math.ceil((2 * MAX_RADIUS) / this.diameter) + 2;
    this.ny = Math.ceil((2 * HALF_HEIGHT) / this.diameter) + 2;
    this.nz = this.nx;
    this.heads = new Int32Array(this.nx * this.ny * this.nz);
    this.heads.fill(-1);
    this.next = new Int32Array(count);
    this.cells = new Int32Array(count);
    this.touched = new Int32Array(count);
    this.reset();
  }

  reset(): void {
    this.velocities.fill(0);
    this.accumulator = 0;
    this.stats.ms =
      this.stats.contacts =
      this.stats.steps =
      this.stats.dropped =
        0;
    const spacing = this.diameter * 1.04;
    const width = Math.ceil(MAX_RADIUS / spacing);
    let grain = 0;
    let layer = 0;
    for (
      let y = HALF_HEIGHT - this.radius - 1e-5;
      y > 0 && grain < this.count;
      y -= spacing, layer++
    ) {
      const limit = radiusAt(y) - this.radius * WALL_MARGIN_FACTOR - 1e-5;
      const offset = (layer % 2) * 0.5;
      for (let iz = -width; iz <= width && grain < this.count; iz++) {
        const z = (iz + offset) * spacing;
        for (let ix = -width; ix <= width && grain < this.count; ix++) {
          const x = (ix + offset) * spacing;
          if (x * x + z * z > limit * limit || limit < 0) continue;
          const p = grain++ * 3;
          this.positions[p] = x;
          this.positions[p + 1] = y;
          this.positions[p + 2] = z;
        }
      }
    }
    if (grain !== this.count)
      throw new Error("Initial grain volume exceeds the upper chamber");
  }

  setMaterial(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= MATERIALS.length) {
      throw new RangeError("Unknown material");
    }
    this.material = index;
  }

  step(acceleration: readonly number[], dt = FIXED_DT): void {
    this.validateAcceleration(acceleration);
    if (!Number.isFinite(dt) || dt < 0)
      throw new RangeError("dt must be finite and nonnegative");
    const start = performance.now();
    this.stats.contacts = 0;
    if (dt > 0)
      this.integrate(acceleration[0], acceleration[1], acceleration[2], dt);
    this.stats.ms = performance.now() - start;
  }

  advance(
    elapsed: number,
    acceleration: readonly number[],
    paused = false,
  ): void {
    this.validateAcceleration(acceleration);
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw new RangeError("elapsed must be finite and nonnegative");
    const start = performance.now();
    this.stats.contacts = 0;
    if (paused) {
      // Pause is not overload: discard the fractional remainder without counting it as dropped time.
      this.accumulator = 0;
    } else {
      this.accumulator += elapsed;
      const available = Math.floor((this.accumulator + 1e-12) / FIXED_DT);
      const steps = Math.min(available, MAX_CATCH_UP_STEPS);
      if (available > steps)
        this.stats.dropped += (available - steps) * FIXED_DT;
      this.accumulator = Math.max(0, this.accumulator - available * FIXED_DT);
      for (let i = 0; i < steps; i++) {
        this.integrate(
          acceleration[0],
          acceleration[1],
          acceleration[2],
          FIXED_DT,
        );
      }
    }
    this.stats.ms = performance.now() - start;
  }

  private validateAcceleration(a: readonly number[]): void {
    if (
      a.length < 3 ||
      !Number.isFinite(a[0]) ||
      !Number.isFinite(a[1]) ||
      !Number.isFinite(a[2])
    ) {
      throw new RangeError("Acceleration requires three finite components");
    }
  }

  private integrate(ax: number, ay: number, az: number, dt: number): void {
    const p = this.positions;
    const v = this.velocities;
    let speedSquared = 0;
    for (let k = 0; k < v.length; k += 3) {
      speedSquared = Math.max(
        speedSquared,
        v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2],
      );
    }
    // Bound travel below the smallest radius before every grid collision pass.
    // The outer clock remains 120 Hz; acceleration magnitude is never clamped or replaced by unit gravity.
    const travel = (Math.sqrt(speedSquared) + Math.hypot(ax, ay, az) * dt) * dt;
    const subdivisions = Math.max(
      1,
      Math.ceil(travel / (this.minRadius * 0.75)),
    );
    if (!Number.isFinite(subdivisions) || subdivisions > MAX_SUBDIVISIONS) {
      throw new RangeError(
        "Acceleration or velocity exceeds the CPU solver safety budget; current step was not advanced",
      );
    }
    const h = dt / subdivisions;
    for (let sub = 0; sub < subdivisions; sub++) {
      for (let k = 0; k < p.length; k += 3) {
        v[k] += ax * h;
        v[k + 1] += ay * h;
        v[k + 2] += az * h;
        p[k] += v[k] * h;
        p[k + 1] += v[k + 1] * h;
        p[k + 2] += v[k + 2] * h;
        this.confine(k);
      }
      // ponytail: two sequential impulse passes; use more passes only if measured packing error requires them.
      for (let iteration = 0; iteration < 2; iteration++) {
        this.buildGrid();
        this.collide();
        for (let k = 0; k < p.length; k += 3) this.confine(k);
      }
    }
    this.stats.steps++;
  }

  private buildGrid(): void {
    for (let i = 0; i < this.touchedCount; i++)
      this.heads[this.touched[i]] = -1;
    this.touchedCount = 0;
    const p = this.positions;
    const diameter = this.diameter;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      const x = Math.floor((p[k] + MAX_RADIUS) / diameter) + 1;
      const y = Math.floor((p[k + 1] + HALF_HEIGHT) / diameter) + 1;
      const z = Math.floor((p[k + 2] + MAX_RADIUS) / diameter) + 1;
      const cell = x + this.nx * (y + this.ny * z);
      if (this.heads[cell] === -1) this.touched[this.touchedCount++] = cell;
      this.cells[i] = cell;
      this.next[i] = this.heads[cell];
      this.heads[cell] = i;
    }
  }

  private collide(): void {
    const p = this.positions;
    const v = this.velocities;
    const radii = this.radii;
    const weights = this.inverseMass;
    const { restitution, friction } = MATERIALS[this.material];
    const plane = this.nx * this.ny;
    for (let i = 0; i < this.count; i++) {
      const a = i * 3;
      const cell = this.cells[i];
      for (let z = -1; z <= 1; z++)
        for (let y = -1; y <= 1; y++)
          for (let x = -1; x <= 1; x++) {
            for (
              let j = this.heads[cell + x + this.nx * y + plane * z];
              j !== -1;
              j = this.next[j]
            ) {
              if (j <= i) continue;
              const b = j * 3;
              let nx = p[b] - p[a];
              let ny = p[b + 1] - p[a + 1];
              let nz = p[b + 2] - p[a + 2];
              const d2 = nx * nx + ny * ny + nz * nz;
              const distanceLimit = radii[i] + radii[j];
              if (d2 >= distanceLimit * distanceLimit) continue;
              let distance = Math.sqrt(d2);
              if (distance < 1e-12) {
                nx = 1;
                ny = 0;
                nz = 0;
                distance = 0;
              } else {
                nx /= distance;
                ny /= distance;
                nz /= distance;
              }
              const weightA = weights[i];
              const weightB = weights[j];
              const inverseWeight = 1 / (weightA + weightB);
              const correction = (distanceLimit - distance) * inverseWeight;
              p[a] -= nx * correction * weightA;
              p[a + 1] -= ny * correction * weightA;
              p[a + 2] -= nz * correction * weightA;
              p[b] += nx * correction * weightB;
              p[b + 1] += ny * correction * weightB;
              p[b + 2] += nz * correction * weightB;
              const rx = v[b] - v[a];
              const ry = v[b + 1] - v[a + 1];
              const rz = v[b + 2] - v[a + 2];
              const normalSpeed = rx * nx + ry * ny + rz * nz;
              if (normalSpeed < 0) {
                // Low-speed contacts are inelastic, avoiding endless restitution jitter in a resting pile.
                const bounce = normalSpeed < -0.1 ? restitution : 0;
                const impulse = -(1 + bounce) * normalSpeed * inverseWeight;
                let jx = nx * impulse;
                let jy = ny * impulse;
                let jz = nz * impulse;
                const tx = rx - normalSpeed * nx;
                const ty = ry - normalSpeed * ny;
                const tz = rz - normalSpeed * nz;
                const tangentSpeed = Math.hypot(tx, ty, tz);
                if (tangentSpeed > 1e-12) {
                  const scale =
                    Math.min(tangentSpeed * inverseWeight, friction * impulse) /
                    tangentSpeed;
                  jx -= tx * scale;
                  jy -= ty * scale;
                  jz -= tz * scale;
                }
                v[a] -= jx * weightA;
                v[a + 1] -= jy * weightA;
                v[a + 2] -= jz * weightA;
                v[b] += jx * weightB;
                v[b + 1] += jy * weightB;
                v[b + 2] += jz * weightB;
              }
              this.stats.contacts++;
            }
          }
    }
  }

  private confine(k: number): void {
    const p = this.positions;
    const radius = this.radii[k / 3];
    const top = HALF_HEIGHT - radius;
    if (p[k + 1] > top) {
      p[k + 1] = top;
      this.wallImpulse(k, 0, 1, 0);
    } else if (p[k + 1] < -top) {
      p[k + 1] = -top;
      this.wallImpulse(k, 0, -1, 0);
    }
    const rho = Math.hypot(p[k], p[k + 2]);
    // Global profile slope gives a conservative sphere inset, including near the smooth neck.
    const limit = radiusAt(p[k + 1]) - radius * WALL_MARGIN_FACTOR;
    if (rho > limit) {
      const nx = p[k] / rho;
      const nz = p[k + 2] / rho;
      p[k] = nx * limit;
      p[k + 2] = nz * limit;
      const slope = MAX_SLOPE * Math.sin((Math.PI * p[k + 1]) / HALF_HEIGHT);
      const inverseLength = 1 / Math.sqrt(1 + slope * slope);
      this.wallImpulse(
        k,
        nx * inverseLength,
        -slope * inverseLength,
        nz * inverseLength,
      );
    }
  }

  private wallImpulse(k: number, nx: number, ny: number, nz: number): void {
    this.stats.contacts++;
    const v = this.velocities;
    const normalSpeed = v[k] * nx + v[k + 1] * ny + v[k + 2] * nz;
    if (normalSpeed <= 0) return;
    const material = MATERIALS[this.material];
    const restitution = normalSpeed > 0.1 ? material.restitution : 0;
    const normalImpulse = (1 + restitution) * normalSpeed;
    const tx = v[k] - normalSpeed * nx;
    const ty = v[k + 1] - normalSpeed * ny;
    const tz = v[k + 2] - normalSpeed * nz;
    const tangentSpeed = Math.hypot(tx, ty, tz);
    const friction =
      tangentSpeed > 1e-12
        ? Math.min(1, (material.friction * normalImpulse) / tangentSpeed)
        : 0;
    v[k] -= nx * normalImpulse + tx * friction;
    v[k + 1] -= ny * normalImpulse + ty * friction;
    v[k + 2] -= nz * normalImpulse + tz * friction;
  }
}
