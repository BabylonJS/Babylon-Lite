/**
 * Build Pages Site — assembles the public "Babylon.lite demos" landing site into
 * pages-dist/ for deployment under ANY base path (e.g. a GitHub Pages project
 * site, or a subdirectory).
 *
 * It reuses the exact flat, self-contained demo site that `build:bundle-demos`
 * produces in lab/public/bundle/demos/ (the same artifact deployed to
 * babylonjs.com/lite-demos/): every URL is relative — Vite builds with
 * `base: "./"`, demo HTML loads `./<slug>.js`, and each demo resolves its
 * runtime assets + glTF decoders from its own `import.meta.url`. pages-dist is
 * that folder copied verbatim (minus sourcemaps), then verified to contain no
 * root-relative URLs that would break under a base path.
 *
 * Usage: npx tsx scripts/build-pages-site.ts
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { buildFlatDemoSite } from "./bundle-demos-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = resolve(ROOT, "pages-dist");

/**
 * Fail loudly if any root-relative URL survives in the assembled site — such a
 * URL would resolve against the domain root and break when the site is served
 * from a subpath (e.g. /lite-demos/).
 */
function assertNoRootRelativeUrls(): void {
    const offenders: string[] = [];
    // demoAssetUrl() (lab/lite/src/demos/demo-asset-url.ts) normalizes paths with
    // these two inert `.replace()` constants. They are never fetched as-is — they
    // only match a "/lite/"-prefixed pathname, which never occurs on a
    // subpath-deployed Pages site — so neutralize them before scanning.
    const inert = /(["'])\/(?:lite\/)?bundle\/demos\/\1/g;
    // Catches HTML/JS root-relative refs that would be FETCHED: `src="/`, `href="/`,
    // `.src="/` (decoder <script> injection), `fetch("/`, and quoted root paths to
    // bundled asset trees.
    const pattern = /(?:src|href)\s*=\s*["']\/|fetch\(\s*["']\/|(["'])\/(?:bundle|doom|thumbnails|assets)\//g;
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = resolve(dir, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else if (/\.(html|js)$/.test(entry.name)) {
                const text = readFileSync(path, "utf-8").replace(inert, '""');
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
    // Build the flat, fully-relative demo site (identical to the artifact
    // build:bundle-demos deploys to babylonjs.com/lite-demos/).
    const flatDir = await buildFlatDemoSite();

    // pages-dist is that folder verbatim, dropping sourcemaps (not needed on Pages).
    rmSync(SITE, { recursive: true, force: true });
    mkdirSync(SITE, { recursive: true });
    cpSync(flatDir, SITE, { recursive: true, filter: (src) => !src.endsWith(".map") });

    assertNoRootRelativeUrls();

    console.log(`\n✓ Pages site built to ${SITE}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
