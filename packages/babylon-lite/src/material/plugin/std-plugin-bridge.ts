/**
 * Standard material-plugin bridge (statically imported only from the opt-in
 * `enableMaterialPlugins(scene)` entry point — never part of the always-fetched
 * graph). Turns `MaterialPlugin[]` into a single `StdExt` registered through
 * `_registerStdExt`.
 *
 * Standard materials have a fixed-layout material UBO, so this bridge:
 *   - pre-bakes a stable per-signature index into Material._pi, separately from
 *     the native feature bits, and contributes only a plugin-presence flag, and
 *   - delivers plugin uniforms through a SELF-MANAGED uniform buffer declared as
 *     a fragment binding and bound via the pre-existing `StdExt._bind` loop. This
 *     avoids an `_writeUbo` hook or extra plugin UBO loop in the renderable; the
 *     generic bind hook only carries the owning scene for lifetime-safe lookup.
 */

import { retireGpuResources } from "../../engine/gpu-resource-retirement.js";
import type { StdExt } from "../standard/standard-flags.js";
import { _installStdMaterialVariantKey } from "../standard/standard-flags.js";
import type { StandardMaterialProps } from "../standard/standard-material.js";
import { _computeStandardMaterialFeatures } from "../standard/standard-material-features.js";
import { getStandardGroupBuilder } from "../standard/standard-group-builder.js";
import { getMaterialSource } from "../material-view.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import { enqueueMaterialSwap } from "../../scene/mesh-scene-registry.js";
import type { ShaderFragment, UboSpec } from "../../shader/fragment-types.js";
import { createUniformBuffer } from "../../resource/uniform-buffer.js";
import type { MaterialPlugin } from "./material-plugin.js";
import { bindPluginTextures, buildPluginFragment, collectPluginTextures, enabledPlugins, pluginSignature, writePluginUbo } from "./plugin-bridge-shared.js";

const HAS_STD_PLUGINS = 1 << 25;

interface PluginEntry {
    readonly _fragment: ShaderFragment;
    readonly _uboSpec: UboSpec | null;
}

interface MaterialPluginState {
    readonly _plugins: readonly MaterialPlugin[];
    _uboBuffer: GPUBuffer | null;
    readonly _uboSpec: UboSpec | null;
    readonly _dynamic: boolean;
    _bindings: number;
    _auxBindings: number;
    _owners?: WeakSet<(() => void)[]>;
}

interface ScenePluginState {
    readonly _materials: Map<StandardMaterialProps, MaterialPluginState>;
    readonly _users: Map<StandardMaterialProps, number>;
    readonly _meshMaterials: WeakMap<Mesh, StandardMaterialProps>;
    readonly _refresh: (deltaMs: number) => void;
}

let _sigToIndex: Map<string, number> | null = null;
let _indexToEntry: PluginEntry[] | null = null;
let _sceneStates: WeakMap<SceneContext, ScenePluginState> | null = null;
let _counter = 0;

function _indexFor(plugins: readonly MaterialPlugin[]): number {
    const sig = pluginSignature(plugins);
    const map = (_sigToIndex ??= new Map());
    let idx = map.get(sig);
    if (idx === undefined) {
        idx = _counter + 1;
        const built = buildPluginFragment(plugins, idx, true);
        (_indexToEntry ??= [])[idx] = { _fragment: built._fragment, _uboSpec: built._stdUboSpec };
        map.set(sig, idx);
        _counter = idx;
    }
    return idx;
}

function _releaseMaterialState(scene: SceneContext, state: MaterialPluginState): void {
    if (state._bindings || !state._uboBuffer) {
        return;
    }
    const buffer = state._uboBuffer;
    state._uboBuffer = null;
    if (scene._z || !scene._built) {
        buffer.destroy();
    } else {
        retireGpuResources(scene.surface.engine, () => buffer.destroy());
    }
}

function _releaseMaterialStateAfterBindings(scene: SceneContext, mat: StandardMaterialProps, state: MaterialPluginState): void {
    if (state._bindings || !state._uboBuffer || !scene._built) {
        _releaseMaterialState(scene, state);
        return;
    }
    let remaining = 0;
    for (const mesh of scene.meshes) {
        if (mesh.material && getMaterialSource(mesh.material) === mat) {
            const disposers = scene._runtimeBuilds?.pendingDisposers(mesh) ?? scene._meshDisposables.get(mesh);
            if (disposers) {
                remaining++;
                let completed = false;
                disposers.push(() => {
                    if (completed) {
                        return;
                    }
                    completed = true;
                    if (--remaining === 0) {
                        _releaseMaterialState(scene, state);
                    }
                });
            }
        }
    }
    if (remaining === 0) {
        _releaseMaterialState(scene, state);
    }
}

