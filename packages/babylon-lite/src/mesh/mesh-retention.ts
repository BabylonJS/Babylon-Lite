import type { Mesh } from "./mesh.js";
import { disposeMeshGpu } from "./mesh-dispose.js";
import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import { _notifySceneChange, _runSceneChange } from "../scene/scene-core.js";
import { installMeshRetention, isMeshUnowned, meshSceneEngine, observeMeshMaterial, hasMeshScene } from "../scene/mesh-scene-registry.js";
import { installSceneAdmission } from "../scene/scene-admission.js";
import type { LightBase } from "../light/types.js";
import { removeMeshFromScene } from "../scene/scene-remove.js";
import { _setShadowCasterFilter } from "../frame-graph/shadow-inputs.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { registerManagedResourceDisposer } from "../resource/managed-resource-hooks.js";
import { acquireTexture, releaseTexture } from "../resource/texture-references.js";
import { _textureOwners } from "../resource/texture-owner-state.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { Material } from "../material/material.js";
import { getMaterialTextures } from "../material/material-textures.js";
import { getMaterialSource } from "../material/material-view.js";
import type { MaterialPlugin } from "../material/plugin/material-plugin.js";

/** Explicit ownership of a mesh across inactive scene lifetimes.
 * Release with {@link releaseMeshResources}; engine teardown also revokes it. */
export interface MeshResourceLease {
    readonly mesh: Mesh;
}

interface Retention {
    mesh: Mesh;
    engine: EngineContext;
    leases: Set<MeshResourceLease>;
    textures: Map<GPUTexture, Texture2D>;
}

let retentions: WeakMap<Mesh, Retention> | undefined;
let leases: WeakMap<MeshResourceLease, Retention> | undefined;
let issuedLeases: WeakSet<MeshResourceLease> | undefined;
let disposedEngines: WeakSet<EngineContext> | undefined;
let capturing: WeakSet<Mesh> | undefined;
/** Scenes each mesh was detached from and not since reinserted into. Weak on both sides, so exclusion never extends a
 *  retired mesh's lifetime, yet a caller caster array still holding it keeps it excluded and its destroyed buffers undrawn. */
let detachedFrom: WeakMap<Mesh, WeakSet<SceneContext>> | undefined;
/** Scenes that ever detached a mesh; caster lookups elsewhere return the registered array untouched. */
let detachScenes: WeakSet<SceneContext> | undefined;
/** Per scene and caller caster array, the last filtered array. Reusing it keeps the identity stable across frames,
 *  since shadow hooks rebuild their nested task (and re-render the map) whenever the array identity changes. */
let filteredCasters: WeakMap<SceneContext, WeakMap<readonly Mesh[], readonly Mesh[]>> | undefined;

function isDetached(scene: SceneContext, mesh: Mesh): boolean {
    const scenes = detachedFrom!.get(mesh);
    if (!scenes?.has(scene)) {
        return false;
    }
    // Reinsertion goes through addToScene, which re-registers membership even after the last lease is gone.
    if (hasMeshScene(scene, mesh)) {
        scenes.delete(scene);
        return false;
    }
    return true;
}

// Runs per generator per frame: an unchanged lookup only scans the caller array against the cached result.
function filterShadowCasters(scene: SceneContext, casters: readonly Mesh[]): readonly Mesh[] {
    if (!detachScenes!.has(scene)) {
        return casters;
    }
    let cache = filteredCasters!.get(scene);
    const cached = cache?.get(casters);
    let kept = 0;
    let reusable = cached !== undefined;
    for (const caster of casters) {
        if (!isDetached(scene, caster)) {
            reusable &&= cached![kept] === caster;
            kept++;
        }
    }
    if (kept === casters.length) {
        // Drop any earlier filtered result for this array: it would otherwise keep its former survivors reachable.
        if (cached) {
            cache!.delete(casters);
        }
        return casters;
    }
    if (reusable && kept === cached!.length) {
        return cached!;
    }
    if (!cache) {
        filteredCasters!.set(scene, (cache = new WeakMap()));
    }
    const filtered = casters.filter((caster) => !isDetached(scene, caster));
    cache.set(casters, filtered);
    return filtered;
}

function captureTextures(state: Retention, material: Material): void {
    if (capturing?.has(state.mesh)) {
        throw new Error(`Mesh "${state.mesh.name}" resource retention cannot reenter material texture enumeration.`);
    }
    (capturing ??= new WeakSet()).add(state.mesh);
    try {
        collectTextures(state, material);
    } finally {
        capturing.delete(state.mesh);
    }
}

