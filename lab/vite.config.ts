import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "fs";
import { spawn } from "child_process";
import { mapBabylonImport, type CompatTarget } from "../packages/babylon-lite-compat/src/bundler-resolve.js";

interface DemoConfigEntry {
    slug: string;
    name: string;
    description: string;
    tags?: string[];
    mobile?: boolean;
}

interface DemoSize {
    rawKB: number;
    gzipKB: number;
}

const DEMO_SOURCE_BASE_URL = "https://github.com/BabylonJS/Babylon-Lite/blob/master/lab/lite/src/demos/";

function readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) {
        return fallback;
    }
    return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Inject the measured engine/code size (the same KB shown on the demos gallery
 * card) into a source demo HTML page so its loading overlay can reiterate it next
 * to the asset estimate. Mirrors the build-time injection used for the deployed
 * flat demo site (scripts/bundle-demos-core.ts) so dev and prod behave the same:
 * `installFetchProgress` reads `window.__DEMO_ENGINE_KB`, and the pre-hydration
 * `.loading-size` text is rewritten to match.
 */
function injectDemoEngineSize(html: string, slug: string): string {
    const sizes = readJson<Record<string, DemoSize>>(resolve(__dirname, "public/bundle/demos-manifest.json"), {});
    const rawKB = sizes[slug]?.rawKB;
    if (rawKB == null) {
        return html;
    }
    const tag = `<script>window.__DEMO_ENGINE_KB=${rawKB};</script>`;
    const withTag = html.includes("</head>") ? html.replace("</head>", `  ${tag}\n</head>`) : `${tag}\n${html}`;
    return withTag.replace(/Estimated demo assets:\s*/g, `Engine ${rawKB} KB · Assets `);
}

function renderPagesDemoCard(demo: DemoConfigEntry, size: DemoSize | undefined): string {
    const tagList = demo.tags ?? [];
    const tags = tagList.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const sizeRow = size
        ? `<div class="size" title="Engine + demo code only — excludes external assets (textures, game data, etc.)"><strong>${size.rawKB} KB</strong> · ${size.gzipKB} KB gzip</div>`
        : "";
    const sourceHref = `${DEMO_SOURCE_BASE_URL}${encodeURIComponent(demo.slug)}.ts`;
    return [
        `<article class="card" data-tags="${escapeHtml(tagList.join(" "))}" data-mobile="${demo.mobile === false ? "false" : "true"}">`,
        `<a class="card-main" href="/demo-${demo.slug}.html" aria-label="Open ${escapeHtml(demo.name)} demo">`,
        `<div class="card-image">`,
        `<img src="/thumbnails/demo-${demo.slug}.jpg" alt="${escapeHtml(demo.name)} thumbnail" loading="lazy" decoding="async" onerror="this.remove()" />`,
        `</div>`,
        `<div class="card-body">`,
        `<h2>${escapeHtml(demo.name)}</h2>`,
        `<p>${escapeHtml(demo.description)}</p>`,
        tags ? `<div class="tags">${tags}</div>` : "",
        sizeRow,
        `<span class="card-disabled-badge">Requires WebGPU</span>`,
        `</div></a>`,
        `<div class="card-links"><a class="source-link" href="${escapeHtml(sourceHref)}" target="_blank" rel="noopener noreferrer">Source code</a></div>`,
        `</article>`,
    ].join("");
}

function renderPagesDemoFilters(demos: DemoConfigEntry[]): string {
    const tags = Array.from(new Set(demos.flatMap((d) => d.tags ?? []))).sort();
    if (tags.length === 0) {
        return "";
    }
    const pills = [
        `<button type="button" class="filter-pill is-active" data-filter="all" aria-pressed="true">All</button>`,
        ...tags.map((t) => `<button type="button" class="filter-pill" data-filter="${escapeHtml(t)}" aria-pressed="false">${escapeHtml(t)}</button>`),
    ].join("");
    return `<nav class="filters" aria-label="Filter demos by tag">${pills}</nav>`;
}

function renderPagesDemoIndex(): string {
    const repoRoot = resolve(__dirname, "..");
    const demos = readJson<DemoConfigEntry[]>(resolve(repoRoot, "demos-config.json"), []);
    const sizes = readJson<Record<string, DemoSize>>(resolve(__dirname, "public/bundle/demos-manifest.json"), {});
    const template = readFileSync(resolve(repoRoot, "pages/index.template.html"), "utf-8");
    return template
        .replace("<!--FILTERS-->", renderPagesDemoFilters(demos))
        .replace("<!--CARDS-->", demos.map((d) => renderPagesDemoCard(d, sizes[d.slug])).join("\n                "))
        .replace('src="babylon-logo.svg"', 'src="/pages/babylon-logo.svg"')
        .replace('src="bundle/demos/landing-bg.js"', 'src="/bundle/demos/landing-bg.js"');
}

