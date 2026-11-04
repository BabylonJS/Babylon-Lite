/**
 * Opt-in entry point for the Material Plugin system.
 *
 * Material plugins (custom WGSL + uniforms + samplers layered on top of the
 * built-in PBR / Standard pipeline) are an *explicit* opt-in: nothing in the
 * always-fetched engine graph references the plugin bridges. A scene only pulls
 * in plugin code when the application imports and calls `enableMaterialPlugins`.
 *
 * Shared PBR/Standard renderables carry no plugin implementation; they merely
 * walk generic extension registries and pass their owning scene to binding hooks.
 * `enableMaterialPlugins` registers the plugin bridges into those registries.
 *
 * Contract: call AFTER creating materials/meshes and adding them to the scene,
 * and BEFORE `registerScene(scene)`. Attach plugins via
 * `material.plugins = [plugin]` first.
 *
 *   const mat = createStandardMaterial();
 *   mat.plugins = [myPlugin];
 *   const box = createBox(engine, 2);
 *   box.material = mat;
 *   addToScene(scene, box);
 *
 *   enableMaterialPlugins(scene); // ← opt-in
 *   await registerScene(scene);
 */

import type { SceneContext } from "../../scene/scene.js";
import type { Material } from "../material.js";
import { getMaterialSource } from "../material-view.js";
import { _registerPbrExt } from "../pbr/pbr-flags.js";
import { _registerStdExt } from "../standard/standard-flags.js";
import { getStandardGroupBuilder, type StandardMaterialProps } from "../standard/standard-material.js";
import { enqueueMaterialSwap } from "../../scene/mesh-scene-registry.js";
import { processMaterialSwaps } from "../../scene/scene-material-swap.js";
import { registerPbrPlugins } from "./pbr-plugin-bridge.js";
import { bakeStdPluginMaterial, registerStdPluginBridge, registerStdPlugins } from "./std-plugin-bridge.js";

function isStandardMaterial(material: Material): material is StandardMaterialProps {
    return material._buildGroup === getStandardGroupBuilder();
}

function installRefresh(scene: SceneContext, refresh: (deltaMs: number) => void): void {
    // Public onBeforeRender() callbacks use unshift(), so appending keeps the upload
    // after plugin-value mutations regardless of whether they register before or after us.
    const previous = scene._beforeRender.indexOf(refresh);
    if (previous >= 0) {
        scene._beforeRender.splice(previous, 1);
    }
    scene._beforeRender.push(refresh);
}

/**
 * Enable material-plugin support for `scene`.
 *
 * - Registers the PBR plugin bridge: its `detect` hook assigns a stable signature
 *   identity outside the material's feature bits during the build, so no mesh
 *   walk is needed here.
 * - Registers the Standard plugin bridge and walks `scene.meshes`, pre-baking a
 *   per-signature identity into every Standard plugin material's `_pi`.
 *   Only a presence flag enters per-renderable features. Standard plugin uniforms are delivered
 *   through a self-managed uniform buffer built here and bound via the
 *   pre-existing `StdExt._bind` loop.
 */
export function enableMaterialPlugins(scene: SceneContext): void {
    registerPbrPlugins(_registerPbrExt);
    const refresh = registerStdPlugins(scene, _registerStdExt);
    installRefresh(scene, refresh);
}

/**
 * Reconcile a plugin material after its shader-affecting state changes in a live scene.
 *
 * The bridge is enabled before the material's renderables are rebuilt. Standard
 * materials are baked by {@link enableMaterialPlugins}; PBR materials receive their
 * stable signature index while the queued renderable rebuild runs.
 */
export async function reconcileMaterialPlugins(scene: SceneContext, material: Material): Promise<void> {
    registerPbrPlugins(_registerPbrExt);
    installRefresh(scene, registerStdPluginBridge(scene, _registerStdExt));
    const source = getMaterialSource(material);
    source._renderFeatures = undefined;
    if (isStandardMaterial(source)) {
        bakeStdPluginMaterial(source, scene);
    }
    for (const mesh of scene.meshes) {
        if (mesh.material && getMaterialSource(mesh.material) === source) {
            enqueueMaterialSwap(scene, mesh);
        }
    }
    const pending = processMaterialSwaps(scene);
    if (pending) {
        await pending;
    }
}
