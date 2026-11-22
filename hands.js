// Webcam hand control for the event display.
// MediaPipe Hand Landmarker (vendor/mediapipe, Apache-2.0) tracks 21 points per hand on the visitor's own
// computer; nothing leaves the browser. This module turns those points into gestures and gesture events.
//
// Landmarks: 0 wrist · 1-4 thumb · 5-8 index · 9-12 middle · 13-16 ring · 17-20 little (tip = 4, 8, 12, 16, 20).

const BASE = new URL("./vendor/mediapipe/", import.meta.url).href;
const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- static hand poses (one frame)
export function pose(lm) {
  const scale = D(lm[0], lm[9]) || 1e-3;                       // wrist -> middle knuckle: hand size in the image
  const ext = (tip, pip) => D(lm[tip], lm[0]) > D(lm[pip], lm[0]) * 1.12;   // finger straight: tip beyond its PIP joint
  const index = ext(8, 6), middle = ext(12, 10), ring = ext(16, 14), little = ext(20, 18);
  const pinch = D(lm[4], lm[8]) / scale;                       // thumb tip <-> index tip
  const thumbOut = D(lm[4], lm[5]) / scale > 0.75;
  const thumbUp = thumbOut && lm[4].y < lm[3].y && lm[3].y < lm[2].y && (lm[2].y - lm[4].y) / scale > 0.45;
  const curled = !index && !middle && !ring && !little;
  let name = "none";
  // a pinch needs the index tip out beyond its knuckle; in a fist the tucked thumb also touches the index finger
  const indexOut = D(lm[8], lm[0]) > D(lm[5], lm[0]) * 1.0;
  if (pinch < 0.32 && indexOut) name = "pinch";
  else if (curled && thumbUp) name = "thumbsup";
  else if (curled && !thumbOut) name = "fist";
  else if (index && middle && !ring && !little) name = "vsign";
  else if (index && !middle && !ring && !little) name = "point";
  else if (index && middle && ring && little) name = "open";
  return { name, pinch, scale, cursor: { x: lm[8].x, y: lm[8].y }, pinchPt: { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 } };
}

// ---------------------------------------------------------------- gestures over time
// Emits: {type:"rotate", dx, dy} · {type:"zoom", k} · {type:"time", u} · {type:"cursor", x, y, visible}
//        {type:"hold", gesture, progress} (0..1 while held) · {type:"fire", gesture} (point / fist / thumbsup / open)
//        {type:"status", text}
// Coordinates are mirrored (selfie view) and normalised to 0..1 of the camera image.
export class GestureEngine {
  constructor(emit) { this.emit = emit; this.prev = {}; this.hold = null; this.cool = 0; this.stable = {}; }
  static HOLD = { point: 0.8, fist: 1.1, thumbsup: 0.6, open: 1.0 };
  update(hands, t) {                               // hands: [{lm, side}] ; t in seconds
    const P = hands.map((h) => ({ ...pose(h.lm.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }))), side: h.side }));
    // debounce: a pose must be seen on 3 consecutive frames before it counts
    P.forEach((p, i) => { const k = "h" + i; const s = this.stable[k] || { name: "none", cand: "none", n: 0 };
      if (p.name === s.cand) s.n++; else { s.cand = p.name; s.n = 1; } if (s.n >= 3) s.name = s.cand; this.stable[k] = s; p.name = s.name; });
    for (const k of Object.keys(this.stable)) if (+k.slice(1) >= P.length) delete this.stable[k];
    const pinches = P.filter((p) => p.name === "pinch");
    const lead = P[0];
    this.emit({ type: "cursor", visible: !!lead, x: lead?.cursor.x, y: lead?.cursor.y, pose: lead?.name || "none", hands: P.length });
    // two hands pinching: zoom by the change of their distance
    if (pinches.length >= 2) {
      const d = D(pinches[0].pinchPt, pinches[1].pinchPt);
      if (this.prev.zoomD) this.emit({ type: "zoom", k: d / this.prev.zoomD });
      this.prev = { zoomD: d }; this.clearHold(); this.emit({ type: "status", text: "🤏🤏 Zoom" }); return;
    }
    // one hand pinching: rotate by its motion
    if (pinches.length === 1) {
      const q = pinches[0].pinchPt;
      if (this.prev.rot) this.emit({ type: "rotate", dx: q.x - this.prev.rot.x, dy: q.y - this.prev.rot.y });
      this.prev = { rot: q }; this.clearHold(); this.emit({ type: "status", text: "🤏 Rotate" }); return;
    }
    // V sign: hand position left -> right scrubs time
    if (lead && lead.name === "vsign") {
      this.prev = {}; this.clearHold();
      const u = Math.min(1, Math.max(0, (lead.cursor.x - 0.2) / 0.6));
      this.emit({ type: "time", u }); this.emit({ type: "status", text: `✌️ Time ${(u * 100).toFixed(0)} %` }); return;
    }
    this.prev = {};
    // held poses fire once after their hold time, then cool down
    const g = lead && GestureEngine.HOLD[lead.name] ? lead.name : null;
    if (t < this.cool || !g) { this.clearHold(); this.emit({ type: "status", text: lead ? { point: "👉 Point", open: "✋ Hand", fist: "✊", thumbsup: "👍" }[lead.name] || "✋ Hand" : "Show a hand" }); return; }
    if (!this.hold || this.hold.g !== g) this.hold = { g, t0: t };
    const prog = Math.min(1, (t - this.hold.t0) / GestureEngine.HOLD[g]);
    this.emit({ type: "hold", gesture: g, progress: prog, x: lead.cursor.x, y: lead.cursor.y });
    if (prog >= 1) { this.emit({ type: "fire", gesture: g, x: lead.cursor.x, y: lead.cursor.y }); this.hold = null; this.cool = t + 1.2; }
  }
  clearHold() { if (this.hold) this.emit({ type: "hold", gesture: null, progress: 0 }); this.hold = null; }
}

