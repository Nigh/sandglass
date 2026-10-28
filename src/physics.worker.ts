import { Physics } from "./physics";

export type PhysicsRequest =
  | { type: "calibrate" }
  | { type: "init"; count: number; material?: number; air?:boolean }
  | {
      type: "advance";
      elapsed: number;
      acceleration: readonly number[];
      paused?: boolean;
      buffer?: ArrayBuffer;
    }
  | { type: "reset" }
  | { type: "air"; enabled:boolean }
  | { type: "material"; material: number };

// CPU worker backend. No timer and no autonomous simulation: one request produces one frame.
// The caller keeps at most one advance in flight and returns its previous position buffer.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<PhysicsRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
let physics: Physics | undefined;

function sendState(buffer?: ArrayBuffer, includeRadii = false): void {
  if (!physics) return;
  const size = physics.positions.byteLength;
  const positions =
    buffer && buffer.byteLength === size ? buffer : new ArrayBuffer(size);
  new Float32Array(positions).set(physics.positions);
  const radii = includeRadii ? physics.radii.slice().buffer : undefined;
  scope.postMessage(
    {
      type: "state",
      positions,
      radii,
      stats: physics.stats,
      count: physics.count,
      neckRadius: physics.neckRadius,
    },
    radii ? [positions, radii] : [positions],
  );
}

scope.onmessage = (event) => {
  try {
    const request = event.data;
    switch (request.type) {
      case "calibrate": {
        const samples = [1000, 5000, 10000].map((count) => {
          const candidate = new Physics(count);
          for (let i = 0; i < 4; i++) candidate.step([0, -9.81, 0]);
          const start = performance.now();
          for (let i = 0; i < 12; i++) candidate.step([0, -9.81, 0]);
          return { count, msPerStep: (performance.now() - start) / 12 };
        });
        let recommended = 1000;
        for (const sample of samples)
          if (sample.msPerStep <= 2.5) recommended = sample.count;
        scope.postMessage({ type: "calibrated", samples, recommended });
        break;
      }
      case "init":
        physics = new Physics(request.count, request.material ?? 1,undefined,request.air===false?0:1);
        sendState(undefined, true);
        break;
      case "advance":
        if (!physics) throw new Error("Initialize physics before advancing");
        physics.advance(request.elapsed, request.acceleration, request.paused);
        sendState(request.buffer);
        break;
      case "reset":
        if (!physics) throw new Error("Initialize physics before resetting");
        physics.reset();
        break;
      case "material":
        if (!physics)
          throw new Error("Initialize physics before changing material");
        physics.setMaterial(request.material);
        break;
      case "air":
        if(!physics)throw new Error("Initialize physics before changing air resistance");
        physics.setAirResistance(request.enabled);
        break;
      default:
        throw new Error("Unknown physics request");
    }
  } catch (error) {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
