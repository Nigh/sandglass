// Independent SI-unit WGSL implementation. Grid/Jacobi schedule inspiration:
// https://github.com/SamG-Coder/grain-cuda-sand (MIT, 2026).
struct Parameters {
  dimensions: vec4u, // count, nx, ny, cells
  geometry: vec4f, // cell size, substep dt, neck radius, half height
  material: vec4f, // max radius, grain friction, wall friction, restitution
  acceleration: vec4f,
  drag: vec4f, // Stokes rate, Darcy rate, unused, contact skin
}
struct Auxiliary {
  incoming: vec4f,
  correction: vec4f,
  velocity: vec4f,
}
@group(0) @binding(0) var<uniform> params: Parameters;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> velocities: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> predicted: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> corrected: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> auxiliary: array<Auxiliary>;
@group(0) @binding(6) var<storage, read_write> heads: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> links: array<u32>;
@group(0) @binding(8) var<storage, read_write> occupiedCells: array<u32>;
const NONE: u32 = 0xffffffffu;

fn radial(y: f32) -> f32 {
  let h = params.geometry.w;
  let a = params.geometry.z;
  let b = (params.material.x * params.material.x - a * a) / (h * h);
  return sqrt(a * a + b * y * y);
}

// Exact closest point on the meridional hyperbola, Newton-refined near contact.
// End caps are separate constraints. Return outward unit normal and signed gap.
fn sideDistance(p: vec3f) -> vec4f {
  let rho = length(p.xz);
  let h = params.geometry.w;
  let a = params.geometry.z;
  let b = (params.material.x * params.material.x - a * a) / (h * h);
  var t = clamp(p.y, -h, h);
  for (var iteration = 0u; iteration < 6u; iteration++) {
    let r = sqrt(a * a + b * t * t);
    let slope = b * t / r;
    let curvature = b * a * a / (r * r * r);
    let derivative = (r - rho) * slope + t - p.y;
    let second = max(0.25, 1.0 + slope * slope + (r - rho) * curvature);
    t = clamp(t - clamp(derivative / second, -0.01, 0.01), -h, h);
  }
  let r = sqrt(a * a + b * t * t);
  let slope = b * t / r;
  let direction = p.xz / max(rho, 1e-15);
  let normal = vec3f(direction.x, -slope, direction.y) / sqrt(1.0 + slope * slope);
  let gap = (rho - r - (p.y - t) * slope) / sqrt(1.0 + slope * slope);
  return vec4f(normal, gap);
}

fn frictionRemoval(tangent: vec3f, normalLoad: f32, mu: f32) -> vec3f {
  let speed = length(tangent);
  let limit = mu * max(0.0, normalLoad);
  if (speed <= limit) { return tangent; }
  return tangent * min(1.0, 0.8 * limit / max(speed, 1e-15));
}

fn projectPlane(p: vec3f, previous: vec3f, normal: vec3f, depth: f32, mu: f32) -> vec3f {
  if (depth <= 0.0) { return p; }
  let displacement = p - previous;
  let tangent = displacement - normal * dot(displacement, normal);
  return p - normal * (depth + 1e-9) - frictionRemoval(tangent, depth, mu);
}

fn projectWalls(point: vec3f, previous: vec3f, radius: f32) -> vec3f {
  var p = point;
  let top = params.geometry.w - radius;
  for (var iteration = 0u; iteration < 3u; iteration++) {
    p = projectPlane(p, previous, vec3f(0.0, 1.0, 0.0), p.y - top, params.material.y);
    p = projectPlane(p, previous, vec3f(0.0, -1.0, 0.0), -top - p.y, params.material.y);
    if (radial(p.y) - length(p.xz) < radius * 1.2) {
      let side = sideDistance(p);
      p = projectPlane(p, previous, side.xyz, side.w + radius, params.material.z);
    }
  }
  p.y = clamp(p.y, -top, top);
  // A cap clamp can re-enter the side at the rim. Solve the sphere-offset
  // surface at fixed y; radial correction cannot violate either end cap.
  for (var iteration = 0u; iteration < 3u; iteration++) {
    if (radial(p.y) - length(p.xz) >= radius * 1.2) { break; }
    let side = sideDistance(p);
    let depth = side.w + radius;
    if (depth <= 0.0) { break; }
    let rho = length(p.xz);
    let offset = (depth + 1e-9) / max(0.1, length(side.xz));
    let scale = max(0.0, rho - offset) / max(rho, 1e-15);
    p = vec3f(p.x * scale, p.y, p.z * scale);
  }
  return p;
}

