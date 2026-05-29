/**
 * Build Bundle Demos — entry point. Builds each lab demo as a standalone,
 * tree-shaken, minified production bundle and measures its runtime JS size.
 *
 * Usage: npx tsx scripts/build-bundle-demos.ts
 */
import { buildDemoBundles } from "./bundle-demos-core";

buildDemoBundles().catch((err) => {
    console.error(err);
    process.exit(1);
});
