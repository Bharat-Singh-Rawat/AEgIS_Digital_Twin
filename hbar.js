// Positrons -> positronium -> antihydrogen -> moiré deflectometer.
// 3D parts for the event display, two story chapters, and a Monte-Carlo of formation and of the gravity fringe.
// Inputs come from geometry().hbar (twin/hbar.py), with the published numbers and their sources.
// Scene coordinates: scene x = beam z (CST frame, mm), scene y = vertical, scene z = horizontal (CST x).
import * as THREE from "three";
import { CSS2DObject } from "./vendor/CSS2DRenderer.js";

const ALPHA_C = 2.18769e6;                   // α·c [m/s]
const M_H = 1.6735e-27, KB = 1.380649e-23;   // antihydrogen mass, Boltzmann
const gauss = (rnd) => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
export const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// charge exchange Ps(n) + p̄ -> H̄ + e-, fit to the classical-trajectory results (Volponi eq. 2.2.6, after Krasnický 2016)
export function sigmaCX(n, v) {
  const k = (2 * n * v) / ALPHA_C;
  return Math.pow(n, 4) * 1e-19 * (1.2 + 0.1 / (k * k)) / (1 + Math.pow(k / 1.84, 18));   // m²
}

// ---------------------------------------------------------------- positron system rates (source -> bunch)
// 22Na decays (β+ 89.96 %), solid-neon moderation + magnetic filter (net 2.5e-3 of the β+, V 2386-2397), buffer-gas
// capture and transfer into the accumulator (~3.6 %, so 110 s gives ~2e6 e+), accumulator lifetime of minutes.
export function positronChain(h, o = {}) {
  const S = h.positron?.source || {}, T = h.positron?.trapping || { implied_capture: 0.036 };   // older servers lack 'trapping'
  const A = (o.activity_MBq ?? S.activity_MBq?.[0] ?? 220) * 1e6;
  const beta = A * (S.beta_plus ?? 0.8996), slow = beta * (S.efficiency ?? 2.5e-3), R = slow * T.implied_capture, tau = o.lifetime_s ?? 300, t = o.stack_s ?? 110;
  return { activity: A, beta, slow, captured: R, stacked: R * tau * (1 - Math.exp(-t / tau)), tau, t };
}

// ---------------------------------------------------------------- Ps laser cooling (1D, transverse x)
// Broadband 243 nm pulse, retro-reflected: a Ps absorbs from the beam it moves against when its Doppler shift |v|/λ falls
// inside the (saturation-broadened) laser spectrum around the red detuning; each cycle (absorption + decay of 2³P,
// 2·τ_2P on average) gives -v_rec along x plus a random emission kick. Validated against 380 K -> 170 K (PRL 2024).
export function laserCool(vx, c, rnd, t0 = c.on_ns[0], t1 = c.on_ns[1]) {
  // saturated (every cycle scatters) across ±saturated/2 around the detuning, Gaussian edges with the laser rms bandwidth
  const lam = c.nm * 1e-9, det = Math.abs(c.detuning_GHz) * 1e9, half = (c.saturated_GHz / 2) * 1e9, sig = c.bandwidth_GHz * 1e9;
  const cyc = 2 * c.tau_2p_ns; let n = 0;
  for (let t = t0; t + cyc <= t1; t += cyc) {
    const f = Math.abs(vx) / lam, off = Math.max(0, Math.abs(f - det) - half), p = Math.exp(-(off * off) / (2 * sig * sig));
    if (rnd() < p) { vx -= Math.sign(vx) * c.recoil_ms; vx += (2 * rnd() - 1) * c.recoil_ms; n++; }
  }
  return { vx, n };
}