function hasBuildableRootScripts(htmlFile: string): boolean {
    const html = readFileSync(resolve(__dirname, htmlFile), "utf-8");
    if (html.includes('src="/lite/bundle/')) {
        return false;
    }
    for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']\/([^"']+)["']/g)) {
        const scriptPath = match[1];
        if (!scriptPath) {
            continue;
        }
        const localScriptPath = scriptPath.startsWith("lite/bundle/") ? scriptPath.slice("lite/".length) : scriptPath;
        if (!existsSync(resolve(__dirname, scriptPath)) && !existsSync(resolve(__dirname, "public", localScriptPath))) {
            return false;
        }
    }
    return true;
}

function getHtmlInputs(): Record<string, string> {
    const liteHtml = readdirSync(resolve(__dirname, "lite"))
        .filter((f) => f.endsWith(".html") && hasBuildableRootScripts(`lite/${f}`))
        .map((f) => [`lite/${f.replace(".html", "")}`, resolve(__dirname, "lite", f)] as const);
    const glHtml = readdirSync(resolve(__dirname, "gl"))
        .filter((f) => f.endsWith(".html") && hasBuildableRootScripts(`gl/${f}`))
        .map((f) => [`gl/${f.replace(".html", "")}`, resolve(__dirname, "gl", f)] as const);
    return Object.fromEntries([
        ["main", resolve(__dirname, "index.html")],
        ...readdirSync(__dirname)
            .filter((f) => f.endsWith(".html") && f !== "index.html" && hasBuildableRootScripts(f))
            .map((f) => [f.replace(".html", ""), resolve(__dirname, f)]),
        ...liteHtml,
        ...glHtml,
    ]);
}

/** Serve the standalone demo landing page source from repo-root pages/. */
function pagesDemoPlugin(): Plugin {
    return {
        name: "lab-pages-demo",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = (req.url ?? "").split("?")[0];
                if (url === "/pages" || url === "/pages/" || url === "/pages/index.html") {
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.setHeader("Cache-Control", "no-cache");
                    res.end(renderPagesDemoIndex());
                    return;
                }
                if (url === "/pages/babylon-logo.svg") {
                    const filePath = resolve(__dirname, "../pages/babylon-logo.svg");
                    if (existsSync(filePath)) {
                        res.setHeader("Content-Type", "image/svg+xml");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                }
                next();
            });
        },
    };
}

