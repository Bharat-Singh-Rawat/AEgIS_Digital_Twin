/* AEgIS Twin - 3D event display (Three.js)
 * Scene axes: X = beam axis z (CST frame), Y = physics y, Z = physics x.  Units: mm.
 */
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { RoomEnvironment } from "./vendor/RoomEnvironment.js";
import { CSS2DRenderer, CSS2DObject } from "./vendor/CSS2DRenderer.js";

export const SPECIES = [
  { key: "pbar", label: "p̄", name: "antiproton", match: (p) => p === -2212, color: "#ff375f", op: 1.0, on: true },
  { key: "pion", label: "π±", name: "charged pions", match: (p) => Math.abs(p) === 211, color: "#ff9f0a", op: 0.95, on: true },
  { key: "gamma", label: "γ", name: "photons", match: (p) => p === 22, color: "#ffd60a", op: 0.28, on: true },
  { key: "em", label: "e⁻", name: "electrons", match: (p) => p === 11, color: "#64d2ff", op: 0.3, on: true },
  { key: "ep", label: "e⁺", name: "positrons", match: (p) => p === -11, color: "#bf5af2", op: 0.7, on: true },
  { key: "mu", label: "μ±", name: "muons", match: (p) => Math.abs(p) === 13, color: "#30d158", op: 0.95, on: true },
  { key: "p", label: "p", name: "protons", match: (p) => p === 2212, color: "#ff6961", op: 0.9, on: true },
  { key: "n", label: "n", name: "neutrons", match: (p) => p === 2112, color: "#aeaeb2", op: 0.25, on: false },
  { key: "A", label: "A", name: "nuclear fragments", match: (p) => p > 1e9, color: "#ffffff", op: 0.9, on: true },
  { key: "nu", label: "ν", name: "neutrinos", match: (p) => [12, -12, 14, -14, 16, -16].includes(p), color: "#5e5ce6", op: 0.2, on: false },
  { key: "x", label: "…", name: "other", match: () => true, color: "#8e8e93", op: 0.5, on: true },
];
export const PDG_NAME = { "-2212": "antiproton", 2212: "proton", 2112: "neutron", 22: "photon", 11: "electron", "-11": "positron",
  211: "π⁺", "-211": "π⁻", 111: "π⁰", 13: "μ⁻", "-13": "μ⁺", 12: "νe", "-12": "ν̄e", 14: "νμ", "-14": "ν̄μ", 321: "K⁺", "-321": "K⁻", 130: "K⁰L", 310: "K⁰S" };
export const STORY = [
  { key: "line", name: "Transfer line", dur: 7 },
  { key: "mag", name: "Magnets", dur: 5.5 },
  { key: "el", name: "Electrodes", dur: 4.5 },
  { key: "tr", name: "Transport", dur: 11 },
];
const GROUP_COL = { C: "#8e9aaf", HV: "#e0b24a", P: "#5ac8a8", T: "#4fb3d9", B: "#5e8fff", A: "#b07cf0" };

const toScene = (x, y, z) => [z, y, x];
const CRYO_COL = { LHe: "#5ac8fa", LN2: "#7d7aff" };
// pulsed electrode factor 0..1 (same waveform as twin/pulse.py: linear close over `rise`, optional reopening)
export const pulseFactor = (p, t) => {
  if (!Number.isFinite(t)) return t > 0 ? (p.open > 0 ? 0 : 1) : 0;
  let f = Math.min(Math.max((t - p.t0) / p.rise, 0), 1);
  if (p.open > 0) f *= 1 - Math.min(Math.max((t - p.open) / p.rise, 0), 1);
  return f;
};
// area of a disc of radius R lying below the horizontal line y = h
const discBelow = (R, h) => (h <= -R ? 0 : h >= R ? Math.PI * R * R : R * R * Math.acos(-h / R) + h * Math.sqrt(R * R - h * h));

function tubeGeom(ri, ro, z0, z1, phi0 = 0, phi1 = 360, seg = 48) {
  const s = new THREE.Shape();
  const a0 = (phi0 * Math.PI) / 180, a1 = (phi1 * Math.PI) / 180;
  if (phi1 - phi0 >= 360) {
    s.absarc(0, 0, ro, 0, 2 * Math.PI, false);
    const h = new THREE.Path(); h.absarc(0, 0, ri, 0, 2 * Math.PI, true); s.holes.push(h);
  } else {
    s.moveTo(ro * Math.cos(a0), ro * Math.sin(a0));
    s.absarc(0, 0, ro, a0, a1, false);
    s.lineTo(ri * Math.cos(a1), ri * Math.sin(a1));
    s.absarc(0, 0, ri, a1, a0, true);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(z1 - z0, 0.01), bevelEnabled: false, curveSegments: seg });
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, z0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  g.computeVertexNormals();
  return g;
}

function lineMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 1e9 }, uEvent: { value: -1 }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uSpan: { value: 5 } },
    vertexShader: `attribute float time; attribute float ev; varying float vT; varying float vE;
      void main(){ vT = time; vE = ev; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uTime; uniform float uEvent; uniform vec3 uColor; uniform float uOpacity; uniform float uSpan;
      varying float vT; varying float vE;
      void main(){
        if (vT > uTime) discard;
        if (uEvent >= 0.0 && abs(vE - uEvent) > 0.5) discard;
        float head = 1.0 - clamp((uTime - vT) / uSpan, 0.0, 1.0);
        gl_FragColor = vec4(uColor * (1.0 + 1.8 * head), clamp(uOpacity + 0.7 * head, 0.0, 1.0));
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
function pointMaterial(color, size) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 1e9 }, uEvent: { value: -1 }, uColor: { value: new THREE.Color(color) }, uSize: { value: size }, uSpan: { value: 5 } },
    vertexShader: `attribute float time; attribute float ev; varying float vT; varying float vE; varying float vFlash;
      uniform float uSize; uniform float uTime; uniform float uSpan;
      void main(){ vT = time; vE = ev; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFlash = 1.0 - clamp((uTime - time) / (uSpan * 3.0), 0.0, 1.0);
        gl_PointSize = uSize * (1.0 + 2.5 * vFlash) * (900.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uTime; uniform float uEvent; uniform vec3 uColor; varying float vT; varying float vE; varying float vFlash;
      void main(){ if (vT > uTime) discard; if (uEvent >= 0.0 && abs(vE - uEvent) > 0.5) discard;
        float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(uColor * (1.0 + vFlash), a * (0.75 + 0.25 * vFlash)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

export class EventDisplay {
  constructor(host, hooks = {}) {
    this.host = host; this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.localClippingEnabled = true; this.cryo = {}; this.cryoFill = {};
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer(); this.labels.domElement.className = "labels3d"; host.appendChild(this.labels.domElement);
    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x202024, 0.6));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.4); d1.position.set(800, 1500, 1200); this.scene.add(d1);
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 50000);
    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.layers = { line: new THREE.Group(), field: new THREE.Group(), bmap: new THREE.Group(), pot: new THREE.Group(), bunch: new THREE.Group(), electrodes: new THREE.Group(), coils: new THREE.Group(), cryo: new THREE.Group(), ovc: new THREE.Group(), scint: new THREE.Group(), labels: new THREE.Group(), tracks: new THREE.Group(), marks: new THREE.Group(), axis: new THREE.Group() };
    Object.values(this.layers).forEach((g) => this.world.add(g));
    this.opts = { cutaway: true, colorByVoltage: false, radial: 1 };
    this.time = { u: 1, playing: false, speed: 1, duration: 9, sorted: [0, 1] };
    this.event = -1; this.species = SPECIES.map((s) => ({ ...s }));
    this.raycaster = new THREE.Raycaster();
    this.story = { on: false, u: 1, playing: false, auto: true };
    this.zDel = -1073; this.bunchInit = [];
    this.controls.addEventListener("start", () => { if (this.story.playing) this.story.auto = false; });
    this.dotTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
      const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.25, "rgba(255,255,255,.85)"); r.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    this.labels.domElement.addEventListener("pointerdown", (e) => (this._down = [e.clientX, e.clientY]));
    this.labels.domElement.addEventListener("pointerup", (e) => {
      if (this._down && Math.hypot(e.clientX - this._down[0], e.clientY - this._down[1]) < 4) this.pick(e);
    });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize(); this.setView("iso");
    this._last = performance.now();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h); this.labels.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  /* ---------------- detector geometry ---------------- */
  setGeometry(geo, voltages = {}) {
    this.geo = geo; this.voltages = voltages; this.buildGeometry();
  }
  setVoltages(v) { this.voltages = v || {}; this.recolorElectrodes(); }
  buildGeometry() {
    const geo = this.geo; if (!geo) return;
    for (const k of ["electrodes", "coils", "cryo", "ovc", "scint", "labels", "axis"]) this.layers[k].clear();
    this.cryo = {};
    const cut = this.opts.cutaway ? [90, 270] : [0, 360];
    this.elMeshes = [];
    for (const e of geo.electrodes) {
      const m = new THREE.Mesh(tubeGeom(e.ri, e.ro, e.z0, e.z1, ...cut, 40),
        new THREE.MeshStandardMaterial({ color: GROUP_COL[e.group] || "#999", metalness: 0.85, roughness: 0.28, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false }));
      m.userData = { kind: "electrode", ...e }; this.layers.electrodes.add(m); this.elMeshes.push(m);
    }
    this.recolorElectrodes();
    for (const c of geo.coils) {
      const m = new THREE.Mesh(tubeGeom(c.ri, c.ro, c.z0, Math.max(c.z1, c.z0 + 3), ...cut, 64),
        new THREE.MeshStandardMaterial({ color: c.main ? "#d9884f" : "#c06a3a", metalness: 0.6, roughness: 0.4, transparent: true, opacity: c.main ? 0.13 : 0.22, side: THREE.DoubleSide, depthWrite: false }));
      m.userData = { kind: "coil", ...c }; this.layers.coils.add(m);
    }
    // cryogen vessels: stainless skin + the liquid inside (LHe bath around the coils, LN2 jacket in the bore)
    for (const v of geo.cryo || []) {
      const col = CRYO_COL[v.cryogen] || "#8e8e93", w = v.wall;
      const mli = new THREE.MeshStandardMaterial({ color: "#d4a94a", metalness: 0.95, roughness: 0.45, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
      const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);   // keeps y <= level: the liquid settles under gravity
      const liquid = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.35, metalness: 0, roughness: 0.15, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: [plane] });
      const surfMat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.6, metalness: 0, roughness: 0.1, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
      const surf = new THREE.Group(); surf.userData = { kind: "cryo", ...v }; this.layers.cryo.add(surf);
      const steel = new THREE.MeshStandardMaterial({ color: "#c7c7cc", metalness: 0.9, roughness: 0.3, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
      const bath = v.segments.filter((g) => !g.yc);
      v.segments.forEach((g) => {
        const k = bath.indexOf(g), off = !!g.yc;
        // bath segments share end caps only at the ends of the chain; an off-axis reservoir is closed at both ends
        const first = off || k === 0, last = off || k === bath.length - 1, liqRi = g.ri ? g.ri + w : 0;
        const parts = [[liquid, liqRi, g.ro - w, g.z0 + (first ? w : 0), g.z1 - (last ? w : 0)], [steel, g.ro - w, g.ro, g.z0, g.z1]];
        if (g.ri) parts.push([steel, g.ri, g.ri + w, g.z0, g.z1]);
        if (v.mli) parts.push([mli, g.ro, g.ro + v.mli, g.z0, g.z1]);
        if (first) parts.push([steel, g.ri, g.ro, g.z0, g.z0 + w]);
        if (last) parts.push([steel, g.ri, g.ro, g.z1 - w, g.z1]);
        const prev = !off && bath[k - 1];
        if (prev && prev.ro !== g.ro) parts.push([steel, Math.min(prev.ro, g.ro) - w, Math.max(prev.ro, g.ro), g.z0 - w / 2, g.z0 + w / 2]);
        for (const [mat, ri, ro, z0, z1] of parts) {
          const m = new THREE.Mesh(tubeGeom(Math.max(ri, 0.001), ro, z0, z1, ...cut, 64), mat);
          m.position.y = g.yc || 0; m.userData = { kind: "cryo", ...v }; this.layers.cryo.add(m);
        }
        if (off) {       // neck joining the reservoir to the bath below it
          const b = bath.find((q) => q.z0 <= (g.z0 + g.z1) / 2 && q.z1 >= (g.z0 + g.z1) / 2) || bath[0];
          const y0 = b.ro - w, y1 = g.yc - g.ro + w, zc = (g.z0 + g.z1) / 2;
          const neck = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, y1 - y0, 24, 1, true), steel);
          neck.position.set(zc, (y0 + y1) / 2, 0); neck.userData = { kind: "cryo", ...v }; this.layers.cryo.add(neck);
        }
      });
      const s0 = v.segments[0], zEnd = v.segments[v.segments.length - 1].z1;
      const lbl = this.addLabel("",
        toScene(0, -(s0.ro + (v.mli || 0) + 26), (s0.z0 + zEnd) / 2 + (v.cryogen === "LHe" ? 0 : 250)), `lbl cryo ${v.cryogen.toLowerCase()}`);
      this.cryo[v.id] = { v, plane, surf, surfMat, lbl, cap: this.cryoLitres(v, Infinity) };
      this.setCryoFill(v.id, this.cryoFill[v.id] ?? 1);
    }
    // outer vacuum vessel: cylindrical cans joined by flanges, end plates with beam apertures
    if (geo.ovc) {
      const o = geo.ovc, ri = o.ro - o.wall, [fdr, fdz] = o.flange;
      const skin = new THREE.MeshStandardMaterial({ color: "#aeb4bc", metalness: 0.85, roughness: 0.35, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
      const rim = new THREE.MeshStandardMaterial({ color: "#d1d5db", metalness: 0.9, roughness: 0.25, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
      const parts = [[skin, ri, o.ro, o.z0, o.z1], [rim, o.apertures[0], o.ro + fdr, o.z0, o.z0 + o.end], [rim, o.apertures[1], o.ro + fdr, o.z1 - o.end, o.z1]];
      o.cans.slice(1).forEach((c) => parts.push([rim, o.ro, o.ro + fdr, c.z0 - fdz, c.z0 + fdz]));
      for (const [mat, a, b, z0, z1] of parts) {
        const m = new THREE.Mesh(tubeGeom(a, b, z0, z1, ...cut, 96), mat);
        m.userData = { kind: "ovc", ...o }; this.layers.ovc.add(m);
      }
      this.addLabel("Outer vacuum vessel · 293 K · ~1e-7 mbar", toScene(0, -(o.ro + 60), (o.z0 + o.z1) / 2), "lbl ovc");
    }
    this.scMeshes = {};
    for (const s of geo.scintillators) {
      const m = new THREE.Mesh(tubeGeom(s.ri, s.ro, s.z0, s.z1, s.phi0, s.phi1, 48),
        new THREE.MeshStandardMaterial({ color: "#30d158", emissive: "#30d158", emissiveIntensity: 0.0, metalness: 0.1, roughness: 0.6, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
      m.userData = { kind: "scintillator", ...s, flash: 0 }; this.layers.scint.add(m); this.scMeshes[s.id] = m;
      const mid = ((s.phi0 + s.phi1) / 2) * Math.PI / 180;
      this.addLabel(s.id, toScene(s.ro * Math.cos(mid) * 1.06, s.ro * Math.sin(mid) * 1.06, (s.z0 + s.z1) / 2), "lbl sc");
    }
    const foil = new THREE.Mesh(new THREE.CircleGeometry(geo.foil.r, 48), new THREE.MeshStandardMaterial({ color: "#f5f5f7", metalness: 0.9, roughness: 0.15, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
    foil.rotation.y = Math.PI / 2; foil.position.set(geo.foil.z, 0, 0); this.layers.electrodes.add(foil);
    // labels: electrode groups, magnets
    const groups = {};
    geo.electrodes.forEach((e) => { (groups[e.group] ||= []).push(e); });
    for (const [g, es] of Object.entries(groups)) {
      if (g === "HV") { es.forEach((e) => this.addLabel(e.id, toScene(0, 34, (e.z0 + e.z1) / 2), "lbl hv")); continue; }
      const z0 = Math.min(...es.map((e) => e.z0)), z1 = Math.max(...es.map((e) => e.z1));
      this.addLabel(`${g} electrodes`, toScene(0, 40, (z0 + z1) / 2), "lbl grp");
    }
    geo.coils.filter((c) => c.main).forEach((c) => this.addLabel(c.cst === "Coil_11" ? "5 T solenoid" : "1 T solenoid", toScene(0, c.ro + 40, (c.z0 + c.z1) / 2), "lbl mag"));
    this.addLabel("degrader foil", toScene(0, -40, geo.foil.z), "lbl foil");
    // beam axis + ticks
    const zmin = -1700, zmax = 2600;
    const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(zmin, 0, 0), new THREE.Vector3(zmax, 0, 0)]),
      new THREE.LineDashedMaterial({ color: 0x8e8e93, dashSize: 10, gapSize: 8, transparent: true, opacity: 0.5 }));
    axis.computeLineDistances(); this.layers.axis.add(axis);
    for (let z = -1500; z <= 2500; z += 500) {
      const el = document.createElement("div"); el.className = "lbl tick"; el.textContent = `z ${z}`;
      const o = new CSS2DObject(el); o.position.set(z, -260, 0); this.layers.axis.add(o);
    }
    this.applyRadial();
    this.buildTransferLine();
    this.setStory(this.story.u, true);
  }
  /* ---------------- cryogen fill levels ---------------- */
  // litres of liquid below height h (liquid space inside the walls, minus the coils standing in the bath)
  cryoLitres(v, h) {
    const w = v.wall; let mm3 = 0;
    for (const g of v.segments) {
      const z0 = g.z0 + w, z1 = g.z1 - w, ri = g.ri ? g.ri + w : 0, ro = g.ro - w, y = h - (g.yc || 0);
      mm3 += (z1 - z0) * (discBelow(ro, y) - (ri ? discBelow(ri, y) : 0));
      if (v.cryogen === "LHe" && !g.yc) for (const c of this.geo.coils) {
        const a = Math.max(c.z0, z0), b = Math.min(c.z1, z1), r0 = Math.max(c.ri, ri), r1 = Math.min(c.ro, ro);
        if (b > a && r1 > r0) mm3 -= (b - a) * (discBelow(r1, h) - discBelow(r0, h));
      }
    }
    return mm3 * 1e-6;
  }
  placeCryoPlane(c) { c.plane.constant = Number.isFinite(c.h) ? c.h * this.opts.radial : c.h > 0 ? 1e6 : -1e6; }
  // f = fill fraction 0..1 -> liquid level, clip plane, free-surface strips and label; returns the state
  setCryoFill(id, f) {
    const c = this.cryo[id]; if (!c) return null;
    f = Math.min(1, Math.max(0, f)); this.cryoFill[id] = f;
    const v = c.v, w = v.wall;
    if (f >= 0.999) c.h = Infinity; else if (f <= 0.001) c.h = -Infinity;
    else { let lo = Math.min(...v.segments.map((g) => (g.yc || 0) - g.ro)), hi = Math.max(...v.segments.map((g) => (g.yc || 0) + g.ro)); for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; (this.cryoLitres(v, m) < f * c.cap ? (lo = m) : (hi = m)); } c.h = (lo + hi) / 2; }
    c.litres = f * c.cap; this.placeCryoPlane(c);
    // free surface: the horizontal cut through the annulus at y = h (only the kept half in cutaway)
    c.surf.children.forEach((m) => m.geometry.dispose()); c.surf.clear();
    if (Number.isFinite(c.h)) for (const g of v.segments) {
      const ri = g.ri ? g.ri + w : 0, ro = g.ro - w, h = c.h - (g.yc || 0); if (Math.abs(h) >= ro) continue;
      const a = Math.sqrt(ro * ro - h * h), b = Math.abs(h) < ri ? Math.sqrt(ri * ri - h * h) : 0;
      let strips = b ? [[-a, -b], [b, a]] : [[-a, a]];
      if (this.opts.cutaway) strips = strips.map(([x0, x1]) => [x0, Math.min(x1, 0)]).filter(([x0, x1]) => x1 > x0);
      for (const [x0, x1] of strips) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute([g.z0 + w, c.h, x0, g.z1 - w, c.h, x0, g.z1 - w, c.h, x1, g.z0 + w, c.h, x1], 3));
        geo.setIndex([0, 1, 2, 0, 2, 3]); geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, c.surfMat); m.userData = c.surf.userData; c.surf.add(m);
      }
    }
    c.lbl.element.textContent = `${v.cryogen === "LHe" ? "LHe" : "LN₂"} ${v.T} K · ${Math.round(c.litres)} / ${Math.round(c.cap)} L`;
    return this.cryoState(id);
  }
  cryoState(id) { const c = this.cryo[id]; return c && { id, fill: this.cryoFill[id] ?? 1, litres: c.litres, capacity: c.cap, level: c.h }; }
  addLabel(text, pos, cls) {
    const el = document.createElement("div"); el.className = cls; el.textContent = text;
    const o = new CSS2DObject(el); o.position.set(...pos); this.layers.labels.add(o); return o;
  }
  recolorElectrodes() {
    if (!this.elMeshes) return;
    const vs = this.elMeshes.map((m) => Math.abs(this.voltages[m.userData.id] ?? 0));
    const vmax = Math.max(1, ...vs);
    for (const m of this.elMeshes) {
      const e = m.userData;
      if (this.opts.colorByVoltage) {
        const v = this.voltages[e.id] ?? 0, a = Math.min(1, Math.abs(v) / vmax);
        m.material.color.set(v < 0 ? "#0a84ff" : v > 0 ? "#ff453a" : "#8e8e93").lerp(new THREE.Color("#8e8e93"), 1 - (0.25 + 0.75 * a) * (v ? 1 : 0));
      } else m.material.color.set(GROUP_COL[e.group] || "#999");
    }
  }
  setOption(k, v) {
    this.opts[k] = v;
    if (k === "cutaway") { this.buildGeometry(); this.buildTransferLine(); if (this.story.on) this.setStory(this.story.u, true); }
    if (k === "colorByVoltage") this.recolorElectrodes();
    if (k === "radial") this.applyRadial();
  }
  applyRadial() { const k = this.opts.radial; this.world.scale.set(1, k, k); Object.values(this.cryo).forEach((c) => this.placeCryoPlane(c)); }
  setLayer(k, on) { this.layers[k].visible = on;  if (k === "labels") this.labels.domElement.classList.toggle("hide-labels", !on); }

  /* ---------------- tracks ---------------- */
  setTracks(data) {
    this.layers.tracks.clear(); this.layers.marks.clear(); this.trackObjs = []; this.beadObjs = [];
    this.data = data;
    if (!data || !data.available) { this.updateTimeIndex(); return; }
    const per = this.species.map(() => ({ pos: [], time: [], ev: [], seg: [] }));
    let off = 0;
    this.trackInfo = data.meta.map(([ev, trk, par, pdg, n, p0], i) => {
      const si = this.species.findIndex((s) => s.match(pdg));
      const b = per[si];
      const t0 = data.t[off], t1 = data.t[off + n - 1];
      let L = 0;
      for (let k = 0; k < n - 1; k++) {
        const a = off + k, c = a + 1;
        b.pos.push(...toScene(data.x[a], data.y[a], data.z[a]), ...toScene(data.x[c], data.y[c], data.z[c]));
        b.time.push(data.t[a], data.t[c]); b.ev.push(ev, ev); b.seg.push(i);
        L += Math.hypot(data.x[c] - data.x[a], data.y[c] - data.y[a], data.z[c] - data.z[a]);
      }
      const info = { ev, trk, par, pdg, n, p0, si, t0, t1, L, start: [data.x[off], data.y[off], data.z[off]], end: [data.x[off + n - 1], data.y[off + n - 1], data.z[off + n - 1]] };
      off += n; return info;
    });
    this.species.forEach((s, i) => {
      const b = per[i]; s.count = new Set(b.seg).size; s.obj = null;
      if (!b.pos.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute("time", new THREE.Float32BufferAttribute(b.time, 1));
      g.setAttribute("ev", new THREE.Float32BufferAttribute(b.ev, 1));
      const o = new THREE.LineSegments(g, lineMaterial(s.color, s.op));
      o.userData = { species: i, seg: b.seg }; o.visible = s.on; o.frustumCulled = false; o.renderOrder = 5;
      this.layers.tracks.add(o); s.obj = o; this.trackObjs.push(o);
      if (s.key === "pbar") {          // thin 1-px lines are easy to miss: add a glowing beaded trail
        const beads = new THREE.Points(g, pointMaterial(s.color, 3.2));
        beads.frustumCulled = false; beads.renderOrder = 6; o.add(beads); this.beadObjs = [beads];
      }
    });
    // annihilation vertices
    const v = data.vertices;
    if (v.z.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(v.z.flatMap((z, i) => toScene(v.x[i], v.y[i], z)), 3));
      g.setAttribute("time", new THREE.Float32BufferAttribute(v.t, 1));
      g.setAttribute("ev", new THREE.Float32BufferAttribute(v.ev, 1));
      this.vertexPts = new THREE.Points(g, pointMaterial("#ff2d55", 9)); this.vertexPts.frustumCulled = false; this.vertexPts.renderOrder = 6;
      this.layers.marks.add(this.vertexPts);
    }
    // scintillator hits
    const h = data.hits;
    if (h.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(h.flatMap((r) => toScene(r[1], r[2], r[3])), 3));
      g.setAttribute("time", new THREE.Float32BufferAttribute(h.map((r) => r[4]), 1));
      g.setAttribute("ev", new THREE.Float32BufferAttribute(h.map((r) => r[5]), 1));
      this.hitPts = new THREE.Points(g, pointMaterial("#30d158", 12)); this.hitPts.frustumCulled = false;
      this.layers.marks.add(this.hitPts);
    }
    this.trapPts = null;
    const tr = data.trapped;
    if (tr && tr.n) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(tr.z.flatMap((z, i) => toScene(tr.x[i], tr.y[i], z)), 3));
      g.setAttribute("time", new THREE.Float32BufferAttribute(tr.t, 1));
      g.setAttribute("ev", new THREE.Float32BufferAttribute(tr.ev, 1));
      this.trapPts = new THREE.Points(g, pointMaterial("#64d2ff", 10)); this.trapPts.frustumCulled = false; this.trapPts.renderOrder = 6;
      this.layers.marks.add(this.trapPts);
    }
    this.pulses = data.pulses || [];
    const prim = this.trackInfo.filter((t) => t.pdg === -2212 && t.par === 0);
    if (prim.length) this.zDel = prim.reduce((a, t) => a + t.start[2], 0) / prim.length;
    this.bunchInit = prim.map((t, i) => ({ x: t.start[0], y: t.start[1], ev: t.ev, dz: 260 * Math.sin(i * 12.9898) * Math.cos(i * 4.1414), ph: (i * 0.618) % 1 }));
    this.buildTransferLine(); this.buildBunch();
    this.updateTimeIndex();
    if (this.story.on) this.setStory(this.story.u);
  }
  setSpecies(i, on) { this.species[i].on = on; if (this.species[i].obj) this.species[i].obj.visible = on; }
  setEvent(ev) { this.event = ev; this.updateTimeIndex(); }
  updateTimeIndex() {
    // time warping: playback position u maps to the quantile of all step times (busy periods get more screen time)
    const d = this.data; let ts = [];
    if (d && d.available) {
      let off = 0;
      for (const [ev, , , , n] of d.meta) { if (this.event < 0 || ev === this.event) for (let k = 0; k < n; k++) ts.push(d.t[off + k]); off += n; }
    }
    if (!ts.length) ts = [0, 1];
    ts.sort((a, b) => a - b);
    const step = Math.max(1, Math.floor(ts.length / 4000));
    this.time.sorted = ts.filter((_, i) => i % step === 0).concat([ts[ts.length - 1]]);
    this.applyTime();
  }
  tAt(u) { const s = this.time.sorted; const x = Math.min(Math.max(u, 0), 1) * (s.length - 1); const i = Math.floor(x); return s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (x - i); }
  setU(u) { this.time.u = Math.min(Math.max(u, 0), 1); this.applyTime(); }
  applyTime() {
    const t = this.time.u >= 0.9999 ? 1e9 : this.tAt(this.time.u);
    const span = Math.max(0.05, this.tAt(Math.min(1, this.time.u + 0.004)) - this.tAt(Math.max(0, this.time.u - 0.03)));
    const set = (mat) => { mat.uniforms.uTime.value = t; mat.uniforms.uEvent.value = this.event; mat.uniforms.uSpan.value = this.time.u >= 0.9999 ? 1e-6 : span; };
    this.trackObjs?.forEach((o) => set(o.material));
    this.beadObjs?.forEach((o) => set(o.material));
    if (this.vertexPts) set(this.vertexPts.material);
    if (this.hitPts) set(this.hitPts.material);
    if (this.trapPts) set(this.trapPts.material);
    // pulsed electrodes glow cyan once closed
    if (this.pulses?.length && this.elMeshes && !(this.story.on && this.storyLocate(this.story.u).i < 3)) for (const p of this.pulses) {
      const m = this.elMeshes.find((q) => q.userData.id === p.id); if (!m) continue;
      const closed = t >= p.t0 && !(p.open > 0 && t >= p.open && t < 1e9);
      m.material.emissive.set("#64d2ff"); m.material.emissiveIntensity = closed ? 2.4 : 0;
    }
    // flash scintillator panels whose hits just happened
    if (this.data?.hits && this.scMeshes) {
      const win = span * 3;
      for (const m of Object.values(this.scMeshes)) m.userData.flash = 0;
      for (const r of this.data.hits) {
        if (this.event >= 0 && r[5] !== this.event) continue;
        const dt = t - r[4];
        if (dt >= 0 && dt < win && this.scMeshes[r[0]]) this.scMeshes[r[0]].userData.flash = Math.max(this.scMeshes[r[0]].userData.flash, 1 - dt / win);
      }
    }
    if (!(this.story.on && this.storyLocate(this.story.u).i < 3)) this.updatePotential(t >= 1e9 ? Infinity : t);
    // detector hits / annihilations crossed since the last frame (sound)
    const live = this.time.playing || this.story.playing;
    if (live && this.hooks.onHits && this._tPrev != null && t > this._tPrev && t < 1e9 && this.data) {
      const a = this._tPrev, inEv = (ev) => this.event < 0 || ev === this.event;
      const hits = (this.data.hits || []).filter((r) => r[4] > a && r[4] <= t && inEv(r[5]));
      const v = this.data.vertices, anns = [];
      if (v?.t) for (let i = 0; i < v.t.length; i++) if (v.t[i] > a && v.t[i] <= t && inEv(v.ev[i])) anns.push({ z: v.z[i], t: v.t[i], ev: v.ev[i] });
      if (hits.length || anns.length) this.hooks.onHits(hits, anns);
    }
    this._tPrev = t < 1e9 ? t : null;
    this.hooks.onTime?.(this.time.u, t >= 1e9 ? this.time.sorted[this.time.sorted.length - 1] : t);
  }
  play(on = !this.time.playing) { this.time.playing = on; if (on && this.time.u >= 0.999) this.setU(0); this.hooks.onPlay?.(on); }

  /* ---------------- magnet quench (display scenario) ---------------- */
  // q: { id, coils: [ids], z0, z1, vessel, boilFill (fraction of the vessel to evaporate), onField(fB) }
  startQuench(q) {
    this.stopQuench(true);
    const c = this.cryo[q.vessel], o = this.geo.ovc;
    this.quench = { ...q, s: 0, f0: this.cryoFill[q.vessel] ?? 1, fieldLast: 1 };
    const mk = (n, color, size) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size, map: this.dotTex, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
      pts.frustumCulled = false; pts.userData.p = Array.from({ length: n }, () => ({ life: -Math.random() })); this.layers.cryo.add(pts); return pts; };
    this.quench.bubbles = c ? mk(700, "#dff6ff", 7) : null;
    this.quench.vent = o ? mk(500, "#ffffff", 26) : null;
    this.quench.seg = c?.v.segments[0]; this.quench.ventZ = (q.z0 + q.z1) / 2; this.quench.ventY = o ? o.ro + 30 : 720;
  }
  stopQuench(silent) {
    const q = this.quench; if (!q) return;
    [q.bubbles, q.vent].forEach((p) => { if (p) { this.layers.cryo.remove(p); p.geometry.dispose(); } });
    this.layers.coils.children.forEach((m) => { if (q.coils.includes(m.userData.id)) { m.material.emissiveIntensity = 0; } });
    if (this.mapMats?.B) this.mapMats.B.uniforms.uQ.value.set(0, 0, 1);
    this.quench = null; if (!silent) q.onField?.(1, true);
  }
  tickQuench(dt) {
    const q = this.quench; if (!q) return;
    q.s += dt; const s = q.s;
    const fB = Math.exp(-s / 1.1);                                   // current decays into the dump / normal zone
    const boil = Math.exp(-s / 3.5);                                  // violent boiling, then it calms down
    this.layers.coils.children.forEach((m) => { if (!q.coils.includes(m.userData.id)) return;
      m.material.emissive.set("#ff3b30"); m.material.emissiveIntensity = 0.35 + 2.6 * Math.exp(-s / 1.6) * (0.65 + 0.35 * Math.sin(s * 22)); });
    if (this.mapMats?.B) this.mapMats.B.uniforms.uQ.value.set(q.z0, q.z1, fB);
    if (Math.abs(q.fieldLast - fB) > 0.02 || (fB < 0.02 && q.fieldLast >= 0.02)) { q.fieldLast = fB; q.onField?.(fB); }
    const f = Math.max(0, q.f0 - q.boilFill * (1 - Math.exp(-s / 2.2)));
    if (Math.abs((this.cryoFill[q.vessel] ?? 1) - f) > 0.002) { this.setCryoFill(q.vessel, f); q.onLevel?.(f); }
    const lvl = this.cryo[q.vessel]?.h ?? -1e9;
    // bubbles rising through the helium annulus, popping at the surface
    if (q.bubbles && q.seg) {
      const g = q.seg, pos = q.bubbles.geometry.attributes.position, ri = g.ri + 6, ro = g.ro - 6;
      q.bubbles.userData.p.forEach((b, i) => {
        b.life -= dt;
        if (b.life <= 0 || b.y > Math.min(lvl, ro)) {
          if (Math.random() > boil * 1.2 || lvl < -ro + 5) { pos.setXYZ(i, 0, -1e5, 0); b.life = 0.1 + Math.random() * 0.4; b.y = -1e5; return; }
          const r = ri + Math.random() * (ro - ri), a = Math.PI + (this.opts.cutaway ? Math.random() * Math.PI : Math.random() * 2 * Math.PI) - (this.opts.cutaway ? Math.PI / 2 : 0);
          b.x = r * Math.cos(a); b.y = Math.min(r * Math.sin(a), lvl - 2); b.z = g.z0 + 10 + Math.random() * (g.z1 - g.z0 - 20); b.v = 60 + 240 * Math.random(); b.life = 3;
        }
        b.y += b.v * dt * (0.5 + boil); pos.setXYZ(i, b.z, b.y, b.x);
      });
      pos.needsUpdate = true; q.bubbles.material.opacity = 0.25 + 0.7 * boil;
    }
    // helium gas venting through the relief line at the top of the cryostat
    if (q.vent) {
      const pos = q.vent.geometry.attributes.position;
      q.vent.userData.p.forEach((b, i) => {
        b.life -= dt;
        if (b.life <= 0) {
          if (Math.random() > Math.exp(-s / 2.5) * 1.3) { pos.setXYZ(i, 0, -1e5, 0); b.life = 0.05; return; }
          b.z = q.ventZ + (Math.random() - 0.5) * 60; b.y = q.ventY; b.x = (Math.random() - 0.5) * 60;
          b.vy = 500 + 700 * Math.random(); b.vz = (Math.random() - 0.5) * 220; b.vx = (Math.random() - 0.5) * 220; b.life = 1.2 + Math.random();
        }
        b.y += b.vy * dt; b.z += b.vz * dt; b.x += b.vx * dt; b.vy *= 0.985; pos.setXYZ(i, b.z, b.y, b.x);
      });
      pos.needsUpdate = true; q.vent.material.opacity = 0.12 + 0.5 * Math.exp(-s / 2.5);
    }
  }

  frame(now) {
    const dt = Math.min(0.1, (now - this._last) / 1000); this._last = now;
    if (this.recording) return;
    this.tickQuench(dt);
    if (this.story.playing) {
      const total = STORY.reduce((a, b) => a + b.dur, 0);
      this.setStory(this.story.u + (dt * this.time.speed) / total);
      if (this.story.u >= 1) this.storyPlay(false);
    } else if (this.time.playing) {
      this.setU(this.time.u + (dt * this.time.speed) / this.time.duration);
      if (this.time.u >= 1) this.play(false);
    }
    if (this.scMeshes) for (const m of Object.values(this.scMeshes)) {
      m.material.emissiveIntensity = 2.2 * m.userData.flash; m.material.opacity = 0.16 + 0.5 * m.userData.flash;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  /* ---------------- camera ---------------- */
  setView(kind) {
    const c = new THREE.Vector3(-250, 0, 0);
    if (kind === "line") { const zc = this.zDel - 3000; this.controls.target.set(zc, 0, 0); this.camera.position.set(zc + 200, 1300, 4200); return; }
    const pos = { side: [-250, 120, 3400], top: [-250, 3400, 10], end: [-3200, 120, 60], iso: [-1500, 950, 1650], trap: [-250, 60, 520] }[kind] || [-1500, 950, 1650];
    this.camera.position.set(...pos); this.controls.target.copy(c); this.camera.near = kind === "trap" ? 0.5 : 1; this.camera.updateProjectionMatrix();
  }
  focus(xyz) {
    const [X, Y, Z] = toScene(...xyz); const k = this.opts.radial;
    const p = new THREE.Vector3(X, Y * k, Z * k);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(p); this.camera.position.copy(p.clone().add(dir.multiplyScalar(260)));
  }

  /* ---------------- transfer line (schematic) ---------------- */
  buildTransferLine() {
    const L = this.layers.line; L.clear();
    const z1 = this.zDel, z0 = z1 - 6000, cut = this.opts.cutaway ? [90, 270] : [0, 360];
    const glass = new THREE.MeshStandardMaterial({ color: "#9fb4d8", metalness: 0.9, roughness: 0.15, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
    L.add(new THREE.Mesh(tubeGeom(46, 50, z0, z1 - 40, ...cut, 48), glass));
    this.quads = [];
    for (let k = 0, z = z0 + 450; z < z1 - 350; z += 700, k++) {
      const col = k % 2 ? "#0a84ff" : "#ff453a";
      const m = new THREE.Mesh(tubeGeom(62, 125, z, z + 150, ...cut, 48),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.15, metalness: 0.5, roughness: 0.35, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      m.userData = { kind: "quad", z: z + 75 }; L.add(m); this.quads.push(m);
    }
    for (const [z, txt] of [[z0 + 150, "ELENA extraction"], [z0 + 3000, "LNE00 · LNE01 · LNE02 transfer line (schematic, not to scale)"]]) {
      const el = document.createElement("div"); el.className = "lbl line"; el.textContent = txt;
      const o = new CSS2DObject(el); o.position.set(z, 170, 0); L.add(o);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(70, 2.2, 12, 96), new THREE.MeshStandardMaterial({ color: "#64d2ff", emissive: "#64d2ff", emissiveIntensity: 1.6 }));
    ring.rotation.y = Math.PI / 2; ring.position.set(z1, 0, 0); L.add(ring); this.delRing = ring;
    const el = document.createElement("div"); el.className = "lbl del"; el.textContent = "Delivery point · LNE02$END";
    const o = new CSS2DObject(el); o.position.set(z1, 105, 0); L.add(o);
  }
  buildBunch() {
    this.layers.bunch.clear();
    const n = Math.max(this.bunchInit.length, 1);
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    this.bunch = new THREE.Points(g, new THREE.PointsMaterial({ color: "#ff375f", size: 9, map: this.dotTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.bunch.frustumCulled = false; this.layers.bunch.add(this.bunch);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, color: "#ff375f", transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(160, 160, 1); this.bunchGlow = glow; this.layers.bunch.add(glow);
  }
  placeBunch(p) {
    if (!this.bunch) return 0;
    const z0 = this.zDel - 6000, e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const zb = z0 + (this.zDel - z0) * e;
    const pos = this.bunch.geometry.attributes.position;
    this.bunchInit.forEach((b, i) => {
      const z = zb + b.dz * (1 - e);
      const dist = (this.zDel - z) / 6000;
      const f = 1 + 7 * dist * Math.abs(Math.sin((Math.PI * (this.zDel - z)) / 700 + b.ph * 0.3));
      pos.setXYZ(i, z, b.y * f, b.x * f);
    });
    pos.needsUpdate = true;
    this.bunchGlow.position.set(zb, 0, 0); this.bunchGlow.material.opacity = 0.35 * (1 - 0.6 * e);
    this.quads?.forEach((q) => (q.material.emissiveIntensity = 0.15 + 1.4 * Math.exp(-Math.pow((q.userData.z - zb) / 160, 2))));
    return zb;
  }

  /* ---------------- field lines & potential ---------------- */
  setField(zB, bz) {
    this.layers.field.clear(); this.fieldLines = [];
    let bmax = 0, iref = 0; bz.forEach((b, i) => { if (b > bmax) { bmax = b; iref = i; } });
    this.Bmax = bmax;
    if (bmax <= 0) return;
    const base = new THREE.Color("#64d2ff");
    for (const [r0, nphi] of [[5, 6], [10, 8], [14, 8], [30, 10], [55, 12]]) {
      for (let k = 0; k < nphi; k++) {
        const phi = (2 * Math.PI * (k + (r0 % 7) * 0.13)) / nphi;
        const pts = [], cols = [];
        for (let i = 0; i < zB.length; i++) {
          const b = Math.max(bz[i], 1e-4), r = r0 * Math.sqrt(bmax / b);
          if (r > 330) { if (pts.length) break; else continue; }
          pts.push(...toScene(r * Math.cos(phi), r * Math.sin(phi), zB[i]));
          const c = base.clone().multiplyScalar(0.15 + 0.85 * (b / bmax)); cols.push(c.r, c.g, c.b);
        }
        if (pts.length < 6) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
        const l = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: r0 > 20 ? 0.35 : 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
        l.userData.n = pts.length / 3; l.userData.op = l.material.opacity; l.frustumCulled = false;
        this.layers.field.add(l); this.fieldLines.push(l);
      }
    }
    if (this.story.on) this.setStory(this.story.u);
  }
  setFieldMaps(fm) {
    this.layers.bmap.clear(); this.mapMats = {};
    const decode = (b64) => { const bin = atob(b64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Float32Array(u8.buffer); };
    const make = (m, kind, layer, order, step) => {
      const tex = new THREE.DataTexture(decode(m.data), m.nz, m.nr, THREE.RedFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
      const vabs = Math.max(Math.abs(m.min), Math.abs(m.max), 1e-9);
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: tex }, vmax: { value: kind === 0 ? m.max : vabs }, uScale: { value: 1 }, uOpacity: { value: 0.82 }, uStep: { value: step }, cmap: { value: kind }, uRcut: { value: 0 },
          uZ0: { value: m.z0 }, uW: { value: m.nz * m.dz }, uQ: { value: new THREE.Vector3(0, 0, 1) } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform sampler2D map; uniform float vmax; uniform float uScale; uniform float uOpacity; uniform float uStep; uniform int cmap; uniform float uRcut; uniform float uZ0; uniform float uW; uniform vec3 uQ; varying vec2 vUv;
          vec3 turbo(float x){ x = clamp(x, 0.0, 1.0);
            return vec3(0.13572138 + x*(4.61539260 + x*(-42.66032258 + x*(132.13108234 + x*(-152.94239396 + x*59.28637943)))),
                        0.09140261 + x*(2.19418839 + x*(4.84296658 + x*(-14.18503333 + x*(4.27729857 + x*2.82956604)))),
                        0.10667330 + x*(12.64194608 + x*(-60.58204836 + x*(110.36276771 + x*(-89.90310912 + x*27.34824973))))); }
          void main(){
            if (vUv.y < uRcut) discard;
            float zz = uZ0 + vUv.x * uW;
            float q = mix(1.0, uQ.z, smoothstep(uQ.x - 60.0, uQ.x + 60.0, zz) * (1.0 - smoothstep(uQ.y - 60.0, uQ.y + 60.0, zz)));
            float v = texture2D(map, vUv).r * uScale * q;
            vec3 c; float a;
            if (cmap == 0) { float t = v / vmax; c = turbo(t); a = smoothstep(0.0, 0.04, t); }
            else { float t = clamp(v / vmax, -1.0, 1.0); t = sign(t) * pow(abs(t), 0.55);
                   c = t < 0.0 ? mix(vec3(0.85, 0.9, 1.0), vec3(0.04, 0.45, 1.0), -t) : mix(vec3(1.0, 0.9, 0.88), vec3(1.0, 0.27, 0.23), t);
                   a = smoothstep(0.0, 0.03, abs(t)); }
            float f = v / uStep, w = fwidth(f);
            float line = 1.0 - smoothstep(0.0, 1.2, abs(fract(f - 0.5) - 0.5) / max(w, 1e-5));
            c = mix(c, vec3(1.0), 0.55 * line * step(0.001, abs(v)));
            gl_FragColor = vec4(c, uOpacity * max(a, 0.6 * line * step(0.001, abs(v))));
          }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      const w = m.nz * m.dz, h = m.nr * m.dr;
      for (const sgn of [1, -1]) {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
        mesh.position.set(m.z0 + w / 2, sgn * (m.r0 + h / 2), 0); mesh.scale.y = sgn; mesh.renderOrder = order;
        layer.add(mesh);
      }
      return mat;
    };
    this.mapInfo = fm;
    this.mapMats.B = make(fm.B, 0, this.layers.bmap, 1, 0.5);
    this.bRcut = 15.5 / (fm.B.nr * fm.B.dr);
    this.Bmax = fm.B.max;
    if (this.story.on) this.setStory(this.story.u); else this.setStory(1, true);
  }

  setPotential(zE, V) {
    this.layers.pot.clear();
    const vabs = Math.max(1, ...V.map(Math.abs)), k = 60 / vabs, y0 = -40;   // drawn below the bore in the x = 0 plane
    const line = [], fill = [];
    let imin = 0; V.forEach((v, i) => { if (v < V[imin]) imin = i; });
    for (let i = 0; i < zE.length; i++) {
      line.push(zE[i], y0 + V[i] * k, 0.5);
      if (i) fill.push(zE[i - 1], y0, 0.4, zE[i - 1], y0 + V[i - 1] * k, 0.4, zE[i], y0 + V[i] * k, 0.4, zE[i - 1], y0, 0.4, zE[i], y0 + V[i] * k, 0.4, zE[i], y0, 0.4);
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(line, 3));
    this.potLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: "#a8ecff", transparent: true, opacity: 1, depthTest: false }));
    const fg = new THREE.BufferGeometry(); fg.setAttribute("position", new THREE.Float32BufferAttribute(fill, 3));
    this.potFill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: "#06182f", transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
    const base = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(zE[0], y0, 0.5), new THREE.Vector3(zE[zE.length - 1], y0, 0.5)]),
      new THREE.LineDashedMaterial({ color: "#ffffff", dashSize: 6, gapSize: 5, transparent: true, opacity: 0.45, depthTest: false }));
    base.computeLineDistances();
    this.potFill.renderOrder = 7; base.renderOrder = 8; this.potLine.renderOrder = 9;
    [this.potFill, base, this.potLine].forEach((o) => { o.frustumCulled = false; this.layers.pot.add(o); });
    this.potN = zE.length; this.Vmin = V[imin]; this.potK = k; this.potY0 = y0; this.potZ = zE;
    const lab = (txt, x, y, cls) => { const el = document.createElement("div"); el.className = cls; el.textContent = txt; const o = new CSS2DObject(el); o.position.set(x, y, 0.5); this.layers.pot.add(o); return o; };
    lab("Φ(z) on axis", zE[0] + 70, y0 + 9, "lbl pot");
    lab("0 V", zE[zE.length - 1] + 25, y0, "lbl pot");
    this.potMin = lab(`${V[imin].toFixed(1)} V`, zE[imin], y0 + V[imin] * k - 9, "lbl potmin");
    this.potMinIdx = imin;
    this.pulseLbls = (this.potDyn?.pulsed || []).map((q) => lab("", q.zc, y0 + 22, "lbl pulse"));
    if (this.story.on) this.setStory(this.story.u); else this.setStory(1, true);
  }
  // pulsed catching: Φ(z, t) = static part + Σ f_pulse(t) · V · φ_e(z)
  setPulseProfile(dyn) { this.potDyn = dyn && dyn.pulsed?.length ? dyn : null; }
  updatePotential(t) {
    const d = this.potDyn; if (!d || !this.potLine || d.Vs.length !== this.potN) return;
    const n = this.potN, k = this.potK, y0 = this.potY0, V = Float32Array.from(d.Vs);
    const fs = d.pulsed.map((q) => pulseFactor(q, t));
    d.pulsed.forEach((q, j) => { if (fs[j]) for (let i = 0; i < n; i++) V[i] += fs[j] * q.V * q.phi[i]; });
    const lp = this.potLine.geometry.attributes.position, fp = this.potFill.geometry.attributes.position;
    let imin = 0;
    for (let i = 0; i < n; i++) {
      const y = y0 + V[i] * k; lp.setY(i, y); if (V[i] < V[imin]) imin = i;
      if (i) { fp.setY(6 * (i - 1) + 1, y0 + V[i - 1] * k); fp.setY(6 * (i - 1) + 2, y); fp.setY(6 * (i - 1) + 4, y); }
    }
    lp.needsUpdate = fp.needsUpdate = true;
    this.potMinIdx = imin;
    if (this.potMin) { this.potMin.element.textContent = `${V[imin].toFixed(1)} V`; this.potMin.position.set(this.potZ[imin], y0 + V[imin] * k - 9, 0.5); }
    this.pulseLbls?.forEach((o, j) => { const q = d.pulsed[j], v = fs[j] * q.V;
      o.element.textContent = `${q.id} ${Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + " kV" : v.toFixed(0) + " V"}`;
      o.element.classList.toggle("on", fs[j] > 0.5); o.position.set(q.zc, y0 + Math.min(0, v) * k - 14, 0.5); });
  }

  /* ---------------- story mode ---------------- */
  storyMode(on) {
    this.story.on = on;
    if (!on) { this.story.playing = false; this.setStory(1, true); this.setU(1); }
  }
  storyPlay(on = !this.story.playing) {
    this.story.playing = on;
    if (on) { this.time.playing = false; this.story.auto = true; if (this.story.u >= 0.999) this.setStory(0); }
    this.hooks.onPlay?.(on);
  }
  storyLocate(u) {
    const total = STORY.reduce((a, b) => a + b.dur, 0); let acc = 0;
    for (let i = 0; i < STORY.length; i++) { const d = STORY[i].dur / total; if (u <= acc + d || i === STORY.length - 1) return { i, p: Math.min(1, Math.max(0, (u - acc) / d)) }; acc += d; }
  }
  setStory(u, silent = false) {
    this.story.u = Math.min(Math.max(u, 0), 1);
    const { i, p } = this.storyLocate(this.story.u);
    const P = (k) => (i > k ? 1 : i === k ? p : 0);
    const pl = P(0), pm = P(1), pe = P(2), pt = P(3);
    // 1 transfer line + bunch
    const zb = this.placeBunch(pl);
    this.layers.bunch.visible = i < 3;
    this.delRing && (this.delRing.material.emissiveIntensity = 1.2 + (i >= 1 && i < 3 ? 1.2 * Math.abs(Math.sin(this.story.u * 60)) : 0));
    // 2 magnets
    let bnow = 0;
    const coils = this.layers.coils.children;
    const corr = coils.filter((m) => !m.userData.main).sort((a, b) => a.userData.z0 - b.userData.z0);
    coils.forEach((m) => {
      const start = m.userData.main ? 0 : 0.3 + (0.4 * corr.indexOf(m)) / Math.max(corr.length, 1);
      const l = Math.min(1, Math.max(0, (pm - start) / 0.3));
      m.material.emissive.set("#ff8a3d");
      m.material.emissiveIntensity = (0.25 * l + 1.6 * Math.sin(Math.PI * l)) * (1 - 0.75 * pt);
      m.material.opacity = (m.userData.main ? 0.13 : 0.22) * (1 - 0.45 * pt) + 0.2 * l * (1 - 0.85 * pt);
      if (m.userData.main) bnow = Math.max(bnow, l);
    });
    const fp = Math.min(1, Math.max(0, (pm - 0.1) / 0.8));
    this.fieldLines?.forEach((l) => { l.geometry.setDrawRange(0, Math.floor(l.userData.n * fp)); l.material.opacity = l.userData.op * Math.min(1, pm * 2) * (1 - 0.5 * pt); });
    // 3 electrodes
    const els = (this.elMeshes || []).slice().sort((a, b) => a.userData.z0 - b.userData.z0);
    const vmax = Math.max(1, ...els.map((m) => Math.abs(this.voltages[m.userData.id] ?? 0)));
    els.forEach((m, k) => {
      const v = this.voltages[m.userData.id] ?? 0, a = Math.abs(v) / vmax;
      const l = Math.min(1, Math.max(0, (pe - (0.7 * k) / els.length) / 0.25));
      m.material.emissive.set(v < 0 ? "#0a84ff" : "#ff453a");
      m.material.emissiveIntensity = v ? a * (0.5 * l + 1.8 * Math.sin(Math.PI * l)) : 0;
    });
    if (this.potLine) {
      const n = Math.floor(this.potN * pe);
      this.potLine.geometry.setDrawRange(0, n); this.potFill.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
      if (this.potMin) this.potMin.visible = n > this.potMinIdx;
    }
    if (this.mapMats?.B) {
      const ramp = Math.min(1, Math.max(0, pm / 0.7)), rs = ramp * ramp * (3 - 2 * ramp);
      this.mapMats.B.uniforms.uScale.value = rs; this.mapMats.B.uniforms.uOpacity.value = 0.45 * Math.min(1, pm * 3) * (1 - 0.4 * pt);


    }
    // 4 transport
    if (i < 3) {
      const hide = (mat) => (mat.uniforms.uTime.value = -1);
      this.trackObjs?.forEach((o) => hide(o.material)); this.beadObjs?.forEach((o) => hide(o.material)); this.vertexPts && hide(this.vertexPts.material); this.hitPts && hide(this.hitPts.material); this.trapPts && hide(this.trapPts.material);
      for (const m of Object.values(this.scMeshes || {})) m.userData.flash = 0;
      this.updatePotential(-Infinity); this._tPrev = null;
    } else this.setU(pt);
    // camera
    if (this.story.on && this.story.auto && !silent) this.storyCamera(i, p, zb);
    if (!silent) this.hooks.onStory?.(this.story.u, i, p, { B: bnow * (this.Bmax || 0), Vmin: (this.Vmin || 0) * pe, t: i === 3 ? this.tAt(pt) : 0, zb });
  }
  storyCamera(i, p, zb) {
    const ease = (x) => x * x * (3 - 2 * x);
    const v = (x, y, z) => new THREE.Vector3(x, y, z);
    const endLine = { t: v(this.zDel + 250, 0, 0), c: v(this.zDel - 650, 300, 820) };
    const wide = { t: v(-300, 0, 0), c: v(-1950, 1150, 2350) };
    const close = { t: v(-250, 0, 0), c: v(-1050, 360, 1050) };
    let vz = -150;
    if (this.event >= 0 && this.data?.vertices) { const k = this.data.vertices.ev.indexOf(this.event); if (k >= 0) vz = this.data.vertices.z[k]; }
    const fin = { t: v(vz, 0, 0), c: v(vz - 620, 250, 620) };
    let a, b, q;
    if (i === 0) { const t = v(zb + 300, 0, 0); a = b = { t, c: v(zb - 500, 260, 760) }; q = 1; }
    else if (i === 1) { a = endLine; b = wide; q = ease(Math.min(1, p / 0.6)); }
    else if (i === 2) { a = wide; b = close; q = ease(Math.min(1, p / 0.7)); }
    else { a = close; b = fin; q = ease(Math.min(1, p / 0.5)); }
    this.controls.target.copy(a.t.clone().lerp(b.t, q));
    this.camera.position.copy(a.c.clone().lerp(b.c, q));
    const k = this.opts.radial; this.controls.target.y *= k; this.controls.target.z *= k;
  }

  /* ---------------- recording ---------------- */
  // Steps the animation deterministically and hands every rendered frame to onFrame(glCanvas, labels).
  async record({ mode = "story", frames = 200, onFrame, onProgress, shouldStop }) {
    this.recording = true; this.story.playing = false; this.time.playing = false;
    const auto = this.story.auto; this.story.auto = true;
    try {
      for (let k = 0; k < frames; k++) {
        if (shouldStop?.()) break;
        const u = frames > 1 ? k / (frames - 1) : 1;
        if (mode === "story") this.setStory(u); else this.setU(Math.min(u, 0.9999));
        if (this.scMeshes) for (const m of Object.values(this.scMeshes)) { m.material.emissiveIntensity = 2.2 * m.userData.flash; m.material.opacity = 0.16 + 0.5 * m.userData.flash; }
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        await onFrame(this.renderer.domElement, this.screenLabels(), k);
        onProgress?.(k + 1, frames);
        if (k % 3 === 0) await new Promise((r) => requestAnimationFrame(r));
      }
    } finally { this.recording = false; this.story.auto = auto; }
  }
  screenLabels() {
    if (!this.layers.labels.visible && !this.layers.line.visible) return [];
    const W = this.renderer.domElement.clientWidth, H = this.renderer.domElement.clientHeight, out = [], v = new THREE.Vector3();
    this.scene.traverseVisible((o) => {
      if (!o.isCSS2DObject) return;
      if (this.labels.domElement.classList.contains("hide-labels")) return;
      o.getWorldPosition(v); v.project(this.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return;
      const cs = (o._cs ||= getComputedStyle(o.element));
      out.push({ text: o.element.textContent, x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * H, color: cs.color, font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` });
    });
    return out;
  }

  /* ---------------- picking ---------------- */
  pick(e) {
    const r = this.labels.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(m, this.camera);
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.raycaster.params.Line.threshold = Math.max(0.5, dist / 300);
    const t = this.time.u >= 0.9999 ? 1e9 : this.tAt(this.time.u);
    const objs = (this.trackObjs || []).filter((o) => o.visible && this.layers.tracks.visible);
    for (const hit of this.raycaster.intersectObjects(objs, false)) {
      const o = hit.object, vi = hit.index;
      const tt = o.geometry.attributes.time.getX(vi), ev = o.geometry.attributes.ev.getX(vi);
      if (tt > t || (this.event >= 0 && ev !== this.event)) continue;
      const info = this.trackInfo[o.userData.seg[Math.floor(vi / 2)]];
      return this.hooks.onPick?.({ type: "track", ...info, species: this.species[info.si] });
    }
    const hm = this.raycaster.intersectObjects([...this.layers.electrodes.children, ...this.layers.scint.children, ...(this.layers.cryo.visible ? this.layers.cryo.children : []), ...(this.layers.ovc.visible ? this.layers.ovc.children : [])], true)[0];
    if (hm?.object.userData.kind) return this.hooks.onPick?.({ type: hm.object.userData.kind, ...hm.object.userData, V: this.voltages[hm.object.userData.id] });
    this.hooks.onPick?.(null);
  }
}
