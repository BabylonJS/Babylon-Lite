/**
 * Build Bundle Demos — builds each lab "demo" as a standalone, tree-shaken,
 * minified production bundle into lab/public/bundle/demos/, then measures the
 * runtime-fetched JS size with a headless browser.
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
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from "fs";
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface DemoConfigEntry {
    slug: string;
    name: string;
    description: string;
    tags?: string[];
}

interface DemoManifestEntry {
    rawKB: number;
    gzipKB: number;
}

const demosDir = resolve(outDir, "demos");
const DEMOS_MANIFEST_FILE = resolve(outDir, "demos-manifest.json");

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

export async function buildDemo(slug: string): Promise<void> {
    const demoOutDir = resolve(demosDir, slug);
    rmSync(demoOutDir, { recursive: true, force: true });

    const buildResult = await build({
        root: labDir,
        configFile: false,
        base: "./",
        publicDir: false,
        logLevel: "warn",
        plugins: [wgslMinifyPlugin(), terserPropertyManglePlugin(), minimalVitePreloadPlugin()],
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
                input: { [slug]: resolve(labDir, `src/demos/${slug}.ts`) },
                external: isLiteBundleExternal,
                output: {
                    format: "es",
                    entryFileNames: "[name].js",
                    chunkFileNames: `${slug}-[name]-[hash].js`,
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

export async function buildDemoBundles(): Promise<void> {
    const demos = loadDemosConfig();
    if (demos.length === 0) {
        console.log("No demos configured; skipping demo bundle build.");
        return;
    }
    mkdirSync(demosDir, { recursive: true });

    for (const demo of demos) {
        console.log(`Building demo ${demo.slug}...`);
        await buildDemo(demo.slug);
    }

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
                const { rawKB, gzipKB } = await measurePage(browser, port, `demo-${demo.slug}`, `demo-${demo.slug}.html`, "/bundle/demos/");
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

    console.log(`✓ Demo bundles + manifest built to ${demosDir}`);
}