fn wallImpulse(v: vec3f, incoming: vec3f, normal: vec3f, mu: f32, bounce: bool) -> vec3f {
  let before = dot(incoming, normal);
  let restitution = select(0.0, params.material.w, bounce && before > 0.1);
  let change = min(0.0, -restitution * max(0.0, before) - dot(v, normal));
  var result = v + change * normal;
  let tangent = result - normal * dot(result, normal);
  result -= frictionRemoval(tangent, -change, mu);
  return result;
}

fn wallVelocity(p: vec3f, radius: f32, velocity: vec3f, incoming: vec3f, bounce: bool) -> vec3f {
  var v = velocity;
  let top = params.geometry.w - radius;
  let skin = params.drag.w;
  if (p.y >= top - skin) { v = wallImpulse(v, incoming, vec3f(0.0, 1.0, 0.0), params.material.y, bounce); }
  if (p.y <= -top + skin) { v = wallImpulse(v, incoming, vec3f(0.0, -1.0, 0.0), params.material.y, bounce); }
  if (radial(p.y) - length(p.xz) < radius * 1.25) {
    let side = sideDistance(p);
    if (side.w + radius >= -skin) { v = wallImpulse(v, incoming, side.xyz, params.material.z, bounce); }
  }
  return v;
}

fn cellCoordinates(p: vec3f) -> vec3i {
  let origin = vec3f(params.material.x, params.geometry.w, params.material.x);
  let maximum = vec3i(i32(params.dimensions.y) - 1, i32(params.dimensions.z) - 1, i32(params.dimensions.y) - 1);
  return clamp(vec3i(floor((p + origin) / params.geometry.x)) + vec3i(1), vec3i(0), maximum);
}
fn cellIndex(c: vec3i) -> u32 {
  return u32((c.z * i32(params.dimensions.z) + c.y) * i32(params.dimensions.y) + c.x);
}
fn validCell(c: vec3i) -> bool {
  return all(c >= vec3i(0)) && c.x < i32(params.dimensions.y) && c.y < i32(params.dimensions.z) && c.z < i32(params.dimensions.y);
}
fn contactNormal(i: u32, j: u32, delta: vec3f, distance: f32) -> vec3f {
  if (distance > 1e-12) { return delta / distance; }
  // Antisymmetric for coincident centers; both directions use the same axis.
  let axis = ((min(i, j) * 1664525u) ^ (max(i, j) * 1013904223u)) % 3u;
  var n = vec3f(0.0);
  n[axis] = select(-1.0, 1.0, i > j);
  return n;
}
fn inverseMass(radius: f32) -> f32 {
  // Common density and scale cancel in each pair's inverse-mass ratio.
  let relative = params.geometry.x / radius;
  return relative * relative * relative;
}

@compute @workgroup_size(128)
fn predict(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.dimensions.x) { return; }
  let old = positions[i];
  let h = params.geometry.y;
  let axial = old.y / (2.0 * params.geometry.z);
  var packed = 0.0;
  if (velocities[i].w >= 2.0 && abs(axial) < 1.0) {
    packed = params.drag.y * (1.0 - axial * axial) * (1.0 - axial * axial);
  }
  var v = (velocities[i].xyz + params.acceleration.xyz * h) / (1.0 + (params.drag.x + packed) * h);
  var p = old.xyz;
  // Only fast particles pay for wall sweeps. Travel is never clipped: every slice
  // integrates its full time. This prevents crossing the narrow throat sideways.
  let slices = max(1u, u32(ceil(length(v) * h / (old.w * 0.5))));
  let slice = h / f32(slices);
  if (slices == 1u) {
    p += v * h;
  } else {
    for (var s = 0u; s < slices; s++) {
      let previous = p;
      p = projectWalls(p + v * slice, previous, old.w);
      v = wallVelocity(p, old.w, v, v, true);
    }
  }
  predicted[i] = vec4f(p, old.w);
  auxiliary[i].incoming = vec4f(v, 0.0);
  auxiliary[i].correction = vec4f(0.0);
  let cell = cellIndex(cellCoordinates(p));
  occupiedCells[i] = cell;
  links[i] = atomicExchange(&heads[cell], i + 1u) - 1u;
}

