/**
 * Build Bundle Demos — builds each lab "demo" plus required demo support
 * bundles as standalone, tree-shaken, minified production bundles into
 * lab/public/bundle/demos/, writes the demo HTML needed to serve those bundles,
 * then measures each configured demo's runtime JS size with a headless browser.
 *
 * Demos are showcase-only pages (pure Lite, no BJS comparison, no parity/golden
 * obligations) that exist to advertise how thin a Lite-powered page can be.
 * They are intentionally kept OUT of scene-config.json so they don't inherit
 * parity / bundle-ceiling test requirements.
 *
 * Sizes are written to lab/public/bundle/demos-manifest.json which the lab
 * "Demos" tab reads to render a size badge per demo.
 *
 * NOTE: The Vite build config below mirrors the lite branch of `buildScene`
 * in bundle-scenes-core.ts so demo sizes are measured the exact same way as
 * scenes. Keep the two in sync.
 *
 * Usage: npx tsx scripts/build-bundle-demos.ts
 */
import { build, type Plugin } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { cpSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from "fs";
import {
    labDir,
    srcDir,
    outDir,
    wgslMinifyPlugin,
    terserPropertyManglePlugin,
    isLiteBundleExternal,
    writeBundleInfo,
    startStaticServer,
    measurementBrowserArgs,
    measurePage,
    LITE_BUNDLE_TARGET,
    NAME_POLYFILL,
} from "./bundle-scenes-core";
import { fetchDemoAssets } from "./demo-fetchers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGES_SRC = resolve(ROOT, "pages");
const THUMBS_SRC = resolve(labDir, "public/thumbnails");
const DOOM_SRC = resolve(labDir, "public/doom");
const LIBREQUAKE_SRC = resolve(labDir, "public/librequake");
const MINECRAFT_SRC = resolve(labDir, "public/minecraft");
const FREECIV_SRC = resolve(labDir, "public/freeciv");
const LITTLEST_TOKYO_SRC = resolve(labDir, "public/littlest-tokyo");
const DRACO_FILES = ["draco_decoder.js", "draco_decoder.wasm"];

interface DemoConfigEntry {
    slug: string;
    name: string;
    description: string;
    tags?: string[];
    /** When false, the demo is hidden on mobile-oriented demo listings. */
    mobile?: boolean;
    /** Optional id of the asset fetcher for this demo (see scripts/demo-fetchers.ts). */
    fetch?: string;
}

interface DemoManifestEntry {
    rawKB: number;
    gzipKB: number;
}

const demosDir = resolve(outDir, "demos");
const DEMOS_MANIFEST_FILE = resolve(outDir, "demos-manifest.json");
const DEMO_SUPPORT_BUNDLES = ["landing-bg"] as const;

/** Stub Vite's preload helper so it doesn't add bytes to measured bundles. */
function minimalVitePreloadPlugin(): Plugin {
    const id = "\0minimal-vite-preload";
    return {
        name: "minimal-vite-preload",
        enforce: "pre",
        resolveId(source) {
            return source === "vite/preload-helper.js" ? id : null;
        },
        load(source) {
            return source === id ? "export const __vitePreload = (baseModule) => baseModule();" : null;
        },
        transform(_code, source) {
            return source.endsWith("vite/preload-helper.js") ? "export const __vitePreload = (baseModule) => baseModule();" : null;
        },
    };
}

function loadDemosConfig(): DemoConfigEntry[] {
    return JSON.parse(readFileSync(resolve(ROOT, "demos-config.json"), "utf-8")) as DemoConfigEntry[];
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function rewriteDemoHtmlForBundle(html: string): string {
    return html.replace(/(["'])\/(?:lite\/)?bundle\/demos\//g, "$1./");
}

function renderCard(demo: DemoConfigEntry, size: DemoManifestEntry | undefined): string {
    const tagList = demo.tags ?? [];
    const tags = tagList.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    const sizeRow = size
        ? `<div class="size" title="Engine + demo code only — excludes external assets (textures, game data, etc.)"><strong>${size.rawKB} KB</strong> · ${size.gzipKB} KB gzip</div>`
        : "";
    return [
        `<a class="card" href="./demo-${demo.slug}.html" data-tags="${escapeHtml(tagList.join(" "))}" data-mobile="${demo.mobile === false ? "false" : "true"}">`,
        `<div class="card-image">`,
        `<img src="thumbnails/demo-${demo.slug}.png" alt="${escapeHtml(demo.name)} thumbnail" loading="lazy" decoding="async" onerror="this.remove()" />`,
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

function renderFilters(demos: DemoConfigEntry[]): string {
    const tags = Array.from(new Set(demos.flatMap((demo) => demo.tags ?? []))).sort();
    if (tags.length === 0) {
        return "";
    }
    const pills = [
        `<button type="button" class="filter-pill is-active" data-filter="all" aria-pressed="true">All</button>`,
        ...tags.map((tag) => `<button type="button" class="filter-pill" data-filter="${escapeHtml(tag)}" aria-pressed="false">${escapeHtml(tag)}</button>`),
    ].join("");
    return `<nav class="filters" aria-label="Filter demos by tag">${pills}</nav>`;
}

function renderDemoIndex(demos: DemoConfigEntry[], manifest: Record<string, DemoManifestEntry>): string {
    const template = readFileSync(resolve(PAGES_SRC, "index.template.html"), "utf-8");
    const cards = demos.map((demo) => renderCard(demo, manifest[demo.slug])).join("\n                ");
    return template
        .replace("<!--FILTERS-->", renderFilters(demos))
        .replace("<!--CARDS-->", cards)
        .replace(/(["'])bundle\/demos\/landing-bg\.js\1/g, "$1./landing-bg.js$1");
}

function copyDemoIndexAssets(demos: DemoConfigEntry[]): void {
    cpSync(resolve(PAGES_SRC, "babylon-logo.svg"), resolve(demosDir, "babylon-logo.svg"));

    const thumbsOut = resolve(demosDir, "thumbnails");
    rmSync(thumbsOut, { recursive: true, force: true });
    mkdirSync(thumbsOut, { recursive: true });
    for (const demo of demos) {
        const thumb = resolve(THUMBS_SRC, `demo-${demo.slug}.png`);
        if (existsSync(thumb)) {
            cpSync(thumb, resolve(thumbsOut, `demo-${demo.slug}.png`));
        }
    }
}

function copyRequiredDir(source: string, target: string, label: string): void {
    if (!existsSync(source)) {
        throw new Error(`Missing ${label} assets at ${source}`);
    }
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
}

function copyDemoRuntimeAssets(demos: DemoConfigEntry[]): void {
    if (demos.some((demo) => demo.slug === "doom")) {
        if (!existsSync(DOOM_SRC)) {
            throw new Error(`Missing DOOM assets at ${DOOM_SRC}`);
        }
        const doomOut = resolve(demosDir, "doom");
        rmSync(doomOut, { recursive: true, force: true });
        mkdirSync(doomOut, { recursive: true });
        for (const file of readdirSync(DOOM_SRC)) {
            if (file === "freedoom2.wad") continue;
            cpSync(resolve(DOOM_SRC, file), resolve(doomOut, file));
        }
    }

    if (demos.some((demo) => demo.slug === "quake")) {
        copyRequiredDir(LIBREQUAKE_SRC, resolve(demosDir, "librequake"), "LibreQuake");
    }

    if (demos.some((demo) => demo.slug === "minecraft")) {
        copyRequiredDir(MINECRAFT_SRC, resolve(demosDir, "minecraft"), "Minecraft voxel pack");
    }

    if (demos.some((demo) => demo.slug === "freeciv")) {
        copyRequiredDir(FREECIV_SRC, resolve(demosDir, "freeciv"), "Freeciv");
    }

    if (demos.some((demo) => demo.slug === "littlest-tokyo")) {
        copyRequiredDir(LITTLEST_TOKYO_SRC, resolve(demosDir, "littlest-tokyo"), "Littlest Tokyo");
    }

    if (demos.some((demo) => demo.slug === "bath-day")) {
        const glb = resolve(labDir, "public", "bath_day.glb");
        if (existsSync(glb)) {
            cpSync(glb, resolve(demosDir, "bath_day.glb"));
        }
    }

    for (const file of [...DRACO_FILES, "brdf-lut.png"]) {
        const src = resolve(labDir, "public", file);
        if (existsSync(src)) {
            cpSync(src, resolve(demosDir, file));
        }
    }
}

function writeDemoHtml(demos: DemoConfigEntry[], manifest: Record<string, DemoManifestEntry>): void {
    for (const demo of demos) {
        const source = resolve(labDir, "lite", `demo-${demo.slug}.html`);
        if (!existsSync(source)) {
            throw new Error(`Missing demo HTML: ${source}`);
        }
        writeFileSync(resolve(demosDir, `demo-${demo.slug}.html`), rewriteDemoHtmlForBundle(readFileSync(source, "utf-8")));
    }
    copyDemoIndexAssets(demos);
    copyDemoRuntimeAssets(demos);
    writeFileSync(resolve(demosDir, "index.html"), renderDemoIndex(demos, manifest));
}

export async function buildDemo(slug: string): Promise<void> {
    const demoOutDir = resolve(demosDir, slug);
    rmSync(demoOutDir, { recursive: true, force: true });

    const buildResult = await build({
        root: labDir,
        configFile: false,
        base: "./",
        publicDir: false,
        logLevel: "warn",
        plugins: [wgslMinifyPlugin({ mangle: false }), terserPropertyManglePlugin(), minimalVitePreloadPlugin()],
        resolve: {
            alias: { "babylon-lite": srcDir },
            dedupe: ["@babylonjs/core"],
        },
        build: {
            outDir: demoOutDir,
            emptyOutDir: true,
            target: LITE_BUNDLE_TARGET,
            minify: "esbuild",
            sourcemap: "hidden",
            modulePreload: { polyfill: false, resolveDependencies: () => [] },
            rollupOptions: {
                input: { [slug]: resolve(labDir, `lite/src/demos/${slug}.ts`) },
                external: isLiteBundleExternal,
                output: {
                    format: "es",
                    entryFileNames: "[name].js",
                    chunkFileNames: `${slug}-[name]-[hash].js`,
                    banner: NAME_POLYFILL,
                },
            },
        },
        // Demos may spawn a module Web Worker via `new Worker(new URL("./x.ts", import.meta.url), { type: "module" })`
        // (see the offscreen demo). Build the worker with the same WGSL/property-mangle
        // pipeline and emit its chunks prefixed with the slug so the copy + stale-cleanup
        // logic below picks them up alongside the main entry. WGSL identifier mangling is
        // disabled (mangle: false) because the worker's aggressive code-splitting can place
        // a shader struct declaration and its usages in different chunks, which per-chunk
        // mangling would rename inconsistently (e.g. "struct member wp not found").
        worker: {
            format: "es",
            plugins: () => [wgslMinifyPlugin({ mangle: false }), terserPropertyManglePlugin()],
            rollupOptions: {
                output: {
                    entryFileNames: `${slug}-worker-[hash].js`,
                    chunkFileNames: `${slug}-worker-[name]-[hash].js`,
                    banner: NAME_POLYFILL,
                },
            },
        },
    });

    // Bundle-info keyed as `demo-<slug>` so size accounting can read it during measurement.
    writeBundleInfo(`demo-${slug}`, buildResult);

    // Atomically replace this demo's files in outDir/demos:
    // 1. Write all new files. 2. Remove stale chunks from a previous build.
    mkdirSync(demosDir, { recursive: true });
    const newNames = new Set<string>();
    for (const f of readdirSync(demoOutDir)) {
        if (f.endsWith(".map")) continue;
        if (!statSync(resolve(demoOutDir, f)).isFile()) continue;
        newNames.add(f);
        writeFileSync(resolve(demosDir, f), readFileSync(resolve(demoOutDir, f)));
    }
    for (const existing of readdirSync(demosDir)) {
        if ((existing === `${slug}.js` || existing.startsWith(`${slug}-`)) && !newNames.has(existing)) {
            rmSync(resolve(demosDir, existing));
        }
    }
    rmSync(demoOutDir, { recursive: true, force: true });
}

export async function buildDemoSupportBundles(): Promise<void> {
    for (const slug of DEMO_SUPPORT_BUNDLES) {
        console.log(`Building demo support bundle ${slug}...`);
        await buildDemo(slug);
    }
}

export async function buildDemoBundles(): Promise<void> {
    const demos = loadDemosConfig();
    if (demos.length === 0) {
        console.log("No demos configured; skipping demo bundle build.");
        return;
    }

    // Make sure every demo's runtime assets (IWAD, textures, tilesets, …) are
    // present locally before bundling. Each fetcher is idempotent.
    await fetchDemoAssets(demos);

    mkdirSync(demosDir, { recursive: true });

    for (const demo of demos) {
        console.log(`Building demo ${demo.slug}...`);
        await buildDemo(demo.slug);
    }

    await buildDemoSupportBundles();

    // Measure runtime-fetched JS size for each demo.
    const { chromium } = await import("@playwright/test");
    const { server, port } = await startStaticServer(labDir);
    const manifest: Record<string, DemoManifestEntry> = existsSync(DEMOS_MANIFEST_FILE)
        ? (JSON.parse(readFileSync(DEMOS_MANIFEST_FILE, "utf-8")) as Record<string, DemoManifestEntry>)
        : {};
    try {
        const browser = await chromium.launch({ channel: "chrome", headless: true, args: measurementBrowserArgs() });
        try {
            for (const demo of demos) {
                const { rawKB, gzipKB } = await measurePage(browser, port, `demo-${demo.slug}`, `lite/demo-${demo.slug}.html`, "/bundle/demos/");
                manifest[demo.slug] = { rawKB, gzipKB };
                writeFileSync(DEMOS_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
                console.log(`  measured ${demo.slug}: ${rawKB} KB raw, ${gzipKB} KB gzip`);
            }
        } finally {
            await browser.close();
        }
    } finally {
        server.close();
    }

    // Drop manifest entries for demos that no longer exist.
    const slugs = new Set(demos.map((d) => d.slug));
    let changed = false;
    for (const key of Object.keys(manifest)) {
        if (!slugs.has(key)) {
            delete manifest[key];
            changed = true;
        }
    }
    if (changed) {
        writeFileSync(DEMOS_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    }

    writeDemoHtml(demos, manifest);

    console.log(`✓ Demo bundles, manifest, and HTML built to ${demosDir}`);
}
