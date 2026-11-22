// Static (GitHub Pages) build: answers app.js api() calls from pre-exported JSON in ./api/
(() => {
  const cache = new Map();
  const get = (p) => {
    if (!cache.has(p)) cache.set(p, fetch("api/" + p + ".json").then((r) => {
      if (!r.ok) throw new Error("not available in the static build");
      return r.json();
    }));
    return cache.get(p);
  };
  window.TWIN_STATIC = async (path, body) => {
    const p = decodeURIComponent(path.replace(/^\/api\//, "").split("?")[0]);
    if (body === undefined) return get(p);
    if (p === "fieldmaps") return get("fieldmaps/_default");   // field overlay for tracks without a run folder
    throw new Error("Static showcase: running simulations is not available here");
  };
  const css = document.createElement("style");
  css.textContent = 'a[data-page="simulate"],a[data-page="surrogate"],#ov-manage,#res-del,#rm-del{display:none!important}';
  document.head.appendChild(css);
})();
