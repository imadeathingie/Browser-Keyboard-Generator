import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { Mesh } from './core/types';

interface PartInstance {
  id: string;
  source: Mesh;
  object: THREE.Mesh;
  edges: THREE.LineSegments;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  baseColor: THREE.Color;
}

interface PartOptions {
  color?: number;
}

export enum RenderMode {
  Solid,
  Wireframe,
  SolidWithEdges,
}

export class Viewer {
  private readonly container: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly parts = new Map<string, PartInstance>();
  private readonly resizeObserver: ResizeObserver;
  private renderMode = RenderMode.SolidWithEdges;
  private readonly raycaster = new THREE.Raycaster();
  private hoveredPart?: PartInstance;
  private readonly pointer = new THREE.Vector2();
  private readonly objectMap = new Map<THREE.Object3D, PartInstance>();
  private readonly grid: THREE.GridHelper;

  constructor(container: HTMLElement) {
    this.container = container;

    this.scene.background = new THREE.Color(0xE8DBC0); // 0x15181d
    this.scene.fog = new THREE.Fog(0xE8DBC0, 900, 2600);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    // The generator's data is Z-up (mm); tell the camera so orbiting
    // behaves like a CAD viewport rather than a Y-up game scene.
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(250, -220, 250);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';

    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.zoomSpeed = 1.2;
    this.controls.rotateSpeed = 0.8;
    this.controls.panSpeed = 0.8;
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;

    this.addLights();

    // GridHelper lies in the XZ plane (three.js is Y-up by default); rotate
    // it into XY so it reads as the floor under our Z-up model.
    this.grid = new THREE.GridHelper(1000, 100, 0x39414d, 0x232830);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);

