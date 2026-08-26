// Playwright perf driver — mirrors lite's tests/gl/perf method exactly: wrap requestAnimationFrame
// to time each callback (CPU per frame), warm up, then collect timings over a fixed window and
// compute Potential FPS (1000 / rafAvg), RAF CPU avg + p95, frames, and JS-heap memory. Adds a
// player-agnostic GL draw-call counter (monkeypatches WebGL2RenderingContext draw methods) and
// reads init/TTF the adapters stamped on canvas.dataset. Runs each (player × anim) in a fresh page.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";

const WARMUP_MS = 2000;
const DURATION_MS = Number(process.env.PERF_DURATION || 5) * 1000;
const RETRIES = 2;

// Injected before page scripts: per RAF callback, record its CPU duration AND how many GL draw
// calls it issued, so the driver can measure PER-RENDERED-FRAME cost. This matters for fairness:
// the sprite player throttles to the animation fps and skips most RAF callbacks (empty throttle
// checks), while the stencil player renders every callback — timing all callbacks would wrongly
// flatter the throttling player. We compare only callbacks that actually drew.
const INIT_SCRIPT = `
  window.__frames = [];
  window.__measuring = false;
  window.__dc = 0;
  var _orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb){
    return _orig(function(ts){
      if (window.__measuring) {
        var dc0 = window.__dc; var a = performance.now();
        cb(ts);
        window.__frames.push({ dt: performance.now() - a, dc: window.__dc - dc0 });
      } else { cb(ts); }
    });
  };
  var P = WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  if (P) ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced','drawRangeElements'].forEach(function(m){
    var o = P[m]; if (!o) return;
    P[m] = function(){ window.__dc++; return o.apply(this, arguments); };
  });
`;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".map": "application/json" };

function serve(dir) {
    const server = createServer((req, res) => {
        const url = (req.url || "/").split("?")[0];
        const file = resolve(dir, "." + (url === "/" ? "/page.html" : url));
        if (!existsSync(file)) {
            res.writeHead(404);
            res.end("not found");
            return;
        }
        res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
        res.end(readFileSync(file));
    });
    return server;
}

// Compute per-rendered-frame stats. `frames` = [{dt, dc}] per RAF callback during the window. We
// keep only callbacks that issued >=1 draw (an actually-rendered frame). If a player drew NOTHING
// across the whole window, it didn't render this animation (e.g. the sprite player has no image-
// layer support) — report rendered:false and zeros rather than timing empty rAF callbacks, which
// would otherwise flatter a non-rendering player with a bogus huge FPS.
function stats(frames) {
    const rendered = frames.filter((f) => f.dc > 0);
    if (rendered.length === 0) {
        return { rendered: false, potentialFps: 0, rafAvgMs: 0, rafP95Ms: 0, frames: 0, drawCalls: 0 };
    }
    const dts = rendered.map((f) => f.dt).sort((a, b) => a - b);
    const dcs = rendered.map((f) => f.dc).sort((a, b) => a - b);
    const avg = dts.reduce((s, v) => s + v, 0) / dts.length;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return {
        rendered: true,
        potentialFps: avg > 0 ? Math.round((1000 / avg) * 10) / 10 : 0,
        rafAvgMs: r3(avg),
        rafP95Ms: r3(dts[Math.floor(dts.length * 0.95)]),
        frames: rendered.length,
        drawCalls: dcs[Math.floor(dcs.length / 2)],
    };
}

async function measureOnce(context, base, player, anim) {
    const page = await context.newPage();
    await page.addInitScript({ content: INIT_SCRIPT });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/page.html?player=${player}&anim=${anim}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30000 });

    const ttfMs = await page.evaluate(() => parseFloat(document.querySelector("canvas").dataset.ttfMs || "0"));
    const memoryOf = () =>
        page.evaluate(() => {
            const m = performance.memory;
            return m ? Math.round((m.usedJSHeapSize / (1024 * 1024)) * 10) / 10 : 0;
        });
    const dimsOf = () =>
        page.evaluate(() => {
            const c = document.querySelector("canvas");
            return { w: c.width, h: c.height };
        });

    // lottie-react drives lottie-web on the CPU (Canvas2D) — there is NO WebGL draw boundary, so the
    // dc-based per-frame stats (FPS / RAF CPU / draw calls) and the sync "init" don't apply. Report
    // the cross-renderer-comparable metrics we CAN measure — TTF + memory — and mark the rest N/A.
    if (player === "lottie") {
        const memoryMB = await memoryOf();
        const dims = await dimsOf();
        await page.close();
        return {
            rendered: true,
            potentialFps: null,
            rafAvgMs: null,
            rafP95Ms: null,
            frames: null,
            drawCalls: null,
            initMs: null,
            ttfMs: Math.round(ttfMs),
            memoryMB,
            dims,
            errors: errors.length,
        };
    }

    const initMs = await page.evaluate(() => parseFloat(document.querySelector("canvas").dataset.initMs || "0"));

    await page.waitForTimeout(WARMUP_MS);

    // Measurement window: reset counters, measure, stop.
    await page.evaluate(() => {
        window.__frames = [];
        window.__dc = 0;
        window.__measuring = true;
    });
    await page.waitForTimeout(DURATION_MS);
    const frames = await page.evaluate(() => {
        window.__measuring = false;
        return window.__frames;
    });

    const memoryMB = await memoryOf();
    const dims = await dimsOf();
    await page.close();

    const s = stats(frames);
    return { ...s, initMs: Math.round(initMs), ttfMs: Math.round(ttfMs), memoryMB, dims, errors: errors.length };
}

async function measure(context, base, player, anim) {
    for (let i = 0; i < RETRIES; i++) {
        const r = await measureOnce(context, base, player, anim);
        if (r.rendered) {
            return r;
        }
    }
    return measureOnce(context, base, player, anim);
}

/** Run perf for every (player × anim). `skip(anim, player)` → truthy reason string marks that cell
 *  statically unsupported (no measurement run). Returns { [anim]: { sprite, stencil } }. */
export async function runPerf(dist, anims, skip = () => null) {
    const server = serve(dist);
    await new Promise((r) => server.listen(0, r));
    const base = `http://localhost:${server.address().port}`;
    const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--enable-precise-memory-info", "--force-color-profile=srgb", "--ignore-gpu-blocklist"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

    const results = {};
    for (const anim of anims) {
        results[anim] = {};
        for (const player of ["babylon", "sprite", "stencil", "lottie"]) {
            const unsupported = skip(anim, player);
            if (unsupported) {
                results[anim][player] = { rendered: false, unsupported, errors: 0 };
                console.log(`  ${anim} / ${player} … UNSUPPORTED (${unsupported}) — not measured`);
                continue;
            }
            process.stdout.write(`  ${anim} / ${player} … `);
            const r = await measure(context, base, player, anim);
            results[anim][player] = r;
            const na = (v, suffix = "") => (v == null ? "n/a" : `${v}${suffix}`);
            const tag = r.rendered
                ? `fps≈${na(r.potentialFps)} raf=${na(r.rafAvgMs, "ms")} draws=${na(r.drawCalls)} init=${na(r.initMs, "ms")} ttf=${na(r.ttfMs, "ms")} mem=${na(r.memoryMB, "MB")}`
                : `RENDERED NOTHING init=${r.initMs}ms`;
            console.log(`${tag}${r.errors ? ` ERR=${r.errors}` : ""}`);
        }
    }

    await context.close();
    await browser.close();
    server.close();
    return results;
}
