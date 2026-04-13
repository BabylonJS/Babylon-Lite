/**
 * Shared core for building tree-shaken, minified per-scene bundles.
 *
 * Each scene is built independently (separate Rollup pass) so:
 *  - Bundle sizes reflect true standalone cost (no shared-chunk inflation)
 *
 * After building, a headless browser loads each bundle-sceneN.html page and
 * measures only the JS bytes actually fetched at runtime.  Dynamic-import
 * chunks that are never loaded (e.g. animation for a static model) are
 * correctly excluded from the manifest numbers.
 */
import { build, type Plugin } from "vite";
import { resolve, dirname, join, extname } from "path";
import { rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { gzipSync } from "zlib";
import { initialize as initMiniray, minify as minifyWgslMiniray } from "miniray";
import { minify as terserMinify } from "terser";

/**
 * Vite plugin: minify WGSL shader text using miniray (whitespace removal + comment stripping).
 * For `?raw` WGSL imports: miniray minification (no identifier mangling — miniray's mangler
 * produces invalid WGSL on some shaders).
 * For inline template-literal WGSL in JS output: regex-based operator/whitespace stripping.
 */
function wgslMinifyPlugin(): Plugin {
    return {
        name: "wgsl-minify",
        enforce: "pre",
        async buildStart() {
            await initMiniray();
        },
        transform(code: string, id: string) {
            if (!id.includes(".wgsl")) return null;
            const match = code.match(/^export default "(.*)"$/s);
            if (!match) return null;
            const raw = JSON.parse(`"${match[1]}"`);
            const result = minifyWgslMiniray(raw, { mangle: false });
            const minified = typeof result === "string" ? result : result.code;
            return { code: `export default ${JSON.stringify(minified)}`, map: null };
        },
        renderChunk(code: string) {
            return { code: minifyTemplateWgsl(code), map: null };
        },
    };
}

/** Strip spaces around WGSL operators inside template literal content. */
function minifyTemplateWgsl(code: string): string {
    const out: string[] = [];
    let i = 0;
    const len = code.length;

    while (i < len) {
        const ch = code[i]!;

        // Skip regular string literals
        if (ch === '"' || ch === "'") {
            const q = ch;
            let j = i + 1;
            while (j < len && code[j] !== q) {
                if (code[j] === "\\") j++;
                j++;
            }
            out.push(code.slice(i, j + 1));
            i = j + 1;
            continue;
        }

        // Skip line comments
        if (ch === "/" && i + 1 < len && code[i + 1] === "/") {
            let j = i;
            while (j < len && code[j] !== "\n") j++;
            out.push(code.slice(i, j));
            i = j;
            continue;
        }

        // Template literal — minify WGSL whitespace
        if (ch === "`") {
            out.push("`");
            i++;
            i = processTemplateLiteral(code, i, len, out);
            continue;
        }

        out.push(ch);
        i++;
    }
    return out.join("");
}

function processTemplateLiteral(code: string, i: number, len: number, out: string[]): number {
    while (i < len) {
        const ch = code[i]!;

        if (ch === "\\") {
            out.push(ch, code[i + 1] ?? "");
            i += 2;
            continue;
        }
        if (ch === "`") {
            out.push("`");
            return i + 1;
        }
        if (ch === "$" && i + 1 < len && code[i + 1] === "{") {
            out.push("${");
            i += 2;
            let depth = 1;
            while (i < len && depth > 0) {
                const ec = code[i]!;
                if (ec === "{") depth++;
                else if (ec === "}") {
                    depth--;
                    if (depth === 0) {
                        out.push("}");
                        i++;
                        break;
                    }
                } else if (ec === "`") {
                    out.push("`");
                    i++;
                    i = processTemplateLiteral(code, i, len, out);
                    continue;
                } else if (ec === '"' || ec === "'") {
                    const q = ec;
                    let j = i + 1;
                    while (j < len && code[j] !== q) {
                        if (code[j] === "\\") j++;
                        j++;
                    }
                    out.push(code.slice(i, j + 1));
                    i = j + 1;
                    continue;
                }
                out.push(ec);
                i++;
            }
            continue;
        }

        // Strip WGSL line comments
        if (ch === "/" && i + 1 < len && code[i + 1] === "/") {
            i += 2;
            while (i < len && code[i] !== "\n") i++;
            continue;
        }

        // Strip spaces around operators
        if (ch === " ") {
            const prev = out.length > 0 ? out[out.length - 1]! : "";
            const prevCh = prev.length > 0 ? prev[prev.length - 1]! : "";
            const next = i + 1 < len ? code[i + 1]! : "";
            const ops = ":=,+-*/<>(){}[];";
            if (ops.includes(prevCh) || ops.includes(next)) {
                i++;
                continue;
            }
        }

        // Replace newlines with space
        if (ch === "\n") {
            out.push(" ");
            i++;
            continue;
        }

        out.push(ch);
        i++;
    }
    return i;
}

/**
 * Vite plugin: mangle underscore-prefixed properties via Terser.
 * Runs in generateBundle (after esbuild minification) with a shared nameCache
 * so cross-chunk property names stay consistent.
 */
function terserPropertyManglePlugin(): Plugin {
    return {
        name: "terser-property-mangle",
        async generateBundle(_options, bundle) {
            const nameCache: Record<string, unknown> = {};

            for (const [, chunk] of Object.entries(bundle)) {
                if (chunk.type !== "chunk") continue;

                const result = await terserMinify(chunk.code, {
                    compress: false,
                    mangle: {
                        properties: {
                            regex: /^_[a-z]/,
                            reserved: ["_pad", "_pad0", "_pad1", "_pad2", "_pad3", "_pad4", "_imgPad0", "_imgPad1"],
                        },
                    },
                    nameCache,
                    sourceMap: false,
                });

                if (result.code) {
                    chunk.code = result.code;
                }
            }
        },
    };
}

import { createServer, type Server } from "http";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export const labDir = resolve(ROOT, "apps/manual-lab");
export const outDir = resolve(labDir, "public/bundle");
export const srcDir = resolve(ROOT, "packages/babylon-lite/src");

const sceneConfig: { id: number }[] = JSON.parse(readFileSync(resolve(ROOT, "scene-config.json"), "utf-8"));
const ALL_SCENES = sceneConfig.map((s) => `scene${s.id}`);
const SCENES = process.env.BUNDLE_SCENES ? process.env.BUNDLE_SCENES.split(",") : ALL_SCENES;
const BJS_SCENES = process.env.SKIP_BJS ? [] : SCENES.map((s) => `bjs-${s}`);

function getAllJsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) results.push(...getAllJsFiles(fullPath));
        else if (entry.name.endsWith(".js")) results.push(fullPath);
    }
    return results;
}