function collectTextures(state: Retention, material: Material): void {
    // Recovery replaces texture handles in place; re-key before deduplicating acquisitions.
    state.textures = new Map([...state.textures.values()].map((texture) => [texture.texture, texture]));
    const visited = new Set<Material>();
    const found = new Map<GPUTexture, Texture2D>();
    const visit = (current: Material): void => {
        if (current && !visited.has(current)) {
            visited.add(current);
            const textures = [...getMaterialTextures(current)];
            const source = getMaterialSource(current);
            if ("plugins" in source) {
                for (const plugin of (source.plugins as MaterialPlugin[] | undefined) ?? []) {
                    if (plugin.isEnabled !== false) {
                        plugin.getActiveTextures?.(textures);
                    }
                }
            }
            for (const texture of textures) {
                found.set(texture.texture, texture);
            }
            if (current._shadowCasterMaterial) {
                visit(current._shadowCasterMaterial);
            }
        }
    };
    visit(material);
    // Enumerate completely before acquiring: a plugin error must not leave partial ownership.
    for (const [allocation, texture] of found) {
        if (!state.textures.has(allocation)) {
            acquireRetainedTexture(state.engine, texture);
            state.textures.set(allocation, texture);
        }
    }
}

/** Keep a mesh alive until this independent lease is released.
 * Retain before last-scene removal. Does not add a geometry-sharing owner.
 * Scene-local renderables may be rebuilt; owned geometry is reused. */
export function retainMeshResources(engine: EngineContext, mesh: Mesh): MeshResourceLease {
    assertMesh(mesh);
    if (capturing?.has(mesh)) {
        throw new Error(`Mesh "${mesh.name}" resource retention cannot reenter material texture enumeration.`);
    }
    if (mesh._disposed || disposedEngines?.has(engine)) {
        throw new Error(`Mesh "${mesh.name}" cannot be retained: it was disposed.`);
    }
    const owner = meshSceneEngine(mesh);
    let state = retentions?.get(mesh);
    if ((owner && owner !== engine) || (state && state.engine !== engine)) {
        throw new Error(`Mesh "${mesh.name}" cannot be retained by a different engine.`);
    }
    if (!state) {
        retentions ??= new WeakMap();
        leases ??= new WeakMap();
        installMeshRetention(
            (candidate, sceneEngine) => {
                const retention = retentions?.get(candidate);
                if (retention && sceneEngine && retention.engine !== sceneEngine) {
                    throw new Error(`Mesh "${candidate.name}" is retained by a different engine.`);
                }
                return !!retention;
            },
            (candidate, material) => {
                const retention = retentions?.get(candidate);
                if (retention) {
                    captureTextures(retention, material);
                }
            }
        );
        state = { mesh, engine, leases: new Set(), textures: new Map() };
        captureTextures(state, mesh.material);
        retentions.set(mesh, state);
        if (!engine._retainedMeshes) {
            const meshes = (engine._retainedMeshes = new Set());
            registerManagedResourceDisposer(engine, () => {
                (disposedEngines ??= new WeakSet()).add(engine);
                for (const retained of meshes) {
                    const retention = retentions?.get(retained);
                    if (retention) {
                        revoke(retained, retention, true);
                    }
                }
            });
        }
        engine._retainedMeshes.add(mesh);
        installSceneAdmission(engine, (scene, entity) => {
            if ("_gpu" in entity && "material" in entity) {
                const candidate = entity as Mesh;
                // Force disposal must remain an explicit add error, not a duplicate no-op.
                return !!candidate._disposed || !hasMeshScene(scene, candidate);
            }
            return !("lightType" in entity) || !scene.lights.includes(entity as LightBase);
        });
    }
    observeMeshMaterial(mesh);
    const lease: MeshResourceLease = Object.freeze({ mesh });
    state.leases.add(lease);
    leases!.set(lease, state);
    (issuedLeases ??= new WeakSet()).add(lease);
    return lease;
}

function revoke(mesh: Mesh, state: Retention, force: boolean): void {
    for (const lease of state.leases) {
        leases!.delete(lease);
    }
    state.leases.clear();
    retentions!.delete(mesh);
    state.engine._retainedMeshes!.delete(mesh);
    if (!state.engine._retainedMeshes!.size) {
        installSceneAdmission(state.engine, undefined);
    }
    const textures = [...state.textures.values()];
    state.textures.clear();
    const release = (): void => {
        if (force || isMeshUnowned(mesh)) {
            disposeMeshGpu(mesh);
        }
        for (const texture of textures) {
            releaseRetainedTexture(state.engine, texture);
        }
    };
    if (force) {
        release();
    } else {
        retireGpuResources(state.engine, release);
    }
}

