import { BU } from "./gpu-flags.js";
import type { EngineContext } from "./engine.js";
import { isRenderingContextRegistered } from "./engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Mesh, MeshGPU } from "../mesh/mesh.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import { clearSceneBGLCache, getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { ensureSceneLightState } from "../render/lights-ubo.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { createSkeleton } from "../skeleton/create-skeleton.js";
import type { createMorphTargets } from "../morph/create-morph-targets.js";
import type { Renderable } from "../render/renderable.js";

interface MutableSkeleton {
    boneTexture: GPUTexture;
    jointsBuffer: GPUBuffer;
    weightsBuffer: GPUBuffer;
    joints1Buffer: GPUBuffer | null;
    weights1Buffer: GPUBuffer | null;
}

interface MutableMorphTargets {
    deltasBuffer: GPUBuffer;
    weightsBuffer: GPUBuffer;
}

interface RecoverableRenderTask {
    _sceneUBO: GPUBuffer;
    _sceneBG: GPUBindGroup;
    _lightsUBO: GPUBuffer;
    _opaqueBindings: unknown[];
    _directBindings: unknown[];
    _transparentBindings: unknown[];
    _ob: unknown[];
    _lastVersion: number;
    _sceneUboCacheKey: unknown[];
}

/**
 * Rebuilds the GPU resources of every registered scene after a WebGPU device
 * loss. This whole subtree (mesh geometry, frame-graph tasks, textures,
 * skeletons, morph targets) runs only on the recovery path, so it lives here
 * behind a single lazy `await import()` from the scene recovery adapter.
 * The always-bundled recovery orchestrator therefore carries
 * none of it statically, and a recovery-enabled scene only fetches this chunk
 * if an actual device loss occurs.
 */
export async function rebuildRegisteredScenes(engine: EngineContext): Promise<void> {
    clearSceneBGLCache();
    // Engine-scoped and lazily recreated by the PBR fallback resolver, so it must be cleared once
    // per recovery. Clearing it per scene would orphan the fallback each later scene rebuilt.
    engine._pbrFallbackTex = undefined;
    for (const surface of engine.surfaces) {
        for (const ctx of surface._renderingContexts) {
            if (ctx._kind !== "scene") {
                continue;
            }
            const scene = ctx as SceneContext;
            if (!isRenderingContextRegistered(surface, scene) || scene._z) {
                continue;
            }
            await rebuildSceneGpu(engine, scene);
        }
    }
}

async function rebuildSceneGpu(engine: EngineContext, scene: SceneContext): Promise<void> {
    // The environment and shadow rebuild logic each live in their own module, reached only
    // through these lazy imports so recovery-enabled scenes that use neither carry neither.
    if (scene._envTextures) {
        const { rebuildSceneEnvironment } = await import("../loader-env/environment-recovery.js");
        await runRecoveryStep("rebuilding environment textures", () => rebuildSceneEnvironment(engine, scene));
    }

    await runRecoveryStep("rebuilding material textures", () => rebuildSceneTextures(engine, scene));
    await runRecoveryStep("rebuilding meshes", () => _rebuildMeshes(engine, scene));
    if (scene._z) {
        return;
    }
    if (scene.shadowGenerators.length > 0 || scene.lights.some((light) => light.shadowGenerator)) {
        const { rebuildSceneShadowGenerators } = await import("../shadow/shadow-recovery.js");
        await runRecoveryStep("rebuilding shadows", () => rebuildSceneShadowGenerators(engine, scene));
    }
    if (scene._z) {
        return;
    }

    // Snapshot the rebuild thunks before the renderable list is truncated below. Discovering them
    // here — rather than recording descriptors through a capture seam — keeps the loader paths that
    // build renderables free of any recovery cost, and this whole module is only ever fetched on
    // the recovery path.
    const rebuilds = scene._renderables.filter((r) => !!r._rebuild).map((r) => r._rebuild!);

    scene._renderables.length = scene._uniformUpdaters.length = 0;
    scene._meshDisposables.clear();
    scene._meshAuxDisposables.clear();
    if (scene._lightGpuState) {
        scene._lightGpuState = undefined;
    }

    for (const [build, meshes] of scene._groups) {
        const result = await runRecoveryStep("rebuilding material groups", () => build(scene, meshes));
        if (scene._z) {
            return;
        }
        meshes.r = scene._runtimeBuilds?.base(build, result.rebuildSingle) ?? result.rebuildSingle;
        meshes.o = result.renderables;
        scene._renderables.push(...result.renderables);
        if (result.updater) {
            scene._uniformUpdaters.push(result.updater);
        }
    }
    if (rebuilds.length > 0) {
        scene._renderables.push(...(await runRecoveryStep("rebuilding renderables", () => rebuildRenderables(rebuilds))));
    }
    scene._renderables.sort((a, b) => a.order - b.order);
    scene._renderableVersion++;
    resetFrameGraphTasks(engine, scene);
    scene._frameGraph.build();
}

/**
 * @internal Replay discovered rebuild thunks, preserving their pre-loss relative order.
 *
 * Sequential rather than concurrent: each thunk re-runs its builder, which allocates GPU resources
 * on the replacement device, and the surrounding recovery steps are ordered for the same reason.
 */
export async function rebuildRenderables(rebuilds: readonly NonNullable<Renderable["_rebuild"]>[]): Promise<Renderable[]> {
    const rebuilt: Renderable[] = [];
    for (const rebuild of rebuilds) {
        rebuilt.push(await rebuild());
    }
    return rebuilt;
}

async function runRecoveryStep<T>(description: string, action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Device-lost Scene recovery failed while ${description}: ${message}`, { cause: error });
    }
}

function resetFrameGraphTasks(engine: EngineContext, scene: SceneContext): void {
    for (const task of scene._frameGraph._tasks) {
        if (!("_sceneUBO" in task && "_sceneBG" in task && "_opaqueBindings" in task)) {
            continue;
        }
        const rt = task as unknown as RecoverableRenderTask;
        rt._sceneUBO = createEmptyUniformBuffer(engine, SCENE_UBO_BYTES);
        rt._lightsUBO = ensureSceneLightState(engine, scene)._buffer;
        rt._sceneBG = engine._device.createBindGroup({
            layout: getSceneBindGroupLayout(engine),
            entries: [
                { binding: 0, resource: { buffer: rt._sceneUBO } },
                { binding: 1, resource: { buffer: rt._lightsUBO } },
            ],
        });
        rt._opaqueBindings.length = 0;
        rt._directBindings.length = 0;
        rt._transparentBindings.length = 0;
        rt._ob.length = 0;
        rt._lastVersion = -1;
        rt._sceneUboCacheKey.length = 0;
    }
}

/** @internal Rebuild retained mesh resources after a device loss. */
export async function _rebuildMeshes(engine: EngineContext, scene: SceneContext): Promise<void> {
    let skeletonFactory: typeof createSkeleton | null = null;
    let morphFactory: typeof createMorphTargets | null = null;

    for (const mesh of scene.meshes) {
        if (mesh._cpuPositions && mesh._cpuNormals && mesh._cpuIndices) {
            const recoverShared = mesh._gpu._recoverShared;
            mesh._gpu = recoverShared ? recoverShared(engine, mesh, uploadRetainedMesh) : uploadRetainedMesh(engine, mesh);
        }
        if (mesh.skeleton) {
            skeletonFactory ??= (await import("../skeleton/create-skeleton.js")).createSkeleton;
            const old = mesh.skeleton;
            const rebuilt = skeletonFactory(engine, old.joints, old.weights, old.boneCount, old.boneMatrices, old.joints1, old.weights1);
            Object.assign(old as MutableSkeleton, rebuilt);
        }
        if (mesh.morphTargets) {
            morphFactory ??= (await import("../morph/create-morph-targets.js")).createMorphTargets;
            const old = mesh.morphTargets;
            const rebuilt = morphFactory(
                engine,
                old.targets.map((t) => ({ positions: t.positions, normals: t.normals })),
                mesh._cpuPositions ? mesh._cpuPositions.length / 3 : 0,
                Array.from(old.weights)
            );
            Object.assign(old as MutableMorphTargets, rebuilt);
        }
    }
}

function uploadRetainedMesh(engine: EngineContext, mesh: Mesh): MeshGPU {
    const positions = mesh._cpuPositions!;
    const normals = mesh._cpuNormals!;
    const uvs = mesh._cpuUvs;
    const indices = mesh._cpuGpuIndices ?? mesh._cpuIndices!;
    const device = engine._device;
    let uvBuffer: GPUBuffer;
    if (uvs && uvs.length > 0) {
        uvBuffer = createMappedBuffer(engine, uvs, BU.VERTEX);
    } else {
        uvBuffer = device.createBuffer({ size: (positions.length / 3) * 8, usage: BU.VERTEX, mappedAtCreation: true });
        uvBuffer.unmap();
    }
    return {
        positionBuffer: createMappedBuffer(engine, positions, BU.VERTEX),
        normalBuffer: createMappedBuffer(engine, normals, BU.VERTEX),
        tangentBuffer: mesh._cpuTangents ? createMappedBuffer(engine, mesh._cpuTangents, BU.VERTEX) : null,
        uvBuffer,
        uv2Buffer: mesh._cpuUv2s ? createMappedBuffer(engine, mesh._cpuUv2s, BU.VERTEX) : null,
        colorBuffer: mesh._cpuColors ? createMappedBuffer(engine, mesh._cpuColors, BU.VERTEX) : null,
        hasUv: !!uvs && uvs.length > 0,
        hasUv2: !!mesh._cpuUv2s && mesh._cpuUv2s.length > 0,
        hasTangent: !!mesh._cpuTangents && mesh._cpuTangents.length > 0,
        hasColor: !!mesh._cpuColors && mesh._cpuColors.length > 0,
        indexBuffer: createMappedBuffer(engine, indices, BU.INDEX),
        // Capacity-reserved meshes retain exact active CPU geometry. Recovery intentionally collapses the
        // reservation; the next capacity update may grow it again without exposing padded arrays publicly.
        indexCount: indices.length,
        indexFormat: mesh._cpuIndexFormat ?? mesh._gpu.indexFormat,
    };
}

async function rebuildSceneTextures(engine: EngineContext, scene: SceneContext): Promise<void> {
    const seen = new Set<Texture2D>();
    const visited = new WeakSet<object>();
    const textures: Texture2D[] = [];
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") {
            return;
        }
        const obj = value as Record<string, unknown>;
        if (obj.texture && obj.view && obj.sampler && typeof obj.width === "number" && typeof obj.height === "number") {
            const tex = obj as unknown as Texture2D;
            if (!seen.has(tex)) {
                seen.add(tex);
                textures.push(tex);
            }
            return;
        }
        if (visited.has(value)) {
            return;
        }
        visited.add(value);
        for (const child of Object.values(obj)) {
            visit(child);
        }
    };
    for (const mesh of scene.meshes) {
        visit(mesh.material);
    }
    if (textures.length === 0) {
        return;
    }
    // The per-kind texture rebuild logic lives in its own module, reached only
    // when the scene actually owns material textures.
    const { rebuildTexture2D } = await import("../texture/texture-recovery.js");
    await Promise.all(textures.map((texture) => rebuildTexture2D(engine, texture)));
}
