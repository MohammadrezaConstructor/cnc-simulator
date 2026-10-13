// 3D view for the milling simulator (three.js).
// Work coordinates (X, Y, Z) map to three.js (X, Z, −Y): Z up, Y away from the viewer.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { MillMachine } from './machine';
import { viseGeometry, PARALLEL_W } from './machine';
import { MATERIALS } from '../sim/machine';
import type { MillOp, MillTool } from './types';
import { discretize3 } from './path';
import { toolProfile } from './tools';
import type { BlockModel } from './stock';

const W = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);

/** free the GPU resources of an object tree before it is dropped (geometries, materials, textures) */
function disposeTree(o: THREE.Object3D) {
  if (o instanceof THREE.ArrowHelper) {
    o.dispose(); // its geometries are shared by all arrows – only the materials are freed
    return;
  }
  for (const c of o.children) disposeTree(c);
  const m = o as THREE.Mesh;
  m.geometry?.dispose();
  const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
  for (const mat of mats) {
    (mat as THREE.MeshStandardMaterial).map?.dispose();
    mat.dispose();
  }
}
function clearGroup(g: THREE.Group) {
  for (const c of g.children) disposeTree(c);
  g.clear();
}

interface Chip {
  alive: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: THREE.Euler;
  w: THREE.Vector3;
  life: number;
  s: number;
}