function _clearSceneMaterials(scene: SceneContext, state: ScenePluginState): void {
    for (const materialState of state._materials.values()) {
        _releaseMaterialState(scene, materialState);
    }
    state._materials.clear();
    state._users.clear();
}

function _dropUnusedState(scene: SceneContext, material: StandardMaterialProps, state: MaterialPluginState): void {
    const sceneState = _sceneStates?.get(scene);
    if (!sceneState) {
        _releaseMaterialState(scene, state);
        return;
    }
    const current = sceneState._materials.get(material);
    if (current === state) {
        if (sceneState._users.has(material) || state._auxBindings) {
            return;
        }
        sceneState._materials.delete(material);
    }
    _releaseMaterialState(scene, state);
}

function _trackMeshUsage(scene: SceneContext, state: ScenePluginState, mesh: Mesh, material: Mesh["material"] | undefined, bake: boolean): void {
    const source = material ? (getMaterialSource(material) as StandardMaterialProps) : undefined;
    const next = source?._buildGroup === getStandardGroupBuilder() ? source : undefined;
    const previous = state._meshMaterials.get(mesh);
    if (previous === next) {
        return;
    }
    if (previous) {
        state._meshMaterials.delete(mesh);
        const remaining = state._users.get(previous)! - 1;
        if (remaining) {
            state._users.set(previous, remaining);
        } else {
            state._users.delete(previous);
        }
        const old = state._materials.get(previous);
        if (old) {
            _dropUnusedState(scene, previous, old);
        }
    }
    if (next) {
        state._meshMaterials.set(mesh, next);
        state._users.set(next, (state._users.get(next) ?? 0) + 1);
        if (bake && next.plugins?.length && !state._materials.has(next)) {
            bakeStdPluginMaterial(next, scene);
        }
    }
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
            _users: new Map(),
            _meshMaterials: new WeakMap(),
            _refresh: () => refreshStdPluginUbos(scene),
        };
        states.set(scene, created);
        for (const mesh of scene.meshes) {
            _trackMeshUsage(scene, created, mesh, mesh.material, false);
        }
        const previous = scene._meshMaterialChange;
        const changed: NonNullable<SceneContext["_meshMaterialChange"]> = (mesh, material) => {
            previous?.(mesh, material);
            if (!scene._z) {
                _trackMeshUsage(scene, created, mesh, material, true);
            }
        };
        scene._meshMaterialChange = changed;
        scene._disposables.push(() => {
            _clearSceneMaterials(scene, created);
            states.delete(scene);
            if (scene._meshMaterialChange === changed) {
                scene._meshMaterialChange = previous;
            }
        });
        state = created;
    }
    return state;
}

const stdPluginExt: StdExt = {
    _id: "plugin",
    _phase: "mesh",
    _feature: HAS_STD_PLUGINS,
    _meshFeatures: (_meshFeatures, mat) => (mat?._pi ? HAS_STD_PLUGINS : 0),
    _frag(_features, _meshFeatures, mat): ShaderFragment {
        const fragment = mat?._pi ? _indexToEntry?.[mat._pi]?._fragment : undefined;
        if (!fragment) {
            throw new Error("Standard material plugin signature is not registered.");
        }
        return fragment;
    },
    _bind(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number, _mesh, scene, disposers, auxiliary): number {
        const source = getMaterialSource(mat) as StandardMaterialProps;
        if (!source.plugins?.length) {
            return b;
        }
        // The self-managed UBO is declared first in the plugin fragment's
        // bindings (before any textures), so it must be bound first here too.
        if (!scene) {
            throw new Error("Standard material plugins require an owning scene.");
        }
        const sceneState = _sceneState(scene);
        let state = sceneState._materials.get(source);
        if (!state) {
            if (!disposers && !sceneState._users.has(source)) {
                throw new Error("Standard plugin material requires a scene mesh or a binding owner.");
            }
            state = _createMaterialState(source._preparedPlugins!, source._pi ?? 0, scene);
            sceneState._materials.set(source, state);
        }
        if (disposers && !state._owners?.has(disposers)) {
            (state._owners ??= new WeakSet()).add(disposers);
            state._bindings++;
            if (auxiliary) {
                state._auxBindings++;
            }
            const owned = state;
            let released = false;
            disposers.push(() => {
                if (released) {
                    return;
                }
                released = true;
                owned._bindings--;
                if (auxiliary) {
                    owned._auxBindings--;
                }
                _dropUnusedState(scene, source, owned);
            });
        }
        if (state._uboBuffer) {
            entries.push({ binding: b++, resource: { buffer: state._uboBuffer } });
        }
        return bindPluginTextures(state._plugins, entries, b);
    },
    _textures(mat: StandardMaterialProps, out): void {
        const plugins = mat._preparedPlugins;
        if (!plugins?.length) {
            return;
        }
        collectPluginTextures(plugins, out);
    },
};

