/**
 * Scene 349 — glTF export: shared buffer conversions
 *
 * Babylon.js visualization test: "GLTF Serializer Shared Buffer Conversions".
 * Playground: #KX53VK#85 (`meshCount = 2`). Reference image: glTFSerializerSharedBufferConversions.png (errorRatio 1.1).
 *
 * Reproduced as written, except that the light joins after the round trip (the snippet's `shouldExportNode` excludes it;
 * Lite's exporter has no node filter). The two meshes are built from the same typed arrays, so the exporter sees one
 * shared geometry.
 */
import { test } from "../parity-fixtures";
import { getSceneConfig } from "../compare-utils";
import { assertExportParity } from "../export-gltf-parity";

test.skip(!!getSceneConfig(349).skipParity, "Scene 349 skipped via skipParity in scene-config.json");
test("Scene 349 — GLTF Serializer Shared Buffer Conversions matches Babylon.js", async ({ page }, testInfo) => {
    await assertExportParity(page, testInfo, 349);
});