@compute @workgroup_size(128)
fn clearBins(@builtin(global_invocation_id) id: vec3u) {
  // Duplicate clears are atomic; every nonempty cell has at least one owner.
  if (id.x < params.dimensions.x) { atomicStore(&heads[occupiedCells[id.x]], 0u); }
}
@compute @workgroup_size(128)
fn buildBins(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.dimensions.x) { return; }
  let cell = cellIndex(cellCoordinates(predicted[i].xyz));
  occupiedCells[i] = cell;
  links[i] = atomicExchange(&heads[cell], i + 1u) - 1u;
}


@compute @workgroup_size(128)
fn solvePositions(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.dimensions.x) { return; }
  let p = predicted[i];
  let old = positions[i].xyz;
  let center = cellCoordinates(p.xyz);
  let wi = inverseMass(p.w);
  var correction = vec3f(0.0);
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let cell = center + vec3i(x, y, z);
    if (!validCell(cell)) { continue; }
    var j = atomicLoad(&heads[cellIndex(cell)]) - 1u;
    loop {
      if (j == NONE) { break; }
      if (j != i) {
        let q = predicted[j];
        let delta = p.xyz - q.xyz;
        let distance = length(delta);
        let depth = p.w + q.w - distance;
        if (depth > 0.0) {
          let n = contactNormal(i, j, delta, distance);
          let displacement = (p.xyz - old) - (q.xyz - positions[j].xyz);
          let tangent = displacement - n * dot(displacement, n);
          let pairCorrection = n * depth - frictionRemoval(tangent, depth, params.material.y);
          // A global Jacobi relaxation preserves equal/opposite pair impulses.
          let relaxation = 0.5;
          correction += pairCorrection * (wi / (wi + inverseMass(q.w))) * relaxation;
        }
      }
      j = links[j];
    }
  } } }
  let next = projectWalls(p.xyz + correction, old, p.w);
  auxiliary[i].correction += vec4f(correction + (next - (p.xyz + correction)), 0.0);
  corrected[i] = vec4f(next, p.w);
}

// Position corrections are complete before this pass; reconstruct on demand.
fn reconstructedVelocity(i: u32) -> vec3f {
  return auxiliary[i].incoming.xyz + auxiliary[i].correction.xyz / params.geometry.y;
}

fn velocityContact(i: u32) -> vec4f {
  let p = predicted[i];
  let center = cellCoordinates(p.xyz);
  let velocity = reconstructedVelocity(i);
  let wi = inverseMass(p.w);
  var correction = vec3f(0.0);
  var contacts = 0.0;
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let cell = center + vec3i(x, y, z);
    if (!validCell(cell)) { continue; }
    var j = atomicLoad(&heads[cellIndex(cell)]) - 1u;
    loop {
      if (j == NONE) { break; }
      if (j != i) {
        let q = predicted[j];
        let delta = p.xyz - q.xyz;
        let distance = length(delta);
        if (distance <= p.w + q.w + params.drag.w) {
          contacts += 1.0;
          let n = contactNormal(i, j, delta, distance);
          let neighbor = reconstructedVelocity(j);
          let relative = velocity - neighbor;
          let normal = dot(relative, n);
          let before = dot(auxiliary[i].incoming.xyz - auxiliary[j].incoming.xyz, n);
          let restitution = select(0.0, params.material.w, before < -0.1);
          let targetSpeed = -restitution * min(0.0, before);
          let load = max(0.0, targetSpeed - normal);
          let tangent = relative - n * normal;
          let impulse = n * load - frictionRemoval(tangent, load, params.material.y);
          let relaxation = 0.5;
          correction += impulse * (wi / (wi + inverseMass(q.w))) * relaxation;
        }
      }
      j = links[j];
    }
  } } }
  let result = wallVelocity(p.xyz, p.w, velocity + correction, auxiliary[i].incoming.xyz, true);
  return vec4f(result, contacts);
}

@compute @workgroup_size(128)
fn solveVelocity(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i < params.dimensions.x) { auxiliary[i].velocity = velocityContact(i); }
}
@compute @workgroup_size(128)
fn commit(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i < params.dimensions.x) {
    positions[i] = predicted[i];
    velocities[i] = auxiliary[i].velocity;
  }
}
