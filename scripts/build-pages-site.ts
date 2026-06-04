/**
 * Build Pages Site — assembles a self-contained, public GitHub Pages site that
 * showcases the standalone Babylon Lite demos.
 *
 * Output: pages-dist/ — a flat static site that works under ANY base path
 * (e.g. a project Pages site served from /Babylon-Lite/). Every URL it emits is
 * RELATIVE, so no base-path rewriting is required at deploy time:
 *   - index.html ............ landing page ("Babylon.lite demos"), one card per demo
 *   - demo-<slug>.html ...... each demo page (script src made relative)
 *   - bundle/demos/*.js ..... production demo bundles (doom WAD fetch made relative)
 *   - doom/* ................ Freedoom IWAD + license files (DOOM demo data)
 *   - thumbnails/*.png ...... demo card thumbnails
 *   - babylon-logo.svg ...... brand logo (dimmed page background + header)
 *
 * Cards are generated from demos-config.json; size badges from the committed
 * lab/public/bundle/demos-manifest.json.
 *
 * Usage: npx tsx scripts/build-pages-site.ts
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { buildDemo } from "./bundle-demos-core";
import { fetchDemoAssets } from "./demo-fetchers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAB = resolve(ROOT, "lab");
const PAGES_SRC = resolve(ROOT, "pages");
const SITE = resolve(ROOT, "pages-dist");

const DEMOS_CONFIG = resolve(ROOT, "demos-config.json");
const DEMOS_BUNDLE_SRC = resolve(LAB, "public/bundle/demos");
const DEMOS_MANIFEST = resolve(LAB, "public/bundle/demos-manifest.json");
const DOOM_SRC = resolve(LAB, "public/doom");
const LIBREQUAKE_SRC = resolve(LAB, "public/librequake");
const MINECRAFT_SRC = resolve(LAB, "public/minecraft");
const FREECIV_SRC = resolve(LAB, "public/freeciv");
const THUMBS_SRC = resolve(LAB, "public/thumbnails");
/** Draco decoder JS+WASM, loaded relative to the page by glTF demos that hit a
 *  KHR_draco_mesh_compression asset (see loader-gltf/draco-decode.ts). */
const DRACO_FILES = ["draco_decoder.js", "draco_decoder.wasm"];

interface DemoConfigEntry {
    slug: string;
    name: string;
    description: string;
    tags?: string[];
    /** When false, the demo is hidden on mobile devices (see index.template.html). */
    mobile?: boolean;
    /** Optional id of the asset fetcher for this demo (see scripts/demo-fetchers.ts). */
    fetch?: string;
}
interface DemoSize {
    rawKB: number;
    gzipKB: number;
}

