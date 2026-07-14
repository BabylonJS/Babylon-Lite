import { describe, expect, it, vi } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import type { Mesh, MeshGPU } from "../../../packages/babylon-lite/src/mesh/mesh";
import { initMeshTransform } from "../../../packages/babylon-lite/src/mesh/mesh";
import { updateMeshGeometry } from "../../../packages/babylon-lite/src/mesh/mesh-factories";
import { setThinInstanceColor, setThinInstanceDrawCount, setThinInstanceMatrix, type ThinInstanceData } from "../../../packages/babylon-lite/src/mesh/thin-instance";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { ShadowGenerator } from "../../../packages/babylon-lite/src/shadow/shadow-generator";
import { renderPcfShadowMap, type PcfLightMatrix, type PcfTaskState } from "../../../packages/babylon-lite/src/shadow/pcf-shadow-task-hooks";

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

describe("shadow caster dirty tracking", () => {
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
});
