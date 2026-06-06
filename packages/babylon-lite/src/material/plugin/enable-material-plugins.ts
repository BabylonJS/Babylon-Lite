/**
 * Opt-in entry point for the Material Plugin system.
 *
 * Material plugins (custom WGSL + uniforms + samplers layered on top of the
 * built-in PBR / Standard pipeline) are an *explicit* opt-in: nothing in the
 * always-fetched engine graph references the plugin bridges. A scene only pulls
 * in plugin code when the application imports and calls `enableMaterialPlugins`.
 *
 * This is what keeps plugin-free scenes BYTE-IDENTICAL to a build without the
 * plugin system at all: the shared PBR/Standard renderable and group-builder
 * modules carry zero plugin-specific code; they merely walk their generic
 * extension registries. `enableMaterialPlugins` registers the plugin bridges
 * into those global registries, and the pre-existing hook loops invoke them with
 * no shared-code changes.
 *
 * Contract: call AFTER creating materials/meshes and adding them to the scene,
 * and BEFORE `registerScene(engine, scene)`. Attach plugins via
 * `material.plugins = [plugin]` first.
 *
 *   const mat = createStandardMaterial();
 *   mat.plugins = [myPlugin];
 *   const box = createBox(engine, 2);
 *   box.material = mat;
 *   addToScene(scene, box);
 *
 *   enableMaterialPlugins(scene); // ← opt-in
 *   await registerScene(engine, scene);
 */

import type { SceneContext } from "../../scene/scene.js";
import { _registerPbrExt } from "../pbr/pbr-flags.js";
import { _registerStdExt } from "../standard/standard-flags.js";
import { registerPbrPlugins } from "./pbr-plugin-bridge.js";
import { registerStdPlugins } from "./std-plugin-bridge.js";

/**
 * Enable material-plugin support for `scene`.
 *
 * - Registers the PBR plugin bridge: its `detect` hook encodes a per-signature
 *   index into each PBR material's feature bits during the build, so no mesh
 *   walk is needed here.
 * - Registers the Standard plugin bridge and walks `scene.meshes`, pre-baking a
 *   per-signature index into every Standard plugin material's cached
 *   `_renderFeatures` (Standard's feature computation is not ext-extensible, so
 *   the index must be baked in up front). Standard plugin uniforms are delivered
 *   through a self-managed uniform buffer built here and bound via the
 *   pre-existing `StdExt._bind` loop.
 */
export function enableMaterialPlugins(scene: SceneContext): void {
    registerPbrPlugins(_registerPbrExt);
    registerStdPlugins(scene.meshes, scene.engine, _registerStdExt);
}
