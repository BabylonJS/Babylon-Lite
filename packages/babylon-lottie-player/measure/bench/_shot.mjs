// One-off visual check: screenshot the bench page for given player/anim pairs, so we can confirm
// the sprite player actually paints (not blank). Usage: node bench/_shot.mjs sprite:<name> stencil:<name>
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".map": "application/json" };
const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const file = resolve(dist, "." + (url === "/" ? "/page.html" : url));
    if (!existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--ignore-gpu-blocklist"] });
for (const arg of process.argv.slice(2)) {
    const [player, anim] = arg.split(":");
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await page.goto(`${base}/page.html?player=${player}&anim=${anim}`, { waitUntil: "domcontentloaded" });
    try {
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 15000 });
    } catch {
        /* ignore */
    }
    await page.waitForTimeout(1500);
    const out = resolve(here, `shot-${player}-${anim}.png`);
    await page.screenshot({ path: out });
    console.log(`${player}/${anim} -> ${out}  errors=${errs.length}${errs.length ? " :: " + errs.slice(0, 2).join(" | ") : ""}`);
    await page.close();
}
await browser.close();
server.close();