/** Serve reference images from the repo-root reference/lite/ directory */
function serveReferenceImages(): Plugin {
    return {
        name: "serve-reference-images",
        enforce: "pre",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = (req.url ?? "").split("?")[0]; // strip query string
                const liteHtmlCompat = url.match(
                    /^\/((?:scene|bundle-scene|bundle-bjs-scene|babylon-ref-scene|bundle-baseline-scene)\d+|demo-[^/]+|dispose-test|leak-test|material-swap-test|picking-test)\.html$/
                );
                if (liteHtmlCompat) {
                    const name = liteHtmlCompat[1];
                    const filePath = resolve(__dirname, "lite", `${name}.html`);
                    if (existsSync(filePath)) {
                        res.setHeader("Content-Type", "text/html; charset=utf-8");
                        res.setHeader("Cache-Control", "no-cache");
                        // Demo pages: inject the measured engine size so the loading
                        // overlay reiterates it next to the asset estimate, mirroring
                        // the build-time injection on the deployed flat demo site.
                        if (name.startsWith("demo-")) {
                            res.end(injectDemoEngineSize(readFileSync(filePath, "utf-8"), name.slice("demo-".length)));
                        } else {
                            createReadStream(filePath).pipe(res);
                        }
                        return;
                    }
                }
                // Reference/golden images for either experience:
                //   /lite/reference/<slug>/<file>  or  /reference/lite/<slug>/<file>  → reference/lite/...
                //   /gl/reference/<slug>/<file>     or  /reference/gl/<slug>/<file>     → reference/gl/...
                const refMatch = url.match(/^\/(lite|gl)\/reference\/(.+)$/) ?? url.match(/^\/reference\/(lite|gl)\/(.+)$/);
                if (refMatch) {
                    const refPath = `reference/${refMatch[1]}/${refMatch[2]}`;
                    const filePath = resolve(__dirname, "..", refPath);
                    if (existsSync(filePath)) {
                        res.setHeader("Content-Type", "image/png");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                }
                if (url.startsWith("/lite/thumbnails/")) {
                    const filePath = resolve(__dirname, "public", url.slice("/lite/".length));
                    if (existsSync(filePath) && statSync(filePath).isFile()) {
                        res.setHeader("Content-Type", filePath.endsWith(".png") ? "image/png" : "image/jpeg");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                }
                const rootJson = new Map([
                    ["/scene-config.json", "scene-config.json"],
                    ["/demos-config.json", "demos-config.json"],
                    ["/scene-config-webgl.json", "scene-config-webgl.json"],
                    ["/demos-config-webgl.json", "demos-config-webgl.json"],
                ]);
                const rootJsonFile = rootJson.get(url);
                if (rootJsonFile) {
                    const filePath = resolve(__dirname, "..", rootJsonFile);
                    if (existsSync(filePath)) {
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                }
                if (url === "/perf-manifest.json" || url === "/perf-regression-manifest.json" || url === "/gl/perf-manifest.json" || url === "/gl/perf-regression-manifest.json") {
                    const filePath = resolve(__dirname, "public", url.slice(1));
                    if (existsSync(filePath) && statSync(filePath).isFile()) {
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                }
                // Serve the generated aggregate bundle manifest. The tracked source of
                // truth is one file per scene under public/bundle/manifest/; the single
                // aggregate manifest.json is a (gitignored) build output. On a fresh
                // checkout it hasn't been built yet, so synthesize it on the fly from the
                // per-scene files so the Bundle tab is populated without a full build.
                if (url === "/bundle/manifest.json") {
                    const aggregatePath = resolve(__dirname, "public/bundle/manifest.json");
                    if (existsSync(aggregatePath) && statSync(aggregatePath).isFile()) {
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(aggregatePath).pipe(res);
                        return;
                    }
                    const perSceneDir = resolve(__dirname, "public/bundle/manifest");
                    if (existsSync(perSceneDir)) {
                        const files = readdirSync(perSceneDir)
                            .filter((f) => f.endsWith(".json"))
                            .sort((a, b) => (parseInt(a.replace(/\D/g, ""), 10) || 0) - (parseInt(b.replace(/\D/g, ""), 10) || 0));
                        const manifest: Record<string, unknown> = {};
                        for (const file of files) {
                            try {
                                manifest[file.slice(0, -".json".length)] = JSON.parse(readFileSync(resolve(perSceneDir, file), "utf-8"));
                            } catch {
                                /* skip malformed per-scene file */
                            }
                        }
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-cache");
                        res.end(JSON.stringify(manifest));
                        return;
                    }
                }
                // Serve pre-built bundle JS (scenes + demos) directly from lab/public/bundle.
                // Vite caches the public-file list at startup and never refreshes it for paths
                // matching `server.watch.ignored` (which includes **/public/bundle/**). So any
                // bundle (re)generated AFTER the dev server started is absent from that cache:
                // Vite's static middleware skips it and the transform middleware then 404s the
                // `<script type="module">` request (plain GET still falls through to 200, which
                // is why the file looks present yet demos break). Serving these build outputs
                // ourselves — before Vite's internal middlewares — makes a freshly regenerated
                // bundle load immediately without a dev-server restart.
                if ((url.startsWith("/bundle/") || url.startsWith("/lite/bundle/")) && (url.endsWith(".js") || url.endsWith(".mjs"))) {
                    const bundlePath = url.startsWith("/lite/bundle/") ? url.slice("/lite/".length) : url.slice(1);
                    const filePath = resolve(__dirname, "public", bundlePath);
                    if (existsSync(filePath) && statSync(filePath).isFile()) {
                        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                    res.statusCode = 404;
                    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
                    res.setHeader("Cache-Control", "no-cache");
                    res.end(
                        `console.error(${JSON.stringify(`Missing lab bundle ${url}. Run pnpm build:bundle-scenes, pnpm build:bundle-demos, or pnpm dev:lab to regenerate it.`)});\n` +
                            `document.getElementById("renderCanvas")?.setAttribute("data-error", "missing-bundle");\n`
                    );
                    return;
                }
                if ((url.startsWith("/bundle/") || url.startsWith("/lite/bundle/") || url.startsWith("/gl/bundle/")) && url.endsWith(".json")) {
                    const bundlePath = url.startsWith("/lite/bundle/") ? url.slice("/lite/".length) : url.slice(1);
                    const filePath = resolve(__dirname, "public", bundlePath);
                    if (existsSync(filePath) && statSync(filePath).isFile()) {
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                }
                // Serve bundled demo runtime ASSETS (spritesheets, textures, game data, etc.)
                // copied under lab/public/bundle/demos/<slug>/ by copyDemoRuntimeAssets. Same
                // startup-cache staleness as the .js/.json blocks above: a demo whose assets
                // were (re)generated after the server started would otherwise fall through to
                // the SPA fallback (200 text/html) and fail to decode. Serve them from disk.
                if (url.startsWith("/bundle/demos/") || url.startsWith("/lite/bundle/demos/")) {
                    const ASSET_TYPES: Record<string, string> = {
                        ".png": "image/png",
                        ".jpg": "image/jpeg",
                        ".jpeg": "image/jpeg",
                        ".gif": "image/gif",
                        ".webp": "image/webp",
                        ".svg": "image/svg+xml",
                        ".xml": "application/xml",
                        ".wasm": "application/wasm",
                        ".bin": "application/octet-stream",
                        ".glb": "model/gltf-binary",
                        ".env": "application/octet-stream",
                        ".wad": "application/octet-stream",
                        ".txt": "text/plain; charset=utf-8",
                        ".md": "text/markdown; charset=utf-8",
                    };
                    const ext = url.slice(url.lastIndexOf(".")).toLowerCase();
                    const assetType = ASSET_TYPES[ext];
                    if (assetType) {
                        const bundlePath = url.startsWith("/lite/bundle/") ? url.slice("/lite/".length) : url.slice(1);
                        const filePath = resolve(__dirname, "public", bundlePath);
                        if (existsSync(filePath) && statSync(filePath).isFile()) {
                            res.setHeader("Content-Type", assetType);
                            res.setHeader("Cache-Control", "no-cache");
                            createReadStream(filePath).pipe(res);
                            return;
                        }
                    }
                }
                if (url === "/lab-api/signature") {
                    // Returns mtimes for current/master bundle and perf manifests plus per-scene parity images
                    // so the dashboard can auto-refresh only when data actually changes.
                    const sig: {
                        bundle: number | null;
                        bundleMaster: number | null;
                        perf: number | null;
                        parity: Record<string, number>;
                    } = { bundle: null, bundleMaster: null, perf: null, parity: {} };
                    const mtime = (p: string): number | null => {
                        try {
                            return existsSync(p) ? statSync(p).mtimeMs : null;
                        } catch {
                            return null;
                        }
                    };
                    // Newest mtime across the tracked per-scene manifest files, used as a
                    // fallback when the generated aggregate manifest.json isn't built yet.
                    const dirNewestMtime = (dir: string): number | null => {
                        try {
                            if (!existsSync(dir)) return null;
                            let newest: number | null = null;
                            for (const file of readdirSync(dir)) {
                                if (!file.endsWith(".json")) continue;
                                const m = mtime(resolve(dir, file));
                                if (m != null && (newest == null || m > newest)) newest = m;
                            }
                            return newest;
                        } catch {
                            return null;
                        }
                    };
                    sig.bundle = mtime(resolve(__dirname, "public/bundle/manifest.json")) ?? dirNewestMtime(resolve(__dirname, "public/bundle/manifest"));
                    sig.bundleMaster = mtime(resolve(__dirname, "public/bundle/master-manifest.json"));
                    sig.perf = mtime(resolve(__dirname, "public/perf-manifest.json"));
                    try {
                        const cfgPath = resolve(__dirname, "../scene-config.json");
                        if (existsSync(cfgPath)) {
                            const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Array<{ id: number; slug: string }>;
                            for (const s of cfg) {
                                const imgPath = resolve(__dirname, "../reference/lite", s.slug, "test-actual.png");
                                const m = mtime(imgPath);
                                if (m != null) sig.parity["scene" + s.id] = m;
                            }
                        }
                    } catch {
                        // ignore
                    }
                    res.setHeader("Content-Type", "application/json");
                    res.setHeader("Cache-Control", "no-store");
                    res.end(JSON.stringify(sig));
                    return;
                }
                next();
            });
        },
    };
}

/**
 * Dev-server endpoints backing the lab's "API Docs" tab.
 *  - `GET  /lab-api/docs-status`   → whether the TypeDoc site has been generated.
 *  - `POST /lab-api/generate-docs` → runs TypeDoc (repo-root `typedoc.json`) on demand
 *    and reports success + tail of the log. Lite output lands in `lab/public/lite/api-docs/`,
 *    which Vite serves statically at `/lite/api-docs/`.
 */
function apiDocsPlugin(): Plugin {
    const repoRoot = resolve(__dirname, "..");
    const docsTargets = {
        lite: {
            index: resolve(__dirname, "public/lite/api-docs/index.html"),
            canGenerate: true,
        },
        gl: {
            index: resolve(__dirname, "public/gl/api-docs/index.html"),
            canGenerate: false,
        },
    };
    let generating = false;

    function getDocsTarget(reqUrl: string): (typeof docsTargets)["lite"] {
        const qs = reqUrl.includes("?") ? new URLSearchParams(reqUrl.slice(reqUrl.indexOf("?") + 1)) : new URLSearchParams();
        return qs.get("experience") === "gl" ? docsTargets.gl : docsTargets.lite;
    }

    return {
        name: "lab-api-docs",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const reqUrl = req.url ?? "";
                const url = reqUrl.split("?")[0];

                if (url === "/lab-api/docs-status") {
                    const target = getDocsTarget(reqUrl);
                    const generated = existsSync(target.index);
                    res.setHeader("Content-Type", "application/json");
                    res.setHeader("Cache-Control", "no-store");
                    res.end(
                        JSON.stringify({
                            generated,
                            generating,
                            mtime: generated ? statSync(target.index).mtimeMs : null,
                        })
                    );
                    return;
                }

                if (url === "/lab-api/generate-docs") {
                    if (req.method !== "POST") {
                        res.statusCode = 405;
                        res.end("Method Not Allowed");
                        return;
                    }
                    const target = getDocsTarget(reqUrl);
                    if (!target.canGenerate) {
                        res.statusCode = 501;
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ ok: false, error: "Lite GL API documentation generation is not configured yet." }));
                        return;
                    }
                    if (generating) {
                        res.statusCode = 409;
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ ok: false, error: "Documentation generation already in progress." }));
                        return;
                    }
                    generating = true;
                    const typedocCli = resolve(repoRoot, "node_modules/typedoc/dist/lib/cli.js");
                    const child = spawn(process.execPath, [typedocCli], { cwd: repoRoot });
                    let log = "";
                    const collect = (d: Buffer) => {
                        log += d.toString();
                    };
                    child.stdout.on("data", collect);
                    child.stderr.on("data", collect);
                    child.on("error", (err) => {
                        generating = false;
                        res.statusCode = 500;
                        res.setHeader("Content-Type", "application/json");
                        res.end(JSON.stringify({ ok: false, error: String(err), log: log.slice(-4000) }));
                    });
                    child.on("close", (code) => {
                        generating = false;
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-store");
                        res.end(JSON.stringify({ ok: code === 0, code, log: log.slice(-4000) }));
                    });
                    return;
                }

                next();
            });
        },
    };
}

