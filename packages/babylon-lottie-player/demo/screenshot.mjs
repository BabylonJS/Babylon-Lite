// Screenshot the fill-validation harness with headed Chrome (real GPU) for the available fixtures.
//   node packages/babylon-lottie-player/demo/screenshot.mjs
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".map": "application/json" };

const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const file = resolve(dist, "." + (url === "/" ? "/index.html" : url));
    if (!existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--use-gl=angle", "--use-angle=default", "--ignore-gpu-blocklist"] });
const anims = process.argv.slice(2).length ? process.argv.slice(2) : ["_stroketest", "_masktest"];
// THREAD=worker drives the off-thread worker player (OffscreenCanvas) instead of the main-thread
// path; RENDERER=shapes selects the shapes-only player/worker. Both default to the main-thread full
// player, matching the historical behavior.
const thread = process.env.THREAD === "worker" ? "worker" : "main";
const rendererKind = process.env.RENDERER === "shapes" ? "shapes" : "full";
for (const arg of anims) {
    // Accept "name" or "name@t" where t is a 0..1 fraction of the play span (fixed frame).
    const [name, tStr] = arg.split("@");
    let query = `?anim=${name}`;
    if (tStr !== undefined) {
        query += `&t=${tStr}`;
    }
    if (thread === "worker") {
        query += `&thread=worker`;
    }
    if (rendererKind === "shapes") {
        query += `&renderer=shapes`;
    }
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/index.html${query}`, { waitUntil: "load" });
    let ready = false;
    try {
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 10000 });
        ready = true;
    } catch {
        // Keep the screenshot for diagnosis even when the readiness marker times out.
    }
    await page.waitForTimeout(thread === "worker" ? 2500 : 500); // worker self-drives live; let the animation build
    const tag = (thread === "worker" ? "-worker" : "") + (rendererKind === "shapes" ? "-shapes" : "");
    const suffix = (tStr !== undefined ? `-t${tStr}` : "") + tag;
    const out = resolve(here, `shot-${name}${suffix}.png`);
    await page.screenshot({ path: out });
    const dims = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        return c ? { w: c.width, h: c.height } : null;
    });
    console.log(
        `${name}${suffix}: ready=${ready} dims=${dims ? dims.w + "x" + dims.h : "?"} errors=${errors.length}${errors.length ? " :: " + errors.slice(0, 3).join(" | ") : ""} -> ${out}`
    );
    await page.close();
}
await browser.close();
server.close();
console.log("done");
