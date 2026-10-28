# 流砂 · Sandglass

公开仓库：[Nigh/sandglass](https://github.com/Nigh/sandglass)。

工程验收、5000 粒实时基准及原始数据见 [benchmarks/RESULTS.md](benchmarks/RESULTS.md)。桌面硬件结果不代替真实 Android/iPhone 验收。

Vite + TypeScript + Three.js 的纯前端沙漏。手机传感器与预设输入共用粒子积分接口，全部计算在本地执行。字体也随应用本地部署，无后端、账号、分析服务或传感器数据上传。

## 运行

需要 Node.js 20.19+ 或 22.12+。

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run preview
```

开发命令监听局域网。手机访问 `http://电脑IP:端口` **不是安全上下文**，不能据此验证传感器；请用 HTTPS 开发代理或部署到 HTTPS 站点。以命令实际输出端口为准。

`dist/` 可部署到任何静态 HTTPS 托管服务。`public/_headers` 适用于支持此格式的平台；其他服务器应设置 `Permissions-Policy: accelerometer=(self), gyroscope=(self), magnetometer=(self)`。嵌入 iframe 还需要父页面的 Permissions Policy 和 `allow="accelerometer; gyroscope; magnetometer"`。应用不依赖 SharedArrayBuffer，无需 COOP/COEP。

### GitHub Pages

站点地址：[nigh.github.io/sandglass](https://nigh.github.io/sandglass/)。

`.github/workflows/deploy-pages.yml` 在推送到 `main` 时自动运行，也支持 Actions 页面手动执行 `workflow_dispatch`。工作流使用 Node.js 24，依次运行 `npm ci`、单元测试和 TypeScript/Vite 构建，再通过官方 Pages artifact 部署；构建路径取自 Pages 配置，支持仓库子路径。构建仅有读取权限，部署单独授予 `pages: write` 和 `id-token: write`。

仓库的 Settings → Pages → Source 需选择 **GitHub Actions**。Pages 不处理 `public/_headers`；传感器仍需用户授权，嵌入其他网站时需由嵌入方设置 Permissions Policy。

## 使用

- 首次加载尝试权限申请。iOS 可能要求点击“启用手机传感器”；两个权限 API 在同一用户手势调用栈内执行。
- 只有有效含重力加速度到达后才进入真实模式。真实模式禁用预设；改变预设不能覆盖传感器。
- 数据超时或无效后立即使用标明的故障/零输入，不偷偷恢复向下 1g。点击“使用当前预设”可主动恢复预设；新真实数据自动重新取得独占控制。
- 预设支持六轴方向、自定义单位方向和 0–3g 连续幅值。归一化仅用于用户输入的**预设方向**，绝不用于真实测量。
- 拖动观察、双指/滚轮缩放、双击复位。相机与物理输入独立。
- 暂停不重置位置。颜色和外观保持位置、速度；材料改变接触参数。更改粒子数量、重置和恢复初始分布属于明确的重新初始化操作。
- 默认开启细砂空气阻力。关闭复选框进入无空气阻力模型，可检查零输入下的惯性；切换不重置颗粒位置、速度或传感器输入。零外加加速度不等于没有空气力或接触力。
- 调试面板显示读数、坐标变换、最终加速度、数据年龄、频率、CPU 耗时与帧时间分位数。显示值未滤波，不把估计冒充测量。

## 物理输入与坐标

设备坐标：x 向屏幕右，y 向设备顶部，z 朝屏幕外。`screen.orientation.angle`（或旧版 `window.orientation`）将设备轴旋转到当前屏幕轴。沙漏物理坐标和 Three.js 模型坐标使用屏幕轴；OrbitControls 只改变相机。

本应用采用**随手机固定的容器参考系**，不是假装获得绝对惯性世界姿态。忽略旋转项时，相对容器的有效加速度为 `g - a_device`，而理想加速度计的比力为 `a_device - g`。浏览器 `accelerationIncludingGravity` 的平台符号约定不完全一致；标准浏览器常见竖直静止读数约为 `(0,-9.81,0)`，直接对应此容器所需输入。提供明确的极性校准，必须按实机静止、倾斜与平移测试确认，不能凭“约 1g”自动猜测符号。

保留原始含重力量、原始线性量、屏幕变换量和最终物理量。姿态与旋转速率单独显示。不会通过姿态角生成固定模长重力，也不额外叠加地球 1g。静止的 1g 不被解释为设备正在进行 1g 平移；近自由落体读数趋零时，相对容器的平移惯性驱动趋零，已有速度继续积分。

**可观测边界：** 浏览器无法保证绝对姿态和传感器偏差可辨识；方向数据可能在剧烈运动时失准。当前模型不重建完整 Euler、离心及 Coriolis 加速度场，也不使用陀螺积分假冒精确运动。快速转动产生的平移读数会驱动沙粒，但不能视为完整六自由度容器仿真。请勿抛掷手机进行失重测试。

## 物理与性能架构

- 支持 WebGPU 的浏览器默认采用 GPU 常驻物理。计算与 Three.js WebGPURenderer 共用 GPUDevice、同一个 `vec4(x,y,z,radius)` 存储缓冲；渲染节点直接读取粒子位置，正常逐帧路径没有粒子回读、CPU 实例矩阵重建或位置上传。
- GPU 采用质量加权、无写入竞争的 Jacobi 接触求解；预测与修正缓冲交替使用。原子链式均匀网格在每轮位置修正前重建，只遍历相邻 27 单元；每粒一个链节点，没有固定桶容量或丢弃邻居的上限。
- 固定外步长 1/120 秒；GPU 每步使用 8 个子步、每子步 3 轮接触迭代及库仑摩擦。重力保留三轴真实幅值，不截断速度、不指定沙流速度、不定时放粒。
- GPU 计算和渲染的完成通知限制在途工作；尚未完成时不持续堆积命令。模拟积压、实际物理步数和绘制帧时间分别显示；不能用静止画面的高刷新率掩盖物理变慢。
- 每批最多推进两个外步，避免大批追赶产生“计算过慢、下一帧继续加大批次”的低帧率反馈。未提交时间保留在积压中；60 Hz 绘制时最多推进 120 Hz 物理，瞬时卡顿的积压不会被额外步骤追平。
- 可用时用 WebGPU timestamp query 测量整批物理计算，不包含渲染。仅异步读取 16 字节计时结果；CPU 编码/提交时间不是 GPU 时间。GPU 接触数未回读时明确显示不可用。
- 无 WebGPU adapter 时使用真实 CPU Web Worker + WebGL 后端。CPU 使用预分配 TypedArray、计数/前缀和/散射连续网格、带位移失效检查的邻居缓存、支撑链休眠及局部高速墙扫描。已删除成本高于收益的粒群岛归并。
- CPU 位置通过可转移缓冲交给 InstancedMesh；仅上传实际变化的平移。启动测量保守选择数量，持续低帧率仅调整渲染开销，不删除颗粒。
- WebGPU 初始化失败或设备丢失明确停止并报错，不静默替换求解器，也不把软件 adapter 当成硬件性能证据。

### 容器、砂量与物理边界

容器内高 86 mm、最大内径 50 mm，采用共享解析双曲锥面：玻璃和碰撞使用同一轮廓。5000 粒时孔径 3.15 mm，基准等效半径 0.420 mm；密实、无重叠的初始分布顶面位于上腔高度约 53.8%。收细的是实际几何开口，不是隐藏宽开口后绘制一条装饰沙线。

增加粒子数量会增加等效砂量并适度细化颗粒。可见碰撞球是细砂体积采样，不是逐颗解析 26 µm 微粒。窄孔可能因材料、姿态和接触形成堵塞；没有强制解堵或流量控制器。

默认空气模型包含稀相 Stokes 阻力，以及颈部接触粒群的 Darcy 启发局部阻力。隐式更新 `v_next = (v + a*h) / (1 + h*阻力率)` 保留输入加速度幅值和方向；关闭空气时阻力项为零。零外加加速度不等于没有空气力或接触力，验证惯性请关闭空气。

26 µm 有效粒径、0.4 孔隙率、0.65 水力形状因子及材料有效密度是闭合参数，不是实际砂样的测量值。没有求解空气压力、气体质量守恒、颗粒转动、棱角、黏聚或完整连续粒间碰撞。高速玻璃接触采用局部扫描；极端真空运动仍不等于认证 DEM。

旧容器的 97 秒实测与时长外推不适用于新几何，已删除界面估时。模拟不追求指定排砂秒数。

实现参考：[grain-cuda-sand](https://github.com/SamG-Coder/grain-cuda-sand) 的 GPU 常驻状态、计算/渲染共享缓冲、预分配资源和网格邻域思想；[Müller 空间网格](https://matthias-research.github.io/pages/tenMinutePhysics/11-hashing.pdf)、[Small Steps](https://mmacklin.com/smallsteps.pdf)、[PBD 接触与静摩擦](https://mmacklin.com/uppfrta_preprint.pdf)、[沙漏气体阻力](https://pmc.ncbi.nlm.nih.gov/articles/PMC5461489/)。本项目直接实现 WGSL，不引入 CUDA 编译器；没有照搬参考实现的速度截断。参考项目的帧率不是本项目的测量。

### 后端选择

| 路径 | 当前状态 | 性能边界 |
|---|---|---|
| WebGPU Compute + WebGPU 直渲染 | 实际默认路径，需要可用 adapter | 5000 粒实时验收必须同时检查绘制帧率、物理进度、积压和 GPU 时间 |
| CPU Worker + WebGL | 无 WebGPU 时的实际兼容路径 | 保留完整交互与守恒；不承诺 5000 粒实时 60 FPS |

手机仍需在具体设备上运行同一基准；WebGPU API 存在不代表 adapter 可用或性能充足。

## 自动化与基准

```sh
npm test
npm run typecheck
npm run build
npx playwright install chromium
BASE_URL=http://localhost:5177 npx tsx scripts/browser-smoke.ts
BASE_URL=http://localhost:5177 npx tsx scripts/browser-smoke.ts --gpu
BASE_URL=http://localhost:5177 npx tsx scripts/gpu-smoke.ts
BASE_URL=http://localhost:5177 npx tsx scripts/realtime-benchmark.ts
npm run benchmark -- --counts=5000 --seconds=12 --output=benchmarks/physics-current.json
npm run benchmark:flow -- --counts=1000 --seconds=15 --output=benchmarks/flow-sample.json
```

`browser-smoke.ts` 默认强制验证无 WebGPU 的 CPU 路径；`--gpu` 验证实际 GPU 路径及设备丢失。覆盖权限拒绝/恢复、2g/0g、真实输入锁定、过期故障、显式预设、暂停、重置、数量变更、外观和手机布局。

`gpu-smoke.ts` 在真实 GPU 上推进 360 个固定步，检查初始半高、持续跨颈、边界、有限性、接触压缩和反向重力。只在显式验收时读取粒子状态。

`realtime-benchmark.ts` 运行实际页面 60 秒，固定 5000 粒，覆盖竖直、翻转、横向 2g、零输入和恢复。导出 `benchmarks/realtime-5000.json`，同时要求平均绘制帧率至少 58 FPS、P95 不超过 20 ms、物理进度不少于墙钟的 97%、不丢弃模拟时间。Linux 默认启用原生 Vulkan 并记录 adapter 标识；`SOFTWARE_GPU=1` 只用于兼容性诊断，不冒充硬件跑分。

界面也可记录并导出同一 60 秒基准。CPU 物理脚本单独测求解吞吐量、分位数、边界和有限性，不把其步耗时换算成渲染 FPS。

## 平台与验收边界

- iOS Safari：用户手势授权，系统/站点拒绝后可能需要在 Safari 网站设置允许“运动与方向访问”，然后重载。
- Android Chrome：通常没有 `requestPermission()` 静态方法，但仍可能被站点设置、系统策略、硬件缺失或 iframe 策略阻止。
- 桌面：API 存在不代表硬件存在；等不到有效数据会进入数据不可用，可完整使用预设。
- HTTPS/localhost 之外显示安全上下文错误。
- **没有真实 Android 或 iPhone 硬件，不能声称通过手机传感器、旋转极性、自由落体或持续 30 FPS 验收。** 需要在具体机型与浏览器上运行相同的 60 秒场景，确认自动预算、权限、横竖屏、平移、摇晃、后台恢复及高密度堆积。推荐粒子预算须以实机导出结果为准，界面档位不是性能承诺。