const MIME: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".css": "text/css",
};

function startStaticServer(root: string): Promise<{ server: Server; port: number }> {
    const publicDir = join(root, "public");
    return new Promise((res) => {
        const server = createServer((req, resp) => {
            const url = (req.url ?? "/").split("?")[0]!;
            // Try root first (HTML pages), then public/ (bundle JS, assets)
            let filePath = join(root, url === "/" ? "index.html" : url);
            if (!existsSync(filePath)) filePath = join(publicDir, url);
            if (existsSync(filePath) && !filePath.includes("..")) {
                resp.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
                resp.end(readFileSync(filePath));
            } else {
                resp.writeHead(404);
                resp.end();
            }
        });
        server.listen(0, () => {
            const addr = server.address();
            res({ server, port: typeof addr === "object" ? addr!.port : 0 });
        });
    });
}

function elapsed(startMs: number): string {
    return `${((performance.now() - startMs) / 1000).toFixed(1)}s`;
}

export async function buildBundleScenes(): Promise<void> {
    const t0 = performance.now();
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    // ── 1. Build all scenes ──────────────────────────────────────────────
    const NAME_POLYFILL = 'var __name=(fn,name)=>(Object.defineProperty(fn,"name",{value:name,configurable:true}),fn);';

    /** Modules that must keep side effects (they patch prototypes via bare import). */
    const BJS_SIDE_EFFECT_MODULES = ["thinInstanceMesh"];
    function isBjsSideEffectModule(id: string): boolean {
        return BJS_SIDE_EFFECT_MODULES.some((m) => id.includes(m));
    }

    /** Override sideEffects for @babylonjs packages so Rollup can tree-shake. */
    function bjsSideEffectsFalsePlugin(): Plugin {
        return {
            name: "bjs-side-effects-false",
            resolveId: {
                order: "pre" as const,
                async handler(source, importer, options) {
                    if (!source.includes("@babylonjs")) return null;
                    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
                    if (!resolved) return null;
                    if (isBjsSideEffectModule(source)) return { ...resolved, moduleSideEffects: true };
                    return { ...resolved, moduleSideEffects: false };
                },
            },
        };
    }

    async function buildScene(scene: string) {
        const sceneOutDir = resolve(outDir, scene);
        const isBjs = scene.startsWith("bjs-");

        await build({
            root: labDir,
            configFile: false,
            publicDir: false,
            logLevel: "warn",
            plugins: isBjs ? [bjsSideEffectsFalsePlugin()] : [wgslMinifyPlugin(), terserPropertyManglePlugin()],
            build: {
                outDir: sceneOutDir,
                emptyOutDir: true,
                minify: "esbuild",
                sourcemap: false,
                modulePreload: false,
                rollupOptions: {
                    input: { [scene]: resolve(labDir, isBjs ? `src/bjs/${scene.slice(4)}.ts` : `src/lite/${scene}.ts`) },
                    output: {
                        format: "es",
                        entryFileNames: "[name].js",
                        chunkFileNames: `${scene}-[name]-[hash].js`,
                        banner: NAME_POLYFILL,
                    },
                    ...(isBjs && {
                        treeshake: {
                            moduleSideEffects: (id: string) => !id.includes("@babylonjs") || isBjsSideEffectModule(id),
                        },
                    }),
                },
                ...(isBjs && { target: "esnext" }),
            },
        });

        // Move files from sceneN/ subdir to parent so bundle-sceneN.html can load /bundle/sceneN.js
        const jsFiles = getAllJsFiles(sceneOutDir);
        for (const f of jsFiles) {
            const name = f.substring(sceneOutDir.length + 1).replace(/\\/g, "/");
            const dest = resolve(outDir, name);
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, readFileSync(f));
        }
        rmSync(sceneOutDir, { recursive: true, force: true });
    }

    // Build sequentially — parallel Vite build() calls within the same process
    // cause race conditions (0-byte chunk files, stale measurements on Windows).
    const totalScenes = SCENES.length + BJS_SCENES.length;
    let built = 0;
    for (const scene of SCENES) {
        built++;
        const tScene = performance.now();
        console.log(`[${built}/${totalScenes}] Building ${scene}...`);
        await buildScene(scene);
        console.log(`[${built}/${totalScenes}] ✓ ${scene} (${elapsed(tScene)}, total ${elapsed(t0)})`);
    }
    for (const scene of BJS_SCENES) {
        built++;
        const tScene = performance.now();
        console.log(`[${built}/${totalScenes}] Building ${scene}...`);
        await buildScene(scene);
        console.log(`[${built}/${totalScenes}] ✓ ${scene} (${elapsed(tScene)}, total ${elapsed(t0)})`);
    }

    console.log(`\nAll ${totalScenes} scenes built in ${elapsed(t0)}`);

    // ── 2. Measure real runtime sizes via headless browser ───────────────
    const tMeasure = performance.now();
    const manifest = await measureLiveSizes();
    console.log(`Live measurement completed in ${elapsed(tMeasure)}`);

    console.log("\n=== Per-scene bundle sizes (live runtime measurement) ===");
    for (const scene of SCENES) {
        const s = manifest[scene];
        if (s) {
            let line = `  ${scene}: ${s.rawKB} KB raw, ${s.gzipKB} KB gzip`;
            if (s.bjsRawKB != null) line += `  |  BJS: ${s.bjsRawKB} KB raw, ${s.bjsGzipKB} KB gzip`;
            console.log(line);
        }
    }
    console.log(`✓ Bundle scenes + manifest built to ${outDir} (total ${elapsed(t0)})`);
}

