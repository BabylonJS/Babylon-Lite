/**
 * Build GL Bundle Scenes — writes lab/public/gl/bundle/manifest.json with each
 * @babylonjs/lite-gl lab scene's standalone, tree-shaken, minified bundle size
 * (plus the Babylon ThinEngine equivalent from its parity reference), consumed by
 * the GL dashboard "Bundle" tab.
 *
 * All logic lives in bundle-scenes-gl-core.ts so the bundle-size ceiling test
 * (tests/gl/build/bundle-size.test.ts) can reuse the exact same measurement.
 *
 * Usage: npx tsx scripts/build-bundle-scenes-gl.ts   (or: pnpm build:bundle-scenes:gl)
 */
import { buildGlBundleManifest } from "./bundle-scenes-gl-core";

buildGlBundleManifest().catch((err) => {
    console.error(err);
    process.exit(1);
});