/**
 * Dev-server endpoints that let the lab dashboard generate a tab's underlying
 * data on demand when it is missing (Parity, Bundle, Perf, Perf Regression).
 *
 *  - `GET  /lab-api/gen-status?target=X` → `{ generated, generating, mtime, present, total, done, ok, error, log }`.
 *  - `POST /lab-api/generate?target=X`   → starts the matching pnpm command as a
 *    background job and returns immediately (`{ started: true }`). The client then
 *    polls `gen-status` for live log output and completion. A single global lock
 *    means only one generation runs at a time (these are CPU/GPU heavy).
 *
 * Job state lives in-memory on the dev server so it survives full page reloads
 * (e.g. when a bundle build writes into `lab/public` and Vite reloads the page).
 */
function tabContentPlugin(): Plugin {
    const repoRoot = resolve(__dirname, "..");
    const publicDir = resolve(__dirname, "public");

    type TargetDef = { command: string; detect: () => { generated: boolean; mtime: number | null; present?: number; total?: number } };

    const mtimeOf = (p: string): number | null => {
        try {
            return existsSync(p) ? statSync(p).mtimeMs : null;
        } catch {
            return null;
        }
    };
    const fileTarget = (p: string) => () => ({ generated: existsSync(p), mtime: mtimeOf(p) });
    const detectParity = () => {
        let present = 0;
        let total = 0;
        let mtime: number | null = null;
        try {
            const cfgPath = resolve(repoRoot, "scene-config.json");
            if (existsSync(cfgPath)) {
                const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Array<{ slug: string; skipParity?: boolean }>;
                for (const s of cfg) {
                    if (s.skipParity) continue;
                    total++;
                    const m = mtimeOf(resolve(repoRoot, "reference/lite", s.slug, "test-actual.png"));
                    if (m != null) {
                        present++;
                        mtime = mtime == null ? m : Math.max(mtime, m);
                    }
                }
            }
        } catch {
            // ignore
        }
        return { generated: present > 0, mtime, present, total };
    };

    const detectParityGl = () => {
        let present = 0;
        let total = 0;
        let mtime: number | null = null;
        try {
            const cfgPath = resolve(repoRoot, "scene-config-webgl.json");
            if (existsSync(cfgPath)) {
                const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Array<{ slug: string; skipParity?: boolean }>;
                for (const s of cfg) {
                    if (s.skipParity) continue;
                    total++;
                    const m = mtimeOf(resolve(repoRoot, "reference/gl", s.slug, "test-actual.png"));
                    if (m != null) {
                        present++;
                        mtime = mtime == null ? m : Math.max(mtime, m);
                    }
                }
            }
        } catch {
            // ignore
        }
        return { generated: present > 0, mtime, present, total };
    };

    const LITE_TARGETS: Record<string, TargetDef> = {
        parity: { command: "pnpm test:parity", detect: detectParity },
        bundle: { command: "pnpm build:bundle-scenes", detect: fileTarget(resolve(publicDir, "bundle/manifest.json")) },
        demos: { command: "pnpm build:bundle-demos", detect: fileTarget(resolve(publicDir, "bundle/demos-manifest.json")) },
        perf: { command: "pnpm test:perf", detect: fileTarget(resolve(publicDir, "perf-manifest.json")) },
        perfreg: {
            // The regression test needs current + baseline bundles; build them first
            // so a fresh checkout actually produces perf-regression-manifest.json.
            command: "pnpm build:bundle-scenes && pnpm build:perf-baseline && pnpm test:perf-regression",
            detect: fileTarget(resolve(publicDir, "perf-regression-manifest.json")),
        },
    };

    // Detect predicate for the GL "Demos" tab. GL demos are static, config-driven
    // (demos-config-webgl.json) with no build step, so "generated" simply means the
    // config lists at least one demo. Its Regenerate command runs the cheap GL bundle
    // build (there is no GL demos-bundle pipeline); the demo cards render from the
    // static config regardless.
    const detectDemosGl = () => {
        try {
            const cfgPath = resolve(repoRoot, "demos-config-webgl.json");
            if (existsSync(cfgPath)) {
                const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as unknown[];
                if (Array.isArray(cfg) && cfg.length > 0) {
                    return { generated: true, mtime: mtimeOf(cfgPath), present: cfg.length, total: cfg.length };
                }
            }
        } catch {
            // ignore
        }
        return { generated: false, mtime: null, present: 0, total: 0 };
    };

    // Lite GL experience: parity + perf + bundle + demos + perf-regression all have
    // GL tooling now. Each target writes under reference/gl/* or lab/public/gl/*:
    //   parity  → test:parity:gl              → reference/gl/<slug>/test-actual.png
    //   bundle  → build:bundle-scenes:gl       → lab/public/gl/bundle/manifest.json
    //   demos   → (static demos-config-webgl)  → cheap GL bundle rebuild on Regenerate
    //   perf    → test:perf:gl                 → lab/public/gl/perf-manifest.json
    //   perfreg → test:perf-regression:gl      → lab/public/gl/perf-regression-manifest.json
    // (perfreg baseline = the Babylon ThinEngine reference, not a prior Lite build.)
    const GL_TARGETS: Record<string, TargetDef> = {
        parity: { command: "pnpm test:parity:gl", detect: detectParityGl },
        bundle: { command: "pnpm build:bundle-scenes:gl", detect: fileTarget(resolve(publicDir, "gl/bundle/manifest.json")) },
        demos: { command: "pnpm build:bundle-scenes:gl", detect: detectDemosGl },
        perf: { command: "pnpm test:perf:gl", detect: fileTarget(resolve(publicDir, "gl/perf-manifest.json")) },
        perfreg: { command: "pnpm test:perf-regression:gl", detect: fileTarget(resolve(publicDir, "gl/perf-regression-manifest.json")) },
    };

    const targetsFor = (experience: string): Record<string, TargetDef> => (experience === "gl" ? GL_TARGETS : LITE_TARGETS);

    type Job = { running: boolean; log: string; done: boolean; ok: boolean; code: number | null; error?: string };
    const jobs: Record<string, Job> = {};
    let busy: string | null = null;

    const json = (res: import("http").ServerResponse, body: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(body));
    };

    return {
        name: "lab-tab-content",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const [path, qs] = (req.url ?? "").split("?");
                const target = new URLSearchParams(qs ?? "").get("target") ?? "";
                const experience = new URLSearchParams(qs ?? "").get("experience") === "gl" ? "gl" : "lite";
                const TARGETS = targetsFor(experience);
                // Namespace job/lock state per experience so a GL run and a lite run of
                // the same target (e.g. "perf") never collide. Lite keeps the bare
                // target key for backwards compatibility.
                const jobKey = experience === "gl" ? "gl:" + target : target;

                if (path === "/lab-api/gen-status") {
                    const def = TARGETS[target];
                    if (!def) {
                        json(res, { error: experience === "gl" ? `"${target}" is not available for the Lite GL experience.` : "Unknown target" }, 400);
                        return;
                    }
                    const det = def.detect();
                    const job = jobs[jobKey];
                    json(res, {
                        generated: det.generated,
                        generating: !!(job && job.running),
                        mtime: det.mtime,
                        present: det.present,
                        total: det.total,
                        done: !!(job && job.done),
                        ok: job ? job.ok : undefined,
                        error: job ? job.error : undefined,
                        log: job ? job.log.slice(-6000) : "",
                    });
                    return;
                }

                if (path === "/lab-api/generate") {
                    if (req.method !== "POST") {
                        json(res, { error: "Method Not Allowed" }, 405);
                        return;
                    }
                    const def = TARGETS[target];
                    if (!def) {
                        json(res, { error: experience === "gl" ? `"${target}" is not available for the Lite GL experience.` : "Unknown target" }, 400);
                        return;
                    }
                    if (busy) {
                        json(res, { started: false, error: "A generation is already in progress (" + busy + ")." }, 409);
                        return;
                    }
                    busy = jobKey;
                    const job: Job = { running: true, log: "", done: false, ok: false, code: null };
                    jobs[jobKey] = job;
                    const shellCmd = process.platform === "win32" ? "cmd" : "sh";
                    const shellArgs = process.platform === "win32" ? ["/c", def.command] : ["-c", def.command];
                    const child = spawn(shellCmd, shellArgs, { cwd: repoRoot });
                    job.log += "$ " + def.command + "\n\n";
                    const collect = (d: Buffer) => {
                        job.log += d.toString();
                    };
                    child.stdout.on("data", collect);
                    child.stderr.on("data", collect);
                    child.on("error", (err) => {
                        job.running = false;
                        job.done = true;
                        job.ok = false;
                        job.error = String(err);
                        busy = null;
                    });
                    child.on("close", (code) => {
                        job.running = false;
                        job.done = true;
                        job.code = code;
                        const det = def.detect();
                        job.ok = code === 0 && det.generated;
                        if (code === 0 && !det.generated) {
                            job.error = "Command finished but the expected artifact is still missing.";
                        } else if (code !== 0) {
                            job.error = "Command exited with code " + code + ".";
                        }
                        busy = null;
                    });
                    json(res, { started: true });
                    return;
                }

                next();
            });
        },
    };
}

