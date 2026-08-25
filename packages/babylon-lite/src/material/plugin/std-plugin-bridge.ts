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
import { _computeStandardMaterialFeatures, getStandardGroupBuilder } from "../standard/standard-material.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { ShaderFragment, UboSpec } from "../../shader/fragment-types.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import type { MaterialPlugin } from "./material-plugin.js";
import { bindPluginTextures, buildPluginFragment, enabledPlugins, pluginSignature, writePluginUbo } from "./plugin-bridge-shared.js";

const PLUGIN_INDEX_SHIFT = 24;
const PLUGIN_INDEX_MASK = 0x7f;

interface PluginEntry {
    readonly _fragment: ShaderFragment;
    readonly _uboSpec: UboSpec | null;
}

interface MaterialPluginState {
    readonly _plugins: readonly MaterialPlugin[];
    readonly _uboBuffer: GPUBuffer | null;
    readonly _uboSpec: UboSpec | null;
    readonly _dynamic: boolean;
    readonly _engine: EngineContext;
}

let _sigToIndex: Map<string, number> | null = null;
let _indexToEntry: Map<number, PluginEntry> | null = null;
let _materialStates: Map<StandardMaterialProps, MaterialPluginState> | null = null;
let _counter = 0;

function _resetState(): void {
    _sigToIndex = new Map();
    _indexToEntry = new Map();
    _materialStates = new Map();
    _counter = 0;
}

function _indexFor(plugins: readonly MaterialPlugin[]): number {
    const sig = pluginSignature(plugins);
    const map = (_sigToIndex ??= new Map());
    let idx = map.get(sig);
    if (idx === undefined) {
        idx = ++_counter;
        map.set(sig, idx);
        const built = buildPluginFragment(plugins, idx, true);
        (_indexToEntry ??= new Map()).set(idx, { _fragment: built._fragment, _uboSpec: built._stdUboSpec });
    }
    return idx;
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
        const state = _materialStates?.get(mat);
        if (state?._uboBuffer) {
            entries.push({ binding: b++, resource: { buffer: state._uboBuffer } });
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
    const materials = new Set<StandardMaterialProps>();
    for (const m of meshes) {
        const mat = m.material as StandardMaterialProps | null;
        if (mat && !materials.has(mat)) {
            materials.add(mat);
            bakeStdPluginMaterial(mat, engine);
        }
    }
}

/**
 * Bake a Standard material's plugin signature and per-material uniform buffer.
 *
 * Call this after assigning plugins to a Standard material created after
 * {@link registerStdPlugins} has walked the scene, and before its mesh first renders.
 */
export function bakeStdPluginMaterial(mat: StandardMaterialProps | null | undefined, engine: EngineContext): void {
    if (!mat?.plugins?.length || mat._buildGroup !== getStandardGroupBuilder()) {
        return;
    }
    const plugins = mat.plugins;
    const idx = _indexFor(plugins);
    const uboSpec = _indexToEntry?.get(idx)?._uboSpec ?? null;
    let uboBuffer: GPUBuffer | null = null;
    if (uboSpec && uboSpec._totalBytes > 0) {
        const data = new Float32Array(uboSpec._totalBytes / 4);
        writePluginUbo(plugins, data, uboSpec._offsets);
        uboBuffer = createUniformBuffer(engine, data, "plugin-ubo");
    }
    (_materialStates ??= new Map()).set(mat, {
        _plugins: plugins,
        _uboBuffer: uboBuffer,
        _uboSpec: uboSpec,
        _dynamic: enabledPlugins(plugins).some((plugin) => plugin.dynamic === true),
        _engine: engine,
    });
    mat._renderFeatures = { features: _computeStandardMaterialFeatures(mat) | (idx << PLUGIN_INDEX_SHIFT) };
}

let _uboScratch: Float32Array | null = null;

/** Re-upload dynamic Standard plugin UBO values for one engine. */
export function refreshStdPluginUbos(engine: EngineContext): void {
    if (!_materialStates) {
        return;
    }
    for (const state of _materialStates.values()) {
        if (!state._dynamic || state._engine !== engine || !state._uboBuffer || !state._uboSpec) {
            continue;
        }
        const floats = state._uboSpec._totalBytes / 4;
        if (!_uboScratch || _uboScratch.length < floats) {
            _uboScratch = new Float32Array(floats);
        } else {
            _uboScratch.fill(0, 0, floats);
        }
        writePluginUbo(state._plugins, _uboScratch, state._uboSpec._offsets);
        engine._device.queue.writeBuffer(state._uboBuffer, 0, _uboScratch.buffer, 0, state._uboSpec._totalBytes);
    }
}
