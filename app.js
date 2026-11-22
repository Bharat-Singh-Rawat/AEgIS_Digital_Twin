/* AEgIS Digital Twin - front end */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (path, body) => {
  if (window.TWIN_STATIC) return window.TWIN_STATIC(path, body);   // static (GitHub Pages) build: see export_static.py
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("twin." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("twin." + k, JSON.stringify(v)); } catch {} },
};
const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200); };
const fmt = (v, d = 3) => (Math.abs(v) >= 1000 ? v.toFixed(0) : (+v).toFixed(d));

const S = { state: null, currents: {}, voltages: {}, page: "overview", runs: [], selRun: null, cmpRuns: new Set(), beams: [], elFilter: "All" };

/* ---------------- theme ---------------- */
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = t;
  $$("#theme-seg button").forEach((b) => b.classList.toggle("on", b.dataset.v === t));
  store.set("theme", t);
  setTimeout(redrawAll, 30);
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => redrawAll());

function layout(extra = {}) {
  const grid = css("--sep"), txt = css("--text"), mut = css("--muted");
  return Object.assign({
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: css("--font"), size: 12, color: txt },
    margin: { l: 52, r: 16, t: 10, b: 40 }, hovermode: "x unified",
    hoverlabel: { bgcolor: css("--card-solid"), bordercolor: css("--sep2"), font: { color: txt } },
    xaxis: { gridcolor: grid, zerolinecolor: grid, linecolor: grid, tickcolor: grid, color: mut },
    yaxis: { gridcolor: grid, zerolinecolor: css("--sep2"), linecolor: grid, tickcolor: grid, color: mut },
    legend: { orientation: "h", y: 1.12, x: 0, bgcolor: "rgba(0,0,0,0)" },
    modebar: { bgcolor: "rgba(0,0,0,0)", color: mut, activecolor: css("--accent") },
  }, extra);
}
const PCONF = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"] };
const plot = (id, data, lay) => Plotly.react(id, data, layout(lay), PCONF);
const COLORS = () => [css("--accent"), css("--orange"), css("--green"), css("--purple"), css("--red"), css("--teal")];

/* ---------------- navigation ---------------- */
function go(page) {
  if (!document.getElementById("page-" + page)) page = "overview";
  S.page = page; store.set("page", page); if (location.hash.slice(1) !== page) history.replaceState(null, "", "#" + page);
  $$("nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + page));
  setTimeout(() => { redrawAll(); $$(".page.active .js-plotly-plot").forEach((p) => Plotly.Plots.resize(p)); }, 20);
  if (page === "results") refreshRuns();
  if (page === "simulate") { refreshBeams(); updateRunSummary(); }
  if (page === "beam") refreshBeams();
  if (page === "display") initDisplay();
  if (page === "surrogate") { if (!S._sgInit) { S._sgInit = true; sgRender(); } sgRefresh(); }
}
$$("nav a").forEach((a) => a.addEventListener("click", () => go(a.dataset.page)));

function seg(id, onChange) {
  const el = $(id);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", el).forEach((x) => x.classList.toggle("on", x === b));
    onChange && onChange(b.dataset.v);
  });
  return () => $("button.on", el)?.dataset.v;
}

/* ---------------- field computation ---------------- */
function fieldB() {
  const st = S.state, n = st.zB.length;
  const bz = new Float64Array(n), bz10 = new Float64Array(n), br10 = new Float64Array(n);
  for (const c of st.coils) {
    const I = S.currents[c.id] ?? c.default;
    if (!I) continue;
    for (let i = 0; i < n; i++) { bz[i] += I * c.bz0[i]; bz10[i] += I * c.bz10[i]; br10[i] += I * c.br10[i]; }
  }
  return { bz, bz10, br10 };
}
function fieldV() {
  const st = S.state, n = st.zE.length, V = new Float64Array(n);
  for (const e of st.electrodes) {
    const v = S.voltages[e.id] ?? e.default;
    if (!v) continue;
    for (let i = 0; i < n; i++) V[i] += v * e.phi[i];
  }
  const Ez = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) Ez[i] = -(V[i + 1] - V[i - 1]) / (st.zE[i + 1] - st.zE[i - 1]); // V/mm
  return { V, Ez };
}
const interp = (zs, ys, z) => {
  let i = zs.findIndex((x) => x >= z); if (i <= 0) return ys[Math.max(i, 0)];
  const t = (z - zs[i - 1]) / (zs[i] - zs[i - 1]); return ys[i - 1] + t * (ys[i] - ys[i - 1]);
};
const electrodeShapes = (ymin, ymax, alpha = 0.07) => S.state.electrodes.map((e) => ({
  type: "rect", xref: "x", yref: "paper", x0: e.z0, x1: e.z1, y0: 0, y1: 1, fillcolor: css("--muted"), opacity: alpha, line: { width: 0 }, layer: "below" }));

/* ---------------- magnets page ---------------- */
function rangeFor(c) { return c.group === "Main" ? [0, 200] : [-30, 30]; }
function buildCoils() {
  const host = $("#coil-groups"); host.innerHTML = "";
  const groups = [...new Set(S.state.coils.map((c) => c.group))];
  for (const g of groups) {
    host.insertAdjacentHTML("beforeend", `<div class="group-title">${g}</div>`);
    const card = document.createElement("div"); card.className = "card flush coil-list";
    for (const c of S.state.coils.filter((c) => c.group === g)) {
      const [lo, hi] = rangeFor(c);
      const row = document.createElement("div"); row.className = "coil";
      row.innerHTML = `<div class="nm">${c.id}<small>${c.cst.replaceAll("_", " ")} · z ${c.zc.toFixed(0)} mm</small></div>
        <input type="range" min="${lo}" max="${hi}" step="${g === "Main" ? 0.1 : 0.01}">
        <span class="unit" data-u="A"><input type="number" step="0.01"></span>
        <button class="reset" title="Reset to ${c.default} A">↺</button>`;
      const [rg, num, rs] = [$("input[type=range]", row), $("input[type=number]", row), $(".reset", row)];
      const set = (v, from) => {
        v = +v; S.currents[c.id] = v; if (from !== "r") rg.value = v; if (from !== "n") num.value = v;
        rg.style.setProperty("--p", ((v - lo) / (hi - lo)) * 100 + "%"); scheduleMag();
      };
      rg.addEventListener("input", () => set(rg.value, "r"));
      num.addEventListener("change", () => set(num.value, "n"));
      rs.addEventListener("click", () => set(c.default));
      row._set = set; c._row = row;
      set(S.currents[c.id] ?? c.default);
      card.appendChild(row);
    }
    host.appendChild(card);
  }
}
let magT; const scheduleMag = () => { cancelAnimationFrame(magT); magT = requestAnimationFrame(drawMag); store.set("currents", S.currents); sgSchedule(); };
function drawMag() {
  if (!S.state || S.page !== "magnets" && S.page !== "overview") return;
  const z = S.state.zB, { bz, bz10, br10 } = fieldB();
  const tr = [{ x: z, y: [...bz], name: "Bz on axis", line: { color: css("--accent"), width: 2.4 }, hovertemplate: "%{y:.4f} T" }];
  if ($("#mag-r10").checked) {
    tr.push({ x: z, y: [...bz10], name: "Bz, r=10 mm", line: { color: css("--teal"), width: 1.5, dash: "dot" }, hovertemplate: "%{y:.4f} T" });
    tr.push({ x: z, y: [...br10], name: "Br, r=10 mm", line: { color: css("--green"), width: 1.5 }, hovertemplate: "%{y:.4f} T" });
  }
  if ($("#mag-ref").checked) tr.push({ x: S.state.rom_axis.z, y: S.state.rom_axis.bz_default, name: "CST ROM nominal", mode: "lines",
    line: { color: css("--muted"), width: 1.2, dash: "dash" }, hovertemplate: "%{y:.4f} T" });
  if (S.page === "magnets") plot("pl-mag", tr, { xaxis: { ...layout().xaxis, title: "z (CST frame) [mm]" }, yaxis: { ...layout().yaxis, title: "B [T]" }, shapes: electrodeShapes() });
  const at = (zz) => interp(z, bz, zz);
  let pk = 0; for (const v of bz) pk = Math.max(pk, v);
  const C0 = S.state.frame.offset;
  $("#mag-tiles").innerHTML = [
    ["5 T region (z −728)", at(-728), "T"], ["1 T trap (z 300)", at(300), "T"], ["At C0 entrance", at(C0), "T"],
    ["Peak Bz", pk, "T"], ["Upstream z −1400", at(-1400), "T"],
  ].map(([l, v, u]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v.toFixed(3)}<small>${u}</small></div></div>`).join("");
}
$("#mag-ref").addEventListener("change", drawMag); $("#mag-r10").addEventListener("change", drawMag);
$("#mag-reset").addEventListener("click", () => { S.state.coils.forEach((c) => c._row._set(c.default)); toast("Magnets reset to nominal"); });
$("#mag-zero").addEventListener("click", () => { S.state.coils.forEach((c) => c.group !== "Main" && c._row._set(0)); toast("Correctors set to 0 A"); });

/* ---------------- electrodes page ---------------- */
const elRange = (e) => (e.group === "HV" ? [-15000, 15000] : [-500, 500]);
function buildElectrodes() {
  const groups = ["All", ...new Set(S.state.electrodes.map((e) => e.group))];
  $("#el-filter").innerHTML = groups.map((g) => `<button data-v="${g}" class="${g === S.elFilter ? "on" : ""}">${g}</button>`).join("");
  const grid = $("#el-grid"); grid.innerHTML = "";
  for (const e of S.state.electrodes) {
    const [lo, hi] = elRange(e);
    const d = document.createElement("div"); d.className = "el"; d.dataset.g = e.group;
    d.innerHTML = `<div class="top"><div><b>${e.id}</b><span class="z">z ${e.z0.toFixed(0)} … ${e.z1.toFixed(0)}</span></div><span class="unit" data-u="V"><input type="number" step="0.1"></span></div>
      <input type="range" min="${lo}" max="${hi}" step="${e.group === "HV" ? 10 : 0.5}">`;
    const [num, rg] = [$("input[type=number]", d), $("input[type=range]", d)];
    const set = (v, from) => {
      v = +v; S.voltages[e.id] = v; if (from !== "r") rg.value = v; if (from !== "n") num.value = v;
      rg.style.setProperty("--p", ((v - lo) / (hi - lo)) * 100 + "%"); d.classList.toggle("mod", v !== e.default); scheduleEl();
    };
    rg.addEventListener("input", () => set(rg.value, "r"));
    num.addEventListener("change", () => set(num.value, "n"));
    d.addEventListener("dblclick", (ev) => { if (ev.target.tagName !== "INPUT") set(e.default); });
    e._el = d; e._set = set; set(S.voltages[e.id] ?? e.default);
    grid.appendChild(d);
  }
  filterEl();
  const s = S.state.electrodes[0].source;
  $("#el-source").textContent = "Basis: " + s + (s.startsWith("FD") ? " — stand-in until CST exports are imported (Overview → Rebuild)." : "");
}
function filterEl() { $$("#el-grid .el").forEach((d) => (d.style.display = S.elFilter === "All" || d.dataset.g === S.elFilter ? "" : "none")); }
seg("#el-filter", (v) => { S.elFilter = v; filterEl(); });
let elT; const scheduleEl = () => { cancelAnimationFrame(elT); elT = requestAnimationFrame(drawEl); store.set("voltages", S.voltages); sgSchedule(); };
function drawEl() {
  if (!S.state || S.page !== "electrodes") return;
  const z = S.state.zE, { V, Ez } = fieldV();
  plot("pl-el", [
    { x: z, y: [...V], name: "Φ on axis [V]", line: { color: css("--accent"), width: 2.4 }, hovertemplate: "%{y:.2f} V" },
    { x: z, y: [...Ez].map((v) => v * 10), name: "Ez on axis [V/cm]", yaxis: "y2", line: { color: css("--orange"), width: 1.3 }, hovertemplate: "%{y:.2f} V/cm" },
    { x: S.state.electrodes.flatMap((e) => [e.z0, e.z1, null]), y: S.state.electrodes.flatMap((e) => { const v = S.voltages[e.id] ?? e.default; return [v, v, null]; }),
      name: "electrode V", mode: "lines", line: { color: css("--muted"), width: 3 }, hoverinfo: "skip" },
  ], { xaxis: { ...layout().xaxis, title: "z (CST frame) [mm]" }, yaxis: { ...layout().yaxis, title: "Φ [V]" },
       yaxis2: { overlaying: "y", side: "right", color: css("--orange"), showgrid: false, zeroline: false, title: "Ez [V/cm]" }, margin: { l: 52, r: 56, t: 10, b: 40 } });
  // strip
  const zmin = z[0], zmax = z[z.length - 1], vmax = Math.max(1, ...S.state.electrodes.map((e) => Math.abs(S.voltages[e.id] ?? e.default)));
  $("#el-strip").innerHTML = S.state.electrodes.map((e) => {
    const v = S.voltages[e.id] ?? e.default, a = Math.min(1, Math.abs(v) / vmax);
    const col = v < 0 ? `rgba(10,132,255,${0.15 + 0.85 * a})` : v > 0 ? `rgba(255,69,58,${0.15 + 0.85 * a})` : "transparent";
    return `<div data-id="${e.id}" title="${e.id}: ${v} V" style="left:${((e.z0 - zmin) / (zmax - zmin)) * 100}%;width:${((e.z1 - e.z0) / (zmax - zmin)) * 100}%;background:${col}"></div>`;
  }).join("");
  let wmin = Infinity, zw = 0; for (let i = 0; i < z.length; i++) if (V[i] < wmin) { wmin = V[i]; zw = z[i]; }
  const changed = S.state.electrodes.filter((e) => (S.voltages[e.id] ?? e.default) !== e.default).length;
  $("#el-tiles").innerHTML = [["Deepest point on axis", wmin.toFixed(1), "V"], ["at z", zw.toFixed(0), "mm"],
    ["Max |Ez| on axis", (Math.max(...Ez.map(Math.abs)) * 10).toFixed(1), "V/cm"], ["Changed from nominal", changed, `/ ${S.state.electrodes.length}`]]
    .map(([l, v, u]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}<small>${u}</small></div></div>`).join("");
}
$("#el-strip").addEventListener("click", (ev) => {
  const id = ev.target.dataset.id; if (!id) return;
  const e = S.state.electrodes.find((x) => x.id === id);
  S.elFilter = "All"; $$("#el-filter button").forEach((b) => b.classList.toggle("on", b.dataset.v === "All")); filterEl();
  e._el.scrollIntoView({ behavior: "smooth", block: "center" }); e._el.classList.add("flash"); setTimeout(() => e._el.classList.remove("flash"), 1200);
  $("input[type=number]", e._el).focus();
});
$("#el-reset").addEventListener("click", () => { S.state.electrodes.forEach((e) => e._set(e.default)); toast("Electrodes reset to nominal"); });
$("#el-zero").addEventListener("click", () => { S.state.electrodes.forEach((e) => e._set(0)); toast("All electrodes at 0 V"); });

