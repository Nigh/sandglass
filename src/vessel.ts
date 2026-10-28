export const HALF_HEIGHT = 0.18;
export const MAX_RADIUS = 0.09;
export const FIXED_DT = 1 / 120;

/** Fine-sand permeability, separate from the coarse collision sampling radius. */
export const MICRO_GRAIN_DIAMETER = 26e-6; // m, effective fine-sand diameter
const POROSITY = 0.4;
const AIR_VISCOSITY = 1.8e-5; // Pa·s
const SPHERICITY = 0.65; // effective angular-grain hydraulic shape factor
const PERMEABILITY = (MICRO_GRAIN_DIAMETER * SPHERICITY) ** 2 * POROSITY ** 3 / (180 * (1 - POROSITY) ** 2); // m²

/** Darcy resistance per solid mass, s⁻¹. No target speed or timer enters the solver. */
export function bedDragRate(density: number): number {
  return AIR_VISCOSITY / (density * PERMEABILITY);
}

/** Dilute Stokes drag, s⁻¹; applies to fine sand in ambient air, not to the sensor input. */
export function ambientDragRate(density: number): number {
  return 18 * AIR_VISCOSITY / (density * MICRO_GRAIN_DIAMETER ** 2);
}

/** Volume-equivalent coarse material-point radius, in metres; not a resolved microscopic grain. */
export function grainBaseRadius(count: number): number {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100_000)
    throw new RangeError("count must be an integer from 1 to 100000");
  // ponytail: one control increases volume while refining grains; split quantity
  // from resolution only if independent controls become necessary.
  return Math.min(0.0073, 0.0016 * (1000 / count) ** 0.25);
}

/** Geometric clearance plus a fixed fine-sand hydraulic opening; no target timer. */
export function neckRadiusFor(count: number): number {
  return Math.min(MAX_RADIUS * 0.95, Math.max(6.5 * grainBaseRadius(count), 0.0069));
}

const REFERENCE_VOLUME=1000*grainBaseRadius(1000)**3;
const REFERENCE_NECK=neckRadiusFor(1000);
/** Rough 1g/standard/air estimate from measured 1000-grain mean flux (97 s).
 * More volume and a smaller opening extend the estimate; never drives physics.
 */
export function estimatedDurationSeconds(count:number):number{
  return 97*(count*grainBaseRadius(count)**3/REFERENCE_VOLUME)*(REFERENCE_NECK/neckRadiusFor(count))**2;
}

/** Analytic surface of revolution; end caps lie at ±HALF_HEIGHT. */
export function radiusAt(y: number, neckRadius: number): number {
  const clamped = Math.max(-HALF_HEIGHT, Math.min(HALF_HEIGHT, y));
  const sine = Math.sin((Math.PI * clamped) / (2 * HALF_HEIGHT));
  return neckRadius + (MAX_RADIUS - neckRadius) * sine * sine;
}

/** Exact derivative of radiusAt, including its clamped extension. */
export function slopeAt(y: number, neckRadius: number): number {
  if (Math.abs(y) >= HALF_HEIGHT) return 0;
  return ((MAX_RADIUS - neckRadius) * Math.PI * Math.sin((Math.PI * y) / HALF_HEIGHT)) / (2 * HALF_HEIGHT);
}
