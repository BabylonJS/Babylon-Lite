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
import type { MaterialPlugin } from "./material-plugin.js";
import { bindPluginTextures, buildPluginFragment, collectPluginTextures, enabledPlugins, pluginSignature, writePluginUbo } from "./plugin-bridge-shared.js";
import { _allocatePbrPluginIndex, _getActivePbrPluginExt, _getPbrPluginFragment, _registerPbrPluginFragment } from "./pbr-plugin-registry.js";

// Shader identities outlive scene registration and device changes. Keep only
// immutable fragment data here, never material instances or their callbacks.
let _sigToIndex: Map<string, number> | null = null;

function _indexFor(plugins: readonly MaterialPlugin[]): number {
    const sig = pluginSignature(plugins);
    const map = (_sigToIndex ??= new Map());
    let index = map.get(sig);
    if (index === undefined) {
        index = _allocatePbrPluginIndex();
        _registerPbrPluginFragment(index, buildPluginFragment(plugins, index, false)._fragment);
        map.set(sig, index);
    }
    return index;
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
        const fragment = _getPbrPluginFragment(idx);
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

/** Register the PBR plugin bridge extension. Called from `pbr-renderable` only
 *  when at least one PBR material in the scene carries plugins. */
export function registerPbrPlugins(register: (ext: PbrExt) => void): void {
    register(_getActivePbrPluginExt(pbrPluginExt));
}