// ---------------------------------------------------------------- camera + tracker
export class HandControl {
  constructor({ video, canvas, emit, onStatus }) { Object.assign(this, { video, canvas, emit, onStatus }); this.engine = new GestureEngine(emit); this.running = false; }
  async start() {
    this.onStatus?.("Loading the hand model…");
    const { FilesetResolver, HandLandmarker } = await import(BASE + "vision_bundle.mjs");
    const files = await FilesetResolver.forVisionTasks(BASE + "wasm");
    const make = (delegate) => HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: BASE + "hand_landmarker.task", delegate }, runningMode: "VIDEO", numHands: 2,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.5 });
    try { this.tracker = await make("GPU"); } catch { this.tracker = await make("CPU"); }
    this.onStatus?.("Waiting for the camera…");
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
    this.video.srcObject = this.stream; await this.video.play();
    this.running = true; this.last = -1; this.onStatus?.("Show a hand to the camera");
    const loop = () => { if (!this.running) return; this.tick(); this.raf = requestAnimationFrame(loop); };
    loop();
  }
  tick() {
    const v = this.video, now = performance.now();
    if (v.readyState < 2 || v.currentTime === this.last || now - (this.lastRun || 0) < 30) return;     // ~30 fps is plenty
    this.last = v.currentTime; this.lastRun = now;
    const r = this.tracker.detectForVideo(v, now);
    const hands = (r.landmarks || []).map((lm, i) => ({ lm: this.smooth(i, lm), side: r.handedness?.[i]?.[0]?.categoryName }));
    this.draw(hands);
    this.engine.update(hands, now / 1000);
  }
  smooth(i, lm) {                                 // light exponential smoothing against jitter
    const prev = (this._s ||= [])[i], a = 0.55;
    const out = prev && prev.length === lm.length ? lm.map((p, k) => ({ x: prev[k].x + a * (p.x - prev[k].x), y: prev[k].y + a * (p.y - prev[k].y), z: p.z })) : lm.map((p) => ({ ...p }));
    this._s[i] = out; return out;
  }
  draw(hands) {
    const c = this.canvas, g = c.getContext("2d"), W = (c.width = c.clientWidth * devicePixelRatio), H = (c.height = c.clientHeight * devicePixelRatio);
    g.save(); g.clearRect(0, 0, W, H); g.translate(W, 0); g.scale(-1, 1);       // selfie view
    g.globalAlpha = 0.85; g.drawImage(this.video, 0, 0, W, H); g.globalAlpha = 1;
    const B = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
    hands.forEach((h, i) => {
      g.strokeStyle = i ? "#ff9f0a" : "#64d2ff"; g.lineWidth = 2.2 * devicePixelRatio; g.beginPath();
      B.forEach(([a, b]) => { g.moveTo(h.lm[a].x * W, h.lm[a].y * H); g.lineTo(h.lm[b].x * W, h.lm[b].y * H); }); g.stroke();
      g.fillStyle = "#fff"; [4, 8, 12, 16, 20].forEach((k) => { g.beginPath(); g.arc(h.lm[k].x * W, h.lm[k].y * H, 3 * devicePixelRatio, 0, 7); g.fill(); });
    });
    g.restore();
  }
  stop() {
    this.running = false; cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    try { this.tracker?.close(); } catch {} this.tracker = null;
  }
}
