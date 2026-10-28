import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { HALF_HEIGHT, neckRadiusFor, radiusAt } from "./vessel";

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
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10);
  controls: OrbitControls;
  mesh!: THREE.InstancedMesh;
  private shell: THREE.Mesh<THREE.LatheGeometry, THREE.MeshPhysicalMaterial>;
  geometries = [
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.SphereGeometry(1, 7, 5),
    new THREE.OctahedronGeometry(1, 0),
    new THREE.IcosahedronGeometry(1, 0),
  ];
  material = new THREE.MeshStandardMaterial({
    roughness: 0.55,
    metalness: 0.12,
  });
  dummy = new THREE.Object3D();
  color = new THREE.Color();
  radii: Float32Array = new Float32Array();
  shape = 0;
  palette = 0;
  count = 0;
  observer: ResizeObserver;
  environment: THREE.WebGLRenderTarget;
  constructor(public container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    this.renderer.setClearColor(0x101719, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;
    container.append(this.renderer.domElement);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.environment.texture;
    this.camera.position
      .set(0.43, 0.19, 0.73)
      .multiplyScalar(container.clientWidth < 650 ? 1.25 : 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.48;
    this.controls.maxDistance = 1.6;
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
      opacity: 0.16,
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
        new THREE.CylinderGeometry(0.108, 0.108, 0.013, 64),
        dark,
      );
      cap.position.y = sign * 0.193;
      this.scene.add(cap);
      const lip = new THREE.Mesh(
        new THREE.TorusGeometry(0.101, 0.002, 8, 64),
        metal,
      );
      lip.rotation.x = Math.PI / 2;
      lip.position.y = sign * 0.184;
      this.scene.add(lip);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.108, 0.0018, 8, 64),
        metal,
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = sign * 0.195;
      this.scene.add(ring);
    }
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI * 2) / 3 + 0.4;
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0028, 0.0028, 0.373, 12),
        metal,
      );
      post.position.set(Math.sin(a) * 0.101, 0, Math.cos(a) * 0.101);
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
      .set(0.43, 0.19, 0.73)
      .multiplyScalar(this.container.clientWidth < 650 ? 1.25 : 1);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
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
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.prepareInstances();
    this.scene.add(this.mesh);
    this.setPalette(this.palette);
  }
  setShape(shape: number) {
    this.shape = shape;
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
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  update(positions: Float32Array) {
    if (!this.mesh) return;
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
