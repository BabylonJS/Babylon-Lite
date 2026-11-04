/**
 * Scene 350 — glTF export of a textured sphere with two animated morph targets
 *
 * Babylon.js visualization test: "GLTF Serializer Morph Target Animation"
 * Playground: #84M2SR#107. Babylon.js reference image: gltfSerializerMorphTargetAnimation.png (errorRatio 1.1; the test is
 * excluded on WebGPU upstream, but the Babylon.js WebGPU render of this snippet matches that image).
 *
 * Not reproduced as in the snippet: the morph targets are position/normal deltas rather than absolute positions, and the
 * two influence animations are not authored, because the Lite exporter exports only glTF-clip animation groups.
 * The test therefore covers morph-target export and reload, not morph-animation export; the weights Babylon.js
 * reaches at frame 60 (1.25, 1.25) are applied directly after the reload.
 * See the header of lab/lite/src/lite/scene350.ts.
 */
import { test } from "../parity-fixtures";
import { getSceneConfig } from "../compare-utils";
import { assertExportParity } from "../export-gltf-parity";

test.skip(!!getSceneConfig(350).skipParity, "Scene 350 skipped via skipParity in scene-config.json");
test("Scene 350 — GLTF Serializer Morph Target Animation matches Babylon.js", async ({ page }, testInfo) => {
    await assertExportParity(page, testInfo, 350);
});
