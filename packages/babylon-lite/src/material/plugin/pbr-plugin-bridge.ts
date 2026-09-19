/**
 * PBR material-plugin bridge (dynamically imported only when a PBR material in
 * the scene carries `plugins`). Turns `MaterialPlugin[]` into a single `PbrExt`
 * registered through `_registerPbrExt`, hooking every lifecycle stage:
 *   detect   → provides a per-signature shader variant outside the native
 *              feature bitfields so plugin and extension flags cannot collide.
 *   frag     → returns the composed plugin ShaderFragment for that signature.
 *   writeUbo → routes plugin UBO writes into the material UBO.
 *   bind     → appends plugin texture/sampler bind entries (fragment phase).
 *   textures → enumerates plugin textures for acquire/release.
 *
 * The plugin signature index is carried by Material._pi.
 */

import type { PbrExt } from "../pbr/pbr-flags.js";
import type { PbrMaterialProps } from "../pbr/pbr-material.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { MaterialPlugin } from "./material-plugin.js";
import { bindPluginTextures, buildPluginFragment, collectPluginTextures, enabledPlugins, pluginSignature, writePluginUbo } from "./plugin-bridge-shared.js";

// Shader identities outlive scene registration and device changes. Keep only
// immutable fragment data here, never material instances or their callbacks.
let _sigToIndex: Map<string, number> | null = null;
let _indexToFragment: ShaderFragment[] | null = null;
let _counter = 0;

function _indexFor(plugins: readonly MaterialPlugin[]): number {
    const sig = pluginSignature(plugins);
    const map = (_sigToIndex ??= new Map());
    let idx = map.get(sig);
    if (idx === undefined) {
        idx = _counter + 1;
        const fragment = buildPluginFragment(plugins, idx, false)._fragment;
        (_indexToFragment ??= [])[idx] = fragment;
        map.set(sig, idx);
        _counter = idx;
    }
    return idx;
}

const pbrPluginExt: PbrExt = {
    id: "plugin",
    phase: "fragment",
    detect(mat) {
        const material = mat as PbrMaterialProps & { plugins?: MaterialPlugin[] };
        const plugins = material.plugins;
        material._preparedPlugins = plugins?.length ? enabledPlugins(plugins) : undefined;
        material._pi = plugins?.length ? _indexFor(plugins) : 0;
        return { f: 0, f2: 0 };
    },
    frag(ctx) {
        const idx = ctx._pi ?? 0;
        if (!idx) {
            return null;
        }
        const fragment = _indexToFragment?.[idx];
        if (!fragment) {
            throw new Error("PBR material plugin signature is not registered.");
        }
        return fragment;
    },
    writeUbo(data, mat, offsets) {
        const plugins = (mat as PbrMaterialProps)._preparedPlugins;
        if (plugins?.length) {
            writePluginUbo(plugins, data, offsets);
        }
    },
    bind(ctx, entries, b) {
        const plugins = (ctx._material as PbrMaterialProps)._preparedPlugins;
        return plugins?.length ? bindPluginTextures(plugins, entries, b) : b;
    },
    textures(mat, out) {
        const plugins = (mat as PbrMaterialProps)._preparedPlugins;
        if (!plugins?.length) {
            return;
        }
        collectPluginTextures(plugins, out);
    },
};

let activePbrPluginExt = pbrPluginExt;

/** @internal Preserve an opt-in PBR plugin bridge across later registration and reconciliation. */
export function _setActivePbrPluginExt(extension: PbrExt): void {
    activePbrPluginExt = extension;
}

/** Register the PBR plugin bridge extension. Called from `pbr-renderable` only
 *  when at least one PBR material in the scene carries plugins. */
export function registerPbrPlugins(register: (ext: PbrExt) => void): void {
    register(activePbrPluginExt);
}
