/**
 * Scene 351 — glTF export: rotation conversion
 *
 * Babylon.js visualization test: "GLTF Serializer Rotation conversion, left-handed".
 * Playground: #UK7FLI#1. Reference image: glTFSerializerRotationConversionLH.png (errorRatio 1.1).
 *
 * Not ported: the snippet's right-handed variant (Lite has no right-handed scenes).
 * Not reproduced one-to-one: the light and camera values Babylon.js's createDefaultLight / createDefaultCamera produce are
 * set explicitly, and the material-less boxes get an explicit default StandardMaterial (Babylon.js exports its default material).
 */
import { test } from "../parity-fixtures";
import { getSceneConfig } from "../compare-utils";
import { assertExportParity } from "../export-gltf-parity";

test.skip(!!getSceneConfig(351).skipParity, "Scene 351 skipped via skipParity in scene-config.json");
test("Scene 351 — GLTF Serializer Rotation conversion, left-handed matches Babylon.js", async ({ page }, testInfo) => {
    await assertExportParity(page, testInfo, 351);
});