/* ---------------- beam page ---------------- */
const beamMode = seg("#beam-mode", (v) => { $("#beam-gauss").hidden = v !== "gauss"; $("#beam-xsuite").hidden = v !== "xsuite"; $("#b-name").value = v === "gauss" ? "gauss_100keV" : "xsuite_lne02"; });
$("#btn-beam").addEventListener("click", async () => {
  $("#beam-err").textContent = ""; const btn = $("#btn-beam"); btn.disabled = true;
  try {
    let upload = null;
    const f = $("#x-file").files[0];
    if (beamMode() === "xsuite" && f) {
      $("#beam-err").textContent = `Uploading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`;
      const r = await fetch("/api/upload?name=" + encodeURIComponent(f.name.replace(/[^A-Za-z0-9_.-]/g, "_")), { method: "POST", body: f });
      const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || r.statusText);
      upload = j.upload; $("#beam-err").textContent = "";
    }
    const req = { name: $("#b-name").value.trim(), mode: beamMode(), upload, z_delivery: $("#b-zdel").value, z_start: $("#b-zst").value,
      npz: $("#x-npz").value.trim(),
      gauss: { n: $("#g-n").value, ke_kev: $("#g-ke").value, sx: $("#g-sx").value, sxp: $("#g-sxp").value, sy: $("#g-sy").value, syp: $("#g-syp").value, sdelta: $("#g-sd").value } };
    const st = await api("/api/beam", req);
    toast(`Beam ${st.file} · ${st.n} antiprotons`);
    await refreshBeams(st.file); showBeam(st);
  } catch (e) { $("#beam-err").textContent = e.message; } finally { btn.disabled = false; }
});
async function refreshBeams(select) {
  S.beams = await api("/api/beams");
  const opts = S.beams.map((b) => `<option value="${b.file}">${b.file} (${b.n})</option>`).join("");
  const bs = $("#beam-select"); const prev = select || bs.value;
  bs.innerHTML = opts || `<option value="">no beams yet</option>`; if (prev) bs.value = prev;
  const rb = $("#r-beam"), rprev = rb.value || store.get("runBeam", "");
  rb.innerHTML = `<option value="">Built-in Gaussian (g4bl defaults)</option>` + opts; rb.value = S.beams.some((b) => b.file === rprev) ? rprev : "";
  if (S.page === "beam" && bs.value && !select) showBeam(await api("/api/beam/" + encodeURIComponent(bs.value)));
}
$("#beam-select").addEventListener("change", async (e) => e.target.value && showBeam(await api("/api/beam/" + encodeURIComponent(e.target.value))));
function showBeam(st) {
  S.lastBeam = st;
  $("#beam-tiles").innerHTML = [["Particles", st.n, ""], ["Kinetic energy", st.ke_kev.toFixed(1), "keV"], ["σx / σy", `${st.sx.toFixed(2)} / ${st.sy.toFixed(2)}`, "mm"],
    ["σx′ / σy′", `${(st.sxp * 1e3).toFixed(2)} / ${(st.syp * 1e3).toFixed(2)}`, "mrad"], ["Start plane z", st.z.toFixed(0), "mm"]]
    .map(([l, v, u]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}<small>${u}</small></div></div>`).join("");
  const sc = (x, y, xt, yt, c) => [[{ x, y, mode: "markers", type: "scattergl", marker: { size: 3, color: c, opacity: 0.55 }, hoverinfo: "skip" }],
    { hovermode: false, margin: { l: 44, r: 8, t: 6, b: 36 }, xaxis: { ...layout().xaxis, title: xt }, yaxis: { ...layout().yaxis, title: yt }, showlegend: false }];
  plot("pl-xxp", ...sc(st.x, st.xp, "x [mm]", "x′ [mrad]", css("--accent")));
  plot("pl-yyp", ...sc(st.y, st.yp, "y [mm]", "y′ [mrad]", css("--orange")));
  plot("pl-xy", ...sc(st.x, st.y, "x [mm]", "y [mm]", css("--purple")));
}

/* ---------------- simulate page ---------------- */
const rMag = seg("#r-mag", updateRunSummary), rEf = seg("#r-ef", updateRunSummary);
$("#r-beam").addEventListener("change", () => { store.set("runBeam", $("#r-beam").value); updateRunSummary(); });
$("#r-n").addEventListener("input", updateRunSummary); $("#r-trace").addEventListener("input", updateRunSummary);
function runRequestBase() {
  const currents = {}, voltages = {};
  S.state.coils.forEach((c) => (currents[c.id] = S.currents[c.id] ?? c.default));
  S.state.electrodes.forEach((e) => (voltages[e.id] = S.voltages[e.id] ?? e.default));
  return { name: $("#r-name").value.trim(), nEvents: +$("#r-n").value, magnetModel: +rMag(), efieldModel: +rEf(),
    beam: $("#r-beam").value ? { file: $("#r-beam").value } : null, currents, voltages, traceEvents: +$("#r-trace").value || 0 };
}
function runRequest() {
  const r = runRequestBase();
  return $("#c-deg") ? catchRequest(r) : r;
}
function updateRunSummary() {
  if (!S.state) return;
  const r = runRequest();
  const dC = S.state.coils.filter((c) => r.currents[c.id] !== c.default), dV = S.state.electrodes.filter((e) => r.voltages[e.id] !== e.default);
  const chips = [[`${r.nEvents} events`, 1], [r.traceEvents ? `3D tracks: ${Math.min(r.traceEvents, r.nEvents)} events` : "no 3D tracks", 1], [r.magnetModel ? "B: CST ROM maps" : "B: analytic solenoids", 1],
    [["E: off", "E: ROM maps", "E: analytic well"][r.efieldModel], 1], [r.beam ? `beam: ${r.beam.file}` : "beam: built-in Gaussian", 1]];
  dC.forEach((c) => chips.push([`I_${c.id}=${r.currents[c.id]}`, 0])); dV.forEach((e) => chips.push([`V_${e.id}=${r.voltages[e.id]}`, 0]));
  chips.splice(1, 0, [`degrader ${r.degraderThickness ?? "?"} µm`, 1], [`track ${((r.maxTime || 10000) / 1000).toFixed(1)} µs`, 1]);
  if (r.pulse) chips.splice(3, 0, [`${r.pulse.electrode} pulse → ${(r.voltages[r.pulse.electrode] / 1000).toFixed(1)} kV at ${r.pulse.t0} ns`, 1]);
  if (!dC.length && !dV.length) chips.push(["all currents and voltages nominal", 0]);
  $("#run-summary").innerHTML = chips.map(([t, h]) => `<span class="chip ${h ? "hl" : ""}">${t}</span>`).join("");
  if (!r.magnetModel && dC.length) $("#run-summary").insertAdjacentHTML("beforeend", `<p class="muted small" style="width:100%">Note: coil currents only act on the CST ROM maps; the analytic model uses its own fixed current densities.</p>`);
}
$("#btn-run").addEventListener("click", async () => {
  $("#run-err").textContent = "";
  if (!$("#r-name").value.trim()) $("#r-name").value = "run_" + new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "");
  try { const r = await api("/api/run", runRequest()); toast(r.queued ? `Queued ${r.name}: waiting for a free slot` : `Started ${r.name}`); $("#r-name").value = ""; await refreshRuns(); }
  catch (e) { $("#run-err").textContent = e.message; }
});
async function refreshScenarios() { const l = await api("/api/scenarios"); $("#sc-list").innerHTML = l.map((n) => `<option>${n}</option>`).join("") || "<option value=''>none saved</option>"; }
$("#sc-save").addEventListener("click", async () => {
  const name = $("#sc-name").value.trim(); if (!name) return toast("Give the scenario a name");
  try { await api("/api/scenario", { ...runRequest(), name }); toast(`Scenario “${name}” saved`); refreshScenarios(); } catch (e) { toast(e.message); }
});
$("#sc-load").addEventListener("click", async () => {
  const n = $("#sc-list").value; if (!n) return;
  const sc = await api("/api/scenario/" + encodeURIComponent(n));
  S.state.coils.forEach((c) => c._row._set(sc.currents?.[c.id] ?? c.default));
  S.state.electrodes.forEach((e) => e._set(sc.voltages?.[e.id] ?? e.default));
  $("#r-n").value = sc.nEvents || 1000;
  $$("#r-mag button").forEach((b) => b.classList.toggle("on", +b.dataset.v === sc.magnetModel));
  $$("#r-ef button").forEach((b) => b.classList.toggle("on", +b.dataset.v === sc.efieldModel));
  if (sc.degraderThickness != null) $("#c-deg").value = sc.degraderThickness;
  if (sc.maxTime) $("#c-time").value = sc.maxTime / 1000;
  $("#c-on").checked = !!sc.pulse;
  if (sc.pulse) { $("#c-el").value = sc.pulse.electrode; $("#c-t0").value = sc.pulse.t0; $("#c-rise").value = sc.pulse.rise; $("#c-open").value = sc.pulse.open || 0;
    $("#c-v").value = (sc.voltages?.[sc.pulse.electrode] ?? -14000) / 1000; }
  catchChanged(); updateRunSummary(); toast(`Loaded “${n}”`);
});

/* ---------------- degrader & catching ---------------- */
const DEG_SCAN = [[0, 100], [0.2, 84.9], [0.6, 56.4], [0.9, 36.2], [1.1, 24.3], [1.3, 14.7], [1.5, 8.5], [1.8, 5.5], [2.2, 2.5]];   // µm -> median exit keV (G4beamline scan)
const degKE = (t) => { for (let i = 1; i < DEG_SCAN.length; i++) if (t <= DEG_SCAN[i][0]) { const [a, ka] = DEG_SCAN[i - 1], [b, kb] = DEG_SCAN[i]; return ka + ((kb - ka) * (t - a)) / (b - a); } return 1; };
function initCatching() {
  const hv = S.state.electrodes.filter((e) => e.group === "HV");
  $("#c-el").innerHTML = hv.map((e) => `<option>${e.id}</option>`).join(""); $("#c-el").value = "HV1";
  $("#c-ref").innerHTML = `<option value="">— none —</option>` + hv.map((e) => `<option>${e.id}</option>`).join(""); $("#c-ref").value = "HV2";
  const saved = store.get("catch", null);
  if (saved) for (const [id, v] of Object.entries(saved)) { const el = $("#" + id); if (!el) continue; if (el.type === "checkbox") el.checked = v; else el.value = v; }
  ["#c-deg", "#c-time", "#c-on", "#c-el", "#c-v", "#c-t0", "#c-rise", "#c-open", "#c-ref", "#c-refv"].forEach((id) => $(id).addEventListener("input", catchChanged));
  $("#c-preset").addEventListener("click", () => {
    Object.entries({ "c-deg": 1.5, "c-time": 10, "c-el": "HV1", "c-v": -14, "c-t0": 450, "c-rise": 20, "c-open": 0, "c-ref": "HV2", "c-refv": -14 }).forEach(([k, v]) => ($("#" + k).value = v));
    $("#c-on").checked = true; catchChanged(); toast("Catching preset: 1.5 µm foil, HV2 −14 kV reflector, HV1 closes at 450 ns");
  });
  $("#c-dump").addEventListener("click", () => {
    Object.entries({ "c-deg": 1.5, "c-time": 10, "c-el": "HV1", "c-v": -14, "c-t0": 450, "c-rise": 20, "c-open": 5000, "c-ref": "HV2", "c-refv": -14 }).forEach(([k, v]) => ($("#" + k).value = v));
    $("#c-on").checked = true; catchChanged(); toast("Catch & dump: HV1 closes at 450 ns and reopens at 5 µs, so the trapped p̄ annihilate on the degrader");
  });
  catchChanged();
}
function catchChanged() {
  const on = $("#c-on").checked; $("#c-pulse").hidden = !on; $("#c-timing").hidden = !on;
  const t = +$("#c-deg").value, ke = degKE(t);
  $("#c-deg-hint").textContent = `≈ median p̄ energy after the foil: ${ke.toFixed(1)} keV  (0.2 µm ≈ 85 keV, 1.5 µm ≈ 8.5 keV, thicker foils stop more p̄ in the foil)`;
  const st = {}; ["c-deg", "c-time", "c-el", "c-v", "c-t0", "c-rise", "c-open", "c-ref", "c-refv"].forEach((k) => (st[k] = $("#" + k).value)); st["c-on"] = on; store.set("catch", st);
  if (on) drawPulseTimeline(ke);
  updateRunSummary(); if (typeof sgSchedule === "function") sgSchedule();
}
function drawPulseTimeline(ke) {
  const el = S.state.electrodes.find((e) => e.id === $("#c-el").value), ref = S.state.electrodes.find((e) => e.id === $("#c-ref").value);
  const v = (k) => 299.792458 * Math.sqrt((2 * k) / 938272);   // mm/ns for k keV
  const keFast = ke * 1.6, keSlow = Math.max(ke * 0.35, 0.5);
  const t0 = +$("#c-t0").value, rise = +$("#c-rise").value, open = +$("#c-open").value;
  const zFoil = -1069, dIn = el ? Math.abs((el.z0 + el.z1) / 2 - zFoil) : 50, dRef = ref && el ? Math.abs((ref.z0 + ref.z1) / 2 - (el.z0 + el.z1) / 2) : 0;
  const tSlowIn = dIn / v(keSlow), tFastBack = dRef ? (dIn + 2 * dRef) / v(keFast) : null;
  const tmax = Math.max(t0 * 1.6, (tFastBack || 0) * 1.4, open * 1.1, 800);
  const x = (t) => `${(100 * t) / tmax}%`;
  let html = `<div class="bar" style="left:${x(t0)};right:0;background:rgba(10,132,255,.18)"></div>`;
  if (open > t0) html = `<div class="bar" style="left:${x(t0)};width:calc(${x(open)} - ${x(t0)});background:rgba(10,132,255,.18)"></div>`;
  html += `<div class="ln" style="left:${x(tSlowIn)};background:var(--green)"></div><span class="lab" style="left:${x(tSlowIn)};top:20px">slow p̄ in · ${tSlowIn.toFixed(0)} ns</span>`;
  if (tFastBack) html += `<div class="ln" style="left:${x(tFastBack)};background:var(--orange)"></div><span class="lab" style="left:${x(tFastBack)};top:36px">fast p̄ back · ${tFastBack.toFixed(0)} ns</span>`;
  html += `<div class="ln" style="left:${x(t0)};background:var(--accent)"></div><span class="lab" style="left:${x(t0)}">${$("#c-el").value} closes · ${t0} ns</span>`;
  $("#c-timing").innerHTML = html;
  const ok = tFastBack ? t0 > tSlowIn && t0 + rise < tFastBack : t0 > tSlowIn;
  $("#c-timing").style.boxShadow = ok ? "inset 0 0 0 1.5px var(--green)" : "inset 0 0 0 1.5px var(--orange)";
  $("#c-timing").title = ok ? "Pulse closes after the slow p̄ entered and before the fast p̄ return" : "Timing may lose p̄: close after the slow ones are in and before the fast ones are back";
}
function catchRequest(r) {
  r.degraderThickness = +$("#c-deg").value; r.maxTime = +$("#c-time").value * 1000;
  if ($("#c-on").checked) {
    const el = $("#c-el").value;
    r.pulse = { electrode: el, t0: +$("#c-t0").value, rise: +$("#c-rise").value, open: +$("#c-open").value };
    r.voltages[el] = +$("#c-v").value * 1000;
    if ($("#c-ref").value) { r.voltages[$("#c-ref").value] = +$("#c-refv").value * 1000; r.reflector = $("#c-ref").value; }
  }
  return r;
}

/* ---------------- surrogate ---------------- */
const SG = { list: [], sel: null, info: null, out: "trapped", pred: null, knobs: [] };
const SG_PARAMS = { degraderThickness: ["Degrader thickness (µm)", 1.2, 1.8], pulseT0: ["Pulse close time t₀ (ns)", 250, 900],
  pulseV: ["Pulse voltage (V)", -16000, -8000], reflectorV: ["Reflector voltage (V)", -16000, -8000], KE: ["Beam energy (keV)", 80, 120] };
function sgDefaultRange(kind, id) {
  if (kind === "param") return SG_PARAMS[id].slice(1);
  const cur = kind === "coil" ? S.currents[id] ?? S.state.coils.find((c) => c.id === id)?.default ?? 0 : S.voltages[id] ?? S.state.electrodes.find((e) => e.id === id)?.default ?? 0;
  const span = kind === "coil" ? Math.max(Math.abs(cur) * 0.2, 2) : id.startsWith("HV") ? 2000 : Math.max(Math.abs(cur) * 0.3, 50);
  return [+(cur - span).toFixed(2), +(cur + span).toFixed(2)];
}
function sgRender() {
  const opt = (sel, list) => list.map(([v, t]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${t}</option>`).join("");
  $("#sg-knobs").innerHTML = SG.knobs.map((k, i) => `<div class="sg-knob" data-i="${i}">
    <select data-f="type">${opt(k.kind === "param" ? k.id : k.kind, [["coil", "Coil current"], ["electrode", "Electrode voltage"], ...Object.entries(SG_PARAMS).map(([id, v]) => [id, v[0]])])}</select>
    ${k.kind === "param" ? "<span></span>" : `<select data-f="id">${opt(k.id, (k.kind === "coil" ? S.state.coils : S.state.electrodes).map((x) => [x.id, x.id]))}</select>`}
    <input type="number" data-f="lo" value="${k.lo}" step="any" title="from"><input type="number" data-f="hi" value="${k.hi}" step="any" title="to">
    <button class="reset" data-f="rm" title="remove">✕</button></div>`).join("") || `<p class="muted small">No knobs yet: add some or use a preset.</p>`;
  sgEstimate();
}
$("#sg-knobs").addEventListener("change", (e) => {
  const row = e.target.closest(".sg-knob"); if (!row) return; const k = SG.knobs[+row.dataset.i], f = e.target.dataset.f;
  if (f === "type") { const v = e.target.value;
    if (v === "coil" || v === "electrode") { k.kind = v; k.id = v === "coil" ? S.state.coils[0].id : "P5"; } else { k.kind = "param"; k.id = v; }
    [k.lo, k.hi] = sgDefaultRange(k.kind, k.id); sgRender(); }
  if (f === "id") { k.id = e.target.value; [k.lo, k.hi] = sgDefaultRange(k.kind, k.id); sgRender(); }
  if (f === "lo" || f === "hi") { k[f] = +e.target.value; sgEstimate(); }
});
$("#sg-knobs").addEventListener("click", (e) => { if (e.target.dataset.f === "rm") { SG.knobs.splice(+e.target.closest(".sg-knob").dataset.i, 1); sgRender(); } });
$("#sg-add").addEventListener("click", () => { const [lo, hi] = sgDefaultRange("param", "degraderThickness"); SG.knobs.push({ kind: "param", id: "degraderThickness", lo, hi }); sgRender(); });
$$("[data-sgp]").forEach((b) => b.addEventListener("click", () => {
  const P = { catch: [["param", "degraderThickness"], ["param", "pulseT0"]], hv: [["param", "pulseV"], ["param", "reflectorV"]], mag: [["coil", "Coil11"], ["coil", "Coil12"]] }[b.dataset.sgp];
  SG.knobs = P.map(([kind, id]) => { const [lo, hi] = sgDefaultRange(kind, id); return { kind, id, lo, hi }; });
  if (b.dataset.sgp !== "mag" && !$("#c-on").checked) toast("Tip: enable Pulsed catching on the Simulate page so the baseline includes the pulse");
  sgRender();
}));
["#sg-n", "#sg-ev", "#sg-r", "#sg-pr"].forEach((id) => $(id).addEventListener("input", sgEstimate));
function sgEstimate() {
  const n = +$("#sg-n").value + +$("#sg-r").value * +$("#sg-pr").value, ev = +$("#sg-ev").value;
  const pulsed = $("#c-on")?.checked, sPer1k = pulsed ? 210 : 30, par = S.status?.limits?.max_concurrent || 8;
  const secs = (n * ev * sPer1k) / 1000 / par;
  $("#sg-est").textContent = `${n} G4beamline runs × ${ev} events · ≈ ${secs < 3600 ? (secs / 60).toFixed(0) + " min" : (secs / 3600).toFixed(1) + " h"} on ${par} parallel runs${pulsed ? " (pulsed catching tracks trapped p̄, so runs are slower)" : ""}`;
}
$("#sg-go").addEventListener("click", async () => {
  $("#sg-err").textContent = "";
  try {
    if (!SG.knobs.length) throw new Error("add at least one knob");
    const base = runRequest(); delete base.name;
    const r = await api("/api/surrogate", { name: $("#sg-name").value.trim() || undefined, knobs: SG.knobs, base, n_init: +$("#sg-n").value,
      rounds: +$("#sg-r").value, per_round: +$("#sg-pr").value, events: +$("#sg-ev").value, keep_runs: $("#sg-keep").checked, traj_events: +$("#sg-tj").value });
    toast(`Training ${r.started}: ${r.total} runs queued`); SG.sel = r.started; await sgRefresh();
  } catch (e) { $("#sg-err").textContent = e.message; }
});
async function sgRefresh() {
  SG.list = await api("/api/surrogates");
  $("#sg-list").innerHTML = SG.list.map((c) => `<div class="item ${c.name === SG.sel ? "cmp" : ""}" data-sg="${c.name}" style="cursor:pointer">
    <div class="grow"><div class="t">${c.name}</div><div class="muted small">${c.knobs.map((k) => k.label).join(" · ")} · ${c.events} ev/run</div>
    ${["sampling", "active learning", "fitting", "starting", "resuming"].includes(c.status) ? `<div class="progress"><i style="width:${(100 * c.done) / c.total}%"></i></div>` : ""}</div>
    <span class="pill ${c.trained ? "done" : c.status === "error" ? "failed" : "running"}">${c.status === "idle" || c.status === "done" ? (c.trained ? "trained" : c.status) : c.status} · ${c.done}/${c.total}</span>
    ${["sampling", "active learning", "starting", "resuming", "fitting"].includes(c.status) ? `<button class="btn small danger" data-sgact="stop" data-n="${c.name}">Stop</button>` :
      (c.done + c.failed < c.total ? `<button class="btn small" data-sgact="resume" data-n="${c.name}">Resume</button>` : "")}
    <button class="btn small" data-sgact="delete" data-n="${c.name}" title="delete surrogate">✕</button></div>`).join("") || `<p class="muted">No surrogates yet.</p>`;
  if (!SG.sel && SG.list.length) SG.sel = (SG.list.find((c) => c.trained) || SG.list[0]).name;
  const cur = SG.list.find((c) => c.name === SG.sel);
  if (cur && cur.trained) await sgLoad(cur.name); else ["#sg-live", "#sg-opt-card", "#sg-q-card", "#sg-tj-card"].forEach((id) => ($(id).hidden = true));
}
$("#sg-list").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-sgact]");
  if (act) { e.stopPropagation(); const n = act.dataset.n, a = act.dataset.sgact;
    if (a === "delete" && !(await confirmSheet(`Delete surrogate ${n}?`, "The trained model and its sample table are removed. Runs already deleted stay deleted.", []))) return;
    try { await api(`/api/surrogate/${n}/${a}`, {}); toast(`${a} ${n}`); if (a === "delete" && SG.sel === n) SG.sel = null; } catch (err) { toast(err.message); }
    return sgRefresh(); }
  const it = e.target.closest("[data-sg]"); if (it) { SG.sel = it.dataset.sg; SG.info = null; sgRefresh(); }
});
async function sgLoad(name) {
  const fresh = !SG.info || SG.info.campaign.name !== name || SG._n !== SG.list.find((c) => c.name === name)?.done;
  if (fresh) { SG.info = await api("/api/surrogate/" + name); SG._n = SG.info.n; }
  const outs = SG.info.outputs.filter((o) => SG.info.quality[o.key]);
  if (!outs.find((o) => o.key === SG.out)) SG.out = outs[0]?.key;
  $("#sg-out").innerHTML = outs.map((o) => `<button data-v="${o.key}" class="${o.key === SG.out ? "on" : ""}">${o.label}</button>`).join("");
  $("#sg-opt-out").innerHTML = outs.map((o) => `<option value="${o.key}" ${o.key === "trapped" ? "selected" : ""}>${o.label}</option>`).join("");
  ["#sg-live", "#sg-opt-card", "#sg-q-card"].forEach((id) => ($(id).hidden = false));
  $("#sg-live-name").textContent = `· ${name} · ${SG.info.n} runs`;
  await sgPredict(); sgQuality(); sgTrajUpdate();
}
seg("#sg-out", (v) => { SG.out = v; sgDrawScan(); sgQuality(); });
let sgT; function sgSchedule() { if (S.page !== "surrogate" || !SG.info) return; clearTimeout(sgT); sgT = setTimeout(() => { sgPredict(); sgTrajUpdate(); }, 250); }
async function sgPredict() {
  if (!SG.info) return;
  try { SG.pred = await api(`/api/surrogate/${SG.info.campaign.name}/predict`, runRequest()); } catch (e) { return; }
  const units = Object.fromEntries(SG.info.outputs.map((o) => [o.key, o]));
  $("#sg-tiles").innerHTML = Object.entries(SG.pred.point).map(([k, v]) => `<div class="tile"><div class="l">${units[k]?.label || k}</div>
    <div class="v">${v.mean.toFixed(units[k]?.unit === "mm" ? 0 : 1)}<small>± ${v.std.toFixed(1)} ${units[k]?.unit || ""}</small></div></div>`).join("");
  $("#sg-outside").hidden = !SG.pred.outside.length; $("#sg-outside").title = "Extrapolating in: " + SG.pred.outside.join(", ");
  sgDrawScan();
  if (SG.pred.zhist) { const zb = SG.info.zbins, c = zb.slice(0, -1).map((z, i) => (z + zb[i + 1]) / 2);
    plot("pl-sg-z", [{ x: c, y: SG.pred.zhist.map((v) => 100 * v), type: "bar", marker: { color: css("--red") }, hovertemplate: "z %{x:.0f}: %{y:.2f}%<extra></extra>" }],
      { xaxis: { ...layout().xaxis, title: "predicted annihilation position z [mm]" }, yaxis: { ...layout().yaxis, title: "% of p̄ / bin" }, hovermode: "closest", shapes: electrodeShapes(), bargap: 0.05, margin: { l: 52, r: 16, t: 6, b: 40 } }); }
}
function sgDrawScan() {
  if (!SG.pred) return; const col = COLORS(), sc = SG.pred.scans, n = sc.length, unit = SG.info.outputs.find((o) => o.key === SG.out);
  const tr = [], lay = { hovermode: "closest", showlegend: false, grid: { rows: 1, columns: n, pattern: "independent" }, margin: { l: 50, r: 10, t: 24, b: 44 }, annotations: [] };
  sc.forEach((s, i) => { const o = s.out[SG.out]; if (!o) return; const ax = i ? i + 1 : "", c = col[i % col.length];
    const up = o.mean.map((m, j) => m + 2 * o.std[j]), dn = o.mean.map((m, j) => m - 2 * o.std[j]);
    tr.push({ x: [...s.x, ...s.x.slice().reverse()], y: [...up, ...dn.reverse()], fill: "toself", fillcolor: c + "33", line: { width: 0 }, xaxis: "x" + ax, yaxis: "y" + ax, hoverinfo: "skip" });
    tr.push({ x: s.x, y: o.mean, line: { color: c, width: 2 }, xaxis: "x" + ax, yaxis: "y" + ax, hovertemplate: `${s.knob}: %{x:.3g}<br>%{y:.2f} ${unit?.unit || ""}<extra></extra>` });
    lay["xaxis" + ax] = { ...layout().xaxis, title: { text: s.knob, font: { size: 11 } } }; lay["yaxis" + ax] = { ...layout().yaxis, title: i ? "" : `${unit?.label} [${unit?.unit}]` };
    (lay.shapes ||= []).push({ type: "line", xref: "x" + ax, yref: "y" + ax + " domain", x0: s.current, x1: s.current, y0: 0, y1: 1, line: { color: css("--muted"), dash: "dot" } }); });
  plot("pl-sg-scan", tr, lay);
}
function sgQuality() {
  const q = SG.info?.quality?.[SG.out]; if (!q) return; const lo = Math.min(...q.y, ...q.loo), hi = Math.max(...q.y, ...q.loo), u = SG.info.outputs.find((o) => o.key === SG.out);
  plot("pl-sg-loo", [{ x: q.y, y: q.loo, mode: "markers", error_y: { type: "data", array: q.loo_sd.map((v) => 2 * v), thickness: 1, color: css("--muted") }, marker: { color: css("--accent"), size: 7 }, hovertemplate: "G4beamline %{x:.2f}<br>surrogate %{y:.2f}<extra></extra>" },
    { x: [lo, hi], y: [lo, hi], line: { dash: "dash", color: css("--muted") }, hoverinfo: "skip" }],
    { showlegend: false, hovermode: "closest", xaxis: { ...layout().xaxis, title: `G4beamline ${u?.label} [${u?.unit}]` }, yaxis: { ...layout().yaxis, title: "surrogate (leave-one-out)" },
      annotations: [{ x: 0.02, y: 0.98, xref: "paper", yref: "paper", xanchor: "left", showarrow: false, text: `R² ${q.r2.toFixed(3)} · RMSE ${q.rmse.toFixed(2)} · MC noise ≈ ${q.noise.toFixed(2)} ${u?.unit}`, font: { size: 12, color: css("--text") } }] });
  const ks = SG.info.campaign.knobs, rel = q.relevance, mx = Math.max(...rel);
  plot("pl-sg-rel", [{ y: ks.map((k) => k.label), x: rel.map((r) => r / mx), type: "bar", orientation: "h", marker: { color: css("--purple") }, hovertemplate: "%{y}: %{x:.2f}<extra></extra>" }],
    { hovermode: "closest", xaxis: { ...layout().xaxis, title: `knob relevance for ${u?.label}`, range: [0, 1.05] }, yaxis: { ...layout().yaxis, automargin: true }, margin: { l: 10, r: 10, t: 10, b: 44 } });
  const v = SG.info.verify || [];
  $("#sg-verify").innerHTML = v.length ? `<h4 style="margin-top:14px">Verification runs</h4><table class="sg-opt-table">${v.map((r) => `<tr><td>${r.run}</td><td>${u?.label}: predicted ${r.pred[SG.out] ? r.pred[SG.out].mean.toFixed(1) + " ± " + r.pred[SG.out].std.toFixed(1) : "–"}</td><td>${r.actual ? "G4beamline " + (+r.actual[SG.out]).toFixed(1) : "running…"}</td></tr>`).join("")}</table>` : "";
}
$("#sg-opt-go").addEventListener("click", async () => {
  try {
    const out = $("#sg-opt-out").value, maximise = $("#sg-opt-dir button.on").dataset.v === "1";
    const r = await api(`/api/surrogate/${SG.info.campaign.name}/optimise`, { output: out, maximise });
    const u = SG.info.outputs.find((o) => o.key === out); SG.best = r;
    $("#sg-opt-res").innerHTML = `<table class="sg-opt-table">${r.knobs.map((k, i) => `<tr><td>${k}</td><td>${(+r.x[i]).toPrecision(4)}</td></tr>`).join("")}
      <tr><td><b>${u.label}</b></td><td><b>${r.mean.toFixed(1)} ± ${r.std.toFixed(1)} ${u.unit}</b></td></tr></table>
      <div class="row"><button class="btn" id="sg-apply">Apply to settings</button><button class="btn primary" id="sg-verify-go">Verify with G4beamline</button></div>`;
    $("#sg-apply").onclick = () => sgApply(r); $("#sg-verify-go").onclick = async () => { sgApply(r); const v = await api(`/api/surrogate/${SG.info.campaign.name}/verify`, runRequest()); toast(`Verifying: ${v.run}`); };
  } catch (e) { toast(e.message); }
});
seg("#sg-opt-dir");
$("#sg-tj-build").addEventListener("click", async () => { try { const r = await api(`/api/surrogate/${SG.sel}/trajectories`, { events: 30 }); toast(`Tracing ${r.started} training points…`); sgRefresh(); } catch (e) { toast(e.message); } });
$("#sg-tj-pick").addEventListener("change", (e) => { TJ.pick = +e.target.value; sgTrajUpdate(true); });
$("#sg-tj-play").addEventListener("click", () => TJ.viewer?.play());
$("#sg-tj-time").addEventListener("input", (e) => { TJ.viewer?.play(false); TJ.viewer?.setU(e.target.value / 1000); });
$("#sg-tj-prev").addEventListener("click", () => sgTrajStep(-1)); $("#sg-tj-next").addEventListener("click", () => sgTrajStep(1));
$("#sg-tj-open").addEventListener("click", () => { if (!TJ.data) return; D.surData = TJ.data; D.surPending = true; go("display"); });
function sgApply(r) {
  SG.info.campaign.knobs.forEach((k, i) => { const v = +r.x[i];
    if (k.kind === "coil") S.state.coils.find((c) => c.id === k.id)?._row._set(+v.toFixed(3));
    else if (k.kind === "electrode") S.state.electrodes.find((e) => e.id === k.id)?._set(+v.toFixed(2));
    else if (k.id === "degraderThickness") $("#c-deg").value = v.toFixed(3);
    else if (k.id === "pulseT0") { $("#c-t0").value = v.toFixed(0); $("#c-on").checked = true; }
    else if (k.id === "pulseV") $("#c-v").value = (v / 1000).toFixed(2);
    else if (k.id === "reflectorV") $("#c-refv").value = (v / 1000).toFixed(2);
    else if (k.id === "KE") $("#g-ke").value = v.toFixed(1); });
  catchChanged(); toast("Applied to the Magnets / Electrodes / Simulate settings"); sgPredict();
}

