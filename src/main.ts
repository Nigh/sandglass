import "./style.css";
import { SandScene, palettes } from "./scene";
import { SensorInput } from "./sensors";
import { detectBackends } from "./capabilities";
import { FIXED_DT, MICRO_GRAIN_DIAMETER, estimatedDurationSeconds } from "./vessel";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const options = (names: string[]) =>
  names.map((n, i) => `<option value="${i}">${n}</option>`).join("");
$("app").innerHTML =
  `<header><a class="brand" href="./">流砂<span>SANDGLASS</span></a><div class="header-note">真实加速度 · 本地物理实验</div><button id="fullscreen" class="quiet">全屏</button></header>
<main><section class="stage" aria-label="交互式三维沙漏"><div class="stage-heading"><h1>让重力，<br>有迹可循。</h1><p>转动手机，观察每一粒沙的回应。</p></div><div id="viewport"></div><div class="readout"><span id="mode">检测输入</span><strong id="g-value">1.00 <small>g</small></strong><span id="vector-label">有效加速度</span><svg width="64" height="64" viewBox="0 0 64 64" aria-label="加速度平面方向"><circle cx="32" cy="32" r="26" fill="none" stroke="currentColor" opacity=".25"/><path id="vector" d="M32 32L32 55" stroke="currentColor" stroke-width="2"/><circle cx="32" cy="32" r="2" fill="currentColor"/></svg></div><div class="stage-bottom"><span id="help">拖动环绕 · 双指缩放 · 双击复位<br>观察视角不改变物理输入</span><div><button id="view" class="quiet">复位视角</button><button id="pause" class="primary">暂停模拟</button></div></div></section>
<aside><section class="sensor-section"><div class="section-title"><h2>物理输入</h2><span class="status-dot" id="status-dot"></span></div><p id="sensor-status" role="status" aria-live="polite">正在检测传感器…</p><button id="permission" class="wide">启用手机传感器</button><p class="fine" id="sensor-detail"></p><details><summary>传感器校准与物理边界</summary><p class="fine">沙漏固定于屏幕坐标系。输入为随设备运动的有效加速度，不是惯性系中的地球引力。相机独立。未重建完整旋转惯性场。</p><label>平台读数极性<select id="polarity"><option value="1">标准浏览器约定</option><option value="-1">反向（实机校准）</option></select></label></details></section>
<section><h2>预设加速度</h2><p class="fine" id="preset-note">仅真实传感器不可用时允许启用。</p><fieldset id="preset-controls"><label>方向<select id="direction">${options(["竖直向下", "竖直向上", "水平向左", "水平向右", "水平向前", "水平向后", "自定义方向"])}</select></label><div id="custom" hidden><label>X<input id="x" type="number" min="-1" max="1" step=".1" value="0"></label><label>Y<input id="y" type="number" min="-1" max="1" step=".1" value="-1"></label><label>Z<input id="z" type="number" min="-1" max="1" step=".1" value="0"></label></div><label class="range-label">幅值 <output id="magnitude-label">1.00 g</output><input id="magnitude" type="range" min="0" max="3" step=".01" value="1"></label><div class="pills">${[0, 0.5, 1, 2].map((n) => `<button data-g="${n}">${n}g</button>`).join("")}</div><button id="activate-preset" class="wide quiet">使用当前预设</button></fieldset></section>
<section><h2>沙粒工坊</h2><div class="two-col"><label>颗粒外观<select id="shape">${options(["细砂", "粗砂", "晶体砂", "彩色颗粒砂"])}</select></label><label>颜色<select id="palette">${options(palettes)}</select></label></div><label>物理材料<select id="material">${options(["极细流动砂", "标准砂", "粗颗粒砂", "高摩擦晶体砂"])}</select></label><label>性能档位<select id="quality">${options(["省电 · 1,000 粒", "平衡 · 5,000 粒", "高质量 · 10,000 粒", "自定义"])}</select></label><label id="count-label" hidden>粒子数量<input id="count" type="number" min="100" max="20000" step="100" value="1000"></label><p class="fine" id="budget">启动实测正在选择安全预算。更改数量会重新分布；自动降级不删除沙粒。</p><div class="two-col"><button id="reset">重置沙漏</button><button id="restore" class="quiet">恢复初始分布</button></div></section>
<details id="debug"><summary>传感器与性能监测 <span id="fps">— FPS</span></summary><pre id="debug-data"></pre><p class="fine">原始、变换、显示平滑与最终输入独立。绝对地球重力与完整设备运动未知。GPU 时间戳不可用，不以 CPU 提交时间冒充 GPU 耗时。</p><button id="benchmark">开始 60 秒渲染基准</button><button id="export" disabled>导出基准 JSON</button></details><label class="toggle"><input id="show-help" type="checkbox" checked>显示辅助信息</label><footer>无预设轨迹，无数据上传。<br>传感器需要 HTTPS 或 localhost。</footer></aside></main><div id="fatal" role="alert" hidden></div>`;
const airLabel=document.createElement("label");
airLabel.className="toggle";
airLabel.innerHTML='<input id="air" type="checkbox" checked>细砂空气阻力（关闭为真空）';
$("material").closest("label")!.after(airLabel);
const airEnabled=()=>($("air") as HTMLInputElement).checked;
const durationNote=document.createElement("p");
durationNote.id="duration-estimate";durationNote.className="fine";
airLabel.after(durationNote);
($("count") as HTMLInputElement).min="1000";
$("quality").parentElement!.firstChild!.textContent="砂量与性能档位";
const sensor = new SensorInput();
const stage = $("viewport");
let scene: SandScene;
try {
  scene = new SandScene(stage);
} catch (error) {
  $("fatal").hidden = false;
  $("fatal").textContent =
    `无法启动 WebGL：${String(error)}。请启用硬件加速或更换浏览器。`;
  throw error;
}
const worker = new Worker(new URL("./physics.worker.ts", import.meta.url), {
  type: "module",
});
void detectBackends(document.createElement("canvas")).then((result) => {
  console.info("物理后端评估", result);
});
let paused = false,
  pending = true,
  positions: Float32Array | undefined,
  radii: Float32Array | undefined,
  count = 1000,
  material = 1,
  disposed = false;
