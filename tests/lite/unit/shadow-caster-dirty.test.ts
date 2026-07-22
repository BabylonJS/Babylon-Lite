import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { AnimationGroup } from "../../../packages/babylon-lite/src/animation/animation-group";
import type { AnimationManager } from "../../../packages/babylon-lite/src/animation/animation-manager";
import { createAnimationManager, updateAnimationManager } from "../../../packages/babylon-lite/src/animation/animation-manager";
import {
    PATH_TRANSLATION,
    PATH_WEIGHTS,
    type AnimationClip,
    type MorphBinding,
    type MorphTargetData,
    type NodeRest,
    type SkeletonBinding,
    type SkeletonData,
} from "../../../packages/babylon-lite/src/animation/types";
import { enableAnimationBlending } from "../../../packages/babylon-lite/src/animation/weighted-gltf-mixer";
import { _installDeformationChangeNotifier } from "../../../packages/babylon-lite/src/animation/deformation-change-hooks";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import { updateMeshGeometry } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { setMorphTargetWeights } from "../../../packages/babylon-lite/src/morph/create-morph-targets";
import { setThinInstanceColor, setThinInstanceDrawCount, setThinInstanceMatrix, type ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { renderPcfShadowMap, type PcfLightMatrix, type PcfTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";
import { createAnimationController } from "../../../packages/babylon-lite/src/skeleton/skeleton-updater";
import { writeBoneTextures } from "../../../packages/babylon-lite/src/skeleton/skeleton-pose";
import { updateSkeletonBoneMatrices } from "../../../packages/babylon-lite/src/skeleton/update-skeleton-bone-matrices";

function identity(): Mat4 {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as Mat4;
}

function makeThinInstances(): ThinInstanceData {
    const matrices = new Float32Array(32);
    matrices.set(identity(), 0);
    matrices.set(identity(), 16);
    return {
        matrices,
        count: 1,
        _capacity: 2,
        _version: 1,
        _gpuBuffer: { size: 2 * 64 } as GPUBuffer,
        _gpuBufferStorage: false,
        _gpuVersion: 1,
        _dirtyMin: 0,
        _dirtyMax: 2,
        _colorVersion: 0,
        _colorDirtyMin: 0,
        _colorDirtyMax: 0,
        _colorGpuBuffer: null,
        _colorGpuBufferStorage: false,
        _colorGpuVersion: 0,
        _gpuCullingEnabled: false,
    };
}

function makeNode(): NodeRest {
    return {
        parentIdx: -1,
        tx: 0,
        ty: 0,
        tz: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        rw: 1,
        sx: 1,
        sy: 1,
        sz: 1,
    };
}

function makeSkeletonBinding(onShadowCasterChanged: () => void): SkeletonBinding {
    const boneMatrices = new Float32Array(16);
    const runtimeSkeleton = {
        boneTexture: {} as GPUTexture,
        boneCount: 1,
        boneMatrices,
        _onShadowCasterChanged: onShadowCasterChanged,
    } as unknown as SkeletonData;
    return {
        jointNodes: [0],
        inverseBindMatrices: new Float32Array(identity()),
        invMeshWorld: identity(),
        boneTexture: runtimeSkeleton.boneTexture,
        boneCount: 1,
        boneMatrices,
        runtimeSkeleton,
    };
}

function makeMorphTargetData(onShadowCasterChanged: () => void): MorphTargetData {
    return {
        count: 1,
        weights: new Float32Array(1),
        weightsBuffer: {} as GPUBuffer,
        targets: [{ positions: new Float32Array([1, 0, 0]), normals: null }],
        _onShadowCasterChanged: onShadowCasterChanged,
    } as unknown as MorphTargetData;
}

function makeAnimationClip(includeMorph = false): AnimationClip {
    return {
        name: "deform",
        duration: 1,
        channels: [{ samplerIdx: 0, nodeIdx: 0, path: PATH_TRANSLATION }, ...(includeMorph ? [{ samplerIdx: 1, nodeIdx: 0, path: PATH_WEIGHTS } as const] : [])],
        samplers: [
            {
                input: new Float32Array([0, 1]),
                output: new Float32Array([0, 0, 0, 1, 0, 0]),
                interpolation: 0,
            },
            ...(includeMorph
                ? [
                      {
                          input: new Float32Array([0, 1]),
                          output: new Float32Array([0, 1]),
                          interpolation: 0 as const,
                      },
                  ]
                : []),
        ],
    };
}

describe("shadow caster dirty tracking", () => {
    beforeEach(() => {
        _installDeformationChangeNotifier((data, source, poseToken) => data?._onShadowCasterChanged?.(source, poseToken));
    });

    it("redraws a cached shadow map after count-only and same-buffer geometry updates", () => {
        const writeBuffer = vi.fn();
        const engine = {
            _device: { queue: { writeBuffer } },
            useFloatingOrigin: false,
        } as unknown as EngineContext;
        const gpu = {
            positionBuffer: { size: 9 * 4 } as GPUBuffer,
            normalBuffer: {} as GPUBuffer,
            uvBuffer: {} as GPUBuffer,
            indexBuffer: {} as GPUBuffer,
            indexCount: 3,
            indexFormat: "uint32",
            hasUv: false,
            hasUv2: false,
            hasTangent: false,
            hasColor: false,
        } satisfies MeshGPU;
        const mesh = {
            name: "caster",
            children: [],
            _gpu: gpu,
            _cpuPositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            _cpuNormals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
            _cpuIndices: new Uint32Array([0, 1, 2]),
            thinInstances: makeThinInstances(),
        } as unknown as Mesh;
        initMeshTransform(mesh);
        const execute = vi.fn(() => 1);
        const task = { record: vi.fn(), execute, dispose: vi.fn() } as unknown as PcfTaskState["_task"];
        const camera = {
            fov: 1,
            nearPlane: 0.1,
            farPlane: 10,
            children: [],
            worldMatrix: identity(),
            worldMatrixVersion: 1,
            _viewCache: new Float32Array(16),
            _projCache: new Float32Array(16),
            _vpCache: new Float32Array(16),
        } as Camera;
        const state = {
            _task: task,
            _camera: camera,
            _cameraVersion: 0,
            _lastCasterVersion: -1,
            _lastLightVersion: -1,
            _lastFoVersion: -1,
            _shadowUboData: new Float32Array(24),
            _casterMeshes: [mesh],
            _scene: { camera: null } as unknown as SceneContext,
        } satisfies PcfTaskState;
        const shadowGenerator = {
            _light: { lightType: "directional", worldMatrixVersion: 1 },
            _lightMatrix: new Float32Array(16),
            _depthValues: new Float32Array(4),
            _shadowsInfo: new Float32Array(4),
            _shadowUBO: {} as GPUBuffer,
            _version: 0,
            _config: { _mapSize: 1024, _bias: 0, _forceRefreshEveryFrame: false },
        } as unknown as ShadowGenerator;
        const matrix: PcfLightMatrix = {
            _view: new Float32Array(identity()),
            _viewProj: new Float32Array(identity()),
            _near: 0.1,
            _far: 10,
        };
        const computeLightMatrix = vi.fn(() => matrix);

        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(1);
        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(0);

        const unrelated = {
            name: "unrelated",
            children: [],
            _gpu: { ...gpu },
            _cpuPositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            _cpuNormals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
            _cpuIndices: new Uint32Array([0, 1, 2]),
        } as unknown as Mesh;
        initMeshTransform(unrelated);
        updateMeshGeometry(engine, unrelated, new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 2, 1]));
        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(0);

        setThinInstanceDrawCount(mesh, 2);
        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(1);
        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(0);

        const moved = new Float32Array(identity());
        moved[12] = 2;
        setThinInstanceMatrix(mesh, 0, moved as unknown as Mat4);
        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(1);
        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(0);

        mesh.thinInstances!.colors = new Float32Array(8);
        setThinInstanceColor(mesh, 0, 1, 0, 0, 1);
        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(1);
        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(0);

        updateMeshGeometry(engine, mesh, new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 2, 1]));
        expect(renderPcfShadowMap(engine, shadowGenerator, state, computeLightMatrix)).toBe(1);
        expect(execute).toHaveBeenCalledTimes(5);
    });

    it("notifies the opt-in shadow hook from the normal skeleton and morph updater", () => {
        const skeletonChanged = vi.fn();
        const morphChanged = vi.fn();
        const skeletonBinding = makeSkeletonBinding(skeletonChanged);
        const morphTargets = makeMorphTargetData(morphChanged);
        const morphBinding: MorphBinding = {
            nodeIdx: 0,
            weightsBuffer: morphTargets.weightsBuffer,
            weights: morphTargets.weights,
            targetCount: 1,
            runtimeMorphTargets: morphTargets,
        };
        const writeTexture = vi.fn();
        const writeBuffer = vi.fn();
        const engine = { _device: { queue: { writeTexture, writeBuffer } } } as unknown as EngineContext;
        const controller = createAnimationController(makeAnimationClip(true), [makeNode()], [skeletonBinding], [morphBinding]);

        controller.tick(100, engine);

        expect(skeletonChanged).toHaveBeenCalledTimes(1);
        expect(morphChanged).toHaveBeenCalledTimes(1);
    });

    it("notifies the opt-in shadow hook from setMorphTargetWeights", () => {
        const changed = vi.fn();
        const morphTargets = makeMorphTargetData(changed);
        const writeBuffer = vi.fn();
        const engine = { _device: { queue: { writeBuffer } } } as unknown as EngineContext;

        setMorphTargetWeights(engine, morphTargets, [0.75]);

        expect(changed).toHaveBeenCalledTimes(1);
    });

    it("notifies the opt-in shadow hook from the weighted glTF mixer", () => {
        const changed = vi.fn();
        const skeletonBinding = makeSkeletonBinding(changed);
        const clip = makeAnimationClip();
        const group = {
            name: "weighted",
            duration: 1,
            isPlaying: true,
            currentTime: 0,
            targetedAnimations: [],
            speedRatio: 1,
            loopAnimation: true,
            weight: 0.5,
            _gltfMixer: [clip, [makeNode()], [skeletonBinding]],
            _stopped: false,
        } as unknown as AnimationGroup;
        const writeTexture = vi.fn();
        const engine = { _device: { queue: { writeTexture } } } as unknown as EngineContext;
        const manager = createAnimationManager({ engine });
        (manager as AnimationManager & { _animationGroups: AnimationGroup[] })._animationGroups = [group];
        enableAnimationBlending(manager);

        updateAnimationManager(manager, 100);

        expect(changed).toHaveBeenCalledTimes(1);
    });

    it("notifies the opt-in shadow hook from direct skeleton pose uploads", () => {
        const changed = vi.fn();
        const skeletonBinding = makeSkeletonBinding(changed);
        const writeTexture = vi.fn();
        const device = { queue: { writeTexture } } as unknown as GPUDevice;

        writeBoneTextures(device, [skeletonBinding], new Float32Array(identity()));

        expect(changed).toHaveBeenCalledTimes(1);
    });

    it("notifies the opt-in shadow hook from updateSkeletonBoneMatrices", () => {
        const changed = vi.fn();
        const skeleton = makeSkeletonBinding(changed).runtimeSkeleton!;
        const writeTexture = vi.fn();
        const engine = { _device: { queue: { writeTexture } } } as unknown as EngineContext;

        updateSkeletonBoneMatrices(engine, skeleton, new Float32Array(identity()));

        expect(changed).toHaveBeenCalledTimes(1);
    });
});
