/**
 * Temporary handoff tooling for the glTF-export parity scenes — delete before merging.
 *
 * Local stand-in for the parity specs + captureGolden when the sandbox cannot reach the playground asset hosts: it
 * serves those hosts from the mirror built by build-asset-mirror.sh through Playwright request routing. The committed
 * scenes keep the playgrounds' original URLs; CI fetches them for real. Runs headless Chromium with SwiftShader WebGPU.
 *
 * Needs the lab dev server: `LAB_DEV_PORT=5179 pnpm --filter @babylon-lite/lab dev`.
 * Run from the repo root with tsx (it imports tests/shared/compare-core.ts):
 *   npx tsx scripts/gltf-export-parity/xrun.mjs golden   <id> [query]   capture reference/lite/<slug>/babylon-ref-golden.png
 *   npx tsx scripts/gltf-export-parity/xrun.mjs lite     <id> [query]   screenshot sceneN.html and print MAD vs the golden
 *   npx tsx scripts/gltf-export-parity/xrun.mjs fidelity <id> <referenceImage.png> <errorRatio> [query]
 *        render babylon-ref-sceneN.html?antialias=0 at 600x400 like Babylon.js's visualization harness and compare with
 *        Babylon.js's reference image using its rule (pixelmatch threshold 0.035, pass when differing pixels <= errorRatio %)
 *   npx tsx scripts/gltf-export-parity/xrun.mjs shot     <url> <out.png> [w] [h]
 * Env: GLTF_PARITY_WORK (default ~/.cache/gltf-parity, as in build-asset-mirror.sh), LAB_URL (default http://localhost:5179),
 *      SHOT_TIMEOUT_MS (default 240000; heavy scenes such as TeapotsGalore take > 30 s per screenshot under SwiftShader).
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { compareImages, generateDiffMap, waitForCanvasReady } from "../../tests/shared/compare-core.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = process.env.GLTF_PARITY_WORK ?? path.join(os.homedir(), ".cache/gltf-parity");
const MIRROR = path.join(WORK, "mirror");
const BJS_REFS = path.join(WORK, "bjs-reference-images");
const BASE = process.env.LAB_URL ?? "http://localhost:5179";
const SHOT_TIMEOUT = Number(process.env.SHOT_TIMEOUT_MS ?? 240_000);
const OUT = path.join(WORK, "out");

const MIRRORED = /^https:\/\/(playground\.babylonjs\.com|models\.babylonjs\.com|cdn\.babylonjs\.com|assets\.babylonjs\.com|cdn\.jsdelivr\.net|i\.imgur\.com)\//;
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".ktx2": "image/ktx2", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".json": "application/json" };

function slugFor(id) {
    const entry = JSON.parse(fs.readFileSync(path.join(REPO, "scene-config.json"), "utf8")).find((s) => s.id === id);
    if (!entry) {
        throw new Error(`no scene-config.json entry for ${id}`);
    }
    return entry.slug;
}

async function open(width, height) {
    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
        headless: true,
        args: ["--force-color-profile=srgb", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-angle=swiftshader", "--disable-vulkan-fallback-to-gl-for-testing", "--ignore-gpu-blocklist"],
    });
    const context = await browser.newContext({ viewport: { width, height } });
    const misses = new Set();
    await context.route(MIRRORED, async (route) => {
        const url = new URL(route.request().url());
        const file = path.join(MIRROR, url.host, decodeURIComponent(url.pathname));
        const headers = { "Access-Control-Allow-Origin": "*" };
        if (!file.startsWith(MIRROR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            misses.add(url.href);
            await route.fulfill({ status: 404, headers, body: "not mirrored" });
            return;
        }
        await route.fulfill({ status: 200, headers, contentType: TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    const logs = [];
    page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
    return {
        page,
        report() {
            if (misses.size) {
                console.log("UNMIRRORED:\n  " + [...misses].join("\n  "));
            }
            if (logs.length) {
                console.log("CONSOLE:\n  " + logs.slice(0, 40).join("\n  "));
            }
        },
        close: () => browser.close(),
    };
}

async function waitReady(page, label, query) {
    await waitForCanvasReady(page, { timeout: 120_000, label });
    if (/seekTime=/.test(query)) {
        await waitForCanvasReady(page, { timeout: 120_000, label, flag: "animationFrozen" });
    }
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    fs.mkdirSync(OUT, { recursive: true });
    if (cmd === "golden" || cmd === "lite") {
        const id = Number(args[0]);
        const query = args[1] ? `?${args[1]}` : "";
        const refDir = path.join(REPO, "reference/lite", slugFor(id));
        fs.mkdirSync(refDir, { recursive: true });
        const s = await open(1280, 720);
        try {
            if (cmd === "golden") {
                await s.page.goto(`${BASE}/babylon-ref-scene${id}.html${query}`);
                await waitReady(s.page, `bjs ${id}`, query);
                await s.page.waitForFunction(() => !document.getElementById("babylonjsLoadingDiv"), { timeout: 10_000 }).catch(() => {});
                await s.page.waitForTimeout(1500);
                const out = path.join(refDir, "babylon-ref-golden.png");
                await s.page.locator("canvas").screenshot({ path: out, timeout: SHOT_TIMEOUT });
                console.log(`golden -> ${out}`);
            } else {
                await s.page.goto(`${BASE}/scene${id}.html${query}`);
                await waitReady(s.page, `lite ${id}`, query);
                await s.page.locator("#loader-overlay").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
                await s.page.waitForTimeout(500);
                const actual = path.join(refDir, "test-actual.png");
                const golden = path.join(refDir, "babylon-ref-golden.png");
                await s.page.locator("canvas").screenshot({ path: actual, timeout: SHOT_TIMEOUT });
                const r = compareImages(actual, golden);
                const diffMap = path.join(OUT, `diff-${id}.png`);
                generateDiffMap(actual, golden, diffMap);
                console.log(`scene ${id}${query}: MAD=${r.mad.toFixed(4)} within5=${((100 * r.within5) / r.totalPixels).toFixed(1)}%  diffmap=${diffMap}`);
            }
        } finally {
            s.report();
            await s.close();
        }
    } else if (cmd === "fidelity") {
        const pixelmatch = createRequire(path.join(WORK, "package.json"))("pixelmatch");
        const id = Number(args[0]);
        const refImage = path.isAbsolute(args[1]) ? args[1] : path.join(BJS_REFS, args[1]);
        const errorRatio = Number(args[2] ?? 1.1);
        const query = `?antialias=0${args[3] ? `&${args[3]}` : ""}`;
        const s = await open(600, 400);
        try {
            await s.page.goto(`${BASE}/babylon-ref-scene${id}.html${query}`);
            await waitReady(s.page, `bjs ${id}`, query);
            await s.page.waitForFunction(() => !document.getElementById("babylonjsLoadingDiv"), { timeout: 10_000 }).catch(() => {});
            await s.page.waitForTimeout(1000);
            const out = path.join(OUT, `fidelity-${id}.png`);
            await s.page.screenshot({ path: out, timeout: SHOT_TIMEOUT });
            const a = PNG.sync.read(fs.readFileSync(out));
            const b = PNG.sync.read(fs.readFileSync(refImage));
            if (a.width !== b.width || a.height !== b.height) {
                throw new Error(`size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
            }
            const diff = new PNG({ width: a.width, height: a.height });
            const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.035 });
            fs.writeFileSync(path.join(OUT, `fidelity-${id}-diff.png`), PNG.sync.write(diff));
            const ratio = (100 * n) / (a.width * a.height);
            console.log(`fidelity ${id} vs ${path.basename(refImage)}: ${n} px differ (${ratio.toFixed(3)}%, limit ${errorRatio}%) MAD=${compareImages(out, refImage).mad.toFixed(3)} -> ${ratio <= errorRatio ? "PASS" : "FAIL"}  shot=${out}`);
        } finally {
            s.report();
            await s.close();
        }
    } else if (cmd === "shot") {
        const s = await open(Number(args[2] ?? 1280), Number(args[3] ?? 720));
        try {
            await s.page.goto(`${BASE}${args[0]}`);
            await s.page.waitForTimeout(8000);
            await s.page.screenshot({ path: args[1], timeout: SHOT_TIMEOUT });
        } finally {
            s.report();
            await s.close();
        }
    } else {
        throw new Error("usage: xrun.mjs golden|lite|fidelity|shot …");
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
