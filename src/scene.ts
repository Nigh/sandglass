import * as THREE from "three";
import {
  MeshStandardNodeMaterial,
  PMREMGenerator as GpuPMREMGenerator,
  StorageBufferAttribute,
  WebGPURenderer,
} from "three/webgpu";
import {
  float, instanceIndex, normalGeometry, positionGeometry, rotate, storage,
  transformNormalToView, uniform, vec3,
} from "three/tsl";

// Three r180 exposes these backend methods at runtime, but omits them from its types.
type StorageBackend = WebGPURenderer["backend"] & {
  readonly isWebGPUBackend: boolean;
  readonly device: GPUDevice;
  createStorageAttribute(attribute: StorageBufferAttribute): void;
  destroyAttribute(attribute: StorageBufferAttribute): void;
  get(attribute: StorageBufferAttribute): { buffer: GPUBuffer };
};
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { HALF_HEIGHT, MAX_RADIUS, neckRadiusFor, radiusAt } from "./vessel";

export const palettes = [
  "自然金色",
  "白色石英",
  "黑曜石",
  "海洋蓝",
  "翡翠绿",
  "彩虹混合",
];
const colors = [
  ["#d4a65b", "#eacb84", "#a87737"],
  ["#e5e4d9", "#b6cbd1", "#fff4dc"],
  ["#313c43", "#61717a", "#9b9690"],
  ["#398ca9", "#77bfd0", "#256b93"],
  ["#3c9e7e", "#93c9a1", "#216654"],
  ["#dd795f", "#dbbd68", "#73ae96", "#739dc4", "#b18cae"],
];
export class SandScene {
  readonly renderer: THREE.WebGLRenderer | WebGPURenderer;
  readonly backend: "webgpu" | "cpu";
  readonly gpuDevice?: GPUDevice;
  private storageAttribute?: StorageBufferAttribute;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10);
  controls: OrbitControls;
  private readonly mobile = matchMedia("(pointer: coarse)").matches;
  mesh!: THREE.InstancedMesh;
  private shell: THREE.Mesh<THREE.LatheGeometry, THREE.MeshPhysicalMaterial>;
  geometries = [
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.SphereGeometry(1, 7, 5),
    new THREE.OctahedronGeometry(1, 0),
    new THREE.IcosahedronGeometry(1, 0),
  ];
  material: THREE.MeshStandardMaterial | MeshStandardNodeMaterial;
  private readonly gpuShapeScale = uniform(new THREE.Vector3(1, 0.9, 0.85));
  dummy = new THREE.Object3D();
  color = new THREE.Color();
  radii: Float32Array = new Float32Array();
  shape = 0;
  palette = 0;
  count = 0;
  observer: ResizeObserver;
  environment: THREE.RenderTarget;

  static async create(container: HTMLElement): Promise<SandScene> {
    const adapter = navigator.gpu
      ? await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
      : null;
    if (adapter) {
      const device = await adapter.requestDevice({
        requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [],
      });
      const renderer = new WebGPURenderer({ device, antialias: true, alpha: true });
      // An acquired GPU that fails initialization is an error, not CPU physics.
      renderer._getFallback = null;
      try {
        await renderer.init();
        return new SandScene(container, renderer);
      } catch (error) {
        renderer.dispose();
        device.destroy();
        throw error;
      }
    }
    return new SandScene(container, new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    }));
  }

  private constructor(
    public container: HTMLElement,
    renderer: THREE.WebGLRenderer | WebGPURenderer,
  ) {
    this.renderer = renderer;
    this.backend = renderer instanceof WebGPURenderer ? "webgpu" : "cpu";
    if (renderer instanceof WebGPURenderer) {
      const backend = renderer.backend as StorageBackend;
      if (!backend.isWebGPUBackend) throw new Error("WebGPU renderer did not acquire a WebGPU backend");
      this.gpuDevice = backend.device;
    }
    this.material = this.backend === "webgpu"
      ? new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.12 })
      : new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.12 });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.mobile ? 1 : 1.6));
    this.renderer.setClearColor(0x101719, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;
    container.append(this.renderer.domElement);
    const pmrem = renderer instanceof WebGPURenderer
      ? new GpuPMREMGenerator(renderer)
      : new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.environment.texture;
    this.camera.position
      .set(this.mobile ? 0 : 0.43, this.mobile ? 0 : 0.19, this.mobile ? 0.85 : 0.73)
      .multiplyScalar((HALF_HEIGHT / 0.18) * (container.clientWidth < 650 ? 1.25 : 1));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enabled = !this.mobile;
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = HALF_HEIGHT * (0.48 / 0.18);
    this.controls.maxDistance = HALF_HEIGHT * (1.6 / 0.18);
    this.controls.minPolarAngle = 0.2;
    this.controls.maxPolarAngle = Math.PI - 0.2;
    this.scene.add(new THREE.HemisphereLight(0xc5e7e8, 0x29302c, 2));
    const light = new THREE.DirectionalLight(0xffe4ba, 3);
    light.position.set(-0.3, 0.7, 0.5);
    this.scene.add(light);
    const rim = new THREE.DirectionalLight(0x87cad6, 2);
    rim.position.set(0.5, 0, -0.4);
    this.scene.add(rim);
    const geometry = this.glassGeometry(neckRadiusFor(1000));
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xd3e8df,
      roughness: 0.12,
      metalness: 0,
      transparent: true,
      // WebGPU blends into HDR before tone mapping; avoid a milky, opaque shell.
      opacity: this.backend === "webgpu" ? 0.025 : 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      clearcoat: 1,
    });
    this.shell = new THREE.Mesh(geometry, glass);
    this.shell.renderOrder = 2;
    this.scene.add(this.shell);
    const metal = new THREE.MeshStandardMaterial({
      color: 0x796a50,
      metalness: 0.8,
      roughness: 0.29,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x242c2c,
      metalness: 0.5,
      roughness: 0.4,
    });
    for (const sign of [-1, 1]) {
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(MAX_RADIUS * 1.2, MAX_RADIUS * 1.2, HALF_HEIGHT * 0.072, 64),
        dark,
      );
      cap.position.y = sign * HALF_HEIGHT * 1.072;
      this.scene.add(cap);
      const lip = new THREE.Mesh(
        new THREE.TorusGeometry(MAX_RADIUS * 1.122, MAX_RADIUS * 0.022, 8, 64),
        metal,
      );
      lip.rotation.x = Math.PI / 2;
      lip.position.y = sign * HALF_HEIGHT * 1.022;
      this.scene.add(lip);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(MAX_RADIUS * 1.2, MAX_RADIUS * 0.02, 8, 64),
        metal,
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = sign * HALF_HEIGHT * 1.083;
      this.scene.add(ring);
    }
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3 + 0.4;
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(MAX_RADIUS * 0.031, MAX_RADIUS * 0.031, HALF_HEIGHT * 2.072, 12),
        metal,
      );
      post.position.set(Math.sin(a) * MAX_RADIUS * 1.122, 0, Math.cos(a) * MAX_RADIUS * 1.122);
      this.scene.add(post);
    }
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.renderer.domElement.addEventListener("dblclick", () =>
      this.resetView(),
    );
  }
  private glassGeometry(neckRadius: number): THREE.LatheGeometry {
    const profile: THREE.Vector2[] = [];
    for (let i = 0; i <= 160; i++) {
      const y = -HALF_HEIGHT + (i * 2 * HALF_HEIGHT) / 160;
      profile.push(new THREE.Vector2(radiusAt(y, neckRadius), y));
    }
    return new THREE.LatheGeometry(profile, 72);
  }
  resize() {
    const { width, height } = this.container.getBoundingClientRect();
    this.renderer.setSize(width, height);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }
  resetView() {
    this.camera.position
      .set(this.mobile ? 0 : 0.43, this.mobile ? 0 : 0.19, this.mobile ? 0.85 : 0.73)
      .multiplyScalar((HALF_HEIGHT / 0.18) * (this.container.clientWidth < 650 ? 1.25 : 1));
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }
  createGpuStorage(): GPUBuffer {
    if (!(this.renderer instanceof WebGPURenderer) || !this.count) {
      throw new Error("Configure a WebGPU scene before creating particle storage");
    }
    this.releaseGpuStorage();
    const attribute = new StorageBufferAttribute(this.count, 4);
    attribute.name = "GPU particle positions and radii";
    const backend = this.renderer.backend as StorageBackend;
    backend.createStorageAttribute(attribute);
    this.storageAttribute = attribute;
    const particle = storage(attribute, "vec4", this.count).toReadOnly().element(instanceIndex);
    const material = this.material as MeshStandardNodeMaterial;
    const rotation = float(instanceIndex).mul(vec3(0.7, 1.2, 0.31));
    // Only the grain geometry rotates/stretches. Its GPU center is added last.
    material.positionNode = rotate(positionGeometry.mul(this.gpuShapeScale), rotation)
      .mul(particle.w).add(particle.xyz);
    material.normalNode = transformNormalToView(
      rotate(normalGeometry.div(this.gpuShapeScale), rotation),
    ).toVarying().normalize();
    material.needsUpdate = true;
    return backend.get(attribute).buffer;
  }

  private releaseGpuStorage() {
    if (!this.storageAttribute || !(this.renderer instanceof WebGPURenderer)) return;
    (this.renderer.backend as StorageBackend).destroyAttribute(this.storageAttribute);
    this.storageAttribute = undefined;
  }

  configure(count: number, radii: Float32Array, neckRadius: number) {
    const oldGeometry = this.shell.geometry;
    this.shell.geometry = this.glassGeometry(neckRadius);
    oldGeometry.dispose();
    this.radii = radii;
    this.count = count;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.dispose();
    }
    this.mesh = new THREE.InstancedMesh(
      this.geometries[this.shape],
      this.material,
      count,
    );
    if (this.backend === "cpu") this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.prepareInstances();
    this.scene.add(this.mesh);
    this.setPalette(this.palette);
  }
  setShape(shape: number) {
    this.shape = shape;
    this.gpuShapeScale.value.set(shape === 1 ? 0.85 : 1, shape === 2 ? 1 : 0.9, 0.85);
    if (this.mesh) {
      this.mesh.geometry = this.geometries[shape];
      this.prepareInstances();
    }
    this.material.roughness = shape === 2 ? 0.22 : 0.55;
  }
  setPalette(palette: number) {
    this.palette = palette;
    if (!this.mesh) return;
    const set = colors[palette];
    for (let i = 0; i < this.count; i++) {
      this.color.set(set[(Math.imul(i + 1, 2654435761) >>> 0) % set.length]);
      this.color.multiplyScalar(0.88 + ((i * 17) % 23) / 100);
      this.mesh.setColorAt(i, this.color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  private prepareInstances() {
    const matrices = this.mesh.instanceMatrix.array;
    if (this.backend === "webgpu") {
      // Never let an instance transform rotate/scale the GPU world-space center.
      matrices.fill(0);
      for (let i = 0; i < this.count; i++) {
        const offset = i * 16;
        matrices[offset] = matrices[offset + 5] = matrices[offset + 10] = matrices[offset + 15] = 1;
      }
      this.mesh.instanceMatrix.needsUpdate = true;
      return;
    }
    for (let i = 0; i < this.count; i++) {
      const offset = i * 16;
      const r = this.radii[i];
      this.dummy.position.set(
        matrices[offset + 12],
        matrices[offset + 13],
        matrices[offset + 14],
      );
      this.dummy.rotation.set(i * 0.7, i * 1.2, i * 0.31);
      this.dummy.scale.set(
        r * (this.shape === 1 ? 0.85 : 1),
        r * (this.shape === 2 ? 1 : 0.9),
        r * 0.85,
      );
      this.dummy.updateMatrix();
      this.dummy.matrix.toArray(matrices, offset);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  update(positions: Float32Array) {
    if (!this.mesh || this.backend === "webgpu") return;
    const matrices = this.mesh.instanceMatrix.array;
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      const p = i * 3;
      const offset = i * 16 + 12;
      if (
        matrices[offset] === positions[p] &&
        matrices[offset + 1] === positions[p + 1] &&
        matrices[offset + 2] === positions[p + 2]
      ) continue;
      matrices[offset] = positions[p];
      matrices[offset + 1] = positions[p + 1];
      matrices[offset + 2] = positions[p + 2];
      changed = true;
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }
  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
  dispose() {
    this.releaseGpuStorage();
    this.observer.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        materials.forEach((m) => m.dispose());
      }
    });
    this.geometries.forEach((g) => g.dispose());
    this.environment.dispose();
    this.renderer.dispose();
  }
}
