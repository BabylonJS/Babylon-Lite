import { BU } from "./gpu-flags.js";
import type { EngineContext } from "./engine.js";
import { isRenderingContextRegistered } from "./engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Mesh, MeshGPU } from "../mesh/mesh.js";
import { createEmptyUniformBuffer, createMappedBuffer } from "../resource/gpu-buffers.js";
import { getSceneBindGroupLayout } from "../render/scene-helpers.js";
import { ensureSceneLightState } from "../render/lights-ubo.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-size.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { createSkeleton } from "../skeleton/create-skeleton.js";
import type { createMorphTargets } from "../morph/create-morph-targets.js";

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
    _opaqueBundles: unknown[];
    _lastVersion: number;
    _su: unknown[];
}

/**
 * Rebuilds the GPU resources of every registered scene after a WebGPU device
 * loss. This whole subtree (mesh geometry, frame-graph tasks, textures,
 * skeletons, morph targets) runs only on the recovery path, so it lives here
 * behind a single lazy `await import()` from device-lost-recovery's
 * `recoverDevice`. The always-bundled recovery orchestrator therefore carries
 * none of it statically, and a recovery-enabled scene only fetches this chunk
 * if an actual device loss occurs.
 */
export async function rebuildRegisteredScenes(engine: EngineContext): Promise<void> {
    for (const surface of engine.surfaces) {
        for (const ctx of surface._renderingContexts) {
            const scene = ctx as SceneContext;
            if (!isRenderingContextRegistered(surface, scene)) {
                continue;
            }
            await rebuildSceneGpu(engine, scene);
        }
    }
}

async function rebuildSceneGpu(engine: EngineContext, scene: SceneContext): Promise<void> {
    await rebuildSceneTextures(engine, scene);
    await _rebuildMeshes(engine, scene);

    scene._renderables.length = 0;
    scene._uniformUpdaters.length = 0;
    scene._meshDisposables.clear();
    scene._meshAuxDisposables.clear();
    if (scene._lightGpuState) {
        scene._lightGpuState = undefined;
    }

    for (const [build, meshes] of scene._groups) {
        const result = await build(scene, meshes);
        scene._renderables.push(...result.renderables);
        if (result.updater) {
            scene._uniformUpdaters.push(result.updater);
        }
    }
    scene._renderables.sort((a, b) => a.order - b.order);
    scene._renderableVersion++;
    resetFrameGraphTasks(engine, scene);
    scene._frameGraph.build();
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
        rt._opaqueBundles.length = 0;
        rt._lastVersion = -1;
        rt._su.length = 0;
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
    const promises: Promise<void>[] = [];
    // The per-kind texture rebuild logic lives in its own module, reached only
    // through this lazy import on the recovery path so this rebuild chunk carries
    // none of it statically.
    const { rebuildTexture2D } = await import("../texture/texture-recovery.js");
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") {
            return;
        }
        const obj = value as Record<string, unknown>;
        if (obj.texture && obj.view && obj.sampler && typeof obj.width === "number" && typeof obj.height === "number") {
            const tex = obj as unknown as Texture2D;
            if (!seen.has(tex)) {
                seen.add(tex);
                promises.push(rebuildTexture2D(engine, tex));
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
    await Promise.all(promises);
}
