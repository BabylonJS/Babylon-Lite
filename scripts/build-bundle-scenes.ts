/**
 * Build Bundle Scenes — builds each lab scene as a standalone, tree-shaken,
 * minified production bundle into lab/public/bundle/.
 *
 * The "Bundle" tab in the lab gallery loads these pre-built files directly,
 * showing what a real consumer gets after tree-shaking + minification.
 *
 * Also writes the per-scene manifest files (lab/public/bundle/manifest/<scene>.json)
 * plus a generated aggregate manifest.json for the gallery UI. Both are gitignored
 * build output; master publishes the aggregate as the shared size baseline.
 *
 * Usage: npx tsx scripts/build-bundle-scenes.ts
 */
import { buildBundleScenes } from "./bundle-scenes-core";

buildBundleScenes().catch((err) => {
    console.error(err);
    process.exit(1);
});
