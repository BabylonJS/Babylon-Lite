// Generate a self-contained, shareable HTML dashboard from the combined size+perf results. No
// external assets — inline CSS + data — so it can be opened or emailed as a single file. Styled
// after lite's perf dashboard: one card per animation, each metric a pair of bars (Sprite vs
// Stencil) with the better value highlighted and a winner badge.

const METRICS = [
    { key: "rawKB", label: "SIZE RAW (KB)", dir: "down", fmt: (v) => v.toFixed(1) },
    { key: "gzipKB", label: "SIZE GZIP (KB)", dir: "down", fmt: (v) => v.toFixed(1) },
    { key: "potentialFps", label: "POTENTIAL FPS", dir: "up", fmt: (v) => v.toFixed(0) },
    { key: "drawCalls", label: "DRAW CALLS", dir: "down", fmt: (v) => String(v) },
    { key: "initMs", label: "INIT TIME (MS)", dir: "down", fmt: (v) => v.toFixed(0) },
    { key: "ttfMs", label: "TIME TO FIRST FRAME (MS)", dir: "down", fmt: (v) => v.toFixed(0) },
    { key: "rafAvgMs", label: "RAF CPU AVG (MS)", dir: "down", fmt: (v) => v.toFixed(3) },
    { key: "rafP95Ms", label: "RAF CPU P95 (MS)", dir: "down", fmt: (v) => v.toFixed(3) },
    { key: "memoryMB", label: "MEMORY (MB)", dir: "down", fmt: (v) => v.toFixed(1) },
];

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function metricRow(m, sprite, stencil, babylon, lottie) {
    // A statically-unsupported player is N/A for EVERY metric (size + perf). A player that rendered
    // nothing at runtime is N/A for perf. And a null perf value → N/A for THAT metric only: lottie-
    // react is a CPU renderer with no WebGL draw boundary, so its FPS / RAF-CPU / draw-calls / init
    // are null while TTF + memory are real.
    const isPerf = m.key !== "rawKB" && m.key !== "gzipKB";
    const naFor = (p) => !!p.unsupported || (isPerf && p.rendered === false);
    const naMetric = (p) => naFor(p) || (isPerf && (p[m.key] === null || p[m.key] === undefined));
    const sprNA = naMetric(sprite);
    const steNA = naMetric(stencil);
    const babNA = naMetric(babylon);
    const lotNA = naMetric(lottie);
    const sv = sprite[m.key] ?? 0;
    const tv = stencil[m.key] ?? 0;
    const bv = babylon[m.key] ?? 0;
    const lv = lottie[m.key] ?? 0;
    const bar = (val, na, color, valColor, cls, label, max) => {
        if (na) {
            return `<div class="row"><span class="who">${label}</span><div class="track"></div><span class="val na">n/a</span></div>`;
        }
        const pct = Math.max(2, (val / max) * 100);
        return `<div class="row"><span class="who ${cls}">${label}</span><div class="track"><div class="fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div><span class="val" style="color:${valColor}">${m.fmt(val)}</span></div>`;
    };

    if (!isPerf) {
        // SIZE metric. The two PRODUCTION players (amber = Babylon.js, magenta = lottie-react) are the
        // baselines the lite players improve on — shown first. Then the lite sprite + full stencil
        // bundles, their worker delivery (⊕w), and the shapes variant for eligible vector-only anims.
        const swv = sprite.worker ? (sprite.worker[m.key] ?? 0) : 0;
        const twv = stencil.worker ? (stencil.worker[m.key] ?? 0) : 0;
        const shapes = stencil.shapes ? stencil.shapes[m.key] : null;
        const shapesW = stencil.shapesWorker ? stencil.shapesWorker[m.key] : null;
        const max = Math.max(babNA ? 0 : bv, lotNA ? 0 : lv, sprNA ? 0 : sv, sprNA ? 0 : swv, steNA ? 0 : tv, twv, shapes ?? 0, shapesW ?? 0, 1e-6);
        const rows =
            bar(bv, babNA, "#e0955a", "#e0955a", "babylon", "babylon (prod)", max) +
            bar(lv, lotNA, "#c77dff", "#c77dff", "lottie", "lottie-react", max) +
            bar(sv, sprNA, "#888", "#ddd", "sprite", "sprite", max) +
            bar(swv, sprNA, "#5a5a5a", "#aaa", "sprite", "sprite ⊕w", max) +
            bar(tv, steNA, "#6aa0e0", "#ddd", "stencil", "full", max) +
            bar(twv, false, "#3f6391", "#aaa", "stencil", "full ⊕w", max) +
            (shapes !== null ? bar(shapes, false, "#46c66a", "#46c66a", "shapes", "↳ shapes", max) : "") +
            (shapesW !== null ? bar(shapesW, false, "#2f7d47", "#9ed0ad", "shapes", "↳ shapes ⊕w", max) : "");
        return `<div class="metric"><div class="mlabel">${m.label} ${m.dir === "up" ? "↑" : "↓"}</div>${rows}</div>`;
    }

    // PERF metric: the two production players vs lite sprite + stencil, the BEST value highlighted.
    const vals = [];
    if (!babNA) vals.push(bv);
    if (!lotNA) vals.push(lv);
    if (!sprNA) vals.push(sv);
    if (!steNA) vals.push(tv);
    const best = vals.length ? (m.dir === "up" ? Math.max(...vals) : Math.min(...vals)) : null;
    const wins = (val, na) => !na && best !== null && val === best;
    const max = Math.max(babNA ? 0 : bv, lotNA ? 0 : lv, sprNA ? 0 : sv, steNA ? 0 : tv, 1e-6);
    const win = "#46c66a";
    const rows =
        bar(bv, babNA, wins(bv, babNA) ? win : "#e0955a", wins(bv, babNA) ? win : "#ddd", "babylon", "babylon (prod)", max) +
        bar(lv, lotNA, wins(lv, lotNA) ? win : "#c77dff", wins(lv, lotNA) ? win : "#ddd", "lottie", "lottie-react", max) +
        bar(sv, sprNA, wins(sv, sprNA) ? win : "#888", wins(sv, sprNA) ? win : "#ddd", "sprite", "sprite", max) +
        bar(tv, steNA, wins(tv, steNA) ? win : "#6aa0e0", wins(tv, steNA) ? win : "#ddd", "stencil", "stencil", max);
    return `<div class="metric"><div class="mlabel">${m.label} ${m.dir === "up" ? "↑" : "↓"}</div>${rows}</div>`;
}

