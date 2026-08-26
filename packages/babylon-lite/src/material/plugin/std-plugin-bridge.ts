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
 *     avoids an `_writeUbo` hook or extra plugin UBO loop in the renderable; the
 *     generic bind hook only carries the owning scene for lifetime-safe lookup.
 */

import type { EngineContext } from "../../engine/engine.js";
import { retireGpuResources } from "../../engine/gpu-resource-retirement.js";
import type { StdExt } from "../standard/standard-flags.js";
import type { StandardMaterialProps } from "../standard/standard-material.js";
import { _computeStandardMaterialFeatures, getStandardGroupBuilder } from "../standard/standard-material.js";
import { getMaterialSource } from "../material-view.js";
import type { SceneContext } from "../../scene/scene.js";
import { enqueueMaterialSwap } from "../../scene/mesh-scene-registry.js";
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

interface ScenePluginState {
    readonly _materials: Map<StandardMaterialProps, MaterialPluginState>;
    readonly _refresh: (deltaMs: number) => void;
}

let _sigToIndex: Map<string, number> | null = null;
let _indexToEntry: Map<number, PluginEntry> | null = null;
let _sceneStates: WeakMap<SceneContext, ScenePluginState> | null = null;
let _counter = 0;

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

function _releaseMaterialState(scene: SceneContext, state: MaterialPluginState): void {
    if (!state._uboBuffer) {
        return;
    }
    if (scene._z || !scene._built) {
        state._uboBuffer.destroy();
    } else {
        const buffer = state._uboBuffer;
        retireGpuResources(state._engine, () => buffer.destroy());
    }
}

function _clearSceneMaterials(scene: SceneContext, state: ScenePluginState): void {
    for (const materialState of state._materials.values()) {
        _releaseMaterialState(scene, materialState);
    }
    state._materials.clear();
}

function _queueBindingRebuild(scene: SceneContext, mat: StandardMaterialProps): void {
    if (!scene._built) {
        return;
    }
    for (const mesh of scene.meshes) {
        if (mesh.material && getMaterialSource(mesh.material) === mat) {
            enqueueMaterialSwap(scene, mesh);
        }
    }
}

function _sceneState(scene: SceneContext): ScenePluginState {
    const states = (_sceneStates ??= new WeakMap());
    let state = states.get(scene);
    if (!state) {
        const created: ScenePluginState = {
            _materials: new Map(),
            _refresh: () => refreshStdPluginUbos(scene),
        };
        states.set(scene, created);
        scene._disposables.push(() => {
            _clearSceneMaterials(scene, created);
            states.delete(scene);
        });
        state = created;
    }
    return state;
}

const stdPluginExt: StdExt = {
    _id: "plugin",
    _phase: "mesh",
    _feature: PLUGIN_INDEX_MASK << PLUGIN_INDEX_SHIFT,
    _frag(features: number): ShaderFragment {
        const idx = (features >>> PLUGIN_INDEX_SHIFT) & PLUGIN_INDEX_MASK;
        return _indexToEntry?.get(idx)?._fragment ?? { _id: "plugin-0" };
    },
    _bind(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number, _mesh, scene): number {
        const source = getMaterialSource(mat) as StandardMaterialProps;
        const plugins = source.plugins;
        if (!plugins?.length) {
            return b;
        }
        // The self-managed UBO is declared first in the plugin fragment's
        // bindings (before any textures), so it must be bound first here too.
        const state = scene ? _sceneStates?.get(scene)?._materials.get(source) : undefined;
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
 *  `scene.meshes` may contain non-Standard (e.g. PBR) materials — those are skipped via
 *  the `_buildGroup` discriminator so their `_renderFeatures` is left untouched
 *  for the PBR build's own `detect`-based feature computation. */
export function registerStdPlugins(scene: SceneContext, register: (ext: StdExt) => void): (deltaMs: number) => void {
    register(stdPluginExt);
    const state = _sceneState(scene);
    const materials = new Set<StandardMaterialProps>();
    for (const m of scene.meshes) {
        const mat = m.material as StandardMaterialProps | null;
        if (mat?._buildGroup === getStandardGroupBuilder()) {
            materials.add(mat);
        }
    }
    for (const [mat, materialState] of state._materials) {
        if (!materials.has(mat)) {
            state._materials.delete(mat);
            _releaseMaterialState(scene, materialState);
        }
    }
    for (const mat of materials) {
        if (mat.plugins?.length || state._materials.has(mat)) {
            bakeStdPluginMaterial(mat, scene);
        }
    }
    return state._refresh;
}

/**
 * Bake a Standard material's plugin signature and per-material uniform buffer.
 *
 * Call this after assigning plugins to a Standard material created after
 * {@link registerStdPlugins} has walked the scene, and before its mesh first renders.
 */
export function bakeStdPluginMaterial(mat: StandardMaterialProps | null | undefined, scene: SceneContext): void {
    if (!mat || mat._buildGroup !== getStandardGroupBuilder()) {
        return;
    }
    const existingSceneState = _sceneStates?.get(scene);
    const old = existingSceneState?._materials.get(mat);
    if (!mat.plugins?.length) {
        if (old) {
            existingSceneState!._materials.delete(mat);
            _releaseMaterialState(scene, old);
            mat._renderFeatures = undefined;
            _queueBindingRebuild(scene, mat);
        }
        return;
    }
    const sceneState = existingSceneState ?? _sceneState(scene);
    const plugins = mat.plugins;
    const idx = _indexFor(plugins);
    const uboSpec = _indexToEntry?.get(idx)?._uboSpec ?? null;
    let uboBuffer: GPUBuffer | null = null;
    if (uboSpec && uboSpec._totalBytes > 0) {
        const data = new Float32Array(uboSpec._totalBytes / 4);
        writePluginUbo(plugins, data, uboSpec._offsets);
        uboBuffer = createUniformBuffer(scene.surface.engine, data, "plugin-ubo");
    }
    const state: MaterialPluginState = {
        _plugins: plugins,
        _uboBuffer: uboBuffer,
        _uboSpec: uboSpec,
        _dynamic: enabledPlugins(plugins).some((plugin) => plugin.dynamic === true),
        _engine: scene.surface.engine,
    };
    if (old) {
        mat._renderFeatures = undefined;
        _releaseMaterialState(scene, old);
    }
    sceneState._materials.set(mat, state);
    mat._renderFeatures = { features: _computeStandardMaterialFeatures(mat) | (idx << PLUGIN_INDEX_SHIFT) };
    _queueBindingRebuild(scene, mat);
}

let _uboScratch: Float32Array | null = null;

/** Re-upload dynamic Standard plugin UBO values for one scene. */
export function refreshStdPluginUbos(scene: SceneContext): void {
    const sceneState = _sceneStates?.get(scene);
    if (!sceneState) {
        return;
    }
    for (const state of sceneState._materials.values()) {
        if (!state._dynamic || !state._uboBuffer || !state._uboSpec) {
            continue;
        }
        const floats = state._uboSpec._totalBytes / 4;
        if (!_uboScratch || _uboScratch.length < floats) {
            _uboScratch = new Float32Array(floats);
        } else {
            _uboScratch.fill(0, 0, floats);
        }
        writePluginUbo(state._plugins, _uboScratch, state._uboSpec._offsets);
        state._engine._device.queue.writeBuffer(state._uboBuffer, 0, _uboScratch.buffer, 0, state._uboSpec._totalBytes);
    }
}
