export type Vec3 = [number, number, number];
export type SensorStatus =
  | "checking"
  | "requesting"
  | "granted"
  | "denied"
  | "unsupported"
  | "unavailable"
  | "insecure-context"
  | "error";
export type SensorMode = "sensor" | "preset" | "fault";

type PermissionAPI = { requestPermission?: () => Promise<string> };
type Angles = {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
};
export type SensorWindow = EventTarget & {
  isSecureContext: boolean;
  DeviceMotionEvent?: PermissionAPI;
  DeviceOrientationEvent?: PermissionAPI;
  performance?: Pick<Performance, "now">;
  screen?: { orientation?: EventTarget & { angle: number } };
  orientation?: number;
  document?: EventTarget & { visibilityState: string };
};
export type SensorOptions = {
  window?: SensorWindow;
  now?: () => number;
  staleAfterMs?: number;
  permissionTimeoutMs?: number;
};

const ZERO: Vec3 = [0, 0, 0];
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function vector(
  value:
    { x: number | null; y: number | null; z: number | null } | null | undefined,
): Vec3 | null {
  return value && finite(value.x) && finite(value.y) && finite(value.z)
    ? [value.x, value.y, value.z]
    : null;
}
function angles(value: Partial<Angles> | null | undefined): Angles | null {
  if (!value) return null;
  return {
    alpha: finite(value.alpha) ? value.alpha : null,
    beta: finite(value.beta) ? value.beta : null,
    gamma: finite(value.gamma) ? value.gamma : null,
  };
}

/** Device axes to current screen axes: x right, y up, z toward viewer. Degrees, no normalization. */
export function deviceToScreen(value: Vec3, angle: number): Vec3 {
  const radians = (angle * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    value[0] * cosine - value[1] * sine,
    value[0] * sine + value[1] * cosine,
    value[2],
  ];
}

/**
 * Device-fixed hourglass input, in m/s². Browser accelerationIncludingGravity is used directly:
 * the usual upright reading [0, -g, 0] drives grains down. It is not normalized, nor added to g.
 * Physically, a device-fixed particle feels g - a_device, the negative of accelerometer specific
 * force f = a_device - g. Browser/platform sign conventions differ; polarity is explicit calibration,
 * never an inferred stationary baseline. Zero remains zero, including free fall.
 * Orientation and angular rates are diagnostics, not a fabricated world attitude. This translational
 * approximation does not reconstruct Euler, centrifugal, or Coriolis terms during fast rotation.
 */
export class SensorInput {
  status: SensorStatus = "checking";
  mode: SensorMode = "preset";
  detail = "等待设备检测；当前使用明确标记的预设加速度。";
  lastValid: number | null = null;
  raw: Vec3 | null = null;
  transformed: Vec3 | null = null;
  linear: Vec3 | null = null;
  frequency = 0;
  rotation: Angles | null = null;
  orientation: (Angles & { absolute: boolean }) | null = null;
  screenAngle = 0;

  private readonly host: SensorWindow | undefined;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly permissionTimeoutMs: number;
  private preset: Vec3 = [0, -9.80665, 0];
  private sign: 1 | -1 = 1;
  private started = false;
  private disposed = false;
  private valid = false;
  private hadSensor = false;
  private startedAt = 0;
  private stopPolling: (() => void) | null = null;
  private pending: Promise<void> | null = null;
  private cancelRequest: (() => void) | null = null;
  private requestVersion = 0;

  constructor(
    private readonly onChange: () => void = () => {},
    options: SensorOptions = {},
  ) {
    this.host =
      options.window ??
      (typeof window === "undefined"
        ? undefined
        : (window as unknown as SensorWindow));
    this.now =
      options.now ?? (() => this.host?.performance?.now() ?? performance.now());
    this.staleAfterMs = options.staleAfterMs ?? 1200;
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 8000;
  }

  get acceleration(): Vec3 {
    if (this.mode === "sensor" && this.valid && this.transformed)
      return this.transformed;
    return this.mode === "preset" ? this.preset : ZERO;
  }