function animCard(name, data) {
    const sprite = data.sprite;
    const stencil = data.stencil;
    const babylon = data.babylon;
    const lottie = data.lottie;
    const dims = stencil.dims || sprite.dims || babylon.dims || lottie.dims || { w: 0, h: 0 };
    const half = Math.ceil(METRICS.length / 2);
    const col = (ms) => ms.map((m) => metricRow(m, sprite, stencil, babylon, lottie)).join("");
    // The only badges are correctness flags: a player that can't render this animation (statically
    // unsupported), rendered nothing at runtime, or hit render errors. No smaller/faster headlines —
    // the per-metric numbers speak for themselves.
    const flag = (p, who) =>
        p.unsupported
            ? `<span class="badge red">✖ ${who} can't render this — ${esc(p.unsupported)}</span>`
            : p.rendered === false
              ? `<span class="badge red">⚠ ${who} renders nothing</span>`
              : p.errors
                ? `<span class="badge red">⚠ ${who} render errors</span>`
                : "";
    const badges = flag(babylon, "babylon") + flag(lottie, "lottie-react") + flag(sprite, "sprite") + flag(stencil, "stencil");
    return `<section class="card">
    <div class="chead"><h2>${esc(name)}</h2><span class="dims">${dims.w}×${dims.h}</span><div class="badges">${badges}</div></div>
    <div class="grid"><div>${col(METRICS.slice(0, half))}</div><div>${col(METRICS.slice(half))}</div></div>
  </section>`;
}

