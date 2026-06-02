import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "fs";
import { spawn } from "child_process";

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

function readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) {
        return fallback;
    }
    return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPagesDemoCard(demo: DemoConfigEntry, size: DemoSize | undefined): string {
    const tagList = demo.tags ?? [];
    const tags = tagList.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const sizeRow = size ? `<div class="size" title="Engine + demo code only — excludes external assets (textures, game data, etc.)"><strong>${size.rawKB} KB</strong> · ${size.gzipKB} KB gzip</div>` : "";
    return [
        `<a class="card" href="/demo-${demo.slug}.html" data-tags="${escapeHtml(tagList.join(" "))}" data-mobile="${demo.mobile === false ? "false" : "true"}">`,
        `<div class="card-image">`,
        `<img src="/thumbnails/demo-${demo.slug}.png" alt="${escapeHtml(demo.name)} thumbnail" loading="lazy" decoding="async" onerror="this.remove()" />`,
        `</div>`,
        `<div class="card-body">`,
        `<h2>${escapeHtml(demo.name)}</h2>`,
        `<p>${escapeHtml(demo.description)}</p>`,
        tags ? `<div class="tags">${tags}</div>` : "",
        sizeRow,
        `<span class="card-disabled-badge">Requires WebGPU</span>`,
        `</div></a>`,
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
    return Object.fromEntries([
        ["main", resolve(__dirname, "index.html")],
        ...readdirSync(__dirname)
            .filter((f) => f.endsWith(".html") && f !== "index.html" && hasBuildableRootScripts(f))
            .map((f) => [f.replace(".html", ""), resolve(__dirname, f)]),
        ...liteHtml,
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
                    const filePath = resolve(__dirname, "lite", `${liteHtmlCompat[1]}.html`);
                    if (existsSync(filePath)) {
                        res.setHeader("Content-Type", "text/html; charset=utf-8");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
                    }
                }
                if (url.startsWith("/reference/lite/") || url.startsWith("/lite/reference/")) {
                    const refPath = url.startsWith("/lite/reference/") ? `reference/lite/${url.slice("/lite/reference/".length)}` : url.slice(1);
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
                        res.setHeader("Content-Type", "image/png");
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
                if (url === "/perf-manifest.json" || url === "/perf-regression-manifest.json") {
                    const filePath = resolve(__dirname, "public", url.slice(1));
                    if (existsSync(filePath) && statSync(filePath).isFile()) {
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
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
                if ((url.startsWith("/bundle/") || url.startsWith("/lite/bundle/")) && url.endsWith(".json")) {
                    const bundlePath = url.startsWith("/lite/bundle/") ? url.slice("/lite/".length) : url.slice(1);
                    const filePath = resolve(__dirname, "public", bundlePath);
                    if (existsSync(filePath) && statSync(filePath).isFile()) {
                        res.setHeader("Content-Type", "application/json");
                        res.setHeader("Cache-Control", "no-cache");
                        createReadStream(filePath).pipe(res);
                        return;
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
                    sig.bundle = mtime(resolve(__dirname, "public/bundle/manifest.json"));
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

    const TARGETS: Record<string, TargetDef> = {
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

                if (path === "/lab-api/gen-status") {
                    const def = TARGETS[target];
                    if (!def) {
                        json(res, { error: "Unknown target" }, 400);
                        return;
                    }
                    const det = def.detect();
                    const job = jobs[target];
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
                        json(res, { error: "Unknown target" }, 400);
                        return;
                    }
                    if (busy) {
                        json(res, { started: false, error: "A generation is already in progress (" + busy + ")." }, 409);
                        return;
                    }
                    busy = target;
                    const job: Job = { running: true, log: "", done: false, ok: false, code: null };
                    jobs[target] = job;
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

export default defineConfig({
    plugins: [pagesDemoPlugin(), serveReferenceImages(), apiDocsPlugin(), tabContentPlugin()],
    optimizeDeps: {
        // BJS uses prototype-patching side-effect imports (e.g. abstractEngine.dom.js).
        // babylon-lite uses ?raw WGSL imports that esbuild can't handle.
        // Exclude both from Vite's dep optimizer.
        exclude: ["@babylonjs/core", "@babylonjs/loaders", "@babylonjs/havok"],
    },
    resolve: {
        // Ensure @babylonjs/core resolves to a single instance (loaders registers
        // plugins on the same SceneLoader the scene code imports).
        dedupe: ["@babylonjs/core"],
        alias: {
            // Point babylon-lite directly at the TypeScript source directory so Vite treats
            // it as first-party code: full HMR + native ?raw WGSL handling.
            // Directory alias so sub-path imports like 'babylon-lite/loader-env/...' work too.
            "babylon-lite": resolve(__dirname, "../packages/babylon-lite/src"),
        },
    },
    server: {
        port: 5174,
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
                "**/public/bundle-baseline/**",
                "**/public/api-docs/**",
                "**/public/lite/api-docs/**",
                "**/public/gl/api-docs/**",
                "**/public/perf-manifest.json",
                "**/public/perf-regression-manifest.json",
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
