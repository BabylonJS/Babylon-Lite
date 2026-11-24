/**
 * Scene 359 — glTF export: negative world matrix
 *
 * Babylon.js visualization test: "GLTF Serializer with Negative World Matrix (left handed, twice)", run as `?iterations=2`.
 * Playground: #KX53VK#88. Reference image: glTFSerializerNegativeWorldMatrix.png (errorRatio 1.1), shared by all variants.
 *
 * Also covers "left handed, once": its single export and reload is the first iteration here and compares to the same golden.
 * Not ported: the two right-handed tests ("right handed, once / twice"); Lite has no right-handed scenes.
 * Not reproduced one-to-one: Lite has no per-material sideOrientation, so the "CW" triangles keep their vertices and
 * get reversed indices. The page opts into `enableDeviceLostSceneRecovery` so loaded meshes keep their vertex colors
 * for the second export (see the page and docs/lite/architecture/60-gltf-exporter.md, Scope). The snippet's
 * `shouldExportNode` excludes the light; Lite's exporter has no node filter, so the light joins after the round trips.
 */
import { test } from "../parity-fixtures";
import { getSceneConfig } from "../compare-utils";
import { assertExportParity } from "../export-gltf-parity";

test.skip(!!getSceneConfig(359).skipParity, "Scene 359 skipped via skipParity in scene-config.json");
test("Scene 359 — GLTF Serializer with Negative World Matrix (left handed, twice) matches Babylon.js", async ({ page }, testInfo) => {
    await assertExportParity(page, testInfo, 359, "?iterations=2");
});