// ---------------------------------------------------------------- formation Monte-Carlo (one cycle)
// Ps leave the converter face toward the p̄ cloud, the lasers excite those inside the beam at t_L, Rydberg Ps that cross
// the cloud form H̄ with probability 1 - exp(-σ n_p̄ ℓ). Each sampled Ps stands for (e+ · yield / samples) real ones.
export function formationMC(h, o = {}) {
  const rnd = mulberry(o.seed ?? 7), cv = h.converter, L = h.lasers, H = h.hbar;
  const N = o.samples ?? 40000, nPs = o.nPs ?? L.n_ps, Ne = o.positrons ?? 2e6;
  const zFace = cv.z_face, zL = L.z, s = L.uv.fwhm_mm / 2.355, pPeak = L.p_n3 * L.p_rydberg * (1 - L.self_ionisation);
  const a = H.pbar_r_mm, b = H.pbar_half_len_mm, zc = H.cloud_z, Np = o.pbarN ?? H.pbar_n;
  const dens = Np / ((4 / 3) * Math.PI * a * a * b * 1e-9);                       // p̄ per m³
  const vp = (o.vPs ?? cv.ps_v) / 1e6;                                             // mm per ns
  const cmin = Math.cos((cv.ps_cone_deg * Math.PI) / 180), spot = 2.0 / 2.355;
  const w = (Ne * cv.ps_yield) / N, out = { ps: [], hbarPerCycle: 0, rydPerCycle: 0, crossPerCycle: 0, starkLost: 0, times: [], nPs, sigma: 0 };
  const cool = o.cool && h.cooling, B = o.B ?? 1.0, tLas = cool ? h.cooling.on_ns[1] + 5 : L.delay_ns;   // excite after cooling
  let vx2a = 0, vx2b = 0, nC = 0;
  let sigSum = 0, sigN = 0;
  for (let i = 0; i < N; i++) {
    const ct = cmin + (1 - cmin) * rnd(), st = Math.sqrt(1 - ct * ct), ph = 2 * Math.PI * rnd();
    const sp = (vp / Math.SQRT2) * Math.hypot(gauss(rnd), gauss(rnd), gauss(rnd));      // Maxwell-like speed, mode = vp
    const d = { x: st * Math.cos(ph) * sp, y: st * Math.sin(ph) * sp, z: -ct * sp };   // toward the cloud (upstream)
    const p0 = { x: gauss(rnd) * spot, y: gauss(rnd) * spot, z: zFace };
    const tDecay = -cv.ops_lifetime_ns * Math.log(1 - rnd()), tL = tLas;
    if (cool && tDecay > h.cooling.on_ns[1]) {          // transverse (x) cooling while the 243 nm pulse is on
      const vx0 = d.x * 1e6, r = laserCool(vx0, h.cooling, rnd); vx2a += vx0 * vx0; vx2b += r.vx * r.vx; nC++;
      p0.x += (d.x - r.vx / 1e6) * Math.max(0, h.cooling.on_ns[1]) * 0.5; d.x = r.vx / 1e6;
    }
    let ryd = false, tf = -1, P = 0;
    if (tDecay > tL) {
      const y = p0.y + d.y * tL, z = p0.z + d.z * tL;
      if (rnd() < pPeak * Math.exp(-(y * y + (z - zL) * (z - zL)) / (2 * s * s))) ryd = true;
    }
    if (ryd) {
      // motional Stark ionisation in the real field at the cloud: n_max = (1.4e10 / (v B sinθ))^¼ (Volponi eq. 2.2.3)
      const sinT = Math.hypot(d.x, d.y) / sp, nmax = Math.pow(1.4e10 / Math.max(sp * 1e6 * B * Math.max(sinT, 1e-3), 1e-9), 0.25);
      if (nPs > nmax) { out.starkLost += w; ryd = false; }
    }
    if (ryd) {
      out.rydPerCycle += w;
      // chord through the ellipsoid x²/a² + y²/a² + (z-zc)²/b² = 1, starting from the position at t_L
      const q = { x: p0.x + d.x * tL, y: p0.y + d.y * tL, z: p0.z + d.z * tL - zc };
      const A = (d.x * d.x + d.y * d.y) / (a * a) + (d.z * d.z) / (b * b), B = 2 * ((q.x * d.x + q.y * d.y) / (a * a) + (q.z * d.z) / (b * b));
      const C = (q.x * q.x + q.y * q.y) / (a * a) + (q.z * q.z) / (b * b) - 1, D = B * B - 4 * A * C;
      if (D > 0) {
        const t1 = (-B - Math.sqrt(D)) / (2 * A), t2 = (-B + Math.sqrt(D)) / (2 * A);
        if (t2 > 0) {
          const len = (t2 - Math.max(t1, 0)) * sp;                                     // mm
          const vms = sp * 1e6, sig = sigmaCX(nPs, vms); sigSum += sig; sigN++;
          P = 1 - Math.exp(-sig * dens * len * 1e-3);
          out.crossPerCycle += w; out.hbarPerCycle += w * P;
          tf = tL + (Math.max(t1, 0) + t2) / 2; out.times.push([tf, w * P]);
        }
      }
    }
    if (i < (o.keep ?? 900)) out.ps.push({ p0, d, tDecay, ryd, P, tf });
  }
  out.sigma = sigN ? sigSum / sigN : sigmaCX(nPs, cv.ps_v);
  const M_PS = 2 * 9.1093837e-31; out.B = B; out.cooled = !!cool;
  if (nC) { out.Tbefore = (M_PS * vx2a / nC) / KB; out.Tafter = (M_PS * vx2b / nC) / KB; }
  out.psPerCycle = Ne * cv.ps_yield; out.density = dens;
  return out;
}

