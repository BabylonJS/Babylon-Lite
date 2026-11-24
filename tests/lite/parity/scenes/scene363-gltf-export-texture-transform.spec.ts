/**
 * Scene 363 — glTF export: KHR_texture_transform
 *
 * Babylon.js visualization test: "Export GLTF Extension KHR_texture_transform"
 * Playground: #20OAV9#15148. Reference image: exportGltfKHRTextureTransform.png (errorRatio 1.1).
 *
 * Not reproduced one-to-one:
 * - The snippet exports with `shouldExportNode: node.name.startsWith("plane")`. Lite's exporter has no filter, so the
 *   hemispheric light and the camera are added to the scene after the export instead.
 * - Babylon.js `Texture.wAng` (rotation about the UV origin) is Lite's `Texture2D.uAng`, with the opposite sign.
 */
import { test } from "../parity-fixtures";
import { getSceneConfig } from "../compare-utils";
import { assertExportParity } from "../export-gltf-parity";

test.skip(!!getSceneConfig(363).skipParity, "Scene 363 skipped via skipParity in scene-config.json");
test("Scene 363 — Export GLTF Extension KHR_texture_transform matches Babylon.js", async ({ page }, testInfo) => {
    await assertExportParity(page, testInfo, 363);
});