export function generateDashboard(combined, meta = {}) {
    const names = Object.keys(combined);
    const cards = names.map((n) => animCard(n, combined[n])).join("\n");
    const when = new Date().toISOString().replace("T", " ").slice(0, 16);
    return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Lottie Players — Production (Babylon.js, lottie-react) vs Babylon Lite</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#15161a; color:#e8e8ea; font-family:"Segoe UI",system-ui,sans-serif; padding:24px; }
  header { max-width:1100px; margin:0 auto 20px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { opacity:.6; font-size:13px; }
  .legend { margin-top:10px; font-size:12px; display:flex; gap:16px; align-items:center; }
  .swatch { display:inline-block; width:11px; height:11px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  .card { max-width:1100px; margin:0 auto 16px; background:#1d1f25; border:1px solid #000; border-radius:10px; padding:16px 20px; }
  .chead { display:flex; align-items:center; gap:12px; margin-bottom:14px; flex-wrap:wrap; }
  .chead h2 { font-size:17px; margin:0; }
  .dims { font-size:12px; opacity:.5; font-variant-numeric:tabular-nums; }
  .badges { margin-left:auto; display:flex; gap:8px; }
  .badge { font-size:12px; padding:3px 9px; border-radius:20px; font-weight:600; }
  .badge.green { background:#16351f; color:#5fd07e; border:1px solid #2a5a39; }
  .badge.red { background:#3a1d1d; color:#e08a8a; border:1px solid #5a2a2a; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px 36px; }
  .metric { margin-bottom:11px; }
  .mlabel { font-size:11px; letter-spacing:.04em; opacity:.65; margin-bottom:4px; text-transform:uppercase; }
  .row { display:flex; align-items:center; gap:8px; margin:2px 0; }
  .who { font-size:11px; width:80px; opacity:.7; white-space:nowrap; }
  .track { flex:1; background:#0e0f12; border-radius:4px; height:15px; overflow:hidden; }
  .fill { height:100%; border-radius:4px; }
  .val { font-size:12px; width:64px; text-align:right; font-variant-numeric:tabular-nums; }
  .val.na { color:#a06; opacity:.7; }
  @media (max-width:720px){ .grid{grid-template-columns:1fr;} }
</style></head>
<body>
  <header>
    <h1>Lottie Players — Production (Babylon.js · lottie-react) vs Babylon Lite (Sprite · Stencil) <span style="opacity:.4;font-weight:400">(WebGL2 · lottie-react is CPU)</span></h1>
    <div class="sub">${esc(meta.note || "Per-animation size + runtime comparison.")} · generated ${when}</div>
    <div class="legend">
      <span><span class="swatch" style="background:#e0955a"></span>Babylon.js (production, @babylonjs/core)</span>
      <span><span class="swatch" style="background:#c77dff"></span>lottie-react (production, lottie-web · CPU)</span>
      <span><span class="swatch" style="background:#6aa0e0"></span>Lite Stencil (vector)</span>
      <span><span class="swatch" style="background:#888"></span>Lite Sprite (raster)</span>
      <span><span class="swatch" style="background:#3f6391"></span>⊕w = with worker (production: client + shipped worker)</span>
      <span><span class="swatch" style="background:#46c66a"></span>↳ shapes = shapes-only /shapes build (eligible vector-only anims)</span>
      <span style="opacity:.5">↑ higher is better · ↓ lower is better</span>
    </div>
  </header>
  ${cards}
  <div style="max-width:1100px;margin:8px auto;opacity:.4;font-size:11px;">
    <b>babylon (prod)</b> = @babylonjs/lottie-player 9.8.0 (a sprite atlas on a @babylonjs/core ThinEngine) — the player shipping in production TODAY, measured flat (LocalPlayer, everything loaded). It shares the lite sprite player's raster-atlas limits (no morphs/masks/images), so it's N/A for the same animations.
    <b>lottie-react (prod)</b> = lottie-react ^2.3.1, a thin React wrapper over lottie-web (the reference CPU renderer, Canvas2D). Size measured flat with React EXTERNAL (a React app already ships React). It renders on the CPU, so it has no WebGL draw boundary — FPS / RAF-CPU / draw-calls / init are N/A; we report TTF + memory. It supports the FULL Lottie format, so it is never capability-gated.
    Size: esbuild minify+treeshake, gzip L9, babylon-lite-gl tree-shaken in. Full stencil is one flat bundle for every animation; sprite uses its shipped triggered feature chunks.
    <b>⊕w</b> = main-thread client + the actual full or shapes worker for stencil; sprite uses its shipped worker chunks. Render work runs off the main thread.
    ↳ shapes = the flat <code>@babylonjs/lottie-player/shapes</code> build (text+image renderers and their lite-gl texture path tree-shaken away), shown for eligible vector-only animations — local and ⊕w worker.
    Perf: headed Chrome, RAF-callback CPU timing (lite's method), Potential FPS = 1000/RAF-avg, draw calls counted at the GL boundary, memory = JS heap. JSON payloads not included.
  </div>
</body></html>`;
}