function readJson<T>(path: string, fallback: T): T {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as T) : fallback;
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderCard(demo: DemoConfigEntry, size: DemoSize | undefined): string {
    const tagList = demo.tags ?? [];
    const tags = tagList.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const sizeRow = size ? `<div class="size" title="Engine + demo code only — excludes external assets (textures, game data, etc.)"><strong>${size.rawKB} KB</strong> · ${size.gzipKB} KB gzip</div>` : "";
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

/** Build the row of filter pills from the union of all demo tags ("All" first). */
function renderFilters(demos: DemoConfigEntry[]): string {
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

/** Make a demo HTML page deployable under any base path (root-relative -> relative). */
function rewriteDemoHtml(html: string): string {
    return html.replace(/(["'])\/bundle\//g, "$1./bundle/");
}

/** Make a demo bundle deployable under any base path. Demos that fetch runtime
 *  data use root-relative URLs (DOOM `/doom/...`, Quake `/librequake/...`); make
 *  them relative so the site works under any Pages base path. */
function rewriteBundle(code: string): string {
    return code
        .replace(/(["'])\/doom\//g, "$1doom/")
        .replace(/(["'])\/librequake\//g, "$1librequake/")
        .replace(/(["'])\/minecraft\//g, "$1minecraft/")
        .replace(/(["'])\/freeciv\//g, "$1freeciv/")
        .replace(/(["'])\/(draco_decoder\.(?:js|wasm))/g, "$1$2")
        .replace(/(["'])\/(brdf-lut\.png)/g, "$1$2");
}

/** Fail loudly if any root-relative URL survives in the assembled site. */
function assertNoRootRelativeUrls(): void {
    const offenders: string[] = [];
    const pattern = /(?:src|href)\s*=\s*["']\/|fetch\(\s*["']\/|(["'])\/(?:bundle|doom|thumbnails|assets)\//g;
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = resolve(dir, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else if (/\.(html|js)$/.test(entry.name)) {
                const text = readFileSync(path, "utf-8");
                if (pattern.test(text)) {
                    offenders.push(path);
                }
                pattern.lastIndex = 0;
            }
        }
    };
    walk(SITE);
    if (offenders.length > 0) {
        throw new Error(`Root-relative URLs found (won't work under a Pages base path):\n  ${offenders.join("\n  ")}`);
    }
}

async function main(): Promise<void> {
    const demos = readJson<DemoConfigEntry[]>(DEMOS_CONFIG, []);
    if (demos.length === 0) {
        throw new Error(`No demos found in ${DEMOS_CONFIG}`);
    }
    const sizes = readJson<Record<string, DemoSize>>(DEMOS_MANIFEST, {});

    // 0. Make sure every demo's runtime assets are present locally before we
    //    build bundles and copy asset trees below. Each fetcher is idempotent.
    await fetchDemoAssets(demos);

    // 1. Build each demo's production bundle into lab/public/bundle/demos/.
    for (const demo of demos) {
        console.log(`Building demo bundle: ${demo.slug}`);
        await buildDemo(demo.slug);
    }

    // 1b. Build the landing-page background effect (a pure Lite WGSL effect).
    //     It is NOT a card — built separately so it never appears in demos-config.
    console.log("Building landing background effect: landing-bg");
    await buildDemo("landing-bg");

    // 2. Fresh output dir.
    rmSync(SITE, { recursive: true, force: true });
    mkdirSync(SITE, { recursive: true });

    // 3. Copy + rewrite demo bundles (.js only; skip sourcemaps).
    const bundleOut = resolve(SITE, "bundle/demos");
    mkdirSync(bundleOut, { recursive: true });
    for (const file of readdirSync(DEMOS_BUNDLE_SRC)) {
        if (!file.endsWith(".js")) continue;
        const code = rewriteBundle(readFileSync(resolve(DEMOS_BUNDLE_SRC, file), "utf-8"));
        writeFileSync(resolve(bundleOut, file), code);
    }
    if (existsSync(DEMOS_MANIFEST)) {
        cpSync(DEMOS_MANIFEST, resolve(SITE, "bundle/demos-manifest.json"));
    }

    // 4. DOOM demo data (Freedoom IWAD + BSD license/attribution files). Only
    //    freedoom1.wad is fetched at runtime; skip the unused freedoom2.wad.
    if (demos.some((d) => d.slug === "doom") && existsSync(DOOM_SRC)) {
        const doomOut = resolve(SITE, "doom");
        mkdirSync(doomOut, { recursive: true });
        for (const file of readdirSync(DOOM_SRC)) {
            if (file === "freedoom2.wad") continue;
            cpSync(resolve(DOOM_SRC, file), resolve(doomOut, file));
        }
    }

    // 4b. Quake demo data (BSD-licensed LibreQuake: BSP, palette, models, sounds,
    //     license/attribution files). Fetched at dev/build time by
    //     `pnpm fetch:librequake` into lab/public/librequake/ (not committed). The
    //     whole tree is copied since the demo fetches many nested assets at runtime.
    if (demos.some((d) => d.slug === "quake") && existsSync(LIBREQUAKE_SRC)) {
        cpSync(LIBREQUAKE_SRC, resolve(SITE, "librequake"), { recursive: true });
    }

    // 4c. Minecraft demo data (BSD-licensed voxel texture pack + attribution).
    //     Fetched at dev/build time by `pnpm fetch:voxelpack` into
    //     lab/public/minecraft/ (not committed). The demo fetches the pack's PNGs
    //     at runtime from /minecraft/voxelpack/, so copy the whole tree.
    if (demos.some((d) => d.slug === "minecraft") && existsSync(MINECRAFT_SRC)) {
        cpSync(MINECRAFT_SRC, resolve(SITE, "minecraft"), { recursive: true });
    }

    // 4d. Freeciv demo data (GPLv2 amplio2 tileset PNGs + plain-text .spec grids,
    //     tilespec, and COPYING). Fetched at dev/build time by `pnpm fetch:freeciv`
    //     into lab/public/freeciv/ (not committed). The demo fetches the sheets and
    //     .spec files at runtime from /freeciv/amplio2/, so copy the whole tree.
    if (demos.some((d) => d.slug === "freeciv") && existsSync(FREECIV_SRC)) {
        cpSync(FREECIV_SRC, resolve(SITE, "freeciv"), { recursive: true });
    }

    // 4e-bis. Bath Day demo's vendored glTF model. Committed at
    //     lab/public/bath_day.glb; the demo loads it relative to the page via
    //     demoAssetUrl("./bath_day.glb"), which resolves to /bundle/demos/, so
    //     copy it alongside the demo bundles.
    if (demos.some((d) => d.slug === "bath-day")) {
        const glb = resolve(LAB, "public", "bath_day.glb");
        if (existsSync(glb)) cpSync(glb, resolve(SITE, "bundle/demos/bath_day.glb"));
    }

    // 4e. Draco decoder (JS glue + WASM) and the PBR BRDF LUT. glTF/PBR demos load
    //     these relative to the page (Draco only on KHR_draco_mesh_compression
    //     assets); the bundle ships rewritten relative references, so place the
    //     files at the site root.
    for (const file of [...DRACO_FILES, "brdf-lut.png"]) {
        const src = resolve(LAB, "public", file);
        if (existsSync(src)) cpSync(src, resolve(SITE, file));
    }

    // 5. Thumbnails for the demo cards.
    const thumbsOut = resolve(SITE, "thumbnails");
    mkdirSync(thumbsOut, { recursive: true });
    for (const demo of demos) {
        const thumb = resolve(THUMBS_SRC, `demo-${demo.slug}.png`);
        if (existsSync(thumb)) {
            cpSync(thumb, resolve(thumbsOut, `demo-${demo.slug}.png`));
        }
    }

    // 6. Demo HTML pages (rewritten to relative bundle paths).
    for (const demo of demos) {
        const src = resolve(LAB, "lite", `demo-${demo.slug}.html`);
        if (!existsSync(src)) {
            throw new Error(`Missing demo page: ${src}`);
        }
        writeFileSync(resolve(SITE, `demo-${demo.slug}.html`), rewriteDemoHtml(readFileSync(src, "utf-8")));
    }

    // 7. Brand logo.
    cpSync(resolve(PAGES_SRC, "babylon-logo.svg"), resolve(SITE, "babylon-logo.svg"));

    // 8. Landing page from template + generated cards.
    const template = readFileSync(resolve(PAGES_SRC, "index.template.html"), "utf-8");
    const cards = demos.map((d) => renderCard(d, sizes[d.slug])).join("\n                ");
    const filters = renderFilters(demos);
    writeFileSync(resolve(SITE, "index.html"), template.replace("<!--FILTERS-->", filters).replace("<!--CARDS-->", cards));

    // 9. Guardrail: nothing root-relative slipped through.
    assertNoRootRelativeUrls();

    console.log(`\n✓ Pages site built to ${SITE} (${demos.length} demo${demos.length === 1 ? "" : "s"})`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