/**
 * Single-server compatibility-layer harness.
 *
 * The existing Babylon.js oracle scenes under `lab/lite/src/bjs/sceneN.ts` import
 * deep `@babylonjs/core` / `@babylonjs/loaders` subpaths. This plugin lets the
 * *same* source render on the `@babylonjs/lite-compat` layer **without a second
 * dev server**, by serving a parallel `/compat/sceneN.html` route whose module
 * graph is tagged with a `?compat` query. Within that tagged subtree (and only
 * there) every `@babylonjs/core`/`@babylonjs/loaders` specifier is redirected to
 * the compat barrel; everywhere else (the `babylon-ref-*` golden pages) the real
 * Babylon.js package resolves untouched. This is what makes a true side-by-side —
 * real BJS vs compat — possible on one port.
 *
 * Mechanism:
 *  - A distinct module id (`scene2.ts?compat`) means Vite caches a *separate*
 *    transform from the real `scene2.ts`, so the two can resolve `@babylonjs/core`
 *    differently without colliding.
 *  - `resolveId` redirects bare `@babylonjs/(core|loaders)` imports to the compat
 *    barrel only when the importer carries the `compat` query marker, and
 *    propagates the marker across relative imports so transitive BJS usage in any
 *    shared helper is redirected too.
 */
