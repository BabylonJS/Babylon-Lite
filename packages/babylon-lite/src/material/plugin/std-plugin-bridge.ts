/**
 * Standard material-plugin bridge (statically imported only from the opt-in
 * `enableMaterialPlugins(scene)` entry point — never part of the always-fetched
 * graph). Turns `MaterialPlugin[]` into a single `StdExt` registered through
 * `_registerStdExt`.
 *
 * Standard materials have no per-ext `detect` hook and a fixed-layout material
 * UBO, so this bridge:
 *   - pre-bakes a per-signature index into each plugin material's cached
 *     `_renderFeatures.features` (bits 24..30) so the feature/pipeline caches
 *     rebuild on any plugin change, and
 *   - delivers plugin uniforms through a SELF-MANAGED uniform buffer declared as
 *     a fragment binding and bound via the pre-existing `StdExt._bind` loop. This
 *     keeps every shared standard-material module byte-identical to a plugin-free
 *     build (no `_writeUbo` hook, no extra UBO loop in the renderable).
 */

import type { EngineContext } from "../../engine/engine.js";
import type { StdExt } from "../standard/standard-flags.js";
import type { StandardMaterialProps } from "../standard/standard-material.js";
import { _computeStandardMaterialFeatures, standardGroupBuilder } from "../standard/standard-material.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import type { MaterialPlugin } from "./material-plugin.js";
import { bindPluginTextures, buildPluginFragment, enabledPlugins, pluginSignature, writePluginUbo } from "./plugin-bridge-shared.js";

const PLUGIN_INDEX_SHIFT = 24;
const PLUGIN_INDEX_MASK = 0x7f;

interface PluginEntry {
    readonly _plugins: readonly MaterialPlugin[];
    readonly _fragment: ShaderFragment;
    /** Self-managed plugin uniform buffer, or null when the plugins declare no uniforms. */
    readonly _uboBuffer: GPUBuffer | null;
}

let _sigToIndex: Map<string, number> | null = null;
let _indexToEntry: Map<number, PluginEntry> | null = null;
let _counter = 0;

function _resetState(): void {
    _sigToIndex = new Map();
    _indexToEntry = new Map();
    _counter = 0;
}

function _indexFor(plugins: readonly MaterialPlugin[], engine: EngineContext): number {
    const sig = pluginSignature(plugins);
    const map = (_sigToIndex ??= new Map());
    let idx = map.get(sig);
    if (idx === undefined) {
        idx = ++_counter;
        map.set(sig, idx);
        const built = buildPluginFragment(plugins, idx, true);
        // Build the self-managed plugin UBO once per signature. Uniform values
        // come from the plugins themselves (constant for a given signature), so
        // the buffer is filled at registration time and shared by every material
        // carrying that signature.
        let uboBuffer: GPUBuffer | null = null;
        if (built._stdUboSpec && built._stdUboSpec._totalBytes > 0) {
            const data = new Float32Array(built._stdUboSpec._totalBytes / 4);
            writePluginUbo(plugins, data, built._stdUboSpec._offsets);
            uboBuffer = createUniformBuffer(engine, data, "plugin-ubo");
        }
        (_indexToEntry ??= new Map()).set(idx, { _plugins: plugins, _fragment: built._fragment, _uboBuffer: uboBuffer });
    }
    return idx;
}

function _entryFor(plugins: readonly MaterialPlugin[]): PluginEntry | undefined {
    const idx = _sigToIndex?.get(pluginSignature(plugins));
    return idx ? _indexToEntry?.get(idx) : undefined;
}

const stdPluginExt: StdExt = {
    _id: "plugin",
    _phase: "mesh",
    _feature: PLUGIN_INDEX_MASK << PLUGIN_INDEX_SHIFT,
    _frag(features: number): ShaderFragment {
        const idx = (features >>> PLUGIN_INDEX_SHIFT) & PLUGIN_INDEX_MASK;
        return _indexToEntry?.get(idx)?._fragment ?? { _id: "plugin-0" };
    },
    _bind(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number): number {
        const plugins = (mat as StandardMaterialProps & { plugins?: MaterialPlugin[] }).plugins;
        if (!plugins?.length) {
            return b;
        }
        // The self-managed UBO is declared first in the plugin fragment's
        // bindings (before any textures), so it must be bound first here too.
        const entry = _entryFor(plugins);
        if (entry?._uboBuffer) {
            entries.push({ binding: b++, resource: { buffer: entry._uboBuffer } });
        }
        return bindPluginTextures(plugins, entries, b);
    },
    _textures(mat: StandardMaterialProps, out): void {
        const plugins = (mat as StandardMaterialProps & { plugins?: MaterialPlugin[] }).plugins;
        if (!plugins?.length) {
            return;
        }
        for (const p of enabledPlugins(plugins)) {
            p.getActiveTextures?.(out);
        }
    },
};

/** Register the Standard plugin bridge extension and pre-bake the signature bits
 *  into each Standard plugin material's cached feature set. Called from
 *  `enableMaterialPlugins` only.
 *
 *  `meshes` may contain non-Standard (e.g. PBR) materials — those are skipped via
 *  the `_buildGroup` discriminator so their `_renderFeatures` is left untouched
 *  for the PBR build's own `detect`-based feature computation. */
export function registerStdPlugins(meshes: readonly Mesh[], engine: EngineContext, register: (ext: StdExt) => void): void {
    _resetState();
    register(stdPluginExt);
    for (const m of meshes) {
        const mat = m.material as (StandardMaterialProps & { plugins?: MaterialPlugin[]; _renderFeatures?: { features: number }; _buildGroup?: unknown }) | null;
        if (mat?.plugins?.length && mat._buildGroup === standardGroupBuilder) {
            const idx = _indexFor(mat.plugins, engine);
            mat._renderFeatures = { features: _computeStandardMaterialFeatures(mat) | (idx << PLUGIN_INDEX_SHIFT) };
        }
    }
}
