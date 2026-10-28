import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  deviceToScreen,
  SensorInput,
  type SensorOptions,
  type SensorWindow,
  type Vec3,
} from "../src/sensors.ts";

class FakeScreen extends EventTarget {
  angle = 0;
}
class FakeDocument extends EventTarget {
  visibilityState = "visible";
}
class FakeWindow extends EventTarget implements SensorWindow {
  isSecureContext = true;
  DeviceMotionEvent: SensorWindow["DeviceMotionEvent"] = {};
  DeviceOrientationEvent: SensorWindow["DeviceOrientationEvent"] = {};
  screen = { orientation: new FakeScreen() };
  document = new FakeDocument();
  time = 0;
  performance = { now: () => this.time };
}

function setup(t: TestContext, options: Omit<SensorOptions, "window"> = {}) {
  const host = new FakeWindow();
  const input = new SensorInput(undefined, { window: host, ...options });
  t.after(() => input.dispose());
  return { host, input };
}
function sample(host: FakeWindow, value: Vec3 | null, extra: object = {}) {
  const reading = value ? { x: value[0], y: value[1], z: value[2] } : null;
  host.dispatchEvent(
    Object.assign(new Event("devicemotion"), {
      accelerationIncludingGravity: reading,
      ...extra,
    }),
  );
}
function near(actual: Vec3, expected: Vec3) {
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(
      Math.abs(actual[axis] - expected[axis]) < 1e-10,
      `${actual} != ${expected}`,
    );
  }
}

test("screen coordinates retain magnitude through portrait, landscape and upside-down rotations", () => {
  near(deviceToScreen([1, 2, 3], 0), [1, 2, 3]);
  near(deviceToScreen([1, 2, 3], 90), [-2, 1, 3]);
  near(deviceToScreen([1, 2, 3], 180), [-1, -2, 3]);
  near(deviceToScreen([1, 2, 3], 270), [2, -1, 3]);
  near(deviceToScreen([1, 2, 3], -90), [2, -1, 3]);
  near(deviceToScreen([0, 0, 0], 90), [0, 0, 0]);
});

test("initial preset stays explicit until genuine data; 1g, .5g, 2g, zero and negatives keep amplitude", async (t) => {
  const { host, input } = setup(t);
  assert.equal(input.status, "checking");
  assert.equal(input.mode, "preset");
  input.setPreset([1, -2, 3]);
  input.start();
  await input.request();
  assert.equal(input.status, "checking");
  assert.match(input.detail, /等待读数|等.*读数/);
  near(input.acceleration, [1, -2, 3]);
  for (const reading of [
    [0, -9.80665, 0],
    [0, -4.903325, 0],
    [0, -19.6133, 0],
    [0, 0, 0],
    [-3, 4, -5],
  ] satisfies Vec3[]) {
    host.time += 20;
    sample(host, reading);
    assert.equal(input.mode, "sensor");
    assert.equal(input.status, "granted");
    near(input.raw!, reading);
    near(input.transformed!, reading);
    near(input.display, reading);
    input.setPreset([99, 99, 99]);
    near(input.acceleration, reading);
  }
  assert.equal(input.lastValid, 100);
  assert.equal(input.frequency, 50);
});

test("invalid initial measurements do not invent gravity or disable deliberate presets", async (t) => {
  const { host, input } = setup(t);
  input.start();
  await input.request();
  input.setPreset([0, -4, 0]);
  sample(host, null, { acceleration: { x: 0, y: -50, z: 0 } });
  assert.equal(input.status, "unavailable");
  assert.equal(input.mode, "preset");
  assert.equal(input.raw, null);
  near(input.acceleration, [0, -4, 0]);
  assert.equal(input.lastValid, null);
});

test("missing, partial and non-finite measurements fail closed after real data", async (t) => {
  const { host, input } = setup(t);
  input.start();
  await input.request();
  const invalid = [
    null,
    { x: 0, y: null, z: 0 },
    { x: 0, z: 0 },
    { x: NaN, y: -9, z: 0 },
    { x: 0, y: Infinity, z: 0 },
    { x: 0, y: -9, z: -Infinity },
  ];
  for (const reading of invalid) {
    host.time += 20;
    sample(host, [0, -9, 0]);
    host.dispatchEvent(
      Object.assign(new Event("devicemotion"), {
        accelerationIncludingGravity: reading,
      }),
    );
    assert.equal(input.mode, "fault");
    assert.equal(input.status, "unavailable");
    assert.equal(input.raw, null);
    assert.equal(input.transformed, null);
    near(input.acceleration, [0, 0, 0]);
    assert.equal(input.lastValid, host.time);
    assert.equal(input.frequency, 0);
  }
  sample(host, [0, 0, 0]);
  assert.equal(input.mode, "sensor");
});