function compatScenesPlugin(): Plugin {
    const compatTargets: Record<CompatTarget, string> = {
        core: resolve(__dirname, "../packages/babylon-lite-compat/src/index.ts"),
        addons: resolve(__dirname, "../packages/babylon-lite-compat/src/navigation/navigation.ts"),
        recast: resolve(__dirname, "../packages/babylon-lite-compat/src/navigation/recast-shim.ts"),
        // GridMaterial is re-exported from the barrel, so materials folds into core.
        materials: resolve(__dirname, "../packages/babylon-lite-compat/src/index.ts"),
    };
    const hasCompatMarker = (id: string) => {
        const q = id.split("?")[1];
        return !!q && q.split("&").includes("compat");
    };

    return {
        name: "lab-compat-scenes",
        enforce: "pre",
        async resolveId(source, importer) {
            if (!importer || !hasCompatMarker(importer)) {
                return null;
            }
            // Redirect Babylon.js core/loaders/navigation/grid + raw Recast onto the
            // matching compat modules. The mapping table is shared with the publishable
            // `@babylonjs/lite-compat/vite` plugin so the two can never drift.
            const target = mapBabylonImport(source);
            if (target) {
                return compatTargets[target];
            }
            // Propagate the marker across relative imports so a helper that itself
            // imports @babylonjs/core is still redirected within the compat subtree.
            if (source.startsWith(".")) {
                const baseImporter = importer.split("?")[0];
                const resolved = await this.resolve(source, baseImporter, { skipSelf: true });
                if (resolved && !resolved.external) {
                    return resolved.id + (resolved.id.includes("?") ? "&compat" : "?compat");
                }
            }
            return null;
        },
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const url = (req.url ?? "").split("?")[0];
                const match = url.match(/^\/compat\/scene(\d+)\.html$/);
                if (!match) {
                    next();
                    return;
                }
                const sceneId = match[1];
                const srcRel = `lite/src/bjs/scene${sceneId}.ts`;
                if (!existsSync(resolve(__dirname, srcRel))) {
                    // No Babylon.js oracle source for this scene — it is a Lite-only scene
                    // (e.g. text rendering, multi-canvas) with nothing to run through the
                    // compat layer. Report it as intentionally skipped, not as an error.
                    res.statusCode = 404;
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.end(
                        `<!DOCTYPE html><meta charset="utf-8"><body style="font:14px monospace;color:#8b949e;background:#000">` +
                            `Scene ${sceneId} is a Lite-only scene (no Babylon.js oracle at ${srcRel}); nothing to run through the compat layer.</body>`
                    );
                    return;
                }
                const baseHtml = [
                    "<!DOCTYPE html>",
                    '<html lang="en">',
                    "<head>",
                    '<meta charset="UTF-8" />',
                    `<title>Babylon Lite Compat — Scene ${sceneId}</title>`,
                    "<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}canvas{width:100%;height:100%;display:block}</style>",
                    "</head>",
                    "<body>",
                    '<canvas id="renderCanvas"></canvas>',
                    // The BJS oracle scenes swallow their own errors via `.catch(console.error)`,
                    // so intercept console.error / global errors and surface the thrown error onto
                    // the canvas (`data-error`). The Compat tab — and the coverage-triage harness —
                    // poll `data-ready` vs `data-error` to tell "renders" from "throws".
                    "<script>(function(){var c=document.getElementById('renderCanvas');function mark(m){if(c&&!c.dataset.error){c.dataset.error=String(m).slice(0,400);}}function fromArgs(args){for(var i=0;i<args.length;i++){var a=args[i];if(a&&(a instanceof Error||a.message&&a.stack))return a.message;}for(var j=0;j<args.length;j++){if(typeof args[j]==='string')return args[j];}return '';}var o=console.error.bind(console);console.error=function(){try{var m=fromArgs(arguments);if(m)mark(m);}catch(e){}return o.apply(console,arguments);};window.addEventListener('error',function(e){mark((e&&(e.error&&e.error.message||e.message))||'error');});window.addEventListener('unhandledrejection',function(e){var r=e&&e.reason;mark((r&&r.message)||r||'unhandledrejection');});})();</script>",
                    `<script type="module" src="/${srcRel}?compat"></script>`,
                    "</body>",
                    "</html>",
                ].join("\n");
                const html = await server.transformIndexHtml(req.url ?? url, baseHtml);
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache");
                res.end(html);
            });
        },
    };
}