let last = performance.now(),
  elapsedPending = 0,
  lastUi = 0,
  workerMs = 0,
  contacts = 0,
  active=0,
  sleeping=0,
  neighborChecks=0,
  islands=0,
  clustered=0,
  bulkIntegrated=0,
  islandSplits=0,
  substeps=0,
  neckRadius=0,
  steps = 0,
  previousSteps = 0,
  previousStatsTime = performance.now(),
  dropped = 0,
  renderMs = 0,
  frames: number[] = [],
  runStart = 0,
  benchmarkRows: unknown[] = [],
  benchmarkResult: unknown;
let startup = true,
  slowWindows = 0,
  fastWindows = 0,
  windowStart = performance.now(),
  windowFrames: number[] = [],
  pixelRatio = Math.min(devicePixelRatio, 1.6);
const hardware = navigator as Navigator & { deviceMemory?: number };
const initialCount =
  hardware.hardwareConcurrency >= 8 && (hardware.deviceMemory ?? 4) >= 8
    ? 5000
    : 1000;
count = initialCount;
($("quality") as HTMLSelectElement).value = count === 5000 ? "1" : "0";
($("material") as HTMLSelectElement).value = String(material);
$("magnitude").setAttribute("aria-label", "预设加速度幅值");
const physicsControls = ["reset", "restore", "material", "air", "quality", "count"];
for (const id of physicsControls)
  ($(id) as HTMLButtonElement | HTMLSelectElement | HTMLInputElement).disabled =
    true;