/* ---------------- surrogate: trajectory library viewer ---------------- */
const TJ = { viewer: null, run: null, pick: 0, data: null };
async function sgTrajUpdate(force) {
  const c = SG.list.find((x) => x.name === SG.sel); if (!c || !c.trained) return;
  const lib = c.traj, card = $("#sg-tj-card"); card.hidden = false;
  $("#sg-tj-build").hidden = !(lib < c.done) || c.traj_running;
  $("#sg-tj-build").textContent = lib ? `Complete trajectory library (${lib}/${c.done})` : "Build trajectory library";
  $("#sg-tj-prog").hidden = !c.traj_running;
  if (c.traj_running) $("#sg-tj-prog").innerHTML = `<div class="progress"><i style="width:${(100 * c.traj_done) / Math.max(c.traj_total, 1)}%"></i></div><span class="muted small">tracing ${c.traj_done}/${c.traj_total} training points…</span>`;
  if (!lib) { $("#sg-tj-info").innerHTML = `This surrogate was trained without trajectories. <b>Build trajectory library</b> re-runs each training point briefly with tracing (about a minute), so the 3D view can show real events next to the predictions.`; $("#sg-tj-wrap").hidden = true; return; }
  $("#sg-tj-wrap").hidden = false;
  await viewerReady;
  if (!TJ.viewer) {
    TJ.viewer = new window.TwinViewer.EventDisplay($("#sg-viewport"), {
      onTime: (u, t) => { $("#sg-tj-time").value = Math.round(u * 1000); $("#sg-tj-time").style.setProperty("--p", u * 100 + "%"); $("#sg-tj-t").textContent = fmtTime(t); },
      onPlay: (on) => ($("#sg-tj-play").innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>'),
    });
    if (!S.geo) S.geo = await api("/api/geometry");
    TJ.viewer.setGeometry(S.geo, {}); TJ.viewer.setView("iso");
  }
  const req = runRequest(); req._meta_only = true; req._traj_index = TJ.pick;
  const meta = await api(`/api/surrogate/${SG.sel}/trajectory`, req);
  if (!meta.available) return;
  const m = meta.surrogate;
  $("#sg-tj-pick").innerHTML = m.neighbours.map((nb, i) => `<option value="${i}" ${i === TJ.pick ? "selected" : ""}>#${i + 1} · ${nb.x.map((v, j) => `${m.knobs[j].replace(/ \[.*\]/, "")} ${(+v).toPrecision(3)}`).join(" · ")} · Δ ${nb.distance.toFixed(2)}</option>`).join("");
  const far = m.distance > 0.25;
  $("#sg-tj-info").innerHTML = `Real G4beamline trajectories from the <b>nearest simulated setting</b> (${m.library} in the library): ${m.x.map((v, j) => `${m.knobs[j]} = <b>${(+v).toPrecision(4)}</b>`).join(", ")}.
    Distance ${m.distance.toFixed(2)} in normalised knob space${far ? ` <span class="pill failed">far from training points: train more or verify</span>` : ""}. The numbers above are the GP prediction at your exact settings; at this point G4beamline gave
    ${m.outputs ? `trapped ${m.outputs.trapped.toFixed(1)} %, annihilated ${m.outputs.annihilated.toFixed(1)} %` : "–"}.`;
  if (!force && m.run === TJ.run) return;
  req._meta_only = false;
  const data = await api(`/api/surrogate/${SG.sel}/trajectory`, req);
  TJ.run = m.run; TJ.data = data;
  await fillViewer(TJ.viewer, data, null).catch(() => {});
  const evs = [...new Set(data.meta.map((x) => x[0]))].sort((a, b) => a - b), tr = new Set(data.trapped ? data.trapped.ev : []), an = new Set(data.vertices.ev);
  TJ.events = evs; TJ.ev = -1;
  TJ.viewer.setEvent(TJ.ev); TJ.viewer.setU(1);
  $("#sg-tj-ev").textContent = `all ${evs.length} events · ${tr.size} trapped`;
}
function sgTrajStep(k) {
  if (!TJ.events?.length) return; const tr = new Set(TJ.data.trapped ? TJ.data.trapped.ev : []), an = new Set(TJ.data.vertices.ev);
  const i = TJ.events.indexOf(TJ.ev); TJ.ev = TJ.events[(i + k + TJ.events.length) % TJ.events.length];
  TJ.viewer.setEvent(TJ.ev); TJ.viewer.setU(0); TJ.viewer.play(true);
  $("#sg-tj-ev").textContent = `event ${TJ.ev}${tr.has(TJ.ev) ? " · trapped" : an.has(TJ.ev) ? " · annihilation" : ""}`;
}

/* ---------------- runs / results ---------------- */
const pill = (r) => `<span class="pill ${r.status}">${r.status === "running" && r.total ? Math.round((100 * r.done) / r.total) + "%" : r.status}</span>`;
const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " kB");
const RM = { on: false, sel: new Set() };
function confirmSheet(title, msg, items) {
  return new Promise((res) => {
    $("#sheet-t").textContent = title; $("#sheet-m").textContent = msg; $("#sheet-x").innerHTML = (items || []).map((x) => `<div>${x}</div>`).join("");
    $("#sheet").hidden = false;
    const done = (v) => { $("#sheet").hidden = true; $("#sheet-yes").onclick = $("#sheet-no").onclick = null; res(v); };
    $("#sheet-yes").onclick = () => done(true); $("#sheet-no").onclick = () => done(false);
  });
}
async function deleteRuns(names) {
  if (!names.length) return;
  const size = S.runs.filter((r) => names.includes(r.name)).reduce((a, r) => a + (r.size || 0), 0);
  const ok = await confirmSheet(`Delete ${names.length} run${names.length > 1 ? "s" : ""}?`, `This frees about ${fmtBytes(size)} and cannot be undone.`, names);
  if (!ok) return;
  try {
    const r = await api("/api/delete", { names });
    const errs = Object.entries(r.errors || {});
    toast(`Deleted ${r.deleted.length} run${r.deleted.length === 1 ? "" : "s"} · freed ${fmtBytes(r.freed)}` + (errs.length ? ` · ${errs.length} skipped (${errs[0][1]})` : ""));
    r.deleted.forEach((n) => { RM.sel.delete(n); S.cmpRuns.delete(n); delete RESULT_CACHE[n]; if (S.selRun === n) S.selRun = null; if (D.run === n) D.run = null; });
    await refreshRuns(); refreshStorage();
  } catch (e) { toast(e.message); }
}
function rmUpdate() {
  const sel = S.runs.filter((r) => RM.sel.has(r.name));
  $("#rm-sum").textContent = `${sel.length} selected · ${fmtBytes(sel.reduce((a, r) => a + (r.size || 0), 0))}`;
  $("#rm-del").disabled = !sel.length;
}
function setManage(on) {
  RM.on = on; if (!on) RM.sel.clear();
  $("#rm-bar").hidden = !on; $("#rm-hint").hidden = on; $("#rm-toggle").textContent = on ? "Done" : "Manage";
  refreshRuns(); rmUpdate();
}
async function refreshStorage() {
  try {
    const s = await api("/api/storage");
    $("#ov-storage").innerHTML = [["Runs", s.runs, ""], ["Disk used by runs", fmtBytes(s.bytes), ""], ["Free on disk", fmtBytes(s.disk_free), ""]]
      .map(([l, v, u]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}<small>${u}</small></div></div>`).join("");
  } catch {}
}
const when = (t) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
async function refreshRuns() {
  S.runs = await api("/api/runs");
  const running = S.runs.filter((r) => r.status === "running" || r.status === "queued");
  $("#nav-running").hidden = !running.length; $("#nav-running").textContent = running.length;
  $("#run-queue").innerHTML = S.runs.slice(0, 12).map((r) => `<div class="item"><div class="grow"><div class="t">${r.name}</div>
     <div class="muted small">${when(r.time)} · ${r.meta.nEvents ?? "?"} events · ${r.meta.magnetModel === 0 ? "analytic B" : "ROM B"}${r.meta.user ? " · " + r.meta.user : ""}</div>
     ${r.status === "running" ? `<div class="progress"><i style="width:${r.total ? (100 * r.done) / r.total : 5}%"></i></div>` : ""}</div>
     ${pill(r)}${r.status === "running" || r.status === "queued" ? `<button class="btn danger" data-stop="${r.name}">${r.status === "queued" ? "Cancel" : "Stop"}</button>` : `<button class="btn" data-open="${r.name}">Open</button>`}</div>`).join("") || `<p class="muted">No runs yet.</p>`;
  $("#ov-runs").innerHTML = S.runs.slice(0, 5).map((r) => `<div class="item"><div class="grow"><div class="t">${r.name}</div><div class="muted small">${when(r.time)}</div></div>${pill(r)}<button class="btn" data-open="${r.name}">Open</button></div>`).join("") || `<p class="muted">No runs yet — set up fields and press Run.</p>`;
  $("#res-runs").innerHTML = S.runs.map((r) => RM.on
    ? `<div class="item ${RM.sel.has(r.name) ? "picked" : ""}" data-pick="${r.name}"><span class="ck">${RM.sel.has(r.name) ? "✓" : ""}</span>
       <div class="grow"><div class="t">${r.name}</div><div class="muted small">${when(r.time)} · ${r.meta.nEvents ?? "?"} ev</div></div><span class="sz">${fmtBytes(r.size || 0)}</span></div>`
    : `<div class="item ${r.name === S.selRun ? "on" : ""} ${S.cmpRuns.has(r.name) ? "cmp" : ""}" data-sel="${r.name}">
     <div class="grow"><div class="t">${r.name}</div><div class="muted small">${when(r.time)} · ${r.meta.nEvents ?? "?"} ev · ${fmtBytes(r.size || 0)}</div></div>${pill(r)}</div>`).join("");
  if (S.page === "results" && !S.selRun && S.runs.length) openRun(S.runs.find((r) => r.status === "done")?.name || S.runs[0].name);
  return S.runs;
}
document.addEventListener("click", async (e) => {
  const o = e.target.closest("[data-open]"); if (o) { S.selRun = o.dataset.open; go("results"); openRun(S.selRun); }
  const s = e.target.closest("[data-stop]"); if (s) { try { await api("/api/stop/" + s.dataset.stop, {}); toast("Stopping " + s.dataset.stop); } catch (err) { toast(err.message); } refreshRuns(); }
  const pk = e.target.closest("[data-pick]");
  if (pk) { const n = pk.dataset.pick, r = S.runs.find((x) => x.name === n);
    if (r && (r.status === "running" || r.status === "queued")) return toast(`${n} is ${r.status}; stop it first`);
    RM.sel.has(n) ? RM.sel.delete(n) : RM.sel.add(n); refreshRuns(); rmUpdate(); return; }
  const sel = e.target.closest("[data-sel]");
  if (sel) {
    const n = sel.dataset.sel;
    if (e.metaKey || e.ctrlKey) { S.cmpRuns.has(n) ? S.cmpRuns.delete(n) : S.cmpRuns.add(n); refreshRuns(); openRun(S.selRun); }
    else { S.cmpRuns.clear(); openRun(n); }
  }
});
const RESULT_CACHE = {};
async function getResult(n) {
  if (RESULT_CACHE[n]?.status === "done") return RESULT_CACHE[n];
  const r = await api("/api/run/" + encodeURIComponent(n)); RESULT_CACHE[n] = r; return r;
}
async function openRun(n) {
  if (!n) return; S.selRun = n;
  $$("#res-runs .item").forEach((i) => i.classList.toggle("on", i.dataset.sel === n));
  const r = await getResult(n);
  if (!r.ready) {
    $("#res-tiles").innerHTML = `<div class="tile"><div class="l">${n}</div><div class="v">${r.status}<small>${r.done}/${r.total ?? "?"} events</small></div></div>`;
    ["pl-annz", "pl-annrz", "pl-annxy", "pl-byel", "pl-sc"].forEach((id) => Plotly.purge(id)); $("#res-params").innerHTML = ""; return;
  }
  const s = r.summary, frac = s.primaries ? (100 * s.annihilations) / s.primaries : 0;
  $("#res-tiles").innerHTML = [["Antiprotons", s.primaries, ""], ["Annihilated in trap", s.annihilations, ""], ["Fraction", frac.toFixed(1), "%"],
    ["Mean vertex z", s.z_mean == null ? "–" : s.z_mean.toFixed(0), "mm"],
    ...(s.trapped != null ? [["Trapped", `${s.trapped}`, `${s.primaries ? ((100 * s.trapped) / s.primaries).toFixed(1) : 0}%`]] : [["On electrode wall", s["on_electrode_wall(r>14.5mm)"], ""]])]
    .map(([l, v, u]) => `<div class="tile"><div class="l">${l}</div><div class="v">${v}<small>${u}</small></div></div>`).join("");
  const cmp = [n, ...[...S.cmpRuns].filter((x) => x !== n)];
  const res = await Promise.all(cmp.map(getResult)); const col = COLORS();
  plot("pl-annz", res.filter((x) => x.ready).map((x, i) => ({ x: x.vertices.z, type: "histogram", name: `${x.name} (${x.summary.annihilations})`,
    xbins: { size: 5 }, marker: { color: col[i % col.length], line: { width: 0 } }, opacity: res.length > 1 ? 0.6 : 0.9 })),
    { barmode: "overlay", bargap: 0.05, hovermode: "closest", xaxis: { ...layout().xaxis, title: "z (CST frame) [mm]" }, yaxis: { ...layout().yaxis, title: "annihilations / 5 mm" }, shapes: electrodeShapes(),
      margin: { l: 52, r: 16, t: 26, b: 40 },
      annotations: Object.entries(s.by_electrode).filter(([k]) => k !== "outside").slice(0, 8).map(([k]) => { const e = S.state.electrodes.find((x) => x.id === k);
        return e && { x: (e.z0 + e.z1) / 2, y: 1, yref: "paper", text: k, showarrow: false, textangle: -45, font: { size: 10, color: css("--muted") }, yanchor: "bottom" }; }).filter(Boolean) });
  const v = r.vertices, rr = v.x.map((x, i) => Math.hypot(x, v.y[i]));
  plot("pl-annrz", [{ x: v.z, y: rr, mode: "markers", type: "scattergl", marker: { size: 5, color: v.npi, colorscale: "Viridis", showscale: true, colorbar: { title: "π", thickness: 10 } }, hovertemplate: "z %{x:.1f} mm<br>r %{y:.2f} mm<extra></extra>" }],
    { hovermode: "closest", showlegend: false, xaxis: { ...layout().xaxis, title: "z [mm]" }, yaxis: { ...layout().yaxis, title: "r [mm]" } });
  const ring = Array.from({ length: 121 }, (_, i) => (i / 120) * 2 * Math.PI);
  plot("pl-annxy", [{ x: ring.map((a) => 15 * Math.cos(a)), y: ring.map((a) => 15 * Math.sin(a)), mode: "lines", line: { color: css("--muted"), width: 1, dash: "dot" }, hoverinfo: "skip" },
    { x: v.x, y: v.y, mode: "markers", type: "scattergl", marker: { size: 5, color: v.z, colorscale: "Blues", showscale: true, colorbar: { title: "z", thickness: 10 } }, hovertemplate: "x %{x:.1f}, y %{y:.1f}<extra></extra>" }],
    { hovermode: "closest", showlegend: false, xaxis: { ...layout().xaxis, title: "x [mm]", scaleanchor: "y" }, yaxis: { ...layout().yaxis, title: "y [mm]" } });
  const be = Object.entries(s.by_electrode);
  plot("pl-byel", [{ x: be.map((x) => x[0]), y: be.map((x) => x[1]), type: "bar", marker: { color: css("--accent") }, hovertemplate: "%{x}: %{y}<extra></extra>" }], { hovermode: "closest", showlegend: false });
  const scs = res.filter((x) => x.ready);
  plot("pl-sc", scs.map((x, i) => { const e = Object.entries(x.summary.events_with_scintillator_hits).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    return { x: e.map((q) => q[0]), y: e.map((q) => q[1]), type: "bar", name: x.name, marker: { color: col[i % col.length] } }; }),
    { barmode: "group", hovermode: "closest", showlegend: scs.length > 1, yaxis: { ...layout().yaxis, title: "events with hits" } });
  renderPhysics(n);
  const m = r.meta || {};
  const shown = Object.entries(m).filter(([k]) => !["scenario", "created"].includes(k));
  $("#res-params").innerHTML = shown.map(([k, val]) => `<span class="chip ${/^(nEvents|magnetModel|efieldModel|beam)/.test(k) ? "hl" : ""}">${k}=${val}</span>`).join("")
    + Object.entries(r.energy).slice(0, 6).map(([k, e]) => `<span class="chip">Edep ${k}: ${e.toFixed(2)} MeV</span>`).join("");
}

/* ---------------- physics plots ---------------- */
const SPCOL = { "π⁺": "#ff9f0a", "π⁻": "#ff6b0a", "π⁰": "#ffd60a", "γ": "#f7e463", n: "#8e8e93", p: "#ff453a", nuclei: "#5e5ce6", "e⁻": "#64d2ff", "e⁺": "#bf5af2", "μ±": "#30d158", "ν": "#a2845e", K: "#ff375f" };
const PDGCOL = { 22: "#f7c600", 2112: "#8e8e93", 211: "#ff9f0a", "-211": "#ff6b0a", 11: "#0a84ff", "-11": "#bf5af2", 13: "#30d158", "-13": "#30d158", 2212: "#ff453a" };
const PDGN = { 22: "γ", 2112: "n", 211: "π⁺", "-211": "π⁻", "-11": "e⁺", 11: "e⁻", 13: "μ⁻", "-13": "μ⁺", 2212: "p", "-2212": "p̄" };
async function renderPhysics(n) {
  let ph; try { ph = await api("/api/physics/" + encodeURIComponent(n)); } catch { return; }
  if (!ph.ready || S.selRun !== n) return;
  const col = COLORS(), L = (x) => layout(x), ax = (t, extra = {}) => ({ ...layout().xaxis, title: t, ...extra }), ay = (t, extra = {}) => ({ ...layout().yaxis, title: t, ...extra });
  const mul = Object.entries(ph.mult);
  $("#ph-chips").innerHTML = [`${ph.n_annihilations} annihilations / ${ph.n_primaries} p̄`, ...mul.map(([k, v]) => `⟨${k}⟩ = ${(+v).toFixed(2)}`),
    `⟨π±⟩ = ${((ph.mult["π⁺"] || 0) + (ph.mult["π⁻"] || 0)).toFixed(2)} per annihilation`].map((t, i) => `<span class="chip ${i ? "" : "hl"}">${t}</span>`).join("");
  // 1. fate sunburst
  const ids = ["p̄"], labels = [`p̄ (${ph.n_primaries})`], parents = [""], vals = [ph.n_primaries];
  ids.push("ann"); labels.push("annihilated"); parents.push("p̄"); vals.push(ph.n_annihilations);
  const ntr = ph.trapped?.n || 0;
  if (ntr) { ids.push("trap"); labels.push("trapped"); parents.push("p̄"); vals.push(ntr); }
  ids.push("pass"); labels.push("left the model / stopped elsewhere"); parents.push("p̄"); vals.push(Math.max(0, ph.n_primaries - ph.n_annihilations - ntr));
  for (const [g, es] of Object.entries(ph.fate)) {
    const tot = Object.values(es).reduce((a, b) => a + b, 0);
    ids.push("g" + g); labels.push(g === "outside" ? "gaps" : g + " electrodes"); parents.push("ann"); vals.push(tot);
    for (const [e, c] of Object.entries(es)) if (g !== "outside") { ids.push("e" + e); labels.push(e); parents.push("g" + g); vals.push(c); }
  }
  plot("ph-fate", [{ type: "sunburst", ids, labels, parents, values: vals, branchvalues: "total", insidetextorientation: "radial",
    marker: { colors: ids.map((id) => (id === "p̄" ? css("--red") : id === "trap" ? css("--green") : id === "pass" ? css("--muted") : id === "ann" ? css("--orange") : id.startsWith("g") ? css("--accent") : css("--teal"))) }, hovertemplate: "%{label}: %{value}<extra></extra>" }],
    { margin: { l: 4, r: 4, t: 4, b: 4 }, hovermode: "closest" });
  // 2. fields + annihilation profile
  const st = S.state, p = ph.params || {}, bz = new Array(st.zB.length).fill(0), V = new Array(st.zE.length).fill(0);
  st.coils.forEach((c) => { const I = p.magnetModel === 0 ? c.default : p["I_" + c.id] ?? c.default; c.bz0.forEach((b, i) => (bz[i] += I * b)); });
  st.electrodes.forEach((e) => { const v = p["V_" + e.id] ?? e.default; if (v) e.phi.forEach((f, i) => (V[i] += v * f)); });
  const zr = [st.zE[0], st.zE[st.zE.length - 1]];
  plot("ph-fields", [
    { x: ph.z_ann, type: "histogram", xbins: { size: 8 }, name: "annihilations", marker: { color: css("--red") }, opacity: 0.75 },
    { x: st.zB, y: bz, name: "Bz on axis [T]", yaxis: "y2", line: { color: css("--accent"), width: 2 } },
    { x: st.zE, y: V, name: "Φ on axis [V]", yaxis: "y3", line: { color: css("--orange"), width: 2 } }],
    { xaxis: ax("z (CST frame) [mm]", { range: zr, domain: [0, 0.86] }), yaxis: ay("annihilations / 8 mm"),
      yaxis2: { overlaying: "y", side: "right", title: "B [T]", color: css("--accent"), showgrid: false, zeroline: false },
      yaxis3: { overlaying: "y", side: "right", position: 0.95, anchor: "free", title: "Φ [V]", color: css("--orange"), showgrid: false, zeroline: false },
      margin: { l: 52, r: 30, t: 30, b: 40 }, hovermode: "closest", shapes: electrodeShapes() });
  // 3. KE spectra
  plot("ph-ke", ph.spectra.map((s, i) => ({ x: s.x, y: s.y.map((v, k) => v / s.w[k]), name: `${s.label} (⟨KE⟩ ${s.mean < 1 ? (s.mean * 1e3).toFixed(0) + " keV" : s.mean.toFixed(0) + " MeV"})`,
    mode: "lines", line: { shape: "hvh", width: 1.8, color: SPCOL[s.label] || col[i % col.length] } })),
    { xaxis: ax("kinetic energy at creation [MeV]", { type: "log" }), yaxis: ay("dN/dE per annihilation [1/MeV]", { type: "log" }), hovermode: "closest", legend: { orientation: "v", x: 1.02, y: 1 }, margin: { l: 60, r: 10, t: 10, b: 44 } });
  // 4. charged-pion multiplicity
  const tot = ph.nch.reduce((a, b) => a + b, 0) || 1, mean = ph.nch.reduce((a, c, k) => a + k * c, 0) / tot;
  plot("ph-mult", [{ x: ph.nch.map((_, k) => k), y: ph.nch.map((c) => c / tot), type: "bar", marker: { color: css("--orange") }, hovertemplate: "%{x} π±: %{y:.2f}<extra></extra>" }],
    { xaxis: ax("charged pions per annihilation", { dtick: 1 }), yaxis: ay("fraction"), hovermode: "closest",
      annotations: [{ x: 0.98, y: 0.95, xref: "paper", yref: "paper", text: `⟨n<sub>π±</sub>⟩ = ${mean.toFixed(2)}`, showarrow: false, xanchor: "right", font: { size: 14, color: css("--text") } }] });
  // 5. pion emission angles
  plot("ph-cth", [{ x: ph.cth, type: "histogram", xbins: { start: -1, end: 1, size: 0.1 }, marker: { color: css("--purple") }, name: "π±" }],
    { xaxis: ax("cos θ  (θ to the beam axis)", { range: [-1, 1] }), yaxis: ay("pions"), hovermode: "closest", showlegend: false,
      shapes: ph.cth.length ? [{ type: "line", x0: -1, x1: 1, y0: ph.cth.length / 20, y1: ph.cth.length / 20, line: { dash: "dash", color: css("--muted") } }] : [],
      annotations: [{ x: 0, y: 1.02, xref: "x", yref: "paper", text: "dashed: isotropic", showarrow: false, font: { size: 11, color: css("--muted") } }] });
  const pb = new Array(18).fill(0); ph.phi.forEach((f) => pb[Math.floor(((f + 360) % 360) / 20)]++);
  plot("ph-phi", [{ type: "barpolar", r: pb, theta: pb.map((_, k) => k * 20 + 10), width: 18, marker: { color: css("--purple"), opacity: 0.8 } }],
    { polar: { bgcolor: "rgba(0,0,0,0)", radialaxis: { gridcolor: css("--sep"), color: css("--muted") }, angularaxis: { gridcolor: css("--sep"), color: css("--muted") } }, margin: { l: 20, r: 20, t: 20, b: 20 }, showlegend: false });
  // 6. timing
  const ts = [...ph.t_ann].sort((a, b) => a - b), q = (f) => ts[Math.min(ts.length - 1, Math.floor(f * ts.length))] ?? 0;
  const lo = q(0.02), hi = q(0.98), pad = Math.max(0.5, 0.1 * (hi - lo));
  plot("ph-time", [{ x: ph.t_ann, type: "histogram", xbins: { start: lo - pad, end: hi + pad, size: Math.max(0.05, (hi - lo + 2 * pad) / 40) }, marker: { color: css("--teal") } }],
    { xaxis: ax("annihilation time after start [ns]", { range: [lo - pad, hi + pad] }), yaxis: ay("annihilations"), hovermode: "closest", showlegend: false });
  // 7. degrader
  const dg = ph.degrader;
  if (dg.ke) plot("ph-deg", [{ x: dg.ke.x, y: dg.ke.y, type: "bar", marker: { color: css("--red") }, hovertemplate: "%{x:.2f} keV: %{y}<extra></extra>" }],
    { xaxis: ax(dg.where === "exit" ? "p̄ kinetic energy leaving the degrader [keV]" : "p̄ kinetic energy entering the degrader [keV] (run predates the exit detector)"), yaxis: ay("p̄", { type: "log" }), hovermode: "closest", bargap: 0.02,
      annotations: [{ x: 0.02, y: 0.95, xref: "paper", yref: "paper", xanchor: "left", text: dg.where === "exit" ? `median ${dg.median.toFixed(1)} keV · ${(100 * dg.frac10).toFixed(0)}% below 10 keV · ${dg.n} transmitted` : `${dg.mean.toFixed(2)} ± ${dg.sigma.toFixed(2)} keV`, showarrow: false, font: { size: 13, color: css("--text") } }] });
  // 8. scintillator time-of-flight map + coincidences + Edep
  const sc = ph.scint;
  if (sc && sc.t) {
    const kinds = [...new Set(sc.pdg)];
    plot("ph-tof", kinds.map((k, i) => { const m = sc.pdg.map((p_, j) => (p_ === k ? j : -1)).filter((j) => j >= 0);
      return { x: m.map((j) => sc.z[j] + (Math.random() - 0.5) * 30), y: m.map((j) => sc.t[j]), mode: "markers", type: "scatter", name: PDGN[k] || "PDG " + k,
        marker: { size: 7, color: PDGCOL[k] || col[i % col.length], opacity: 0.8 } }; }),
      { xaxis: ax("scintillator position z [mm]"), yaxis: ay("hit time [ns]", { type: "log" }), hovermode: "closest" });
    plot("ph-coinc", [{ x: sc.coinc.map((_, k) => `≥ ${k + 1}`), y: sc.coinc.map((v) => 100 * v), type: "bar", marker: { color: css("--green") }, text: sc.coinc.map((v) => (100 * v).toFixed(0) + "%"), textposition: "outside", hovertemplate: "%{x} detectors: %{y:.0f}%<extra></extra>" }],
      { xaxis: ax("scintillators hit in the same event"), yaxis: ay("% of annihilations", { range: [0, 110] }), hovermode: "closest" });
    if (sc.edep_h) plot("ph-edep", [{ x: sc.edep_h.x, y: sc.edep_h.y, type: "bar", marker: { color: css("--green") } }],
      { xaxis: ax("energy deposited per hit [MeV]", { type: "log" }), yaxis: ay("hits"), hovermode: "closest", bargap: 0.05 });
  }
  // 9. census
  const cen = ph.census.filter((c) => c[1] > 0);
  plot("ph-census", [{ y: cen.map((c) => c[0]), x: cen.map((c) => c[1]), type: "bar", orientation: "h", marker: { color: css("--accent") }, hovertemplate: "%{y}: %{x:.3f} per p̄<extra></extra>" }],
    { xaxis: ax("secondaries created per incident p̄ (all generations)", { type: "log" }), yaxis: ay("", { autorange: "reversed" }), hovermode: "closest", margin: { l: 60, r: 16, t: 10, b: 44 } });
}

$("#rm-toggle").addEventListener("click", () => setManage(!RM.on));
$("#rm-all").addEventListener("click", () => { S.runs.filter((r) => !["running", "queued"].includes(r.status)).forEach((r) => RM.sel.add(r.name)); refreshRuns(); rmUpdate(); });
$("#rm-none").addEventListener("click", () => { RM.sel.clear(); refreshRuns(); rmUpdate(); });
$("#rm-old").addEventListener("click", () => {
  const d = +prompt("Select runs older than how many days?", "7"); if (!(d >= 0)) return;
  const cut = Date.now() / 1000 - d * 86400;
  S.runs.filter((r) => r.time < cut && !["running", "queued"].includes(r.status)).forEach((r) => RM.sel.add(r.name)); refreshRuns(); rmUpdate();
});
$("#rm-del").addEventListener("click", () => deleteRuns([...RM.sel]));
$("#res-del").addEventListener("click", () => S.selRun && deleteRuns([S.selRun]));
$("#ov-manage").addEventListener("click", () => { go("results"); setManage(true); });

/* ---------------- overview ---------------- */
function applyMode(st) {
  if (S._modeApplied) return; S._modeApplied = true; S.status = st;
  if (st.guest) { $("#st-user").hidden = false; $("#st-user").innerHTML = `<a class="btn small signin" href="/login">Sign in to run simulations</a>`; }
  else if (st.user) { $("#st-user").hidden = false; $("#st-user").innerHTML = `<span class="av">${st.user.slice(0, 1).toUpperCase()}</span>${st.user}`; }
  if (!st.allow_rebuild) { $("#rebuild-card").innerHTML = `<h3>Model</h3><p class="muted">Field maps and the G4beamline model are built into this deployment. Rebuild offline (e.g. with new CST exports) and redeploy the image.</p>`; }
  if (st.mode === "server") $("#x-npz-field").hidden = true;
  const L = st.limits || {};
  if (st.mode === "server") { $("#r-n").max = L.max_events; $("#r-trace").max = L.max_trace;
    $("#run-limits").textContent = `Limits on this server: ≤ ${L.max_events} events, ≤ ${L.max_trace} traced events, ${L.max_concurrent} runs at a time (others are queued).`; }
  if (st.readonly) {
    ["#btn-run", "#btn-beam", "#sc-save"].forEach((id) => ($(id).disabled = true));
    [$("#page-simulate .card"), $("#page-beam .card")].forEach((c) => c.insertAdjacentHTML("afterbegin", st.guest
      ? `<div class="ro-banner">You are browsing as a guest. <a href="/login">Sign in</a> to create beams and run simulations.</div>`
      : `<div class="ro-banner">Read-only showcase: browse the results and event displays; new runs are disabled.</div>`));
  }
}
async function refreshStatus() {
  const st = await api("/api/status"); applyMode(st);
  $("#st-g4bl").className = "dot " + (st.g4bl ? "ok" : "bad");
  $("#st-maps").className = "dot " + (st.nmag && st.nel ? (st.efield_source.startsWith("FD") ? "warn" : "ok") : "bad");
  $("#st-xsuite").className = "dot " + (st.xsuite ? "ok" : "warn");
  const stage = (ic, color, tt, ds, ok, stt, page) => `<div class="stage" data-go="${page}"><div class="ic" style="background:${color}">${ic}</div><div class="tt">${tt}</div><div class="ds">${ds}</div>
     <div class="st"><span class="dot ${ok}"></span>${stt}</div></div>`;
  $("#pipeline").innerHTML = [
    stage("1", "linear-gradient(135deg,#5e5ce6,#0a84ff)", "ELENA → LNE02", "Xsuite transfer line, 100 keV p̄", st.xsuite ? "ok" : "warn", st.xsuite ? "Xsuite available" : "import .npz from Xsuite", "beam"),
    stage("2", "linear-gradient(135deg,#0a84ff,#30b0c7)", "Hand-over", "Delivery point → BLTrackFile, CST frame", "ok", "ready", "beam"),
    stage("3", "linear-gradient(135deg,#30b0c7,#28cd41)", "Magnets", `${st.nmag} coil maps, CST ROM`, st.nmag ? "ok" : "bad", st.nmag ? "maps built" : "missing", "magnets"),
    stage("4", "linear-gradient(135deg,#ff9f0a,#ff6b0a)", "Electrodes", `${st.nel} electrode maps`, st.efield_source.startsWith("FD") ? "warn" : "ok", st.efield_source.startsWith("FD") ? "Laplace stand-in" : "CST ROM", "electrodes"),
    stage("5", "linear-gradient(135deg,#af52de,#ff375f)", "G4beamline", "Tracking + annihilation", st.g4bl ? "ok" : "bad", st.g4bl ? "3.08 ready" : "not found", "simulate"),
  ].join("");
  $("#sys-kv").innerHTML = [["Frame", `z_CST = z_G4BL(old) ${st.frame_offset} mm`], ["G4beamline", st.g4bl_dir], ["Model", st.model ? "PenningTrap_CST.g4bl" : "missing"],
    ["E basis", st.efield_source], ["Running", st.running.join(", ") || "—"]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  if (st.build && $("#rebuild-msg")) {
    $("#rebuild-msg").textContent = st.build.running ? "building…" : st.build.log ? (st.build.ok ? "done ✓" : "failed") : "";
    $("#btn-rebuild").disabled = st.build.running;
    if (st.build.log) { $("#rebuild-log").hidden = false; $("#rebuild-log").textContent = st.build.log; }
    if (S._building && !st.build.running) { S._building = false; await loadState(); toast("Model rebuilt"); }
  }
}
document.addEventListener("click", (e) => { const s = e.target.closest("[data-go]"); if (s) go(s.dataset.go); });
$("#btn-rebuild").addEventListener("click", async () => {
  try { await api("/api/rebuild", { cst_efield: $("#cst-folder").value.trim() || null }); S._building = true; toast("Rebuilding field maps…"); refreshStatus(); }
  catch (e) { toast(e.message); }
});

/* ---------------- event display ---------------- */
const fmtTime = (t) => (t < 10 ? t.toFixed(2) + " ns" : t < 1e3 ? t.toFixed(1) + " ns" : t < 1e6 ? (t / 1e3).toFixed(2) + " µs" : (t / 1e6).toFixed(2) + " ms");
const D = { viewer: null, geo: null, run: null, data: null, events: [], annEvents: [] };
const viewerReady = new Promise((res) => (window.TwinViewer ? res() : addEventListener("viewer-ready", res, { once: true })));
async function initDisplay() {
  await viewerReady;
  if (!D.viewer) {
    const { EventDisplay, SPECIES } = window.TwinViewer;
    D.viewer = new EventDisplay($("#viewport"), {
      onTime: (u, t) => { if (D.viewer?.story.on) return; $("#d-time").value = Math.round(u * 1000); $("#d-time").style.setProperty("--p", u * 100 + "%"); $("#d-tread").textContent = "t = " + fmtTime(t); },
      onStory: storyHUD,
      onPlay: (on) => { $("#d-play").classList.toggle("on", on); $("#d-play").innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>'; },
      onPick: showPick,
      onHits: soundHits,
    });
    D.geo = await api("/api/geometry");
    D.viewer.cryoFill = store.get("cryoFill", {});
    D.viewer.setGeometry(D.geo, {});
    buildCryoUI();
    $("#d-time").addEventListener("input", (e) => {
      if (D.viewer.story.on) { D.viewer.storyPlay(false); D.viewer.story.auto = true; D.viewer.setStory(e.target.value / 1000); }
      else { D.viewer.play(false); D.viewer.setU(e.target.value / 1000); }
    });
    $("#d-play").addEventListener("click", () => (D.viewer.story.on ? D.viewer.storyPlay() : D.viewer.play()));
    seg("#d-mode", (v) => setStoryMode(v === "story"));
    const { STORY } = window.TwinViewer;
    $("#d-chapters").innerHTML = STORY.map((c, i) => `<button data-ch="${i}">${i + 1} · ${c.name}<span class="bar"></span></button>`).join("");
    $("#d-chapters").insertAdjacentHTML("beforeend", `<button class="explain${EX.on ? " on" : ""}" id="d-explain" title="Pause at each chapter with a short explanation">ⓘ Explain</button>`);
    $("#d-explain").addEventListener("click", () => { EX.on = !EX.on; store.set("explain", EX.on); $("#d-explain").classList.toggle("on", EX.on); if (!EX.on) $("#d-explainer").hidden = true; else EX.shown = -1; });
    $("#d-hands").addEventListener("click", () => (HC.ctl ? handsOff() : handsOn()));
    $("#hp-x").addEventListener("click", handsOff);
    $("#d-sound").classList.toggle("on", SND.on);
    $("#d-sound").addEventListener("click", () => { SND.on = !SND.on; store.set("sound", SND.on); $("#d-sound").classList.toggle("on", SND.on); if (SND.on) { sndInit(); sndNote(440, 0.25, 0, "triangle", 1.2); } });
    $$("#d-chapters [data-ch]").forEach((b) => b.addEventListener("click", () => {
      const tot = STORY.reduce((a, c) => a + c.dur, 0); let u = 0; for (let k = 0; k < +b.dataset.ch; k++) u += STORY[k].dur / tot;
      D.viewer.story.auto = true; D.viewer.setStory(u + 1e-4); D.viewer.storyPlay(true);
    }));
    seg("#d-speed", (v) => (D.viewer.time.speed = +v));
    $$("[data-layer]").forEach((c) => c.addEventListener("change", () => { D.viewer.setLayer(c.dataset.layer, c.checked); syncCbars(); }));
    $("#d-overlays").addEventListener("change", (e) => setOverlays(e.target.checked));
    $("#d-cut").addEventListener("change", (e) => D.viewer.setOption("cutaway", e.target.checked));
    $("#d-volt").addEventListener("change", (e) => D.viewer.setOption("colorByVoltage", e.target.checked));
    $("#d-rad").addEventListener("input", (e) => { D.viewer.setOption("radial", +e.target.value); $("#d-radv").textContent = e.target.value + "×"; e.target.style.setProperty("--p", ((e.target.value - 1) / 11) * 100 + "%"); });
    $$(".hud-views button").forEach((b) => b.addEventListener("click", () => D.viewer.setView(b.dataset.view)));
    $("#d-run").addEventListener("change", (e) => (e.target.value === "__sur__" ? loadDisplayRun("__sur__", D.surData) : loadDisplayRun(e.target.value)));
    $("#d-event").addEventListener("change", (e) => setDisplayEvent(+e.target.value));
    $("#d-prev").addEventListener("click", () => stepEvent(-1)); $("#d-next").addEventListener("click", () => stepEvent(1));
    $("#d-nextann").addEventListener("click", () => {
      const cur = D.viewer.event; const nx = D.annEvents.find((e) => e > cur) ?? D.annEvents[0];
      if (nx != null) { setDisplayEvent(nx); D.viewer.setU(0); D.viewer.play(true); }
    });
    addEventListener("keydown", (e) => {
      if (S.page !== "display" || e.target.matches("input:not([type=range]), select")) return;
      if (e.code === "Space") { e.preventDefault(); D.viewer.story.on ? D.viewer.storyPlay() : D.viewer.play(); }
      if (e.key === "f" || e.key === "F") setOverlays(!$("#d-overlays").checked);
      if (e.key === "ArrowRight") stepEvent(1); if (e.key === "ArrowLeft") stepEvent(-1);
    });
  }
  const runs = (await refreshRuns()).filter((r) => r.has_tracks && r.status === "done");
  const cur = $("#d-run").value;
  $("#d-run").innerHTML = (D.surData ? `<option value="__sur__">✦ ${D.surData.surrogate.campaign} · nearest training point</option>` : "") +
    (runs.map((r) => `<option value="${r.name}">${r.name}</option>`).join("") || (D.surData ? "" : `<option value="">no runs with trajectories</option>`));
  if (D.surPending) { D.surPending = false; $("#d-run").value = "__sur__"; return loadDisplayRun("__sur__", D.surData); }
  const pick = runs.some((r) => r.name === cur) ? cur : runs.some((r) => r.name === S.selRun) ? S.selRun : runs[0]?.name;
  if (D.run === "__sur__" && D.surData) { $("#d-run").value = "__sur__"; }
  else if (pick) { $("#d-run").value = pick; if (pick !== D.run) await loadDisplayRun(pick); }
  else { $("#d-empty").hidden = false; D.viewer.setTracks(null); }
  const q = new URLSearchParams(location.search);
  if (q.has("story") && !D._storyParam) { D._storyParam = true; setStoryMode(true); D.viewer.storyPlay(false); D.viewer.setStory(+q.get("story")); }
}
function fillViewer(viewer, data, fmSource) {
  // voltages, tracks, on-axis field lines, potential profile, then the 2D |B| map
  const volts = {}; S.state.electrodes.forEach((e) => (volts[e.id] = data.params?.["V_" + e.id] ?? e.default));
  viewer.setVoltages(volts);
  viewer.setTracks(data);
  const st = S.state, bz = new Array(st.zB.length).fill(0), V = new Array(st.zE.length).fill(0);
  const useROM = data.params?.magnetModel !== 0;
  st.coils.forEach((c) => { const I = useROM ? (data.params?.["I_" + c.id] ?? c.default) : c.default; c.bz0.forEach((b, i) => (bz[i] += I * b)); });
  st.electrodes.forEach((e) => { const v = volts[e.id]; if (v) e.phi.forEach((f, i) => (V[i] += v * f)); });
  // pulsed electrodes: Φ(z) follows the pulse in time (static part + f(t)·V·φ_e)
  const pulsed = (data.pulses || []).map((p) => { const e = st.electrodes.find((x) => x.id === p.id); return e && { ...p, V: p.V ?? volts[p.id], phi: e.phi, zc: (e.z0 + e.z1) / 2 }; }).filter(Boolean);
  const Vs = V.slice(); pulsed.forEach((q) => q.phi.forEach((f, i) => (Vs[i] -= q.V * f)));
  viewer.setPulseProfile({ Vs, pulsed });
  // per-coil on-axis contributions, so a quenched magnet's field can be collapsed
  viewer._fieldSrc = { zB: st.zB, coils: st.coils.map((c) => ({ id: c.id, I: useROM ? (data.params?.["I_" + c.id] ?? c.default) : c.default, bz0: c.bz0 })) };
  viewer.setField(st.zB, bz); viewer.setPotential(st.zE, V);
  const fm = fmSource ? api("/api/fieldmaps/" + encodeURIComponent(fmSource)) : api("/api/fieldmaps", { params: data.params || {} });
  return fm.then((m) => { viewer.setFieldMaps(m); return { fm: m, V }; });
}
async function loadDisplayRun(name, pre) {
  if (!name) return;
  D.run = name; $("#d-stats").innerHTML = `<div style="grid-column:span 2"><div class="l">loading</div><div class="v">…</div></div>`;
  let data = pre;
  if (!data) {
    try { data = await api("/api/tracks/" + encodeURIComponent(name)); }
    catch (e) { $("#d-stats").innerHTML = `<div style="grid-column:span 2"><div class="l">could not load tracks</div><div class="v" style="font-size:12px">${e.message}</div></div>`; return; }
  }
  D.data = data; $("#d-empty").hidden = !!data.available;
  fillViewer(D.viewer, data, pre ? null : name).then(({ fm, V }) => {
    if (D.run !== name) return;
    $("#cb-B1").textContent = fm.B.max.toFixed(2); $("#cb-V0").textContent = `well minimum ${Math.min(...V).toFixed(1)} V`;
    $("#cb-src").textContent = `B: ${fm.magnetModel === 0 ? "CST ROM at nominal currents (run used analytic magnets)" : "CST ROM, run currents"} · |B| shown on the x = 0 cut plane · Φ: ${fm.V.source.startsWith("FD") ? "Laplace basis (stand-in)" : "CST basis"}, run voltages`;
    $("#d-cbars").hidden = false; syncCbars();
  }).catch(() => {});
  D.events = data.available ? [...new Set(data.meta.map((m) => m[0]))].sort((a, b) => a - b) : [];
  D.annEvents = data.available ? [...new Set(data.vertices.ev)].sort((a, b) => a - b) : [];
  const ann = new Set(D.annEvents), trapSet = new Set(data.available && data.trapped ? data.trapped.ev : []);
  D.trapEvents = D.events.filter((e) => trapSet.has(e));
  $("#d-event").innerHTML = `<option value="-1">All events (${D.events.length})</option>` + D.events.map((e) => `<option value="${e}">Event ${e}${trapSet.has(e) ? "  ◆ trapped" : ""}${ann.has(e) ? "  ★ annihilation" : ""}</option>`).join("");
  // catching runs: most events are a single trapped p̄, so start with all events; otherwise the first annihilation
  renderSpecies(); setDisplayEvent(D.trapEvents.length ? -1 : D.annEvents.length ? D.annEvents[0] : -1); D.viewer.setU(1); $("#d-info").hidden = true;
}
const CAPTIONS = [
  (x) => ["Chapter 1 · ELENA → AEgIS", "Antiprotons arrive through the transfer line", `100 keV p̄ bunch travelling LNE00 → LNE02 · z = ${x.zb.toFixed(0)} mm`],
  (x) => ["Chapter 2 · Magnets", "Superconducting solenoids ramp up", `B on axis ${x.B.toFixed(2)} T · 5 T and 1 T solenoids + 21 correctors · flux lines r ∝ √(B₀/B)`],
  (x) => ["Chapter 3 · Electrodes", "66 trap electrodes are energised", `Potential well on axis: ${x.Vmin.toFixed(1)} V · blue = negative, red = positive`],
  (x) => { const p = D.data?.pulses?.[0], closed = p && x.t >= p.t0, released = p && p.open > 0 && x.t >= p.open;
    const title = !p ? "p̄ through the degrader, into the trap, annihilation" : released ? `${p.id} reopened at ${fmtTime(p.open)}: trapped p̄ dumped and annihilate` :
      closed ? `${p.id} closed at ${p.t0} ns: p̄ caught between the electrodes` : "p̄ through the degrader, into the catching trap";
    return ["Chapter 4 · Transport", title,
      `t = ${fmtTime(x.t)} · ${D.viewer.event >= 0 ? "event " + D.viewer.event : "all traced events"}${p ? ` · ${p.id} ${released ? "open (dump)" : closed ? "closed" : "open"}` : ""}${D.data?.trapped?.n ? ` · ${D.data.trapped.n} trapped` : ""}`]; },
];
function storyHUD(u, i, p, x) {
  $("#d-time").value = Math.round(u * 1000); $("#d-time").style.setProperty("--p", u * 100 + "%");
  const [k, t, sub] = CAPTIONS[i](x);
  if ($("#d-cap-t").textContent !== t) { const c = $("#d-caption"); c.style.animation = "none"; c.offsetHeight; c.style.animation = ""; }
  $("#d-cap-k").textContent = k; $("#d-cap-t").textContent = t; $("#d-cap-s").textContent = sub;
  $("#d-tread").textContent = i === 3 ? "t = " + fmtTime(x.t) : `${i + 1} / 4`;
  $$("#d-chapters [data-ch]").forEach((b, j) => { b.classList.toggle("on", j === i); b.classList.toggle("done", j < i); $(".bar", b).style.width = j === i ? p * 100 + "%" : ""; });
  explainStep(u, i);
}
function setStoryMode(on) {
  $("#d-caption").hidden = !on; $("#d-chapters").hidden = !on;
  $$("#d-mode button").forEach((b) => b.classList.toggle("on", (b.dataset.v === "story") === on));
  D.viewer.storyMode(on);
  if (on) { if (D.viewer.event < 0 && D.annEvents.length) setDisplayEvent(D.annEvents[0]); D.viewer.setStory(0); D.viewer.storyPlay(true); }
  else { D.viewer.setView("iso"); }
}
function setOverlays(on) {
  for (const k of ["bmap", "pot"]) { const c = $(`[data-layer="${k}"]`); c.checked = on; D.viewer.setLayer(k, on); }
  syncCbars();
}
function syncCbars() {
  const b = $('[data-layer="bmap"]').checked, v = $('[data-layer="pot"]').checked;
  $("#d-overlays").checked = b || v;
  $("#cb-B").hidden = !b; $("#cb-V").hidden = !v; $("#d-cbars").hidden = !(b || v) || !D.viewer?.mapMats;
}
function setDisplayEvent(ev) {
  D.viewer.setEvent(ev); $("#d-event").value = ev; renderSpecies(); displayStats();
}
function stepEvent(k) {
  if (!D.events.length) return;
  const i = D.events.indexOf(D.viewer.event);
  const n = i < 0 ? (k > 0 ? 0 : D.events.length - 1) : (i + k + D.events.length) % D.events.length;
  setDisplayEvent(D.events[n]); D.viewer.setU(0); D.viewer.play(true);
}
function renderSpecies() {
  const v = D.viewer, d = D.data, ev = v.event;
  const counts = v.species.map(() => 0);
  if (d?.available) v.trackInfo.forEach((t) => { if (ev < 0 || t.ev === ev) counts[t.si]++; });
  $("#d-species").innerHTML = v.species.map((s, i) => counts[i] || s.key === "pbar" ? `<div class="sp ${s.on ? "" : "off"}" data-sp="${i}"><i style="color:${s.color};background:${s.color}"></i><b>${s.label}</b><span>${s.name}</span><em>${counts[i]}</em></div>` : "").join("");
  $$("#d-species .sp").forEach((el) => el.addEventListener("click", () => { const i = +el.dataset.sp; v.setSpecies(i, !v.species[i].on); el.classList.toggle("off", !v.species[i].on); }));
}
function displayStats() {
  const d = D.data, ev = D.viewer.event; if (!d?.available) { $("#d-stats").innerHTML = ""; return; }
  const tr = D.viewer.trackInfo.filter((t) => ev < 0 || t.ev === ev);
  const traced = new Set(D.events), inView = (e) => (ev < 0 ? traced.has(e) : e === ev);   // count only events that were traced
  const nAnn = d.vertices.ev.filter(inView).length, nHit = d.hits.filter((h) => inView(h[5])).length;
  const nPi = tr.filter((t) => Math.abs(t.pdg) === 211).length;
  const nTrap = d.trapped ? (d.trapped.ev || []).filter(inView).length : null;
  $("#d-stats").innerHTML = [["Events", ev < 0 ? D.events.length : 1], ["Tracks", tr.length], ["Annihilations", nAnn], ["π± produced", nPi], ["Scint. hits", nHit],
    nTrap != null ? ["Trapped p̄", nTrap] : ["Magnets", d.params?.magnetModel === 0 ? "analytic" : "CST ROM"]].map(([l, v]) => `<div><div class="l">${l}</div><div class="v">${v}</div></div>`).join("");
}
/* ---------------- annihilation sound ---------------- */
// every scintillator hit plays a note: pitch from the slab's position along the beam (A minor pentatonic,
// upstream = low, downstream = high), timbre from the particle, loudness from the deposited energy;
// every annihilation vertex is a soft low drum
const SND = { on: store.get("sound", false), ctx: null };
const PENTA = [0, 3, 5, 7, 10];
function sndInit() {
  if (SND.ctx) { SND.ctx.resume(); return; }
  const C = new (window.AudioContext || window.webkitAudioContext)();
  const comp = C.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 8;
  const master = C.createGain(); master.gain.value = 0.55;
  const rev = C.createConvolver(), len = Math.floor(C.sampleRate * 2.4), ir = C.createBuffer(2, len, C.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
  rev.buffer = ir; const wet = C.createGain(); wet.gain.value = 0.32;
  master.connect(comp); master.connect(rev); rev.connect(wet); wet.connect(comp); comp.connect(C.destination);
  Object.assign(SND, { ctx: C, master });
}
function sndNote(freq, gain, pan, type, dur) {
  const C = SND.ctx; if (!C) return; const t = C.currentTime;
  const g = C.createGain(), pn = C.createStereoPanner(); pn.pan.value = pan;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(pn); pn.connect(SND.master);
  for (const [mul, a] of [[1, 1], [2.01, 0.28], [3.98, 0.08]]) {      // a little bell shimmer
    const o = C.createOscillator(), og = C.createGain(); o.type = mul === 1 ? type : "sine"; o.frequency.value = freq * mul; og.gain.value = a;
    o.connect(og); og.connect(g); o.start(t); o.stop(t + dur + 0.05);
  }
}
function sndThump(gain) {
  const C = SND.ctx; if (!C) return; const t = C.currentTime;
  const o = C.createOscillator(), g = C.createGain(); o.type = "sine";
  o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  o.connect(g); g.connect(SND.master); o.start(t); o.stop(t + 0.6);
}
function soundHits(hits, anns) {
  if (!SND.on || !SND.ctx) return;
  const sc = (D.geo?.scintillators || []).slice().sort((a, b) => a.z0 - b.z0).map((x) => x.id);
  // annihilations: one soft drum at most every ~100 ms, so "all events" playback stays musical
  const now = SND.ctx.currentTime;
  if (anns.length && now - (SND.lastThump || 0) > 0.1) { SND.lastThump = now; sndThump(Math.min(0.55, 0.3 + 0.05 * anns.length)); }
  hits.slice(0, 10).forEach((h) => {
    const k = Math.max(0, sc.indexOf(h[0])), pdg = Math.abs(h[6]), e = h[7] || 1;
    let f = 220 * Math.pow(2, (12 * Math.floor(k / 5) + PENTA[k % 5]) / 12), type = "triangle", dur = 1.6, g = Math.min(0.55, 0.14 + 0.16 * e);
    if (pdg === 11 || pdg === 22) { f *= 2; type = "sine"; dur = 0.55; g *= 0.6; }          // e± / γ: short, high
    else if (pdg === 2212 || pdg > 1e9) { f /= 2; type = "sine"; dur = 1.0; }                 // protons / fragments: low
    else if (pdg === 13) { type = "sawtooth"; g *= 0.4; dur = 0.8; }                          // muons: buzzy
    sndNote(f, g, Math.max(-0.85, Math.min(0.85, h[3] / 1100)), type, dur);
  });
  const b = $("#d-sound"); b.classList.remove("ping"); void b.offsetWidth; b.classList.add("ping");
}

/* ---------------- webcam hand control ---------------- */
// gestures from twin/static/hands.js drive the 3D view; the camera image never leaves the browser
const HC = { ctl: null };
async function handsOn() {
  const btn = $("#d-hands"), panel = $("#d-handpanel"), st = $("#hp-status");
  if (!navigator.mediaDevices?.getUserMedia) { toast("This browser has no camera access (needs https or localhost)"); return; }
  btn.classList.add("on"); panel.hidden = false; $("#d-cbars").style.visibility = "hidden";   // the camera panel sits where the legend is
  try {
    const { HandControl } = await import("./hands.js");
    HC.ctl = new HandControl({ video: $("#hp-video"), canvas: $("#hp-cv"), emit: handEvent, onStatus: (t) => (st.textContent = t) });
    await HC.ctl.start();
  } catch (e) {
    const msg = e?.name === "NotAllowedError" ? "Camera blocked: allow camera access for this page" : e?.name === "NotFoundError" ? "No camera found" : "Could not start: " + (e?.message || e);
    st.textContent = msg; HC.ctl?.stop(); HC.ctl = null; btn.classList.remove("on");
  }
}
function handsOff() {
  HC.ctl?.stop(); HC.ctl = null;
  $("#d-hands").classList.remove("on"); $("#d-handpanel").hidden = true; $("#hp-cursor").hidden = true; $("#d-cbars").style.visibility = "";
}
// camera coordinates (0..1, mirrored) -> viewport pixels; the middle 80 % of the image spans the whole view
function handToView(x, y) {
  const r = $("#viewport").getBoundingClientRect(), f = (v) => Math.min(1, Math.max(0, (v - 0.1) / 0.8));
  return { left: f(x) * r.width, top: f(y) * r.height, clientX: r.left + f(x) * r.width, clientY: r.top + f(y) * r.height };
}
function handEvent(ev) {
  const V = D.viewer; if (!V || S.page !== "display") return;
  const cur = $("#hp-cursor");
  if (ev.type === "status") { $("#hp-status").textContent = ev.text; return; }
  if (ev.type === "cursor") {
    cur.hidden = !ev.visible; if (!ev.visible) return;
    const p = handToView(ev.x, ev.y); cur.style.left = p.left + "px"; cur.style.top = p.top + "px";
    cur.classList.toggle("pinch", ev.pose === "pinch"); return;
  }
  if (ev.type === "rotate") {                     // orbit the camera around its target
    const c = V.camera, t = V.controls.target, off = c.position.clone().sub(t);
    const r = off.length(), th = Math.atan2(off.x, off.z) - ev.dx * 7, ph = Math.min(3.05, Math.max(0.1, Math.acos(off.y / r) - ev.dy * 5));
    c.position.set(t.x + r * Math.sin(ph) * Math.sin(th), t.y + r * Math.cos(ph), t.z + r * Math.sin(ph) * Math.cos(th));
    V.story.auto = false; V.controls.update(); return;
  }
  if (ev.type === "zoom") {
    const c = V.camera, t = V.controls.target, off = c.position.clone().sub(t);
    const r = Math.min(20000, Math.max(40, off.length() / Math.pow(ev.k, 1.6)));
    c.position.copy(t).add(off.setLength(r)); V.story.auto = false; V.controls.update(); return;
  }
  if (ev.type === "time") {
    if (V.story.on) { V.storyPlay(false); V.story.auto = true; V.setStory(ev.u); } else { V.play(false); V.setU(ev.u); }
    return;
  }
  const ring = $(".ring", cur), lbl = $("#hp-cur-t");
  const meaningful = (g) => g !== "open" || !!(QS.quenched || QS.timer);
  if (ev.type === "hold") {
    const on = ev.gesture && meaningful(ev.gesture);
    ring.style.strokeDasharray = `${on ? ev.progress * 100 : 0} 100`;
    lbl.textContent = on ? { point: "select…", fist: "quench 5 T…", thumbsup: "play / pause…", open: "reset…" }[ev.gesture] : "";
    return;
  }
  if (ev.type === "fire") {
    ring.style.strokeDasharray = "0 100"; lbl.textContent = "";
    if (ev.gesture === "point") { const p = handToView(ev.x, ev.y); V.pick({ clientX: p.clientX, clientY: p.clientY }); }
    else if (ev.gesture === "thumbsup") V.story.on ? V.storyPlay() : V.play();
    else if (ev.gesture === "fist" && D.geo?.magnets?.length) quenchMagnet("5T");
    else if (ev.gesture === "open" && meaningful("open")) resetScenario();
  }
}

/* ---------------- explainer cards (story mode) ---------------- */
const EX = { on: store.get("explain", false), shown: -1 };
const EXPLAIN = [
  { k: "1 · ELENA → AEgIS", t: "Antiprotons on demand", p: [
      "Antiprotons are made at CERN by firing protons from the PS into a target. The Antiproton Decelerator slows them down, and the small ELENA ring (30 m around) slows them further, from 5.3 MeV to 100 keV.",
      "The LNE transfer lines then steer each 100 keV bunch electrostatically to the experiments. Here the bunch arrives at the AEgIS delivery point."],
    chips: () => [["ELENA", "5.3 MeV → 100 keV"], ["Bunch", "100 keV p̄"]], src: "AEgIS overview (2024)" },
  { k: "2 · Magnets", t: "Why superconducting magnets?", p: [
      "A charged particle in a magnetic field spirals around the field lines, so a strong axial field stops the antiprotons from drifting into the walls. AEgIS catches and cools them at 5 T: electrons lose energy by cyclotron radiation (∝ B²) and cool the antiprotons by collisions. Antihydrogen is formed in the gentler 1 T region.",
      "The niobium-titanium coils only superconduct below 9 K, so they sit in liquid helium at 4.2 K, wrapped in a 77 K liquid-nitrogen shield inside a vacuum vessel."],
    chips: () => { const c = cryoTotals(); return [["B max", (D.viewer.Bmax || 0).toFixed(2) + " T"], ["LHe now", `${Math.round(c.LHe.L)} L · coils covered ${fmtHold(c.LHe.h)}`], ["LN₂ now", `${Math.round(c.LN2.L)} L · ${fmtHold(c.LN2.h)}`]]; },
    src: "Volponi (2024), Huck (2025)" },
  { k: "3 · Electrodes", t: "A Penning–Malmberg trap", p: [
      "The magnetic field holds particles radially; along the axis they are held by voltages on a stack of ring electrodes. For negatively charged antiprotons the −14 kV electrodes (HV1, HV2) are walls, and the electrodes near 0 V between them form the well where antiprotons and cooling electrons are stored.",
      "The traps sit in an ultra-high vacuum of about 10⁻¹³ mbar, cryo-pumped by the cold walls, so the antiprotons can live for minutes to hours."],
    chips: () => [["Electrodes", `${D.geo?.electrodes?.length || 66}`], ["Walls", "−14 kV"], ["Vacuum", "~10⁻¹³ mbar"]], src: "Volponi (2024), Huck (2025)" },
  { k: "4 · Catching", t: "Catch, hold, annihilate", p: [
      "The 100 keV antiprotons pass a thin degrader foil, which slows most of them to a few keV. HV2 reflects them, and HV1 is switched to −14 kV behind them in about 20 ns: pulsed catching. Watch the Φ(z) curve close.",
      "An antiproton that touches matter annihilates with a nucleus. On average about three charged pions fly out through the cryostat and light up the scintillators: that is how the experiment sees antimatter. Turn on ♪ to hear each hit."],
    chips: () => { const p = D.data?.pulses?.[0]; return [["Degrader", "1.5 µm Parylene"], p ? ["Pulse", `${p.id} closes at ${p.t0} ns${p.open ? ", opens at " + fmtTime(p.open) : ""}`] : ["Pulse", "static"], ["Trapped", `${D.data?.trapped?.n ?? "—"}`]]; },
    src: "this G4beamline run" },
  { k: "What comes next", t: "Towards a beam of antihydrogen", p: [
      "The cooled antiprotons are moved to the 1 T trap. Laser-excited (Rydberg) positronium passes by and hands over its positron, which forms antihydrogen. The antihydrogen is neutral, so it leaves the trap as a beam.",
      "AEgIS aims to measure how that beam falls in Earth's gravity: does antimatter fall like matter?"],
    chips: () => [], src: "AEgIS" },
];
const fmtHold = (h) => (h >= 48 ? (h / 24).toFixed(1) + " days" : h.toFixed(0) + " h");
function explainShow(i) {
  const c = EXPLAIN[i], box = $("#d-explainer"); EX.shown = i;
  box.innerHTML = `<div class="ex-k">${c.k}</div><h3>${c.t}</h3>${c.p.map((t) => `<p>${t}</p>`).join("")}
    <div class="chips">${c.chips().map(([a, b]) => `<span>${a} <b>${b}</b></span>`).join("")}</div>
    <div class="row"><span class="src">${c.src}</span><button class="btn small" id="ex-off">Hide explanations</button>${i < EXPLAIN.length - 1 ? `<button class="btn small primary" id="ex-go">Continue ›</button>` : `<button class="btn small primary" id="ex-close">Close</button>`}</div>`;
  box.hidden = false; box.style.animation = "none"; box.offsetHeight; box.style.animation = "";
  $("#ex-off").onclick = () => { EX.on = false; store.set("explain", false); $("#d-explain").classList.remove("on"); box.hidden = true; D.viewer.storyPlay(true); };
  if ($("#ex-go")) $("#ex-go").onclick = () => { box.hidden = true; D.viewer.storyPlay(true); };
  if ($("#ex-close")) $("#ex-close").onclick = () => (box.hidden = true);
}
function explainStep(u, i) {
  if (!EX.on || !D.viewer?.story.on) return;
  if (u >= 0.999 && EX.shown !== EXPLAIN.length - 1) return explainShow(EXPLAIN.length - 1);
  if (D.viewer.story.playing && i !== EX.shown && u < 0.999 && i > EX.shown) { D.viewer.storyPlay(false); explainShow(i); }
  if (i < EX.shown && u < 0.999) EX.shown = i - 1;          // jumped back: show it again next time
}

/* ---------------- quench & boil-off scenarios ---------------- */
const QS = { timer: null, hours: 0, quenched: null };
const HOURS_PER_SEC = 3;
function cryoTotals() {
  const out = { LHe: { L: 0 }, LN2: { L: 0 } };
  (D.geo?.cryo || []).forEach((v) => { const st = D.viewer?.cryoState(v.id); if (st) out[v.cryogen].L += st.litres; });
  out.LN2.h = (24 * out.LN2.L) / CRYO_USE.LN2;
  // helium: what matters is how long every coil stays covered, not when the last drop is gone
  const capAll = (D.geo?.cryo || []).filter((v) => v.cryogen === "LHe").reduce((a, v) => a + (D.viewer?.cryoState(v.id)?.capacity || 0), 0);
  const hrs = (D.geo?.magnets || []).map((m) => { const st = D.viewer?.cryoState(m.vessel), c = coilCover(m); if (!st || !c.top) return Infinity;
    const usable = Math.max(0, st.litres - c.litres), rate = (CRYO_USE.LHe * st.capacity) / capAll; return (24 * usable) / rate; });
  out.LHe.h = Math.min(...hrs, (24 * out.LHe.L) / CRYO_USE.LHe); return out;
}
// helium level relative to the top of a magnet's coil pack (mm, + = coils covered)
function coilCover(m) {
  const c = D.viewer.cryo[m.vessel]; if (!c) return Infinity;
  const top = Math.max(...D.geo.coils.filter((k) => m.coils.includes(k.id)).map((k) => k.ro));
  return { top, above: c.h - top, litres: D.viewer.cryoLitres(c.v, top) };
}
function qAlert(html, quench) { const a = $("#d-qalert"); a.innerHTML = html; a.classList.toggle("quench", !!quench); a.hidden = !html; }
function quenchField(m, fB) {
  const src = D.viewer._fieldSrc; if (!src) return;
  const bz = new Array(src.zB.length).fill(0);
  src.coils.forEach((c) => { const I = c.I * (m.coils.includes(c.id) ? fB : 1); c.bz0.forEach((b, i) => (bz[i] += I * b)); });
  D.viewer.setField(src.zB, bz);
}
function quenchMagnet(id) {
  const m = D.geo.magnets.find((x) => x.id === id); if (!m) return;
  stopBoiloff(); const st = D.viewer.cryoState(m.vessel); QS.quenched = id;
  D.viewer.startQuench({ id, coils: m.coils, z0: m.z0, z1: m.z1, vessel: m.vessel, boilFill: m.boil_litres / st.capacity,
    onField: (fB) => quenchField(m, fB), onLevel: () => cryoSync() });
  qAlert(`⚡ <b>QUENCH · ${m.name}</b> — the coil turns normal-conducting and its field collapses
    <span class="qs">≈ ${m.stored_MJ} MJ of stored energy ends up in the helium bath · up to ≈ ${Math.round(m.boil_litres)} L of liquid helium boils off and vents ·
    the antiprotons lose their radial confinement (estimate: uniform-solenoid energy, no dump resistor)</span>`, true);
}
function stopBoiloff() { clearInterval(QS.timer); QS.timer = null; $("#cr-boil")?.classList.remove("primary"); }
function startBoiloff() {
  if (QS.timer) { stopBoiloff(); qAlert(""); return; }
  D.viewer.stopQuench(); QS.quenched = null; QS.hours = 0; let last = performance.now();
  $("#cr-boil").classList.add("primary");
  QS.timer = setInterval(() => {
    const now = performance.now(), dh = ((now - last) / 1000) * HOURS_PER_SEC; last = now; QS.hours += dh;
    for (const k of ["LHe", "LN2"]) {
      const g = D.geo.cryo.filter((v) => v.cryogen === k), cap = g.reduce((a, v) => a + D.viewer.cryoState(v.id).capacity, 0);
      g.forEach((v) => { const s0 = D.viewer.cryoState(v.id); D.viewer.setCryoFill(v.id, (s0.litres - (CRYO_USE[k] / 24) * dh * s0.capacity / cap) / s0.capacity); });
    }
    cryoSync();
    const rows = D.geo.magnets.map((m) => ({ m, c: coilCover(m) }));
    const hit = rows.find((r) => Number.isFinite(r.c.above) && r.c.above < 0);
    qAlert(`⏱ <b>Boil-off time-lapse · +${QS.hours.toFixed(0)} h</b> without refilling
      <span class="qs">${rows.map((r) => `${r.m.name}: ${Number.isFinite(r.c.above) ? `helium ${r.c.above.toFixed(0)} mm above the coils` : "vessel full"}`).join(" · ")} · AEgIS refills every couple of days</span>`);
    if (hit) quenchMagnet(hit.m.id);
  }, 60);
}
function resetScenario() {
  stopBoiloff(); D.viewer.stopQuench(); QS.quenched = null; qAlert("");
  (D.geo?.cryo || []).forEach((v) => D.viewer.setCryoFill(v.id, 1)); cryoSync();
}

/* ---------------- cryogen fill levels ---------------- */
const CRYO_USE = { LHe: 150, LN2: 5 };     // L/day in operation, Derking et al. 2014
function buildCryoUI() {
  const box = $("#d-cryo"), vs = D.geo?.cryo || [];
  if (!vs.length) { box.hidden = true; return; }
  const col = { LHe: "#5ac8fa", LN2: "#7d7aff" };
  box.innerHTML = vs.map((v) => `<div class="cr-row"><span><i style="background:${col[v.cryogen]}"></i>${v.cryogen === "LHe" ? "LHe" : "LN₂"} · ${v.magnet}</span><b id="cr-v-${v.id}"></b></div>
      <input type="range" min="0" max="100" step="1" data-cryo="${v.id}" style="--c:${col[v.cryogen]}">`).join("") +
    `<div class="cr-sum" id="cr-sum"></div><div class="cr-btns"><button class="btn small" id="cr-fill">Fill all</button><button class="btn small" id="cr-day">+1 day boil-off</button></div>
     <div class="cr-sum" style="margin-top:9px">Scenarios</div>
     <div class="cr-btns"><button class="btn small" id="cr-boil" title="Time-lapse: no refills until the helium uncovers a coil">⏱ Boil-off</button><button class="btn small" id="cr-reset">Reset</button></div>
     <div class="cr-sum" style="margin-top:6px">Quench a magnet</div>
     <div class="cr-btns"><button class="btn small" id="cr-q5" title="Quench the 5 T solenoid">⚡ 5 T</button><button class="btn small" id="cr-q1" title="Quench the 1 T solenoid">⚡ 1 T</button></div>`;
  const set = (id, f) => { D.viewer.setCryoFill(id, f); };
  box.querySelectorAll("[data-cryo]").forEach((r) => r.addEventListener("input", () => { set(r.dataset.cryo, r.value / 100); cryoSync(); }));
  $("#cr-fill").onclick = () => resetScenario();
  $("#cr-boil").onclick = () => startBoiloff(); $("#cr-reset").onclick = () => resetScenario();
  $("#cr-q5").onclick = () => quenchMagnet("5T"); $("#cr-q1").onclick = () => quenchMagnet("1T");
  // one day of operation: the published consumption, shared between the vessels of a cryogen by their capacity
  $("#cr-day").onclick = () => {
    for (const k of ["LHe", "LN2"]) {
      const g = vs.filter((v) => v.cryogen === k), cap = g.reduce((a, v) => a + D.viewer.cryoState(v.id).capacity, 0);
      g.forEach((v) => { const st = D.viewer.cryoState(v.id); set(v.id, (st.litres - CRYO_USE[k] * st.capacity / cap) / st.capacity); });
    }
    cryoSync();
  };
  $('[data-layer="cryo"]').addEventListener("change", (e) => (box.hidden = !e.target.checked));
  box.hidden = !$('[data-layer="cryo"]').checked;
  cryoSync();
}
function cryoSync() {
  const vs = D.geo?.cryo || []; const fill = {};
  vs.forEach((v) => {
    const st = D.viewer.cryoState(v.id); if (!st) return; fill[v.id] = st.fill;
    const r = $(`[data-cryo="${v.id}"]`); r.value = Math.round(st.fill * 100); r.style.setProperty("--p", st.fill * 100 + "%");
    $(`#cr-v-${v.id}`).textContent = `${Math.round(st.litres)} / ${Math.round(st.capacity)} L`;
  });
  store.set("cryoFill", fill);
  const tot = cryoTotals();
  $("#cr-sum").innerHTML = `LHe ${Math.round(tot.LHe.L)} L · coils covered ≈ ${fmtHold(tot.LHe.h)} at ${CRYO_USE.LHe} L/day<br>LN₂ ${Math.round(tot.LN2.L)} L · lasts ≈ ${fmtHold(tot.LN2.h)} at ${CRYO_USE.LN2} L/day` + (D.geo?.magnets || []).map((m) => { const c = coilCover(m); return Number.isFinite(c.above) && c.above < 0 ? `<br><span class="cr-warn">⚠ ${m.name} coils uncovered (${(-c.above).toFixed(0)} mm)</span>` : ""; }).join("");
  if (D.pick?.type === "cryo") showPick(D.pick);
}
function showPick(p) {
  D.pick = p;
  const box = $("#d-info");
  if (!p) { box.hidden = true; return; }
  const { PDG_NAME } = window.TwinViewer;
  let html = "";
  if (p.type === "track") {
    const m = { "-2212": 938.272, 2212: 938.272, 2112: 939.565, 211: 139.57, "-211": 139.57, 11: 0.511, "-11": 0.511, 13: 105.66, "-13": 105.66 }[p.pdg] ?? 0;
    const ke = Math.sqrt(p.p0 * p.p0 + m * m) - m;
    html = `<h4><i style="background:${p.species.color};box-shadow:0 0 8px ${p.species.color}"></i>${PDG_NAME[p.pdg] || "PDG " + p.pdg}</h4><dl>
      <dt>Event / track</dt><dd>${p.ev} / ${p.trk}</dd><dt>Parent track</dt><dd>${p.par || "primary"}</dd>
      <dt>Momentum at start</dt><dd>${p.p0.toFixed(3)} MeV/c</dd>${m ? `<dt>Kinetic energy</dt><dd>${ke < 1 ? (ke * 1000).toFixed(1) + " keV" : ke.toFixed(2) + " MeV"}</dd>` : ""}
      <dt>Created</dt><dd>t ${p.t0.toFixed(2)} ns · z ${p.start[2].toFixed(1)} mm</dd><dt>Ends</dt><dd>t ${p.t1.toFixed(2)} ns · z ${p.end[2].toFixed(1)} mm</dd>
      <dt>Ends at r</dt><dd>${Math.hypot(p.end[0], p.end[1]).toFixed(1)} mm</dd><dt>Path length</dt><dd>${p.L.toFixed(1)} mm</dd></dl>
      <div class="row"><button class="btn small" id="pk-ev">Show event ${p.ev}</button><button class="btn small" id="pk-focus">Focus start</button></div>`;
  } else if (p.type === "electrode") {
    html = `<h4>Electrode ${p.id}</h4><dl><dt>Group</dt><dd>${p.group}</dd><dt>z (CST)</dt><dd>${p.z0.toFixed(1)} … ${p.z1.toFixed(1)} mm</dd><dt>Radius</dt><dd>${p.ri} – ${p.ro} mm</dd><dt>Voltage (run)</dt><dd>${p.V ?? 0} V</dd></dl>`;
  } else if (p.type === "cryo") {
    const g = p.segments, bath = g.filter((x) => !x.yc), res = g.find((x) => x.yc), ri = Math.min(...bath.map((x) => x.ri)), ro = Math.max(...bath.map((x) => x.ro));
    html = `<h4><i style="background:${p.cryogen === "LHe" ? "#5ac8fa" : "#7d7aff"}"></i>${p.name}</h4><dl>
      <dt>Temperature</dt><dd>${p.T} K</dd>${(() => { const st = D.viewer?.cryoState(p.id) || { litres: p.litres, capacity: p.litres, fill: 1, level: Infinity };
        return `<dt>Liquid</dt><dd>${st.litres.toFixed(1)} of ${st.capacity.toFixed(1)} L (${(st.litres * p.mass_kg / p.litres).toFixed(1)} kg)</dd>
        <dt>Fill / level</dt><dd>${Math.round(st.fill * 100)} %${Number.isFinite(st.level) ? ` · surface at y = ${st.level.toFixed(0)} mm` : st.fill >= 0.999 ? " · full" : " · empty"}</dd>`; })()}
      ${p.coil_litres ? `<dt>Displaced by coils</dt><dd>${p.coil_litres} L</dd>` : ""}
      <dt>z (CST)</dt><dd>${Math.min(...g.map((x) => x.z0)).toFixed(0)} … ${Math.max(...g.map((x) => x.z1)).toFixed(0)} mm</dd><dt>${res ? "Bath" : "Radius"}</dt><dd>r ${ri} – ${ro} mm (wall ${p.wall} mm)</dd>${res ? `<dt>Reservoir</dt><dd>Ø${2 * res.ro} mm × ${res.z1 - res.z0} mm, centre ${res.yc} mm above the axis</dd>` : ""}
      <dt>Role</dt><dd>${p.role}</dd></dl>
      <p class="muted" style="font-size:11px;margin:6px 0 0">Nesting (LHe → LN₂ shield → MLI → OVC), bores and consumption are published (Volponi 2024, Huck 2025, Dudarev 2012, Derking 2014);
      wall radii are sized so LHe lasts ~2 days and LN₂ ~3 months at that consumption (no drawing published).</p>`;
  } else if (p.type === "ovc") {
    html = `<h4><i style="background:#aeb4bc"></i>${p.name}</h4><dl>
      <dt>Outer radius</dt><dd>${p.ro} mm (wall ${p.wall} mm)</dd><dt>z (CST)</dt><dd>${p.z0} … ${p.z1} mm</dd>
      <dt>Sections</dt><dd>${p.cans.map((c) => c.name).join(" · ")}</dd>
      <dt>Insulating vacuum</dt><dd>≈ ${(p.vacuum_litres / 1000).toFixed(2)} m³ at ~1e-7 mbar</dd>
      <dt>Beam apertures</dt><dd>Ø${2 * p.apertures[0]} / Ø${2 * p.apertures[1]} mm</dd><dt>Role</dt><dd>${p.role}</dd></dl>
      <p class="muted" style="font-size:11px;margin:6px 0 0">Layout and the ~70 cm scintillator radius are from the Volponi (2024) and Huck (2025) theses; the length, wall and flanges are estimates.</p>`;
  } else if (p.type === "scintillator") {
    const n = D.data?.hits?.filter((h) => h[0] === p.id && (D.viewer.event < 0 || h[5] === D.viewer.event)).length ?? 0;
    html = `<h4>Scintillator ${p.id}</h4><dl><dt>z (CST)</dt><dd>${p.z0.toFixed(0)} … ${p.z1.toFixed(0)} mm</dd><dt>Radius</dt><dd>${p.ri} – ${p.ro} mm</dd><dt>φ</dt><dd>${p.phi0}° – ${p.phi1}°</dd><dt>Hits shown</dt><dd>${n}</dd></dl>`;
  }
  box.innerHTML = `<button class="x" id="pk-x">✕</button>` + html; box.hidden = false;
  $("#pk-x").onclick = () => (box.hidden = true);
  if (p.type === "track") { $("#pk-ev").onclick = () => setDisplayEvent(p.ev); $("#pk-focus").onclick = () => D.viewer.focus(p.start); }
}