export default defineConfig({
    plugins: [pagesDemoPlugin(), compatScenesPlugin(), serveReferenceImages(), apiDocsPlugin(), tabContentPlugin()],
    optimizeDeps: {
        // BJS uses prototype-patching side-effect imports (e.g. abstractEngine.dom.js).
        // babylon-lite uses ?raw WGSL imports that esbuild can't handle.
        // Exclude both from Vite's dep optimizer.
        // @recast-navigation/* ship a wasm binary the esbuild optimizer can't process; serve
        // them as native ESM so Babylon Lite's navigation (and the compat nav wrapper) can load
        // Recast on demand without a hung pre-bundle.
        exclude: ["@babylonjs/core", "@babylonjs/loaders", "@babylonjs/havok", "@recast-navigation/core", "@recast-navigation/generators", "@recast-navigation/wasm"],
    },
    resolve: {
        // Ensure @babylonjs/core resolves to a single instance (loaders registers
        // plugins on the same SceneLoader the scene code imports).
        dedupe: ["@babylonjs/core"],
        alias: {
            // Point babylon-lite directly at the TypeScript source directory so Vite treats
            // it as first-party code: full HMR + native ?raw WGSL handling.
            // Directory alias so sub-path imports like 'babylon-lite/loader-env/...' work too.
            "babylon-lite-gl": resolve(__dirname, "../packages/babylon-lite-gl/src"),
            "babylon-lite": resolve(__dirname, "../packages/babylon-lite/src"),
        },
    },
    server: {
        // Default interactive port is 5174. Playwright test runs pass LAB_DEV_PORT
        // to spin up an ISOLATED server on a dedicated port (so test traffic never
        // competes with the interactive lab). strictPort is enabled only for that
        // test server so the exact port Playwright waits on is guaranteed; the
        // interactive dev server keeps Vite's default auto-increment behavior.
        port: Number(process.env.LAB_DEV_PORT) || 5174,
        strictPort: !!process.env.LAB_DEV_PORT,
        watch: {
            // On-demand tab generation writes many files under the Vite root that
            // would otherwise churn the single-threaded dev server (stalling the
            // live generation-log polling) or trigger disruptive full page reloads.
            // All of these are build artifacts — the lab re-fetches them over HTTP
            // via each tab's reload() callback, never via HMR — so exclude them:
            //   • bundle build / API docs  → hundreds of files
            //   • perf-baseline (perfreg)  → bundle-baseline/ + bundle-baseline-scene*.html
            //   • perf manifests           → single-file writes that force a reload
            ignored: [
                "**/public/bundle/**",
                "**/public/gl/bundle/**",
                "**/public/bundle-baseline/**",
                "**/public/api-docs/**",
                "**/public/lite/api-docs/**",
                "**/public/gl/api-docs/**",
                "**/public/perf-manifest.json",
                "**/public/perf-regression-manifest.json",
                "**/public/gl/perf-manifest.json",
                "**/public/gl/perf-regression-manifest.json",
                "**/bundle-baseline-scene*.html",
                "**/.perf-baseline-worktree/**",
            ],
        },
    },
    build: {
        rollupOptions: {
            input: getHtmlInputs(),
        },
    },
});