    const axes = new THREE.AxesHelper(40);
    this.scene.add(axes);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', () => {
      this.clearHover();
    });

    this.resize();
    this.animate();
  }

  private addLights() {
    const hemi = new THREE.HemisphereLight(0xdfe8f2, 0x40454d, 1.15);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(400, -600, 500);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xbcd0e8, 0.4);
    fill.position.set(-350, 150, 300);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffe2b0, 0.3);
    rim.position.set(0, 400, -200);
    this.scene.add(rim);
  }

  private resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private meshToGeometry(mesh: Mesh): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();

    const positions = new Float32Array(mesh.vertices.length * 3);
    mesh.vertices.forEach((v, i) => {
      positions[i * 3 + 0] = v[0];
      positions[i * 3 + 1] = v[1];
      positions[i * 3 + 2] = v[2];
    });
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Fan-triangulate polygon faces:
    //
    //   0--1        (0,1,2)
    //   | /|   ->   (0,2,3)
    //   |/ |
    //   3--2
    const indices: number[] = [];
    for (const face of mesh.faces) {
      if (face.length < 3) continue;
      for (let i = 1; i < face.length - 1; i++) {
        indices.push(face[0], face[i], face[i + 1]);
      }
    }
    geometry.setIndex(indices);

    // Un-index FIRST so each triangle owns its vertices, THEN compute
    // normals: that yields true per-face (flat) normals. The reverse order
    // averages normals across welded vertices before splitting them.
    const result = geometry.toNonIndexed();
    result.computeVertexNormals();
    result.computeBoundingBox();
    result.computeBoundingSphere();

    geometry.dispose();
    return result;
  }

  private disposePart(part: PartInstance) {
    if (this.hoveredPart === part) this.hoveredPart = undefined;
    this.objectMap.delete(part.object);
    this.scene.remove(part.object);
    part.edges.geometry.dispose();
    (part.edges.material as THREE.Material).dispose();
    part.geometry.dispose();
    part.material.dispose();
  }

  public clear() {
    for (const part of this.parts.values()) {
      this.disposePart(part);
    }
    this.parts.clear();
  }

  public setPart(id: string, source: Mesh, options: PartOptions = {}) {
    const old = this.parts.get(id);
    if (old) {
      this.disposePart(old);
      this.parts.delete(id);
    }
    if (source.vertices.length === 0 || source.faces.length === 0) return;

    const geometry = this.meshToGeometry(source);
    const color = new THREE.Color(options.color ?? 0xbcbcbc);

    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.62,
      metalness: 0.08,
      wireframe: this.renderMode === RenderMode.Wireframe,
    });

    const mesh = new THREE.Mesh(geometry, material);

    const edgeGeometry = new THREE.EdgesGeometry(geometry, 30 /* crease angle */);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x0c0e11,
      transparent: true,
      opacity: 0.5,
    });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edges.visible = this.renderMode === RenderMode.SolidWithEdges;
    mesh.add(edges);

    this.scene.add(mesh);

    const part: PartInstance = {
      id,
      source,
      object: mesh,
      edges,
      geometry,
      material,
      baseColor: color.clone(),
    };
    this.parts.set(id, part);
    this.objectMap.set(mesh, part);
  }

  public removePartsExcept(keep: Set<string>) {
    for (const [id, part] of [...this.parts]) {
      if (!keep.has(id)) {
        this.disposePart(part);
        this.parts.delete(id);
      }
    }
  }

  public setVisible(id: string, visible: boolean): void {
    const part = this.parts.get(id);
    if (!part) return;
    part.object.visible = visible;
    part.edges.visible = visible && this.renderMode === RenderMode.SolidWithEdges;
  }

  public setRenderMode(mode: RenderMode): void {
    this.renderMode = mode;
    for (const part of this.parts.values()) {
      part.material.wireframe = mode === RenderMode.Wireframe;
      part.edges.visible =
        part.object.visible && mode === RenderMode.SolidWithEdges;
    }
  }

  private visibleBounds(): THREE.Box3 | null {
    const box = new THREE.Box3();
    let found = false;
    for (const part of this.parts.values()) {
      if (!part.object.visible) continue;
      if (!part.geometry.boundingBox) continue;
      box.union(part.geometry.boundingBox);
      found = true;
    }
    return found ? box : null;
  }

  public frameAll(padding = 1.35): void {
    const box = this.visibleBounds();
    if (!box) return;

    // Sit the floor grid at the model's lowest point.
    this.grid.position.z = box.min.z;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 10);

    // Preserve the user's viewing direction.
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(1, -1, 1);
    direction.normalize();

    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (radius * padding) / Math.sin(fov * 0.5);

    this.controls.target.copy(center);
    this.camera.position.copy(
      center.clone().add(direction.multiplyScalar(distance)),
    );
    this.camera.near = Math.max(distance / 1000, 0.1);
    this.camera.far = Math.max(distance * 20, 3000);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private clearHover() {
    if (!this.hoveredPart) return;
    this.unhighlightPart(this.hoveredPart);
    this.hoveredPart = undefined;
  }

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);

    const objects = [...this.parts.values()]
      .filter(p => p.object.visible)
      .map(p => p.object);
    const hits = this.raycaster.intersectObjects(objects, false);

    if (hits.length === 0) {
      // The ray missed everything: drop any lingering highlight (previously
      // this was only handled on pointerleave, so the last-hovered part
      // stayed lit while the cursor idled over empty space).
      this.clearHover();
      return;
    }

    const part = this.objectMap.get(hits[0].object);
    if (this.hoveredPart === part) return;

    this.clearHover();
    this.hoveredPart = part;
    if (part) this.highlightPart(part);
  };

  private highlightPart(part: PartInstance): void {
    part.material.emissive.setRGB(0.12, 0.1, 0.05);
    part.material.color.copy(part.baseColor).multiplyScalar(1.12);
  }

  private unhighlightPart(part: PartInstance): void {
    part.material.emissive.setRGB(0, 0, 0);
    part.material.color.copy(part.baseColor);
  }

  public dispose(): void {
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.clear();
    this.controls.dispose();
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