/** Register the Standard plugin bridge extension and pre-bake a separate signature
 *  identity for each Standard plugin material. Called from
 *  `enableMaterialPlugins` only.
 *
 *  `scene.meshes` may contain non-Standard (e.g. PBR) materials — those are skipped via
 *  the `_buildGroup` discriminator so their `_renderFeatures` is left untouched
 *  for the PBR build's own `detect`-based feature computation. */
export function registerStdPlugins(scene: SceneContext, register: (ext: StdExt) => void): (deltaMs: number) => void {
    const refresh = registerStdPluginBridge(scene, register);
    const state = _sceneState(scene);
    for (const [mat, materialState] of state._materials) {
        _dropUnusedState(scene, mat, materialState);
    }
    for (const mat of state._users.keys()) {
        if (mat.plugins?.length || state._materials.has(mat)) {
            bakeStdPluginMaterial(mat, scene);
        }
    }
    return refresh;
}

/** Register the Standard bridge and obtain this scene's refresh callback without
 * walking or rebaking its materials. Runtime reconciliation uses this before
 * targeting one changed material. */
export function registerStdPluginBridge(scene: SceneContext, register: (ext: StdExt) => void): (deltaMs: number) => void {
    _installStdMaterialVariantKey((mat) => (mat._pi ? `:p${mat._pi}` : ""));
    register(stdPluginExt);
    return _sceneState(scene)._refresh;
}

/**
 * Bake a Standard material's plugin signature and prepare its uniforms.
 * Unattached materials defer buffer allocation until a scene mesh or binding owns it.
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
        const prepared = !!mat._pi;
        mat._preparedPlugins = undefined;
        mat._pi = 0;
        if (old) {
            existingSceneState!._materials.delete(mat);
            _releaseMaterialStateAfterBindings(scene, mat, old);
        }
        if (old || prepared) {
            mat._renderFeatures = undefined;
            _queueBindingRebuild(scene, mat);
        }
        return;
    }
    const sceneState = existingSceneState ?? _sceneState(scene);
    const plugins = mat.plugins;
    const preparedPlugins = enabledPlugins(plugins);
    const idx = _indexFor(plugins);
    const features = { features: _computeStandardMaterialFeatures(mat) };
    const state = sceneState._users.has(mat) ? _createMaterialState(preparedPlugins, idx, scene) : undefined;
    mat._preparedPlugins = preparedPlugins;
    mat._pi = idx;
    mat._renderFeatures = features;
    if (state) {
        sceneState._materials.set(mat, state);
    } else {
        sceneState._materials.delete(mat);
    }
    if (old) {
        _releaseMaterialStateAfterBindings(scene, mat, old);
    }
    _queueBindingRebuild(scene, mat);
}

function _createMaterialState(preparedPlugins: readonly MaterialPlugin[], index: number, scene: SceneContext): MaterialPluginState {
    const entry = _indexToEntry?.[index];
    if (!entry) {
        throw new Error("Standard material plugin signature is not registered.");
    }
    const uboSpec = entry._uboSpec;
    const dynamic = preparedPlugins.some((plugin) => plugin.dynamic === true);
    let uboBuffer: GPUBuffer | null = null;
    if (uboSpec && uboSpec._totalBytes > 0) {
        const data = new Float32Array(uboSpec._totalBytes / 4);
        writePluginUbo(preparedPlugins, data, uboSpec._offsets);
        uboBuffer = createUniformBuffer(scene.surface.engine, data, "plugin-ubo");
    }
    return {
        _plugins: preparedPlugins,
        _uboBuffer: uboBuffer,
        _uboSpec: uboSpec,
        _dynamic: dynamic,
        _bindings: 0,
        _auxBindings: 0,
    };
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
        scene.surface.engine._device.queue.writeBuffer(state._uboBuffer, 0, _uboScratch.buffer, 0, state._uboSpec._totalBytes);
    }
}