test("expiry never silently selects fallback; explicit preset and later real recovery work", async (t) => {
  const { host, input } = setup(t, { staleAfterMs: 100 });
  input.start();
  await input.request();
  sample(host, [0, -9, 0]);
  host.time = 99;
  input.tick();
  assert.equal(input.mode, "sensor");
  host.time = 100;
  input.tick();
  assert.equal(input.mode, "fault");
  assert.equal(input.status, "unavailable");
  near(input.acceleration, [0, 0, 0]);
  await input.request();
  assert.equal(
    input.mode,
    "fault",
    "permission alone cannot revive expired data",
  );
  near(input.acceleration, [0, 0, 0]);
  input.setPreset([0, -3, 0]);
  assert.equal(input.mode, "preset");
  near(input.acceleration, [0, -3, 0]);
  host.time = 200;
  input.tick();
  assert.equal(input.mode, "preset");
  sample(host, [2, -5, 1]);
  assert.equal(input.mode, "sensor");
  assert.equal(input.status, "granted");
  near(input.acceleration, [2, -5, 1]);
});

test("no-data timeout remains honest unavailable with initial preset allowed", async (t) => {
  const { host, input } = setup(t, { staleAfterMs: 100 });
  input.start();
  await input.request();
  host.time = 100;
  input.tick();
  assert.equal(input.status, "unavailable");
  assert.equal(input.mode, "preset");
  assert.equal(input.lastValid, null);
});

test("both permission APIs run synchronously and retry in same gesture; requests are mutually exclusive", async (t) => {
  const { host, input } = setup(t);
  let gesture = false;
  const calls: string[] = [];
  host.DeviceMotionEvent = {
    requestPermission() {
      calls.push(`motion:${gesture}`);
      return Promise.resolve(gesture ? "granted" : "denied");
    },
  };
  host.DeviceOrientationEvent = {
    requestPermission() {
      calls.push(`orientation:${gesture}`);
      return Promise.resolve(gesture ? "granted" : "denied");
    },
  };
  input.start();
  assert.deepEqual(calls, ["motion:false", "orientation:false"]);
  assert.equal(input.status, "requesting");
  const automatic = input.request();
  assert.equal(input.request(), automatic);
  await automatic;
  assert.equal(input.status, "denied");
  gesture = true;
  const retry = input.request();
  assert.deepEqual(calls, [
    "motion:false",
    "orientation:false",
    "motion:true",
    "orientation:true",
  ]);
  assert.equal(input.request(), retry);
  gesture = false;
  await retry;
  assert.equal(input.status, "checking");
  sample(host, [0, -9, 0]);
  assert.equal(input.mode, "sensor");
  assert.equal(input.status, "granted");
});

test("synchronous permission failure still calls second API and reports error", async (t) => {
  const { host, input } = setup(t);
  let orientationCalls = 0;
  host.DeviceMotionEvent = {
    requestPermission() {
      throw new Error("sensor service failed");
    },
  };
  host.DeviceOrientationEvent = {
    requestPermission() {
      orientationCalls++;
      return Promise.resolve("granted");
    },
  };
  input.start();
  assert.equal(orientationCalls, 1);
  await input.request();
  assert.equal(input.status, "error");
  assert.match(input.detail, /sensor service failed/);
  host.DeviceMotionEvent = {
    requestPermission: () => Promise.resolve("granted"),
  };
  await input.request();
  sample(host, [0, -9, 0]);
  assert.equal(input.mode, "sensor");
});

test("NotAllowedError rejection reports denied, not unsupported", async (t) => {
  const { host, input } = setup(t);
  host.DeviceMotionEvent = {
    requestPermission: () =>
      Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
  };
  input.start();
  await input.request();
  assert.equal(input.status, "denied");
});

test("optional orientation rejection does not discard real translational acceleration", async (t) => {
  const { host, input } = setup(t);
  host.DeviceOrientationEvent = {
    requestPermission: () => Promise.reject(new Error("orientation denied")),
  };
  input.start();
  await input.request();
  assert.equal(input.status, "checking");
  assert.match(input.detail, /方向权限未获准/);
  sample(host, [0, -9, 0]);
  assert.equal(input.mode, "sensor");
  assert.equal(input.status, "granted");
});

test("hung permission request times out and permits retry", async (t) => {
  const { host, input } = setup(t, { permissionTimeoutMs: 5 });
  host.DeviceMotionEvent = {
    requestPermission: () => new Promise<string>(() => {}),
  };
  input.start();
  await input.request();
  assert.equal(input.status, "unavailable");
  assert.match(input.detail, /超时/);
  host.DeviceMotionEvent = {
    requestPermission: () => Promise.resolve("granted"),
  };
  await input.request();
  assert.equal(input.status, "checking");
});