worker.postMessage({ type: "calibrate" });
worker.onmessage = (event: MessageEvent) => {
  const data = event.data;
  if (data.type === "calibrated") {
    count = Math.min(initialCount, data.recommended);
    ($("quality") as HTMLSelectElement).value = String(
      count === 10000 ? 2 : count === 5000 ? 1 : 0,
    );
    console.info("启动物理实测", data.samples);
    elapsedPending = 0;
    worker.postMessage({ type: "init", count, material, air:airEnabled() });
    return;
  }
  if (data.type === "error") {
    $("fatal").hidden = false;
    $("fatal").textContent = data.message;
    pending = false;
    paused = true;
    $("pause").textContent = "继续模拟";
    return;
  }
  if (!data.positions) return;
  for (const id of physicsControls)
    (
      $(id) as HTMLButtonElement | HTMLSelectElement | HTMLInputElement
    ).disabled = false;
  positions = new Float32Array(data.positions);
  if (data.radii) radii = new Float32Array(data.radii);
  if (radii && (scene.count !== data.count || scene.radii !== radii))
    scene.configure(data.count, radii, data.neckRadius);
  scene.update(positions);
  count = data.count;
  workerMs = data.stats?.ms ?? 0;
  contacts = data.stats?.contacts ?? 0;
  steps = data.stats?.steps ?? 0;
  dropped = data.stats?.dropped ?? 0;
  active=data.stats?.active??data.count;
  sleeping=data.stats?.sleeping??0;
  neighborChecks=data.stats?.neighborChecks??0;
  substeps=data.stats?.substeps??0;
  islands=data.stats?.islands??0;
  clustered=data.stats?.clustered??0;
  bulkIntegrated=data.stats?.bulkIntegrated??0;
  islandSplits=data.stats?.islandSplits??0;
  neckRadius=data.neckRadius;
  pending = false;
};
worker.onerror = (e) => {
  $("fatal").hidden = false;
  $("fatal").textContent = `物理线程错误：${e.message}`;
};
function preset() {
  const dirs = [
    [0, -1, 0],
    [0, 1, 0],
    [-1, 0, 0],
    [1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  const index = Number(($("direction") as HTMLSelectElement).value);
  $("custom").hidden = index !== 6;
  const v =
    index === 6
      ? ["x", "y", "z"].map((id) => Number(($(id) as HTMLInputElement).value))
      : dirs[index];
  const length = Math.hypot(...v);
  const g = Number(($("magnitude") as HTMLInputElement).value);
  $("magnitude-label").textContent = `${g.toFixed(2)} g`;
  if (v.every(Number.isFinite))
    sensor.setPreset(
      v.map((n) => (length ? (n / length) * g * 9.81 : 0)) as [
        number,
        number,
        number,
      ],
    );
}
for (const id of ["direction", "magnitude", "x", "y", "z"])
  $(id).addEventListener("input", preset);
$("activate-preset").onclick = preset;
document.querySelectorAll<HTMLButtonElement>("[data-g]").forEach(
  (button) =>
    (button.onclick = () => {
      ($("magnitude") as HTMLInputElement).value = button.dataset.g!;
      preset();
    }),
);
$("permission").onclick = () => {
  void sensor.request();
};
$("polarity").onchange = () => {
  sensor.polarity = Number(($("polarity") as HTMLSelectElement).value) as
    1 | -1;
};
$("pause").onclick = () => {
  paused = !paused;
  $("pause").textContent = paused ? "继续模拟" : "暂停模拟";
};
$("view").onclick = () => scene.resetView();
$("reset").onclick = () => {
  worker.postMessage({ type: "reset" });
  $("fatal").hidden = true;
  scene.resetView();
};
$("restore").onclick = () => {
  worker.postMessage({ type: "reset" });
  $("fatal").hidden = true;
};
$("shape").onchange = () => {
  const shape = Number(($("shape") as HTMLSelectElement).value);
  scene.setShape(shape);
  if (shape === 3) {
    ($("palette") as HTMLSelectElement).value = "5";
    scene.setPalette(5);
  }
};
$("palette").onchange = () =>
  scene.setPalette(Number(($("palette") as HTMLSelectElement).value));
$("material").onchange = () => {
  material = Number(($("material") as HTMLSelectElement).value);
  worker.postMessage({ type: "material", material });
};
$("air").onchange=()=>worker.postMessage({type:"air",enabled:airEnabled()});
function changeCount(n: number) {
  if (!Number.isFinite(n)) return;
  n = Math.min(20000, Math.max(1000, Math.round(n)));
  ($("count") as HTMLInputElement).value=String(n);
  pending = true;
  positions = undefined;
  radii = undefined;
  count = n;
  worker.postMessage({ type: "init", count, material, air:airEnabled() });
}
$("quality").onchange = () => {
  startup = false;
  const quality = Number(($("quality") as HTMLSelectElement).value);
  $("count-label").hidden = quality !== 3;
  if (quality < 3) changeCount([1000, 5000, 10000][quality]);
};
$("count").onchange = () =>
  changeCount(Number(($("count") as HTMLInputElement).value));
$("show-help").onchange = () => {
  $("help").hidden = !($("show-help") as HTMLInputElement).checked;
};
$("fullscreen").hidden = !document.fullscreenEnabled;
$("fullscreen").onclick = () => {
  void (
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen()
  ).catch(() => {
    $("sensor-detail").textContent = "当前浏览器不允许全屏。";
  });
};
const fmt = (v: readonly number[] | null) =>
  v ? v.map((n) => n.toFixed(3)).join(", ") : "不可用";
const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const statusNames: Record<string, string> = {
  checking: "正在检测",
  requesting: "正在请求授权",
  granted: "已收到真实传感器数据",
  denied: "权限被拒绝",
  unsupported: "浏览器不支持传感器",
  unavailable: "传感器数据不可用",
  "insecure-context": "需要安全上下文",
  error: "传感器发生错误",
};
$("benchmark").onclick = () => {
  runStart = performance.now();
  benchmarkRows = [];
  benchmarkResult = undefined;
  $("benchmark").textContent = "基准记录中 · 60 秒";
  ($("benchmark") as HTMLButtonElement).disabled = true;
};
$("export").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(benchmarkResult, null, 2)], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "sandglass-benchmark.json";
  a.click();
  URL.revokeObjectURL(url);
};
function updateUi(now: number) {
  const a = sensor.acceleration;
  $("duration-estimate").textContent=airEnabled()?`1g 标准砂粗估 ${(estimatedDurationSeconds(count)/60).toFixed(1)} 分钟；增加数量会增加砂量。不是精确计时器。`:"真空模式：不保证分钟级流动。";
  const physicsHz =
    (Math.max(0, steps - previousSteps) * 1000) /
    Math.max(1, now - previousStatsTime);
  previousSteps = steps;
  previousStatsTime = now;
  const magnitude = Math.hypot(...a);
  $("g-value").innerHTML = `${(magnitude / 9.81).toFixed(2)} <small>g</small>`;
  $("mode").textContent =
    sensor.mode === "sensor"
      ? "真实传感器"
      : sensor.mode === "fault"
        ? "数据故障 · 零输入"
        : "预设加速度";
  $("sensor-status").textContent = statusNames[sensor.status] ?? sensor.status;
  $("sensor-detail").textContent = sensor.detail;
  $("status-dot").classList.toggle("live", sensor.mode === "sensor");
  ($("preset-controls") as HTMLFieldSetElement).disabled =
    sensor.mode === "sensor";
  $("preset-note").textContent =
    sensor.mode === "sensor"
      ? "真实数据有效：预设输入已锁定。"
      : sensor.mode === "fault"
        ? "真实数据中断。当前施加零输入；可主动启用预设。"
        : "无真实数据。可选择预设方向与幅值。";
  const fps = frames.length
    ? 1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)
    : 0;
  $("fps").textContent = `${fps.toFixed(0)} FPS`;
  const scale = 23 / 19.62;
  $("vector").setAttribute(
    "d",
    `M32 32L${32 + a[0] * scale} ${32 - a[1] * scale}`,
  );
  $("debug-data").textContent =
    `计算后端     CPU / Web Worker · PBD 静摩擦
输入模式     ${sensor.mode}
授权状态     ${sensor.status}
最近有效数据 ${sensor.lastValid === null ? "无" : ((now - sensor.lastValid) / 1000).toFixed(2) + " 秒前"}
原始含重力   ${fmt(sensor.raw)} m/s²
原始线性量   ${fmt(sensor.linear)} m/s²
屏幕变换量   ${fmt(sensor.transformed)} m/s²
显示值(未滤波) ${fmt(sensor.display)} m/s²
最终物理输入 ${fmt(a)} m/s²
输入模长     ${magnitude.toFixed(3)} m/s²
传感器频率   ${sensor.frequency.toFixed(1)} Hz
固定时间步   ${(1000 * FIXED_DT).toFixed(3)} ms
实际物理频率 ${physicsHz.toFixed(1)} Hz
累计物理步数 ${steps}
模拟时间     ${(steps*FIXED_DT).toFixed(1)} s
粒子数量     ${count}
活跃 / 休眠  ${active} / ${sleeping}
沙块 / 成员  ${islands} / ${clustered}
整体积分量   ${bulkIntegrated} 成员粒子×子步
沙块拆解数   ${islandSplits}
瓶颈内径     ${(neckRadius*2000).toFixed(2)} mm
有效细砂直径 ${(MICRO_GRAIN_DIAMETER*1e6).toFixed(0)} µm（粗采样，非逐微粒DEM）
空气模型     ${airEnabled()?"Stokes + 颈部 Darcy 有效闭合（非完整气体求解）":"真空 · 无空气阻力"}
接触 / 邻居  ${contacts} / ${neighborChecks}
最近子步数   ${substeps}
物理 CPU     ${workerMs.toFixed(2)} ms
渲染 CPU提交 ${renderMs.toFixed(2)} ms（非GPU）
GPU耗时      不可用
帧 P50/95/99 ${[0.5, 0.95, 0.99].map((p) => percentile(frames, p).toFixed(1)).join(" / ")} ms
延迟/丢弃时间 ${dropped.toFixed(4)} s
物理状态内存 ≥${((count * 40) / 1024).toFixed(0)} KiB（估计）
姿态信息     ${sensor.orientation ? JSON.stringify(sensor.orientation) : "未知"}
旋转速率     ${sensor.rotation ? JSON.stringify(sensor.rotation) : "未知"}`;
}
function frame(now: number) {
  if (disposed) return;
  requestAnimationFrame(frame);
  const elapsed = (now - last) / 1000;
  last = now;
  if (document.hidden) return;
  sensor.tick(now);
  elapsedPending += elapsed;
  if (!pending) {
    const buffer = positions?.buffer;
    worker.postMessage(
      {
        type: "advance",
        elapsed: elapsedPending,
        acceleration: sensor.acceleration,
        paused,
        buffer,
      },
      buffer ? [buffer] : [],
    );
    elapsedPending = 0;
    positions = undefined;
    pending = true;
  }
  const start = performance.now();
  scene.render();
  renderMs = performance.now() - start;
  const ms = elapsed * 1000;
  frames.push(ms);
  windowFrames.push(ms);
  if (frames.length > 600) frames.shift();
  if (now - lastUi > 200) {
    updateUi(now);
    lastUi = now;
  }
  if (runStart) {
    benchmarkRows.push({
      frameMs: ms,
      physicsMs: workerMs,
      renderSubmissionMs: renderMs,
      count,
      input: [...sensor.acceleration],
      contacts,
      active,
      sleeping,
      neighborChecks,
      neckRadius,
      steps,
      droppedSeconds: dropped,
      mode: sensor.mode,
    });
    if (now - runStart >= 60000) {
      const rows = benchmarkRows as { frameMs: number; physicsMs: number }[];
      const times = rows.map((r) => r.frameMs);
      benchmarkResult = {
        userAgent: navigator.userAgent,
        backend: "CPU Worker + WebGL2 instancing",
        durationMs: now - runStart,
        count,
        averageFps: 1000 / (times.reduce((a, b) => a + b, 0) / times.length),
        p50: percentile(times, 0.5),
        p95: percentile(times, 0.95),
        p99: percentile(times, 0.99),
        physicsMsP95: percentile(
          rows.map((r) => r.physicsMs),
          0.95,
        ),
        droppedSeconds: dropped,
        physicsSteps: steps,
        active,
        sleeping,
        neckRadius,
        estimatedStateBytes: count * 40,
        gpuMs: null,
        rows,
      };
      runStart = 0;
      $("benchmark").textContent = "重新开始 60 秒基准";
      ($("benchmark") as HTMLButtonElement).disabled = false;
      ($("export") as HTMLButtonElement).disabled = false;
    }
  }
  if (now - windowStart > 5000) {
    const p95 = percentile(windowFrames, 0.95);
    if (startup) {
      startup = false;
      $("budget").textContent =
        `启动实测 P95 ${p95.toFixed(1)} ms；当前预算 ${count.toLocaleString()} 粒。自动调节仅降低渲染开销，保持颗粒守恒。`;
    }
    slowWindows = p95 > 33 ? slowWindows + 1 : 0;
    fastWindows = p95 < 20 ? fastWindows + 1 : 0;
    if (slowWindows >= 2) {
      pixelRatio = Math.max(0.75, pixelRatio - 0.2);
      scene.renderer.setPixelRatio(pixelRatio);
      scene.resize();
      scene.setShape(0);
      ($("shape") as HTMLSelectElement).value = "0";
      $("budget").textContent =
        `持续低帧率：像素比 ${pixelRatio.toFixed(2)}，外观已切换为低面数细砂。保留 ${count} 粒；可主动选择较低档位重新分布。`;
      slowWindows = 0;
    }
    if (fastWindows >= 6 && pixelRatio < 1.6) {
      pixelRatio = Math.min(1.6, pixelRatio + 0.1);
      scene.renderer.setPixelRatio(pixelRatio);
      scene.resize();
      fastWindows = 0;
    }
    windowStart = now;
    windowFrames = [];
  }
}
document.addEventListener("visibilitychange", () => {
  last = performance.now();
  elapsedPending = 0;
  sensor.tick();
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  disposed = true;
  worker.terminate();
  sensor.dispose();
  scene.dispose();
});
sensor.start();
preset();
requestAnimationFrame(frame);
