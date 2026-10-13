// 3D view (three.js): revolved stock, chuck, tool, chips & coolant.
// Mapping: simulator (z, x=radius) at spindle angle θ → three.js (z, x·cosθ, x·sinθ).
// The lathe X axis (towards the tool) is three.js +Y.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Machine } from '../sim/machine';
import { chuckGeometry, MATERIALS } from '../sim/machine';
import type { Body } from '../sim/stock';
import type { Op, P } from '../types';
import { discretize, deg } from '../sim/geom';

export interface ThreadZone {
  z0: number;
  z1: number;
  lead: number;
  xMin: number;
  xMax: number;
}

interface RevolveOpts {
  segments: number;
  t0: number;
  t1: number;
  rawR: number;
  rawBore: number;
  faceZ: number;
  leftZ: number;
  colMachined: THREE.Color;
  colRaw: THREE.Color;
  threads: ThreadZone[];
}

function revolve(bodies: Body[], o: RevolveOpts): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const S = o.segments;
  const full = o.t1 - o.t0 >= Math.PI * 2 - 1e-6;
  const cosT: number[] = [];
  const sinT: number[] = [];
  const th: number[] = [];
  for (let j = 0; j <= S; j++) {
    const t = o.t0 + ((o.t1 - o.t0) * j) / S;
    th.push(t);
    cosT.push(Math.cos(t));
    sinT.push(Math.sin(t));
  }
  const zShift = (z: number, r: number, j: number) => {
    for (const tz of o.threads) {
      if (z < tz.z0 - tz.lead || z > tz.z1 + tz.lead || r > o.rawR + 0.01 || r < tz.xMin - 0.3) continue;
      const w = Math.max(0, Math.min(1, (z - tz.z0) / tz.lead)) * Math.max(0, Math.min(1, (tz.z1 - z) / tz.lead));
      const a = ((th[j] - o.t0) / (Math.PI * 2)) * tz.lead;
      return z - w * a;
    }
    return z;
  };

  const pushRing = (z: number, r: number, nz: number, nr: number, c: THREE.Color) => {
    const base = pos.length / 3;
    for (let j = 0; j <= S; j++) {
      pos.push(zShift(z, r, j), r * cosT[j], r * sinT[j]);
      nor.push(nz, nr * cosT[j], nr * sinT[j]);
      col.push(c.r, c.g, c.b);
    }
    return base;
  };
  const strip = (a: number, b: number) => {
    for (let j = 0; j < S; j++) {
      idx.push(a + j, b + j, a + j + 1, a + j + 1, b + j, b + j + 1);
    }
  };

  const chain = (pts: P[], outward: 1 | -1, rawCheck: (p: P) => boolean) => {
    if (pts.length < 2) return;
    if (outward === -1 && pts.every((p) => p.x < 1e-4)) return; // solid: no bore surface
    const segN: [number, number][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const dz = pts[i + 1].z - pts[i].z, dx = pts[i + 1].x - pts[i].x;
      const L = Math.hypot(dz, dx) || 1;
      // left normal of (dz,dx) is (-dx, dz) → outward for the top chain
      segN.push(outward === 1 ? [-dx / L, dz / L] : [dx / L, -dz / L]);
    }
    const smooth = (a: [number, number], b: [number, number]): [number, number] => {
      const d = a[0] * b[0] + a[1] * b[1];
      if (d < Math.cos(deg(35))) return a;
      const s = [a[0] + b[0], a[1] + b[1]];
      const l = Math.hypot(s[0], s[1]) || 1;
      return [s[0] / l, s[1] / l];
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const nA = i > 0 ? smooth(segN[i], segN[i - 1]) : segN[i];
      const nB = i < segN.length - 1 ? smooth(segN[i], segN[i + 1]) : segN[i];
      const raw = rawCheck(a) && rawCheck(b);
      const c = raw ? o.colRaw : o.colMachined;
      const r0 = pushRing(a.z, a.x, nA[0], nA[1], c);
      const r1 = pushRing(b.z, b.x, nB[0], nB[1], c);
      strip(r0, r1);
    }
  };

  for (const b of bodies) {
    chain(b.top, 1, (p) => Math.abs(p.x - o.rawR) < 1e-4);
    chain(b.bottom, -1, (p) => o.rawBore > 0 && Math.abs(p.x - o.rawBore) < 1e-4);
    for (const cap of b.caps) {
      const raw = Math.abs(cap.z - o.faceZ) < 1e-6 || Math.abs(cap.z - o.leftZ) < 1e-6;
      const c = raw ? o.colRaw : o.colMachined;
      const r0 = pushRing(cap.z, cap.r0, cap.dir, 0, c);
      const r1 = pushRing(cap.z, cap.r1, cap.dir, 0, c);
      strip(r0, r1);
    }
    if (!full) {
      // section faces at both cut planes
      const contour = b.outline.map((p) => new THREE.Vector2(p.z, p.x));
      let tris: number[][] = [];
      try {
        tris = THREE.ShapeUtils.triangulateShape(contour, []);
      } catch {
        tris = [];
      }
      for (const [jj, sgn] of [[0, -1], [S, 1]] as [number, number][]) {
        const base = pos.length / 3;
        const n = [0, -sinT[jj] * sgn, cosT[jj] * sgn];
        for (const p of b.outline) {
          pos.push(p.z, p.x * cosT[jj], p.x * sinT[jj]);
          nor.push(n[0], n[1], n[2]);
          col.push(o.colMachined.r * 0.92, o.colMachined.g * 0.92, o.colMachined.b * 0.95);
        }
        for (const t of tris) idx.push(base + t[0], base + t[1], base + t[2]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function extrude(poly: P[], depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.z, p.x)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** free the GPU resources of everything below `root` (geometries, materials and their textures);
 *  materials in `keep` are shared and stay alive */
function disposeTree(root: THREE.Object3D, keep?: THREE.Material) {
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const obj = o as THREE.Mesh;
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) mats.add(m);
  });
  for (const m of mats) {
    if (m === keep) continue;
    for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
    m.dispose();
  }
}

interface Particle {
  alive: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  r: THREE.Euler;
  w: THREE.Vector3;
  life: number;
  s: number;
}

export class View3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private spindle = new THREE.Group();
  private stockMesh: THREE.Mesh | null = null;
  private droppedMesh: THREE.Mesh | null = null;
  private droppedAnim = { t: 0, y0: 0, active: false };
  private toolGroup = new THREE.Group();
  private toolKey = '';
  private pathLines: THREE.LineSegments | null = null;
  /** one material for every tool-path rebuild (setOps runs on each edit) */
  private pathMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 });
  private stockMat: THREE.MeshStandardMaterial;
  private lastVersion = -1;
  private lastBuild = 0;
  private lastStockKey = '';
  section = false;
  showPath = true;
  threads: ThreadZone[] = [];
  private angle = 0;
  private chips: Particle[] = [];
  private chipMesh: THREE.InstancedMesh;
  private coolant: THREE.Points;
  private coolantPos: Float32Array;
  private coolantT: Float32Array;
  private dummy = new THREE.Object3D();
  private bedY = -120;
  private visible = true;
  private lastSig = '';
  forceRender = true;
  private chuckGroupKey = '';
  private chuckGroup = new THREE.Group();

  constructor(private host: HTMLElement, private machine: Machine) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'view3d-canvas';

    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.background = new THREE.Color(0x1b2128);

    const hemi = new THREE.HemisphereLight(0xdfe8f2, 0x30353c, 0.6);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(150, 300, 250);
    this.scene.add(dir);

    this.stockMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.75, roughness: 0.32, side: THREE.DoubleSide, envMapIntensity: 1.1 });

    this.scene.add(this.spindle);
    this.spindle.add(this.chuckGroup);
    this.scene.add(this.toolGroup);

    // chips
    const chipGeo = new THREE.TorusGeometry(1.2, 0.28, 4, 8, Math.PI * 1.3);
    const chipMat = new THREE.MeshStandardMaterial({ color: 0x8a7a60, metalness: 0.8, roughness: 0.35 });
    this.chipMesh = new THREE.InstancedMesh(chipGeo, chipMat, 500);
    this.chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chipMesh.count = 0;
    this.scene.add(this.chipMesh);
    for (let i = 0; i < 500; i++) this.chips.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), life: 0, s: 1 });

    // coolant stream
    const N = 260;
    this.coolantPos = new Float32Array(N * 3);
    this.coolantT = new Float32Array(N);
    for (let i = 0; i < N; i++) this.coolantT[i] = Math.random();
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(this.coolantPos, 3));
    this.coolant = new THREE.Points(cg, new THREE.PointsMaterial({ color: 0x6fc3ff, size: 1.6, transparent: true, opacity: 0.7, depthWrite: false }));
    this.coolant.visible = false;
    this.coolant.frustumCulled = false;
    this.scene.add(this.coolant);

    this.buildMachine();
    this.view('iso');
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  setMachine(m: Machine) {
    this.machine = m;
    this.lastVersion = -1;
    this.toolKey = '';
    this.chuckGroupKey = '';
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

  private buildMachine() {
    // bed & headstock (static)
    const bedMat = new THREE.MeshStandardMaterial({ color: 0x3b4450, metalness: 0.3, roughness: 0.7 });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(900, 20, 260), bedMat);
    bed.position.set(-50, this.bedY - 10, -20);
    bed.name = 'bed';
    this.scene.add(bed);
    const way = new THREE.Mesh(new THREE.BoxGeometry(900, 8, 18), new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.8, roughness: 0.25 }));
    way.position.set(-50, this.bedY + 4, -100);
    this.scene.add(way);
    const way2 = way.clone();
    way2.position.z = 60;
    this.scene.add(way2);
  }

  private rebuildChuck() {
    const st = this.machine.stock;
    const key = `${st.radius}|${st.leftZ}|${st.def.gripLength}`;
    if (key === this.chuckGroupKey) return;
    this.chuckGroupKey = key;
    disposeTree(this.chuckGroup);
    this.chuckGroup.clear();
    const ch = chuckGeometry(st);
    const zl = st.leftZ;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(ch.chuckR, ch.chuckR, 70, 64).rotateZ(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x5d6670, metalness: 0.7, roughness: 0.35 }),
    );
    body.position.x = zl - 2 - 35;
    this.chuckGroup.add(body);
    const head = new THREE.Mesh(
      new THREE.CylinderGeometry(ch.chuckR * 1.15, ch.chuckR * 1.15, 120, 48).rotateZ(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x2c333b, metalness: 0.4, roughness: 0.6 }),
    );
    head.position.x = zl - 2 - 70 - 60;
    this.chuckGroup.add(head);
    const jawMat = new THREE.MeshStandardMaterial({ color: 0x8b949e, metalness: 0.8, roughness: 0.3 });
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI * 2) / 3;
      const jaw = new THREE.Group();
      const lower = new THREE.Mesh(new THREE.BoxGeometry(ch.grip + 2, ch.jawH, 16), jawMat);
      lower.position.set(zl - 2 + (ch.grip + 2) / 2, st.radius + ch.jawH / 2, 0);
      jaw.add(lower);
      const step = new THREE.Mesh(new THREE.BoxGeometry(14, ch.jawH * 0.6, 16), jawMat);
      step.position.set(zl - 2 + 7, st.radius + ch.jawH + ch.jawH * 0.3, 0);
      jaw.add(step);
      jaw.rotation.x = a;
      this.chuckGroup.add(jaw);
    }
  }

  setOps(ops: Op[]) {
    if (this.pathLines) {
      this.scene.remove(this.pathLines);
      this.pathLines.geometry.dispose();
    }
    const pos: number[] = [];
    const col: number[] = [];
    const cRapid = new THREE.Color(0xff5c5c), cFeed = new THREE.Color(0x4fb3ff), cArc = new THREE.Color(0x46d39a), cTh = new THREE.Color(0xc58bff);
    for (const o of ops) {
      if (o.kind !== 'move') continue;
      const pts = discretize(o, deg(5));
      const c = o.type === 'rapid' ? cRapid : o.type === 'arc' ? cArc : o.type === 'thread' ? cTh : cFeed;
      for (let i = 1; i < pts.length; i++) {
        pos.push(pts[i - 1].z, pts[i - 1].x, 0.2, pts[i].z, pts[i].x, 0.2);
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

  view(kind: 'iso' | 'front' | 'top' | 'back') {
    const st = this.machine.stock;
    // frame the part that sticks out of the jaws (plus a bit of the chuck)
    const free = st.def.length - st.def.gripLength;
    const cz = st.faceZ - free / 2 - 8;
    const d = Math.max(140, free * 2.1 + st.radius * 3.2);
    this.controls.target.set(cz, 0, 0);
    if (kind === 'iso') this.camera.position.set(cz + d * 0.35, d * 0.45, d * 0.8);
    if (kind === 'front') this.camera.position.set(cz, 0, d);
    if (kind === 'top') this.camera.position.set(cz, d, 0.01);
    if (kind === 'back') this.camera.position.set(cz - d * 0.3, d * 0.3, -d * 0.85);
    this.camera.up.set(0, 1, 0);
    this.controls.update();
  }

  private rebuildStock(now: number, force: boolean) {
    const st = this.machine.stock;
    const key = `${this.section}|${this.threads.length}`;
    if (!force && st.version === this.lastVersion && key === this.lastStockKey) return;
    if (!force && now - this.lastBuild < 90 && this.machine.status === 'running') return;
    this.lastVersion = st.version;
    this.lastStockKey = key;
    this.lastBuild = now;
    const mat = MATERIALS[st.def.material];
    const opts: RevolveOpts = {
      segments: 120,
      t0: this.section ? Math.PI / 2 : 0,
      t1: Math.PI * 2,
      rawR: st.radius,
      rawBore: st.boreR,
      faceZ: st.faceZ,
      leftZ: st.leftZ,
      colMachined: new THREE.Color(mat.color),
      colRaw: new THREE.Color(mat.raw),
      threads: this.threads,
    };
    const g = revolve(st.bodies(0.004), opts);
    if (this.stockMesh) {
      this.stockMesh.geometry.dispose();
      this.stockMesh.geometry = g;
    } else {
      this.stockMesh = new THREE.Mesh(g, this.stockMat);
      this.spindle.add(this.stockMesh);
    }
    // parted-off piece
    const dropped = st.droppedBodies(0.004);
    if (dropped.length && !this.droppedMesh) {
      const dg = revolve(dropped, { ...opts, t0: 0, t1: Math.PI * 2, threads: this.threads });
      this.droppedMesh = new THREE.Mesh(dg, this.stockMat);
      this.scene.add(this.droppedMesh);
      this.droppedAnim = { t: 0, y0: 0, active: true };
    } else if (!dropped.length && this.droppedMesh) {
      this.scene.remove(this.droppedMesh);
      this.droppedMesh.geometry.dispose();
      this.droppedMesh = null;
    }
  }

  private rebuildTool() {
    const m = this.machine;
    const sh = m.shape;
    const t = m.toolDef;
    const key = t ? JSON.stringify(t) : 'none';
    if (key === this.toolKey) return;
    this.toolKey = key;
    disposeTree(this.toolGroup);
    this.toolGroup.clear();
    if (!sh || !t) return;
    const insertMat = new THREE.MeshStandardMaterial({ color: t.type === 'drill' ? 0xb8bcc2 : 0xd4af37, metalness: 0.85, roughness: 0.3 });
    const holderMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.6, roughness: 0.45 });
    this.toolGroup.add(new THREE.Mesh(extrude(sh.cutter, sh.thickness), insertMat));
    for (const h of sh.holder) {
      const thick = t.type === 'groove' || t.type === 'partoff' ? Math.max(2.4, t.width - 0.4) : t.type === 'bore' || t.type === 'thread_id' || t.type === 'groove_id' ? t.width || 10 : 20;
      this.toolGroup.add(new THREE.Mesh(extrude(h, thick), holderMat));
    }
  }

  update(dt: number, now: number) {
    if (!this.visible) return;
    const m = this.machine;
    this.rebuildChuck();
    this.rebuildStock(now, false);
    this.rebuildTool();
    this.toolGroup.position.set(m.pos.z, m.pos.x, 0);
    if (this.pathLines) this.pathLines.visible = this.showPath;

    // spindle rotation (visual speed capped to avoid strobing)
    const rpm = m.status === 'running' || m.spindle.dir !== 'off' ? m.live.rpm : 0;
    const vis = Math.min(rpm, 240) / 60;
    const dirSign = m.spindle.dir === 'ccw' ? 1 : -1;
    if (!this.section) {
      this.angle += dirSign * vis * Math.PI * 2 * dt;
      this.spindle.rotation.x = this.angle;
    } else {
      this.spindle.rotation.x = 0;
    }

    const chips = this.updateChips(dt);
    this.updateCoolant(dt);
    this.updateDropped(dt);
    const moved = this.controls.update();
    // render only when the picture can have changed
    const sig = `${m.pos.x},${m.pos.z}|${m.stock.version}|${m.tool}|${m.status}|${this.showPath}|${this.section}|${this.renderer.domElement.width}x${this.renderer.domElement.height}`;
    const animating = (vis > 0 && !this.section) || chips > 0 || this.coolant.visible || this.droppedAnim.active;
    if (!moved && !animating && sig === this.lastSig && !this.forceRender) return;
    this.lastSig = sig;
    this.forceRender = false;
    this.renderer.render(this.scene, this.camera);
  }

  private spawnChip(at: THREE.Vector3) {
    const c = this.chips.find((p) => !p.alive);
    if (!c) return;
    c.alive = true;
    c.p.copy(at);
    c.v.set((Math.random() - 0.3) * 120, 120 + Math.random() * 160, (Math.random() - 0.5) * 220);
    c.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    c.w.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
    c.life = 4 + Math.random() * 3;
    c.s = 0.6 + Math.random() * 1.1;
  }

  private updateChips(dt: number) {
    const m = this.machine;
    const live = m.live;
    if (live.cutting && m.status === 'running' && live.mrr > 0.02) {
      const n = Math.min(8, Math.ceil(live.mrr * 0.6 * dt * 60));
      const sh = m.shape;
      const tip = new THREE.Vector3(m.pos.z + (sh?.noseCenter.z ?? 0), m.pos.x, 0);
      for (let i = 0; i < n; i++) this.spawnChip(tip);
    }
    const floor = this.bedY + 1;
    let k = 0;
    for (const c of this.chips) {
      if (!c.alive) continue;
      c.life -= dt;
      if (c.life <= 0) {
        c.alive = false;
        continue;
      }
      if (c.p.y > floor) {
        c.v.y -= 1800 * dt;
        c.p.addScaledVector(c.v, dt);
        c.r.x += c.w.x * dt;
        c.r.y += c.w.y * dt;
        c.r.z += c.w.z * dt;
      } else {
        c.p.y = floor;
      }
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
    const tip = new THREE.Vector3(m.pos.z + 2, m.pos.x + 1, 0);
    const nozzle = new THREE.Vector3(m.pos.z + 45, m.pos.x + 70, 30);
    const N = this.coolantT.length;
    for (let i = 0; i < N; i++) {
      let t = this.coolantT[i] + dt * 2.2;
      if (t > 1) t -= 1;
      this.coolantT[i] = t;
      const j = (i * 7919) % 100 / 100 - 0.5;
      this.coolantPos[i * 3] = nozzle.x + (tip.x - nozzle.x) * t + j * 3 * t;
      this.coolantPos[i * 3 + 1] = nozzle.y + (tip.y - nozzle.y) * t - 12 * t * t + j * 2 * t;
      this.coolantPos[i * 3 + 2] = nozzle.z + (tip.z - nozzle.z) * t + ((i * 31) % 100 / 100 - 0.5) * 4 * t;
    }
    (this.coolant.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateDropped(dt: number) {
    if (!this.droppedMesh || !this.droppedAnim.active) return;
    const a = this.droppedAnim;
    a.t += dt;
    const target = this.bedY + this.machine.stock.radius - 2;
    const y = Math.max(target, -0.5 * 900 * a.t * a.t);
    this.droppedMesh.position.set(18 * Math.min(1, a.t * 2), y, 40 * Math.min(1, a.t));
    this.droppedMesh.rotation.x = a.t * 2;
    if (y <= target) a.active = false;
  }

  /** force a rebuild (stock reset, theme, section toggle…) */
  refresh() {
    this.forceRender = true;
    this.lastVersion = -1;
    if (this.droppedMesh && !this.machine.stock.dropped) {
      this.scene.remove(this.droppedMesh);
      this.droppedMesh.geometry.dispose(); // material = shared stockMat
      this.droppedMesh = null;
    }
    this.rebuildStock(performance.now(), true);
  }

  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
