/**
 * PBR material-plugin bridge (dynamically imported only when a PBR material in
 * the scene carries `plugins`). Turns `MaterialPlugin[]` into a single `PbrExt`
 * registered through `_registerPbrExt`, hooking every lifecycle stage:
 *   detect   → encodes a per-signature index into features2 high bits so the
 *              compose/pipeline caches rebuild on any plugin change.
 *   frag     → returns the composed plugin ShaderFragment for that signature.
 *   writeUbo → routes plugin UBO writes into the material UBO.
 *   bind     → appends plugin texture/sampler bind entries (fragment phase).
 *   textures → enumerates plugin textures for acquire/release.
 *
 * The plugin signature index lives in features2 bits 24..31 (unused by the
 * native PBR flag set, which only reaches bit 20).
 */

import type { PbrExt } from "../pbr/pbr-flags.js";
import type { PbrMaterialProps } from "../pbr/pbr-material.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { MaterialPlugin } from "./material-plugin.js";
import { bindPluginTextures, buildPluginFragment, enabledPlugins, pluginSignature, writePluginUbo } from "./plugin-bridge-shared.js";

const PLUGIN_INDEX_SHIFT = 24;

interface PluginEntry {
    readonly _plugins: readonly MaterialPlugin[];
    readonly _fragment: ShaderFragment | null;
}

// Lazy-init module state (no module-level Map — GUIDANCE §4). Reset each time a
// scene registers its plugins so stale signatures never leak between builds.
let _sigToIndex: Map<string, number> | null = null;
let _indexToEntry: Map<number, PluginEntry> | null = null;
let _counter = 0;

function _resetState(): void {
    _sigToIndex = new Map();
    _indexToEntry = new Map();
    _counter = 0;
}

function _indexFor(plugins: readonly MaterialPlugin[]): number {
    const sig = pluginSignature(plugins);
    const map = (_sigToIndex ??= new Map());
    let idx = map.get(sig);
    if (idx === undefined) {
        idx = ++_counter;
        map.set(sig, idx);
        (_indexToEntry ??= new Map()).set(idx, { _plugins: plugins, _fragment: buildPluginFragment(plugins, idx, false)._fragment });
    }
    return idx;
}

const pbrPluginExt: PbrExt = {
    id: "plugin",
    phase: "fragment",
    detect(mat) {
        const plugins = (mat as PbrMaterialProps & { plugins?: MaterialPlugin[] }).plugins;
        if (!plugins?.length) {
            return { f: 0, f2: 0 };
        }
        return { f: 0, f2: _indexFor(plugins) << PLUGIN_INDEX_SHIFT };
    },
    frag(ctx) {
        const idx = (ctx._features2 >>> PLUGIN_INDEX_SHIFT) & 0xff;
        if (!idx) {
            return null;
        }
        return _indexToEntry?.get(idx)?._fragment ?? null;
    },
    writeUbo(data, mat, offsets) {
        const plugins = (mat as PbrMaterialProps & { plugins?: MaterialPlugin[] }).plugins;
        if (plugins?.length) {
            writePluginUbo(plugins, data, offsets);
        }
    },
    bind(ctx, entries, b) {
        const plugins = (ctx._material as PbrMaterialProps & { plugins?: MaterialPlugin[] }).plugins;
        return plugins?.length ? bindPluginTextures(plugins, entries, b) : b;
    },
    textures(mat, out) {
        const plugins = (mat as PbrMaterialProps & { plugins?: MaterialPlugin[] }).plugins;
        if (!plugins?.length) {
            return;
        }
        for (const p of enabledPlugins(plugins)) {
            p.getActiveTextures?.(out);
        }
    },
};

/** Register the PBR plugin bridge extension. Called from `pbr-renderable` only
 *  when at least one PBR material in the scene carries plugins. */
export function registerPbrPlugins(register: (ext: PbrExt) => void): void {
    _resetState();
    register(pbrPluginExt);
}