/**
 * Start a temporary static server, launch a headless browser, load each
 * bundle-sceneN.html, and measure only the /bundle/*.js bytes that are
 * actually fetched at runtime.
 */
async function measureLiveSizes(): Promise<Record<string, { rawKB: number; gzipKB: number; bjsRawKB?: number; bjsGzipKB?: number }>> {
    const { chromium } = await import("@playwright/test");
    const { server, port } = await startStaticServer(labDir);
    const manifestPath = resolve(outDir, "manifest.json");

    // Load existing manifest so we can update incrementally (UI can refresh mid-build)
    let manifest: Record<string, { rawKB: number; gzipKB: number; bjsRawKB?: number; bjsGzipKB?: number }> = {};
    if (existsSync(manifestPath)) {
        try {
            manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        } catch {
            /* start fresh */
        }
    }

    function flush(): void {
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    try {
        const tBrowser = performance.now();
        console.log("Launching measurement browser...");
        const browser = await chromium.launch({ channel: "chrome", headless: true });
        console.log(`Browser launched in ${elapsed(tBrowser)}`);

        // Measure Lite scenes (write after each)
        for (const scene of SCENES) {
            const tPage = performance.now();
            const { rawKB, gzipKB } = await measurePage(browser, port, `bundle-${scene}.html`, "/bundle/");
            manifest[scene] = { ...manifest[scene], rawKB, gzipKB };
            flush();
            console.log(`  measured ${scene}: ${rawKB} KB raw, ${gzipKB} KB gzip (${elapsed(tPage)})`);
        }

        // Measure BJS scenes and merge into manifest (write after each)
        for (const bjsScene of BJS_SCENES) {
            const tPage = performance.now();
            const liteScene = bjsScene.replace("bjs-", "");
            const { rawKB, gzipKB } = await measurePage(browser, port, `bundle-${bjsScene}.html`, "/bundle/");
            if (manifest[liteScene]) {
                manifest[liteScene].bjsRawKB = rawKB;
                manifest[liteScene].bjsGzipKB = gzipKB;
                flush();
            }
            console.log(`  measured ${bjsScene}: ${rawKB} KB raw, ${gzipKB} KB gzip (${elapsed(tPage)})`);
        }

        await browser.close();
    } finally {
        server.close();
    }

    return manifest;
}

async function measurePage(browser: any, port: number, htmlFile: string, bundlePath: string): Promise<{ rawKB: number; gzipKB: number }> {
    const page = await browser.newPage();
    const jsPayloads: Buffer[] = [];

    page.on("response", async (resp: any) => {
        const url = resp.url();
        if (url.includes(bundlePath) && url.endsWith(".js") && resp.ok()) {
            try {
                jsPayloads.push(await resp.body());
            } catch {
                /* page may close before body resolves */
            }
        }
    });

    await page.goto(`http://localhost:${port}/${htmlFile}`);
    try {
        await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true", { timeout: 30_000 });
    } catch {
        // BJS pages may not reach ready state without GPU — just measure fetched JS
    }

    let rawTotal = 0;
    let gzipTotal = 0;
    for (const body of jsPayloads) {
        rawTotal += body.length;
        gzipTotal += gzipSync(body, { level: 9 }).length;
    }

    await page.close();
    return {
        rawKB: Math.round((rawTotal / 1024) * 10) / 10,
        gzipKB: Math.round((gzipTotal / 1024) * 10) / 10,
    };
}