test("unsupported and insecure contexts do not request permission", async (t) => {
  const unsupported = setup(t);
  unsupported.host.DeviceMotionEvent = undefined;
  unsupported.input.start();
  await unsupported.input.request();
  assert.equal(unsupported.input.status, "unsupported");
  unsupported.input.setPreset([0, -1, 0]);
  near(unsupported.input.acceleration, [0, -1, 0]);
  const insecure = setup(t);
  insecure.host.isSecureContext = false;
  insecure.host.DeviceMotionEvent = {
    requestPermission() {
      assert.fail("insecure request");
    },
  };
  insecure.input.start();
  await insecure.input.request();
  assert.equal(insecure.input.status, "insecure-context");
});

test("screen changes remap current sample; polarity is explicit, never automatic", async (t) => {
  const { host, input } = setup(t);
  input.start();
  await input.request();
  sample(host, [1, -9, 2]);
  near(input.acceleration, [1, -9, 2]);
  host.screen.orientation.angle = 90;
  host.screen.orientation.dispatchEvent(new Event("change"));
  near(input.acceleration, [9, 1, 2]);
  near(input.raw!, [1, -9, 2]);
  input.polarity = -1;
  near(input.acceleration, [-9, -1, -2]);
  host.screen.orientation.angle = 270;
  host.dispatchEvent(new Event("orientationchange"));
  near(input.acceleration, [9, 1, -2]);
  input.polarity = 1;
  sample(host, [0, 0, 0]);
  near(input.acceleration, [0, 0, 0]);
});

test("legacy screen orientation fallback maps landscape", async (t) => {
  const { host, input } = setup(t);
  Object.defineProperty(host, "screen", { value: undefined });
  Object.assign(host, { orientation: -90 });
  input.start();
  await input.request();
  sample(host, [1, 2, 3]);
  near(input.acceleration, [2, -1, 3]);
});

test("linear acceleration, angular rates and orientation remain diagnostics only", async (t) => {
  const { host, input } = setup(t);
  input.start();
  await input.request();
  sample(host, [0, -9, 0], {
    acceleration: { x: 2, y: -1, z: 3 },
    rotationRate: { alpha: 720, beta: null, gamma: Infinity },
  });
  host.dispatchEvent(
    Object.assign(new Event("deviceorientation"), {
      alpha: 30,
      beta: NaN,
      gamma: -4,
      absolute: false,
    }),
  );
  assert.deepEqual(input.linear, [2, -1, 3]);
  assert.deepEqual(input.rotation, { alpha: 720, beta: null, gamma: null });
  assert.deepEqual(input.orientation, {
    alpha: 30,
    beta: null,
    gamma: -4,
    absolute: false,
  });
  near(input.acceleration, [0, -9, 0]);
});

test("visibility suspension zeroes stale input, then requires new data", async (t) => {
  const { host, input } = setup(t);
  input.start();
  await input.request();
  sample(host, [0, -9, 0]);
  host.document.visibilityState = "hidden";
  host.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(input.mode, "fault");
  near(input.acceleration, [0, 0, 0]);
  sample(host, [0, -15, 0]);
  assert.equal(input.mode, "fault");
  host.document.visibilityState = "visible";
  host.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(input.status, "checking");
  near(input.acceleration, [0, 0, 0]);
  sample(host, [0, -8, 0]);
  assert.equal(input.mode, "sensor");
});

test("dispose cancels pending permission, detaches listeners and never revives", async (t) => {
  const { host, input } = setup(t);
  let finish!: (permission: string) => void;
  host.DeviceMotionEvent = {
    requestPermission: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  };
  input.start();
  const pending = input.request();
  input.dispose();
  await pending;
  finish("granted");
  await Promise.resolve();
  sample(host, [0, -9, 0]);
  host.dispatchEvent(
    Object.assign(new Event("deviceorientation"), { alpha: 30 }),
  );
  host.dispatchEvent(new Event("pageshow"));
  input.start();
  await input.request();
  assert.equal(input.status, "unavailable");
  assert.equal(input.mode, "fault");
  assert.equal(input.raw, null);
  assert.equal(input.orientation, null);
  near(input.acceleration, [0, 0, 0]);
});

test("preset rejects non-finite and incomplete vectors", (t) => {
  const { input } = setup(t);
  assert.throws(() => input.setPreset([0, Infinity, 0]), TypeError);
  assert.throws(() => input.setPreset([0, NaN, 0]), TypeError);
  assert.throws(() => input.setPreset([0, 1] as unknown as Vec3), TypeError);
});

test("permission completion preserves granted only when a valid real sample already arrived", async (t) => {
  const { host, input } = setup(t);
  input.start();
  sample(host, [0, -9, 0]);
  assert.equal(input.status, "granted");
  await input.request();
  assert.equal(input.status, "granted");
  assert.equal(input.mode, "sensor");
  near(input.acceleration, [0, -9, 0]);
});