/** Device recovery queues each rebuilt texture's pre-loss ownership before its first await (so a url
 *  fetch in flight is covered), replaces handles before scene handlers run, then tops each
 *  replacement's live count up to its queued pending total only after every handler finishes. An
 *  entry matches a wrapper still holding the outgoing handle as well as one holding the replacement.
 *  Retention keeps that total equal to owed pre-loss claims plus live claims, so the top-up adds back exactly what is owed:
 *  a claim acquired in this window is live and also raises the total, and a released claim lowers
 *  the total, dropping a live claim only when nothing is owed. Releasing the replacement while claims
 *  are still owed would destroy it before surviving owners regain them. */
function pendingTextureOwnership(engine: EngineContext, texture: Texture2D): [Texture2D, number, GPUTexture, boolean] | undefined {
    return engine._deviceLostRecovery?._pendingOwnership?.find(([candidate, , outgoing]) => candidate.texture === texture.texture || outgoing === texture.texture);
}

function acquireRetainedTexture(engine: EngineContext, texture: Texture2D): void {
    const pending = pendingTextureOwnership(engine, texture);
    if (pending) {
        pending[1]++;
        pending[3] = true;
    }
    acquireTexture(texture);
}

function releaseRetainedTexture(engine: EngineContext, texture: Texture2D): void {
    const pending = pendingTextureOwnership(engine, texture);
    if (pending) {
        const owed = pending[1] - _textureOwners(texture);
        pending[1]--;
        if (owed > 0) {
            return;
        }
    }
    releaseTexture(texture);
}

/** Release one lease idempotently. Last unowned mesh disposal is GPU-fenced. */
export function releaseMeshResources(lease: MeshResourceLease): void {
    if (!issuedLeases?.has(lease)) {
        throw new Error("Mesh resource leases must be created by retainMeshResources.");
    }
    const state = leases?.get(lease);
    if (!state) {
        return;
    }
    if (capturing?.has(state.mesh)) {
        throw new Error(`Mesh "${state.mesh.name}" resources cannot be released during material texture enumeration.`);
    }
    leases!.delete(lease);
    state.leases.delete(lease);
    if (!state.leases.size) {
        revoke(lease.mesh, state, false);
    }
}

/** Remove exactly one leased mesh from scene rendering and picking membership.
 * Preserves parenting, children, visibility and identity. Reinsert with addToScene.
 * Requires an active lease for this engine; unsupported roots throw before mutation. */
export function detachMeshFromScene(scene: SceneContext, mesh: Mesh): void {
    assertMesh(mesh);
    const state = retentions?.get(mesh);
    if (!state || state.engine !== scene.surface.engine || mesh._disposed) {
        throw new Error(`Mesh "${mesh.name}" must have a live retainMeshResources lease for this engine before detaching.`);
    }
    if (scene._z) {
        throw new Error("Cannot detach a Mesh from a disposed scene.");
    }
    if (!scene.meshes.includes(mesh)) {
        return;
    }
    const detach = (): void => {
        captureTextures(state, mesh.material);
        removeMeshFromScene(scene, mesh, true);
        if (!detachedFrom) {
            detachedFrom = new WeakMap();
            detachScenes = new WeakSet();
            filteredCasters = new WeakMap();
            _setShadowCasterFilter(filterShadowCasters);
        }
        detachScenes!.add(scene);
        let scenes = detachedFrom.get(mesh);
        if (!scenes) {
            detachedFrom.set(mesh, (scenes = new WeakSet()));
        }
        scenes.add(scene);
        // Membership changed, so `onSceneChange` subscribers see the mesh leave; its children stay.
        _notifySceneChange(scene, mesh, "removed");
    };
    if (scene._sceneChanges && !scene._sceneChanges.depth) {
        _runSceneChange(scene, detach);
    } else {
        detach();
    }
}

function assertMesh(mesh: Mesh): void {
    if (!mesh || typeof mesh !== "object" || !("_gpu" in mesh) || !("material" in mesh)) {
        throw new Error("Mesh resource retention and detach require a Mesh, not a scene root, light, camera or asset container.");
    }
}