export class MillView3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private surf: THREE.Mesh | null = null;
  private skirt: THREE.Mesh | null = null;
  private bottom: THREE.Mesh | null = null;
  private surfMat: THREE.MeshStandardMaterial;
  private skirtMat: THREE.MeshStandardMaterial;
  private uBottom = { value: -1e9 };
  private gridKey = '';
  private fixture = new THREE.Group();
  private fixtureKey = '';
  /** work coordinate system G54: X/Y/Z arrows at the work zero, drawn on top of everything */
  private wcs = new THREE.Group();
  showWcs = true;
  private head = new THREE.Group();
  private toolSpin = new THREE.Group();
  private toolKey = '';
  private pathLines: THREE.LineSegments | null = null;
  private pathMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7 });
  private bottomMat = new THREE.MeshStandardMaterial({ color: 0x8a9099, metalness: 0.5, roughness: 0.5, side: THREE.DoubleSide });
  showPath = true;
  private visible = true;
  private angle = 0;
  private chips: Chip[] = [];
  private chipMesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private coolant: THREE.Points;
  private coolantPos: Float32Array;
  private coolantT: Float32Array;
  private colRaw = new THREE.Color();
  private colCut = new THREE.Color();
  private lastUpdate = 0;
  private floorY = -60;
  private lastSig = '';
  /** set by anything that changes the picture outside update() */
  forceRender = true;

  constructor(private host: HTMLElement, private machine: MillMachine) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'view3d-canvas';
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 6000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.background = new THREE.Color(0x1b2128);
    this.scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x30353c, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(-220, 260, 160);
    this.scene.add(dir);

    this.surfMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.55, envMapIntensity: 0.55, side: THREE.DoubleSide });
    const uB = this.uBottom;
    this.surfMat.onBeforeCompile = (sh) => {
      sh.uniforms.uBottom = uB;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vH;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = position.y;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vH;\nuniform float uBottom;')
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vH < uBottom) discard;');
    };
    this.skirtMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.6, envMapIntensity: 0.5, side: THREE.DoubleSide });

    this.scene.add(this.fixture);
    this.scene.add(this.wcs);
    this.scene.add(this.head);
    this.head.add(this.toolSpin);

    const chipGeo = new THREE.TorusGeometry(0.9, 0.22, 4, 8, Math.PI * 1.4);
    this.chipMesh = new THREE.InstancedMesh(chipGeo, new THREE.MeshStandardMaterial({ color: 0xbfc4ca, metalness: 0.85, roughness: 0.3 }), 600);
    this.chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chipMesh.count = 0;
    this.scene.add(this.chipMesh);
    for (let i = 0; i < 600; i++) this.chips.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), life: 0, s: 1 });

    const N = 240;
    this.coolantPos = new Float32Array(N * 3);
    this.coolantT = new Float32Array(N);
    for (let i = 0; i < N; i++) this.coolantT[i] = Math.random();
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(this.coolantPos, 3));
    this.coolant = new THREE.Points(cg, new THREE.PointsMaterial({ color: 0x6fc3ff, size: 1.5, transparent: true, opacity: 0.7, depthWrite: false }));
    this.coolant.frustumCulled = false;
    this.coolant.visible = false;
    this.scene.add(this.coolant);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.view('iso');
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.forceRender = true;
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(10, r.width), h = Math.max(10, r.height);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.forceRender = true;
  }

  setBackground(light: boolean) {
    (this.scene.background as THREE.Color).set(light ? 0xdde3ea : 0x1b2128);
    this.forceRender = true;
  }

  view(kind: 'iso' | 'front' | 'top' | 'side') {
    const b = this.machine.block;
    const c = W((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.bottom + (b.top - b.bottom) / 2);
    const d = Math.max(200, Math.max(b.x1 - b.x0, b.y1 - b.y0) * 2.6);
    this.controls.target.copy(c);
    if (kind === 'iso') this.camera.position.set(c.x + d * 0.55, c.y + d * 0.65, c.z + d * 0.75);
    if (kind === 'front') this.camera.position.set(c.x, c.y + d * 0.15, c.z + d);
    if (kind === 'top') this.camera.position.set(c.x, c.y + d * 1.1, c.z + 0.01);
    if (kind === 'side') this.camera.position.set(c.x + d, c.y + d * 0.15, c.z);
    this.controls.update();
  }

  setOps(ops: MillOp[]) {
    if (this.pathLines) {
      this.scene.remove(this.pathLines);
      this.pathLines.geometry.dispose();
    }
    const pos: number[] = [];
    const col: number[] = [];
    const cR = new THREE.Color(0xff5c5c), cF = new THREE.Color(0x4fb3ff), cA = new THREE.Color(0x46d39a);
    for (const o of ops) {
      if (o.kind !== 'move') continue;
      const pts = discretize3(o, 0.05);
      const c = o.type === 'rapid' ? cR : o.type === 'arc' ? cA : cF;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        pos.push(a.x, a.z + 0.05, -a.y, b.x, b.z + 0.05, -b.y);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.pathLines = new THREE.LineSegments(g, this.pathMat);
    this.pathLines.visible = this.showPath;
    this.scene.add(this.pathLines);
    this.forceRender = true;
  }

  // ------------------------------------------------------------------ fixture

  private rebuildFixture() {
    const b = this.machine.block;
    const key = `${b.x0}|${b.y0}|${b.x1}|${b.y1}|${b.top}|${b.bottom}|${b.def.aboveJaws}`;
    if (key === this.fixtureKey) return;
    this.fixtureKey = key;
    clearGroup(this.fixture);
    const v = viseGeometry(b);
    const steel = new THREE.MeshStandardMaterial({ color: 0x7a838e, metalness: 0.75, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3b444f, metalness: 0.4, roughness: 0.6 });
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: THREE.Material) => {
      const g = new THREE.BoxGeometry(x1 - x0, z1 - z0, y1 - y0);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.copy(W((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
      this.fixture.add(mesh);
    };
    const cx = (b.x0 + b.x1) / 2;
    const len = v.jaws[0].x1 - v.jaws[0].x0;
    for (const j of v.jaws) box(j.x0, j.x1, j.y0, j.y1, j.z0, j.z1, steel);
    // vise body under the jaws and between them
    box(cx - len / 2, cx + len / 2, b.y0 - 60, b.y1 + 45, v.base - 30, v.base, dark);
    box(cx - len / 2, cx + len / 2, b.y0 - 60, b.y0 - 22, v.base, v.jawTop - 8, dark);
    // parallels
    box(b.x0 + 2, b.x1 - 2, b.y0, b.y0 + PARALLEL_W, v.base, b.bottom, steel);
    box(b.x0 + 2, b.x1 - 2, b.y1 - PARALLEL_W, b.y1, v.base, b.bottom, steel);
    // machine table with T-slots
    const tz = v.base - 30;
    box(cx - 300, cx + 300, b.y0 - 140, b.y1 + 140, tz - 40, tz, new THREE.MeshStandardMaterial({ color: 0x55606b, metalness: 0.6, roughness: 0.45 }));
    for (let k = -1; k <= 1; k++) {
      const yy = (b.y0 + b.y1) / 2 + k * 70;
      box(cx - 300, cx + 300, yy - 7, yy + 7, tz - 0.5, tz + 0.2, new THREE.MeshStandardMaterial({ color: 0x2a3038 }));
    }
    this.floorY = tz;
    this.rebuildWcs(Math.max(b.x1 - b.x0, b.y1 - b.y0));
  }

  private rebuildWcs(size: number) {
    clearGroup(this.wcs);
    const L = Math.max(18, Math.min(45, size * 0.3));
    const label = (text: string, color: string, at: THREE.Vector3, h: number) => {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 64;
      const g = c.getContext('2d')!;
      g.font = 'bold 40px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 8;
      g.strokeStyle = 'rgba(0,0,0,0.75)';
      g.strokeText(text, 64, 34);
      g.fillStyle = color;
      g.fillText(text, 64, 34);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false }));
      sp.scale.set(h * 2, h, 1);
      sp.position.copy(at);
      sp.renderOrder = 21;
      this.wcs.add(sp);
    };
    const axis = (dir: THREE.Vector3, color: number, css: string, name: string) => {
      const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), L, color, L * 0.22, L * 0.11);
      a.traverse((c) => {
        const m = (c as THREE.Mesh).material as THREE.Material | undefined;
        if (m) {
          m.depthTest = false;
          m.depthWrite = false;
          m.transparent = true;
        }
        c.renderOrder = 20;
      });
      this.wcs.add(a);
      label(name, css, dir.clone().multiplyScalar(L + 5), 6);
    };
    axis(W(1, 0, 0), 0xff5d5d, '#ff6b6b', 'X+');
    axis(W(0, 1, 0), 0x3fcf6f, '#5ee08a', 'Y+');
    axis(W(0, 0, 1), 0x4f9dff, '#6aaeff', 'Z+');
    const dot = new THREE.Mesh(new THREE.SphereGeometry(L * 0.06, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd84a, depthTest: false, depthWrite: false, transparent: true }));
    dot.renderOrder = 20;
    this.wcs.add(dot);
    label('G54', '#ffd84a', W(-L * 0.25, -L * 0.25, -L * 0.18), 6);
    this.wcs.position.copy(W(0, 0, 0));
    this.wcs.visible = this.showWcs;
    this.forceRender = true;
  }

  // ------------------------------------------------------------------ height field

  private buildGrid(b: BlockModel) {
    const key = `${b.nx}|${b.ny}|${b.x0}|${b.y0}|${b.c}|${b.top}|${b.bottom}`;
    if (key === this.gridKey && this.surf) return false;
    this.gridKey = key;
    // the shared materials (surface, skirt, bottom) are kept; only geometries are freed
    for (const m of [this.surf, this.skirt, this.bottom]) {
      if (m) {
        this.scene.remove(m);
        m.geometry.dispose();
      }
    }
    this.skirt = null; // rebuilt (and added to the scene again) by buildSkirt
    const nx = b.nx, ny = b.ny;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let k = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, bb = a + 1, c = a + nx, d = c + 1;
        // counter-clockwise seen from above (+Z) so the faces point up
        idx[k++] = a;
        idx[k++] = bb;
        idx[k++] = c;
        idx[k++] = bb;
        idx[k++] = d;
        idx[k++] = c;
      }
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.surf = new THREE.Mesh(g, this.surfMat);
    this.surf.frustumCulled = false;
    this.scene.add(this.surf);
    const bg = new THREE.PlaneGeometry(b.x1 - b.x0, b.y1 - b.y0).rotateX(Math.PI / 2);
    this.bottom = new THREE.Mesh(bg, this.bottomMat);
    this.bottom.position.copy(W((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.bottom));
    this.scene.add(this.bottom);
    return true;
  }

  private vx(b: BlockModel, i: number) {
    return b.x0 + (i * (b.x1 - b.x0)) / (b.nx - 1);
  }
  private vy(b: BlockModel, j: number) {
    return b.y0 + (j * (b.y1 - b.y0)) / (b.ny - 1);
  }

  private updateSurface(force: boolean) {
    const b = this.machine.block;
    const rebuilt = this.buildGrid(b);
    let d = b.takeDirty('view3d');
    if (rebuilt || force) d = { i0: 0, i1: b.nx - 1, j0: 0, j1: b.ny - 1 };
    if (!d) return;
    const g = this.surf!.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute;
    const col = g.getAttribute('color') as THREE.BufferAttribute;
    const P = pos.array as Float32Array, N = nor.array as Float32Array, Cc = col.array as Float32Array;
    const nx = b.nx, ny = b.ny;
    const i0 = Math.max(0, d.i0 - 1), i1 = Math.min(nx - 1, d.i1 + 1), j0 = Math.max(0, d.j0 - 1), j1 = Math.min(ny - 1, d.j1 + 1);
    const mat = MATERIALS[b.def.material];
    this.colRaw.set(mat.raw);
    this.colCut.set(mat.color);
    const span = Math.max(1e-6, b.top - b.bottom);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        const h = b.h[k];
        P[k * 3] = this.vx(b, i);
        P[k * 3 + 1] = h;
        P[k * 3 + 2] = -this.vy(b, j);
        const hl = b.h[k - (i > 0 ? 1 : 0)], hr = b.h[k + (i < nx - 1 ? 1 : 0)];
        const hd = b.h[k - (j > 0 ? nx : 0)], hu = b.h[k + (j < ny - 1 ? nx : 0)];
        const sx = ((i > 0 ? 1 : 0) + (i < nx - 1 ? 1 : 0)) * b.c, sy = ((j > 0 ? 1 : 0) + (j < ny - 1 ? 1 : 0)) * b.c;
        let gx = (hr - hl) / sx, gy = (hu - hd) / sy;
        if (!isFinite(gx)) gx = 0;
        if (!isFinite(gy)) gy = 0;
        // normal of z = h(x, y) in three.js axes (x, up, -y)
        const l = Math.hypot(gx, gy, 1);
        N[k * 3] = -gx / l;
        N[k * 3 + 1] = 1 / l;
        N[k * 3 + 2] = gy / l;
        const c = b.cutBy[k] === 0 ? this.colRaw : this.colCut;
        // deeper = darker so pockets read at a glance (normalised to the first 15 mm)
        const shade = b.cutBy[k] === 0 ? 1 : 1 - 0.4 * Math.min(1, (b.top - h) / Math.min(span, 15));
        Cc[k * 3] = c.r * shade;
        Cc[k * 3 + 1] = c.g * shade;
        Cc[k * 3 + 2] = c.b * shade;
      }
    }
    const start = j0 * nx * 3, count = (j1 - j0 + 1) * nx * 3;
    for (const a of [pos, nor, col]) {
      a.clearUpdateRanges();
      a.addUpdateRange(start, count);
      a.needsUpdate = true;
    }
    this.uBottom.value = b.bottom + 0.004;
    if (d.i0 <= 1 || d.j0 <= 1 || d.i1 >= nx - 2 || d.j1 >= ny - 2 || rebuilt || force) this.buildSkirt(b);
  }

  /** the four side walls follow the edge heights of the map */
  private buildSkirt(b: BlockModel) {
    const pos: number[] = [];
    const col: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    const mat = MATERIALS[b.def.material];
    const raw = new THREE.Color(mat.raw);
    const wall = (pts: { x: number; y: number; h: number }[], n: [number, number, number]) => {
      const base = pos.length / 3;
      for (const p of pts) {
        pos.push(p.x, p.h, -p.y, p.x, b.bottom, -p.y);
        col.push(raw.r, raw.g, raw.b, raw.r, raw.g, raw.b);
        nor.push(...n, ...n);
      }
      for (let k = 0; k < pts.length - 1; k++) {
        const a = base + k * 2;
        idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    };
    const nx = b.nx, ny = b.ny;
    const row = (j: number) => Array.from({ length: nx }, (_, i) => ({ x: this.vx(b, i), y: this.vy(b, j), h: b.h[j * nx + i] }));
    const colm = (i: number) => Array.from({ length: ny }, (_, j) => ({ x: this.vx(b, i), y: this.vy(b, j), h: b.h[j * nx + i] }));
    wall(row(0), [0, 0, 1]);
    // reversed so every wall is wound facing outwards
    wall(row(ny - 1).reverse(), [0, 0, -1]);
    wall(colm(0).reverse(), [-1, 0, 0]);
    wall(colm(nx - 1), [1, 0, 0]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    if (this.skirt) {
      this.skirt.geometry.dispose();
      this.skirt.geometry = g;
    } else {
      this.skirt = new THREE.Mesh(g, this.skirtMat);
      this.scene.add(this.skirt);
    }
  }

  // ------------------------------------------------------------------ tool & head

  private rebuildTool(t: MillTool | undefined) {
    const key = t ? JSON.stringify(t) : 'none';
    if (key === this.toolKey) return;
    this.toolKey = key;
    clearGroup(this.head);
    this.toolSpin = new THREE.Group();
    this.head.add(this.toolSpin);
    const L = t ? t.length : 60;
    if (t) {
      const prof = toolProfile(t);
      const pts = prof.map((p) => new THREE.Vector2(Math.max(0.001, p.r), p.h));
      pts.unshift(new THREE.Vector2(0.001, prof[0].h));
      const g = new THREE.LatheGeometry(pts, 24);
      // stripes along the circumference make the rotation visible (the "flutes")
      const colors: number[] = [];
      const nPer = pts.length;
      const gold = new THREE.Color(t.type === 'drill' || t.type === 'tap' || t.type === 'ream' ? 0x9aa3ad : 0xc8cdd4), dark = new THREE.Color(0x3a4048);
      const count = g.getAttribute('position').count;
      for (let v = 0; v < count; v++) {
        const seg = Math.floor(v / nPer);
        const c = seg % Math.max(2, Math.round(24 / Math.max(1, t.flutes) / 2)) === 0 ? dark : gold;
        colors.push(c.r, c.g, c.b);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const cut = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.8, roughness: 0.25 }));
      this.toolSpin.add(cut);
      const top = prof[prof.length - 1].h;
      const shankR = Math.min(t.diameter / 2, 8);
      if (L - top > 0.5) {
        const shank = new THREE.Mesh(new THREE.CylinderGeometry(shankR, shankR, L - top, 24), new THREE.MeshStandardMaterial({ color: 0xa8b0b9, metalness: 0.85, roughness: 0.3 }));
        shank.position.y = top + (L - top) / 2;
        this.toolSpin.add(shank);
      }
    }
    // holder (collet chuck) + spindle nose
    const holderMat = new THREE.MeshStandardMaterial({ color: 0x4a525c, metalness: 0.7, roughness: 0.35 });
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(20, 16, 22, 32), holderMat);
    nut.position.y = L + 11;
    this.head.add(nut);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(31, 22, 30, 32), holderMat);
    cone.position.y = L + 37;
    this.head.add(cone);
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(60, 60, 60, 40), new THREE.MeshStandardMaterial({ color: 0x2c333b, metalness: 0.4, roughness: 0.55 }));
    nose.position.y = L + 82;
    this.head.add(nose);
    const body = new THREE.Mesh(new THREE.BoxGeometry(170, 260, 170), new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.2, roughness: 0.6 }));
    body.position.set(0, L + 112 + 130, 0);
    this.head.add(body);
  }

  update(dt: number, now: number) {
    if (!this.visible) return;
    const m = this.machine;
    this.rebuildFixture();
    if (now - this.lastUpdate > 60 || m.status !== 'running') {
      this.lastUpdate = now;
      this.updateSurface(false);
    }
    this.rebuildTool(m.toolDef);
    this.head.position.copy(W(m.pos.x, m.pos.y, m.pos.z));
    const vis = Math.min(m.live.rpm, 300) / 60;
    this.angle -= (m.spindle.dir === 'ccw' ? -1 : 1) * vis * Math.PI * 2 * dt;
    this.toolSpin.rotation.y = this.angle;
    if (this.pathLines) this.pathLines.visible = this.showPath;
    this.wcs.visible = this.showWcs;
    const chips = this.updateChips(dt);
    this.updateCoolant(dt);
    const moved = this.controls.update();
    // render only when something visible changed – keeps idle CPU/GPU use near zero
    const sig = `${m.pos.x},${m.pos.y},${m.pos.z}|${m.block.version}|${m.tool}|${m.status}|${this.showPath}|${this.showWcs}|${this.renderer.domElement.width}x${this.renderer.domElement.height}`;
    const animating = vis > 0 || chips > 0 || this.coolant.visible;
    if (!moved && !animating && sig === this.lastSig && !this.forceRender) return;
    this.lastSig = sig;
    this.forceRender = false;
    this.renderer.render(this.scene, this.camera);
  }

  /** full redraw of the block (new stock, theme…) */
  refresh() {
    this.forceRender = true;
    this.fixtureKey = '';
    this.updateSurface(true);
  }

  private updateChips(dt: number) {
    const m = this.machine;
    if (m.live.cutting && m.status === 'running' && m.live.mrr > 0.05) {
      const n = Math.min(10, Math.ceil(m.live.mrr * 0.3 * dt * 60));
      const R = (m.toolDef?.diameter ?? 4) / 2;
      for (let i = 0; i < n; i++) {
        const c = this.chips.find((q) => !q.alive);
        if (!c) break;
        const a = Math.random() * Math.PI * 2;
        c.alive = true;
        c.p.copy(W(m.pos.x + Math.cos(a) * R, m.pos.y + Math.sin(a) * R, m.pos.z + 0.5));
        c.v.set(Math.cos(a + 1.4) * 260, 80 + Math.random() * 160, -Math.sin(a + 1.4) * 260);
        c.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
        c.w.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
        c.life = 3 + Math.random() * 3;
        c.s = 0.6 + Math.random();
      }
    }
    let k = 0;
    for (const c of this.chips) {
      if (!c.alive) continue;
      c.life -= dt;
      if (c.life <= 0) {
        c.alive = false;
        continue;
      }
      if (c.p.y > this.floorY + 1) {
        c.v.y -= 1800 * dt;
        c.p.addScaledVector(c.v, dt);
        c.r.x += c.w.x * dt;
        c.r.y += c.w.y * dt;
      } else c.p.y = this.floorY + 1;
      this.dummy.position.copy(c.p);
      this.dummy.rotation.copy(c.r);
      this.dummy.scale.setScalar(c.s * Math.min(1, c.life));
      this.dummy.updateMatrix();
      this.chipMesh.setMatrixAt(k++, this.dummy.matrix);
    }
    this.chipMesh.count = k;
    this.chipMesh.instanceMatrix.needsUpdate = true;
    return k;
  }

  private updateCoolant(dt: number) {
    const m = this.machine;
    const on = m.coolant && m.spindle.dir !== 'off';
    this.coolant.visible = on;
    if (!on) return;
    const tip = W(m.pos.x, m.pos.y, m.pos.z + 2);
    const L = m.toolDef?.length ?? 60;
    const noz = W(m.pos.x - 45, m.pos.y - 35, m.pos.z + L + 40);
    const N = this.coolantT.length;
    for (let i = 0; i < N; i++) {
      let t = this.coolantT[i] + dt * 2.2;
      if (t > 1) t -= 1;
      this.coolantT[i] = t;
      const j = ((i * 7919) % 100) / 100 - 0.5;
      this.coolantPos[i * 3] = noz.x + (tip.x - noz.x) * t + j * 3 * t;
      this.coolantPos[i * 3 + 1] = noz.y + (tip.y - noz.y) * t - 10 * t * t;
      this.coolantPos[i * 3 + 2] = noz.z + (tip.z - noz.z) * t + (((i * 31) % 100) / 100 - 0.5) * 3 * t;
    }
    (this.coolant.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