// ---------------------------------------------------------------- moiré deflectometer Monte-Carlo
// Straight flights under a vertical acceleration a through two gratings and a position-sensitive detector.
// Transverse velocities are importance-sampled from a box around the acceptance; the weights keep the
// result unbiased and give the fraction of produced H̄ that are detected.
export function moireMC(h, o = {}) {
  const rnd = mulberry(o.seed ?? 11), M = h.moire, H = h.hbar;
  const d = (o.period_um ?? M.period_um) * 1e-6, open = d * (M.open_um / M.period_um);
  const L1 = (M.g1_z - H.cloud_z) * 1e-3, L = M.L_mm * 1e-3, R = M.r_mm * 1e-3, g = o.g ?? 9.81;
  const v0 = o.v ?? H.v_parallel, T = o.T ?? H.pbar_T_K, sv = o.svt ?? Math.sqrt((KB * T) / M_H), svz = o.svz ?? sv;   // thermal spread (or from a ballistic run)
  const res = (o.res_um ?? 1.2) * 1e-6, src = (H.pbar_r_mm * 1e-3) / 2;
  const want = o.nDet ?? 1000, maxS = o.maxSamples ?? 4e6;
  const vmax = (v0 * (R + 3 * src)) / L1, box = (2 * vmax) ** 2, pdf = (x) => Math.exp((-x * x) / (2 * sv * sv)) / (Math.sqrt(2 * Math.PI) * sv);
  const hits = []; let wAcc = 0, wSum = 0, n = 0, T2w = 0;
  const pass = (y) => { const m = ((y % d) + d) % d; return m < open; };
  while (hits.length < want && n < maxS) {
    n++;
    const vz = v0 + gauss(rnd) * svz; if (vz <= 50) continue;
    const vx = (2 * rnd() - 1) * vmax, vy = (2 * rnd() - 1) * vmax, wt = pdf(vx) * pdf(vy) * box;
    wSum += wt;
    const x0 = gauss(rnd) * src, y0 = gauss(rnd) * src;
    const at = (t) => [x0 + vx * t, y0 + vy * t - 0.5 * g * t * t];
    const t1 = L1 / vz, t2 = (L1 + L) / vz, t3 = (L1 + 2 * L) / vz;
    const [x1, y1] = at(t1); if (x1 * x1 + y1 * y1 > R * R || !pass(y1)) continue;
    const [x2, y2] = at(t2); if (x2 * x2 + y2 * y2 > R * R || !pass(y2)) continue;
    const [x3, y3] = at(t3); if (x3 * x3 + y3 * y3 > R * R) continue;
    hits.push({ x: x3, y: y3 + gauss(rnd) * res, w: wt, T2: (L / vz) ** 2 }); wAcc += wt; T2w += wt * (L / vz) ** 2;   // T from time of flight
  }
  // The H̄ are made in a short pulse, so each one's flight time T is known (time of flight). The fall a·T² is removed
  // event by event and a is the value that puts the pattern back on the no-force reference phase (straight lines through
  // slits [0, open) put it at open/2). Matched-filter scan over a, then a local quadratic refinement.
  const W = wAcc || 1, phi0 = (Math.PI * open) / d, k = (2 * Math.PI) / d;
  const score = (ev, a) => { let C = 0, Sn = 0; for (const p of ev) { const ph = k * (p.y + a * p.T2) - phi0; C += p.w * Math.cos(ph); Sn += p.w * Math.sin(ph); } return { C, S: Sn }; };
  const step = Math.min(0.05, d / (60 * (T2w / W)));
  const fit = (ev, lo, hi) => {
    let best = lo, bestC = -Infinity;
    for (let a = lo; a <= hi; a += step) { const { C } = score(ev, a); if (C > bestC) { bestC = C; best = a; } }
    const c0 = score(ev, best - step).C, c2 = score(ev, best + step).C, den = c0 - 2 * bestC + c2;
    return den < 0 ? best + (0.5 * step * (c0 - c2)) / den : best;
  };
  const span = o.aRange ?? 40, aMeas = hits.length ? fit(hits, -span, span) : 0;
  const at = score(hits, aMeas), vis = (2 * Math.hypot(at.C, at.S)) / W;
  // error: pseudo-experiments. The whole Monte-Carlo is repeated with other seeds (up to 4000 H̄ each) and the spread of
  // the fitted a, scaled by 1/√N, is the statistical error. Robust where the fit is far from ideal (phase wraps, wide T spread).
  let sA = Infinity, toyA = [];
  if (o.toys !== false && hits.length > 20) {
    const nt = Math.min(want, 4000);
    toyA = Array.from({ length: o.nToys ?? 8 }, (_, i) => moireMC(h, { ...o, nDet: nt, seed: (o.seed ?? 11) * 7919 + 101 * (i + 1), toys: false }).aMeas);
    const mk = toyA.reduce((a, b) => a + b, 0) / toyA.length;
    sA = (Math.sqrt(toyA.reduce((a, b) => a + (b - mk) ** 2, 0) / (toyA.length - 1)) * Math.sqrt(nt)) / Math.sqrt(hits.length);
  }
  const T2 = T2w / W, shift = -aMeas * T2, sShift = sA * T2;
  const bins = 24, hist = new Array(bins).fill(0), raw = new Array(bins).fill(0);
  for (const p of hits) { const m = (((p.y + aMeas * p.T2) % d) + d) % d, r = ((p.y % d) + d) % d;
    hist[Math.floor((m / d) * bins) % bins] += p.w; raw[Math.floor((r / d) * bins) % bins] += p.w; }
  const fAcc = wAcc / n;                                   // detected fraction of produced H̄
  return { hits, n, detected: hits.length, fAcc, produced: hits.length / Math.max(fAcc, 1e-30), d, open, vis, shift, sShift, T: Math.sqrt(T2),
    aMeas, sA, g, v: v0, Tk: T, hist: hist.map((x) => x / (W / bins)), raw: raw.map((x) => x / (W / bins)), phi0, fallTotal: 0.5 * g * ((L1 + 2 * L) / v0) ** 2,
    expectedShift: -g * (L / v0) ** 2, L, L1 };
}