  /** Display uses the active input unchanged; no filtering or fabricated gravity. */
  get display(): Vec3 {
    return this.acceleration;
  }
  get polarity(): 1 | -1 {
    return this.sign;
  }
  set polarity(value: 1 | -1) {
    if (value !== 1 && value !== -1)
      throw new TypeError("polarity must be 1 or -1");
    this.sign = value;
    this.mapReading();
    this.onChange();
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.startedAt = this.now();
    if (!this.checkEnvironment()) return;
    const host = this.host!;
    host.addEventListener("devicemotion", this.onMotion);
    host.addEventListener("deviceorientation", this.onOrientation);
    host.addEventListener("orientationchange", this.onScreenChange);
    host.addEventListener("pagehide", this.onPageHide);
    host.addEventListener("pageshow", this.onPageShow);
    host.screen?.orientation?.addEventListener("change", this.onScreenChange);
    host.document?.addEventListener("visibilitychange", this.onVisibility);
    this.onScreenChange();
    const interval = setInterval(() => this.tick(), 200);
    this.stopPolling = () => clearInterval(interval);
    // Permission APIs may reject without a gesture. The same request path is retried by the UI gesture.
    void this.request();
  }

  request(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.started) {
      this.start();
      return this.pending ?? Promise.resolve();
    }
    if (this.pending) return this.pending;
    if (!this.checkEnvironment()) return Promise.resolve();
    const version = ++this.requestVersion;
    this.status = "requesting";
    this.detail = "正在申请运动与方向权限。";
    this.onChange();
    const host = this.host!;
    const motion = host.DeviceMotionEvent!;
    const direction = host.DeviceOrientationEvent;
    // Invoke BOTH APIs before any await, including when one throws synchronously. iOS needs
    // both calls in the original user-activation stack, not a sequential promise continuation.
    const invoke = (api: PermissionAPI | undefined): Promise<string> => {
      try {
        return Promise.resolve(
          api?.requestPermission ? api.requestPermission() : "granted",
        );
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const motionResult = invoke(motion);
    const directionResult = invoke(direction);
    let clearDeadline = () => {};
    // Executor form keeps this working on iOS browsers without Promise.withResolvers (ES2024).
    const interruption = new Promise<"timeout" | "cancelled">((resolve) => {
      const timeout = setTimeout(
        () => resolve("timeout"),
        this.permissionTimeoutMs,
      );
      clearDeadline = () => clearTimeout(timeout);
      this.cancelRequest = () => resolve("cancelled");
    });
    this.pending = Promise.race([
      Promise.allSettled([motionResult, directionResult]),
      interruption,
    ])
      .then((result) => {
        if (
          this.disposed ||
          version !== this.requestVersion ||
          result === "cancelled"
        )
          return;
        if (result === "timeout") {
          this.fail("unavailable", "权限请求超时；可点击授权重试。");
          return;
        }
        const [movement, directionPermission] = result;
        if (movement.status === "rejected") {
          const error = movement.reason as {
            name?: string;
            message?: string;
          } | null;
          this.fail(
            error?.name === "NotAllowedError" ? "denied" : "error",
            `运动权限请求失败：${error?.message ?? String(movement.reason)}。可点击授权重试。`,
          );
          return;
        }
        if (movement.value !== "granted") {
          this.fail(
            "denied",
            "运动权限被拒绝；请在浏览器设置中允许，再点击授权重试。",
          );
          return;
        }
        const orientationNote =
          directionPermission.status === "rejected" ||
          directionPermission.value !== "granted"
            ? "方向权限未获准；平移加速度仍可使用，姿态诊断可能不可用。"
            : "";
        this.status = this.valid ? "granted" : "checking";
        this.startedAt = this.now();
        this.detail = this.valid
          ? `正在使用真实设备加速度。${orientationNote}`
          : `权限可用，等待有限的含重力加速度读数。${orientationNote}`;
        this.onChange();
      })
      .finally(() => {
        clearDeadline();
        if (version === this.requestVersion) {
          this.pending = null;
          this.cancelRequest = null;
        }
      });
    return this.pending;
  }

  setPreset(value: Vec3): void {
    if (value.length !== 3 || !value.every(finite))
      throw new TypeError(
        "Preset acceleration must contain three finite values",
      );
    this.tick();
    if (this.valid || this.disposed) return;
    this.preset = [...value];
    this.mode = "preset";
    this.detail = "手动预设输入；不是传感器读数。真实数据恢复后会自动接管。";
    this.onChange();
  }

  tick(now = this.now()): void {
    if (this.disposed || !this.started) return;
    if (
      this.valid &&
      this.lastValid !== null &&
      now - this.lastValid >= this.staleAfterMs
    ) {
      this.fail(
        "unavailable",
        "真实传感器数据已过期；输入归零。请选择预设或等待设备恢复。",
      );
    } else if (
      !this.valid &&
      (this.status === "checking" || this.status === "granted") &&
      now - this.startedAt >= this.staleAfterMs
    ) {
      this.fail(
        "unavailable",
        "未收到有效运动数据；请检查权限、设备支持与页面可见状态。",
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.requestVersion;
    this.cancelRequest?.();
    this.cancelRequest = null;
    this.pending = null;
    this.stopPolling?.();
    this.stopPolling = null;
    const host = this.host;
    host?.removeEventListener("devicemotion", this.onMotion);
    host?.removeEventListener("deviceorientation", this.onOrientation);
    host?.removeEventListener("orientationchange", this.onScreenChange);
    host?.removeEventListener("pagehide", this.onPageHide);
    host?.removeEventListener("pageshow", this.onPageShow);
    host?.screen?.orientation?.removeEventListener(
      "change",
      this.onScreenChange,
    );
    host?.document?.removeEventListener("visibilitychange", this.onVisibility);
    this.valid = false;
    this.raw = this.transformed = null;
    this.mode = "fault";
    this.frequency = 0;
    this.status = "unavailable";
    this.detail = "传感器监听已停止。";
    this.onChange();
  }

  private checkEnvironment(): boolean {
    if (!this.host?.isSecureContext) {
      this.fail(
        "insecure-context",
        "运动传感器需要 HTTPS 或 localhost 安全上下文。",
      );
      return false;
    }
    if (!this.host.DeviceMotionEvent) {
      this.fail("unsupported", "浏览器不支持 DeviceMotion；可手动选择预设。");
      return false;
    }
    return true;
  }

  private fail(status: SensorStatus, detail: string): void {
    this.valid = false;
    this.raw = this.transformed = null;
    this.frequency = 0;
    this.status = status;
    this.detail = detail;
    if (this.hadSensor && this.mode !== "preset") this.mode = "fault";
    this.onChange();
  }

  private mapReading(): void {
    const mapped = this.raw ? deviceToScreen(this.raw, this.screenAngle) : null;
    if (mapped && !mapped.every(finite)) {
      this.fail("unavailable", "屏幕坐标变换超出有限范围；输入归零。");
      return;
    }
    this.transformed = mapped
      ? [mapped[0] * this.sign, mapped[1] * this.sign, mapped[2] * this.sign]
      : null;
  }

  private onScreenChange = (): void => {
    const angle =
      this.host?.screen?.orientation?.angle ?? this.host?.orientation ?? 0;
    this.screenAngle = finite(angle) ? angle : 0;
    this.mapReading();
    this.onChange();
  };

  private onMotion = (event: Event): void => {
    if (this.disposed || this.host?.document?.visibilityState === "hidden")
      return;
    const motion = event as DeviceMotionEvent;
    this.linear = vector(motion.acceleration);
    this.rotation = angles(motion.rotationRate);
    const reading = vector(motion.accelerationIncludingGravity);
    if (!reading) {
      this.fail(
        "unavailable",
        "含重力加速度缺失或非有限；未用线性加速度伪造重力。",
      );
      return;
    }
    const now = this.now();
    const elapsed =
      this.valid && this.lastValid !== null ? now - this.lastValid : 0;
    if (elapsed > 0) {
      const observed = 1000 / elapsed;
      this.frequency = this.frequency
        ? this.frequency * 0.8 + observed * 0.2
        : observed;
    }
    this.raw = reading;
    this.lastValid = now;
    this.valid = true;
    this.hadSensor = true;
    this.mode = "sensor";
    this.status = "granted";
    this.detail = "真实含重力加速度，单位 m/s²；幅值原样保留。";
    this.screenAngle =
      this.host?.screen?.orientation?.angle ?? this.host?.orientation ?? 0;
    if (!finite(this.screenAngle)) this.screenAngle = 0;
    this.mapReading();
    this.onChange();
  };

  private onOrientation = (event: Event): void => {
    if (this.disposed) return;
    const reading = event as DeviceOrientationEvent;
    this.orientation = {
      ...angles(reading)!,
      absolute: reading.absolute === true,
    };
    this.onChange();
  };

  private onPageHide = (): void => {
    this.fail(
      "unavailable",
      "页面已离开前台；输入失效。恢复后等待新的真实数据。",
    );
  };

  private onPageShow = (): void => {
    this.startedAt = this.now();
    if (this.status === "unavailable") {
      this.status = "checking";
      this.detail = "页面已恢复，等待新的真实传感器读数。";
      this.onChange();
    }
  };

  private onVisibility = (): void => {
    if (this.host?.document?.visibilityState === "hidden") this.onPageHide();
    else this.onPageShow();
  };
}
