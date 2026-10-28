export const HALF_HEIGHT = 0.043;
export const MAX_RADIUS = 0.025;
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
  return Math.min(MAX_RADIUS / 9, 0.00042 * (5000 / count) ** 0.25);
}

/** Narrow physical aperture; material-dependent arching remains part of the contact dynamics. */
export function neckRadiusFor(count: number): number {
  return 3.75 * grainBaseRadius(count);
}

/** Rounded double cone with a short throat; planar end caps lie at ±HALF_HEIGHT. */
export function radiusAt(y: number, neckRadius: number): number {
  const height = Math.min(1, Math.abs(y) / HALF_HEIGHT);
  return Math.sqrt(neckRadius * neckRadius + (MAX_RADIUS * MAX_RADIUS - neckRadius * neckRadius) * height * height);
}

/** Exact derivative inside the vessel; the clamped extension is flat beyond the end caps. */
export function slopeAt(y: number, neckRadius: number): number {
  if (Math.abs(y) >= HALF_HEIGHT) return 0;
  return (MAX_RADIUS * MAX_RADIUS - neckRadius * neckRadius) * y /
    (HALF_HEIGHT * HALF_HEIGHT * radiusAt(y, neckRadius));
}
