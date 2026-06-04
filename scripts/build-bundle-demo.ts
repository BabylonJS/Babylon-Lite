/**
 * Build a SINGLE lab demo bundle — fast path for iterating on one demo without
 * rebuilding (and re-measuring) every demo. Re-bundles only the named demo's JS
 * into lab/public/bundle/demos/, then re-copies that demo's runtime assets
 * (tilesets, game data, …) so the served page works.
 *
 * The demo's HTML is left as written by the last full `build:bundle-demos`, and
 * size measurement is skipped — run the full build when you need the size badge
 * updated. Assumes a full `build:bundle-demos` has been run at least once.
 *
 * Usage: npx tsx scripts/build-bundle-demo.ts <slug>   (defaults to "freeciv")
 */
import { buildDemo, copyDemoRuntimeAssets, loadDemoConfig } from "./bundle-demos-core";

const slug = process.argv[2] ?? "freeciv";

async function main(): Promise<void> {
    console.log(`Building demo ${slug}...`);
    await buildDemo(slug);

    const demo = loadDemoConfig(slug);
    if (demo) {
        // Re-copy this demo's runtime assets into the bundle (idempotent), so a demo
        // whose asset folder shares its slug (e.g. freeciv) is restored after bundling.
        copyDemoRuntimeAssets([demo]);
    }
    console.log(`Done. Reload the dev server page for "${slug}".`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
