import type { Mesh } from "./mesh.js";
import { disposeMeshGpu } from "./mesh-dispose.js";
import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import { installMeshRetention, isMeshUnowned, meshSceneEngine, observeMeshMaterial, hasMeshScene } from "../scene/mesh-scene-registry.js";
import { installSceneAdmission } from "../scene/scene-admission.js";
import type { LightBase } from "../light/types.js";
import { removeMeshFromScene } from "../scene/scene-remove.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { registerManagedResourceDisposer } from "../resource/managed-resource-hooks.js";
import { acquireTexture, releaseTexture } from "../resource/texture-references.js";
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
            acquireTexture(texture);
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
        installSceneAdmission((scene, entity) => {
            if (!scene.surface.engine._retainedMeshes?.size) {
                return true;
            }
            if ("_gpu" in entity && "material" in entity) {
                const candidate = entity as Mesh;
                // Force disposal must remain an explicit add error, not a duplicate no-op.
                return !!candidate._disposed || !hasMeshScene(scene, candidate);
            }
            return !("lightType" in entity) || !scene.lights.includes(entity as LightBase);
        });
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
    const textures = [...state.textures.values()];
    state.textures.clear();
    const release = (): void => {
        if (force || isMeshUnowned(mesh)) {
            disposeMeshGpu(mesh);
        }
        for (const texture of textures) {
            releaseTexture(texture);
        }
    };
    if (force) {
        release();
    } else {
        retireGpuResources(state.engine, release);
    }
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
    captureTextures(state, mesh.material);
    removeMeshFromScene(scene, mesh, true);
}

function assertMesh(mesh: Mesh): void {
    if (!mesh || typeof mesh !== "object" || !("_gpu" in mesh) || !("material" in mesh)) {
        throw new Error("Mesh resource retention and detach require a Mesh, not a scene root, light, camera or asset container.");
    }
}