/* ---------------- GIF export ---------------- */
const G = { busy: false, stop: false };
function gifOpts() {
  const v = (id) => $(`${id} button.on`).dataset.v;
  const mode = v("#g-mode"), w = +v("#g-w"), fps = +v("#g-fps"), len = +v("#g-len");
  const { STORY } = window.TwinViewer;
  const secs = (mode === "story" ? STORY.reduce((a, c) => a + c.dur, 0) : 9) * len;
  return { mode, w, fps, secs, frames: Math.max(2, Math.round(secs * fps)), labels: $("#g-labels").checked, caps: $("#g-caps").checked };
}
function gifEstimate() {
  const o = gifOpts(), vp = $("#viewport"), h = Math.round((o.w * vp.clientHeight) / vp.clientWidth / 2) * 2;
  const mb = (o.frames * o.w * h * 0.18) / 1e6;
  $("#g-est").textContent = `${o.frames} frames · ${o.w}×${h} · ${o.secs.toFixed(1)} s · ≈ ${mb < 1 ? (mb * 1000).toFixed(0) + " kB" : mb.toFixed(0) + " MB"}`;
}
["#g-mode", "#g-w", "#g-fps", "#g-len"].forEach((id) => seg(id, gifEstimate));
["#g-labels", "#g-caps"].forEach((id) => $(id).addEventListener("change", gifEstimate));
$("#d-gif").addEventListener("click", () => { if (!D.data?.available) return toast("Load a run with trajectories first"); $("#d-gifsheet").hidden = false; $("#g-prog").hidden = true; $("#g-go").disabled = false; gifEstimate(); });
$("#g-cancel").addEventListener("click", () => { if (G.busy) G.stop = true; else $("#d-gifsheet").hidden = true; });
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function composeFrame(ctx, gl, labels, o, W, H) {
  const sx = W / gl.clientWidth, sy = H / gl.clientHeight;
  const g = ctx.createRadialGradient(W * 0.6, H * 0.3, 0, W * 0.6, H * 0.3, W * 0.9);
  g.addColorStop(0, "#1d2230"); g.addColorStop(0.55, "#0b0c10"); g.addColorStop(1, "#000");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(gl, 0, 0, W, H);
  const f = Math.max(0.75, W / 1400);
  if (o.labels) for (const l of labels) {
    ctx.font = l.font.replace(/(\d+(\.\d+)?)px/, (m, n) => (n * f).toFixed(1) + "px"); ctx.fillStyle = l.color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "#000"; ctx.shadowBlur = 3; ctx.fillText(l.text, l.x * sx, l.y * sy); ctx.shadowBlur = 0;
  }
  // header
  ctx.font = `700 ${Math.round(15 * f)}px Inter, sans-serif`; ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText("AEgIS Digital Twin", 18 * f, 16 * f);
  ctx.font = `500 ${Math.round(11.5 * f)}px Inter, sans-serif`; ctx.fillStyle = "rgba(235,235,245,.6)";
  ctx.fillText(`${D.run} · ${D.viewer.event >= 0 ? "event " + D.viewer.event : "all events"}`, 18 * f, 36 * f);
  if (!o.caps) return;
  let k = "", t = "", sub = "";
  if (o.mode === "story") { k = $("#d-cap-k").textContent; t = $("#d-cap-t").textContent; sub = $("#d-cap-s").textContent; }
  else { k = "Event display"; t = "Antiproton transport and annihilation"; sub = $("#d-tread").textContent; }
  ctx.font = `700 ${Math.round(18 * f)}px Inter, sans-serif`;
  const bw = Math.min(W - 40, Math.max(ctx.measureText(t).width, 300 * f) + 48 * f), bh = 72 * f, bx = (W - bw) / 2, by = H - bh - 18 * f;
  roundRect(ctx, bx, by, bw, bh, 14 * f); ctx.fillStyle = "rgba(30,30,34,.72)"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.stroke();
  ctx.textAlign = "center";
  ctx.font = `700 ${Math.round(10.5 * f)}px Inter, sans-serif`; ctx.fillStyle = "#64d2ff"; ctx.fillText(k.toUpperCase(), W / 2, by + 10 * f);
  ctx.font = `700 ${Math.round(18 * f)}px Inter, sans-serif`; ctx.fillStyle = "#fff"; ctx.fillText(t, W / 2, by + 25 * f);
  ctx.font = `500 ${Math.round(12 * f)}px Inter, sans-serif`; ctx.fillStyle = "rgba(235,235,245,.75)"; ctx.fillText(sub, W / 2, by + 50 * f);
}
$("#g-go").addEventListener("click", async () => {
  if (G.busy) return;
  const o = gifOpts(), v = D.viewer, vp = $("#viewport");
  const W = o.w, H = Math.round((o.w * vp.clientHeight) / vp.clientWidth / 2) * 2;
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  G.busy = true; G.stop = false; $("#g-go").disabled = true; $("#g-prog").hidden = false; $("#g-cancel").textContent = "Stop";
  const wasStory = v.story.on;
  if (o.mode === "story" && !wasStory) setStoryMode(true);
  if (o.mode === "story") v.storyPlay(false);
  if (o.mode === "tracks" && wasStory) setStoryMode(false);
  const gif = new GIF({ workers: Math.min(4, navigator.hardwareConcurrency || 2), quality: 10, width: W, height: H, workerScript: "vendor/gif.worker.js", dither: false });
  const bar = $("#g-bar"), stat = $("#g-stat");
  try {
    await v.record({ mode: o.mode, frames: o.frames, shouldStop: () => G.stop,
      onFrame: (gl, labels) => { composeFrame(ctx, gl, labels, o, W, H); gif.addFrame(ctx, { copy: true, delay: Math.round(1000 / o.fps) }); },
      onProgress: (k, n) => { bar.style.width = (50 * k) / n + "%"; stat.textContent = `Rendering frame ${k} / ${n}`; } });
    if (G.stop) throw new Error("cancelled");
    const blob = await new Promise((res, rej) => {
      gif.on("progress", (p) => { bar.style.width = 50 + 50 * p + "%"; stat.textContent = `Encoding GIF ${Math.round(p * 100)} %`; });
      gif.on("finished", res); gif.on("abort", () => rej(new Error("cancelled"))); gif.render();
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `aegis_${D.run}_${v.event >= 0 ? "ev" + v.event : "all"}_${o.mode}.gif`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    stat.textContent = `Saved ${a.download} · ${(blob.size / 1e6).toFixed(1)} MB`; toast("GIF saved");
  } catch (e) { stat.textContent = e.message === "cancelled" ? "Cancelled" : "Failed: " + e.message; gif.abort?.(); }
  finally { G.busy = false; $("#g-go").disabled = false; $("#g-cancel").textContent = "Close"; }
});

/* ---------------- boot ---------------- */
function redrawAll() { if (!S.state) return; drawMag(); drawEl(); if (S.page === "results" && S.selRun) openRun(S.selRun); if (S.page === "beam" && S.lastBeam) showBeam(S.lastBeam); }
async function loadState() {
  S.state = await api("/api/state");
  buildCoils(); buildElectrodes(); if (!S._catchInit) { S._catchInit = true; initCatching(); } redrawAll(); updateRunSummary();
}
(async function boot() {
  S.currents = store.get("currents", {}); S.voltages = store.get("voltages", {});
  $$("#theme-seg button").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.v)));
  applyTheme(store.get("theme", "auto"));
  await loadState();
  await Promise.all([refreshStatus(), refreshRuns(), refreshBeams(), refreshScenarios(), refreshStorage()]);
  go(location.hash.slice(1) || store.get("page", "overview"));
  addEventListener("hashchange", () => location.hash && go(location.hash.slice(1)));
  let prevRunning = 0;
  if (!window.TWIN_STATIC) setInterval(async () => {
    const runs = await refreshRuns(); const n = runs.filter((r) => r.status === "running").length;
    if (n < prevRunning) { toast("Run finished"); if (S.page === "display") initDisplay(); Object.keys(RESULT_CACHE).forEach((k) => RESULT_CACHE[k].status !== "done" && delete RESULT_CACHE[k]); if (S.page === "results") openRun(S.selRun); }
    prevRunning = n; refreshStatus();
    if (S.page === "surrogate") sgRefresh();
  }, 2500);
})();