// ---------------------------------------------------------------- 3D model + story animation
const S = (z, y, x = 0) => new THREE.Vector3(z, y, x);   // CST (x, y, z) -> scene
function along(r, z0, z1, mat, seg = 40, open = false) {
  const g = new THREE.CylinderGeometry(r, r, Math.max(z1 - z0, 0.01), seg, 1, open); g.rotateZ(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat); m.position.set((z0 + z1) / 2, 0, 0); return m;
}
function label(group, txt, pos, cls = "lbl hb") { const el = document.createElement("div"); el.className = cls; el.textContent = txt; const o = new CSS2DObject(el); o.position.copy(pos); group.add(o); return o; }
function stripeTexture(periods, open) {
  const c = document.createElement("canvas"); c.width = 16; c.height = 2048; const g = c.getContext("2d");
  g.fillStyle = "#9aa3ad"; g.fillRect(0, 0, 16, 2048);
  const p = 2048 / periods; g.fillStyle = "rgba(0,0,0,0)";
  for (let k = 0; k < periods; k++) g.clearRect(0, k * p, 16, p * open);
  const t = new THREE.CanvasTexture(c); t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function points(n, color, size, tex) {
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color, size, map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
  p.frustumCulled = false; return p;
}

export class HbarModel {
  constructor(h, dotTex) { this.h = h; this.tex = dotTex; this.group = new THREE.Group(); this.anim = new THREE.Group(); this.group.add(this.anim); }
  // Geant4 positron-line run (hbar_g4/positron_line): tracks from the 22Na source through the moderator and the guide
  // fields into the buffer-gas trap, drawn on the schematic line. The real route is not published, so z is mapped
  // piecewise onto the schematic layout (source 0-20 mm 1:1, line -> gap before the trap, trap -> Surko trap) and r x8.
  setLineTracks(el) {
    if (this.lineGroup) { this.group.remove(this.lineGroup); this.lineGroup.traverse((o) => o.geometry?.dispose()); this.lineGroup = null; }
    if (!el || !el.tracks?.length || !this.P) return;
    const P = this.P, y0 = P.path[0][1], src = P.parts.find((p) => p.id === "source"), sk = P.parts.find((p) => p.id === "surko"), Gm = el.geometry || {};
    const zs = src.z0 + 15, zT = Gm.z_trap ?? 2000, zE = Gm.z_end ?? 2815, R = 8;
    const mapZ = (z) => z <= 20 ? zs + z : z <= zT ? zs + 20 + ((z - 20) / (zT - 20)) * (sk.z0 - zs - 20) : sk.z0 + ((z - zT) / (zE - zT)) * (sk.z1 - sk.z0);
    const g = new THREE.Group(); g.name = "eline";
    const mat = new THREE.LineBasicMaterial({ color: "#bf5af2", transparent: true, opacity: 0.9 });
    for (const t of el.tracks) {
      const pts = t.z.map((z, i) => S(mapZ(z), y0 + R * t.y[i], R * t.x[i]));
      if (pts.length > 1) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    if (el.trapped?.z?.length) {
      const pos = []; el.trapped.z.forEach((z, i) => pos.push(mapZ(z), y0 + R * el.trapped.y[i], R * el.trapped.x[i]));
      const pg = new THREE.BufferGeometry(); pg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: "#30d158", size: 14, map: this.tex, transparent: true, depthWrite: false, sizeAttenuation: true })));
    }
    label(g, `Geant4 e⁺ tracks: ²²Na → Ne moderator → buffer-gas trap (${el.run}${el.trap_eff ? `, ${(100 * el.trap_eff).toFixed(0)} % trapped` : ""}) · z compressed, r ×${R}`, S(zs + 300, y0 - 120), "lbl hb");
    this.lineGroup = g; this.group.add(g); this.lineTrapped = g.children.find((o) => o.isPoints) || null;
  }
  // prelude animation: f = 0 -> 1 draws the source-to-trap tracks progressively (their own clock: µs after the decay)
  // first 60 %: Geant4 tracks source -> buffer-gas trap; last 40 %: the 2.5 keV bunch leaves the accumulator (top),
  // bends down the transfer line into the 5 T magnet and stops at the injection plane where the Geant4 e+ tracks start
  lineProgress(f) {
    if (!this.lineGroup) return;
    const g = Math.min(1, f / 0.6);
    for (const o of this.lineGroup.children) {
      if (o.isLine) { const n = o.geometry.attributes.position.count; o.geometry.setDrawRange(0, Math.max(g > 0 ? 2 : 0, Math.ceil(g * n))); }
    }
    if (this.lineTrapped) this.lineTrapped.visible = g >= 0.98;
    if (!this.eBunch || this.sAcc1 == null) return;
    if (this.sInj == null) { this.sInj = 1; for (let k = 0; k <= 800; k++) if (this.ePath.getPointAt(k / 800).x >= -1073) { this.sInj = k / 800; break; } }
    const b = (f - 0.6) / 0.4;
    if (b <= 0 || f >= 1) { if (this.bunchGlow) this.bunchGlow.visible = false; this.accGlow.material.opacity = f >= 1 ? 0 : 0.25 + 0.5 * Math.max(0, g - 0.5); this.eBunch.material.size = 9; return; }
    this.eBunch.material.size = 34;          // seen from the whole-line camera
    const e = this.eBunch.geometry.attributes.position, ease = (x) => x * x * (3 - 2 * x);
    for (let i = 0; i < e.count; i++) {
      const sp = Math.min(this.sInj, Math.max(this.sAcc0, this.sAcc1 + (this.sInj - this.sAcc1) * ease(b) - (i / e.count) * 0.012)), q = this.ePath.getPointAt(sp);
      const a = i * 2.39996, r = 9 * Math.sqrt((i % 37) / 37);
      e.setXYZ(i, q.x, q.y + r * Math.sin(a), q.z + r * Math.cos(a));
    }
    e.needsUpdate = true; this.anim.visible = true;
    if (!this.bunchGlow) {   // halo so the bunch reads from the whole-line camera
      this.bunchGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: "#ffb340", transparent: true, opacity: 0.85, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
      this.bunchGlow.scale.setScalar(130); this.anim.add(this.bunchGlow);
    }
    this.bunchGlow.position.set(e.getX(0), e.getY(0), e.getZ(0));
    for (const c of this.anim.children) c.visible = c === this.eBunch || c === this.accGlow || c === this.bunchGlow;   // the overlay re-sets these for its own window
    this.accGlow.material.opacity = 0.75 * (1 - b);
  }
  build() {
    const h = this.h, G = this.group, P = h.positron, M = h.moire, cv = h.converter;
    const steel = new THREE.MeshStandardMaterial({ color: "#b8bfc8", metalness: 0.85, roughness: 0.3, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
    const coil = new THREE.MeshStandardMaterial({ color: "#c97b3f", metalness: 0.6, roughness: 0.4, transparent: true, opacity: 0.6 });
    // positron line (schematic route) -----------------------------------------------------------
    const pts = P.path.slice(0, 6).map(([z, y]) => S(z, y));
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.2);
    G.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 24, 16, false), steel));
    this.ePath = new THREE.CatmullRomCurve3([...pts, ...P.path.slice(6).map(([z, y]) => S(z, y))], false, "centripetal", 0.2);
    // magnets as in the literature: Surko buffer-gas trap and accumulator each sit inside a uniform solenoid
    // (B ~ 0.05-0.15 T: FPS trap at NEPOMUC 55 mT, ALPHA accumulator 0.14 T) around their electrode stacks, and the
    // transfer to the 5 T magnet is guided by solenoid windings (~0.085 T, AEgIS). Exact AEgIS sizes are not published.
    const y0 = P.path[0][1];
    const shellMat = new THREE.MeshStandardMaterial({ color: "#b87333", metalness: 0.75, roughness: 0.35, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false });
    const gold = new THREE.MeshStandardMaterial({ color: "#e0b84a", metalness: 0.9, roughness: 0.25, transparent: true, opacity: 0.85 });
    const solenoid = (z0, z1, rIn, thick) => {   // winding pack: a thick copper shell with end flanges
      const g = new THREE.Group();
      const outer = along(rIn + thick, z0, z1, shellMat, 48, true), inner = along(rIn, z0, z1, shellMat, 48, true); g.add(outer, inner);
      for (const z of [z0, z1]) { const ring = new THREE.Mesh(new THREE.RingGeometry(rIn, rIn + thick, 48), shellMat); ring.rotation.y = Math.PI / 2; ring.position.x = z; g.add(ring); }
      g.position.y = y0; return g;
    };
    const stack = (z0, z1, radii, fracs, gap = 3) => {   // cylindrical electrodes along the axis
      const g = new THREE.Group(); let z = z0; const L = z1 - z0;
      radii.forEach((r, i) => { const l = L * fracs[i]; g.add(along(r, z + gap / 2, z + l - gap / 2, gold, 32, true)); z += l; });
      g.position.y = y0; return g;
    };
    for (const part of P.parts) {
      if (part.id === "source") {
        const m = along(part.r * 0.55, part.z0, part.z1, new THREE.MeshStandardMaterial({ color: "#ffd60a", metalness: 0.7, roughness: 0.35, transparent: true, opacity: 0.55 }), 32);
        m.position.y = y0; G.add(m); G.add(solenoid(part.z0 - 10, part.z1 + 10, part.r * 0.62, 14));            // 120 G source solenoid
      } else if (part.id === "surko") {
        // 3-stage stack, diameters stepping up (ALPHA / FPS: 12.7 mm, 30.5 mm, wide), stage lengths 400 / 255 / 100 mm
        G.add(stack(part.z0, part.z1, [6.35, 15.25, 34], [0.53, 0.34, 0.13]));
        G.add(solenoid(part.z0 - 25, part.z1 + 25, part.r, 22));
      } else if (part.id === "accum") {
        G.add(stack(part.z0 + 20, part.z1 - 20, Array(7).fill(22), Array(7).fill(1 / 7), 6));                    // Penning-Malmberg accumulator
        G.add(solenoid(part.z0 - 25, part.z1 + 25, part.r, 22));
      } else { const m = along(part.r, part.z0, part.z1, steel, 32); m.position.y = y0; G.add(m); }
      label(G, part.name, S((part.z0 + part.z1) / 2, y0 + part.r + 45), "lbl hb");
    }
    { // guide windings: a helical coil wound on the transfer tube (pitch 18 mm) from the diverter to the 5 T magnet
      const zDiv = (P.parts.find((q) => q.id === "diverter")?.z1 ?? -1890) + 15; let s0 = 0.3; while (s0 < 0.9 && curve.getPointAt(s0).x < zDiv) s0 += 0.002;
      const s1 = 0.985, turns = Math.round((curve.getLength() * (s1 - s0)) / 18), pts = [];
      for (let i = 0; i <= turns * 24; i++) {
        const u = s0 + ((s1 - s0) * i) / (turns * 24), p = curve.getPointAt(u), tg = curve.getTangentAt(u).normalize();
        const n1 = new THREE.Vector3(0, 0, 1).cross(tg); if (n1.lengthSq() < 1e-6) n1.set(0, 1, 0); n1.normalize(); const n2 = tg.clone().cross(n1);
        const a = (2 * Math.PI * i) / 24; pts.push(p.clone().addScaledVector(n1, 28 * Math.cos(a)).addScaledVector(n2, 28 * Math.sin(a)));
      }
      G.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length, 2.2, 6, false), coil));
      label(G, "guide solenoid ~0.085 T", curve.getPointAt(0.62).clone().add(new THREE.Vector3(0, 70, 0)), "lbl hb dim");
    }
    label(G, "Positron line · schematic route (not published) · ~2×10⁶ e⁺ per 110 s", S(-2700, P.path[0][1] + 150), "lbl hb dim");
    this.P = P;
    // converter, holder, ionisation grids --------------------------------------------------------
    const [sx, sy, sz] = cv.size_mm;
    const tgt = new THREE.Mesh(new THREE.BoxGeometry(sz, sy, sx), new THREE.MeshStandardMaterial({ color: "#3b3f6b", metalness: 0.3, roughness: 0.25, emissive: "#1c1f45" }));
    tgt.position.set(cv.z_face + sz / 2, 0, 0); tgt.userData = { kind: "hbar", id: "converter" }; G.add(tgt); this.target = tgt;
    const holder = along(4.2, h.a0[0], h.a0[1], new THREE.MeshStandardMaterial({ color: "#c0c4cc", metalness: 0.9, roughness: 0.3, transparent: true, opacity: 0.35 }), 24, true); G.add(holder);
    const gm = new THREE.LineBasicMaterial({ color: "#d8dde6", transparent: true, opacity: 0.55 });
    for (const gr of cv.grids) {
      const v = []; for (let k = -14; k <= 14; k += gr.pitch_mm) { const e = Math.sqrt(Math.max(0, 15 * 15 - k * k)); v.push(gr.z, k, -e, gr.z, k, e, gr.z, -e, k, gr.z, e, k); }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3)); G.add(new THREE.LineSegments(g, gm));
    }
    label(G, "Ps converter (nanochannel silica, 4.6×4.6 mm) on A0", S(cv.z_face, 26), "lbl hb");
    // gravity module ------------------------------------------------------------------------------
    const gv = M.gate_valve, zEnd = M.det_z + 80;
    G.add(along(M.housing_r, 1560, zEnd, steel, 48, true));
    const valve = new THREE.Mesh(new THREE.BoxGeometry(gv[1] - gv[0], 190, 150), steel); valve.position.set((gv[0] + gv[1]) / 2, 30, 0); G.add(valve);
    const shield = new THREE.Mesh(new THREE.TorusGeometry(M.housing_r + 40, 16, 12, 48), new THREE.MeshStandardMaterial({ color: "#6e7681", metalness: 0.8, roughness: 0.5 }));
    shield.rotation.y = Math.PI / 2; shield.position.set(M.shield_coil_z, 0, 0); G.add(shield);
    const gratTex = stripeTexture(Math.round((M.size_mm * 1000) / M.period_um), M.open_um / M.period_um);
    this.gratings = [];
    for (const [z, name] of [[M.g1_z, "Grating 1"], [M.g2_z, "Grating 2"]]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(M.size_mm, M.size_mm), new THREE.MeshStandardMaterial({ map: gratTex, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.4 }));
      pl.rotation.y = Math.PI / 2; pl.position.set(z, 0, 0); pl.userData = { kind: "hbar", id: name }; G.add(pl); this.gratings.push(pl);
      const fr = new THREE.Mesh(new THREE.TorusGeometry(33, 3, 8, 48), coil); fr.rotation.y = Math.PI / 2; fr.position.set(z, 0, 0); G.add(fr);
      label(G, `${name} · ${M.period_um} µm period, ${M.open_um} µm slits`, S(z, -M.housing_r - 30), "lbl hb");
      const sc = new THREE.Mesh(new THREE.BoxGeometry(100, 10, 90), new THREE.MeshStandardMaterial({ color: "#30d158", transparent: true, opacity: 0.35, emissive: "#30d158", emissiveIntensity: 0.1 }));
      sc.position.set(z, M.housing_r + 25, 0); G.add(sc);
    }
    const det = new THREE.Mesh(new THREE.BoxGeometry(4, 58, 57), new THREE.MeshStandardMaterial({ color: "#1d2433", metalness: 0.4, roughness: 0.3, emissive: "#0a1a33" }));
    det.position.set(M.det_z, 0, 0); G.add(det); this.det = det;
    const sc3 = new THREE.Mesh(new THREE.BoxGeometry(100, 10, 90), new THREE.MeshStandardMaterial({ color: "#30d158", transparent: true, opacity: 0.35 })); sc3.position.set(M.det_z, M.housing_r + 25, 0); G.add(sc3);
    label(G, "Position-sensitive detector (CMOS / MCP-Timepix3)", S(M.det_z, -M.housing_r - 30), "lbl hb");
    label(G, "Gravity module (planned): moiré deflectometer", S((M.g1_z + M.det_z) / 2, M.housing_r + 85), "lbl hb strong");
    label(G, "gate valve", S((gv[0] + gv[1]) / 2, 140), "lbl hb dim"); label(G, "field-shield coil", S(M.shield_coil_z, -M.housing_r - 70), "lbl hb dim");
    // animated parts (story only) -------------------------------------------------------------------
    const A = this.anim; A.visible = false;
    this.eBunch = points(160, "#ff9f0a", 9, this.tex); A.add(this.eBunch);
    this.beta = points(260, "#ffb340", 6, this.tex); A.add(this.beta);           // fast β+ from the source, every direction
    this.slowE = points(120, "#ffd60a", 5, this.tex); A.add(this.slowE);         // moderated e+ drifting into the traps
    const glow = (c) => { const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: c, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })); A.add(g); return g; };
    this.srcGlow = glow("#ffe08a"); this.accGlow = glow("#ff9f0a");
    const yL = P.path[0][1], src = P.parts.find((q) => q.id === "source"), acc = P.parts.find((q) => q.id === "accum");
    this.srcGlow.position.set((src.z0 + src.z1) / 2, yL, 0); this.accGlow.position.set((acc.z0 + acc.z1) / 2, yL, 0); this.accGlow.scale.set(acc.z1 - acc.z0, 150, 1);
    // path parameters of the source end and of the accumulator exit on the e+ path
    const sAt = (z) => { for (let k = 0; k <= 400; k++) if (this.ePath.getPointAt(k / 400).x >= z) return k / 400; return 1; };
    this.sAcc0 = sAt(acc.z0); this.sAcc1 = sAt(acc.z1); this.chain = positronChain(h);
    const rb = mulberry(21); this.betaDir = Array.from({ length: 260 }, () => { const u = 2 * rb() - 1, ph = 2 * Math.PI * rb(), st = Math.sqrt(1 - u * u); return [st * Math.cos(ph), u, st * Math.sin(ph), 60 + 260 * rb()]; });
    this.ps = points(900, "#9cff9c", 2.4, this.tex); A.add(this.ps);
    this.ryd = points(900, "#64d2ff", 4.5, this.tex); A.add(this.ryd);
    this.cloud = points(500, "#ff375f", 2.2, this.tex); A.add(this.cloud);
    this.hb = points(400, "#ffd60a", 5, this.tex); A.add(this.hb);
    this.hits = points(400, "#ffd60a", 2.2, this.tex); A.add(this.hits);
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: "#fff2b0", transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    A.add(this.flash);
    const L = h.lasers;
    this.uv = new THREE.Mesh(new THREE.CylinderGeometry(L.uv.fwhm_mm / 2, L.uv.fwhm_mm / 2, 80, 24, 1, true), new THREE.MeshBasicMaterial({ color: "#b18cff", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.uv.rotation.x = Math.PI / 2; this.uv.position.set(L.z, 0, 0); A.add(this.uv);
    this.ir = new THREE.Mesh(new THREE.CylinderGeometry(L.uv.fwhm_mm * 0.7, L.uv.fwhm_mm * 0.7, 80, 24, 1, true), new THREE.MeshBasicMaterial({ color: "#ff453a", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.ir.rotation.x = Math.PI / 2; this.ir.position.set(L.z, 0, 0); A.add(this.ir);
    this.lblLaser = label(A, "205 nm + 1693 nm lasers", S(L.z, 18, 0), "lbl hb laser");
    // cloud particles (ellipsoid)
    const H = h.hbar, cp = this.cloud.geometry.attributes.position, rnd = mulberry(3);
    for (let i = 0; i < cp.count; i++) { let x, y, z; do { x = 2 * rnd() - 1; y = 2 * rnd() - 1; z = 2 * rnd() - 1; } while (x * x + y * y + z * z > 1);
      cp.setXYZ(i, H.cloud_z + z * H.pbar_half_len_mm, y * H.pbar_r_mm, x * H.pbar_r_mm); }
    this.lblCloud = label(A, "p̄ cloud", S(H.cloud_z, -11), "lbl hb pbar");
    this.setMC(formationMC(h), moireMC(h, { nDet: 400 }));
    return G;
  }
  setMC(form, moire) {
    this.form = form; this.moire = moire;
    // the moiré hits shown on the detector face (positions scaled to the 40 mm aperture)
    const hp = this.hits.geometry.attributes.position, M = this.h.moire;
    for (let i = 0; i < hp.count; i++) { const p = moire.hits[i % Math.max(1, moire.hits.length)]; hp.setXYZ(i, M.det_z - 3, p ? p.y * 1e3 : 0, p ? p.x * 1e3 : 0); }
    hp.needsUpdate = true;
    // H̄ shown in chapter 6: formed events weighted by probability, enhanced for visibility (they are rare)
    const H = this.h.hbar, rnd = mulberry(5), sv = Math.sqrt((KB * H.pbar_T_K) / M_H);
    this.hbarVis = Array.from({ length: this.hb.geometry.attributes.position.count }, (_, i) => {
      const along = i < 120 && moire.hits.length > 0;          // a subset drawn from the accepted (straight) flights
      const p = along && moire.hits.length ? moire.hits[i % moire.hits.length] : null;
      const z0 = H.cloud_z + (rnd() - 0.5) * 2 * H.pbar_half_len_mm;
      const vz = H.v_parallel + gauss(rnd) * sv, vx = along ? (p.x / (moire.L1 + 2 * moire.L)) * vz : gauss(rnd) * sv, vy = along ? (p.y / (moire.L1 + 2 * moire.L)) * vz : gauss(rnd) * sv;
      return { z0, x0: (rnd() - 0.5) * 4, y0: (rnd() - 0.5) * 4, vz, vx, vy, along };
    });
  }
  // chapter: 0 = positrons -> positronium, 1 = antihydrogen -> gravity; p in 0..1
  story(ch, p, on) {
    const A = this.anim; A.visible = on; if (!on) return;
    const h = this.h, ease = (x) => x * x * (3 - 2 * x), cl = (x) => Math.min(1, Math.max(0, x));
    const hide = (pts) => { const a = pts.geometry.attributes.position; for (let i = 0; i < a.count; i++) a.setXYZ(i, 0, -1e5, 0); a.needsUpdate = true; };
    this.cloud.visible = true; this.lblCloud.visible = true;
    this.uv.material.opacity = this.ir.material.opacity = 0; this.lblLaser.visible = false; this.flash.material.opacity = 0;
    this.srcGlow.material.opacity = this.accGlow.material.opacity = 0; this.beta.visible = this.slowE.visible = false;
    if (ch === 0) {
      hide(this.hb); this.hits.visible = false;
      // a) 22Na decays: fast β+ in every direction; the solid-neon moderator lets ~0.25 % out slow
      this.stage = p < 0.1 ? "decay" : p < 0.22 ? "stack" : p < 0.45 ? "bunch" : "ps";
      const src = this.srcGlow.position, b = this.beta.geometry.attributes.position;
      if (p < 0.22) {
        this.beta.visible = true; this.srcGlow.material.opacity = 0.9; this.srcGlow.scale.setScalar(70 + 30 * Math.sin(p * 90));
        this.betaDir.forEach(([dx, dy, dz, r], i) => { const k = ((p * 40 + i * 0.137) % 1), d = r * k; b.setXYZ(i, src.x + dx * d, src.y + dy * d, src.z + dz * d); });
        b.needsUpdate = true; this.beta.material.opacity = p < 0.1 ? 0.9 : 0.9 * (1 - (p - 0.1) / 0.12);
      }
      // b) slow e+ drift into the buffer-gas trap and the accumulator, which fills over 110 s (time-lapse)
      if (p > 0.05 && p < 0.24) {
        this.slowE.visible = true; const se = this.slowE.geometry.attributes.position;
        for (let i = 0; i < se.count; i++) { const s = this.sAcc1 * ((p * 6 + i / se.count) % 1), q = this.ePath.getPointAt(Math.min(s, this.sAcc1)); se.setXYZ(i, q.x, q.y + (Math.sin(i) * 4), q.z + Math.cos(i * 1.7) * 4); }
        se.needsUpdate = true;
        this.stackFrac = cl((p - 0.08) / 0.14); this.accGlow.material.opacity = 0.15 + 0.6 * this.stackFrac;
      }
      // c) one 2.5 keV bunch leaves the accumulator, runs down the transfer line and through the traps to the converter
      const pa = cl((p - 0.22) / 0.23), e = this.eBunch.geometry.attributes.position, rnd = mulberry(9);
      for (let i = 0; i < e.count; i++) {
        const s = Math.min(1, Math.max(0, this.sAcc1 + (1 - this.sAcc1) * ease(pa) - (i / e.count) * 0.012)), q = this.ePath.getPointAt(s);
        e.setXYZ(i, q.x, q.y + (rnd() - 0.5) * 5, q.z + (rnd() - 0.5) * 5);
      }
      e.needsUpdate = true; this.eBunch.visible = p >= 0.22 && pa < 1;
      if (pa >= 1 && p < 0.52) { this.flash.position.set(h.converter.z_face, 0, 0); this.flash.scale.setScalar(40); this.flash.material.opacity = 1 - (p - 0.45) / 0.07; }
      // b) positronium leaves the converter; the lasers fire at t_L; Rydberg Ps fly into the p̄ cloud
      this.psAt(p < 0.48 ? -1 : ((p - 0.48) / 0.52) * 450);
    } else {
      hide(this.eBunch); hide(this.ps); hide(this.ryd);
      // a) H̄ formation flash in the cloud; b) H̄ fly downstream: most hit the trap walls, the straight ones reach the gratings
      const hb = this.hb.geometry.attributes.position, M = h.moire;
      if (p < 0.12) { this.flash.position.set(h.hbar.cloud_z, 0, 0); this.flash.scale.setScalar(30 + 200 * p); this.flash.material.opacity = 0.9 * (1 - p / 0.12); }
      const tf = p < 0.08 ? -1 : Math.pow((p - 0.08) / 0.92, 1.6) * ((M.det_z - h.hbar.cloud_z) / h.hbar.v_parallel) * 1e-3 * 1.02;   // seconds of flight
      this.tFlight = tf;
      this.hbarVis.forEach((q, i) => {
        if (tf < 0) { hb.setXYZ(i, 0, -1e5, 0); return; }
        let z = q.z0 + q.vz * tf * 1e3, x = q.x0 + q.vx * tf * 1e3, y = q.y0 + q.vy * tf * 1e3;
        const tw = Math.hypot(q.vx, q.vy) > 0 ? (15 - Math.hypot(q.x0, q.y0)) / (Math.hypot(q.vx, q.vy) * 1e3) : 1e9;   // reaches the 15 mm bore
        if (!q.along && tf > tw) { hb.setXYZ(i, 0, -1e5, 0); return; }
        if (q.along) { z = Math.min(z, M.det_z - 3); }
        hb.setXYZ(i, z, y, x);
      });
      hb.needsUpdate = true;
      this.hits.visible = tf > ((M.det_z - h.hbar.cloud_z) / h.hbar.v_parallel) * 1e-3;
      this.cloud.visible = this.lblCloud.visible = p < 0.25;
    }
  }
  // positronium at tNs after the e+ implant (shared by story chapter 5 and the full-shot overlay)
  psAt(t) {
    const h = this.h; this.tNs = t;
    const ps = this.ps.geometry.attributes.position, ry = this.ryd.geometry.attributes.position, L = h.lasers;
    this.form.ps.forEach((q, i) => {
      if (i >= ps.count) return;
      const at = (tt) => [q.p0.z + q.d.z * tt, q.p0.y + q.d.y * tt, q.p0.x + q.d.x * tt];
      const alive = t >= 0 && t < q.tDecay && !(q.ryd && t >= L.delay_ns);
      const r = q.ryd && t >= L.delay_ns && !(q.P > 0 && q.tf > 0 && t > q.tf + 15);
      if (alive) ps.setXYZ(i, ...at(t)); else ps.setXYZ(i, 0, -1e5, 0);
      if (r) ry.setXYZ(i, ...at(t)); else ry.setXYZ(i, 0, -1e5, 0);
    });
    ps.needsUpdate = ry.needsUpdate = true;
    const lf = t >= L.delay_ns - 4 && t < L.delay_ns + 14 ? 1 - Math.abs(t - L.delay_ns - 3) / 12 : 0;
    this.uv.material.opacity = 0.55 * Math.max(0, lf); this.ir.material.opacity = 0.35 * Math.max(0, lf); this.lblLaser.visible = lf > 0;
  }
  // Full H̄ shot runs: the Monte-Carlo positronium and H̄ drawn on the G4beamline run's own clock (t in ns)
  overlay(t, prm) {
    const A = this.anim, imp = +prm?.positronArrival, th = +prm?.hbarTime;
    if (!prm || !Number.isFinite(imp) || !Number.isFinite(th) || t >= 1e9 || t < imp - 5 || t > th + 900) { A.visible = false; if (this.lblHbar) this.lblHbar.visible = false; return false; }
    const hide = (pts) => { const a = pts.geometry.attributes.position; for (let i = 0; i < a.count; i++) a.setXYZ(i, 0, -1e5, 0); a.needsUpdate = true; };
    A.visible = true; this.cloud.visible = false; this.lblCloud.visible = false; this.hits.visible = false;
    this.beta.visible = this.slowE.visible = this.eBunch.visible = false; this.srcGlow.material.opacity = this.accGlow.material.opacity = 0;
    hide(this.hb);
    const tp = t - imp;
    this.psAt(tp);
    this.flash.material.opacity = 0;
    if (tp >= 0 && tp < 40) { this.flash.position.set(this.h.converter.z_face, 0, 0); this.flash.scale.setScalar(25); this.flash.material.opacity = 1 - tp / 40; }
    const dh = t - th;
    if (!this.lblHbar) this.lblHbar = label(A, "H̄ forms (Ps* + p̄ → H̄* + e⁻)", S(this.h.hbar.cloud_z, 14), "lbl hb strong");
    this.lblHbar.visible = dh >= 0 && dh < 600;
    if (dh >= 0 && dh < 300) { this.flash.position.set(this.h.hbar.cloud_z, 0, 0); this.flash.scale.setScalar(18 + 60 * (dh / 300)); this.flash.material.opacity = 0.9 * (1 - dh / 300); }
    return true;
  }
  camera(ch, p) {
    const h = this.h, c = h.converter.z_face, e = (x) => x * x * (3 - 2 * x);
    if (ch === 0) {
      if (p < 0.22) { const q = this.srcGlow.position.clone().lerp(this.accGlow.position, e(Math.min(1, p / 0.22)) * 0.6); return { t: q.clone(), c: q.clone().add(new THREE.Vector3(-300, 450, 1400)) }; }
      if (p < 0.45) { const q = this.ePath.getPointAt(this.sAcc1 + (1 - this.sAcc1) * e(Math.min(1, (p - 0.22) / 0.23))); return { t: q.clone().add(new THREE.Vector3(150, -100, 0)), c: q.clone().add(new THREE.Vector3(-700, 520, 1500)) }; }
      const k = e(Math.min(1, (p - 0.45) / 0.15));
      const far = { t: new THREE.Vector3(c - 300, 0, 0), c: new THREE.Vector3(c - 1000, 500, 1300) }, near = { t: new THREE.Vector3(c - 18, 0, 0), c: new THREE.Vector3(c - 40, 26, 78) };
      return { t: far.t.clone().lerp(near.t, k), c: far.c.clone().lerp(near.c, k) };
    }
    const M = h.moire, k = e(Math.min(1, p / 0.7));
    const a = { t: new THREE.Vector3(h.hbar.cloud_z, 0, 0), c: new THREE.Vector3(h.hbar.cloud_z - 30, 40, 110) };
    const b = { t: new THREE.Vector3((M.g1_z + M.det_z) / 2, 0, 0), c: new THREE.Vector3(M.g1_z - 300, 420, 1100) };
    const d = { t: new THREE.Vector3(M.det_z, 0, 0), c: new THREE.Vector3(M.det_z + 160, 40, 90) };
    if (p < 0.7) return { t: a.t.clone().lerp(b.t, k), c: a.c.clone().lerp(b.c, k) };
    const k2 = e((p - 0.7) / 0.3); return { t: b.t.clone().lerp(d.t, k2), c: b.c.clone().lerp(d.c, k2) };
  }
}
