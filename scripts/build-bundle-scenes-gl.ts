/**
 * Build GL Bundle Scenes + Demos — writes two dashboard manifests:
 *   - lab/public/gl/bundle/manifest.json: each @babylonjs/lite-gl lab SCENE's
 *     standalone, tree-shaken, minified bundle size (plus the Babylon ThinEngine
 *     equivalent from its parity reference), consumed by the "Bundle" tab.
 *   - lab/public/gl/bundle/demos-manifest.json: each dedicated GL DEMO's bundle
 *     size (slug → { rawKB, gzipKB }), consumed by the "Demos" tab to advertise
 *     the real shipped lite-gl size. Demos that reuse a scene source (e.g.
 *     sine-bands → scene7) are omitted; their size shows in the Bundle tab.
 *
 * All logic lives in bundle-scenes-gl-core.ts so the bundle-size ceiling test
 * (tests/gl/build/bundle-size.test.ts) can reuse the exact same measurement.
 *
 * Usage: npx tsx scripts/build-bundle-scenes-gl.ts   (or: pnpm build:bundle-scenes:gl)
 */
import { buildGlBundleManifest, buildGlDemosManifest } from "./bundle-scenes-gl-core";

async function main(): Promise<void> {
    await buildGlBundleManifest();
    await buildGlDemosManifest();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
